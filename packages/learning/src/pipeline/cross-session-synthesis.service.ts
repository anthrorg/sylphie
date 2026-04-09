/**
 * CrossSessionSynthesisService — Second-order reflection for the Learning subsystem.
 *
 * CANON §Subsystem 3 (Learning): Knowledge must be earned, not given. This service
 * earns knowledge by detecting patterns that persist across multiple sessions —
 * patterns that no single-session reflection can surface.
 *
 * Trigger: A separate timer in LearningService fires every 30 minutes.
 * The service finds pairs of INSIGHT nodes from different sessions that share
 * entity references (REVEALS edges), sends the two insights to the LLM for
 * comparison, and persists any detected meta-pattern as a new Insight node
 * with SYNTHESIZES edges back to the source insights.
 *
 * Confabulation guards (per research: "structured decomposition" strategy):
 *   1. The LLM receives the original insight descriptions verbatim — never
 *      re-generated summaries. This prevents drift from the source material.
 *   2. The LLM must cite source insight IDs explicitly in its response.
 *   3. The response format is strictly structured — open-ended "what patterns
 *      do you see?" is avoided in favour of targeted sub-questions.
 *   4. Any SYNTHESIS insight that cannot cite both source IDs is discarded.
 *
 * Provenance: INFERENCE (synthesis is derived reasoning, not direct observation).
 * Confidence: base 0.30 (INFERENCE floor), boosted by overlap strength, capped
 * at SYNTHESIS_CONFIDENCE_CAP = 0.45. The 0.60 ceiling (CANON §Immutable
 * Standard 3) is never breached without GUARDIAN confirmation.
 *
 * Lesion Test: if LLM is unavailable, synthesis is skipped entirely. Without
 * LLM, Sylphie still learns per-session insights through reflection; she just
 * cannot detect cross-session patterns.
 *
 * Max pairs per cycle: MAX_PAIRS_PER_CYCLE = 3 (token budget control, per
 * research Phase 3 rate limiting recommendation).
 *
 * Temperature 0.2 (more conservative than reflection at 0.3) — cross-session
 * reasoning is higher-risk for confabulation.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  LLM_SERVICE,
  TimescaleService,
  Neo4jService,
  Neo4jInstanceName,
  verboseFor,
  type ILlmService,
  type LlmRequest,
} from '@sylphie/shared';
import type {
  ICrossSessionSynthesisService,
  InsightPair,
  SynthesisResult,
  SynthesisCycleResult,
  InsightType,
} from '../interfaces/learning.interfaces';
import { LEARNING_EVENT_LOGGER } from '../learning.tokens';
import type { ILearningEventLogger } from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum pairs processed per synthesis cycle (token budget control). */
const MAX_PAIRS_PER_CYCLE = 3;

/** Provenance for synthesis-derived nodes. Synthesis is derived reasoning. */
const SYNTHESIS_PROVENANCE = 'INFERENCE' as const;

/** Base confidence for synthesis nodes (same as INFERENCE floor). */
const SYNTHESIS_BASE_CONFIDENCE = 0.30;

/**
 * Maximum confidence a synthesis insight can reach WITHOUT guardian confirmation.
 * Below the 0.60 CANON ceiling. 0.45 = 1.5× INFERENCE base.
 */
const SYNTHESIS_CONFIDENCE_CAP = 0.45;

/**
 * Minimum shared-entity overlap ratio required before attempting LLM synthesis.
 * Guards against pairs that share an entity only incidentally (e.g., "Jim").
 * We compute: sharedEntities.length / min(entities1.length, entities2.length).
 * Below this threshold the pair is skipped without LLM call.
 */
const MIN_OVERLAP_RATIO = 0.0; // No ratio guard for now — entity overlap alone is sufficient.
// The value is kept as a named constant so it can be tuned without hunting for magic numbers.

/** Valid insight type strings for parsing validation (mirrors reflection service). */
const VALID_INSIGHT_TYPES = new Set<string>([
  'DELAYED_REALIZATION',
  'MISSED_CONNECTION',
  'IMPLICIT_INSTRUCTION',
  'CONTRADICTION',
  'THEMATIC_THREAD',
  'TONAL_SHIFT',
]);

// ---------------------------------------------------------------------------
// LLM response parsing patterns
// ---------------------------------------------------------------------------

/**
 * Expected output format from the LLM for a synthesis response:
 *
 *   PATTERN_FOUND: true | false
 *   PATTERN_TYPE: <InsightType>
 *   DESCRIPTION: <free text>
 *   CITES: <insightId1>, <insightId2>
 *
 * Strict line-by-line parsing; any missing field → discard the result.
 */
const PATTERN_FOUND_RE = /^PATTERN_FOUND:\s*(true|false)\s*$/i;
const PATTERN_TYPE_RE = /^PATTERN_TYPE:\s*([A-Z_]+)\s*$/;
const DESCRIPTION_RE = /^DESCRIPTION:\s*(.+)$/;
const CITES_RE = /^CITES:\s*(.+)$/;

// ---------------------------------------------------------------------------
// CrossSessionSynthesisService
// ---------------------------------------------------------------------------

@Injectable()
export class CrossSessionSynthesisService implements ICrossSessionSynthesisService {
  private readonly logger = new Logger(CrossSessionSynthesisService.name);

  constructor(
    @Optional() @Inject(LLM_SERVICE) private readonly llm: ILlmService | null,
    private readonly timescale: TimescaleService,
    private readonly neo4j: Neo4jService,
    @Inject(LEARNING_EVENT_LOGGER) private readonly eventLogger: ILearningEventLogger,
  ) {}

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  async ensureSchema(): Promise<void> {
    try {
      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS synthesized_insight_pairs (
          insight1_id TEXT NOT NULL,
          insight2_id TEXT NOT NULL,
          synthesized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          synthesis_node_id TEXT,
          pattern_found BOOLEAN NOT NULL DEFAULT FALSE,
          PRIMARY KEY (insight1_id, insight2_id)
        )
      `);
      this.logger.debug('ensureSchema: synthesized_insight_pairs table ready');
    } catch (err) {
      this.logger.error(
        `ensureSchema failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // ICrossSessionSynthesisService
  // ---------------------------------------------------------------------------

  async findSynthesizablePairs(limit: number): Promise<InsightPair[]> {
    const neo4jSession = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      // Find pairs of Insight nodes from DIFFERENT sessions that share at least
      // one entity via REVEALS edges. Use LIMIT * 2 in the Neo4j query to give
      // us candidates to filter against the TimescaleDB already-synthesized table.
      const result = await neo4jSession.run(
        `MATCH (i1:Insight)-[:REVEALS]->(e:Entity)<-[:REVEALS]-(i2:Insight)
         WHERE i1.session_id <> i2.session_id
           AND i1.node_id < i2.node_id
         WITH i1, i2, COLLECT(DISTINCT e.label) AS sharedEntities
         WHERE SIZE(sharedEntities) >= 1
         RETURN
           i1.node_id         AS insight1Id,
           i1.description     AS insight1Description,
           i1.insight_type    AS insight1Type,
           i1.session_id      AS insight1SessionId,
           i1.confidence      AS insight1Confidence,
           i2.node_id         AS insight2Id,
           i2.description     AS insight2Description,
           i2.insight_type    AS insight2Type,
           i2.session_id      AS insight2SessionId,
           i2.confidence      AS insight2Confidence,
           sharedEntities
         ORDER BY SIZE(sharedEntities) DESC, i1.node_id ASC
         LIMIT $candidateLimit`,
        { candidateLimit: limit * 4 }, // fetch extra — we'll filter below
      );

      if (result.records.length === 0) {
        return [];
      }

      // Build candidate pairs.
      const candidates: InsightPair[] = result.records.map((record) => ({
        insight1Id: record.get('insight1Id') as string,
        insight1Description: record.get('insight1Description') as string,
        insight1Type: record.get('insight1Type') as InsightType,
        insight1SessionId: record.get('insight1SessionId') as string,
        insight1Confidence: toNumber(record.get('insight1Confidence')),
        insight2Id: record.get('insight2Id') as string,
        insight2Description: record.get('insight2Description') as string,
        insight2Type: record.get('insight2Type') as InsightType,
        insight2SessionId: record.get('insight2SessionId') as string,
        insight2Confidence: toNumber(record.get('insight2Confidence')),
        sharedEntities: (record.get('sharedEntities') as string[]) ?? [],
      }));

      // Filter out pairs already processed (in TimescaleDB).
      const eligible = await this.filterAlreadySynthesized(candidates);

      vlog('findSynthesizablePairs', {
        candidatesFound: candidates.length,
        eligibleAfterFilter: eligible.length,
        limit,
      });

      return eligible.slice(0, limit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vlog('findSynthesizablePairs error', { error: message });
      this.logger.warn(`findSynthesizablePairs failed: ${message}`);
      return [];
    } finally {
      await neo4jSession.close();
    }
  }

  async synthesizePair(pair: InsightPair): Promise<SynthesisResult> {
    const noPattern: SynthesisResult = {
      nodeId: null,
      sourceInsightIds: [pair.insight1Id, pair.insight2Id],
      confidence: 0,
      patternFound: false,
    };

    // Record as attempted regardless of outcome — prevents infinite retry.
    // We update with synthesis_node_id later if a node is created.
    await this.markPairAttempted(pair.insight1Id, pair.insight2Id, null, false);

    if (!this.llm || !this.llm.isAvailable()) {
      vlog('synthesizePair: LLM unavailable — skipping', {
        insight1: pair.insight1Id,
        insight2: pair.insight2Id,
      });
      return noPattern;
    }

    const prompt = buildSynthesisPrompt(pair);
    const correlationId = `synthesis-${randomUUID().substring(0, 8)}`;

    vlog('synthesizePair: calling LLM', {
      insight1: pair.insight1Id,
      insight2: pair.insight2Id,
      sharedEntities: pair.sharedEntities,
      correlationId,
    });

    const request: LlmRequest = {
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
      maxTokens: 512,
      temperature: 0.2,
      tier: 'deep',
      metadata: {
        callerSubsystem: 'LEARNING',
        purpose: 'CROSS_SESSION_SYNTHESIS',
        sessionId: 'synthesis-internal',
        correlationId,
      },
    };

    let responseContent: string;
    try {
      const response = await this.llm.complete(request);
      responseContent = response.content;
    } catch (err) {
      this.logger.warn(
        `synthesizePair: LLM call failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return noPattern;
    }

    // Parse the structured response.
    const parsed = parseSynthesisResponse(responseContent, pair.insight1Id, pair.insight2Id);

    vlog('synthesizePair: LLM response parsed', {
      insight1: pair.insight1Id,
      insight2: pair.insight2Id,
      patternFound: parsed.patternFound,
      insightType: parsed.insightType,
      descriptionPreview: parsed.description?.substring(0, 80),
      citesVerified: parsed.citesVerified,
    });

    if (!parsed.patternFound || !parsed.citesVerified || !parsed.description || !parsed.insightType) {
      // No pattern, or confabulation guard failed (LLM did not cite source IDs).
      return noPattern;
    }

    // Persist the synthesis node.
    const nodeId = await this.persistSynthesisNode(
      parsed.insightType,
      parsed.description,
      pair,
    );

    if (nodeId) {
      await this.markPairAttempted(pair.insight1Id, pair.insight2Id, nodeId, true);
    }

    const confidence = computeSynthesisConfidence(
      pair.insight1Confidence,
      pair.insight2Confidence,
      pair.sharedEntities.length,
    );

    return {
      nodeId,
      sourceInsightIds: [pair.insight1Id, pair.insight2Id],
      confidence,
      patternFound: true,
    };
  }

  async runSynthesisCycle(): Promise<SynthesisCycleResult> {
    const noop: SynthesisCycleResult = {
      pairsExamined: 0,
      synthesesCreated: 0,
      wasNoop: true,
    };

    this.eventLogger.log('SYNTHESIS_CYCLE_STARTED', {});

    const pairs = await this.findSynthesizablePairs(MAX_PAIRS_PER_CYCLE);

    if (pairs.length === 0) {
      this.logger.debug('Synthesis cycle: no synthesizable pairs found');
      return noop;
    }

    this.logger.log(`Synthesis cycle: examining ${pairs.length} insight pair(s)`);

    let synthesesCreated = 0;

    for (const pair of pairs) {
      try {
        const result = await this.synthesizePair(pair);

        this.eventLogger.log('SYNTHESIS_PAIR_PROCESSED', {
          insight1Id: pair.insight1Id,
          insight2Id: pair.insight2Id,
          sharedEntityCount: pair.sharedEntities.length,
          patternFound: result.patternFound,
          synthesisNodeId: result.nodeId,
          confidence: result.confidence,
        });

        if (result.patternFound && result.nodeId) {
          synthesesCreated++;
          this.logger.log(
            `Synthesis: created meta-insight ${result.nodeId} from ` +
              `${pair.insight1Id} + ${pair.insight2Id} ` +
              `(${pair.sharedEntities.length} shared entities, confidence=${result.confidence.toFixed(3)})`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `synthesizePair failed for ${pair.insight1Id}+${pair.insight2Id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    this.eventLogger.log('SYNTHESIS_CYCLE_COMPLETED', {
      pairsExamined: pairs.length,
      synthesesCreated,
    });

    vlog('synthesis cycle finished', {
      pairsExamined: pairs.length,
      synthesesCreated,
    });

    return {
      pairsExamined: pairs.length,
      synthesesCreated,
      wasNoop: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: WKG persistence
  // ---------------------------------------------------------------------------

  private async persistSynthesisNode(
    insightType: InsightType,
    description: string,
    pair: InsightPair,
  ): Promise<string | null> {
    const nodeId = `synthesis-${randomUUID().substring(0, 8)}`;
    const label = `${insightType.toLowerCase()} (synthesis): ${description.substring(0, 60)}`;
    const confidence = computeSynthesisConfidence(
      pair.insight1Confidence,
      pair.insight2Confidence,
      pair.sharedEntities.length,
    );

    const neo4jSession = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    try {
      // Create the synthesis Insight node.
      await neo4jSession.run(
        `CREATE (i:Insight {
           node_id:          $nodeId,
           label:            $label,
           node_type:        'Insight',
           insight_type:     $insightType,
           description:      $description,
           session_id:       'synthesis',
           schema_level:     'instance',
           provenance_type:  $provenance,
           confidence:       $confidence,
           grounded:         true,
           grounding_ratio:  1.0,
           is_synthesis:     true,
           source_sessions:  $sourceSessions,
           created_at:       datetime()
         })`,
        {
          nodeId,
          label,
          insightType,
          description,
          provenance: SYNTHESIS_PROVENANCE,
          confidence,
          sourceSessions: [pair.insight1SessionId, pair.insight2SessionId],
        },
      );

      // SYNTHESIZES edges: synthesis node → each source insight.
      await neo4jSession.run(
        `MATCH (synth:Insight {node_id: $synthId}),
               (src1:Insight  {node_id: $srcId1}),
               (src2:Insight  {node_id: $srcId2})
         MERGE (synth)-[r1:SYNTHESIZES]->(src1)
         ON CREATE SET
           r1.provenance_type = $provenance,
           r1.created_at      = datetime()
         MERGE (synth)-[r2:SYNTHESIZES]->(src2)
         ON CREATE SET
           r2.provenance_type = $provenance,
           r2.created_at      = datetime()`,
        {
          synthId: nodeId,
          srcId1: pair.insight1Id,
          srcId2: pair.insight2Id,
          provenance: SYNTHESIS_PROVENANCE,
        },
      );

      // REVEALS edges: synthesis → shared entities (inherits entity groundings).
      for (const entityLabel of pair.sharedEntities) {
        try {
          await neo4jSession.run(
            `MATCH (synth:Insight {node_id: $synthId}), (e:Entity)
             WHERE toLower(e.label) = toLower($entityLabel)
             MERGE (synth)-[r:REVEALS]->(e)
             ON CREATE SET
               r.provenance_type = $provenance,
               r.confidence      = $confidence,
               r.created_at      = datetime()`,
            {
              synthId: nodeId,
              entityLabel,
              provenance: SYNTHESIS_PROVENANCE,
              confidence,
            },
          );
        } catch {
          // Non-critical — entity may have been removed; continue.
        }
      }

      vlog('persistSynthesisNode: created', {
        nodeId,
        insightType,
        confidence,
        sharedEntities: pair.sharedEntities,
      });

      return nodeId;
    } catch (err) {
      this.logger.warn(
        `persistSynthesisNode failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    } finally {
      await neo4jSession.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Private: TimescaleDB tracking
  // ---------------------------------------------------------------------------

  /**
   * Filter out pairs whose canonical (sorted) ID combination already appears
   * in synthesized_insight_pairs. The canonical ordering is ensured by the
   * Neo4j query (i1.node_id < i2.node_id).
   */
  private async filterAlreadySynthesized(
    candidates: InsightPair[],
  ): Promise<InsightPair[]> {
    if (candidates.length === 0) return [];

    try {
      // Build a VALUES list for a single multi-row check.
      const placeholders = candidates
        .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
        .join(', ');
      const params = candidates.flatMap((p) => [p.insight1Id, p.insight2Id]);

      const result = await this.timescale.query<{
        insight1_id: string;
        insight2_id: string;
      }>(
        `SELECT insight1_id, insight2_id
         FROM synthesized_insight_pairs
         WHERE (insight1_id, insight2_id) IN (${placeholders})`,
        params,
      );

      const processed = new Set(
        result.rows.map((r) => `${r.insight1_id}:${r.insight2_id}`),
      );

      return candidates.filter(
        (p) => !processed.has(`${p.insight1Id}:${p.insight2Id}`),
      );
    } catch (err) {
      // If the table does not exist yet, treat all as eligible.
      this.logger.warn(
        `filterAlreadySynthesized failed (treating all as eligible): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return candidates;
    }
  }

  private async markPairAttempted(
    insight1Id: string,
    insight2Id: string,
    synthesisNodeId: string | null,
    patternFound: boolean,
  ): Promise<void> {
    try {
      await this.timescale.query(
        `INSERT INTO synthesized_insight_pairs
           (insight1_id, insight2_id, synthesized_at, synthesis_node_id, pattern_found)
         VALUES ($1, $2, NOW(), $3, $4)
         ON CONFLICT (insight1_id, insight2_id) DO UPDATE SET
           synthesized_at    = NOW(),
           synthesis_node_id = $3,
           pattern_found     = $4`,
        [insight1Id, insight2Id, synthesisNodeId, patternFound],
      );
    } catch (err) {
      this.logger.warn(
        `markPairAttempted failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Neo4j Integer or plain number to a JS number.
 */
function toNumber(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  // Neo4j Integer objects expose .toNumber()
  if (typeof (val as Record<string, unknown>).toNumber === 'function') {
    return (val as { toNumber(): number }).toNumber();
  }
  return Number(val) || 0;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Compute the confidence for a synthesis Insight node.
 *
 * Rules:
 *   - Start from the mean of the two source insight confidences.
 *   - Apply an overlap bonus: each shared entity beyond the first adds a small
 *     amount (+0.02 per entity, capped at +0.10 total).
 *   - Floor at SYNTHESIS_BASE_CONFIDENCE (0.30) — a synthesis is never less
 *     confident than a raw INFERENCE.
 *   - Cap at SYNTHESIS_CONFIDENCE_CAP (0.45) — does not breach the 0.60
 *     ceiling without GUARDIAN confirmation (CANON §Immutable Standard 3).
 *
 * Exported so unit tests can exercise it without a Neo4j connection.
 */
export function computeSynthesisConfidence(
  confidence1: number,
  confidence2: number,
  sharedEntityCount: number,
): number {
  const mean = (confidence1 + confidence2) / 2;
  const overlapBonus = Math.min((sharedEntityCount - 1) * 0.02, 0.10);
  const raw = mean + overlapBonus;
  return Math.min(Math.max(raw, SYNTHESIS_BASE_CONFIDENCE), SYNTHESIS_CONFIDENCE_CAP);
}

/**
 * Parsed result from the LLM synthesis response.
 */
export interface ParsedSynthesisResponse {
  readonly patternFound: boolean;
  readonly insightType: InsightType | null;
  readonly description: string | null;
  /**
   * citesVerified = true when the LLM's CITES field contains both source IDs.
   * This is the confabulation guard: the LLM must explicitly acknowledge which
   * insights it is reasoning about.
   */
  readonly citesVerified: boolean;
}

/**
 * Parse the LLM's structured synthesis response.
 *
 * Expected format:
 *   PATTERN_FOUND: true
 *   PATTERN_TYPE: THEMATIC_THREAD
 *   DESCRIPTION: Jim consistently references coffee in contexts of morning productivity.
 *   CITES: insight-abc12345, insight-def67890
 *
 * Any deviation from the format (missing fields, wrong CITES) produces a
 * result with patternFound=false or citesVerified=false. The caller discards
 * such results rather than persisting potentially confabulated knowledge.
 *
 * Exported so unit tests can exercise it without a Neo4j connection.
 */
export function parseSynthesisResponse(
  content: string,
  sourceId1: string,
  sourceId2: string,
): ParsedSynthesisResponse {
  const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  let patternFound = false;
  let insightType: InsightType | null = null;
  let description: string | null = null;
  let citesVerified = false;

  for (const line of lines) {
    const foundMatch = PATTERN_FOUND_RE.exec(line);
    if (foundMatch) {
      patternFound = foundMatch[1].toLowerCase() === 'true';
      continue;
    }

    const typeMatch = PATTERN_TYPE_RE.exec(line);
    if (typeMatch) {
      const candidate = typeMatch[1];
      if (VALID_INSIGHT_TYPES.has(candidate)) {
        insightType = candidate as InsightType;
      }
      continue;
    }

    const descMatch = DESCRIPTION_RE.exec(line);
    if (descMatch) {
      description = descMatch[1].trim();
      continue;
    }

    const citesMatch = CITES_RE.exec(line);
    if (citesMatch) {
      const cited = citesMatch[1];
      // Both source IDs must appear in the CITES field (confabulation guard).
      citesVerified = cited.includes(sourceId1) && cited.includes(sourceId2);
      continue;
    }
  }

  return { patternFound, insightType, description, citesVerified };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYNTHESIS_SYSTEM_PROMPT = [
  'You are a pattern-recognition system analyzing pairs of insights extracted',
  'from different conversations. Your task is to determine whether two insights',
  'reveal a meaningful cross-session pattern — a recurring theme, evolving',
  'preference, or persistent contradiction that spans multiple interactions.',
  '',
  'IMPORTANT: You must be conservative. Only report a pattern if it is genuinely',
  'supported by BOTH insights. Do not invent connections. If the two insights are',
  'unrelated beyond sharing an entity name, report PATTERN_FOUND: false.',
  '',
  'You must respond in exactly this format (no deviations):',
  'PATTERN_FOUND: true | false',
  'PATTERN_TYPE: <one of: DELAYED_REALIZATION | MISSED_CONNECTION | IMPLICIT_INSTRUCTION | CONTRADICTION | THEMATIC_THREAD | TONAL_SHIFT>',
  'DESCRIPTION: <one sentence describing the cross-session pattern>',
  'CITES: <insight-id-1>, <insight-id-2>',
  '',
  'If PATTERN_FOUND is false, still include all four lines with placeholder values.',
  'PATTERN_TYPE and DESCRIPTION may be "none" when PATTERN_FOUND is false.',
  'CITES must always contain both insight IDs provided to you.',
].join('\n');

/**
 * Build the user prompt for a single insight pair synthesis.
 */
function buildSynthesisPrompt(pair: InsightPair): string {
  return [
    `Compare these two insights from different conversation sessions.`,
    `They both reference the following shared entities: ${pair.sharedEntities.join(', ')}.`,
    '',
    `Insight 1 (ID: ${pair.insight1Id}, session: ${pair.insight1SessionId}):`,
    `  Type: ${pair.insight1Type}`,
    `  Description: ${pair.insight1Description}`,
    '',
    `Insight 2 (ID: ${pair.insight2Id}, session: ${pair.insight2SessionId}):`,
    `  Type: ${pair.insight2Type}`,
    `  Description: ${pair.insight2Description}`,
    '',
    `Do these two insights together reveal a cross-session pattern that neither`,
    `could reveal on its own? Respond strictly in the required format.`,
    `You MUST include both insight IDs (${pair.insight1Id}, ${pair.insight2Id}) in your CITES line.`,
  ].join('\n');
}

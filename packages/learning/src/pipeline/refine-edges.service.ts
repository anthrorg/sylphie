/**
 * RefineEdgesService — Step 7 of the Learning maintenance cycle.
 *
 * Uses the LLM to classify generic RELATED_TO edges into more specific types.
 * This is the LLM-assisted edge refinement described in CANON §Subsystem 3.
 *
 * When the LLM is unavailable (isAvailable() === false), this step is skipped
 * entirely. This is the Lesion Test support: removing the LLM reveals exactly
 * what Sylphie knows through SENSOR and GUARDIAN provenance alone.
 *
 * Edge refinement provenance: LLM_GENERATED (CANON §Provenance Is Sacred).
 * Even when the LLM correctly identifies a relationship, the provenance
 * reflects who identified it — the LLM. The tag never changes. Confidence
 * can grow through retrieval-and-use or guardian confirmation.
 *
 * Person context enrichment: when entity labels look like person names
 * (title-cased single word appearing in recent INPUT_PARSED events), we
 * query TimescaleDB for recent interactions mentioning that person and
 * include them in the LLM prompt for more accurate refinement.
 *
 * Temperature 0.3 (conservative) per CANON: Learning refinement should be
 * conservative, not expressive. We want accurate classification, not creativity.
 *
 * Response format expected from LLM:
 *   EDGE: <sourceLabel> -> <targetLabel> | <REFINED_TYPE>
 *   One line per edge. Lines not matching this pattern are ignored.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
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
  IRefineEdgesService,
  ExtractedEdge,
  UnlearnedEvent,
} from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid refined edge types the LLM may return. */
const VALID_REFINED_TYPES = new Set([
  'LIKES',
  'DISLIKES',
  'KNOWS',
  'WORKS_AT',
  'LIVES_AT',
  'OWNS',
  'USES',
  'CREATED',
  'BELONGS_TO',
  'IS_PART_OF',
  'IS_TYPE_OF',
  'LOCATED_IN',
  'HAS_PROPERTY',
  'CAUSED_BY',
  'LED_TO',
  'RELATED_TO',
]);

// ---------------------------------------------------------------------------
// Heuristic rule table
// ---------------------------------------------------------------------------

/**
 * A single heuristic rule: if `pattern` matches a window of text containing
 * both entity labels, classify the edge as `edgeType`.
 *
 * Rules are evaluated in declaration order; first match wins.
 * Patterns are verb-derived only — entity-label-based rules are deferred
 * until entity semantic typing is available in the WKG.
 */
interface HeuristicRule {
  readonly edgeType: string;
  readonly pattern: RegExp;
}

/**
 * Ordered heuristic rules for edge classification.
 *
 * Design constraints (from research doc):
 * - Verb-derived patterns only for now. No entity-label-only rules.
 * - Be conservative: only classify when the pattern is unambiguous.
 * - USES is intentionally omitted: "uses" fires on too many irrelevant
 *   constructs ("Jim uses the bathroom", "using Google to search").
 *   Left to the LLM where disambiguation is possible.
 *
 * Confidence note: heuristic-classified edges carry the edge's existing
 * confidence (no boost). The LLM classification path also uses the same
 * existing edge confidence. Both are tagged LLM_GENERATED or SENSOR/GUARDIAN
 * at the extraction stage; refinement does not change provenance.
 */
const HEURISTIC_RULES: readonly HeuristicRule[] = [
  // DISLIKES must come before LIKES to avoid "dislike" partially matching "like"
  {
    edgeType: 'DISLIKES',
    pattern: /\b(?:dislikes?|hates?|can'?t\s+stand|detest)\b/i,
  },
  {
    edgeType: 'LIKES',
    pattern: /\blikes?\b/i,
  },
  {
    edgeType: 'KNOWS',
    pattern: /\b(?:knows?|met|friend\s+of|acquainted\s+with)\b/i,
  },
  {
    edgeType: 'WORKS_AT',
    pattern: /\b(?:works?\s+(?:at|for)|employed\s+(?:at|by)|works?\s+with)\b/i,
  },
  {
    edgeType: 'LIVES_AT',
    pattern: /\b(?:lives?\s+(?:at|in|near)|resides?\s+(?:at|in)|home\s+(?:is|at))\b/i,
  },
  {
    edgeType: 'CREATED',
    pattern: /\b(?:created?|made|built|wrote|authored|invented|founded)\b/i,
  },
  {
    edgeType: 'OWNS',
    pattern: /\b(?:owns?|possesses?|belongs?\s+to)\b/i,
  },
];

/** How many recent events to pull for person-context enrichment. */
const PERSON_CONTEXT_LIMIT = 5;

/** Regex for parsing LLM refinement lines. */
const REFINEMENT_LINE_RE = /^EDGE:\s*(.+?)\s*->\s*(.+?)\s*\|\s*([A-Z_]+)\s*$/;

// ---------------------------------------------------------------------------
// RefineEdgesService
// ---------------------------------------------------------------------------

@Injectable()
export class RefineEdgesService implements IRefineEdgesService {
  private readonly logger = new Logger(RefineEdgesService.name);

  constructor(
    @Optional() @Inject(LLM_SERVICE) private readonly llm: ILlmService | null,
    private readonly timescale: TimescaleService,
    private readonly neo4j: Neo4jService,
  ) {}

  // ---------------------------------------------------------------------------
  // IRefineEdgesService
  // ---------------------------------------------------------------------------

  async refineEdges(
    edges: ExtractedEdge[],
    event: UnlearnedEvent,
  ): Promise<number> {
    if (edges.length === 0) return 0;

    // ── Phase 1: Heuristic classification ────────────────────────────────────
    // Run deterministic verb-derived patterns over conversation context.
    // Edges confidently classified here do NOT proceed to Phase 2.
    // This path works even when the LLM is unavailable (Lesion Test support).
    const personContext = await this.gatherPersonContext(edges, event.session_id);
    const conversationContext = (event.payload['content'] as string | undefined) ?? '';
    const fullContext = [conversationContext, personContext].filter(Boolean).join('\n');

    const heuristicRefinements: Refinement[] = [];
    const llmCandidates: ExtractedEdge[] = [];

    for (const edge of edges) {
      if (edge.relType !== 'RELATED_TO') {
        // Already typed (e.g. from a prior cycle) — skip both phases.
        continue;
      }
      const heuristic = classifyByHeuristic(edge.sourceLabel, edge.targetLabel, fullContext);
      if (heuristic.confident) {
        heuristicRefinements.push({ edge, newType: heuristic.newType, source: 'HEURISTIC' });
      } else {
        llmCandidates.push(edge);
      }
    }

    vlog('refineEdges: heuristic phase', {
      eventId: event.id,
      heuristicCount: heuristicRefinements.length,
      llmCandidateCount: llmCandidates.length,
      heuristics: heuristicRefinements.map((r) => ({
        source: r.edge.sourceLabel,
        target: r.edge.targetLabel,
        newType: r.newType,
      })),
    });

    let refined = 0;

    for (const { edge, newType } of heuristicRefinements) {
      const ok = await this.updateEdgeType(edge, newType, 'HEURISTIC');
      if (ok) {
        edge.relType = newType;
        refined++;
        vlog('edge type refined by heuristic', {
          eventId: event.id,
          source: edge.sourceLabel,
          target: edge.targetLabel,
          newType,
          confidence: edge.confidence,
        });
      }
    }

    // ── Phase 2: LLM classification for remaining ambiguous edges ─────────────
    // Only edges that the heuristic could not confidently classify reach here.
    // If the LLM is unavailable, they remain as RELATED_TO (Lesion Test).
    if (llmCandidates.length === 0) {
      vlog('refineEdges: no LLM candidates, skipping LLM phase', { eventId: event.id });
      this.logger.debug(
        `RefineEdges: event ${event.id} → ${refined}/${edges.length} edges refined (heuristic only)`,
      );
      return refined;
    }

    if (!this.llm || !this.llm.isAvailable()) {
      vlog('refineEdges: LLM unavailable — leaving ambiguous edges as RELATED_TO', {
        eventId: event.id,
        remaining: llmCandidates.length,
      });
      this.logger.debug('RefineEdges: LLM unavailable, skipping LLM phase');
      return refined;
    }

    vlog('refineEdges: calling LLM for ambiguous edges', {
      eventId: event.id,
      edgeCount: llmCandidates.length,
      edges: llmCandidates.map((e) => `${e.sourceLabel} -> ${e.targetLabel}`),
      hasPersonContext: personContext.length > 0,
      model: 'quick',
    });

    const prompt = buildRefinementPrompt(llmCandidates, personContext);
    const correlationId = event.id;
    const sessionId = event.session_id;

    const request: LlmRequest = {
      messages: [{ role: 'user', content: prompt }],
      systemPrompt:
        'You are a knowledge graph analyst. Your task is to classify generic ' +
        'RELATED_TO edges between entities into more specific relationship types. ' +
        'Respond with one line per edge in the format: ' +
        'EDGE: <source> -> <target> | <TYPE>',
      maxTokens: 512,
      temperature: 0.3,
      tier: 'quick',
      metadata: {
        callerSubsystem: 'LEARNING',
        purpose: 'EDGE_REFINEMENT',
        sessionId,
        correlationId,
      },
    };

    let response: Awaited<ReturnType<ILlmService['complete']>>;
    try {
      response = await this.llm.complete(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vlog('refineEdges: LLM call failed', { eventId: event.id, error: message });
      this.logger.warn(`RefineEdges: LLM call failed: ${message}`);
      return refined;
    }

    const llmRefinements = parseRefinements(response.content, llmCandidates);

    vlog('refineEdges: LLM response parsed', {
      eventId: event.id,
      refinementsFound: llmRefinements.length,
      refinements: llmRefinements.map((r) => ({
        source: r.edge.sourceLabel,
        target: r.edge.targetLabel,
        newType: r.newType,
        oldType: r.edge.relType,
      })),
    });

    for (const { edge, newType } of llmRefinements) {
      const ok = await this.updateEdgeType(edge, newType, 'LLM');
      if (ok) {
        edge.relType = newType;
        refined++;
        vlog('edge type refined by LLM', {
          eventId: event.id,
          source: edge.sourceLabel,
          target: edge.targetLabel,
          newType,
          confidence: edge.confidence,
        });
      }
    }

    vlog('refineEdges complete', {
      eventId: event.id,
      refined,
      total: edges.length,
      heuristicRefined: heuristicRefinements.length,
      llmRefined: llmRefinements.length,
    });
    this.logger.debug(
      `RefineEdges: event ${event.id} → ${refined}/${edges.length} edges refined`,
    );
    return refined;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Query TimescaleDB for recent INPUT_PARSED events that mention any entity
   * labels that look like person names (title-cased, single word).
   *
   * Returns a plain text block suitable for injection into the LLM prompt.
   */
  private async gatherPersonContext(
    edges: ExtractedEdge[],
    sessionId: string,
  ): Promise<string> {
    // Collect candidate person labels: title-cased single-word labels.
    const personLabels = new Set<string>();
    for (const edge of edges) {
      if (isPersonLike(edge.sourceLabel)) personLabels.add(edge.sourceLabel);
      if (isPersonLike(edge.targetLabel)) personLabels.add(edge.targetLabel);
    }

    if (personLabels.size === 0) return '';

    try {
      const result = await this.timescale.query<{ payload: Record<string, unknown> }>(
        `SELECT payload
         FROM events
         WHERE type = 'INPUT_PARSED'
           AND subsystem = 'COMMUNICATION'
           AND session_id = $1
         ORDER BY timestamp DESC
         LIMIT $2`,
        [sessionId, PERSON_CONTEXT_LIMIT],
      );

      const contextLines: string[] = [];
      for (const row of result.rows) {
        const content =
          typeof row.payload['content'] === 'string'
            ? row.payload['content']
            : null;
        if (!content) continue;

        // Include the line only if it mentions one of our person labels.
        const mentions = [...personLabels].some((label) =>
          content.toLowerCase().includes(label.toLowerCase()),
        );
        if (mentions) {
          contextLines.push(`- ${content}`);
        }
      }

      return contextLines.length > 0
        ? `Recent context:\n${contextLines.join('\n')}`
        : '';
    } catch (err) {
      this.logger.warn(
        `gatherPersonContext failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return '';
    }
  }

  /**
   * Update an edge's type in Neo4j from RELATED_TO to the refined type.
   *
   * Neo4j does not support renaming relationship types in-place. The pattern is:
   * 1. CREATE the new typed relationship.
   * 2. DELETE the old RELATED_TO relationship (if different).
   *
   * @param refinedFrom - 'HEURISTIC' when classified deterministically,
   *                      'LLM' when classified by the language model.
   *                      Stored in the `refined_from` edge property for
   *                      provenance tracking and Lesion Test analysis.
   *
   * Returns true on success.
   */
  private async updateEdgeType(
    edge: ExtractedEdge,
    newType: string,
    refinedFrom: 'HEURISTIC' | 'LLM' = 'LLM',
  ): Promise<boolean> {
    if (newType === edge.relType) return false; // No change needed.

    const sanitized = sanitizeRelType(newType);
    const refinedFromValue = refinedFrom === 'HEURISTIC' ? 'HEURISTIC' : 'LLM';
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      // Create the refined typed relationship.
      await session.run(
        `MATCH (a:Entity {node_id: $sourceId}), (b:Entity {node_id: $targetId})
         MERGE (a)-[r:${sanitized}]->(b)
         ON CREATE SET
           r.confidence      = $confidence,
           r.provenance_type = $provenance,
           r.created_at      = datetime(),
           r.refined_from    = $refinedFrom
         ON MATCH SET
           r.confidence = CASE WHEN $confidence > r.confidence
                               THEN $confidence
                               ELSE r.confidence END,
           r.updated_at = datetime()`,
        {
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          confidence: edge.confidence,
          provenance: edge.provenance,
          refinedFrom: refinedFromValue,
        },
      );

      // Remove the original RELATED_TO edge now that it has been refined.
      await session.run(
        `MATCH (a:Entity {node_id: $sourceId})-[r:RELATED_TO]->(b:Entity {node_id: $targetId})
         DELETE r`,
        { sourceId: edge.sourceId, targetId: edge.targetId },
      );

      return true;
    } catch (err) {
      this.logger.warn(
        `updateEdgeType failed (${edge.sourceId} -[${newType}]-> ${edge.targetId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    } finally {
      await session.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function buildRefinementPrompt(
  edges: ExtractedEdge[],
  personContext: string,
): string {
  const edgeLines = edges
    .map((e) => `${e.sourceLabel} -> ${e.targetLabel}`)
    .join('\n');

  return [
    'Classify the relationship type for each entity pair below.',
    'Use one of these types: LIKES, DISLIKES, KNOWS, WORKS_AT, LIVES_AT, OWNS, USES,',
    'CREATED, BELONGS_TO, IS_PART_OF, IS_TYPE_OF, LOCATED_IN, HAS_PROPERTY,',
    'CAUSED_BY, LED_TO, RELATED_TO.',
    '',
    'For each pair, respond with exactly:',
    'EDGE: <source> -> <target> | <TYPE>',
    '',
    'Entity pairs:',
    edgeLines,
    personContext ? `\n${personContext}` : '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

interface Refinement {
  edge: ExtractedEdge;
  newType: string;
  source: 'HEURISTIC' | 'LLM';
}

function parseRefinements(
  llmContent: string,
  edges: ExtractedEdge[],
): Refinement[] {
  const result: Refinement[] = [];

  // Build a lookup from "sourceLabel -> targetLabel" to the edge object.
  const edgeMap = new Map<string, ExtractedEdge>();
  for (const edge of edges) {
    edgeMap.set(`${edge.sourceLabel} -> ${edge.targetLabel}`, edge);
  }

  for (const line of llmContent.split('\n')) {
    const match = REFINEMENT_LINE_RE.exec(line.trim());
    if (!match) continue;

    const [, sourceLabel, targetLabel, rawType] = match;
    const key = `${sourceLabel.trim()} -> ${targetLabel.trim()}`;
    const edge = edgeMap.get(key);

    if (!edge) continue;
    if (!VALID_REFINED_TYPES.has(rawType)) continue;
    if (rawType === edge.relType) continue; // Already this type.

    result.push({ edge, newType: rawType, source: 'LLM' });
  }

  return result;
}

/** Heuristic: a single title-cased word with no digits is probably a person name. */
function isPersonLike(label: string): boolean {
  return /^[A-Z][a-z]+$/.test(label);
}

/** Sanitize a relationship type string for Cypher (only alphanumeric + underscore). */
function sanitizeRelType(type: string): string {
  return type.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
}

// ---------------------------------------------------------------------------
// classifyByHeuristic (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Result of a heuristic edge classification attempt.
 *
 * - `confident: true`  — a rule matched; `newType` is the classification.
 * - `confident: false` — no rule matched; the edge should go to the LLM.
 *                        `newType` is 'RELATED_TO' (the safe default).
 */
export interface HeuristicClassification {
  readonly newType: string;
  readonly confident: boolean;
}

/**
 * Attempt to classify a RELATED_TO edge using deterministic verb-derived
 * heuristics over the conversation context.
 *
 * Strategy:
 *   1. Build a context window that contains both entity labels (±100 chars
 *      around each label occurrence). This prevents false positives from
 *      patterns that appear in unrelated parts of the conversation.
 *   2. Run each rule in HEURISTIC_RULES order against that window.
 *   3. Return confident=true on the first match.
 *   4. If no rule matches, return confident=false (LLM fallback).
 *
 * Pure function — no I/O, no DI. Exported for unit tests.
 *
 * @param sourceLabel - The source entity label from the ExtractedEdge.
 * @param targetLabel - The target entity label from the ExtractedEdge.
 * @param context     - Full conversation text + person context string.
 */
export function classifyByHeuristic(
  sourceLabel: string,
  targetLabel: string,
  context: string,
): HeuristicClassification {
  if (!context || context.trim().length === 0) {
    return { newType: 'RELATED_TO', confident: false };
  }

  // Build a set of context windows: regions of text that contain both labels.
  // We look for sentences (split on . ! ?) that mention both labels.
  // If no sentence contains both, we build a wider window (±100 chars around
  // each label occurrence) and check if both labels appear within 200 chars.
  const lowerContext = context.toLowerCase();
  const lowerSource = sourceLabel.toLowerCase();
  const lowerTarget = targetLabel.toLowerCase();

  const windows = extractContextWindows(lowerContext, lowerSource, lowerTarget);

  if (windows.length === 0) {
    // Both labels don't co-occur in the context — cannot classify confidently.
    return { newType: 'RELATED_TO', confident: false };
  }

  for (const window of windows) {
    for (const rule of HEURISTIC_RULES) {
      if (rule.pattern.test(window)) {
        return { newType: rule.edgeType, confident: true };
      }
    }
  }

  return { newType: 'RELATED_TO', confident: false };
}

/**
 * Extract text windows from `context` where both `labelA` and `labelB`
 * appear within a reasonable proximity.
 *
 * Two strategies (in order):
 *   1. Sentence-level: sentences containing both labels.
 *   2. Proximity-window: ±WINDOW_RADIUS chars around labelA occurrences
 *      where labelB also falls within that window.
 */
const WINDOW_RADIUS = 120;

function extractContextWindows(
  context: string,
  labelA: string,
  labelB: string,
): string[] {
  const windows: string[] = [];

  // Strategy 1: sentences containing both labels.
  const sentences = context.split(/[.!?]+/);
  for (const sentence of sentences) {
    if (sentence.includes(labelA) && sentence.includes(labelB)) {
      windows.push(sentence);
    }
  }

  if (windows.length > 0) return windows;

  // Strategy 2: proximity windows around labelA occurrences.
  let searchFrom = 0;
  while (true) {
    const idxA = context.indexOf(labelA, searchFrom);
    if (idxA === -1) break;

    const start = Math.max(0, idxA - WINDOW_RADIUS);
    const end = Math.min(context.length, idxA + labelA.length + WINDOW_RADIUS);
    const window = context.substring(start, end);

    if (window.includes(labelB)) {
      windows.push(window);
    }

    searchFrom = idxA + 1;
  }

  return windows;
}

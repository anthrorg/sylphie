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
  type ILlmService,
  type LlmRequest,
} from '@sylphie/shared';
import type {
  IRefineEdgesService,
  ExtractedEdge,
  UnlearnedEvent,
} from '../interfaces/learning.interfaces';

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
    // Lesion Test: if LLM is not available, skip refinement gracefully.
    if (!this.llm || !this.llm.isAvailable()) {
      this.logger.debug('RefineEdges: LLM unavailable, skipping');
      return 0;
    }

    if (edges.length === 0) return 0;

    // Gather person context for edges that mention person-like entities.
    const personContext = await this.gatherPersonContext(edges, event.session_id);

    const prompt = buildRefinementPrompt(edges, personContext);
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
      this.logger.warn(
        `RefineEdges: LLM call failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }

    const refinements = parseRefinements(response.content, edges);
    let refined = 0;

    for (const { edge, newType } of refinements) {
      const ok = await this.updateEdgeType(edge, newType);
      if (ok) {
        edge.relType = newType; // Mutate for downstream observability.
        refined++;
      }
    }

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
   * Returns true on success.
   */
  private async updateEdgeType(
    edge: ExtractedEdge,
    newType: string,
  ): Promise<boolean> {
    if (newType === edge.relType) return false; // No change needed.

    const sanitized = sanitizeRelType(newType);
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      // Create the refined typed relationship.
      await session.run(
        `MATCH (a {node_id: $sourceId}), (b {node_id: $targetId})
         MERGE (a)-[r:${sanitized}]->(b)
         ON CREATE SET
           r.confidence      = $confidence,
           r.provenance_type = $provenance,
           r.created_at      = datetime(),
           r.refined_from    = 'RELATED_TO'
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
        },
      );

      // Remove the original RELATED_TO edge now that it has been refined.
      await session.run(
        `MATCH (a {node_id: $sourceId})-[r:RELATED_TO]->(b {node_id: $targetId})
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

    result.push({ edge, newType: rawType });
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

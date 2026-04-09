/**
 * ExtractEdgesService — Step 4 of the Learning maintenance cycle.
 *
 * For each pair of entities extracted from the same event, create a RELATED_TO
 * edge in Neo4j WORLD. These are the raw relationship candidates that Step 7
 * (RefineEdgesService) may later classify into more specific types.
 *
 * Edge provenance is LLM_GENERATED — even though the pairing is mechanical
 * (co-occurrence), the interpretation that "these two things are related" is
 * an inference that is not grounded in a direct sensor observation.
 *
 * CANON §Provenance Is Sacred: LLM_GENERATED provenance is used here because
 * the relationship itself was inferred, not observed. The base confidence of
 * 0.35 reflects this uncertainty. Confidence only increases if the guardian
 * confirms the relationship or it survives retrieval-and-use.
 *
 * MERGE pattern: ON MATCH only increases confidence (never decreases). This
 * ensures that a repeatedly co-occurring pair builds confidence over time.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Neo4jService,
  Neo4jInstanceName,
  resolveBaseConfidence,
  verboseFor,
} from '@sylphie/shared';
import type {
  IExtractEdgesService,
  ExtractedEntity,
  ExtractedEdge,
  UnlearnedEvent,
} from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of entity pairs to create edges for in a single event.
 *  With n entities, pairs grow as n*(n-1)/2. Cap prevents quadratic blow-up. */
const MAX_PAIRS = 10;

/** Provenance for inferred co-occurrence edges. */
const EDGE_PROVENANCE = 'LLM_GENERATED' as const;

// ---------------------------------------------------------------------------
// ExtractEdgesService
// ---------------------------------------------------------------------------

@Injectable()
export class ExtractEdgesService implements IExtractEdgesService {
  private readonly logger = new Logger(ExtractEdgesService.name);

  constructor(
    private readonly neo4j: Neo4jService,
  ) {}

  // ---------------------------------------------------------------------------
  // IExtractEdgesService
  // ---------------------------------------------------------------------------

  async extractEdges(
    entities: ExtractedEntity[],
    event: UnlearnedEvent,
  ): Promise<ExtractedEdge[]> {
    if (entities.length < 2) {
      vlog('extractEdges: skipped — fewer than 2 entities', { eventId: event.id, entityCount: entities.length });
      return [];
    }

    const confidence = resolveBaseConfidence(EDGE_PROVENANCE);
    const pairs = buildPairs(entities, MAX_PAIRS);
    const edges: ExtractedEdge[] = [];

    vlog('extractEdges: building pairs', {
      eventId: event.id,
      entityCount: entities.length,
      pairsToAttempt: pairs.length,
      provenance: EDGE_PROVENANCE,
      confidence,
    });

    for (const [source, target] of pairs) {
      const ok = await this.mergeRelatedToEdge(
        source.nodeId,
        target.nodeId,
        confidence,
      );

      if (ok) {
        vlog('edge extracted', {
          eventId: event.id,
          source: source.label,
          target: target.label,
          relType: 'RELATED_TO',
          provenance: EDGE_PROVENANCE,
          confidence,
        });
        edges.push({
          sourceId: source.nodeId,
          sourceLabel: source.label,
          targetId: target.nodeId,
          targetLabel: target.label,
          relType: 'RELATED_TO',
          provenance: EDGE_PROVENANCE,
          confidence,
          sessionId: event.session_id,
        });
      }
    }

    vlog('extractEdges complete', { eventId: event.id, edgesCreated: edges.length });
    this.logger.debug(
      `ExtractEdges: event ${event.id} → ${edges.length} RELATED_TO edges`,
    );
    return edges;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * MERGE a RELATED_TO edge between two entity nodes.
   * Returns true on success, false if Neo4j is unavailable or query fails.
   */
  private async mergeRelatedToEdge(
    sourceId: string,
    targetId: string,
    confidence: number,
  ): Promise<boolean> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      await session.run(
        `MATCH (a:Entity {node_id: $sourceId}), (b:Entity {node_id: $targetId})
         MERGE (a)-[r:RELATED_TO]->(b)
         ON CREATE SET
           r.confidence      = $confidence,
           r.provenance_type = $provenance,
           r.created_at      = datetime()
         ON MATCH SET
           r.confidence = CASE WHEN $confidence > r.confidence
                               THEN $confidence
                               ELSE r.confidence END,
           r.updated_at = datetime()`,
        {
          sourceId,
          targetId,
          confidence,
          provenance: EDGE_PROVENANCE,
        },
      );
      return true;
    } catch (err) {
      this.logger.error(
        `mergeRelatedToEdge failed (${sourceId} -> ${targetId}): ${
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

/**
 * Build pairs from an entity list, capped at maxPairs.
 *
 * Uses the natural (i, j) ordering to keep the combination space bounded.
 * For 3 entities [A, B, C] this produces [(A,B), (A,C), (B,C)].
 */
function buildPairs(
  entities: ExtractedEntity[],
  maxPairs: number,
): Array<[ExtractedEntity, ExtractedEntity]> {
  const pairs: Array<[ExtractedEntity, ExtractedEntity]> = [];

  outer: for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      // Skip if either node_id is empty (write failed upstream).
      if (!entities[i].nodeId || !entities[j].nodeId) continue;

      pairs.push([entities[i], entities[j]]);
      if (pairs.length >= maxPairs) break outer;
    }
  }

  return pairs;
}

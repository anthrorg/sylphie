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

    if (pairs.length === 0) {
      vlog('extractEdges: no valid pairs', { eventId: event.id });
      return [];
    }

    vlog('extractEdges: batching UNWIND+MERGE', {
      eventId: event.id,
      entityCount: entities.length,
      pairsToAttempt: pairs.length,
      provenance: EDGE_PROVENANCE,
      confidence,
    });

    const edges = await this.mergeRelatedToEdgesBatched(pairs, confidence, event);

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
   * Batch MERGE RELATED_TO edges for all pairs in a single UNWIND query.
   *
   * Opens one Neo4j session, sends one UNWIND+MERGE Cypher statement for
   * all pairs, and returns the successfully created ExtractedEdge objects.
   * This replaces the previous sequential per-pair session+MERGE loop,
   * reducing up to MAX_PAIRS round-trips down to exactly one.
   *
   * Atomic failure is acceptable for co-occurrence edges — if the batch
   * fails, all pairs are lost for this cycle but will be re-derived on
   * the next maintenance run.
   */
  private async mergeRelatedToEdgesBatched(
    pairs: Array<[ExtractedEntity, ExtractedEntity]>,
    confidence: number,
    event: UnlearnedEvent,
  ): Promise<ExtractedEdge[]> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      const pairParams = pairs.map(([source, target]) => ({
        sourceId: source.nodeId,
        targetId: target.nodeId,
      }));

      const result = await session.run(
        `UNWIND $pairs AS pair
         MATCH (a:Entity {node_id: pair.sourceId}), (b:Entity {node_id: pair.targetId})
         MERGE (a)-[r:RELATED_TO]->(b)
         ON CREATE SET
           r.confidence      = $confidence,
           r.provenance_type = $provenance,
           r.created_at      = datetime()
         ON MATCH SET
           r.confidence = CASE WHEN $confidence > r.confidence
                               THEN $confidence
                               ELSE r.confidence END,
           r.updated_at = datetime()
         RETURN a.node_id AS sourceId, b.node_id AS targetId`,
        {
          pairs: pairParams,
          confidence,
          provenance: EDGE_PROVENANCE,
        },
      );

      // Build a lookup from nodeId → entity for label resolution
      const entityById = new Map<string, ExtractedEntity>();
      for (const [source, target] of pairs) {
        entityById.set(source.nodeId, source);
        entityById.set(target.nodeId, target);
      }

      const edges: ExtractedEdge[] = [];
      for (const record of result.records) {
        const sourceId = record.get('sourceId') as string;
        const targetId = record.get('targetId') as string;
        const source = entityById.get(sourceId);
        const target = entityById.get(targetId);

        if (source && target) {
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

      if (result.records.length !== pairs.length) {
        this.logger.warn(
          `extractEdges batch: expected ${pairs.length} pairs but ` +
            `${result.records.length} matched (some Entity nodes may be missing)`,
        );
      }

      return edges;
    } catch (err) {
      this.logger.error(
        `mergeRelatedToEdgesBatched failed for event ${event.id} ` +
          `(${pairs.length} pairs): ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      return [];
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

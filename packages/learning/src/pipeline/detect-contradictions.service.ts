/**
 * DetectContradictionsService — Post-refinement contradiction detection.
 *
 * CANON §Subsystem 3 (Learning): After edge refinement classifies generic
 * RELATED_TO edges into typed relationships (LIKES, DISLIKES, WORKS_AT, etc.),
 * this step checks whether any newly typed edge contradicts an existing edge
 * between the same entity pair.
 *
 * A contradiction occurs when two semantically opposing relationship types
 * exist between the same pair of entities. For example:
 *   Jim -[LIKES]-> Coffee  (existing, confidence 0.60)
 *   Jim -[DISLIKES]-> Coffee  (newly refined, confidence 0.35)
 *
 * When a contradiction is detected, a CONTRADICTS edge is created between the
 * two entity nodes, with metadata about the conflicting types and their
 * confidences. This edge is consumed by the ContradictionScannerService
 * (decision-making) during pre-action coherence checks.
 *
 * Contradiction pairs are defined by ANTONYM_PAIRS. Only typed edges (not
 * RELATED_TO) are checked — generic co-occurrence edges cannot contradict.
 *
 * This service is pure graph logic — no LLM calls. It works even when the
 * LLM is unavailable (Lesion Test support).
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Neo4jService,
  Neo4jInstanceName,
  verboseFor,
} from '@sylphie/shared';
import type {
  IDetectContradictionsService,
  ExtractedEdge,
  UnlearnedEvent,
} from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

// ---------------------------------------------------------------------------
// Antonym pairs — semantically opposing relationship types
// ---------------------------------------------------------------------------

/**
 * Map from a relationship type to its semantic antonym. If entity A has both
 * a type and its antonym toward entity B, that is a contradiction.
 */
const ANTONYM_MAP = new Map<string, string>([
  ['LIKES', 'DISLIKES'],
  ['DISLIKES', 'LIKES'],
]);

// ---------------------------------------------------------------------------
// DetectContradictionsService
// ---------------------------------------------------------------------------

@Injectable()
export class DetectContradictionsService implements IDetectContradictionsService {
  private readonly logger = new Logger(DetectContradictionsService.name);

  constructor(
    private readonly neo4j: Neo4jService,
  ) {}

  // ---------------------------------------------------------------------------
  // IDetectContradictionsService
  // ---------------------------------------------------------------------------

  async detectContradictions(
    edges: ExtractedEdge[],
    event: UnlearnedEvent,
  ): Promise<number> {
    // Only check edges that have been refined to a specific type.
    const typedEdges = edges.filter(
      (e) => e.relType !== 'RELATED_TO' && ANTONYM_MAP.has(e.relType),
    );

    if (typedEdges.length === 0) {
      vlog('detectContradictions: no typed antonym-eligible edges', {
        eventId: event.id,
        totalEdges: edges.length,
      });
      return 0;
    }

    vlog('detectContradictions: checking edges', {
      eventId: event.id,
      typedEdges: typedEdges.length,
      types: typedEdges.map((e) => e.relType),
    });

    let contradictions = 0;

    for (const edge of typedEdges) {
      const antonym = ANTONYM_MAP.get(edge.relType);
      if (!antonym) continue;

      const found = await this.checkAndCreateContradiction(edge, antonym, event);
      if (found) contradictions++;
    }

    if (contradictions > 0) {
      vlog('detectContradictions: contradictions found', {
        eventId: event.id,
        contradictions,
      });
      this.logger.log(
        `DetectContradictions: event ${event.id} → ${contradictions} contradiction(s) detected`,
      );
    }

    return contradictions;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether an antonym relationship exists for the same entity pair.
   * If so, create a CONTRADICTS edge with metadata about the conflict.
   */
  private async checkAndCreateContradiction(
    edge: ExtractedEdge,
    antonym: string,
    event: UnlearnedEvent,
  ): Promise<boolean> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      // Check for the antonym edge in either direction.
      const checkResult = await session.run(
        `MATCH (a:Entity {node_id: $sourceId})-[existing:${sanitize(antonym)}]-(b:Entity {node_id: $targetId})
         RETURN existing.confidence AS existingConfidence
         LIMIT 1`,
        { sourceId: edge.sourceId, targetId: edge.targetId },
      );

      if (checkResult.records.length === 0) {
        return false; // No antonym edge — no contradiction.
      }

      const existingConf = checkResult.records[0].get('existingConfidence') as number;

      // Create a CONTRADICTS edge with conflict metadata.
      await session.run(
        `MATCH (a:Entity {node_id: $sourceId}), (b:Entity {node_id: $targetId})
         MERGE (a)-[c:CONTRADICTS]->(b)
         ON CREATE SET
           c.claim = $claim,
           c.existingFact = $existingFact,
           c.claimConfidence = $claimConf,
           c.existingConfidence = $existingConf,
           c.detected_at = datetime(),
           c.event_id = $eventId,
           c.session_id = $sessionId,
           c.confidence = 0.50
         ON MATCH SET
           c.claim = $claim,
           c.existingFact = $existingFact,
           c.claimConfidence = $claimConf,
           c.existingConfidence = $existingConf,
           c.detected_at = datetime(),
           c.event_id = $eventId`,
        {
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          claim: `${edge.sourceLabel} ${edge.relType} ${edge.targetLabel}`,
          existingFact: `${edge.sourceLabel} ${antonym} ${edge.targetLabel}`,
          claimConf: edge.confidence,
          existingConf: existingConf,
          eventId: event.id,
          sessionId: event.session_id,
        },
      );

      vlog('contradiction created', {
        eventId: event.id,
        source: edge.sourceLabel,
        target: edge.targetLabel,
        newType: edge.relType,
        existingType: antonym,
        newConf: edge.confidence,
        existingConf,
      });

      return true;
    } catch (err) {
      this.logger.warn(
        `checkAndCreateContradiction failed for ${edge.sourceLabel} → ${edge.targetLabel}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
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

/** Sanitize a relationship type for Cypher (only alphanumeric + underscore). */
function sanitize(type: string): string {
  return type.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
}

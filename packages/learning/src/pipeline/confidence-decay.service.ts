/**
 * ConfidenceDecayService — Periodic confidence decay and garbage collection.
 *
 * CANON §Confidence Dynamics: Knowledge that is not retrieved-and-used should
 * decay over time, following ACT-R base-level activation principles. Without
 * decay, confidence is monotonically increasing (the MERGE pattern only
 * increases confidence on match), which means old incorrect facts persist
 * at artificially high confidence forever.
 *
 * This service runs as a periodic cycle (separate from the per-event
 * maintenance cycle). On each run it:
 *
 *   1. DECAY: Apply time-based confidence reduction to all nodes and edges
 *      using per-provenance decay rates from DEFAULT_DECAY_RATES.
 *      Formula: new_conf = max(0.0, old_conf - decayRate * ln(hours + 1))
 *
 *   2. PRUNE: Remove orphaned Entity nodes with confidence < PRUNE_THRESHOLD
 *      that have no relationships. Structural nodes (Drive, CoBeing,
 *      ActionProcedure) are never pruned.
 *
 * The decay formula is a simplified ACT-R model that uses the node's
 * updated_at (or created_at) timestamp in place of lastRetrievalAt, since
 * retrieval counts are not yet tracked on nodes. The per-provenance decay
 * rates ensure GUARDIAN knowledge decays slowest and LLM_GENERATED decays
 * fastest, matching the epistemic trust hierarchy.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Neo4jService,
  Neo4jInstanceName,
  verboseFor,
} from '@sylphie/shared';
import type { IConfidenceDecayService, DecayCycleResult } from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Nodes below this confidence with no edges are pruned. */
const PRUNE_THRESHOLD = 0.10;

/** Minimum hours since last activity before decay applies. Prevents
 *  freshly-touched nodes from being decayed on the same cycle. */
const MIN_HOURS_BEFORE_DECAY = 1.0;

// ---------------------------------------------------------------------------
// ConfidenceDecayService
// ---------------------------------------------------------------------------

@Injectable()
export class ConfidenceDecayService implements IConfidenceDecayService {
  private readonly logger = new Logger(ConfidenceDecayService.name);

  constructor(
    private readonly neo4j: Neo4jService,
  ) {}

  // ---------------------------------------------------------------------------
  // IConfidenceDecayService
  // ---------------------------------------------------------------------------

  async runDecayCycle(): Promise<DecayCycleResult> {
    const t0 = Date.now();

    const nodesDecayed = await this.decayNodes();
    const edgesDecayed = await this.decayEdges();
    const nodesPruned = await this.pruneOrphanedNodes();

    const durationMs = Date.now() - t0;

    vlog('decay cycle complete', { nodesDecayed, edgesDecayed, nodesPruned, durationMs });
    this.logger.log(
      `Decay cycle: ${nodesDecayed} nodes decayed, ${edgesDecayed} edges decayed, ` +
        `${nodesPruned} orphans pruned (${durationMs}ms)`,
    );

    return { nodesDecayed, edgesDecayed, nodesPruned, wasNoop: nodesDecayed + edgesDecayed + nodesPruned === 0 };
  }

  // ---------------------------------------------------------------------------
  // Private: decay nodes
  // ---------------------------------------------------------------------------

  /**
   * Apply time-based confidence decay to all nodes in WORLD.
   *
   * Excludes schema-level nodes (bootstrap anchors like Drive, CoBeing) and
   * nodes that were touched less than MIN_HOURS_BEFORE_DECAY ago.
   *
   * The decay rates are per-provenance (CANON §Confidence Dynamics):
   *   SENSOR:        0.05
   *   GUARDIAN:       0.03  (slowest — guardian-taught facts are durable)
   *   LLM_GENERATED: 0.08  (fastest — must be re-validated or it fades)
   *   INFERENCE:      0.06
   */
  private async decayNodes(): Promise<number> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      const result = await session.run(
        `MATCH (n)
         WHERE n.confidence > $pruneThreshold
           AND n.schema_level <> 'schema'
           AND NOT n:Drive AND NOT n:CoBeing
         WITH n,
              CASE WHEN n.updated_at IS NOT NULL THEN n.updated_at
                   ELSE n.created_at END AS lastActivity
         WHERE lastActivity IS NOT NULL
         WITH n, lastActivity,
              (datetime().epochMillis - lastActivity.epochMillis) / 3600000.0 AS hoursSince,
              CASE n.provenance_type
                WHEN 'SENSOR'        THEN 0.05
                WHEN 'GUARDIAN'       THEN 0.03
                WHEN 'LLM_GENERATED' THEN 0.08
                WHEN 'INFERENCE'     THEN 0.06
                ELSE 0.05
              END AS decayRate
         WHERE hoursSince > $minHours
         WITH n, n.confidence - decayRate * log(hoursSince + 1) AS newConf
         WHERE newConf < n.confidence
         SET n.confidence = CASE WHEN newConf < 0.0 THEN 0.0 ELSE newConf END,
             n.decayed_at = datetime()
         RETURN count(n) AS decayed`,
        { pruneThreshold: PRUNE_THRESHOLD, minHours: MIN_HOURS_BEFORE_DECAY },
      );

      const record = result.records[0];
      return record ? toNumber(record.get('decayed')) : 0;
    } catch (err) {
      this.logger.warn(
        `decayNodes failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Private: decay edges
  // ---------------------------------------------------------------------------

  /**
   * Apply time-based confidence decay to all edges in WORLD.
   * Same formula and provenance-based rates as node decay.
   */
  private async decayEdges(): Promise<number> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      const result = await session.run(
        `MATCH ()-[r]->()
         WHERE r.confidence IS NOT NULL
           AND r.confidence > $pruneThreshold
         WITH r,
              CASE WHEN r.updated_at IS NOT NULL THEN r.updated_at
                   ELSE r.created_at END AS lastActivity
         WHERE lastActivity IS NOT NULL
         WITH r, lastActivity,
              (datetime().epochMillis - lastActivity.epochMillis) / 3600000.0 AS hoursSince,
              CASE r.provenance_type
                WHEN 'SENSOR'        THEN 0.05
                WHEN 'GUARDIAN'       THEN 0.03
                WHEN 'LLM_GENERATED' THEN 0.08
                WHEN 'INFERENCE'     THEN 0.06
                ELSE 0.05
              END AS decayRate
         WHERE hoursSince > $minHours
         WITH r, r.confidence - decayRate * log(hoursSince + 1) AS newConf
         WHERE newConf < r.confidence
         SET r.confidence = CASE WHEN newConf < 0.0 THEN 0.0 ELSE newConf END,
             r.decayed_at = datetime()
         RETURN count(r) AS decayed`,
        { pruneThreshold: PRUNE_THRESHOLD, minHours: MIN_HOURS_BEFORE_DECAY },
      );

      const record = result.records[0];
      return record ? toNumber(record.get('decayed')) : 0;
    } catch (err) {
      this.logger.warn(
        `decayEdges failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Private: prune orphaned nodes
  // ---------------------------------------------------------------------------

  /**
   * Remove Entity nodes with confidence below PRUNE_THRESHOLD that have no
   * relationships. Structural nodes (Drive, CoBeing, ActionProcedure,
   * Conversation, Insight, Word) are never pruned.
   */
  private async pruneOrphanedNodes(): Promise<number> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    try {
      const result = await session.run(
        `MATCH (n:Entity)
         WHERE n.confidence <= $pruneThreshold
           AND NOT n:Drive AND NOT n:CoBeing AND NOT n:ActionProcedure
           AND NOT n:Conversation AND NOT n:Insight AND NOT n:Word
           AND NOT EXISTS { (n)--() }
         DELETE n
         RETURN count(n) AS pruned`,
        { pruneThreshold: PRUNE_THRESHOLD },
      );

      const record = result.records[0];
      return record ? toNumber(record.get('pruned')) : 0;
    } catch (err) {
      this.logger.warn(
        `pruneOrphanedNodes failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    } finally {
      await session.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert Neo4j Integer to plain number. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'toNumber' in v) {
    return (v as { toNumber(): number }).toNumber();
  }
  return 0;
}

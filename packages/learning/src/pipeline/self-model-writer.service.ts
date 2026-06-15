/**
 * SelfModelWriterService — Self-model write cycle for the Learning subsystem.
 *
 * CANON §Provenance Is Sacred (Std-2), §Confidence Ceiling (Std-3), and
 * §Theater Prohibition (Std-1) govern every line of this service.
 *
 * What this service writes
 * ------------------------
 * THREE honest :Capability nodes in the SELF Neo4j graph, each from its own
 * grounded TimescaleDB telemetry source:
 *
 *   1. :Capability {name='prediction_accuracy'} + paired :PredictionAccuracy
 *      {domain='drive_effects'} — from PREDICTION_EVALUATED events.
 *
 *   2. :Capability {name='knowledge_retrieval'} (NO paired node) — from
 *      RESPONSE_GENERATED events carrying knowledgeGrounding + intent. The
 *      metric counts GROUNDED responses over (GROUNDED|UNKNOWN) responses on
 *      turns where retrieval was actually DEMANDED (intent='QUESTION').
 *
 *   3. :Capability {name='social_interaction'} (NO paired node) — from
 *      SOCIAL_COMMENT_INITIATED events (emitted ONLY for genuinely proactive,
 *      self-initiated, no-originator comments). The metric counts bids that
 *      earned a guardian reply (GUARDIAN_CONFIRMATION|GUARDIAN_INPUT_RECEIVED)
 *      in the SAME session within 30 seconds, over all such proactive bids.
 *
 * All three capabilities refresh together in the same cycle, each over its own
 * independent 24-hour sample window. A capability with zero qualifying rows in
 * its window writes NOTHING and DETACH DELETEs its stale node (see Zero-sample).
 *
 * Deliberately OMITTED capabilities (no honest telemetry source today):
 *   - error_correction     — unblock: persist a contradiction-resolution event.
 *   - :DrivePattern nodes  — unblock: persist observed drive-stimulus pairs.
 *
 * Theater Prohibition (Std-1) filters
 * -----------------------------------
 * prediction_accuracy: ~54% of PREDICTION_EVALUATED rows have empty
 *   predictedEffects ({}).  These are trivially "accurate" because
 *   prediction.service.ts fills novel predictions with random deltas — they
 *   carry no real predictive signal.  Filtered out with
 *   `payload->'predictedEffects' <> '{}'::jsonb`.
 *
 * knowledge_retrieval: EXCLUDES knowledgeGrounding='LLM_ASSISTED' (social /
 *   greeting turns where no retrieval was attempted — counting them measures
 *   chat volume, not competence) AND restricts to intent='QUESTION' (turns
 *   where retrieval was actually demanded, removing the UNKNOWN ambiguity of
 *   tried-and-failed vs no-retrieval-needed). Null grounding/intent excluded.
 *
 * Zero-sample guard
 * -----------------
 * If no qualifying rows exist in the 24-hour window, the service writes
 * NOTHING and DETACH DELETEs any stale :Capability / :PredictionAccuracy
 * nodes so the reader (SelfAssessmentService) never serves a fabricated rate.
 *
 * Confidence ceiling (Std-3)
 * --------------------------
 * confidence = min(0.60, sampleCount / (sampleCount + 50))
 * Clamped at the write source.  The reader and the drive re-clamp defensively,
 * but storing an honest value avoids silent Std-3 violations in the SELF graph.
 *
 * Provenance (Std-2)
 * ------------------
 * provenance_type = 'INFERENCE' — a system-computed aggregate, not a guardian
 * judgment.  Stamping GUARDIAN here would violate Std-2 and Std-3.
 *
 * SELF-graph write path
 * ---------------------
 * Uses Neo4jService.getSession(Neo4jInstanceName.SELF, 'WRITE') — the same
 * established write path as WkgBootstrapService (wkg-bootstrap.service.ts:142)
 * and UpsertEntitiesService (upsert-entities.service.ts:93).  No raw driver is
 * introduced.
 *
 * MERGE keys (idempotent re-runs, no duplicate nodes):
 *   MERGE (c:Capability {node_id: 'self-cap-prediction_accuracy'})
 *   MERGE (a:PredictionAccuracy {domain: 'drive_effects'})
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Neo4jService,
  Neo4jInstanceName,
  TimescaleService,
  verboseFor,
} from '@sylphie/shared';
import type {
  ISelfModelWriterService,
  SelfModelCycleResult,
  CapabilityWriteResult,
} from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Std-3 ceiling for INFERENCE-sourced capability confidence. */
const CONFIDENCE_CEILING = 0.60;

/**
 * Confidence formula denominator addend: sampleCount / (sampleCount + K).
 * K=50 means you need 50 qualifying samples to reach 0.50 confidence,
 * and effectively infinite samples to reach the 0.60 ceiling.
 */
const CONFIDENCE_K = 50;

/** SELF-graph node_id for the prediction_accuracy Capability. */
const CAPABILITY_NODE_ID = 'self-cap-prediction_accuracy';

/** Domain key for the PredictionAccuracy node paired to this capability. */
const PREDICTION_ACCURACY_DOMAIN = 'drive_effects';

/** SELF-graph node_id for the knowledge_retrieval Capability (no paired node). */
const KNOWLEDGE_RETRIEVAL_NODE_ID = 'self-cap-knowledge_retrieval';

/** SELF-graph node_id for the social_interaction Capability (no paired node). */
const SOCIAL_INTERACTION_NODE_ID = 'self-cap-social_interaction';

// ---------------------------------------------------------------------------
// Row types from TimescaleDB queries
// ---------------------------------------------------------------------------

interface PredictionStatsRow {
  sample_count: string;  // pg returns numeric columns as strings
  accurate_count: string;
  avg_mae: string | null;
}

interface KnowledgeStatsRow {
  sample_count: string;   // (GROUNDED|UNKNOWN) AND intent=QUESTION
  success_count: string;  // GROUNDED AND intent=QUESTION
}

interface SocialStatsRow {
  sample_count: string;   // SOCIAL_COMMENT_INITIATED with non-null session_id
  success_count: string;  // those with a guardian reply in the same session ≤30s later
}

// ---------------------------------------------------------------------------
// SelfModelWriterService
// ---------------------------------------------------------------------------

@Injectable()
export class SelfModelWriterService implements ISelfModelWriterService {
  private readonly logger = new Logger(SelfModelWriterService.name);

  constructor(
    private readonly neo4j: Neo4jService,
    private readonly timescale: TimescaleService,
  ) {}

  // ---------------------------------------------------------------------------
  // ISelfModelWriterService
  // ---------------------------------------------------------------------------

  async runSelfModelCycle(): Promise<SelfModelCycleResult> {
    try {
      // Both capabilities refresh together, each over its own honest window.
      // prediction_accuracy is the back-compat top-level result; knowledge_retrieval
      // is reported additively in the nested field.
      const prediction = await this.refreshPredictionAccuracy();
      const knowledgeRetrieval = await this.refreshKnowledgeRetrieval();
      const socialInteraction = await this.refreshSocialInteraction();

      return {
        wrote: prediction.wrote,
        sampleCount: prediction.sampleCount,
        successRate: prediction.successRate,
        confidence: prediction.confidence,
        wasNoop: false,
        knowledgeRetrieval,
        socialInteraction,
      };
    } catch (err) {
      this.logger.error(
        `Self-model cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        wrote: false,
        sampleCount: 0,
        successRate: null,
        confidence: null,
        wasNoop: true,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private: prediction_accuracy capability
  // ---------------------------------------------------------------------------

  /**
   * Refresh the prediction_accuracy :Capability (+ paired :PredictionAccuracy)
   * from PREDICTION_EVALUATED telemetry. Zero qualifying samples → DETACH DELETE
   * the stale nodes (never serve a fabricated rate).
   */
  private async refreshPredictionAccuracy(): Promise<CapabilityWriteResult> {
    const stats = await this.queryPredictionStats();
    const sampleCount = parseInt(stats.sample_count, 10);

    if (sampleCount === 0) {
      vlog('self-model cycle: prediction_accuracy zero samples — DETACH DELETE stale nodes', {});
      await this.deletePredictionNodes();
      return { wrote: false, sampleCount: 0, successRate: null, confidence: null };
    }

    const accurateCount = parseInt(stats.accurate_count, 10);
    const successRate = accurateCount / sampleCount;
    const avgMae = stats.avg_mae != null ? parseFloat(stats.avg_mae) : 0;

    // Std-3 ceiling: clamp at source so the stored graph is honest.
    const rawConfidence = sampleCount / (sampleCount + CONFIDENCE_K);
    const confidence = Math.min(CONFIDENCE_CEILING, rawConfidence);

    vlog('self-model cycle: writing prediction_accuracy nodes', {
      sampleCount,
      accurateCount,
      successRate,
      avgMae,
      confidence,
    });

    await this.writeCapabilityNodes(sampleCount, successRate, confidence, avgMae);

    this.logger.log(
      `Self-model cycle: wrote prediction_accuracy capability ` +
        `(n=${sampleCount}, success=${successRate.toFixed(3)}, conf=${confidence.toFixed(3)})`,
    );

    return { wrote: true, sampleCount, successRate, confidence };
  }

  // ---------------------------------------------------------------------------
  // Private: knowledge_retrieval capability
  // ---------------------------------------------------------------------------

  /**
   * Refresh the knowledge_retrieval :Capability from RESPONSE_GENERATED
   * telemetry. Structurally identical to prediction_accuracy: 24-hour window,
   * Std-1 theater filter (LLM_ASSISTED + non-QUESTION + null excluded), Std-3
   * confidence ceiling, Std-2 INFERENCE provenance, zero-sample DETACH DELETE.
   * NO paired node — knowledge_retrieval needs only the :Capability node.
   */
  private async refreshKnowledgeRetrieval(): Promise<CapabilityWriteResult> {
    const stats = await this.queryKnowledgeStats();
    const sampleCount = parseInt(stats.sample_count, 10);

    if (sampleCount === 0) {
      vlog('self-model cycle: knowledge_retrieval zero samples — DETACH DELETE stale node', {});
      await this.deleteKnowledgeNode();
      return { wrote: false, sampleCount: 0, successRate: null, confidence: null };
    }

    const successCount = parseInt(stats.success_count, 10);
    const successRate = successCount / sampleCount;

    // Std-3 ceiling: clamp at source so the stored graph is honest.
    const rawConfidence = sampleCount / (sampleCount + CONFIDENCE_K);
    const confidence = Math.min(CONFIDENCE_CEILING, rawConfidence);

    vlog('self-model cycle: writing knowledge_retrieval node', {
      sampleCount,
      successCount,
      successRate,
      confidence,
    });

    await this.writeKnowledgeRetrievalNode(sampleCount, successRate, confidence);

    this.logger.log(
      `Self-model cycle: wrote knowledge_retrieval capability ` +
        `(n=${sampleCount}, success=${successRate.toFixed(3)}, conf=${confidence.toFixed(3)})`,
    );

    return { wrote: true, sampleCount, successRate, confidence };
  }

  // ---------------------------------------------------------------------------
  // Private: social_interaction capability
  // ---------------------------------------------------------------------------

  /**
   * Refresh the social_interaction :Capability from SOCIAL_COMMENT_INITIATED
   * telemetry. Structurally identical to knowledge_retrieval: 24-hour window,
   * Std-1 honest denominator (PROACTIVE bids only), Std-3 confidence ceiling,
   * Std-2 INFERENCE provenance, zero-sample DETACH DELETE. NO paired node.
   *
   * Std-1 honest metric: SOCIAL_COMMENT_INITIATED is emitted ONLY for genuinely
   * proactive (self-initiated, no-originator) comments — see
   * decision-making.service.ts reportOutcome(). The success self-join counts a
   * bid as successful iff a guardian reply (GUARDIAN_CONFIRMATION or
   * GUARDIAN_INPUT_RECEIVED) lands in the SAME session within 30 seconds. This
   * measures whether Sylphie's UNPROMPTED bids land, NOT whether a conversation
   * continued (the drive-side socialCommentTimestamp fires on every reply and is
   * deliberately NOT used here).
   */
  private async refreshSocialInteraction(): Promise<CapabilityWriteResult> {
    const stats = await this.querySocialStats();
    const sampleCount = parseInt(stats.sample_count, 10);

    if (sampleCount === 0) {
      vlog('self-model cycle: social_interaction zero samples — DETACH DELETE stale node', {});
      await this.deleteSocialNode();
      return { wrote: false, sampleCount: 0, successRate: null, confidence: null };
    }

    const successCount = parseInt(stats.success_count, 10);
    const successRate = successCount / sampleCount;

    // Std-3 ceiling: clamp at source so the stored graph is honest.
    const rawConfidence = sampleCount / (sampleCount + CONFIDENCE_K);
    const confidence = Math.min(CONFIDENCE_CEILING, rawConfidence);

    vlog('self-model cycle: writing social_interaction node', {
      sampleCount,
      successCount,
      successRate,
      confidence,
    });

    await this.writeSocialInteractionNode(sampleCount, successRate, confidence);

    this.logger.log(
      `Self-model cycle: wrote social_interaction capability ` +
        `(n=${sampleCount}, success=${successRate.toFixed(3)}, conf=${confidence.toFixed(3)})`,
    );

    return { wrote: true, sampleCount, successRate, confidence };
  }

  // ---------------------------------------------------------------------------
  // Private: TimescaleDB query
  // ---------------------------------------------------------------------------

  /**
   * Query PREDICTION_EVALUATED events in the last 24 hours, excluding rows
   * with empty predictedEffects (theater prohibition — those rows are trivially
   * "accurate" because prediction.service.ts fills novel predictions with
   * random deltas that are never checked against reality).
   */
  private async queryPredictionStats(): Promise<PredictionStatsRow> {
    const result = await this.timescale.query<PredictionStatsRow>(
      `SELECT
         count(*)                                                AS sample_count,
         count(*) FILTER (WHERE (payload->>'accurate')::boolean) AS accurate_count,
         avg((payload->>'mae')::numeric)                         AS avg_mae
       FROM events
       WHERE type = 'PREDICTION_EVALUATED'
         AND timestamp > now() - interval '24 hours'
         AND payload->'predictedEffects' <> '{}'::jsonb`,
    );

    // pg always returns exactly one row from an aggregate query.
    const row = result.rows[0];
    if (!row) {
      // Should never happen with a COUNT aggregate, but guard defensively.
      return { sample_count: '0', accurate_count: '0', avg_mae: null };
    }
    return row;
  }

  /**
   * Query RESPONSE_GENERATED events in the last 24 hours for the
   * knowledge_retrieval metric (CANON Std-1 — the whole point of this metric).
   *
   *   denominator (sample_count) = knowledgeGrounding IN ('GROUNDED','UNKNOWN')
   *   numerator   (success_count) = knowledgeGrounding = 'GROUNDED'
   *
   * Both restricted to intent='QUESTION' (turns where retrieval was actually
   * DEMANDED) and knowledgeGrounding IS NOT NULL. LLM_ASSISTED (social/greeting,
   * no retrieval attempted) is EXCLUDED — counting it would measure chat volume,
   * not retrieval competence.
   */
  private async queryKnowledgeStats(): Promise<KnowledgeStatsRow> {
    const result = await this.timescale.query<KnowledgeStatsRow>(
      `SELECT
         count(*) FILTER (WHERE payload->>'knowledgeGrounding' IN ('GROUNDED','UNKNOWN')) AS sample_count,
         count(*) FILTER (WHERE payload->>'knowledgeGrounding' = 'GROUNDED')             AS success_count
       FROM events
       WHERE type = 'RESPONSE_GENERATED'
         AND timestamp > now() - interval '24 hours'
         AND payload->>'knowledgeGrounding' IS NOT NULL
         AND payload->>'intent' = 'QUESTION'`,
    );

    // pg always returns exactly one row from an aggregate query.
    const row = result.rows[0];
    if (!row) {
      return { sample_count: '0', success_count: '0' };
    }
    return row;
  }

  /**
   * Query SOCIAL_COMMENT_INITIATED events in the last 24 hours for the
   * social_interaction metric (CANON Std-1 — proactive bids only).
   *
   *   denominator (sample_count) = SOCIAL_COMMENT_INITIATED rows with a non-null
   *                                session_id (the self-join requires it).
   *   numerator   (success_count) = those followed by a guardian reply
   *                                (GUARDIAN_CONFIRMATION or GUARDIAN_INPUT_RECEIVED)
   *                                in the SAME session > t and ≤ t+30s.
   *
   * SOCIAL_COMMENT_INITIATED is emitted ONLY for genuinely proactive
   * (self-initiated, no-originator) comments, so the denominator never includes
   * reactive replies — that is the whole point of the metric.
   */
  private async querySocialStats(): Promise<SocialStatsRow> {
    const result = await this.timescale.query<SocialStatsRow>(
      `WITH initiations AS (
         SELECT id, session_id, timestamp FROM events
         WHERE type = 'SOCIAL_COMMENT_INITIATED'
           AND timestamp > now() - interval '24 hours'
           AND session_id IS NOT NULL
       )
       SELECT count(*) AS sample_count,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM events g
           WHERE g.session_id = i.session_id
             AND g.type IN ('GUARDIAN_CONFIRMATION','GUARDIAN_INPUT_RECEIVED')
             AND g.timestamp > i.timestamp
             AND g.timestamp <= i.timestamp + interval '30 seconds'
         )) AS success_count
       FROM initiations i`,
    );

    // pg always returns exactly one row from an aggregate query.
    const row = result.rows[0];
    if (!row) {
      return { sample_count: '0', success_count: '0' };
    }
    return row;
  }

  // ---------------------------------------------------------------------------
  // Private: SELF-graph writes
  // ---------------------------------------------------------------------------

  /**
   * MERGE :Capability + :PredictionAccuracy nodes into the SELF graph.
   *
   * Uses the exact property names that SelfAssessmentService reads:
   *   Capability:          node_id, name, success_rate, confidence, sample_count,
   *                        last_executed, provenance_type
   *   PredictionAccuracy:  domain, mae, sample_count, confidence, last_updated
   *
   * Provenance is INFERENCE for both (system-computed aggregate, not guardian).
   */
  private async writeCapabilityNodes(
    sampleCount: number,
    successRate: number,
    confidence: number,
    avgMae: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    const session = this.neo4j.getSession(Neo4jInstanceName.SELF, 'WRITE');
    try {
      // :Capability node
      await session.run(
        `MERGE (c:Capability {node_id: $nodeId})
         SET c.name           = 'prediction_accuracy',
             c.success_rate   = $successRate,
             c.confidence     = $confidence,
             c.sample_count   = $sampleCount,
             c.last_executed  = $now,
             c.provenance_type = 'INFERENCE'`,
        {
          nodeId: CAPABILITY_NODE_ID,
          successRate,
          confidence,
          sampleCount,
          now,
        },
      );

      // :PredictionAccuracy node (paired — read by SelfAssessmentService.readPredictionAccuracy)
      await session.run(
        `MERGE (a:PredictionAccuracy {domain: $domain})
         SET a.mae          = $avgMae,
             a.sample_count = $sampleCount,
             a.confidence   = $confidence,
             a.last_updated = $now`,
        {
          domain: PREDICTION_ACCURACY_DOMAIN,
          avgMae,
          sampleCount,
          confidence,
          now,
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * MERGE the knowledge_retrieval :Capability node into the SELF graph.
   *
   * Uses the EXACT property names SelfAssessmentService.readCapabilities reads:
   *   node_id, name, success_rate, confidence, sample_count, last_executed,
   *   provenance_type. No paired node — knowledge_retrieval needs only this one.
   *
   * Provenance is INFERENCE (system-computed aggregate, not a guardian judgment).
   * The drive maps knowledge_retrieval → CognitiveAwareness and INFERENCE →
   * recovery-toward-default only (no MAIN→drive read; MAIN pushes, drive judges).
   */
  private async writeKnowledgeRetrievalNode(
    sampleCount: number,
    successRate: number,
    confidence: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    const session = this.neo4j.getSession(Neo4jInstanceName.SELF, 'WRITE');
    try {
      await session.run(
        `MERGE (c:Capability {node_id: $nodeId})
         SET c.name           = 'knowledge_retrieval',
             c.success_rate   = $successRate,
             c.confidence     = $confidence,
             c.sample_count   = $sampleCount,
             c.last_executed  = $now,
             c.provenance_type = 'INFERENCE'`,
        {
          nodeId: KNOWLEDGE_RETRIEVAL_NODE_ID,
          successRate,
          confidence,
          sampleCount,
          now,
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * DETACH DELETE stale prediction_accuracy :Capability and :PredictionAccuracy
   * nodes when the 24-hour query window returns zero qualifying samples. Ensures
   * the reader never serves a fabricated rate from a previous window.
   */
  private async deletePredictionNodes(): Promise<void> {
    const session = this.neo4j.getSession(Neo4jInstanceName.SELF, 'WRITE');
    try {
      await session.run(
        `MATCH (c:Capability {node_id: $nodeId}) DETACH DELETE c`,
        { nodeId: CAPABILITY_NODE_ID },
      );
      await session.run(
        `MATCH (a:PredictionAccuracy {domain: $domain}) DETACH DELETE a`,
        { domain: PREDICTION_ACCURACY_DOMAIN },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * DETACH DELETE the stale knowledge_retrieval :Capability node when its
   * 24-hour window returns zero qualifying samples. Same honesty guard as
   * prediction_accuracy — the reader must never serve a fabricated rate.
   */
  private async deleteKnowledgeNode(): Promise<void> {
    const session = this.neo4j.getSession(Neo4jInstanceName.SELF, 'WRITE');
    try {
      await session.run(
        `MATCH (c:Capability {node_id: $nodeId}) DETACH DELETE c`,
        { nodeId: KNOWLEDGE_RETRIEVAL_NODE_ID },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * MERGE the social_interaction :Capability node into the SELF graph.
   *
   * Uses the EXACT property names SelfAssessmentService.readCapabilities reads:
   *   node_id, name, success_rate, confidence, sample_count, last_executed,
   *   provenance_type. No paired node — social_interaction needs only this one.
   *
   * Provenance is INFERENCE (system-computed aggregate, not a guardian judgment).
   * The drive maps social_interaction → Social and INFERENCE →
   * recovery-toward-default only (no MAIN→drive read; MAIN pushes, drive judges).
   */
  private async writeSocialInteractionNode(
    sampleCount: number,
    successRate: number,
    confidence: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    const session = this.neo4j.getSession(Neo4jInstanceName.SELF, 'WRITE');
    try {
      await session.run(
        `MERGE (c:Capability {node_id: $nodeId})
         SET c.name           = 'social_interaction',
             c.success_rate   = $successRate,
             c.confidence     = $confidence,
             c.sample_count   = $sampleCount,
             c.last_executed  = $now,
             c.provenance_type = 'INFERENCE'`,
        {
          nodeId: SOCIAL_INTERACTION_NODE_ID,
          successRate,
          confidence,
          sampleCount,
          now,
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * DETACH DELETE the stale social_interaction :Capability node when its
   * 24-hour window returns zero qualifying samples. Same honesty guard as the
   * other capabilities — the reader must never serve a fabricated rate.
   */
  private async deleteSocialNode(): Promise<void> {
    const session = this.neo4j.getSession(Neo4jInstanceName.SELF, 'WRITE');
    try {
      await session.run(
        `MATCH (c:Capability {node_id: $nodeId}) DETACH DELETE c`,
        { nodeId: SOCIAL_INTERACTION_NODE_ID },
      );
    } finally {
      await session.close();
    }
  }
}

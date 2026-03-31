/**
 * ObservatoryService — backend computation for the Observatory Dashboard.
 *
 * Provides the 7 analytics methods called by the 7 GET /api/metrics/observatory/*
 * endpoints. Each method is self-contained, wraps its query in try/catch, and
 * returns a well-typed result or a graceful empty fallback.
 *
 * Data sources:
 *  - Neo4j WKG via WKG_SERVICE: vocabulary growth, phrase recognition
 *  - TimescaleDB via TIMESCALEDB_POOL: drive evolution, action diversity,
 *    developmental stage, comprehension accuracy
 *  - PostgreSQL via POSTGRES_RUNTIME_POOL: session comparison
 *
 * CANON §Development Metrics: These seven charts are the primary instrument
 * panel for Phase 1. They must never return 500 errors — degraded data is
 * preferable to a dashboard crash.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { TIMESCALEDB_POOL } from '../../events/events.tokens';
import { POSTGRES_RUNTIME_POOL } from '../../database/database.tokens';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';

// ---------------------------------------------------------------------------
// Return types for each Observatory endpoint
// ---------------------------------------------------------------------------

export interface VocabularyGrowthResponse {
  days: Array<{
    date: string;
    newNodes: number;
    cumulativeTotal: number;
    byLabel: Record<string, number>;
    byProvenance: Record<string, number>;
  }>;
}

export interface DriveEvolutionSession {
  sessionId: string;
  drives: Record<string, number>;
  sampleCount: number;
}

export interface DriveEvolutionResponse {
  sessions: DriveEvolutionSession[];
}

export interface ActionDiversitySession {
  sessionId: string;
  uniqueActionTypes: number;
  totalActions: number;
  diversityIndex: number;
}

export interface ActionDiversityResponse {
  sessions: ActionDiversitySession[];
}

export interface DevelopmentalStageSession {
  sessionId: string;
  type1Count: number;
  type2Count: number;
  ratio: number;
}

export interface DevelopmentalStageResponse {
  sessions: DevelopmentalStageSession[];
  overall: {
    stage: string;
    type1Pct: number;
  };
}

export interface SessionComparisonRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  metricsSnapshot: Record<string, unknown> | null;
}

export interface SessionComparisonResponse {
  sessions: SessionComparisonRow[];
}

export interface ComprehensionAccuracySession {
  sessionId: string;
  mae: number;
  sampleCount: number;
}

export interface ComprehensionAccuracyResponse {
  sessions: ComprehensionAccuracySession[];
}

export interface PhraseRecognitionResponse {
  totalUtterances: number;
  recognizedCount: number;
  ratio: number;
  byProvenance: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ObservatoryService {
  private readonly logger = new Logger(ObservatoryService.name);

  /** 5-minute TTL cache for the vocabulary growth query (expensive). */
  private vocabGrowthCache: { data: VocabularyGrowthResponse; expiresAt: number } | null = null;
  private readonly vocabGrowthTtlMs = 5 * 60 * 1000;

  constructor(
    @Inject(WKG_SERVICE) private readonly wkg: IWkgService,
    @Inject(TIMESCALEDB_POOL) private readonly tsPool: Pool,
    @Inject(POSTGRES_RUNTIME_POOL) private readonly pgPool: Pool,
  ) {}

  // ---------------------------------------------------------------------------
  // 1. Vocabulary Growth
  // ---------------------------------------------------------------------------

  /**
   * Count WKG nodes by creation date bucket (daily), grouped by label and provenance.
   *
   * Result is cached for 5 minutes because the underlying Neo4j MATCH-all scan
   * is expensive and vocabulary only changes when Learning runs.
   */
  async getVocabularyGrowth(): Promise<VocabularyGrowthResponse> {
    const now = Date.now();

    if (this.vocabGrowthCache && this.vocabGrowthCache.expiresAt > now) {
      return this.vocabGrowthCache.data;
    }

    try {
      const days = await this.wkg.queryVocabularyGrowth();
      const response: VocabularyGrowthResponse = { days };
      this.vocabGrowthCache = { data: response, expiresAt: now + this.vocabGrowthTtlMs };
      return response;
    } catch (error) {
      this.logger.warn(
        `getVocabularyGrowth: Neo4j unavailable — ${error instanceof Error ? error.message : String(error)}`,
      );
      return { days: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Drive Evolution
  // ---------------------------------------------------------------------------

  /**
   * Mean drive values per session from DRIVE_TICK events.
   *
   * Extracts per-drive averages from drive_snapshot->'pressureVector' JSONB.
   * Sessions are identified via event_data->>'sessionId'. Sessions with no
   * drive_snapshot data are excluded.
   */
  async getDriveEvolution(): Promise<DriveEvolutionResponse> {
    const sql = `
      SELECT
        event_data->>'sessionId'                                                   AS session_id,
        AVG((drive_snapshot->'pressureVector'->>'systemHealth')::float)            AS system_health,
        AVG((drive_snapshot->'pressureVector'->>'moralValence')::float)            AS moral_valence,
        AVG((drive_snapshot->'pressureVector'->>'integrity')::float)               AS integrity,
        AVG((drive_snapshot->'pressureVector'->>'cognitiveAwareness')::float)      AS cognitive_awareness,
        AVG((drive_snapshot->'pressureVector'->>'guilt')::float)                   AS guilt,
        AVG((drive_snapshot->'pressureVector'->>'curiosity')::float)               AS curiosity,
        AVG((drive_snapshot->'pressureVector'->>'boredom')::float)                 AS boredom,
        AVG((drive_snapshot->'pressureVector'->>'anxiety')::float)                 AS anxiety,
        AVG((drive_snapshot->'pressureVector'->>'satisfaction')::float)            AS satisfaction,
        AVG((drive_snapshot->'pressureVector'->>'sadness')::float)                 AS sadness,
        AVG((drive_snapshot->'pressureVector'->>'informationIntegrity')::float)    AS information_integrity,
        AVG((drive_snapshot->'pressureVector'->>'social')::float)                  AS social,
        COUNT(*)                                                                    AS sample_count
      FROM events
      WHERE event_type = 'DRIVE_TICK'
        AND drive_snapshot IS NOT NULL
        AND event_data->>'sessionId' IS NOT NULL
      GROUP BY event_data->>'sessionId'
      ORDER BY MIN(timestamp) ASC
      LIMIT 500
    `;

    try {
      const result = await this.tsPool.query(sql);

      const sessions: DriveEvolutionSession[] = result.rows.map(row => {
        const drives: Record<string, number> = {};
        const driveKeys = [
          'system_health', 'moral_valence', 'integrity', 'cognitive_awareness',
          'guilt', 'curiosity', 'boredom', 'anxiety',
          'satisfaction', 'sadness', 'information_integrity', 'social',
        ];

        for (const key of driveKeys) {
          const val = row[key];
          if (val !== null && val !== undefined) {
            drives[key] = parseFloat(val);
          }
        }

        return {
          sessionId: row.session_id as string,
          drives,
          sampleCount: parseInt(row.sample_count as string, 10),
        };
      });

      return { sessions };
    } catch (error) {
      this.logger.warn(
        `getDriveEvolution: TimescaleDB unavailable — ${error instanceof Error ? error.message : String(error)}`,
      );
      return { sessions: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Action Diversity
  // ---------------------------------------------------------------------------

  /**
   * Count distinct actionType values from OUTCOME_PROCESSED events per session.
   *
   * The diversity index is uniqueActionTypes / totalActions, clamped to [0, 1].
   */
  async getActionDiversity(): Promise<ActionDiversityResponse> {
    const sql = `
      SELECT
        event_data->>'sessionId'                         AS session_id,
        COUNT(DISTINCT event_data->>'actionType')        AS unique_action_types,
        COUNT(*)                                         AS total_actions
      FROM events
      WHERE event_type = 'OUTCOME_PROCESSED'
        AND event_data->>'actionType' IS NOT NULL
        AND event_data->>'sessionId' IS NOT NULL
      GROUP BY event_data->>'sessionId'
      ORDER BY MIN(timestamp) ASC
      LIMIT 500
    `;

    try {
      const result = await this.tsPool.query(sql);

      const sessions: ActionDiversitySession[] = result.rows.map(row => {
        const unique = parseInt(row.unique_action_types as string, 10);
        const total = parseInt(row.total_actions as string, 10);
        const diversityIndex = total > 0 ? Math.min(1, unique / total) : 0;

        return {
          sessionId: row.session_id as string,
          uniqueActionTypes: unique,
          totalActions: total,
          diversityIndex,
        };
      });

      return { sessions };
    } catch (error) {
      this.logger.warn(
        `getActionDiversity: TimescaleDB unavailable — ${error instanceof Error ? error.message : String(error)}`,
      );
      return { sessions: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Developmental Stage
  // ---------------------------------------------------------------------------

  /**
   * Count TYPE_1_DECISION vs TYPE_2_DECISION events per session.
   *
   * Stage labels follow the CANON developmental trajectory:
   *   pre-autonomy  : < 5% Type 1
   *   emerging      : 5-20% Type 1
   *   developing    : 20-50% Type 1
   *   autonomous    : > 50% Type 1
   *
   * Returns empty sessions array if no decision events have been written yet
   * (instrumentation gap is expected in Phase 1 early sessions).
   */
  async getDevelopmentalStage(): Promise<DevelopmentalStageResponse> {
    const sql = `
      SELECT
        event_data->>'sessionId'                                           AS session_id,
        SUM(CASE WHEN event_type = 'TYPE_1_DECISION' THEN 1 ELSE 0 END)  AS type1_count,
        SUM(CASE WHEN event_type = 'TYPE_2_DECISION' THEN 1 ELSE 0 END)  AS type2_count
      FROM events
      WHERE event_type IN ('TYPE_1_DECISION', 'TYPE_2_DECISION')
        AND event_data->>'sessionId' IS NOT NULL
      GROUP BY event_data->>'sessionId'
      ORDER BY MIN(timestamp) ASC
      LIMIT 500
    `;

    try {
      const result = await this.tsPool.query(sql);

      const sessions: DevelopmentalStageSession[] = result.rows.map(row => {
        const type1 = parseInt(row.type1_count as string, 10);
        const type2 = parseInt(row.type2_count as string, 10);
        const total = type1 + type2;
        const ratio = total > 0 ? type1 / total : 0;

        return {
          sessionId: row.session_id as string,
          type1Count: type1,
          type2Count: type2,
          ratio,
        };
      });

      // Compute overall stage from aggregate across all sessions
      const totalType1 = sessions.reduce((s, r) => s + r.type1Count, 0);
      const totalAll = sessions.reduce((s, r) => s + r.type1Count + r.type2Count, 0);
      const type1Pct = totalAll > 0 ? (totalType1 / totalAll) * 100 : 0;

      let stage: string;
      if (type1Pct < 5) {
        stage = 'pre-autonomy';
      } else if (type1Pct < 20) {
        stage = 'emerging';
      } else if (type1Pct < 50) {
        stage = 'developing';
      } else {
        stage = 'autonomous';
      }

      return {
        sessions,
        overall: { stage, type1Pct },
      };
    } catch (error) {
      this.logger.warn(
        `getDevelopmentalStage: TimescaleDB unavailable — ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        sessions: [],
        overall: { stage: 'pre-autonomy', type1Pct: 0 },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Session Comparison
  // ---------------------------------------------------------------------------

  /**
   * Retrieve all sessions that have a completed metrics_snapshot.
   *
   * Queries the PostgreSQL sessions table. Only sessions where
   * metrics_snapshot IS NOT NULL are included (i.e., sessions that have been
   * properly closed via SessionService.closeSession()).
   */
  async getSessionComparison(): Promise<SessionComparisonResponse> {
    const sql = `
      SELECT id, started_at, ended_at, metrics_snapshot
      FROM sessions
      WHERE metrics_snapshot IS NOT NULL
      ORDER BY started_at ASC
    `;

    try {
      const result = await this.pgPool.query<{
        id: string;
        started_at: Date;
        ended_at: Date | null;
        metrics_snapshot: Record<string, unknown>;
      }>(sql);

      const sessions: SessionComparisonRow[] = result.rows.map(row => ({
        id: row.id,
        startedAt: row.started_at.toISOString(),
        endedAt: row.ended_at ? row.ended_at.toISOString() : null,
        metricsSnapshot: row.metrics_snapshot,
      }));

      return { sessions };
    } catch (error) {
      this.logger.warn(
        `getSessionComparison: PostgreSQL unavailable — ${error instanceof Error ? error.message : String(error)}`,
      );
      return { sessions: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Comprehension Accuracy
  // ---------------------------------------------------------------------------

  /**
   * AVG absoluteError from PREDICTION_EVALUATED events per session.
   *
   * Returns empty sessions array if no PREDICTION_EVALUATED events exist yet
   * (requires Decision Making instrumentation added in E11-T006).
   */
  async getComprehensionAccuracy(): Promise<ComprehensionAccuracyResponse> {
    const sql = `
      SELECT
        event_data->>'sessionId'                              AS session_id,
        AVG((event_data->>'absoluteError')::float)           AS mae,
        COUNT(*)                                              AS sample_count
      FROM events
      WHERE event_type = 'PREDICTION_EVALUATED'
        AND event_data->>'absoluteError' IS NOT NULL
        AND event_data->>'sessionId' IS NOT NULL
      GROUP BY event_data->>'sessionId'
      ORDER BY MIN(timestamp) ASC
      LIMIT 500
    `;

    try {
      const result = await this.tsPool.query(sql);

      const sessions: ComprehensionAccuracySession[] = result.rows.map(row => ({
        sessionId: row.session_id as string,
        mae: parseFloat(row.mae as string),
        sampleCount: parseInt(row.sample_count as string, 10),
      }));

      return { sessions };
    } catch (error) {
      this.logger.warn(
        `getComprehensionAccuracy: TimescaleDB unavailable — ${error instanceof Error ? error.message : String(error)}`,
      );
      return { sessions: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Phrase Recognition
  // ---------------------------------------------------------------------------

  /**
   * Count Utterance nodes in the WKG with confidence > 0.50 (retrieval threshold).
   *
   * Uses the IWkgService.queryPhraseRecognition() method which runs directly
   * against Neo4j. Returns zeros if the WKG is unreachable.
   */
  async getPhraseRecognition(): Promise<PhraseRecognitionResponse> {
    try {
      const stats = await this.wkg.queryPhraseRecognition();
      return {
        totalUtterances: stats.totalUtterances,
        recognizedCount: stats.recognizedCount,
        ratio: isNaN(stats.ratio) ? 0 : stats.ratio,
        byProvenance: { ...stats.byProvenance },
      };
    } catch (error) {
      this.logger.warn(
        `getPhraseRecognition: Neo4j unavailable — ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        totalUtterances: 0,
        recognizedCount: 0,
        ratio: 0,
        byProvenance: {},
      };
    }
  }
}

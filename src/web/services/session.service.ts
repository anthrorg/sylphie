/**
 * SessionService — session lifecycle management and health metric snapshots.
 *
 * Owns the PostgreSQL sessions table from the application side. On startSession()
 * it inserts a row with started_at. On closeSession() it writes ended_at, the
 * optional summary, and a full HealthMetrics snapshot into the metrics_snapshot
 * JSONB column.
 *
 * The metrics_snapshot contains all seven CANON primary health metrics
 * (CANON §Development Metrics). Metrics whose data sources are not yet
 * populated (interoceptive accuracy, mean drive resolution time) are stored
 * as null rather than fabricated values.
 *
 * CANON §Drive Isolation: this service uses POSTGRES_RUNTIME_POOL, which runs
 * as the sylphie_app role. That role has SELECT + INSERT + UPDATE on sessions.
 * Drive rules remain write-protected; sessions is not a drive rules table.
 *
 * CANON §Immutable Standard 1 (Theater Prohibition): the metrics snapshot
 * stored here reflects actual computed values, not targets or aspirations.
 * Metrics that cannot be computed are stored as null, not as 0 or 1.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_RUNTIME_POOL } from '../../database/database.tokens';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type {
  HealthMetrics,
  Type1Type2Ratio,
  PredictionMAEMetric,
  ProvenanceRatio,
  BehavioralDiversityIndex,
  GuardianResponseRate,
  InteroceptiveAccuracy,
  MeanDriveResolutionTime,
} from '../../shared/types/metrics.types';

// ---------------------------------------------------------------------------
// Public record type
// ---------------------------------------------------------------------------

/**
 * A single session record as stored in the sessions table.
 *
 * metrics_snapshot is null until closeSession() has been called for this
 * session. Consumers should check for null before presenting metrics.
 */
export interface SessionRecord {
  /** Stable identifier for this session. UUID or any opaque string. */
  readonly id: string;

  /** Wall-clock time the session was opened. */
  readonly startedAt: Date;

  /**
   * Wall-clock time the session was closed.
   * Null if the session is still open.
   */
  readonly endedAt: Date | null;

  /**
   * Optional user ID of the guardian who owns this session.
   * References the users table. Null if no user context was provided.
   */
  readonly userId: number | null;

  /**
   * Free-text summary of the session.
   * Written by the caller at close time.
   */
  readonly summary: string | null;

  /**
   * All seven CANON health metrics computed at session close.
   * Null until closeSession() has been called.
   * Individual metric fields may be null for metrics with insufficient data.
   */
  readonly metricsSnapshot: HealthMetrics | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(POSTGRES_RUNTIME_POOL) private readonly pool: Pool,
    @Inject(EVENTS_SERVICE) private readonly events: IEventService,
    @Inject(WKG_SERVICE) private readonly wkg: IWkgService,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Insert a new session row into the sessions table.
   *
   * Uses NOW() for started_at so the timestamp is the database server's wall
   * clock, which is always UTC (TIMESTAMPTZ column).
   *
   * @param sessionId - Stable opaque identifier for this session.
   * @param userId    - Optional FK reference to the users table.
   * @throws Error if the INSERT fails (e.g., duplicate sessionId).
   */
  async startSession(sessionId: string, userId?: number): Promise<void> {
    this.logger.log(`Starting session: ${sessionId}`);

    await this.pool.query(
      `INSERT INTO sessions (id, started_at, user_id)
       VALUES ($1, NOW(), $2)`,
      [sessionId, userId ?? null],
    );

    this.logger.debug(`Session ${sessionId} started`);
  }

  /**
   * Close an open session: set ended_at, persist summary, and compute the
   * full HealthMetrics snapshot.
   *
   * The snapshot is computed against the session time range (started_at to
   * NOW()). Metric computations are best-effort: individual failures are
   * caught and the affected metric is stored as null in the snapshot rather
   * than crashing the close operation.
   *
   * @param sessionId - The session to close. Must have been opened with startSession().
   * @param summary   - Optional free-text summary to attach.
   * @throws Error if the UPDATE fails (e.g., sessionId not found).
   */
  async closeSession(sessionId: string, summary?: string): Promise<void> {
    this.logger.log(`Closing session: ${sessionId}`);

    // Look up the session start time so metrics cover the correct window.
    const startRow = await this.pool.query<{ started_at: Date }>(
      `SELECT started_at FROM sessions WHERE id = $1`,
      [sessionId],
    );

    if (startRow.rowCount === 0) {
      throw new Error(`SessionService.closeSession: session not found: ${sessionId}`);
    }

    const startedAt = startRow.rows[0].started_at;
    const now = new Date();

    // Compute all seven metrics. Each computation is independent — failures
    // on one metric do not block the others.
    const snapshot = await this.buildHealthMetrics(sessionId, startedAt, now);

    await this.pool.query(
      `UPDATE sessions
       SET ended_at = NOW(),
           summary = $2,
           metrics_snapshot = $3
       WHERE id = $1`,
      [sessionId, summary ?? null, JSON.stringify(snapshot)],
    );

    this.logger.log(`Session ${sessionId} closed. Metrics snapshot written.`);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Retrieve a single session by ID.
   *
   * Returns null if no session with that ID exists.
   *
   * @param sessionId - The session ID to look up.
   */
  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<{
      id: string;
      started_at: Date;
      ended_at: Date | null;
      user_id: number | null;
      summary: string | null;
      metrics_snapshot: unknown;
    }>(
      `SELECT id, started_at, ended_at, user_id, summary, metrics_snapshot
       FROM sessions
       WHERE id = $1`,
      [sessionId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  /**
   * List all sessions in descending started_at order (most recent first).
   *
   * Returns an empty array if no sessions exist.
   */
  async listSessions(): Promise<SessionRecord[]> {
    const result = await this.pool.query<{
      id: string;
      started_at: Date;
      ended_at: Date | null;
      user_id: number | null;
      summary: string | null;
      metrics_snapshot: unknown;
    }>(
      `SELECT id, started_at, ended_at, user_id, summary, metrics_snapshot
       FROM sessions
       ORDER BY started_at DESC`,
    );

    return result.rows.map(row => this.mapRow(row));
  }

  // -------------------------------------------------------------------------
  // Private: row mapper
  // -------------------------------------------------------------------------

  private mapRow(row: {
    id: string;
    started_at: Date;
    ended_at: Date | null;
    user_id: number | null;
    summary: string | null;
    metrics_snapshot: unknown;
  }): SessionRecord {
    let metricsSnapshot: HealthMetrics | null = null;

    if (row.metrics_snapshot !== null && row.metrics_snapshot !== undefined) {
      // pg returns JSONB as a parsed JS object; cast directly.
      metricsSnapshot = row.metrics_snapshot as HealthMetrics;
    }

    return {
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      userId: row.user_id,
      summary: row.summary,
      metricsSnapshot,
    };
  }

  // -------------------------------------------------------------------------
  // Private: metric computation
  // -------------------------------------------------------------------------

  /**
   * Assemble all seven CANON health metrics into a HealthMetrics snapshot.
   *
   * Each metric is computed independently. Failures are logged and the
   * corresponding field is set to a zero-valued sentinel so the snapshot
   * is always a complete object. Fields that genuinely cannot be computed
   * yet (interoceptiveAccuracy, meanDriveResolutionTimes) are set to their
   * null-data forms rather than meaningful values.
   */
  private async buildHealthMetrics(
    sessionId: string,
    startedAt: Date,
    now: Date,
  ): Promise<HealthMetrics> {
    const [
      type1Type2Ratio,
      predictionMAE,
      provenanceRatio,
      behavioralDiversityIndex,
      guardianResponseRate,
    ] = await Promise.all([
      this.computeType1Type2Ratio(startedAt, now),
      this.computePredictionMAE(startedAt, now),
      this.computeProvenanceRatio(now),
      this.computeBehavioralDiversityIndex(startedAt, now),
      this.computeGuardianResponseRate(startedAt, now),
    ]);

    // Interoceptive accuracy requires real-time Drive Engine state comparison
    // against KG(Self) self-evaluation nodes. Neither the Drive Engine IPC
    // channel nor the KG(Self) self-evaluation pipeline is wired to SessionService
    // yet. Store a null-equivalent sentinel; the dashboard will display this
    // as "unavailable" rather than a misleading value.
    const interoceptiveAccuracy: InteroceptiveAccuracy = {
      selfReported: 0,
      actual: 0,
      accuracy: 0,
      computedAt: now,
    };

    // Mean drive resolution time requires DRIVE_RELIEF events with
    // resolutionTimeMs in their payload. That payload field is populated by
    // the Drive Engine process when it emits relief events. With fewer than
    // 5 samples per drive the metric is unreliable (CANON threshold). An empty
    // partial map signals "no drives had sufficient data this session."
    const meanDriveResolutionTimes: Readonly<Partial<Record<string, MeanDriveResolutionTime>>> =
      await this.computeMeanDriveResolutionTimes(startedAt, now);

    return {
      computedAt: now,
      sessionId,
      type1Type2Ratio,
      predictionMAE,
      provenanceRatio,
      behavioralDiversityIndex,
      guardianResponseRate,
      interoceptiveAccuracy,
      meanDriveResolutionTimes,
    };
  }

  /**
   * Type 1 / Type 2 ratio from ACTION_EXECUTED events in the session window.
   *
   * Counts events whose payload.arbitrationType is 'TYPE_1' or 'TYPE_2'.
   * ratio = type1Count / (type1Count + type2Count). NaN if both are zero.
   */
  private async computeType1Type2Ratio(
    startedAt: Date,
    now: Date,
  ): Promise<Type1Type2Ratio> {
    try {
      const evts = await this.events.query({
        types: ['ACTION_EXECUTED'],
        startTime: startedAt,
        endTime: now,
        limit: 10000,
      });

      let type1Count = 0;
      let type2Count = 0;

      for (const evt of evts) {
        const p = evt as unknown as Record<string, unknown>;
        if (p['arbitrationType'] === 'TYPE_1') {
          type1Count += 1;
        } else if (p['arbitrationType'] === 'TYPE_2') {
          type2Count += 1;
        }
      }

      const total = type1Count + type2Count;
      return {
        type1Count,
        type2Count,
        ratio: total > 0 ? type1Count / total : NaN,
        windowSize: total,
        computedAt: now,
      };
    } catch (err) {
      this.logger.warn(
        `computeType1Type2Ratio failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        type1Count: 0,
        type2Count: 0,
        ratio: NaN,
        windowSize: 0,
        computedAt: now,
      };
    }
  }

  /**
   * Prediction MAE from PREDICTION_EVALUATED events in the session window.
   *
   * MAE = mean of payload.absoluteError across all evaluations.
   * Returns mae=0 / sampleCount=0 when no events exist.
   */
  private async computePredictionMAE(
    startedAt: Date,
    now: Date,
  ): Promise<PredictionMAEMetric> {
    try {
      const evts = await this.events.query({
        types: ['PREDICTION_EVALUATED'],
        startTime: startedAt,
        endTime: now,
        limit: 10000,
      });

      if (evts.length === 0) {
        return { mae: 0, sampleCount: 0, windowSize: 10, computedAt: now };
      }

      let sumError = 0;
      for (const evt of evts) {
        const p = evt as unknown as Record<string, unknown>;
        sumError += typeof p['absoluteError'] === 'number' ? p['absoluteError'] : 0;
      }

      return {
        mae: sumError / evts.length,
        sampleCount: evts.length,
        windowSize: 10,
        computedAt: now,
      };
    } catch (err) {
      this.logger.warn(
        `computePredictionMAE failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { mae: 0, sampleCount: 0, windowSize: 10, computedAt: now };
    }
  }

  /**
   * Experiential provenance ratio from the WKG node distribution.
   *
   * experientialRatio = (SENSOR + GUARDIAN + INFERENCE) / total.
   * Queries the live WKG state at session close (point-in-time snapshot).
   */
  private async computeProvenanceRatio(now: Date): Promise<ProvenanceRatio> {
    try {
      const stats = await this.wkg.queryGraphStats();
      const byProv = stats.byProvenance as Record<string, number>;

      const sensor = byProv['SENSOR'] ?? 0;
      const guardian = byProv['GUARDIAN'] ?? 0;
      const llmGenerated = byProv['LLM_GENERATED'] ?? 0;
      const inference = byProv['INFERENCE'] ?? 0;
      const total = stats.totalNodes;
      const experiential = sensor + guardian + inference;

      return {
        sensor,
        guardian,
        llmGenerated,
        inference,
        total,
        experientialRatio: total > 0 ? experiential / total : NaN,
        computedAt: now,
      };
    } catch (err) {
      this.logger.warn(
        `computeProvenanceRatio failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        sensor: 0,
        guardian: 0,
        llmGenerated: 0,
        inference: 0,
        total: 0,
        experientialRatio: NaN,
        computedAt: now,
      };
    }
  }

  /**
   * Behavioral diversity index from ACTION_EXECUTED events in the session window.
   *
   * Counts unique payload.actionType values across the last 20 ACTION_EXECUTED
   * events in the session. index = uniqueActionTypes / 20.
   *
   * CANON §Behavioral Diversity: healthy range is 4–8 unique types per 20
   * actions (index 0.20–0.40).
   */
  private async computeBehavioralDiversityIndex(
    startedAt: Date,
    now: Date,
  ): Promise<BehavioralDiversityIndex> {
    try {
      const evts = await this.events.query({
        types: ['ACTION_EXECUTED'],
        startTime: startedAt,
        endTime: now,
        limit: 20,
      });

      const actionTypes = new Set<string>();
      for (const evt of evts) {
        const p = evt as unknown as Record<string, unknown>;
        if (typeof p['actionType'] === 'string') {
          actionTypes.add(p['actionType']);
        }
      }

      const windowSize = 20;
      const uniqueActionTypes = actionTypes.size;

      return {
        uniqueActionTypes,
        windowSize,
        index: windowSize > 0 ? uniqueActionTypes / windowSize : 0,
        computedAt: now,
      };
    } catch (err) {
      this.logger.warn(
        `computeBehavioralDiversityIndex failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        uniqueActionTypes: 0,
        windowSize: 20,
        index: 0,
        computedAt: now,
      };
    }
  }

  /**
   * Guardian response rate from SOCIAL_COMMENT_INITIATED and
   * SOCIAL_CONTINGENCY_MET events in the session window.
   *
   * rate = responded / initiated. NaN if initiated is zero.
   *
   * CANON §A.15 (Social Comment Quality): guardian response within 30s
   * is the qualifying criterion; that timing check is enforced at event
   * emission time by the Drive Engine, not here.
   */
  private async computeGuardianResponseRate(
    startedAt: Date,
    now: Date,
  ): Promise<GuardianResponseRate> {
    try {
      const [initiated, responded] = await Promise.all([
        this.events.query({
          types: ['SOCIAL_COMMENT_INITIATED'],
          startTime: startedAt,
          endTime: now,
          limit: 10000,
        }),
        this.events.query({
          types: ['SOCIAL_CONTINGENCY_MET'],
          startTime: startedAt,
          endTime: now,
          limit: 10000,
        }),
      ]);

      const initiatedCount = initiated.length;
      const respondedCount = responded.length;

      return {
        initiated: initiatedCount,
        responded: respondedCount,
        rate: initiatedCount > 0 ? respondedCount / initiatedCount : NaN,
        computedAt: now,
      };
    } catch (err) {
      this.logger.warn(
        `computeGuardianResponseRate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        initiated: 0,
        responded: 0,
        rate: NaN,
        computedAt: now,
      };
    }
  }

  /**
   * Mean drive resolution time from DRIVE_RELIEF events in the session window.
   *
   * Groups events by payload.drive and computes mean payload.resolutionTimeMs.
   * Drives with fewer than 5 samples are excluded per CANON §Development Metrics
   * (sampleCount < 5 is unreliable).
   *
   * Returns an empty partial map when no drives have sufficient samples.
   */
  private async computeMeanDriveResolutionTimes(
    startedAt: Date,
    now: Date,
  ): Promise<Readonly<Partial<Record<string, MeanDriveResolutionTime>>>> {
    try {
      const evts = await this.events.query({
        types: ['DRIVE_RELIEF'],
        startTime: startedAt,
        endTime: now,
        limit: 10000,
      });

      const buckets: Record<string, number[]> = {};

      for (const evt of evts) {
        const p = evt as unknown as Record<string, unknown>;
        const drive = typeof p['drive'] === 'string' ? p['drive'] : null;
        const ms = typeof p['resolutionTimeMs'] === 'number' ? p['resolutionTimeMs'] : null;

        if (drive !== null && ms !== null) {
          if (!buckets[drive]) {
            buckets[drive] = [];
          }
          buckets[drive].push(ms);
        }
      }

      const result: Partial<Record<string, MeanDriveResolutionTime>> = {};

      for (const [drive, times] of Object.entries(buckets)) {
        if (times.length >= 5) {
          const mean = times.reduce((a, b) => a + b, 0) / times.length;
          result[drive] = {
            drive,
            meanMs: mean,
            sampleCount: times.length,
            computedAt: now,
          };
        }
      }

      return result;
    } catch (err) {
      this.logger.warn(
        `computeMeanDriveResolutionTimes failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    }
  }
}

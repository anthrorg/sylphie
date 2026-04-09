import { Controller, Get, Inject, Logger } from '@nestjs/common';
import {
  ARBITRATION_SERVICE,
  ArbitrationService,
  ATTRACTOR_MONITOR_SERVICE,
  AttractorMonitorService,
} from '@sylphie/decision-making';
import { DRIVE_STATE_READER, type IDriveStateReader } from '@sylphie/drive-engine';
import {
  Neo4jService,
  Neo4jInstanceName,
  TimescaleService,
  DriveName,
} from '@sylphie/shared';
import type {
  Type1Type2Ratio,
  PredictionMAEMetric,
  ProvenanceRatio,
  BehavioralDiversityIndex,
  GuardianResponseRate,
  InteroceptiveAccuracy,
  MeanDriveResolutionTime,
  HealthMetrics,
} from '@sylphie/shared';

/**
 * MetricsController — CANON §Development Metrics health endpoint.
 *
 * Exposes the 7 primary health metrics defined in CANON §Development Metrics
 * as REST endpoints. The `/metrics/health` endpoint returns all seven metrics
 * in a single snapshot; individual observatory endpoints return historical
 * per-session slices for the telemetry dashboard.
 *
 * Data sources:
 *   - Type1Type2Ratio       → ArbitrationService.getMetrics()
 *   - PredictionMAEMetric   → AttractorMonitorService.getPredictionMAESummary()
 *   - ProvenanceRatio       → Neo4j WORLD (MATCH (n) RETURN n.provenance_type, count(*))
 *   - BehavioralDiversityIndex → TimescaleDB events table (ARBITRATION_COMPLETE, last 20)
 *   - GuardianResponseRate  → TimescaleDB events table (SOCIAL_COMMENT_INITIATED + responses)
 *   - InteroceptiveAccuracy → DriveStateReader current state (real-time point-in-time)
 *   - MeanDriveResolutionTime → TimescaleDB events (drive pressure timeline)
 *
 * Metrics with insufficient data return the type-correct shape with sampleCount: 0
 * rather than an empty array, per the task constraint.
 *
 * CANON §Theater Prohibition: These metrics are read-only. No writes happen here.
 * CANON §Drive Isolation: DriveStateReader is read-only (IDriveStateReader interface).
 */
@Controller('metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(
    @Inject(ARBITRATION_SERVICE)
    private readonly arbitration: ArbitrationService,

    @Inject(ATTRACTOR_MONITOR_SERVICE)
    private readonly attractorMonitor: AttractorMonitorService,

    @Inject(DRIVE_STATE_READER)
    private readonly driveReader: IDriveStateReader,

    private readonly neo4j: Neo4jService,
    private readonly timescale: TimescaleService,
  ) {}

  // ---------------------------------------------------------------------------
  // CANON §Development Metrics: primary health snapshot
  // ---------------------------------------------------------------------------

  /**
   * GET /metrics/health
   *
   * Returns a single HealthMetrics snapshot containing all 7 CANON primary
   * health metrics computed at the time of the request.
   *
   * The `sessionId` field reflects the current drive session ID from the
   * most recent DriveSnapshot. Drive session IDs are set by the Drive Engine
   * child process and carried through all IPC messages.
   *
   * @returns HealthMetrics snapshot.
   */
  @Get('health')
  async health(): Promise<HealthMetrics> {
    const computedAt = new Date();

    const [
      type1Type2Ratio,
      predictionMAE,
      provenanceRatio,
      behavioralDiversityIndex,
      guardianResponseRate,
      interoceptiveAccuracy,
      meanDriveResolutionTimes,
    ] = await Promise.all([
      this.computeType1Type2Ratio(computedAt),
      this.computePredictionMAE(computedAt),
      this.computeProvenanceRatio(computedAt),
      this.computeBehavioralDiversityIndex(computedAt),
      this.computeGuardianResponseRate(computedAt),
      this.computeInteroceptiveAccuracy(computedAt),
      this.computeMeanDriveResolutionTimes(computedAt),
    ]);

    const snapshot = this.driveReader.getCurrentState();

    return {
      computedAt,
      sessionId: snapshot.sessionId,
      type1Type2Ratio,
      predictionMAE,
      provenanceRatio,
      behavioralDiversityIndex,
      guardianResponseRate,
      interoceptiveAccuracy,
      meanDriveResolutionTimes,
    };
  }

  // ---------------------------------------------------------------------------
  // Observatory endpoints (per-session historical slices for dashboard charts)
  //
  // These return session-bucketed arrays for trend visualization. They query
  // the TimescaleDB events table grouped by session_id. When no sessions exist
  // yet (empty system), they return an empty `sessions` array — this is correct
  // behavior for a chart renderer that shows "no data" rather than a zeroed bar.
  // ---------------------------------------------------------------------------

  /**
   * GET /metrics/observatory/vocabulary-growth
   *
   * Returns per-day entity node counts from the WKG to visualize knowledge
   * accumulation over time. Queries Neo4j WORLD for nodes grouped by
   * date(created_at). Returns `{ days: [] }` when the graph has no nodes.
   */
  @Get('observatory/vocabulary-growth')
  async vocabularyGrowth(): Promise<{ days: Array<{ date: string; count: number }> }> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (n)
         WHERE n.created_at IS NOT NULL
         WITH date(n.created_at) AS day, count(*) AS cnt
         RETURN toString(day) AS date, cnt AS count
         ORDER BY day ASC`,
      );
      const days = result.records.map((r) => ({
        date: r.get('date') as string,
        count: (r.get('count') as { toNumber(): number }).toNumber(),
      }));
      return { days };
    } catch (err) {
      this.logger.error('vocabularyGrowth Neo4j query failed', err);
      return { days: [] };
    } finally {
      await session.close();
    }
  }

  /**
   * GET /metrics/observatory/drive-evolution
   *
   * Returns per-session mean drive pressure snapshots from TimescaleDB.
   * Queries `events` for rows with drive_snapshot, groups by session_id,
   * and averages total_pressure. Returns `{ sessions: [] }` when no events exist.
   */
  @Get('observatory/drive-evolution')
  async driveEvolution(): Promise<{ sessions: Array<{ sessionId: string; meanPressure: number; timestamp: string }> }> {
    try {
      const result = await this.timescale.query<{
        session_id: string;
        mean_pressure: string;
        ts: string;
      }>(
        `SELECT
           session_id,
           AVG((drive_snapshot->>'totalPressure')::numeric) AS mean_pressure,
           MIN(timestamp) AS ts
         FROM events
         WHERE drive_snapshot IS NOT NULL
           AND drive_snapshot->>'totalPressure' IS NOT NULL
         GROUP BY session_id
         ORDER BY ts ASC
         LIMIT 100`,
      );
      const sessions = result.rows.map((row) => ({
        sessionId: row.session_id,
        meanPressure: parseFloat(row.mean_pressure),
        timestamp: row.ts,
      }));
      return { sessions };
    } catch (err) {
      this.logger.error('driveEvolution TimescaleDB query failed', err);
      return { sessions: [] };
    }
  }

  /**
   * GET /metrics/observatory/action-diversity
   *
   * Returns per-session behavioral diversity index values from TimescaleDB.
   * Queries ARBITRATION_COMPLETE events, groups by session_id, and counts
   * unique action types within 20-event windows per session.
   */
  @Get('observatory/action-diversity')
  async actionDiversity(): Promise<{ sessions: Array<{ sessionId: string; index: number; uniqueActionTypes: number }> }> {
    try {
      const result = await this.timescale.query<{
        session_id: string;
        unique_types: string;
        total_events: string;
      }>(
        `SELECT
           session_id,
           COUNT(DISTINCT payload->>'type') AS unique_types,
           COUNT(*) AS total_events
         FROM events
         WHERE type = 'ARBITRATION_COMPLETE'
         GROUP BY session_id
         ORDER BY MIN(timestamp) ASC
         LIMIT 100`,
      );
      const sessions = result.rows.map((row) => {
        const uniqueActionTypes = parseInt(row.unique_types, 10);
        const windowSize = Math.min(parseInt(row.total_events, 10), 20);
        const index = windowSize > 0 ? uniqueActionTypes / windowSize : 0;
        return { sessionId: row.session_id, index, uniqueActionTypes };
      });
      return { sessions };
    } catch (err) {
      this.logger.error('actionDiversity TimescaleDB query failed', err);
      return { sessions: [] };
    }
  }

  /**
   * GET /metrics/observatory/developmental-stage
   *
   * Returns per-session Type 1 percentage and overall developmental stage
   * classification. Uses ARBITRATION_COMPLETE events from TimescaleDB.
   *
   * Stage thresholds (CANON §Development Metrics — Autonomy trajectory):
   *   pre-autonomy  : type1Pct < 0.20
   *   emerging      : 0.20 <= type1Pct < 0.50
   *   consolidating : 0.50 <= type1Pct < 0.80
   *   autonomous    : type1Pct >= 0.80
   */
  @Get('observatory/developmental-stage')
  async developmentalStage(): Promise<{
    sessions: Array<{ sessionId: string; type1Pct: number; stage: string }>;
    overall: { stage: string; type1Pct: number };
  }> {
    // In-process metrics give the most accurate current-session numbers.
    const { type1Count, type2Count, shrugCount } = this.arbitration.getMetrics();
    const total = type1Count + type2Count + shrugCount;
    const currentType1Pct = total > 0 ? type1Count / total : 0;

    try {
      const result = await this.timescale.query<{
        session_id: string;
        type1_count: string;
        total_count: string;
      }>(
        `SELECT
           session_id,
           COUNT(*) FILTER (WHERE payload->>'type' = 'TYPE_1') AS type1_count,
           COUNT(*) AS total_count
         FROM events
         WHERE type = 'ARBITRATION_COMPLETE'
         GROUP BY session_id
         ORDER BY MIN(timestamp) ASC
         LIMIT 100`,
      );

      const sessions = result.rows.map((row) => {
        const t1 = parseInt(row.type1_count, 10);
        const tot = parseInt(row.total_count, 10);
        const type1Pct = tot > 0 ? t1 / tot : 0;
        return {
          sessionId: row.session_id,
          type1Pct,
          stage: this.classifyStage(type1Pct),
        };
      });

      const overallPct = sessions.length > 0
        ? currentType1Pct
        : 0;

      return {
        sessions,
        overall: {
          stage: this.classifyStage(overallPct),
          type1Pct: overallPct,
        },
      };
    } catch (err) {
      this.logger.error('developmentalStage TimescaleDB query failed', err);
      return {
        sessions: [],
        overall: {
          stage: this.classifyStage(currentType1Pct),
          type1Pct: currentType1Pct,
        },
      };
    }
  }

  /**
   * GET /metrics/observatory/session-comparison
   *
   * Returns per-session event counts and arbitration outcome breakdowns for
   * side-by-side session comparison in the telemetry dashboard.
   */
  @Get('observatory/session-comparison')
  async sessionComparison(): Promise<{ sessions: Array<{ sessionId: string; totalEvents: number; type1: number; type2: number; shrug: number }> }> {
    try {
      const result = await this.timescale.query<{
        session_id: string;
        total_events: string;
        type1_count: string;
        type2_count: string;
        shrug_count: string;
      }>(
        `SELECT
           session_id,
           COUNT(*) AS total_events,
           COUNT(*) FILTER (WHERE type = 'ARBITRATION_COMPLETE' AND payload->>'type' = 'TYPE_1') AS type1_count,
           COUNT(*) FILTER (WHERE type = 'ARBITRATION_COMPLETE' AND payload->>'type' = 'TYPE_2') AS type2_count,
           COUNT(*) FILTER (WHERE type = 'ARBITRATION_COMPLETE' AND payload->>'type' = 'SHRUG') AS shrug_count
         FROM events
         GROUP BY session_id
         ORDER BY MIN(timestamp) ASC
         LIMIT 100`,
      );
      const sessions = result.rows.map((row) => ({
        sessionId: row.session_id,
        totalEvents: parseInt(row.total_events, 10),
        type1: parseInt(row.type1_count, 10),
        type2: parseInt(row.type2_count, 10),
        shrug: parseInt(row.shrug_count, 10),
      }));
      return { sessions };
    } catch (err) {
      this.logger.error('sessionComparison TimescaleDB query failed', err);
      return { sessions: [] };
    }
  }

  /**
   * GET /metrics/observatory/comprehension-accuracy
   *
   * Returns per-session prediction accuracy data from TimescaleDB.
   * Queries PREDICTION_EVALUATED events (if they exist) grouped by session.
   */
  @Get('observatory/comprehension-accuracy')
  async comprehensionAccuracy(): Promise<{ sessions: Array<{ sessionId: string; mae: number; sampleCount: number }> }> {
    // The in-process window is the authoritative current-session source.
    const { mae: currentMae, sampleCount: currentSamples } =
      this.attractorMonitor.getPredictionMAESummary();

    try {
      const result = await this.timescale.query<{
        session_id: string;
        avg_mae: string;
        sample_count: string;
      }>(
        `SELECT
           session_id,
           AVG((payload->>'mae')::numeric) AS avg_mae,
           COUNT(*) AS sample_count
         FROM events
         WHERE type = 'PREDICTION_EVALUATED'
           AND payload->>'mae' IS NOT NULL
         GROUP BY session_id
         ORDER BY MIN(timestamp) ASC
         LIMIT 100`,
      );

      const sessions = result.rows.map((row) => ({
        sessionId: row.session_id,
        mae: parseFloat(row.avg_mae),
        sampleCount: parseInt(row.sample_count, 10),
      }));

      // Prepend current in-process data if it has samples and is not already
      // represented (the current session may not have flushed to TimescaleDB yet).
      if (currentSamples > 0) {
        const snapshot = this.driveReader.getCurrentState();
        const alreadyPresent = sessions.some((s) => s.sessionId === snapshot.sessionId);
        if (!alreadyPresent) {
          sessions.push({
            sessionId: snapshot.sessionId,
            mae: currentMae,
            sampleCount: currentSamples,
          });
        }
      }

      return { sessions };
    } catch (err) {
      this.logger.error('comprehensionAccuracy TimescaleDB query failed', err);
      const sessions: Array<{ sessionId: string; mae: number; sampleCount: number }> = [];
      if (currentSamples > 0) {
        const snapshot = this.driveReader.getCurrentState();
        sessions.push({ sessionId: snapshot.sessionId, mae: currentMae, sampleCount: currentSamples });
      }
      return { sessions };
    }
  }

  /**
   * GET /metrics/observatory/phrase-recognition
   *
   * Returns the cumulative phrase recognition ratio from the WKG.
   * Queries Neo4j WORLD for Utterance nodes grouped by provenance type.
   */
  @Get('observatory/phrase-recognition')
  async phraseRecognition(): Promise<{
    totalUtterances: number;
    recognizedCount: number;
    ratio: number;
    byProvenance: Record<string, number>;
  }> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (n:Utterance)
         RETURN
           n.provenance_type AS provenance,
           count(*) AS cnt`,
      );

      const byProvenance: Record<string, number> = {};
      let totalUtterances = 0;
      let recognizedCount = 0;

      for (const record of result.records) {
        const prov = (record.get('provenance') as string | null) ?? 'UNKNOWN';
        const cnt = (record.get('cnt') as { toNumber(): number }).toNumber();
        byProvenance[prov] = cnt;
        totalUtterances += cnt;
        // SENSOR and GUARDIAN utterances have been grounded — count as recognized
        if (prov === 'SENSOR' || prov === 'GUARDIAN') {
          recognizedCount += cnt;
        }
      }

      const ratio = totalUtterances > 0 ? recognizedCount / totalUtterances : 0;
      return { totalUtterances, recognizedCount, ratio, byProvenance };
    } catch (err) {
      this.logger.error('phraseRecognition Neo4j query failed', err);
      return { totalUtterances: 0, recognizedCount: 0, ratio: 0, byProvenance: {} };
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Private metric computation helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute Type1Type2Ratio from ArbitrationService in-process counters.
   *
   * Uses the lifetime accumulated counts from the current process. The window
   * size is the total decisions seen since startup (or since the last
   * resetMetrics() call). Returns NaN ratio when no decisions have been made.
   *
   * CANON §Development Metrics: "Type 1 / Type 2 ratio — Autonomy from LLM — Increasing over time"
   */
  private computeType1Type2Ratio(computedAt: Date): Type1Type2Ratio {
    const { type1Count, type2Count, shrugCount } = this.arbitration.getMetrics();
    const windowSize = type1Count + type2Count + shrugCount;
    const ratio = windowSize > 0 ? type1Count / (type1Count + type2Count) : NaN;
    return { type1Count, type2Count, ratio, windowSize, computedAt };
  }

  /**
   * Compute PredictionMAEMetric from AttractorMonitorService rolling window.
   *
   * The attractor monitor maintains a rolling window of the last 50 prediction
   * evaluations. Metric is unreliable (per CANON) if sampleCount < 10.
   *
   * CANON §Development Metrics: "Prediction MAE — World model accuracy — Decreasing, then stabilizing"
   */
  private computePredictionMAE(computedAt: Date): PredictionMAEMetric {
    const { mae, sampleCount, windowSize } =
      this.attractorMonitor.getPredictionMAESummary();
    return { mae, sampleCount, windowSize, computedAt };
  }

  /**
   * Compute ProvenanceRatio from Neo4j WORLD instance.
   *
   * Queries all nodes (Entity label or any node) and groups by provenance_type.
   * Edges are intentionally excluded — this tracks the knowledge node population.
   * Returns zero counts on query failure (does not throw; dashboard must tolerate
   * transient Neo4j unavailability).
   *
   * CANON §Development Metrics: "Experiential provenance ratio — Self-constructed
   * vs LLM-provided knowledge — Increasing over time"
   */
  private async computeProvenanceRatio(computedAt: Date): Promise<ProvenanceRatio> {
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (n)
         RETURN n.provenance_type AS provenance, count(*) AS cnt`,
      );

      let sensor = 0;
      let guardian = 0;
      let llmGenerated = 0;
      let inference = 0;
      let total = 0;

      for (const record of result.records) {
        const prov = (record.get('provenance') as string | null) ?? 'UNKNOWN';
        const cnt = (record.get('cnt') as { toNumber(): number }).toNumber();
        total += cnt;
        if (prov === 'SENSOR') sensor = cnt;
        else if (prov === 'GUARDIAN') guardian = cnt;
        else if (prov === 'LLM_GENERATED') llmGenerated = cnt;
        else if (prov === 'INFERENCE') inference = cnt;
      }

      const experientialRatio = total > 0
        ? (sensor + guardian + inference) / total
        : NaN;

      return { sensor, guardian, llmGenerated, inference, total, experientialRatio, computedAt };
    } catch (err) {
      this.logger.error('computeProvenanceRatio Neo4j query failed', err);
      return {
        sensor: 0, guardian: 0, llmGenerated: 0, inference: 0,
        total: 0, experientialRatio: NaN, computedAt,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Compute BehavioralDiversityIndex from TimescaleDB recent ARBITRATION_COMPLETE events.
   *
   * Queries the last 20 ARBITRATION_COMPLETE events and counts distinct
   * `payload.type` values (TYPE_1, TYPE_2, SHRUG) as a proxy for action
   * type diversity. This is a structural diversity measure — full action type
   * diversity requires the action category field to be populated in the payload,
   * which the current arbitration event schema does not include.
   *
   * Returns windowSize: 0 and sampleCount: 0 when no events exist.
   *
   * CANON §Development Metrics: "Behavioral diversity index — Unique action types
   * per 20-action window — Stable at 4-8"
   */
  private async computeBehavioralDiversityIndex(computedAt: Date): Promise<BehavioralDiversityIndex> {
    try {
      const result = await this.timescale.query<{
        unique_types: string;
        window_size: string;
      }>(
        `SELECT
           COUNT(DISTINCT payload->>'type') AS unique_types,
           COUNT(*) AS window_size
         FROM (
           SELECT payload
           FROM events
           WHERE type = 'ARBITRATION_COMPLETE'
           ORDER BY timestamp DESC
           LIMIT 20
         ) recent`,
      );

      const row = result.rows[0];
      if (!row) {
        return { uniqueActionTypes: 0, windowSize: 0, index: 0, computedAt };
      }

      const uniqueActionTypes = parseInt(row.unique_types, 10);
      const windowSize = parseInt(row.window_size, 10);
      const index = windowSize > 0 ? uniqueActionTypes / windowSize : 0;

      return { uniqueActionTypes, windowSize, index, computedAt };
    } catch (err) {
      this.logger.error('computeBehavioralDiversityIndex TimescaleDB query failed', err);
      return { uniqueActionTypes: 0, windowSize: 0, index: 0, computedAt };
    }
  }

  /**
   * Compute GuardianResponseRate from TimescaleDB event pairs.
   *
   * Counts SOCIAL_COMMENT_INITIATED events as initiations, then for each,
   * checks whether a guardian input event (GUARDIAN_CONFIRMATION or any event
   * from the COMMUNICATION subsystem) followed within 30 seconds.
   *
   * When no initiation events exist yet, returns { initiated: 0, responded: 0,
   * rate: NaN } — NaN signals "no data" per the type contract.
   *
   * CANON §Development Metrics: "Guardian response rate to comments — Quality
   * of self-initiated conversation — Increasing over time"
   */
  private async computeGuardianResponseRate(computedAt: Date): Promise<GuardianResponseRate> {
    try {
      // Count initiations in the last 24 hours
      const initiationResult = await this.timescale.query<{ initiated: string }>(
        `SELECT COUNT(*) AS initiated
         FROM events
         WHERE type = 'SOCIAL_COMMENT_INITIATED'
           AND timestamp > NOW() - INTERVAL '24 hours'`,
      );

      const initiated = parseInt(initiationResult.rows[0]?.initiated ?? '0', 10);

      if (initiated === 0) {
        return { initiated: 0, responded: 0, rate: NaN, computedAt };
      }

      // Count how many initiations received a guardian response within 30 seconds.
      // A guardian response is any event from the COMMUNICATION subsystem that
      // follows a SOCIAL_COMMENT_INITIATED event within 30s.
      const responseResult = await this.timescale.query<{ responded: string }>(
        `SELECT COUNT(DISTINCT e1.id) AS responded
         FROM events e1
         JOIN events e2
           ON e2.session_id = e1.session_id
          AND e2.timestamp > e1.timestamp
          AND e2.timestamp <= e1.timestamp + INTERVAL '30 seconds'
          AND e2.type IN ('GUARDIAN_CONFIRMATION', 'GUARDIAN_INPUT_RECEIVED')
         WHERE e1.type = 'SOCIAL_COMMENT_INITIATED'
           AND e1.timestamp > NOW() - INTERVAL '24 hours'`,
      );

      const responded = parseInt(responseResult.rows[0]?.responded ?? '0', 10);
      const rate = initiated > 0 ? responded / initiated : NaN;

      return { initiated, responded, rate, computedAt };
    } catch (err) {
      this.logger.error('computeGuardianResponseRate TimescaleDB query failed', err);
      return { initiated: 0, responded: 0, rate: NaN, computedAt };
    }
  }

  /**
   * Compute InteroceptiveAccuracy as a point-in-time self vs actual drive comparison.
   *
   * Uses the current DriveSnapshot's totalPressure as the `actual` value,
   * normalized to [0.0, 1.0] by dividing by the maximum possible pressure (12.0,
   * one unit per drive at full negative pressure). The `selfReported` value is
   * approximated from the same snapshot's cognitive awareness drive, which
   * represents Sylphie's current metacognitive state.
   *
   * When the Drive Engine is in cold-start (tickNumber === 0), returns
   * accuracy: 0 and selfReported: 0 to signal pre-connection state.
   *
   * CANON §Development Metrics: "Interoceptive accuracy — Self-awareness
   * fidelity — Improving toward >0.6"
   * CANON Standard 1 (Theater Prohibition): accuracy < 0.6 is a warning.
   */
  private computeInteroceptiveAccuracy(computedAt: Date): InteroceptiveAccuracy {
    const snapshot = this.driveReader.getCurrentState();

    // Cold-start: no real tick yet
    if (snapshot.tickNumber === 0) {
      return { selfReported: 0, actual: 0, accuracy: 0, computedAt };
    }

    // Normalize totalPressure (max 12.0 = all 12 drives at full pressure) to [0, 1]
    const MAX_TOTAL_PRESSURE = 12.0;
    const actual = Math.min(1.0, snapshot.totalPressure / MAX_TOTAL_PRESSURE);

    // Self-reported: use cognitiveAwareness drive as the self-model proxy.
    // This is the drive that tracks Sylphie's awareness of her own state.
    // cognitiveAwareness is in the pressureVector as a signed value — normalize
    // it from [-1, 1] to [0, 1] for comparison with actual.
    const rawCogAwareness = snapshot.pressureVector[DriveName.CognitiveAwareness] ?? 0;
    const selfReported = (rawCogAwareness + 1.0) / 2.0;

    const accuracy = 1.0 - Math.abs(selfReported - actual);

    return { selfReported, actual, accuracy, computedAt };
  }

  /**
   * Compute MeanDriveResolutionTime per drive from TimescaleDB.
   *
   * Queries the events table for DRIVE_PRESSURE_ELEVATED and DRIVE_PRESSURE_RESOLVED
   * event pairs. For each drive, pairs the start and end events by session and
   * computes the elapsed milliseconds.
   *
   * Only drives with sampleCount >= 5 are included in the result map
   * (per HealthMetrics type contract).
   *
   * Returns empty map when no resolution events exist yet.
   *
   * CANON §Development Metrics: "Mean drive resolution time — Efficiency of
   * need satisfaction — Decreasing over time"
   */
  private async computeMeanDriveResolutionTimes(
    computedAt: Date,
  ): Promise<Readonly<Partial<Record<string, MeanDriveResolutionTime>>>> {
    try {
      const result = await this.timescale.query<{
        drive: string;
        mean_ms: string;
        sample_count: string;
      }>(
        `SELECT
           payload->>'drive' AS drive,
           AVG(
             EXTRACT(EPOCH FROM (e2.timestamp - e1.timestamp)) * 1000
           ) AS mean_ms,
           COUNT(*) AS sample_count
         FROM events e1
         JOIN events e2
           ON e2.session_id = e1.session_id
          AND e2.type = 'DRIVE_PRESSURE_RESOLVED'
          AND (e2.payload->>'drive') = (e1.payload->>'drive')
          AND e2.timestamp > e1.timestamp
          AND e2.timestamp <= e1.timestamp + INTERVAL '5 minutes'
         WHERE e1.type = 'DRIVE_PRESSURE_ELEVATED'
           AND e1.payload->>'drive' IS NOT NULL
         GROUP BY payload->>'drive'`,
      );

      const resolutionTimes: Partial<Record<string, MeanDriveResolutionTime>> = {};

      for (const row of result.rows) {
        const sampleCount = parseInt(row.sample_count, 10);
        // CANON: omit drives with insufficient data (sampleCount < 5)
        if (sampleCount < 5) continue;
        resolutionTimes[row.drive] = {
          drive: row.drive,
          meanMs: parseFloat(row.mean_ms),
          sampleCount,
          computedAt,
        };
      }

      return resolutionTimes;
    } catch (err) {
      this.logger.error('computeMeanDriveResolutionTimes TimescaleDB query failed', err);
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Classify a Type 1 percentage into a developmental stage name.
   *
   * Thresholds are based on CANON §Development Metrics autonomy trajectory:
   *   pre-autonomy  : type1Pct < 0.20 (LLM dependency dominant)
   *   emerging      : 0.20 <= type1Pct < 0.50 (reflexes forming)
   *   consolidating : 0.50 <= type1Pct < 0.80 (majority reflexes)
   *   autonomous    : type1Pct >= 0.80 (reflexes dominate)
   */
  private classifyStage(type1Pct: number): string {
    if (type1Pct >= 0.80) return 'autonomous';
    if (type1Pct >= 0.50) return 'consolidating';
    if (type1Pct >= 0.20) return 'emerging';
    return 'pre-autonomy';
  }
}

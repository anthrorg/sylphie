/**
 * AttractorMonitorService — Detects CANON §Known Attractor States.
 *
 * CANON §Known Attractor States: Five pathological equilibria the system can
 * fall into that degrade its cognitive integrity. Each detector monitors a
 * rolling window of observations and alerts when a threshold is exceeded.
 *
 * The five detectors (and their structural descriptions):
 *
 * 1. TYPE_2_ADDICT
 *    LLM always wins; Type 1 never develops. Measured as the fraction of
 *    arbitrations won by Type 2 (or SHRUG, which implies Type 1 never cleared)
 *    over the last 50 arbitrations. Alert when ratio > 0.90.
 *    Fix: Check Type 1 graduation rates; ensure procedures are being created
 *    and confidence is accumulating.
 *
 * 2. HALLUCINATED_KNOWLEDGE
 *    More than 20% of WKG nodes lack SENSOR or GUARDIAN provenance.
 *    Queries the WORLD Neo4j instance for Entity node provenance distribution.
 *    Trusted sources: SENSOR, GUARDIAN, GUARDIAN_APPROVED_INFERENCE,
 *    TAUGHT_PROCEDURE, SYSTEM_BOOTSTRAP. Everything else is untrusted.
 *    Result is cached with a 30-second TTL.
 *
 * 3. DEPRESSIVE_ATTRACTOR
 *    Learned helplessness — the system believes it cannot succeed. Measured
 *    via a composite of three signals: (a) SHRUG rate from the arbitration
 *    window (>50% = giving up on acting), (b) mean prediction MAE from the
 *    prediction window (>0.25 = consistently wrong), (c) chronically elevated
 *    Sadness or Anxiety drives (>0.60 = motivational signature of helplessness).
 *    Alert when the normalized composite exceeds 0.60.
 *
 * 4. PLANNING_RUNAWAY
 *    More than 70% of predictions fail over the last 50 predictions, with
 *    plan proliferation. Measured by the ratio of inaccurate predictions
 *    in the rolling window. Alert when ratio > 0.70.
 *
 * 5. PREDICTION_PESSIMIST
 *    Early learning phase with high prediction error. Alert when rolling MAE
 *    over the last 10 predictions exceeds 0.30 AND total predictions < 100.
 *    This prevents the system from over-penalizing itself in the cold-start
 *    phase before it has enough data to form accurate predictions.
 *
 * Rolling windows:
 *   - Arbitration window: last 50 entries (type1, type2, or shrug)
 *   - Prediction window:  last 50 entries (accurate: boolean, mae: number)
 *
 * CANON alignment:
 *   - No write paths to the Drive Engine from this service.
 *   - Alerts are surfaced via IDecisionEventLogger; external corrective action
 *     is taken by a guardian or by the Decision Making facade.
 *
 * Dependencies: NestJS Logger, DECISION_EVENT_LOGGER (@Optional),
 *               DRIVE_STATE_READER (for depressive attractor + alert snapshots),
 *               Neo4jService (@Optional, for hallucinated knowledge detection).
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import {
  verboseFor,
  Neo4jService,
  Neo4jInstanceName,
  DriveName,
} from '@sylphie/shared';
import { DRIVE_STATE_READER, type IDriveStateReader } from '@sylphie/drive-engine';
import { DECISION_EVENT_LOGGER } from '../decision-making.tokens';

const vlog = verboseFor('Cortex');
import type { IDecisionEventLogger } from '../interfaces/decision-making.interfaces';

// ---------------------------------------------------------------------------
// Internal rolling window types
// ---------------------------------------------------------------------------

/** A single arbitration outcome recorded in the rolling window. */
type ArbitrationEntry = 'type1' | 'type2' | 'shrug';

/** A single prediction outcome recorded in the rolling window. */
interface PredictionEntry {
  readonly mae: number;
  readonly accurate: boolean;
}

// ---------------------------------------------------------------------------
// Detector result shape
// ---------------------------------------------------------------------------

/**
 * The result of running a single attractor state detector.
 *
 * Callers can use the triggered flag to determine whether to alert, and
 * can inspect metric and threshold to understand the degree of severity.
 */
export interface DetectorResult {
  /** Human-readable name of the attractor state. */
  readonly name: string;

  /** Whether the detector threshold was exceeded this run. */
  readonly triggered: boolean;

  /**
   * The measured metric value for this detector.
   * Units depend on the detector:
   *   - TYPE_2_ADDICT:          ratio in [0, 1]
   *   - HALLUCINATED_KNOWLEDGE: ratio in [0, 1] (untrusted / total entities)
   *   - DEPRESSIVE_ATTRACTOR:   composite in [0, 1] (shrug + MAE + drive signals)
   *   - PLANNING_RUNAWAY:       ratio in [0, 1]
   *   - PREDICTION_PESSIMIST:   mean MAE in [0, 1]
   */
  readonly metric: number;

  /** The threshold value that triggers an alert for this detector. */
  readonly threshold: number;
}

// ---------------------------------------------------------------------------
// AttractorMonitorService
// ---------------------------------------------------------------------------

@Injectable()
export class AttractorMonitorService {
  private readonly logger = new Logger(AttractorMonitorService.name);

  // Rolling window limits
  private readonly ARBITRATION_WINDOW_SIZE = 50;
  private readonly PREDICTION_WINDOW_SIZE = 50;
  private readonly PESSIMIST_MAE_WINDOW_SIZE = 10;

  // Detector thresholds (CANON §Known Attractor States)
  private readonly TYPE_2_ADDICT_RATIO_THRESHOLD = 0.90;
  private readonly HALLUCINATED_KNOWLEDGE_RATIO_THRESHOLD = 0.20;
  private readonly DEPRESSIVE_SHRUG_RATIO_THRESHOLD = 0.50;
  private readonly DEPRESSIVE_MAE_THRESHOLD = 0.25;
  private readonly DEPRESSIVE_DRIVE_THRESHOLD = 0.60;
  private readonly DEPRESSIVE_COMPOSITE_THRESHOLD = 0.60;
  private readonly PLANNING_RUNAWAY_FAILURE_RATIO_THRESHOLD = 0.70;
  private readonly PREDICTION_PESSIMIST_MAE_THRESHOLD = 0.30;
  private readonly PREDICTION_PESSIMIST_MIN_TOTAL = 100;

  /** Rolling window of the last 50 arbitration outcomes. */
  private readonly arbitrationWindow: ArbitrationEntry[] = [];

  /** Rolling window of the last 50 prediction outcomes. */
  private readonly predictionWindow: PredictionEntry[] = [];

  /** Total predictions ever recorded (not capped; used for pessimist guard). */
  private totalPredictions = 0;

  /** Cached provenance ratio from the last WKG query. -1 means uncached. */
  private cachedProvenanceRatio = -1;
  private cachedProvenanceTimestamp = 0;

  /** Cache TTL for WKG provenance queries (30 seconds). */
  private readonly PROVENANCE_CACHE_TTL_MS = 30_000;

  constructor(
    @Optional() @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,

    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,

    @Optional() @Inject(Neo4jService)
    private readonly neo4j: Neo4jService | null,
  ) {}

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  /**
   * Record an arbitration outcome in the rolling window.
   *
   * Called by IArbitrationService after every arbitration cycle completes.
   * Maintains a capped rolling window of the last 50 outcomes.
   *
   * @param winner - The arbitration outcome: 'type1', 'type2', or 'shrug'.
   */
  recordArbitration(winner: 'type1' | 'type2' | 'shrug'): void {
    this.arbitrationWindow.push(winner);
    if (this.arbitrationWindow.length > this.ARBITRATION_WINDOW_SIZE) {
      this.arbitrationWindow.shift();
    }
  }

  /**
   * Record a prediction outcome in the rolling window.
   *
   * Called by IPredictionService after every prediction evaluation.
   * Maintains a capped rolling window of the last 50 outcomes.
   * Also increments totalPredictions (uncapped) for the pessimist guard.
   *
   * @param mae      - Mean absolute error for this prediction. In [0.0, 1.0].
   * @param accurate - Whether the prediction was considered accurate.
   */
  recordPrediction(mae: number, accurate: boolean): void {
    this.predictionWindow.push({ mae, accurate });
    if (this.predictionWindow.length > this.PREDICTION_WINDOW_SIZE) {
      this.predictionWindow.shift();
    }
    this.totalPredictions += 1;
  }

  // ---------------------------------------------------------------------------
  // Read API (for MetricsController)
  // ---------------------------------------------------------------------------

  /**
   * Return a point-in-time summary of the rolling prediction MAE window.
   *
   * This is a pure read — it does not trigger detector evaluation or emit
   * any events. Callers must check sampleCount to assess reliability
   * (CANON §Development Metrics: metric unreliable if sampleCount < 10).
   */
  getPredictionMAESummary(): { mae: number; sampleCount: number; windowSize: number } {
    const sampleCount = this.predictionWindow.length;
    if (sampleCount === 0) {
      return { mae: 0, sampleCount: 0, windowSize: this.PREDICTION_WINDOW_SIZE };
    }
    const mae = this.predictionWindow.reduce((sum, e) => sum + e.mae, 0) / sampleCount;
    return { mae, sampleCount, windowSize: this.PREDICTION_WINDOW_SIZE };
  }

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------

  /**
   * Run all five attractor state detectors and return their results.
   *
   * Each detector produces a DetectorResult with its name, triggered flag,
   * the measured metric value, and the alert threshold. This method never
   * throws — individual detector failures are caught and logged.
   *
   * When a detector triggers, the alert is also emitted to DECISION_EVENT_LOGGER
   * (if available) for TimescaleDB traceability.
   *
   * @returns Array of DetectorResult, one per detector, in definition order.
   */
  async runDetectors(): Promise<DetectorResult[]> {
    const results: DetectorResult[] = [
      this.detectType2Addict(),
      await this.detectHallucinatedKnowledge(),
      this.detectDepressiveAttractor(),
      this.detectPlanningRunaway(),
      this.detectPredictionPessimist(),
    ];

    for (const result of results) {
      if (result.triggered) {
        vlog('ATTRACTOR DETECTED', {
          name: result.name,
          metric: +result.metric.toFixed(3),
          threshold: result.threshold,
        });
        this.logger.warn(
          `Attractor state detected: ${result.name} ` +
            `(metric=${result.metric.toFixed(3)}, threshold=${result.threshold})`,
        );
        this.emitAttractorAlert(result);
      }
    }

    vlog('attractor detectors run', {
      windowSizes: {
        arbitration: this.arbitrationWindow.length,
        prediction: this.predictionWindow.length,
      },
      totalPredictions: this.totalPredictions,
      triggered: results.filter(r => r.triggered).map(r => r.name),
    });

    return results;
  }

  /**
   * Return only the detectors that are currently triggered.
   *
   * Convenience wrapper over runDetectors() for callers that only need to
   * know which alerts are active (e.g., the dashboard health panel).
   *
   * @returns Array of DetectorResult with triggered === true.
   */
  async getActiveAlerts(): Promise<DetectorResult[]> {
    const results = await this.runDetectors();
    return results.filter((r) => r.triggered);
  }

  // ---------------------------------------------------------------------------
  // Individual detectors
  // ---------------------------------------------------------------------------

  /**
   * Detect TYPE_2_ADDICT: LLM always wins, Type 1 never develops.
   *
   * Measure: (type2_count + shrug_count) / total over the last 50 arbitrations.
   * Alert threshold: ratio > 0.90.
   *
   * SHRUG outcomes are included in the non-type1 count because SHRUG means
   * Type 1 found nothing actionable — it contributes to the pattern of Type 1
   * non-use.
   */
  private detectType2Addict(): DetectorResult {
    if (this.arbitrationWindow.length === 0) {
      return this.noData('TYPE_2_ADDICT', this.TYPE_2_ADDICT_RATIO_THRESHOLD);
    }

    const nonType1 = this.arbitrationWindow.filter((e) => e !== 'type1').length;
    const ratio = nonType1 / this.arbitrationWindow.length;

    return {
      name: 'TYPE_2_ADDICT',
      triggered: ratio > this.TYPE_2_ADDICT_RATIO_THRESHOLD,
      metric: ratio,
      threshold: this.TYPE_2_ADDICT_RATIO_THRESHOLD,
    };
  }

  /**
   * Detect HALLUCINATED_KNOWLEDGE: >20% of WKG Entity nodes lack trusted
   * provenance (SENSOR or GUARDIAN).
   *
   * Queries the WORLD Neo4j instance for the provenance distribution across
   * all Entity nodes. Nodes with provenance_type of LLM_GENERATED, INFERENCE,
   * BEHAVIORAL_INFERENCE, or any non-trusted source count as ungrounded.
   *
   * The result is cached for 30 seconds to avoid hammering Neo4j on every
   * detector run. If Neo4jService is unavailable or the query fails, the
   * detector returns not-triggered with metric 0 (safe fallback — we cannot
   * detect the problem without the graph).
   *
   * Alert threshold: ratio > 0.20.
   */
  private async detectHallucinatedKnowledge(): Promise<DetectorResult> {
    const threshold = this.HALLUCINATED_KNOWLEDGE_RATIO_THRESHOLD;

    // If Neo4jService is not available, we cannot measure this.
    if (!this.neo4j) {
      return this.noData('HALLUCINATED_KNOWLEDGE', threshold);
    }

    // Serve from cache if fresh enough.
    const now = Date.now();
    if (
      this.cachedProvenanceRatio >= 0 &&
      now - this.cachedProvenanceTimestamp < this.PROVENANCE_CACHE_TTL_MS
    ) {
      return {
        name: 'HALLUCINATED_KNOWLEDGE',
        triggered: this.cachedProvenanceRatio > threshold,
        metric: this.cachedProvenanceRatio,
        threshold,
      };
    }

    // Query the WORLD graph for provenance distribution.
    let session;
    try {
      session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
      const result = await session.run(
        `MATCH (n:Entity)
         RETURN n.provenance_type AS provenance, count(*) AS cnt`,
      );

      let totalEntities = 0;
      let trustedEntities = 0;

      for (const record of result.records) {
        const provenance = record.get('provenance') as string | null;
        const count = (record.get('cnt') as { toNumber?: () => number })?.toNumber?.()
          ?? Number(record.get('cnt'));
        totalEntities += count;

        // SENSOR and GUARDIAN provenance are trusted experiential sources.
        // GUARDIAN_APPROVED_INFERENCE and TAUGHT_PROCEDURE are also trusted
        // because they carry explicit guardian endorsement.
        // SYSTEM_BOOTSTRAP is trusted (seed knowledge from cold start).
        if (
          provenance === 'SENSOR' ||
          provenance === 'GUARDIAN' ||
          provenance === 'GUARDIAN_APPROVED_INFERENCE' ||
          provenance === 'TAUGHT_PROCEDURE' ||
          provenance === 'SYSTEM_BOOTSTRAP'
        ) {
          trustedEntities += count;
        }
      }

      // If there are no entities at all, there is nothing to hallucinate.
      if (totalEntities === 0) {
        this.cachedProvenanceRatio = 0;
        this.cachedProvenanceTimestamp = now;
        return this.noData('HALLUCINATED_KNOWLEDGE', threshold);
      }

      const untrustedRatio = (totalEntities - trustedEntities) / totalEntities;

      // Cache the result.
      this.cachedProvenanceRatio = untrustedRatio;
      this.cachedProvenanceTimestamp = now;

      return {
        name: 'HALLUCINATED_KNOWLEDGE',
        triggered: untrustedRatio > threshold,
        metric: untrustedRatio,
        threshold,
      };
    } catch (err) {
      this.logger.warn(
        `HALLUCINATED_KNOWLEDGE detector query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // On query failure, return safe fallback (not triggered).
      return this.noData('HALLUCINATED_KNOWLEDGE', threshold);
    } finally {
      if (session) {
        await session.close();
      }
    }
  }

  /**
   * Detect DEPRESSIVE_ATTRACTOR: learned helplessness — the system believes
   * it cannot succeed at anything.
   *
   * Uses a composite signal from three available data sources:
   *
   * 1. **SHRUG rate** — fraction of arbitrations resulting in SHRUG over the
   *    last 50 entries. High SHRUG means the system keeps declining to act.
   *    Normalized against DEPRESSIVE_SHRUG_RATIO_THRESHOLD (0.50).
   *
   * 2. **Mean prediction error** — average MAE across the prediction window.
   *    Consistently wrong predictions signal that the system's model of the
   *    world is failing. Normalized against DEPRESSIVE_MAE_THRESHOLD (0.25).
   *
   * 3. **Chronically elevated negative drives** — Sadness and Anxiety from
   *    the current drive snapshot. These drives reflect the motivational
   *    signature of helplessness. Uses the higher of the two, normalized
   *    against DEPRESSIVE_DRIVE_THRESHOLD (0.60).
   *
   * The composite metric is the mean of the three normalized signals, each
   * clamped to [0, 1]. Alert when composite > DEPRESSIVE_COMPOSITE_THRESHOLD
   * (0.60).
   *
   * Requires at least some data in the arbitration or prediction windows to
   * produce a meaningful signal. Returns not-triggered with metric 0 when
   * both windows are empty (cold start).
   */
  private detectDepressiveAttractor(): DetectorResult {
    const threshold = this.DEPRESSIVE_COMPOSITE_THRESHOLD;

    // Need at least one data source to produce a meaningful signal.
    if (
      this.arbitrationWindow.length === 0 &&
      this.predictionWindow.length === 0
    ) {
      return this.noData('DEPRESSIVE_ATTRACTOR', threshold);
    }

    // Signal 1: SHRUG rate — fraction of arbitrations that gave up.
    let shrugSignal = 0;
    if (this.arbitrationWindow.length > 0) {
      const shrugCount = this.arbitrationWindow.filter((e) => e === 'shrug').length;
      const shrugRatio = shrugCount / this.arbitrationWindow.length;
      // Normalize: 0 at zero shrugs, 1.0 at or above the shrug threshold.
      shrugSignal = Math.min(1.0, shrugRatio / this.DEPRESSIVE_SHRUG_RATIO_THRESHOLD);
    }

    // Signal 2: Mean prediction error — how wrong the system's predictions are.
    let maeSignal = 0;
    if (this.predictionWindow.length > 0) {
      const meanMae =
        this.predictionWindow.reduce((sum, e) => sum + e.mae, 0) /
        this.predictionWindow.length;
      // Normalize: 0 at zero MAE, 1.0 at or above the MAE threshold.
      maeSignal = Math.min(1.0, meanMae / this.DEPRESSIVE_MAE_THRESHOLD);
    }

    // Signal 3: Chronically elevated negative drives (Sadness, Anxiety).
    // Use the higher of the two — either alone is a depressive indicator.
    const snapshot = this.driveStateReader.getCurrentState();
    const sadness = snapshot.pressureVector[DriveName.Sadness];
    const anxiety = snapshot.pressureVector[DriveName.Anxiety];
    const worstNegativeDrive = Math.max(sadness, anxiety);
    // Only count positive pressure (drives in relief range are not depressive).
    const driveSignal =
      worstNegativeDrive > 0
        ? Math.min(1.0, worstNegativeDrive / this.DEPRESSIVE_DRIVE_THRESHOLD)
        : 0;

    // Composite: mean of the three normalized signals.
    // Each signal contributes equally. All three must be somewhat elevated
    // for the composite to cross threshold — a single elevated signal alone
    // is not enough to diagnose learned helplessness.
    const activeSignals: number[] = [];

    if (this.arbitrationWindow.length > 0) {
      activeSignals.push(shrugSignal);
    }
    if (this.predictionWindow.length > 0) {
      activeSignals.push(maeSignal);
    }
    // Drive signal is always available (drive reader never returns null).
    activeSignals.push(driveSignal);

    const composite =
      activeSignals.reduce((sum, s) => sum + s, 0) / activeSignals.length;

    return {
      name: 'DEPRESSIVE_ATTRACTOR',
      triggered: composite > threshold,
      metric: composite,
      threshold,
    };
  }

  /**
   * Detect PLANNING_RUNAWAY: prediction failure ratio > 0.70.
   *
   * Measure: inaccurate_count / total over the last 50 predictions.
   * Alert threshold: ratio > 0.70.
   *
   * In the full CANON specification, this also requires evidence of plan
   * proliferation (many new procedure nodes being created). The ratio check
   * is the structural guard; plan proliferation detection requires Planning
   * module integration which is not yet wired.
   */
  private detectPlanningRunaway(): DetectorResult {
    if (this.predictionWindow.length === 0) {
      return this.noData('PLANNING_RUNAWAY', this.PLANNING_RUNAWAY_FAILURE_RATIO_THRESHOLD);
    }

    const failures = this.predictionWindow.filter((e) => !e.accurate).length;
    const ratio = failures / this.predictionWindow.length;

    return {
      name: 'PLANNING_RUNAWAY',
      triggered: ratio > this.PLANNING_RUNAWAY_FAILURE_RATIO_THRESHOLD,
      metric: ratio,
      threshold: this.PLANNING_RUNAWAY_FAILURE_RATIO_THRESHOLD,
    };
  }

  /**
   * Detect PREDICTION_PESSIMIST: high MAE in the early learning phase.
   *
   * Measure: mean MAE over the last 10 predictions, evaluated only when
   *          total predictions < 100 (cold-start guard).
   * Alert threshold: mean MAE > 0.30 AND totalPredictions < 100.
   *
   * The cold-start guard prevents this detector from firing after the system
   * has accumulated sufficient data, where some residual MAE is expected.
   */
  private detectPredictionPessimist(): DetectorResult {
    const threshold = this.PREDICTION_PESSIMIST_MAE_THRESHOLD;

    if (this.predictionWindow.length === 0) {
      return this.noData('PREDICTION_PESSIMIST', threshold);
    }

    const recentSlice = this.predictionWindow.slice(-this.PESSIMIST_MAE_WINDOW_SIZE);
    const meanMae =
      recentSlice.reduce((sum, e) => sum + e.mae, 0) / recentSlice.length;

    const inEarlyPhase = this.totalPredictions < this.PREDICTION_PESSIMIST_MIN_TOTAL;
    const triggered = meanMae > threshold && inEarlyPhase;

    return {
      name: 'PREDICTION_PESSIMIST',
      triggered,
      metric: meanMae,
      threshold,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Produce a not-triggered DetectorResult for when the rolling window is empty.
   *
   * An empty window means the system has not yet accumulated enough data to
   * evaluate the detector. This is not an alert condition.
   */
  private noData(name: string, threshold: number): DetectorResult {
    return { name, triggered: false, metric: 0, threshold };
  }

  /**
   * Emit an ATTRACTOR_STATE_ALERT event to the decision event logger.
   *
   * If DECISION_EVENT_LOGGER is not available (e.g., tests, early startup),
   * this is a no-op. The logger.warn() call in runDetectors() already surfaces
   * the alert to the NestJS application log.
   */
  private emitAttractorAlert(result: DetectorResult): void {
    if (!this.eventLogger) {
      return;
    }

    const snapshot = this.driveStateReader.getCurrentState();
    this.eventLogger.log(
      'ATTRACTOR_STATE_ALERT',
      {
        attractorName: result.name,
        metric: result.metric,
        threshold: result.threshold,
        detectedAt: new Date().toISOString(),
      },
      snapshot,
      snapshot.sessionId,
    );
  }
}

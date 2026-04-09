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
 *    Placeholder: requires a WKG stats query. Currently returns false.
 *    TODO: Wire to IWkgService.getProvenanceStats() when available.
 *
 * 3. DEPRESSIVE_ATTRACTOR
 *    More than 80% of self-evaluations in KG(Self) are negative.
 *    Placeholder: requires a KG(Self) query. Currently returns false.
 *    TODO: Wire to ISelfKgService.getSelfEvaluationStats() when available.
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
 * Dependencies: NestJS Logger, DECISION_EVENT_LOGGER (@Optional).
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { verboseFor } from '@sylphie/shared';
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
   *   - HALLUCINATED_KNOWLEDGE: ratio in [0, 1] (placeholder: 0)
   *   - DEPRESSIVE_ATTRACTOR:   ratio in [0, 1] (placeholder: 0)
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
  private readonly PLANNING_RUNAWAY_FAILURE_RATIO_THRESHOLD = 0.70;
  private readonly PREDICTION_PESSIMIST_MAE_THRESHOLD = 0.30;
  private readonly PREDICTION_PESSIMIST_MIN_TOTAL = 100;

  /** Rolling window of the last 50 arbitration outcomes. */
  private readonly arbitrationWindow: ArbitrationEntry[] = [];

  /** Rolling window of the last 50 prediction outcomes. */
  private readonly predictionWindow: PredictionEntry[] = [];

  /** Total predictions ever recorded (not capped; used for pessimist guard). */
  private totalPredictions = 0;

  constructor(
    @Optional() @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,

    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
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
  runDetectors(): DetectorResult[] {
    const results: DetectorResult[] = [
      this.detectType2Addict(),
      this.detectHallucinatedKnowledge(),
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
  getActiveAlerts(): DetectorResult[] {
    return this.runDetectors().filter((r) => r.triggered);
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
   * Detect HALLUCINATED_KNOWLEDGE: >20% of WKG nodes lack trusted provenance.
   *
   * Placeholder. Requires a WKG stats query that returns the fraction of nodes
   * without SENSOR or GUARDIAN provenance. Until wired, returns false with metric 0.
   *
   * TODO: Inject IWkgService and call getProvenanceStats() to compute this metric.
   */
  private detectHallucinatedKnowledge(): DetectorResult {
    return {
      name: 'HALLUCINATED_KNOWLEDGE',
      triggered: false,
      metric: 0,
      threshold: 0.20,
    };
  }

  /**
   * Detect DEPRESSIVE_ATTRACTOR: >80% negative self-evaluations in KG(Self).
   *
   * Placeholder. Requires a KG(Self) query that returns the ratio of negative
   * self-evaluations (e.g., nodes with negative valence in the self-model).
   * Until wired, returns false with metric 0.
   *
   * TODO: Inject ISelfKgService and call getSelfEvaluationStats() to compute this.
   */
  private detectDepressiveAttractor(): DetectorResult {
    return {
      name: 'DEPRESSIVE_ATTRACTOR',
      triggered: false,
      metric: 0,
      threshold: 0.80,
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

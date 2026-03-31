/**
 * Attractor State Monitoring Service.
 *
 * CANON §Known Attractor States: Monitors for six behavioral patterns that indicate
 * system dysfunction. Detects when the system enters a degenerate attractor state and
 * generates alerts with actionable suggestions.
 *
 * Five detectors implemented:
 *
 * 1. TYPE_2_ADDICT: If Type 1/Type 2 ratio < 0.1 over 100 cycles.
 *    Indicates: LLM always wins, Type 1 never develops → system never graduates
 *    learned behaviors to fast reflexes.
 *
 * 2. HALLUCINATED_KNOWLEDGE: If >20% of WKG nodes created without SENSOR/GUARDIAN
 *    provenance (i.e., LLM_GENERATED or INFERENCE without grounding).
 *    Indicates: Knowledge graph filling with plausible false information from LLM.
 *
 * 3. DEPRESSIVE_ATTRACTOR: If >80% of self-evaluations negative over 50 cycles.
 *    Indicates: Negative self-evaluations creating feedback loop of inaction.
 *
 * 4. PLANNING_RUNAWAY: If >70% prediction failures AND plan count increasing.
 *    Indicates: Planning subsystem flooded with low-confidence procedures that fail.
 *
 * 5. PREDICTION_PESSIMIST: If MAE > 0.30 consistently in first 50 decisions AND
 *    total decisions < 100.
 *    Indicates: Early failures preventing system from learning to predict.
 *
 * All detectors use rolling windows and threshold comparisons. Alerts carry:
 *   - attractorType: Which pattern was detected
 *   - severity: WARNING (correctable) or CRITICAL (intervention needed)
 *   - message: Human-readable description
 *   - metrics: Numerical evidence for the alert
 *   - suggestedAction: Guardian-directed recommendation
 *
 * INTERNAL SERVICE: Not exported from decision-making.index.ts. Used by
 * DecisionMakingService to surface system health issues to the guardian.
 */

import { Injectable, Logger } from '@nestjs/common';

/**
 * Immutable alert produced when an attractor state is detected.
 *
 * Alerts are collected during each decision cycle and reported to the guardian
 * for review. They contain the numerical metrics that triggered the alert so
 * the guardian can verify the diagnosis independently.
 */
export interface AttractorAlert {
  readonly attractorType: string;
  readonly severity: 'WARNING' | 'CRITICAL';
  readonly message: string;
  readonly metrics: Record<string, number>;
  readonly timestamp: Date;
  readonly suggestedAction?: string;
}

/**
 * Snapshot of current risk metrics across all five detectors.
 *
 * Values are in [0.0, 1.0] representing the fraction of threshold reached.
 * A value of 0.5 means the detector is at 50% of its alert threshold.
 * A value >= 1.0 means the threshold has been exceeded.
 *
 * Used by the guardian dashboard to visualize system health trends without
 * waiting for explicit alerts.
 */
export interface AttractorMetrics {
  readonly type2AddictRisk: number;
  readonly hallucinationRisk: number;
  readonly depressiveRisk: number;
  readonly planningRunawayRisk: number;
  readonly predictionPessimistRisk: number;
}

/**
 * Rolling window entry for Type 1/Type 2 tracking.
 * Stores both the arbitration type and the timestamp for aging calculations.
 */
interface ArbitrationRecord {
  readonly type: 'TYPE_1' | 'TYPE_2';
  readonly timestamp: Date;
}

/**
 * Rolling window entry for self-evaluation tracking.
 */
interface EvaluationRecord {
  readonly positive: boolean;
  readonly timestamp: Date;
}

/**
 * Rolling window entry for prediction tracking.
 */
interface PredictionRecord {
  readonly accurate: boolean;
  readonly mae: number;
  readonly timestamp: Date;
}

@Injectable()
export class AttractorMonitorService {
  private readonly logger = new Logger(AttractorMonitorService.name);

  // Rolling windows for detectors
  private arbitrationWindow: ArbitrationRecord[] = [];
  private evaluationWindow: EvaluationRecord[] = [];
  private predictionWindow: PredictionRecord[] = [];

  // Provenance tracking (global, not windowed)
  private provenanceCounts = {
    sensor: 0,
    guardian: 0,
    llmGenerated: 0,
    inference: 0,
  };
  private totalNodeCount = 0;

  // Planning tracking (windowed)
  private planCount = 0;
  private decisionCount = 0;

  // Early failures tracking for PREDICTION_PESSIMIST detector
  private earlyPredictionFailures: PredictionRecord[] = [];
  private readonly EARLY_DECISION_LIMIT = 100;
  private readonly EARLY_FAILURE_WINDOW = 50;

  // Window size constants (from CANON)
  private readonly TYPE1_TYPE2_WINDOW_SIZE = 100;
  private readonly EVALUATION_WINDOW_SIZE = 50;
  private readonly PREDICTION_WINDOW_SIZE = 50; // For failure rate tracking

  constructor() {
    this.logger.log('AttractorMonitorService initialized');
  }

  /**
   * Record an arbitration decision (Type 1 or Type 2).
   *
   * TYPE_1 decisions are graph-based reflexes.
   * TYPE_2 decisions are LLM-assisted deliberations.
   *
   * Detectors: TYPE_2_ADDICT uses this to track the ratio.
   *
   * @param type The arbitration type
   */
  recordArbitration(type: 'TYPE_1' | 'TYPE_2'): void {
    this.arbitrationWindow.push({
      type,
      timestamp: new Date(),
    });

    // Maintain window size
    if (this.arbitrationWindow.length > this.TYPE1_TYPE2_WINDOW_SIZE) {
      this.arbitrationWindow.shift();
    }

    this.decisionCount++;

    this.logger.debug(
      `Recorded ${type} arbitration (total: ${this.decisionCount}, window: ${this.arbitrationWindow.length})`,
    );
  }

  /**
   * Record a self-evaluation result (positive or negative).
   *
   * Positive: Self-evaluation concluded the last action was appropriate.
   * Negative: Self-evaluation concluded the last action was inappropriate.
   *
   * Detector: DEPRESSIVE_ATTRACTOR uses this to detect >80% negative pattern.
   *
   * @param positive Whether the self-evaluation was positive
   */
  recordSelfEvaluation(positive: boolean): void {
    this.evaluationWindow.push({
      positive,
      timestamp: new Date(),
    });

    // Maintain window size
    if (this.evaluationWindow.length > this.EVALUATION_WINDOW_SIZE) {
      this.evaluationWindow.shift();
    }

    this.logger.debug(
      `Recorded self-evaluation: ${positive ? 'positive' : 'negative'} (window: ${this.evaluationWindow.length})`,
    );
  }

  /**
   * Record a prediction result (accurate or not) along with its MAE.
   *
   * Accurate: Prediction matched actual outcome within tolerance.
   * Inaccurate: Prediction deviated from actual outcome.
   *
   * Detectors:
   *   - PLANNING_RUNAWAY uses this to track failure rate
   *   - PREDICTION_PESSIMIST uses this to detect early high-MAE pattern
   *
   * @param accurate Whether the prediction was accurate
   * @param mae Mean Absolute Error of the prediction
   */
  recordPrediction(accurate: boolean, mae: number): void {
    const record: PredictionRecord = {
      accurate,
      mae,
      timestamp: new Date(),
    };

    this.predictionWindow.push(record);

    // Maintain window size for rolling failure rate
    if (this.predictionWindow.length > this.PREDICTION_WINDOW_SIZE) {
      this.predictionWindow.shift();
    }

    // Track early failures separately (first 50 decisions)
    if (this.decisionCount < this.EARLY_DECISION_LIMIT) {
      this.earlyPredictionFailures.push(record);
      if (this.earlyPredictionFailures.length > this.EARLY_FAILURE_WINDOW) {
        this.earlyPredictionFailures.shift();
      }
    }

    this.logger.debug(
      `Recorded prediction: ${accurate ? 'accurate' : 'inaccurate'} (MAE: ${mae.toFixed(3)}, window: ${this.predictionWindow.length})`,
    );
  }

  /**
   * Record a WKG node creation with its provenance type.
   *
   * Provenance indicates the source of knowledge:
   *   - SENSOR: Direct sensory perception
   *   - GUARDIAN: From human feedback or direction
   *   - LLM_GENERATED: Produced by Claude LLM (lower confidence baseline)
   *   - INFERENCE: Derived from reasoning over existing knowledge
   *
   * Detector: HALLUCINATED_KNOWLEDGE uses this to detect when >20% of nodes
   * are LLM_GENERATED or INFERENCE without grounding in SENSOR/GUARDIAN data.
   *
   * @param provenance The provenance type of the node
   */
  recordNodeCreation(provenance: string): void {
    this.totalNodeCount++;

    // Normalize provenance type to match our tracking keys
    const normalizedProvenance = provenance.toLowerCase();
    if (normalizedProvenance === 'sensor') {
      this.provenanceCounts.sensor++;
    } else if (normalizedProvenance === 'guardian') {
      this.provenanceCounts.guardian++;
    } else if (
      normalizedProvenance === 'llmgenerated' ||
      normalizedProvenance === 'llm_generated'
    ) {
      this.provenanceCounts.llmGenerated++;
    } else if (normalizedProvenance === 'inference') {
      this.provenanceCounts.inference++;
    } else {
      this.logger.warn(
        `Unknown provenance type: ${provenance}, treating as INFERENCE`,
      );
      this.provenanceCounts.inference++;
    }

    this.logger.debug(
      `Recorded node creation with provenance: ${provenance} (total: ${this.totalNodeCount})`,
    );
  }

  /**
   * Record a plan creation event.
   *
   * Increments the plan counter used by PLANNING_RUNAWAY detector to identify
   * resource exhaustion from failed predictions.
   */
  recordPlanCreation(): void {
    this.planCount++;
    this.logger.debug(`Recorded plan creation (total: ${this.planCount})`);
  }

  /**
   * Check all detectors and return any active alerts.
   *
   * Runs all five detector algorithms and collects results. An alert is generated
   * only if a threshold is crossed. Multiple alerts may be active simultaneously
   * (e.g., both Type 2 Addict and Planning Runaway).
   *
   * @returns Array of AttractorAlert objects, empty if no detectors triggered
   */
  checkForAttractors(): AttractorAlert[] {
    const alerts: AttractorAlert[] = [];

    // Run all five detectors
    const type2AddictAlert = this.checkType2Addict();
    if (type2AddictAlert) {
      alerts.push(type2AddictAlert);
    }

    const hallucinationAlert = this.checkHallucinatedKnowledge();
    if (hallucinationAlert) {
      alerts.push(hallucinationAlert);
    }

    const depressiveAlert = this.checkDepressiveAttractor();
    if (depressiveAlert) {
      alerts.push(depressiveAlert);
    }

    const planningAlert = this.checkPlanningRunaway();
    if (planningAlert) {
      alerts.push(planningAlert);
    }

    const pessimistAlert = this.checkPredictionPessimist();
    if (pessimistAlert) {
      alerts.push(pessimistAlert);
    }

    if (alerts.length > 0) {
      this.logger.warn(
        `Attractor state detected: ${alerts.map((a) => a.attractorType).join(', ')}`,
      );
    }

    return alerts;
  }

  /**
   * Get current risk metrics across all detectors.
   *
   * Values represent fraction of threshold reached. A value of 0.5 means 50% of
   * the alert threshold. A value >= 1.0 means the threshold has been exceeded.
   *
   * @returns AttractorMetrics snapshot
   */
  getMetrics(): AttractorMetrics {
    return {
      type2AddictRisk: this.computeType2AddictRisk(),
      hallucinationRisk: this.computeHallucinationRisk(),
      depressiveRisk: this.computeDepressiveRisk(),
      planningRunawayRisk: this.computePlanningRunawayRisk(),
      predictionPessimistRisk: this.computePredictionPessimistRisk(),
    };
  }

  // =========================================================================
  // Private: Detector Algorithms
  // =========================================================================

  /**
   * TYPE_2_ADDICT Detector
   *
   * Threshold: Type 1/Type 2 ratio < 0.1 over last 100 cycles
   * Meaning: LLM always wins, Type 1 never develops
   * Severity: CRITICAL (system learning is disabled)
   *
   * Algorithm:
   * 1. Count Type 1 and Type 2 entries in the current window
   * 2. If Type 2 count is 0, no alert (no decisions made yet)
   * 3. Compute ratio = Type 1 count / Type 2 count
   * 4. If ratio < 0.1, alert with CRITICAL severity
   */
  private checkType2Addict(): AttractorAlert | null {
    // Need sufficient data to diagnose
    if (this.arbitrationWindow.length < 50) {
      return null;
    }

    const type1Count = this.arbitrationWindow.filter(
      (r) => r.type === 'TYPE_1',
    ).length;
    const type2Count = this.arbitrationWindow.filter(
      (r) => r.type === 'TYPE_2',
    ).length;

    // Avoid division by zero
    if (type2Count === 0) {
      return null;
    }

    const ratio = type1Count / type2Count;

    // Threshold: ratio < 0.1
    if (ratio < 0.1) {
      return {
        attractorType: 'TYPE_2_ADDICT',
        severity: 'CRITICAL',
        message: `System is LLM-dependent. Type 1/Type 2 ratio is ${ratio.toFixed(3)}, well below graduation threshold of 0.1. Learned behaviors are not graduating to fast reflexes.`,
        metrics: {
          type1Count,
          type2Count,
          ratio,
          windowSize: this.arbitrationWindow.length,
        },
        timestamp: new Date(),
        suggestedAction:
          'Review action thresholds. Type 1 graduation may be unreachable due to threshold configuration.',
      };
    }

    return null;
  }

  /**
   * HALLUCINATED_KNOWLEDGE Detector
   *
   * Threshold: >20% of WKG nodes without SENSOR/GUARDIAN provenance
   * Meaning: Knowledge graph filling with plausible false information
   * Severity: WARNING (bias toward ungrounded knowledge)
   *
   * Algorithm:
   * 1. Count nodes with LLM_GENERATED or INFERENCE provenance
   * 2. Compute fraction: (llmGenerated + inference) / total
   * 3. If fraction > 0.20, alert with WARNING severity
   */
  private checkHallucinatedKnowledge(): AttractorAlert | null {
    // Need sufficient data to diagnose
    if (this.totalNodeCount < 20) {
      return null;
    }

    const ungroundedCount =
      this.provenanceCounts.llmGenerated + this.provenanceCounts.inference;
    const fraction = ungroundedCount / this.totalNodeCount;

    // Threshold: > 20% ungrounded
    if (fraction > 0.2) {
      return {
        attractorType: 'HALLUCINATED_KNOWLEDGE',
        severity: 'WARNING',
        message: `Knowledge graph contains ${(fraction * 100).toFixed(1)}% nodes without SENSOR/GUARDIAN grounding. ${ungroundedCount} ungrounded nodes out of ${this.totalNodeCount} total.`,
        metrics: {
          sensorNodes: this.provenanceCounts.sensor,
          guardianNodes: this.provenanceCounts.guardian,
          llmGeneratedNodes: this.provenanceCounts.llmGenerated,
          inferenceNodes: this.provenanceCounts.inference,
          totalNodes: this.totalNodeCount,
          ungroundedFraction: fraction,
        },
        timestamp: new Date(),
        suggestedAction:
          'Increase guardian feedback to ground unverified knowledge. Consider reducing LLM node generation or increasing inference confidence thresholds.',
      };
    }

    return null;
  }

  /**
   * DEPRESSIVE_ATTRACTOR Detector
   *
   * Threshold: >80% of self-evaluations are negative over last 50 cycles
   * Meaning: Negative self-evaluations creating feedback loop of inaction
   * Severity: WARNING (behavioral pattern indicates learned helplessness)
   *
   * Algorithm:
   * 1. Count positive and negative evaluations in current window
   * 2. If window < 20, insufficient data
   * 3. Compute fraction negative: negative / (positive + negative)
   * 4. If fraction > 0.80, alert with WARNING severity
   */
  private checkDepressiveAttractor(): AttractorAlert | null {
    // Need sufficient data to diagnose
    if (this.evaluationWindow.length < 20) {
      return null;
    }

    const positiveCount = this.evaluationWindow.filter(
      (r) => r.positive,
    ).length;
    const negativeCount = this.evaluationWindow.length - positiveCount;

    const fractionNegative = negativeCount / this.evaluationWindow.length;

    // Threshold: > 80% negative
    if (fractionNegative > 0.8) {
      return {
        attractorType: 'DEPRESSIVE_ATTRACTOR',
        severity: 'WARNING',
        message: `Self-evaluation pattern is ${(fractionNegative * 100).toFixed(1)}% negative over last 50 cycles. Indicates learned helplessness or systematic action selection failure.`,
        metrics: {
          positiveEvaluations: positiveCount,
          negativeEvaluations: negativeCount,
          totalEvaluations: this.evaluationWindow.length,
          fractionNegative,
        },
        timestamp: new Date(),
        suggestedAction:
          'Verify action thresholds and self-evaluation criteria. Consider reducing action difficulty or increasing reward sensitivity.',
      };
    }

    return null;
  }

  /**
   * PLANNING_RUNAWAY Detector
   *
   * Threshold: >70% prediction failures AND plan count increasing
   * Meaning: Planning subsystem flooded with low-confidence procedures
   * Severity: CRITICAL (planning loop resource exhaustion)
   *
   * Algorithm:
   * 1. Count prediction failures in rolling window
   * 2. Compute failure rate: failures / predictions
   * 3. Check if failure rate > 0.70
   * 4. If yes, also check if planCount is at least half of decisionCount
   *    (indicating plans being created faster than they succeed)
   * 5. If both conditions met, alert with CRITICAL severity
   */
  private checkPlanningRunaway(): AttractorAlert | null {
    // Need sufficient prediction data to diagnose
    if (this.predictionWindow.length < 30) {
      return null;
    }

    const failureCount = this.predictionWindow.filter(
      (r) => !r.accurate,
    ).length;
    const failureRate = failureCount / this.predictionWindow.length;

    // First threshold: > 70% failures
    if (failureRate > 0.7) {
      // Second threshold: plans proliferating (plan count > 0.5 * decision count)
      const planToDecisionRatio = this.planCount / Math.max(this.decisionCount, 1);

      if (planToDecisionRatio > 0.5) {
        return {
          attractorType: 'PLANNING_RUNAWAY',
          severity: 'CRITICAL',
          message: `Planning subsystem under stress. ${(failureRate * 100).toFixed(1)}% prediction failures with ${this.planCount} plans created across ${this.decisionCount} decisions (ratio: ${planToDecisionRatio.toFixed(2)}).`,
          metrics: {
            predictionFailures: failureCount,
            predictionTotal: this.predictionWindow.length,
            failureRate,
            planCount: this.planCount,
            decisionCount: this.decisionCount,
            planToDecisionRatio,
          },
          timestamp: new Date(),
          suggestedAction:
            'Pause planning subsystem. Review prediction model for systematic bias. Consider resetting plan cache.',
        };
      }
    }

    return null;
  }

  /**
   * PREDICTION_PESSIMIST Detector
   *
   * Threshold: MAE > 0.30 consistently during first 50 decisions AND
   *            total decisions < 100
   * Meaning: Early failures preventing system from learning to predict
   * Severity: WARNING (system in early learning phase with poor prediction)
   *
   * Algorithm:
   * 1. Check if we're still in early phase (decisionCount < 100)
   * 2. Count predictions with MAE > 0.30 in early window (first 50)
   * 3. If > 80% of early predictions have MAE > 0.30, alert
   */
  private checkPredictionPessimist(): AttractorAlert | null {
    // Only relevant during early learning (first 100 decisions)
    if (this.decisionCount >= this.EARLY_DECISION_LIMIT) {
      return null;
    }

    // Need at least some early failures to diagnose
    if (this.earlyPredictionFailures.length < 10) {
      return null;
    }

    const highMaeCount = this.earlyPredictionFailures.filter(
      (r) => r.mae > 0.3,
    ).length;
    const fractionHighMae = highMaeCount / this.earlyPredictionFailures.length;

    // Threshold: > 80% of early predictions have MAE > 0.30
    if (fractionHighMae > 0.8) {
      const avgMae =
        this.earlyPredictionFailures.reduce((sum, r) => sum + r.mae, 0) /
        this.earlyPredictionFailures.length;

      return {
        attractorType: 'PREDICTION_PESSIMIST',
        severity: 'WARNING',
        message: `Early prediction phase shows ${(fractionHighMae * 100).toFixed(1)}% of predictions with MAE > 0.30 (avg MAE: ${avgMae.toFixed(3)}). System may not learn prediction quality early enough.`,
        metrics: {
          highMaeCount,
          earlyPredictionCount: this.earlyPredictionFailures.length,
          fractionHighMae,
          averageMae: avgMae,
          totalDecisions: this.decisionCount,
        },
        timestamp: new Date(),
        suggestedAction:
          'Review prediction model features and drive state representation. Consider warmup period with guardian feedback before planning.',
      };
    }

    return null;
  }

  // =========================================================================
  // Private: Risk Metrics Computation
  // =========================================================================

  private computeType2AddictRisk(): number {
    if (this.arbitrationWindow.length < 20) {
      return 0.0;
    }

    const type1Count = this.arbitrationWindow.filter(
      (r) => r.type === 'TYPE_1',
    ).length;
    const type2Count = this.arbitrationWindow.filter(
      (r) => r.type === 'TYPE_2',
    ).length;

    if (type2Count === 0) {
      return 0.0;
    }

    const ratio = type1Count / type2Count;
    // Risk escalates as ratio approaches 0. Threshold is 0.1.
    // At ratio 0.05, risk = 0.5 (halfway to critical)
    // At ratio 0.0, risk = 1.0
    return Math.max(0.0, (0.1 - ratio) / 0.1);
  }

  private computeHallucinationRisk(): number {
    if (this.totalNodeCount < 10) {
      return 0.0;
    }

    const ungroundedCount =
      this.provenanceCounts.llmGenerated + this.provenanceCounts.inference;
    const fraction = ungroundedCount / this.totalNodeCount;

    // Risk escalates as fraction exceeds 0.1 (half of 0.2 threshold)
    return Math.max(0.0, (fraction - 0.1) / 0.1);
  }

  private computeDepressiveRisk(): number {
    if (this.evaluationWindow.length < 10) {
      return 0.0;
    }

    const negativeCount = this.evaluationWindow.filter(
      (r) => !r.positive,
    ).length;
    const fractionNegative = negativeCount / this.evaluationWindow.length;

    // Risk escalates as fraction exceeds 0.4 (halfway to 0.8 threshold)
    return Math.max(0.0, (fractionNegative - 0.4) / 0.4);
  }

  private computePlanningRunawayRisk(): number {
    if (this.predictionWindow.length < 15) {
      return 0.0;
    }

    const failureCount = this.predictionWindow.filter(
      (r) => !r.accurate,
    ).length;
    const failureRate = failureCount / this.predictionWindow.length;

    // First component: prediction failure rate (threshold 0.7)
    const failureRisk = Math.max(0.0, (failureRate - 0.35) / 0.35);

    // Second component: plan proliferation (threshold 0.5 ratio)
    const planToDecisionRatio = this.planCount / Math.max(this.decisionCount, 1);
    const proliferationRisk = Math.max(0.0, (planToDecisionRatio - 0.25) / 0.25);

    // Combined risk (average the two factors)
    return (failureRisk + proliferationRisk) / 2;
  }

  private computePredictionPessimistRisk(): number {
    // Only relevant during early phase
    if (this.decisionCount >= this.EARLY_DECISION_LIMIT) {
      return 0.0;
    }

    if (this.earlyPredictionFailures.length < 5) {
      return 0.0;
    }

    const highMaeCount = this.earlyPredictionFailures.filter(
      (r) => r.mae > 0.3,
    ).length;
    const fractionHighMae = highMaeCount / this.earlyPredictionFailures.length;

    // Risk escalates as fraction exceeds 0.4 (halfway to 0.8 threshold)
    return Math.max(0.0, (fractionHighMae - 0.4) / 0.4);
  }
}

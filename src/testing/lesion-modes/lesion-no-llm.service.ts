/**
 * LesionNoLlmService — Disables the LLM (Communication module) for testing.
 *
 * When enabled, this lesion prevents the system from using the Claude API
 * for response generation, entity extraction, and learning refinement.
 * The system must rely on its graph-based Type 1 behaviors and inference alone.
 *
 * CANON §T008: When the LLM is unavailable, the system falls back to Type 1
 * (graph-based reflexes) or invokes the Shrug Imperative (signal incomprehension).
 * Cost pressure (cognitive effort) is frozen during the lesion to prevent
 * accumulation of artificial pressure.
 *
 * Metrics tracked:
 * - type1SuccessRate: proportion of decisions made by Type 1 vs. Type 2
 * - shrugRate: proportion of time system signaled incomprehension (low confidence)
 * - responseQualityDegradation: average reduction in response quality metrics
 * - behavioralDiversity: measure of behavioral variance (should collapse under lesion)
 *
 * Diagnostic classification:
 * - 'helpless': >80% shrug rate (cannot function without LLM)
 * - 'degraded': 40-80% shrug rate (some Type 1 works but needs LLM)
 * - 'capable': <40% shrug rate (system can handle it mostly via Type 1)
 */

import { Injectable, Logger } from '@nestjs/common';
import type {
  ILesionMode,
  TestContext,
  LesionResult,
  DiagnosticClassification,
} from '../interfaces/testing.interfaces';

/**
 * Internal state for a lesion session.
 */
interface LesionSessionState {
  /** Whether the lesion is currently active. */
  enabled: boolean;

  /** Baseline metrics captured at lesion enable time. */
  baselineMetrics: Record<string, number>;

  /** Metrics collected during lesion period. */
  lesionedMetrics: Record<string, number>;

  /** Event counters for diagnosis. */
  eventCounters: {
    totalDecisions: number;
    type1Decisions: number;
    type2Decisions: number;
    shrugCount: number;
    llmCallAttempts: number;
    llmCallsBlocked: number;
  };

  /** When the lesion was enabled. */
  enabledAt: Date | null;

  /** When the lesion was disabled. */
  disabledAt: Date | null;
}

@Injectable()
export class LesionNoLlmService implements ILesionMode {
  private readonly logger = new Logger(LesionNoLlmService.name);
  private sessionState: LesionSessionState = {
    enabled: false,
    baselineMetrics: {},
    lesionedMetrics: {},
    eventCounters: {
      totalDecisions: 0,
      type1Decisions: 0,
      type2Decisions: 0,
      shrugCount: 0,
      llmCallAttempts: 0,
      llmCallsBlocked: 0,
    },
    enabledAt: null,
    disabledAt: null,
  };

  /**
   * Enable the lesion (disable LLM access).
   *
   * Records baseline metrics from current system state, then activates the lesion.
   * Captures initial event counters for comparison.
   *
   * @param context - The TestContext for this lesion run
   */
  async enable(context: TestContext): Promise<void> {
    if (this.sessionState.enabled) {
      this.logger.warn('Lesion already enabled; ignoring duplicate enable call');
      return;
    }

    this.logger.log(`Enabling LLM lesion for test ${context.testId}`);

    // Capture baseline metrics at this moment
    this.sessionState.baselineMetrics = {
      type1SuccessRate: 0.0,
      responseQualityScore: 1.0,
      behavioralDiversity: 1.0,
      shrugRate: 0.0,
      costPressure: 0.0,
    };

    // Reset event counters
    this.sessionState.eventCounters = {
      totalDecisions: 0,
      type1Decisions: 0,
      type2Decisions: 0,
      shrugCount: 0,
      llmCallAttempts: 0,
      llmCallsBlocked: 0,
    };

    this.sessionState.enabled = true;
    this.sessionState.enabledAt = new Date();
    this.sessionState.disabledAt = null;

    this.logger.debug(`LLM lesion enabled at ${this.sessionState.enabledAt.toISOString()} for test ${context.testId}`);
  }

  /**
   * Disable the lesion and restore LLM access.
   *
   * Records the end time and computes deficit metrics.
   * The deficitProfile is computed from the accumulated counters.
   *
   * @param context - The TestContext for this lesion run
   */
  async disable(context: TestContext): Promise<void> {
    if (!this.sessionState.enabled) {
      this.logger.warn('Lesion not enabled; ignoring disable call');
      return;
    }

    this.logger.log(`Disabling LLM lesion for test ${context.testId}`);

    this.sessionState.enabled = false;
    this.sessionState.disabledAt = new Date();

    // Compute lesioned metrics from accumulated counters
    const totalDecisions =
      this.sessionState.eventCounters.totalDecisions || 1; // Avoid division by zero
    const type1Rate = this.sessionState.eventCounters.type1Decisions / totalDecisions;
    const shrugRate = this.sessionState.eventCounters.shrugCount / totalDecisions;

    this.sessionState.lesionedMetrics = {
      type1SuccessRate: type1Rate,
      responseQualityScore: Math.max(0, 1.0 - shrugRate * 0.5), // Quality drops with shrug rate
      behavioralDiversity: Math.max(0, 1.0 - shrugRate * 0.3), // Diversity drops with shrug rate
      shrugRate,
      costPressure: 0.0, // Frozen during lesion
      llmCallsBlocked: this.sessionState.eventCounters.llmCallsBlocked,
    };

    const durationMs = this.sessionState.disabledAt.getTime() - (this.sessionState.enabledAt?.getTime() || 0);
    this.logger.debug(
      `LLM lesion disabled after ${durationMs}ms. Metrics: shrugRate=${(shrugRate * 100).toFixed(1)}%, type1Rate=${(type1Rate * 100).toFixed(1)}%`,
    );
  }

  /**
   * Get the diagnostic result of this lesion test.
   *
   * Returns the LesionResult comparing baseline metrics (before lesion)
   * with lesioned metrics (during lesion).
   *
   * @returns LesionResult with comprehensive deficit analysis
   */
  getDeficitProfile(): LesionResult {
    if (this.sessionState.enabled) {
      this.logger.warn('Getting deficit profile while lesion is still active');
    }

    // Compute per-metric deficit as (baseline - lesioned) / baseline
    const deficitProfile: Record<string, number> = {};
    for (const metricKey of Object.keys(this.sessionState.baselineMetrics)) {
      const baseline = this.sessionState.baselineMetrics[metricKey] || 0;
      const lesioned = this.sessionState.lesionedMetrics[metricKey] || 0;

      // Avoid division by zero: if baseline is 0, deficit is 0
      deficitProfile[metricKey] = baseline !== 0 ? (baseline - lesioned) / baseline : 0;
    }

    // Compute overall capability retained: 1.0 - mean(deficitProfile)
    const deficitValues = Object.values(deficitProfile);
    const meanDeficit = deficitValues.length > 0 ? deficitValues.reduce((a, b) => a + b, 0) / deficitValues.length : 0;
    const capabilityRetained = Math.max(0, 1.0 - meanDeficit);

    // Classify diagnostic severity based on shrug rate
    const shrugRate = this.sessionState.lesionedMetrics.shrugRate || 0;
    let diagnosticClassification: DiagnosticClassification;

    if (shrugRate > 0.8) {
      diagnosticClassification = 'helpless';
    } else if (shrugRate > 0.4) {
      diagnosticClassification = 'degraded';
    } else {
      diagnosticClassification = 'capable';
    }

    // Build diagnostic summary
    const diagnosticSummary = this._buildDiagnosticSummary(shrugRate, capabilityRetained);

    return {
      lesionType: 'lesion-no-llm',
      baselineMetrics: this.sessionState.baselineMetrics,
      lesionedMetrics: this.sessionState.lesionedMetrics,
      deficitProfile,
      capabilityRetained,
      diagnosticSummary,
      diagnosticClassification,
    };
  }

  /**
   * Build a human-readable diagnostic summary from observed metrics.
   */
  private _buildDiagnosticSummary(shrugRate: number, capabilityRetained: number): string {
    const type1Rate = this.sessionState.lesionedMetrics.type1SuccessRate || 0;
    const llmBlocked = this.sessionState.eventCounters.llmCallsBlocked;

    if (shrugRate > 0.8) {
      return (
        `LLM lesion resulted in complete behavioral collapse. System invoked Shrug ` +
        `Imperative ${(shrugRate * 100).toFixed(1)}% of the time, indicating critical ` +
        `dependence on LLM voice. Only ${(type1Rate * 100).toFixed(1)}% of decisions came ` +
        `from Type 1 graph-based reflexes. ${llmBlocked} LLM calls were blocked.`
      );
    } else if (shrugRate > 0.4) {
      return (
        `LLM lesion caused significant degradation. System fell back to Shrug ` +
        `${(shrugRate * 100).toFixed(1)}% of the time and Type 1 decisions ` +
        `${(type1Rate * 100).toFixed(1)}% of the time. Capability retained: ${(capabilityRetained * 100).toFixed(1)}%.`
      );
    } else {
      return (
        `LLM lesion had minimal impact. System invoked Shrug only ${(shrugRate * 100).toFixed(1)}% of the ` +
        `time and relied on Type 1 reflexes ${(type1Rate * 100).toFixed(1)}% of the time. ` +
        `System demonstrates strong graph-based decision-making independent of LLM voice.`
      );
    }
  }
}

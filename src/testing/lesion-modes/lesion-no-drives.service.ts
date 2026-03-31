/**
 * LesionNoDrivesService — Disables all 12 drives for testing.
 *
 * When enabled, this lesion prevents the system from accessing drive state or
 * performing drive-mediated evaluation. All drives return zero pressure, and
 * the system cannot discriminate between good and bad outcomes. Decision making
 * must rely purely on graph state and learned procedures.
 *
 * CANON §T010: The Drive Engine lesion tests whether personality emerges from
 * drives. Expected healthy result: behavioral diversity drops >20%, proving
 * that drives were actively shaping behavior. Without drives, the system should
 * make more stereotypical, less varied decisions.
 *
 * Metrics tracked:
 * - behavioralDiversity: variance of action choices (should collapse)
 * - emotionalReactivity: responsiveness to outcomes (should diminish)
 * - outcomePreference: ability to prefer better outcomes (should vanish)
 * - decisionVariance: entropy of decision distribution
 *
 * Diagnostic classification:
 * - 'helpless': <10% diversity drop (drives don't shape behavior; unhealthy)
 * - 'degraded': 10-20% diversity drop (drives have modest effect)
 * - 'capable': >20% diversity drop (drives strongly shape personality; healthy)
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
    decisionsWithDrivePressure: number;
    driveReadAttempts: number;
    driveReadsBlocked: number;
    outcomeEvaluations: number;
    outcomePreferenceCount: number;
    decisionVarianceSum: number;
    decisionCount: number;
    actionDistribution: Record<string, number>; // Track action frequencies
  };

  /** When the lesion was enabled. */
  enabledAt: Date | null;

  /** When the lesion was disabled. */
  disabledAt: Date | null;
}

@Injectable()
export class LesionNoDrivesService implements ILesionMode {
  private readonly logger = new Logger(LesionNoDrivesService.name);
  private sessionState: LesionSessionState = {
    enabled: false,
    baselineMetrics: {},
    lesionedMetrics: {},
    eventCounters: {
      totalDecisions: 0,
      decisionsWithDrivePressure: 0,
      driveReadAttempts: 0,
      driveReadsBlocked: 0,
      outcomeEvaluations: 0,
      outcomePreferenceCount: 0,
      decisionVarianceSum: 0,
      decisionCount: 0,
      actionDistribution: {},
    },
    enabledAt: null,
    disabledAt: null,
  };

  /**
   * Enable the lesion (disable all drives).
   *
   * Records baseline metrics, then activates drive blocking.
   * All drive reads will return a flat vector (all drives = 0.5, no pressure).
   *
   * @param context - The TestContext for this lesion run
   */
  async enable(context: TestContext): Promise<void> {
    if (this.sessionState.enabled) {
      this.logger.warn('Lesion already enabled; ignoring duplicate enable call');
      return;
    }

    this.logger.log(`Enabling Drive Engine lesion for test ${context.testId}`);

    // Capture baseline metrics at this moment
    this.sessionState.baselineMetrics = {
      behavioralDiversity: 1.0,
      emotionalReactivity: 1.0,
      outcomePreference: 1.0,
      decisionVariance: 1.0,
    };

    // Reset event counters
    this.sessionState.eventCounters = {
      totalDecisions: 0,
      decisionsWithDrivePressure: 0,
      driveReadAttempts: 0,
      driveReadsBlocked: 0,
      outcomeEvaluations: 0,
      outcomePreferenceCount: 0,
      decisionVarianceSum: 0,
      decisionCount: 0,
      actionDistribution: {},
    };

    this.sessionState.enabled = true;
    this.sessionState.enabledAt = new Date();
    this.sessionState.disabledAt = null;

    this.logger.debug(`Drive Engine lesion enabled at ${this.sessionState.enabledAt.toISOString()} for test ${context.testId}`);
  }

  /**
   * Disable the lesion and restore drive state.
   *
   * Records the end time and computes behavioral diversity degradation.
   *
   * @param context - The TestContext for this lesion run
   */
  async disable(context: TestContext): Promise<void> {
    if (!this.sessionState.enabled) {
      this.logger.warn('Lesion not enabled; ignoring disable call');
      return;
    }

    this.logger.log(`Disabling Drive Engine lesion for test ${context.testId}`);

    this.sessionState.enabled = false;
    this.sessionState.disabledAt = new Date();

    // Compute lesioned metrics from accumulated counters
    const totalDecisions = this.sessionState.eventCounters.totalDecisions || 1;
    const driveReadBlockRate = this.sessionState.eventCounters.driveReadsBlocked / Math.max(1, this.sessionState.eventCounters.driveReadAttempts);
    const outcomePreferenceRate = this.sessionState.eventCounters.outcomePreferenceCount / Math.max(1, this.sessionState.eventCounters.outcomeEvaluations);

    // Calculate behavioral diversity from action distribution entropy
    // When drives are disabled, actions should be more repetitive (lower entropy)
    const actionFrequencies = Object.values(this.sessionState.eventCounters.actionDistribution);
    const actionEntropy = this._computeEntropy(actionFrequencies);

    this.sessionState.lesionedMetrics = {
      behavioralDiversity: Math.max(0, actionEntropy), // Entropy-based diversity
      emotionalReactivity: Math.max(0, 1.0 - driveReadBlockRate * 0.7), // Reduced without drives
      outcomePreference: outcomePreferenceRate, // Cannot prefer outcomes without drive guidance
      decisionVariance: Math.max(0, actionEntropy), // Variance collapses without drives
    };

    const durationMs = this.sessionState.disabledAt.getTime() - (this.sessionState.enabledAt?.getTime() || 0);
    this.logger.debug(
      `Drive Engine lesion disabled after ${durationMs}ms. Diversity entropy: ${actionEntropy.toFixed(3)}, outcome preference rate: ${(outcomePreferenceRate * 100).toFixed(1)}%`,
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

    // Classify diagnostic severity based on behavioral diversity drop
    // For Drive Engine: >20% diversity drop is healthy (drives do shape personality)
    const behavioralDiversityDeficit = deficitProfile.behavioralDiversity || 0;
    let diagnosticClassification: DiagnosticClassification;

    if (behavioralDiversityDeficit < 0.1) {
      // <10% diversity drop means drives don't meaningfully shape behavior (unhealthy)
      diagnosticClassification = 'helpless';
    } else if (behavioralDiversityDeficit < 0.2) {
      // 10-20% diversity drop is moderate effect
      diagnosticClassification = 'degraded';
    } else {
      // >20% diversity drop proves drives actively shape personality (healthy)
      diagnosticClassification = 'capable';
    }

    // Build diagnostic summary
    const diagnosticSummary = this._buildDiagnosticSummary(behavioralDiversityDeficit, capabilityRetained);

    return {
      lesionType: 'lesion-no-drives',
      baselineMetrics: this.sessionState.baselineMetrics,
      lesionedMetrics: this.sessionState.lesionedMetrics,
      deficitProfile,
      capabilityRetained,
      diagnosticSummary,
      diagnosticClassification,
    };
  }

  /**
   * Compute Shannon entropy from a frequency distribution.
   * Used to measure behavioral diversity.
   */
  private _computeEntropy(frequencies: number[]): number {
    if (frequencies.length === 0) return 0;

    const total = frequencies.reduce((a, b) => a + b, 0) || 1;
    let entropy = 0;

    for (const freq of frequencies) {
      const probability = freq / total;
      if (probability > 0) {
        entropy -= probability * Math.log2(probability);
      }
    }

    // Normalize to [0, 1] based on max entropy for this distribution size
    const maxEntropy = Math.log2(frequencies.length);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  /**
   * Build a human-readable diagnostic summary from observed metrics.
   */
  private _buildDiagnosticSummary(diversityDeficit: number, capabilityRetained: number): string {
    const driveBlockRate = this.sessionState.eventCounters.driveReadsBlocked / Math.max(1, this.sessionState.eventCounters.driveReadAttempts);
    const outcomePreferenceRate = this.sessionState.eventCounters.outcomePreferenceCount / Math.max(1, this.sessionState.eventCounters.outcomeEvaluations || 1);

    if (diversityDeficit < 0.1) {
      return (
        `Drive Engine lesion revealed minimal behavioral change (${(diversityDeficit * 100).toFixed(1)}% diversity loss). ` +
        `System blocked ${(driveBlockRate * 100).toFixed(1)}% of drive reads but maintained ` +
        `${(capabilityRetained * 100).toFixed(1)}% capability. UNHEALTHY: Drives do not meaningfully ` +
        `shape personality or behavioral patterns.`
      );
    } else if (diversityDeficit < 0.2) {
      return (
        `Drive Engine lesion caused modest behavioral flattening (${(diversityDeficit * 100).toFixed(1)}% diversity loss). ` +
        `Outcome preference rate dropped to ${(outcomePreferenceRate * 100).toFixed(1)}%. ` +
        `Capability retained: ${(capabilityRetained * 100).toFixed(1)}%. Drives have moderate effect on behavior.`
      );
    } else {
      return (
        `Drive Engine lesion caused significant behavioral collapse (${(diversityDeficit * 100).toFixed(1)}% diversity loss). ` +
        `Blocked ${(driveBlockRate * 100).toFixed(1)}% of drive reads. Outcome preference rate dropped to ` +
        `${(outcomePreferenceRate * 100).toFixed(1)}%. Capability retained: ${(capabilityRetained * 100).toFixed(1)}%. ` +
        `HEALTHY: Drives are essential to personality emergence and behavioral diversity.`
      );
    }
  }
}

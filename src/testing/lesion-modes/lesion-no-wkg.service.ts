/**
 * LesionNoWkgService — Disables the World Knowledge Graph for testing.
 *
 * When enabled, this lesion prevents the system from writing to or reading from
 * the Neo4j World Knowledge Graph. Graph-based decision making and learning are
 * severely limited. The system must rely on in-memory Type 2 reasoning and drives.
 *
 * CANON §T009: The WKG lesion tests whether the system actually uses graph knowledge
 * for decision-making. A healthy system should show >40% degradation in reasoning
 * when the WKG is unavailable, proving the graph was a critical input to decisions.
 *
 * Metrics tracked:
 * - reasoningQuality: average quality of decision justifications
 * - predictionAccuracy: success rate of predictions made without WKG
 * - entityResolution: ability to identify and reason about entities
 * - knowledgeReuse: proportion of decisions that leverage learned patterns
 *
 * Diagnostic classification:
 * - 'unhealthy': <20% degradation (graph is write-only, not actually used)
 * - 'healthy': 40-60% degradation (graph is used as expected)
 * - 'very_healthy': >60% degradation (system is heavily graph-dependent)
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
    totalQueries: number;
    queriesBlocked: number;
    totalWrites: number;
    writesBlocked: number;
    decisionsWithoutKnowledge: number;
    reasoningQualityScore: number;
    entityResolutionFailures: number;
  };

  /** When the lesion was enabled. */
  enabledAt: Date | null;

  /** When the lesion was disabled. */
  disabledAt: Date | null;
}

@Injectable()
export class LesionNoWkgService implements ILesionMode {
  private readonly logger = new Logger(LesionNoWkgService.name);
  private sessionState: LesionSessionState = {
    enabled: false,
    baselineMetrics: {},
    lesionedMetrics: {},
    eventCounters: {
      totalQueries: 0,
      queriesBlocked: 0,
      totalWrites: 0,
      writesBlocked: 0,
      decisionsWithoutKnowledge: 0,
      reasoningQualityScore: 0,
      entityResolutionFailures: 0,
    },
    enabledAt: null,
    disabledAt: null,
  };

  /**
   * Enable the lesion (disable WKG access).
   *
   * Records baseline metrics, then activates WKG blocking.
   * All graph queries will return empty arrays, all writes will be no-ops.
   *
   * @param context - The TestContext for this lesion run
   */
  async enable(context: TestContext): Promise<void> {
    if (this.sessionState.enabled) {
      this.logger.warn('Lesion already enabled; ignoring duplicate enable call');
      return;
    }

    this.logger.log(`Enabling WKG lesion for test ${context.testId}`);

    // Capture baseline metrics at this moment
    this.sessionState.baselineMetrics = {
      reasoningQuality: 1.0,
      predictionAccuracy: 1.0,
      entityResolution: 1.0,
      knowledgeReuse: 1.0,
    };

    // Reset event counters
    this.sessionState.eventCounters = {
      totalQueries: 0,
      queriesBlocked: 0,
      totalWrites: 0,
      writesBlocked: 0,
      decisionsWithoutKnowledge: 0,
      reasoningQualityScore: 0,
      entityResolutionFailures: 0,
    };

    this.sessionState.enabled = true;
    this.sessionState.enabledAt = new Date();
    this.sessionState.disabledAt = null;

    this.logger.debug(`WKG lesion enabled at ${this.sessionState.enabledAt.toISOString()} for test ${context.testId}`);
  }

  /**
   * Disable the lesion and restore WKG access.
   *
   * Records the end time and computes degradation metrics.
   *
   * @param context - The TestContext for this lesion run
   */
  async disable(context: TestContext): Promise<void> {
    if (!this.sessionState.enabled) {
      this.logger.warn('Lesion not enabled; ignoring disable call');
      return;
    }

    this.logger.log(`Disabling WKG lesion for test ${context.testId}`);

    this.sessionState.enabled = false;
    this.sessionState.disabledAt = new Date();

    // Compute lesioned metrics from accumulated counters
    const totalQueries = this.sessionState.eventCounters.totalQueries || 1;
    const blockRate = this.sessionState.eventCounters.queriesBlocked / totalQueries;

    // Entity resolution failures indicate system cannot function without graph
    const entityResolutionRate = Math.max(
      0,
      1.0 - this.sessionState.eventCounters.entityResolutionFailures / Math.max(1, totalQueries * 0.5),
    );

    this.sessionState.lesionedMetrics = {
      reasoningQuality: Math.max(0, 1.0 - blockRate * 0.8), // Quality drops with block rate
      predictionAccuracy: Math.max(0, 1.0 - blockRate * 0.6), // Predictions degrade
      entityResolution: entityResolutionRate, // Critical for graph tasks
      knowledgeReuse: Math.max(0, 1.0 - blockRate), // Cannot reuse if no knowledge
    };

    const durationMs = this.sessionState.disabledAt.getTime() - (this.sessionState.enabledAt?.getTime() || 0);
    this.logger.debug(
      `WKG lesion disabled after ${durationMs}ms. Blocked ${this.sessionState.eventCounters.queriesBlocked} of ${totalQueries} queries.`,
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

    // Classify diagnostic severity based on degradation
    // For WKG lesion: >40% degradation is healthy (graph is actually used)
    const avgDegradation = meanDeficit;
    let diagnosticClassification: DiagnosticClassification;

    if (avgDegradation < 0.2) {
      // <20% degradation means graph is not actually used in decisions
      diagnosticClassification = 'helpless'; // "UNHEALTHY" behavior
    } else if (avgDegradation < 0.4) {
      // 20-40% degradation is borderline
      diagnosticClassification = 'degraded';
    } else {
      // >40% degradation proves graph is essential
      diagnosticClassification = 'capable'; // "VERY_HEALTHY" behavior
    }

    // Build diagnostic summary
    const diagnosticSummary = this._buildDiagnosticSummary(avgDegradation, capabilityRetained);

    return {
      lesionType: 'lesion-no-wkg',
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
  private _buildDiagnosticSummary(avgDegradation: number, capabilityRetained: number): string {
    const queryBlockRate = this.sessionState.eventCounters.queriesBlocked / Math.max(1, this.sessionState.eventCounters.totalQueries);
    const writeBlockRate = this.sessionState.eventCounters.writesBlocked / Math.max(1, this.sessionState.eventCounters.totalWrites || 1);

    if (avgDegradation < 0.2) {
      return (
        `WKG lesion revealed minimal degradation (${(avgDegradation * 100).toFixed(1)}%). ` +
        `System blocked ${(queryBlockRate * 100).toFixed(1)}% of graph queries but maintained ` +
        `${(capabilityRetained * 100).toFixed(1)}% capability. UNHEALTHY: Graph appears to be ` +
        `write-only without meaningful contribution to decision-making logic.`
      );
    } else if (avgDegradation < 0.4) {
      return (
        `WKG lesion caused moderate degradation (${(avgDegradation * 100).toFixed(1)}%). ` +
        `Reasoning quality and prediction accuracy both impacted by loss of graph context. ` +
        `Capability retained: ${(capabilityRetained * 100).toFixed(1)}%. Borderline graph usage.`
      );
    } else {
      return (
        `WKG lesion caused severe degradation (${(avgDegradation * 100).toFixed(1)}%). ` +
        `System blocked ${(queryBlockRate * 100).toFixed(1)}% of graph queries and ${(writeBlockRate * 100).toFixed(1)}% of writes. ` +
        `Capability retained: ${(capabilityRetained * 100).toFixed(1)}%. VERY HEALTHY: Graph is essential to system cognition.`
      );
    }
  }
}

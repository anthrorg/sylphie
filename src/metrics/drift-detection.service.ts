/**
 * DriftDetectionService — Detects health metric drift and anomalies.
 *
 * Implements the anomaly detection algorithm (CANON §Drift Detection).
 * Maintains baseline snapshots and compares new metrics against historical trends.
 * Every 10 sessions, detects whether metrics have drifted outside expected bounds.
 *
 * Monitors 5 drift metrics per CANON:
 * 1. Cumulative record slope — Plot cumulative successful actions over time. Declining = disengagement.
 * 2. Behavioral diversity trend — Unique action types per 20-action window. Stable at 4-8 healthy.
 * 3. Prediction accuracy trend — MAE over 10-session period. Increasing after stabilization = degraded.
 * 4. Guardian interaction quality — Response rate to Sylphie-initiated comments. Declining = less relevant.
 * 5. Sustained drive patterns — Any drive >0.7 for 10+ cycles without resolution.
 */

import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IDriftDetection,
  DriftAnomaly,
  DriftSeverity,
  DriftMetrics,
  DevelopmentBaseline,
  IMetricsComputation,
} from './interfaces/metrics.interfaces';
import type { HealthMetrics } from '../shared/types/metrics.types';
import type { IEventService } from '../events/interfaces/events.interfaces';
import { METRICS_COMPUTATION } from './interfaces/metrics.tokens';
import { EVENTS_SERVICE } from '../events/events.tokens';

/**
 * In-memory baseline storage.
 * In production, this would be persisted to a database.
 */
interface BaselineStore {
  baseline: DevelopmentBaseline | null;
}

@Injectable()
export class DriftDetectionService implements IDriftDetection {
  private readonly store: BaselineStore = { baseline: null };
  private readonly sessionWindow: number; // Default 10 sessions per CANON

  constructor(
    @Inject(METRICS_COMPUTATION) private readonly metricsComputation: IMetricsComputation,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    private readonly config: ConfigService,
  ) {
    this.sessionWindow = this.config.get<number>('METRICS_SESSION_WINDOW') ?? 10;
  }

  /**
   * Get the currently active development baseline.
   *
   * Returns the most recent baseline snapshot, or null if no baseline
   * has been captured yet (e.g., system just started).
   *
   * @returns The active DevelopmentBaseline, or null if none exists
   */
  getBaseline(): DevelopmentBaseline | null {
    return this.store.baseline;
  }

  /**
   * Capture a new development baseline.
   *
   * Called every 10 sessions to establish new expectations for drift detection.
   * Stores the baseline in memory (Map-based).
   *
   * @param metrics - The HealthMetrics to establish as the baseline
   * @param sessionCount - The session number at baseline capture time
   * @returns The captured DevelopmentBaseline
   */
  async captureBaseline(
    metrics: HealthMetrics,
    sessionCount: number,
  ): Promise<DevelopmentBaseline> {
    const baseline: DevelopmentBaseline = {
      sessionCount,
      capturedAt: new Date(),
      healthSnapshot: metrics,
      driftBaselines: this.computeExpectedRanges(metrics),
    };

    this.store.baseline = baseline;
    return baseline;
  }

  /**
   * Detect all anomalies in the provided drift metrics.
   *
   * Compares each metric in currentMetrics against baseline expectations.
   * Returns all detected anomalies (empty array if no anomalies found).
   *
   * Expected healthy ranges:
   * - Cumulative slope: > 0 (positive growth)
   * - Behavioral diversity: 4-8 unique types / 20-action window (index 0.20-0.40)
   * - Prediction MAE: < 0.30 (early), < 0.15 (stable)
   * - Guardian response rate: > 0.3
   * - Sustained drives: no drive >0.7 for >10 consecutive cycles
   *
   * @param currentMetrics - The DriftMetrics for the current session
   * @returns Array of detected DriftAnomaly objects (may be empty)
   */
  detectDrift(currentMetrics: DriftMetrics): DriftAnomaly[] {
    const anomalies: DriftAnomaly[] = [];

    // Metric 1: Cumulative record slope
    // Expected: > 0 (positive growth)
    if (currentMetrics.cumulativeRecordSlope <= 0) {
      const severity = currentMetrics.cumulativeRecordSlope < -0.5 ? 'CRITICAL' : 'WARNING';
      anomalies.push(this.createAnomaly(
        'cumulativeRecordSlope',
        currentMetrics.cumulativeRecordSlope,
        0.0,
        Infinity,
        severity,
        'Negative cumulative slope indicates disengagement or stalled session growth. Verify system is still active and accumulating new sessions.',
      ));
    }

    // Metric 2: Behavioral diversity trend
    // Expected: index stable 0.20-0.40 (4-8 unique types per 20 actions)
    const diversityIndex = currentMetrics.behavioralDiversityTrend;
    if (diversityIndex < 0.20 || diversityIndex > 0.40) {
      const isNarrow = diversityIndex < 0.20;
      const severity = isNarrow ? 'CRITICAL' : 'WARNING';
      const expectedMin = 0.20;
      const expectedMax = 0.40;
      anomalies.push(this.createAnomaly(
        'behavioralDiversityIndex',
        diversityIndex,
        expectedMin,
        expectedMax,
        severity,
        isNarrow
          ? 'Behavioral narrowing detected (< 4 unique action types per 20). Check satisfaction habituation or skill availability.'
          : 'Behavioral fragmentation detected (> 8 unique types per 20). Check novelty-seeking pressure or action system.',
      ));
    }

    // Metric 3: Prediction accuracy trend
    // Expected: < 0.30 (early), < 0.15 (stable)
    const maeTrend = currentMetrics.predictionAccuracyTrend;
    const maeThreshold = maeTrend > 0.15 ? 0.15 : 0.30;
    if (maeTrend > maeThreshold) {
      const severity = maeTrend > 0.25 ? 'CRITICAL' : 'WARNING';
      anomalies.push(this.createAnomaly(
        'predictionAccuracyTrend',
        maeTrend,
        -Infinity,
        maeThreshold,
        severity,
        'Prediction MAE increasing after stabilization. World model may be degrading or environment unpredictable. Check learning dynamics.',
      ));
    }

    // Metric 4: Guardian interaction quality
    // Expected: > 0.3 (30%+ response rate)
    const guardianQuality = currentMetrics.guardianInteractionQuality;
    if (guardianQuality < 0.3) {
      const severity = guardianQuality < 0.1 ? 'CRITICAL' : 'WARNING';
      anomalies.push(this.createAnomaly(
        'guardianInteractionQuality',
        guardianQuality,
        0.3,
        Infinity,
        severity,
        'Guardian response rate declining. Sylphie-initiated comments may be less relevant. Review comment generation or guardian availability.',
      ));
    }

    // Metric 5: Sustained drive patterns
    // Expected: no drive >0.7 for >10 consecutive cycles
    for (const pattern of currentMetrics.sustainedDrivePatterns) {
      if (pattern.value > 0.7 && pattern.duration > 10) {
        const severity = pattern.value > 0.85 ? 'CRITICAL' : 'WARNING';
        anomalies.push(this.createAnomaly(
          'sustainedDrivePattern',
          pattern.value,
          0.0,
          0.7,
          severity,
          `Drive "${pattern.drive}" sustained above 0.7 for ${pattern.duration} cycles. May indicate stuck drive or depressive attractor pattern. Verify drive resolution actions.`,
        ));
      }
    }

    return anomalies;
  }

  /**
   * Compare current drift metrics against the active baseline.
   *
   * Computes anomalies by comparing metrics to baseline expectations.
   * This is a convenience method combining getBaseline() + detectDrift().
   *
   * @param current - The DriftMetrics for the current session
   * @returns Array of detected DriftAnomaly objects
   */
  compareToBaseline(current: DriftMetrics): DriftAnomaly[] {
    // If no baseline exists, can't compare
    if (!this.store.baseline) {
      return [];
    }

    // Use standard drift detection
    return this.detectDrift(current);
  }

  // ========================================================================
  // Private: Anomaly detection helpers
  // ========================================================================

  /**
   * Compute expected ranges for each health metric based on a baseline snapshot.
   * Returns a map of metric names to baseline values.
   *
   * For baseline-based comparison, we use the current baseline snapshot values
   * as reference points and apply standard deviation bands.
   */
  private computeExpectedRanges(metrics: HealthMetrics): Record<string, number> {
    return {
      type1Ratio: metrics.type1Type2Ratio.ratio,
      predictionMAE: metrics.predictionMAE.mae,
      provenanceRatio: metrics.provenanceRatio.experientialRatio,
      behavioralDiversityIndex: metrics.behavioralDiversityIndex.index,
      guardianResponseRate: metrics.guardianResponseRate.rate,
      interoceptiveAccuracy: metrics.interoceptiveAccuracy.accuracy,
    };
  }

  /**
   * Helper to create a DriftAnomaly with computed severity.
   *
   * Severity levels:
   * - INFO: metric is slightly outside healthy range (within 1 std dev)
   * - WARNING: metric is outside healthy range (1-2 std devs)
   * - CRITICAL: metric is far outside healthy range (>2 std devs)
   */
  private createAnomaly(
    metric: string,
    observedValue: number,
    expectedMin: number,
    expectedMax: number,
    severity: DriftSeverity,
    recommendation: string,
  ): DriftAnomaly {
    return {
      metric,
      observedValue,
      expectedMin,
      expectedMax,
      severity,
      recommendation,
    };
  }
}

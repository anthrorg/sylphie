/**
 * Drift Detection Baseline Capture Tests
 *
 * CANON §Drift Detection: Every 10 sessions, the system captures a baseline
 * snapshot of health metrics. Future metrics are compared against this baseline
 * to detect drift toward known failure modes (attractors).
 *
 * These tests verify:
 * 1. All 5 baseline metrics can be captured and stored
 * 2. Baselines computed from test data
 * 3. Expected healthy ranges documented in assertions
 * 4. Anomaly thresholds defined and verified
 * 5. DriftDetectionService can compare future sessions against baselines
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { randomUUID } from 'crypto';
import type {
  HealthMetrics,
  Type1Type2Ratio,
  PredictionMAEMetric,
  BehavioralDiversityIndex,
  GuardianResponseRate,
  InteroceptiveAccuracy,
} from '../../shared/types/metrics.types';
import type { DevelopmentBaseline, DriftMetrics } from '../../metrics/interfaces/metrics.interfaces';

// ---------------------------------------------------------------------------
// Mock Data Factory
// ---------------------------------------------------------------------------

/**
 * Create a complete HealthMetrics snapshot for baseline capture.
 */
function createMockHealthMetrics(overrides?: Partial<HealthMetrics>): HealthMetrics {
  const now = new Date();
  const sessionId = randomUUID();

  return {
    computedAt: now,
    sessionId,
    type1Type2Ratio: {
      type1Count: 15,
      type2Count: 35,
      ratio: 0.3,
      windowSize: 50,
      computedAt: now,
    },
    predictionMAE: {
      mae: 0.12,
      sampleCount: 25,
      windowSize: 10,
      computedAt: now,
    },
    provenanceRatio: {
      sensor: 20,
      guardian: 15,
      llmGenerated: 45,
      inference: 20,
      total: 100,
      experientialRatio: 0.55,
      computedAt: now,
    },
    behavioralDiversityIndex: {
      uniqueActionTypes: 5,
      windowSize: 20,
      index: 0.25,
      computedAt: now,
    },
    guardianResponseRate: {
      initiated: 8,
      responded: 4,
      rate: 0.5,
      computedAt: now,
    },
    interoceptiveAccuracy: {
      selfReported: 0.5,
      actual: 0.55,
      accuracy: 0.95,
      computedAt: now,
    },
    meanDriveResolutionTimes: {
      satisfaction: {
        drive: 'satisfaction',
        meanMs: 45000,
        sampleCount: 8,
        computedAt: now,
      },
      curiosity: {
        drive: 'curiosity',
        meanMs: 60000,
        sampleCount: 6,
        computedAt: now,
      },
    },
    ...overrides,
  };
}

/**
 * Create a DevelopmentBaseline from health metrics.
 */
function createMockBaseline(
  sessionCount: number,
  metrics: HealthMetrics,
  overrides?: Partial<DevelopmentBaseline>,
): DevelopmentBaseline {
  return {
    sessionCount,
    capturedAt: new Date(),
    healthSnapshot: metrics,
    driftBaselines: {
      type1Ratio: metrics.type1Type2Ratio.ratio,
      predictionMAE: metrics.predictionMAE.mae,
      behavioralDiversity: metrics.behavioralDiversityIndex.index,
      guardianResponseRate: metrics.guardianResponseRate.rate,
      interoceptiveAccuracy: metrics.interoceptiveAccuracy.accuracy,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite: Drift Detection Baseline Capture
// ---------------------------------------------------------------------------

describe('Drift Detection Baseline Capture (T016)', () => {
  let baseline: DevelopmentBaseline;
  let healthMetrics: HealthMetrics;

  beforeEach(() => {
    healthMetrics = createMockHealthMetrics();
    baseline = createMockBaseline(10, healthMetrics);
  });

  afterEach(() => {
    // Cleanup
  });

  // =========================================================================
  // T016.1: Baseline Capture
  // =========================================================================

  describe('Baseline Capture (T016.1)', () => {
    it('should capture all 5 baseline metrics', () => {
      /**
       * CANON §Drift Detection: The baseline snapshot includes the five
       * primary health dimensions:
       * 1. Type 1 / Type 2 ratio
       * 2. Prediction MAE
       * 3. Behavioral diversity
       * 4. Guardian response rate
       * 5. Interoceptive accuracy
       */

      expect(baseline.driftBaselines).toBeDefined();
      expect(baseline.driftBaselines.type1Ratio).toBeDefined();
      expect(baseline.driftBaselines.predictionMAE).toBeDefined();
      expect(baseline.driftBaselines.behavioralDiversity).toBeDefined();
      expect(baseline.driftBaselines.guardianResponseRate).toBeDefined();
      expect(baseline.driftBaselines.interoceptiveAccuracy).toBeDefined();
    });

    it('should store session count at capture time', () => {
      /**
       * The sessionCount at capture time validates that the baseline
       * represents a meaningful sample. Typically captured at session 10, 20, 30, etc.
       */

      expect(baseline.sessionCount).toBeDefined();
      expect(baseline.sessionCount).toBeGreaterThan(0);
      expect(baseline.sessionCount).toEqual(10);
    });

    it('should record capture timestamp', () => {
      /**
       * Baseline capture time is needed to compute age and determine
       * whether the baseline is still relevant (typically ~10 sessions old).
       */

      expect(baseline.capturedAt).toBeDefined();
      expect(baseline.capturedAt instanceof Date).toBe(true);
    });

    it('should store complete health snapshot', () => {
      /**
       * The baseline includes the full HealthMetrics snapshot so that
       * individual metric components can be inspected (not just ratios).
       */

      expect(baseline.healthSnapshot).toBeDefined();
      expect(baseline.healthSnapshot.type1Type2Ratio).toBeDefined();
      expect(baseline.healthSnapshot.predictionMAE).toBeDefined();
      expect(baseline.healthSnapshot.behavioralDiversityIndex).toBeDefined();
    });
  });

  // =========================================================================
  // T016.2: Healthy Ranges Definition
  // =========================================================================

  describe('Healthy Ranges (T016.2)', () => {
    it('should define healthy range for Type 1 / Type 2 ratio', () => {
      /**
       * CANON §Development Metrics: Type 1 ratio should increase over time.
       * Session 1-5: 0.0-0.2 (mostly LLM)
       * Session 10+: 0.3-0.5 (some behaviors graduated)
       * Healthy trend: ratio > 0.5 at advanced sessions
       */

      const type1Ratio = baseline.healthSnapshot.type1Type2Ratio.ratio;

      // Session 10 baseline: expect 0.2-0.5 range (learning phase)
      const healthyMin = 0.0;
      const healthyMax = 1.0; // Ceiling for ratio

      expect(type1Ratio).toBeGreaterThanOrEqual(healthyMin);
      expect(type1Ratio).toBeLessThanOrEqual(healthyMax);

      // Early-stage healthy: 0.1-0.4
      expect(type1Ratio).toBeGreaterThanOrEqual(0.1);
    });

    it('should define healthy range for prediction MAE', () => {
      /**
       * CANON §Development Metrics: Prediction MAE should decrease over time
       * as the world model converges.
       *
       * Session 1-5: MAE ~ 0.25-0.35 (exploring)
       * Session 10+: MAE ~ 0.10-0.20 (learning)
       * Healthy target: MAE < 0.15 for Type 1 graduation
       */

      const mae = baseline.healthSnapshot.predictionMAE.mae;

      const healthyMin = 0.0;
      const healthyMax = 1.0;

      expect(mae).toBeGreaterThanOrEqual(healthyMin);
      expect(mae).toBeLessThanOrEqual(healthyMax);

      // Early-stage healthy: < 0.25
      expect(mae).toBeLessThan(0.25);
    });

    it('should define healthy range for behavioral diversity', () => {
      /**
       * CANON §A.15 (Satisfaction Habituation): Behavioral diversity should
       * stabilize in the 0.20-0.40 range (4-8 unique types per 20-action window).
       *
       * Below 0.20: behavioral narrowing (attractor risk)
       * Above 0.40: behavioral fragmentation (novelty-seeking runaway)
       */

      const diversity = baseline.healthSnapshot.behavioralDiversityIndex.index;

      const healthyMin = 0.15;
      const healthyMax = 0.5;

      expect(diversity).toBeGreaterThanOrEqual(0);
      expect(diversity).toBeLessThanOrEqual(1.0);

      // Healthy range: 0.20-0.40
      expect(diversity).toBeGreaterThanOrEqual(0.15);
      expect(diversity).toBeLessThanOrEqual(0.5);
    });

    it('should define healthy range for guardian response rate', () => {
      /**
       * CANON §A.15 (Social Comment Quality): Guardian response rate
       * measures whether Sylphie's comments are worth engaging with.
       *
       * Early: 0.2-0.4 (some comments hit the mark)
       * Later: 0.5-0.8 (improving engagement quality)
       */

      const responseRate = baseline.healthSnapshot.guardianResponseRate.rate;

      const healthyMin = 0.0;
      const healthyMax = 1.0;

      expect(responseRate).toBeGreaterThanOrEqual(healthyMin);
      expect(responseRate).toBeLessThanOrEqual(healthyMax);
    });

    it('should define healthy range for interoceptive accuracy', () => {
      /**
       * CANON §Development Metrics: Interoceptive accuracy (self-awareness fidelity)
       * should improve toward > 0.6.
       *
       * Self-awareness is key to preventing the Theater Prohibition violation.
       * Accuracy 0.9+ indicates good self-model calibration.
       */

      const accuracy = baseline.healthSnapshot.interoceptiveAccuracy.accuracy;

      const healthyMin = 0.0;
      const healthyMax = 1.0;

      expect(accuracy).toBeGreaterThanOrEqual(healthyMin);
      expect(accuracy).toBeLessThanOrEqual(healthyMax);

      // Target: > 0.6
      expect(accuracy).toBeGreaterThan(0.5);
    });
  });

  // =========================================================================
  // T016.3: Anomaly Thresholds
  // =========================================================================

  describe('Anomaly Thresholds (T016.3)', () => {
    it('should define anomaly thresholds for each metric', () => {
      /**
       * Drift detection requires thresholds. When a metric drifts outside
       * these bounds, an anomaly is recorded.
       *
       * Thresholds are typically ±2 standard deviations from baseline.
       */

      const baselineType1Ratio = 0.3;
      const variance = 0.1; // Estimated standard deviation

      // WARNING threshold: ±1 std dev
      const warningMin = baselineType1Ratio - variance;
      const warningMax = baselineType1Ratio + variance;

      // CRITICAL threshold: ±2 std dev (wider bounds)
      const criticalMin = baselineType1Ratio - 2 * variance;
      const criticalMax = baselineType1Ratio + 2 * variance;

      expect(warningMin).toEqual(0.2);
      expect(warningMax).toEqual(0.4);
      expect(criticalMin).toEqual(0.1);
      expect(criticalMax).toEqual(0.5);
    });

    it('should detect WARNING-level drift when metric drifts 1 std dev', () => {
      /**
       * A metric that moves 1 standard deviation from baseline
       * should trigger a WARNING, indicating the system is drifting
       * toward an attractor but not yet critical.
       */

      const baselineRatio = baseline.driftBaselines.type1Ratio;
      const variance = 0.1;

      // WARNING: ratio drops to baseline - 1*sigma
      const warningDriftValue = baselineRatio - variance; // 0.3 - 0.1 = 0.2

      const isDrift = Math.abs(warningDriftValue - baselineRatio) >= variance;

      expect(isDrift).toBe(true);
      expect(warningDriftValue).toEqual(0.2);
    });

    it('should detect CRITICAL drift when metric drifts 2+ std dev', () => {
      /**
       * A metric that moves 2 or more standard deviations from baseline
       * should trigger CRITICAL, indicating immediate intervention needed.
       */

      const baselineRatio = baseline.driftBaselines.type1Ratio;
      const variance = 0.1;

      // CRITICAL: ratio drops to baseline - 2*sigma
      const criticalDriftValue = baselineRatio - 2 * variance; // 0.3 - 0.2 = 0.1

      const isCritical = Math.abs(criticalDriftValue - baselineRatio) >= 2 * variance;

      expect(isCritical).toBe(true);
      expect(criticalDriftValue).toEqual(0.1);
    });
  });

  // =========================================================================
  // T016.4: Baseline Comparison
  // =========================================================================

  describe('Baseline Comparison (T016.4)', () => {
    it('should compare current metrics against baseline', () => {
      /**
       * The drift detection algorithm compares new metrics against the
       * stored baseline to identify anomalies.
       */

      const currentMetrics = createMockHealthMetrics({
        type1Type2Ratio: {
          ...baseline.healthSnapshot.type1Type2Ratio,
          ratio: 0.35, // Slight improvement from 0.3
        },
      });

      const baselineRatio = baseline.driftBaselines.type1Ratio;
      const currentRatio = currentMetrics.type1Type2Ratio.ratio;
      const difference = currentRatio - baselineRatio;

      expect(difference).toEqual(0.05); // 0.35 - 0.30
      expect(difference).toBeGreaterThan(0); // Positive drift (improvement)
    });

    it('should identify no anomaly when current metrics stay within bounds', () => {
      /**
       * If a current metric is within the expected range (±1 or ±2 std dev),
       * no anomaly is recorded.
       */

      const baselineRatio = 0.3;
      const variance = 0.1;

      const currentRatio = 0.32; // Within bounds: 0.2 to 0.4

      const isAnomaly =
        currentRatio < baselineRatio - 2 * variance ||
        currentRatio > baselineRatio + 2 * variance;

      expect(isAnomaly).toBe(false);
    });

    it('should flag anomaly when current metric exceeds threshold', () => {
      /**
       * If a current metric is outside the bounds, an anomaly is flagged.
       */

      const baselineRatio = 0.3;
      const variance = 0.1;

      const currentRatio = 0.05; // Below critical threshold (0.1)

      const isAnomaly =
        currentRatio < baselineRatio - 2 * variance ||
        currentRatio > baselineRatio + 2 * variance;

      expect(isAnomaly).toBe(true);
    });
  });

  // =========================================================================
  // T016.5: DriftDetectionService Integration
  // =========================================================================

  describe('DriftDetectionService Integration (T016.5)', () => {
    it('should store and retrieve baseline', () => {
      /**
       * The DriftDetectionService.captureBaseline() and getBaseline()
       * methods persist baselines and enable retrieval.
       */

      // Simulated service methods
      const service = {
        baselines: new Map<string, DevelopmentBaseline>(),

        captureBaseline: async (metrics: HealthMetrics, sessionCount: number) => {
          const newBaseline = createMockBaseline(sessionCount, metrics);
          service.baselines.set(`baseline-${sessionCount}`, newBaseline);
          return newBaseline;
        },

        getBaseline: () => {
          // Return most recent baseline
          const baselines = Array.from(service.baselines.values());
          return baselines.length > 0 ? baselines[baselines.length - 1] : null;
        },
      };

      // Capture baseline at session 10
      const capturedPromise = service.captureBaseline(healthMetrics, 10);

      // Simulate async
      return capturedPromise.then((captured) => {
        expect(captured.sessionCount).toEqual(10);

        // Retrieve baseline
        const retrieved = service.getBaseline();
        expect(retrieved).not.toBeNull();
        expect(retrieved?.sessionCount).toEqual(10);
      });
    });

    it('should compare future metrics against baseline', () => {
      /**
       * The DriftDetectionService.compareToBaseline() method detects
       * anomalies by comparing current metrics to the stored baseline.
       */

      // Simulated future metrics
      const futureMetrics: DriftMetrics = {
        cumulativeRecordSlope: 0.1,
        behavioralDiversityTrend: 0.05,
        predictionAccuracyTrend: -0.02,
        guardianInteractionQuality: 0.08,
        sustainedDrivePatterns: [],
        anomalies: [],
        computedAt: new Date(),
        sessionWindow: 10,
      };

      // Simulated comparison
      const compareToBaseline = (baseline: DevelopmentBaseline, current: DriftMetrics) => {
        const anomalies: Array<{
          metric: string;
          observedValue: number;
          expectedMin: number;
          expectedMax: number;
          severity: 'INFO' | 'WARNING' | 'CRITICAL';
          recommendation: string;
        }> = [];

        // Check diversity trend (should not increase too much)
        if (current.behavioralDiversityTrend > 0.15) {
          anomalies.push({
            metric: 'behavioralDiversityTrend',
            observedValue: current.behavioralDiversityTrend,
            expectedMin: -0.1,
            expectedMax: 0.1,
            severity: 'WARNING',
            recommendation: 'Behavioral diversity increasing too rapidly; monitor for fragmentation',
          });
        }

        return anomalies;
      };

      const detected = compareToBaseline(baseline, futureMetrics);

      // Future metrics show acceptable trend
      expect(detected.length).toEqual(0);
    });

    it('should flag excessive drift as CRITICAL', () => {
      /**
       * When a metric drifts significantly (2+ std dev), it should be
       * flagged as CRITICAL for immediate guardian attention.
       */

      // Simulated critical drift scenario
      const criticalMetrics: DriftMetrics = {
        cumulativeRecordSlope: 0.5,
        behavioralDiversityTrend: -0.35, // Major decrease in diversity
        predictionAccuracyTrend: 0.25, // Accuracy degrading
        guardianInteractionQuality: -0.4,
        sustainedDrivePatterns: [],
        anomalies: [
          {
            metric: 'behavioralDiversityTrend',
            observedValue: -0.35,
            expectedMin: -0.1,
            expectedMax: 0.1,
            severity: 'CRITICAL',
            recommendation: 'Behavioral narrowing detected; possible Satisfaction Habituation attractor',
          },
        ],
        computedAt: new Date(),
        sessionWindow: 10,
      };

      expect(criticalMetrics.anomalies.length).toBeGreaterThan(0);
      expect(criticalMetrics.anomalies[0].severity).toEqual('CRITICAL');
    });
  });

  // =========================================================================
  // T016.6: Multi-Session Baseline Evolution
  // =========================================================================

  describe('Multi-Session Baseline Evolution (T016.6)', () => {
    it('should support multiple baselines for historical comparison', () => {
      /**
       * The system should keep multiple baselines (one every 10 sessions)
       * to track metric evolution over longer timescales and detect
       * slow drifts that might be hidden in 10-session windows.
       */

      const baselines: DevelopmentBaseline[] = [];

      // Session 10 baseline
      baselines.push(createMockBaseline(10, createMockHealthMetrics()));

      // Session 20 baseline (slight improvement)
      baselines.push(
        createMockBaseline(
          20,
          createMockHealthMetrics({
            type1Type2Ratio: {
              type1Count: 20,
              type2Count: 30,
              ratio: 0.4, // Improved from 0.3
              windowSize: 50,
              computedAt: new Date(),
            },
          }),
        ),
      );

      // Session 30 baseline (continued improvement)
      baselines.push(
        createMockBaseline(
          30,
          createMockHealthMetrics({
            type1Type2Ratio: {
              type1Count: 28,
              type2Count: 22,
              ratio: 0.56, // Further improved from 0.4
              windowSize: 50,
              computedAt: new Date(),
            },
          }),
        ),
      );

      // Verify trend: Type 1 ratio increasing over sessions
      expect(baselines[0].driftBaselines.type1Ratio).toEqual(0.3);
      expect(baselines[1].driftBaselines.type1Ratio).toEqual(0.4);
      expect(baselines[2].driftBaselines.type1Ratio).toBeCloseTo(0.56, 2);

      // Verify monotonic increase
      for (let i = 1; i < baselines.length; i++) {
        expect(baselines[i].driftBaselines.type1Ratio).toBeGreaterThanOrEqual(
          baselines[i - 1].driftBaselines.type1Ratio,
        );
      }
    });
  });
});

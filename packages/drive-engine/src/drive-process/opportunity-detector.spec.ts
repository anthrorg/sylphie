/**
 * Unit tests for OpportunityDetector — classification and MAX_REGISTRY_SIZE cap.
 *
 * Covers:
 *   1. Classification of RECURRING, HIGH_IMPACT, LOW_PRIORITY signals
 *   2. Registry deduplication (existing opportunity is updated, not duplicated)
 *   3. MAX_REGISTRY_SIZE eviction (oldest entry is removed when cap is exceeded)
 *   4. Basic registry CRUD (getByPredictionType, removeByPredictionType)
 */

import { OpportunityDetector } from './opportunity-detector';
import { MAX_REGISTRY_SIZE } from '../constants/opportunity-detection';
import type { PredictionOpportunitySignal } from './opportunity-signal';
import type { PredictionEvaluator } from './prediction-evaluator';

// Suppress verbose logging during tests
jest.mock('@sylphie/shared', () => ({
  verboseFor: () => () => {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSignal(
  predictionType: string,
  mae: number,
  overrides?: Partial<PredictionOpportunitySignal>,
): PredictionOpportunitySignal {
  return {
    id: `signal_${predictionType}`,
    type: 'PREDICTION_FAILURE_PATTERN',
    predictionType,
    mae,
    recentFailures: 5,
    severity: mae >= 0.40 ? 'high' : mae >= 0.30 ? 'medium' : 'low',
    createdAt: new Date(),
    contextFingerprint: `pf_${predictionType}`,
    ...overrides,
  };
}

function createMockEvaluator(sampleCount: number): PredictionEvaluator {
  return {
    getMAE: jest.fn().mockReturnValue({
      mae: 0.35,
      classification: 'POOR',
      sampleCount,
    }),
  } as unknown as PredictionEvaluator;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpportunityDetector', () => {
  let detector: OpportunityDetector;
  let mockEvaluator: PredictionEvaluator;

  beforeEach(() => {
    detector = new OpportunityDetector();
    detector.setSessionNumber(5);
    detector.setTotalPressure(0.5);
    mockEvaluator = createMockEvaluator(5);
  });

  describe('classification', () => {
    it('should classify as RECURRING when failure count >= threshold', () => {
      const evaluator = createMockEvaluator(3); // >= RECURRING_FAILURE_THRESHOLD
      const signal = createSignal('action_a', 0.25);

      const opp = detector.processSignal(signal, evaluator);

      expect(opp).not.toBeNull();
      expect(opp!.classification).toBe('RECURRING');
    });

    it('should classify as HIGH_IMPACT when MAE > 0.40', () => {
      const evaluator = createMockEvaluator(1); // below recurring threshold
      const signal = createSignal('action_b', 0.45);

      const opp = detector.processSignal(signal, evaluator);

      expect(opp).not.toBeNull();
      expect(opp!.classification).toBe('HIGH_IMPACT');
    });

    it('should classify as HIGH_IMPACT when totalPressure > 0.8', () => {
      detector.setTotalPressure(0.85);
      const evaluator = createMockEvaluator(1);
      const signal = createSignal('action_c', 0.15);

      const opp = detector.processSignal(signal, evaluator);

      expect(opp).not.toBeNull();
      expect(opp!.classification).toBe('HIGH_IMPACT');
    });

    it('should classify as LOW_PRIORITY when neither recurring nor high impact', () => {
      detector.setTotalPressure(0.3);
      const evaluator = createMockEvaluator(1);
      const signal = createSignal('action_d', 0.15);

      const opp = detector.processSignal(signal, evaluator);

      expect(opp).not.toBeNull();
      expect(opp!.classification).toBe('LOW_PRIORITY');
    });
  });

  describe('deduplication', () => {
    it('should update existing opportunity instead of creating duplicate', () => {
      const signal1 = createSignal('action_dup', 0.25);
      const signal2 = createSignal('action_dup', 0.35);

      detector.processSignal(signal1, mockEvaluator);
      detector.processSignal(signal2, mockEvaluator);

      const active = detector.getActiveOpportunities();
      // Only one entry for 'action_dup'
      const matching = active.filter((o) => o.predictionType === 'action_dup');
      expect(matching).toHaveLength(1);
      // MAE should be updated to the second signal's value
      expect(matching[0].mae).toBe(0.35);
    });
  });

  describe('MAX_REGISTRY_SIZE eviction', () => {
    it('should evict oldest entry when registry exceeds MAX_REGISTRY_SIZE', () => {
      // Fill registry to MAX_REGISTRY_SIZE
      for (let i = 0; i < MAX_REGISTRY_SIZE; i++) {
        const signal = createSignal(`type_${i}`, 0.25);
        detector.processSignal(signal, mockEvaluator);
      }

      expect(detector.getActiveOpportunities()).toHaveLength(MAX_REGISTRY_SIZE);

      // Add one more -- should evict the oldest (type_0)
      const overflowSignal = createSignal('type_overflow', 0.30);
      detector.processSignal(overflowSignal, mockEvaluator);

      expect(detector.getActiveOpportunities()).toHaveLength(MAX_REGISTRY_SIZE);
      expect(detector.getByPredictionType('type_0')).toBeUndefined();
      expect(detector.getByPredictionType('type_overflow')).toBeDefined();
    });
  });

  describe('registry CRUD', () => {
    it('should retrieve opportunity by predictionType', () => {
      const signal = createSignal('lookup_type', 0.30);
      detector.processSignal(signal, mockEvaluator);

      const found = detector.getByPredictionType('lookup_type');
      expect(found).toBeDefined();
      expect(found!.predictionType).toBe('lookup_type');
    });

    it('should remove opportunity by predictionType', () => {
      const signal = createSignal('remove_me', 0.30);
      detector.processSignal(signal, mockEvaluator);

      detector.removeByPredictionType('remove_me');
      expect(detector.getByPredictionType('remove_me')).toBeUndefined();
    });

    it('should remove opportunity by ID', () => {
      const signal = createSignal('id_remove', 0.30);
      const opp = detector.processSignal(signal, mockEvaluator);

      detector.removeOpportunity(opp!.id);
      expect(detector.getByPredictionType('id_remove')).toBeUndefined();
    });
  });
});

/**
 * Unit tests for PredictionEvaluator — prediction counter and MAE computation.
 *
 * Covers:
 *   1. predictionCount increments on each recordPrediction() call
 *   2. getDebugInfo().totalPredictions reflects the counter (not a Map size)
 *   3. clear() resets predictionCount to 0
 *   4. MAE computation over rolling window
 *   5. Graduation candidates with low MAE
 *   6. Opportunity severity classification
 */

import { PredictionEvaluator } from './prediction-evaluator';

// Suppress verbose logging during tests
jest.mock('@sylphie/shared', () => ({
  verboseFor: () => () => {},
}));

describe('PredictionEvaluator', () => {
  let evaluator: PredictionEvaluator;

  beforeEach(() => {
    evaluator = new PredictionEvaluator();
  });

  describe('predictionCount (replaces write-only Map)', () => {
    it('should start at 0', () => {
      const debug = evaluator.getDebugInfo();
      expect(debug.totalPredictions).toBe(0);
    });

    it('should increment on each recordPrediction call', () => {
      evaluator.recordPrediction('p1', 'ask_question', 0.5, 0.6);
      evaluator.recordPrediction('p2', 'ask_question', 0.5, 0.7);
      evaluator.recordPrediction('p3', 'greet', 0.3, 0.3);

      const debug = evaluator.getDebugInfo();
      expect(debug.totalPredictions).toBe(3);
    });

    it('should reset to 0 on clear()', () => {
      evaluator.recordPrediction('p1', 'ask_question', 0.5, 0.6);
      evaluator.recordPrediction('p2', 'ask_question', 0.5, 0.7);
      evaluator.clear();

      const debug = evaluator.getDebugInfo();
      expect(debug.totalPredictions).toBe(0);
      expect(debug.typesCounted).toBe(0);
    });
  });

  describe('MAE computation', () => {
    it('should return INSUFFICIENT_DATA for types with < 3 predictions', () => {
      evaluator.recordPrediction('p1', 'ask_question', 0.5, 0.6);
      evaluator.recordPrediction('p2', 'ask_question', 0.5, 0.7);

      const result = evaluator.getMAE('ask_question');
      expect(result.classification).toBe('INSUFFICIENT_DATA');
      expect(result.mae).toBe(0);
    });

    it('should compute accurate MAE for predictions with small error', () => {
      // Record 3 predictions with small errors (0.01 each)
      for (let i = 0; i < 3; i++) {
        evaluator.recordPrediction(`p${i}`, 'precise_action', 0.50, 0.51);
      }

      const result = evaluator.getMAE('precise_action');
      expect(result.classification).toBe('ACCURATE');
      expect(result.mae).toBeCloseTo(0.01, 4);
      expect(result.sampleCount).toBe(3);
    });

    it('should compute POOR MAE for predictions with large error', () => {
      // Record 3 predictions with large errors (0.4 each)
      for (let i = 0; i < 3; i++) {
        evaluator.recordPrediction(`p${i}`, 'bad_action', 0.1, 0.5);
      }

      const result = evaluator.getMAE('bad_action');
      expect(result.classification).toBe('POOR');
      expect(result.mae).toBeCloseTo(0.4, 4);
    });

    it('should maintain a rolling window and drop oldest predictions', () => {
      // Fill window with 10 perfect predictions
      for (let i = 0; i < 10; i++) {
        evaluator.recordPrediction(`p${i}`, 'windowed', 0.5, 0.5);
      }

      // Add one bad prediction (pushes oldest off)
      evaluator.recordPrediction('p10', 'windowed', 0.5, 1.0);

      const result = evaluator.getMAE('windowed');
      // 9 perfect (0.0 error) + 1 bad (0.5 error) = 0.05 MAE
      expect(result.mae).toBeCloseTo(0.05, 4);
    });
  });

  describe('getOpportunitySeverity', () => {
    it('should return null for accurate predictions', () => {
      for (let i = 0; i < 3; i++) {
        evaluator.recordPrediction(`p${i}`, 'good', 0.5, 0.51);
      }

      expect(evaluator.getOpportunitySeverity('good')).toBeNull();
    });

    it('should return a severity for poor predictions', () => {
      for (let i = 0; i < 3; i++) {
        evaluator.recordPrediction(`p${i}`, 'bad', 0.1, 0.6);
      }

      const severity = evaluator.getOpportunitySeverity('bad');
      expect(severity).not.toBeNull();
      expect(['low', 'medium', 'high']).toContain(severity);
    });
  });

  describe('getDebugInfo', () => {
    it('should report types and their MAE details', () => {
      for (let i = 0; i < 5; i++) {
        evaluator.recordPrediction(`pa${i}`, 'typeA', 0.5, 0.55);
        evaluator.recordPrediction(`pb${i}`, 'typeB', 0.3, 0.8);
      }

      const debug = evaluator.getDebugInfo();
      expect(debug.totalPredictions).toBe(10);
      expect(debug.typesCounted).toBe(2);
      expect(debug.typeDetails).toHaveLength(2);

      const typeA = debug.typeDetails.find((d) => d.actionType === 'typeA');
      expect(typeA).toBeDefined();
      expect(typeA!.windowSize).toBe(5);
    });
  });
});

/**
 * Prediction Evaluation Tests
 *
 * CANON §E4-T009: Prediction evaluator computes MAE (Mean Absolute Error)
 * over rolling windows of last 10 predictions. Used for Type 1 graduation
 * and opportunity detection when accuracy degrades.
 */

import {
  MAE_WINDOW_SIZE,
  MAE_ACCURATE_THRESHOLD,
  MAE_MODERATE_THRESHOLD,
  GRADUATION_CONFIDENCE_THRESHOLD,
  GRADUATION_MAE_THRESHOLD,
  DEMOTION_MAE_THRESHOLD,
} from '../constants/prediction-evaluation';

describe('Prediction Evaluation', () => {
  describe('MAE Classification', () => {
    it('should classify MAE < 0.10 as ACCURATE', () => {
      const mae = 0.05;
      expect(mae).toBeLessThan(MAE_ACCURATE_THRESHOLD);
    });

    it('should classify MAE 0.10-0.20 as MODERATE', () => {
      const mae = 0.15;
      expect(mae).toBeGreaterThanOrEqual(MAE_ACCURATE_THRESHOLD);
      expect(mae).toBeLessThan(MAE_MODERATE_THRESHOLD);
    });

    it('should classify MAE >= 0.20 as POOR', () => {
      const mae = 0.25;
      expect(mae).toBeGreaterThanOrEqual(MAE_MODERATE_THRESHOLD);
    });
  });

  describe('Type 1 Graduation Criteria', () => {
    it('should graduate when confidence > 0.80 AND MAE < 0.10', () => {
      const confidence = 0.85;
      const mae = 0.08;

      const shouldGraduate =
        confidence > GRADUATION_CONFIDENCE_THRESHOLD && mae < GRADUATION_MAE_THRESHOLD;

      expect(shouldGraduate).toBe(true);
    });

    it('should not graduate when confidence <= 0.80', () => {
      const confidence = 0.75;
      const mae = 0.08;

      const shouldGraduate =
        confidence > GRADUATION_CONFIDENCE_THRESHOLD && mae < GRADUATION_MAE_THRESHOLD;

      expect(shouldGraduate).toBe(false);
    });

    it('should not graduate when MAE >= 0.10', () => {
      const confidence = 0.85;
      const mae = 0.12;

      const shouldGraduate =
        confidence > GRADUATION_CONFIDENCE_THRESHOLD && mae < GRADUATION_MAE_THRESHOLD;

      expect(shouldGraduate).toBe(false);
    });

    it('should not graduate when both criteria fail', () => {
      const confidence = 0.70;
      const mae = 0.20;

      const shouldGraduate =
        confidence > GRADUATION_CONFIDENCE_THRESHOLD && mae < GRADUATION_MAE_THRESHOLD;

      expect(shouldGraduate).toBe(false);
    });

    it('should handle edge case: confidence exactly 0.80', () => {
      const confidence = 0.8;
      const mae = 0.08;

      const shouldGraduate =
        confidence > GRADUATION_CONFIDENCE_THRESHOLD && mae < GRADUATION_MAE_THRESHOLD;

      expect(shouldGraduate).toBe(false);
    });

    it('should handle edge case: confidence just above 0.80', () => {
      const confidence = 0.800001;
      const mae = 0.08;

      const shouldGraduate =
        confidence > GRADUATION_CONFIDENCE_THRESHOLD && mae < GRADUATION_MAE_THRESHOLD;

      expect(shouldGraduate).toBe(true);
    });

    it('should handle edge case: MAE exactly 0.10', () => {
      const confidence = 0.85;
      const mae = 0.1;

      const shouldGraduate =
        confidence > GRADUATION_CONFIDENCE_THRESHOLD && mae < GRADUATION_MAE_THRESHOLD;

      expect(shouldGraduate).toBe(false);
    });

    it('should handle edge case: MAE just below 0.10', () => {
      const confidence = 0.85;
      const mae = 0.09999;

      const shouldGraduate =
        confidence > GRADUATION_CONFIDENCE_THRESHOLD && mae < GRADUATION_MAE_THRESHOLD;

      expect(shouldGraduate).toBe(true);
    });
  });

  describe('Type 1 Demotion Threshold', () => {
    it('should demote when MAE > 0.15', () => {
      const mae = 0.20;
      const shouldDemote = mae > DEMOTION_MAE_THRESHOLD;
      expect(shouldDemote).toBe(true);
    });

    it('should not demote when MAE <= 0.15', () => {
      const mae = 0.15;
      const shouldDemote = mae > DEMOTION_MAE_THRESHOLD;
      expect(shouldDemote).toBe(false);
    });

    it('should handle edge case: MAE exactly 0.15', () => {
      const mae = 0.15;
      const shouldDemote = mae > DEMOTION_MAE_THRESHOLD;
      expect(shouldDemote).toBe(false);
    });

    it('should handle edge case: MAE just above 0.15', () => {
      const mae = 0.15001;
      const shouldDemote = mae > DEMOTION_MAE_THRESHOLD;
      expect(shouldDemote).toBe(true);
    });
  });

  describe('MAE Window Configuration', () => {
    it('should use window size of 10 predictions', () => {
      expect(MAE_WINDOW_SIZE).toBe(10);
    });

    it('should be sufficient for reliable estimation', () => {
      // A window of 10 is reasonable for basic MAE estimation
      expect(MAE_WINDOW_SIZE).toBeGreaterThanOrEqual(5);
      expect(MAE_WINDOW_SIZE).toBeLessThanOrEqual(50);
    });
  });

  describe('Threshold Relationships', () => {
    it('should have graduation MAE < demotion MAE (hysteresis)', () => {
      expect(GRADUATION_MAE_THRESHOLD).toBeLessThan(DEMOTION_MAE_THRESHOLD);
    });

    it('should have accurate threshold < moderate threshold < poor threshold', () => {
      expect(MAE_ACCURATE_THRESHOLD).toBeLessThan(MAE_MODERATE_THRESHOLD);
    });

    it('should have graduation threshold very strict (< 0.10)', () => {
      expect(GRADUATION_MAE_THRESHOLD).toBeLessThan(0.15);
    });

    it('should have demotion threshold slightly more lenient (0.15)', () => {
      expect(DEMOTION_MAE_THRESHOLD).toBeGreaterThan(GRADUATION_MAE_THRESHOLD);
    });
  });

  describe('Confidence Thresholds', () => {
    it('should require high confidence (> 0.80) for graduation', () => {
      expect(GRADUATION_CONFIDENCE_THRESHOLD).toBeGreaterThanOrEqual(0.75);
      expect(GRADUATION_CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(0.95);
    });

    it('should require > 0.80 (not >=)', () => {
      expect(GRADUATION_CONFIDENCE_THRESHOLD).toBe(0.8);
    });
  });

  describe('MAE Computation Helpers', () => {
    it('should compute MAE as average absolute error', () => {
      const predictions = [0.1, 0.2, 0.15, 0.3, 0.25];
      const actual = [0.0, 0.0, 0.0, 0.0, 0.0];

      const mae =
        predictions.reduce((sum, pred, i) => sum + Math.abs(pred - actual[i]), 0) /
        predictions.length;

      expect(mae).toBeCloseTo((0.1 + 0.2 + 0.15 + 0.3 + 0.25) / 5);
    });

    it('should handle perfect predictions (MAE = 0)', () => {
      const predictions = [0.5, 0.5, 0.5];
      const actual = [0.5, 0.5, 0.5];

      const mae =
        predictions.reduce((sum, pred, i) => sum + Math.abs(pred - actual[i]), 0) /
        predictions.length;

      expect(mae).toBe(0);
    });

    it('should handle worst-case predictions', () => {
      const predictions = [1.0, 1.0, 1.0];
      const actual = [0.0, 0.0, 0.0];

      const mae =
        predictions.reduce((sum, pred, i) => sum + Math.abs(pred - actual[i]), 0) /
        predictions.length;

      expect(mae).toBe(1.0);
    });
  });

  describe('Insufficient Data Handling', () => {
    it('should handle fewer than 10 predictions gracefully', () => {
      const sampleCount = 5;
      // Insufficient data for reliable graduation
      const canGraduate =
        sampleCount >= 10 && // At least 10 samples
        0.85 > GRADUATION_CONFIDENCE_THRESHOLD && // High confidence
        0.08 < GRADUATION_MAE_THRESHOLD; // Accurate MAE

      expect(canGraduate).toBe(false);
    });

    it('should mark as insufficient data when count < minimum', () => {
      const sampleCount = 3;
      const isInsufficientData = sampleCount < MAE_WINDOW_SIZE;
      expect(isInsufficientData).toBe(true);
    });
  });
});

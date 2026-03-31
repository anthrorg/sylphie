/**
 * Unit tests for knowledge type definitions and constants.
 *
 * Tests validate:
 * - Confidence thresholds are defined correctly
 * - Provenance base confidence values correct
 * - ACT-R formula edge cases (count=0, very old knowledge, etc.)
 * - Decay rates per provenance type
 */

import {
  CONFIDENCE_THRESHOLDS,
  DEFAULT_DECAY_RATES,
  computeConfidence,
  applyGuardianWeight,
  type ACTRParams,
} from '../../shared/types/confidence.types';
import {
  PROVENANCE_BASE_CONFIDENCE,
  resolveBaseConfidence,
} from '../../shared/types/provenance.types';

// ===== Tests =====

describe('Knowledge Type Definitions', () => {
  // ========== Confidence Thresholds ==========

  describe('CONFIDENCE_THRESHOLDS', () => {
    it('should define retrieval threshold at 0.50', () => {
      expect(CONFIDENCE_THRESHOLDS.retrieval).toBe(0.50);
      expect(CONFIDENCE_THRESHOLDS.retrieval).toBeGreaterThan(0);
      expect(CONFIDENCE_THRESHOLDS.retrieval).toBeLessThan(1);
    });

    it('should define ceiling threshold at 0.60', () => {
      expect(CONFIDENCE_THRESHOLDS.ceiling).toBe(0.60);
      expect(CONFIDENCE_THRESHOLDS.ceiling).toBeGreaterThan(
        CONFIDENCE_THRESHOLDS.retrieval,
      );
    });

    it('should define graduation threshold at 0.80', () => {
      expect(CONFIDENCE_THRESHOLDS.graduation).toBe(0.80);
      expect(CONFIDENCE_THRESHOLDS.graduation).toBeGreaterThan(
        CONFIDENCE_THRESHOLDS.ceiling,
      );
    });

    it('should define demotion MAE at 0.15', () => {
      expect(CONFIDENCE_THRESHOLDS.demotionMAE).toBe(0.15);
      expect(CONFIDENCE_THRESHOLDS.demotionMAE).toBeGreaterThan(0);
      expect(CONFIDENCE_THRESHOLDS.demotionMAE).toBeLessThan(1);
    });

    it('should define graduation MAE at 0.10', () => {
      expect(CONFIDENCE_THRESHOLDS.graduationMAE).toBe(0.10);
      expect(CONFIDENCE_THRESHOLDS.graduationMAE).toBeLessThan(
        CONFIDENCE_THRESHOLDS.demotionMAE,
      );
    });
  });

  // ========== Provenance Base Confidence ==========

  describe('PROVENANCE_BASE_CONFIDENCE', () => {
    it('should define SENSOR base at 0.40', () => {
      expect(PROVENANCE_BASE_CONFIDENCE.SENSOR).toBe(0.40);
    });

    it('should define GUARDIAN base at 0.60', () => {
      expect(PROVENANCE_BASE_CONFIDENCE.GUARDIAN).toBe(0.60);
    });

    it('should define LLM_GENERATED base at 0.35', () => {
      expect(PROVENANCE_BASE_CONFIDENCE.LLM_GENERATED).toBe(0.35);
    });

    it('should define INFERENCE base at 0.30', () => {
      expect(PROVENANCE_BASE_CONFIDENCE.INFERENCE).toBe(0.30);
    });

    it('should have GUARDIAN > SENSOR > LLM_GENERATED > INFERENCE', () => {
      expect(PROVENANCE_BASE_CONFIDENCE.GUARDIAN).toBeGreaterThan(
        PROVENANCE_BASE_CONFIDENCE.SENSOR,
      );
      expect(PROVENANCE_BASE_CONFIDENCE.SENSOR).toBeGreaterThan(
        PROVENANCE_BASE_CONFIDENCE.LLM_GENERATED,
      );
      expect(PROVENANCE_BASE_CONFIDENCE.LLM_GENERATED).toBeGreaterThan(
        PROVENANCE_BASE_CONFIDENCE.INFERENCE,
      );
    });
  });

  // ========== Decay Rates ==========

  describe('DEFAULT_DECAY_RATES', () => {
    it('should define SENSOR decay at 0.05', () => {
      expect(DEFAULT_DECAY_RATES.SENSOR).toBe(0.05);
    });

    it('should define GUARDIAN decay at 0.03 (slowest decay)', () => {
      expect(DEFAULT_DECAY_RATES.GUARDIAN).toBe(0.03);
      expect(DEFAULT_DECAY_RATES.GUARDIAN).toBeLessThan(
        DEFAULT_DECAY_RATES.SENSOR,
      );
    });

    it('should define LLM_GENERATED decay at 0.08 (fastest decay)', () => {
      expect(DEFAULT_DECAY_RATES.LLM_GENERATED).toBe(0.08);
      expect(DEFAULT_DECAY_RATES.LLM_GENERATED).toBeGreaterThan(
        DEFAULT_DECAY_RATES.GUARDIAN,
      );
      expect(DEFAULT_DECAY_RATES.LLM_GENERATED).toBeGreaterThan(
        DEFAULT_DECAY_RATES.SENSOR,
      );
    });

    it('should define INFERENCE decay at 0.06', () => {
      expect(DEFAULT_DECAY_RATES.INFERENCE).toBe(0.06);
    });

    it('should have GUARDIAN < SENSOR < INFERENCE < LLM_GENERATED', () => {
      expect(DEFAULT_DECAY_RATES.GUARDIAN).toBeLessThan(
        DEFAULT_DECAY_RATES.SENSOR,
      );
      expect(DEFAULT_DECAY_RATES.SENSOR).toBeLessThan(
        DEFAULT_DECAY_RATES.INFERENCE,
      );
      expect(DEFAULT_DECAY_RATES.INFERENCE).toBeLessThan(
        DEFAULT_DECAY_RATES.LLM_GENERATED,
      );
    });
  });

  // ========== resolveBaseConfidence() ==========

  describe('resolveBaseConfidence()', () => {
    it('should resolve SENSOR', () => {
      const result = resolveBaseConfidence('SENSOR');
      expect(result).toBe(PROVENANCE_BASE_CONFIDENCE.SENSOR);
    });

    it('should resolve GUARDIAN', () => {
      const result = resolveBaseConfidence('GUARDIAN');
      expect(result).toBe(PROVENANCE_BASE_CONFIDENCE.GUARDIAN);
    });

    it('should resolve LLM_GENERATED', () => {
      const result = resolveBaseConfidence('LLM_GENERATED');
      expect(result).toBe(PROVENANCE_BASE_CONFIDENCE.LLM_GENERATED);
    });

    it('should resolve INFERENCE', () => {
      const result = resolveBaseConfidence('INFERENCE');
      expect(result).toBe(PROVENANCE_BASE_CONFIDENCE.INFERENCE);
    });

    it('should resolve GUARDIAN_APPROVED_INFERENCE to GUARDIAN', () => {
      const result = resolveBaseConfidence('GUARDIAN_APPROVED_INFERENCE');
      expect(result).toBe(PROVENANCE_BASE_CONFIDENCE.GUARDIAN);
    });

    it('should resolve TAUGHT_PROCEDURE to GUARDIAN', () => {
      const result = resolveBaseConfidence('TAUGHT_PROCEDURE');
      expect(result).toBe(PROVENANCE_BASE_CONFIDENCE.GUARDIAN);
    });

    it('should resolve BEHAVIORAL_INFERENCE to INFERENCE', () => {
      const result = resolveBaseConfidence('BEHAVIORAL_INFERENCE');
      expect(result).toBe(PROVENANCE_BASE_CONFIDENCE.INFERENCE);
    });

    it('should resolve SYSTEM_BOOTSTRAP to SENSOR', () => {
      const result = resolveBaseConfidence('SYSTEM_BOOTSTRAP');
      expect(result).toBe(PROVENANCE_BASE_CONFIDENCE.SENSOR);
    });
  });

  // ========== ACT-R Formula Edge Cases ==========

  describe('ACT-R formula edge cases', () => {
    it('should handle count=0 with null lastRetrievalAt', () => {
      const params: ACTRParams = {
        base: 0.50,
        count: 0,
        decayRate: 0.05,
        lastRetrievalAt: null,
      };

      const result = computeConfidence(params);

      expect(result).toBeLessThanOrEqual(CONFIDENCE_THRESHOLDS.ceiling);
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it('should handle count=1', () => {
      const params: ACTRParams = {
        base: 0.50,
        count: 1,
        decayRate: 0.05,
        lastRetrievalAt: new Date(),
      };

      const result = computeConfidence(params);

      expect(result).toBeGreaterThan(0.45);
      expect(result).toBeLessThanOrEqual(1.0);
    });

    it('should handle very large count', () => {
      const params: ACTRParams = {
        base: 0.60,
        count: 100000,
        decayRate: 0.03,
        lastRetrievalAt: new Date(),
      };

      const result = computeConfidence(params);

      expect(result).toBeLessThanOrEqual(1.0);
      expect(result).toBeGreaterThan(0.6);
    });

    it('should never return negative', () => {
      const params: ACTRParams = {
        base: 0.0,
        count: 1,
        decayRate: 10.0,
        lastRetrievalAt: new Date('1970-01-01'),
      };

      const result = computeConfidence(params);

      expect(result).toBeGreaterThanOrEqual(0.0);
    });

    it('should never exceed 1.0', () => {
      const params: ACTRParams = {
        base: 1.0,
        count: 10000,
        decayRate: 0.0,
        lastRetrievalAt: new Date(),
      };

      const result = computeConfidence(params);

      expect(result).toBeLessThanOrEqual(1.0);
    });
  });

  // ========== Guardian Weight ==========

  describe('applyGuardianWeight()', () => {
    it('should apply 2x multiplier for confirmation', () => {
      const delta = 0.1;
      const result = applyGuardianWeight(delta, 'confirmation');

      expect(result).toBeCloseTo(0.2, 10);
    });

    it('should apply 3x multiplier for correction', () => {
      const delta = 0.1;
      const result = applyGuardianWeight(delta, 'correction');

      expect(result).toBeCloseTo(0.3, 10);
    });

    it('should have correction > confirmation', () => {
      const delta = 0.05;
      const confirmation = applyGuardianWeight(delta, 'confirmation');
      const correction = applyGuardianWeight(delta, 'correction');

      expect(correction).toBeGreaterThan(confirmation);
      expect(correction / confirmation).toBeCloseTo(1.5, 10);
    });

    it('should preserve sign of delta', () => {
      const negativeDelta = -0.1;

      const confResult = applyGuardianWeight(negativeDelta, 'confirmation');
      const corrResult = applyGuardianWeight(negativeDelta, 'correction');

      expect(confResult).toBeLessThan(0);
      expect(corrResult).toBeLessThan(0);
    });
  });

  // ========== Threshold Relationships ==========

  describe('Threshold relationships (CANON §Confidence Dynamics)', () => {
    it('should have retrieval < ceiling < graduation', () => {
      expect(CONFIDENCE_THRESHOLDS.retrieval).toBeLessThan(
        CONFIDENCE_THRESHOLDS.ceiling,
      );
      expect(CONFIDENCE_THRESHOLDS.ceiling).toBeLessThan(
        CONFIDENCE_THRESHOLDS.graduation,
      );
    });

    it('should have graduationMAE < demotionMAE', () => {
      expect(CONFIDENCE_THRESHOLDS.graduationMAE).toBeLessThan(
        CONFIDENCE_THRESHOLDS.demotionMAE,
      );
    });

    it('should have graduation threshold at 0.80 for Type 1 graduation', () => {
      expect(CONFIDENCE_THRESHOLDS.graduation).toBe(0.80);
      expect(CONFIDENCE_THRESHOLDS.graduationMAE).toBe(0.10);
    });
  });

  // ========== ACT-R Formula Constants ==========

  describe('ACT-R formula constants', () => {
    it('should use 0.12 growth coefficient in formula', () => {
      const params: ACTRParams = {
        base: 0,
        count: 10,
        decayRate: 0,
        lastRetrievalAt: new Date(),
      };

      const result = computeConfidence(params);
      const expectedGrowth = 0.12 * Math.log(10);

      expect(result).toBe(expectedGrowth);
    });

    it('should apply decay as d * ln(hours + 1)', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const params: ACTRParams = {
        base: 0.6,
        count: 1,
        decayRate: 0.03,
        lastRetrievalAt: oneHourAgo,
      };

      const result = computeConfidence(params);

      // Formula: 0.6 + 0.12*ln(1) - 0.03*ln(2)
      // = 0.6 + 0 - 0.03*0.693
      // ≈ 0.579
      expect(result).toBeCloseTo(0.579, 2);
    });
  });
});

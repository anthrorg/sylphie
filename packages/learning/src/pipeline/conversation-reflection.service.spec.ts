/**
 * Unit tests for computeGroundedConfidence — Idea 5: Grounded Confidence.
 *
 * The function is pure (no I/O, no DI) so these tests run without any mocks
 * for Neo4j or TimescaleDB. They verify the three distinct cases:
 *
 *   A. No entity references (purely observational) → base confidence, grounded=true
 *   B. Partial grounding (some entities matched)   → scaled confidence, grounded=true
 *   C. Zero grounding (no entities matched)        → floor confidence 0.05, grounded=false
 *   D. Full grounding (all entities matched)       → full base confidence, grounded=true
 *   E. Floor behaviour (very small ratio)          → never below 0.05
 */

import { computeGroundedConfidence } from './conversation-reflection.service';

// REFLECTION_CONFIDENCE is 0.30 (module-level constant).
// Tests refer to it symbolically via BASE so the relationship is clear.
const BASE = 0.30;

describe('computeGroundedConfidence', () => {
  // -------------------------------------------------------------------------
  // A. No entity references
  // -------------------------------------------------------------------------
  describe('when no entities were referenced (attemptedReveals === 0)', () => {
    it('returns base REFLECTION_CONFIDENCE unchanged', () => {
      const result = computeGroundedConfidence(0, 0);
      expect(result.adjustedConfidence).toBe(BASE);
    });

    it('marks the insight as grounded=true (nothing to fail against)', () => {
      const result = computeGroundedConfidence(0, 0);
      expect(result.grounded).toBe(true);
    });

    it('returns groundingRatio of 1 (full credit for observational insights)', () => {
      const result = computeGroundedConfidence(0, 0);
      expect(result.groundingRatio).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // B. Partial grounding
  // -------------------------------------------------------------------------
  describe('when some referenced entities matched (partial grounding)', () => {
    it('scales confidence by the ratio: 1/4 matched → 0.30 * 0.25 = 0.075', () => {
      const result = computeGroundedConfidence(4, 1);
      expect(result.adjustedConfidence).toBeCloseTo(BASE * 0.25);
    });

    it('scales confidence by the ratio: 2/4 matched → 0.30 * 0.5 = 0.15', () => {
      const result = computeGroundedConfidence(4, 2);
      expect(result.adjustedConfidence).toBeCloseTo(BASE * 0.5);
    });

    it('scales confidence by the ratio: 3/4 matched → 0.30 * 0.75 = 0.225', () => {
      const result = computeGroundedConfidence(4, 3);
      expect(result.adjustedConfidence).toBeCloseTo(BASE * 0.75);
    });

    it('marks partial-grounding insights as grounded=true', () => {
      const result = computeGroundedConfidence(4, 1);
      expect(result.grounded).toBe(true);
    });

    it('returns the correct groundingRatio for 1/4 matched', () => {
      const result = computeGroundedConfidence(4, 1);
      expect(result.groundingRatio).toBeCloseTo(0.25);
    });

    it('returns the correct groundingRatio for 3/5 matched', () => {
      const result = computeGroundedConfidence(5, 3);
      expect(result.groundingRatio).toBeCloseTo(0.6);
    });
  });

  // -------------------------------------------------------------------------
  // C. Zero grounding (ungrounded insight)
  // -------------------------------------------------------------------------
  describe('when no referenced entities matched (zero grounding)', () => {
    it('returns the floor confidence of 0.05', () => {
      const result = computeGroundedConfidence(3, 0);
      expect(result.adjustedConfidence).toBe(0.05);
    });

    it('marks the insight as grounded=false', () => {
      const result = computeGroundedConfidence(3, 0);
      expect(result.grounded).toBe(false);
    });

    it('returns groundingRatio of 0', () => {
      const result = computeGroundedConfidence(3, 0);
      expect(result.groundingRatio).toBe(0);
    });

    it('marks grounded=false regardless of how many entities were referenced', () => {
      expect(computeGroundedConfidence(1, 0).grounded).toBe(false);
      expect(computeGroundedConfidence(10, 0).grounded).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // D. Full grounding (all entities matched)
  // -------------------------------------------------------------------------
  describe('when all referenced entities matched (full grounding)', () => {
    it('returns exactly REFLECTION_CONFIDENCE for 1/1 match', () => {
      const result = computeGroundedConfidence(1, 1);
      expect(result.adjustedConfidence).toBeCloseTo(BASE);
    });

    it('returns exactly REFLECTION_CONFIDENCE for 5/5 match', () => {
      const result = computeGroundedConfidence(5, 5);
      expect(result.adjustedConfidence).toBeCloseTo(BASE);
    });

    it('marks full-grounding insights as grounded=true', () => {
      const result = computeGroundedConfidence(5, 5);
      expect(result.grounded).toBe(true);
    });

    it('returns groundingRatio of 1 for fully matched insights', () => {
      const result = computeGroundedConfidence(5, 5);
      expect(result.groundingRatio).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // E. Floor enforcement
  // -------------------------------------------------------------------------
  describe('floor at 0.05', () => {
    it('never returns adjustedConfidence below 0.05 for any non-zero attemptedReveals', () => {
      // Worst case: 1 entity referenced, 0 matched
      const result = computeGroundedConfidence(1, 0);
      expect(result.adjustedConfidence).toBeGreaterThanOrEqual(0.05);
    });

    it('returns exactly 0.05 for 0/N matched (floor triggered)', () => {
      // BASE * 0 = 0, floor kicks in
      const result = computeGroundedConfidence(2, 0);
      expect(result.adjustedConfidence).toBe(0.05);
    });

    it('does NOT apply floor when ratio produces confidence above 0.05', () => {
      // BASE * (2/4) = 0.30 * 0.5 = 0.15, above floor
      const result = computeGroundedConfidence(4, 2);
      expect(result.adjustedConfidence).toBeGreaterThan(0.05);
      expect(result.adjustedConfidence).toBeCloseTo(0.15);
    });
  });
});

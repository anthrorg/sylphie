/**
 * Behavioral Contingency Tests
 *
 * CANON §A.14: Behavioral contingencies create the reinforcement schedules
 * that shape Sylphie's learning. These tests verify each contingency computes
 * drive deltas according to specification.
 */

import { DriveName } from '../../shared/types/drive.types';
import { SatisfactionHabituation } from '../drive-process/behavioral-contingencies/satisfaction-habituation';
import { GuiltyRepair } from '../drive-process/behavioral-contingencies/guilt-repair';
import { AnxietyAmplification } from '../drive-process/behavioral-contingencies/anxiety-amplification';
import { SocialCommentQuality } from '../drive-process/behavioral-contingencies/social-comment-quality';
import { CuriosityInformationGain } from '../drive-process/behavioral-contingencies/curiosity-information-gain';

describe('Behavioral Contingencies', () => {
  describe('Satisfaction Habituation', () => {
    let habituation: SatisfactionHabituation;

    beforeEach(() => {
      habituation = new SatisfactionHabituation();
    });

    it('should apply first success relief (0.20)', () => {
      const relief = habituation.computeRelief('test-action', 'positive');
      expect(relief).toBeCloseTo(0.2);
    });

    it('should apply second success relief (0.15)', () => {
      habituation.computeRelief('test-action', 'positive'); // 1st: 0.20
      const relief = habituation.computeRelief('test-action', 'positive'); // 2nd: 0.15
      expect(relief).toBeCloseTo(0.15);
    });

    it('should apply third success relief (0.10)', () => {
      habituation.computeRelief('test-action', 'positive'); // 1st: 0.20
      habituation.computeRelief('test-action', 'positive'); // 2nd: 0.15
      const relief = habituation.computeRelief('test-action', 'positive'); // 3rd: 0.10
      expect(relief).toBeCloseTo(0.1);
    });

    it('should apply fourth success relief (0.05)', () => {
      habituation.computeRelief('test-action', 'positive'); // 1st: 0.20
      habituation.computeRelief('test-action', 'positive'); // 2nd: 0.15
      habituation.computeRelief('test-action', 'positive'); // 3rd: 0.10
      const relief = habituation.computeRelief('test-action', 'positive'); // 4th: 0.05
      expect(relief).toBeCloseTo(0.05);
    });

    it('should apply fifth+ success relief (0.02)', () => {
      habituation.computeRelief('test-action', 'positive'); // 1st
      habituation.computeRelief('test-action', 'positive'); // 2nd
      habituation.computeRelief('test-action', 'positive'); // 3rd
      habituation.computeRelief('test-action', 'positive'); // 4th
      const relief = habituation.computeRelief('test-action', 'positive'); // 5th: 0.02
      expect(relief).toBeCloseTo(0.02);

      const relief6 = habituation.computeRelief('test-action', 'positive'); // 6th: 0.02
      expect(relief6).toBeCloseTo(0.02);
    });

    it('should reset counter on failure', () => {
      habituation.computeRelief('test-action', 'positive'); // 1st: 0.20
      habituation.computeRelief('test-action', 'positive'); // 2nd: 0.15
      habituation.computeRelief('test-action', 'negative'); // Failure: reset
      const relief = habituation.computeRelief('test-action', 'positive'); // Back to 1st: 0.20
      expect(relief).toBeCloseTo(0.2);
    });

    it('should reset counter when switching action types', () => {
      habituation.computeRelief('action-a', 'positive'); // 1st: 0.20
      habituation.computeRelief('action-a', 'positive'); // 2nd: 0.15
      const relief = habituation.computeRelief('action-b', 'positive'); // Different action: 1st: 0.20
      expect(relief).toBeCloseTo(0.2);
    });

    it('should return zero on failure', () => {
      const relief = habituation.computeRelief('test-action', 'negative');
      expect(relief).toBe(0);
    });
  });

  describe('Guilt Repair', () => {
    let repair: GuiltyRepair;

    beforeEach(() => {
      repair = new GuiltyRepair();
    });

    it('should apply acknowledgment-only relief (-0.10)', () => {
      const relief = repair.computeGuiltRelief('apologize-action', 'positive');
      expect(relief).toBeCloseTo(-0.1);
    });

    it('should apply behavioral-change-only relief (-0.15)', () => {
      const relief = repair.computeGuiltRelief('different-action', 'positive', {
        previousErrorActionType: 'original-error',
      });
      expect(relief).toBeCloseTo(-0.15);
    });

    it('should apply both acknowledgment and behavioral change relief (-0.30)', () => {
      const relief = repair.computeGuiltRelief('apologize-different', 'positive', {
        previousErrorActionType: 'original-error',
      });
      expect(relief).toBeCloseTo(-0.3);
    });

    it('should return zero on negative outcome', () => {
      const relief = repair.computeGuiltRelief('any-action', 'negative');
      expect(relief).toBe(0);
    });

    it('should detect acknowledgment keywords', () => {
      expect(repair.computeGuiltRelief('acknowledge-mistake', 'positive')).toBeLessThan(0);
      expect(repair.computeGuiltRelief('accept-responsibility', 'positive')).toBeLessThan(0);
      expect(repair.computeGuiltRelief('apologize-sincerely', 'positive')).toBeLessThan(0);
      expect(repair.computeGuiltRelief('admit-error', 'positive')).toBeLessThan(0);
    });

    it('should detect behavioral change from context', () => {
      const relief = repair.computeGuiltRelief('new-approach', 'positive', {
        previousErrorActionType: 'failed-approach',
      });
      expect(relief).toBeLessThan(0);
    });
  });

  describe('Anxiety Amplification', () => {
    let amplifier: AnxietyAmplification;

    beforeEach(() => {
      amplifier = new AnxietyAmplification();
    });

    it('should amplify reduction 1.5x when anxiety > 0.7 and outcome negative', () => {
      const baseReduction = 0.2;
      const amplified = amplifier.amplifyReduction(0.8, 'negative', baseReduction);
      expect(amplified).toBeCloseTo(baseReduction * 1.5);
    });

    it('should not amplify when anxiety <= 0.7', () => {
      const baseReduction = 0.2;
      const result = amplifier.amplifyReduction(0.7, 'negative', baseReduction);
      expect(result).toBeCloseTo(baseReduction);
    });

    it('should not amplify when outcome is positive', () => {
      const baseReduction = 0.2;
      const result = amplifier.amplifyReduction(0.8, 'positive', baseReduction);
      expect(result).toBeCloseTo(baseReduction);
    });

    it('should not amplify when both anxiety is low and outcome is positive', () => {
      const baseReduction = 0.2;
      const result = amplifier.amplifyReduction(0.5, 'positive', baseReduction);
      expect(result).toBeCloseTo(baseReduction);
    });

    it('should handle edge case: anxiety exactly 0.7', () => {
      const baseReduction = 0.2;
      const result = amplifier.amplifyReduction(0.7, 'negative', baseReduction);
      // 0.7 is NOT > 0.7, so no amplification
      expect(result).toBeCloseTo(baseReduction);
    });

    it('should handle edge case: anxiety just above 0.7', () => {
      const baseReduction = 0.2;
      const result = amplifier.amplifyReduction(0.70001, 'negative', baseReduction);
      expect(result).toBeCloseTo(baseReduction * 1.5);
    });
  });

  describe('Social Comment Quality', () => {
    let social: SocialCommentQuality;

    beforeEach(() => {
      social = new SocialCommentQuality();
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should apply social relief when guardian responds within 30s', () => {
      const commentTime = Date.now();
      social.recordComment(commentTime);

      jest.advanceTimersByTime(15 * 1000); // Advance 15 seconds
      const result = social.processGuardianResponse(Date.now());

      expect(result.socialRelief).toBeCloseTo(-0.15);
      expect(result.satisfactionBonus).toBeCloseTo(0.1);
    });

    it('should not apply relief when no response within 30s', () => {
      const commentTime = Date.now();
      social.recordComment(commentTime);

      jest.advanceTimersByTime(31 * 1000); // Advance 31 seconds
      const result = social.processGuardianResponse(Date.now());

      expect(result.socialRelief).toBe(0);
      expect(result.satisfactionBonus).toBe(0);
    });

    it('should apply relief at exactly 30s boundary', () => {
      const commentTime = Date.now();
      social.recordComment(commentTime);

      jest.advanceTimersByTime(30 * 1000); // Advance exactly 30 seconds
      const result = social.processGuardianResponse(Date.now());

      expect(result.socialRelief).toBeCloseTo(-0.15);
      expect(result.satisfactionBonus).toBeCloseTo(0.1);
    });

    it('should accumulate relief from multiple comments', () => {
      const time1 = Date.now();
      social.recordComment(time1);

      jest.advanceTimersByTime(5 * 1000);
      const time2 = Date.now();
      social.recordComment(time2);

      jest.advanceTimersByTime(20 * 1000);
      const result = social.processGuardianResponse(Date.now());

      // Both comments should qualify
      expect(result.socialRelief).toBeCloseTo(-0.3); // 2 × -0.15
      expect(result.satisfactionBonus).toBeCloseTo(0.2); // 2 × 0.10
    });
  });

  describe('Curiosity Information Gain', () => {
    let curiosity: CuriosityInformationGain;

    beforeEach(() => {
      curiosity = new CuriosityInformationGain();
    });

    it('should compute relief from new nodes (0.05 per node)', () => {
      const relief = curiosity.computeRelief(1, 0, 0);
      expect(relief).toBeCloseTo(-0.05);
    });

    it('should compute relief from confidence deltas (0.10 per unit)', () => {
      const relief = curiosity.computeRelief(0, 0.5, 0);
      expect(relief).toBeCloseTo(-0.05); // 0.5 * 0.10
    });

    it('should compute relief from resolved errors (0.15 per error)', () => {
      const relief = curiosity.computeRelief(0, 0, 1);
      expect(relief).toBeCloseTo(-0.15);
    });

    it('should accumulate all information gain sources', () => {
      const relief = curiosity.computeRelief(2, 0.3, 1);
      // (2 * 0.05) + (0.3 * 0.10) + (1 * 0.15)
      // = 0.10 + 0.03 + 0.15 = 0.28
      expect(relief).toBeCloseTo(-0.28);
    });

    it('should return zero for no information gain', () => {
      const relief = curiosity.computeRelief(0, 0, 0);
      expect(relief).toBeCloseTo(0);
    });

    it('should clamp negative inputs to zero', () => {
      const relief = curiosity.computeRelief(-5, -3, -2);
      expect(relief).toBeCloseTo(0);
    });

    it('should compute relief from context object', () => {
      const relief = curiosity.computeReliefFromContext({
        newNodes: 1,
        confidenceDeltas: 0.2,
        resolvedErrors: 1,
      });
      // (1 * 0.05) + (0.2 * 0.10) + (1 * 0.15) = 0.22
      expect(relief).toBeCloseTo(-0.22);
    });

    it('should return zero for empty context', () => {
      const relief = curiosity.computeReliefFromContext({});
      expect(relief).toBeCloseTo(0);
    });

    it('should return zero for undefined context', () => {
      const relief = curiosity.computeReliefFromContext(undefined);
      expect(relief).toBe(0);
    });
  });
});

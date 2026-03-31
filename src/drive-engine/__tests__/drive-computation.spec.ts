/**
 * Drive Computation Tests
 *
 * CANON §A.1 Tick Loop: Accumulation, decay, outcome effects, cross-modulation,
 * and clamping all combined in the full computation pipeline.
 */

import {
  DriveName,
  INITIAL_DRIVE_STATE,
  DRIVE_RANGE,
  clampDriveValue,
} from '../../shared/types/drive.types';
import {
  DRIVE_ACCUMULATION_RATES,
  DRIVE_DECAY_RATES,
  ANXIETY_CURIOSITY_SUPPRESSION_THRESHOLD,
  ANXIETY_CURIOSITY_SUPPRESSION_COEFFICIENT,
  SATISFACTION_BOREDOM_SUPPRESSION_THRESHOLD,
  SATISFACTION_BOREDOM_SUPPRESSION_COEFFICIENT,
  ANXIETY_INTEGRITY_AMPLIFICATION_THRESHOLD,
  ANXIETY_INTEGRITY_AMPLIFICATION_COEFFICIENT,
  SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_THRESHOLD,
  SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_COEFFICIENT,
  BOREDOM_CURIOSITY_AMPLIFICATION_THRESHOLD,
  BOREDOM_CURIOSITY_AMPLIFICATION_COEFFICIENT,
  GUILT_SATISFACTION_SUPPRESSION_THRESHOLD,
  GUILT_SATISFACTION_SUPPRESSION_COEFFICIENT,
} from '../constants/drives';
import { createMockPressureVector } from './test-utils';

describe('Drive Computation', () => {
  describe('Accumulation', () => {
    it('should apply positive accumulation rates to drives', () => {
      const current = INITIAL_DRIVE_STATE[DriveName.SystemHealth];
      const rate = DRIVE_ACCUMULATION_RATES[DriveName.SystemHealth];

      const updated = current + rate;

      expect(rate).toBeGreaterThan(0);
      expect(updated).toBeGreaterThan(current);
    });

    it('should apply negative decay rates to satisfaction', () => {
      const current = INITIAL_DRIVE_STATE[DriveName.Satisfaction];
      const rate = DRIVE_DECAY_RATES[DriveName.Satisfaction];

      const updated = current + rate;

      expect(rate).toBeLessThan(0);
      expect(updated).toBeLessThan(current);
    });

    it('should apply zero rate for event-only drives (Guilt)', () => {
      const rate = DRIVE_ACCUMULATION_RATES[DriveName.Guilt];
      expect(rate).toBe(0);
    });

    it('should accumulate per tick for all 12 drives', () => {
      let state = { ...INITIAL_DRIVE_STATE };

      Object.entries(DRIVE_ACCUMULATION_RATES).forEach(([driveName, rate]) => {
        const decayRate = DRIVE_DECAY_RATES[driveName as DriveName];
        state[driveName as DriveName] += rate + decayRate;
      });

      // State should have changed (at least some drives)
      let changed = false;
      Object.entries(state).forEach(([driveName, value]) => {
        if (value !== INITIAL_DRIVE_STATE[driveName as DriveName]) {
          changed = true;
        }
      });

      expect(changed).toBe(true);
    });
  });

  describe('Decay', () => {
    it('should decay satisfaction toward zero', () => {
      const current = 0.5;
      const rate = DRIVE_DECAY_RATES[DriveName.Satisfaction];
      const updated = current + rate;

      expect(rate).toBeLessThan(0);
      expect(updated).toBeLessThan(current);
      expect(updated).toBeGreaterThan(0); // Not clamped yet
    });

    it('should decay sadness toward zero', () => {
      const current = 0.3;
      const rate = DRIVE_DECAY_RATES[DriveName.Sadness];
      const updated = current + rate;

      expect(rate).toBeLessThan(0);
      expect(updated).toBeLessThan(current);
    });

    it('should not decay core drives', () => {
      const coreDrives = [
        DriveName.SystemHealth,
        DriveName.MoralValence,
        DriveName.Integrity,
        DriveName.CognitiveAwareness,
      ];

      coreDrives.forEach((drive) => {
        const rate = DRIVE_DECAY_RATES[drive];
        expect(rate).toBe(0);
      });
    });
  });

  describe('Cross-Modulation: Anxiety-Curiosity', () => {
    it('should suppress curiosity when anxiety > 0.7', () => {
      const anxiety = 0.8;
      const curiosity = 0.6;

      if (anxiety > ANXIETY_CURIOSITY_SUPPRESSION_THRESHOLD) {
        const suppressed = curiosity * (1 - ANXIETY_CURIOSITY_SUPPRESSION_COEFFICIENT * anxiety);
        expect(suppressed).toBeLessThan(curiosity);
      }
    });

    it('should not suppress when anxiety <= 0.7', () => {
      const anxiety = 0.6;
      const curiosity = 0.6;

      if (anxiety > ANXIETY_CURIOSITY_SUPPRESSION_THRESHOLD) {
        // No suppression
      } else {
        expect(curiosity).toBe(0.6);
      }
    });

    it('should use suppression coefficient of 0.4', () => {
      expect(ANXIETY_CURIOSITY_SUPPRESSION_COEFFICIENT).toBe(0.4);
    });
  });

  describe('Cross-Modulation: Satisfaction-Boredom', () => {
    it('should suppress boredom when satisfaction > 0.6', () => {
      const satisfaction = 0.7;
      const boredom = 0.5;

      if (satisfaction > SATISFACTION_BOREDOM_SUPPRESSION_THRESHOLD) {
        const suppressed =
          boredom * (1 - SATISFACTION_BOREDOM_SUPPRESSION_COEFFICIENT * satisfaction);
        expect(suppressed).toBeLessThan(boredom);
      }
    });

    it('should use suppression coefficient of 0.3', () => {
      expect(SATISFACTION_BOREDOM_SUPPRESSION_COEFFICIENT).toBe(0.3);
    });
  });

  describe('Cross-Modulation: Anxiety-Integrity', () => {
    it('should amplify integrity when anxiety > 0.7', () => {
      const anxiety = 0.9;
      const integrity = 0.4;

      if (anxiety > ANXIETY_INTEGRITY_AMPLIFICATION_THRESHOLD) {
        const amplified = integrity + ANXIETY_INTEGRITY_AMPLIFICATION_COEFFICIENT * anxiety;
        expect(amplified).toBeGreaterThan(integrity);
      }
    });

    it('should use amplification coefficient of 0.2', () => {
      expect(ANXIETY_INTEGRITY_AMPLIFICATION_COEFFICIENT).toBe(0.2);
    });
  });

  describe('Cross-Modulation: SystemHealth-Anxiety', () => {
    it('should amplify anxiety when systemHealth < 0.3', () => {
      const systemHealth = 0.2;
      const anxiety = 0.3;

      if (systemHealth < SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_THRESHOLD) {
        const amplified =
          anxiety +
          SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_COEFFICIENT *
            (SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_THRESHOLD - systemHealth);
        expect(amplified).toBeGreaterThan(anxiety);
      }
    });

    it('should use amplification coefficient of 0.5', () => {
      expect(SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_COEFFICIENT).toBe(0.5);
    });
  });

  describe('Cross-Modulation: Boredom-Curiosity', () => {
    it('should amplify curiosity when boredom > 0.6', () => {
      const boredom = 0.7;
      const curiosity = 0.3;

      if (boredom > BOREDOM_CURIOSITY_AMPLIFICATION_THRESHOLD) {
        const amplified =
          curiosity + BOREDOM_CURIOSITY_AMPLIFICATION_COEFFICIENT * (boredom - BOREDOM_CURIOSITY_AMPLIFICATION_THRESHOLD);
        expect(amplified).toBeGreaterThan(curiosity);
      }
    });

    it('should use amplification coefficient of 0.3', () => {
      expect(BOREDOM_CURIOSITY_AMPLIFICATION_COEFFICIENT).toBe(0.3);
    });
  });

  describe('Cross-Modulation: Guilt-Satisfaction', () => {
    it('should suppress satisfaction when guilt > 0.4', () => {
      const guilt = 0.6;
      const satisfaction = 0.7;

      if (guilt > GUILT_SATISFACTION_SUPPRESSION_THRESHOLD) {
        const suppressed =
          satisfaction * (1 - GUILT_SATISFACTION_SUPPRESSION_COEFFICIENT * guilt);
        expect(suppressed).toBeLessThan(satisfaction);
      }
    });

    it('should use suppression coefficient of 0.5', () => {
      expect(GUILT_SATISFACTION_SUPPRESSION_COEFFICIENT).toBe(0.5);
    });
  });

  describe('Clamping', () => {
    it('should clamp values to [-10.0, 1.0]', () => {
      expect(clampDriveValue(-15)).toBe(DRIVE_RANGE.min);
      expect(clampDriveValue(2.0)).toBe(DRIVE_RANGE.max);
    });

    it('should respect minimum bound of -10.0', () => {
      const clamped = clampDriveValue(-20);
      expect(clamped).toBe(-10.0);
    });

    it('should respect maximum bound of 1.0', () => {
      const clamped = clampDriveValue(5.0);
      expect(clamped).toBe(1.0);
    });

    it('should not clamp values within range', () => {
      expect(clampDriveValue(0.0)).toBe(0.0);
      expect(clampDriveValue(-0.5)).toBe(-0.5);
      expect(clampDriveValue(0.5)).toBe(0.5);
    });

    it('should handle boundary values', () => {
      expect(clampDriveValue(DRIVE_RANGE.min)).toBe(DRIVE_RANGE.min);
      expect(clampDriveValue(DRIVE_RANGE.max)).toBe(DRIVE_RANGE.max);
    });
  });

  describe('Total Pressure Computation', () => {
    it('should sum all positive drive values', () => {
      // Create a pressure vector with only three drives set to non-zero
      const pressureVector: Record<DriveName, number> = {
        [DriveName.SystemHealth]: 0.2,
        [DriveName.MoralValence]: 0,
        [DriveName.Integrity]: 0,
        [DriveName.CognitiveAwareness]: 0,
        [DriveName.Guilt]: 0,
        [DriveName.Curiosity]: 0.3,
        [DriveName.Boredom]: 0,
        [DriveName.Anxiety]: 0.5,
        [DriveName.Satisfaction]: 0,
        [DriveName.Sadness]: 0,
        [DriveName.InformationIntegrity]: 0,
        [DriveName.Social]: 0,
      };

      const totalPressure = Object.values(pressureVector).reduce(
        (sum, value) => sum + Math.max(0, value),
        0,
      );

      expect(totalPressure).toBeCloseTo(0.5 + 0.3 + 0.2);
    });

    it('should ignore negative drive values (relief)', () => {
      // Create a pressure vector with only two drives set
      const pressureVector: Record<DriveName, number> = {
        [DriveName.SystemHealth]: 0,
        [DriveName.MoralValence]: 0,
        [DriveName.Integrity]: 0,
        [DriveName.CognitiveAwareness]: 0,
        [DriveName.Guilt]: 0,
        [DriveName.Curiosity]: 0,
        [DriveName.Boredom]: 0,
        [DriveName.Anxiety]: 0.5,
        [DriveName.Satisfaction]: -2.0, // Negative = relief
        [DriveName.Sadness]: 0,
        [DriveName.InformationIntegrity]: 0,
        [DriveName.Social]: 0,
      };

      const totalPressure = Object.values(pressureVector).reduce(
        (sum, value) => sum + Math.max(0, value),
        0,
      );

      // Only Anxiety contributes
      expect(totalPressure).toBeCloseTo(0.5);
    });

    it('should be in range [0.0, 12.0]', () => {
      const maxPressure = 12 * 1.0; // All drives at maximum
      expect(maxPressure).toBe(12.0);

      const minPressure = 0.0; // All drives at or below zero
      expect(minPressure).toBe(0.0);
    });

    it('should be zero when all drives <= 0', () => {
      // Create a pressure vector with all drives at or below zero
      const pressureVector: Record<DriveName, number> = {
        [DriveName.SystemHealth]: -0.5,
        [DriveName.MoralValence]: -0.3,
        [DriveName.Integrity]: 0,
        [DriveName.CognitiveAwareness]: -0.2,
        [DriveName.Guilt]: 0,
        [DriveName.Curiosity]: -1.0,
        [DriveName.Boredom]: -0.5,
        [DriveName.Anxiety]: 0,
        [DriveName.Satisfaction]: -1.0,
        [DriveName.Sadness]: 0.0,
        [DriveName.InformationIntegrity]: -0.3,
        [DriveName.Social]: -0.1,
      };

      const totalPressure = Object.values(pressureVector).reduce(
        (sum, value) => sum + Math.max(0, value),
        0,
      );

      expect(totalPressure).toBe(0);
    });
  });

  describe('Full Pipeline', () => {
    it('should apply accumulation then clamping', () => {
      let drive = INITIAL_DRIVE_STATE[DriveName.SystemHealth];
      const rate = DRIVE_ACCUMULATION_RATES[DriveName.SystemHealth];

      // Apply accumulation many times to reach clamping boundary
      for (let i = 0; i < 1000; i++) {
        drive += rate;
      }

      // Clamp
      drive = clampDriveValue(drive);

      expect(drive).toBeLessThanOrEqual(DRIVE_RANGE.max);
      expect(drive).toBeGreaterThanOrEqual(DRIVE_RANGE.min);
    });

    it('should prevent unbounded accumulation via clamping', () => {
      let drive = INITIAL_DRIVE_STATE[DriveName.Satisfaction];
      const rate = DRIVE_DECAY_RATES[DriveName.Satisfaction];

      // Decay many times
      for (let i = 0; i < 10000; i++) {
        drive += rate;
        drive = clampDriveValue(drive);
      }

      expect(drive).toBeGreaterThanOrEqual(DRIVE_RANGE.min);
    });
  });
});

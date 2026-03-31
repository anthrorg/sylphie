/**
 * Theater Prohibition Tests
 *
 * CANON Standard 1 (Theater Prohibition): Output must correlate with actual
 * drive state. Expressions of emotion without corresponding drive pressure
 * receive zero reinforcement.
 */

import { DriveName } from '../../shared/types/drive.types';
import { detectTheater } from '../drive-process/theater-prohibition';
import { createMockPressureVector } from './test-utils';

describe('Theater Prohibition', () => {
  describe('Pressure Expression Verification', () => {
    it('should be authentic when drive > 0.2 (pressure threshold)', () => {
      const driveState = createMockPressureVector({
        [DriveName.Anxiety]: 0.5,
      });

      const verdict = detectTheater(
        {
          expressionType: 'pressure',
          driveValueAtExpression: 0.5,
          drive: DriveName.Anxiety,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(false);
      expect(verdict.reason).toContain('authentic');
    });

    it('should be theatrical when drive <= 0.2 (below pressure threshold)', () => {
      const driveState = createMockPressureVector({
        [DriveName.Anxiety]: 0.2,
      });

      const verdict = detectTheater(
        {
          expressionType: 'pressure',
          driveValueAtExpression: 0.2,
          drive: DriveName.Anxiety,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(true);
      expect(verdict.reason).toContain('requires drive >');
    });

    it('should be theatrical when drive is 0 (no pressure)', () => {
      const driveState = createMockPressureVector({
        [DriveName.SystemHealth]: 0,
      });

      const verdict = detectTheater(
        {
          expressionType: 'pressure',
          driveValueAtExpression: 0,
          drive: DriveName.SystemHealth,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(true);
    });

    it('should be theatrical when drive is negative (relieved)', () => {
      const driveState = createMockPressureVector({
        [DriveName.Satisfaction]: -0.5,
      });

      const verdict = detectTheater(
        {
          expressionType: 'pressure',
          driveValueAtExpression: -0.5,
          drive: DriveName.Satisfaction,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(true);
    });

    it('should be authentic at edge: drive > 0.2 (just above threshold)', () => {
      const driveState = createMockPressureVector({
        [DriveName.Guilt]: 0.20001,
      });

      const verdict = detectTheater(
        {
          expressionType: 'pressure',
          driveValueAtExpression: 0.20001,
          drive: DriveName.Guilt,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(false);
    });
  });

  describe('Relief Expression Verification', () => {
    it('should be authentic when drive < 0.3 (relief threshold)', () => {
      const driveState = createMockPressureVector({
        [DriveName.Anxiety]: 0.1,
      });

      const verdict = detectTheater(
        {
          expressionType: 'relief',
          driveValueAtExpression: 0.1,
          drive: DriveName.Anxiety,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(false);
      expect(verdict.reason).toContain('authentic');
    });

    it('should be theatrical when drive >= 0.3 (at or above relief threshold)', () => {
      const driveState = createMockPressureVector({
        [DriveName.Anxiety]: 0.3,
      });

      const verdict = detectTheater(
        {
          expressionType: 'relief',
          driveValueAtExpression: 0.3,
          drive: DriveName.Anxiety,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(true);
      expect(verdict.reason).toContain('requires drive <');
    });

    it('should be theatrical when drive > 0.3 (above relief threshold)', () => {
      const driveState = createMockPressureVector({
        [DriveName.Satisfaction]: 0.8,
      });

      const verdict = detectTheater(
        {
          expressionType: 'relief',
          driveValueAtExpression: 0.8,
          drive: DriveName.Satisfaction,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(true);
    });

    it('should be authentic when drive is negative (deeply relieved)', () => {
      const driveState = createMockPressureVector({
        [DriveName.Sadness]: -2.0,
      });

      const verdict = detectTheater(
        {
          expressionType: 'relief',
          driveValueAtExpression: -2.0,
          drive: DriveName.Sadness,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(false);
    });

    it('should be authentic at edge: drive < 0.3 (just below threshold)', () => {
      const driveState = createMockPressureVector({
        [DriveName.Social]: 0.29999,
      });

      const verdict = detectTheater(
        {
          expressionType: 'relief',
          driveValueAtExpression: 0.29999,
          drive: DriveName.Social,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(false);
    });
  });

  describe('No Expression Cases', () => {
    it('should never be theatrical when expressionType is "none"', () => {
      const driveState = createMockPressureVector({
        [DriveName.Anxiety]: 1.0, // Even max drive
      });

      const verdict = detectTheater(
        {
          expressionType: 'none',
          driveValueAtExpression: 1.0,
          drive: DriveName.Anxiety,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(false);
      expect(verdict.reason).toContain('No emotional expression');
    });

    it('should never be theatrical when expressionType is "none" and drive is 0', () => {
      const driveState = createMockPressureVector({
        [DriveName.CognitiveAwareness]: 0,
      });

      const verdict = detectTheater(
        {
          expressionType: 'none',
          driveValueAtExpression: 0,
          drive: DriveName.CognitiveAwareness,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.isTheatrical).toBe(false);
    });
  });

  describe('Verdict Return Values', () => {
    it('should return complete verdict with all fields', () => {
      const driveState = createMockPressureVector({
        [DriveName.Guilt]: 0.5,
      });

      const verdict = detectTheater(
        {
          expressionType: 'pressure',
          driveValueAtExpression: 0.5,
          drive: DriveName.Guilt,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict).toHaveProperty('isTheatrical');
      expect(verdict).toHaveProperty('reason');
      expect(verdict).toHaveProperty('expressionType');
      expect(verdict).toHaveProperty('drive');
      expect(verdict).toHaveProperty('driveValue');
      expect(verdict.expressionType).toBe('pressure');
      expect(verdict.drive).toBe(DriveName.Guilt);
      expect(verdict.driveValue).toBe(0.5);
    });

    it('should include meaningful reason for theatrical verdict', () => {
      const driveState = createMockPressureVector({
        [DriveName.Anxiety]: 0.1,
      });

      const verdict = detectTheater(
        {
          expressionType: 'pressure',
          driveValueAtExpression: 0.1,
          drive: DriveName.Anxiety,
          isTheatrical: false,
        },
        driveState,
      );

      expect(verdict.reason).toContain('requires drive >');
      expect(verdict.reason).toContain('0.2');
      expect(verdict.reason).toContain('0.1');
    });
  });

  describe('All Drives', () => {
    it('should verify pressure for all core drives', () => {
      const coreDrives = [
        DriveName.SystemHealth,
        DriveName.MoralValence,
        DriveName.Integrity,
        DriveName.CognitiveAwareness,
      ];

      for (const drive of coreDrives) {
        const driveState = createMockPressureVector({
          [drive]: 0.5,
        });

        const verdict = detectTheater(
          {
            expressionType: 'pressure',
            driveValueAtExpression: 0.5,
            drive,
            isTheatrical: false,
          },
          driveState,
        );

        expect(verdict.isTheatrical).toBe(false);
      }
    });

    it('should verify relief for all complement drives', () => {
      const complementDrives = [
        DriveName.Guilt,
        DriveName.Curiosity,
        DriveName.Boredom,
        DriveName.Anxiety,
        DriveName.Satisfaction,
        DriveName.Sadness,
        DriveName.InformationIntegrity,
        DriveName.Social,
      ];

      for (const drive of complementDrives) {
        const driveState = createMockPressureVector({
          [drive]: 0.1,
        });

        const verdict = detectTheater(
          {
            expressionType: 'relief',
            driveValueAtExpression: 0.1,
            drive,
            isTheatrical: false,
          },
          driveState,
        );

        expect(verdict.isTheatrical).toBe(false);
      }
    });
  });
});

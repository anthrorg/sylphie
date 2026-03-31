/**
 * Unit tests for ThresholdComputationService.
 * Tests dynamic threshold computation based on drive state.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ThresholdComputationService } from '../threshold-computation.service';
import { createMockDriveSnapshot } from '../../__tests__/test-helpers';
import { DriveName } from '../../../shared/types/drive.types';

describe('ThresholdComputationService', () => {
  let service: ThresholdComputationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ThresholdComputationService],
    }).compile();

    service = module.get<ThresholdComputationService>(ThresholdComputationService);
  });

  describe('Base threshold at neutral drives', () => {
    it('should return 0.50 at neutral drives (all zero)', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.0,
          [DriveName.Guilt]: 0.0,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeCloseTo(0.5, 2);
    });
  });

  describe('Anxiety effect', () => {
    it('should raise threshold when anxiety is high (> 0.70)', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.8,
          [DriveName.Guilt]: 0.0,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeGreaterThan(0.5);
    });

    it('should not raise threshold when anxiety is low (< 0.30)', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.2,
          [DriveName.Guilt]: 0.0,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeCloseTo(0.5, 1);
    });

    it('should raise threshold proportionally to anxiety level', () => {
      const drive1 = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.5,
          [DriveName.Guilt]: 0.0,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const drive2 = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 1.0,
          [DriveName.Guilt]: 0.0,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result1 = service.computeThreshold(drive1);
      const result2 = service.computeThreshold(drive2);

      expect(result2.threshold).toBeGreaterThan(result1.threshold);
    });
  });

  describe('Guilt effect', () => {
    it('should raise threshold when guilt is high (> 0.50)', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.0,
          [DriveName.Guilt]: 0.6,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeGreaterThan(0.5);
    });

    it('should not raise threshold when guilt is low (< 0.30)', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.0,
          [DriveName.Guilt]: 0.2,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeCloseTo(0.5, 1);
    });
  });

  describe('Curiosity + Boredom effect', () => {
    it('should lower threshold when both curiosity and boredom are high', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.0,
          [DriveName.Guilt]: 0.0,
          [DriveName.Curiosity]: 0.7,
          [DriveName.Boredom]: 0.7,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeLessThan(0.5);
    });

    it('should not lower threshold when curiosity or boredom is low', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.0,
          [DriveName.Guilt]: 0.0,
          [DriveName.Curiosity]: 0.2,
          [DriveName.Boredom]: 0.7,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeCloseTo(0.5, 1);
    });
  });

  describe('Threshold clamping', () => {
    it('should clamp to minimum 0.30', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.0,
          [DriveName.Guilt]: 0.0,
          [DriveName.Curiosity]: 1.0,
          [DriveName.Boredom]: 1.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeGreaterThanOrEqual(0.3);
    });

    it('should clamp to maximum 0.70', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 1.0,
          [DriveName.Guilt]: 1.0,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeLessThanOrEqual(0.7);
    });

    it('should set clamped flag when limit applied', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 1.0,
          [DriveName.Guilt]: 1.0,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.clamped).toBe(true);
    });

    it('should not set clamped flag when within bounds', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.0,
          [DriveName.Guilt]: 0.0,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.clamped).toBe(false);
    });
  });

  describe('Complex drive states', () => {
    it('should combine anxiety and guilt effects', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.6,
          [DriveName.Guilt]: 0.5,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeGreaterThan(0.5);
    });

    it('should balance anxiety and curiosity+boredom', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.8,
          [DriveName.Guilt]: 0.0,
          [DriveName.Curiosity]: 0.8,
          [DriveName.Boredom]: 0.8,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      // Anxiety raises, curiosity+boredom lowers, final should be somewhere in middle
      expect(result.threshold).toBeGreaterThanOrEqual(0.3);
      expect(result.threshold).toBeLessThanOrEqual(0.7);
    });
  });

  describe('Result structure', () => {
    it('should return all breakdown components', () => {
      const drive = createMockDriveSnapshot();
      const result = service.computeThreshold(drive);

      expect(result.threshold).toBeDefined();
      expect(typeof result.threshold).toBe('number');
      expect(result.baseThreshold).toBeDefined();
      expect(result.anxietyMultiplier).toBeDefined();
      expect(result.moralMultiplier).toBeDefined();
      expect(result.curiosityReduction).toBeDefined();
      expect(result.clamped).toBeDefined();
    });

    it('should have baseThreshold = 0.50', () => {
      const drive = createMockDriveSnapshot();
      const result = service.computeThreshold(drive);

      expect(result.baseThreshold).toBe(0.5);
    });

    it('should have valid multiplier values', () => {
      const drive = createMockDriveSnapshot();
      const result = service.computeThreshold(drive);

      expect(result.anxietyMultiplier).toBeGreaterThanOrEqual(1.0);
      expect(result.anxietyMultiplier).toBeLessThanOrEqual(1.3);
      expect(result.moralMultiplier).toBeGreaterThanOrEqual(1.0);
      expect(result.moralMultiplier).toBeLessThanOrEqual(1.2);
      expect(result.curiosityReduction).toBeGreaterThanOrEqual(0.8);
      expect(result.curiosityReduction).toBeLessThanOrEqual(1.0);
    });
  });

  describe('Edge cases', () => {
    it('should handle all drives at maximum', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 1.0,
          [DriveName.Guilt]: 1.0,
          [DriveName.Curiosity]: 1.0,
          [DriveName.Boredom]: 1.0,
          [DriveName.SystemHealth]: 1.0,
          [DriveName.MoralValence]: 1.0,
          [DriveName.Integrity]: 1.0,
          [DriveName.CognitiveAwareness]: 1.0,
          [DriveName.Satisfaction]: 1.0,
          [DriveName.Sadness]: 1.0,
          [DriveName.InformationIntegrity]: 1.0,
          [DriveName.Social]: 1.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeDefined();
      expect(result.threshold).toBeGreaterThanOrEqual(0.3);
      expect(result.threshold).toBeLessThanOrEqual(0.7);
    });

    it('should handle all drives at minimum', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.0,
          [DriveName.Guilt]: 0.0,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 0.0,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result = service.computeThreshold(drive);
      expect(result.threshold).toBeCloseTo(0.5, 2);
    });
  });

  describe('Consistency', () => {
    it('should produce consistent results for same input', () => {
      const drive = createMockDriveSnapshot({
        pressureVector: {
          [DriveName.Anxiety]: 0.6,
          [DriveName.Guilt]: 0.4,
          [DriveName.Curiosity]: 0.5,
          [DriveName.Boredom]: 0.3,
          [DriveName.SystemHealth]: 0.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.0,
          [DriveName.CognitiveAwareness]: 0.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 0.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.0,
        },
      });

      const result1 = service.computeThreshold(drive);
      const result2 = service.computeThreshold(drive);

      expect(result1.threshold).toBe(result2.threshold);
    });
  });
});

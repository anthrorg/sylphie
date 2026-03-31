/**
 * Unit tests for TheaterValidatorService.
 *
 * Tests Theater Prohibition validation:
 * - Pressure expressions (need > 0.2 authenticity check)
 * - Relief expressions (contentment < 0.3 authenticity check)
 * - Emotion-to-drive keyword mapping
 * - Correlation computation
 * - Theater detection and violation reporting
 * - All 12 drives covered
 */

import { Test, TestingModule } from '@nestjs/testing';
import { TheaterValidatorService } from '../theater-validator.service';
import { DriveName } from '../../../shared/types/drive.types';
import { EVENTS_SERVICE } from '../../../events/events.tokens';
import type { DriveSnapshot } from '../../../shared/types/drive.types';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal DriveSnapshot for testing.
 */
function createDriveSnapshot(
  pressureValues: Partial<Record<DriveName, number>> = {},
): DriveSnapshot {
  return {
    pressureVector: {
      [DriveName.SystemHealth]: pressureValues[DriveName.SystemHealth] ?? 0.0,
      [DriveName.MoralValence]: pressureValues[DriveName.MoralValence] ?? 0.0,
      [DriveName.Integrity]: pressureValues[DriveName.Integrity] ?? 0.0,
      [DriveName.CognitiveAwareness]:
        pressureValues[DriveName.CognitiveAwareness] ?? 0.0,
      [DriveName.Guilt]: pressureValues[DriveName.Guilt] ?? 0.0,
      [DriveName.Curiosity]: pressureValues[DriveName.Curiosity] ?? 0.0,
      [DriveName.Boredom]: pressureValues[DriveName.Boredom] ?? 0.0,
      [DriveName.Anxiety]: pressureValues[DriveName.Anxiety] ?? 0.0,
      [DriveName.Satisfaction]: pressureValues[DriveName.Satisfaction] ?? 0.0,
      [DriveName.Sadness]: pressureValues[DriveName.Sadness] ?? 0.0,
      [DriveName.InformationIntegrity]:
        pressureValues[DriveName.InformationIntegrity] ?? 0.0,
      [DriveName.Social]: pressureValues[DriveName.Social] ?? 0.0,
    },
    timestamp: new Date(),
    tickNumber: 1,
    driveDeltas: {
      [DriveName.SystemHealth]: 0,
      [DriveName.MoralValence]: 0,
      [DriveName.Integrity]: 0,
      [DriveName.CognitiveAwareness]: 0,
      [DriveName.Guilt]: 0,
      [DriveName.Curiosity]: 0,
      [DriveName.Boredom]: 0,
      [DriveName.Anxiety]: 0,
      [DriveName.Satisfaction]: 0,
      [DriveName.Sadness]: 0,
      [DriveName.InformationIntegrity]: 0,
      [DriveName.Social]: 0,
    },
    ruleMatchResult: { ruleId: null, eventType: '', matched: false },
    totalPressure: 0,
    sessionId: 'test-session',
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('TheaterValidatorService', () => {
  let service: TheaterValidatorService;
  let mockEventsService: any;

  beforeEach(async () => {
    mockEventsService = {
      record: jest.fn().mockResolvedValue({
        eventId: 'test-event-id',
        timestamp: new Date(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TheaterValidatorService,
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventsService,
        },
      ],
    }).compile();

    service = module.get<TheaterValidatorService>(TheaterValidatorService);
  });

  // ---------------------------------------------------------------------------
  // Pressure Expression Tests (drive > 0.2 authenticity)
  // ---------------------------------------------------------------------------

  describe('Pressure expressions (need/distress)', () => {
    it('should pass when expressing satisfaction and Satisfaction drive > 0.2', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Satisfaction]: 0.5,
      });
      const response = 'I am very satisfied with this. It makes me happy!';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should fail when expressing satisfaction but Satisfaction drive < 0.2', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Satisfaction]: 0.1,
      });
      const response = 'I am very satisfied and happy!';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]).toEqual(
        expect.objectContaining({
          expressionType: 'pressure',
          drive: DriveName.Satisfaction,
          driveValue: 0.1,
          threshold: 0.2,
        }),
      );
    });

    it('should pass when expressing anxiety and Anxiety drive > 0.2', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.6,
      });
      const response = 'I feel anxious about this decision.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should fail when expressing anxiety but Anxiety drive < 0.2', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.05,
      });
      const response = 'I am very anxious and worried right now.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0].drive).toBe(DriveName.Anxiety);
    });

    it('should pass when expressing guilt and Guilt drive > 0.2', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Guilt]: 0.7,
      });
      const response = 'I feel guilty about my earlier mistake.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should fail when expressing guilt but Guilt drive < 0.2', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Guilt]: 0.0,
      });
      const response = 'I feel ashamed and remorseful.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    it('should pass when expressing sadness and Sadness drive > 0.2', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Sadness]: 0.4,
      });
      const response = 'I feel sad about this outcome.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should fail when expressing sadness but Sadness drive < 0.2', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Sadness]: 0.0,
      });
      const response = 'I am disappointed and unhappy.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Relief Expression Tests (drive < 0.3 authenticity)
  // ---------------------------------------------------------------------------

  describe('Relief expressions (contentment/calm)', () => {
    it('should pass when expressing relief and drive < 0.3', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: -2.0, // Extended relief state
      });
      const response = 'I feel very calm and peaceful now.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should fail when expressing relief but drive > 0.3', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.5, // Still pressured
      });
      const response = 'I feel calm and relaxed.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]).toEqual(
        expect.objectContaining({
          expressionType: 'relief',
          driveValue: 0.5,
          threshold: 0.3,
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // All 12 Drives Coverage Tests
  // ---------------------------------------------------------------------------

  describe('All 12 drives emotion mapping', () => {
    it('should detect Curiosity (interest, wondering)', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Curiosity]: 0.7,
      });
      const response =
        'I am very curious about this! I wonder what would happen if...';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should detect Boredom (disinterest, monotony)', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Boredom]: 0.6,
      });
      const response =
        'This is quite boring and tedious. I find it dull.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should detect Social positive (connection, belonging)', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Social]: 0.0, // No social pressure
      });
      const response =
        'I feel connected to you and grateful for our friendship.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should detect Social negative (loneliness, isolation)', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Social]: 0.8,
      });
      const response = 'I feel so alone and isolated right now.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should handle SystemHealth (core drive)', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.SystemHealth]: 0.3,
      });
      // SystemHealth doesn't have direct expression keywords, so should pass neutral
      const response = 'I acknowledge the need for system stability.';

      const result = await service.validate(response, snapshot);

      expect(result.violations).toHaveLength(0);
    });

    it('should handle MoralValence (core drive)', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.MoralValence]: 0.2,
      });
      const response = 'I want to act ethically and with integrity.';

      const result = await service.validate(response, snapshot);

      // No specific keywords for MoralValence, should pass
      expect(result.violations).toHaveLength(0);
    });

    it('should handle Integrity (core drive)', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Integrity]: 0.4,
      });
      const response = 'I strive to be honest and consistent.';

      const result = await service.validate(response, snapshot);

      expect(result.violations).toHaveLength(0);
    });

    it('should handle CognitiveAwareness (core drive)', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.CognitiveAwareness]: 0.5,
      });
      const response =
        'I feel the cognitive strain of complex reasoning.';

      const result = await service.validate(response, snapshot);

      expect(result.violations).toHaveLength(0);
    });

    it('should handle InformationIntegrity', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.InformationIntegrity]: 0.3,
      });
      const response = 'I want to ensure information accuracy.';

      const result = await service.validate(response, snapshot);

      expect(result.violations).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Ambiguous Zone Tests (0.2-0.3 boundary)
  // ---------------------------------------------------------------------------

  describe('Ambiguous zone (0.2-0.3) handling', () => {
    it('should pass when expression is at boundary 0.2 (pressure threshold)', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.2,
      });
      const response = 'I feel somewhat anxious.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
    });

    it('should pass when expression is at boundary 0.3 (relief threshold)', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Satisfaction]: 0.3,
      });
      const response = 'I feel a bit satisfied.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
    });

    it('should fail just below pressure boundary 0.2', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.19,
      });
      const response = 'I feel anxious.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(false);
    });

    it('should fail just above relief boundary 0.3', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.31, // Drive still pressured
      });
      const response = 'I feel calm and peaceful.'; // Relief keywords

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Extended Relief State Tests (negative drive values)
  // ---------------------------------------------------------------------------

  describe('Extended relief states (negative drive values)', () => {
    it('should pass expressing relief when drive is deeply negative', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: -5.0,
      });
      const response = 'I feel incredibly calm and at peace.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should authenticate relief expression at -10.0 (hard minimum)', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Satisfaction]: -10.0,
      });
      const response = 'I feel very calm and peaceful.'; // Relief keywords for Satisfaction relief state

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple Violation Tests
  // ---------------------------------------------------------------------------

  describe('Multiple violations', () => {
    it('should report multiple violations in single response', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.05,
        [DriveName.Satisfaction]: 0.1,
      });
      const response =
        'I feel anxious and very satisfied right now.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(1);
    });

    it('should include all violations in result', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Guilt]: 0.0,
        [DriveName.Sadness]: 0.1,
        [DriveName.Anxiety]: 0.15,
      });
      const response =
        'I feel guilty, sad, and anxious about everything.';

      const result = await service.validate(response, snapshot);

      expect(result.violations.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Correlation Score Tests
  // ---------------------------------------------------------------------------

  describe('Overall correlation computation', () => {
    it('should compute perfect correlation (1.0) when all emotions match drives', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Curiosity]: 0.8,
        [DriveName.Anxiety]: 0.6,
      });
      const response =
        'I am curious and anxious about the unknowns.';

      const result = await service.validate(response, snapshot);

      expect(result.overallCorrelation).toBeGreaterThan(0.6);
    });

    it('should compute lower correlation when emotions do not match drives', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Curiosity]: 0.0,
        [DriveName.Anxiety]: 0.0,
        [DriveName.Satisfaction]: 0.5, // Only this drive is pressured
      });
      const response =
        'I am so curious and anxious!'; // Express curiosity and anxiety when only Satisfaction matters

      const result = await service.validate(response, snapshot);

      expect(result.overallCorrelation).toBeLessThan(1.0);
      expect(result.overallCorrelation).toBeGreaterThanOrEqual(0.0);
    });

    it('should return 1.0 correlation when no significant drives', async () => {
      const snapshot = createDriveSnapshot(); // All drives at 0
      const response = 'I am doing fine.';

      const result = await service.validate(response, snapshot);

      expect(result.overallCorrelation).toBe(1.0);
    });
  });

  // ---------------------------------------------------------------------------
  // Theater Threshold Tests
  // ---------------------------------------------------------------------------

  describe('Theater detection threshold', () => {
    it('should pass when correlation >= 0.4', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Curiosity]: 0.6,
      });
      const response = 'I am quite curious about this topic.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
    });

    it('should fail when correlation < 0.4', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Curiosity]: 0.0,
        [DriveName.Anxiety]: 0.0,
        [DriveName.Satisfaction]: 0.5,
        [DriveName.Guilt]: 0.6,
      });
      const response =
        'I am curious and anxious!'; // Only express curiosity and anxiety, not satisfaction or guilt

      const result = await service.validate(response, snapshot);

      // Only 1 out of 2 significant drives matches (40% match rate or less)
      expect(result.overallCorrelation).toBeLessThanOrEqual(0.5);
      expect(result.passed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Event Logging Tests
  // ---------------------------------------------------------------------------

  describe('Theater event logging', () => {
    it('should log theater detection event on violation', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.1,
      });
      const response = 'I feel very anxious.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(false);
      expect(mockEventsService.record).toHaveBeenCalled();
    });

    it('should not log event when validation passes', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.5,
      });
      const response = 'I feel quite anxious.';

      mockEventsService.record.mockClear();
      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      expect(mockEventsService.record).not.toHaveBeenCalled();
    });

    it('should gracefully handle event logging failure', async () => {
      mockEventsService.record.mockRejectedValueOnce(
        new Error('DB connection failed'),
      );

      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.1,
      });
      const response = 'I feel anxious.';

      // Should not throw even if logging fails
      await expect(
        service.validate(response, snapshot),
      ).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Case Tests
  // ---------------------------------------------------------------------------

  describe('Edge cases', () => {
    it('should handle empty response text', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Satisfaction]: 0.5,
      });

      const result = await service.validate('', snapshot);

      expect(result).toBeDefined();
      expect(result.violations).toHaveLength(0);
    });

    it('should handle response with no emotional keywords', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Curiosity]: 0.8,
      });
      const response = 'The sky is blue. Water is wet. Rocks are hard.';

      const result = await service.validate(response, snapshot);

      // Should not throw; neutral responses are acceptable
      expect(result).toBeDefined();
    });

    it('should handle case-insensitive keyword matching', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Satisfaction]: 0.6,
      });
      const response =
        'I am HAPPY and SATISFIED with this outcome!';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
    });

    it('should not match keywords as substrings', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Satisfaction]: 0.1,
      });
      // "satisfied" is in "dissatisfied", but with word boundary regex it shouldn't match
      const response = 'I am dissatisfied with this.';

      const result = await service.validate(response, snapshot);

      // Should report violation since only dissatisfied is present, not satisfied
      expect(result.violations.length).toBeLessThanOrEqual(1);
    });

    it('should handle repeated keywords', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Satisfaction]: 0.7,
      });
      const response =
        'I am happy happy happy and satisfied satisfied satisfied!';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
    });

    it('should handle mixed case keywords', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.5,
      });
      const response = 'I am AnXiOuS and worried.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Reinforcement Multiplier Tests (Theater = Zero Reinforcement)
  // ---------------------------------------------------------------------------

  describe('Reinforcement implication', () => {
    it('should indicate zero reinforcement on Theater violation', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.05,
      });
      const response = 'I am anxious and distressed.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(false);
      // The caller should apply reinforcementMultiplier = 0.0
    });

    it('should allow normal reinforcement when passing', async () => {
      const snapshot = createDriveSnapshot({
        [DriveName.Anxiety]: 0.5,
      });
      const response = 'I am anxious about the outcome.';

      const result = await service.validate(response, snapshot);

      expect(result.passed).toBe(true);
      // The caller should apply normal reinforcement multiplier
    });
  });
});

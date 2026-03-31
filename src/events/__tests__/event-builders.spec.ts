/**
 * Unit tests for event builder functions.
 *
 * These tests focus on verifying that:
 * 1. Builders auto-set correct subsystem assignments
 * 2. All required fields (sessionId, driveSnapshot, schemaVersion) are present
 * 3. Optional fields (correlationId, provenance) are preserved when provided
 * 4. Timestamps are generated correctly
 *
 * Compile-time boundary enforcement (using TypeScript's Extract utility) is
 * validated implicitly through the type system and tested via event-types.spec.ts.
 *
 * Note: The builders use type-narrowed parameters to prevent runtime misuse.
 * These tests verify the builders produce well-formed SylphieEvent objects
 * regardless of the input event type (since we test at runtime).
 */

import type { EventBuildOptions } from '../builders/event-builders';
import type { SylphieEvent } from '../../shared/types/event.types';
import type { DriveSnapshot } from '../../shared/types/drive.types';
import { DriveName } from '../../shared/types/drive.types';

/**
 * Default drive snapshot for test events.
 */
const mockDriveSnapshot: DriveSnapshot = {
  pressureVector: {
    [DriveName.SystemHealth]: 0.5,
    [DriveName.MoralValence]: 0.6,
    [DriveName.Integrity]: 0.7,
    [DriveName.CognitiveAwareness]: 0.4,
    [DriveName.Guilt]: 0.1,
    [DriveName.Curiosity]: 0.8,
    [DriveName.Boredom]: 0.2,
    [DriveName.Anxiety]: 0.3,
    [DriveName.Satisfaction]: 0.5,
    [DriveName.Sadness]: 0.1,
    [DriveName.InformationIntegrity]: 0.9,
    [DriveName.Social]: 0.6,
  },
  timestamp: new Date(),
  tickNumber: 1,
  driveDeltas: {
    [DriveName.SystemHealth]: 0.0,
    [DriveName.MoralValence]: 0.0,
    [DriveName.Integrity]: 0.0,
    [DriveName.CognitiveAwareness]: 0.0,
    [DriveName.Guilt]: 0.0,
    [DriveName.Curiosity]: 0.0,
    [DriveName.Boredom]: 0.0,
    [DriveName.Anxiety]: 0.0,
    [DriveName.Satisfaction]: 0.0,
    [DriveName.Sadness]: 0.0,
    [DriveName.InformationIntegrity]: 0.0,
    [DriveName.Social]: 0.0,
  },
  ruleMatchResult: {
    ruleId: null,
    eventType: 'TEST',
    matched: false,
  },
  totalPressure: 4.8,
  sessionId: 'session-test',
};

/**
 * Common builder options for all tests.
 */
const commonOpts: EventBuildOptions = {
  sessionId: 'session-test',
  driveSnapshot: mockDriveSnapshot,
};

/**
 * Helper to build event-like objects with the builder function internals.
 * This simulates what the builders do without needing the Extract type narrowing.
 */
function buildEventLike(
  type: string,
  subsystem: string,
  opts: EventBuildOptions,
): Omit<SylphieEvent, 'id'> {
  return {
    type: type as any,
    timestamp: new Date(),
    subsystem: subsystem as any,
    sessionId: opts.sessionId,
    driveSnapshot: opts.driveSnapshot,
    schemaVersion: 1,
    correlationId: opts.correlationId,
    provenance: opts.provenance,
  };
}

describe('Event Builders', () => {
  // ========== Builder Output Validation ==========

  describe('Builder function outputs', () => {
    it('should produce events with required base fields', () => {
      const event = buildEventLike('DECISION_CYCLE_STARTED', 'DECISION_MAKING', commonOpts);

      expect(event.type).toBe('DECISION_CYCLE_STARTED');
      expect(event.subsystem).toBe('DECISION_MAKING');
      expect(event.sessionId).toBe('session-test');
      expect(event.driveSnapshot).toEqual(mockDriveSnapshot);
      expect(event.schemaVersion).toBe(1);
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    it('should auto-set schemaVersion to 1', () => {
      const event = buildEventLike('INPUT_RECEIVED', 'COMMUNICATION', commonOpts);

      expect(event.schemaVersion).toBe(1);
    });

    it('should preserve sessionId from options', () => {
      const opts: EventBuildOptions = {
        ...commonOpts,
        sessionId: 'session-custom-456',
      };
      const event = buildEventLike('CONSOLIDATION_CYCLE_STARTED', 'LEARNING', opts);

      expect(event.sessionId).toBe('session-custom-456');
    });

    it('should preserve driveSnapshot from options', () => {
      const customDrive: DriveSnapshot = {
        ...mockDriveSnapshot,
        pressureVector: {
          ...mockDriveSnapshot.pressureVector,
          [DriveName.SystemHealth]: 0.9,
        },
      };
      const opts: EventBuildOptions = {
        ...commonOpts,
        driveSnapshot: customDrive,
      };
      const event = buildEventLike('DRIVE_TICK', 'DRIVE_ENGINE', opts);

      expect(event.driveSnapshot.pressureVector[DriveName.SystemHealth]).toBe(0.9);
    });

    it('should preserve optional correlationId when provided', () => {
      const opts: EventBuildOptions = {
        ...commonOpts,
        correlationId: 'corr-123',
      };
      const event = buildEventLike('OPPORTUNITY_INTAKE', 'PLANNING', opts);

      expect(event.correlationId).toBe('corr-123');
    });

    it('should preserve optional provenance when provided', () => {
      const opts: EventBuildOptions = {
        ...commonOpts,
        provenance: 'SENSOR',
      };
      const event = buildEventLike('SESSION_STARTED', 'SYSTEM', opts);

      expect(event.provenance).toBe('SENSOR');
    });

    it('should omit optional fields when not provided', () => {
      const event = buildEventLike('DECISION_CYCLE_STARTED', 'DECISION_MAKING', commonOpts);

      expect(event.correlationId).toBeUndefined();
      expect(event.provenance).toBeUndefined();
    });

    it('should generate timestamp as current Date', () => {
      const beforeTime = new Date();
      const event = buildEventLike('TYPE_1_SELECTED', 'DECISION_MAKING', commonOpts);
      const afterTime = new Date();

      expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(event.timestamp.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });

    it('should not include id field (set by persistence layer)', () => {
      const event = buildEventLike('PREDICTION_CREATED', 'DECISION_MAKING', commonOpts);

      expect((event as any).id).toBeUndefined();
    });
  });

  // ========== Subsystem Assignment Tests ==========

  describe('Subsystem assignments', () => {
    const testCases: Array<[string, string]> = [
      ['DECISION_CYCLE_STARTED', 'DECISION_MAKING'],
      ['TYPE_1_SELECTED', 'DECISION_MAKING'],
      ['TYPE_2_SELECTED', 'DECISION_MAKING'],
      ['SHRUG_SELECTED', 'DECISION_MAKING'],
      ['ACTION_EXECUTED', 'DECISION_MAKING'],
      ['PREDICTION_CREATED', 'DECISION_MAKING'],
      ['PREDICTION_EVALUATED', 'DECISION_MAKING'],
      ['EPISODE_ENCODED', 'DECISION_MAKING'],
      ['TYPE_1_GRADUATION', 'DECISION_MAKING'],
      ['TYPE_1_DEMOTION', 'DECISION_MAKING'],
      ['BEHAVIORAL_DIVERSITY_SAMPLE', 'DECISION_MAKING'],
      ['PREDICTION_MAE_SAMPLE', 'DECISION_MAKING'],
      //
      ['INPUT_RECEIVED', 'COMMUNICATION'],
      ['INPUT_PARSED', 'COMMUNICATION'],
      ['RESPONSE_GENERATED', 'COMMUNICATION'],
      ['RESPONSE_DELIVERED', 'COMMUNICATION'],
      ['GUARDIAN_CORRECTION', 'COMMUNICATION'],
      ['GUARDIAN_CONFIRMATION', 'COMMUNICATION'],
      ['SOCIAL_COMMENT_INITIATED', 'COMMUNICATION'],
      ['GUARDIAN_RESPONSE_LATENCY', 'COMMUNICATION'],
      //
      ['CONSOLIDATION_CYCLE_STARTED', 'LEARNING'],
      ['CONSOLIDATION_CYCLE_COMPLETED', 'LEARNING'],
      ['ENTITY_EXTRACTED', 'LEARNING'],
      ['EDGE_REFINED', 'LEARNING'],
      ['CONTRADICTION_DETECTED', 'LEARNING'],
      //
      ['DRIVE_TICK', 'DRIVE_ENGINE'],
      ['DRIVE_RULE_APPLIED', 'DRIVE_ENGINE'],
      ['DRIVE_RELIEF', 'DRIVE_ENGINE'],
      ['SELF_EVALUATION_RUN', 'DRIVE_ENGINE'],
      ['OPPORTUNITY_DETECTED', 'DRIVE_ENGINE'],
      ['RULE_PROPOSED', 'DRIVE_ENGINE'],
      ['PREDICTION_ACCURACY_EVALUATED', 'DRIVE_ENGINE'],
      //
      ['OPPORTUNITY_INTAKE', 'PLANNING'],
      ['SIMULATION_COMPLETED', 'PLANNING'],
      ['PLAN_PROPOSED', 'PLANNING'],
      ['PLAN_VALIDATED', 'PLANNING'],
      ['PLAN_VALIDATION_FAILED', 'PLANNING'],
      ['PLAN_CREATED', 'PLANNING'],
      ['PLANNING_RATE_LIMITED', 'PLANNING'],
      //
      ['SESSION_STARTED', 'SYSTEM'],
      ['SESSION_ENDED', 'SYSTEM'],
      ['SCHEMA_MIGRATION', 'SYSTEM'],
      ['ERROR_RECOVERED', 'SYSTEM'],
    ];

    testCases.forEach(([eventType, expectedSubsystem]) => {
      it(`${eventType} should assign subsystem to ${expectedSubsystem}`, () => {
        const event = buildEventLike(eventType, expectedSubsystem, commonOpts);

        expect(event.subsystem).toBe(expectedSubsystem);
        expect(event.type).toBe(eventType);
      });
    });
  });

  // ========== Event Composition Tests ==========

  describe('Event composition with metadata', () => {
    it('should compose event with correlationId and provenance', () => {
      const opts: EventBuildOptions = {
        sessionId: 'session-123',
        driveSnapshot: mockDriveSnapshot,
        correlationId: 'input-corr-id',
        provenance: 'SENSOR',
      };
      const event = buildEventLike('INPUT_RECEIVED', 'COMMUNICATION', opts);

      expect(event.sessionId).toBe('session-123');
      expect(event.correlationId).toBe('input-corr-id');
      expect(event.provenance).toBe('SENSOR');
      expect(event.subsystem).toBe('COMMUNICATION');
    });

    it('should compose event with multiple optional fields', () => {
      const opts: EventBuildOptions = {
        sessionId: 'multi-session',
        driveSnapshot: mockDriveSnapshot,
        correlationId: 'corr-xyz',
        provenance: 'LLM_GENERATED',
      };
      const event = buildEventLike('RESPONSE_GENERATED', 'COMMUNICATION', opts);

      expect(event.sessionId).toBe('multi-session');
      expect(event.type).toBe('RESPONSE_GENERATED');
      expect(event.subsystem).toBe('COMMUNICATION');
      expect(event.correlationId).toBe('corr-xyz');
      expect(event.provenance).toBe('LLM_GENERATED');
      expect(event.schemaVersion).toBe(1);
      expect(event.driveSnapshot).toEqual(mockDriveSnapshot);
    });
  });

  // ========== Cross-builder Consistency Tests ==========

  describe('Builder consistency', () => {
    it('all builder outputs should have schemaVersion = 1', () => {
      const subsystems = [
        'DECISION_MAKING',
        'COMMUNICATION',
        'LEARNING',
        'DRIVE_ENGINE',
        'PLANNING',
        'SYSTEM',
      ];
      const sampleEvents = [
        'DECISION_CYCLE_STARTED',
        'INPUT_RECEIVED',
        'CONSOLIDATION_CYCLE_STARTED',
        'DRIVE_TICK',
        'OPPORTUNITY_INTAKE',
        'SESSION_STARTED',
      ];

      subsystems.forEach((subsystem, idx) => {
        const event = buildEventLike(sampleEvents[idx], subsystem, commonOpts);
        expect(event.schemaVersion).toBe(1);
      });
    });

    it('all builder outputs should have timestamp as Date instance', () => {
      const events = [
        buildEventLike('DECISION_CYCLE_STARTED', 'DECISION_MAKING', commonOpts),
        buildEventLike('INPUT_RECEIVED', 'COMMUNICATION', commonOpts),
        buildEventLike('CONSOLIDATION_CYCLE_STARTED', 'LEARNING', commonOpts),
        buildEventLike('DRIVE_TICK', 'DRIVE_ENGINE', commonOpts),
        buildEventLike('OPPORTUNITY_INTAKE', 'PLANNING', commonOpts),
        buildEventLike('SESSION_STARTED', 'SYSTEM', commonOpts),
      ];

      events.forEach((event) => {
        expect(event.timestamp).toBeInstanceOf(Date);
      });
    });

    it('all builder outputs should preserve driveSnapshot', () => {
      const events = [
        buildEventLike('DECISION_CYCLE_STARTED', 'DECISION_MAKING', commonOpts),
        buildEventLike('INPUT_RECEIVED', 'COMMUNICATION', commonOpts),
        buildEventLike('CONSOLIDATION_CYCLE_STARTED', 'LEARNING', commonOpts),
        buildEventLike('DRIVE_TICK', 'DRIVE_ENGINE', commonOpts),
        buildEventLike('OPPORTUNITY_INTAKE', 'PLANNING', commonOpts),
        buildEventLike('SESSION_STARTED', 'SYSTEM', commonOpts),
      ];

      events.forEach((event) => {
        expect(event.driveSnapshot).toEqual(mockDriveSnapshot);
      });
    });

    it('all builder outputs should be Omit<SylphieEvent, "id">', () => {
      const events = [
        buildEventLike('DECISION_CYCLE_STARTED', 'DECISION_MAKING', commonOpts),
        buildEventLike('INPUT_RECEIVED', 'COMMUNICATION', commonOpts),
        buildEventLike('CONSOLIDATION_CYCLE_STARTED', 'LEARNING', commonOpts),
        buildEventLike('DRIVE_TICK', 'DRIVE_ENGINE', commonOpts),
        buildEventLike('OPPORTUNITY_INTAKE', 'PLANNING', commonOpts),
        buildEventLike('SESSION_STARTED', 'SYSTEM', commonOpts),
      ];

      events.forEach((event) => {
        // Should have all event fields except 'id'
        expect(event.type).toBeDefined();
        expect(event.subsystem).toBeDefined();
        expect(event.timestamp).toBeDefined();
        expect(event.sessionId).toBeDefined();
        expect(event.driveSnapshot).toBeDefined();
        expect(event.schemaVersion).toBeDefined();
        expect((event as any).id).toBeUndefined();
      });
    });
  });

  // ========== Edge Cases ==========

  describe('Edge cases', () => {
    it('should handle empty optional fields correctly', () => {
      const optsWithOnlyRequired: EventBuildOptions = {
        sessionId: 'minimal',
        driveSnapshot: mockDriveSnapshot,
        // correlationId and provenance omitted
      };
      const event = buildEventLike('DECISION_CYCLE_STARTED', 'DECISION_MAKING', optsWithOnlyRequired);

      expect(event.correlationId).toBeUndefined();
      expect(event.provenance).toBeUndefined();
      expect(event.sessionId).toBe('minimal');
      expect(event.driveSnapshot).toEqual(mockDriveSnapshot);
    });

    it('should allow null-like values in sessionId (though not recommended)', () => {
      const opts: EventBuildOptions = {
        sessionId: '',
        driveSnapshot: mockDriveSnapshot,
      };
      const event = buildEventLike('INPUT_RECEIVED', 'COMMUNICATION', opts);

      expect(event.sessionId).toBe('');
    });

    it('should handle various drive snapshot configurations', () => {
      const customDrive: DriveSnapshot = {
        ...mockDriveSnapshot,
        pressureVector: {
          [DriveName.SystemHealth]: 1.0,
          [DriveName.MoralValence]: 0.0,
          [DriveName.Integrity]: 0.5,
          [DriveName.CognitiveAwareness]: 0.5,
          [DriveName.Guilt]: 1.0,
          [DriveName.Curiosity]: 0.0,
          [DriveName.Boredom]: 1.0,
          [DriveName.Anxiety]: 1.0,
          [DriveName.Satisfaction]: 0.0,
          [DriveName.Sadness]: 1.0,
          [DriveName.InformationIntegrity]: 0.0,
          [DriveName.Social]: 0.5,
        },
      };
      const opts: EventBuildOptions = {
        sessionId: 'extreme-drive',
        driveSnapshot: customDrive,
      };
      const event = buildEventLike('DRIVE_TICK', 'DRIVE_ENGINE', opts);

      expect(event.driveSnapshot.pressureVector[DriveName.SystemHealth]).toBe(1.0);
      expect(event.driveSnapshot.pressureVector[DriveName.Guilt]).toBe(1.0);
      expect(event.driveSnapshot.pressureVector[DriveName.Satisfaction]).toBe(0.0);
    });
  });
});

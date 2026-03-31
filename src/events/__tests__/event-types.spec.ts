/**
 * Unit tests for event type system: boundaries, validation, and type safety.
 *
 * Tests verify:
 * - SubsystemSource has exactly 6 values
 * - EVENT_BOUNDARY_MAP covers all EventType values
 * - EVENT_TYPE_BOUNDARIES is the inverse of EVENT_BOUNDARY_MAP
 * - validateEventBoundary() accepts valid and rejects invalid pairs
 * - All event types appear exactly once in the boundary maps
 */

import {
  EVENT_BOUNDARY_MAP,
  EVENT_TYPE_BOUNDARIES,
  validateEventBoundary,
  type SubsystemSource,
  type EventType,
} from '../../shared/types/event.types';

describe('Event Type System', () => {
  // ========== SubsystemSource Tests ==========

  describe('SubsystemSource enumeration', () => {
    it('should have exactly 6 subsystems (5 core + SYSTEM)', () => {
      const subsystems: SubsystemSource[] = [
        'DECISION_MAKING',
        'COMMUNICATION',
        'LEARNING',
        'DRIVE_ENGINE',
        'PLANNING',
        'SYSTEM',
      ];

      expect(subsystems).toHaveLength(6);
    });

    it('EVENT_TYPE_BOUNDARIES should have entries for all 6 subsystems', () => {
      const subsystems = Object.keys(EVENT_TYPE_BOUNDARIES) as SubsystemSource[];

      expect(subsystems).toContain('DECISION_MAKING');
      expect(subsystems).toContain('COMMUNICATION');
      expect(subsystems).toContain('LEARNING');
      expect(subsystems).toContain('DRIVE_ENGINE');
      expect(subsystems).toContain('PLANNING');
      expect(subsystems).toContain('SYSTEM');
      expect(subsystems).toHaveLength(6);
    });
  });

  // ========== EVENT_BOUNDARY_MAP Tests ==========

  describe('EVENT_BOUNDARY_MAP', () => {
    it('should map all DECISION_MAKING event types', () => {
      const decisionTypes: EventType[] = [
        'DECISION_CYCLE_STARTED',
        'TYPE_1_SELECTED',
        'TYPE_2_SELECTED',
        'SHRUG_SELECTED',
        'ACTION_EXECUTED',
        'PREDICTION_CREATED',
        'PREDICTION_EVALUATED',
        'EPISODE_ENCODED',
        'TYPE_1_GRADUATION',
        'TYPE_1_DEMOTION',
        'BEHAVIORAL_DIVERSITY_SAMPLE',
        'PREDICTION_MAE_SAMPLE',
      ];

      decisionTypes.forEach((type) => {
        expect(EVENT_BOUNDARY_MAP[type]).toBe('DECISION_MAKING');
      });
    });

    it('should map all COMMUNICATION event types', () => {
      const commTypes: EventType[] = [
        'INPUT_RECEIVED',
        'INPUT_PARSED',
        'RESPONSE_GENERATED',
        'RESPONSE_DELIVERED',
        'GUARDIAN_CORRECTION',
        'GUARDIAN_CONFIRMATION',
        'SOCIAL_COMMENT_INITIATED',
        'GUARDIAN_RESPONSE_LATENCY',
      ];

      commTypes.forEach((type) => {
        expect(EVENT_BOUNDARY_MAP[type]).toBe('COMMUNICATION');
      });
    });

    it('should map all LEARNING event types', () => {
      const learnTypes: EventType[] = [
        'CONSOLIDATION_CYCLE_STARTED',
        'CONSOLIDATION_CYCLE_COMPLETED',
        'ENTITY_EXTRACTED',
        'EDGE_REFINED',
        'CONTRADICTION_DETECTED',
      ];

      learnTypes.forEach((type) => {
        expect(EVENT_BOUNDARY_MAP[type]).toBe('LEARNING');
      });
    });

    it('should map all DRIVE_ENGINE event types', () => {
      const driveTypes: EventType[] = [
        'DRIVE_TICK',
        'DRIVE_RULE_APPLIED',
        'DRIVE_RELIEF',
        'SELF_EVALUATION_RUN',
        'OPPORTUNITY_DETECTED',
        'RULE_PROPOSED',
        'PREDICTION_ACCURACY_EVALUATED',
      ];

      driveTypes.forEach((type) => {
        expect(EVENT_BOUNDARY_MAP[type]).toBe('DRIVE_ENGINE');
      });
    });

    it('should map all PLANNING event types', () => {
      const planTypes: EventType[] = [
        'OPPORTUNITY_INTAKE',
        'SIMULATION_COMPLETED',
        'PLAN_PROPOSED',
        'PLAN_VALIDATED',
        'PLAN_VALIDATION_FAILED',
        'PLAN_CREATED',
        'PLANNING_RATE_LIMITED',
      ];

      planTypes.forEach((type) => {
        expect(EVENT_BOUNDARY_MAP[type]).toBe('PLANNING');
      });
    });

    it('should map all SYSTEM event types', () => {
      const sysTypes: EventType[] = [
        'SESSION_STARTED',
        'SESSION_ENDED',
        'SCHEMA_MIGRATION',
        'ERROR_RECOVERED',
      ];

      sysTypes.forEach((type) => {
        expect(EVENT_BOUNDARY_MAP[type]).toBe('SYSTEM');
      });
    });

    it('should be exhaustive (no unmapped event types)', () => {
      // Count all expected event types
      const allExpectedTypes = [
        // Decision Making (12)
        'DECISION_CYCLE_STARTED',
        'TYPE_1_SELECTED',
        'TYPE_2_SELECTED',
        'SHRUG_SELECTED',
        'ACTION_EXECUTED',
        'PREDICTION_CREATED',
        'PREDICTION_EVALUATED',
        'EPISODE_ENCODED',
        'TYPE_1_GRADUATION',
        'TYPE_1_DEMOTION',
        'BEHAVIORAL_DIVERSITY_SAMPLE',
        'PREDICTION_MAE_SAMPLE',
        // Communication (8)
        'INPUT_RECEIVED',
        'INPUT_PARSED',
        'RESPONSE_GENERATED',
        'RESPONSE_DELIVERED',
        'GUARDIAN_CORRECTION',
        'GUARDIAN_CONFIRMATION',
        'SOCIAL_COMMENT_INITIATED',
        'GUARDIAN_RESPONSE_LATENCY',
        // Learning (5)
        'CONSOLIDATION_CYCLE_STARTED',
        'CONSOLIDATION_CYCLE_COMPLETED',
        'ENTITY_EXTRACTED',
        'EDGE_REFINED',
        'CONTRADICTION_DETECTED',
        // Drive Engine (7)
        'DRIVE_TICK',
        'DRIVE_RULE_APPLIED',
        'DRIVE_RELIEF',
        'SELF_EVALUATION_RUN',
        'OPPORTUNITY_DETECTED',
        'RULE_PROPOSED',
        'PREDICTION_ACCURACY_EVALUATED',
        // Planning (7)
        'OPPORTUNITY_INTAKE',
        'SIMULATION_COMPLETED',
        'PLAN_PROPOSED',
        'PLAN_VALIDATED',
        'PLAN_VALIDATION_FAILED',
        'PLAN_CREATED',
        'PLANNING_RATE_LIMITED',
        // System (4)
        'SESSION_STARTED',
        'SESSION_ENDED',
        'SCHEMA_MIGRATION',
        'ERROR_RECOVERED',
      ] as EventType[];

      const mappedTypes = Object.keys(EVENT_BOUNDARY_MAP) as EventType[];
      expect(mappedTypes).toHaveLength(allExpectedTypes.length);
    });
  });

  // ========== EVENT_TYPE_BOUNDARIES Tests ==========

  describe('EVENT_TYPE_BOUNDARIES (inverse map)', () => {
    it('should have DECISION_MAKING with 12 event types', () => {
      const types = EVENT_TYPE_BOUNDARIES['DECISION_MAKING'];
      expect(types).toHaveLength(12);
      expect(types).toContain('DECISION_CYCLE_STARTED');
      expect(types).toContain('TYPE_1_SELECTED');
      expect(types).toContain('BEHAVIORAL_DIVERSITY_SAMPLE');
    });

    it('should have COMMUNICATION with 8 event types', () => {
      const types = EVENT_TYPE_BOUNDARIES['COMMUNICATION'];
      expect(types).toHaveLength(8);
      expect(types).toContain('INPUT_RECEIVED');
      expect(types).toContain('GUARDIAN_CORRECTION');
      expect(types).toContain('GUARDIAN_RESPONSE_LATENCY');
    });

    it('should have LEARNING with 5 event types', () => {
      const types = EVENT_TYPE_BOUNDARIES['LEARNING'];
      expect(types).toHaveLength(5);
      expect(types).toContain('CONSOLIDATION_CYCLE_STARTED');
      expect(types).toContain('ENTITY_EXTRACTED');
      expect(types).toContain('CONTRADICTION_DETECTED');
    });

    it('should have DRIVE_ENGINE with 7 event types', () => {
      const types = EVENT_TYPE_BOUNDARIES['DRIVE_ENGINE'];
      expect(types).toHaveLength(7);
      expect(types).toContain('DRIVE_TICK');
      expect(types).toContain('OPPORTUNITY_DETECTED');
      expect(types).toContain('PREDICTION_ACCURACY_EVALUATED');
    });

    it('should have PLANNING with 7 event types', () => {
      const types = EVENT_TYPE_BOUNDARIES['PLANNING'];
      expect(types).toHaveLength(7);
      expect(types).toContain('OPPORTUNITY_INTAKE');
      expect(types).toContain('PLAN_CREATED');
      expect(types).toContain('PLANNING_RATE_LIMITED');
    });

    it('should have SYSTEM with 4 event types', () => {
      const types = EVENT_TYPE_BOUNDARIES['SYSTEM'];
      expect(types).toHaveLength(4);
      expect(types).toContain('SESSION_STARTED');
      expect(types).toContain('SESSION_ENDED');
      expect(types).toContain('SCHEMA_MIGRATION');
      expect(types).toContain('ERROR_RECOVERED');
    });

    it('should be consistent with EVENT_BOUNDARY_MAP', () => {
      // For each event type in the map, verify it appears in the correct subsystem's boundaries list
      Object.entries(EVENT_BOUNDARY_MAP).forEach(([eventType, subsystem]) => {
        const types = EVENT_TYPE_BOUNDARIES[subsystem];
        expect(types).toContain(eventType as EventType);
      });
    });

    it('should have no duplicate event types across subsystems', () => {
      const allTypes: EventType[] = [];
      Object.values(EVENT_TYPE_BOUNDARIES).forEach((types) => {
        allTypes.push(...(types as EventType[]));
      });

      const uniqueTypes = new Set(allTypes);
      expect(allTypes).toHaveLength(uniqueTypes.size);
    });
  });

  // ========== validateEventBoundary() Tests ==========

  describe('validateEventBoundary()', () => {
    // Valid pairs
    it('should accept valid DECISION_MAKING events', () => {
      expect(validateEventBoundary('DECISION_CYCLE_STARTED', 'DECISION_MAKING')).toBe(true);
      expect(validateEventBoundary('TYPE_1_SELECTED', 'DECISION_MAKING')).toBe(true);
      expect(validateEventBoundary('PREDICTION_CREATED', 'DECISION_MAKING')).toBe(true);
    });

    it('should accept valid COMMUNICATION events', () => {
      expect(validateEventBoundary('INPUT_RECEIVED', 'COMMUNICATION')).toBe(true);
      expect(validateEventBoundary('GUARDIAN_CORRECTION', 'COMMUNICATION')).toBe(true);
      expect(validateEventBoundary('RESPONSE_DELIVERED', 'COMMUNICATION')).toBe(true);
    });

    it('should accept valid LEARNING events', () => {
      expect(validateEventBoundary('CONSOLIDATION_CYCLE_STARTED', 'LEARNING')).toBe(true);
      expect(validateEventBoundary('ENTITY_EXTRACTED', 'LEARNING')).toBe(true);
      expect(validateEventBoundary('CONTRADICTION_DETECTED', 'LEARNING')).toBe(true);
    });

    it('should accept valid DRIVE_ENGINE events', () => {
      expect(validateEventBoundary('DRIVE_TICK', 'DRIVE_ENGINE')).toBe(true);
      expect(validateEventBoundary('OPPORTUNITY_DETECTED', 'DRIVE_ENGINE')).toBe(true);
      expect(validateEventBoundary('PREDICTION_ACCURACY_EVALUATED', 'DRIVE_ENGINE')).toBe(true);
    });

    it('should accept valid PLANNING events', () => {
      expect(validateEventBoundary('OPPORTUNITY_INTAKE', 'PLANNING')).toBe(true);
      expect(validateEventBoundary('PLAN_CREATED', 'PLANNING')).toBe(true);
      expect(validateEventBoundary('PLANNING_RATE_LIMITED', 'PLANNING')).toBe(true);
    });

    it('should accept valid SYSTEM events', () => {
      expect(validateEventBoundary('SESSION_STARTED', 'SYSTEM')).toBe(true);
      expect(validateEventBoundary('SESSION_ENDED', 'SYSTEM')).toBe(true);
      expect(validateEventBoundary('ERROR_RECOVERED', 'SYSTEM')).toBe(true);
    });

    // Invalid pairs
    it('should reject LEARNING trying to emit DECISION_MAKING event', () => {
      expect(validateEventBoundary('PREDICTION_CREATED', 'LEARNING')).toBe(false);
      expect(validateEventBoundary('DECISION_CYCLE_STARTED', 'LEARNING')).toBe(false);
    });

    it('should reject COMMUNICATION trying to emit LEARNING event', () => {
      expect(validateEventBoundary('ENTITY_EXTRACTED', 'COMMUNICATION')).toBe(false);
      expect(validateEventBoundary('CONSOLIDATION_CYCLE_STARTED', 'COMMUNICATION')).toBe(false);
    });

    it('should reject DECISION_MAKING trying to emit DRIVE_ENGINE event', () => {
      expect(validateEventBoundary('DRIVE_TICK', 'DECISION_MAKING')).toBe(false);
      expect(validateEventBoundary('OPPORTUNITY_DETECTED', 'DECISION_MAKING')).toBe(false);
    });

    it('should reject PLANNING trying to emit DRIVE_ENGINE event', () => {
      expect(validateEventBoundary('DRIVE_RULE_APPLIED', 'PLANNING')).toBe(false);
      expect(validateEventBoundary('SELF_EVALUATION_RUN', 'PLANNING')).toBe(false);
    });

    it('should reject DRIVE_ENGINE trying to emit PLANNING event', () => {
      expect(validateEventBoundary('OPPORTUNITY_INTAKE', 'DRIVE_ENGINE')).toBe(false);
      expect(validateEventBoundary('PLAN_CREATED', 'DRIVE_ENGINE')).toBe(false);
    });

    it('should reject mismatches for all SYSTEM events', () => {
      expect(validateEventBoundary('SESSION_STARTED', 'DECISION_MAKING')).toBe(false);
      expect(validateEventBoundary('SESSION_ENDED', 'LEARNING')).toBe(false);
      expect(validateEventBoundary('SCHEMA_MIGRATION', 'COMMUNICATION')).toBe(false);
      expect(validateEventBoundary('ERROR_RECOVERED', 'PLANNING')).toBe(false);
    });
  });

  // ========== Bidirectional Consistency Tests ==========

  describe('Bidirectional consistency', () => {
    it('should maintain consistency between EVENT_BOUNDARY_MAP and EVENT_TYPE_BOUNDARIES', () => {
      // For every entry in EVENT_BOUNDARY_MAP, the event should appear in EVENT_TYPE_BOUNDARIES
      Object.entries(EVENT_BOUNDARY_MAP).forEach(([eventType, subsystem]) => {
        const boundaryTypes = EVENT_TYPE_BOUNDARIES[subsystem];
        expect(boundaryTypes).toContain(eventType as EventType);
      });
    });

    it('should have no orphaned entries in EVENT_TYPE_BOUNDARIES', () => {
      // Every event in EVENT_TYPE_BOUNDARIES should be in EVENT_BOUNDARY_MAP
      Object.entries(EVENT_TYPE_BOUNDARIES).forEach(([subsystem, eventTypes]) => {
        (eventTypes as EventType[]).forEach((eventType) => {
          expect(EVENT_BOUNDARY_MAP[eventType]).toBe(subsystem);
        });
      });
    });

    it('should have consistent validateEventBoundary with both maps', () => {
      // For every (eventType, subsystem) pair, validateEventBoundary should match the maps
      Object.entries(EVENT_BOUNDARY_MAP).forEach(([eventType, correctSubsystem]) => {
        expect(validateEventBoundary(eventType as EventType, correctSubsystem as SubsystemSource)).toBe(
          true,
        );

        // Try all wrong subsystems
        const allSubsystems: SubsystemSource[] = [
          'DECISION_MAKING',
          'COMMUNICATION',
          'LEARNING',
          'DRIVE_ENGINE',
          'PLANNING',
          'SYSTEM',
        ];

        allSubsystems.forEach((wrongSubsystem) => {
          if (wrongSubsystem !== correctSubsystem) {
            expect(validateEventBoundary(eventType as EventType, wrongSubsystem)).toBe(false);
          }
        });
      });
    });
  });

  // ========== Total Count Tests ==========

  describe('Total event count', () => {
    it('should have exactly 43 total event types', () => {
      const allTypes = Object.keys(EVENT_BOUNDARY_MAP);
      expect(allTypes).toHaveLength(43);
    });

    it('should account for all events in subsystems sum', () => {
      let totalCount = 0;
      Object.values(EVENT_TYPE_BOUNDARIES).forEach((types) => {
        totalCount += (types as EventType[]).length;
      });

      expect(totalCount).toBe(43);
    });
  });
});

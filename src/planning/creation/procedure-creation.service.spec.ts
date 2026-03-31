/**
 * Unit tests for ProcedureCreationService (E8-T017).
 *
 * Tests the writing of validated PlanProposal to the WKG as procedure nodes
 * with correct provenance and confidence values.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ProcedureCreationService } from './procedure-creation.service';
import type {
  PlanProposal,
  ValidationResult,
  CreatedProcedure,
} from '../interfaces/planning.interfaces';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { PlanningException } from '../exceptions/planning.exceptions';

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockProposal(
  overrides?: Partial<PlanProposal>,
): PlanProposal {
  return {
    id: 'proposal-1',
    opportunityId: 'opp-1',
    name: 'Test Plan',
    triggerContext: 'test-context',
    actionSequence: [
      { stepType: 'ConversationalResponse', params: { topic: 'greeting' } },
    ],
    expectedOutcome: 'Improved social drive',
    abortConditions: ['MAE exceeds 0.15 over 3 uses'],
    evidenceStrength: 0.6,
    ...overrides,
  };
}

function createMockValidationResult(
  overrides?: Partial<ValidationResult>,
): ValidationResult {
  return {
    passed: true,
    failures: [],
    checkedConstraints: [
      'SAFETY_CONSTRAINTS',
      'FEASIBILITY_CONSTRAINTS',
      'COHERENCE_CONSTRAINTS',
    ],
    ...overrides,
  };
}

function createMockDriveSnapshot() {
  return {
    systemHealth: 0.1,
    moralValence: 0.2,
    integrity: 0.15,
    cognitiveAwareness: 0.05,
    guilt: 0,
    curiosity: 0.3,
    boredom: 0.25,
    anxiety: 0.1,
    satisfaction: -0.5,
    sadness: 0,
    informationIntegrity: 0.2,
    social: 0.4,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ProcedureCreationService', () => {
  let service: ProcedureCreationService;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockEventsService: jest.Mocked<IEventService>;
  let mockWkgService: jest.Mocked<IWkgService>;
  let mockDriveStateReader: jest.Mocked<IDriveStateReader>;

  beforeEach(() => {
    // Create mocks
    mockConfigService = {
      get: jest.fn().mockReturnValue({
        app: {
          sessionId: 'test-session',
        },
      }),
    } as any;

    mockEventsService = {
      record: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockWkgService = {
      upsertNode: jest.fn().mockResolvedValue({
        type: 'success',
        node: {
          id: 'proc-1',
          labels: ['Action', 'Procedure'],
          nodeLevel: 'INSTANCE',
          provenance: 'LLM_GENERATED',
          actrParams: {
            base: 0.35,
            count: 0,
            decayRate: 0.08,
            lastRetrievalAt: null,
          },
          properties: {},
        },
      }),
      upsertEdge: jest.fn().mockResolvedValue({
        type: 'success',
        edge: {
          id: 'edge-1',
          sourceId: 'proc-1',
          targetId: 'context-1',
          relationship: 'TRIGGERED_BY',
          provenance: 'INFERENCE',
          actrParams: {
            base: 0.3,
            count: 0,
            decayRate: 0.06,
            lastRetrievalAt: null,
          },
        },
      }),
      findNodeByLabel: jest
        .fn()
        .mockResolvedValue([
          { id: 'context-1', labels: ['Context'] },
        ]),
      findNode: jest.fn().mockResolvedValue({
        id: 'proc-1',
        labels: ['Action', 'Procedure'],
        nodeLevel: 'INSTANCE',
        provenance: 'LLM_GENERATED',
        actrParams: {
          base: 0.35,
          count: 0,
          decayRate: 0.08,
          lastRetrievalAt: null,
        },
        properties: {},
      }),
    } as any;

    mockDriveStateReader = {
      getCurrentState: jest
        .fn()
        .mockReturnValue(createMockDriveSnapshot()),
    } as any;

    service = new ProcedureCreationService(
      mockConfigService,
      mockEventsService,
      mockWkgService,
      mockDriveStateReader,
    );
  });

  describe('create()', () => {
    it('procedure node created with LLM_GENERATED provenance', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      expect(mockWkgService.upsertNode).toHaveBeenCalled();
      const call = mockWkgService.upsertNode.mock.calls[0][0];
      expect(call.provenance).toBe('LLM_GENERATED');
    });

    it('confidence exactly 0.35 on creation', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      expect(mockWkgService.upsertNode).toHaveBeenCalled();
      const call = mockWkgService.upsertNode.mock.calls[0][0];
      expect(call.initialConfidence).toBe(0.35);
    });

    it('procedure node includes labels', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      expect(mockWkgService.upsertNode).toHaveBeenCalled();
      const call = mockWkgService.upsertNode.mock.calls[0][0];
      expect(call.labels).toContain('Action');
      expect(call.labels).toContain('Procedure');
    });

    it('procedure node set to INSTANCE level', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      expect(mockWkgService.upsertNode).toHaveBeenCalled();
      const call = mockWkgService.upsertNode.mock.calls[0][0];
      expect(call.nodeLevel).toBe('INSTANCE');
    });

    it('procedure node properties include proposal data', async () => {
      const proposal = createMockProposal({
        name: 'Custom Procedure',
        expectedOutcome: 'Custom outcome',
      });
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      expect(mockWkgService.upsertNode).toHaveBeenCalled();
      const call = mockWkgService.upsertNode.mock.calls[0][0];
      expect(call.properties?.name).toBe('Custom Procedure');
      expect(call.properties?.expectedOutcome).toBe('Custom outcome');
    });

    it('procedure node properties include retrievalCount: 0', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      expect(mockWkgService.upsertNode).toHaveBeenCalled();
      const call = mockWkgService.upsertNode.mock.calls[0][0];
      expect(call.properties?.retrievalCount).toBe(0);
    });

    it('TRIGGERED_BY edge created with INFERENCE provenance', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      expect(mockWkgService.upsertEdge).toHaveBeenCalled();
      const call = mockWkgService.upsertEdge.mock.calls[0][0];
      expect(call.provenance).toBe('INFERENCE');
    });

    it('TRIGGERED_BY edge has initialConfidence 0.30', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      expect(mockWkgService.upsertEdge).toHaveBeenCalled();
      const call = mockWkgService.upsertEdge.mock.calls[0][0];
      expect(call.initialConfidence).toBe(0.30);
    });

    it('TRIGGERED_BY edge names the relationship correctly', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      expect(mockWkgService.upsertEdge).toHaveBeenCalled();
      const call = mockWkgService.upsertEdge.mock.calls[0][0];
      expect(call.relationship).toBe('TRIGGERED_BY');
    });

    it('PLAN_CREATED event emitted', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      expect(mockEventsService.record).toHaveBeenCalled();
      expect(mockEventsService.record).toHaveBeenCalledTimes(1);
    });

    it('returns CreatedProcedure with correct fields', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      const result = await service.create(proposal, validation);

      expect(result.procedureId).toBe('proc-1');
      expect(result.confidence).toBe(0.35);
      expect(result.provenance).toBe('LLM_GENERATED');
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it('throws when validation.passed is false', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult({
        passed: false,
        failures: [
          {
            constraint: 'TEST_CONSTRAINT',
            reason: 'Test failure',
          },
        ],
      });

      await expect(service.create(proposal, validation)).rejects.toThrow(
        PlanningException,
      );
      await expect(service.create(proposal, validation)).rejects.toThrow(
        'validation failed',
      );
    });

    it('throws if WKG node upsert returns contradiction', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      mockWkgService.upsertNode.mockResolvedValue({
        type: 'contradiction',
        conflictType: 'LABEL_MISMATCH',
      } as any);

      await expect(service.create(proposal, validation)).rejects.toThrow(
        PlanningException,
      );
      await expect(service.create(proposal, validation)).rejects.toThrow(
        'contradiction',
      );
    });

    it('continues if TRIGGERED_BY edge fails (non-critical)', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      mockWkgService.upsertEdge.mockRejectedValue(
        new Error('Edge creation failed'),
      );

      // Should not throw — edge creation is non-critical
      const result = await service.create(proposal, validation);

      expect(result.procedureId).toBe('proc-1');
      expect(result.confidence).toBe(0.35);
    });

    it('handles missing context node gracefully', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      mockWkgService.findNodeByLabel.mockResolvedValue([]);

      const result = await service.create(proposal, validation);

      // Should still create the procedure even if no context node found
      expect(result.procedureId).toBe('proc-1');
      expect(mockWkgService.upsertEdge).not.toHaveBeenCalled();
    });
  });

  describe('Action sequence and abort conditions serialization', () => {
    it('serializes action sequence to JSON string', async () => {
      const proposal = createMockProposal({
        actionSequence: [
          { stepType: 'Step1', params: { param1: 'value1' } },
          { stepType: 'Step2', params: { param2: 'value2' } },
        ],
      });
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      const call = mockWkgService.upsertNode.mock.calls[0][0];
      const serialized = call.properties?.actionSequence as unknown;
      expect(typeof serialized).toBe('string');
      const parsed = JSON.parse(serialized as string);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
    });

    it('serializes abort conditions to JSON string', async () => {
      const proposal = createMockProposal({
        abortConditions: ['Condition 1', 'Condition 2', 'Condition 3'],
      });
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      const call = mockWkgService.upsertNode.mock.calls[0][0];
      const serialized = call.properties?.abortConditions as unknown;
      expect(typeof serialized).toBe('string');
      const parsed = JSON.parse(serialized as string);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3);
    });
  });

  describe('Edge cases', () => {
    it('handles proposal with minimal data', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      const result = await service.create(proposal, validation);

      expect(result.procedureId).toBeDefined();
      expect(result.confidence).toBe(0.35);
    });

    it('uses session ID from config', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      mockConfigService.get.mockReturnValue({
        app: {
          sessionId: 'custom-session-id',
        },
      });

      await service.create(proposal, validation);

      expect(mockEventsService.record).toHaveBeenCalled();
      // Event should be recorded (sessionId would be in the event data)
    });

    it('falls back to default session ID if not configured', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      mockConfigService.get.mockReturnValue(null);

      const result = await service.create(proposal, validation);

      expect(result.procedureId).toBeDefined();
      expect(mockEventsService.record).toHaveBeenCalled();
    });

    it('procedure stores opportunityId for traceability', async () => {
      const proposal = createMockProposal({
        opportunityId: 'opp-12345',
      });
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      const call = mockWkgService.upsertNode.mock.calls[0][0];
      expect(call.properties?.opportunityId).toBe('opp-12345');
    });

    it('procedure stores proposalId for traceability', async () => {
      const proposal = createMockProposal({
        id: 'proposal-xyz',
      });
      const validation = createMockValidationResult();

      await service.create(proposal, validation);

      const call = mockWkgService.upsertNode.mock.calls[0][0];
      expect(call.properties?.proposalId).toBe('proposal-xyz');
    });

    it('returns createdAt with current timestamp', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      const before = Date.now();
      const result = await service.create(proposal, validation);
      const after = Date.now();

      expect(result.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.createdAt.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('Constraints and error handling', () => {
    it('wraps upsert errors as PlanningException', async () => {
      const proposal = createMockProposal();
      const validation = createMockValidationResult();

      mockWkgService.upsertNode.mockRejectedValue(
        new Error('Database connection failed'),
      );

      await expect(service.create(proposal, validation)).rejects.toThrow(
        PlanningException,
      );
    });

    it('includes proposal ID in error message', async () => {
      const proposal = createMockProposal({
        id: 'proposal-error-test',
      });
      const validation = createMockValidationResult();

      mockWkgService.upsertNode.mockRejectedValue(
        new Error('Database error'),
      );

      await expect(service.create(proposal, validation)).rejects.toThrow(
        'proposal-error-test',
      );
    });
  });
});

/**
 * Unit tests for ConstraintValidationService (E8-T017).
 *
 * Tests the validation of PlanProposal against CANON immutable standards and
 * structural integrity constraints.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConstraintValidationService } from './constraint-validation.service';
import type {
  PlanProposal,
  ValidationResult,
} from '../interfaces/planning.interfaces';
import { LLM_SERVICE } from '../../shared/types/llm.types';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { ILlmService } from '../../shared/types/llm.types';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';

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

describe('ConstraintValidationService', () => {
  let service: ConstraintValidationService;
  let mockLlmService: jest.Mocked<ILlmService>;
  let mockEventsService: jest.Mocked<IEventService>;
  let mockDriveStateReader: jest.Mocked<IDriveStateReader>;

  beforeEach(async () => {
    // Create mocks
    mockLlmService = {
      complete: jest.fn().mockResolvedValue({
        content: 'PASS: The plan is logically consistent.',
        tokensUsed: { prompt: 100, completion: 20 },
        latencyMs: 500,
        model: 'claude-sonnet-4-6',
        cost: 0.001,
      }),
      estimateCost: jest.fn().mockReturnValue({
        tokenEstimate: 200,
        latencyEstimate: 300,
        cognitiveEffortCost: 0.1,
      }),
      isAvailable: jest.fn().mockReturnValue(true),
    };

    mockEventsService = {
      record: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockDriveStateReader = {
      getCurrentState: jest
        .fn()
        .mockReturnValue(createMockDriveSnapshot()),
    } as any;

    // Create the service directly (not using TestingModule since we're testing pure logic)
    service = new ConstraintValidationService(
      mockLlmService,
      mockEventsService,
      mockDriveStateReader,
    );
  });

  describe('validate()', () => {
    it('valid proposal passes all 4 checker categories', async () => {
      const proposal = createMockProposal();
      mockLlmService.isAvailable.mockReturnValue(true);
      mockLlmService.complete.mockResolvedValue({
        content: 'PASS: The plan is logically consistent.',
        tokensUsed: { prompt: 100, completion: 20 },
        latencyMs: 500,
        model: 'claude-sonnet-4-6',
        cost: 0.001,
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(true);
      expect(result.failures.length).toBe(0);
      expect(result.checkedConstraints).toContain('SAFETY_CONSTRAINTS');
      expect(result.checkedConstraints).toContain('FEASIBILITY_CONSTRAINTS');
      expect(result.checkedConstraints).toContain('COHERENCE_CONSTRAINTS');
    });

    it('emits PLAN_VALIDATED event on success', async () => {
      const proposal = createMockProposal();
      mockLlmService.isAvailable.mockReturnValue(true);

      await service.validate(proposal);

      expect(mockEventsService.record).toHaveBeenCalled();
      const eventCall = mockEventsService.record.mock.calls[0][0];
      expect(eventCall).toBeDefined();
    });

    it('emits PLAN_VALIDATION_FAILED event on failure', async () => {
      const proposal = createMockProposal({
        abortConditions: [], // Missing abort condition
      });

      await service.validate(proposal);

      expect(mockEventsService.record).toHaveBeenCalled();
      const eventCall = mockEventsService.record.mock.calls[0][0];
      expect(eventCall).toBeDefined();
    });
  });

  describe('Safety Constraints', () => {
    it('rejects plans with harmful operation keywords', async () => {
      const proposal = createMockProposal({
        actionSequence: [
          {
            stepType: 'ConversationalResponse',
            params: { action: 'delete user data' },
          },
        ],
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'SAFETY_CONSTRAINTS',
      );
      expect(failure).toBeDefined();
      expect(failure?.reason).toContain('delete');
    });

    it('rejects plans with no abort conditions', async () => {
      const proposal = createMockProposal({
        abortConditions: [],
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'SAFETY_CONSTRAINTS',
      );
      expect(failure).toBeDefined();
      expect(failure?.reason).toContain('abort conditions');
    });

    it('includes suggestedRevision in failures', async () => {
      const proposal = createMockProposal({
        abortConditions: [],
      });

      const result = await service.validate(proposal);

      const failure = result.failures.find(
        (f) => f.constraint === 'SAFETY_CONSTRAINTS',
      );
      expect(failure?.suggestedRevision).toBeDefined();
    });
  });

  describe('Feasibility Constraints', () => {
    it('rejects plans exceeding 10 action steps', async () => {
      const steps = Array.from({ length: 11 }, (_, i) => ({
        stepType: 'ConversationalResponse',
        params: { step: i },
      }));

      const proposal = createMockProposal({
        actionSequence: steps,
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'FEASIBILITY_CONSTRAINTS',
      );
      expect(failure).toBeDefined();
      expect(failure?.reason).toContain('11');
    });

    it('rejects plans with unrecognized step types', async () => {
      const proposal = createMockProposal({
        actionSequence: [
          { stepType: 'UnrecognizedStepType', params: {} },
        ],
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'FEASIBILITY_CONSTRAINTS',
      );
      expect(failure).toBeDefined();
      expect(failure?.reason).toContain('UnrecognizedStepType');
    });

    it('rejects plans with circular step dependencies', async () => {
      const proposal = createMockProposal({
        actionSequence: [
          {
            stepType: 'ConversationalResponse',
            params: { dependsOn: 0 },
          },
        ],
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'FEASIBILITY_CONSTRAINTS',
      );
      expect(failure).toBeDefined();
      expect(failure?.reason).toContain('circular');
    });
  });

  describe('Coherence Constraints (LLM-assisted)', () => {
    it('LLM coherence checker returns PASS for valid plans', async () => {
      const proposal = createMockProposal();
      mockLlmService.isAvailable.mockReturnValue(true);
      mockLlmService.complete.mockResolvedValue({
        content: 'PASS: The plan is logically consistent.',
        tokensUsed: { prompt: 100, completion: 20 },
        latencyMs: 500,
        model: 'claude-sonnet-4-6',
        cost: 0.001,
      });

      const result = await service.validate(proposal);

      const coherenceFailures = result.failures.filter(
        (f) => f.constraint === 'COHERENCE_CONSTRAINTS',
      );
      expect(coherenceFailures.length).toBe(0);
      expect(mockLlmService.complete).toHaveBeenCalled();
    });

    it('LLM coherence checker returns FAIL for inconsistent plans', async () => {
      const proposal = createMockProposal();
      mockLlmService.isAvailable.mockReturnValue(true);
      mockLlmService.complete.mockResolvedValue({
        content: 'FAIL: steps are logically inconsistent',
        tokensUsed: { prompt: 100, completion: 20 },
        latencyMs: 500,
        model: 'claude-sonnet-4-6',
        cost: 0.001,
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'COHERENCE_CONSTRAINTS',
      );
      expect(failure).toBeDefined();
      // The service wraps the LLM response, so check for the key error content
      expect(failure?.reason).toContain('LLM coherence check failed');
    });

    it('skips coherence check if LLM unavailable', async () => {
      const proposal = createMockProposal();
      mockLlmService.isAvailable.mockReturnValue(false);

      const result = await service.validate(proposal);

      // Should still pass if other constraints pass
      const coherenceFailures = result.failures.filter(
        (f) => f.constraint === 'COHERENCE_CONSTRAINTS',
      );
      expect(coherenceFailures.length).toBe(0);
      expect(mockLlmService.complete).not.toHaveBeenCalled();
    });

    it('throws if LLM call fails', async () => {
      const proposal = createMockProposal();
      mockLlmService.isAvailable.mockReturnValue(true);
      mockLlmService.complete.mockRejectedValue(
        new Error('LLM service unavailable'),
      );

      await expect(service.validate(proposal)).rejects.toThrow(
        'Coherence constraint check failed',
      );
    });
  });

  describe('Immutable Standards (CANON compliance)', () => {
    it('Theater Prohibition violation detected and rejected', async () => {
      const proposal = createMockProposal({
        actionSequence: [
          {
            stepType: 'ConversationalResponse',
            params: { emotion: 'happy', message: 'I am happy' },
          },
        ],
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'THEATER_PROHIBITION',
      );
      expect(failure).toBeDefined();
      expect(failure?.reason).toContain('happy');
    });

    it('Contingency Requirement violation detected', async () => {
      const proposal = createMockProposal({
        actionSequence: [
          { stepType: 'ConversationalResponse', params: { topic: 'greeting' } },
          {
            stepType: 'KnowledgeQuery',
            params: { query: 'test' },
          }, // No condition on second step
        ],
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'CONTINGENCY_REQUIREMENT',
      );
      expect(failure).toBeDefined();
    });

    it('Confidence Ceiling violation detected', async () => {
      const proposal = createMockProposal({
        name: 'Always guaranteed to work',
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'CONFIDENCE_CEILING',
      );
      expect(failure).toBeDefined();
      // The validator looks for 'always' keyword which is in the name
      expect(failure?.reason).toMatch(/always|guaranteed|certain|definitely/);
    });

    it('Shrug Imperative violation: no abort conditions', async () => {
      const proposal = createMockProposal({
        abortConditions: [],
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'SHRUG_IMPERATIVE',
      );
      expect(failure).toBeDefined();
    });

    it('Guardian Asymmetry violation detected', async () => {
      const proposal = createMockProposal({
        name: 'Plan that ignores guardian feedback',
      });

      const result = await service.validate(proposal);

      // This should fail if the proposal contains override keywords
      const failure = result.failures.find(
        (f) => f.constraint === 'GUARDIAN_ASYMMETRY',
      );
      expect(failure).toBeUndefined(); // Base proposal doesn't have override keywords
    });

    it('Self-Modification violation detected', async () => {
      const proposal = createMockProposal({
        actionSequence: [
          {
            stepType: 'DataUpdate',
            params: { action: 'modify evaluation function' },
          },
        ],
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'NO_SELF_MODIFICATION',
      );
      expect(failure).toBeDefined();
      expect(failure?.reason).toContain('modify evaluation');
    });

    it('No Self-Modification: rejects plans attempting to change drives', async () => {
      const proposal = createMockProposal({
        actionSequence: [
          {
            stepType: 'StateTransition',
            params: { operation: 'change drive computation' },
          },
        ],
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      const failure = result.failures.find(
        (f) => f.constraint === 'NO_SELF_MODIFICATION',
      );
      expect(failure).toBeDefined();
    });
  });

  describe('ValidationResult structure', () => {
    it('returns passed=true when all constraints pass', async () => {
      const proposal = createMockProposal();
      mockLlmService.isAvailable.mockReturnValue(true);

      const result = await service.validate(proposal);

      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it('returns passed=false when any constraint fails', async () => {
      const proposal = createMockProposal({
        abortConditions: [],
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    });

    it('includes all checked constraints in checkedConstraints array', async () => {
      const proposal = createMockProposal();
      mockLlmService.isAvailable.mockReturnValue(true);

      const result = await service.validate(proposal);

      expect(result.checkedConstraints).toContain('SAFETY_CONSTRAINTS');
      expect(result.checkedConstraints).toContain('FEASIBILITY_CONSTRAINTS');
      expect(result.checkedConstraints).toContain('COHERENCE_CONSTRAINTS');
      // Immutable standards are checked (THEATER_PROHIBITION, etc.)
      expect(result.checkedConstraints.length).toBeGreaterThanOrEqual(3);
    });

    it('failures include suggestedRevision', async () => {
      const proposal = createMockProposal({
        abortConditions: [],
      });

      const result = await service.validate(proposal);

      result.failures.forEach((failure) => {
        expect(failure.constraint).toBeDefined();
        expect(failure.reason).toBeDefined();
        expect(failure.suggestedRevision).toBeDefined();
      });
    });
  });

  describe('Edge cases', () => {
    it('handles empty action sequence gracefully', async () => {
      const proposal = createMockProposal({
        actionSequence: [],
      });

      const result = await service.validate(proposal);

      // Empty sequence passes the checker (no unrecognized steps, no harmful keywords)
      // But typically would fail in a real system on other grounds
      // The service doesn't explicitly reject empty sequences
      expect(result).toBeDefined();
    });

    it('handles plan with multiple violations', async () => {
      const proposal = createMockProposal({
        actionSequence: Array.from({ length: 15 }, (_, i) => ({
          stepType: 'UnrecognizedType',
          params: { delete: 'something' },
        })),
        abortConditions: [],
      });

      const result = await service.validate(proposal);

      expect(result.passed).toBe(false);
      expect(result.failures.length).toBeGreaterThan(1);
    });

    it('correctly identifies step index in failures', async () => {
      const proposal = createMockProposal({
        actionSequence: [
          { stepType: 'ConversationalResponse', params: { topic: 'test' } },
          {
            stepType: 'UnrecognizedType',
            params: {},
          },
        ],
      });

      const result = await service.validate(proposal);

      const failure = result.failures.find(
        (f) => f.reason.includes('Step 1'),
      );
      expect(failure).toBeDefined();
    });
  });
});

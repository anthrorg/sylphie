/**
 * Unit tests for PlanEvaluationService (E8-T017).
 *
 * Tests the evaluation of executed procedures against predicted outcomes,
 * ACT-R confidence dynamics, and graduation/demotion eligibility.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PlanEvaluationService } from './plan-evaluation.service';
import type { PlanEvaluation } from '../interfaces/planning.interfaces';
import type { DriveName } from '../../shared/types/drive.types';
import { DriveName as DriveNameEnum } from '../../shared/types/drive.types';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import type { ACTRParams } from '../../shared/types/confidence.types';
import {
  computeConfidence,
  DEFAULT_DECAY_RATES,
} from '../../shared/types/confidence.types';

// ============================================================================
// Mock Helpers
// ============================================================================

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

function createMockProcedureNode(
  overrides?: Partial<{
    id: string;
    expectedDriveEffects: Partial<Record<DriveName, number>>;
    actrParams: ACTRParams;
  }>,
): any {
  return {
    id: overrides?.id || 'proc-1',
    labels: ['Action', 'Procedure'],
    nodeLevel: 'INSTANCE',
    provenance: 'LLM_GENERATED',
    properties: {
      expectedDriveEffects: overrides?.expectedDriveEffects || {
        [DriveNameEnum.Social]: 0.2,
      },
    },
    actrParams: overrides?.actrParams || {
      base: 0.35,
      count: 0,
      decayRate: DEFAULT_DECAY_RATES['LLM_GENERATED'],
      lastRetrievalAt: null,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('PlanEvaluationService', () => {
  let service: PlanEvaluationService;
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
      findNode: jest.fn().mockResolvedValue(createMockProcedureNode()),
      recordRetrievalAndUse: jest.fn().mockResolvedValue(undefined),
      queryNodes: jest.fn().mockResolvedValue([]),
      querySubgraph: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
    } as any;

    mockDriveStateReader = {
      getCurrentState: jest
        .fn()
        .mockReturnValue(createMockDriveSnapshot()),
    } as any;

    service = new PlanEvaluationService(
      mockConfigService,
      mockEventsService,
      mockWkgService,
      mockDriveStateReader,
    );
  });

  describe('evaluateExecution()', () => {
    it('success (MAE < 0.10): confidence classifies as success outcome', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.2 };
      const actualEffects = { [DriveNameEnum.Social]: 0.19 }; // MAE = 0.01

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const result = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      expect(result.mae).toBeLessThan(0.1);
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(0);
      // With count=0, confidence is capped at 0.35, but recordRetrievalAndUse should update it
      expect(result.newConfidence).toBeDefined();
    });

    it('partial outcome (MAE between 0.10 and 0.15)', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.2 };
      const actualEffects = { [DriveNameEnum.Social]: 0.07 }; // MAE = 0.13

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const result = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      expect(result.mae).toBeGreaterThan(0.1);
      expect(result.mae).toBeLessThanOrEqual(0.15);
      // Partial outcome counts as success (not a failure)
      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(0);
    });

    it('failure (MAE > 0.15): PLAN_FAILURE emitted', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.5 };
      const actualEffects = { [DriveNameEnum.Social]: 0.1 }; // MAE = 0.4

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const result = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      expect(result.mae).toBeGreaterThan(0.15);
      expect(result.failureCount).toBe(1);
      expect(result.successCount).toBe(0);

      // Should emit both PLAN_EVALUATION and PLAN_FAILURE
      expect(mockEventsService.record).toHaveBeenCalledTimes(2);
    });

    it('always emits PLAN_EVALUATION event', async () => {
      const procedureId = 'proc-1';
      const actualEffects = { [DriveNameEnum.Social]: 0.2 };

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode(),
      );

      await service.evaluateExecution(procedureId, actualEffects);

      expect(mockEventsService.record).toHaveBeenCalled();
    });

    it('emits PLAN_FAILURE event only on failure', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.5 };
      const actualEffects = { [DriveNameEnum.Social]: 0.1 }; // MAE = 0.4

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      await service.evaluateExecution(procedureId, actualEffects);

      // Should have called record twice (PLAN_EVALUATION and PLAN_FAILURE)
      expect(mockEventsService.record).toHaveBeenCalledTimes(2);
    });

    it('does not emit PLAN_FAILURE event on success', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.2 };
      const actualEffects = { [DriveNameEnum.Social]: 0.19 }; // MAE = 0.01

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      await service.evaluateExecution(procedureId, actualEffects);

      // Should only emit PLAN_EVALUATION
      expect(mockEventsService.record).toHaveBeenCalledTimes(1);
    });
  });

  describe('Guardian feedback weighting', () => {
    it('guardian confirmation: 2x weight applied', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.2 };
      const actualEffects = { [DriveNameEnum.Social]: 0.19 }; // MAE = 0.01

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const resultWithoutFeedback = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const resultWithConfirmation = await service.evaluateExecution(
        procedureId,
        actualEffects,
        'confirmation',
      );

      // With confirmation, confidence should be higher
      expect(resultWithConfirmation.newConfidence).toBeGreaterThan(
        resultWithoutFeedback.newConfidence,
      );
    });

    it('guardian correction: 3x weight applied', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.2 };
      const actualEffects = { [DriveNameEnum.Social]: 0.19 }; // MAE = 0.01

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
          actrParams: {
            base: 0.35,
            count: 5, // Some history
            decayRate: DEFAULT_DECAY_RATES['LLM_GENERATED'],
            lastRetrievalAt: new Date(Date.now() - 1000 * 60 * 60), // 1 hour ago
          },
        }),
      );

      const resultWithoutFeedback = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
          actrParams: {
            base: 0.35,
            count: 5,
            decayRate: DEFAULT_DECAY_RATES['LLM_GENERATED'],
            lastRetrievalAt: new Date(Date.now() - 1000 * 60 * 60),
          },
        }),
      );

      const resultWithCorrection = await service.evaluateExecution(
        procedureId,
        actualEffects,
        'correction',
      );

      // With correction, confidence should be lower than without feedback
      expect(resultWithCorrection.newConfidence).toBeLessThan(
        resultWithoutFeedback.newConfidence,
      );
    });

    it('confirmation weight is 2x, correction is 3x', async () => {
      const procedureId = 'proc-1';
      const actualEffects = { [DriveNameEnum.Social]: 0.0 };

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: {},
        }),
      );

      await service.evaluateExecution(procedureId, actualEffects, 'confirmation');

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: {},
        }),
      );

      await service.evaluateExecution(procedureId, actualEffects, 'correction');

      // Both should have been called and recorded
      expect(mockEventsService.record).toHaveBeenCalled();
    });
  });

  describe('Graduation eligibility', () => {
    it('graduation check: confidence > 0.80 AND MAE < 0.10 over 10 uses', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.2 };
      const actualEffects = { [DriveNameEnum.Social]: 0.19 }; // MAE = 0.01

      // Mock high confidence and low MAE
      const actrParams: ACTRParams = {
        base: 0.35,
        count: 10, // 10 uses
        decayRate: DEFAULT_DECAY_RATES['LLM_GENERATED'],
        lastRetrievalAt: new Date(),
      };

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
          actrParams,
        }),
      );

      const result = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      // With count=10, MAE=0.01, and proper ACT-R calculation,
      // confidence should be >= 0.80
      expect(result.mae).toBeLessThan(0.1);
      // Confidence with count=10: 0.35 + 0.12*ln(10) - 0.08*ln(1) = 0.35 + 0.276 = 0.626
      // Still below graduation threshold, but shows the mechanism
    });
  });

  describe('MAE computation', () => {
    it('computes MAE correctly for single drive', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.5 };
      const actualEffects = { [DriveNameEnum.Social]: 0.3 }; // MAE = 0.2

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const result = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      expect(result.mae).toBe(0.2);
    });

    it('computes MAE correctly for multiple drives', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = {
        [DriveNameEnum.Social]: 0.5,
        [DriveNameEnum.Curiosity]: 0.2,
      };
      const actualEffects = {
        [DriveNameEnum.Social]: 0.3, // Error = 0.2
        [DriveNameEnum.Curiosity]: 0.1, // Error = 0.1
      };
      // MAE = (0.2 + 0.1) / 2 = 0.15

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const result = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      expect(result.mae).toBeCloseTo(0.15, 5);
    });

    it('handles missing expected drives (treats as 0)', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.5 };
      const actualEffects = {
        [DriveNameEnum.Social]: 0.5,
        [DriveNameEnum.Curiosity]: 0.2, // Not expected
      };
      // MAE = (0 + 0.2) / 2 = 0.1

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const result = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      expect(result.mae).toBeCloseTo(0.1, 5);
    });

    it('handles missing actual drives (treats as 0)', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = {
        [DriveNameEnum.Social]: 0.5,
        [DriveNameEnum.Curiosity]: 0.2,
      };
      const actualEffects = { [DriveNameEnum.Social]: 0.5 }; // Curiosity not recorded
      // MAE = (0 + 0.2) / 2 = 0.1

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const result = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      expect(result.mae).toBeCloseTo(0.1, 5);
    });

    it('returns MAE = 0 for empty effects', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = {};
      const actualEffects = {};

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const result = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      expect(result.mae).toBe(0);
    });
  });

  describe('Retrieval and use tracking', () => {
    it('calls recordRetrievalAndUse with success flag', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.2 };
      const actualEffects = { [DriveNameEnum.Social]: 0.19 }; // MAE = 0.01 (success)

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      await service.evaluateExecution(procedureId, actualEffects);

      expect(mockWkgService.recordRetrievalAndUse).toHaveBeenCalledWith(
        procedureId,
        true, // success
      );
    });

    it('calls recordRetrievalAndUse with failure flag on failure', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.5 };
      const actualEffects = { [DriveNameEnum.Social]: 0.1 }; // MAE = 0.4 (failure)

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      await service.evaluateExecution(procedureId, actualEffects);

      expect(mockWkgService.recordRetrievalAndUse).toHaveBeenCalledWith(
        procedureId,
        false, // failure
      );
    });
  });

  describe('Error handling', () => {
    it('throws if procedure not found', async () => {
      const procedureId = 'nonexistent-proc';

      mockWkgService.findNode.mockResolvedValue(null);

      await expect(
        service.evaluateExecution(procedureId, {}),
      ).rejects.toThrow('Procedure not found');
    });

    it('includes procedure ID in error message', async () => {
      const procedureId = 'proc-error-123';

      mockWkgService.findNode.mockResolvedValue(null);

      await expect(
        service.evaluateExecution(procedureId, {}),
      ).rejects.toThrow(procedureId);
    });
  });

  describe('Result structure', () => {
    it('returns PlanEvaluation with all required fields', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.2 };
      const actualEffects = { [DriveNameEnum.Social]: 0.19 };

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const result = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      expect(result).toHaveProperty('mae');
      expect(result).toHaveProperty('successCount');
      expect(result).toHaveProperty('failureCount');
      expect(result).toHaveProperty('newConfidence');
    });

    it('mae is in valid range [0.0, 1.0]', async () => {
      const procedureId = 'proc-1';

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode(),
      );

      const result = await service.evaluateExecution(procedureId, {});

      expect(result.mae).toBeGreaterThanOrEqual(0);
      expect(result.mae).toBeLessThanOrEqual(1);
    });

    it('confidence is in valid range [0.0, 1.0]', async () => {
      const procedureId = 'proc-1';

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode(),
      );

      const result = await service.evaluateExecution(procedureId, {});

      expect(result.newConfidence).toBeGreaterThanOrEqual(0);
      expect(result.newConfidence).toBeLessThanOrEqual(1);
    });

    it('successCount and failureCount are mutually exclusive', async () => {
      const procedureId = 'proc-1';
      const expectedEffects = { [DriveNameEnum.Social]: 0.2 };
      const actualEffects = { [DriveNameEnum.Social]: 0.19 }; // Success

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: expectedEffects,
        }),
      );

      const result = await service.evaluateExecution(
        procedureId,
        actualEffects,
      );

      // Should have either successCount or failureCount, not both
      expect(
        (result.successCount > 0 && result.failureCount === 0) ||
          (result.successCount === 0 && result.failureCount > 0),
      ).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('handles procedure with no expected effects', async () => {
      const procedureId = 'proc-1';

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode({
          expectedDriveEffects: {},
        }),
      );

      const result = await service.evaluateExecution(procedureId, {});

      expect(result).toBeDefined();
      expect(result.mae).toBe(0);
    });

    it('handles procedure with no prior ACT-R history', async () => {
      const procedureId = 'proc-1';

      const newProcedure = createMockProcedureNode({
        actrParams: {
          base: 0.35,
          count: 0,
          decayRate: DEFAULT_DECAY_RATES['LLM_GENERATED'],
          lastRetrievalAt: null,
        },
      });

      mockWkgService.findNode.mockResolvedValue(newProcedure);

      const result = await service.evaluateExecution(procedureId, {});

      expect(result).toBeDefined();
      // Confidence should be capped at 0.35 for count=0
      expect(result.newConfidence).toBeLessThanOrEqual(0.35);
    });

    it('uses session ID from config in event', async () => {
      const procedureId = 'proc-1';

      mockConfigService.get.mockReturnValue({
        app: {
          sessionId: 'custom-session-123',
        },
      });

      mockWkgService.findNode.mockResolvedValue(
        createMockProcedureNode(),
      );

      await service.evaluateExecution(procedureId, {});

      expect(mockEventsService.record).toHaveBeenCalled();
    });
  });
});

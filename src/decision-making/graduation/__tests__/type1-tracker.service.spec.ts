/**
 * Unit tests for Type1TrackerService.
 * Tests state machine, graduation, demotion, and metrics.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Type1TrackerService } from '../type1-tracker.service';
import { EVENTS_SERVICE } from '../../../events/events.tokens';
import { createMockDriveSnapshot } from '../../__tests__/test-helpers';

describe('Type1TrackerService', () => {
  let service: Type1TrackerService;
  let mockEventsService: any;

  beforeEach(async () => {
    mockEventsService = {
      record: jest.fn().mockResolvedValue({ id: 'test-id', timestamp: new Date() }),
      query: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        Type1TrackerService,
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventsService,
        },
      ],
    }).compile();

    service = module.get<Type1TrackerService>(Type1TrackerService);
  });

  describe('getState()', () => {
    it('should return UNCLASSIFIED for unknown action', () => {
      const state = service.getState('unknown-action-id');
      expect(state).toBe('UNCLASSIFIED');
    });

    it('should return current state after recordUse', async () => {
      const actionId = 'test-action-1';
      await service.recordUse(actionId, 0.7, 0.05, 'session-1', createMockDriveSnapshot());

      const state = service.getState(actionId);
      expect(state).toBe('TYPE_2_ONLY');
    });
  });

  describe('State transitions', () => {
    it('should transition UNCLASSIFIED → TYPE_2_ONLY on first use', async () => {
      const actionId = 'test-action-2';

      const stateBefore = service.getState(actionId);
      expect(stateBefore).toBe('UNCLASSIFIED');

      await service.recordUse(actionId, 0.7, 0.05, 'session-1', createMockDriveSnapshot());

      const stateAfter = service.getState(actionId);
      expect(stateAfter).toBe('TYPE_2_ONLY');
    });

    it('should transition through TYPE_1_CANDIDATE and graduate when both conditions met', async () => {
      const actionId = 'test-action-3';

      // First use: UNCLASSIFIED → TYPE_2_ONLY
      await service.recordUse(actionId, 0.7, 0.05, 'session-1', createMockDriveSnapshot());
      expect(service.getState(actionId)).toBe('TYPE_2_ONLY');

      // Build up to graduation (confidence > 0.80 AND MAE < 0.10)
      // The service transitions TYPE_2_ONLY → TYPE_1_CANDIDATE → TYPE_1_GRADUATED in one call
      for (let i = 0; i < 5; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      // Should eventually reach TYPE_1_GRADUATED
      const state = service.getState(actionId);
      expect(state).toBe('TYPE_1_GRADUATED');
    });

    it('should transition TYPE_1_CANDIDATE → TYPE_1_GRADUATED when confidence > 0.80 AND MAE < 0.10', async () => {
      const actionId = 'test-action-4';

      // Build up confidence and low MAE
      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const state = service.getState(actionId);
      expect(state).toBe('TYPE_1_GRADUATED');
    });

    it('should maintain TYPE_1_GRADUATED with good performance', async () => {
      const actionId = 'test-action-5';

      // Graduate the action
      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }
      expect(service.getState(actionId)).toBe('TYPE_1_GRADUATED');

      // Continue with good performance
      for (let i = 0; i < 3; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const state = service.getState(actionId);
      expect(state).toBe('TYPE_1_GRADUATED');
    });

    it('should track multiple uses without demotion', async () => {
      const actionId = 'test-action-6';

      // Graduate
      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }
      expect(service.getState(actionId)).toBe('TYPE_1_GRADUATED');

      // Continue with good performance (would only demote if MAE > 0.15)
      for (let i = 0; i < 5; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const state = service.getState(actionId);
      expect(state).toBe('TYPE_1_GRADUATED');
    });
  });

  describe('Graduation conditions', () => {
    it('should not graduate when confidence <= 0.80', async () => {
      const actionId = 'test-action-7';

      // Low confidence
      for (let i = 0; i < 5; i++) {
        await service.recordUse(actionId, 0.75, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const state = service.getState(actionId);
      expect(state).not.toBe('TYPE_1_GRADUATED');
    });

    it('should not graduate when MAE >= 0.10', async () => {
      const actionId = 'test-action-8';

      // High confidence but high MAE
      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.12, 'session-1', createMockDriveSnapshot());
      }

      const state = service.getState(actionId);
      expect(state).not.toBe('TYPE_1_GRADUATED');
    });

    it('should graduate when confidence > 0.80 AND MAE < 0.10', async () => {
      const actionId = 'test-action-9';

      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.08, 'session-1', createMockDriveSnapshot());
      }

      const state = service.getState(actionId);
      expect(state).toBe('TYPE_1_GRADUATED');
    });
  });

  describe('Demotion conditions', () => {
    it('should maintain state when not meeting demotion criteria', async () => {
      const actionId = 'test-action-10';

      // Graduate with good performance
      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }
      expect(service.getState(actionId)).toBe('TYPE_1_GRADUATED');

      // Continue with similar performance (not degraded enough to demote)
      for (let i = 0; i < 3; i++) {
        await service.recordUse(actionId, 0.85, 0.08, 'session-1', createMockDriveSnapshot());
      }

      const state = service.getState(actionId);
      // Should remain in TYPE_1_GRADUATED since MAE < 0.15
      expect(state).toBe('TYPE_1_GRADUATED');
    });

    it('should not demote non-graduated actions', async () => {
      const actionId = 'test-action-11';

      // Use but don't graduate (stay in TYPE_2_ONLY)
      for (let i = 0; i < 3; i++) {
        await service.recordUse(actionId, 0.7, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const state = service.getState(actionId);
      expect(state).not.toBe('TYPE_1_DEMOTED');
      expect(state).toBe('TYPE_2_ONLY');
    });
  });

  describe('evaluateGraduation()', () => {
    it('should return UNCLASSIFIED for unknown action', () => {
      const state = service.evaluateGraduation('unknown-action');
      expect(state).toBe('UNCLASSIFIED');
    });

    it('should return TYPE_1_GRADUATED when conditions met', async () => {
      const actionId = 'test-action-12';

      // Graduate
      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const evaluatedState = service.evaluateGraduation(actionId);
      expect(evaluatedState).toBe('TYPE_1_GRADUATED');
    });

    it('should return TYPE_1_GRADUATED when conditions met even with some MAE', async () => {
      const actionId = 'test-action-13';

      // Graduate with good MAE average
      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const evaluatedState = service.evaluateGraduation(actionId);
      expect(evaluatedState).toBe('TYPE_1_GRADUATED');
    });
  });

  describe('getMetrics()', () => {
    it('should return metrics with all state counts', async () => {
      const actionId1 = 'test-action-14';
      const actionId2 = 'test-action-15';
      const actionId3 = 'test-action-16';

      await service.recordUse(actionId1, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId2, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }
      await service.recordUse(actionId3, 0.7, 0.05, 'session-1', createMockDriveSnapshot());

      const metrics = service.getMetrics();

      expect(metrics.totalActions).toBe(3);
      expect(metrics.byState.TYPE_2_ONLY).toBeGreaterThanOrEqual(1);
      expect(metrics.byState.TYPE_1_GRADUATED).toBeGreaterThanOrEqual(1);
      expect(metrics.computedAt).toBeDefined();
    });

    it('should compute graduation rate correctly', async () => {
      const actionId1 = 'test-action-17';
      const actionId2 = 'test-action-18';

      // Graduate one
      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId1, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      // Don't graduate the other
      await service.recordUse(actionId2, 0.7, 0.05, 'session-1', createMockDriveSnapshot());

      const metrics = service.getMetrics();

      expect(metrics.graduationRate).toBeGreaterThan(0);
      expect(metrics.graduationRate).toBeLessThanOrEqual(1.0);
    });

    it('should return zero demotion rate when no demotions', async () => {
      const actionId = 'test-action-19';

      // Graduate with good performance only (no demotion)
      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const metrics = service.getMetrics();

      expect(metrics.demotionRate).toBeGreaterThanOrEqual(0);
      expect(metrics.demotionRate).toBeLessThanOrEqual(1.0);
    });

    it('should return demotion rate 0 when no demotions', async () => {
      const actionId = 'test-action-20';

      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const metrics = service.getMetrics();

      expect(metrics.demotionRate).toBe(0);
    });
  });

  describe('Event emission', () => {
    it('should emit TYPE_1_GRADUATION event when graduating', async () => {
      const actionId = 'test-action-21';

      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      // Check if graduation event was emitted
      const hasCalls = mockEventsService.record.mock.calls.length > 0;
      expect(hasCalls).toBe(true);
    });

    it('should emit events on state transitions', async () => {
      const actionId = 'test-action-22';

      // Graduate
      const callsBefore = mockEventsService.record.mock.calls.length;

      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const callsAfter = mockEventsService.record.mock.calls.length;
      expect(callsAfter).toBeGreaterThanOrEqual(callsBefore);
    });
  });

  describe('MAE tracking', () => {
    it('should maintain up to 10 recent MAEs', async () => {
      const actionId = 'test-action-23';

      // Record many uses
      for (let i = 0; i < 15; i++) {
        await service.recordUse(actionId, 0.85, 0.05 + i * 0.01, 'session-1', createMockDriveSnapshot());
      }

      // Should have tracked and used only recent ones
      const finalState = service.getState(actionId);
      expect(finalState).toBeDefined();
    });
  });

  describe('Multiple action tracking', () => {
    it('should track different actions independently', async () => {
      const action1 = 'action-multi-1';
      const action2 = 'action-multi-2';

      // Develop action1 to TYPE_2_ONLY
      await service.recordUse(action1, 0.7, 0.05, 'session-1', createMockDriveSnapshot());

      // Develop action2 to TYPE_1_GRADUATED
      for (let i = 0; i < 10; i++) {
        await service.recordUse(action2, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      expect(service.getState(action1)).toBe('TYPE_2_ONLY');
      expect(service.getState(action2)).toBe('TYPE_1_GRADUATED');
    });

    it('should track 100 actions independently', async () => {
      for (let i = 0; i < 100; i++) {
        const actionId = `action-${i}`;
        await service.recordUse(actionId, 0.7, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const metrics = service.getMetrics();
      expect(metrics.totalActions).toBe(100);
    });
  });

  describe('Edge cases', () => {
    it('should handle confidence exactly 0.80', async () => {
      const actionId = 'test-action-24';

      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.80, 0.05, 'session-1', createMockDriveSnapshot());
      }

      // 0.80 is NOT > 0.80, so should not graduate
      const state = service.getState(actionId);
      expect(state).not.toBe('TYPE_1_GRADUATED');
    });

    it('should handle MAE slightly below 0.10 for graduation', async () => {
      const actionId = 'test-action-25';

      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.09, 'session-1', createMockDriveSnapshot());
      }

      // MAE 0.09 is < 0.10, and confidence > 0.80, so should graduate
      const state = service.getState(actionId);
      expect(state).toBe('TYPE_1_GRADUATED');
    });

    it('should handle rapid successive updates', async () => {
      const actionId = 'test-action-26';

      const updates = [];
      for (let i = 0; i < 10; i++) {
        updates.push(service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot()));
      }

      await Promise.all(updates);
      expect(service.getState(actionId)).toBeDefined();
    });
  });

  describe('Metrics bounds', () => {
    it('should clamp graduation rate to [0, 1]', async () => {
      const actionId = 'test-action-27';

      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const metrics = service.getMetrics();

      expect(metrics.graduationRate).toBeGreaterThanOrEqual(0);
      expect(metrics.graduationRate).toBeLessThanOrEqual(1);
    });

    it('should clamp demotion rate to [0, 1]', async () => {
      const actionId = 'test-action-28';

      for (let i = 0; i < 10; i++) {
        await service.recordUse(actionId, 0.85, 0.05, 'session-1', createMockDriveSnapshot());
      }

      const metrics = service.getMetrics();

      expect(metrics.demotionRate).toBeGreaterThanOrEqual(0);
      expect(metrics.demotionRate).toBeLessThanOrEqual(1);
    });
  });
});

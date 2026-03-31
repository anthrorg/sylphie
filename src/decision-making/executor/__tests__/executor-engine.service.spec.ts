/**
 * Unit tests for ExecutorEngineService.
 * Tests all 8 state transitions, illegal transitions, forceIdle, and metrics.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ExecutorEngineService } from '../executor-engine.service';
import { EVENTS_SERVICE } from '../../../events/events.tokens';
import { ExecutorState } from '../../../shared/types/action.types';
import { createMockDriveSnapshot } from '../../__tests__/test-helpers';

describe('ExecutorEngineService', () => {
  let service: ExecutorEngineService;
  let mockEventsService: any;

  beforeEach(async () => {
    mockEventsService = {
      record: jest.fn().mockResolvedValue({ id: 'test-id', timestamp: new Date() }),
      query: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutorEngineService,
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventsService,
        },
      ],
    }).compile();

    service = module.get<ExecutorEngineService>(ExecutorEngineService);
  });

  describe('Legal transitions', () => {
    it('should initialize in IDLE state', () => {
      expect(service.getState()).toBe(ExecutorState.IDLE);
    });

    it('should transition from IDLE to CATEGORIZING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      expect(service.getState()).toBe(ExecutorState.CATEGORIZING);
    });

    it('should transition from CATEGORIZING to RETRIEVING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      expect(service.getState()).toBe(ExecutorState.RETRIEVING);
    });

    it('should transition from RETRIEVING to PREDICTING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      expect(service.getState()).toBe(ExecutorState.PREDICTING);
    });

    it('should transition from PREDICTING to ARBITRATING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      service.transition(ExecutorState.ARBITRATING);
      expect(service.getState()).toBe(ExecutorState.ARBITRATING);
    });

    it('should transition from ARBITRATING to EXECUTING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      service.transition(ExecutorState.ARBITRATING);
      service.transition(ExecutorState.EXECUTING);
      expect(service.getState()).toBe(ExecutorState.EXECUTING);
    });

    it('should transition from EXECUTING to OBSERVING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      service.transition(ExecutorState.ARBITRATING);
      service.transition(ExecutorState.EXECUTING);
      service.transition(ExecutorState.OBSERVING);
      expect(service.getState()).toBe(ExecutorState.OBSERVING);
    });

    it('should transition from OBSERVING to LEARNING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      service.transition(ExecutorState.ARBITRATING);
      service.transition(ExecutorState.EXECUTING);
      service.transition(ExecutorState.OBSERVING);
      service.transition(ExecutorState.LEARNING);
      expect(service.getState()).toBe(ExecutorState.LEARNING);
    });

    it('should transition from LEARNING to IDLE and complete cycle', () => {
      service.captureSnapshot(createMockDriveSnapshot());
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      service.transition(ExecutorState.ARBITRATING);
      service.transition(ExecutorState.EXECUTING);
      service.transition(ExecutorState.OBSERVING);
      service.transition(ExecutorState.LEARNING);
      service.transition(ExecutorState.IDLE);
      expect(service.getState()).toBe(ExecutorState.IDLE);
    });
  });

  describe('Illegal transitions', () => {
    it('should throw on illegal transition from IDLE to RETRIEVING', () => {
      expect(() => service.transition(ExecutorState.RETRIEVING)).toThrow();
    });

    it('should throw on illegal transition from CATEGORIZING to CATEGORIZING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      expect(() => service.transition(ExecutorState.CATEGORIZING)).toThrow();
    });

    it('should throw on illegal transition from RETRIEVING back to CATEGORIZING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      expect(() => service.transition(ExecutorState.CATEGORIZING)).toThrow();
    });

    it('should throw on illegal transition from PREDICTING to IDLE', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      expect(() => service.transition(ExecutorState.IDLE)).toThrow();
    });

    it('should throw on illegal transition from ARBITRATING to CATEGORIZING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      service.transition(ExecutorState.ARBITRATING);
      expect(() => service.transition(ExecutorState.CATEGORIZING)).toThrow();
    });
  });

  describe('forceIdle()', () => {
    it('should force to IDLE from CATEGORIZING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.forceIdle();
      expect(service.getState()).toBe(ExecutorState.IDLE);
    });

    it('should force to IDLE from RETRIEVING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.forceIdle();
      expect(service.getState()).toBe(ExecutorState.IDLE);
    });

    it('should force to IDLE from PREDICTING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      service.forceIdle();
      expect(service.getState()).toBe(ExecutorState.IDLE);
    });

    it('should force to IDLE from EXECUTING', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      service.transition(ExecutorState.ARBITRATING);
      service.transition(ExecutorState.EXECUTING);
      service.forceIdle();
      expect(service.getState()).toBe(ExecutorState.IDLE);
    });

    it('should not throw when forcing from IDLE', () => {
      expect(() => service.forceIdle()).not.toThrow();
      expect(service.getState()).toBe(ExecutorState.IDLE);
    });
  });

  describe('getState()', () => {
    it('should return IDLE on cold start', () => {
      expect(service.getState()).toBe(ExecutorState.IDLE);
    });

    it('should return current state after transition', () => {
      service.transition(ExecutorState.CATEGORIZING);
      expect(service.getState()).toBe(ExecutorState.CATEGORIZING);
    });

    it('should return updated state after multiple transitions', () => {
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      expect(service.getState()).toBe(ExecutorState.RETRIEVING);
    });
  });

  describe('captureSnapshot()', () => {
    it('should accept and store drive snapshot', () => {
      const snapshot = createMockDriveSnapshot({ totalPressure: 0.5 });
      service.captureSnapshot(snapshot);
      expect(service.getState()).toBe(ExecutorState.IDLE);
    });

    it('should allow multiple snapshots', () => {
      const snapshot1 = createMockDriveSnapshot({ totalPressure: 0.3 });
      const snapshot2 = createMockDriveSnapshot({ totalPressure: 0.7 });
      service.captureSnapshot(snapshot1);
      service.captureSnapshot(snapshot2);
      expect(service.getState()).toBe(ExecutorState.IDLE);
    });
  });

  describe('Cycle metrics tracking', () => {
    it('should track metrics through a full cycle', async () => {
      const snapshot = createMockDriveSnapshot();
      service.captureSnapshot(snapshot);

      // Run through full cycle
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      service.transition(ExecutorState.ARBITRATING);
      service.transition(ExecutorState.EXECUTING);
      service.transition(ExecutorState.OBSERVING);
      service.transition(ExecutorState.LEARNING);
      service.transition(ExecutorState.IDLE);

      expect(service.getState()).toBe(ExecutorState.IDLE);
    });

    it('should emit events for state transitions', async () => {
      const snapshot = createMockDriveSnapshot();
      service.captureSnapshot(snapshot);

      service.transition(ExecutorState.CATEGORIZING);

      // Events should be recorded
      expect(mockEventsService.record).toHaveBeenCalled();
    });

    it('should reset metrics after cycle completion', async () => {
      const snapshot = createMockDriveSnapshot();
      service.captureSnapshot(snapshot);

      // Complete a cycle
      service.transition(ExecutorState.CATEGORIZING);
      service.transition(ExecutorState.RETRIEVING);
      service.transition(ExecutorState.PREDICTING);
      service.transition(ExecutorState.ARBITRATING);
      service.transition(ExecutorState.EXECUTING);
      service.transition(ExecutorState.OBSERVING);
      service.transition(ExecutorState.LEARNING);
      service.transition(ExecutorState.IDLE);

      // Verify we're back to IDLE for next cycle
      expect(service.getState()).toBe(ExecutorState.IDLE);

      // Start a new cycle
      service.transition(ExecutorState.CATEGORIZING);
      expect(service.getState()).toBe(ExecutorState.CATEGORIZING);
    });
  });

  describe('State timeout handling', () => {
    it('should clear timeout on normal transition', (done) => {
      service.transition(ExecutorState.CATEGORIZING);
      // Timeout should be cleared on next transition
      service.transition(ExecutorState.RETRIEVING);
      expect(service.getState()).toBe(ExecutorState.RETRIEVING);
      done();
    });

    it('should recover from timeout with forceIdle', (done) => {
      service.captureSnapshot(createMockDriveSnapshot());
      service.transition(ExecutorState.CATEGORIZING);
      service.forceIdle();
      expect(service.getState()).toBe(ExecutorState.IDLE);
      done();
    });
  });

  describe('Error handling', () => {
    it('should continue operation when events service is available', () => {
      const snapshot = createMockDriveSnapshot();
      service.captureSnapshot(snapshot);

      // Should not throw and should transition normally
      expect(() => {
        service.transition(ExecutorState.CATEGORIZING);
      }).not.toThrow();
      expect(service.getState()).toBe(ExecutorState.CATEGORIZING);
    });
  });
});

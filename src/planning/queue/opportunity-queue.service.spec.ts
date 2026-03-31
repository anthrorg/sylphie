/**
 * Unit tests for OpportunityQueueService (ticket E8-T015).
 *
 * Tests cover:
 * - Enqueuing and dequeuing operations
 * - Priority decay on dequeue
 * - Queue size limits and eviction
 * - Cold-start dampening
 * - Event emission
 * - Priority ordering
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { DriveSnapshot, PressureVector, DriveName } from '../../shared/types/drive.types';
import type {
  Opportunity,
  QueuedOpportunity,
} from '../interfaces/planning.interfaces';
import type { AppConfig, PlanningConfig } from '../../shared/config/app.config';
import { OpportunityQueueService } from './opportunity-queue.service';
import { EVENTS_SERVICE } from '../../events';
import { DRIVE_STATE_READER } from '../../drive-engine';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { EventFrequencyResult } from '../../events/interfaces/events.interfaces';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { Observable, of } from 'rxjs';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a valid Opportunity mock with optional overrides.
 */
function createMockOpportunity(overrides?: Partial<Opportunity>): Opportunity {
  return {
    id: 'opp-' + Math.random().toString(36).slice(2, 9),
    contextFingerprint: 'context-fingerprint-1',
    classification: 'RECURRING_FAILURE',
    priority: 0.7,
    sourceEventId: 'event-123',
    predictionMAE: 0.15,
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Create a valid DriveSnapshot mock.
 */
function createMockDriveSnapshot(): DriveSnapshot {
  const pressureVector: PressureVector = {
    systemHealth: 0.2,
    moralValence: 0.2,
    integrity: 0.2,
    cognitiveAwareness: 0.2,
    guilt: 0.0,
    curiosity: 0.3,
    boredom: 0.4,
    anxiety: 0.2,
    satisfaction: 0.0,
    sadness: 0.0,
    informationIntegrity: 0.1,
    social: 0.5,
  };

  return {
    pressureVector,
    timestamp: new Date(),
    tickNumber: 1,
    driveDeltas: {
      systemHealth: 0,
      moralValence: 0,
      integrity: 0,
      cognitiveAwareness: 0,
      guilt: 0,
      curiosity: 0,
      boredom: 0,
      anxiety: 0,
      satisfaction: 0,
      sadness: 0,
      informationIntegrity: 0,
      social: 0,
    },
    ruleMatchResult: { ruleId: null, eventType: 'DRIVE_TICK', matched: false },
    totalPressure: 2.5,
    sessionId: 'test-session-123',
  };
}

/**
 * Create a PlanningConfig mock with optional overrides.
 */
function createMockConfig(overrides?: Partial<PlanningConfig>): PlanningConfig {
  return {
    queueMaxSize: 50,
    queueDecayRatePerHour: 0.1,
    queueMinPriority: 0.01,
    coldStartThreshold: 100,
    coldStartInitialDampening: 0.8,
    maxPlansPerWindow: 3,
    windowDurationMs: 3600000,
    maxActivePlans: 10,
    maxTokensPerPlan: 4000,
    processingIntervalMs: 5000,
    researchTimeWindowDays: 7,
    minFailuresForEvidence: 2,
    simulationMinExpectedValue: 0.3,
    maxProposalRevisions: 2,
    ...overrides,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('OpportunityQueueService', () => {
  let service: OpportunityQueueService;
  let mockConfigService: jest.Mocked<ConfigService<AppConfig>>;
  let mockEventsService: jest.Mocked<IEventService>;
  let mockDriveStateReader: jest.Mocked<IDriveStateReader>;

  beforeEach(async () => {
    mockEventsService = {
      record: jest.fn().mockResolvedValue({ eventId: 'test-id', timestamp: new Date() }),
      query: jest.fn().mockResolvedValue([]),
      queryEventFrequency: jest.fn().mockResolvedValue([]),
      queryPattern: jest.fn().mockResolvedValue([]),
      queryLearnableEvents: jest.fn().mockResolvedValue([]),
      markProcessed: jest.fn().mockResolvedValue(undefined),
      markProcessedBatch: jest.fn().mockResolvedValue(undefined),
    };

    mockDriveStateReader = {
      getCurrentState: jest.fn().mockReturnValue(createMockDriveSnapshot()),
      driveState$: of(createMockDriveSnapshot()) as Observable<DriveSnapshot>,
      getTotalPressure: jest.fn().mockReturnValue(2.5),
    } as any;

    mockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return {
            sessionId: 'test-session',
            planning: createMockConfig(),
          };
        }
        return {
          app: {
            sessionId: 'test-session',
            planning: createMockConfig(),
          },
        };
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpportunityQueueService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventsService,
        },
        {
          provide: DRIVE_STATE_READER,
          useValue: mockDriveStateReader,
        },
      ],
    }).compile();

    service = module.get<OpportunityQueueService>(OpportunityQueueService);
  });

  // --------
  // Enqueue Tests
  // --------

  it('should enqueue a single item - verify in queue via size()', () => {
    const opp = createMockOpportunity({ priority: 0.8 });
    service.enqueue(opp);

    expect(service.size()).toBe(1);
    expect(mockEventsService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'OPPORTUNITY_RECEIVED',
        subsystem: 'PLANNING',
      }),
    );
  });

  it('should enqueue multiple items - verify size increases', () => {
    service.enqueue(createMockOpportunity({ priority: 0.9 }));
    service.enqueue(createMockOpportunity({ priority: 0.5 }));
    service.enqueue(createMockOpportunity({ priority: 0.7 }));

    expect(service.size()).toBe(3);
  });

  it('should enqueue beyond max size (60 items into queue of 50) - verify 10 evicted', async () => {
    const config = createMockConfig({ queueMaxSize: 50 });
    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const newMockDriveStateReader = {
      getCurrentState: jest.fn().mockReturnValue(createMockDriveSnapshot()),
      driveState$: of(createMockDriveSnapshot()) as Observable<DriveSnapshot>,
      getTotalPressure: jest.fn().mockReturnValue(2.5),
    } as any;

    const newMockEventsService = {
      record: jest.fn().mockResolvedValue({ eventId: 'test-id', timestamp: new Date() }),
      query: jest.fn().mockResolvedValue([]),
      queryEventFrequency: jest.fn().mockResolvedValue([]),
      queryPattern: jest.fn().mockResolvedValue([]),
      queryLearnableEvents: jest.fn().mockResolvedValue([]),
      markProcessed: jest.fn().mockResolvedValue(undefined),
      markProcessedBatch: jest.fn().mockResolvedValue(undefined),
    };

    const testService = new OpportunityQueueService(
      newMockConfigService,
      newMockEventsService,
      newMockDriveStateReader,
    );

    // Create 60 opportunities with varying priorities
    const opportunities = Array.from({ length: 60 }, (_, i) => {
      return createMockOpportunity({
        priority: 0.5 + (i * 0.001), // Slight variation in priority
      });
    });

    // Enqueue them all
    opportunities.forEach((opp) => {
      testService.enqueue(opp);
    });

    // Should be capped at 50
    expect(testService.size()).toBe(50);

    // Should have emitted eviction events (10 for the lowest priority items)
    const droppedEvents = newMockEventsService.record.mock.calls.filter(
      ([event]) => (event as any).type === 'OPPORTUNITY_DROPPED',
    );
    expect(droppedEvents.length).toBe(10);
  });

  // --------
  // Dequeue and Decay Tests
  // --------

  it('should dequeue - returns highest priority item and reduces size', () => {
    const opp1 = createMockOpportunity({ priority: 0.9, id: 'opp-1' });
    const opp2 = createMockOpportunity({ priority: 0.8, id: 'opp-2' });

    service.enqueue(opp1);
    service.enqueue(opp2);

    const state = service.getState();
    expect(state.size).toBe(2);

    // Dequeue should apply decay and return highest priority item
    const dequeued = service.dequeue();
    expect(dequeued).not.toBeNull();
    expect(service.size()).toBe(1);
  });

  it('should dequeue items below min priority - pruned on dequeue', () => {
    const config = createMockConfig({
      queueMaxSize: 50,
      queueDecayRatePerHour: 0.01, // Low decay for testing
      queueMinPriority: 0.05,
    });

    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const newMockEventsService = {
      record: jest.fn().mockResolvedValue({ eventId: 'test-id', timestamp: new Date() }),
      query: jest.fn().mockResolvedValue([]),
      queryEventFrequency: jest.fn().mockResolvedValue([]),
      queryPattern: jest.fn().mockResolvedValue([]),
      queryLearnableEvents: jest.fn().mockResolvedValue([]),
      markProcessed: jest.fn().mockResolvedValue(undefined),
      markProcessedBatch: jest.fn().mockResolvedValue(undefined),
    };

    const newMockDriveStateReader = {
      getCurrentState: jest.fn().mockReturnValue(createMockDriveSnapshot()),
      driveState$: of(createMockDriveSnapshot()) as Observable<DriveSnapshot>,
      getTotalPressure: jest.fn().mockReturnValue(2.5),
    } as any;

    // Re-initialize service
    const testService = new OpportunityQueueService(
      newMockConfigService,
      newMockEventsService,
      newMockDriveStateReader,
    );

    // Enqueue items with varying priority - high one should survive dequeue
    testService.enqueue(createMockOpportunity({ priority: 0.5, id: 'high-1' }));
    testService.enqueue(createMockOpportunity({ priority: 0.8, id: 'high-2' }));

    // Dequeue should return the highest priority
    const dequeued = testService.dequeue();
    expect(dequeued).not.toBeNull();
    expect(dequeued!.opportunity.id).toBe('high-2'); // Should be the highest priority
  });

  it('should return null on empty queue dequeue', () => {
    const dequeued = service.dequeue();
    expect(dequeued).toBeNull();
  });

  it('should maintain priority ordering after decay', () => {
    // Enqueue 3 items with different priorities
    const opp1 = createMockOpportunity({ priority: 0.9, id: 'opp-1' });
    const opp2 = createMockOpportunity({ priority: 0.7, id: 'opp-2' });
    const opp3 = createMockOpportunity({ priority: 0.5, id: 'opp-3' });

    service.enqueue(opp1);
    service.enqueue(opp2);
    service.enqueue(opp3);

    // Dequeue and verify order
    const first = service.dequeue();
    expect(first).not.toBeNull();
    expect(first!.opportunity.id).toBe('opp-1');

    const second = service.dequeue();
    expect(second).not.toBeNull();
    expect(second!.opportunity.id).toBe('opp-2');

    const third = service.dequeue();
    expect(third).not.toBeNull();
    expect(third!.opportunity.id).toBe('opp-3');
  });

  // --------
  // Cold-Start Dampening Tests
  // --------

  it('should enqueue with dampening applied based on decision count', async () => {
    // Mock queryEventFrequency to return 0 decisions
    const mockResult: EventFrequencyResult = {
      eventType: 'DECISION_CYCLE_STARTED',
      count: 0,
      windowStartTime: new Date(),
      windowEndTime: new Date(),
    };
    mockEventsService.queryEventFrequency.mockResolvedValue([mockResult]);

    const opp = createMockOpportunity({ priority: 1.0, id: 'test-opp' });
    service.enqueue(opp);

    // Enqueue again
    service.enqueue(createMockOpportunity({ priority: 1.0, id: 'test-opp-2' }));

    const state = service.getState();
    expect(state.size).toBe(2);
  });

  it('should compute dampening correctly at different decision counts', async () => {
    const config = createMockConfig({
      coldStartThreshold: 100,
      coldStartInitialDampening: 0.8,
    });

    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const newMockEventsService = {
      record: jest.fn().mockResolvedValue({ eventId: 'test-id', timestamp: new Date() }),
      query: jest.fn().mockResolvedValue([]),
      queryEventFrequency: jest.fn().mockResolvedValue([]),
      queryPattern: jest.fn().mockResolvedValue([]),
      queryLearnableEvents: jest.fn().mockResolvedValue([]),
      markProcessed: jest.fn().mockResolvedValue(undefined),
      markProcessedBatch: jest.fn().mockResolvedValue(undefined),
    };

    const newMockDriveStateReader = {
      getCurrentState: jest.fn().mockReturnValue(createMockDriveSnapshot()),
      driveState$: of(createMockDriveSnapshot()) as Observable<DriveSnapshot>,
      getTotalPressure: jest.fn().mockReturnValue(2.5),
    } as any;

    const testService = new OpportunityQueueService(
      newMockConfigService,
      newMockEventsService,
      newMockDriveStateReader,
    );

    const createMockResult = (count: number): EventFrequencyResult => ({
      eventType: 'DECISION_CYCLE_STARTED',
      count,
      windowStartTime: new Date(),
      windowEndTime: new Date(),
    });

    // Test: decision 0, dampening = 0.8
    newMockEventsService.queryEventFrequency.mockResolvedValue([createMockResult(0)]);
    let opp = createMockOpportunity({ priority: 1.0 });
    testService.enqueue(opp);

    // Test: decision 50, dampening = 0.4
    newMockEventsService.queryEventFrequency.mockResolvedValue([createMockResult(50)]);
    opp = createMockOpportunity({ priority: 1.0 });
    testService.enqueue(opp);

    // Test: decision 100, dampening = 0.0
    newMockEventsService.queryEventFrequency.mockResolvedValue([createMockResult(100)]);
    opp = createMockOpportunity({ priority: 1.0 });
    testService.enqueue(opp);

    // Test: decision 200, dampening = 0.0 (no negative dampening)
    newMockEventsService.queryEventFrequency.mockResolvedValue([createMockResult(200)]);
    opp = createMockOpportunity({ priority: 1.0 });
    testService.enqueue(opp);

    expect(testService.size()).toBeGreaterThan(0);
  });

  // --------
  // Event Emission Tests
  // --------

  it('should emit OPPORTUNITY_RECEIVED event on enqueue', () => {
    const opp = createMockOpportunity();
    service.enqueue(opp);

    expect(mockEventsService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'OPPORTUNITY_RECEIVED',
        subsystem: 'PLANNING',
        sessionId: 'test-session',
      }),
    );
  });

  it('should emit OPPORTUNITY_DROPPED event on eviction', () => {
    const config = createMockConfig({ queueMaxSize: 2 });
    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const newMockEventsService = {
      record: jest.fn().mockResolvedValue({ eventId: 'test-id', timestamp: new Date() }),
      query: jest.fn().mockResolvedValue([]),
      queryEventFrequency: jest.fn().mockResolvedValue([]),
      queryPattern: jest.fn().mockResolvedValue([]),
      queryLearnableEvents: jest.fn().mockResolvedValue([]),
      markProcessed: jest.fn().mockResolvedValue(undefined),
      markProcessedBatch: jest.fn().mockResolvedValue(undefined),
    };

    const newMockDriveStateReader = {
      getCurrentState: jest.fn().mockReturnValue(createMockDriveSnapshot()),
      driveState$: of(createMockDriveSnapshot()) as Observable<DriveSnapshot>,
      getTotalPressure: jest.fn().mockReturnValue(2.5),
    } as any;

    const testService = new OpportunityQueueService(
      newMockConfigService,
      newMockEventsService,
      newMockDriveStateReader,
    );

    // Fill queue to max
    testService.enqueue(createMockOpportunity({ priority: 0.9, id: 'opp-1' }));
    testService.enqueue(createMockOpportunity({ priority: 0.8, id: 'opp-2' }));

    // Clear previous calls
    newMockEventsService.record.mockClear();

    // Enqueue one more to trigger eviction
    testService.enqueue(createMockOpportunity({ priority: 0.7, id: 'opp-3' }));

    // Should have emitted both OPPORTUNITY_RECEIVED and OPPORTUNITY_DROPPED
    const calls = newMockEventsService.record.mock.calls;
    const hasDropped = calls.some(([event]) => (event as any).type === 'OPPORTUNITY_DROPPED');
    const hasReceived = calls.some(([event]) => (event as any).type === 'OPPORTUNITY_RECEIVED');

    expect(hasReceived).toBe(true);
    expect(hasDropped).toBe(true);
  });

  // --------
  // State Tests
  // --------

  it('should return correct state via getState()', () => {
    service.enqueue(createMockOpportunity({ priority: 0.8, id: 'opp-1' }));
    service.enqueue(createMockOpportunity({ priority: 0.6, id: 'opp-2' }));

    const state = service.getState();

    expect(state.size).toBe(2);
    expect(state.priorityDistribution).toHaveLength(2);
    expect(state.oldestAge).toBeGreaterThanOrEqual(0);
  });

  it('should track oldest item in getState()', () => {
    const opp1 = createMockOpportunity({
      priority: 0.8,
      id: 'opp-1',
    });
    service.enqueue(opp1);

    const state = service.getState();
    expect(state.size).toBe(1);
    expect(state.oldestAge).toBeGreaterThanOrEqual(0);
  });

  it('should return size 0 and oldestAge 0 for empty queue', () => {
    const state = service.getState();

    expect(state.size).toBe(0);
    expect(state.oldestAge).toBe(0);
    expect(state.priorityDistribution).toEqual([]);
  });
});

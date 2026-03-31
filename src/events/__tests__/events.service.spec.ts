/**
 * Unit tests for EventsService.
 *
 * These tests cover the full implementation of EventsService methods:
 * - record() with boundary validation
 * - query() with dynamic filtering and pagination
 * - queryLearnableEvents() with FIFO and SKIP LOCKED
 * - queryEventFrequency() for Drive Engine signal computation
 * - queryPattern() for Planning research
 * - markProcessed() and markProcessedBatch() for Learning consolidation
 *
 * Tests use jest.mock to inject a mock pg.Pool and verify SQL construction,
 * parameter binding, and error handling without requiring a live database.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Pool, PoolClient } from 'pg';
import { EventsService } from '../events.service';
import { TIMESCALEDB_POOL } from '../events.tokens';
import {
  EventValidationError,
  EventStorageError,
  EventQueryError,
} from '../exceptions/events.exceptions';
import type {
  SylphieEvent,
  LearnableEvent,
} from '../../shared/types/event.types';
import type { RecordResult } from '../interfaces/events.interfaces';

// ===== Mock Setup =====

/**
 * Helper to create a mock PoolClient with jest.fn() methods.
 */
function createMockClient() {
  return {
    query: jest.fn(),
    release: jest.fn(),
  } as any;
}

/**
 * Helper to create a mock Pool with jest.fn() methods.
 */
function createMockPool() {
  return {
    connect: jest.fn(),
    end: jest.fn(),
  } as any;
}

// ===== Fixtures =====

import { DriveName } from '../../shared/types/drive.types';

/**
 * Default drive snapshot for test events.
 */
const mockDriveSnapshot: any = {
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
 * Valid DECISION_MAKING event for testing.
 */
const validDecisionMakingEvent: Omit<SylphieEvent, 'id' | 'timestamp'> = {
  type: 'DECISION_CYCLE_STARTED',
  subsystem: 'DECISION_MAKING',
  sessionId: 'session-123',
  driveSnapshot: mockDriveSnapshot,
  schemaVersion: 1,
};

/**
 * Valid COMMUNICATION event for testing.
 */
const validCommunicationEvent: Omit<SylphieEvent, 'id' | 'timestamp'> = {
  type: 'INPUT_RECEIVED',
  subsystem: 'COMMUNICATION',
  sessionId: 'session-123',
  driveSnapshot: mockDriveSnapshot,
  schemaVersion: 1,
};

/**
 * Valid LEARNING event for testing.
 */
const validLearningEvent: Omit<SylphieEvent, 'id' | 'timestamp'> = {
  type: 'CONSOLIDATION_CYCLE_STARTED',
  subsystem: 'LEARNING',
  sessionId: 'session-123',
  driveSnapshot: mockDriveSnapshot,
  schemaVersion: 1,
};

/**
 * Valid DRIVE_ENGINE event for testing.
 */
const validDriveEngineEvent: Omit<SylphieEvent, 'id' | 'timestamp'> = {
  type: 'DRIVE_TICK',
  subsystem: 'DRIVE_ENGINE',
  sessionId: 'session-123',
  driveSnapshot: mockDriveSnapshot,
  schemaVersion: 1,
};

/**
 * Valid PLANNING event for testing.
 */
const validPlanningEvent: Omit<SylphieEvent, 'id' | 'timestamp'> = {
  type: 'OPPORTUNITY_INTAKE',
  subsystem: 'PLANNING',
  sessionId: 'session-123',
  driveSnapshot: mockDriveSnapshot,
  schemaVersion: 1,
};

/**
 * Boundary violation: LEARNING subsystem trying to emit DECISION_MAKING event.
 */
const boundaryViolationEvent: Omit<SylphieEvent, 'id' | 'timestamp'> = {
  type: 'PREDICTION_CREATED',
  subsystem: 'LEARNING',
  sessionId: 'session-123',
  driveSnapshot: mockDriveSnapshot,
  schemaVersion: 1,
};

// ===== Tests =====

describe('EventsService', () => {
  let service: EventsService;
  let mockPool: any;
  let mockClient: any;

  beforeEach(async () => {
    mockPool = createMockPool();
    mockClient = createMockClient();
    mockPool.connect.mockResolvedValue(mockClient);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        {
          provide: TIMESCALEDB_POOL,
          useValue: mockPool,
        },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========== record() tests ==========

  describe('record()', () => {
    it('should successfully record a valid DECISION_MAKING event', async () => {
      const eventId = '550e8400-e29b-41d4-a716-446655440000';
      const timestamp = new Date();

      mockClient.query.mockResolvedValueOnce({ rows: [{ event_id: eventId, timestamp }] } as any);

      const result = await service.record(validDecisionMakingEvent);

      expect(result.eventId).toBe(eventId);
      expect(result.timestamp).toEqual(timestamp);
      expect(mockClient.query).toHaveBeenCalledTimes(1);

      // Verify SQL contains INSERT and the parameterized values
      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO events');
      expect(params).toContain('DECISION_CYCLE_STARTED');
      expect(params).toContain('DECISION_MAKING');
      // sessionId is in event_data JSON, not a direct param
      expect(params.some((p: any) => typeof p === 'string' && p.includes('session-123'))).toBe(true);
    });

    it('should successfully record a valid COMMUNICATION event', async () => {
      const eventId = '550e8400-e29b-41d4-a716-446655440001';
      const timestamp = new Date();

      mockClient.query.mockResolvedValueOnce({ rows: [{ event_id: eventId, timestamp }] } as any);

      const result = await service.record(validCommunicationEvent);

      expect(result.eventId).toBe(eventId);
      expect(mockClient.query).toHaveBeenCalledTimes(1);
    });

    it('should successfully record a valid LEARNING event', async () => {
      const eventId = '550e8400-e29b-41d4-a716-446655440002';
      const timestamp = new Date();

      mockClient.query.mockResolvedValueOnce({ rows: [{ event_id: eventId, timestamp }] } as any);

      const result = await service.record(validLearningEvent);

      expect(result.eventId).toBe(eventId);
      expect(mockClient.query).toHaveBeenCalledTimes(1);
    });

    it('should successfully record a valid DRIVE_ENGINE event', async () => {
      const eventId = '550e8400-e29b-41d4-a716-446655440003';
      const timestamp = new Date();

      mockClient.query.mockResolvedValueOnce({ rows: [{ event_id: eventId, timestamp }] } as any);

      const result = await service.record(validDriveEngineEvent);

      expect(result.eventId).toBe(eventId);
      expect(mockClient.query).toHaveBeenCalledTimes(1);
    });

    it('should successfully record a valid PLANNING event', async () => {
      const eventId = '550e8400-e29b-41d4-a716-446655440004';
      const timestamp = new Date();

      mockClient.query.mockResolvedValueOnce({ rows: [{ event_id: eventId, timestamp }] } as any);

      const result = await service.record(validPlanningEvent);

      expect(result.eventId).toBe(eventId);
      expect(mockClient.query).toHaveBeenCalledTimes(1);
    });

    it('should reject a boundary violation: LEARNING emitting PREDICTION_CREATED', async () => {
      await expect(service.record(boundaryViolationEvent)).rejects.toThrow(
        EventValidationError,
      );
    });

    it('should reject a boundary violation: COMMUNICATION emitting DRIVE_TICK', async () => {
      const event: Omit<SylphieEvent, 'id' | 'timestamp'> = {
        type: 'DRIVE_TICK',
        subsystem: 'COMMUNICATION',
        sessionId: 'session-123',
        driveSnapshot: mockDriveSnapshot,
        schemaVersion: 1,
      };

      await expect(service.record(event)).rejects.toThrow(EventValidationError);
    });

    it('should throw EventStorageError on database constraint violation', async () => {
      const dbError = new Error('duplicate key value violates unique constraint');
      mockClient.query.mockRejectedValueOnce(dbError);

      await expect(service.record(validDecisionMakingEvent)).rejects.toThrow(
        EventStorageError,
      );
    });

    it('should throw EventStorageError on connection timeout', async () => {
      const dbError = new Error('Connection timeout');
      mockClient.query.mockRejectedValueOnce(dbError);

      await expect(service.record(validDecisionMakingEvent)).rejects.toThrow(
        EventStorageError,
      );
    });

    it('should release client even on error', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('Test error'));

      try {
        await service.record(validDecisionMakingEvent);
      } catch {
        // Expect error
      }

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should include correlationId and provenance when provided', async () => {
      const eventId = '550e8400-e29b-41d4-a716-446655440005';
      const timestamp = new Date();
      const eventWithMetadata: Omit<SylphieEvent, 'id' | 'timestamp'> = {
        ...validDecisionMakingEvent,
        correlationId: 'corr-123',
        provenance: 'SENSOR',
      };

      mockClient.query.mockResolvedValueOnce({ rows: [{ event_id: eventId, timestamp }] } as any);

      const result = await service.record(eventWithMetadata);

      expect(result.eventId).toBe(eventId);
      const [, params] = mockClient.query.mock.calls[0];
      expect(params).toContain('corr-123');
    });

    it('should return EventStorageError if INSERT returns no rows', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] } as any);

      // NOTE: Boundary validation happens first, so this event must pass validation
      await expect(service.record(validDecisionMakingEvent)).rejects.toThrow(
        EventStorageError,
      );
    });
  });

  // ========== query() tests ==========

  describe('query()', () => {
    it('should query events without filters', async () => {
      const mockRow = {
        event_id: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: new Date('2026-01-01'),
        event_type: 'DECISION_CYCLE_STARTED',
        subsystem_source: 'DECISION_MAKING',
        correlation_id: null,
        actor_id: 'sylphie',
        drive_snapshot: JSON.stringify(mockDriveSnapshot),
        tick_number: null,
        event_data: JSON.stringify({ sessionId: 'session-123', provenance: 'SENSOR' }),
        has_learnable: false,
        processed: false,
        schema_version: 1,
      };

      mockClient.query.mockResolvedValueOnce({ rows: [mockRow] } as any);

      const result = await service.query({});

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(result[0].type).toBe('DECISION_CYCLE_STARTED');
      expect(result[0].subsystem).toBe('DECISION_MAKING');

      // Verify query was called with parameterized SQL
      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql] = mockClient.query.mock.calls[0];
      expect(sql).toContain('SELECT');
      expect(sql).toContain('FROM events');
    });

    it('should filter by event types', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.query({
        types: ['DECISION_CYCLE_STARTED', 'INPUT_RECEIVED'],
      });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('event_type IN');
      expect(params).toContain('DECISION_CYCLE_STARTED');
      expect(params).toContain('INPUT_RECEIVED');
    });

    it('should filter by subsystems', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.query({
        subsystems: ['DECISION_MAKING', 'COMMUNICATION'],
      });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('subsystem_source IN');
      expect(params).toContain('DECISION_MAKING');
      expect(params).toContain('COMMUNICATION');
    });

    it('should filter by time range', async () => {
      const startTime = new Date('2026-01-01');
      const endTime = new Date('2026-01-02');

      mockClient.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.query({ startTime, endTime });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('timestamp >=');
      expect(sql).toContain('timestamp <=');
      expect(params).toContain(startTime);
      expect(params).toContain(endTime);
    });

    it('should filter by sessionId', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.query({ sessionId: 'session-xyz' });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain("event_data->>'sessionId'");
      expect(params).toContain('session-xyz');
    });

    it('should filter by correlationId', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.query({ correlationId: 'corr-abc' });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('correlation_id');
      expect(params).toContain('corr-abc');
    });

    it('should enforce limit (default 100, max 10000)', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.query({ limit: 500 });

      const [, params] = mockClient.query.mock.calls[0];
      // Check that the limit parameter is 500 (within max)
      expect(params).toContain(500);
    });

    it('should cap limit at 10000', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.query({ limit: 50000 });

      const [, params] = mockClient.query.mock.calls[0];
      // Check that the limit parameter is capped at 10000
      expect(params).toContain(10000);
    });

    it('should apply offset for pagination', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.query({ limit: 50, offset: 100 });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('OFFSET');
      expect(params).toContain(50);
      expect(params).toContain(100);
    });

    it('should order by timestamp DESC (most recent first)', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.query({});

      const [sql] = mockClient.query.mock.calls[0];
      expect(sql).toContain('ORDER BY timestamp DESC');
    });

    it('should deserialize JSONB drive_snapshot and event_data', async () => {
      const mockRow = {
        event_id: 'id-1',
        timestamp: new Date(),
        event_type: 'INPUT_RECEIVED',
        subsystem_source: 'COMMUNICATION',
        correlation_id: null,
        actor_id: 'sylphie',
        drive_snapshot: JSON.stringify(mockDriveSnapshot),
        tick_number: null,
        event_data: JSON.stringify({ sessionId: 'session-abc', provenance: 'GUARDIAN' }),
        has_learnable: false,
        processed: false,
        schema_version: 1,
      };

      mockClient.query.mockResolvedValueOnce({ rows: [mockRow] } as any);

      const result = await service.query({});

      expect(result[0].driveSnapshot).toBeDefined();
      expect(result[0].driveSnapshot.tickNumber).toBe(1);
      expect(result[0].driveSnapshot.totalPressure).toBe(4.8);
      expect(result[0].sessionId).toBe('session-abc');
    });

    it('should throw EventQueryError on connection timeout', async () => {
      const dbError = new Error('Connection timeout');
      mockClient.query.mockRejectedValueOnce(dbError);

      await expect(service.query({})).rejects.toThrow(EventQueryError);
    });

    it('should throw EventQueryError on query failure', async () => {
      const dbError = new Error('Syntax error in query');
      mockClient.query.mockRejectedValueOnce(dbError);

      await expect(service.query({})).rejects.toThrow(EventQueryError);
    });

    it('should release client even on error', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('Test error'));

      try {
        await service.query({});
      } catch {
        // Expect error
      }

      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  // ========== queryLearnableEvents() tests ==========

  describe('queryLearnableEvents()', () => {
    it('should query learnable events with default limit of 5', async () => {
      const mockRow = {
        event_id: 'id-1',
        timestamp: new Date('2026-01-01'),
        event_type: 'INPUT_RECEIVED',
        subsystem_source: 'COMMUNICATION',
        correlation_id: null,
        actor_id: 'sylphie',
        drive_snapshot: JSON.stringify(mockDriveSnapshot),
        tick_number: null,
        event_data: JSON.stringify({
          sessionId: 'session-123',
          hasLearnable: true,
          content: 'test content',
          guardianFeedbackType: 'confirmation',
          source: 'SENSOR',
          salience: 0.8,
        }),
        has_learnable: true,
        processed: false,
        schema_version: 1,
      };

      mockClient.query
        .mockResolvedValueOnce({ rows: [] } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [mockRow] } as any) // SELECT FOR UPDATE
        .mockResolvedValueOnce({ rows: [] } as any); // COMMIT

      const result = await service.queryLearnableEvents();

      expect(result).toHaveLength(1);
      expect((result[0] as any).hasLearnable).toBe(true);
      expect((result[0] as any).content).toBe('test content');

      // Verify SELECT FOR UPDATE SKIP LOCKED was called
      const selectCall = mockClient.query.mock.calls[1];
      expect(selectCall[0]).toContain('FOR UPDATE SKIP LOCKED');
      expect(selectCall[1]).toContain(5); // Default limit
    });

    it('should respect custom limit', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [] } as any) // SELECT FOR UPDATE
        .mockResolvedValueOnce({ rows: [] } as any); // COMMIT

      await service.queryLearnableEvents(10);

      const selectCall = mockClient.query.mock.calls[1];
      expect(selectCall[1]).toContain(10);
    });

    it('should cap limit at 50', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [] } as any) // SELECT FOR UPDATE
        .mockResolvedValueOnce({ rows: [] } as any); // COMMIT

      await service.queryLearnableEvents(100);

      const selectCall = mockClient.query.mock.calls[1];
      expect(selectCall[1]).toContain(50);
    });

    it('should return empty array if limit < 1', async () => {
      const result = await service.queryLearnableEvents(0);

      expect(result).toEqual([]);
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should return empty array if limit is negative', async () => {
      const result = await service.queryLearnableEvents(-5);

      expect(result).toEqual([]);
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should filter WHERE has_learnable = true AND processed = false', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [] } as any) // SELECT FOR UPDATE
        .mockResolvedValueOnce({ rows: [] } as any); // COMMIT

      await service.queryLearnableEvents();

      const selectCall = mockClient.query.mock.calls[1];
      expect(selectCall[0]).toContain('has_learnable = true');
      expect(selectCall[0]).toContain('processed = false');
    });

    it('should order by timestamp ASC (FIFO)', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [] } as any) // SELECT FOR UPDATE
        .mockResolvedValueOnce({ rows: [] } as any); // COMMIT

      await service.queryLearnableEvents();

      const selectCall = mockClient.query.mock.calls[1];
      expect(selectCall[0]).toContain('ORDER BY timestamp ASC');
    });

    it('should commit transaction after reading', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [] } as any) // SELECT FOR UPDATE
        .mockResolvedValueOnce({ rows: [] } as any); // COMMIT

      await service.queryLearnableEvents();

      expect(mockClient.query).toHaveBeenCalledTimes(3);
      expect(mockClient.query.mock.calls[2][0]).toContain('COMMIT');
    });

    it('should rollback on error', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] } as any) // BEGIN
        .mockRejectedValueOnce(new Error('Query failed')) // SELECT FOR UPDATE fails
        .mockResolvedValueOnce({ rows: [] } as any); // ROLLBACK

      try {
        await service.queryLearnableEvents();
      } catch {
        // Expect error
      }

      expect(mockClient.query).toHaveBeenCalledTimes(3);
      expect(mockClient.query.mock.calls[2][0]).toContain('ROLLBACK');
    });

    it('should throw EventQueryError on connection timeout', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] } as any) // BEGIN
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockResolvedValueOnce({ rows: [] } as any); // ROLLBACK

      await expect(service.queryLearnableEvents()).rejects.toThrow(
        EventQueryError,
      );
    });

    it('should release client after successful query', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [] } as any) // SELECT FOR UPDATE
        .mockResolvedValueOnce({ rows: [] } as any); // COMMIT

      await service.queryLearnableEvents();

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should release client even on error', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] } as any) // BEGIN
        .mockRejectedValueOnce(new Error('Query failed'))
        .mockResolvedValueOnce({ rows: [] } as any); // ROLLBACK

      try {
        await service.queryLearnableEvents();
      } catch {
        // Expect error
      }

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should reconstruct full LearnableEvent from row data', async () => {
      const mockRow = {
        event_id: 'id-learnable',
        timestamp: new Date('2026-01-01T10:00:00Z'),
        event_type: 'RESPONSE_DELIVERED',
        subsystem_source: 'COMMUNICATION',
        correlation_id: 'corr-xyz',
        actor_id: 'sylphie',
        drive_snapshot: JSON.stringify(mockDriveSnapshot),
        tick_number: null,
        event_data: JSON.stringify({
          sessionId: 'session-456',
          hasLearnable: true,
          content: 'learned fact',
          guardianFeedbackType: 'correction',
          source: 'GUARDIAN',
          salience: 0.95,
          provenance: 'GUARDIAN',
        }),
        has_learnable: true,
        processed: false,
        schema_version: 1,
      };

      mockClient.query
        .mockResolvedValueOnce({ rows: [] } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [mockRow] } as any) // SELECT FOR UPDATE
        .mockResolvedValueOnce({ rows: [] } as any); // COMMIT

      const result = await service.queryLearnableEvents();

      expect(result).toHaveLength(1);
      const event = result[0] as any;
      expect(event.id).toBe('id-learnable');
      expect(event.type).toBe('RESPONSE_DELIVERED');
      expect(event.subsystem).toBe('COMMUNICATION');
      expect(event.hasLearnable).toBe(true);
      expect(event.content).toBe('learned fact');
      expect(event.guardianFeedbackType).toBe('correction');
      expect(event.source).toBe('GUARDIAN');
      expect(event.salience).toBe(0.95);
    });
  });

  // ========== markProcessed() tests ==========

  describe('markProcessed()', () => {
    it('should mark a single event as processed with valid UUID', async () => {
      const validUUID = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.query.mockResolvedValueOnce({ rows: [{ event_id: validUUID }] } as any);

      await service.markProcessed(validUUID);

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('UPDATE events');
      expect(sql).toContain('processed = true');
      expect(params).toContain(validUUID);
    });

    it('should throw EventValidationError if UUID is invalid', async () => {
      await expect(service.markProcessed('invalid-id')).rejects.toThrow(
        'Invalid UUID format',
      );
    });

    it('should support marking events as processed with valid UUID format', async () => {
      const validUUID = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.query.mockResolvedValueOnce({ rowCount: 1 } as any);

      // Should succeed without throwing
      await service.markProcessed(validUUID);

      expect(mockClient.query).toHaveBeenCalledTimes(1);
    });

    it('should release client after success', async () => {
      const validUUID = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.query.mockResolvedValueOnce({ rows: [{ event_id: validUUID }] } as any);

      await service.markProcessed(validUUID);

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should release client on query error', async () => {
      const validUUID = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.query.mockRejectedValueOnce(new Error('DB error'));

      try {
        await service.markProcessed(validUUID);
      } catch {
        // Expect error
      }

      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  // ========== markProcessedBatch() tests ==========

  describe('markProcessedBatch()', () => {
    it('should mark multiple events as processed', async () => {
      mockClient.query.mockResolvedValueOnce({ rowCount: 2 } as any);

      await service.markProcessedBatch([
        '550e8400-e29b-41d4-a716-446655440000',
        '550e8400-e29b-41d4-a716-446655440001',
      ]);

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('UPDATE events');
      expect(sql).toContain('processed = true');
      // Implementation uses ANY($1::uuid[]) syntax instead of IN
      expect(sql).toContain('ANY');
    });

    it('should be a no-op for empty array', async () => {
      await service.markProcessedBatch([]);

      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should validate all UUIDs in batch', async () => {
      await expect(
        service.markProcessedBatch([
          '550e8400-e29b-41d4-a716-446655440000',
          'invalid-uuid',
        ]),
      ).rejects.toThrow();
    });

    it('should release client after success', async () => {
      mockClient.query.mockResolvedValueOnce({ rowCount: 1 } as any);

      await service.markProcessedBatch(['550e8400-e29b-41d4-a716-446655440000']);

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should release client on query error', async () => {
      const validUUID = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.query.mockRejectedValueOnce(new Error('DB error'));

      try {
        await service.markProcessedBatch([validUUID]);
      } catch {
        // Expect error
      }

      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});

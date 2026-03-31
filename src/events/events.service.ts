/**
 * EventsService — TimescaleDB event persistence and querying.
 *
 * Implements IEventService with all seven required methods. Methods not yet
 * implemented in this ticket throw EventValidationError with explicit ticket
 * references for the caller to understand what to do next.
 *
 * On module init (OnModuleInit):
 * - Verifies TimescaleDB connection with SELECT 1
 * - Creates two critical indexes on (has_learnable, processed, timestamp) and (subsystem_source, timestamp DESC)
 * - Both indexes support key query paths: queryLearnableEvents and pattern research
 *
 * On module destroy (OnModuleDestroy):
 * - No-op; pool cleanup is handled by TimescaleInitService
 *
 * CANON §TimescaleDB — The Event Backbone: all five subsystems read/write
 * exclusively through this service. No direct database clients outside events/.
 */

import {
  Injectable,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import type { SylphieEvent, EventType, LearnableEvent } from '../shared/types/event.types';
import type {
  IEventService,
  EventQueryOptions,
  EventFrequencyResult,
  EventPatternQuery,
  RecordResult,
} from './interfaces/events.interfaces';
import { TIMESCALEDB_POOL } from './events.tokens';
import { TimescaleInitService } from './timescale-init.service';
import { validateEventBoundary } from '../shared/types/event.types';
import {
  EventValidationError,
  EventStorageError,
  EventQueryError,
  EventNotFoundError,
} from './exceptions/events.exceptions';

@Injectable()
export class EventsService implements IEventService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @Inject(TIMESCALEDB_POOL) private readonly pool: Pool,
    private readonly timescaleInit: TimescaleInitService,
  ) {}

  /**
   * Initialize the service: verify connection and create critical indexes.
   * Called automatically by NestJS on application start.
   *
   * Note: TimescaleInitService is injected to ensure NestJS initializes it
   * (and its onModuleInit which creates the hypertable) before this service.
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing EventsService...');

    try {
      // Verify connection works and hypertable exists
      await this.healthCheck();

      // Create critical indexes not created by TimescaleInitService
      await this.createCriticalIndexes();

      this.logger.log('EventsService initialized successfully');
    } catch (error) {
      this.logger.error('EventsService initialization failed:', error);
      throw error;
    }
  }

  /**
   * Module destroy hook. No-op; TimescaleInitService handles pool cleanup.
   */
  async onModuleDestroy(): Promise<void> {
    // Pool cleanup is handled by TimescaleInitService
  }

  /**
   * Health check: verify database connection and events hypertable exists.
   * @throws EventStorageError if connection or hypertable check fails
   */
  async healthCheck(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      // Test basic connectivity
      const selectResult = await client.query('SELECT 1 as health_check');
      if (!selectResult.rows.length) {
        throw new Error('Health check SELECT 1 returned no rows');
      }

      // Verify events hypertable exists
      const hypertableCheckSql = `
        SELECT EXISTS(
          SELECT 1 FROM timescaledb_information.hypertables
          WHERE hypertable_name = 'events'
        ) as is_hypertable;
      `;
      const hypertableResult = await client.query(hypertableCheckSql);
      const isHypertable = hypertableResult.rows[0]?.is_hypertable;

      if (!isHypertable) {
        throw new EventStorageError(
          'events table is not a valid hypertable',
          { table: 'events' },
        );
      }

      this.logger.debug('EventsService health check passed');
      return true;
    } catch (error) {
      if (error instanceof EventStorageError) {
        throw error;
      }
      throw new EventStorageError(
        'EventsService health check failed',
        { originalError: String(error) },
        error,
      );
    } finally {
      client.release();
    }
  }

  /**
   * Create critical indexes for query performance.
   * Both indexes are idempotent and safe to create multiple times.
   */
  private async createCriticalIndexes(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Index for queryLearnableEvents: (has_learnable, processed, timestamp) WHERE has_learnable = true AND processed = false
      const learnableIndexSql = `
        CREATE INDEX IF NOT EXISTS idx_has_learnable_processed
        ON events (has_learnable, processed, timestamp)
        WHERE has_learnable = true AND processed = false;
      `;

      // Index for pattern research: (subsystem_source, timestamp DESC)
      const subsystemIndexSql = `
        CREATE INDEX IF NOT EXISTS idx_subsystem_timestamp
        ON events (subsystem_source, timestamp DESC);
      `;

      await client.query(learnableIndexSql);
      await client.query(subsystemIndexSql);

      this.logger.debug('Critical indexes created or already exist');
    } catch (error) {
      throw new EventStorageError(
        'Failed to create critical indexes',
        { originalError: String(error) },
        error,
      );
    } finally {
      client.release();
    }
  }

  /**
   * Record a new event to TimescaleDB.
   *
   * Implementation (E2-T003):
   * 1. Validates subsystem/event_type boundary using validateEventBoundary()
   * 2. Generates event_id as UUID v4 server-side (crypto.randomUUID)
   * 3. Generates timestamp as current time
   * 4. Extracts all fields and constructs parameterized INSERT
   * 5. Returns { eventId, timestamp } on success
   *
   * @param event - All SylphieEvent fields except id and timestamp
   * @returns The generated eventId and server-side timestamp
   * @throws EventValidationError if the event violates the boundary contract
   * @throws EventStorageError if the TimescaleDB write fails
   */
  async record(
    event: Omit<SylphieEvent, 'id' | 'timestamp'>,
  ): Promise<RecordResult> {
    // Step 1: Validate subsystem/event_type boundary
    const isBoundaryValid = validateEventBoundary(event.type, event.subsystem);
    if (!isBoundaryValid) {
      throw new EventValidationError(
        `Event type "${event.type}" is not owned by subsystem "${event.subsystem}"`,
        {
          eventType: event.type,
          subsystem: event.subsystem,
        },
      );
    }

    // Step 2: Generate event_id (UUID v4)
    const eventId = randomUUID();

    // Step 3: Generate timestamp (wall-clock time of persistence)
    const timestamp = new Date();

    // Step 4: Build the event_data JSONB payload
    // Includes all SylphieEvent fields except type, subsystem, and those that map to table columns
    const eventData = {
      sessionId: event.sessionId,
      provenance: event.provenance,
      // For LearnableEvent, include learnable-specific fields
      ...(hasLearnableProperties(event) && {
        hasLearnable: event.hasLearnable,
        content: event.content,
        guardianFeedbackType: event.guardianFeedbackType,
        source: event.source,
        salience: event.salience,
      }),
      // For ReinforcementEvent, include reinforcement-specific fields
      ...(hasReinforcementProperties(event) && {
        actionId: event.actionId,
        reinforcementPolarity: event.reinforcementPolarity,
      }),
      // For other specific event types, include type-specific fields
      ...(hasActionExecutedProperties(event) && {
        actionId: event.actionId,
        actionType: event.actionType,
        arbitrationType: event.arbitrationType,
      }),
      ...(hasPredictionEvaluatedProperties(event) && {
        predictionId: event.predictionId,
        actionId: event.actionId,
        absoluteError: event.absoluteError,
        accurate: event.accurate,
      }),
    };

    // Step 5: Determine has_learnable flag
    const hasLearnable = hasLearnableProperties(event)
      ? event.hasLearnable
      : false;

    // Step 6: Parameterized INSERT into TimescaleDB
    const insertSql = `
      INSERT INTO events (
        event_id,
        timestamp,
        event_type,
        subsystem_source,
        correlation_id,
        actor_id,
        drive_snapshot,
        tick_number,
        event_data,
        has_learnable,
        processed,
        schema_version
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING event_id, timestamp;
    `;

    const client = await this.pool.connect();
    try {
      const result = await client.query(insertSql, [
        eventId, // $1: event_id
        timestamp, // $2: timestamp
        event.type, // $3: event_type
        event.subsystem, // $4: subsystem_source
        event.correlationId ?? null, // $5: correlation_id (nullable)
        'sylphie', // $6: actor_id (default)
        event.driveSnapshot ? JSON.stringify(event.driveSnapshot) : null, // $7: drive_snapshot (JSONB)
        null, // $8: tick_number (not set in this implementation)
        JSON.stringify(eventData), // $9: event_data (JSONB)
        hasLearnable, // $10: has_learnable
        false, // $11: processed (false on insert)
        event.schemaVersion ?? 1, // $12: schema_version
      ]);

      if (!result.rows.length) {
        throw new EventStorageError(
          'INSERT did not return a row',
          { eventId, timestamp },
        );
      }

      const returnedRow = result.rows[0];
      return {
        eventId: returnedRow.event_id,
        timestamp: returnedRow.timestamp,
      };
    } catch (error) {
      // Distinguish between validation/constraint errors and connection/timeout errors
      if (error instanceof EventValidationError) {
        throw error;
      }

      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();

        // Log and categorize the error
        if (errorMsg.includes('timeout') || errorMsg.includes('ECONNREFUSED')) {
          this.logger.error(
            `EventsService.record() connection timeout or lost: ${error.message}`,
            { eventId, eventType: event.type, subsystem: event.subsystem },
          );
          throw new EventStorageError(
            'TimescaleDB connection timeout or lost',
            {
              eventId,
              eventType: event.type,
              subsystem: event.subsystem,
              originalError: error.message,
            },
            error,
          );
        }

        // Constraint violations (duplicate key, not null, etc.)
        if (
          errorMsg.includes('constraint') ||
          errorMsg.includes('unique') ||
          errorMsg.includes('violation')
        ) {
          this.logger.error(
            `EventsService.record() constraint violation: ${error.message}`,
            { eventId, eventType: event.type, subsystem: event.subsystem },
          );
          throw new EventStorageError(
            'TimescaleDB constraint violation',
            {
              eventId,
              eventType: event.type,
              subsystem: event.subsystem,
              originalError: error.message,
            },
            error,
          );
        }

        // Generic storage error
        this.logger.error(
          `EventsService.record() storage error: ${error.message}`,
          { eventId, eventType: event.type, subsystem: event.subsystem },
        );
        throw new EventStorageError(
          'TimescaleDB write failed',
          {
            eventId,
            eventType: event.type,
            subsystem: event.subsystem,
            originalError: error.message,
          },
          error,
        );
      }

      // Unknown error type
      this.logger.error('EventsService.record() unknown error', {
        eventId,
        eventType: event.type,
        subsystem: event.subsystem,
        error,
      });
      throw new EventStorageError(
        'TimescaleDB write failed with unknown error',
        {
          eventId,
          eventType: event.type,
          subsystem: event.subsystem,
        },
        error,
      );
    } finally {
      client.release();
    }
  }

  /**
   * Query events with filtering and pagination options.
   *
   * Implementation (E2-T004):
   * 1. Builds dynamic WHERE clause from non-null filter fields (types, subsystems, timeranges, sessionId, correlationId)
   * 2. Defaults: startTime = 24h ago if not provided; endTime = now if not provided
   * 3. Enforces limits: default 100, max 10000
   * 4. Orders by timestamp DESC (most recent first)
   * 5. Applies LIMIT + OFFSET for pagination
   * 6. Deserializes JSONB fields (drive_snapshot, event_data) back to typed objects
   * 7. Reconstructs full SylphieEvent from database columns
   *
   * @param options - Filter and pagination options
   * @returns Matching events in descending timestamp order (most recent first)
   * @throws EventQueryError if the TimescaleDB read fails
   */
  async query(options: EventQueryOptions): Promise<readonly SylphieEvent[]> {
    const client = await this.pool.connect();
    try {
      // ===== Step 1: Build dynamic WHERE clause =====
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      // Filter by event types (IN clause)
      if (options.types && options.types.length > 0) {
        const placeholders = options.types
          .map(() => `$${paramIndex++}`)
          .join(', ');
        conditions.push(`event_type IN (${placeholders})`);
        params.push(...options.types);
      }

      // Filter by subsystems (IN clause)
      if (options.subsystems && options.subsystems.length > 0) {
        const placeholders = options.subsystems
          .map(() => `$${paramIndex++}`)
          .join(', ');
        conditions.push(`subsystem_source IN (${placeholders})`);
        params.push(...options.subsystems);
      }

      // Filter by time range (inclusive)
      // Default: startTime = 24h ago if not provided
      const startTime = options.startTime ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(startTime);

      // Default: endTime = now if not provided
      const endTime = options.endTime ?? new Date();
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(endTime);

      // Filter by sessionId (equality)
      if (options.sessionId) {
        conditions.push(`event_data->>'sessionId' = $${paramIndex++}`);
        params.push(options.sessionId);
      }

      // Filter by correlationId (equality)
      if (options.correlationId) {
        conditions.push(`correlation_id = $${paramIndex++}`);
        params.push(options.correlationId);
      }

      // ===== Step 2: Enforce limit and offset =====
      const limit = Math.min(
        options.limit ?? 100,
        10000,
      );
      const offset = options.offset ?? 0;

      // ===== Step 3: Build complete query =====
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const querySql = `
        SELECT
          event_id,
          timestamp,
          event_type,
          subsystem_source,
          correlation_id,
          actor_id,
          drive_snapshot,
          tick_number,
          event_data,
          has_learnable,
          processed,
          schema_version
        FROM events
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT $${paramIndex++}
        OFFSET $${paramIndex++}
      `;

      params.push(limit, offset);

      // ===== Step 4: Execute query =====
      const result = await client.query(querySql, params);

      // ===== Step 5: Deserialize and reconstruct SylphieEvent[] =====
      const events: SylphieEvent[] = result.rows.map((row) => {
        // Parse JSONB fields
        const driveSnapshot = row.drive_snapshot
          ? typeof row.drive_snapshot === 'string'
            ? JSON.parse(row.drive_snapshot)
            : row.drive_snapshot
          : undefined;

        const eventData = row.event_data
          ? typeof row.event_data === 'string'
            ? JSON.parse(row.event_data)
            : row.event_data
          : {};

        // Reconstruct SylphieEvent from database columns + event_data
        const event: SylphieEvent = {
          id: row.event_id,
          type: row.event_type as EventType,
          timestamp: new Date(row.timestamp),
          subsystem: row.subsystem_source,
          sessionId: eventData.sessionId ?? '',
          driveSnapshot: driveSnapshot,
          schemaVersion: row.schema_version ?? 1,
          correlationId: row.correlation_id ?? undefined,
          provenance: eventData.provenance ?? undefined,
        };

        // For LearnableEvent, include learnable-specific fields if present
        if (row.has_learnable && eventData.hasLearnable) {
          const learnableEvent = event as SylphieEvent & {
            hasLearnable?: boolean;
            content?: string;
            guardianFeedbackType?: string;
            source?: string;
            salience?: number;
          };
          learnableEvent.hasLearnable = eventData.hasLearnable;
          learnableEvent.content = eventData.content;
          learnableEvent.guardianFeedbackType = eventData.guardianFeedbackType;
          learnableEvent.source = eventData.source;
          learnableEvent.salience = eventData.salience;
        }

        // For ReinforcementEvent, include reinforcement-specific fields if present
        if (eventData.actionId && eventData.reinforcementPolarity) {
          const reinforcementEvent = event as SylphieEvent & {
            actionId?: string;
            reinforcementPolarity?: string;
          };
          reinforcementEvent.actionId = eventData.actionId;
          reinforcementEvent.reinforcementPolarity = eventData.reinforcementPolarity;
        }

        // For ActionExecutedEvent, include action execution fields if present
        if (eventData.actionId && eventData.actionType && eventData.arbitrationType) {
          const actionExecutedEvent = event as SylphieEvent & {
            actionId?: string;
            actionType?: string;
            arbitrationType?: string;
          };
          actionExecutedEvent.actionId = eventData.actionId;
          actionExecutedEvent.actionType = eventData.actionType;
          actionExecutedEvent.arbitrationType = eventData.arbitrationType;
        }

        // For PredictionEvaluatedEvent, include prediction evaluation fields if present
        if (eventData.predictionId && eventData.actionId && eventData.absoluteError !== undefined) {
          const predictionEvaluatedEvent = event as SylphieEvent & {
            predictionId?: string;
            actionId?: string;
            absoluteError?: number;
            accurate?: boolean;
          };
          predictionEvaluatedEvent.predictionId = eventData.predictionId;
          predictionEvaluatedEvent.actionId = eventData.actionId;
          predictionEvaluatedEvent.absoluteError = eventData.absoluteError;
          predictionEvaluatedEvent.accurate = eventData.accurate;
        }

        return event;
      });

      return events;
    } catch (error) {
      // Distinguish between different error types
      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();

        // Connection/timeout errors
        if (errorMsg.includes('timeout') || errorMsg.includes('ECONNREFUSED')) {
          this.logger.error(
            `EventsService.query() connection timeout or lost: ${error.message}`,
            { options },
          );
          throw new EventQueryError(
            'TimescaleDB connection timeout or lost',
            { originalError: error.message },
            error,
          );
        }

        // Generic query error
        this.logger.error(
          `EventsService.query() query error: ${error.message}`,
          { options },
        );
        throw new EventQueryError(
          'TimescaleDB query failed',
          { originalError: error.message },
          error,
        );
      }

      // Unknown error type
      this.logger.error('EventsService.query() unknown error', { options, error });
      throw new EventQueryError(
        'TimescaleDB query failed with unknown error',
        { options: JSON.stringify(options) },
        error,
      );
    } finally {
      client.release();
    }
  }

  /**
   * Query unprocessed learnable events for the Learning subsystem (E2-T005).
   *
   * Implementation:
   * 1. Filter: has_learnable = true AND processed = false
   * 2. Order: timestamp ASC (FIFO consolidation, oldest first)
   * 3. Limit: configurable, default 5 (per CANON), hardcoded max 50
   * 4. Concurrency: SELECT FOR UPDATE SKIP LOCKED prevents multiple Learning
   *    cycles from claiming the same events
   * 5. Row mapping: reconstruct full SylphieEvent + LearnableEvent fields from
   *    table columns and event_data JSONB
   *
   * Transaction flow:
   * - Get client from pool
   * - BEGIN (implicit with client)
   * - SELECT FOR UPDATE SKIP LOCKED (acquires row locks)
   * - Map rows to LearnableEvent[]
   * - COMMIT (releases locks; caller must call markProcessed afterward)
   * - Release client
   *
   * Lock semantics: Locks are released after COMMIT. Even though the lock
   * releases before markProcessed() is called, the Learning subsystem will
   * call markProcessed() before the next cycle, setting processed=true.
   * In single-process NestJS, Learning cycles are sequential async, so
   * concurrent queries are rare. SKIP LOCKED still provides safety.
   *
   * @param limit - Maximum events to return. Defaults to 5 (CANON max per cycle).
   *                Hardcoded max is 50. Returning [] if limit < 1.
   * @returns Learnable events, oldest first, up to limit. Empty array if none.
   * @throws EventQueryError if the query fails or connection is lost
   */
  async queryLearnableEvents(limit?: number): Promise<readonly LearnableEvent[]> {
    // Step 1: Validate and normalize limit
    let finalLimit = limit ?? 5; // Default to 5 (CANON §Subsystem 3)
    if (finalLimit < 1) {
      return []; // Invalid limit; return empty
    }
    if (finalLimit > 50) {
      finalLimit = 50; // Hardcoded max
    }

    // Step 2: Get client and run query in transaction
    const client = await this.pool.connect();
    try {
      // Begin transaction (implicit with client acquisition)
      await client.query('BEGIN');

      // Step 3: Run SELECT FOR UPDATE SKIP LOCKED
      const querySql = `
        SELECT *
        FROM events
        WHERE has_learnable = true AND processed = false
        ORDER BY timestamp ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED;
      `;

      const result = await client.query(querySql, [finalLimit]);

      // Step 4: Map rows to LearnableEvent[]
      const learnableEvents: LearnableEvent[] = result.rows.map((row) => {
        // Parse event_data JSONB
        const eventData =
          typeof row.event_data === 'string'
            ? JSON.parse(row.event_data)
            : row.event_data;

        // Parse drive_snapshot JSONB if present
        const driveSnapshot =
          row.drive_snapshot &&
          (typeof row.drive_snapshot === 'string'
            ? JSON.parse(row.drive_snapshot)
            : row.drive_snapshot);

        // Reconstruct full LearnableEvent from table columns + event_data
        return {
          id: row.event_id,
          type: row.event_type as EventType,
          timestamp: row.timestamp,
          subsystem: row.subsystem_source,
          sessionId: eventData.sessionId,
          driveSnapshot,
          schemaVersion: row.schema_version ?? 1,
          correlationId: row.correlation_id,
          provenance: eventData.provenance,
          // LearnableEvent-specific fields from event_data
          hasLearnable: true, // Literal, since we filtered for it
          content: eventData.content ?? '',
          guardianFeedbackType: eventData.guardianFeedbackType ?? 'none',
          source: eventData.source ?? 'LLM_GENERATED',
          salience: eventData.salience ?? 0.5,
        } as LearnableEvent;
      });

      // Step 5: Commit transaction (releases row locks)
      await client.query('COMMIT');

      this.logger.debug(
        `queryLearnableEvents returned ${learnableEvents.length} events`,
        { limit: finalLimit, returnedCount: learnableEvents.length },
      );

      return learnableEvents;
    } catch (error) {
      // Rollback on error
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        this.logger.warn(
          `Failed to rollback transaction: ${rollbackError}`,
        );
      }

      // Distinguish between connection/timeout and other query errors
      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();

        if (errorMsg.includes('timeout') || errorMsg.includes('econnrefused')) {
          this.logger.error(
            `queryLearnableEvents connection timeout or lost: ${error.message}`,
            { limit: finalLimit },
          );
          throw new EventQueryError(
            'TimescaleDB connection timeout or lost during queryLearnableEvents',
            {
              limit: finalLimit,
              originalError: error.message,
            },
            error,
          );
        }

        // Generic query error
        this.logger.error(
          `queryLearnableEvents query failed: ${error.message}`,
          { limit: finalLimit },
        );
        throw new EventQueryError(
          'TimescaleDB query failed during queryLearnableEvents',
          {
            limit: finalLimit,
            originalError: error.message,
          },
          error,
        );
      }

      // Unknown error type
      this.logger.error('queryLearnableEvents unknown error', {
        limit: finalLimit,
        error,
      });
      throw new EventQueryError(
        'queryLearnableEvents failed with unknown error',
        { limit: finalLimit },
        error,
      );
    } finally {
      // Release client and transaction
      client.release();
    }
  }

  /**
   * Query event frequency for Drive Engine signal computation.
   *
   * Implementation (E2-T006):
   * 1. Validates eventTypes array is non-empty; returns empty array if empty
   * 2. Calculates window start time: now - windowMs
   * 3. Queries TimescaleDB with parameterized COUNT(*) aggregation
   * 4. Maps results to EventFrequencyResult with windowStartTime and windowEndTime
   * 5. Fills in zero counts for requested event types not returned by query
   * 6. Returns one result per requested event type (guarantees complete signal vector)
   *
   * Performance: <5ms p99 on typical drive tick. Uses simple index-backed aggregation.
   * Drive Engine runs at high tick rate; this must be fast.
   *
   * @param eventTypes - Event types to count (even if empty, returns [])
   * @param windowMs - Lookback window in milliseconds
   * @returns One EventFrequencyResult per requested event type, count may be 0
   * @throws EventQueryError if the aggregation query fails
   */
  async queryEventFrequency(
    eventTypes: readonly EventType[],
    windowMs: number,
  ): Promise<readonly EventFrequencyResult[]> {
    // Step 1: Validate eventTypes — empty array is valid, just return empty result
    if (eventTypes.length === 0) {
      return [];
    }

    // Step 2: Calculate window boundaries
    const windowEndTime = new Date();
    const windowStartTime = new Date(windowEndTime.getTime() - windowMs);

    // Step 3: Execute parameterized COUNT query with event_type filter and time window
    const client = await this.pool.connect();
    try {
      const countSql = `
        SELECT event_type, COUNT(*) as count
        FROM events
        WHERE event_type = ANY($1)
          AND timestamp >= $2
        GROUP BY event_type;
      `;

      const result = await client.query(countSql, [
        eventTypes as string[], // $1: event_type array
        windowStartTime, // $2: window start timestamp
      ]);

      // Step 4: Map query results to a Map for easy lookup
      const countByType = new Map<EventType, number>();
      for (const row of result.rows) {
        countByType.set(row.event_type as EventType, parseInt(row.count, 10));
      }

      // Step 5: Build complete result array with zero-fill for missing types
      const results: EventFrequencyResult[] = [];
      for (const eventType of eventTypes) {
        results.push({
          eventType,
          count: countByType.get(eventType) ?? 0,
          windowStartTime,
          windowEndTime,
        });
      }

      // Step 6: Return results in the same order as requested eventTypes
      return results;
    } catch (error) {
      // Connection failure or query error
      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();

        if (errorMsg.includes('timeout') || errorMsg.includes('ECONNREFUSED')) {
          this.logger.error(
            `EventsService.queryEventFrequency() connection timeout or lost: ${error.message}`,
            { eventTypeCount: eventTypes.length, windowMs },
          );
          throw new EventQueryError(
            'TimescaleDB connection timeout or lost',
            {
              eventTypeCount: eventTypes.length,
              windowMs,
              originalError: error.message,
            },
            error,
          );
        }

        this.logger.error(
          `EventsService.queryEventFrequency() query error: ${error.message}`,
          { eventTypeCount: eventTypes.length, windowMs },
        );
        throw new EventQueryError(
          'Event frequency query failed',
          {
            eventTypeCount: eventTypes.length,
            windowMs,
            originalError: error.message,
          },
          error,
        );
      }

      // Unknown error type
      this.logger.error('EventsService.queryEventFrequency() unknown error', {
        eventTypeCount: eventTypes.length,
        windowMs,
        error,
      });
      throw new EventQueryError(
        'Event frequency query failed with unknown error',
        {
          eventTypeCount: eventTypes.length,
          windowMs,
        },
        error,
      );
    } finally {
      client.release();
    }
  }

  /**
   * Query event patterns for Planning subsystem research.
   *
   * Returns raw events matching the pattern specification. The Planning
   * subsystem uses these events to estimate outcome probability in
   * SimulationService. Only events matching the contextFingerprint and
   * event types within the window are returned, and only if the total
   * count meets minOccurrences.
   *
   * @param query - Pattern specification including fingerprint, types, and window
   * @returns Matching events from the pattern window, oldest first
   * @throws EventQueryError if the pattern query fails
   */
  async queryPattern(query: EventPatternQuery): Promise<readonly SylphieEvent[]> {
    // Validate inputs
    if (!query.eventTypes || query.eventTypes.length === 0) {
      return [];
    }
    if (query.windowDays <= 0) {
      return [];
    }

    const client = await this.pool.connect();
    try {
      const windowStart = new Date(Date.now() - query.windowDays * 24 * 60 * 60 * 1000);
      const windowEnd = new Date();

      // First, check if we meet minOccurrences threshold
      const countSql = `
        SELECT COUNT(*) as total
        FROM events
        WHERE event_type = ANY($1)
          AND timestamp >= $2
          AND event_data->>'contextFingerprint' = $3
      `;
      const countResult = await client.query(countSql, [
        query.eventTypes as unknown as string[],
        windowStart,
        query.contextFingerprint,
      ]);

      const totalCount = parseInt(countResult.rows[0]?.total ?? '0', 10);
      if (totalCount < query.minOccurrences) {
        this.logger.debug(
          `queryPattern: ${totalCount} events found, below minOccurrences ${query.minOccurrences}`,
        );
        return [];
      }

      // Fetch matching events
      const querySql = `
        SELECT
          event_id, timestamp, event_type, subsystem_source,
          correlation_id, actor_id, drive_snapshot, tick_number,
          event_data, has_learnable, processed, schema_version
        FROM events
        WHERE event_type = ANY($1)
          AND timestamp >= $2
          AND event_data->>'contextFingerprint' = $3
        ORDER BY timestamp ASC
      `;
      const result = await client.query(querySql, [
        query.eventTypes as unknown as string[],
        windowStart,
        query.contextFingerprint,
      ]);

      // Map rows to SylphieEvent[]
      const events: SylphieEvent[] = result.rows.map((row) => {
        const driveSnapshot = row.drive_snapshot
          ? typeof row.drive_snapshot === 'string'
            ? JSON.parse(row.drive_snapshot)
            : row.drive_snapshot
          : undefined;

        const eventData = row.event_data
          ? typeof row.event_data === 'string'
            ? JSON.parse(row.event_data)
            : row.event_data
          : {};

        return {
          id: row.event_id,
          type: row.event_type as EventType,
          timestamp: new Date(row.timestamp),
          subsystem: row.subsystem_source,
          sessionId: eventData.sessionId ?? '',
          driveSnapshot,
          schemaVersion: row.schema_version ?? 1,
          correlationId: row.correlation_id ?? undefined,
          provenance: eventData.provenance ?? undefined,
        };
      });

      this.logger.debug(`queryPattern: returned ${events.length} events for fingerprint`);
      return events;
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(
          `EventsService.queryPattern() failed: ${error.message}`,
          { contextFingerprint: query.contextFingerprint },
        );
        throw new EventQueryError(
          'Pattern query failed',
          { originalError: error.message, contextFingerprint: query.contextFingerprint },
          error,
        );
      }
      throw new EventQueryError('Pattern query failed with unknown error', {});
    } finally {
      client.release();
    }
  }

  /**
   * Mark a single event as processed by the Learning subsystem (E2-T007).
   *
   * Implementation:
   * 1. Validates eventId is valid UUID v4 format — throws EventValidationError if invalid
   * 2. Executes: UPDATE events SET processed = true WHERE event_id = $1
   * 3. Idempotent: calling twice on the same ID is silent success (UPDATE affects 0 rows on second call)
   * 4. Non-existent eventId: silent success (UPDATE affects 0 rows, no error thrown)
   * 5. Connection failure → throws EventStorageError
   *
   * @param eventId - UUID v4 of the event to mark processed
   * @throws EventValidationError if eventId fails UUID v4 validation
   * @throws EventStorageError if the TimescaleDB update fails
   */
  async markProcessed(eventId: string): Promise<void> {
    // Step 1: Validate UUID v4 format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(eventId)) {
      throw new EventValidationError(
        `Invalid UUID format for eventId: "${eventId}"`,
        { eventId, method: 'markProcessed' },
      );
    }

    // Step 2: Get client and execute UPDATE
    const client = await this.pool.connect();
    try {
      const updateSql = `
        UPDATE events
        SET processed = true
        WHERE event_id = $1;
      `;

      await client.query(updateSql, [eventId]);

      this.logger.debug(`markProcessed: event ${eventId} marked as processed`, {
        eventId,
      });
    } catch (error) {
      // Connection error → EventStorageError
      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();

        if (errorMsg.includes('timeout') || errorMsg.includes('ECONNREFUSED')) {
          this.logger.error(
            `markProcessed connection timeout or lost: ${error.message}`,
            { eventId },
          );
          throw new EventStorageError(
            'TimescaleDB connection timeout or lost',
            { eventId, originalError: error.message },
            error,
          );
        }

        // Generic storage error
        this.logger.error(`markProcessed storage error: ${error.message}`, {
          eventId,
        });
        throw new EventStorageError(
          'TimescaleDB update failed',
          { eventId, originalError: error.message },
          error,
        );
      }

      // Unknown error type
      this.logger.error('markProcessed unknown error', { eventId, error });
      throw new EventStorageError(
        'TimescaleDB update failed with unknown error',
        { eventId },
        error,
      );
    } finally {
      client.release();
    }
  }

  /**
   * Mark multiple events as processed by the Learning subsystem (batch) (E2-T007).
   *
   * Implementation:
   * 1. Empty array: no-op (return immediately, no query executed)
   * 2. Validates all eventIds are valid UUID v4 format — throws EventValidationError if any invalid
   * 3. Executes single UPDATE: UPDATE events SET processed = true WHERE event_id = ANY($1::uuid[])
   * 4. Idempotent: calling twice is safe (second call affects 0 rows)
   * 5. Non-existent eventIds: silent success (affects 0 rows, no error thrown)
   * 6. Connection failure → throws EventStorageError
   *
   * @param eventIds - Array of event UUIDs to mark processed
   * @throws EventValidationError if any eventId fails UUID v4 validation
   * @throws EventStorageError if the TimescaleDB update fails
   */
  async markProcessedBatch(eventIds: readonly string[]): Promise<void> {
    // Step 1: Empty array is a no-op
    if (eventIds.length === 0) {
      return;
    }

    // Step 2: Validate all eventIds are valid UUID v4 format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const eventId of eventIds) {
      if (!uuidRegex.test(eventId)) {
        throw new EventValidationError(
          `Invalid UUID format in batch: "${eventId}"`,
          { eventId, method: 'markProcessedBatch', batchSize: eventIds.length },
        );
      }
    }

    // Step 3: Get client and execute batch UPDATE
    const client = await this.pool.connect();
    try {
      const updateSql = `
        UPDATE events
        SET processed = true
        WHERE event_id = ANY($1::uuid[]);
      `;

      await client.query(updateSql, [eventIds]);

      this.logger.debug(`markProcessedBatch: marked ${eventIds.length} events as processed`, {
        batchSize: eventIds.length,
      });
    } catch (error) {
      // Connection error → EventStorageError
      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();

        if (errorMsg.includes('timeout') || errorMsg.includes('ECONNREFUSED')) {
          this.logger.error(
            `markProcessedBatch connection timeout or lost: ${error.message}`,
            { batchSize: eventIds.length },
          );
          throw new EventStorageError(
            'TimescaleDB connection timeout or lost',
            { batchSize: eventIds.length, originalError: error.message },
            error,
          );
        }

        // Generic storage error
        this.logger.error(
          `markProcessedBatch storage error: ${error.message}`,
          { batchSize: eventIds.length },
        );
        throw new EventStorageError(
          'TimescaleDB update failed',
          { batchSize: eventIds.length, originalError: error.message },
          error,
        );
      }

      // Unknown error type
      this.logger.error('markProcessedBatch unknown error', {
        batchSize: eventIds.length,
        error,
      });
      throw new EventStorageError(
        'TimescaleDB update failed with unknown error',
        { batchSize: eventIds.length },
        error,
      );
    } finally {
      client.release();
    }
  }
}

// ============================================================================
// Type Guard Functions for record() event_data payload construction
// ============================================================================

/**
 * Type guard: checks if an event has LearnableEvent properties.
 * Used to conditionally include learnable fields in event_data JSONB.
 */
function hasLearnableProperties(
  event: Omit<SylphieEvent, 'id' | 'timestamp'>,
): event is Omit<SylphieEvent, 'id' | 'timestamp'> & {
  hasLearnable: boolean;
  content: string;
  guardianFeedbackType: string;
  source: string;
  salience: number;
} {
  return (
    'hasLearnable' in event &&
    'content' in event &&
    'guardianFeedbackType' in event &&
    'source' in event &&
    'salience' in event
  );
}

/**
 * Type guard: checks if an event has ReinforcementEvent properties.
 * Used to conditionally include reinforcement fields in event_data JSONB.
 */
function hasReinforcementProperties(
  event: Omit<SylphieEvent, 'id' | 'timestamp'>,
): event is Omit<SylphieEvent, 'id' | 'timestamp'> & {
  actionId: string;
  reinforcementPolarity: 'positive' | 'negative';
} {
  return (
    'actionId' in event &&
    'reinforcementPolarity' in event &&
    // Exclude ActionExecutedEvent and other non-reinforcement event types
    !('actionType' in event) &&
    !('arbitrationType' in event)
  );
}

/**
 * Type guard: checks if an event is an ActionExecutedEvent.
 * Used to conditionally include action execution fields in event_data JSONB.
 */
function hasActionExecutedProperties(
  event: Omit<SylphieEvent, 'id' | 'timestamp'>,
): event is Omit<SylphieEvent, 'id' | 'timestamp'> & {
  actionId: string;
  actionType: string;
  arbitrationType: 'TYPE_1' | 'TYPE_2';
} {
  return (
    'actionId' in event &&
    'actionType' in event &&
    'arbitrationType' in event
  );
}

/**
 * Type guard: checks if an event is a PredictionEvaluatedEvent.
 * Used to conditionally include prediction evaluation fields in event_data JSONB.
 */
function hasPredictionEvaluatedProperties(
  event: Omit<SylphieEvent, 'id' | 'timestamp'>,
): event is Omit<SylphieEvent, 'id' | 'timestamp'> & {
  predictionId: string;
  actionId: string;
  absoluteError: number;
  accurate: boolean;
} {
  return (
    'predictionId' in event &&
    'actionId' in event &&
    'absoluteError' in event &&
    'accurate' in event
  );
}

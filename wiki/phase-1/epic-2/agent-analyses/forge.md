# Epic 2: Events Module (TimescaleDB Backbone) -- Forge Architectural Analysis

**Status:** Planning
**Epic Scope:** Fill in the IEventService stub with real TimescaleDB implementation
**Analysis Date:** 2026-03-29
**Scope:** Event service interface design, TimescaleDB schema enforcement, type safety, boundary validation, error handling, observable patterns, ticket breakdown

---

## Executive Summary

Epic 2 transforms EventsModule from a stub into the operational backbone of Sylphie's episodic record. The Events module is a **two-way hub**: all five subsystems write events to TimescaleDB, and the same five subsystems query it for context, learnable events, and patterns. This makes EventsModule the most intensely-coupled infrastructure component alongside KnowledgeModule.

The architectural challenge is **stigmergic isolation**: events are the medium of inter-subsystem communication, but the system must prevent:
- Subsystems emitting event types they shouldn't (boundary enforcement)
- Type-unsafe event construction (discriminated unions)
- Missed transaction semantics for batch learnable event queries
- Uncontrolled event stream explosion (retention + compression policies from E1)
- Real-time deadlocking between high-frequency writers (Decision Making, Drive Engine) and batch readers (Learning)

This analysis covers EventsService interface refinement, TypeScript event type system, DI patterns, error handling, Observable patterns for reactive subsystems, boundary enforcement mechanisms, and ticket sequencing.

---

## 1. IEventService Interface Refinement

### 1.1 Baseline Interface (from E0)

From the roadmap, E0 defines:

```typescript
interface IEventService {
  record(event: SylphieEvent): Promise<void>;
  query(filter: EventFilter): Promise<SylphieEvent[]>;
  queryLearnableEvents(limit?: number): Promise<LearnableEvent[]>;
  queryEventFrequency(eventType: string, windowSeconds: number): Promise<number>;
  markProcessed(eventId: string): Promise<void>;
}
```

### 1.2 Refinement: Method Signatures with Full Type Safety

This interface is sufficient in structure but needs parameter and return type enrichment:

```typescript
/**
 * IEventService: TimescaleDB-backed event persistence and querying.
 * All five subsystems write and read through this interface.
 * Events are the stigmergic medium -- subsystems communicate via event streams.
 */
interface IEventService {
  /**
   * Emit a typed event to TimescaleDB.
   *
   * @param event - Discriminated union (SylphieEvent) with subsystem source validation
   * @param options - Optional: correlationId (link related events), priority, retention override
   * @throws EventValidationError if event_type is invalid for the source subsystem
   * @throws EventStorageError if TimescaleDB write fails
   */
  record(
    event: SylphieEvent,
    options?: EventRecordOptions,
  ): Promise<{ eventId: string; timestamp: Date }>;

  /**
   * Query events by filter (type, subsystem, time range, drive snapshot state).
   * Returns raw event objects with full schema.
   *
   * @param filter - EventFilter with required time_range, optional type/subsystem/drive filters
   * @param options - Optional: limit (default 100, max 10000), order (asc|desc), include_processed
   * @throws EventQueryError if filter is invalid
   * @throws TimescaleDBError if query times out or fails
   * @returns Array of SylphieEvent objects (may be empty)
   */
  query(
    filter: EventFilter,
    options?: EventQueryOptions,
  ): Promise<SylphieEvent[]>;

  /**
   * Query learnable events (max 5 per cycle for Learning subsystem).
   * Learnable events are marked has_learnable=true and not yet processed.
   *
   * @param limit - Max events to return (default 5, hardcoded max 5 per CANON A.3)
   * @param options - Optional: before_timestamp, correlation_id
   * @throws EventQueryError if filter is invalid
   * @returns Array of LearnableEvent (subset with extracted entities/edges)
   *
   * CRITICAL: This query MUST acquire a read lock on returned rows to prevent
   * concurrent Learning cycles from processing the same events twice.
   * Use SELECT FOR UPDATE (or equivalent isolation level).
   */
  queryLearnableEvents(
    limit?: number,
    options?: LearnableEventQueryOptions,
  ): Promise<LearnableEvent[]>;

  /**
   * Query event frequency (count of event_type in a time window).
   * Used by Drive Engine for opportunity detection (recurring failures).
   *
   * @param eventType - String identifier of event type (e.g., "PREDICTION_FAILED")
   * @param windowSeconds - Time window to aggregate (e.g., 300 = 5 minutes)
   * @param options - Optional: endTime (default now), subsystem filter
   * @throws EventQueryError if eventType is invalid
   * @throws TimescaleDBError if aggregation query fails
   * @returns Count of matching events in the window
   */
  queryEventFrequency(
    eventType: string,
    windowSeconds: number,
    options?: EventFrequencyOptions,
  ): Promise<number>;

  /**
   * Mark an event as processed by Learning.
   * Sets processed_at timestamp; idempotent.
   *
   * @param eventId - UUID of the event
   * @throws EventNotFoundError if eventId doesn't exist
   * @throws TimescaleDBError on persistence failure
   */
  markProcessed(eventId: string): Promise<void>;

  /**
   * (NEW) Batch mark events as processed.
   * Prevents repeated calls for large learnable event batches.
   *
   * @param eventIds - Array of event UUIDs
   * @throws EventNotFoundError if any eventId doesn't exist
   * @throws TimescaleDBError on persistence failure
   */
  markProcessedBatch(eventIds: string[]): Promise<void>;

  /**
   * (NEW - OPTIONAL, for advanced use) Stream events as they arrive.
   * Returns an RxJS Observable for real-time reactive subscribers.
   * Useful for Drive Engine to react to decisions in real-time.
   *
   * @param filter - Optional event filter (type, subsystem)
   * @returns Observable<SylphieEvent> that emits new events
   *
   * NOTE: This is an ADVANCED feature. Start with polling (queryLearnableEvents)
   * and add streaming only if subsystem latency becomes a bottleneck.
   */
  streamEvents(filter?: EventFilter): Observable<SylphieEvent>;
}
```

### 1.3 New Option Types

```typescript
/**
 * Options for IEventService.record()
 */
interface EventRecordOptions {
  /**
   * Correlation ID: link multiple related events together.
   * E.g., all events from one decision cycle share a correlation_id.
   */
  correlationId?: string;

  /**
   * Priority level (used by future rate-limiting / pressure mechanisms).
   * Default: 'normal'
   */
  priority?: 'low' | 'normal' | 'high';

  /**
   * Override default TimescaleDB retention for this event.
   * Useful for debugging high-volume events.
   */
  retentionOverride?: number; // seconds

  /**
   * If true, do not process this event through learning consolidation.
   * Useful for telemetry-only events.
   */
  learningSkip?: boolean;
}

/**
 * Options for IEventService.query()
 */
interface EventQueryOptions {
  limit?: number; // default 100, max 10000
  order?: 'asc' | 'desc'; // by timestamp
  includeProcessed?: boolean; // default false (exclude learnable events already processed)
}

/**
 * Options for IEventService.queryLearnableEvents()
 */
interface LearnableEventQueryOptions {
  beforeTimestamp?: Date; // query events before this timestamp
  correlationId?: string; // filter by correlation_id
  subsystemFilter?: SubsystemSource[]; // only events from these subsystems
}

/**
 * Options for IEventService.queryEventFrequency()
 */
interface EventFrequencyOptions {
  endTime?: Date; // default now
  subsystemFilter?: SubsystemSource; // optionally filter by one subsystem
}
```

---

## 2. Event Type System (Discriminated Union)

### 2.1 Design Principle

Events must be **type-safe discriminated unions** to prevent subsystems from:
1. Emitting event types that don't belong to them
2. Constructing events with invalid field combinations
3. Forgetting required metadata (correlation ID, drive state)

### 2.2 Event Type Hierarchy

From E0 roadmap, SylphieEvent is a discriminated union with 30+ event types. The subsystem sources and their allowed event types:

```typescript
/**
 * Subsystem source tags (for boundary enforcement).
 */
type SubsystemSource =
  | 'decision-making'
  | 'communication'
  | 'learning'
  | 'drive-engine'
  | 'planning';

/**
 * Base event structure (all events have these fields).
 */
interface SylphieEventBase {
  eventId: string; // UUID, generated by IEventService.record()
  timestamp: Date; // UTC, generated on insert
  source: SubsystemSource; // which subsystem emitted this
  schema_version: number; // for migrations (current: 1)
  correlationId?: string; // links related events (e.g., same decision cycle)
  drive_snapshot?: DriveSnapshot; // optional: drive state at time of event
  has_learnable: boolean; // can Learning consolidate from this event?
  processed_at?: Date; // set by IEventService.markProcessed()
}

/**
 * Discriminated union of all event types.
 * Each event type is keyed by source + purpose.
 * This enforces: Decision Making can emit PREDICTION_* but not ENTITY_LEARNED.
 */
type SylphieEvent =
  // === DECISION MAKING EVENTS ===
  | {
      event_type: 'PREDICTION_GENERATED';
      source: 'decision-making';
      data: {
        prediction_id: string;
        action_candidate_id: string;
        predicted_outcome: string;
        confidence: number; // 0-1
        type1_or_type2: 'type1' | 'type2';
      };
    }
  | {
      event_type: 'PREDICTION_FAILED';
      source: 'decision-making';
      data: {
        prediction_id: string;
        expected_outcome: string;
        actual_outcome: string;
        error_magnitude: number; // for MAE calculation
      };
    }
  | {
      event_type: 'PREDICTION_CONFIRMED';
      source: 'decision-making';
      data: {
        prediction_id: string;
        expected_outcome: string;
        actual_outcome: string;
      };
    }
  | {
      event_type: 'ACTION_SELECTED';
      source: 'decision-making';
      data: {
        action_id: string;
        action_name: string;
        confidence: number;
        arbitration_method: 'type1' | 'type2';
      };
    }
  | {
      event_type: 'ACTION_EXECUTED';
      source: 'decision-making';
      data: {
        action_id: string;
        executor_state_from: string;
        executor_state_to: string;
        latency_ms: number;
      };
    }
  | {
      event_type: 'INPUT_PROCESSED';
      source: 'decision-making';
      data: {
        input_type: 'text' | 'audio' | 'sensor';
        input_summary: string;
        attention_arousal_gated: boolean;
      };
    }
  | {
      event_type: 'EPISODE_ENCODED';
      source: 'decision-making';
      data: {
        episode_id: string;
        context_tags: string[];
        drives_at_encoding: string; // serialized snapshot
      };
    }

  // === COMMUNICATION EVENTS ===
  | {
      event_type: 'UTTERANCE_GENERATED';
      source: 'communication';
      data: {
        utterance_id: string;
        text: string;
        generated_by: 'llm' | 'reflex';
        llm_cost_estimate: number;
        theater_check_passed: boolean; // did drive state match emotional expression?
      };
    }
  | {
      event_type: 'UTTERANCE_RECEIVED_RESPONSE';
      source: 'communication';
      data: {
        utterance_id: string;
        response_received_within_30s: boolean;
        response_sentiment: 'positive' | 'neutral' | 'negative';
      };
    }
  | {
      event_type: 'INPUT_RECEIVED';
      source: 'communication';
      data: {
        input_id: string;
        input_type: 'text' | 'audio';
        text: string;
        parsed_intent: string;
        parser_confidence: number;
      };
    }
  | {
      event_type: 'PERSON_MODEL_UPDATED';
      source: 'communication';
      data: {
        person_id: string;
        person_name: string;
        update_type: 'extraction' | 'inference';
      };
    }

  // === LEARNING EVENTS ===
  | {
      event_type: 'ENTITY_LEARNED';
      source: 'learning';
      data: {
        entity_id: string;
        entity_name: string;
        entity_type: string;
        provenance: ProvenanceSource;
        initial_confidence: number;
      };
    }
  | {
      event_type: 'EDGE_LEARNED';
      source: 'learning';
      data: {
        edge_id: string;
        source_entity: string;
        target_entity: string;
        edge_type: string;
        provenance: ProvenanceSource;
        initial_confidence: number;
      };
    }
  | {
      event_type: 'CONTRADICTION_DETECTED';
      source: 'learning';
      data: {
        entity_id: string;
        existing_value: string;
        new_value: string;
        severity: 'low' | 'medium' | 'high';
      };
    }
  | {
      event_type: 'MAINTENANCE_CYCLE_STARTED';
      source: 'learning';
      data: {
        cycle_id: string;
        trigger: 'pressure' | 'timer' | 'manual';
        cognitive_awareness_pressure: number;
      };
    }
  | {
      event_type: 'MAINTENANCE_CYCLE_COMPLETED';
      source: 'learning';
      data: {
        cycle_id: string;
        events_processed: number;
        entities_learned: number;
        edges_learned: number;
      };
    }

  // === DRIVE ENGINE EVENTS ===
  | {
      event_type: 'DRIVE_TICK';
      source: 'drive-engine';
      data: {
        tick_number: number;
        drive_values: Record<DriveName, number>; // all 12 drives
        total_pressure: number;
      };
    }
  | {
      event_type: 'OPPORTUNITY_DETECTED';
      source: 'drive-engine';
      data: {
        opportunity_id: string;
        trigger: 'recurring_failure' | 'high_impact_failure' | 'pattern';
        associated_prediction_ids: string[];
        priority: number;
      };
    }
  | {
      event_type: 'RULE_PROPOSED';
      source: 'drive-engine';
      data: {
        rule_id: string;
        rule_description: string;
        expected_drive_relief: Record<DriveName, number>;
      };
    }
  | {
      event_type: 'DRIVE_RULE_APPLIED';
      source: 'drive-engine';
      data: {
        rule_id: string;
        trigger_event_type: string;
        drives_affected: DriveName[];
      };
    }

  // === PLANNING EVENTS ===
  | {
      event_type: 'PLAN_PROPOSED';
      source: 'planning';
      data: {
        plan_id: string;
        opportunity_id: string;
        plan_description: string;
        expected_success_probability: number;
      };
    }
  | {
      event_type: 'PLAN_CREATED';
      source: 'planning';
      data: {
        plan_id: string;
        action_procedure_id: string;
        initial_confidence: number;
      };
    }
  | {
      event_type: 'PLAN_EXECUTED';
      source: 'planning';
      data: {
        plan_id: string;
        plan_result: 'success' | 'failure' | 'partial';
        outcome_summary: string;
      };
    };

/**
 * LearnableEvent: subset of SylphieEvent with has_learnable=true and processed_at=null.
 * Used by Learning subsystem to consolidate.
 */
type LearnableEvent = SylphieEvent & {
  has_learnable: true;
  processed_at: null;
  data: SylphieEvent['data'] & {
    // Learnable events carry extracted semantic content
    entities_mentioned?: string[];
    edges_mentioned?: string[];
  };
};
```

### 2.3 Boundary Enforcement at Type Level

The discriminated union **naturally enforces** boundary constraints:

```typescript
// This COMPILES (correct subsystem):
const dmEvent: SylphieEvent = {
  event_type: 'PREDICTION_GENERATED',
  source: 'decision-making',
  data: { /* ... */ },
};

// This DOES NOT COMPILE (wrong subsystem):
const wrongEvent: SylphieEvent = {
  event_type: 'ENTITY_LEARNED', // Learning event
  source: 'decision-making',     // but DM source
  data: { /* ... */ },
};
// TypeScript error: Type does not match any variant
```

### 2.4 Runtime Boundary Validation

The IEventService.record() method validates at runtime (defense-in-depth):

```typescript
/**
 * Helper: allowed event types per subsystem source.
 */
const EVENT_TYPE_BOUNDARIES: Record<SubsystemSource, Set<string>> = {
  'decision-making': new Set([
    'PREDICTION_GENERATED',
    'PREDICTION_FAILED',
    'PREDICTION_CONFIRMED',
    'ACTION_SELECTED',
    'ACTION_EXECUTED',
    'INPUT_PROCESSED',
    'EPISODE_ENCODED',
  ]),
  'communication': new Set([
    'UTTERANCE_GENERATED',
    'UTTERANCE_RECEIVED_RESPONSE',
    'INPUT_RECEIVED',
    'PERSON_MODEL_UPDATED',
  ]),
  'learning': new Set([
    'ENTITY_LEARNED',
    'EDGE_LEARNED',
    'CONTRADICTION_DETECTED',
    'MAINTENANCE_CYCLE_STARTED',
    'MAINTENANCE_CYCLE_COMPLETED',
  ]),
  'drive-engine': new Set([
    'DRIVE_TICK',
    'OPPORTUNITY_DETECTED',
    'RULE_PROPOSED',
    'DRIVE_RULE_APPLIED',
  ]),
  'planning': new Set([
    'PLAN_PROPOSED',
    'PLAN_CREATED',
    'PLAN_EXECUTED',
  ]),
};

// In EventsService.record():
if (!EVENT_TYPE_BOUNDARIES[event.source].has(event.event_type)) {
  throw new EventValidationError(
    `Event type "${event.event_type}" not allowed for source "${event.source}"`,
  );
}
```

---

## 3. DI Patterns and Module Wiring

### 3.1 EventsModule Structure

From E1, EventsModule owns the TimescaleDB connection. E2 adds the EventsService implementation:

```typescript
// src/events/events.module.ts
import { Module, Global } from '@nestjs/common';
import { EventsService } from './events.service';
import { EVENTS_SERVICE, timescalePoolProvider } from './events.providers';

@Global() // EventsModule is global; all subsystems can inject EVENTS_SERVICE
@Module({
  providers: [
    timescalePoolProvider, // from E1; provides TIMESCALE_POOL
    {
      provide: EVENTS_SERVICE,
      useClass: EventsService, // Real implementation (E2 fills this)
    },
  ],
  exports: [EVENTS_SERVICE],
})
export class EventsModule {}
```

### 3.2 EventsService Implementation Structure

```typescript
// src/events/events.service.ts
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { Observable, Subject } from 'rxjs';
import { TIMESCALE_POOL } from './events.providers';
import { IEventService } from './interfaces/event.interface';
import { SylphieEvent, LearnableEvent, EventFilter, EventRecordOptions } from '@/shared/types';

@Injectable()
export class EventsService implements IEventService {
  private readonly logger = new Logger('EventsService');
  private eventStream$ = new Subject<SylphieEvent>(); // for streamEvents()

  constructor(@Inject(TIMESCALE_POOL) private pool: Pool) {}

  // --- Lifecycle ---

  async onModuleInit() {
    this.logger.log('EventsService initializing...');
    // Verify hypertable exists (created in E1)
    // Set up compression policies (created in E1)
    // Connect event stream to PostgreSQL LISTEN/NOTIFY
  }

  async onModuleDestroy() {
    this.logger.log('EventsService shutting down...');
    this.eventStream$.complete();
    // Drain pool connections
  }

  // --- Core Methods ---

  async record(
    event: SylphieEvent,
    options?: EventRecordOptions,
  ): Promise<{ eventId: string; timestamp: Date }> {
    // 1. Validate event type against source
    // 2. Generate UUID for eventId
    // 3. Insert into events hypertable with all fields
    // 4. Emit to eventStream$ for streamEvents() subscribers
    // 5. Return eventId and insert timestamp
  }

  async query(
    filter: EventFilter,
    options?: EventQueryOptions,
  ): Promise<SylphieEvent[]> {
    // 1. Build dynamic WHERE clause from filter
    // 2. Execute time-series query with ORDER BY timestamp
    // 3. Deserialize event data JSON
    // 4. Return SylphieEvent[]
  }

  async queryLearnableEvents(
    limit?: number,
    options?: LearnableEventQueryOptions,
  ): Promise<LearnableEvent[]> {
    // 1. Clamp limit to 5 (hardcoded per CANON A.3)
    // 2. Query: WHERE has_learnable=true AND processed_at IS NULL
    // 3. IMPORTANT: Use SELECT ... FOR UPDATE to acquire read lock
    //    (prevents concurrent Learning cycles from processing same events)
    // 4. Return LearnableEvent[]
  }

  async queryEventFrequency(
    eventType: string,
    windowSeconds: number,
    options?: EventFrequencyOptions,
  ): Promise<number> {
    // 1. Compute time_bucket aggregation over windowSeconds
    // 2. COUNT(*) WHERE event_type = ?
    // 3. Return count
  }

  async markProcessed(eventId: string): Promise<void> {
    // 1. UPDATE events SET processed_at = NOW() WHERE event_id = ?
    // 2. Idempotent (processed_at already set = no change)
  }

  async markProcessedBatch(eventIds: string[]): Promise<void> {
    // 1. Batch UPDATE with IN clause
    // 2. Faster than N individual calls
  }

  streamEvents(filter?: EventFilter): Observable<SylphieEvent> {
    // 1. Return filtered view of eventStream$ Subject
    // 2. Optionally filter in-memory before emitting (for low-volume subscribers)
    // 3. ADVANCED: skip if latency becomes a bottleneck
  }
}
```

### 3.3 Injection in Consumer Subsystems

Each subsystem injects EVENTS_SERVICE via token:

```typescript
// Example: DecisionMakingService
constructor(
  @Inject(EVENTS_SERVICE) private events: IEventService,
  private knowledge: IWkgService, // from KnowledgeModule
) {}

// When action is selected:
await this.events.record({
  event_type: 'ACTION_SELECTED',
  source: 'decision-making',
  data: {
    action_id: actionId,
    action_name: actionName,
    confidence: confidence,
    arbitration_method: type1OrType2,
  },
});
```

---

## 4. Error Handling Strategy

### 4.1 Custom Exception Hierarchy

From E0 (shared exceptions), EventsService defines domain-specific exceptions:

```typescript
// src/events/exceptions/
export class EventStorageError extends SylphieException {
  constructor(message: string, readonly details?: any) {
    super(`Event storage failed: ${message}`, 'EVENT_STORAGE_ERROR', details);
  }
}

export class EventValidationError extends SylphieException {
  constructor(message: string, readonly details?: any) {
    super(`Event validation failed: ${message}`, 'EVENT_VALIDATION_ERROR', details);
  }
}

export class EventQueryError extends SylphieException {
  constructor(message: string, readonly details?: any) {
    super(`Event query failed: ${message}`, 'EVENT_QUERY_ERROR', details);
  }
}

export class EventNotFoundError extends SylphieException {
  constructor(eventId: string) {
    super(`Event not found: ${eventId}`, 'EVENT_NOT_FOUND', { eventId });
  }
}

export class TimescaleDBError extends SylphieException {
  constructor(message: string, readonly details?: any) {
    super(`TimescaleDB error: ${message}`, 'TIMESCALEDB_ERROR', details);
  }
}
```

### 4.2 Error Handling in IEventService.record()

```typescript
async record(event: SylphieEvent, options?: EventRecordOptions) {
  try {
    // 1. Validate event type against source (throws EventValidationError)
    this.validateEventTypeForSource(event);

    // 2. Generate UUID and prepare for insertion
    const eventId = uuidv4();
    const timestamp = new Date();

    // 3. Serialize data JSON safely
    const dataJson = JSON.stringify(event.data);

    // 4. Insert into hypertable
    const query = `
      INSERT INTO events (event_id, timestamp, source, event_type, data, ...)
      VALUES ($1, $2, $3, $4, $5, ...)
      RETURNING event_id, timestamp
    `;

    const client = await this.pool.connect();
    try {
      const result = await client.query(query, [
        eventId,
        timestamp,
        event.source,
        event.event_type,
        dataJson,
        // ... remaining fields
      ]);

      // 5. Emit to observable stream (non-blocking)
      this.eventStream$.next(event);

      return {
        eventId: result.rows[0].event_id,
        timestamp: result.rows[0].timestamp,
      };
    } finally {
      client.release();
    }
  } catch (error) {
    // Classify error
    if (error instanceof EventValidationError) {
      this.logger.warn(`Validation failed: ${error.message}`);
      throw error; // Re-throw validation errors to caller
    }

    if (error.code === 'ECONNREFUSED' || error.code === '08006') {
      this.logger.error(`TimescaleDB connection failed: ${error.message}`);
      throw new TimescaleDBError('Connection failed', { originalError: error });
    }

    if (error.code === '23505') {
      // Duplicate key error
      this.logger.warn(`Duplicate event_id: ${error.message}`);
      throw new EventStorageError('Event already exists', { originalError: error });
    }

    // Generic storage error
    this.logger.error(`Unexpected storage error: ${error.message}`);
    throw new EventStorageError('Failed to store event', { originalError: error });
  }
}
```

### 4.3 Transaction Handling for queryLearnableEvents()

Critical constraint: Learning consolidation must be atomic. Multiple Learning cycles must not process the same events:

```typescript
async queryLearnableEvents(
  limit?: number,
  options?: LearnableEventQueryOptions,
): Promise<LearnableEvent[]> {
  const actualLimit = Math.min(limit || 5, 5); // Hardcoded max 5

  const client = await this.pool.connect();
  try {
    // Start transaction with SERIALIZABLE isolation (strictest)
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

    try {
      // Query with row-level lock (SELECT FOR UPDATE)
      const query = `
        SELECT * FROM events
        WHERE has_learnable = true
        AND processed_at IS NULL
        AND source IN ('decision-making', 'communication', 'drive-engine', 'planning')
        ORDER BY timestamp ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED -- Skip rows locked by concurrent cycles
      `;

      const result = await client.query(query, [actualLimit]);
      const events = result.rows.map(row => this.deserializeEvent(row));

      // Commit transaction (locks released)
      await client.query('COMMIT');

      return events as LearnableEvent[];
    } catch (error) {
      // Rollback on error
      await client.query('ROLLBACK');
      this.logger.error(`Learnable event query failed: ${error.message}`);
      throw new EventQueryError('Failed to query learnable events', {
        originalError: error,
      });
    }
  } finally {
    client.release();
  }
}
```

---

## 5. Observable Patterns for Real-Time Reactivity

### 5.1 Design Decision: Streaming vs. Polling

Two approaches:

**Approach A (Polling, Default):**
- Learning queries queryLearnableEvents() on a timer or pressure trigger
- Drive Engine queries queryEventFrequency() periodically
- Simpler, stateless, bounded latency
- **Chosen for E2 baseline**

**Approach B (Streaming, Optional):**
- EventsService exposes streamEvents() Observable
- Drive Engine subscribes to event stream
- Reacts to events in near real-time
- Adds complexity: subscription management, backpressure
- **Can be added in E4 if Drive Engine latency becomes issue**

### 5.2 streamEvents() Implementation

```typescript
/**
 * Stream events as they arrive.
 * Filters in-memory before emitting to subscriber.
 * WARNING: If filter is too broad, can cause backpressure.
 */
streamEvents(filter?: EventFilter): Observable<SylphieEvent> {
  return this.eventStream$.asObservable().pipe(
    // Filter in-memory if filter provided
    filter((event) => {
      if (!filter) return true; // No filter = pass all

      // Check event_type
      if (filter.event_type && event.event_type !== filter.event_type) {
        return false;
      }

      // Check source
      if (filter.source && event.source !== filter.source) {
        return false;
      }

      // Check drive threshold
      if (
        filter.driveThreshold &&
        event.drive_snapshot &&
        !this.driveSnapshotMatchesThreshold(event.drive_snapshot, filter.driveThreshold)
      ) {
        return false;
      }

      return true;
    }),
    // Optional: backpressure protection
    shareReplay(1), // Last event cached for late subscribers
  );
}

/**
 * Example subscriber in DriveEngineService:
 * Constructor subscribes to prediction failure events.
 */
constructor(
  @Inject(EVENTS_SERVICE) private events: IEventService,
) {
  // Real-time opportunity detection from prediction failures
  this.events
    .streamEvents({
      event_type: 'PREDICTION_FAILED',
      source: 'decision-making',
    })
    .pipe(
      debounceTime(100), // Wait 100ms for batch of failures
      switchMap((event) => {
        // Check if this is a recurring failure
        return this.evaluateRecurrenceAsync(event);
      }),
    )
    .subscribe((opportunity) => {
      if (opportunity) {
        this.detectOpportunity(opportunity);
      }
    });
}
```

---

## 6. Boundary Enforcement Mechanisms

### 6.1 Subsystem Type Strictness

Create subsystem-specific event builder types to prevent construction errors:

```typescript
// src/events/builders/

/**
 * Typed event builders: static factory functions for each subsystem.
 * Prevents construction of invalid events.
 */

export class DecisionMakingEventBuilder {
  static predictionGenerated(data: {
    prediction_id: string;
    action_candidate_id: string;
    predicted_outcome: string;
    confidence: number;
    type1_or_type2: 'type1' | 'type2';
  }): SylphieEvent {
    return {
      event_type: 'PREDICTION_GENERATED',
      source: 'decision-making',
      data,
    };
  }

  static predictionFailed(data: {
    prediction_id: string;
    expected_outcome: string;
    actual_outcome: string;
    error_magnitude: number;
  }): SylphieEvent {
    return {
      event_type: 'PREDICTION_FAILED',
      source: 'decision-making',
      data,
    };
  }
  // ... other DM events
}

export class LearningEventBuilder {
  static entityLearned(data: {
    entity_id: string;
    entity_name: string;
    entity_type: string;
    provenance: ProvenanceSource;
    initial_confidence: number;
  }): SylphieEvent {
    return {
      event_type: 'ENTITY_LEARNED',
      source: 'learning',
      data,
    };
  }
  // ... other Learning events
}
```

Usage:

```typescript
// In DecisionMakingService:
const event = DecisionMakingEventBuilder.predictionFailed({
  prediction_id: pred.id,
  expected_outcome: pred.outcome,
  actual_outcome: actualOutcome,
  error_magnitude: Math.abs(pred.magnitude - actual),
});
await this.events.record(event);
```

### 6.2 Runtime Validation

IEventService.record() validates every event:

```typescript
private validateEventTypeForSource(event: SylphieEvent): void {
  const allowedTypes = EVENT_TYPE_BOUNDARIES[event.source];
  if (!allowedTypes.has(event.event_type)) {
    throw new EventValidationError(
      `Event type "${event.event_type}" not allowed for source "${event.source}". ` +
        `Allowed: ${Array.from(allowedTypes).join(', ')}`,
    );
  }
}
```

### 6.3 Monitoring and Alerting

Add logging for boundary violations (helps catch bugs in testing):

```typescript
// In EventsService.record():
if (event.drive_snapshot && !this.isValidDriveSnapshot(event.drive_snapshot)) {
  this.logger.warn(
    `Invalid drive snapshot in ${event.source}.${event.event_type}: ` +
      `${JSON.stringify(event.drive_snapshot)}`,
  );
}
```

---

## 7. Transaction Semantics and Concurrency

### 7.1 Write Concurrency (High-Frequency Writers)

Decision Making and Drive Engine emit events at ~100 Hz. TimescaleDB handles this well with append-only semantics:

```typescript
// TimescaleDB hypertable is optimized for time-series write-heavy workloads.
// Each INSERT goes to the chunk for that time interval.
// No need for explicit locking on writes.
```

### 7.2 Read Concurrency (Learning Consolidation)

Multiple Learning cycles must not process the same events. Solution: pessimistic locking (SELECT FOR UPDATE):

```typescript
// queryLearnableEvents uses:
// SELECT ... FOR UPDATE SKIP LOCKED
//
// Behavior:
// - Cycle A queries, locks events [E1, E2, E3]
// - Cycle B queries simultaneously, skips locked events, gets [E4, E5]
// - No duplicate processing
// - No deadlock (SKIP LOCKED prevents blocking)
```

### 7.3 Rate Limiting on Writes

If any subsystem spam-emits events, constrain at the service layer:

```typescript
/**
 * Rate limiter: max events per subsystem per second.
 */
private readonly eventBudget: Map<SubsystemSource, number> = new Map([
  ['decision-making', 1000], // Can emit ~1000 events/sec (prediction + action + outcome)
  ['communication', 100],     // Input parsing, utterances
  ['learning', 50],           // Consolidation events
  ['drive-engine', 100],      // Drive ticks + opportunities
  ['planning', 50],           // Plan proposals
]);

async record(event: SylphieEvent, options?: EventRecordOptions): Promise<...> {
  // Check budget
  const budget = this.eventBudget.get(event.source);
  if (!this.hasCapacity(event.source, budget)) {
    throw new EventStorageError(
      `Event budget exceeded for source "${event.source}"`,
      { source: event.source, budget },
    );
  }

  // ... proceed with insert
}
```

---

## 8. Ticket Breakdown

### E2-T001: IEventService Interface and Types

**Title:** Define IEventService interface, event discriminated union, and option types

**Description:**
- Implement IEventService in src/events/interfaces/event.interface.ts with full type signatures
- Define SylphieEvent discriminated union with all 30+ event types
- Define EventRecordOptions, EventQueryOptions, LearnableEventQueryOptions, EventFrequencyOptions
- Define EVENT_TYPE_BOUNDARIES constant for runtime validation
- Ensure TypeScript compilation: npx tsc --noEmit

**Acceptance Criteria:**
1. IEventService has record(), query(), queryLearnableEvents(), queryEventFrequency(), markProcessed(), markProcessedBatch(), streamEvents()
2. SylphieEvent discriminated union compiles without errors
3. Each variant is keyed by (event_type, source) pair with specific data shape
4. EVENT_TYPE_BOUNDARIES prevents cross-subsystem event emission at compile time and runtime
5. All option types have JSDoc with examples

**Dependencies:** E0, E1
**Complexity:** M

---

### E2-T002: EventsService.record() Implementation

**Title:** Implement IEventService.record() with validation and storage

**Description:**
- Implement EventsService class in src/events/events.service.ts
- record() method validates event type against source boundary
- Generate UUID for eventId on insert
- Insert event into TimescaleDB events hypertable with all fields
- Emit to eventStream$ Subject for streamEvents() subscribers
- Handle connection errors, validation errors, and storage errors
- Add JSDoc with examples

**Acceptance Criteria:**
1. record() validates event_type against EVENT_TYPE_BOUNDARIES
2. Throws EventValidationError if boundary violated
3. Throws TimescaleDBError if connection fails
4. Returns { eventId, timestamp } on success
5. Event emitted to Subject for streams
6. All exceptions are catchable as SylphieException subclasses
7. Logger records all errors at appropriate levels (warn vs error)

**Dependencies:** E2-T001, E1
**Complexity:** M

---

### E2-T003: EventsService.query() and queryEventFrequency()

**Title:** Implement query-side methods with filtering and aggregation

**Description:**
- Implement query() to support time range, event_type, source, drive snapshot filters
- Implement queryEventFrequency() with time_bucket aggregation for Drive Engine
- Both methods deserialize event data JSON safely
- Add pagination support (limit, offset) with safety caps (max 10000)
- Handle query timeouts and invalid filters

**Acceptance Criteria:**
1. query() returns SylphieEvent[] matching filter
2. queryEventFrequency() returns count for given event_type + window
3. Filters properly build WHERE clauses (no SQL injection)
4. Time range is required in EventFilter (no unbounded queries)
5. Results ordered by timestamp
6. Query timeout throws EventQueryError with details
7. Invalid event_type throws EventValidationError

**Dependencies:** E2-T001, E2-T002, E1
**Complexity:** M

---

### E2-T004: EventsService.queryLearnableEvents() with Locking

**Title:** Implement learnable event query with pessimistic locking

**Description:**
- Implement queryLearnableEvents() with SELECT ... FOR UPDATE SKIP LOCKED
- Hardcode limit to 5 (per CANON A.3)
- Clamp user-provided limit parameter
- Use SERIALIZABLE isolation level to prevent race conditions
- Return LearnableEvent[] (subset with has_learnable=true, processed_at=null)
- Idempotent: concurrent cycles can safely query without deadlock

**Acceptance Criteria:**
1. Returns max 5 events (hardcoded limit)
2. Only returns events with has_learnable=true and processed_at IS NULL
3. Uses SELECT FOR UPDATE SKIP LOCKED for row-level locking
4. SERIALIZABLE isolation prevents dirty reads
5. Multiple concurrent cycles do not process duplicate events
6. No deadlock (SKIP LOCKED prevents blocking)
7. Locks released after commit/rollback

**Dependencies:** E2-T001, E2-T002, E1
**Complexity:** L

---

### E2-T005: EventsService.markProcessed() and Batch Operations

**Title:** Implement event marking as processed

**Description:**
- Implement markProcessed() to set processed_at timestamp
- Implement markProcessedBatch() for bulk marking (Learning optimization)
- Both methods are idempotent (no error if already marked)
- Add LSN (log sequence number) tracking for debugging

**Acceptance Criteria:**
1. markProcessed(eventId) sets processed_at = NOW()
2. markProcessedBatch(eventIds) updates multiple events in single query
3. Both are idempotent (no error on duplicate calls)
4. Throws EventNotFoundError if eventId doesn't exist
5. Batch operation is faster than N individual calls (single INSERT for N rows vs N INSERTs)

**Dependencies:** E2-T001, E2-T002, E1
**Complexity:** S

---

### E2-T006: EventsService.streamEvents() Observable

**Title:** Implement real-time event streaming

**Description:**
- Implement streamEvents() returning Observable<SylphieEvent>
- Maintain Subject<SylphieEvent> that record() emits to
- Filter events in-memory based on EventFilter
- Backpressure protection with shareReplay(1)
- Add example subscriber for Drive Engine

**Acceptance Criteria:**
1. streamEvents() returns Observable that emits new events
2. Filtering works on event_type, source, drive snapshot
3. Late subscribers get last event (shareReplay)
4. No memory leak from accumulated events
5. Documentation warns about backpressure for broad filters
6. Example: Drive Engine can subscribe to 'PREDICTION_FAILED' events

**Dependencies:** E2-T001, E2-T002, E2-T003
**Complexity:** M
**Note:** This is OPTIONAL for baseline. Skip if E4 doesn't require real-time reactivity.

---

### E2-T007: Error Handling and Exception Classes

**Title:** Implement EventsService exception hierarchy

**Description:**
- Create src/events/exceptions/ with EventStorageError, EventValidationError, EventQueryError, EventNotFoundError, TimescaleDBError
- All extend SylphieException
- Add JSDoc with causation examples
- Add to events.module.ts exports for reusability

**Acceptance Criteria:**
1. All exception classes are defined
2. Each has descriptive message + error code + optional details
3. Used consistently in EventsService methods
4. Callers can catch by specific exception type
5. No bare throw new Error()

**Dependencies:** E0 (SylphieException base)
**Complexity:** S

---

### E2-T008: Event Builders and Type-Safe Construction

**Title:** Create builder classes for subsystem-specific event construction

**Description:**
- Create src/events/builders/ with DecisionMakingEventBuilder, CommunicationEventBuilder, LearningEventBuilder, DriveEngineEventBuilder, PlanningEventBuilder
- Each builder has static factory methods for that subsystem's event types
- Factory methods enforce required fields and correct types
- Usage: const event = DecisionMakingEventBuilder.predictionFailed({ ... })
- Add JSDoc examples for each builder method

**Acceptance Criteria:**
1. Five builder classes created (one per subsystem)
2. Each has factory methods matching subsystem's event types
3. Factory methods enforce required fields (TypeScript compile-time)
4. Return properly-typed SylphieEvent
5. No way to create cross-subsystem events (DM can't create Learning events)
6. Example usage in every builder method JSDoc

**Dependencies:** E2-T001
**Complexity:** S

---

### E2-T009: Integration Tests and Concurrency Verification

**Title:** Test EventsService with concurrent writers and readers

**Description:**
- Test record() with validation boundary enforcement
- Test query() with various filters
- Test queryLearnableEvents() with concurrent cycles (verify no duplicate processing)
- Test markProcessed() idempotency
- Test streamEvents() with filtering
- Test rate limiting (if implemented)

**Acceptance Criteria:**
1. record() rejects cross-subsystem event types
2. query() returns correct events for filter
3. queryLearnableEvents() with 3 concurrent cycles processes each event exactly once
4. markProcessed() can be called multiple times safely
5. streamEvents() emits new events to subscribers
6. All tests pass: npm run test:e2

**Dependencies:** E2-T001 through E2-T008
**Complexity:** M

---

### E2-T010: Documentation and Migration Scripts

**Title:** Document EventsService API and prepare schema initialization

**Description:**
- Write README.md for EventsModule explaining event types, boundaries, usage patterns
- Document rate limiting and error handling
- Create SQL migration to initialize hypertable (from E1)
- Create data seeding script for test events
- Update CLAUDE.md with events module architecture

**Acceptance Criteria:**
1. README.md covers: IEventService interface, event types, subsystem boundaries, error handling, streaming
2. Usage examples for each subsystem (how to emit, query, subscribe)
3. SQL migration compiles and runs without errors
4. Test data can be seeded with sample events
5. CLAUDE.md updated with E2 completion notes

**Dependencies:** All E2 tickets
**Complexity:** S

---

## 9. Confidence Ceiling Interactions

The Confidence Ceiling (Immutable Standard 3) applies to events:

- **Event base provenance:** Events carry implicit provenance (e.g., PREDICTION_FAILED from a Type 2 decision has LLM_GENERATED provenance)
- **No event exceeds confidence without use:** A learnableEvent that extracts an entity gets initial confidence 0.35 (LLM_GENERATED), not 0.60
- **Learning must update WKG:** When queryLearnableEvents() returns an entity, Learning module writes it to WKG with GUARDIAN or LLM_GENERATED provenance, and only the WKG write respects the ceiling

**Implication for E2:** EventsService doesn't enforce confidence ceilings (that's WKG's job). Events are ephemeral records. The ceiling is enforced when events are **consolidated into graph knowledge**.

---

## 10. Known Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Event explosion (unbounded growth) | Medium | Retention policies in E1 (compress old events, TTL) |
| Learning cycle race conditions | High | SELECT FOR UPDATE SKIP LOCKED in queryLearnableEvents() |
| Drive Engine latency on frequency queries | Medium | Aggregate queries cached, pre-computed if needed |
| Cross-subsystem event emission | Medium | Discriminated union + EVENT_TYPE_BOUNDARIES + runtime validation |
| Storage failure cascade | High | Connection pooling, circuit breaker pattern, error logging |
| Backpressure from streaming | Low | Optional feature; polling is baseline |
| Event ordering guarantees | Medium | TimescaleDB time ordering, correlation IDs for causality |

---

## 11. Glossary and References

- **Hypertable:** TimescaleDB table optimized for time-series inserts
- **SELECT FOR UPDATE:** Pessimistic row-level lock
- **SKIP LOCKED:** Ignore locked rows instead of blocking
- **SERIALIZABLE:** Strictest isolation level (read-committed default in E1)
- **Discriminated Union:** TypeScript feature for type-safe variant types
- **EVENT_TYPE_BOUNDARIES:** Map of allowed event types per subsystem
- **Correlation ID:** Field linking related events from one decision cycle
- **Learnable Event:** Event marked has_learnable=true, eligible for Learning consolidation
- **Observable (RxJS):** Reactive stream abstraction for real-time event subscriptions

---

## 12. Timeline and Dependencies

**Critical Path:**
- E2-T001 (Interface): 1 session
- E2-T002 (record()): 1 session
- E2-T003 (query methods): 1 session
- E2-T004 (learnable locking): 1 session
- E2-T007 (exceptions): 0.5 session
- E2-T008 (builders): 0.5 session
- E2-T009 (tests): 1 session
- E2-T010 (docs): 0.5 session

**Total Estimated Effort:** 7 sessions (sequential, single developer)

**Parallelizable:** E2-T001 can be done in parallel with any ticket that depends on it (but doesn't block).

---

## 13. Success Criteria for Epic 2 Completion

1. **npx tsc --noEmit** passes (full type safety)
2. **All IEventService methods** have real implementations (no stubs)
3. **Event type boundaries** enforced at compile time + runtime
4. **queryLearnableEvents()** tested with concurrent Learning cycles (no duplicates)
5. **All exceptions** are catchable as SylphieException subclasses
6. **Unit + integration tests** pass: `npm run test:e2`
7. **Documentation** covers: interface, types, boundaries, error handling, streaming
8. **Backwards compatible** with E3 Knowledge module (can be implemented after E2 completes)

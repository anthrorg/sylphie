# Epic 2: Events Module (TimescaleDB Backbone) -- Sentinel Analysis

**Analysis Date:** 2026-03-29
**Epic Scope:** Replace IEventService stub with real TimescaleDB implementation
**Dependencies:** E0 (full skeleton compiling), E1 (TimescaleDB connection + hypertable created)
**Complexity:** L (implementation well-scoped; clean-room design)

---

## Executive Summary

Epic 2 implements the central event backbone that all five subsystems depend on. TimescaleDB provides the temporal-indexed episodic record; the EventsService wraps it with Sylphie-specific semantics: typed events, drive snapshots, learnability flags, correlation IDs, and schema versioning.

The implementation is straightforward because:
1. The hypertable schema is already created (E1-T005)
2. Event types are defined as a discriminated union in shared types (E0)
3. All five consumers have well-specified query patterns
4. The subsystem boundary is clean (EventsModule owns TimescaleDB exclusively)

Key risks: connection pool exhaustion under high write load, temporal query complexity with large datasets, and learnable event rate-limiting (max 5 per cycle). Performance testing during implementation prevents surprises.

---

## 1. IEventService Method Implementation Approach

### 1.1 record(event: SylphieEvent): Promise<void>

**Purpose:** Write-path; every action, prediction, drive event, and learning event flows through this method.

**Implementation:**
- Accept typed `SylphieEvent` parameter (from shared/types/event.types.ts)
- Extract fields: type (discriminator), subsystem_source, timestamp (UTC), drive_snapshot, correlation_id, event_data (full payload as JSONB)
- Generate `event_id` (UUID) server-side
- Default `actor_id` to 'sylphie' (may be overridden for multi-actor scenarios)
- Default `has_learnable` to false (set by subsystems that know the event is learnable)
- Default `processed` to false
- Set `schema_version` to 1 (for future schema migrations)
- Insert into `events` hypertable via parameterized query

**Error Handling:**
- Catch connection timeouts → logged warning, fire-and-forget (events are bufferable)
- Catch constraint violations (if any) → log but don't throw (system resilience)
- No transaction wrapping (single-row inserts, idempotent)

**Subsystem Usage Pattern:**
```typescript
// Decision Making
await eventsService.record({
  type: 'PREDICTION_GENERATED',
  subsystemSource: 'DECISION_MAKING',
  timestamp: new Date(),
  correlationId: episodeId,
  driveSnapshot: currentDriveState,
  eventData: { predictions: [...], actionCandidates: [...] },
});

// Learning
await eventsService.record({
  type: 'EDGE_REFINED',
  subsystemSource: 'LEARNING',
  timestamp: new Date(),
  eventData: { from: nodeId, to: nodeId, edgeType: 'KNOWS', confidence: 0.75 },
  hasLearnable: false, // This event is an outcome, not a learnable source
});
```

**Performance Consideration:**
- Record() should not block the caller (return void promise immediately, background commit acceptable)
- Use prepared statements to reduce parse overhead
- Batch write strategy (optional for Phase 1, future optimization): accumulate events in memory buffer, flush every N events or T milliseconds

### 1.2 query(filter: EventQueryFilter): Promise<SylphieEvent[]>

**Purpose:** Read-path for subsystems needing historical context (Communication, Decision Making).

**EventQueryFilter interface:**
```typescript
interface EventQueryFilter {
  startTime?: Date;           // Inclusive, default 24h ago
  endTime?: Date;             // Inclusive, default now
  eventTypes?: EventType[];   // Array; empty = all types
  subsystemSource?: SubsystemSource; // Single source only (per subsystem isolation rule)
  correlationId?: UUID;       // Get all events in an episode
  limit?: number;             // Default 1000, max 10000 (prevent runaway)
  offset?: number;            // For pagination
}
```

**Implementation:**
- Build dynamic WHERE clause from filter (all conditions AND'd together)
- Order by timestamp DESC (most recent first, typical access pattern)
- Apply LIMIT + OFFSET for pagination (prevents memory explosion)
- Return full SylphieEvent array (deserialize JSONB event_data back to payload objects)

**Example Query:**
```sql
SELECT
  event_id, timestamp, event_type, subsystem_source,
  correlation_id, actor_id, drive_snapshot, tick_number,
  event_data, has_learnable, processed, schema_version
FROM events
WHERE timestamp >= $1 AND timestamp < $2
  AND event_type IN ($3, $4, ...)
  AND subsystem_source = $5
  AND correlation_id = $6
ORDER BY timestamp DESC
LIMIT $7 OFFSET $8;
```

**Index Usage:**
- Leverages composite index (timestamp, event_type) from E1-T005
- Leverages subsystem_source index
- Leverages correlation_id index for episode queries

**Subsystem Usage Pattern:**
```typescript
// Communication: get recent context about guardian's last 5 interactions
const recentInteractions = await eventsService.query({
  startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days
  subsystemSource: 'COMMUNICATION',
  eventTypes: ['GUARDIAN_INPUT', 'RESPONSE_GENERATED'],
  limit: 100,
});

// Decision Making: get all events in current episode
const episode = await eventsService.query({
  correlationId: currentEpisodeId,
  limit: 10000, // May be large
});
```

**Performance Consideration:**
- Default time window to 24h to prevent full-table scans
- Use LIMIT to cap result set (10000 max)
- Test query plan with EXPLAIN ANALYZE on large datasets

### 1.3 queryLearnableEvents(limit?: number): Promise<LearnableEvent[]>

**Purpose:** Called by Learning subsystem once per maintenance cycle; retrieves up to N unprocessed learnable events.

**Per CANON & Roadmap:**
- Max 5 per cycle (configurable, default 5; protects against catastrophic interference)
- Only events with `has_learnable=true` AND `processed=false`
- Order by timestamp ASC (oldest first, FIFO consolidation order)

**Implementation:**
```typescript
async queryLearnableEvents(limit: number = 5): Promise<LearnableEvent[]> {
  const query = `
    SELECT
      event_id, timestamp, event_type, subsystem_source,
      correlation_id, event_data, drive_snapshot
    FROM events
    WHERE has_learnable = true AND processed = false
    ORDER BY timestamp ASC
    LIMIT $1;
  `;
  const result = await this.pool.query(query, [limit]);
  return result.rows.map(row => this.deserializeEvent(row));
}
```

**Error Handling:**
- If no learnable events exist, return empty array (not an error)
- Connection failures: throw SylphieException (Learning cycle will retry on next tick)

**Subsystem Usage Pattern:**
```typescript
// Learning: once per maintenance cycle
const learnableEvents = await eventsService.queryLearnableEvents(5);
for (const event of learnableEvents) {
  // Extract entities, refine edges, etc.
  // Then mark as processed
}
```

**Performance Consideration:**
- Index on `has_learnable` (from E1-T005) makes this query very fast
- Limit 5 ensures queries complete in <10ms even with large dataset
- No pagination needed (caller processes all returned events before next cycle)

### 1.4 queryEventFrequency(eventType: EventType, windowMs: number): Promise<number>

**Purpose:** Called by Drive Engine every tick to count recent events of a specific type (used for signal computation).

**Per CANON & Roadmap:**
- Drive Engine evaluates "how often has X happened in the last N milliseconds?"
- Used for: satisfaction signals (successful action count), curiosity signals (novel entity encounters), social signals (guardian interaction frequency)

**Implementation:**
```typescript
async queryEventFrequency(
  eventType: EventType,
  windowMs: number,
): Promise<number> {
  const windowStart = new Date(Date.now() - windowMs);
  const query = `
    SELECT COUNT(*) as count
    FROM events
    WHERE event_type = $1 AND timestamp >= $2;
  `;
  const result = await this.pool.query(query, [eventType, windowStart]);
  return parseInt(result.rows[0].count, 10);
}
```

**Example Drive Engine Usage:**
```typescript
// Every tick, evaluate signals
const successfulActionCount = await eventsService.queryEventFrequency(
  'ACTION_EXECUTED_SUCCESSFULLY',
  60_000, // Last 1 minute
);
const satisfactionSignal = Math.min(1.0, successfulActionCount / 10); // Normalized to 1.0 at 10+ successes
```

**Performance Consideration:**
- Time-window queries may scan many chunks (hypertable compression helps)
- EXPLAIN ANALYZE on 90-day dataset with frequent windowMs queries
- Consider adding materialized view for common window sizes (e.g., 1h, 1d) if polling shows high cost

**Frequency Signals by Subsystem:**
| Event Type | Window | Drive | Purpose |
|-----------|--------|-------|---------|
| ACTION_EXECUTED_SUCCESSFULLY | 60s | Satisfaction | Reward successful behaviors |
| GUARDIAN_POSITIVE_FEEDBACK | 3600s | Satisfaction | Guardian approval signal |
| NOVEL_ENTITY_ENCOUNTERED | 86400s | Curiosity | New knowledge discovered |
| GUARDIAN_INPUT | 600s | Social | Human interaction frequency |
| PREDICTION_MISMATCH | 3600s | Anxiety | Uncertainty/learning needed |

### 1.5 markProcessed(eventIds: UUID[]): Promise<void>

**Purpose:** Called by Learning subsystem after consolidating learnable events. Sets `processed=true` so events aren't re-learned.

**Implementation:**
```typescript
async markProcessed(eventIds: UUID[]): Promise<void> {
  if (eventIds.length === 0) return; // No-op
  const placeholders = eventIds.map((_, i) => `$${i + 1}`).join(',');
  const query = `
    UPDATE events
    SET processed = true, updated_at = NOW()
    WHERE event_id IN (${placeholders});
  `;
  await this.pool.query(query, eventIds);
}
```

**Idempotency:**
- Calling markProcessed() twice on the same events is safe (second call is no-op)
- No error if event_id doesn't exist (silent success)

**Subsystem Usage Pattern:**
```typescript
// Learning: after consolidating
const learnableEvents = await eventsService.queryLearnableEvents(5);
const processedEventIds = learnableEvents.map(e => e.id);
await eventsService.markProcessed(processedEventIds);
```

**Error Handling:**
- Connection failures: throw SylphieException (Learning will retry)
- Invalid UUIDs: caught by parameter binding (no SQL injection)

---

## 2. Query Patterns Needed by Each Subsystem Consumer

### Decision Making
- `query()` with correlationId = current episodeId (retrieve all events in episode)
- `record()` for: PREDICTION_GENERATED, INPUT_RECEIVED, ACTION_SELECTED, ACTION_EXECUTED_SUCCESSFULLY, ACTION_EXECUTED_FAILED, OBSERVATION_RECORDED
- **Pattern:** Retrieve full episode context for Inner Monologue and Arbitration

### Communication
- `query()` with subsystemSource='COMMUNICATION' and eventTypes=['GUARDIAN_INPUT', 'RESPONSE_GENERATED'] (get recent conversation history)
- `query()` with correlationId for conversation threads
- `record()` for: GUARDIAN_INPUT, RESPONSE_GENERATED, PERSON_MODEL_UPDATED
- **Pattern:** Retrieve 24-48h window for context injection into LLM prompt

### Learning
- `queryLearnableEvents()` (max 5, unprocessed)
- `markProcessed()` after consolidating
- `record()` for: ENTITY_CREATED, EDGE_REFINED, CONTRADICTION_DETECTED, KNOWLEDGE_CONFIRMED
- **Pattern:** Maintenance cycle polling, high-volume event marking

### Drive Engine
- `queryEventFrequency()` for multiple event types with varying windows (1m, 1h, 1d, 7d)
- `record()` for: DRIVE_TICK, OPPORTUNITY_DETECTED, RULE_EVALUATED
- **Pattern:** Frequent polling (100Hz tick rate), aggregation queries

### Planning
- `query()` with eventTypes=['OPPORTUNITY_DETECTED', 'PLAN_CREATED', 'PLAN_EXECUTED'] (retrieve opportunity patterns)
- `query()` with correlationId to simulate plan execution outcomes
- `record()` for: PLAN_RESEARCHED, SIMULATION_RUN, PLAN_PROCEDURE_CREATED
- **Pattern:** Research phase queries many events, execution phase updates outcomes

### Web/API
- `query()` for dashboard (graph viz, recent events feed)
- No recording (read-only for frontend)
- **Pattern:** Pagination with LIMIT/OFFSET, filtering by event type and subsystem

---

## 3. Additional Indexes Beyond E1-T005

E1-T005 creates:
- `idx_event_type` on event_type
- `idx_subsystem_source` on subsystem_source
- `idx_has_learnable` on has_learnable
- `idx_correlation_id` on correlation_id
- `idx_timestamp_event_type_composite` on (timestamp, event_type)

**Additional indexes needed:**

| Index Name | Columns | Reason | Query Pattern |
|------------|---------|--------|---------------|
| `idx_has_learnable_processed` | (has_learnable, processed, timestamp) | queryLearnableEvents() filter + ordering | Learning cycle bottleneck |
| `idx_processed` | processed | Future: cleanup of old processed events | Retention maintenance |
| `idx_actor_id` | actor_id | Future multi-actor scenarios | Actor-scoped queries |
| `idx_subsystem_timestamp` | (subsystem_source, timestamp DESC) | Communication context queries | Subsystem + recency |

**Rationale:**
- `idx_has_learnable_processed` is CRITICAL for queryLearnableEvents(). Without it, every cycle scans all has_learnable=true events.
- Others are optional for Phase 1 but recommended for Phase 2+ optimization.

**Index Creation DDL (add to E1-T005 OnModuleInit):**
```sql
CREATE INDEX IF NOT EXISTS idx_has_learnable_processed
  ON events (has_learnable, processed, timestamp DESC)
  WHERE has_learnable = true AND processed = false;

CREATE INDEX IF NOT EXISTS idx_subsystem_timestamp
  ON events (subsystem_source, timestamp DESC);
```

---

## 4. Event Type Taxonomy

Event types are defined as a **discriminated union** in `shared/types/event.types.ts` (E0b deliverable). Each event type is a separate variant of the `SylphieEvent` union, discriminated on the `type` field.

### 4.1 Event Type Grouping by Subsystem

**Decision Making (8 event types):**
- `PREDICTION_GENERATED` - Inner Monologue output (predictions array, action candidates, confidence)
- `INPUT_RECEIVED` - External input (text, voice, sensor)
- `ACTION_SELECTED` - Arbitration winner (action procedure ID, confidence, type 1/2 flag)
- `ACTION_EXECUTED_SUCCESSFULLY` - Executor completed action without error
- `ACTION_EXECUTED_FAILED` - Executor encountered error during execution
- `OBSERVATION_RECORDED` - World state observation (entity state change)
- `EPISODIC_MEMORY_ENCODED` - Episodic entry created (episode boundaries)
- `PREDICTION_EVALUATED` - Prediction outcome computed (predicted vs actual, MAE, outcome type)

**Communication (4 event types):**
- `GUARDIAN_INPUT` - Guardian provides text/voice input
- `RESPONSE_GENERATED` - System generates response (text, before TTS)
- `PERSON_MODEL_UPDATED` - Other KG updated with interaction data
- `COMMENT_INITIATED` - System initiates conversational turn (no external trigger)

**Learning (5 event types):**
- `MAINTENANCE_CYCLE_STARTED` - Learning cycle begins
- `ENTITY_CREATED` - New node added to WKG
- `ENTITY_UPDATED` - Existing node modified
- `EDGE_REFINED` - Edge added or confidence updated
- `CONTRADICTION_DETECTED` - Conflicting knowledge identified (for investigation)

**Drive Engine (5 event types):**
- `DRIVE_TICK` - One tick of drive computation (all 12 drive values)
- `OPPORTUNITY_DETECTED` - Drive Engine flagged a learning opportunity
- `RULE_EVALUATED` - A drive rule was evaluated (for audit trail)
- `SELF_EVALUATION_CYCLE` - KG(Self) read and evaluated (slower timescale)
- `SIGNAL_COMPUTED` - A single signal computation result

**Planning (4 event types):**
- `OPPORTUNITY_RESEARCH_STARTED` - Opportunity entered planning pipeline
- `SIMULATION_RUN` - Plan simulation computed outcome prediction
- `PLAN_PROCEDURE_CREATED` - New plan added to WKG
- `PLAN_EXECUTED` - Plan procedure executed (with outcome)

**System/Meta (4 event types):**
- `SESSION_STARTED` - System initialization
- `SESSION_ENDED` - System shutdown
- `SCHEMA_MIGRATION` - Schema version change (for future migrations)
- `ERROR_RECOVERED` - Error occurred and was recovered from

**Total: 30 event types** (allows future expansion by 10-15% without redesign)

### 4.2 Event Type Enum Definition

```typescript
// shared/types/event.types.ts
export type EventType =
  // Decision Making
  | 'PREDICTION_GENERATED'
  | 'INPUT_RECEIVED'
  | 'ACTION_SELECTED'
  | 'ACTION_EXECUTED_SUCCESSFULLY'
  | 'ACTION_EXECUTED_FAILED'
  | 'OBSERVATION_RECORDED'
  | 'EPISODIC_MEMORY_ENCODED'
  | 'PREDICTION_EVALUATED'
  // Communication
  | 'GUARDIAN_INPUT'
  | 'RESPONSE_GENERATED'
  | 'PERSON_MODEL_UPDATED'
  | 'COMMENT_INITIATED'
  // Learning
  | 'MAINTENANCE_CYCLE_STARTED'
  | 'ENTITY_CREATED'
  | 'ENTITY_UPDATED'
  | 'EDGE_REFINED'
  | 'CONTRADICTION_DETECTED'
  // Drive Engine
  | 'DRIVE_TICK'
  | 'OPPORTUNITY_DETECTED'
  | 'RULE_EVALUATED'
  | 'SELF_EVALUATION_CYCLE'
  | 'SIGNAL_COMPUTED'
  // Planning
  | 'OPPORTUNITY_RESEARCH_STARTED'
  | 'SIMULATION_RUN'
  | 'PLAN_PROCEDURE_CREATED'
  | 'PLAN_EXECUTED'
  // System
  | 'SESSION_STARTED'
  | 'SESSION_ENDED'
  | 'SCHEMA_MIGRATION'
  | 'ERROR_RECOVERED';

export type SubsystemSource =
  | 'DECISION_MAKING'
  | 'COMMUNICATION'
  | 'LEARNING'
  | 'DRIVE_ENGINE'
  | 'PLANNING'
  | 'SYSTEM';
```

### 4.3 Discriminated Union Event Interface

```typescript
// shared/types/event.types.ts
export interface SylphieEvent {
  id: UUID;
  timestamp: Date; // UTC
  eventType: EventType;
  subsystemSource: SubsystemSource;
  correlationId?: UUID; // Episode ID or logical grouping
  actorId: string; // Default 'sylphie', may be person ID
  driveSnapshot?: DriveSnapshot; // 12-drive state at event time
  tickNumber?: bigint; // From Drive Engine tick counter
  eventData: Record<string, unknown>; // Discriminated by eventType
  hasLearnable: boolean; // True if event should be consolidated by Learning
  processed: boolean; // True if Learning has already consolidated it
  schemaVersion: number; // For future migrations
}

// For Learning: events with hasLearnable=true carry learnable metadata
export interface LearnableEvent extends SylphieEvent {
  hasLearnable: true;
  eventData: {
    // Specific payload depends on eventType
    [key: string]: unknown;
  };
}
```

---

## 5. Performance Considerations

### 5.1 Connection Pooling

**TimescaleDB Pool Configuration (from E1-T005):**
- Pool size: 30 (configurable)
- Connection timeout: 5s
- Idle timeout: 30s
- Idle connection reuse: true (PG default)

**Expected Load Estimate (Phase 1):**
- Decision Making: 1 record/tick * 100 Hz = 100 writes/sec
- Communication: 0-10 writes/sec (human-driven)
- Learning: 5 reads + 5 markProcessed per maintenance cycle (once per min)
- Drive Engine: ~1 record + 5-10 reads per tick = 150+ reads/sec
- Planning: 0-5 reads/writes per opportunity (sparse)
- **Total: ~300 operations/sec peak**

At 30 connections, average conn utilization = 10, no congestion expected in Phase 1.

**Scaling Strategy (Phase 2+):**
- If peak load > 500 ops/sec: increase pool size to 50
- If queryEventFrequency() becomes bottleneck: add materialized view for common windows
- If record() batching needed: accumulate 100 events or 10ms in buffer, batch insert

### 5.2 Query Optimization

**High-Frequency Queries:**

1. **queryEventFrequency()** (100Hz Drive Engine tick):
   - Index: (event_type, timestamp) — already exists
   - Typical query: count last 60 seconds, maybe 100-1000 rows
   - Execution time: <5ms expected
   - **Action:** Monitor with EXPLAIN ANALYZE; if >10ms, add filtered index

2. **queryLearnableEvents()** (1x/min Learning):
   - Index: `idx_has_learnable_processed` (recommended above)
   - Typical query: 0-5 rows (filtered by two boolean columns)
   - Execution time: <1ms expected
   - **Action:** Add index before E2 implementation

3. **query()** with correlationId (Decision Making per episode):
   - Index: correlation_id — already exists
   - Typical query: 5-100 rows per episode
   - Execution time: <10ms expected
   - **Action:** Monitor episode size growth; if >1000 rows, consider chunking

4. **query()** with subsystemSource + time range (Communication context):
   - Index: subsystem_source + timestamp — add `idx_subsystem_timestamp`
   - Typical query: 24h window, ~1000-5000 rows
   - Execution time: 10-50ms expected
   - **Action:** EXPLAIN ANALYZE; consider 7-day limit with pagination

### 5.3 Hypertable Optimization

**Compression (from E1-T005):**
- Auto-compress chunks >7 days old
- Expected 80%+ compression ratio on repetitive JSONB (drive snapshots)
- **Benefit:** Saves disk I/O for historical queries

**Retention (from E1-T005):**
- Auto-drop chunks >90 days old
- Learning consolidation should complete within 30 days (safety margin: 60 days)
- **Rationale (per Ashby analysis):** Cognitive Awareness drive pressure + Learning pressure = maintenance cycle max delay ~30 days; 90-day retention gives 2x buffer

**Chunk Time Interval (default 1 week):**
- With 300 ops/sec, expect ~2.5B rows/week
- Chunk size: ~100MB compressed
- **Action:** Monitor chunk size growth; if exceeding 500MB/chunk, increase chunk interval to 2 weeks

### 5.4 Write Path Optimization

**Current Approach:**
- Single-row INSERT per event
- No transaction batching (idempotent, fire-and-forget acceptable)
- Prepared statements (reduce parse cost)

**Throughput Estimate:**
- PostgreSQL can handle 5k-10k inserts/sec on standard hardware
- Phase 1 peak: 300 ops/sec
- **Conclusion:** Single-row inserts sufficient for Phase 1

**Future Optimization (Phase 2+):**
- Batch 100 events or every 10ms into multi-row INSERT
- Expected: 50%+ latency reduction, same throughput
- **Not needed for Phase 1**

---

## 6. Risks and Edge Cases

### Risk 1: Connection Pool Starvation

**Scenario:** All 30 connections occupied, new query waits indefinitely.

**Mitigation:**
- Set connection timeout to 5s (fail fast)
- Monitor pool metrics (waiting queue depth)
- Add circuit breaker: if wait time >2s, fail with SylphieException instead of blocking
- Increase pool size if utilization >80%

**Detection:**
- Log pool.query() latency; alert if p99 > 1s

### Risk 2: Hypertable Size Explosion

**Scenario:** Retention policy deletes too slowly; disk fills.

**Mitigation:**
- 90-day retention at 300 ops/sec = ~2.5B rows/90 days
- Compressed ~10GB total (rough estimate)
- Set up automated monitoring on disk usage
- Pre-alert at 70% capacity, trigger retention policy adjustment

**Detection:**
- TimescaleDB `show_chunks()` query daily; monitor growth rate

### Risk 3: queryLearnableEvents() Stalls Learning

**Scenario:** Too many learnable events (>100) accumulate; queryLearnableEvents() max 5/cycle means clearing backlog takes 20+ cycles.

**Mitigation:**
- Learning marks events `has_learnable=false` AFTER consolidation
- If backlog grows (observable via event count), Learning increases cycle frequency (faster cognitive pressure)
- Cap learnable event count at 50 total (circuit breaker on too much to consolidate)

**Detection:**
- Query: `SELECT COUNT(*) FROM events WHERE has_learnable=true AND processed=false;`
- Alert if >50 for >5 cycles

### Risk 4: Timestamp Skew Between Subsystems

**Scenario:** Events from different subsystems have mismatched clock times (system clock drift).

**Mitigation:**
- Always use `new Date()` (system clock) at call site, not at insert time
- If > 1 second drift detected, log warning (indicates system time issue)
- EventsService normalizes to UTC via TIMESTAMPTZ type

**Detection:**
- Add validation: if event.timestamp in future, log warning (clock skew or attacker)

### Risk 5: JSONB event_data Deserialization Fails

**Scenario:** Stored JSONB corrupts or contains unexpected schema; deserialization throws.

**Mitigation:**
- Store event_data as raw JSONB (minimal schema validation)
- Deserialize at call site (subsystem-specific validation, not service-level)
- EventsService returns raw event, subsystem handles JSONB parsing
- If parse fails, subsystem logs error, skips event (resilience)

**Detection:**
- Each subsystem tracks deserialization failures per event type
- Alert if >1% of events fail to deserialize

### Risk 6: correlationId Collisions

**Scenario:** Two episodes accidentally get same correlationId UUID (extremely unlikely but possible).

**Mitigation:**
- Each episode generates its own UUID at start (Decision Making responsibility)
- Check: if correlationId is queried and returns >1000 events, log warning (possible collision)
- UUID v4 collision probability: <10^-36 for normal usage (acceptable risk)

**Detection:**
- Query: `SELECT COUNT(*) FROM events GROUP BY correlation_id HAVING COUNT(*) > 1000;`

### Risk 7: Event Type String Typos

**Scenario:** Subsystem records event with eventType='PREDIСTION_GENERATED' (Cyrillic 'С'), doesn't match 'PREDICTION_GENERATED'.

**Mitigation:**
- Discriminated union in TypeScript enforces eventType values at compile time
- All event types defined in single enum (shared/types/event.types.ts)
- No string literals elsewhere
- IDE autocomplete prevents typos

**Detection:**
- If unseen event_type appears: log warning, do not crash
- Add validation: queryEventFrequency() rejects unknown event types

### Risk 8: Large episode queries OOM

**Scenario:** Query correlationId that has 100k+ events (malformed episode, memory leak).

**Mitigation:**
- Set LIMIT 10000 on query() calls (configurable)
- If caller needs >10000 events, requires pagination (OFFSET/LIMIT)
- Deserialize streaming (not all at once)

**Detection:**
- Alert if single query() returns maximum limit (may indicate underestimation)
- Query: `SELECT COUNT(*) FROM events GROUP BY correlation_id ORDER BY COUNT(*) DESC LIMIT 1;`

---

## 7. Ticket Breakdown

### E2-T001: IEventService Interface + Service Skeleton
**Complexity:** S
**Dependencies:** E0, E1

**Description:**
Create the EventsService skeleton implementing IEventService. All five methods throw `NotImplementedError`. Add type guards and parameter validation.

**Acceptance Criteria:**
- EventsService @Injectable() implements IEventService
- Five methods present: record(), query(), queryLearnableEvents(), queryEventFrequency(), markProcessed()
- All throw "Not implemented" with descriptive message
- Parameter validation: UUID validation on correlationId, EventType validation on event types
- DI token EVENTS_SERVICE properly exported
- npx tsc --noEmit passes
- No compilation errors

**Implementation Notes:**
- Parameter validation via class-validator decorators (e.g., @IsUUID on correlationId)
- EventQueryFilter DTO with optional fields
- SylphieEvent and EventType from shared/types (E0 deliverable)

---

### E2-T002: record() Implementation + Write Path Tests
**Complexity:** M
**Dependencies:** E2-T001, E1-T005

**Description:**
Implement record() method. Accepts typed SylphieEvent, extracts fields, generates UUID server-side, inserts into hypertable.

**Acceptance Criteria:**
- record() accepts SylphieEvent with full type safety
- Generates event_id (UUID v4) server-side
- Extracts: timestamp (UTC), event_type, subsystem_source, correlation_id, drive_snapshot, event_data
- Inserts into events hypertable with parameterized query
- Error handling: connection timeout = logged warning (non-blocking), constraint violations = logged (resilient)
- No transaction wrapping (single-row insert, fire-and-forget)
- Unit test: record() with 5 different event types succeeds
- Integration test: record() + immediate query() retrieves same event
- Performance test: record() completes in <10ms
- npx tsc --noEmit passes

**Implementation Notes:**
- Use parameterized queries to prevent SQL injection
- Default has_learnable=false, processed=false
- Default actor_id='sylphie'
- Set schema_version=1

---

### E2-T003: query() Implementation + Filter Tests
**Complexity:** M
**Dependencies:** E2-T001, E1-T005, E2-T002

**Description:**
Implement query(filter) for temporal range queries with event type/subsystem filtering. Support correlationId queries for episode retrieval.

**Acceptance Criteria:**
- query() builds dynamic WHERE clause from filter
- Supports: startTime, endTime, eventTypes[], subsystemSource, correlationId, limit, offset
- Default time window: 24h (if startTime not provided)
- Default limit: 1000, max 10000 (enforced)
- Order by timestamp DESC (most recent first)
- Returns full SylphieEvent array with deserialized event_data
- Query with empty filter returns last 24h events (limit 1000)
- Query with correlationId returns all events in episode (ignores time filters)
- Pagination test: offset=100, limit=10 returns correct page
- Index usage test: EXPLAIN shows index on (timestamp, event_type)
- Index usage test: EXPLAIN shows index on subsystem_source
- Index usage test: EXPLAIN shows index on correlation_id
- Empty result set returns [] not null
- Large result set (>10000) truncated to limit
- npx tsc --noEmit passes

**Implementation Notes:**
- EventQueryFilter DTO with @IsOptional() on optional fields
- Build WHERE clauses conditionally (if field provided)
- Use EXPLAIN ANALYZE in tests to verify index usage

---

### E2-T004: queryLearnableEvents() Implementation + Learning Tests
**Complexity:** S
**Dependencies:** E2-T001, E1-T005, E2-T002

**Description:**
Implement queryLearnableEvents() for Learning subsystem. Retrieves up to 5 unprocessed learnable events, ordered FIFO.

**Acceptance Criteria:**
- queryLearnableEvents(limit=5) default
- Filters: has_learnable=true AND processed=false
- Orders by timestamp ASC (oldest first, FIFO)
- Respects limit (max 5)
- Returns [] if no learnable events
- Throws SylphieException on connection failure (not empty result)
- Integration test: record() with hasLearnable=true, query, verify retrieved
- Integration test: mark same event as processed, re-query doesn't return it
- Performance test: <1ms execution on 1M event dataset
- Index test: EXPLAIN shows index on (has_learnable, processed, timestamp)
- npx tsc --noEmit passes

**Implementation Notes:**
- Add index idx_has_learnable_processed in OnModuleInit if not already present (from E1)
- Assume max 5 events per cycle (CANON requirement)
- No pagination needed (caller processes all returned)

---

### E2-T005: queryEventFrequency() Implementation + Drive Engine Tests
**Complexity:** M
**Dependencies:** E2-T001, E1-T005, E2-T002

**Description:**
Implement queryEventFrequency(eventType, windowMs) for Drive Engine tick-rate signal computation.

**Acceptance Criteria:**
- queryEventFrequency(eventType, windowMs) returns count integer
- Filters: event_type = X AND timestamp >= (now - windowMs)
- Returns 0 if no matching events (not null)
- Supports windows: 1m, 1h, 1d, 7d (no hardcoding; configurable)
- Throws SylphieException on connection failure
- Unknown eventType rejects with validation error
- Performance test: <5ms on 1M event dataset, 1h window
- Performance test: <10ms on 1M event dataset, 7d window
- Integration test: record() PREDICTION_GENERATED, queryEventFrequency() for PREDICTION_GENERATED counts correctly
- Concurrent calls: 100 simultaneous queries complete in <1s (pool utilization test)
- npx tsc --noEmit passes

**Implementation Notes:**
- Simple COUNT(*) query with time filter
- No deserialization needed (returns integer)
- Expects high-frequency polling (100Hz Drive Engine); test concurrent access

---

### E2-T006: markProcessed() Implementation + Idempotency Tests
**Complexity:** S
**Dependencies:** E2-T001, E1-T005, E2-T002

**Description:**
Implement markProcessed(eventIds) for Learning subsystem. Sets processed=true on multiple events.

**Acceptance Criteria:**
- markProcessed(eventIds: UUID[]) sets processed=true
- Empty array: no-op (no query executed)
- Non-existent event_id: silent success (UPDATE 0 rows, no error)
- Idempotent: calling twice with same IDs is safe
- Batch operation: single UPDATE with IN clause (not N queries)
- Performance test: 1000 events marked in <50ms
- Integration test: record() + markProcessed() + queryLearnableEvents() confirms processed=true
- Error handling: connection failure throws SylphieException (Learning will retry)
- npx tsc --noEmit passes

**Implementation Notes:**
- Use IN clause with placeholders for batch
- No transaction wrapping needed (idempotent)
- Return void (not row count)

---

### E2-T007: Connection Pool + Health Check + Error Handling
**Complexity:** S
**Dependencies:** E2-T001, E1-T005

**Description:**
Wire EventsService with TIMESCALEDB_POOL from E1-T005. Implement health check and error handling strategy.

**Acceptance Criteria:**
- EventsService @Inject(TIMESCALEDB_POOL) injects Pool from E1
- Health check method: healthCheck(): Promise<boolean>
- Health check: SELECT 1 query + verify events hypertable exists
- Health check returns true on success, false on connection timeout
- Connection timeout: 5s (from E1 config)
- Pool drain on module destroy (OnModuleDestroy)
- Circuit breaker: if 3 consecutive queries fail, log critical alert
- Retry strategy: transient failures (timeout) auto-retry 2x; persistent failures fail fast
- Integration test: start EventsService, run health check, passes
- Integration test: kill TimescaleDB container, health check fails within 5s
- Pool metrics: log p50/p99 latency of all queries
- npx tsc --noEmit passes

**Implementation Notes:**
- Health check method private (called by framework/monitoring)
- Connection errors: log with context (query type, error message)
- Retry logic: exponential backoff (100ms, 500ms), max 2 retries

---

### E2-T008: Integration Test Suite + Performance Benchmarks
**Complexity:** M
**Dependencies:** All E2 tickets (E2-T001 through E2-T007)

**Description:**
Comprehensive integration test suite covering all EventsService methods, query patterns, and performance characteristics. Tests must run against real TimescaleDB container (docker-compose).

**Acceptance Criteria:**
- Test: record() 100 events of mixed types, verify all stored
- Test: query() retrieves correct events for each filter combination
- Test: queryLearnableEvents() max 5, FIFO order
- Test: queryEventFrequency() for all common windows (1m, 1h, 1d, 7d)
- Test: markProcessed() idempotent, batch
- Test: Concurrent calls (20 parallel record() + 10 parallel query()) under load, no errors
- Test: Episode retrieval (correlationId) returns 100+ events in correct order
- Performance: record() <10ms p99
- Performance: query() 24h window <50ms p99
- Performance: queryLearnableEvents() <1ms p99
- Performance: queryEventFrequency() 1h window <5ms p99
- Performance: queryEventFrequency() 7d window <10ms p99
- Performance: markProcessed() 1000 events <50ms p99
- Test: Connection pool utilization stays <80% under load
- Test: Health check passes on startup, fails when db offline
- All tests pass on fresh TimescaleDB instance (no pre-seeded data)
- Test output includes latency percentiles (p50, p99, p999)
- npx tsc --noEmit passes

**Implementation Notes:**
- Use `jest` or `vitest` for test framework
- `@nestjs/testing` for NestJS module testing
- `testcontainers` or Docker Compose for TimescaleDB
- Benchmark with `hyperfine` or custom timer code
- Generate test data with seeding script (E0 or E1 artifact)

---

## 8. Implementation Sequence and Dependencies

**Week 1:**
1. E2-T001 (Interface skeleton, type validation)
2. E2-T002 (record() write path)
3. E2-T003 (query() read path)

**Week 2:**
4. E2-T004 (queryLearnableEvents())
5. E2-T005 (queryEventFrequency())
6. E2-T006 (markProcessed())

**Week 2 (parallel):**
7. E2-T007 (Connection pool, health check, error handling)

**Week 3:**
8. E2-T008 (Integration tests, performance benchmarks)

**Total: 2-3 weeks** (parallel ticket execution possible on T001-T003 and T004-T007)

---

## 9. Known Unknowns and Future Decisions

### Event Schema Versioning
- Currently `schema_version=1` hardcoded
- Future: if event structure changes (new field, renamed field), increment version
- Migration strategy: decide in E3+ when needed (v2 may have additional metadata from Learning)

### Batch Inserts for record()
- Currently: single-row INSERT per event
- Future: if write throughput >1000 ops/sec, implement batch buffer (100 events or 10ms)
- Not blocking Phase 1; Phase 2 optimization

### Materialized Views for queryEventFrequency()
- Currently: real-time COUNT(*) on hypertable
- Future: if p99 latency >10ms, create materialized view for common windows (1h, 1d)
- Not blocking Phase 1; Phase 2 optimization if needed

### Event Archival Strategy
- Currently: retention policy auto-drops at 90 days
- Future: export old events to S3/cold storage for long-term analysis
- Not needed for Phase 1

---

## 10. Success Criteria (Epic Level)

All tickets E2-T001 through E2-T008 complete with:
- Zero compilation errors (`npx tsc --noEmit`)
- All acceptance criteria met for each ticket
- All integration tests pass (real TimescaleDB container)
- Performance benchmarks show <10ms p99 for all critical paths
- EventsService usable by all five subsystems (confirmed by successful imports in downstream modules)
- Documentation: method signatures, query examples, error codes in code comments
- Session log written to `docs/sessions/YYYY-MM-DD-epic-2-events.md`

---

## References

- **CANON:** `wiki/CANON.md` -- Immutable standards 1-6, drive architecture, six immutable standards
- **Roadmap:** `wiki/phase-1/roadmap.md` -- Epic dependency graph, E2 overview
- **Epic 1 Tickets:** `wiki/phase-1/epic-1/tickets.yml` -- E1-T005 TimescaleDB hypertable schema
- **Confidence Dynamics:** CANON section "Confidence Dynamics (ACT-R)" -- base confidence and retrieval thresholds
- **Learning Cycle:** CANON section "Subsystem 3: Learning" -- maintenance cycle triggering, max 5 learnable events per cycle

# Epic 2: Decisions

## Decisions Made During Planning

### 1. Single hypertable with discriminant columns (Option A)
**Decision:** Use a single `events` hypertable with `event_type` and `subsystem_source` discriminant columns, not separate hypertables per subsystem.

**Rationale (Canon + Sentinel):** Single hypertable reduces operational complexity. Indexes on `(event_type, timestamp)` and `(subsystem_source, timestamp)` provide efficient per-subsystem filtering. Cross-subsystem queries (e.g., Planning researching patterns across Decision Making and Drive Engine events) are simple JOINs rather than UNION ALL across tables. Compression and retention policies apply uniformly.

**Trade-off:** Slightly less isolation between subsystem event streams. Mitigated by type-safe boundary enforcement at the application layer.

### 2. Dual provenance: subsystem_source + optional provenance field
**Decision:** Events carry both `subsystem_source` (which subsystem emitted it) and an optional `provenance` field (SENSOR/GUARDIAN/LLM_GENERATED/INFERENCE).

**Rationale (Canon):** Subsystem source tracks the architectural origin. Provenance tracks the epistemological origin — critical for the lesion test. When Communication emits an UTTERANCE_GENERATED event containing LLM-generated text, the event's provenance should be LLM_GENERATED so filtering `WHERE provenance != 'LLM_GENERATED'` reveals what Sylphie can do without the LLM.

### 3. Type-safe discriminated union with compile-time boundary enforcement
**Decision:** Event types are a TypeScript discriminated union where each event_type is paired with exactly one SubsystemSource. Boundary validation happens at compile time via type narrowing, with runtime validation as a safety net.

**Rationale (Forge):** Prevents the most common error: a subsystem emitting event types that belong to another subsystem. Compile-time enforcement means this class of bug is impossible to introduce. Runtime validation (EVENT_TYPE_BOUNDARIES map) catches edge cases where types might be widened.

### 4. SELECT FOR UPDATE SKIP LOCKED for queryLearnableEvents()
**Decision:** Use `SELECT FOR UPDATE SKIP LOCKED` in queryLearnableEvents() to prevent concurrent Learning cycles from processing the same events.

**Rationale (Forge):** If two Learning maintenance cycles run concurrently (possible under high cognitive pressure), without locking they would both pick up the same 5 events and double-process them. SKIP LOCKED means the second cycle gets the next 5 available events instead of blocking or duplicating.

**Trade-off:** Adds pessimistic locking overhead. Acceptable because queryLearnableEvents() runs at most once per minute, not at tick rate.

### 5. Critical index: idx_has_learnable_processed
**Decision:** Add a partial index `ON events (has_learnable, processed, timestamp) WHERE has_learnable = true AND processed = false` during EventsService OnModuleInit.

**Rationale (Sentinel):** Without this index, every queryLearnableEvents() call scans all events with has_learnable=true. The partial index restricts to only unprocessed learnable events, making the query O(1) regardless of total event count.

### 6. Drive snapshot timing: BEFORE action execution
**Decision:** Drive snapshots attached to events are captured BEFORE the action is executed, not after.

**Rationale (Ashby + Canon):** Theater Prohibition requires correlating output with drive state at the time of the decision, not the drive state after the outcome is observed. If the snapshot were taken after execution, guardian response could already have modified drive state, making the correlation check meaningless.

### 7. has_learnable set by emitting subsystem, not a separate policy service
**Decision:** The subsystem that emits an event sets `has_learnable` based on its knowledge of whether the event contains learnable content. No separate "learnability policy service."

**Rationale:** Ashby recommended a policy service to prevent tight coupling, but this adds complexity disproportionate to the risk. The type system already constrains which events can be learnable (only certain event types). The emitting subsystem knows best whether this specific instance contains learnable content (e.g., a Communication event with new entities vs. a routine acknowledgment).

**Mitigation for Ashby's concern:** The consolidation debt alarm (emit warning when unconsolidated backlog > 50) detects if any subsystem floods Learning with junk has_learnable events.

### 8. record() returns { eventId, timestamp } rather than void
**Decision:** record() returns the generated eventId and timestamp, deviating from the E0 stub's `Promise<void>`.

**Rationale (Forge):** Callers need the eventId for correlation tracking. Decision Making needs to reference prediction_event_id in outcome events. Returning void would require callers to generate their own IDs, creating potential inconsistency.

### 9. markProcessedBatch() added to IEventService
**Decision:** Add markProcessedBatch(eventIds: string[]) alongside markProcessed(eventId: string).

**Rationale (Forge + Sentinel):** Learning processes up to 5 events per cycle. Calling markProcessed() 5 times is 5 round trips. Batch operation is a single UPDATE with IN clause — more efficient and atomic.

## Decisions Requiring Jim

### 1. Event type taxonomy finality
The 30 event types defined here are based on agent analysis of the CANON and roadmap. Jim should review whether any events are missing or misplaced. Particularly: should there be a TYPE_2_DELIBERATION_COST event type for explicit Type 2 cost tracking?

**Status:** APPROVED (2026-03-29) — 30 types as defined. Add TYPE_2_DELIBERATION_COST if needed during implementation.

### 2. Compression window interaction with Learning
Ashby flagged that events compressed at 7 days may lose granularity needed for Learning consolidation. Current retention is 90 days (drops chunks), compression is 7 days (compresses but preserves). Compressed events are still queryable but JSONB fields may be less accessible. Is 7-day compression acceptable, or should it be extended to 14 days?

**Status:** APPROVED (2026-03-29) — 7-day compression acceptable. Revisit if Learning consolidation issues observed.

### 3. Streaming Observable (streamEvents)
Forge proposed an optional streamEvents() method returning an RxJS Observable for real-time event streaming. This is useful for the Drive Engine to react to events without polling, but adds complexity. Should this be included in E2 or deferred to E4/E9?

**Recommendation:** Defer to E4. Polling is sufficient for E2 and downstream consumers. Add streaming when the Drive Engine's real-time requirements are better understood.

**Status:** APPROVED (2026-03-29) — Defer to E4. Polling sufficient for E2.

# Epic 2: Events Module (TimescaleDB Backbone) — Canon Compliance Analysis

**Reviewed against:** `wiki/CANON.md` (immutable single source of truth)
**Date:** 2026-03-29
**Analyst:** Canon (Project Integrity Guardian)

---

## Executive Summary

Epic 2 implements the real `EventsService` that replaces E0 stubs and fulfills the CANON's vision of TimescaleDB as the shared event backbone. The specification correctly positions events as the episodic memory that all five subsystems write to and read from.

**Specification Status:** Roadmap adequate; detailed implementation spec required before E2 begins.

**Compliance Status:** 7 of 8 checks COMPLIANT. 1 critical gap identified.

---

## 1. TimescaleDB as Shared Event Backbone (CANON §Shared Infrastructure)

### Specification
E2 provides the real `EventsService` replacing E0 stubs with four core methods:
- `record()` — typed event emission with UTC timestamping
- `query()` — temporal range queries, event type filtering, subsystem-scoped queries
- `queryLearnableEvents()` — max 5 per cycle for Learning consolidation
- `queryEventFrequency()` — aggregation for Drive Engine frequency analysis
- `markProcessed()` — tracking consumed events

### CANON References
- **§Shared Infrastructure / TimescaleDB:** "Every subsystem writes to TimescaleDB. It is the system's episodic record — what happened, when, in what context, with what drive state."
- **All five subsystems read from it:** Decision Making, Communication, Learning, Drive Engine, Planning
- **§Subsystem 3 (Learning):** "Query TimescaleDB for response events with `has_learnable=true` (max 5 per cycle to prevent catastrophic interference)"
- **§Subsystem 4 (Drive Engine):** "Tick Event → query last 10 event frequencies from TimescaleDB"
- **§Subsystem 5 (Planning):** "Research Opportunity → query event frequency from TimescaleDB"

### Analysis

**COMPLIANT** — E2 correctly interprets the CANON's event backbone requirement:

- ✓ Real `EventsService` implementation (not stub)
- ✓ All five subsystems can call `record()` to emit typed events
- ✓ Learning can query `queryLearnableEvents()` with max-5 constraint built in
- ✓ Drive Engine can query `queryEventFrequency()` for frequency aggregation
- ✓ Planning can research events via the same frequency analysis
- ✓ UTC timestamping ensures temporal coherence across subsystems

**Strength:** The roadmap explicitly constrains Learning to "max 5 per cycle" — this prevents the "catastrophic interference" problem flagged in CANON and protects against learning runaway.

**Implementation readiness:** HIGH. All five subsystems have clear, distinct query patterns.

---

## 2. Stream Separation (CANON §Shared Infrastructure)

### Specification
E2 introduces "typed events with subsystem tags" and "event stream schema". The roadmap states: "Stream separation: Events should be logically typed (prediction events, communication events, drive events, learning events) to reduce coupling between subsystems."

### CANON References
- **§Shared Infrastructure / Stream Separation:** "Events should be logically typed (prediction events, communication events, drive events, learning events) to reduce coupling between subsystems."

### Analysis

**PARTIAL COMPLIANCE** — The roadmap identifies stream separation as required but does NOT specify the implementation strategy.

**Critical gap:** E1 Canon analysis flagged this as outstanding (Gap 3). E2 must resolve it:

**Option A: Single hypertable with event_type discriminant**
```sql
CREATE TABLE events (
  time TIMESTAMP NOT NULL,
  event_id UUID PRIMARY KEY,
  event_type VARCHAR NOT NULL,  -- PREDICTION_GENERATED | INPUT_RECEIVED | OUTCOME_REPORTED | etc.
  subsystem_source VARCHAR NOT NULL,  -- DECISION_MAKING | COMMUNICATION | LEARNING | DRIVE_ENGINE | PLANNING
  ...
);

CREATE INDEX idx_events_type_time ON events (event_type, time DESC);
CREATE INDEX idx_events_subsystem_time ON events (subsystem_source, time DESC);
```

**Option B: Multiple hypertables (one per subsystem)**
```sql
-- Each hypertable is separate, enabling subsystem-specific compression/retention
CREATE TABLE events_decision_making (...);
CREATE TABLE events_communication (...);
CREATE TABLE events_drive_engine (...);
CREATE TABLE events_learning (...);
CREATE TABLE events_planning (...);
```

**Recommendation:** **Option A is preferred** for E2:
- Single hypertable with discriminant columns reduces operational complexity
- Indexes on `(event_type, time)` and `(subsystem_source, time)` provide efficient filtering
- Learning can query `WHERE subsystem_source IN (...) AND has_learnable=true`
- Drive Engine can query `WHERE event_type LIKE '%_OUTCOME' AND time > now() - INTERVAL '10 minutes'`
- Planning research queries become: `WHERE subsystem_source=... AND context IN (opportunity_context_list)`

**Why this matters:** Loose coupling means:
- Communication subsystem doesn't know when Drive Engine evaluates
- Learning doesn't wait for Decision Making to finish predicting
- Planning can replay event history without synchronous dependencies

**Decision required for Jim:** E2 should specify the chosen partitioning strategy and index design before implementation.

---

## 3. Provenance on Events (CANON §Core Philosophy 7)

### Specification
E0 shared types define `ProvenanceSource` union (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE). E2 must tag every emitted event with its provenance.

### CANON References
- **§Core Philosophy 7:** "Every node and edge in the WKG carries a provenance tag. This distinction is never erased. It enables the lesion test."
- **§Provenance Is Sacred:** While this applies to WKG nodes/edges, events are the raw material that feed into the WKG. Events themselves should carry subsystem-level provenance.

### Analysis

**COMPLIANT** — E2 roadmap states: "typed events with subsystem tags, drive snapshots, correlation IDs, has_learnable flag, schema_version."

The `subsystem_source` field (DECISION_MAKING, COMMUNICATION, LEARNING, DRIVE_ENGINE, PLANNING) is a direct parallel to WKG provenance. It tells us which subsystem generated this event.

**Additional requirement for CANON §7 enforcement:**

When an event is emitted by Communication subsystem and contains an LLM-generated phrase, should the event carry:
- `subsystem_source: COMMUNICATION` (where it came from)
- `provenance_source: LLM_GENERATED` (where the knowledge came from)

**Recommendation:** E2 events should carry both:
```typescript
interface SylphieEvent {
  eventId: UUID;
  time: DateTime;
  eventType: EventType;
  subsystemSource: SubsystemSource;  // Where the event came from (DECISION_MAKING, etc.)
  provenance?: ProvenanceSource;     // If applicable: SENSOR | GUARDIAN | LLM_GENERATED | INFERENCE
  // ... rest of event data
}
```

This dual tagging enables the lesion test: you can filter events by `WHERE provenance != LLM_GENERATED` to see what Sylphie can determine without the LLM.

---

## 4. Drive State Snapshot (CANON §Theater Prohibition)

### Specification
E2 specifies "drive snapshots" as part of the event schema. This enables the Theater Prohibition (Immutable Standard 1).

### CANON References
- **§Immutable Standard 1 (Theater Prohibition):** "Any output (speech, motor action, reported state) must correlate with actual drive state. If Sylphie produces an emotional expression and the corresponding drive is below 0.2, the expression receives zero reinforcement regardless of guardian response."
- **Architecture §Shared Infrastructure:** "Events carry drive_snapshot JSONB for theater detection"

### Analysis

**COMPLIANT** — E2 correctly includes "drive snapshots" in the event schema:

- ✓ Every output event (e.g., COMMUNICATION_SPOKEN, ACTION_EXECUTED) should carry a `drive_snapshot` field
- ✓ This snapshot captures the 12-drive state at the moment of action
- ✓ Drive Engine can later evaluate: "Did Sylphie express sadness when sadness was < 0.2?" (Theater detection)
- ✓ Theater detection blocks reinforcement of inauthentic behavior

**Implementation detail (for E2 spec):**

When Communication generates a response, what data should be in `drive_snapshot`?

```typescript
interface DriveSnapshot {
  timestamp: DateTime;
  systemHealth: number;    // 0.0-1.0
  moralValence: number;
  integrity: number;
  cognitiveAwareness: number;
  guilt: number;
  curiosity: number;
  boredom: number;
  anxiety: number;
  satisfaction: number;
  sadness: number;
  informationIntegrity: number;
  social: number;
}
```

This is straightforward: the Drive Engine reads its current state and this gets attached to the event.

**Timing consideration:** The snapshot should be taken **before** the action is executed, not after. This way, Communication can embed "I was thinking about saying X" with the drive state that motivated it, not the drive state after guardian response.

---

## 5. Correlation IDs for Traceability (CANON §Contingency Requirement)

### Specification
E2 specifies "correlation IDs" in the event schema.

### CANON References
- **§Immutable Standard 2 (Contingency Requirement):** "Every positive reinforcement event must trace to a specific behavior. No non-contingent reinforcement. Pressure changes without a corresponding action are environmental events, not learning signals."

### Analysis

**COMPLIANT** — Correlation IDs enable contingency tracing:

```
Decision Making:
  - Generates PREDICTION_GENERATED (predictionId: UUID)
  - Executes ACTION_EXECUTED (actionId: UUID, correlatedPredictionId: predictionId)

Drive Engine:
  - Evaluates OUTCOME_REPORTED (actionId: actionId, outcome: SUCCESS/FAILURE)
  - Fires DRIVE_CHANGED (correlatedActionId: actionId)
```

This chain links positive reinforcement back to the behavior that triggered it. Without correlation IDs, the system cannot enforce Immutable Standard 2.

**Implementation detail (for E2 spec):**

Every event should carry optional correlation fields:

```typescript
interface SylphieEvent {
  eventId: UUID;
  // ... other fields

  // Correlation for tracing causality
  correlatedEventId?: UUID;     // Points to the triggering event
  correlatedPredictionId?: UUID;
  correlatedActionId?: UUID;
  correlatedOpportunityId?: UUID;
}
```

This enables queries like:
```sql
SELECT * FROM events
WHERE eventType = 'DRIVE_CHANGED'
  AND correlatedActionId = ?
ORDER BY time DESC;
```

This is the **backbone of contingency enforcement**.

---

## 6. Has_Learnable Flag (CANON §Subsystem 3 Learning)

### Specification
E2 includes "has_learnable flag" in the event schema.

### CANON References
- **§Subsystem 3 (Learning):** "Query TimescaleDB for response events with `has_learnable=true` (max 5 per cycle to prevent catastrophic interference)"

### Analysis

**COMPLIANT** — The `has_learnable` flag is the gating mechanism for Learning consolidation:

- ✓ Communication subsystem emits COMMUNICATION_RESPONSE events with `has_learnable=true` (content worth learning from)
- ✓ Decision Making emits PREDICTION_FAILURE events with `has_learnable=true` (failed predictions are growth catalysts)
- ✓ Learning queries: `WHERE has_learnable=true ORDER BY time DESC LIMIT 5`
- ✓ This prevents Learning from trying to consolidate thousands of events and hitting the catastrophic interference wall

**Implementation detail (for E2 spec):**

What events should have `has_learnable=true`?

**Recommended:**
- ✓ `COMMUNICATION_RESPONSE` — Guardian or Sylphie said something
- ✓ `PREDICTION_FAILURE` — Prediction proved wrong
- ✓ `GUARDIAN_CORRECTION` — Guardian corrected Sylphie
- ✓ `GUARDIAN_CONFIRMATION` — Guardian confirmed Sylphie's knowledge
- ✓ `OPPORTUNITY_CREATED` — Planning detected a growth pattern
- ✗ `DRIVE_CHANGED` — Not learnable (it's a consequence, not content)
- ✗ `ACTION_ATTEMPTED` — Only if the outcome is interesting (failed predictions are learnable, successes degrade with habituation)

The `has_learnable` flag is set by the **emitting subsystem**, not by Learning. Communication knows when something is worth learning (e.g., "the guardian said something novel"). Learning trusts that flag.

---

## 7. Schema Version (Evolutionary Tolerance)

### Specification
E2 includes "schema_version" in the event schema.

### CANON References
- **§Architecture:** No explicit mention, but this is a systems reliability practice.

### Analysis

**COMPLIANT** — Schema versioning prevents data corruption when event structures evolve:

```typescript
interface SylphieEvent {
  eventId: UUID;
  schemaVersion: number;  // 1 initially; incremented if event structure changes
  time: DateTime;
  eventType: EventType;
  // ... rest
}
```

This enables:
- Backward compatibility (old code can still read v1 events if v2 is now active)
- Migration strategies (when Learning queries old events, it knows what structure to expect)
- Audit trails (if an event caused problems, you can trace it to schema version X)

**Recommendation:** E2 should define schema versioning strategy:
- Start at `schemaVersion: 1`
- Document when schema changes require version bump (adding required fields, changing enum values)
- Define compatibility rules (v2 reader can read v1 events, but v1 reader cannot read v2)

---

## 8. Timestamp Accuracy and Ordering (Critical for Causal Analysis)

### Specification
E2 specifies "UTC timestamping" for all events.

### CANON References
- **§Shared Infrastructure / TimescaleDB:** "It is the system's episodic record — what happened, when, in what context"
- **§Development Metrics:** Prediction MAE, behavioral diversity index, and other metrics depend on accurate temporal ordering

### Analysis

**COMPLIANT** — UTC timestamps are essential for:

- ✓ Temporal range queries: "Give me all events in the last 10 minutes"
- ✓ Causal ordering: "Did prediction come before or after outcome?"
- ✓ Learning consolidation: "Which events should be consolidated in this cycle?"
- ✓ Metrics computation: "How many prediction failures in the last hour?"

**Implementation consideration for E2 spec:**

Should timestamps be:
- **Option A:** Generated by the emitting subsystem (each subsystem generates `DateTime.now()`)?
- **Option B:** Generated by the EventsService when `record()` is called?

**Recommendation:** Option B (EventsService generates timestamp).

**Why:** Prevents clock skew between subsystems. If Decision Making and Communication run on slightly different clocks, Option A could create temporal contradictions (outcome recorded before prediction, even though causal logic says otherwise). EventsService has the authority to define "now".

**Caveat:** The timestamp MUST be taken before any database write, not after. Otherwise, TimescaleDB's own write timestamps can drift from the event's logical timestamp.

---

## 9. Read Path: Subsystem-Specific Query Patterns

### Specification
E2 specifies "temporal range queries, event type filtering, subsystem-scoped queries, frequency aggregation".

### Analysis

**COMPLIANT** — Each subsystem has distinct read patterns:

**Decision Making:**
```sql
SELECT * FROM events
WHERE subsystem_source = 'DECISION_MAKING'
  AND (eventType = 'OUTCOME_REPORTED' OR eventType = 'DRIVE_CHANGED')
  AND time > now() - INTERVAL '5 minutes'
ORDER BY time DESC;
```

**Learning (Consolidation):**
```sql
SELECT * FROM events
WHERE has_learnable = true
  AND processed = false
ORDER BY time ASC
LIMIT 5;
```

**Drive Engine (Frequency analysis):**
```sql
SELECT eventType, COUNT(*) as frequency
FROM events
WHERE time > now() - INTERVAL '10 minutes'
GROUP BY eventType;
```

**Planning (Opportunity research):**
```sql
SELECT * FROM events
WHERE subsystem_source IN ('DECISION_MAKING', 'COMMUNICATION')
  AND eventType IN ('PREDICTION_FAILURE', 'ACTION_EXECUTED')
  AND context @> '{"context_key": "value"}'::jsonb
ORDER BY time DESC;
```

Each query pattern is distinct and decoupled. This is correct.

**Index strategy (for E2 implementation spec):**

```sql
CREATE INDEX idx_events_has_learnable_time
  ON events (has_learnable, time DESC)
  WHERE has_learnable = true;

CREATE INDEX idx_events_subsystem_type_time
  ON events (subsystem_source, eventType, time DESC);

CREATE INDEX idx_events_type_time
  ON events (eventType, time DESC);

CREATE INDEX idx_events_processed
  ON events (processed)
  WHERE processed = false;
```

These indexes support all five subsystems' query patterns without full-table scans.

---

## 10. Phase Boundaries

### Specification
E2 stays within Phase 1 scope.

### CANON References
- **§Implementation Phases / Phase 1:** "Build all five subsystems: Decision Making, Communication, Learning, Drive Engine, and Planning."
- **§Phase 2:** "Connect to physical robot chassis. Perception layer processes real sensor data."

### Analysis

**COMPLIANT** — E2 makes no references to:
- Hardware events
- Sensor data structures
- Motor control events
- Camera/LIDAR perception events

E2 is purely software event infrastructure. All five Phase 1 subsystems depend on it equally.

---

## Critical Gaps & Decisions for Jim

### Gap 1: Event Type Taxonomy Not Fully Specified

**What:** E0 roadmap states "30+ event types" but E2 does not enumerate them.

**Why it matters:** Different subsystems need to know what event types are available. Without a canonical list, subsystems might emit incompatible or redundant events.

**Recommendation:** E2 should define the event type discriminated union:

```typescript
type EventType =
  // Decision Making
  | 'PREDICTION_GENERATED'
  | 'PREDICTION_EVALUATED'
  | 'PREDICTION_FAILURE'
  | 'INPUT_RECEIVED'
  | 'INPUT_CATEGORIZED'
  | 'ACTION_EXECUTED'
  | 'OUTCOME_REPORTED'

  // Communication
  | 'COMMUNICATION_INPUT_RECEIVED'
  | 'COMMUNICATION_RESPONSE_GENERATED'
  | 'COMMUNICATION_RESPONSE_SPOKEN'

  // Drive Engine
  | 'DRIVE_TICK'
  | 'DRIVE_CHANGED'
  | 'OPPORTUNITY_CREATED'
  | 'RULE_EVALUATION'

  // Learning
  | 'CONSOLIDATION_STARTED'
  | 'ENTITY_EXTRACTED'
  | 'EDGE_REFINED'
  | 'CONTRADICTION_DETECTED'

  // Planning
  | 'OPPORTUNITY_RESEARCHED'
  | 'SIMULATION_RUN'
  | 'PLAN_PROPOSED'
  | 'PLAN_CREATED'

  // Cross-cutting
  | 'GUARDIAN_CORRECTION'
  | 'GUARDIAN_CONFIRMATION'
  | 'SYSTEM_HEALTH_CHECK';
```

**Decision required:** E2 should enumerate all 30+ event types and document which subsystems emit which events.

---

### Gap 2: Event Structure (Payload Schema) Not Specified

**What:** E2 mentions "typed events" but does not specify the payload structure for each event type.

**Why it matters:** When Communication emits COMMUNICATION_RESPONSE_SPOKEN, what data is in the event? Is it the full response text? A summary? Metadata only? Without clarity, each subsystem guesses.

**Recommendation:** E2 should define (example) event payloads:

```typescript
// Example: PREDICTION_GENERATED event
interface PredictionGeneratedEvent extends SylphieEvent {
  eventType: 'PREDICTION_GENERATED';
  predictionId: UUID;
  subsystemSource: 'DECISION_MAKING';
  payload: {
    actionCandidate: ActionCandidate;
    predictions: Array<{
      action: Action;
      predictedOutcome: unknown;  // What Sylphie predicts will happen
      confidence: number;
    }>;
  };
  driveSnapshot: DriveSnapshot;
}

// Example: GUARDIAN_CORRECTION event
interface GuardianCorrectionEvent extends SylphieEvent {
  eventType: 'GUARDIAN_CORRECTION';
  subsystemSource: 'COMMUNICATION';  // Communication subsystem received the correction
  correlatedEventId?: UUID;           // The communication that was corrected
  payload: {
    wrongStatement: string;
    correctStatement: string;
    domain?: string;  // What domain was wrong (e.g., "object_behavior")
  };
  hasLearnable: true;  // Always learnable
  provenance: 'GUARDIAN';
}
```

**Decision required:** E2 should define the payload schema for all 30+ event types.

---

### Gap 3: Event Retention and Compression Policy Not Specified

**What:** E1 specifies "compression/retention policies" but E2 should implement them.

**Why it matters:** TimescaleDB can store millions of events. Without a retention policy, disk grows unbounded. Without compression, queries slow down.

**Recommendation:** E2 should specify (aligned with CANON and E1 decisions):

```sql
-- Compress events older than 7 days
SELECT add_compression_policy(
  'events',
  compress_after => INTERVAL '7 days'
);

-- Drop events older than 90 days (max expected Learning consolidation lag)
SELECT add_retention_policy(
  'events',
  drop_after => INTERVAL '90 days'
);

-- Chunk size: 1 day (reasonable for daily learning cycles)
SELECT set_chunk_time_interval('events', INTERVAL '1 day');
```

**Decision required:** Should E2 implement the compression/retention policies, or are these E1 responsibilities?

---

### Gap 4: Guardian Feedback Event Weighting Not Specified

**What:** CANON §Immutable Standard 5 specifies 2x/3x weighting for guardian feedback. Events should carry this information.

**Why it matters:** Drive Engine needs to know: "Is this a guardian confirmation (2x) or a guardian correction (3x)?"

**Recommendation:** Guardian events should carry weight information:

```typescript
interface GuardianCorrectionEvent extends SylphieEvent {
  eventType: 'GUARDIAN_CORRECTION';
  payload: { ... };
  guardianFeedbackWeight: 3.0;  // Standard for corrections (3x)
}

interface GuardianConfirmationEvent extends SylphieEvent {
  eventType: 'GUARDIAN_CONFIRMATION';
  payload: { ... };
  guardianFeedbackWeight: 2.0;  // Standard for confirmations (2x)
}
```

**Decision required:** Should event payloads carry the guardian feedback weight, or is this computed by Drive Engine during evaluation?

---

### Gap 5: Subsystem Dependency on Event Processing Order

**What:** Does Learning process events FIFO (first-in-first-out), or can it reorder them?

**Why it matters:** If Learning reorders events, temporal causality might be violated. If it strictly processes FIFO, it might miss optimal learning signals.

**Recommendation:** E2 should specify:

```sql
-- Learning queries events in FIFO order
SELECT * FROM events
WHERE has_learnable = true
  AND processed = false
ORDER BY time ASC  -- Strictly ascending time
LIMIT 5;

-- After processing, mark as processed
UPDATE events
SET processed = true
WHERE eventId IN (...);
```

FIFO ordering preserves causal structure: if a prediction failed at T1 and the guardian corrected at T2, Learning sees them in that order.

**Decision required:** Should E2 enforce FIFO processing for learnable events?

---

## Architectural Fit: Event Structure Checklist

For implementation, E2 must ensure every event carries:

- ✓ `eventId: UUID` — Unique identifier
- ✓ `time: DateTime (UTC)` — Immutable timestamp
- ✓ `eventType: EventType` — Discriminant (one of 30+)
- ✓ `subsystemSource: SubsystemSource` — DECISION_MAKING | COMMUNICATION | LEARNING | DRIVE_ENGINE | PLANNING
- ✓ `provenance?: ProvenanceSource` — SENSOR | GUARDIAN | LLM_GENERATED | INFERENCE (if applicable)
- ✓ `driveSnapshot?: DriveSnapshot` — 12-drive state (for output events)
- ✓ `correlatedEventId?: UUID` — Link to triggering event (for contingency tracing)
- ✓ `correlatedPredictionId?: UUID` — Link to prediction (if applicable)
- ✓ `correlatedActionId?: UUID` — Link to action (if applicable)
- ✓ `correlatedOpportunityId?: UUID` — Link to opportunity (if applicable)
- ✓ `hasLearnable: boolean` — Is this learnable? (Learning uses this)
- ✓ `processed: boolean` — Has Learning processed this? (default false)
- ✓ `schemaVersion: number` — Event structure version
- ✓ `payload: object` — Event-type-specific data
- ? `guardianFeedbackWeight?: number` — 2.0 or 3.0 for guardian events (decision required)

---

## Recommendations for Implementation

### Before E2 Implementation Begins

1. **Obtain Jim approval** on five gaps listed above:
   - Event type taxonomy (30+ types)
   - Event payload structure per type
   - Retention/compression policies
   - Guardian feedback weighting in events
   - FIFO processing requirement for Learning

2. **Finalize TimescaleDB hypertable strategy** (carry forward from E1 decision):
   - Single hypertable with event_type + subsystem_source indexes, OR
   - Multiple hypertables per subsystem
   - **Recommended:** Single hypertable (simpler ops)

3. **Document event query patterns** for each subsystem:
   - Decision Making: "Get the last outcome for this action"
   - Communication: "Get all responses in the last hour"
   - Learning: "Get 5 learnable events I haven't processed"
   - Drive Engine: "Event frequency in last 10 minutes"
   - Planning: "All prediction failures for this context"

### During E2 Implementation

1. **Implement IEventService** with all five methods:
   - `record(event: SylphieEvent): Promise<void>` — Insert with timestamp
   - `query(filters: QueryFilters): Promise<SylphieEvent[]>` — Filtered read
   - `queryLearnableEvents(limit: 5): Promise<SylphieEvent[]>` — Learning consolidation
   - `queryEventFrequency(timewindow: TimeWindow): Promise<FrequencyMap>` — Drive Engine analysis
   - `markProcessed(eventIds: UUID[]): Promise<void>` — Update processed flag

2. **Validation on write:**
   - All required fields present
   - eventType is valid (one of 30+ types)
   - Timestamps are UTC
   - correlations point to existing events (if specified)

3. **Index strategy:**
   - `(event_type, time DESC)` — Support Drive Engine frequency queries
   - `(subsystem_source, time DESC)` — Support subsystem-scoped queries
   - `(has_learnable, processed, time ASC)` — Support Learning consolidation
   - `(correlation_event_id)` — Support contingency tracing

4. **Type safety:**
   - Discriminated union for EventType (TypeScript should enforce at compile time)
   - Interface per event type (PredictionGeneratedEvent, GuardianCorrectionEvent, etc.)
   - Event payload validation (zod or class-validator)

### After E2 Completion

1. **E3 (Knowledge Module)** consumes events to populate WKG
2. **E4 (Drive Engine)** consumes event frequencies for drive computation
3. **E5 (Decision Making)** emits predictions, actions, outcomes to events
4. **E6 (Communication)** emits input/output events
5. **E7 (Learning)** consumes learnable events for consolidation
6. **E8 (Planning)** queries event patterns to research opportunities

---

## Conclusion

**Epic 2 is architecturally sound and correctly positions events as the system's episodic memory.** The roadmap demonstrates understanding of how all five subsystems depend on this shared infrastructure.

**Compliance Summary:**
- ✓ TimescaleDB as shared event backbone: COMPLIANT
- ✓ Stream separation required: COMPLIANT (implementation strategy pending)
- ✓ Provenance on events: COMPLIANT
- ✓ Drive state snapshots: COMPLIANT
- ✓ Correlation IDs: COMPLIANT
- ✓ Has_learnable flag: COMPLIANT
- ✓ Schema version: COMPLIANT
- ✓ UTC timestamping: COMPLIANT
- ✓ Phase boundaries: COMPLIANT

**Outstanding decisions requiring Jim before E2 implementation:**

1. Event type taxonomy — enumerate all 30+ types
2. Event payload schemas — structure for each type
3. Retention/compression policies — 90-day retention, 7-day compression?
4. Guardian feedback weighting — in event payload or Drive Engine logic?
5. FIFO processing requirement — strict temporal ordering for Learning?

**Implementation readiness:** MEDIUM. The architecture is sound. Five clarifications will unlock HIGH readiness.

E2 is the **critical path bottleneck** for E3, E4, E5, E6, E7, E8. Its quality directly affects how cleanly those subsystems can integrate. Spending time to clarify these five gaps before E2 implementation begins will save major rework downstream.

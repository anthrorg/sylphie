# Epic 2: Events Module (TimescaleDB Backbone)

## Summary

Replace the IEventService stub (from E0) with a real TimescaleDB-backed implementation. The Events module is the stigmergic backbone — all five subsystems write events to and read events from TimescaleDB, coordinating indirectly through the shared event stream. After E2, every subsystem can record typed events, query historical context, process learnable events for consolidation, compute event frequencies for drive signals, and mark events as processed.

## Why This Epic Matters

TimescaleDB is not a logging database. It is the system's episodic memory and the coordination medium between subsystems. Decision Making writes predictions and outcomes. Communication writes interactions. Learning reads learnable events for consolidation. Drive Engine aggregates event frequencies for signal computation. Planning researches patterns for opportunity detection. Without a working event backbone, the five subsystems are isolated silos that cannot observe each other's behavior.

Per Ashby's analysis: the event stream is a stigmergic medium (like ant pheromone trails). Subsystems communicate not by calling each other, but by modifying the shared event store that other subsystems then perceive. This architectural pattern preserves the CANON's isolation requirements while enabling emergent coordination.

## Ticket Summary (9 tickets)

| ID | Title | Complexity | Dependencies |
|----|-------|-----------|-------------|
| E2-T001 | Event type system: discriminated union + boundary types | M | - |
| E2-T002 | EventsService skeleton + DI wiring + exceptions | M | T001 |
| E2-T003 | record() implementation with type validation | M | T002 |
| E2-T004 | query() implementation with dynamic filtering | M | T003 |
| E2-T005 | queryLearnableEvents() with FIFO + concurrent safety | L | T003 |
| E2-T006 | queryEventFrequency() for Drive Engine signals | M | T003 |
| E2-T007 | markProcessed() and markProcessedBatch() | S | T003 |
| E2-T008 | Event builder utilities per subsystem | S | T001 |
| E2-T009 | Integration test suite + performance benchmarks | L | T003-T008 |

## Parallelization

```
E2-T001 (Event type system)
  |
  +------------------+
  |                  |
  v                  v
E2-T002 (Skeleton)  E2-T008 (Builders)
  |
  v
E2-T003 (record())
  |
  +----------+----------+----------+
  |          |          |          |
  v          v          v          v
E2-T004   E2-T005   E2-T006   E2-T007
(query)   (learnable) (freq)  (markProc)
  |          |          |          |
  +----------+----------+----------+
              |
              v
          E2-T009 (Integration tests)
```

## Key Design Decisions

1. **Single hypertable with discriminant columns.** One `events` table with `event_type` and `subsystem_source` columns, not separate tables per subsystem. Simpler operations, cross-subsystem queries just work.

2. **Type-safe discriminated union.** 30 event types in a TypeScript discriminated union with compile-time subsystem boundary enforcement. Impossible to emit the wrong event type from the wrong subsystem.

3. **Dual provenance.** Events carry `subsystem_source` (architectural origin) and optional `provenance` (epistemological origin: SENSOR/GUARDIAN/LLM_GENERATED/INFERENCE). Enables the lesion test on the event stream.

4. **SELECT FOR UPDATE SKIP LOCKED.** queryLearnableEvents() uses pessimistic locking to prevent concurrent Learning cycles from double-processing events.

5. **Critical partial index.** `idx_has_learnable_processed` on (has_learnable, processed, timestamp) WHERE has_learnable=true AND processed=false. Makes queryLearnableEvents() O(1).

6. **Drive snapshot before action.** Snapshots attached to events are captured before execution, not after. Required for Theater Prohibition enforcement.

7. **record() returns eventId.** Unlike E0 stub's void return, the real implementation returns { eventId, timestamp } so callers can reference events in correlation chains.

8. **Batch markProcessed.** markProcessedBatch(eventIds[]) added for Learning efficiency — one UPDATE instead of N.

9. **Streaming deferred.** Forge proposed streamEvents() Observable for real-time subscriptions. Deferred to E4 when Drive Engine's real-time needs are concrete.

## Agent Analyses

See `agent-analyses/` for full perspectives from:
- **Sentinel**: IEventService method implementations, query patterns per subsystem, performance estimates, 8 risks, 8-ticket breakdown
- **Forge**: Interface refinement with full type signatures, discriminated union design, DI patterns, boundary enforcement, Observable analysis, 10-ticket breakdown
- **Canon**: 7/8 CANON checks compliant, 1 gap (event type taxonomy not specified), dual provenance recommendation, Theater Prohibition enforcement via drive_snapshot
- **Ashby**: Stigmergic sufficiency analysis, 3 feedback loops (fast/medium/slow), compression/retention interaction risk, attractor state implications, emergence observability

## Decisions Requiring Jim

1. **Event type taxonomy**: Review the 30 defined event types. Should TYPE_2_DELIBERATION_COST be a separate event type?
2. **Compression window**: 7-day compression acceptable, or extend to 14 days for Learning safety margin?
3. **Streaming Observable**: Defer to E4, or include in E2?

## Ashby's Feedback Loop Analysis (for E3-E4)

Three feedback loops flow through the event backbone:
1. **Fast loop (<500ms)**: Decision → Action → Outcome → Drive update → next Decision. Negative/stabilizing when outcomes are accurate.
2. **Medium loop (5-60s)**: Frequency aggregation → Opportunity detection → Planning. Positive/amplifying — limited by opportunity decay and rate limiting.
3. **Slow loop (5+ min)**: Learnable events → Learning consolidation → WKG growth → better Type 1 candidates. Positive/amplifying — limited by Confidence Ceiling.

Risk: if Learning consolidation falls behind, unconsolidated events accumulate. The consolidation debt alarm (emit warning when backlog > 50) is the circuit breaker.

## v1 Sources

| v1 File | v2 Destination | Lift Type |
|---------|---------------|-----------|
| `co-being/packages/tick-events/src/events/events.service.ts` | E2-T003 record()/query() | Conceptual (clean-room, different schema) |
| `co-being/packages/tick-events/src/events/events.controller.ts` | E9 (Dashboard API) | Deferred to E9 |
| v1 Signal interface | E2-T001 SylphieEvent type | Clean-room redesign |

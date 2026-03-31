# 2026-03-29 — E4-T012 Event Emission: Drive Events to TimescaleDB

## Changes

- NEW: `src/drive-engine/constants/events.ts` — Event batching constants (batch size 50, timeout 100ms, max queue 10k), sampling rates for DRIVE_TICK and HEALTH_STATUS
- NEW: `src/drive-engine/interfaces/drive-events.ts` — Type-safe event shapes (DriveTickEvent, OutcomeProcessedEvent, OpportunityCreatedEvent, ContingencyAppliedEvent, SelfEvaluationRunEvent, RuleAppliedEvent, HealthStatusEvent)
- NEW: `src/drive-engine/drive-process/event-emitter.ts` — EventEmitter class with fire-and-forget batching pipeline, queue management, and non-blocking flush
- NEW: `src/drive-engine/drive-process/timescale-writer.ts` — TimescaleDB writer with dedicated pg.Pool connection (isolated from NestJS), parameterized multi-value INSERT, retry logic (up to 3 attempts with exponential backoff)
- MODIFIED: `src/drive-engine/drive-process/drive-engine.ts` — Integrated event emission into tick loop: DRIVE_TICK sampled every 100 ticks, OUTCOME_PROCESSED on every action outcome, HEALTH_STATUS every 6000 ticks, event emitter initialization on session start

## Wiring Changes

- DriveEngine now holds EventEmitter and TimescaleWriter instances
- Tick loop emits DRIVE_TICK events (sampled) and HEALTH_STATUS events (periodic)
- applyOutcome() method now calls eventEmitter.emitOutcomeProcessed() after rule application
- Session start handler re-initializes event emitter with new session ID
- Stop handler flushes remaining events and closes TimescaleDB connection

## Known Issues

- Event emission to TimescaleDB still requires `initializeEventEmission()` to be called by DriveProcessManagerService with TimescaleDB config — this integration is NOT YET implemented in the service
- self-evaluation.ts has null-safety type warnings (not in scope of this ticket)
- Only OUTCOME_PROCESSED, DRIVE_TICK, and HEALTH_STATUS are implemented; CONTINGENCY_APPLIED, OPPORTUNITY_CREATED, SELF_EVALUATION_RUN, RULE_APPLIED events are typed but not yet emitted

## Gotchas for Next Session

- Event batching is fire-and-forget; if TimescaleDB is slow, events queue up and oldest ones are dropped at MAX_QUEUE_SIZE threshold
- DRIVE_TICK sampling (every 100 ticks) prevents event flooding but means sub-second granularity is lost
- TimescaleDB connection in child process is completely isolated — EventEmitter cannot access NestJS DI or shared pools
- event_data column in TimescaleDB events table must be JSONB and include sessionId for event queries to work correctly

# 2026-03-29 -- Executor Engine: State Machine & 8-State Loop (E5-T001)

## Changes
- MODIFIED: `src/decision-making/executor/executor-engine.service.ts` -- Implemented full state machine logic with 8-state transitions, timeout enforcement (500ms per state), cycle metrics collection, and error recovery. Replaced E0 stub with working implementation.

## Wiring Changes
- ExecutorEngineService now injects EVENTS_SERVICE for TimescaleDB event emission
- Captures DriveSnapshot via new `captureSnapshot()` method for event correlation
- Emits DECISION_CYCLE_STARTED events on state transitions
- Emits PREDICTION_MAE_SAMPLE events on cycle completion with per-state latency breakdown

## Known Issues
- Type checker requires `as any` casts on createDecisionMakingEvent calls due to TypeScript generic narrowing limitation (matches pattern used in episodic-memory.service.ts)
- captureSnapshot() method is not yet wired to DecisionMakingService (internal hookup deferred to integration epic)

## Gotchas for Next Session
- State timeouts fire automatically after 500ms and call forceIdle() — ensure timeout handle is cleared on normal transitions
- CycleMetrics.driveSnapshot is updated via captureSnapshot() after cycle start — integrate this call into DecisionMakingService.processInput()
- Map iteration for state latencies requires for...of loop; don't use Array methods that may not be available
- Event emission failures are logged but don't block state transitions (defensive design for robustness)

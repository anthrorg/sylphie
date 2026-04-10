# Idea: Decision Cycle Concurrency Guard

**Created:** 2026-04-10
**Status:** proposed

## Summary

Add an explicit single-threaded execution guard to `DecisionMakingService.processInput()` and the executor FSM so that concurrent calls are safely queued rather than corrupting shared state like `currentState`, `eventBuffer`, and `responseSubject`.

## Motivation

The decision-making executor engine maintains mutable shared state (`currentState` in ExecutorEngine, `eventBuffer` in DecisionEventLoggerService, `pendingLatentPatterns` and `recentGapTypes` in DecisionMakingService). Currently nothing prevents two simultaneous `processInput()` calls from interleaving their state transitions. If an HTTP request or upstream service fires two sensory frames in quick succession (faster than the ~200ms tick), the FSM could execute two states concurrently—corrupting the cycle, double-flushing the event buffer, or producing incoherent arbitration results. This is a latent bug that may only surface under load or when perception throughput increases.

## Subsystems Affected

- decision-making (ExecutorEngine, DecisionMakingService)
- decision-making/logging (DecisionEventLoggerService)
- decision-making/working-memory (WorkingMemoryService activation state)

## Open Questions

- Should concurrent frames be queued (FIFO) or should later arrivals pre-empt the current cycle?
- What queue depth is appropriate before back-pressure is applied upstream?
- Should the guard be a simple mutex/semaphore, or a bounded async queue (e.g., `p-limit` or a custom `CycleQueue`)?
- Does the supervisor need to be notified when cycles are being queued (indicating the system is falling behind)?

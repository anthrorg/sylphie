# Idea: Drive Tick-Loop Observability Instrumentation

**Created:** 2026-04-10
**Status:** proposed

## Summary

Add lightweight instrumentation to the drive-engine's 100Hz tick loop to track execution time, queue depths, and drift — making performance degradation visible before it silently impacts drive behavior.

## Motivation

The drive-engine tick loop (`drive-engine.ts`) is the heartbeat of the entire drive subsystem, running at 100Hz (10ms budget per tick). Today there is zero visibility into whether ticks stay within budget. If outcome processing, cross-modulation, or rule application cause a tick to exceed 10ms, the loop silently drifts to a lower frequency. This is dangerous because drive accumulation/decay rates are calibrated assuming 100Hz — a sustained drop to 50Hz would halve accumulation speed, making Sylphie appear motivationally sluggish with no diagnostic trail.

Concrete gaps discovered in the code:

- No `performance.now()` measurements around the tick body
- No histogram of tick durations (min / p50 / p99 / max)
- No metric for outcome queue depth at drain time (could detect backpressure)
- No alert or log when tick duration exceeds the 10ms budget
- The `suppressedValidationErrors` counter in `ws-channel.service.ts` is never reported anywhere
- TimescaleDB batch writes fail silently with no retry count or latency metric

## Subsystems Affected

- drive-engine (tick loop core)
- drive-process/opportunity-detector (queue depth)
- drive-process/timescale-writer (write latency/failure counts)
- ipc-channel/ws-channel.service (suppressed error counts)

## Open Questions

- Should metrics be emitted as IPC messages to the main process, or written directly to TimescaleDB from the child process?
- What sampling rate is acceptable? Measuring every tick adds overhead; sampling every 100th tick (1/sec) may be sufficient.
- Should a tick-budget-exceeded event trigger a structured log warning, or a full IPC alert to the supervisor?
- Is there value in exposing a `/drives/health` endpoint that reports tick stats for external monitoring?

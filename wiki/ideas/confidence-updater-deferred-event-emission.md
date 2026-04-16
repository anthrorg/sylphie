# Idea: Resolve Deferred Event Emission in ConfidenceUpdaterService

**Created:** 2026-04-13
**Status:** proposed

## Summary

`ConfidenceUpdaterService` never emits CONFIDENCE_UPDATED, TYPE_1_GRADUATION, or TYPE_1_DEMOTION events to TimescaleDB because it lacks a DriveSnapshot at call time. All three event emission methods are stub-deferred (logging `[event deferred]` debug messages only), creating a gap in the TimescaleDB event backbone that breaks auditability and downstream consumers.

## Motivation

The `emitConfidenceUpdated()`, `emitGraduationEvent()`, and `emitDemotionEvent()` methods in `confidence-updater.service.ts` all contain the comment: *"No DriveSnapshot available at this layer — skip event emission per design brief."* The result is that these events are **never written to TimescaleDB**:

1. **No audit trail for confidence changes.** CANON Standard 5 (Guardian Asymmetry) requires 2x/3x weighting on guardian feedback. The confidence updater applies these multipliers correctly, but there's no event record proving it happened. If a guardian correction was applied with 3x weight, that fact exists only in ephemeral debug logs.

2. **No historical record of Type 1 graduations/demotions.** The system logs these as `this.logger.log(...)` (stdout) but never writes them to TimescaleDB. Any downstream analysis of how quickly procedures graduate, which ones get demoted, or what triggers demotion would have no data source.

3. **Learning subsystem blind spot.** The Learning subsystem reads from TimescaleDB to detect patterns and trigger maintenance cycles. Without confidence change events, it cannot detect patterns like "this procedure's confidence is oscillating" or "guardian corrections are concentrating on one action category."

4. **Supervisor can't track confidence dynamics.** The SupervisorService evaluates cognitive cycles, but graduation/demotion events would be valuable signals for its verdict reasoning — especially detecting if Type 1 is graduating too quickly or demoting repeatedly.

The fix is straightforward: the `update()` method's caller (the executor in the decision cycle) already has the current DriveSnapshot. Either:
- Add an optional `driveSnapshot` parameter to `update()` and pass it through to event emission
- Introduce a deferred event queue that buffers events and flushes them when the executor calls a `flushEvents(driveSnapshot)` method after the confidence update completes
- Use a `DriveSnapshotProvider` injectable that the confidence updater can query at emission time (similar to how the Communication subsystem queries drive state)

The second approach (deferred queue + flush) preserves the current separation of concerns while ensuring events are eventually emitted with accurate drive context.

## Subsystems Affected

- **Decision Making** (`confidence/confidence-updater.service.ts`) — primary change site; event emission logic
- **Decision Making** (`executor/executor-engine.service.ts`) — likely call site that would pass DriveSnapshot or call flush
- **@sylphie/shared** (TimescaleDB event schema) — may need event type definitions for CONFIDENCE_UPDATED, TYPE_1_GRADUATION, TYPE_1_DEMOTION if not already present
- **Supervisor** (indirect beneficiary) — could subscribe to these events for richer verdict reasoning

## Open Questions

- Which approach (parameter threading, deferred queue, or snapshot provider) best fits the existing executor flow?
- Should the deferred events include the full ACT-R parameter state (base, count, decayRate) or just the confidence delta and outcome?
- Is there a risk of event storms during batch decay passes (where many actions are decayed in a single tick)?  If so, should decay-path events be aggregated into a single BATCH_CONFIDENCE_DECAY event?
- Should graduation/demotion events carry the MAE window snapshot that triggered the decision, for post-hoc auditability?

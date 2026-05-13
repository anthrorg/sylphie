# Idea: Track and Bound Supervisor Intervention Lifecycle

**Created:** 2026-04-27
**Status:** proposed

## Summary

The `pendingInterventions` array in `packages/supervisor/src/supervisor.service.ts` (declared line 110, only ever appended to at line 359) is a write-only structure: nothing reads, drains, or trims it, and nothing tracks whether each intervention was actually accepted by the sidecar. Replace it with a bounded, status-tracked ring of intervention records (pending → dispatched → accepted / rejected / failed), surface it in `getStatus()` alongside `recentVerdicts`, and use it as the canonical audit trail for guardian-issued and supervisor-issued interventions.

## Motivation

Three concrete problems live in the current shape of `pendingInterventions`:

1. **Unbounded growth.** Every call to `submitIntervention()` pushes onto the array; nothing ever shifts. Compare with `recentVerdicts`, which is explicitly capped at `VERDICT_BUFFER_SIZE = 100`. Over a long-running session the array grows until process restart — a slow leak in a service that is supposed to run 24/7.
2. **No dispatch outcome captured.** `executeIntervention()` returns `{accepted, error?}`, and the result is logged when `accepted === false`, then discarded. The intervention itself is never updated with what happened to it. If the sidecar was down or rejected the request, the intervention is silently lost — there is no record on the supervisor side that distinguishes "submitted but failed" from "submitted and applied."
3. **`getStatus()` blindspot for the guardian.** `getStatus()` is the source for the player-view dashboard. It exposes verdict history but exposes zero information about interventions Jim has issued and whether they took effect. From the dashboard perspective, the `correct`, `reinforce`, `freeze_model`, `rollback_checkpoint` controls are fire-and-forget.

A proper lifecycle record would: (a) make the leak go away, (b) give the guardian a real "did my correction stick?" view, and (c) give a future audit-trail/circuit-breaker effort (see `sidecar-control-circuit-breaker.md` and `supervisor-verdict-audit-trail.md`) a clean handle to operate on instead of an opaque queue.

This is distinct from the existing supervisor ideas: those cover retry behavior at the HTTP boundary, persisting **verdicts** to TimescaleDB, and reasoning-content exposure. None of them touch the intervention state machine or the unread `pendingInterventions` array.

## Subsystems Affected

- Supervisor (`packages/supervisor/src/supervisor.service.ts` — replace the array with a bounded buffer of records)
- Supervisor types (`packages/supervisor/src/interfaces/supervisor.types.ts` — add `InterventionRecord` with status enum, dispatch timestamp, sidecar response, error)
- Sidecar control (`packages/supervisor/src/sidecar-control.service.ts` — already returns the structured result; just needs to be threaded back into the record)
- Player-view / status surface (whatever consumes `getStatus()` — gains a new `recentInterventions` field)

## Open Questions

- What is the right buffer size? `VERDICT_BUFFER_SIZE` is 100 — should interventions match, or be smaller (they should be far rarer than verdicts)?
- Should completed interventions be expired by count only, or also by age (e.g., 24h)? Audit usefulness vs. memory.
- Should the lifecycle tracker double as a retry queue (i.e., status `failed` triggers re-dispatch with backoff), or is retry strictly the responsibility of a circuit breaker layer added later? Pick one to avoid two systems racing on the same record.
- Does the guardian want the dashboard to show only outcome-bearing interventions (accepted / rejected / failed), or pending ones too? The latter implies the dashboard can render a real-time "in flight" indicator.
- For `boost_salience`, which is currently a no-op acknowledged with `accepted: true`, do we record it as `accepted` or introduce a fourth status like `acknowledged_but_unimplemented` so the audit trail doesn't lie? (Cross-references `sidecar-boost-salience-implementation.md`.)

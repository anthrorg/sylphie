# Idea: Close Two Correctness Gaps in Supervisor Budget Enforcement

**Created:** 2026-04-27
**Status:** proposed

## Summary

The `CostTrackerService` is supposed to be the hard ceiling that lets the supervisor "self-disable for the rest of the day" once `SUPERVISOR_DAILY_BUDGET_USD` is spent, but two structural gaps in `packages/supervisor/src/cost-tracker.service.ts` and the way `SupervisorService.onCycleResponse` uses it allow the daily budget to be silently exceeded. Fix both: (a) make the budget check-and-debit atomic so concurrent in-flight evaluations cannot collectively overshoot, and (b) persist `costToday` (and `currentDay`) across process restarts so a restart cannot reset the counter mid-day.

## Motivation

Two distinct failure modes, neither covered by existing supervisor or cost-tracker ideas:

**1. Check-then-act race lets concurrent evaluations blow past the ceiling.**
`SupervisorService.onCycleResponse` (line 162) is invoked from `response$.subscribe` as a fire-and-forget async call — every cycle the gate passes spins up a new in-flight evaluation, and there is no concurrency limit. Inside, the budget gate (`this.costTracker.hasBudget()`, line 192) is checked at the *start*, but cost is only recorded *after* the DeepSeek round-trip completes (`recordCost`, line 263). With a sample rate of 1/10 and a DeepSeek-reasoner round-trip in the multi-second range, it is entirely possible for ~5–20 evaluations to be in flight when `costToday` is still under-budget at gate time. They all pass, all complete, and all record cost — putting the day's spend well past the configured ceiling. The boolean returned by `recordCost` is also discarded on line 263, so even a per-call signal is wasted. The hard guarantee implied by the file's docblock ("supervisor self-disables for the rest of the day") does not hold under realistic concurrency.

**2. `costToday` is in-memory only, so a restart launders the daily budget.**
`costToday`, `currentDay`, and `totalCost` live as plain class fields (lines 20–26). Any process restart — crash, deploy, supervisord recycle, Railway redeploy — resets `costToday` to 0 and lets the supervisor spend a fresh `dailyBudgetUsd` for what is still the same UTC day. For an autonomously-running cognition system the supervisor is supposed to be the cost circuit-breaker for, this is a real loophole: a flaky service that restarts twice per day effectively triples the daily ceiling. `supervisor-verdict-audit-trail.md` proposes persisting verdicts to TimescaleDB but explicitly does not address budget state — verdict history is for analysis, not enforcement.

Both are correctness bugs in the budget guarantee, not feature gaps. Atomic check-and-debit (e.g., a single `tryDebit(estimatedMaxCost)` method that reserves a worst-case cost up front and reconciles on completion, plus a serializing mutex or `p-limit(1)` in `SupervisorService` since evaluations are already low-frequency) closes the race. Persisting `{ currentDay, costToday }` to disk or TimescaleDB on every debit and rehydrating in the constructor closes the restart loophole. Together they make `SUPERVISOR_DAILY_BUDGET_USD` an actual ceiling instead of a soft target.

## Subsystems Affected

- Supervisor (`packages/supervisor/src/cost-tracker.service.ts` — replace `hasBudget()`/`recordCost()` with an atomic `tryDebit(estimatedMaxCost) -> { allowed, reservationId }` and `reconcile(reservationId, actualCost)`; add persistence)
- Supervisor (`packages/supervisor/src/supervisor.service.ts` — call `tryDebit` before issuing the LLM request; reconcile after; consider serializing evaluation calls via a lightweight queue instead of unbounded fire-and-forget)
- Persistence layer (TimescaleDB or a small SQLite/file checkpoint — wherever a single-row "today's budget state" can live without standing up new infra; probably the same hypertable proposed in `supervisor-verdict-audit-trail.md`)
- Sampling policy types (`supervisor.types.ts` — possibly extend `SamplingPolicy` with a `maxConcurrentEvaluations` field so the concurrency cap is configurable)

## Open Questions

- For the pre-flight reservation, what `estimatedMaxCost` to use? `maxTokens=300` × output rate gives a worst-case output cost, but input tokens vary with narration size — should the narration builder return an estimated token count, or should we cap at a generous fixed estimate?
- Where should persisted budget state live? Inline in TimescaleDB (one row per day), a small checkpoint file alongside other supervisor state, or piggyback on the verdict audit trail proposed in `supervisor-verdict-audit-trail.md`? Picking the same target keeps infra minimal.
- Should evaluations be strictly serialized (`p-limit(1)`) given they are already 1/N-sampled and async, or is a small concurrency cap (e.g., 3) preferable to ride out occasional latency spikes? Strict serialization makes the math trivially correct.
- How should reconciliation handle the case where actual cost exceeds the reservation? Cap at reservation (under-counting), bill the overage (and possibly trip the daily ceiling), or log and alert?
- On restart partway through a UTC day, should we re-check `currentDay` against persisted state and roll the day over if the persisted day is stale, rather than only inside `maybeResetDay()` on the next call?
- Does `burstMode` need to interact with the concurrency cap (e.g., temporarily raise it), or should it remain purely a sampling-rate override?

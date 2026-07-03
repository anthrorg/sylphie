# Feature: Replay-from-events — rebuild tensor training data from the event log

**Priority:** P2  ·  **Engineering level:** production
**Area / component:** cognition-service / learning / TimescaleDB

## Why (required)
The TimescaleDB event log is the ground truth of everything Sylphie did. If training data
can be regenerated from it, then **no tensor change is truly catastrophic** — a breaking
architecture change triggers a replay, not a reset. The weights become a cache; the events
are the source. This is the insurance policy that lets the code evolve aggressively
without ever losing the learning, and it makes protecting the event log more important
than protecting the weights.

## What it should do (required)
- A **replay tool** that reads the event history (situation → action → drive-outcome
  records) and regenerates labeled training samples for the executor tensor, honoring the
  current input contract / fusion-slot registry.
- **Retrain-from-experience path:** given a breaking tensor change, the tool rebuilds the
  training set from history and retrains the policy; the retrained model re-enters the
  bootstrap ladder at shadow stage and must re-earn graduation per category.
- **Deterministic and resumable:** replay over the same event range produces the same
  sample set (modulo documented stochastic augmentation); long replays checkpoint
  progress.
- Verification hooks: sample counts and category distributions reported at the end, so a
  replay can be compared against the manifest's `verified_training_samples` history.

## Scope hints
`packages/cognition-service/**` and `packages/learning/**` (owners: `meridian` /
`learning`; conceptual reviewers `ashby` / `piaget`); TimescaleDB read path in
`packages/shared` event types. Read-only over the event store.

## Dependencies (required)
Depends on **feature-tensor-contract** (samples must target a versioned input contract)
and **feature-snapshot-restore** (event log durability is the premise). Build after the
loops are generating real history worth replaying. Conflict risk: shares
cognition-service code with feature-tensor-contract — sequence them.

## Database impact (required)
**Touches a database / schema / migration?** yes (read-only)
Reads TimescaleDB event history at scale (range scans). No writes, no schema change.
Budget query load so replay doesn't perturb a live system (run offline or against a
restored snapshot).

## Acceptance — how we'll know it works (required)
1. Given an event-log range, when replay runs, then it emits a labeled training set whose
   sample count matches an independently queried count of qualifying events.
2. Given the same range replayed twice, then the outputs are identical (determinism).
3. End-to-end: given a deliberately "broken" tensor (fresh init), when retrain-from-replay
   runs on accumulated history, then the resulting model reaches at least audit-stage
   agreement on the most-populated action category — demonstrating learning is
   reconstructible from events alone.

## Non-goals / scope guard (required)
No changes to what events are captured (if the event schema is missing a needed field,
that's a finding to surface, not scope to absorb). No online/continuous replay — this is
an offline tool. No graduation-threshold changes.

## Source / references
`docs/future/sylphie-persistence-migration-plan.md` §4.3 (retrain-from-experience), §7
(build order item 5).

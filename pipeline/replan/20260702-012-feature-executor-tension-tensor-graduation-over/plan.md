# Plan — 20260702-012: Executor tension (stakes, veto, Guilt drive)

## Verification against the actual codebase

The source is well-informed but conflates **existing, already-built infrastructure**
with the **genuinely new** pieces. Verified claims, file:line cited:

1. **The "bootstrap ladder" (shadow → audit → partial → full) already exists.**
   - `packages/cognition-service/schemas.py:17-21` — `BootstrapMode` enum
     (`SHADOW/AUDIT/PARTIAL/FULL`), already per-**category** (not per-stakes-tier).
   - `packages/cognition-service/inference/bootstrap.py:55` — graduation threshold is
     **already 0.85** (`self._graduation_threshold: float = 0.85 # per-category
     threshold for partial`) — this is an *exact* match for source Acceptance #3
     ("agreement ≥85%"), already built and tested
     (`inference/tests/test_bootstrap_demotion.py`).
   - `packages/decision-making/src/tensor/tensor-candidate-builder.ts:26-46` —
     confidence is **already capped at 0.79 in partial mode**
     (`Math.min(0.79, maxProb)`) and 0.95 in full mode — an exact match for source
     Acceptance #3's "confidence capped at 0.79," already built and unit-tested
     (`tensor-candidate-builder.spec.ts`).
   - `packages/decision-making/src/decision-making.service.ts:848-886` — tensor
     divergence (`divergenceScore > 0.3 && !consensus`) already **soft-escalates**
     to Type 2 deliberation by capping candidate confidence.
   - **Conclusion: the graduation ladder is not new scope.** Tickets below extend it
     (add a stakes-tier gate) rather than build it.

2. **`stakes(action, driveState)` does not exist anywhere in the repo.** Confirmed via
   repo-wide search (`stakes(`, `stakesOf`) — zero matches outside the source doc
   itself. Genuinely new.

3. **The deterministic, tensor-blind "veto" as described does not exist.** There is no
   hardcoded action-*selection* floor that independently proposes "what I would have
   done" to diff against. `ACTION_TYPE_DEFAULTS` (`packages/drive-engine/src/
   constants/rules.ts:80-179`) is **not** an action-selection policy — it's a table of
   drive *effects* applied to an action's *outcome* (reactive, after the action is
   already chosen), consumed by `computeDefaultAffect()`. The closest thing to
   "the floor" today is the soft divergence-escalation in decision-making.service.ts
   (item 1 above), which defers to Type 2 deliberation — it does not reassert a
   specific alternative action, and it is not tensor-blind by construction (it reads
   `tensorResult.divergenceScore`, i.e. it's downstream of the tensor, not independent
   of it). **This is a real design gap, not just an implementation gap**: something
   with the shape "given (hardcoded rules, drive vector), what would the floor pick"
   has to be *specified* before it can be vetoed against, and no such specification
   or mechanism exists today. Source correctly flags this as a design-blocker
   requiring `architect` sign-off — verified as accurate, not overcaution.

4. **CANON Std-6 "checksum-verified at boot" infra does not exist yet either.** Grep
   for boot-checksum verification of write-protected logic turns up nothing in
   decision-making/drive-engine. The nearest analog is
   `infra/migrations/002-drive-rules-lockdown.ts` (TK-154, merged via PR #86) — DB-level
   REVOKE+RLS immutability for the `drive_rules` table, not a code-checksum boot
   check. Item **20260702-015** ("Feature: Schema versioning, migration framework, and
   boot/restore invariant checks" — source's cited "invariant #6") is still in
   `planning`, unbuilt. The veto's "checksum-verified at boot" requirement is an
   **undeclared additional dependency** the source didn't list explicitly as a
   pipeline item — flagged in open_questions.

5. **`DriveName.Guilt` already exists and is already partially wired** — NOT
   "currently-undriven" as the source states. `packages/drive-engine/src/constants/
   rules.ts:212-215` — `OUTCOME_DEFAULTS.guardian_correction` already sets
   `[DriveName.Guilt]: 0.15` on guardian correction. `packages/drive-engine/src/
   constants/drives.ts:60,90,185-195` — Guilt has zero base accrual/decay ("event-only")
   and a satisfaction-suppression coupling at guilt > 0.4 (CANON §A.15). There is also
   a **separate, unrelated "Guilt Repair" behavioral contingency**
   (`packages/drive-engine/src/drive-process/behavioral-contingencies/guilt-repair.ts`)
   that relieves Guilt via acknowledgment/behavioral-change detection — already built,
   already reviewed for a stale finding (contract.yaml ~line 1482-1484, PR #59). The
   genuinely new piece is a **second accrual source**: divergence × stakes at action
   time. Source's "currently-undriven" framing is factually wrong but the requested
   work (a new accrual path) is still real and additive to the existing Guilt wiring.

6. **Depressive Attractor detector already exists and is generic enough.**
   `packages/decision-making/src/monitoring/attractor-monitor.service.ts:456-517` —
   `detectDepressiveAttractor()` composites shrug-ratio + rolling MAE + "worst negative
   drive" (any drive whose pressure exceeds `DEPRESSIVE_DRIVE_THRESHOLD = 0.60`
   contributes). Since Guilt is a drive, sustained unresolved Guilt above 0.60 already
   participates in this composite with **no new monitor code needed** — source's claim
   here is accurate and should be taken as a hard non-goal (do not add a Guilt-specific
   detector).

7. **Guardian asymmetry (x2/x3) is an existing pattern**, referenced across
   `packages/drive-engine/src/{interfaces/drive-engine.interfaces.ts, drive-process/
   timescale-writer.ts, drive-process/opportunity-priority.ts, drive-process/
   drive-engine.ts, action-outcome-reporter.service.ts}`. The "rule strengthened on
   punished transgression / loosened on vindicated" mechanic must reuse this pattern,
   not invent a new weighting scheme.

## Contract overlap (existing_contract_overlap)

No existing epic/ticket in `planning/contract.yaml` covers stakes()/veto/Guilt-divergence
wiring — confirmed by grep for `executor|Guilt|stakes(|veto` (case-insensitive) against
the full contract; the only Guilt-adjacent hit is the closed, unrelated PR #59
guilt-repair triage note (contract.yaml ~line 1482). The pipeline's intake umbrella
(**FEAT-3** / **EP-21**, "Intake pipeline — rolling operational/maintenance work") is
the correct attachment point for a new epic, per house convention (contract.yaml
~line 5873-5882). No existing ticket needs to be reused; a **new** epic under EP-21/FEAT-3
is warranted given this is new application-direction scope, not decomposition of
already-approved intent — see routing note below.

## Dependency status (verified against `pipeline/pipeline.json`, not the source's say-so)

| Source's named dependency | Actual pipeline item | State |
|---|---|---|
| feature-snapshot-restore | 20260702-016 | **planning** (unbuilt) |
| feature-tensor-contract | 20260702-017 | **planning** (unbuilt) |
| drive_rules write-protection P0 | 20260625-002 → TK-154/TK-155 | **done** (PR #86 merged, per MEMORY + contract) |
| bug-audit-cognition-sidecar | 20260702-002 | **working** (in progress, not closed) |
| bug-audit-drive-engine (broader resilience item) | 20260702-004 | **working** (in progress, not closed — distinct from the already-closed drive_rules P0 sub-item above) |
| bug-audit-decision-making-core | *no exact match* — closest is 20260702-003 ("Decision-making concurrency & deliberation," state **working**) and the already-**done** TK-77 (cycle-guard concurrency verification, contract.yaml ~line 4974-5007) | mixed: TK-77 concurrency proof is done; 003's broader remaining concerns (LLM timeout, unconditional debate, provenance drop) are still open |

**Net: three of five named prerequisites are still open** (016, 017, 002-working), plus
the undeclared boot-checksum dependency (item 6 above, ~015 also still in planning).
This item cannot be sequenced into a build queue yet regardless of the design-fork
question below.

## Open questions (route to architect — do not guess)

1. **stakes(action, driveState) — exact contract.** Signature, output type (continuous
   score vs. discrete tier enum), the low/high stakes-tier boundary rule, and how it
   composes with the *existing* per-category agreement gate (item 1 above) — is
   stakes-tier a hard ceiling on which bootstrap mode a category may ever reach, or a
   separate multiplier on the existing 0.85/0.79 thresholds? Source mandates
   "airtight before build — architect must sign off" — treating this as a build-blocker
   is correct, not gold-plating.
2. **What is "the floor" the veto checks against, mechanically?** No hardcoded
   action-*selection* policy exists today (verified item 3 above). Architect must
   specify what a "the executor would have picked X" computation looks like given only
   `(hardcoded rules, drive vector)` before a veto predicate can be written or property-
   tested for tensor-blindness.
3. **Boot-checksum verification mechanism.** Source ties veto immutability to "CANON
   Std-6 ... checksum-verified at boot ... invariant #6," which lives in the still-
   unbuilt schema-versioning feature (20260702-015). Does this ticket build a minimal
   standalone checksum check, or hard-block on 015 landing first?
4. **Rule-strength write path for per-action-class tolerance.** Confirmed drive_rules
   is now REVOKE+RLS locked (TK-154) with a guardian-privileged pool (TK-155). Does the
   new "vindicated → rule loosened / punished → rule strengthened" mechanic write
   through that same guardian pool with no new grant, or does it need a new column
   requiring its own guardian-approved migration? (Feeds directly into migration.md.)

Given (a) the source's own text names two hard design-blockers requiring architect
sign-off, (b) verification confirms an additional undeclared design gap (open question 2)
that materially changes what "the veto" even means, and (c) three of five prerequisite
pipeline items are still unbuilt — **this item is not ready to stage into buildable,
atomic tickets today.** The ticket list below is staged for *after* the architect
ruling and is explicitly gated on it (see `depends_on: ["ARCHITECT-RULING"]` placeholder).

## Split recommendation

The source is single-themed (one coherent feature) and should **not** split into
separate pipeline items. It should, however, decompose into the tickets below, staged
in three waves: (A) the architect ruling itself, (B) the veto + stakes-tier gate on the
existing ladder, (C) the Guilt drive wiring. Waves B and C both depend on wave A; C
additionally depends on B (guilt weight is `stakes()`-gated, and resolution needs the
graduated/veto machinery to know what "vindicated" means).

## Proposed epic + tickets

### EP-NEW-1 (working id `20260702-012-EP`) — parent `EP-21` (FEAT-3 intake umbrella)
"Executor tension — stakes(), tensor-blind veto, and Guilt-drive divergence wiring"

---

**20260702-012-a** — Architect ruling: stakes() contract + veto mechanism + checksum scope
- engineering_level: exploration
- priority: P1
- depends_on: [] (blocked on nothing code-wise; blocks everything else in this epic)
- non_goals: does not write any product code; produces a decision record only.
- Given the four open questions above, when `architect` is convened with this plan.md
  and the cited file:line evidence, then a decision is recorded in
  `docs/decisions/architect-log.yaml` that: (1) defines `stakes(action, driveState)`'s
  signature and stakes-tier taxonomy, (2) specifies the mechanical definition of "the
  floor" the veto diffs against, (3) rules on the boot-checksum scope (build minimal
  vs. block on item 015), (4) rules on the rule-strength write path (question 4).
  **Runnable check:** `grep -A5 "stakes(action" docs/decisions/architect-log.yaml`
  (or the ruling's actual decision id) returns a non-empty, dated entry addressing all
  four points; reviewed manually against the four open questions as a checklist.
- Given the ruling is recorded, when contract.yaml is next updated for this epic, then
  tickets b-i below are re-derived from the ruling (they may change shape) before any
  of them are marked ready.
  **Runnable check:** N/A — this is a process step, verified by the plan/refine cog
  re-reading this ticket before queueing b-i.

**20260702-012-b** — Implement `stakes(action, driveState)` per the architect ruling
- engineering_level: production (per source: "airtight before build")
- priority: P1
- depends_on: ["20260702-012-a"]
- non_goals: does not touch arbitration, tensor, or Guilt wiring — pure function only.
- Given a fixed `(action, driveState)` input, when `stakes()` is called any number of
  times, then it returns a byte-identical result every time (pure, deterministic) and
  takes no tensor/network/DB input.
  **Runnable check:** a property test (`fast-check` or manual table-driven) asserting
  `stakes(a, d) === stakes(a, d)` across ≥50 generated `(action, driveState)` pairs, run
  via `yarn workspace @sylphie/decision-making test stakes.spec.ts`.
- Given the architect-defined low/high boundary examples (from the ruling doc), when
  `stakes()` is run on each example, then it returns the tier/score the ruling specifies.
  **Runnable check:** a fixture-driven spec asserting each ruling example against
  `stakes()`'s actual output, same test command as above.

**20260702-012-c** — Implement the deterministic, tensor-blind veto predicate
- engineering_level: production
- priority: P0 (safety-critical per source: "outranks both [LLM, tensor] on safety")
- depends_on: ["20260702-012-a", "20260702-012-b"]
- non_goals: does not change the existing per-category bootstrap ladder thresholds
  (0.85 agreement / 0.79 confidence cap) — those stay as-is.
- Given any tensor output as input, when the veto predicate is evaluated, then its
  result is provably a pure function of `(hardcoded rules, drive vector)` only — code
  inspection confirms no parameter or closed-over reference to a tensor type.
  **Runnable check:** a static-analysis test asserting the veto function's parameter
  types + no import from `tensor/**`, plus a property test feeding 50+ randomized
  tensor outputs at fixed `(rules, driveVector)` and asserting the veto result never
  changes, run via `yarn workspace @sylphie/decision-making test veto.spec.ts`.
- Given the boot-checksum scope the ruling selected (open question 3), when the app
  boots, then tampering with the veto module fails the boot checksum check (or, if the
  ruling deferred this to item 015, this criterion is replaced 1:1 with "boot fails
  loudly with a named TODO tracking item 20260702-015" — whichever the ruling picked).
  **Runnable check:** `yarn workspace @sylphie/decision-making test veto-checksum.spec.ts`
  (checksum path) or a grep-verifiable TODO comment citing 20260702-015 (deferred path).

**20260702-012-d** — Wire veto into the cycle: reassert + log `floor_vetoes`
- engineering_level: production
- priority: P0
- depends_on: ["20260702-012-c"]
- non_goals: no change to LLM tier or arbitration thresholds beyond this ladder
  (explicit source non-goal).
- Given a tensor choice the veto predicate rejects at high stakes, when the cycle
  reaches ARBITRATING, then the executor's own choice is what actually executes (not
  the tensor's) and a veto event is written to Timescale.
  **Runnable check:** an integration test in `decision-making.service.spec.ts` (or a new
  `veto-integration.spec.ts`) asserting `executedAction === floorChoice` and one
  `FLOOR_VETO` event row logged, run via `yarn workspace @sylphie/decision-making test`.
- Given N veto events across a test run, when the snapshot metrics block is read, then
  `floor_vetoes` equals N.
  **Runnable check:** same test file, asserting the metrics counter.

**20260702-012-e** — Layer stakes-tier gating onto the existing bootstrap ladder
- engineering_level: production
- priority: P2
- depends_on: ["20260702-012-b"]
- non_goals: does not rebuild shadow/audit/partial/full (already exists, item 1 above);
  does not change the 0.85/0.79 numeric thresholds themselves.
- Given a low-stakes action category with agreement ≥85% and no floor veto, when
  graduation is evaluated, then that category (and only it) enters partial mode with
  confidence capped at 0.79 — **this criterion is source Acceptance #3 and is already
  passing today per verification item 1; this ticket's job is to add the stakes-tier
  ceiling on top without regressing it.**
  **Runnable check:** existing `tensor-candidate-builder.spec.ts` + `bootstrap.py`'s
  `test_bootstrap_demotion.py` continue passing (`yarn workspace @sylphie/
  decision-making test` + `python -m pytest inference/tests/test_bootstrap_demotion.py`).
- Given a high-stakes category per the architect's stakes-tier ruling, when its
  agreement reaches ≥85%, then it is held at partial (or shadow/audit, per the ruling)
  and never reaches full mode.
  **Runnable check:** a new fixture test asserting a high-stakes category's
  `categories_graduated` never includes "full" regardless of agreement_rate, via
  `python -m pytest inference/tests/test_stakes_tier_ceiling.py`.

**20260702-012-f** — Guilt accrual at action time (divergence × stakes)
- engineering_level: production
- priority: P1
- depends_on: ["20260702-012-b", "20260702-012-d"]
- non_goals: no wiring to outcomes-in-the-world, other drives, or user disapproval
  (explicit source non-goal) — solely executor/tensor divergence.
- Given agreement (tensor choice == floor choice), when the action executes, then
  Guilt accrual for that action is exactly 0.
  **Runnable check:** `yarn workspace @sylphie/drive-engine test guilt-accrual.spec.ts`
  asserting `accrual === 0` on an agreement fixture.
- Given low-stakes divergence, when the action executes, then Guilt accrual is
  approximately 0 (bounded by an architect-set epsilon).
  **Runnable check:** same spec file, low-stakes divergence fixture.
- Given permitted high-stakes divergence (veto did not trigger), when the action
  executes, then Guilt accrual is strictly positive and equals
  `divergence_magnitude × stakes(action, driveState)` within floating-point tolerance.
  **Runnable check:** same spec file, asserting the exact product formula.
- Given the drive-isolation CANON (push-only, never pull/RPC into the drive process),
  when Guilt accrual is computed in decision-making, then it reaches drive-engine only
  via an emitted event (never a call the drive process must answer).
  **Runnable check:** code-inspection test asserting no drive-engine import/RPC client
  exists in the accrual call site; the event is asserted via the existing
  push-event test pattern used by `action-outcome-reporter.service.ts`.

**20260702-012-g** — Guilt resolution at outcome evaluation (punished/vindicated)
- engineering_level: production
- priority: P1
- depends_on: ["20260702-012-f"]
- non_goals: does not modify the existing, unrelated `guilt-repair.ts`
  acknowledgment/behavioral-change relief mechanism — this is a second, independent
  accrual/resolution path riding the MAE evaluation, not a replacement.
- Given a punished transgression (predicted-vs-actual drive-delta MAE confirms harm) at
  outcome evaluation, when resolution runs, then Guilt locks in (no discharge) and the
  action class's rule strength is adjusted per the architect-ruled guardian-asymmetry
  write path (open question 4) — never a direct `drive_rules` write.
  **Runnable check:** `yarn workspace @sylphie/drive-engine test guilt-resolution.spec.ts`
  asserting no direct write call to the drive_rules client and the correct
  strengthen-direction delta.
- Given a vindicated divergence (MAE confirms the tensor was right), when resolution
  runs, then Guilt mostly discharges (small decaying residual, not zero) and that
  action class's tolerance is slightly loosened.
  **Runnable check:** same spec file, vindicated fixture, asserting residual > 0 and
  discharge magnitude per the ruling's formula.

**20260702-012-h** — Snapshot metrics: guilt_events, guilt_resolved_vindicated/punished
- engineering_level: prototype
- priority: P2
- depends_on: ["20260702-012-d", "20260702-012-g"]
- non_goals: no new dashboard UI — counters only (observability dashboard is a
  separate pipeline item, 20260702-013).
- Given N accrual events, M vindicated resolutions, and K punished resolutions in a test
  run, when the snapshot metrics block is read, then `guilt_events === N`,
  `guilt_resolved_vindicated === M`, `guilt_resolved_punished === K`.
  **Runnable check:** an integration test asserting all three counters, run via
  `yarn workspace @sylphie/drive-engine test snapshot-metrics.spec.ts`.

**20260702-012-i** — Regression proof: unresolved Guilt trips the existing Depressive Attractor
- engineering_level: prototype
- priority: P2
- depends_on: ["20260702-012-f"]
- non_goals: **does not add a new detector** — verification item 6 confirms
  `detectDepressiveAttractor()` already composites any drive over threshold 0.60; this
  ticket only proves Guilt participates in practice.
- Given sustained unresolved Guilt forced above 0.60 in a test harness, when
  `AttractorMonitorService.detectDepressiveAttractor()` runs, then it reports
  `DEPRESSIVE_ATTRACTOR` detected, with no new detector code added.
  **Runnable check:** `yarn workspace @sylphie/decision-making test
  attractor-monitor.service.spec.ts` — new fixture forcing Guilt high, asserting the
  existing detector fires; diff review confirms no new `detect*` method was added.

## Non-goals (carried from source, all verified as sensible scope guards)
- No changes to the LLM tier or arbitration thresholds beyond the ladder described.
- No guilt wiring to outcomes-in-the-world, other drives, or user disapproval.
- No global graduation switch — per-stakes-tier only (layered onto the existing
  per-category ladder, per verification item 1 — not a parallel mechanism).
- The floor itself (existing behavior) is never modified by this work.
- Does not touch or refactor the existing, unrelated `guilt-repair.ts` contingency.
- Does not build the boot-checksum framework wholesale if the architect ruling defers
  that to item 20260702-015 (ticket c's second criterion is conditional on the ruling).

## CANON check
- **Drive isolation**: ticket f explicitly requires push-event-only wiring into
  drive-engine; ticket g explicitly requires no direct `drive_rules` write.
- **Confidence ceiling 0.60**: unaffected — the existing 0.79/0.95 caps are bootstrap-
  mode caps on a different axis (Type-1 procedure confidence), not the raw-inference
  0.60 ceiling; not touched by this plan.
- **Guardian asymmetry**: ticket g explicitly reuses the existing x2/x3 pattern rather
  than inventing new weighting.
- **Theater prohibition**: Guilt must be sparse/stakes-gated per source — ticket f's
  "≈0 on low-stakes divergence" criterion is the concrete anti-theater check (no
  guilt performance on trivia).
- **No self-modification of evaluation**: ticket g's rule-strength adjustment changes
  *behavioral rules* (drive_rules), not the *evaluation* logic (MAE computation,
  qualifiesForGraduation/qualifiesForDemotion) — consistent with the existing
  Type1TrackerService pattern (`packages/decision-making/src/graduation/
  type1-tracker.service.ts:28-30`, which explicitly separates evaluation logic from
  its application for the same CANON reason). Worth architect confirming explicitly
  in the ruling since this is the crux of "Guilt affecting rule strength without the
  system grading its own homework."

## Routing recommendation: **replan**

Not because the feature is a bad idea — it's coherent and the source clearly did real
homework — but because: (1) the source's own text designates stakes()/veto as
build-blockers needing architect sign-off, (2) verification surfaced a second,
undeclared design gap (what mechanically *is* "the floor" for action-selection — it
doesn't exist today in the shape assumed), and (3) three of five named prerequisite
pipeline items are still unbuilt. Send the four open_questions to `architect`; once
ruled, the ticket set above (already staged) should convert to `refine` largely as-is
(tickets a is then closed-out, b-i proceed) rather than being re-planned from scratch.

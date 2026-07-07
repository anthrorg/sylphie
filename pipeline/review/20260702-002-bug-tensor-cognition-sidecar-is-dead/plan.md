# Plan — 20260702-002 — Tensor cognition sidecar dead end-to-end (422 on every /cognition/cycle)

- **Type:** bug · **Severity:** blocker / P0 · **Route:** EP-21 (staged, parent FEAT-3), 4 tickets (TK-A/TK-B/TK-C/TK-D working ids) — resolved by DEC-30 / AD-0045-0047 and DEC-33 / AD-0049-0050 · **DB:** no (see migration.md — keyword false positive; confirmed no DB surface for TK-A/TK-B/TK-C/TK-D)
- **Owners (work-trio):** TK-A (contract fix, `apps/sylphie`) → `forge` (conceptual: `ashby`); TK-B + TK-C + TK-D (sidecar EWC/convergence/demotion, `packages/cognition-service`) → `meridian` (conceptual: `ashby`); code review (all four): `code-reviewer`

## Classification (plan cog)
Ingest type `bug` and title are correct — no `set` needed. Audit-derived report
(`docs/audits/repo-bug-audit-2026-07-02.md` §7) with exact file:line evidence.

## Discovery (verified against source, 2026-07-02, commit-current tree)
codebase-pkg MCP unavailable this run — verification done by direct full-file reads
(Haiku reader fan-out). **All 7 evidence claims CONFIRMED:**
1. `tensor-inference-adapter.service.ts:188-197` — `getDriveHistoryFlattened()` returns `padded.flat()` (120 floats). CONFIRMED.
2. `cognition-gateway.service.ts:198` — forwards `drive_history` whenever present; adapter always supplies it → effectively unconditional. CONFIRMED.
3. `packages/cognition-service/schemas.py:48` — `drive_history: list[list[float]] | None` → flat list 422s. CONFIRMED.
4. `main.py:530-627` — `/cognition/phase-transition` is the sole `set_reference`/`compute_fisher` caller; `set_reference` (583) runs before `compute_fisher` (595); an in-code NOTE at :584 even admits the ordering. No runtime caller anywhere (grep). CONFIRMED.
5. `training/replay.py:392-393` — `penalty_gradients()` returns zeros with no reference/fisher; blend logic 183-211. CONFIRMED.
6. `models/convergence.py:155-160,206-214` — single lucky proxy-accuracy call ≥0.80 after 1000 samples flips `use_learned=True`, persisted in checkpoint; `trainer.py` never trains convergence weights (grep: zero hits). CONFIRMED.
7. `inference/bootstrap.py:130` — `check_demotions()` called only from `tests/test_bootstrap_demotion.py`; main train path calls only `check_graduations()` (:408) + `advance_mode()` (:421). CONFIRMED.

## Approach (simplest thing that meets the ACs)
Ship as one ticket with an ordered fix list — fix 1 is the unblocker; 2–5 are small,
already-located point fixes that are only observable once cycles flow:
1. **Contract fix:** drop `.flat()` in `getDriveHistoryFlattened()` → emit `number[][]`
   (10×12). Add a contract test that builds the adapter payload and validates it
   against `schemas.py` (pydantic `model_validate` in a small test harness).
2. **EWC wiring:** fold consolidation into the mode-transition path (`advance_mode`)
   rather than inventing a new runtime caller — smallest honest wiring; keep the HTTP
   endpoint as a manual override. Design note for conceptual review: confirm
   `advance_mode` is the right consolidation boundary.
3. **EWC ordering:** `compute_fisher` before `set_reference` at the boundary; delete
   the false "Online EWC design" comment.
4. **Convergence gate:** `use_learned` requires a real training-pair count +
   validation threshold, not the single-call proxy.
5. **Demotion:** call `check_demotions()` in the train path next to `check_graduations()`.
Non-goals honored: no gradient paths for deliberation panels; ignore the 50 ms
first-cycle AbortSignal nuance (track separately if breaker still trips after fix 1).

## Governance resolution (DEC-30 / AD-0045, AD-0046, AD-0047)
The design forks noted above are RESOLVED. Split into three tickets under epic
**EP-21** (parent `FEAT-3`) instead of the single combined ticket originally
sketched — the contract fix (owner `forge`, apps/sylphie surface) and the
sidecar EWC/convergence/demotion fixes (owner `meridian`, cognition-service
surface) are different files, different owners, and different work-trios;
splitting also lets the P0 unblocker (TK-A) ship and verify independently of
the sidecar-internal fixes (TK-B/TK-C). At contract-write time these become
numeric `TK-<n>` ids under EP-21 — TK-A/TK-B/TK-C/TK-D below are working labels
only.

## Governance resolution — DEC-33 (AD-0049, AD-0050) supersedes the original TK-C lock AC

The refine-cog red-team flagged the original TK-C acceptance criterion "both
EWC calls execute while holding `trainer._weight_lock`" as a **deadlock risk**:
`trainer.get_weights()` (`training/trainer.py:581-594`) already acquires
`trainer._weight_lock` internally for its own brief copy-under-lock
(`:593-594`); had the extracted helper *also* wrapped `get_weights()` +
`compute_fisher()` + `set_reference()` in an outer `with trainer._weight_lock`,
a non-reentrant `threading.Lock` would deadlock on the very first call. The
red-team also flagged AC4's "`penalty_gradients` non-zero at the boundary" as
**false at t=0** — immediately after `set_reference()`, current weights equal
the just-anchored reference (`w == ref`), so `penalty_gradients()`
(`training/replay.py:392-393,404-406`) correctly returns zero; asserting
non-zero there would either fail honestly or force a fake perturbation into
the test. `architect` ruled (DEC-33):

- **AD-0049 (lock discipline):** `_consolidate_phase_boundary` acquires **no
  lock of its own**. The only `_weight_lock` acquisition in the whole call
  path is `get_weights()`'s existing internal one. `compute_fisher()` and
  `set_reference()` run lock-free. No new EWC-state lock is introduced. The
  old "hold `_weight_lock` across both EWC calls" AC is deleted and replaced
  with a deadlock-regression test + a lock-scope test (see TK-C ACs below).
- **AD-0050 (`use_learned` hard-disable, both writers):** `ConvergenceModel`
  has **two** places that can set `use_learned = True` — the graduation
  branch in `check()` (`models/convergence.py:160`) and the checkpoint
  restore in `load()` (`models/convergence.py:235`, which applies a persisted
  flag verbatim). Both must be pinned to `False`; `load()` stays read-only
  (no checkpoint migration/rewrite) — the flag self-heals to `False` the next
  time `save()` runs. This work is split out to its own ticket, **TK-D** (see
  below), to keep the trivial safety-critical pin-off from being blocked by
  TK-C's larger, lock-risky extraction/testing work.
- AC4 (the old "non-zero gradient at boundary" claim) is replaced with an
  "EWC ARMED" assertion (`ewc._reference` and `ewc._fisher` both set), with
  any non-zero-gradient check moved behind an explicit perturb-then-call-twice
  precondition.

This section supersedes the original TK-C ACs for lock discipline, the
`use_learned` scope, and AC4 below; TK-A and TK-B are otherwise governed by
the original DEC-30/AD-0045-0047 resolution above, with TK-B's AC1/AC4
wording corrected per the same red-team pass (see TK-B below).

Light verification of the Python loci (2026-07-02, commit-current tree,
`main.py`/`bootstrap.py` read directly): `main.py:408` `check_graduations()`,
`main.py:416-421` periodic `advance_mode()` call (the boundary TK-C's helper
must be invoked from), `main.py:569-608`
(`phase_transition` handler — `get_weights` → `set_reference` at :583 →
`snapshot_calibration` at :585-587 → `compute_fisher` at :596, with the
misleading "Online EWC design" comment at :584 and the TK-37/TK-39
after-the-fact justification at :589-595) all CONFIRMED as described.
`bootstrap.py:130-160` `check_demotions()` CONFIRMED, with the `>= 20` sample
guard at line 145 (not called anywhere outside its test — CONFIRMED, only
`check_graduations()`/`advance_mode()` are wired into the train path).
`replay.py:156` `set_reference`, `:222` `compute_fisher`, `:367`
`penalty_gradients` CONFIRMED to exist and match the described blend/ordering
logic (`:183-211` blend, first-call uniform-Fisher fallback logged at
`:191-195`). `trainer.py:484` `self._weight_lock = threading.Lock()` CONFIRMED.
`convergence.py:148-168` single-call proxy-accuracy graduation CONFIRMED
(`use_learned = True` at line 160, guarded only by `not self.use_learned` and
sample-count + proxy-accuracy thresholds — no real training signal).

**Additional re-verification for DEC-33 (2026-07-02, direct reads, commit-current
tree):** `trainer.py:581-594` `get_weights()` CONFIRMED to already acquire
`self._weight_lock` internally and briefly (`:593: with self._weight_lock:`)
for its copy-under-lock, then release — this is the ONLY lock the new helper
needs; it must not add another. `convergence.py:216-250` `load()` CONFIRMED to
have a second `use_learned` writer at line 235
(`self.use_learned = bool(data["use_learned"][0])`, applying the persisted
checkpoint flag verbatim with no guard) — the two writers AD-0050 pins are
`:160` (`check()`'s graduation branch) and `:235` (`load()`). `replay.py:392-406`
`penalty_gradients()` CONFIRMED to return `scaled_lambda * fisher * (w - ref)`,
which is exactly `0` whenever `w == ref` — i.e. immediately after
`set_reference()` at a phase boundary — confirming the old AC4 non-zero
assertion would be false at t=0. `main.py:393-408` CONFIRMED as the single
guarded block containing both `check_graduations()` (`:408`) and the
comparison-recording precondition (`:393-399`); `main.py:416-421` CONFIRMED as
the separate periodic `advance_mode()` block, unaffected by TK-B/TK-C.
`bootstrap.py:144-147` CONFIRMED as the `len(history) < 20: continue` guard
shared by graduation and (per TK-B) demotion.

## Proposed contract structure / staged tickets (contract_write=staged — NOT written to contract.yaml)

Epic: **EP-21** "Tensor cognition sidecar: contract fix + lock-free EWC consolidation + convergence/demotion wiring" — parent `FEAT-3`.

```yaml
- id: TK-A
  kind: ticket
  parent: EP-21
  title: "Contract fix: emit nested drive_history (number[][]) from tensor-inference-adapter; TS<->pydantic contract test"
  priority: P0
  engineering_level: production
  complexity_budget: S
  owner: forge
  conceptual_reviewer: ashby
  code_reviewer: code-reviewer
  files_in_scope:
    - apps/sylphie/src/services/tensor-inference-adapter.service.ts   # :189-198, drop .flat()
    - apps/sylphie/src/services/cognition-gateway.service.ts          # :166-167 type, :198 spread (unchanged), :209 AbortSignal (measure only)
    - packages/cognition-service/schemas.py                          # :48 read-only reference, NOT modified
  non_goals:
    - "relaxing/loosening schemas.py:48 (drive_history stays list[list[float]])"
    - "changing the 50ms AbortSignal timeout at cognition-gateway.service.ts:209 without first measuring — see AC3"
  acceptance_criteria:
    - given: "getDriveHistory() in tensor-inference-adapter.service.ts (currently getDriveHistoryFlattened(), :189-198)"
      when: "the adapter builds the drive_history payload for a cycle request"
      then: "it emits nested number[][] (10 timesteps x 12 drives), not a flattened 120-float array; the .flat() call is removed"
    - given: "CognitionGatewayService's cycle-request type at :166-167 (currently readonly number[])"
      when: "the payload type is checked against the nested drive_history the adapter now emits"
      then: "the field type is the nested readonly shape (readonly (readonly number[])[] or equivalent) and compiles cleanly; the :198 spread of the array into the request body is unchanged"
    - given: "a TS-built fixture payload from the adapter (well-formed 10x12 drive_history frame), exported as a golden fixture JSON file (e.g. fixtures/cycle-request.golden.json) generated by a small TS script/test that calls the adapter and dumps its output"
      when: "a pytest test harness loads that golden fixture and calls schemas.py's `CognitionCycleRequest.model_validate(...)` (schemas.py:28-51, drive_history at :48) against it, and separately against a hand-built flat-120 regression fixture (the old `.flat()` shape)"
      then: "the nested 10x12 fixture validates with no ValidationError; the flat-120 regression fixture raises pydantic.ValidationError (proving the schema would still catch a regression back to the old flattened shape)"
    - given: "sidecar + backend running live, a conversational turn triggering a decision cycle"
      when: "POST /cognition/cycle fires for the first cycle after startup"
      then: "first-cycle latency is measured and logged against the 50ms AbortSignal at cognition-gateway.service.ts:209; if it exceeds 50ms, a follow-up item is filed via the intake pipeline (a markdown file dropped in pipeline/inbox/ per pipeline/pipeline.rules.md, not merely a log line) documenting the measured latency and proposing the AbortSignal timeout change — this ticket does not itself change the 50ms value"

- id: TK-B
  kind: ticket
  parent: EP-21
  title: "EWC ordering fix (compute_fisher before set_reference) + wire check_demotions() beside check_graduations()"
  priority: P0
  engineering_level: production
  complexity_budget: S
  owner: meridian
  conceptual_reviewer: ashby
  code_reviewer: code-reviewer
  files_in_scope:
    - packages/cognition-service/main.py                # :584 misleading comment, :589-595 rewrite, :408/:421 demotion wiring point
    - packages/cognition-service/training/replay.py      # :156 set_reference, :222 compute_fisher, :186-189 compute-first support
    - packages/cognition-service/inference/bootstrap.py  # :130-160 check_demotions, :144-147 >=20-sample precondition
  non_goals:
    - "changing the Online EWC blend math itself (gamma decay, ramp steps) — ordering only"
  acceptance_criteria:
    - given: "the INLINE consolidation logic in the /cognition/phase-transition handler (main.py:531-627), where trainer.ewc.set_reference(weights) currently fires at line 583 BEFORE trainer.ewc.compute_fisher(trainer, calibration) at line 596, with the misleading 'Online EWC design' inline comment at line 584 and the TK-37/TK-39 after-the-fact justification comment block at lines 589-595 — TK-C's module-level extraction does not exist yet at this point in the sequence (TK-B lands first), so this fix is made directly in the still-inline handler"
      when: "the ordering is fixed in place inside the existing phase_transition() handler (no extraction — that is TK-C's job)"
      then: "compute_fisher() is invoked BEFORE set_reference() (call order swapped at main.py:583/596); the misleading ':584' comment is deleted; the ':589-595' TK-37/TK-39 comment block is rewritten in place to accurately describe the corrected compute_fisher-then-set_reference sequence — this corrected comment text is what TK-C's later extraction carries over verbatim into the new helper, avoiding a throwaway edit / same-line merge race"
    - given: "replay.py's set_reference() (:156-220) and compute_fisher() (:222+), which already tolerate either call order (compute_fisher operates only on the model + calibration samples; set_reference seeds/rolls the Fisher estimate independent of prior call order per its own docstring at :160-171)"
      when: "main.py's handler is updated to call compute_fisher before set_reference"
      then: "no logic changes are required inside replay.py's set_reference/compute_fisher bodies for this ticket — replay.py is listed in files_in_scope for read/verification of the ordering contract, not modification; this ticket is an ordering swap at the main.py call site only"
    - given: "a graduated category whose rolling agreement has dropped below the 0.70 demotion_threshold and has >= 20 recorded comparisons (bootstrap.py:144-147 guard, the same guard used for graduation)"
      when: "check_demotions() is called from the train path alongside check_graduations()"
      then: "the category is removed from _graduated_categories and logged as demoted (unit test on bootstrap.py); a category with < 20 samples is NOT demoted regardless of agreement (precondition unit test)"
    - given: "check_demotions(), wired into the SAME guarded block that already calls check_graduations() (main.py:393-408 — the block gated on tracker/sample/last_cycle_result preconditions at :393-399)"
      when: "check_graduations() executes (i.e., the guarded block's preconditions are met and it runs)"
      then: "check_demotions() executes immediately alongside it, in that same guarded block, on that same call — NOT on every /cognition/training-sample call unconditionally, only when the existing guard already lets check_graduations() run; no behavior change to check_graduations()'s own logic, to advance_mode(), or to the separate periodic advance_mode() block at main.py:416-421 (untouched by this ticket)"

- id: TK-C
  kind: ticket
  parent: EP-21
  title: "Extract phase-boundary consolidation into a lock-free module-level helper; wire it at mode-advance; truth-edit ROADMAP.md:83"
  priority: P0
  engineering_level: production
  complexity_budget: M
  owner: meridian
  conceptual_reviewer: ashby
  code_reviewer: code-reviewer
  files_in_scope:
    - packages/cognition-service/main.py           # :531-627 extract to _consolidate_phase_boundary (ordering already corrected by TK-B); :416-421 advance_mode() call site; /cognition/phase-transition endpoint kept as manual override
    - packages/cognition-service/training/replay.py # penalty_gradients() zero-path (:392-406), compute_fisher ValueError-on-empty-buffer guard, set_reference()/compute_fisher() read for lock-free confirmation
    - packages/cognition-service/training/trainer.py # :581-594 get_weights() (already lock-scoped internally — read-only reference, NOT modified); :484 _weight_lock (confirm no new acquisition is added around it)
    - packages/cognition-service/inference/bootstrap.py # BootstrapTracker — do NOT inject trainer into it
    - ROADMAP.md                                    # :83 truth-edit (phase-transition "live" claim)
  non_goals:
    - "injecting trainer into BootstrapTracker (helper lives at module level in main.py instead)"
    - "acquiring trainer._weight_lock (or any new lock) anywhere in the helper — see AD-0049 below; the only lock acquisition in the call path is get_weights()'s existing internal one"
    - "the use_learned hard-disable and checkpoint-load fix — split to TK-D (AD-0050); this ticket does not touch models/convergence.py"
    - "adding a real trained convergence head (separate, larger ticket)"
    - "moving the helper's numpy work onto asyncio.to_thread in this ticket (AC4 below only requires measuring and, if warranted, filing a follow-up)"
  acceptance_criteria:
    - given: "the inline consolidation logic in the phase-transition handler (main.py:531-627, ordering already corrected by TK-B), plus trainer.get_weights() (trainer.py:581-594, which already acquires trainer._weight_lock internally for its own brief copy-under-lock at :593) and trainer._weight_lock itself (trainer.py:484)"
      when: "the logic is extracted into a module-level function _consolidate_phase_boundary(trainer, buffer)"
      then: "the extracted function performs: trainer.get_weights() -> buffer.snapshot_calibration(1000, stratified=True) -> trainer.ewc.compute_fisher(trainer, calibration) [guarded: ValueError on an empty buffer caught and logged as a warning, not raised] -> trainer.ewc.set_reference(weights) UNCONDITIONALLY (even when calibration is empty, so the anchor still moves); PER AD-0049, the helper itself acquires trainer._weight_lock ZERO times — no `with trainer._weight_lock:` block appears anywhere in _consolidate_phase_boundary; the only _weight_lock acquisition in the entire call path remains get_weights()'s existing internal one; BootstrapTracker is NOT modified to hold a trainer reference"
    - given: "_consolidate_phase_boundary(trainer, buffer) called against a real (non-mock) CognitiveTrainer instance with a non-empty replay buffer, with the trainer's background training loop concurrently running"
      when: "the helper is invoked from a worker thread (threading.Thread) while that background thread is live"
      then: "a deadlock-regression test asserts thread.join(timeout=<a few seconds, e.g. 5>) returns True (the helper thread completed) before the timeout — the test fails as a loud assertion, not a hang, if the join times out; this is the direct regression test for the deadlock risk the old 'hold _weight_lock across both EWC calls' AC would have introduced"
    - given: "the helper's execution, instrumented for assertion"
      when: "compute_fisher() and set_reference() are entered during a call to _consolidate_phase_boundary"
      then: "a lock-scope test asserts trainer._weight_lock.locked() is False at the moment of entry to both compute_fisher() and set_reference(); get_weights() is asserted to have been called exactly once and to have returned before compute_fisher() is invoked; no new lock object (EWC-state lock or otherwise) is introduced anywhere in ewc.py/replay.py/main.py for this call path"
    - given: "_consolidate_phase_boundary running against production-scale weights and a 1000-sample stratified calibration draw"
      when: "the helper completes"
      then: "its wall-clock duration is measured (time.monotonic() around the body) and logged at INFO with the measured milliseconds; if a live/integration run measures duration > 250ms, a follow-up item is filed via the intake pipeline (a markdown file in pipeline/inbox/ per pipeline/pipeline.rules.md) proposing to move the helper's synchronous numpy work off the event loop via asyncio.to_thread — this ticket does not itself add asyncio.to_thread"
    - given: "tracker.advance_mode() returns True at main.py:421 (a periodic mode-advance check succeeds)"
      when: "the mode actually advances (shadow->audit->partial->full)"
      then: "_consolidate_phase_boundary(trainer, buffer) is called exactly once for that boundary, immediately after advance_mode() returns True"
    - given: "POST /cognition/phase-transition (the manual override endpoint)"
      when: "a guardian/supervisor forces a phase transition directly"
      then: "the endpoint calls the same _consolidate_phase_boundary(trainer, buffer) helper (no duplicated inline logic remains in the handler)"
    - given: "a phase boundary with a non-empty replay buffer, exercised via an integration test that drives tracker.advance_mode() across all four phases (shadow->audit->partial->full)"
      when: "each boundary is crossed, including shadow->audit and the final ->full transition"
      then: "_consolidate_phase_boundary is invoked exactly once per boundary, and after the boundary EWC is ARMED — trainer.ewc._reference is not None AND trainer.ewc._fisher is not None (both anchor and Fisher estimate are set); no assertion is made here that penalty_gradients() returns non-zero, because immediately after set_reference() current weights equal the reference (w == ref), so a zero gradient at this exact point is CORRECT behavior, not a defect (see the next AC for the non-zero case)"
    - given: "EWC armed per the prior AC, with model weights then perturbed away from the anchor (e.g. one training step, or an explicit test-only weight nudge) so current_weights != reference"
      when: "penalty_gradients() is called at least twice in this perturbed state (the first call advances/consumes the initial ramp factor per replay.py:397-399)"
      then: "the second (or later) call returns a gradient array with at least one non-zero element, confirming the EWC penalty exerts real pressure once weights have diverged from the anchor"
    - given: "ROADMAP.md:83's current phase-transition '✅ live' claim"
      when: "the true wiring state (manual-override endpoint + now-automatic mode-advance call, per this ticket) is known"
      then: "the line is edited to accurately reflect reality per Std-4 (no theater-by-documentation) — no unverified '✅ live' claim remains for functionality this ticket did not itself make live"

- id: TK-D
  kind: ticket
  parent: EP-21
  title: "Hard-disable ConvergenceModel.use_learned at both writers (check() graduation branch + load() checkpoint restore)"
  priority: P0
  engineering_level: production
  complexity_budget: S
  owner: meridian
  conceptual_reviewer: ashby
  code_reviewer: code-reviewer
  files_in_scope:
    - packages/cognition-service/models/convergence.py # :119-176 check()'s graduation branch (writer #1 at :160); :216-250 load() (writer #2 at :235)
  non_goals:
    - "training a real convergence head (separate, larger ticket — this is a hard-disable/pin-off only)"
    - "rewriting or migrating existing on-disk checkpoints in load() (load stays read-only; a persisted use_learned=True flag self-heals to False the next time save() runs)"
    - "changing the heuristic cosine-similarity divergence computation itself"
  acceptance_criteria:
    - given: "ConvergenceModel.check() (convergence.py:119-176), whose graduation branch (:152-166) currently flips self.use_learned = True (:160) from a single lucky proxy-accuracy sample against an untrained random head, guarded only by not self.use_learned plus sample-count/accuracy thresholds"
      when: "check() runs, regardless of convergence_sample_count or proxy_accuracy"
      then: "self.use_learned can no longer be set to True by this code path (the assignment at :160 is removed or made permanently unreachable); a unit test asserts use_learned stays False across 1000+ check() calls even when proxy_accuracy would otherwise clear the _GRAD_MIN_ACCURACY (0.80) threshold; the disablement is logged once with an explicit reason (e.g. 'no trained head available — use_learned hard-disabled')"
    - given: "ConvergenceModel.load() (:216-250), whose current body applies a persisted use_learned flag from an npz checkpoint verbatim (:234-235: if 'use_learned' in data: self.use_learned = bool(data['use_learned'][0]))"
      when: "a checkpoint containing use_learned=True is loaded"
      then: "load() forces self.use_learned = False regardless of the persisted value, logging a WARNING when the persisted flag was True and got overridden; the checkpoint file on disk is NOT rewritten or migrated by load() — it stays read-only, and the flag self-heals to False in the checkpoint the next time save() is called"
    - given: "a checkpoint built with use_learned=True per the prior AC, loaded via ConvergenceModel.load()"
      when: "check() is subsequently called"
      then: "a unit test asserts the returned divergence_score matches the heuristic cosine-similarity computation (not the learned _predict_learned() output), confirming convergence.py:168's `divergence_score = learned_divergence if self.use_learned else heuristic_divergence` resolves to the heuristic path"
```

## Notes for refine
- Split rationale (supersedes the single-ticket sketch above, updated per
  DEC-33): TK-A is apps/sylphie + forge-owned and independently
  shippable/verifiable (it is the P0 unblocker). TK-B, TK-C, and TK-D are all
  cognition-service + meridian-owned but are three tickets, not one, because
  they carry genuinely different risk profiles: TK-B is a narrow, mechanical
  ordering/wiring fix (S); TK-C is the larger structural extraction into a
  lock-free helper, with new deadlock-regression and lock-scope tests (M —
  the riskiest of the three, per AD-0049); TK-D is a small, self-contained,
  safety-critical pin-off confined to models/convergence.py (S, per AD-0050).
  Splitting TK-D out of TK-C (red-team MEDIUM finding, actioned) keeps the
  trivial "never let an untrained random head go live" fix from being stuck
  behind TK-C's larger extraction/testing work if that needs a second review
  pass.
- Sequencing: **TK-A → TK-B → TK-C**, with **TK-D independent of TK-C**. TK-A
  unblocks cycles from ever succeeding, so it lands first. TK-B and TK-C both
  touch main.py's phase-transition region — land TK-B (ordering fix, smaller
  diff, done in the still-inline handler) before TK-C (the extraction, which
  assumes TK-B's ordering and rewritten comment are already in place) to
  avoid a merge race on the same lines. TK-D touches only
  models/convergence.py, has no file or code dependency on TK-C's
  main.py/replay.py/trainer.py work, and MAY be built and merged in parallel
  with TK-C, or even before it, if trio bandwidth is constrained — nothing
  in TK-C depends on TK-D landing first. TK-D is listed after TK-C above only
  for numbering convenience.
- **ROADMAP.md:83 truth-edit placement (per AD-0047 "keep on whichever ticket
  lands LAST, not hard-pinned"):** kept on **TK-C**. TK-C performs the
  structural extraction that actually changes what "phase-transition wiring"
  means at runtime (inline handler -> shared helper, called from both the
  manual endpoint and the automatic mode-advance path), so it is the natural
  ticket to true up the doc line — and, per the sequencing above, TK-C is
  expected to be the last of TK-B/TK-C/TK-D to land in the common case (TK-D
  can land in parallel or earlier). If refine or execution reorders TK-D
  after TK-C in practice, the ROADMAP edit does not need to move — it
  concerns phase-transition wiring, which is TK-C's change, not TK-D's.
- CANON lens: EWC-inactive-while-documented-active (TK-C's ROADMAP.md
  truth-edit) and the random-head "learned mode" (TK-D's hard-disable) are
  both theater-prohibition adjacent — flag for the conceptual reviewer
  (`ashby`) on both. TK-C's lock-free extraction (AD-0049) is a Std-6-adjacent
  concern (no self-modification of evaluation machinery via an accidental
  deadlock that would starve the training loop) — flag for `ashby` as well.
- DB impact: confirmed NO DB/schema surface touched by any of
  TK-A/TK-B/TK-C/TK-D — all four are in-memory tensor weights, replay buffer,
  and checkpoint-file state; TK-C's ROADMAP.md edit is a docs change, not a
  migration.

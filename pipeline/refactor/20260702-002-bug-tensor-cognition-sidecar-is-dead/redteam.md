# Red-team findings — 20260702-002 (refine cog, 2026-07-02, plan-reviewer)

Verdict: **REPLAN** — 2 CRITICAL + 3 HIGH unresolved; single-ticket bundling fails the
atomicity gate. Diagnosis (all 7 evidence claims) re-verified and holds; the fixes as
specified do not.

## CRITICAL
1. **Fix #2 "fold consolidation into advance_mode" is architecturally incoherent.**
   `advance_mode()` lives in BootstrapTracker (inference/bootstrap.py:249) with no access
   to `trainer`/`trainer.ewc`; consolidation code lives in main.py's phase-transition
   handler (:583-608). Either a layer violation (inject trainer into the tracker) or the
   plan actually means "call consolidation in main.py train handler after advance_mode()
   returns True" — unstated. Consolidation boundary needs ashby/architect ruling.
2. **Fix #1 mis-specified vs actual code:** server already re-flattens
   (inference/cycle.py:101 `np.array(...).flatten()`); only the pydantic type rejects
   flat. Two valid fixes with opposite blast radius: (a) emit nested from TS — also
   requires gateway type change at cognition-gateway.service.ts:166 + :198 (unstated),
   or (b) 1-line schema relax, no TS change. Plan picks (a) without justification; AC
   can pass while gateway type is still number[].

## HIGH
3. **Theater contradiction unreconciled:** in-code TK-37/TK-39 notes (main.py:590-596)
   claim "this is the live active path — real empirical Fisher... no wiring change
   needed"; audit says path is dead. One of them is wrong; must be reconciled and
   recorded (decision or theater flag) before deleting the comment (Fix #3).
4. **AC #2 not runnably testable as one assertion** — bundles ordering (#3) and wiring
   (#2); "penalty non-zero in the following phase" is not a replay.py unit test. Split
   into (2a) unit ordering test, (2b) integration transition-invokes-consolidation test.
5. **Fix #4 convergence gate = disabling dressed as fixing:** no trainer path for the
   convergence head exists at all; gating use_learned on a training-pair count that
   nothing increments makes it permanently False. Either explicitly hard-disable learned
   mode (recorded), or split out as a design question — not a ≤10-line point fix.

## MEDIUM/LOW (carry into replan)
- →full transition may skip consolidation (main.py:398 gates recording on mode!="full";
  advance checks periodic) — AC must cover the final transition.
- Demotion AC must state the ≥20-sample precondition (bootstrap.py:145).
- Non-goal "50ms first-cycle AbortSignal" (gateway :209) may keep the breaker tripping
  after fix #1 and fail the live-smoke AC — measure first-cycle latency before deferring.
- files_in_scope lists cognition-gateway.service.ts with no fix mapped to it.

## Atomicity verdict — SPLIT
Two languages, two subsystems, two owners (forge TS / meridian Python); title has four
"and"s; fixes #2/#4 carry design content. Recommended split:
- TK-A (P0, forge): fix #1 only — contract + gateway type + contract test. Unblocker.
- TK-B (meridian): fixes #3+#5 — EWC ordering swap + demotion wiring (true point fixes).
- TK-C (meridian + architect/ashby): fix #2 consolidation boundary + fix #4 convergence
  gate — design decisions first, then implement.

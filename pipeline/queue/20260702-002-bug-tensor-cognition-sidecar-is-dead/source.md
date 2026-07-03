# Bug: Tensor cognition sidecar is dead end-to-end (every /cognition/cycle 422s) + EWC/convergence safety paths unreachable

**Severity:** blocker  ·  **Priority:** P0
**Area / component:** cognition-service (Python/TensorFlow sidecar) + tensor-inference adapter (apps/sylphie)

## What's broken (required)
The learned-cognition path — the project's headline thesis — does not run at all. The NestJS adapter sends `drive_history` as a **flat** 120-float array while the sidecar's Pydantic schema requires a **nested** `list[list[float]]`, so every `POST /cognition/cycle` fails validation with HTTP 422. `runCycle` returns null on every turn, the circuit breaker opens after 5 failures, `last_cycle_result` stays `None`, categories never graduate, and mode never advances past shadow. The sidecar's `/health` still returns OK, so the failure is invisible. This single mismatch masks four further defects that only matter once cycles flow again:
- **EWC consolidation never activates.** The only caller of `set_reference()`/`compute_fisher()` is `POST /cognition/phase-transition`, which has zero runtime callers; `penalty_gradients()` returns zeros forever, so shadow→audit→partial→full transitions happen with no anti-catastrophic-interference protection while logs/docs describe EWC as active.
- **EWC ordering bug.** Even if phase-transition were called, `set_reference` runs *before* `compute_fisher`, so the freshly computed Fisher is parked and never used for the phase it was computed for (first post-transition phase runs plain L2). The in-code comment claiming this lag is "Online EWC design" is wrong (Schwarz 2018 blends immediately).
- **ConvergenceModel can graduate a never-trained random head.** No code path trains the convergence weights, yet after 1000 `check()` calls a single lucky call (random sigmoid within 0.2 of the heuristic) flips `use_learned=True`, and the flag is persisted in the checkpoint — routing then runs on untrained random weights presented as "learned mode."
- **Category demotion gate never wired.** `check_demotions()` is called only from its test file, so a graduated category that later collapses below 0.70 agreement keeps tensor authority indefinitely.

## Expected (required)
`POST /cognition/cycle` succeeds with a real inference result for a well-formed frame; the breaker stays closed under normal operation; bootstrap comparison pairing records tensor-vs-LLM agreement; EWC consolidation is invoked at each mode transition with Fisher computed *before* it is blended into the reference; the convergence head cannot flip to learned mode without an actual training signal + validation criterion; and demotion is evaluated on every train call alongside graduation.

## Steps to reproduce (required)
1. Bring up the cognition sidecar and the main backend.
2. Send any conversational turn that triggers a decision cycle.
3. Observe: the sidecar logs a 422 on `/cognition/cycle`; `CognitionGatewayService` records a failure; after 5 turns the breaker opens; `GET /cognition/metrics` shows empty `per_category_confidence` and no graduation.
4. Expected: cycle returns 200 with an inference result; metrics populate.

**Reproducibility:** always (contract mismatch is unconditional; confirm live)

## Evidence
- Flat send: `apps/sylphie/src/services/tensor-inference-adapter.service.ts:189-198` (`getDriveHistoryFlattened()` returns `padded.flat()` → 120 floats); forwarded unconditionally at `cognition-gateway.service.ts:198`.
- Nested requirement: `packages/cognition-service/schemas.py:48` (`drive_history: list[list[float]] | None`); flattened again server-side at `inference/cycle.py:100-103`.
- EWC only-caller: `packages/cognition-service/main.py:531-627` (`/cognition/phase-transition`); no TS/Python runtime caller (grep). Zeros path: `replay.py:392-393`.
- EWC ordering: `main.py:583-596` (`set_reference` before `compute_fisher`); blend/null logic `replay.py:183-211`.
- Convergence graduation: `models/convergence.py:148-168` (count≥1000 + single-call proxy ≥0.80 → `use_learned=True`); persisted `convergence.py:211`. No trainer path (`trainer.py:811-855` trains only the global model).
- Demotion unwired: `inference/bootstrap.py:130-160` (`check_demotions`) called only in its test; `main.py` train path calls only `check_graduations()` + `advance_mode()` (`main.py:416-428`).
- Verified-fixed (do not re-file): `boost_salience` sidecar endpoint now real (`main.py:834-903`); `per_category_confidence` aggregation real (`main.py:194-226`) — empty only because of the 422.

Full detail: `docs/audits/repo-bug-audit-2026-07-02.md` §7.

## Where it lives (scope hints)
Fix #1 (unblocks everything): send nested in `tensor-inference-adapter.service.ts:189-198` (drop `.flat()`, emit `number[][]`), and add a contract test asserting the adapter payload validates against `schemas.py`. Then: add a runtime caller for phase-transition (or fold consolidation into `advance_mode`), swap the `set_reference`/`compute_fisher` order, gate `use_learned` on a real training-pair count + validation threshold, and call `check_demotions()` in the train path.

## Database impact (required)
**Touches a database / schema / migration?** no. All fixes are code + checkpoint-file behavior; no schema/migration. (Checkpoint format for the convergence flag is file state, not a DB.)

## Acceptance — how we'll know it's fixed (required)
- Given a well-formed frame, when `POST /cognition/cycle` is called, then it returns 200 with an inference result and no 422 — proven by a contract test that builds the adapter payload and validates it against the sidecar schema.
- Given a mode transition, when it occurs, then `compute_fisher` has run before `set_reference` for that boundary and `penalty_gradients()` is non-zero in the next phase (unit test on `replay.py`).
- Given a fresh convergence head with no training pairs, when `check()` is called 1000+ times, then `use_learned` stays `False` (unit test).
- Given a graduated category whose agreement drops below threshold, when the train endpoint runs, then `check_demotions()` demotes it (unit test).

## Environment
Local dev + any deploy. Confirmed by source-trace at commit `228df73`; sidecar + backend running.

## Notes / non-goals (optional)
- Fix #1 is the unblocker and should ship first; the other four are only observable once cycles flow.
- Non-goal: retraining/adding gradient paths to the deliberation panels (separate, larger design question — see audit §7 medium items).
- Non-goal: the 50 ms client `AbortSignal` first-cycle-timeout nuance (`cognition-gateway.service.ts:209`) — track separately if the breaker still trips after #1.

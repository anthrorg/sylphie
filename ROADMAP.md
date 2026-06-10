# Sylphie — Roadmap

**Baseline:** 2026-06-09 · HEAD `5e99a46`
**Status:** this is the single canonical forward plan. Earlier plans are in `archive/`.

This document declares where the project stands and where it is going. It supersedes the old `action-plan.yaml` (which was the 2.0 migration build plan — now complete). The granular worklist lives in `wiki/ideas/`; this roadmap is the *strategy* those tickets serve.

---

## Phase history

| Phase | Name | Scope | Status |
|---|---|---|---|
| 1 | **Subsystem migration** | Port the co-being code into the monorepo: the five subsystems, three-graph memory, drive engine, event backbone. | ✅ Done |
| 2 | **Cognitive pipeline + multimodal** | TensorFlow cognition sidecar, DeepSeek supervisor, perception fusion (YOLO + MediaPipe + Moondream2), working memory, voice. | ✅ Done — **this is the current baseline** |
| 3 | **Physical embodiment** | Hardware body, physical sensors/actuators. | ⏸️ **Deferred** — not yet worth building |
| 4 | **Provability First** | Close the cognitive loop and make the central thesis measurable, automated, and visible. | ▶️ **ACTIVE** |

Phase 3 is intentionally skipped for now. The body is premature until the mind is *proven* — which is exactly what Phase 4 is for.

---

## Phase 4 — Provability First

### The thesis being proven

Sylphie's reason for existing is a single claim: **a mind can graduate off the LLM that bootstrapped it, and you can watch it happen.** Today that claim is *architecturally supported but not yet demonstrable* — the loop that would make autonomy rise is stubbed, and the only way to observe it is manual log reading.

Phase 4 has one job: **make "is it working?" a question with a hard, automated, visible answer.** Build the instrument first; then close the loop the instrument measures.

Full reasoning: `sylphie-elevation-roadmap.md`. Honest gap list: `sylphie-assessment.md`, `sylphie-stub-inventory.md`.

### The headline metric

The **autonomy curve** — Type1/Type2 ratio over a session's lifetime — trending up, with prediction MAE trending down, experiential-provenance ratio rising, and the LLM bill falling. When that chart is real and trusted, Phase 4 is done.

---

### Workstreams

Ordered by leverage. WS1 comes before everything because it is the instrument the rest depends on.

#### WS1 — Provability foundation *(do first)*
Make the thesis measurable and the build trustworthy.
- Convert the three `test/e2e/*.e2e.ts` diagnostic probes into an **automated suite with assertions** on the autonomy ratio, MAE, and provenance ratio.
- **Lesion Test in CI** — assert Sylphie stays coherent with the LLM disconnected.
- **One developmental dashboard** — autonomy ratio, MAE trend, provenance ratio, procedures graduating Type 2 → Type 1, live.
- App-level healthcheck; fix the Dockerfile subpath `exports` hack so deploys stop being firefights.
- Related tickets: `unified-mae-history-store`, `attractor-monitor-placeholder-detectors`, `drive-tick-loop-observability`, `supervisor-reasoning-content-exposure`.

**Measurement discipline (the part that makes WS1 trustworthy, not just automated):**

Asserting on a stochastic system — LLM nondeterminism, 1Hz drive ticks, real-time decay — will produce a *flaky* gate unless these are designed in from the start. A flaky gate is worse than none: it trains you to ignore it.

1. **Baseline snapshot before anything else.** Run the current system against the scenario corpus (below) and record today's numbers at this baseline: Type1/Type2 ratio, prediction MAE, provenance ratio, LLM $/hour. The autonomy curve needs an anchor; capture it *before* WS2 changes anything, or "improvement" is unmeasurable forever.
2. **A fixed scenario corpus.** Autonomy curves are only comparable across builds if the input is held constant. Define a replayable "standard session" script (greetings, teachings, repeats of taught material, recall probes, idle stretches) that every gate run replays. Curves measured on ad-hoc conversation are anecdotes.
3. **A determinism strategy, chosen deliberately.** Options: record/replay LLM responses (cassette) for the gate path; seeded everything (Mulberry32 is already the house pattern); and/or assert on *statistical bands* over N runs rather than exact values. Probably a mix — cassettes for the LLM, bands for drive-coupled metrics. This is a `mythos` decision (see escalation table) before any code.
4. **Define "coherent" for the Lesion Test.** It cannot be vibes. Candidate criteria: responds to every scripted turn (no hangs), zero uncaught errors, SHRUG honesty (says "I don't know" rather than fabricating), drive loop keeps ticking, fact-recall of previously-taught WKG content still works. Pin the list, then assert it.
5. **CI pragmatics.** The full stack is ~9 containers + 2 Python sidecars — heavy for cloud CI. Start with the gate as a one-command local target (`yarn gate`) run before merges; promote to hosted CI only after it's stable and the infra is containerized for it. A gate that runs locally every day beats a perfect CI pipeline that ships next quarter.

#### WS1 — RESULTS (2026-06-09): instrument built, hermetic, and it told the truth

The gate exists and is trustworthy. `yarn gate` (record/replay/lesion modes) drives a fixed ~50-turn corpus through the **live** stack, intercepting only the LLM via a hermetic cassette (`test/gate/`). Determinism strategy (mythos-decided): cassette the LLM, seed RNG, assert non-regression vs a committed baseline + direction-of-change. Plumbing landed and verified live: `POST /api/metrics/reset` (per-run window), `POST /api/llm/lesion|heal` (real Lesion signal), `GET /drives` tick-rate, embed timeout, and an `H0` latent-hermeticity step.

**The headline number is honest now, and it is sobering: true autonomy is ~6% (type1=3/49), not the 0.80–0.96 the system reported before.** The gate's first job was to find that the apparent autonomy curve was almost entirely **confabulation** — the system answered unknowable inputs, including literal nonsense, as ~8ms confident-GROUNDED reflexes and never said "I don't know" (`shrug=0`). Root cause (mythos-confirmed, tape-proven): the latent hot layer is hydrated on boot from the persistent `learned_patterns` table (1,782 patterns across all prior runs) and the gate never cleared it — so it matched nonsense against a stale over-general pattern. Fixed: non-destructive `LatentSpaceService.clearHotLayer()` + gate `H0` step → confabulation eliminated (all 10 unknowns now deliberate honestly, LLM_ASSISTED, no false GROUNDED). **This `~6%` is the anchor baseline WS2 must move.** A deeper structural fix landed too: arbitration now gates TYPE_1 on context-match + honest grounding; the latent SHRUG-bypass was deleted; nomic embeddings now carry `search_query:`/`search_document:` task prefixes.

**WS1 follow-ups (do in this order; none block WS2 conceptually, but #1 keeps the instrument honest):**
1. **(near-term, first) Revise the C1/C2 gate definitions for the SHRUG-vs-deliberate regime.** With the LLM *available*, an unknown legitimately *deliberates* and signals honesty via *grounding* (LLM_ASSISTED ≠ GROUNDED), not via SHRUG — SHRUG is the *no-LLM* behavior the **Lesion run** should assert. As written, C2 ("unknowns must SHRUG") and C1 ("recall must be GROUNDED") read FAIL for definitional reasons, not real failures — a gate that's red for the wrong reason trains you to ignore it. C1 must also recognize OKG/person-model-backed recall (deliberation's WKG-only grounding check misses it).
2. **(quick honesty check) Confirm the now-deliberated unknowns honestly *decline* vs. fabricate** — the LLM_ASSISTED label can't tell us; read the recorded response texts from the cassette. Fold into #1's session.

> **#1 & #2 — DONE (2026-06-10).** #2: all 10 recorded unknowns honestly decline; none fabricate (the nonsense turn explicitly refuses to make something up). #1, the **C2 / SHRUG-vs-deliberate** half: shipped and proven live — corpus unknowns now assert `NOT_GROUNDED` ("never falsely GROUNDED"), SHRUG is a Lesion-only (L6) assertion. **Gate: C2 PASS 10/10**, with C0/H0/M1–M4 green. The grounding path was also hardened (credit OKG/person recall in `deliberate()`, close the base-context "Trap A", and stop the LLM self-asserting GROUNDED).
>
> **C1 — DONE (2026-06-10). 13/15 (87%) GROUNDED, C2 still 10/10.** Root cause was that the `okgRecallProvenance` fix was placed in `deliberate()` — but recall turns dispatch a `seed-greet` LLM_GENERATE ActionProcedure (TYPE_2 PROCEDURE path), which bypasses `deliberate()` entirely. Fix: `applyOkgRecallGrounding` shared helper applied in the PROCEDURE loop after `groundingForCachedResponse()`, with `recallKeyForQuestion` exclusions preventing C2 collisions (middle name, grew-up town, favorite food). `groundingProvenance` (the deterministic `attr-${personId}-${key}` OKG node id) now threads to `CycleResponse` (Standard 1 compliance). Two follow-ups: unit spec for `recallKeyForQuestion`; provenance verified against live Neo4j (deferred WS3). See `wiki/ideas/grounded-okg-recall-retrieval.md` for tactical vs durable distinction.
3. **(recurrence-prevention, prod) Latent-space production hardening** — the `toDocumentEmbeddings` fallback (`decision-making.service.ts:~1540`) silently stores the *query* embedding instead of a `search_document:` one, and a long-running process re-accumulates over-general patterns in `learned_patterns` and will confabulate the same way the gate did. Add document-space write-back + a min-population gate before single-pattern matches are trusted. (This is a production Standard-4/Standard-1 hazard, not just a test artifact.)
4. **Developmental dashboard + deploy hardening** (original WS1 scope, still open): live autonomy/MAE/provenance/graduation chart; app healthcheck; fix the Dockerfile subpath `exports` hack.

#### WS2 — Close the learning loop
Make the autonomy curve *able* to rise. These are the load-bearing stubs.
#### WS2 — RESULTS (2026-06-10): learning loop closed

- ✅ **EWC real Fisher + Online EWC** — `training/replay.py` rewritten with empirical Fisher diagonal, Online EWC γ-blend (γ=0.7), λ ramp (200 steps), per-layer Fisher stats logged. `DataBuffer.snapshot_calibration()` added. Phase-transition endpoint `POST /cognition/phase-transition` wires `set_reference()` + `compute_fisher()` at runtime. 7 tests, all passing.
- ✅ **Pressure-driven consolidation** — `LearningPressureBridgeService` wires `driveState$` → `forceCycle()` at `CognitiveAwareness > 0.70` (30s min interval). Timer demoted to 60s safety-net floor.
- ✅ **Convergence head** — Dead `w_adj`/`b_adj` head removed from `ConvergenceModel`. `total_params` now accurate (10369). Legacy checkpoint backward-compat handled in `load()`. `use_learned` graduation-criterion TODO documented.
- ✅ **Supervisor control endpoints** — `reinforce`, `correct`, `freeze`, `unfreeze` all wired to real Trainer operations. Guardian-feedback `alwaysEvaluate` wired: `CycleResponse.inputCategory` threaded through pipeline; supervisor bypasses sampling on `GUARDIAN_FEEDBACK` turns.
- **Pre-existing `np.savez` Windows save bug** fixed across all 4 save sites (`convergence.py`, `global_model.py`, `deliberation.py` ×2). `attractor_alert` in `alwaysEvaluate` deferred (needs per-cycle marker from attractor monitor).
- ✅ **TF training path (Option B, 2026-06-10)** — mythos's WS2 smoke test found the default TF boot silently bypassed ALL training + EWC (`_train_step` returned `0.0`, `get_weights()` returned `[]`, `fisher_computed: false`) — a theater-prohibition violation. Fixed by wiring the TF path through `tf.GradientTape` as the gradient engine only: `compute_batch_gradients()` is the single entry point (hand-derived backprop on NumPy, tape on TF, identical contract), with the validated NumPy Adam/EWC/lock machinery shared downstream. TF `trainable_variables` order shape-validated against the canonical convention (`GlobalModel.tf_variables()`). TF global model confirmed 939,810 params, byte-identical architecture to NumPy (the "5.5M" was whole-service total). 6 new TF-parity tests (`test_tf_training.py`); 13/13 pass in the TF venv. mythos live smoke: PASS all 6 items — loss 2.62→0.0015, non-uniform Fisher (w_action mean 9.7e-3, aux at floor), freeze/unfreeze, `.h5` round-trip exact. mythos also caught the 5th `np.savez` save-bug site (`panel_models.py` — panel weights never persisted); fixed + round-trip verified. NumPy path retained as the parity oracle.

#### WS3 — Compounding memory
Turn accumulated knowledge into compounding capability.
- **Procedure-conflict fix** — `constraint-validation-trigger-context-wiring`. One Cypher query; actively corrupting Type 1 graduation *now*. (Could be pulled forward into WS1/WS2 — it's cheap and high-impact.)
- Instrument spreading-activation payoff and the experiential-provenance ratio shift.
- Related: `mood-congruent-episodic-retrieval`, `theater-prohibition-real-validation`.

#### WS4 — Presence (one mind, many people)
The capability in `sylphie-chat-architecture.md`. A unified interlocutor queue: one mind, serial attention, per-person memory, addressed replies. Forks are decided (Part F of that doc). Shares plumbing with the flagged text-attribution need.
- Related: `decision-cycle-concurrency-guard`.

#### WS5 — Grounding payoff *(later)*
Perception that visibly changes behavior; multimodal episodic memory she can recall. Staged after the loop is proven.

### Cross-cutting: hardening
Automated tests (WS1), deploy robustness, and taming the three god-objects (`decision-making.service.ts` 1557 lines, `communication.service.ts`, `deliberation.service.ts`). Cost observability on every LLM path so "graduating off the LLM" has a dollar figure.

---

### The Phase 4 done-state

A single unbroken demo where every number is real:

> Person A teaches Sylphie something; a procedure graduates Type 2 → Type 1 on the dashboard. Person B joins; she answers both individually, by name. The LLM plug is pulled; she stays coherent. The autonomy curve is up-and-to-the-right; the hour's LLM bill is a fraction of where it started.

When that demo runs and every figure on screen is earned, Phase 4 is complete — and the question of whether Sylphie is "seriously amazing" is settled by the screen, not the argument.

---

## Suggested sequence

1. **WS1** + the procedure-conflict fix from WS3 — build the instrument, stop the active corruption.
2. **WS2** — close the learning loop; now the curve can move.
3. **WS4** — the presence leap.
4. **WS3 / WS5** — compounding memory and grounding payoff.

Pick within a workstream in any order; the worklist is `wiki/ideas/`.

---

## Working notes — escalation cues (for the Sonnet coordinator)

*Left here deliberately, while still on Opus, so the Sonnet coordinator has point-of-use guidance for the cascade. The cascade only pays off if escalation is selective: **escalate judgment, do the mechanics yourself.***

**The decision in one line:** spawn **`mythos`** (read-only reasoner) to *decide the approach* when you'd otherwise be guessing; spawn **`opus-agent`** to *do the build* when the approach is clear but the edit is heavy or risky; handle it yourself when it's mechanical and cheap to reverse. The default pattern for hard work is **mythos plans → you review/relay → opus-agent implements.**

| Phase 4 work | Default posture | Why |
|---|---|---|
| **WS1** metric/gate **definition** — what "working" asserts, Lesion-Test pass criteria, autonomy-ratio thresholds | **`mythos` first** | Getting the metric *definition* wrong is cheap to type and poisons every downstream judgment. Escalate even though it looks small. |
| **WS1** dashboard wiring, healthcheck, `exports` fix | self / `opus-agent` | Mechanical once the metric is defined. Don't escalate plumbing. |
| **WS2** EWC Fisher, convergence head, supervisor-signal-into-loss, pressure-driven design | **`mythos` first, always** → `opus-agent` | Real ML/scientific risk; reason from first principles + check current literature (mythos has web). This is where the cascade earns its keep. |
| **WS3** procedure-conflict fix | **just do it** (self / quick `opus-agent`) | One Cypher query, well understood. Escalating it would be theater. |
| **WS3** spreading-activation / provenance instrumentation | `mythos` if "payoff" needs a defined methodology; else self | Measurement design vs. mechanical plumbing. |
| **WS4** chat queue | **`opus-agent` implements** | Design is done (`sylphie-chat-architecture.md`, forks decided). Only re-spawn `mythos` if a new fork surfaces mid-build. |

**Gotchas:**
- `mythos` is read-only and starts **fresh each spawn** — hand it pointers (the file, the relevant baseline doc) since it can't inherit your context. Gather cheap context first, then escalate.
- Don't escalate cheap, well-understood work (procedure-conflict, dashboard wiring). That just relocates cost to Opus and defeats the point of running Sonnet on top.
- *Do* escalate methodology and metric-definition decisions even when the code is tiny. **The expensive Phase 4 errors are wrong definitions, not wrong lines.**
- When a domain specialist owns it (drive design → `drive`/`skinner`, graph schema → `atlas`, systems stability/attractors → `ashby`, NestJS structure → `forge`), prefer the specialist over generalist `mythos`.
- A `?` from Jim trips the `rank` hook — let that gate the routing rather than reflexively answering hard questions on Sonnet.

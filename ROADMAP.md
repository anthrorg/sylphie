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

#### WS2 — Close the learning loop
Make the autonomy curve *able* to rise. These are the load-bearing stubs.
- **EWC real Fisher computation** — `ewc-real-fisher-computation` (already researched: `wiki/researchedIdeas/2026-04-27-ewc-real-fisher-computation.md`). Precondition for trusting partial/full mode.
- **Pressure-driven consolidation** — `learning-cycle-pressure-trigger`. Drive state actually drives learning cadence.
- **Learned convergence head** — `convergence-panel-adjustment-head-unused`. So bootstrap can clear `partial → full`.
- **Real supervisor intervention** — `cognition-control-reinforce-correct-stubs`, `cognition-per-model-freeze`, `sidecar-boost-salience-implementation`, `supervisor-always-evaluate-events`.

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

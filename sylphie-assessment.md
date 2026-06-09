# Sylphie — Architecture Assessment (Flagged Issues)

Date: 2026-06-09 · HEAD `5e99a46`
Method: direct code reading + spec-vs-reality verification (not markdown-derived claims)
Companion to: `sylphie-tech-spec.md`, `sylphie-stub-inventory.md`

This is the candid version of "what I think." It records the issues worth acting on, ranked by how much they matter to the project's actual goal — not by effort to fix.

---

## 0. The one-paragraph verdict

This is the most *coherent* solo cognitive-architecture project I've seen. The ideas are non-trivial, internally consistent, and — unusually — actually implemented rather than just described. The spec matches the code on every bold claim I checked. The honesty culture (a self-authored, severity-ranked stub inventory) is a genuine engineering asset. **The risk is not architectural; it is epistemic.** The system's entire reason for existing is the LLM→deterministic *graduation curve*, and the stubs that remain unimplemented are precisely the ones that make that curve load-bearing. Today Sylphie is an extraordinary scaffold whose central thesis is **not yet falsifiable in practice**. Closing that gap — making "is it working?" a question with a hard answer — is the highest-leverage work available.

---

## 1. What is verified real (so this is balanced)

I spot-checked the boldest claims against code. They hold:

- **Drive isolation is real, not stylistic.** Separate process (`apps/drive-server`), and `packages/drive-engine/src/postgres-verification/verify-rls.ts` actually aborts startup if `sylphie_app` can UPDATE/DELETE `drive_rules`. An architectural commitment enforced in code.
- **12 drives, 5 typed cross-modulation rules, 5 behavioral contingencies** — all present and declarative (`drive-engine/src/constants/drives.ts`, `drive-process/cross-modulation.ts`, `behavioral-contingencies/index.ts`).
- **Type1/Type2/SHRUG arbitration** with the 0.80 graduation / 0.60 ceiling thresholds and a contradiction-scan downgrade to SHRUG (`decision-making/src/arbitration/arbitration.service.ts`).
- **Cognition sidecar is real TensorFlow** (~3.3k lines of genuine Python): GlobalModel, 4 panels, convergence, 3 deliberation pipelines.
- **Type discipline is solid:** `strict: true`, **zero `@ts-ignore`**, only **27 TODOs across ~76k lines of TS**, a real shared contract layer.

A spec that matches its code is rarer than it should be. Credit where due.

---

## 2. The load-bearing gap (this is the real issue)

The Apr-29 stub inventory is **still accurate at HEAD `5e99a46`** — I re-verified. The unimplemented pieces are not random; they cluster on the exact mechanism the architecture exists to demonstrate: *graduating off the LLM*.

| Stub | Where | Why it's load-bearing |
|---|---|---|
| **EWC is a no-op** | `cognition-service/training/replay.py` (`_compute_uniform_fisher` returns all-ones; `set_reference()` never called) | The whole "online learning without catastrophic interference" story. Harmless in shadow/audit; becomes load-bearing exactly in partial/full — the modes the bootstrap is *designed to reach*. A graduated category can silently regress and the agreement-gate won't catch it. |
| **Pressure-driven learning doesn't exist** | `learning/src/learning.service.ts` (all four cycles are pure `setInterval`) | A core CANON claim — "she consolidates because she *needs to*" — is currently a cron job. Drive state has zero influence on consolidation. This quietly invalidates the InteroceptiveAccuracy story. |
| **ConvergenceModel never uses its learned head** | `cognition-service/models/convergence.py` (`use_learned` never flipped true) | Bootstrap `partial→full` needs agreement to clear 0.90; raw cosine averaging is too noisy. Bootstrap may **stall at partial** forever. |
| **Cognition control endpoints are logging stubs** | `cognition-service/main.py` (`reinforce`/`correct`/`freeze`) | The supervisor's "corrective training signal" is theater: the HTTP call succeeds, the sidecar does nothing. You cannot distinguish "supervisor improves the system" from "supervisor emits verdicts that get logged." |
| **Procedure-conflict detection always passes** | `planning/src/pipeline/constraint-validation.service.ts` (`fetchExistingTriggerContexts()` returns `new Set()`) | Planning can write duplicate `:ActionProcedure` nodes; Type 1 then graduates a "phantom twin," fragmenting confidence updates. Manifests as "sometimes right, sometimes wrong, no apparent learning." **Actively corrupting Type 1 now** — and it's one Cypher query to fix. |

**The through-line:** shadow/audit mode works. The graduation off the LLM — the entire point — is not yet exercisable, because the machinery that would make partial/full mode safe and effective is stubbed. You can build forever in shadow mode without ever testing the hypothesis.

---

## 3. Engineering health: solid core, two real weaknesses

**Strong:** modularity (9 clean packages), the event-backbone-with-ownership-map pattern, provenance/confidence rigor, the Lesion Test discipline (every LLM path has a degraded fallback).

**Weak — and worth your attention:**

1. **Verification is manual.** 15 test files total. The unit tests (`cross-modulation.spec.ts`, `prediction.service.spec.ts`) are genuinely good. But the three `test/e2e/*.e2e.ts` files are operator-driven log-dump probes — "hand logs to Claude" — not automated pass/fail. **For a system whose behavior is emergent and stochastic, you currently cannot tell regression from drift in CI.** Given the stated value of "verify before presenting," this is the gap I'd close first.

2. **Deploy is fragile.** The recent git history is almost entirely Railway/Prisma firefighting. The Dockerfile copies `dist/` contents into package roots to fake missing `exports` fields — that hack breaks silently if package structure shifts. No app-level healthcheck.

3. **A few god-objects.** `decision-making.service.ts` (1557 lines), `communication.service.ts` (1165), `deliberation.service.ts` (1132). Cohesive today, but they're where complexity will rot first. Watch them.

---

## 4. The epistemic risk, stated plainly

The headline metric — Type1/Type2 ratio rising over time — **cannot climb** until the load-bearing learning stubs (§2) are real, because nothing currently graduates procedures safely. And the manual-only e2e harness (§3.1) means that even if it *did* climb, you'd have no automated signal telling you whether you're progressing or chasing noise. So the project's two biggest risks compound: the thesis isn't yet testable, *and* the instrument that would test it isn't automated.

This is not a criticism of ambition or execution — both are high. It's the observation that the next unit of effort is worth far more spent on *provability* than on *more architecture*.

---

## 5. What I'd do first (prioritized)

In order, weighted by leverage:

1. **Turn the autonomy metric into an automated, asserted e2e gate.** Make "is it working?" falsifiable. This is above everything else — it's the instrument you need before any other change can be trusted. (Convert the three diagnostic e2e files into a real suite with assertions on Type1/Type2 ratio, MAE, provenance ratio.)
2. **Fix procedure-conflict** (§2, last row). One Cypher query. It is actively corrupting Type 1 graduation *right now*.
3. **Make EWC and pressure-driven learning real — *before* attempting partial-mode bootstrap.** Without EWC, partial mode is unsafe; without pressure-driven cycles, "motivated learning" is a claim with no implementation behind it.
4. **Plumb the dropped DeepSeek reasoning trace** (you pay for reasoning tokens and discard them) and wire the `alwaysEvaluate` supervisor path so guardian-feedback/attractor-alert events actually force evaluation.
5. Then deploy hardening: app healthcheck, fix the subpath `exports` hack, document env parity.

Phases A/B in your own stub inventory already say most of this. The one thing I'd add and weight above all of it is **#1** — provability first.

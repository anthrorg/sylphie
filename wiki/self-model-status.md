# Self-Model & Phase 4 Wave 2 — Status / Return Doc

**Last updated:** 2026-06-15 · **Merged to `main` at `67c3bf9`** (merge commit).

This is the single-source-of-truth handoff for the self-model capability work and Phase 4 Wave 2. If you're an agent picking this up, read this first.

---

## Where everything lives now

All of the following is **merged into `main`** (commit `67c3bf9`), integrated with the P1→P3.A vision stack (`4d19b03`) that was also on main:

- **Phase 4 Wave 2** — Tier-3 clusters 3a/3b/3c (`9056217`) + residuals/one-hop completions (`e8f5b20`).
- **CANON Std-6 ratification** (`c74cb7f`) — see ledger below.
- **Three self-model capabilities** (`56af7a3`, `1a40bb1`, `8eeea74`).

The temporary `feat/phase4-self-model` branch + its worktree have been **removed** (fully merged). Do not look for the work on a branch — it's on `main`.

---

## The self-model: 3 honest capabilities

MAIN's Learning subsystem writes `:Capability` nodes to the SELF Neo4j graph on a 10-min cycle; `SelfAssessmentService` reads them and pushes `SELF_ASSESSMENT` to the drive every 10s (event-judge model — the drive never reads MAIN). The drive maps each capability to a drive via `CAPABILITY_TO_DRIVE_MAP` and, because provenance is `INFERENCE`, can only **recover** that drive's baseline toward its `INITIAL_DRIVE_STATE` default — never depress it (the `allowReduction=false` guard). All three are live-verified end-to-end (mythos) and CANON-clean.

| Capability | Honest metric (the anti-theater bit) | Drive | Source telemetry |
|---|---|---|---|
| `prediction_accuracy` | accurate / total over `PREDICTION_EVALUATED`, **excluding empty-`predictedEffects` rows** (trivially-accurate random-delta predictions) | Integrity | TimescaleDB `events` |
| `knowledge_retrieval` | `GROUNDED / (GROUNDED\|UNKNOWN)` over `RESPONSE_GENERATED`, **gated on `intent='QUESTION'`** (LLM_ASSISTED/non-QUESTION excluded — measures retrieval, not chat volume) | CognitiveAwareness | TimescaleDB `events` |
| `social_interaction` | (proactive `SOCIAL_COMMENT_INITIATED` that earned a guardian reply ≤30s) / (all proactive bids), **denominator gated to genuinely proactive self-tick bids only** (NOT the every-turn `socialCommentTimestamp`) | Social | TimescaleDB `events` |

**Code:** `packages/learning/src/pipeline/self-model-writer.service.ts` (the writer — one `refresh*()` method per capability, all sharing the INFERENCE / `confidence=min(0.60, n/(n+50))` / zero-sample→`DETACH DELETE` / idempotent-MERGE discipline). Reader: `apps/sylphie/src/services/self-assessment.service.ts`. Emit legs are in `packages/decision-making/src/decision-making.service.ts` + `apps/sylphie/src/services/communication.service.ts`.

### `error_correction` — deliberately OMITTED (not a TODO; a finding)
The 4th capability name in `KNOWN_CAPABILITY_NAMES` is intentionally **not** written. There is **no contradiction-resolution mechanism anywhere in the code**, and the detector cannot fire (0 DISLIKES edges in the WORLD graph). Writing a node would assert a competence Sylphie cannot perform (Std-1 theater). Standing flag is in the writer header. Lighting it up is a real **capability** build (a resolution mechanism), not a telemetry one.

---

## CANON Std-6 ledger (ratified, in `sylphie-tech-spec.md` §9)

Jim ratified (2026-06-14): *Learning may write **INFERENCE-grade** self-capability nodes that feed drive baseline-adjustment, provided provenance=INFERENCE, confidence≤0.60, and the data is honest telemetry. **Reduction authority stays GUARDIAN-only** — an INFERENCE assessment may only recover a baseline toward its CANON default, never depress it. Bounded self-recovery, not self-modification (Std-6 preserved).* The guard is capability-agnostic, so this generalizes to all `CAPABILITY_TO_DRIVE_MAP` entries; each new live edge still gets a confirming canon sign-off. Three edges are live: `prediction_accuracy→Integrity`, `knowledge_retrieval→CognitiveAwareness`, `social_interaction→Social`.

---

## Open residuals (honest — none are silent)

1. **Organic-traffic accrual (all 3 capabilities, environmental — not a code gap).** The metrics read empty/zero-sample until real traffic flows over ~24h: genuine pressure-gated proactive comments, grounded recall questions, prediction evaluations. The write/read/drive machinery is proven; it just needs Sylphie running and interacting. The zero-sample guard keeps the pre-accrual state honest (`DETACH DELETE`, no fabricated node).
2. **`e8f5b20` Wave-2 residuals never got a live smoke.** That batch (dead-stub cleanup + the 4 one-hop completions: decision-making WKG-diff emit, correlationId origin, theater correlation_id, intervention outcome auto-attribution, supervisor `this.model` race) is **build + unit green only**. Per the mandatory-live-smoke policy it's still owed a runtime sign-off. (The Wave-2 *clusters* and all 3 self-model capabilities were live-smoked.)
3. **Minor, non-blocking (from earlier smokes):** a full-stack on-the-wire `SELF_ASSESSMENT` push log was never captured (port-clash avoidance); the 10-min writer auto-timer was never observed firing organically (the path it calls is verified).
4. **Pre-existing, unrelated:** `packages/learning/src/pipeline/refine-edges.service.spec.ts` has one failing test (past-tense LIKES heuristic) — present before this work, not in any of these diffs. Left alone.

---

## How to continue (the pattern)

To add another honest capability: (1) confirm a real telemetry source exists and define a denominator that measures the *competence*, not volume (the recurring theater trap — empty-`{}`, LLM_ASSISTED, every-turn-timestamp); if no honest source exists, OMIT and say so. (2) Add a `refresh<X>()` to `SelfModelWriterService` mirroring the others. (3) Confirm `CAPABILITY_TO_DRIVE_MAP` has the edge. (4) Fresh canon sign-off on the new live edge. (5) mythos live smoke. The cascade that built these: mythos design → opus-agent/specialist build → canon → mythos smoke → commit.

---

## Notes for whoever syncs `main`

- `main` also carries unrelated **uncommitted** architecture-docs work (a `CLAUDE.md` map section + untracked `wiki/architecture/`, `docs/`, `wiki/_assemble.py`, `wiki/cv-framework.md`, `wiki/architecture-manifest.json`). The merge deliberately did **not** touch these — they're a separate effort still sitting uncommitted on `main`.
- After a merge, **rebuild the `@sylphie/*` package `dist`s** before `yarn build:backend` — `nest build` resolves cross-package types via `dist`, and a stale `dist` produces phantom "property does not exist" errors even when source is correct (hit this during the merge).
- Other feature branches still exist (`ws5-grounding-payoff`, `phase4-wave1-hardening`, `worktree-vision-abc-plan`, several `worktree-agent-*`) — out of scope for this work; their owners/agents should reconcile them.

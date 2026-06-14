# Phase 4 — Consolidated Hardening Backlog

**Compiled 2026-06-14** from a full sweep of `ROADMAP.md` residuals, `sylphie-stub-inventory.md` (§2–§4), the WS3/WS4/WS5 build-plan residual sections, and all 76 `wiki/ideas/` tickets (+ `research-report.md`). Deduplicated across sources. This is the working burn-down list for closing out Phase 4's residuals.

**Legend:** size = quick (hours) · ticket (focused build) · workstream (multi-ticket). Blocker = prerequisite before it can start.

---

## Tier 0 — By-design / NOT work (record, don't build)
- **Guardian-fact compounding = decay-resistance only** (Std 3, correct). Doc-note only.
- **Global voice cache** (TTS audio, not knowledge) — acceptable unless per-person voice is wanted (Jim).
- **§3.3 drives-controller 501s** — CANON-correct (drive isolation forbids app mutating drives); only the UX (decorative controls show 501) is open → product decision.
- **§2.10 post-hoc OKG-recall regex fallback** — not a stub; safe `else` branch; delete only after T2/T4 verify the durable path subsumes it.

## Tier 1 — CANON / Six-Standards hazards (do FIRST — these are breaches)
| Item | What | Std | Size | Blocker |
|---|---|---|---|---|
| **§2.8 person-fact WKG leak** | 60s learning cycle leaks spoken proper nouns into shared WKG → Person B grounds off Person A's facts. **Gate-invisible** (single-person corpus). | 3 / §4.1 isolation | ticket | atlas design call (part of world-fact cluster, Tier 4a) |
| `latent-space-confidence-ceiling-enforcement` | `write` stores caller confidence >0.60 at useCount=0 — direct ceiling breach. | 3 | quick | canon sign-off |
| `action-emotion-runtime-registration-bypass` | casts Readonly→mutable, self-modifies the eval table; **zero callers**. | 6 | quick (guard/remove) | canon |
| `theater-prohibition-real-validation` (§3.1) | `checkTheaterProhibition` only flags anxiety>0.7, always returns grounded — toothless. | 1 | ticket | needs sentiment-vs-drive correlation design |
| `theater-prohibited-event-emission` | THEATER_PROHIBITED events die in stderr, not auditable. | 1 | ticket | none |
| `attractor-monitor-placeholder-detectors` | 2 of 5 CANON attractor detectors always return false — safety blind spot. **Reconcile:** research-report claims these are "already implemented" — verify against code first. | safety | ticket | code check |

## Tier 2 — Quick wins, no blockers (hours each — high ratio of value/risk)
**Dead-code deletions:** §4.1 perception `/stream` (503), §4.2 DebugController, `action-handler-registry-stale-comments`, `sensory-logger-temporary-standin` (verify+delete).
**Observability/audit (cheap, real value):** §2.3 `per_category_confidence` empty, §2.4 DeepSeek reasoning trace dropped (`supervisor-reasoning-content-exposure`), §2.7 `MAX_INFERENCE_TIMEOUT_MS` unenforced.
**Correctness bugs:** `guilt-repair-behavioral-change-dead-path` (relief unreachable, §A.14), `self-eval-circuit-breaker-half-open-hardening` (3 bugs), `bootstrap-category-normalization-consistency`, `tracker-class-aware-iou-association` (cross-class ID swaps), `recovery-mechanism-jitter-and-iterative-retry`.
**Perf/robustness:** `simulation-parallel-category-evaluation` (~4×), `learning-neo4j-session-batching`, `planning-ingest-per-row-error-isolation`, `perception-frame-source-timeout-guards`, `perception-embedding-init-deduplication`, `concurrent-persistence-checks-in-pipeline`, `conversation-history-split-lookahead-efficiency` (O(n²)→O(n)), `learning-llm-call-timeout-guards`, `inner-monologue-question-subject-extraction`.
**Roadmap residuals:** M2 baseline re-anchor (= M1 fix, done for M1), `recallKeyForQuestion` unit spec, 2 stale jest suites, `.env.example` empty JWT_SECRET hazard, `cost-tracker-configurable-pricing-rates`.

## Tier 3 — Dependency clusters (build the root once → unblocks several)
**3a. Drive-engine IPC read path** *(one root unblocks 4)* — the drive child process can't read WKG/Self-KG or expose vectors cross-process. Build it once → unblocks `ipc-self-kg-reader-wiring` (§E4-T008), `curiosity-information-gain-wkg-access` (§A.14, defraudable today), `action-outcome-cost-and-window-tracking`, `tensor-inference-opportunity-features`. *(drive + atlas + forge)* — **workstream**.
**3b. Supervisor / DeepSeek feedback loop** (~9 tickets) — `cognition-control-reinforce-correct-stubs` (loop broken at final step — HIGH), `supervisor-verdict-audit-trail`, `supervisor-always-evaluate-events` (= `attractor_alert` half, §2.6), `supervisor-adaptive-sampling-rate`, `supervisor-behavioral-baseline-in-narration`, `supervisor-intervention-lifecycle-tracking`, `sidecar-control-circuit-breaker`, `sidecar-boost-salience-implementation` (§2.2), `cost-tracker-budget-enforcement-correctness`. *(meridian/supervisor)* — **ticket-cluster**.
**3c. Drive-engine audit/observability** — `drive-event-timescale-forwarding` (TODO line 201), `drive-event-correlation-id` (Std 2 verification), `drive-tick-loop-observability` (silent 100→50Hz drift), `action-outcome-cost` (→3a). *(drive/sentinel)*.

## Tier 4 — Workstreams (multi-ticket, need scoping)
**4a. World-fact / three-graph cluster (= WS5.5, atlas-led)** — the most-deferred bundle, items keep getting carried forward: **§2.8 leak fix** + **`ws5-t1-world-fact-promotion`** (CandidateWorldFact + guardian gate) + **§2.12 consolidation→visualContext** + **`grounded-okg-recall-retrieval` durable path** (PRIV.2 amber) + **T3 face→Type-1 reflex + face-privacy machinery** + **`legacy-pattern-rescope-migration`** (needs Jim's OK). All co-dependent in the atlas/isolation design space. → **scope as WS5.5.**
**4b. Multi-hop / spreading-activation recall (Phase 3)** — gated behind THREE co-reqs before any wiring: §2.8 fix [atlas] + depth-governor redesign [ashby] + priming↔inhibition contract [ashby]. `spreading_activation.py` is dead code (§2.9) → rebuild, not a switch. → **deferred, correctly.**
**4c. God-object refactors** — `decision-making.service.ts` (~2000+ lines post-WS5), `communication.service.ts`, `deliberation.service.ts`. *(forge)*.
**4d. Cognition-sidecar training stubs** — `cognition-control-reinforce-correct-stubs`, `cognition-per-model-freeze`, `ewc-real-fisher-computation` (verify vs WS2), `bootstrap-mode-and-category-demotion`, §2.5 `use_learned` graduation criterion.
**4e. Deploy hardening** — app-level healthcheck + Dockerfile subpath `exports` fix (open since WS1).
**4f. Cost observability on every LLM path** — the dollar figure for "graduating off the LLM" (done-state metric).

## Tier 5 — OTHER deferred (decay, research, perception cognition)
- **§2.11 OTHER-instance decay** — gated on a guardian/identity-exclusion design (identity facts must not fade). *(learning/atlas, gate-design)*.
- **§3.2 SearXNG unused** — research is retrospective-only; wire the web client or remove the container.
- `consolidation-semantic-extraction-depth`, `reflection-long-session-sampling`, `ungrounded-insight-regrounding-sweep`, `learning-pipeline-dead-letter-tracking`, `learning-cycle-pressure-trigger`.
- **Perception cognition (Python):** `morphology-executor-call-step-type` + `procedure-executor-syntactic-step-types` (NotImplementedError — procedures can't compose), `semantic-teaching-default-sense-tag`, `inference-depth-4-advancement-criteria`, `configurable-persistence-check-weights`, `tracker-class-aware-iou` (→Tier 2).
- **Planning:** `planning-requeue-backoff-on-llm-unavailability`, `simulation-cross-drive-effect-aggregation`, `simulation-confidence-risk-sample-size-aware`, `constraint-validation-trigger-context-wiring`.
- **Decision-making:** `decision-cycle-concurrency-guard` (WS4 residual), `decision-cycle-structured-error-recovery`, `confidence-updater-deferred-event-emission`, `unified-mae-history-store`, `mood-congruent-episodic-retrieval` (verify — folded into WS5 T2.5?), `latent-space-multimodal-drive-face-write` (= T3, →4a), `adaptive-candidate-scoring-weights` (2nd Type2→Type1 axis, canon-check).
- **Misc/PKG:** `scope-aware-calls-edge-resolution`, `pkg-tools-name-resolution-suggestions`, `skill-installer-cycle-detection`, `narration-sidecar-model-state-enrichment`, `bootstrap-mode-and-category-demotion`.

## Tier 6 — Needs Jim's decision before any work
- `legacy-pattern-rescope-migration` — re-attribute 293 legacy world-scoped rows to `guardian`? (one-shot migration).
- Per-person voice cache (Tier 0) — wanted?
- §2.9 `spreading_activation.py` — keep as Phase-3 reference spec, or delete?
- §4.3 voice one-shot `/transcribe` — implement (Deepgram REST) or remove the press-to-talk UI?
- §3.3 drives-controller UI — remove the affordances or route via guardian-feedback?

## Verify-before-listing (status uncertain)
- A2.1 latent-space production hardening — commit `80128a4` suggests it landed; confirm.
- `mood-congruent-episodic-retrieval` — likely shipped as WS5 T2.5; confirm, then close.
- `research-report.md` (46 ideas, April) — stale vs the June cluster; mine for any not-yet-ticketed gems, otherwise archive.

---

## Suggested wave order (dependency-aware)
1. **Wave 1 — CANON hazards (Tier 1) + the Tier-2 quick wins.** Highest value/risk ratio; closes real Standard breaches and clears noise. Can be parallelized heavily.
2. **Wave 2 — Tier-3 clusters** (drive-IPC root, supervisor loop, drive audit) — build each root once.
3. **Wave 3 — WS5.5 (Tier 4a)** — the world-fact/three-graph bundle, atlas-led (this also closes §2.8 which Tier 1 depends on — so §2.8 may pull forward into Wave 1/2 if we start the cluster early).
4. **Wave 4 — remaining Tier 4/5 + god-objects + deploy/cost hardening.**
5. **Parked:** multi-hop recall (4b) stays deferred until its 3 co-reqs land; Tier-6 items await Jim's calls.

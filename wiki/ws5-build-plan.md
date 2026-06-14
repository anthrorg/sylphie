# WS5 — Grounding Payoff: Build Plan

**Status:** ✅ CLOSED-WITH-RESIDUALS (2026-06-14). T0–T2 + gate rows shipped & mythos-verified live; T3 deferred to WS5.5. Full `yarn gate` 32/1/4 (non-regression confirmed; the 1 FAIL is M1 stale-baseline, not a regression), prows smoke 3× deterministic green, T1/T2 forcing smokes green, real camera→sidecar leg live-verified. Residuals: M1 re-baseline, P2 smoke turn-correlation, real-camera/COCO leg (env-limited), WS5.5 bundle (T3/T5/§2.8/consolidation→visualContext). Scoped by `mythos`; revised after a **2-round, 14-agent adversarial review** (PROCEED-WITH-CHANGES, 0 blocks, CANON cleared).
**Governing doc:** `sylphie-tech-spec.md §9` (Six Immutable Standards), `§4.1` (graph isolation); CLAUDE.md (cascade + mandatory mythos live-smoke before close).
**Companion idea docs:** `wiki/ideas/latent-space-multimodal-drive-face-write.md`, `wiki/ideas/mood-congruent-episodic-retrieval.md`, `wiki/ideas/ws5-t1-world-fact-promotion.md`, `wiki/ideas/episodic-ageweight-live-decay.md`, `wiki/ideas/perception-frame-source-timeout-guards.md`, `wiki/ideas/perception-embedding-init-deduplication.md`
**Review record:** `wiki/reviews/ws5-build-plan/synthesis.md` (Round 1), `wiki/reviews/ws5-build-plan/verdict.md` (Round 2 + verdict).

---

## Revision history

- **2026-06-13 — Round-2 fold-in (build-ready).** Final verdict PROCEED-WITH-CHANGES (Round 2: 3 `proceed`, 11 `proceed-with-changes`, 0 blocked; CANON BLOCKED→proceed once T3 deferred). This pass folds the entire Round-2 "Consolidated change-list" (`verdict.md`) into the T0/T1/T2/T4 ticket specs, turning each review finding into a concrete builder spec line. Every load-bearing cite re-grounded against live source at HEAD `4f0b473`. The one decision left open by the verdict — the synthetic-frame WKG-node provenance strategy — is **decided here (option (a), threaded override)** and folded into T0 (atlas sign-off flagged). Two new BLOCKED-until markers added: T1 `sceneSurprise→attention` cycle-ordering (was assumed wired, is not) and T4-P1c familiarity mechanism (must exist before P1c can ship non-vacuous).
- **2026-06-13 — Revised post-review (Round 1).** Verdict PROCEED-WITH-CHANGES (unanimous, 14 reviewers, no plan-level blocks). Folded the Round-1 change-list and Jim's two binding decisions:
  1. **T3 (face→Type-1 reflex) and all its identity/face-privacy machinery deferred to WS5.5**, bundled with T5 (world-fact promotion) and the §2.8 WKG leak fix. WS5 ships = T0 + T1 + T2 + surviving gate rows (P5 removed).
  2. **This plan went to a Round-2 review** — so the revision is concrete and self-contained.
- Change-lists applied below were re-verified against live source at HEAD `4f0b473` (file:line citations confirmed where load-bearing).

> **Provenance note.** Scoping and these revisions authored by `mythos` (Opus reasoner); every load-bearing claim re-grounded in live source at HEAD `4f0b473`. Synthesised into build-plan form by the Sonnet coordinator. The two scope decisions (T3→WS5.5, T0 injection mechanism) and the synthetic-frame provenance strategy were decided as noted. `mythos` live-smoke remains a **hard close-criterion** — it must bring up perception-service + backend, push a real frame over the inbound camera socket, and watch a drive move and a visual episode become recallable end-to-end, covering the real camera→sidecar leg the cassette deliberately bypasses.

---

## The thesis (code-confirmed)

**Grounding payoff proves the perception Sylphie already runs is not decorative: it measurably moves her drives, changes her decisions, and becomes episodic memory she can recall — and every one of those is now a hermetic gate assertion, not a log you have to read.**

What this proves that WS1–WS4 did not: WS1–WS4 closed and proved the **text/conversation** loop (autonomy ratio, learning, compounding memory, presence). The autonomy curve today is earned almost entirely from language. WS5 brings the **second sensory channel** onto the same provable footing — *seen-not-told* experiential provenance is the path to the autonomy curve continuing to rise **after the conversational well runs dry.** Tied to the headline metric, WS5 adds: a **second MAE that should fall** (scene-prediction surprise, habituating), and the **first non-conversational experiential-provenance source** (visual episodes, T1/P3, recallable via T2/P4).

> **Scope note (post-review).** The perception-sourced point on the Type1/Type2 curve (face→reflex) was the original T3 headline. It is **deferred to WS5.5**. WS5's proven payoff is **multimodal recall** (T0/T1/T2), not the face reflex. The done-state wording below is corrected accordingly — do not claim a perception-sourced Type-1 point as a WS5 deliverable.

---

## What is ALREADY REAL (do not rebuild — assert it)

Perception already reaches cognition in three verified places. WS5 does **not** rebuild these; it makes them provable.

- **Vision reaches the decision frame.** Face encoder → 20-dim geometry+blendshapes (`face.encoder.ts:78-228`); video encoder → COCO histogram (`video.encoder.ts:78-121`); fused into `SensoryFrame.fused_embedding` (`sensory-fusion.ts:126-141`).
- **Vision already moves drives.** `routeScenePredictionErrors` routes scene surprise → drive outcomes: novel-track → **Curiosity + Anxiety** (`decision-making.service.ts:1867` + `drive-engine/src/constants/rules.ts:165-168`); a **separate** `UnknownPersonPressure` outcome (gated on `frame.raw['unknown_person_count']`, `decision-making.service.ts:1894-1905`) is what moves **Social**. (Corrected per finding K — `scene-prediction` does **not** move Social.)
- **Vision already changes the LLM response.** Scene description injected as "What I see:" into deliberation **unconditionally** via `buildFlatContext` (`deliberation.service.ts:838-843`) AND as a (prunable) candidate in working-memory assembly (`working-memory.service.ts:137,365-371`); YOLO/scene labels become retrieval entities (`process-input.service.ts:268-298`). *(T4/P2 must pin which of these two paths the gate backend runs — they diverge in evictability; see finding 3 / T4.)*

## What is BROKEN / STUBBED (the actual WS5 work)

1. **Episodic memory is multimodal-blind for recall.** Episodes store `inputSummary` (text-first, `process-input.service.ts:314-326`), `contextFingerprint`, `driveSnapshot` — but **no visual content** and **no `source`/provenance field at all** (`Episode`/`EpisodeInput` in `decision-making.types.ts:53-145`). "What did you see earlier?" cannot be answered, and "seen-not-told" cannot be proven, because there is no field to read.
2. **Episodic recall is keyword-Jaccard over a SHA fingerprint** (`episodic-memory.service.ts:293-324` + `process-input.service.ts:335-347`) — fingerprint = `sha256(fused_embedding[:64] + category + drive)`, so two semantically-related visual episodes share zero tokens. `CONTEXT_SIMILARITY_THRESHOLD = 0.70` is calibrated for that near-binary SHA Jaccard; an NL query vs a short caption Jaccards ≈ 0.11. Content recall is impossible by construction *and* below the include-gate.
3. **The gate cannot inject a perception frame.** Corpus is text-only over the conversation WebSocket (`corpus.ts:28-54`, `gate.ts:29-58`); no seam feeds a YOLO/face/scene frame. **A completely broken perception→behavior path would leave `yarn gate` green.** This is WS4's two-socket problem exactly — and it is why T0 comes first.
4. **`sceneSurprise` never reaches the encode-attention gate (NEW, Round 2, load-bearing).** The 0.15 encoding gate reads `input.attention`, which is **drive-derived only** (`computeAttention`, `decision-making.service.ts:2438-2443`). The `encode()` call (`:1426-1440`) runs *before* scene surprise is computed in-cycle (`routeScenePredictionErrors` at `:1867`). So a salient-but-calm novel frame fails the encode gate structurally (one-tick IPC lag), and **P3/P4 are unreachable until F2(a) is wired** (see T1).

*(The `faces`/`drives` latent write-skip at `latent-space.service.ts:540` — the original WS5 stub #3 — is now WS5.5's problem, deferred with T3.)*

---

## Scope decisions (ratified by Jim, 2026-06-13; updated post-review)

- **WS5 ships T0 + T1 + T2 + gate rows (minus P5).** The headline is **multimodal recall** — perception becomes recallable episodic memory with honest seen-not-told provenance, gate-proven.
- **T3 (face→Type-1 reflex) and ALL face-privacy machinery → WS5.5**, bundled with **T5 (world-fact promotion, ws5-t1)** and the **§2.8 WKG person-fact leak fix**. (Full WS5.5 spec captured in the Deferred section.)
- **T0 uses the real HTTP boundary, not the tickSampler.** The cassette feeds canned detection/caption JSON through the **`PERCEPTION_HOST` HTTP boundary**, so the real `PerceptionGateway.handleFrame` (detection mapping → `detectEvents` → VWM → caption compose) actually runs. `PerceptionGateway` gets **NO production-code changes** (no `GATE_MODE` guards).

---

## Phase 0 — The injection seam (do first; nothing in WS5 is provable without it)

### T0 — Perception-frame gate-injection seam at the real boundary
*(owner: `mythos` defines the contract, `forge` shapes the harness, `opus-agent` builds; `sentinel` owns the reset/hermeticity block; `proof` owns the determinism acceptance checks)*

**Inject at the `PERCEPTION_HOST` HTTP boundary, NOT the tickSampler.** The original plan injected at `tickSampler.updateVideoDetections/updateFaces/updateScene/updateSceneDescription`, which is **downstream** of `handleFrame`'s detection mapping, `sceneEventDetector.detectEvents`, VWM update, and caption composition (`perception.gateway.ts:96-201`) — i.e. it bypasses exactly the gateway code the cassette path was ratified to prove (finding A). A path broken in `detectEvents`/VWM/caption-compose would still leave P1/P3/P6 green.

The real seam already exists: `PERCEPTION_HOST` is externalized via `ConfigService` (`perception.gateway.ts:50-53`), exactly mirroring `OLLAMA_HOST` for the LLM cassette. T0 scope, with the Round-2 build-spec lines folded in:

**T0.1 — Cassette server topology (two servers, two ports).** *(forge)*
- **TWO separate cassette servers on TWO ports**, started separately in `gate.ts`, each behind its own env var: the **perception cassette** (answers the sidecar detection/scene + `/perception/caption` endpoints; the detection channel is **binary-JPEG in / JSON out**) and the existing **LLM/JSON cassette** (`OLLAMA_HOST`). Do not multiplex them on one port — the perception path's binary-JPEG content type vs the LLM path's JSON will collide. `PERCEPTION_HOST` redirected at the perception cassette; `OLLAMA_HOST` at the LLM cassette, exactly as today.

**T0.2 — Pin the `/perception/detect` cassette response schema (REQUIRED — or the whole block is bypassed vacuously).** *(proof)*
- The detect response MUST contain `tracked_objects` with at least one object carrying **`state: 'confirmed'`** AND a **non-empty `scene_summary`**. Grounding: VWM `updateScene` filters `o.state === 'confirmed'` (`visual-working-memory.service.ts:195`) before creating any entity, and the scene/VWM/caption block at `perception.gateway.ts:131` is gated on a confirmed-object scene. **If the cassette returns tentative-only objects or an empty `scene_summary`, the scene→VWM→caption block is silently skipped and P1/P3 go green vacuously.** Make a non-empty confirmed `tracked_objects` array + non-empty `scene_summary` a hard T0 fixture invariant.

**T0.3 — Inbound WebSocket camera stub.** *(forge / meridian)*
- An inbound camera client in `test/gate/` that pushes a dummy JPEG to `/ws/perception` to **trigger `handleFrame`** (unlike the outbound-only LLM cassette, perception needs an inbound trigger; the real gateway then drives the real path).

**T0.4 — Caption-settle barrier (NEW, Round 2, build-gating R-new-1).** *(proof, meridian)*
- `requestVlmCaption` is **fire-and-forget**; `lastVlmCaption` lands on a *later* frame, gated by a 5s cooldown + scene-change predicate. Without sequencing, P2/P4 either flake or pass vacuously (no caption ever in the prompt). The P2/P4 fixture MUST:
  1. Inject a **scene-change frame** to arm the caption request.
  2. Deterministically **await caption-fetch completion + the `captionInFlight` (in-flight) flag clear** — not a wall-clock sleep.
  3. Inject a **second frame**, then the text turn.
- **T0 acceptance check (assert in T0, not just T4):** "`/perception/caption` received a hit" — the perception cassette must record that its caption endpoint was actually called during the settle sequence. If it was never hit, the barrier is misbuilt and downstream P2/P4 caption assertions are untrustworthy.

**T0.5 — Frame pacing.** *(proof)*
- Injected frames must be spaced **> `MIN_FRAME_INTERVAL_MS` (66ms)** and the harness must **await the gateway `processing` flag clear** between injected frames. Back-to-back frames inside the min-interval are dropped by the gateway; a dropped "novel" frame makes P1a/P1c non-deterministic.

**T0.6 — Caption-lesion mode.** *(forge)*
- The perception cassette's `/perception/caption` endpoint has a lesion mode (returns "unavailable") for P6 — so the lesion fixture can inject **detections-only** and prove she does not fabricate a caption she cannot generate.

**T0.7 — Reset endpoints wired into the gate hermeticity block (NEW, Round 2).** *(sentinel)*
Two new controller endpoints, added to the gate's hermeticity/reset block alongside `/api/metrics/latent-reset`:
- **`POST /metrics/episodic-reset`** — inject `EpisodicMemoryService` into `MetricsController`, call `clear()` (zeros the in-memory ring) **AND** `TRUNCATE episodic_memory_checkpoint`. Grounding (finding M, sentinel): `clear()` zeros only the in-memory buffer; the TimescaleDB checkpoint is re-hydrated on backend restart (`episodic-memory.service.ts:120-135`), so without the TRUNCATE a backend restart between phases contaminates P3 cross-run.
- **`POST /metrics/perception-reset`** — `TRUNCATE visual_object_embeddings` **AND** clear the VWM in-memory entity Map. Grounding (finding 4, sentinel): `visual_object_embeddings` rows and Neo4j WORLD `:VisualObject` nodes from synthetic frames **accumulate across runs** — VWM has no `clear()` today. Without this, P1c/P3 surprise/novelty is contaminated by prior-run entities.
- **Scene-predictor reset** (already in scope, keep): the predictor is stateful (`predictedScene` persists; first call returns surprise 0). A reset endpoint zeroes `predictedScene`. This is the determinism mechanism for P1a — **NOT** "seeded RNG" (the non-determinism is carried mutable state, not randomness — finding L).

**T0.8 — Synthetic-frame WKG-node provenance strategy (DECISION MADE: option (a), threaded override).** *(sentinel/atlas — flag for atlas sign-off)*
- **Problem:** VWM's `createUndiscoveredNode` writes `:Entity:VisualObject` WORLD-KG nodes with **hardcoded `provenance_type='SENSOR'`** (`visual-working-memory.service.ts:505`). Synthetic gate frames create real WORLD nodes that are **indistinguishable from genuine sensor events** — a data-integrity hazard, not just a hermeticity one (a synthetic "cat" becomes a permanent SENSOR-grounded world fact).
- **Decision: option (a) — thread a `provenance_type` override through the cassette response into VWM node-creation.** Reasoning: option (b) (post-run cleanup query) is fragile — a crashed/aborted gate run leaves orphan synthetic SENSOR nodes that a later cleanup never reaches, and "delete by created_at window" can race real sensor writes if a real camera is attached; option (c) (accept + document) violates the Theater-prohibition spirit (a never-seen object becomes an asserted world fact) and would corrupt the WKG census T1 is trying to make honest. Option (a) makes the synthetic provenance **truthful at write time**, survives crashes, and the `perception-reset` TRUNCATE (T0.7) then cleans up cleanly by querying `WHERE n.provenance_type = 'GATE_SYNTHETIC'`.
- **Build shape (kept minimal — this is the one sanctioned prod-code touch in T0, and it is provenance-truthful, not a `GATE_MODE` branch):**
  - **ATLAS RULING (2026-06-13, signed off — build to this exactly):** use a **distinct `synthetic: true` boolean property, NOT a `provenance_type` enum value.** The synthetic node **keeps `provenance_type='SENSOR'`** (and `confidence=0.40`, unchanged); the `synthetic:true` boolean is the sole discriminator. `provenance_type` is a *trust tier* consumed numerically (base-confidence + per-source decay rate, `provenance.types.ts:20-95`, `confidence-decay.service.ts:126-189`); a value meaning "fake" has no honest place on that axis and would be a latent trap the moment SENSOR's decay rate diverges. Atlas verified: **no consolidation/promotion/confidence-decay path reads `:VisualObject`/`:Entity` WORLD nodes BY `provenance_type`** (consolidation reads the experience buffer, `update-wkg.service.ts:92-94`; decay reads provenance only inside a `CASE … ELSE`; the lone read-by-value is a cosmetic cytoscape border rule, `graphStyles.ts:334`). So `synthetic:true` + `provenance_type='SENSOR'` corrupts nothing.
  - Add an **optional `synthetic` boolean to the detection-channel DTO** the cassette returns (real sidecar omits it → absent/false, unchanged behavior). Plumb it through the detection mapping onto `SceneEntity` (the entity already carries a stable `id`/`personId`, `visual-working-memory.service.ts:50-61`).
  - In `createUndiscoveredNode` (`:499-513`), keep `n.provenance_type = 'SENSOR'` unchanged; **add** `n.synthetic = entity.synthetic ?? false`. The cassette sets `synthetic:true`; real frames leave it undefined → `false`. **This is not a `GATE_MODE` guard** — it is a data-carried value set by the cassette, analogous to how the LLM cassette sets response content. No test-only branch in `PerceptionGateway`. (If the override is threaded as a generic field per earlier wording, the synthetic value passed into the `provenance_type` slot must still be `'SENSOR'` — the synthetic fact rides the separate boolean only; do not smuggle a non-CANON string into `provenance_type`.)
  - **`perception-reset` (T0.7)** deletes synthetic nodes on the **WORLD session only**: `MATCH (n:VisualObject {synthetic: true}) DETACH DELETE n`. Atlas verified `DETACH DELETE` is isolation-sound (synthetic nodes are fresh `vobj-<uuid>` MERGEs, never targets of edges from real nodes; WORLD instance is physically separate so it cannot reach SELF/OTHER). Keep BOTH halves — the Neo4j `DETACH DELETE` **and** `TRUNCATE visual_object_embeddings` (the companion Timescale row written at `:524-528`) — or the embedding store leaks across runs.

**T0.9 — Discharge "labeled synthetic" through T1's `source` discriminant, NOT a frame-level flag (NEW, Round 2).** *(canon)*
- The original "the injected frame must be labeled synthetic in provenance" is discharged at the **episode** layer, not the frame layer: a synthetic visual episode carries `source='perception'` (T1) and the **invariant that synthetic frames never set `speakerIsGuardian=true`** (the gate camera stub has no `currentTurnContext`, so the `speakerId`/`speakerIsGuardian` spread at `decision-making.service.ts:1434-1437` is omitted — verified). A frame-level synthetic flag is explicitly **rejected**: it would require a `PerceptionGateway` prod-code branch, breaking the no-prod-change rule. The Theater-prohibition guarantee is: a seen-fact carries `source='perception'`, never inherits GUARDIAN provenance, and a synthetic seen-fact never masquerades as guardian-confirmed because `speakerIsGuardian` is structurally absent.

**T0 invariants (recap):** `PerceptionGateway` receives **no `GATE_MODE` guards / no test-only branches**. The one sanctioned prod-code change is the **data-carried `synthetic` boolean override** in T0.8 (a value, not a mode; atlas-signed-off 2026-06-13). Everything else is external (two cassette servers + inbound WS stub + caption-lesion + reset endpoints + host env redirection).

- **Dependency:** none. Build first.
- **Live smoke during T0:** confirm whether a salient visual frame stores a visual episode through the **real** path. This is where F2 gets empirically grounded — but **the smoke must inject into an idle (drive-cold) backend** (finding B): a passing smoke is a false positive if drives were already warm from conversation (`computeAttention`/`computeArousal` read drive averages, `:2438-2459`), so a drive-cold backend is the only honest test that the new `sceneSurprise→attention` term (T1/F2(a)) actually opened the encode gate.

## Phase 1 — Perception becomes recallable memory

### T1 — Multimodal episode write: store what she saw, with honest provenance
*(owner: `opus-agent`; `cortex` consults on Episode shape + the cycle-ordering refactor; **`canon` sign-off on the source discriminant + per-sub-field provenance before write**)*

> **BLOCKED-until precondition (NEW, Round 2, build-gating R-new-6).** **`sceneSurprise → input.attention` must be wired before T1 can store a salient-but-calm visual episode** — and it is NOT wired today. This is the load-bearing change of the ticket. See T1.0 below; T1's P3/P4 payoff is unreachable until it lands. Do not mark T1 green on a fixture where drives happened to be warm — the T0 drive-cold smoke is the forcing test.

**T1.0 — Make `sceneSurprise → input.attention` real (cycle-ordering refactor).** *(luria, ashby, cortex)*
- **The defect (verified):** `encode()` at `decision-making.service.ts:1426-1440` passes `attention`/`arousal` derived **only** from drives (`computeAttention` `:2438-2443`, `computeArousal` `:2454-2459`). Scene surprise is computed *later* in the same cycle, at `routeScenePredictionErrors` (`:1867`) — **after** the encode call. So frame N's surprise cannot reach frame N's encode gate; a salient-but-calm novel frame fails the 0.15 gate structurally.
- **The refactor:** compute scene errors **once, early** in the cycle (before the `encode()` call site), **cache `totalSurprise`** (the aggregate from `scene-prediction.service.ts:135-140`), and:
  1. **Fold the cached `totalSurprise` into the encode-attention term** — `attention` becomes `max(computeAttention(driveSnapshot), saliencyTerm(cachedSceneSurprise))`. The encode gate is **already an OR**, so this is an additional admission path, not a new AND-gate (ashby — an AND would drop the salient-but-calm episode, the exact P3/P4 demo).
  2. Have **`routeScenePredictionErrors` consume the cached value** rather than recomputing. **Do NOT double-advance `updatePredictions`** — it runs once inside the predictor's compare method (`scene-prediction.service.ts:150`), mutating `predictedScene`. If the early compute calls the same method and `routeScenePredictionErrors` calls it again, predictions advance twice per frame and surprise is wrong on the next frame. Split the predictor's "compute errors" (pure) from "advance predictions" (mutating), or compute once and pass the cached `SceneComparisonResult` to the router.
- **Salience feeds the attention channel ONLY — never Curiosity/Anxiety (ashby, load-bearing).** The new term raises `input.attention` for the encode gate. It must **not** also feed the drive outcomes (Curiosity/Anxiety already get scene surprise via `routeScenePredictionErrors`). If the salience term also raised those drives, the perception→drive→perception loop would be **relocated, not broken** — the rumination loop (finding I) would re-form through the attention edge. Keep arousal as an `ageWeight`/consolidation weight, not a second admission gate.
- **Wording fix (luria):** the salience term is **"floored at 0.05, with familiarity decay from P1c"** — NOT "thresholded for habituation." A threshold is not habituation; the floor prevents a fully-familiar scene from contributing negative attention, and the familiarity decay (T4/P1c mechanism) is what makes the term diminish on re-exposure.
- Add this cycle-ordering change to T1's **blast-radius note** (it moves the scene-error compute earlier in `runCycle`; audit anything between the old and new compute sites that reads `predictedScene`).

**T1.1 — `source` — a REQUIRED, guarded discriminant (NOT optional).** *(canon, cortex, vox)*
- `Episode`/`EpisodeInput` have **no source field today** (`decision-making.types.ts:53-145`, verified). Per CANON Std 1, `source` must be **required and guarded** — a conversation episode is `source='conversation'`, a vision-dominant episode is `source='perception'` — else P4's "seen-not-told" is unfalsifiable. The grounding taxonomy (GROUNDED/UNKNOWN/LLM_ASSISTED) has no SEEN/PERCEPTION value today; T1 adds the experiential value the recall surface reads.
- **Deserialization shim (NEW, Round 2).** At `episodic-memory.service.ts:125-129`, pre-T1 checkpoint rows deserialize via `JSON.parse(...) as Episode` and have no `source`. Add `ep.source ??= 'legacy'` **before the cast** at `:129`. Use an explicit **`'legacy'` (or `'unknown'`) sentinel — NOT `'conversation'`** — so P4's `source !== 'conversation'` (and `source === 'perception'`) assertions are not satisfied vacuously by a back-filled default. (`'legacy'` rows are neither `'conversation'` nor `'perception'`; P4 asserts `=== 'perception'` positively.)
- The `episodic_search` tool currently returns a hardcoded `provenance:'medium_trust'` for every episode (`tool-registry.ts:323`) — T1 makes provenance derive from `episode.source` (see T2).

**T1.2 — `visualContext` with per-sub-field provenance.** *(vox, atlas, canon)*
- Add `visualContext: { caption?, sceneLabels?[], personIds?[], faceCount? }` populated at the encode call site (`decision-making.service.ts:1426-1440`) from `frame.raw['scene_description']`, scene objects, and recognized person ids. A vision-dominant `inputSummary` should include the caption, not just `[VISUAL_INPUT] entities: …` (`process-input.service.ts:322-326`).
- **`visualContext` mixes three provenance tiers** — `caption` = LLM_GENERATED (Moondream2), `sceneLabels` = SENSOR (YOLO), `personIds` = INFERENCE. To prevent provenance-laundering at recall:
  - **`caption` carries its OWN required, typed `provenanceSource` sub-field** (e.g. `{ caption: string, provenanceSource: 'LLM_GENERATED' }`) — REQUIRED whenever `caption` is present, not narrative-only. A recalled VLM caption must never surface as experiential-GROUNDED.
  - **`personIds` carries an explicit per-sub-field provenance tag = `INFERENCE`** (typed, not a comment). T1's `personIds` is isolation-clean (in-process ring, not WKG; follows the shipped `speakerId` precedent — verified by atlas in Round 2), but its INFERENCE provenance must be machine-readable for the WS5.5 consolidation path that will later read it.

**T1.3 — Blast radius + pre-T1 rows.** *(cortex)*
- `Episode`/`EpisodeInput` live in `@sylphie/shared` — adding a required `source` touches **every constructor** of these types. Audit all call sites; provide a migration default only where the source is genuinely known (the conversation-encode site sets `'conversation'`; do **not** default-stamp `'conversation'` onto an unknown — that is what the `'legacy'` shim is for at deserialization).
- T2's read path must treat absent `visualContext` (pre-T1 rows) as "text episode," not crash or mislabel.

**T1.4 — Consolidation→visualContext DEFERRED to WS5.5 (verbatim stub-inventory entry required).** *(learning)*
- `convertToSemantic` reads only `inputSummary`/`actionTaken`, and `EXTRACTION_PROVENANCE` is a hardcoded INFERENCE constant, not `episode.source`. Extending it is a WKG-gain question co-dependent with the §2.8 leak and T5 promotion work — **DEFERRED to WS5.5.**
- **Add this verbatim to `sylphie-stub-inventory.md`:** *"WS5 T1 visual episodes are recall-only. `visualContext` (caption/sceneLabels/personIds) is NOT read by consolidation (`convertToSemantic`); visual episodes contribute ZERO to the WKG semantic census; `EXTRACTION_PROVENANCE` remains a hardcoded INFERENCE constant, not derived from `episode.source`. No log distinguishes a visual episode from a text episode in the consolidation path. WS5.5's first regression test: a `source='perception'` episode, once consolidated, produces a WKG node whose provenance derives from `episode.source` (SENSOR for sceneLabels / LLM_GENERATED for caption), not the INFERENCE constant."*

- **Dependency:** T0. **Shape coupled to F2** (T1.0 — the salience term must be wired or salient-but-calm frames never store, and P3/P4 are unreachable).
- **CANON:** Provenance-required (Std 1) — visual episodes carry `source='perception'`; they are *seen*, not *told*, and never inherit GUARDIAN provenance. No graph-isolation concern — episodic memory is the in-process ring, NOT the WKG (`episodic-memory.service.ts:2-8`).

### T2 — Multimodal episodic recall: make "what did you see?" work
*(owner: `opus-agent`; `cortex` on retrieval scoring; `ashby`/`skinner` on alpha + breaker)*

The `episodic_search` tool (`tool-registry.ts:91` — **the tool is `episodic_search`, NOT `recall_memory`**; the Round-1 plan misnamed it) calls `queryByContext` (`tool-registry.ts:320`) but is throttled by the SHA-fingerprint Jaccard. `queryByContext` has **TWO callers** — the recall tool (free text) AND `process-input.service.ts:134` (passes the SHA `contextFingerprint`). Mutating the match key in place would silently break the per-cycle lookup (returns `[]`, logs "0 similar episodes" — looks normal). **Do NOT mutate in place — split** (finding G):

**T2.1 — Split the query method.** *(cortex)*
- **`queryByFingerprint(contextFingerprint, limit)`** — the existing SHA-Jaccard behavior (`episodic-memory.service.ts:293-324`), kept **verbatim**, retargeted at the `process-input.service.ts:134` caller. Its `ageWeight desc` sort (`:308-312`) is **unchanged**.
- **`queryByContent(queryText, limit)`** — NEW; matches on **content tokens** (caption + scene labels + inputSummary), used by `episodic_search`.
- **Update `IEpisodicMemoryService`** to expose `queryByContent` (and keep `queryByFingerprint`/`queryByContext` as the interface requires).

**T2.2 — Re-derive the content threshold as an additive named constant.** *(cortex)*
- `CONTEXT_SIMILARITY_THRESHOLD = 0.70` is calibrated for SHA Jaccard; an NL-query-vs-caption Jaccard ≈ 0.11, so reusing 0.70 makes P4 fail by construction. **Leave `CONTEXT_SIMILARITY_THRESHOLD=0.70` intact** (still used by `queryByFingerprint`); introduce a **separate additive named constant** for `queryByContent`. Pick it empirically against the P4 fixtures (cassette caption "a cat on the windowsill" vs query "did you see a cat earlier?") — **record the measured Jaccards in the ticket.** Calibration step, not a guess.

**T2.3 — Surface caption + per-episode provenance.** *(cortex, forge)*
- Surface `visualContext.caption` in the tool's returned episode summary (`tool-registry.ts:325-330`).
- **Move `provenance` from the tool level to per-episode**, derived from `episode.source` (+ the caption sub-field's `provenanceSource` from T1) — **replacing the hardcoded tool-level `'medium_trust'`** at `tool-registry.ts:323`. A `source='perception'` episode surfaces experiential provenance; its caption surfaces as LLM_GENERATED, never as experiential-GROUNDED.

**T2.4 — ageWeight live-decay fenced to a recall-local transform (IN-SCOPE for T2).** *(cortex, learning)*
- `queryByContent` must apply a **live recency decay** so a stale high-attention episode does not outrank a fresh moderate visual one (P4's "did you see a cat **earlier**?" requires recency to win; without it, frozen encode-time `ageWeight` ordering is wrong-by-construction once visual episodes carry scene-surprise-driven attention).
- **FENCE (NEW, Round 2):** the decay is a **recall-local transform computed inside `queryByContent` only** — at the sort comparator, apply `effectiveWeight = ageWeight * recencyDecay(now - timestamp)`. **Do NOT mutate the stored `episode.ageWeight`**, and **do NOT touch the consolidation reads** (`consolidation.service.ts:108,145` read stored `ageWeight` for candidate selection — mutating it would corrupt consolidation). **`queryByFingerprint`'s sort stays unchanged** (frozen `ageWeight desc`). Leave exactly **one comment at the `queryByContent` sort site** explaining the transform is recall-local-only.
- If the decay turns out non-trivial during build, escalate as an Open fork rather than silently shipping frozen ordering.

**T2.5 — Mood-congruent retrieval (alpha) + rumination circuit-breaker.** *(ashby, skinner)*
- Fold `mood-congruent-episodic-retrieval` in here (drive-cosine blend into the recall score — same change site). **Alpha is a loop-gain parameter, not a free tuning call.**
- **alpha ship value = `0.20`** (ceiling `0.25`), as a **single named constant**. `alpha=0.25` is only valid as the triple {F2→(a) phasic event-salience [T1.0], bounded alpha, rumination breaker present}. With T1.0 wired, ship 0.20.
- **Rumination circuit-breaker (ashby's spec, REQUIRED — CANON prescribes one; absent today):**
  - A **sliding-window retrieval-diversity detector**: over the last 10 `queryByContent` retrievals, if **≥8/10 are mood-congruent AND ≤3 distinct episode IDs** appear → **trip**.
  - On trip: **force `α → 0` for the next K=3 retrievals**, **write NOTHING to drives** (Std 6 — no self-modification of evaluation; the breaker must not itself move drives), and **emit a gate-assertable `RUMINATION_BREAKER_TRIPPED` event**.
  - The breaker exists because the perception→drive→perception loop closes through the **arousal encoding gate + mood-congruent retrieval** (finding I): scene-surprise → Curiosity/Anxiety↑ → arousal↑ → encode gate opens → visual episode stored → mood-congruent retrieval favors it while still aroused → re-injected → re-excitation. The T1.0 "salience feeds attention only" rule breaks the encode-side edge; the breaker bounds the retrieval-side edge.

- **Dependency:** T1 (nothing to recall until visual content is stored). **The load-bearing recall half of the thesis.**

## Phase 2 — Prove it (the WS5 gate rows)

### T4 — WS5 gate rows
*(owner: `mythos` defines, `opus-agent` builds harness; `drive`/`scout` on P1c familiarity; `meridian` on P2/P4 prompt-pinning)* Depends on T0–T2. All require the T0 HTTP-boundary seam + inbound camera stub. **P5 is removed from WS5** (moves to WS5.5 with T3).

| Row | Assertion | Hermetic measurement |
|---|---|---|
| **P1a — scene-surprise moves curiosity+anxiety** | **Ordering: reset → prime-frame (surprise 0) → novel-frame.** Assert **Curiosity AND Anxiety** deltas non-zero/positive on the **novel** frame (the second), and a `scene-prediction` outcome with `sceneSurprise > 0.05`. **Never assert on frame 1** (first call after reset returns surprise 0 by construction). | Two sequential injected frames (T0.5 pacing). Drive deltas off `/drives` (gate already polls it, `gate.ts:46`); `ACTION_OUTCOME` event for `actionId:'scene-prediction'`. **Scene-predictor reset** before the row (T0.7) — NOT seeded RNG (carried state, not randomness — finding L). |
| **P1b — unknown-person moves social** | Inject a frame with `frame.raw['unknown_person_count'] > 0`; assert a **`UnknownPersonPressure`** outcome and a positive **Social** delta. **Note:** `UnknownPersonPressure` ALSO moves Curiosity — so keep `unknown_person_count=0` on the P1a/P1c surprise-comparison frames, else the unknown-person path contaminates the curiosity delta being attributed to scene-surprise. | Separate outcome (`decision-making.service.ts:1894-1905`). This is the **only** path that moves Social — `scene-prediction` does not (finding K). |
| **P1c — habituation (BLOCKED-until familiarity mechanism)** | Re-inject the **SAME IDENTITY under a FRESH `trackId`** (`personId` else `label`) after P1a; assert the second surprise is **strictly smaller** than the first. | **BLOCKED-until precondition — see P1c spec below.** |
| **P2 — perception changes the response** | Inject frame with known caption ("a red mug on the table") via the **caption-settle barrier (T0.4)** → text turn "what do you see?"; assert response references caption tokens and is NOT falsely GROUNDED on a never-taught fact. | **Reconcile the two scene-injection paths (NEW, finding 3):** `buildFlatContext` injects "What I see:" **unconditionally** (`deliberation.service.ts:838-843`), whereas the WM path's SCENE candidate is **evictable** (`working-memory.service.ts:602-610` token-budget pop). **T4 must assert which path the gate backend actually runs.** If WM path: eviction-exempt the SCENE min-slot OR size the fixture small + assert `sourceCounts.SCENE ≥ 1`, AND reset `residualActivation` (else survival is non-deterministic). **Assert the caption substring on the replay-HIT `TapeEntry.key`, normalized** (lowercased + whitespace-collapsed per `cassette.ts:116`) — closes the byte-identical-prompt theater hole. |
| **P3 — multimodal episode stored** | After a salient injected frame (drive-cold, so the T1.0 salience term is what opens the encode gate), assert episodic memory holds an episode whose `visualContext.caption`/`sceneLabels` match the injected frame AND whose **`source='perception'`**. | New read surface exposing recent episode `visualContext` + `source`. Gate reset uses **`POST /metrics/episodic-reset`** (T0.7 — `clear()` + `TRUNCATE episodic_memory_checkpoint`). Proves T1. |
| **P4 — multimodal recall works** | Inject frame (caption "a cat on the windowsill") via the caption-settle barrier → later text turn "did you see a cat earlier?"; assert the response recalls it AND provenance marks it **experiential (`source='perception'`)**, not guardian-told and not vacuously-`'legacy'`. | Drives the `episodic_search`→`queryByContent` path (T2). Same prompt-path reconciliation + normalized `TapeEntry.key` caption-substring assertion as P2. The headline "multimodal episodic memory she can recall" done-state, made provable. |
| **P6 (lesion) — perception survives LLM disconnect** | Under `GATE_MODE=lesion`, inject a **detections-only** novel-object frame (caption withheld via the `/perception/caption` lesion mode, T0.6); assert drives still move (scene-prediction is LLM-independent) AND she does not fabricate a caption she cannot generate. | Folds into the existing lesion run. The caption-fallback half asserts the **absence of a fabricated caption directly on the response** (not on an internal gateway fallback line). Proves perception→drive coupling is not LLM-dependent. |

**P1c — full spec (BLOCKED-until precondition).** *(scout, drive, skinner)*
> **BLOCKED-until:** P1c **MUST NOT ship until the predictor familiarity mechanism exists.** Hard WS5 close-criterion, not optional — a vacuous P1c green is worse than a red one.
- **The defect (verified, strong Round-2 convergence):** the IoU tracker assigns a **fresh monotonic `trackId`** to any unmatched detection on re-entry (`tracker.py:276,284` — `TrackId(self._next_id); self._next_id += 1`). The scene predictor keys novelty on `trackId` with **flat `magnitude:1.0`** and **no familiarity/count** (`scene-prediction.service.ts:108-116`). So "same person → smaller surprise" is satisfiable by **trackId persistence alone, with zero habituation logic** — P1c would bless tracker churn, not habituation.
- **Required mechanism (must be built first):** a **familiarity-count map in the predictor, keyed on `personId` else `label`** (NOT `trackId`), with **monotone-decreasing magnitude** on repeat exposure, that **persists across the trackId gap** (the identity signal is already present: `TrackedObjectDTO.personId` and the VWM `SceneEntity.id`/`personId`, `visual-working-memory.service.ts:50-61`). On re-entry under a fresh trackId, the predictor looks up the identity key, finds prior familiarity, and emits a **smaller** magnitude than the first sighting.
- **P1c asserts:** re-inject the same `personId`/`label` under a **fresh trackId** (simulating walk-out/walk-back); assert surprise₂ < surprise₁ on the identity key — proving familiarity decay, not trackId persistence.
- If adding count/familiarity to the predictor is non-trivial, route to **scout/drive** (it is the curiosity-leak control loop; may need an ashby pass). This is the forcing function for the habituation the subsystem exists to provide.

**Why this is real, not theater:** P1a/P1b/P1c/P3/P6 assert on *internal state changes* (drive deltas, outcome emission, surprise magnitude on an identity key, episode contents + `source`, lesion behavior) independent of LLM stochasticity. P2/P4 cassette the LLM and additionally **assert the caption is actually in the prompt** (normalized `TapeEntry.key` substring on the replay HIT) — closing the byte-identical-prompt theater hole — and reconcile the unconditional-vs-evictable scene-injection paths so the assertion lands on the path the backend runs. The experiential-provenance ratio (a creation census, `test/gate/assertions.ts`) finally gets a non-conversational contributor — P3 episodes are the first seen-not-told provenance source (now with a real `source` field to count, not a hardcoded constant). The `RUMINATION_BREAKER_TRIPPED` event (T2.5) is gate-assertable should the loop-gain bound ever be exceeded.

---

## DEFERRED — WS5.5 provenance + identity-modality follow-up (NOT in WS5 per Jim, 2026-06-13)

WS5.5 bundles the identity-modality work and the WKG-provenance work that T3 kept colliding with. **Spec captured here so WS5.5 is ready to scope; `atlas` owns the schema/scoping calls.**

### T3 (deferred) — Perception-grounded face→Type-1 reflex
Resolve `latent-space-multimodal-drive-face-write` (`latent-space.service.ts:540`): write `faces` patterns to the multimodal latent index so a recognized-face context can fire a Type-1 social reflex. The review showed the original "person-scoped patterns that cannot leak by construction" claim is **false as written**; WS5.5 must build the machinery to make it true. Required:
1. **Write-time face person-scoping (forced).** A `faces` pattern must be **forced** to person-scope at write time, overriding the shared text-turn `groundingPersonId` (which can be `null`/world-scoped — and a null-scoped pattern replays GROUNDED to **anyone**, `latent-space.service.ts:891-895`).
2. **Suppress-not-demote for the faces modality.** WS4-T5's `applyPersonScopeDemotion` (`decision-making.service.ts:1100`) strips GROUNDED→UNKNOWN but **the cached reflex still fires and `responseText` plays unchanged** (`:1090-1156`). For a face→identity reflex, *the leak IS the recognition behavior* ("Welcome back, Jim!") — it survives demotion. Needs a **new suppress behavior** (no fire on person-scope mismatch).
3. **Same-id-space verification.** Confirm `person_model.personId` and the recognized-face id are the **same id space** — makes T1's `personIds` provenance a hard prerequisite.
4. **Person-agnostic `responseText`** for face reflexes.
5. **Cross-session `learned_patterns` accumulation guard / boot-time modality filter.** Boot hydration has **no modality filter** (`latent-space.service.ts:794-801`); `learned_patterns` has **no retention/prune policy** — every face pattern re-hydrates next boot, reproducing the WS1 confabulation structure (1,782 patterns) in the identity modality. **Production Standard-4 hazard.**
6. **Careful text-required-guard relaxation.** `searchMultiModal` discards all non-text matches when text didn't match (`latent-space.service.ts:391-397`) — a **silent returning person** (the literal payoff) **cannot fire** today. Relaxation must be faces-modality-scoped and paired with the suppress behavior. The face embedding is **geometry, not identity** (`face.encoder.ts:105-228`) — scoping must live in `grounding_person_id` at write time, never the embedding.
- **Keep `drives` skipped** (F4 — modulator, not match key; stale-affect replay risk).
- **Its gate row (former P5)** must be redesigned: assert the match actually fires for A AND is **actively suppressed (not merely absent)** for B. P5 must **not** claim §2.8 is closed.

### T5 (deferred) — World-fact promotion + guardian-confirmation gate (ws5-t1)
`CandidateWorldFact` staging store at ≤0.60/CANDIDATE provenance; promotion only via guardian confirmation reusing `reportGuardianFeedback(turnId,'confirmation')`. *(owner: `atlas` schema, `opus-agent` build.)*

### §2.8 WKG person-fact leak fix (deferred)
Per-hop provenance/person-scope gating. *(owner: `atlas`.)* Co-dependent with T5 — bundle.

### Consolidation→visualContext (deferred from T1)
Extend `convertToSemantic` to read `visualContext` and derive `EXTRACTION_PROVENANCE` from `episode.source` so visual episodes contribute to the WKG with honest provenance. **Stub-inventory entry required now (T1.4).** WS5.5's first regression test named in T1.4. *(owner: `learning`/`atlas`.)*

### Other deferred (cross-cutting hardening, not WS5/WS5.5-blocking)
`ungrounded-insight-regrounding-sweep`, `perception-frame-source-timeout-guards`, `perception-embedding-init-deduplication`, plus two review-surfaced hardening items: **stale-VLM-caption staleness check** ("What I see:" injects possibly-seconds-old `lastVlmCaption` fire-and-forget — she can narrate a cat that already left; finding M/vox — partially mitigated in-gate by the T0.4 caption-settle barrier, but the **production** staleness check is still owed) and **visual person-binding** (face→personId uses global `getActivePersonId()` = whoever spoke last, not who's on camera — reopens WS4-T4 thrash; finding M/vox). Both must be in the stub inventory.

---

## Build order

T0 (two cassette servers + inbound camera stub + caption-settle barrier + caption-lesion mode + predictor-reset + episodic-reset[+checkpoint TRUNCATE] + perception-reset[+VWM clear] + threaded `provenance_type` override pending atlas sign-off) → **T1** (cycle-ordering refactor wiring `sceneSurprise→attention` FIRST → `source` required + deserialization shim → `visualContext` with per-sub-field provenance → stub-inventory entry) → **T2** (split `queryByFingerprint`/`queryByContent` + content-threshold re-derive + recall-local ageWeight decay + alpha=0.20 + rumination breaker) → **T4** (P1a/P1b → P1c [BLOCKED-until familiarity mechanism] → P2/P4 [path reconciliation + caption-key assertion] → P3 → P6) → **live smoke (mythos, mandatory, covers real camera→sidecar leg)** → close.

T1 and T2 are sequential (T2 recalls what T1 stores); there is no T3 parallel branch in WS5 anymore.

**Two hard BLOCKED-until close-criteria the builder cannot ship green-vacuous:**
1. **T1.0 — `sceneSurprise→attention` cycle-ordering** must be wired and confirmed by the T0 **drive-cold** smoke before T1/P3/P4 can be green.
2. **P1c familiarity mechanism** (identity-keyed, monotone-decreasing, persists across the trackId gap) must exist before P1c is asserted — else P1c blesses trackId churn.

## Open forks (resolve in-build, not Jim-level)

- **F2 — RESOLVED to option (a).** Phasic `sceneSurprise` → **attention channel only** (T1.0), floored at 0.05 with P1c familiarity decay; never a flat frame-present flag, never arousal-as-second-gate, never also feeding Curiosity/Anxiety. Remaining sub-fork: the exact decay curve shape → **drive/skinner/luria**, resolve before T1 finalizes.
- **F2 ⇄ T2-alpha — loop-gain bound RESOLVED by ashby.** alpha ship **0.20** (ceiling 0.25), valid only as the triple {F2→(a), bounded alpha, rumination breaker}. Breaker spec in T2.5. ashby owns the bound; skinner owns the mood-perseveration/depressive-attractor risk.
- **F4 — keep `drives` skipped** (modulator, not match key). Travels with T3 to WS5.5.
- **P1c habituation mechanism — route to scout/drive** (curiosity-leak control loop; may need an ashby pass). BLOCKED-until-built per T4.
- **T2 content-threshold re-derivation** — empirical, in-build (cortex), against the P4 fixtures; record measured Jaccards.
- **T0.8 `GATE_SYNTHETIC` provenance field shape** — atlas sign-off (enum value vs distinct `synthetic:true` property); the threaded-override mechanism is decided regardless.
- **WS5.5 scoping (atlas)** — deferred T3/T5/§2.8 spec captured; schema/scoping/suppress-behavior calls are atlas's when WS5.5 opens.

## Specialist handoffs

- **mythos** — T0/T4 gate-row definition; **mandatory WS5 live smoke before close** (must cover the real camera→sidecar leg the cassette bypasses — hard close-criterion).
- **forge** — T0 two cassette servers (binary-JPEG perception + JSON LLM) + inbound `/ws/perception` camera stub + caption-settle barrier + caption-lesion mode; `source` deserialization shim; `IEpisodicMemoryService` update.
- **sentinel** — T0.7 reset endpoints (episodic-reset + checkpoint TRUNCATE, perception-reset + VWM clear); T0.8 synthetic-provenance strategy.
- **canon** — T1 `source` required-guarded-discriminant + per-sub-field `provenanceSource` sign-off before write; T0.9 "synthetic via `source`, never `speakerIsGuardian`" invariant; done-state wording (no sidecar overclaim).
- **drive / skinner / luria** — F2 decay curve; T1.0 cycle-ordering neuroscience; mood-congruent alpha within the ashby bound; P1a/P1b drive mapping.
- **ashby** — F2/T2-alpha loop-gain bound + rumination circuit-breaker spec (T2.5); T1.0 "attention-only, not Curiosity/Anxiety" rule; habituation control loop if non-trivial.
- **scout / drive** — P1c scene-predictor familiarity mechanism (identity-keyed, monotone-decreasing).
- **cortex** — Episode shape (T1), `queryByContent` scoring + threshold (T2), recall-local ageWeight decay; cycle-ordering refactor review.
- **meridian** — P2/P4 prompt-path reconciliation (WM-vs-`buildFlatContext`) + normalized `TapeEntry.key` caption-substring assertion.
- **opus-agent** — heavy builds (T1 incl. cycle-ordering refactor, T2, T4 harness).
- **atlas** — T0.8 synthetic-provenance field shape sign-off; WS5.5 only (deferred T3 face-scoping + suppress-not-demote, T5 schema, §2.8). Not otherwise in WS5.
- **learning** — T1.4 stub-inventory entry; WS5.5 consolidation→visualContext (deferred from T1).
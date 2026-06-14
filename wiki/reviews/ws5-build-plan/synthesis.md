# WS5 Build-Plan Review — Synthesis (Round 1)

**Plan under review:** `wiki/ws5-build-plan.md` (authored by mythos)
**Reviewers (14):** cortex, atlas, drive, skinner, ashby, canon, proof, forge, vox, meridian, learning, luria, scout, sentinel. Author **mythos** excluded → Phase-4 tie-breaker.
**Date:** 2026-06-13 · Round 1 of 2.

---

## PROVISIONAL VERDICT (post-Round-1): **PROCEED-WITH-CHANGES**

**Unanimous.** All 14 reviewers returned `proceed-with-changes`. No reviewer returned `blocked` at the plan level; no reviewer returned a clean `proceed`. **CANON did not plan-level-block** but set three hard ticket-gated preconditions (T1 source field, T3 confidence+scope, P5 wording).

The thesis (perception → behavior → recall, gate-provable) is sound and the gate-row *intent* is right. But the plan has **two structural defects** (T0 injects at the wrong layer; T3's core privacy claim is false as written) and a **cluster of provability gaps** that would let gate rows go green while the real path is broken. These are fixable, but several change T1/T2/T3 shape and one is a genuine scope decision (T3 disposition) for Jim.

No dissent to quote — the reviewers are mutually reinforcing, not in conflict.

---

## Convergent findings (independently hit by multiple agents)

### A. T0 injects below the gateway — bypasses the code the cassette was chosen to prove *(proof, forge, sentinel, meridian — high)*
The plan injects at `tickSampler.updateVideoDetections/updateFaces/updateScene/updateSceneDescription`, which is **downstream** of `PerceptionGateway.handleFrame`'s detection mapping, `sceneEventDetector.detectEvents`, VWM update, and caption composition (`perception.gateway.ts:96-201`). The ratified rationale for the cassette path (over a test-only inject controller) was *"it exercises the gateway's detection mapping." The chosen injection point bypasses exactly that.* proof: "the seam as specified is the inject-controller in cassette clothing." A perception path broken in `detectEvents`/VWM/caption-compose **still leaves P1/P3/P5/P6 green.**
- **forge's fix (verified):** the real seam already exists at the HTTP boundary — `PERCEPTION_HOST` is already externalized via ConfigService (`perception.gateway.ts:50-53`), exactly like `OLLAMA_HOST` for the LLM cassette. Point it at a `/perception/detect` + `/perception/caption` cassette server; the real `handleFrame` then runs. **Caveat (forge/meridian):** unlike the outbound-only LLM cassette, perception also needs an *inbound* WebSocket camera stub (a `test/gate/` client pushing a dummy JPEG to `/ws/perception`) to trigger `handleFrame`, plus a lesion-mode for the caption endpoint (for P6). Both are test-external, no prod-code change.

### B. F2 is mis-stated and load-bearing — it's an IPC-ordering problem, not a tuning call *(drive, skinner, luria, ashby, scout, cortex — high)*
The 0.15 encoding gate reads `input.attention`/`input.arousal`, which are **drive-derived averages** (`episodic-memory.service.ts:54-59,184-194`), *not* frame/perceptual salience. A visual frame's surprise reaches drives only via `routeScenePredictionErrors`, which fires **after** arbitration and crosses the drive-process IPC boundary — so the bump from frame N is not visible to frame N's encode (drive isolation). **Consequence:** a salient-but-calm novel frame fails the gate structurally (one-tick lag), and "F2 resolved empirically in T0 smoke" risks measuring the wrong thing (a passing smoke could just mean drives were already warm from conversation — scout C6).
- **Convergent fix (luria, skinner, scout, drive):** resolve F2 → **option (a)**, but the salience term must be **phasic scene-prediction surprise** (`sceneSurprise`, thresholded for habituation) feeding the **attention/novelty** channel — *not* a flat "visual frame present" flag (floods the 50-slot ring) and *not* arousal-as-second-gate. luria's neuroscience: biological encoding is novelty-gated (hippocampal comparator), dissociable from arousal; option (b) "attention-gated = the human model" is folk-neuroscience — it implements *tonic-arousal* gating and provably drops the salient-but-calm episode, which **is** the cat-on-windowsill P3/P4 demo. Keep arousal as a *consolidation/ageWeight* weight, not an admission gate.

### C. T3 "person-scoped face patterns that cannot leak by construction" is **FALSE as written** *(atlas, vox, learning, sentinel, canon, skinner — highest severity)*
The plan's central T3 claim does not hold against the actual WS4-T5 machinery (atlas, decisive, all verified):
1. **Latent match is person-blind at match time.** `searchByModality` filters only on modality; `groundingPersonId` is never consulted during cosine search (`latent-space.service.ts:286-298`). Person-scoping happens **only after** the match fires.
2. **WS4-T5 demotes, it does not suppress.** `applyPersonScopeDemotion` strips GROUNDED→UNKNOWN but **the cached reflex still fires** and `responseText` plays unchanged (`decision-making.service.ts:1090-1156`). For a text fact, losing the GROUNDED label is a defensible mitigation. For a **face→identity reflex, the leak IS the recognition behavior** ("Welcome back, Jim!") — which survives demotion.
3. **Write-time scope is shared across modalities** — a `faces` pattern inherits the text turn's `groundingPersonId`, which can be `null` (world-scoped) on a WKG-sourced/non-GROUNDED turn, and a null-scoped pattern replays GROUNDED **to anyone** (`:1620-1660`, `applyPersonScopeDemotion:895`).
4. **The face embedding is geometry, not identity** (sentinel/skinner, verified `face.encoder.ts:105-228`): 20 geometric features (bbox, blendshapes, landmark spread, head-pose). Two different people with similar geometry → near-identical vectors. "Person-scoping" cannot live in the embedding; it must be `grounding_person_id` at write time — and even then, the *match* can fire on a look-alike (skinner: the WS1 over-generalization pathology in the identity modality).
- **What T3 actually needs (atlas):** (a) `faces` patterns **forced** to person-scope at write time (override the shared scope), (b) **suppress-not-demote** on person-scope mismatch for the faces modality (a new behavior the shared `applyPersonScopeDemotion` cannot express), (c) verify `person_model.personId` and the recognized-face id are the **same id space** (makes T1's `personIds` provenance a hard T3 prerequisite, not a parallel ticket), (d) person-agnostic `responseText` for face reflexes.

### D. `searchMultiModal` text-required guard makes T3/P5 unreachable or vacuous *(atlas, skinner, ashby, proof — high)*
`searchMultiModal` discards all non-text matches when text didn't match (`latent-space.service.ts:391-397`). A **silent returning person** (face, no speech) — the literal T3 payoff scenario ("returning person → warm Type-1 greeting") — **cannot fire a Type-1 match** as written. So P5's positive leg is unreachable unless T3 relaxes the guard (a change the plan never lists, and which reopens the stale-replay hole the guard exists to close). And P5's negative leg ("same face as Person B does NOT replay GROUNDED") passes **vacuously** whenever B simply fails to match. proof: "P5 is the weakest row — it can go green while proving neither the payoff nor the privacy boundary."

### E. T3 re-accumulates `learned_patterns` cross-session → WS1 confabulation in a new modality *(learning, sentinel — high)*
T3 removes the `faces` write-skip; the boot hydration query has **no modality filter** (`latent-space.service.ts:794-801`), so every face pattern re-hydrates into the hot layer next boot — the exact structure of the WS1 confabulation (1,782 accumulated patterns). `learned_patterns` has **no retention/prune policy** (verified; only `clear()`/`clearHotLayer()` exist, both gate-time). atlas's person-scoping is orthogonal — it stops cross-**person** leaks, not cross-**session** accumulation. Needs a write-time count guard / boot-time modality filter / session-boundary eviction. This is a **production** Standard-4 hazard, not just a gate artifact.

### F. `Episode` has no `source`/provenance field → P4 "seen-not-told" is unprovable *(cortex, canon, vox, meridian, learning, luria — high)*
Verified: `Episode`/`EpisodeInput` have **no source field today** (`decision-making.types.ts:53-145`). T1 *adds* it. The `recall_memory` tool returns a hardcoded `provenance:'medium_trust'` for every episode (`tool-registry.ts:323`); the grounding taxonomy (GROUNDED/UNKNOWN/LLM_ASSISTED) has **no SEEN/PERCEPTION value**. So P4's "experiential (seen), not guardian-told" assertion has no field to read.
- **canon (Std 1):** `source` must be a **required, guarded discriminant**, not an optional tag — else P4 is unfalsifiable.
- **forge/sentinel (provenance-laundering):** `visualContext` mixes three provenance tiers — caption = LLM_GENERATED (Moondream2), sceneLabels = SENSOR (YOLO), personIds = INFERENCE. The caption sub-field needs its **own** `provenanceSource` discriminant, or a recalled VLM caption surfaces as experiential-GROUNDED (Std 1 violation at the type level).

### G. T2 mutates a shared method with a second caller + an impossible threshold *(cortex — high)*
`queryByContext` has **two callers**: the recall tool (free text) **and** `process-input.service.ts:134` (passes the SHA `contextFingerprint`). Switching the match key to content tokens in place **silently breaks** the per-cycle episodic-context lookup (returns `[]`, logs "0 similar episodes" — looks normal). Must split into `queryByFingerprint` (keep) + `queryByContent` (new). Separately, the `CONTEXT_SIMILARITY_THRESHOLD = 0.70` is calibrated for near-binary SHA-token Jaccard; a natural-language query vs a short caption Jaccards ≈ 0.11 — **far below 0.70**, so P4 fails by construction unless the threshold is re-derived. The mood-congruent alpha cannot rescue a score already below the include-gate.

### H. Frozen `ageWeight` corrupts recall ordering once visual episodes exist *(cortex, learning, scout, ashby — medium)*
`queryByContext` sorts by `ageWeight` (= encode-time attention, frozen — `episodic-memory.service.ts:200,308-312`); the `episodic-ageweight-live-decay` fix is deferred. A stale high-attention episode outranks a fresh moderate visual one — directly undercutting P4's "did you see a cat **earlier**?" (recency should win). Deferral was safe when all episodes shared one attention distribution; T1's visual episodes (scene-surprise-driven attention) make the ordering wrong by construction. Reconsider the deferral (idea doc calls the fix "straightforward").

### I. The perception→drive→perception loop closes through the encoding gate + mood-retrieval, not F4 *(ashby, skinner — high)*
F4 (keep `drives` patterns skipped) is **necessary but not sufficient**. The dominant loop: scene-surprise → Curiosity/Anxiety↑ → arousal↑ → encoding gate opens → visual episode stored (T1) → mood-congruent retrieval (T2) favors it while still aroused → re-injected to deliberation → re-excitation. **F4 touches none of these edges.** So T2's `alpha` and F2's salience term are **loop-gain parameters** needing an explicit stability bound + a rumination circuit breaker (CANON prescribes one; absent here). skinner: mood-congruent retrieval is state-dependent recall → mood perseveration → depressive-attractor on-ramp. **F2 and T2-alpha are coupled and must be decided together:** F2→(a) event-salience ⇒ alpha 0.25 OK; F2→(b) arousal-gated ⇒ alpha ≤0.10 or defer T2-mood.

### J. "Novelty" = trackId discontinuity, with no habituation *(scout — medium/high)*
`scene-prediction.service.ts:108-114`: novel = trackId not in last frame, flat `magnitude:1.0`; the predictor is one-frame persistence with no familiarity/count. A person who walks out and back gets a fresh trackId → full curiosity every time. **No habituation anywhere** → a curiosity *leak* (the fixation pathology the subsystem exists to prevent), undercutting the headline "perception keeps the autonomy curve rising." P1 can go green measuring tracker churn. Add a P1 assertion that re-injecting the same person yields *smaller* surprise.

### K. P1 is over-specified — asserts a drive the outcome doesn't move *(drive — high)*
The `scene-prediction` outcome maps to **Curiosity + Anxiety**, *not Social* (`rules.ts:165-168`). Social comes from a **separate** `UnknownPersonPressure` outcome gated on `frame.raw['unknown_person_count']` (`decision-making.service.ts:1894-1905`). "novel person → curiosity+social" is a docstring fiction not implemented in `routeScenePredictionErrors`. Split P1 into (a) `scene-prediction` → curiosity **AND anxiety** + sceneSurprise>0.05, and (b) a separate `UnknownPersonPressure` → social assertion requiring the T0 frame to set `unknown_person_count>0`.

### L. Determinism gaps will make P1/P2/P4/P6 flaky like M2 *(proof, meridian, drive — high)*
- **Scene-predictor is stateful** (`predictedScene` persists; first call returns surprise 0). No reset seam → non-hermetic. "Seeded RNG" (plan) targets the wrong failure mode — it's carried mutable state. Need a scene-predictor reset endpoint (cf. `/api/metrics/latent-reset`).
- **P2/P4 cassette keying:** the "What I see:" scene text is a budget-**pruned** working-memory candidate (`working-memory.service.ts:365-386`), not guaranteed in the prompt. If pruned, frame-present and frame-absent prompts are byte-identical post-normalization → P2/P4 pass replaying a response that **never saw the caption** (theater-passable). Must assert `TapeEntry.key` literally contains the caption substring. (meridian verified the key *does* include the system prompt — so the fix is to guarantee the scene candidate is pinned into the prompt + assert it.)
- **P6 cites an unreachable line:** the VLM-caption fallback (`perception.gateway.ts:247-248`) lives in gateway code the tickSampler seam bypasses. Split P6 into the provable half (drives move under lesion — sound) and drop/re-site the caption half; the lesion fixture must **withhold** the caption (inject detections-only), or P6 asserts a tautology.

### M. Secondary correctness *(various — medium/low)*
- **Stale VLM caption** (vox): "What I see:" injects `lastVlmCaption` (async, fire-and-forget, possibly seconds old) with no staleness check — she can narrate a cat that already left (Theater). P2 doesn't catch stale tokens.
- **Visual person binding uses global `activePersonId`** (vox): face→personId via `getActivePersonId()` = whoever spoke last, not who's on camera — reopens WS4-T4 thrash on the most sensitive channel.
- **Consolidation blind to `visualContext`** (learning): `convertToSemantic` reads only `inputSummary`/`actionTaken`; caption/sceneLabels ignored → WKG gain from visual episodes is zero unless extended; `EXTRACTION_PROVENANCE` is a hardcoded INFERENCE constant, not from `episode.source`.
- **Episodic checkpoint not cleared by `clear()`** (sentinel): `clear()` zeros only the in-memory buffer, not the TimescaleDB `episodic_memory_checkpoint` → cross-run contamination if the backend restarts between phases → P3 non-hermetic. Reset must `TRUNCATE` the checkpoint.
- **P5 must not claim §2.8 closed** (canon, Std/§4.1): §2.8 is a *separate* Type-2 WKG-grounding leak; T3+P5 close only the face-pattern-replay surface. Scope P5's wording accordingly.
- **CANON live-smoke close-criterion** (canon): the cassette deliberately bypasses camera→sidecar; the done-state language ("the perception Sylphie already runs") must not overclaim — make mythos's mandatory live-smoke cover the real camera→sidecar leg a hard close-criterion.

---

## Risk register (carried regardless of revisions)
| # | Risk | Owner | Closes in |
|---|---|---|---|
| R1 | T0 injection point must move to the `/perception/detect` HTTP boundary + add inbound WS camera stub + caption-endpoint lesion mode | forge | T0 |
| R2 | F2 → option (a) phasic sceneSurprise into attention/novelty channel; arousal → ageWeight only | drive/skinner/luria | T0 smoke → T1 |
| R3 | T3 person-scope: write-time face scoping + **suppress-not-demote** + same-id-space verify + person-agnostic responseText | atlas | T3 (BLOCKED until) |
| R4 | T3 cross-session `learned_patterns` accumulation guard / boot modality filter | learning/sentinel | T3 |
| R5 | T3 face reflex unreachable via text-required guard; relaxing it reopens stale-replay | atlas/ashby | T3 / P5 |
| R6 | `Episode.source` required guarded discriminant; per-sub-field provenance on `visualContext.caption` | canon/forge | T1 (BLOCKED until) |
| R7 | T2 split `queryByContext` into fingerprint/content callers + re-derive the 0.70 threshold | cortex | T2 |
| R8 | F2/T2-alpha coupled loop-gain → stability bound + rumination circuit breaker | ashby/skinner | T1/T2 |
| R9 | Scene-predictor reset endpoint; P2/P4 cassette-key caption assertion; P6 caption-withheld fixture; checkpoint TRUNCATE on reset | proof/meridian/sentinel | T4 |
| R10 | P1 split (curiosity+anxiety vs separate unknown-person→social); add habituation/repeat-decay assertion | drive/scout | T4 |
| R11 | ageWeight-live-decay deferral unsafe once visual episodes exist — reconsider | cortex/learning | T2 |
| R12 | P5 wording must not claim §2.8 closed; done-state must not overclaim sidecar coverage | canon | T4/close |

---

## The load-bearing decision for Jim
Most items above are required *changes* routed to owners (forge/atlas/cortex/drive). **One is a genuine scope decision: T3's disposition.** As written T3 is the riskiest ticket (false privacy claim, geometry-not-identity embedding, cross-session accumulation, unreachable-or-vacuous P5) and needs substantial *new* machinery (suppress-not-demote, write-time face scoping, accumulation guard, careful text-guard relaxation) — arguably its own mini-stream, like T5 was. WS5's headline payoff (multimodal **recall**: T0/T1/T2) does not depend on T3. → surfaced to Jim.

# WS5 Build-Plan Review — VERDICT

**Plan:** `wiki/ws5-build-plan.md` (revised post-Round-1) · **Reviewers:** 14 + mythos (author/reviser) · **Rounds:** 2 · **Date:** 2026-06-13
**Full record:** `synthesis.md` (Round 1), this file (Round 2 + verdict).

---

## VERDICT: **PROCEED-WITH-CHANGES**

**Round-2 stances:** 3 `proceed` (atlas, vox, learning) · 11 `proceed-with-changes` · **0 blocked**.
**CANON moved from BLOCKED → proceed-with-changes** once T3 was deferred — its three Round-1 preconditions are satisfied. No reviewer blocks. No dissent.

The plan is **approved to build** once the Round-2 change-list below is folded into the ticket specs. **None of the changes is a plan-level redesign or a new scope decision for Jim** — they are build-time implementation specs and fixture requirements, each routed to an owner. Two rounds reached convergence: Round 2 verified the Round-1 fixes landed (they did, all verified against code) and surfaced a tighter second-order list plus a few genuinely new findings that only became visible once the injection mechanism was concretized.

---

## What Round 2 verified resolved (Round-1 fixes confirmed against code)
- **T0 HTTP-boundary injection** (proof, forge): the seam genuinely exercises the real `handleFrame` → `detectEvents`/VWM/caption path; inbound `/ws/perception` stub triggers it; `PerceptionGateway` needs no prod-code change. The structural defect is fixed.
- **T3 deferral** (atlas): the WS5.5 spec faithfully captures every load-bearing T3 requirement; T1's `personIds` in WS5 is **isolation-clean** (in-process ring, not WKG; follows the shipped `speakerId` precedent; consolidation deferred so nothing reaches a graph store).
- **`Episode.source` required discriminant** (canon, cortex, vox): verified absent today; the required-guarded design makes P4 falsifiable; CANON's Std-1/4 preconditions met.
- **T2 `queryByContext` split + threshold re-derive** (cortex): the two-caller split is correct and verified-necessary.
- **F2 → option (a)** (luria, skinner, ashby): the novelty-gating model is the right neuroscience and breaks the encode-side affect bias.
- **P1 split, P5 removal, P6 detections-only, predictor-reset, checkpoint-TRUNCATE** (drive, proof, sentinel): all correct in substance.

## New findings (Round 2 — only visible once the mechanism was concrete)
1. **Caption is async / one-frame-lagged** (proof, meridian, sentinel, vox — high). `requestVlmCaption` is fire-and-forget; `lastVlmCaption` lands on a *later* frame, gated by a 5s cooldown + scene-change. P2/P4 need a **caption-settle barrier** and a ≥2-frame fixture, or they flake / pass vacuously.
2. **WM SCENE candidate is evictable** (meridian, proof — high). The min-slot guarantee is revoked by the token-budget pop (`working-memory.service.ts:602-610`); SCENE is first-to-evict by priority. "Pin the scene candidate" has **no mechanism yet** — must eviction-exempt min-slot items *or* size the fixture small + assert `sourceCounts.SCENE ≥ 1`. Also reset `residualActivation` or the survival is non-deterministic.
3. **Two scene-injection paths diverge** (meridian). WM path (prunable) vs `buildFlatContext` (unconditional, `deliberation.service.ts:843`). T4 must assert which the gate backend runs.
4. **VWM persistent state not reset** (sentinel — high). `visual_object_embeddings` + Neo4j WORLD `:VisualObject` nodes from synthetic frames accumulate across runs (no VWM `clear()`); nodes are hardcoded `provenance_type='SENSOR'`, indistinguishable from real sensor events. Needs a perception-reset endpoint + a synthetic-provenance strategy for VWM-created WKG nodes (data-integrity, not just hermeticity).
5. **P1c blesses trackId-churn** (scout, drive, skinner, proof, luria — strong convergence). The IoU tracker assigns a fresh monotonic `trackId` on re-entry (`tracker.py:276,284`), and novelty is keyed on trackId with flat `magnitude:1.0` — so "same person → smaller surprise" is satisfiable by trackId persistence with **no habituation logic**. P1c must re-inject **same identity under a fresh trackId**, assert on a `personId`/`label` familiarity key, and be **BLOCKED-until** the familiarity mechanism exists (the identity signal is already on `TrackedObjectDTO` and in VWM).
6. **`sceneSurprise → input.attention` is not wired + cycle-ordering** (luria, ashby — high). Encode (`:1426`) runs *before* scene-surprise is computed in-cycle (`:1867`); attention is drive-derived only. F2(a) requires a **cycle-ordering refactor**: compute surprise once early, cache, feed both the encode-attention term and `routeScenePredictionErrors` (avoid double-advancing `updatePredictions`). ashby: the salience term must be a **new attention-channel input that does NOT also raise Curiosity/Anxiety**, else the loop is relocated, not broken.
7. **Rumination circuit-breaker — ashby specified it.** alpha ship value **0.20** (ceiling 0.25); breaker = sliding-window detector on **retrieval diversity** (≥8/10 mood-congruent AND ≤3 distinct episode IDs → trip), force α→0 for K=3 retrievals, write nothing to drives (Std 6), emit a gate-assertable `RUMINATION_BREAKER_TRIPPED` event.

---

## Consolidated change-list (fold into ticket specs before build; owner in brackets)

### T0 (forge / sentinel / proof / opus-agent)
- Pin the `/perception/detect` cassette response schema (`tracked_objects` + non-empty `scene_summary`, `state:'confirmed'`) or the scene/VWM/caption block is bypassed at `perception.gateway.ts:131` and P1/P3 go green vacuously. **[proof]**
- **Caption-settle barrier:** fixture injects a scene-change frame to arm the caption, deterministically awaits caption-fetch + `captionInFlight` clear, then a second frame, then the text turn. Make "`/perception/caption` received a hit" a T0 acceptance check. **[proof, meridian]**
- Two separate cassette servers/ports (binary-JPEG perception vs JSON LLM); env var + separate startup in `gate.ts`. **[forge]**
- Frame pacing >66ms (`MIN_FRAME_INTERVAL_MS`) + await `processing` clear between injected frames. **[proof]**
- New reset endpoints wired into the gate hermeticity block: `POST /metrics/episodic-reset` (inject `EpisodicMemoryService` into `MetricsController`, `clear()` + `TRUNCATE episodic_memory_checkpoint`) and `POST /metrics/perception-reset` (`TRUNCATE visual_object_embeddings`, clear VWM in-memory Map). **[sentinel]**
- **Decision required before T0 code:** synthetic-frame WKG nodes — pass a `provenance_type` override (e.g. `GATE_SYNTHETIC`) through the cassette response into VWM node-creation, or accept accumulation + document in stub inventory. (VWM hardcodes `'SENSOR'` at `visual-working-memory.service.ts:505`.) **[sentinel/atlas]**
- Discharge T0's "labeled synthetic in provenance" through the T1 `source='perception'` discriminant + a "synthetic frames never carry `speakerIsGuardian=true`" invariant — NOT a frame-level flag (would break the no-prod-change rule). **[canon]**

### T1 (cortex / canon / opus-agent)
- **Make `sceneSurprise → input.attention` real** (cycle-ordering refactor): compute scene errors once early, cache `totalSurprise`, fold into the encode-attention term, have `routeScenePredictionErrors` consume the cached value (avoid double-advancing `updatePredictions` at `scene-prediction.service.ts:150`). Add to T1's blast-radius note as a cycle-ordering change; T0 idle-backend smoke confirms a drive-cold salient frame encodes. **[luria, ashby, cortex]**
- The salience term feeds the **attention channel only** and must not also raise Curiosity/Anxiety (keep it off the arousal loop). The encode gate is already an OR — no AND. **[ashby]**
- Fix wording: "floored at 0.05, with familiarity decay from P1c" — not "thresholded for habituation" (threshold ≠ habituation). **[luria]**
- `source` deserialization shim at `episodic-memory.service.ts:129` (`ep.source ??= 'conversation'` before cast) for pre-T1 checkpoint rows; pick an explicit `'unknown'`/`'legacy'` sentinel so P4's `source !== 'conversation'` isn't satisfied vacuously. **[forge, vox]**
- Make `provenanceSource` a **required** typed sub-field on `visualContext.caption` (+ explicit per-sub-field tag on `personIds` = INFERENCE), not narrative-only. **[vox, atlas, canon]**
- Stub-inventory entry (verbatim) for the consolidation→visualContext deferral: visual episodes are recall-only, contribute zero to the WKG census, no log distinguishes them; WS5.5's first regression test named. **[learning]**

### T2 (cortex / ashby / opus-agent)
- **Fence ageWeight live-decay to a recall-local transform** inside `queryByContent` — do NOT mutate stored `ageWeight` or touch consolidation reads (`consolidation.service.ts:108,145`); `queryByFingerprint` sort unchanged. One comment at the sort site. **[cortex, learning]**
- `queryByContent` threshold = additive named constant; leave `CONTEXT_SIMILARITY_THRESHOLD=0.70` intact. Record measured Jaccards. **[cortex]**
- Fix tool-name: the tool is `episodic_search` (`tool-registry.ts:91`), not `recall_memory`; retarget `executeEpisodicSearch:320`; move `provenance` per-episode (derived from `episode.source`), replacing the tool-level `'medium_trust'`. Update `IEpisodicMemoryService` to expose `queryByContent`. **[cortex, forge]**
- alpha ship **0.20** (ceiling 0.25) as a named constant + the rumination circuit-breaker (ashby's spec) with a gate-assertable trip event. alpha=0.25 only valid as the triple {F2→(a), bounded alpha, breaker}. **[ashby, skinner]**

### T4 (mythos / drive / scout / opus-agent)
- **P1c:** re-specify as identity-keyed (same `personId`/`label` under a fresh `trackId`) and **BLOCKED-until** the predictor familiarity mechanism exists (familiarity-count map keyed on `personId` else `label`, monotone-decreasing magnitude, persisting across the trackId gap). Hard WS5 close-criterion, not optional. **[scout, drive, skinner]**
- **P1a:** explicit ordering reset → prime-frame (surprise 0) → novel-frame; never assert on frame 1. **P1b:** note `UnknownPersonPressure` also moves Curiosity — keep `unknown_person_count=0` on surprise-comparison frames. **[drive, proof]**
- **P2/P4:** assert the caption substring on the **replay-HIT key** (live invariant), normalized (lowercased/whitespace-collapsed per `cassette.ts:116`); reconcile the WM-path vs `buildFlatContext` divergence — assert which path the gate backend runs. **[meridian]**

---

## Risk register (carried into build)
Every item above is owned and scoped. The three highest-leverage, build-gating items: **(R-new-1) caption-settle barrier** (T0), **(R-new-5) P1c identity-keying + familiarity mechanism** (T4, blocked-until-built), **(R-new-6) sceneSurprise→attention cycle-ordering** (T1). The one item needing a **decision before T0 code**: synthetic-frame WKG-node provenance strategy (sentinel).

## Process note
Do not start T0 build off this PROCEED-WITH-CHANGES verdict until the change-list lands in the ticket specs (skill rule). Recommended: one final author pass (mythos) folding the Round-2 list into T0/T1/T2/T4, then build.

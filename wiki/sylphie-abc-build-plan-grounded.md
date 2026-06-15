# Sylphie Vision A/B/C — Grounded Build Plan (repo-anchored)

> **Derived from `sylphie-abc-build-plan.md` (LOCKED v1.0, 2026-06-13). Companion to `wiki/cv-framework.md`.**
> This document PRESERVES every architectural decision of the original plan EXACTLY (faculties A/B/C; D1 DINOv2 ViT-L/14 1024-D; D2 Moondream2; D3 masklets-as-tracks; D4 1280→1024; build order A → (B+A.5) → C; all acceptance tests; the VRAM budget; the out-of-scope list). No architectural decision has been added, removed, or changed.
> What this document ADDS, per milestone: a **Grounded targets** block with exact repo coordinates (files, symbols, current→target, insertion points) so the work is executable without rediscovery; and a top **OPEN ITEMS FOR JIM** section that surfaces every confirmed contradiction between the plan's assumptions and the repo reality — surfaced, **not** resolved. Decisions reserved for Jim are flagged as such and left to him.

---

## OPEN ITEMS FOR JIM — surfaced, NOT resolved

These are confirmed (or partially-confirmed) contradictions between the plan's stated assumptions and the verified repo state. **No resolution is proposed.** Each says, where relevant, whether the affected milestone is "wire existing" vs "build net-new" — and leaves that call to Jim. Milestones below carry a pointer (`→ OPEN-n`) to the items that touch them.

A blanket note that applies to ALL items: the skeptic pass confirmed that the `sylphie-abc-build-plan.md` document itself is **not a committed repo artifact** (it lives in `Downloads/`), and the only committed vision plan, `wiki/ws5-build-plan.md`, has no Fork/A/B/C structure. Every *repo-reality* coordinate below is verified against source; some *plan line-number* citations the original grounding used are mis-located (e.g. "Plan §2 P1") — the substance holds regardless of where the plan text lives. This does not weaken any item; it only means the contradictions are "plan-as-written vs repo," not "committed-plan vs repo."

---

### OPEN-1 — P1 is scoped as a constant swap, but true frame dims do NOT reach the encoder boundary. It is net-new end-to-end plumbing.
- **Severity:** BLOCKER (for P1 scoping) / MAJOR overall.
- **Plan's assumption:** P1 (§2): the four encoders "must read true negotiated frame dims (`Frame.width/height`), not hardcoded 640×480" — phrasing implies dims are already available to swap in.
- **Repo reality:** The encoders run in the NestJS `decision-making` process and receive ONLY bbox pixel arrays. True dims exist in two places, neither reachable by the encoders: (a) Python `Frame.width/height` (`packages/perception-service/cobeing/layer2_perception/types.py:135-136`), decoded from the JPEG at `main.py:991-998`, then **dropped** — the `/detect` response (`main.py:478-497`) omits them; (b) browser `video.videoWidth/Height` (`frontend/src/hooks/usePerception.ts:184-198`), but only JPEG bytes are sent (`:190-198`). The gateway maps only label/confidence/bbox (`perception.gateway.ts:131-145`); no `VideoDetection`/`FaceDetection`/`SceneSnapshot`/`SceneSummary` field carries dims (`scene.types.ts:10-82`). Whole-tree grep `frame_width|frame_height|frameWidth|frameHeight` across `.ts` = **0 hits**.
- **Why it blocks/complicates:** P1 is a prerequisite for Fork B's spatial-IoU/size signals. As written ("read `Frame.width/height`") it reads as a constant edit; in reality it requires plumbing dims end-to-end (Python `/detect` JSON → gateway mapping → TickSampler raw value → each encoder's `encode()` input contract), OR adopting browser-sent dims. **This is "build net-new wiring across ≥4 files," NOT "wire existing constant." Which data path to use (Python-response vs frontend-sends-dims) is Jim's call** — both insertion points are documented under M-P1.
- **Touches:** P1 / M-A1 / M-A4 (the `/detect` contract is shared).

### OPEN-2 — P1's consumer list omits a fifth hardcoded 640×480 normalizer: `ScenePredictionService`.
- **Severity:** MINOR.
- **Plan's assumption:** P1 enumerates exactly four consumers: `VideoEncoder`, `SceneEncoder`, `FaceEncoder`, `FaceSnapshot.classifyAngle`.
- **Repo reality:** A fifth same-class normalizer exists: `packages/decision-making/src/prediction/scene-prediction.service.ts:37-38` hardcodes `FRAME_W = 640; FRAME_H = 480;` and uses them at `:231-234` to normalize bbox centroids for movement/IoU scene-surprise (vs `MOVEMENT_THRESHOLD = 0.15` at `:36`). Its `totalSurprise` output feeds the very drive-pressure path Fork C is built on: cached at `decision-making.service.ts:873`, routed to drives via `routeScenePredictionErrors` (call `:1959`, def `:2409`), and folded into the attention/encode gate (`:2529`).
- **Why it complicates:** If P1 fixes only the four named files, `ScenePredictionService` still skews under non-480p capture, so the surprise magnitude routed to Curiosity/Anxiety and to the encode gate is computed on miscalibrated coordinates. **Whether this is P1 scope or Fork C scope must be assigned, not dropped — Jim's call.**
- **Touches:** P1 / M-C2 (surprise source).

### OPEN-3 — SAM 3.1 stateful-session API (`session.add_frame`, `inference_state`) does not exist in the substrate; "wake the dormant pipeline" is net-new, and the existing buffer is structurally wrong for a stateful tracker.
- **Severity:** BLOCKER.
- **Plan's assumption:** A.1 / M-A1: "Browser frames → `FrameSource` → `session.add_frame` → masklets. This *wakes the dormant streaming pipeline* (`FrameSource` + drop-oldest `FrameBuffer`) — that abstraction is exactly what the stateful tracker needs."
- **Repo reality:** (1) No `session.add_frame`, `inference_state`, `masklet`, `propagate_in_video`, or video-session concept exists anywhere in `packages/perception-service` (grep = 0). (2) Every `FrameSource` is **pull-based**: the `FrameSource` protocol (`protocols.py:73-134`) exposes only `__aenter__`/`__aexit__`/`get_frame()`; `CameraFrameSource` (`frame_sources.py:73`) and `VideoFileSource` (`:255`) pull via `cv2.VideoCapture.read()`; the consumer `PerceptionPipeline` pulls (`pipeline.py:330`). The live browser path is the opposite topology — stateless `POST /perception/detect` (`main.py:306`), one frame in, JSON out, no `FrameSource`/`FrameBuffer`/capture loop. (3) `FrameBuffer` (`frame_buffer.py:64-115`) is **single-slot drop-oldest** — `put()` overwrites the one slot — which *drops* frames, the exact opposite of "feed every frame to maintain `inference_state`." (Minor: `FrameBuffer` is in `frame_buffer.py`, not `pipeline.py` as the plan locates it; `ObservationSessionManager` is in `frame_buffer.py:181-259`, and the "session" in `pipeline.py:233` is a Neo4j graph session, unrelated to SAM state.)
- **Why it blocks:** A feed-every-frame stateful SAM session requires a **net-new push-style `FrameSource`** (inbound queue whose `get_frame()` blocks on externally-pushed frames) OR bypassing `FrameSource` and feeding SAM directly from the gateway — in which case the existing `FrameSource`/`FrameBuffer`/`_capture_loop` is **not reused at all**. **This is "build net-new," NOT "wake existing." The push-adapter-vs-bypass choice, and whether a drop-oldest buffer is acceptable at all for a memory-propagating tracker, are Jim's calls.**
- **Touches:** M-A1.

### OPEN-4 — The dormant `PerceptionPipeline` has zero callers and is not exercised by any test; "promote it" means resurrecting unproven code.
- **Severity:** MAJOR.
- **Plan's assumption:** Plan + cv-framework treat the dormant pipeline as a built, validated abstraction ready to promote (cv-framework §7: "used in tests and ready"; "Only the test suite constructs the pipeline").
- **Repo reality:** The only `PerceptionPipeline(` occurrence in first-party code is the docstring example at `pipeline.py:60`. `main.py:_startup()` (`:165-234`) builds only detector/tracker/face detector; `_run_pipeline` (`:237`) is defined but never called; `_AppState.pipeline` stays `None`. Two first-party tests DO exist (`tests/test_observation_validator.py`, `tests/test_thread_safety.py`) but neither constructs the pipeline (grep = 0) — they test isolated components. So cv-framework's "used in tests / tests only" claim is overstated: the pipeline itself is exercised nowhere.
- **Why it complicates:** "Wake it" resurrects a path with no integration coverage; `_processing_loop`/`_capture_loop`/validator wiring carry unknown runtime correctness. **Jim decides whether to (a) validate the dormant path first, or (b) build the SAM session feed fresh and retire the dormant pipeline rather than promote it.**
- **Touches:** M-A1.

### OPEN-5 — `feature_extraction.py` is the SOLE face embedder; A.5 deletes it and B.4 still relies on face embeddings, with no replacement specified.
- **Severity:** BLOCKER.
- **Plan's assumption:** A.5 deletes `feature_extraction.py` (EfficientNet); B.4 runs `:Person` binding "using FaceSnapshot embeddings" as a still-working input; DINOv2 (A.2) replaces only the object path.
- **Repo reality:** `OnnxEmbeddingExtractor` (`feature_extraction.py:344`, EfficientNet-Lite4, 1280-D) is the embedder for BOTH objects (`_extract_track_embedding`, `main.py:888-896`) AND faces (`/crop-face`, `main.py:674-677`) — they reuse the same `_state.embedding_extractor` singleton. Deleting the file removes the face embedder. Failure mode is **silent/graceful, not a crash**: `/crop-face` returns `embedding: []` on extractor failure (`main.py:662,700-703`), and `identifyFace`/`matchFace` return `null` on empty input (`face-snapshot.service.ts:171,205`) → cross-session `:Person` re-id silently never recognizes anyone (a theater hazard).
- **Why it blocks:** Fork A is sequenced before B. A.5 strands B.4's face identity before B runs; B's acceptance test (power-cycle `:Person` re-bind) would have no face embedding source. **The plan specifies no replacement face embedder. Whether to (a) keep a dedicated face-recognition model, (b) exempt the face path from A.5 deletion, or (c) something else, is Jim's call.**
- **Touches:** M-A4 (A.5 decommission) / M-B4.

### OPEN-6 — D4 migrates `face_embeddings` 1280→1024, but no milestone changes the face embedder off 1280-D, and the `length===1280` guards silently drop mismatched vectors.
- **Severity:** BLOCKER.
- **Plan's assumption:** D4: "Embedding dim migrates 1280→1024 across all stores"; A.5: migrate both `visual_object_embeddings` AND `face_embeddings` to `vector(1024)`. B.4: faces keep FaceSnapshot embeddings ("only the embedding source differs").
- **Repo reality:** Faces are embedded 1280-D by EfficientNet via `/crop-face` (`main.py:578,700-703`) and stored to `face_embeddings vector(1280)` (`face-snapshot.service.ts:50,572`). Save/hydrate guards require `embedding.length === FACE_EMBEDDING_DIM (1280)` (`:501,615`) — a 1024-D vector would be **silently dropped** (not error). DINOv2 (A.2) touches only the object path. So D4's own "all stores" contradicts B.4's "source differs (faces unchanged)."
- **Why it blocks:** Migrating `face_embeddings` to `vector(1024)` while `/crop-face` still emits 1280-D fails every INSERT and the guards silently drop hydration → face identity (B.4) breaks invisibly. **Jim decides whether to (a) exempt `face_embeddings` from D4, (b) introduce a 1024-D face embedder, or (c) other.**
- **Touches:** M-A4 / M-B4. (Directly entangled with OPEN-5.)

### OPEN-7 — A.5 "delete `feature_extraction.py`" also deletes `DominantColorExtractor`, a Fork B dependency.
- **Severity:** MAJOR.
- **Plan's assumption:** A.5 deletes `feature_extraction.py` ("EfficientNet"); B.1 activates the A.5 5-signal scorer including "color Jaccard (4×4×4)."
- **Repo reality:** `feature_extraction.py` holds three classes, not just the EfficientNet embedder: `OnnxEmbeddingExtractor` (`:344`), `MockEmbeddingExtractor` (`:254`, used by tests), and `DominantColorExtractor` (`:66`, 8×8×8/512-bin histogram). The dormant A.5 pipeline imports `DominantColorExtractor` from this exact module (`pipeline.py:84-87,164-165`) to build the color feature feeding the A.5 color-Jaccard signal that B.1 activates. (Note: the histogram is 8×8×8/512 at extraction; the scorer re-bins to 4×4×4/64 at scoring time — two separate steps.)
- **Why it complicates:** Deleting the whole file removes a just-activated Fork B dependency (and the test mock). **Jim decides whether to relocate/preserve `DominantColorExtractor` (and the protocol/mock) before deletion.**
- **Touches:** M-A4 / M-B1.

### OPEN-8 — No Neo4j-backed `GraphPersistence` exists; B.1's "wire the A.5 Neo4j backend" is net-new durable-store work.
- **Severity:** BLOCKER.
- **Plan's assumption:** B.1: "Wire a real `PersistenceCheck` … + the A.5 Neo4j backend" — phrased as wiring an existing Neo4j-backed `find_nodes_by_embedding`. cv-framework §7 also asserts the dormant A.5 store is "Neo4j via `find_nodes_by_embedding`."
- **Repo reality:** The ONLY concrete `GraphPersistence` is `InMemoryGraphPersistence` (`in_memory_persistence.py:139`), a plain Python dict with pure-Python cosine; its own docstring (`:36-37`) says it does **not** persist across restarts. `find_nodes_by_embedding` has exactly two definitions repo-wide: the Protocol stub (`protocols.py:324`) and the in-memory impl (`:395-459`). `class Neo4jGraphPersistence` has **zero** definitions — yet it is imported and `isinstance`-checked in production (`skill_reset.py:103,206,299` via `cobeing.layer3_knowledge.infrastructure.neo4j_persistence`), and neither that file nor the `infrastructure/` package exists (dangling references to a never-built class). `classification_query.py` uses a raw `neo4j.Session` for a *different* semantic-query read path and does not implement `GraphPersistence`.
- **Why it blocks:** B's power-cycle acceptance test requires a durable store surviving restart; in-memory does not. Building the Neo4j-backed `find_nodes_by_embedding` adapter (vector index + bbox/color/label/`confirmation_count` property storage + recency window) is substantial **net-new** work. **This is "build net-new," NOT "wire existing." Jim owns the backend choice (Neo4j vector index vs pgvector adapter vs other).**
- **Touches:** M-B1.

### OPEN-9 — A.5's spatial-IoU signal is an in-session "same-place-in-frame" signal; reused cross-session it is ~0, yet it is the heaviest weight (0.50) for new nodes — structurally capping a new-node re-id below the 0.75 match threshold.
- **Severity:** MAJOR.
- **Plan's assumption:** Fork B reuses the A.5 5-signal scorer verbatim — including spatial IoU at 0.50 for new/low-confirmation nodes — as the cross-session matcher (B = A.5 activation). P1 frame-normalization is the only nod to spatial validity.
- **Repo reality:** `_score_spatial` (`persistence_check_service.py:199-254`) is IoU between the fresh detection's normalized-frame bbox (`observation_builder.py:322-335`) and the durable node's stored bbox — "same place in the frame," reliable frame-to-frame within a session, arbitrary across days. Candidates are durable graph nodes (`find_nodes_by_embedding`), not same-frame tracks. For `confirmation_count < 5`, weights are `spatial 0.50 / embedding 0.25 / color 0.15 / size 0.05 / label 0.05` (`:84-90`). With `match_threshold = 0.75` (`config.py:241`), a perfect-visual-match moved object on a different day (spatial IoU≈0) can reach at most ≈0.50 — below 0.75.
- **Why it complicates:** B's acceptance test directly exercises the moved-object case; the scorer as-built can structurally fail it for low-confirmation nodes. P1 fixes coordinate skew but does **not** make spatial IoU cross-session-valid. **Do NOT silently re-weight. Jim decides whether to re-weight, condition spatial on same-session, or drop it cross-session.**
- **Touches:** M-B1 / M-B3.

### OPEN-10 — `_NullPersistenceCheck` is dormant-only; the LIVE `/detect` endpoint runs no persistence check at all. "Retire `_NullPersistenceCheck`" is gated on activating the whole dormant pipeline.
- **Severity:** MAJOR.
- **Plan's assumption:** B.1: "Wire a real `PersistenceCheck` (retire `_NullPersistenceCheck`)" implies `_NullPersistenceCheck` is on the live identity path and swapping it activates A.5.
- **Repo reality:** `_NullPersistenceCheck` (`main.py:70-74`) is defined but never instantiated or invoked. The live `POST /perception/detect` chain (`main.py:306-497`) runs detector + face + IoU tracker + per-track embedding and returns JSON — **no** persistence check. The only `find_match` call site is `pipeline.py:504`, inside the dormant `PerceptionPipeline` that `main.py` never constructs.
- **Why it complicates:** "Activate A.5" is gated on activating the dormant streaming pipeline (M-A1 / OPEN-3, OPEN-4) and building the durable backend (OPEN-8), not a one-line `_Null→real` substitution. Affects M-B1 sequencing/effort. **Jim owns the sequencing.**
- **Touches:** M-B1 (depends on M-A1).

### OPEN-11 — Plan B.3's premise "Faces already do per-angle centroids" does not match the code; B.3's "match against the set" is net-new retrieval for BOTH faces and objects.
- **Severity:** MAJOR.
- **Plan's assumption:** B.3: "Generalize FaceSnapshot's per-angle centroids to objects … Faces already do frontal/left/right/up/down" — framed as porting an existing per-angle multi-centroid matcher.
- **Repo reality:** `FaceSnapshot` keeps **one** centroid per person (`Map<personId, FaceCentroid>` with a single `.embedding`, `face-snapshot.service.ts:108`), updated by an **angle-blind** incremental mean over all angles (`updateCentroid`, `:535-553`). `identifyFace`/`matchFace` (`:176-185,210-217`) compare against that single collapsed centroid. The five angles only drive (a) collection-completeness state and (b) per-`(person_id, angle)` warm rows — which the matcher never reads per-angle (it folds them into one mean on hydrate, `:613-617`).
- **Why it complicates:** There is no per-angle multi-centroid matcher to port. B.3's "match against the set of `(node, view)` embeddings" is **net-new** retrieval logic for both faces and objects, materially changing scope/effort and B's cross-angle re-bind acceptance test. **Jim decides whether B.3 is a port (it isn't) or a from-scratch multi-view matcher.**
- **Touches:** M-B3.

### OPEN-12 — Person "face" identity actually keys on the whole-person OBJECT-track embedding, not the masked face-crop; the person gallery is already contaminated by mixed sources.
- **Severity:** MAJOR.
- **Plan's assumption:** B.4: `:Person` binding "uses FaceSnapshot embeddings"; "only the embedding source differs."
- **Repo reality:** The live person-recognition query is the OBJECT-track embedding (EfficientNet on the full person bbox, background zeroed by YOLO-seg mask): `scene-event-detector.service.ts:79` passes `obj.embedding` into `identifyFace`; `visual-working-memory.service.ts:300/345/429` feed `entity.embedding`. But the gallery centroids are built from masked face-crop embeddings (`/crop-face` convex hull, `main.py:647-661` → `face-snapshot.service.ts:315`). Worse, `updateCentroid` is ALSO called with the body-crop `entity.embedding` at `visual-working-memory.service.ts:436,605` — mixing face-crop and body-crop embeddings into one person centroid. Both are 1280-D so cosine "works," but query and gallery come from different pixel regions.
- **Why it complicates:** B.4's "unify, only the source differs" understates a pre-existing inconsistency. A B redesign (DINOv2 for objects, "face embeddings" for persons) must decide **which** person embedding (body track vs face crop) is canonical. **Jim's call.**
- **Touches:** M-B4.

### OPEN-13 — No shared `masklet→node` binding abstraction exists to "unify" under; B is a from-scratch unification of two stores and two thresholds.
- **Severity:** MAJOR.
- **Plan's assumption:** B.4: "The binding service handles both `:VisualObject` and `:Person` — the `masklet→node` binding is the shared abstraction."
- **Repo reality:** No `BindingService`/`masklet` identity abstraction exists (grep = 0 first-party hits). Two separate identity paths: objects via VWM cosine over `visual_object_embeddings`, `OBJECT_MATCH_THRESHOLD = 0.75` (`visual-working-memory.service.ts:36`); persons via FaceSnapshot centroids, `IDENTIFICATION_THRESHOLD = 0.55` (`face-snapshot.service.ts:81`). Persons are NOT in `visual_object_embeddings` (they live in `face_embeddings` + OKG). The intended shared matcher (A.5 5-signal) is dormant Python, never live.
- **Why it complicates:** B.1/B.4 are a from-scratch unification reconciling two stores and two thresholds, not a refactor of one shared abstraction. **Jim owns the reconciliation (single threshold? two? which store is canonical?).**
- **Touches:** M-B1 / M-B4.

### OPEN-14 — "Vision is ambient, non-triggering" is ALREADY FALSE in the uncommitted WS5 working tree; the plan doesn't acknowledge the existing scene→cycle nudge edge.
- **Severity:** MAJOR.
- **Plan's assumption:** Fork C / C.4 / C acceptance test treat "vision is ambient, non-triggering" as the current state to change ("current behavior never triggers on a camera change").
- **Repo reality:** The working tree already has a scene-change → cognitive-cycle trigger (WS5 T1.0). On a confirmed-object `OBJECT_APPEARED/PERSON_ARRIVED/OBJECT_DISAPPEARED/PERSON_LEFT` (deduped at `SCENE_CYCLE_COOLDOWN_MS = 5_000`, `perception.gateway.ts:37`), the gateway calls `tickSampler.nudgeSceneChange()` (`:251-255`) → `tick-sampler.ts:147-152` → `decision-making.service.ts:547-557` enqueues an `InboundTurn{sceneNudge:true, text:''}` drained as a full cycle. The companion `cv-framework.md:247-250` still asserts the OLD non-triggering state (it was generated at committed HEAD `4f0b473`, blind to the uncommitted WS5 edits).
- **Why it complicates:** Fork C's headline differentiator is partly already shipped (uncommitted). **Jim must decide whether C.2/C.4 REPLACE the WS5 scene-nudge edge or layer drive-mediated surprise on top of it.** The plan was authored against a stale companion doc.
- **Touches:** M-C2 / M-C4.

### OPEN-15 — Surprise-triggered ticks categorize as `MULTIMODAL_INPUT`, not `VISUAL_INPUT`; the existing `VISUAL_INPUT` branch is the wrong hook.
- **Severity:** MAJOR (downgraded from the plan's framing).
- **Plan's assumption:** C.4: "`VISUAL_INPUT` becomes a trigger category … Surprise-triggered ticks carry the surprising node + VLM caption" — implies the surprise/scene tick is categorized `VISUAL_INPUT`.
- **Repo reality:** `categorizeFrame` (`process-input.service.ts:227-236`) returns `VISUAL_INPUT` only when `video` is the SOLE non-drive modality (`:236`); with ≥2 it returns `MULTIMODAL_INPUT` (`:229-231`). A live scene frame sets `video` AND `scene` (both registered, non-event-driven encoders that persist across ticks), plus `faces` when present — so ≥2 non-drive modalities → `MULTIMODAL_INPUT`. (Correction to the original grounding: `scene_description`/`undiscovered_count`/`unknown_person_count` do NOT count — they have no encoder and land in `frame.raw` only, `sensory-fusion.ts:120-124`.)
- **Why it complicates:** Making `VISUAL_INPUT` a trigger would not capture the live surprise/scene tick (it's `MULTIMODAL_INPUT`). M-C4 may need a dedicated surprise/visual-trigger category or a different gating point. **Jim decides the design; do NOT assume the existing `VISUAL_INPUT` branch is the hook.**
- **Touches:** M-C4.

### OPEN-16 — C.2's "route as pressure on the relevant axis / magnitude scales accumulation rate" is ambiguous against CANON Standard 6: raw-signal-in is allowed, computed-delta-in is forbidden. And the surprise→drive-pressure path ALREADY exists.
- **Severity:** BLOCKER (CANON tripwire).
- **Plan's assumption:** C.2: surprise magnitude "is routed to the drive engine as pressure on the relevant axis … Magnitude scales accumulation rate."
- **Repo reality (two parts):** (1) **It already exists and is CANON-compliant as built.** `routeScenePredictionErrors` (`decision-making.service.ts:2409-2434`, call `:1959`) sends ONLY `metadata: { sceneSurprise }` (no axis, no delta); the isolated drive process maps `ScenePrediction → {Curiosity:0.02, Anxiety:0.01}` (`rules.ts:165-168`) scaled by `meta.sceneSurprise` (`rules.ts:239-240`) INSIDE the child process. Per-axis differentiation also already exists: `UnknownPersonPressure→Social` (`rules.ts:156-159`), `UndiscoveredObjectPressure→Curiosity/Focus` (`rules.ts:151-154`). (2) **CANON forbids the forbidden reading.** `ipc.types.ts:134-136`: "No pre-computed drive deltas — the drive engine is fully isolated." `drive-engine.interfaces.ts:240-242`: "NOT a write path to the evaluation function … cannot be modified through this interface (CANON Standard 6)." `IDriveStateReader` has zero write methods (`:191-227`). "Accumulation rate" and "the relevant axis" are drive-process-internal evaluation, write-protected by Standard 6 (`sylphie-tech-spec.md:333`).
- **Why it blocks:** If C.2 is built as "perception decides the axis + accumulation effect and injects it," it breaches drive isolation. If built as "perception reports `sceneSurprise` magnitude; the drive process maps axis+delta" (the existing pattern), it is compliant. The plan's wording tilts toward the forbidden reading. **This is the highest-risk ambiguity in Fork C. Jim must decide the intended semantics before any C.2 code. Note: much of C.2 may be "assert existing" rather than "build."**
- **Touches:** M-C2.

### OPEN-17 — C.2's "big surprise spikes pressure → near-immediate tick (same frame)" is structurally impossible via the pressure path, and contradicts the already-built pressure-free scene-nudge.
- **Severity:** MAJOR.
- **Plan's assumption:** C.2: surprise magnitude governs WHEN a decision tick fires ("big surprise → near-immediate tick; small surprise colors the next ambient tick").
- **Repo reality:** The self-tick gate is pressure-thresholded at `IDLE_PRESSURE_THRESHOLD = 4.0` (`decision-making.service.ts:459,629`); drive values arrive 1-2 ticks stale over IPC (`drive-engine.interfaces.ts:184-186`). A surprise reported this frame cannot raise this frame's pressure in time to fire this frame's tick. The actual built "run a cycle on a salient frame" mechanism is the direct `nudgeSceneChange()` path (gateway `:254`), which by design "writes NOTHING to drives" (`inbound-turn.ts:107`) and bypasses pressure entirely. (The WS5 T1.0 encode-ordering refactor is already built — scene surprise is computed early at `:851-873` and folded into attention via `Math.max` at `:1484` — but that governs whether an already-running cycle ENCODES an episode, not whether a tick FIRES.)
- **Why it complicates:** C.2's causal chain (surprise → pressure spike → same-frame tick) and C.4's direct-nudge mechanism are two different, partly-incompatible trigger stories for the same effect. The salience-vs-pressure decoupling is deliberate (ashby loop-safety). **Jim decides which mechanism C uses.**
- **Touches:** M-C2 / M-C4.

### OPEN-18 — The automated CANON gate reads a `wiki/CANON.md` that does not exist; the only real guard for Fork C's Standard-6 risk is manual review against the tech-spec.
- **Severity:** MAJOR.
- **Plan's assumption:** Implicit — a stable CANON exists for the canon agent / enforce-canon to check Fork C against.
- **Repo reality:** `wiki/CANON.md` is absent. Both `.claude/skills/enforce-canon/SKILL.md:23` and `.claude/hooks/canon-check.cjs:64` instruct reading it; the hook degrades silently (per `canon-check.cjs:119-137`, only a `FAIL` verdict blocks; a missing-file Read produces neither PASS nor FAIL → `exit 0`). The dangling reference recurs in ~15 agent definitions and several planning skills. The authoritative CANON text actually lives in `sylphie-tech-spec.md §9` (`:326-333`, Six Immutable Standards incl. Standard 6) and `§3.2` (`:99-110`, Drive Isolation).
- **Why it complicates:** Fork C is the fork most likely to trip Standard 6 (see OPEN-16), and the automated gate cannot reliably catch it. **Jim decides whether to create `wiki/CANON.md` or repoint the tooling at `sylphie-tech-spec.md §9` before relying on the gate to bless Fork C.**
- **Touches:** M-C2 (CANON gate).

---

## 0. What this plan is

*(Preserved verbatim from the original.)* Three faculties, one integrated system:

- **A — Unified perception core.** One open-vocab model (SAM 3.1) for detect+segment+track, one embedding backbone (DINOv2), replacing YOLOv8n-seg + greedy IoU tracker + EfficientNet-Lite4.
- **B — Persistent cross-session identity.** Bind SAM 3.1 masklet IDs to durable Neo4j nodes via the (currently dormant) CANON A.5 multi-signal scorer, so Sylphie remembers the *specific* object/person across sessions and days.
- **C — Surprise as the universal gate.** Collapse the three orphaned triggers (VLM cooldown/periodic, scene events, A.5 surprise) into one **surprise signal** that feeds the homeostatic drive engine — the decision module — bridging cheap continuous perception to expensive cognition.

**Internal build order (not optional):** `A → (B + A.5 activation) → C`. B consumes A's masklets and embeddings and *is* the A.5 activation. C consumes B's "known vs novel" identity and A.5 appearance drift.

**Foundational assumption:** SAM 3.1 is the video core. A and B require per-object masklet IDs to exist. *(See OPEN-3: the stateful-session API does not exist in the substrate; this assumption implies net-new code.)*

---

## 1. Locked decisions (with validation gates — preserved EXACTLY)

| # | Decision | Rationale | Validation gate | Fallback (already in-plan) |
|---|----------|-----------|-----------------|----------------------------|
| D1 | **DINOv2 ViT-L/14** as the per-track embedding backbone (1024-D) | Purpose-built dense visual representation; strong instance separation. PE less validated for instance embeddings | On held-out Sylphie objects/people across angles, measure intra- vs inter-instance cosine margin | If margin < target: **DINOv2 ViT-B/14 (768-D)** if latency-bound, or **pooled PE features** if separation-bound |
| D2 | **Moondream2** as the gated VLM for v1 | Already integrated, lazy, cheap; now fires only on surprise | Measure whether surprise-captions discriminate "what changed" well enough to route drives | Upgrade to a larger gated VLM — 4080 budget allows it precisely *because* low-frequency |
| D3 | **SAM 3.1 masklets are the tracks** — retire greedy IoU entirely | Memory propagation handles occlusion natively; the IoU tracker has no motion model | Masklet ID stability through a scripted occlusion/crossing test | Add ByteTrack-style ID association as a thin safety net over masklets |
| D4 | **Embedding dim migrates 1280 → 1024** across all stores | DINOv2 ViT-L native dim | n/a (migration) | ViT-B path keeps it at 768 if D1 falls back |

> **Open items touching D4:** OPEN-6 (face store cannot migrate to 1024 without changing the face embedder), OPEN-5 (the face embedder is deleted by A.5). "across all stores" is exactly the phrase those items contradict.

---

## 2. Prerequisite — P1: Correct frame normalization

*(Preserved.)* `VideoEncoder`, `SceneEncoder`, `FaceEncoder`, and `FaceSnapshot.classifyAngle` must read true negotiated frame dims (`Frame.width/height`), not hardcoded 640×480. A.5's spatial-IoU and size-ratio signals (Fork B) are computed in normalized coords; if the camera negotiates 720p and the code assumes 480p, every spatial/size signal skews and B's matcher degrades silently.

> **→ OPEN-1 (BLOCKER for scoping): this is net-new end-to-end plumbing, NOT a constant swap — true dims do not reach the encoder boundary. → OPEN-2 (MINOR): a fifth normalizer, `ScenePredictionService`, is omitted from the four-file list.**

### Grounded targets — P1

All four named consumers hardcode the identical pair `FRAME_W = 640; FRAME_H = 480;`:
- `packages/decision-making/src/inputs/encoders/video.encoder.ts:33-34` — used at `:97` (`frameArea`), `:101-103` (`sumCx/sumCy/sumArea`). `encode()` at `:67` takes bbox-only `VideoDetection[]`. Doc comments `:25-26` say "assumes 640px/480px frame."
- `packages/decision-making/src/inputs/encoders/scene.encoder.ts:38-39` — used at `:117-120` (primary-person bbox) and `:152-153` (quadrant midpoints `midX=FRAME_W/2; midY=FRAME_H/2`). `encode(snapshot: SceneSnapshot)` at `:69`; `SceneSnapshot` (`scene.types.ts:76-82`) has no dims field.
- `packages/decision-making/src/inputs/encoders/face.encoder.ts:80-81` — used at `:129-132` (face bbox), `:161-175` (landmark mean/spread), `:203` (pitch proxy `/FRAME_H`). `encode(faces: FaceDetection[])` at `:105`; `FaceDetection` carries no dims.
- `apps/sylphie/src/services/face-snapshot.service.ts:89-90` — `classifyAngle` (`:348-380`) uses `FRAME_H` only at `:367` (`pitch = ((noseTip[1]??0) - eyeLineY) / FRAME_H`). **`FRAME_W` is declared but UNUSED in `classifyAngle`** — yaw (`:360-363`) is a scale-invariant ratio. Verify the angle dead-zone thresholds (`:373-377`) still hold under a new pitch scale. `classifyAngle` is called from `processFaceFrame` (`:265`), reached from `perception.gateway.ts:153-155` with `mappedFaces + jpegData` (no dims passed today).

The data-path gap (OPEN-1), and the two insertion points Jim must choose between:

- **Source of truth (Python):** `frame.width/height` are decoded at `main.py:991` (`height, width = img_rgb.shape[:2]`) and held on `Frame` (`types.py:135-136`) but the `/detect` response (`main.py:478-497`) returns only `{detections, faces, face_connections, face_oval, tracked_objects, scene_summary}` — no dims. **(Option A) ADD** `frame_width/frame_height` to that response object (in scope at `main.py:993-1001`). This is the only place dims are both correct and serializable to NestJS. (`/crop-face` already has `h,w` at `main.py:609` if needed.)
- **Source of truth (browser):** `frontend/src/hooks/usePerception.ts:184-198` sizes the canvas to `v.videoWidth/videoHeight` (true dims, known browser-side) but `:190-198` sends only the JPEG `ArrayBuffer`. **(Option B)** send negotiated dims alongside the frame.
- **WIRE (either option):** thread dims from `perception.gateway.ts:118` (`const result = await response.json()`) into the sensory pipeline. Today `result.*` is consumed at `:121-197` with no dims read. Either (a) extend `VideoDetection`/`FaceDetection`/`SceneSnapshot`/`SceneSummary` in `packages/shared/src/types/scene.types.ts` to carry `frameWidth/frameHeight`, mapped at `perception.gateway.ts:131-145/165-188`; and/or (b) add a `TickSampler` raw-value slot (mirror `updateUndiscoveredCount` at `tick-sampler.ts:236-238` / `latestValues` map at `:51`), e.g. `updateFrameDims({width,height})`, surfaced to encoders via fusion raw. Insertion point: `perception.gateway.ts` after `:118` (parse), before the existing `tickSampler.update*` calls (`:130/148/197`).
- **MODIFY** each of the four encoders to normalize by the supplied dims instead of `FRAME_W/H`; update the `:25-26` doc comments in `video.encoder.ts`.

**Fifth normalizer (OPEN-2 — assignment is Jim's call):** `packages/decision-making/src/prediction/scene-prediction.service.ts:37-38` (`FRAME_W=640/FRAME_H=480`), used at `:231-234` (`bboxCentroidDistance` normalizes centroids) vs `MOVEMENT_THRESHOLD = 0.15` (`:36`). Its `totalSurprise` is cached at `decision-making.service.ts:873`, routed to drives via `routeScenePredictionErrors` (`:1959`, `:2409-2421`), and folded into the attention/encode gate (`:2529`). Not in the plan's four-file list.

- **Current → target:** dims decoded server-side then discarded; encoders receive bbox-only → true negotiated `width/height` available as an input to each encoder's `encode()` at encode time.

---

## 3. FORK A — Unified Perception Core

**Replaces:** `detector.py` (YOLOv8n-seg), `tracker.py` (greedy IoU), `feature_extraction.py` (EfficientNet-Lite4).

### A.1 — SAM 3.1 in the sidecar *(→ OPEN-3, OPEN-4)*
*(Preserved.)* Load SAM 3.1 as a singleton in `perception-service` `_AppState`, replacing `detector` + `tracker`. Two prompt modes: a runtime-extensible standing concept list (the curiosity drive can propose new concept prompts — see C) and exemplar prompts (guardian-named objects → node discovery, B.3). Stateful session: one SAM 3.1 video session per camera stream, holding `inference_state` across frames; browser frames → `FrameSource` → `session.add_frame` → masklets. Retires the per-request / singleton-IoU-tracker hack.

### A.2 — DINOv2 embedding per track *(D1)*
*(Preserved.)* Per CONFIRMED masklet: crop bbox → apply the SAM 3.1 mask to zero background (preserves the "embed the object, not its surroundings" property from `_extract_track_embedding`) → DINOv2 ViT-L/14 → 1024-D embedding. Lazy-load with the same thread-safe double-checked locking as today's extractor.

### A.3 — Tracking & confirmation
*(Preserved.)* In-session identity = masklets; no IoU matching. Keep the confirmation-gate concept (maps to `min_confirm_frames=3`): a masklet must be present N frames before becoming a track of record eligible for embedding + graph binding. Drop the matching mechanism, keep the promotion semantics. States simplify to `OBSERVED → CONFIRMED → LOST → RELEASED`.

### A.4 — `/perception/detect` contract (new shape)
*(Preserved.)* `tracked_objects[]` each carries `{ masklet_id, concept_label, mask_polygon, bbox, confidence, presence_score, embedding[1024] }`. Ripples to: VWM (now 1024-D), `SceneEventDetector` (consumes tracks), the cognitive `VideoEncoder` (Fork C wiring).

### A.5 — Decommission list (explicit) *(→ OPEN-5, OPEN-6, OPEN-7)*
*(Preserved.)* Delete: YOLO path in `detector.py`; greedy IoU in `tracker.py`; `feature_extraction.py` (EfficientNet); `efficientnet_b0.onnx` download + `_DEFAULT_MODEL_URL`. Update `config.py::DetectionConfig`. Migrate TimescaleDB `visual_object_embeddings` + `face_embeddings` `vector(1280)` → `vector(1024)`; rebuild ivfflat indexes.

### A — Acceptance test
*(Preserved.)* Open-vocab detect+seg+track runs server-side at interactive FPS on the 4080; a scripted occlusion/crossing clip keeps masklet IDs stable (D3 gate); EfficientNet is gone; embeddings are 1024-D end to end.

### Grounded targets — Fork A

**M-A1 — SAM 3.1 in sidecar + concept prompts + stateful session.** *(→ OPEN-3, OPEN-4)*
- **MODIFY** `packages/perception-service/main.py` — `_AppState` + `_startup`. Today: `_AppState.detector = YoloDetector` (`:90`, built `:182-184`), `_AppState.tracker = IoUTracker(0.3,3,15)` (`:97`, built `:190-194`), `face_detector` (`:91`, built `:216-219`). Insertion point `:182-195` in `_startup()`. Replace detector+tracker singletons with a SAM 3.1 singleton + per-stream video session holding `inference_state`; the standing-concept-prompt list and exemplar-prompt mode are net-new state on `_AppState`. **Net-new (OPEN-3): `session.add_frame`/`inference_state` do not exist in the substrate.**
- **ADD (net-new push FrameSource) or BYPASS** — Jim's call (OPEN-3). The pull-only contract is `FrameSource` (`protocols.py:73-134`: `__aenter__`/`__aexit__`/`get_frame()` only); impls `CameraFrameSource` (`frame_sources.py:73`), `VideoFileSource` (`:255`) pull via `cv2.VideoCapture.read()`. Option (a): add a class implementing `FrameSource` whose `get_frame()` blocks on an internal queue an HTTP/WS handler fills (push→pull adapter). Option (b): bypass `FrameSource` entirely and feed `session.add_frame` directly from the gateway — `FrameSource`/`FrameBuffer`/`_capture_loop` are then NOT reused.
- **VERIFY buffer compatibility (OPEN-3, Jim's call):** `FrameBuffer` (`frame_buffer.py:64-115`) is single-slot drop-oldest (`put()` overwrites at `:99`); `PerceptionPipeline` processing loop is fixed at `processing_fps=3.0` (`pipeline.py:169`), warmup `_WARMUP_FRAMES=30` (`:116`), change-detection off (`:210`). A memory-propagating SAM session must see every frame; drop-oldest at a 3-FPS consumer drops frames. Plan §7 caveat: "Set the target FPS before M-A1" — that FPS decision intersects the buffer policy here.
- **WIRE startup (OPEN-4, Jim's call):** if reusing the pipeline, `_startup` must construct it and assign `_state.pipeline_task = asyncio.create_task(_run_pipeline(pipeline))` — today `_run_pipeline` (`main.py:237`) is never called and `_AppState.pipeline`/`pipeline_task` stay `None`. Decide promote-vs-rebuild given the pipeline has no integration test coverage (`tests/` exist but never construct it).
- **VERIFY docstring drift (cv-framework §11.1b):** effective YOLO default is `yolov8n-seg.pt` (`config.py:102`) but docstrings say `yolov8n.pt` (`detector.py:72,82`; `config.py:18,32,91`; `main.py:32`). Moot if `YoloDetector`/`DetectionConfig` are deleted in M-A4; otherwise clean up the stale references.

**M-A2 — DINOv2 per-track embedding (D1) + mask-zeroed crops.**
- **MIGRATE** `packages/perception-service/main.py` + `packages/perception-service/cobeing/layer2_perception/feature_extraction.py`. Today: `_extract_track_embedding` (`main.py:868-938`) calls `OnnxEmbeddingExtractor` (`feature_extraction.py:344`; `_EMBEDDING_DIM=1280` at `:341`; `_MODEL_INPUT_SIZE=224` at `:340`; ImageNet norm `:469-471`); mask-zeroing via `cv2.fillPoly` (`main.py:908-923`); double-checked lock on `_embedding_init_lock` (`:888-900`); `_embedding_init_failed` gate (`:865,881,899`).
- Keep the mask-zeroing semantic (`:908-923`) but source the mask from the SAM masklet, not the YOLO `mask_polygon`. Keep the double-checked-locking pattern and the failed-init gate. Swap `OnnxEmbeddingExtractor` for a DINOv2 extractor; `_EMBEDDING_DIM` 1280→1024; input size 224 may change for ViT-L/14.
- **Note (OPEN-5):** `/crop-face` (`main.py:665-691`) uses the SAME `OnnxEmbeddingExtractor` — it also flips to 1024-D unless faces keep a separate backbone (see B.4 / OPEN-6).

**M-A3 — Retire greedy IoU (D3); confirmation gate kept; new `/detect` contract (1024-D).**
- **DELETE** the matching mechanism in `packages/perception-service/cobeing/layer2_perception/tracker.py`: `_greedy_assign` (`:106`) + `_compute_iou` (`:68`). Keep promotion semantics (masklet present ≥3 frames → track of record; maps to `min_confirm_frames=3`, `config.py:151-155`). New states `OBSERVED→CONFIRMED→LOST→RELEASED` replace `tracker.py` `TENTATIVE→CONFIRMED→LOST→DELETED`. Live instance `main.py:190-194` and the `tracker.update()` + `tracked_objects` loop (`main.py:420-476`) must be rewritten to consume SAM masklets. `config.py::TrackingConfig` `iou_threshold` becomes dead.
- **MODIFY** the response contract in `main.py:448-468` (`tracked_objects_json`): today carries `track_id, state, label, confidence, bbox, frames_seen, frames_lost, first/last_seen_at, embedding[1280]`. Replace `track_id→masklet_id`, `label→concept_label` (open-vocab string), add `mask_polygon` + `presence_score`; embedding 1280→1024. Downstream parsers of this JSON: `apps/sylphie/src/gateways/perception.gateway.ts` and `scene.types.ts` `TrackedObjectDTO` (out of the Python cluster but coupled to this contract — and to P1/OPEN-1).

**M-A4 — Decommission EfficientNet/YOLO/IoU; migrate stores 1280→1024 (D4).** *(→ OPEN-5, OPEN-6, OPEN-7)*
- **DELETE (with care — OPEN-7):** in `feature_extraction.py`, `OnnxEmbeddingExtractor` + `_DEFAULT_MODEL_URL`/`_DEFAULT_MODEL_FILENAME`/`_download_model` (`:334-339,344-510`). **KEEP `DominantColorExtractor` (`:66`)** — pure-Python, imported by the dormant A.5 pipeline (`pipeline.py:84-87,164-165`) for the color-Jaccard signal Fork B activates. Keep `EmbeddingExtractor` protocol (`:213`) + `MockEmbeddingExtractor` (`:254`) if tests rely on them. Re-exported at `__init__.py:79-80`. Delete the YOLO path in `detector.py` (`YoloDetector:59-296`). Update `config.py::DetectionConfig` (`:80-117`): conf/NMS become concept-prompt config. (Lite4-not-B0 mislabel is cosmetic; both 1280-D — see cv-framework §11.1.)
- **MIGRATE (TS side — cross-codebase) — object store:** `apps/sylphie/src/services/visual-working-memory.service.ts:152` `embedding vector(1280)` → `vector(1024)`; rebuild ivfflat index `visual_object_embedding_idx` (`:162-166`, `lists=100`). `CREATE TABLE IF NOT EXISTS` (`ensureSchema`, `:147`) will NOT alter an existing 1280 column — a real ALTER/recreate + re-embed is required (existing 1280-D EfficientNet rows are incompatible with 1024-D DINOv2). No prisma migration exists; DDL lives in the service.
- **VERIFY (gate + DTO):** the cosine query (`:460-466`) and INSERT (`:541-553`) are dim-agnostic at SQL level but break if a 1024-D vector is searched against a 1280-D column before the ALTER lands — confirm ordering. Update the `1280D` doc-comments (`scene.types.ts:20`, `visual-working-memory.service.ts:80`). **CRITICAL gate dependency:** `test/gate/perception-cassette.ts:122-123` hardcodes `new Array<number>(1280)` — must become 1024 in lockstep. `perception-reset` (`metrics.controller.ts:404-421` → `vwm.resetForGate()` → `TRUNCATE visual_object_embeddings` at `:840`) carries no dim literal but must run so stale 1280-D rows don't survive the ALTER.
- **VERIFY (face store — BLOCKER, OPEN-5/OPEN-6):** `face-snapshot.service.ts:50` `FACE_EMBEDDING_DIM=1280`, DDL `:572` `vector(1280)`, guards `:501,615` `embedding.length === FACE_EMBEDDING_DIM`. Migrating to 1024 requires changing the face embedder, which no A/B/C milestone does. `/crop-face`'s `OnnxEmbeddingExtractor` (`main.py:674-677`) is deleted by A.5 with no replacement. **Do NOT fix — Jim decides** whether to exempt `face_embeddings` from D4, introduce a 1024-D face embedder, or other. Note: `face_embeddings` has only a btree `person_id` index (`:578-581`), NOT an ivfflat index — the plan's "rebuild ivfflat indexes (both stores)" is inapplicable to the face store.

---

## 4. FORK B — Persistent Cross-Session Identity

**Core problem:** *(Preserved.)* `masklet_id` is session-scoped; the graph node (`:VisualObject`/`:Person`) is durable. B is the binding layer that answers, per CONFIRMED masklet: known node, or new? This is where the dormant A.5 scorer becomes the cross-session matcher — B and A.5 activation are one task.

### B.1 — Binding service (promote/replace VWM identity) *(→ OPEN-8, OPEN-9, OPEN-10, OPEN-13)*
*(Preserved.)* On masklet promotion, run the CANON A.5 multi-signal persistence check: candidate set `find_nodes_by_embedding()`; score 5 signals (embedding cosine + spatial IoU + color Jaccard 4×4×4 + size ratio + label match) under Piaget R1 dynamic weights by `confirmation_count` (new `<5`: spatial-heavy `0.50/0.25/0.15/0.05/0.05`; known `≥10`: embedding-heavy `0.45/0.25/0.15/0.10/0.05`; 5-10 interpolated); outcome via `match_threshold 0.75` / `ambiguity_threshold 0.45` (matched → bind · new → create · ambiguous → defer/route to curiosity/social, feeds C). Replaces VWM's single-signal cosine (`OBJECT_MATCH_THRESHOLD 0.75`). Wire a real `PersistenceCheck` (retire `_NullPersistenceCheck`) + the A.5 Neo4j backend.

### B.2 — Identity binding state
*(Preserved.)* Session-scoped map `masklet_id → { node_id, confidence, match_type, bound_at }` (in-memory hot layer, like VWM). On masklet loss: binding persists through a re-association window, then releases. Durable side = graph node + accumulated embeddings; a new session's masklets re-bind via B.1; identity survives restart.

### B.3 — Node lifecycle + multi-view embedding accumulation *(→ OPEN-9, OPEN-11)*
*(Preserved.)* New `:VisualObject` confidence 0.40, provenance SENSOR, first embedding stored; discovery → confidence floor 0.60, provenance GUARDIAN, `concept_label` set. Generalize FaceSnapshot's per-angle centroids to objects: accumulate multiple `(node, view)` embeddings; match against the set. Surprise hook (bridge to C): when A.5 `surprise_flag` fires (known node, `confirmation_count ≥ 5`, drift > `surprise_threshold 0.3`), store the surprising embedding as a new view AND emit an appearance-surprise event for C.

### B.4 — Person identity (OKG), unified *(→ OPEN-5, OPEN-6, OPEN-12, OPEN-13)*
*(Preserved.)* Same binding for `:Person`, using FaceSnapshot embeddings (3-tier hot/warm/cold already exists). The binding service handles both `:VisualObject` (DINOv2) and `:Person` (face embeddings) — the `masklet → node` binding is the shared abstraction; only the embedding source differs.

### B — Acceptance test
*(Preserved.)* Power-cycle Sylphie. Next session, show the same object/person. It re-binds to the same node (not a new one) above a confidence bar.

### Grounded targets — Fork B

**M-B1 — Binding service: A.5 5-signal scorer replaces VWM cosine; real PersistenceCheck + Neo4j backend.** *(→ OPEN-8, OPEN-9, OPEN-10, OPEN-13)*
- **The scorer exists and is verified exact.** `persistence_check_service.py`: 5-signal `scores` dict (`:423-429`); color 4×4×4/64-bin (`:286-307`); spatial IoU (`:232-254`); size `min/max` (`:348`); label soft bonus 1.0/0.0 (`:351-374`). `_NEW_WEIGHTS` (`:84-90`), `_KNOWN_WEIGHTS` (`:92-98`), interpolation `:148-153`. `match_threshold 0.75`/`ambiguity_threshold 0.45` (`config.py:241-252`, used `:600/:609`). `surprise_threshold 0.3`, `confirmation_count≥5` (`config.py:235-240`; `:591-597`). `find_match` returns `match_type='embedding'` even for multi-signal matches (`:600-607`); returns `None` when `observation.embedding` is falsy (`:543-546`).
- **VERIFY (BLOCKER, OPEN-8):** the durable backend does NOT exist. Only `InMemoryGraphPersistence` (`in_memory_persistence.py:139`) implements `find_nodes_by_embedding` (`:395-459`, pure-Python cosine over `self._nodes`); its docstring (`:36-37`) says it does not persist across restarts. `find_nodes_by_embedding` has two defs only: Protocol stub (`protocols.py:324`) and the in-memory impl. `Neo4jGraphPersistence` is imported/isinstance-checked (`skill_reset.py:103,206,299`) but the file/`infrastructure/` package and the class do NOT exist (dangling). **Net-new backend (Jim owns the choice).** The new node must store the properties the scorer reads: `properties['embedding']` (1024-D under D4), `properties['bounding_box']` (normalized dict), `properties['dominant_colors']`, `properties['label_raw']`, and `node.confirmation_count` (drives Piaget R1). Protocol signature: `find_nodes_by_embedding(embedding, embedding_key='embedding', min_similarity=0.7, limit=10, schema_level=None) -> list[tuple[KnowledgeNode,float]]` (`protocols.py:324-371`).
- **WIRE (OPEN-10):** `_NullPersistenceCheck` (`main.py:70-74`) is never instantiated; the live `/detect` (`main.py:306-497`) runs no persistence check. `PersistenceCheckService.find_match` (`:501-627`) is fully built and unused on the live path; its only call site is the dormant `pipeline.py:504`. Activating it is gated on M-A1 (pipeline activation). If wired on the live path, insertion point is the CONFIRMED-track loop at `main.py:429-468` (embedding already extracted `:441-446`).
- **VERIFY (MAJOR, OPEN-9 — Jim's call):** `_score_spatial` (`:199-254`) is normalized-frame IoU (`observation_builder.py:322-335`); `_NEW_WEIGHTS` spatial=0.50 (`:84-90`) for `confirmation_count<5`; candidates are durable nodes. Cross-session IoU≈0 caps a new-node re-id near 0.50 < 0.75. **Do NOT re-weight silently.**
- **VERIFY (VWM premise, OPEN-13):** VWM live re-id is single-signal cosine (`visual-working-memory.service.ts:36` `OBJECT_MATCH_THRESHOLD=0.75`, applied `:473`). The replace premise (single→multi) is accurate. But the durable `:VisualObject` node currently stores only the embedding (pgvector); for the multi-signal scorer to function, the node must START storing `bounding_box`/`dominant_colors`/`label_raw`/`confirmation_count` — net-new schema. Persons are NOT in `visual_object_embeddings`, so the object scorer does not cover the `:Person` path (keep separate or extend — Jim's reconciliation).
- **Current → target:** object identity = single-signal cosine in NestJS, no durable multi-signal backend → A.5 5-signal scorer on the live path against a durable store.

**M-B2 — Binding state map + re-association window.**
- The hot-layer pattern to mirror is VWM/FaceSnapshot in-memory maps. Re-association concept exists today: `REASSOCIATION_IOU_THRESHOLD=0.3` (`visual-working-memory.service.ts`, cv-framework §5). FaceSnapshot hot layer = `Map<personId, FaceCentroid>` (`face-snapshot.service.ts:108`). Build the session-scoped `masklet_id → {node_id, confidence, match_type, bound_at}` map analogously.

**M-B3 — Multi-view embedding accumulation for objects; node lifecycle; surprise hook → emits to C.** *(→ OPEN-9, OPEN-11)*
- **ADD (net-new, OPEN-11):** there is NO per-angle multi-centroid matcher to port. `FaceSnapshot` keeps ONE collapsed centroid per person (`face-snapshot.service.ts:108`), updated by angle-blind incremental mean (`updateCentroid`, `:535-553`); `identifyFace`/`matchFace` (`:176-185,210-217`) compare against that single centroid; per-`(person,angle)` warm rows are folded into the one mean on hydrate (`:613-617`). Object re-id today stores ONE embedding per node (`createUndiscoveredNode` INSERT, `:541-553`). B.3's "match against the set" is net-new for BOTH faces and objects. Face insertion point: replace the single `FaceCentroid.embedding` with a per-view collection and change `identifyFace`/`matchFace` (`:170-224`) to max-over-views.
- **ADD surprise hook (net-new event path):** VWM has NO surprise signal today (cv-framework §7 table). `surprise_flag` lives only in the dormant A.5 scorer (`persistence_check_service.py:590-597`: `confirmation_count≥5` && `1.0 - cosine > 0.3`). On fire: store the surprising embedding as a new view AND emit appearance-surprise to Fork C (C.1.1). Requires the A.5 scorer activated (M-B1). No emit channel to C exists today.
- **Current → target:** single per-node embedding + no surprise emit → per-view gallery matched as a set + appearance-surprise emitted to C.

**M-B4 — Unify `:Person` binding under the same service.** *(→ OPEN-5, OPEN-6, OPEN-12, OPEN-13)*
- **MIGRATE / reconcile** `apps/sylphie/src/services/{face-snapshot,visual-working-memory,scene-event-detector}.service.ts`. Person path: `identifyFace`/`matchFace` over a single per-person centroid, `IDENTIFICATION_THRESHOLD=0.55` (`face-snapshot.service.ts:81`). Object path: cosine over `visual_object_embeddings`, 0.75. **No shared abstraction exists (OPEN-13; grep `BindingService`/`masklet` = 0).** OKG `:Person` binding path confirmed: `unknown-person-<uuid8>` placeholder (`visual-working-memory.service.ts:569`), `createUnknownPersonNode` MERGEs to Neo4j OTHER (`:578-587`), stores frontal embedding to `face_embeddings` (`:599-602`), calls `updateCentroid` (`:605`).
- **OPEN-12 (Jim's call):** the live person query is the OBJECT-track embedding (`scene-event-detector.service.ts:79` `identifyFace(obj.embedding)`; `visual-working-memory.service.ts:300/345/429`), while gallery centroids are built from masked face-crop embeddings (`main.py:647-661`) AND contaminated by body-crop embeddings (`updateCentroid` at `:436,605`). Decide the canonical person embedding.
- **OPEN-5/OPEN-6 (Jim's call):** A.5 deletes the sole face embedder; B.4 must specify the replacement face model/dim, and whether `face_embeddings` migrates to 1024 (guards `:501,615`).

---

## 5. FORK C — Surprise as the Universal Gate

**Goal:** *(Preserved.)* one surprise signal bridges cheap continuous perception → expensive cognition, with the homeostatic drive engine as the decision module (CANON: LLM is voice box, not interrupt).

### C.1 — Unify three sources into one `SurpriseEvent`
*(Preserved.)* `{ magnitude, source, node_id/masklet_id, timestamp }`, source ∈: (1) Appearance surprise — A.5 Piaget R2 drift on a known node (from B.3); (2) Presence surprise — `SceneEventDetector`: `PERSON_ARRIVED / OBJECT_APPEARED / *_DISAPPEARED / FACE_IDENTIFIED`; (3) Identity surprise — A.5 ambiguous match, or a new node under high curiosity/social pressure.

### C.2 — The gate: surprise → drive engine → (maybe) decision tick *(→ OPEN-16, OPEN-17, OPEN-18, OPEN-2)*
*(Preserved.)* Magnitude is routed to the drive engine as pressure on the relevant axis (curiosity for novel, social for persons) — not directly to the LLM. When integrated pressure crosses the decision threshold, a tick fires. Magnitude scales accumulation rate: a big surprise spikes pressure → near-immediate tick; a small surprise colors the next ambient tick. The synthesis: fixes over-gating (vision can now drive cognition) without a per-frame interrupt (drive-mediated).

### C.3 — Retire the three orphaned triggers *(→ OPEN-14)*
*(Preserved.)* VLM trigger: drop cooldown-5s / periodic-30s / on-scene-change; Moondream2 fires when surprise magnitude warrants a semantic look; its caption writes to the surprising node and feeds the tick's context. Event trigger: now presence surprise (C.1.2). A.5 surprise: appearance surprise (C.1.1). One signal, three sources, one gate.

### C.4 — The gated decision tick *(→ OPEN-14, OPEN-15)*
*(Preserved.)* `VISUAL_INPUT` becomes a trigger category, not only ambient (a deliberate change from "vision is ambient, non-triggering"). Surprise-triggered ticks carry the surprising node + VLM caption as salient context. Retrieval unchanged in shape: fingerprint → episodic + WKG candidates, capped at 5 (Cowan), Type-1 before Type-2. Use the learned/full latent for the fingerprint (close the §11.5 first-64-dims hazard).

### C — Acceptance test
*(Preserved.)* Show Sylphie a known object, then change it. Appearance surprise → drive pressure spikes → VLM looks → decision tick → Sylphie reacts to the change, not just presence. Contrast: current behavior never triggers on a camera change. *(→ OPEN-14: that "current behavior" is already partly false in the working tree.)*

### Grounded targets — Fork C

**M-C1 — Unify 3 sources into `SurpriseEvent`.**
- **ADD** to `packages/shared/src/types/scene.types.ts` (alongside `SceneEvent`) a `SurpriseEvent { magnitude, source ∈ {APPEARANCE|PRESENCE|IDENTITY}, node_id/masklet_id, timestamp }`. Presence-surprise already exists as `SceneEventType` (`:37-50`, all six members), emitted by `scene-event-detector.service.ts:82-176`. Appearance- and identity-surprise come from Fork B's activated `persistence_check_service.py` (dormant today). Note `SceneEvent` carries `trackId` (number), not `node_id` — node binding is Fork B's output that C consumes.
- **Current → target:** `SceneEvent` has `{type, trackId, label, confidence, bbox, timestamp, personId?, previousBbox?}` (`:52-64`), no magnitude/node_id → new `SurpriseEvent` with `magnitude` + `source` enum + `node_id/masklet_id`.

**M-C2 — Gate: surprise → drive-engine pressure → threshold tick.** *(→ OPEN-16, OPEN-17, OPEN-18, OPEN-2)*
- **VERIFY (the channel already exists, CANON-compliant — OPEN-16):** `routeScenePredictionErrors` (`decision-making.service.ts:2409-2434`, call `:1959`) → `reportOutcome({actionType:'ScenePrediction', metadata:{sceneSurprise}})`; isolated mapping `rules.ts:165-168` (`ScenePrediction={Curiosity:0.02, Anxiety:0.01}`) scaled by `meta.sceneSurprise` at `rules.ts:239-240` inside `computeDefaultAffect` (`:218-258`). Per-axis differentiation already present: `UnknownPersonPressure→Social` (`rules.ts:156-159`), `UndiscoveredObjectPressure→Curiosity/Focus` (`rules.ts:151-154`). **Do NOT rebuild.** Scope M-C2 as: confirm the existing `ScenePrediction` path is the intended gate, and thread the NEW `SurpriseEvent` sources (B.3 appearance, A.5 identity) as NEW `actionType` reports with their own metadata magnitude fields, reusing this pattern.
- **CANON boundary to enforce (BLOCKER, OPEN-16 — Jim disambiguates before any code):** allowed inbound = `ACTION_OUTCOME` carrying RAW SIGNAL only (`ipc.types.ts:9-13,55-66,138-149`); forbidden = computing a drive delta/accumulation-rate outside the process and pushing it in (`ipc.types.ts:134-136` "No pre-computed drive deltas"; `drive-engine.interfaces.ts:240-242` "NOT a write path to the evaluation function (CANON Standard 6)"; `IDriveStateReader` has zero write methods `:191-227`; Standard 6 `sylphie-tech-spec.md:333`). New surprise sources MUST be added as new metadata magnitude fields on `ActionOutcomePayload.metadata` (`ipc.types.ts:138-149`) + a matching Zod field in `ipc-message-validator.ts:43-47`, with axis+delta mapping placed in `rules.ts` INSIDE the child process. "Magnitude scales accumulation rate" must NOT be implemented as perception setting an accumulation rate.
- **VERIFY (OPEN-17):** the tick-fire gate is `IDLE_PRESSURE_THRESHOLD=4.0` (`decision-making.service.ts:459,629`), drives are 1-2 ticks stale (`drive-engine.interfaces.ts:184-186`); a surprise this frame cannot fire this frame's tick via pressure. The already-built "run a cycle on a salient frame" mechanism is the direct `nudgeSceneChange()` (`perception.gateway.ts:254`) which writes NOTHING to drives (`inbound-turn.ts:107`). C.2's pressure-spike story and C.4's direct-nudge story are two different mechanisms — Jim picks.
- **VERIFY (OPEN-18):** `wiki/CANON.md` does not exist though `enforce-canon/SKILL.md:23` and `canon-check.cjs:64` read it (silent degrade `:119-137`). Real CANON: `sylphie-tech-spec.md §9 (:326-333)` and `§3.2 (:99-110)`. Manual canon-agent review against the tech-spec is the only reliable guard.
- **VERIFY (stale line anchors):** re-resolve `decision-making.service.ts` symbols by name, not line — the architecture maps were generated at HEAD `4f0b473` and offsets have drifted (e.g. `routeScenePredictionErrors` def is at `:2409`, call `:1959`; `computeAttention` `:2634`).
- **OPEN-2 reminder:** if `ScenePredictionService` is not normalized (P1), the `sceneSurprise` magnitude this gate routes is computed on miscalibrated movement fractions.

**M-C3 — Retire cooldown/periodic VLM + event/A.5 triggers into the one gate; VLM writes to node.** *(→ OPEN-14)*
- **MODIFY** `apps/sylphie/src/gateways/perception.gateway.ts`. Exact removal targets: `:22` `CAPTION_COOLDOWN_MS=5_000`, `:24` `CAPTION_PERIODIC_MS=30_000`, `:211-220` (`timeSinceCaption`/`shouldCaption`/`requestVlmCaption` gating block), `:284-306` (`requestVlmCaption` sets `this.lastVlmCaption` only — no node write today). VLM currently feeds only `tickSampler.updateSceneDescription` (`:222-234`); "writes to node" is NEW (no graph write exists in this gateway). The scene-change→cycle nudge (`:37` `SCENE_CYCLE_COOLDOWN_MS`, `:240-255`) is the WS5 edge to fold into presence-surprise — coordinate retirement/repurpose with M-C2 (OPEN-14).
- **Current → target:** VLM fires on cooldown OR periodic OR scene-change; caption stored to `lastVlmCaption` only → VLM fires only on surprise magnitude; caption written to the surprising graph node.

**M-C4 — `VISUAL_INPUT` as trigger category; fingerprint on full latent (closes §11.5).** *(→ OPEN-14, OPEN-15)*
- **MODIFY** `packages/decision-making/src/process-input/process-input.service.ts` — two sub-changes:
  - **(1) Trigger category (OPEN-15, Jim's call):** `categorizeFrame` (`:213-239`) returns `VISUAL_INPUT` only for a single non-drive `video` modality (`:236`); a real surprise/perception frame sets `video`+`scene`(+`faces`) → `MULTIMODAL_INPUT` (`:228-231`). The existing `VISUAL_INPUT` branch is the wrong hook for live multimodal frames; the change may need a dedicated surprise/visual-trigger category or a different gating point. (Corrected mechanism: `scene_description`/`undiscovered_count`/`unknown_person_count` are raw-only, no encoder — they do NOT raise the modality count; the count is driven by `video`+`scene`+`faces` via `sensory-fusion.ts:94-114` and the non-event-driven, persisting slots in `tick-sampler.ts:216-242,291-294`.)
  - **(2) Fingerprint on full latent (§11.5):** `generateFingerprint` (`:357-369`) does `frame.fused_embedding.slice(0, 64)` (`:363`) of 768, quantizes 2dp, `sha256(`${category}::${quantized.join(',')}::${dominantDrive}`)`. Change `:363` to use the full 768 (or learned/appearance latent). WS5 edits to this file did NOT touch `generateFingerprint` (they changed `:139` `queryByContext→queryByFingerprint` and added `:327-342` VLM-caption summary), so the hazard is fully intact.
- **VERIFY (retrieval shape unchanged):** `generateFingerprint` → `queryByFingerprint(fingerprint, DEFAULT_RECENT_EPISODES_FOR_CONTEXT=3)` (`:77,:139`) for episodic; `actionRetriever.retrieve(...)` (`:163-167`) for WKG; `rankCandidates` Type-1 before Type-2 (`:451-459`); `slice(0, INNER_MONOLOGUE_CAPACITY=5)` (`:74,:177`). WS5 T2.1 already made `queryByContext` a thin alias to `queryByFingerprint` (`episodic-memory.service.ts:413`). **CAUTION:** widening the fingerprint changes the key distribution — every previously-stored episode fingerprint becomes a miss until re-keyed, and the recall include-gate (`CONTEXT_SIMILARITY_THRESHOLD=0.70`, calibrated to the 64-dim SHA Jaccard) must be re-validated.
- **Current → target:** fingerprint hashes first-64 of 768; `VISUAL_INPUT` = single video modality only → fingerprint hashes full/learned latent; a surprise tick is reachable as a trigger category.

---

## 6. Build sequence & milestones *(preserved; open-item pointers added)*

```
P1  Frame-normalization fix ........................ prereq for A.5 spatial signal   [OPEN-1, OPEN-2]
│
A   Unified perception core
│   M-A1  SAM 3.1 in sidecar + concept prompts + stateful session                    [OPEN-3, OPEN-4]
│   M-A2  DINOv2 per-track embedding (D1) + mask-zeroed crops
│   M-A3  Retire greedy IoU (D3); confirmation gate kept; new /detect contract (1024-D)
│   M-A4  Decommission EfficientNet/YOLO/IoU; migrate stores 1280→1024 (D4)           [OPEN-5, OPEN-6, OPEN-7]
│   ── Gate: A acceptance test ──
│
B   Persistent identity  (= A.5 activation)
│   M-B1  Binding service: A.5 5-signal scorer replaces VWM cosine; real PersistenceCheck + backend
│         [OPEN-8, OPEN-9, OPEN-10, OPEN-13]
│   M-B2  Binding state map + re-association window
│   M-B3  Multi-view embedding accumulation for objects; node lifecycle; surprise hook → C
│         [OPEN-9, OPEN-11]
│   M-B4  Unify :Person binding (FaceSnapshot) under the same service                 [OPEN-5, OPEN-6, OPEN-12, OPEN-13]
│   ── Gate: B acceptance test (power-cycle re-bind) ──
│
C   Surprise gate
    M-C1  Unify 3 sources into SurpriseEvent (magnitude/source/node)
    M-C2  Gate: surprise → drive-engine pressure → threshold tick                      [OPEN-16, OPEN-17, OPEN-18, OPEN-2]
    M-C3  Retire cooldown/periodic VLM + event/A.5 triggers into the one gate          [OPEN-14]
    M-C4  VISUAL_INPUT as trigger category; fingerprint on full latent (closes §11.5)  [OPEN-14, OPEN-15]
    ── Gate: C acceptance test (reacts to change, not presence) ──
```

---

## 7. Resource budget (4080, 16 GB — preserved EXACTLY)

| Component | VRAM (fp16, est.) | Residency |
|-----------|-------------------|-----------|
| SAM 3.1 (~840M) | ~3.4 GB | resident |
| DINOv2 ViT-L/14 (~300M) | ~0.6–1.2 GB | resident |
| MediaPipe Face Landmarker | ~0.1 GB | resident |
| Moondream2 (~1.86B) | ~3.7 GB | **lazy** (surprise-gated) |
| **Resident subtotal** | **~4–4.7 GB** | — |
| **Peak (VLM invoked)** | **~8–8.4 GB** | comfortable on 16 GB |

Latency target drives D1 sizing (ViT-L vs ViT-B) and whether M-A1 needs TensorRT (PyTorch ~3–4 FPS → ~30 FPS class with TensorRT). **Set the target FPS before M-A1.** *(→ OPEN-3: the FPS decision intersects the drop-oldest `FrameBuffer` policy — a stateful tracker must see every frame.)*

---

## 8. Explicitly out of scope (preserved EXACTLY)

- **Audio → latent path.** The same learned-encoder pattern likely applies, but audio is its own doc.
- **WebRTC `/ws/webrtc`.** Dead stub; finish or delete separately. JPEG-over-WS is sufficient.
- **WebGPU in-browser privacy tier.** A future SAM-2-class local fallback; not this plan.
- **Cognitive encoder "learned projection" beyond the fingerprint fix.** C.4 closes the §11.5 hazard by feeding + hashing the real latent; a full learned multi-modal projection head is a separate effort.

---

## Considered and dismissed (NOT open items — verified false against this repo)

The independent skeptic pass REFUTED four would-be contradictions. They are recorded here only so they are not re-raised:
1. *"A.5 spatial-IoU latent cap is a plan defect"* — the scorer property is real (new-node cross-session re-id caps ≈0.50 < 0.75; see OPEN-9 which DOES carry it as a B.1 item), but no committed plan exercises A.5 as a cross-session matcher, so the *plan-vs-repo* framing of the dismissed phrasing doesn't hold. The substance lives in OPEN-9.
2. *"D4 self-contradiction (all-stores vs source-differs) is a coded defect"* — the repo reality (faces 1280-D, no milestone changes the embedder) is real and is carried as OPEN-5/OPEN-6; the "plan-vs-plan self-contradiction" framing against a non-existent committed plan is what was dismissed.
3. *"Deleting `feature_extraction.py` removes `DominantColorExtractor`"* as a separate finding — the repo fact is real and is carried as OPEN-7; only the duplicate framing was dismissed.
4. *"C.2 surprise→drive is presented as new but already exists"* — confirmed already-existing-and-compliant; carried into OPEN-16 (which is the live, load-bearing version: the *ambiguity* and the *don't-rebuild* both matter).

---

## Change log
- **2026-06-13 — Grounded v1.** Preserves LOCKED v1.0 architecture verbatim (A/B/C; D1-D4; build order; acceptance tests; VRAM; out-of-scope). Adds per-milestone Grounded-targets blocks with exact repo coordinates (verified against source at HEAD `4f0b473` + uncommitted WS5 working tree) and 18 OPEN ITEMS FOR JIM surfacing every confirmed/partial contradiction — surfaced, not resolved. Highest-risk items: OPEN-1 (P1 net-new plumbing), OPEN-3 (SAM stateful-session API absent), OPEN-5/OPEN-6 (face embedder deleted/migrated with no replacement), OPEN-8 (no Neo4j backend), OPEN-16 (C.2 CANON Standard-6 ambiguity).
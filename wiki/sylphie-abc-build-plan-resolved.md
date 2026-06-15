# Sylphie Vision A/B/C — Resolved Build Plan (v2, impossibility-aware)

> **Derived from `sylphie-abc-build-plan-grounded.md` (Grounded v1, 2026-06-13). v2 applies Jim's UNLOCK decisions and resolves every former OPEN item.** Companion to `wiki/cv-framework.md`.
>
> **Provenance.** v1 surfaced 18 OPEN ITEMS FOR JIM — contradictions between the LOCKED v1.0 architecture and the verified repo, *surfaced not resolved*. The plan was then UNLOCKED; Jim made the binding decisions recorded in **§4 RESOLVED DECISIONS**. This v2 carries those decisions as FINAL (they are never re-opened or bounced back), attaches the exact corrected file-level mechanics from the live substrate probe (`abc-resolution.json`, 8 clusters R1–R8), and — per Jim's explicit safety valve — **loudly flags what the substrate cannot host as specified rather than silently working around it**.
>
> **Substrate baseline.** All coordinates verified against `git HEAD 4f0b473` (`git rev-parse --short HEAD` = `4f0b473`) plus a **live `.venv` probe** of `packages/perception-service`. v1's line numbers had drifted; **every insertion point in v2 is resolved BY SYMBOL.** Note in particular: the decision loop lives at **`packages/decision-making/src/decision-making.service.ts`** (2721 lines), **NOT** `apps/sylphie/src/services/decision-making.service.ts` (that path does not exist). `'masklet'` has **0 occurrences** in first-party code (only inside `ultralytics` in `.venv`).
>
> **Status legend (per milestone):** **BUILDABLE NOW** · **BLOCKED-ON-M0 (deps)** · **IMPOSSIBLE→PARKED (SAM)**.

---

## 1. IMPOSSIBLE / PARKED (substrate cannot host as specified)

This is the loud flag. Per Jim's own premise — *"if Opus's video scoping displaces SAM 3.1, B's binding layer is the piece that adapts; nothing else moves"* — the anticipated displacement is **confirmed**. We do not work around it; we park the one piece that cannot be built and adapt the one piece Jim said would adapt.

### 1.1 SAM 3.1 stateful push session — DOES NOT EXIST as an installable model → **PARKED**

**Decision affected:** Fork A OPEN-3 (net-new push adapter feeding a per-stream SAM 3.1 stateful session: `session.add_frame` / server-held `inference_state` / `propagate_in_video`).

**Substrate verdict (IMPOSSIBLE).** There is no SAM package of any kind in the `.venv` (no `sam` / `segment-anything` / `sam2` / `sam3`). `ultralytics 8.4.33` ships SAM3 *build* code (`sam/build_sam3.py`, `sam/sam3/`, `SAM3Predictor` at `predict.py:2188`) but it is not runnable as a stateful streaming session:
- **(a) No checkpoint.** `downloads.py` `GITHUB_ASSETS_NAMES` (lines 32–44) lists `sam_{b,l}`, `sam2_{blst}`, `sam2.1_{blst}`, FastSAM, mobile_sam — **no `sam3_*.pt`**. No SAM3 checkpoint is auto-downloadable.
- **(b) Uninstalled hard dependency.** `build_sam3_image_model` hard-requires CLIP via `git+https://github.com/ultralytics/CLIP.git` — `import clip` → `ModuleNotFoundError` (`build_sam3.py:146-152`).
- **(c) Finite-video, not a push API.** The SAM2/SAM3 *video* predictors assert `predictor.dataset.mode=='video'` and allocate `[None]*num_frames` from a **pre-counted finite video** (`predict.py:2606-2615`, `1189-1191`), indexing `self.dataset.frame`. **There is no `session.add_frame(jpeg)` push entry point.**

**Closest actually-available substrate:** SAM2.1 (`sam2.1_{b,l,s,t}.pt`, auto-downloadable) / SAM2 (`sam2_*.pt`) — both real video predictors but **finite-video/dataset-bound**. A true per-stream push session would require **net-new research-grade code** driving SAM2.1's internal `_run_single_frame_inference` with a self-managed growing `inference_state` (treating each POST as the next `frame_idx`) against an undocumented internal API. **That is not "configuring a released SAM-3.1 stateful session"; it is building a custom predictor.**

**Resolution (Jim's premise, applied):** **Fork A's perception-core swap (SAM-as-detector+segmenter+tracker) is PARKED pending the video-core re-scope.** It does not block the rest of the plan because:
1. The DINOv2 *object-embedding* swap (the buildable half of Fork A's decision) is **independent of SAM** — see §7 M-A2. It even **fixes a currently-dead path** (object embeddings are already null in production; see §3).
2. **The mask-zeroing degrades cleanly.** `_extract_track_embedding`'s `cv2.fillPoly` mask (`main.py:917-919`) continues to source from the **YOLO-seg `detection.mask_polygon`** (`detector.py:184-211`, `types.py:175`); "mask from the SAM masklet" is the only part blocked, and it falls back to YOLO-seg with zero downstream change.
3. **Concept-prompt config lands additively, inert** — it cannot *replace* conf/NMS without bricking the only working detector (YOLO is closed-vocab COCO, not text-promptable). See §7 M-A1.

### 1.2 The Fork B binding key adapts — to `SceneEntity.id`, NOT a "masklet"

This is the *exactly one* piece Jim said would move. Because the SAM masklet ID does not exist (no SAM), Fork B's per-object binding key **adapts to the stable key that already exists**:

- **`SceneEntity.id`** (`visual-working-memory.service.ts:51`, a `randomUUID()` assigned at `:339`) is the stable per-physical-object key. It **survives `trackId` churn** via the existing re-association window (`vwm.ts:383-410`). This is the documented anchor that out-lives the churning monotonic `trackId` the IoU tracker assigns.
- It is **NOT** keyed on `trackId` (churns on re-entry — the exact P1c habituation defect called out in `wiki/ws5-build-plan.md:200`).
- It is **NOT** a `masklet` (`grep masklet` = **0** first-party hits; the term maps conceptually to YOLO-seg's `mask_polygon` on `Detection`, `types.py:175`).

So when v2 says "bind masklet → node", read it as **"bind `SceneEntity.id` → node"**. Nothing else in Fork B moves on account of the SAM displacement; the five-signal scorer, the threshold set, the candidate stores, and the NestJS seam are all unaffected.

### 1.3 Per-stream session keying is independently blocked

Even if a push-capable SAM existed, `_AppState.sam_sessions[stream_id]` **has no key to index on**: the live POST (`perception.gateway.ts handleFrame`) sends raw JPEG body with only `Content-Type: image/jpeg` and **no stream/session id** in header or body; `detect()` reads only `request.body()`. A per-stream session would first need an **upstream gateway contract change** to add a stream id. Documented here so it is not rediscovered; it is downstream of §1.1 and equally parked.

---

## 2. M0 — Substrate prerequisite (deps) · **HARD GATE before ANY live verification**

**The pipeline is largely DORMANT at runtime right now.** The `perception-service` `.venv` is missing dependencies that `requirements.txt` already lists, plus one (`insightface`) it does not. Live `.venv` probe (`.venv/Scripts/python.exe -c 'import …'`):

| Dependency | requirements.txt | In `.venv`? | Runtime consequence today |
|---|---|---|---|
| `onnxruntime>=1.17,<2.0` | line 11 (pinned) | **ABSENT** | `OnnxEmbeddingExtractor.__init__` raises `ImportError` → `_embedding_init_failed=True` → **object embeddings are already `None` in production**; `/crop-face` returns `embedding: []` |
| `mediapipe>=0.10,<1.0` | line 10 (pinned) | **ABSENT** | `face_model_loaded=False` (`main.py:212-225`) → **NO faces detected at all today** |
| `neo4j>=5.13,<6.0` | **NOT listed** | **ABSENT** (global py has 5.28.3) | `classification_query.py:120` / `semantic_query.py:74` / `semantic_query_benchmark.py:68` do module-level `import neo4j` → **un-importable in the service venv**; graph reads broken in-venv |
| `insightface>=0.7,<1.0` | **NOT listed** | **ABSENT** | needed for ArcFace face path (R2); ships `buffalo_l` / `w600k_r50.onnx` (512-D) via auto-download |

**M0 action (BLOCKER):**
1. Add `neo4j>=5.13,<6.0` and `insightface>=0.7,<1.0` to `packages/perception-service/requirements.txt`.
2. `pip install -r requirements.txt` into `packages/perception-service/.venv`.
3. **Watch numpy 2.x vs insightface.** `numpy 2.4` is installed; `insightface` historically builds against `numpy<2`. If the wheel fails, install a prebuilt `insightface` wheel **or** pin `numpy<2` for this venv. Confirm during install.
4. **No torch/transformers install needed** — `torch 2.11.0+cpu`, `torchvision 0.26.0+cpu`, `transformers 4.57.6` are **already present** (the DINOv2 path is buildable today). `torch` is **CPU-only** here (`cuda=False`) — a perf note, not a blocker.

**Until M0 lands, every "live verification" / "live smoke" / acceptance test is invalid** — the path it would exercise is dormant. Milestones are tagged **BLOCKED-ON-M0** where their live verification depends on these deps. Net-new code can be *written* against the substrate before M0; it cannot be *run/verified* until M0.

---

## 3. RESOLVED DECISIONS (former OPEN items)

Each entry: the v1 OPEN item, **Jim's decision (FINAL)**, the **status tag**, and the **corrected mechanics** from the substrate probe. Coordinates are by-symbol against HEAD `4f0b473`.

### OPEN-1 / OPEN-2 — Frame-dim plumbing (incl. the 5th normalizer) → **RESOLVED · BUILDABLE NOW**
**Decision:** net-new end-to-end frame-dim plumbing, **including** the 5th normalizer `ScenePredictionService`. **Mechanics:** see §7 **P1** (full 8-step plan from cluster R6). Pure-arithmetic change, no new dep. Single source of truth = `Frame.width/height` already computed at `main.py:991`/`997-998` and **currently discarded**; surface them in the `/detect` JSON. Every new DTO field is **optional, defaulting to `640/480`** at each read site, so the WS5 gate's dims-less cassette stays byte-identical.

### OPEN-3 — SAM stateful push session → **PARKED (SAM)** · DINOv2 swap **BUILDABLE NOW**
**Decision:** bypass `FrameSource`; build a net-new push adapter feeding a per-stream SAM 3.1 stateful session. **Substrate verdict:** the SAM half is **IMPOSSIBLE → PARKED** (see §1.1). **Already-true premise:** "bypass `FrameSource`" is the *shipped* architecture for the live YOLO path — `detect()` (`main.py:306`) is a stateless per-POST chain via `_decode_jpeg_to_frame` (`main.py:960`) that never touches `frame_sources`/`frame_buffer`/`pipeline`; `_state.pipeline` is `None`. So the "push adapter that bypasses FrameSource" already exists for the existing detector; **only the SAM-session overlay is net-new, and that piece is blocked.** The DINOv2 object-embedding swap proceeds (§7 M-A2).

### OPEN-4 — Dormant `PerceptionPipeline` resurrection → **MOOT (PARKED with SAM)**
The dormant pipeline only mattered as the host for the SAM session. With Fork A's SAM core parked and the live path confirmed to bypass the pipeline entirely (R1 VERIFY), there is nothing to resurrect for the buildable work. `_state.pipeline` stays `None`; no integration-coverage gamble is taken.

### OPEN-5 / OPEN-6 — Face embedder + face-store dim → **RESOLVED · BLOCKED-ON-M0**
**Decision:** DINOv2 (1024-D) replaces EfficientNet for **OBJECT embeddings only**; **faces get a dedicated purpose-built embedder (ArcFace/InsightFace, native 512-D)**. **Face stores keep their OWN dim (512), NOT forced to 1024.** **Do not delete the shared EfficientNet until BOTH the object and face paths are live.** **Mechanics:** see §7 **M-B4 / face cluster R2** (new `face_embedding.py::ArcFaceEmbedder`, `/crop-face` switch, destructive `face_embeddings` `1280→512` migration with `IDENTIFICATION_THRESHOLD` retune off 0.55, EfficientNet retired LAST behind a grep gate). This **resolves the D4 "all stores → 1024" contradiction**: dims are **per-modality** (object→1024, face→512). See D4 correction in §6.

### OPEN-7 — `DominantColorExtractor` is a Fork B dependency → **RESOLVED · BUILDABLE NOW**
`feature_extraction.py` holds three classes; A.5's color-Jaccard signal imports `DominantColorExtractor` (`pipeline.py:84-87,164-165`). The EfficientNet retirement (R2 M6) **deletes only `OnnxEmbeddingExtractor` + its download helpers**, KEEPS `DominantColorExtractor`, the `EmbeddingExtractor` protocol, and `MockEmbeddingExtractor`. (Honesty note: on the NestJS-side binder, color is **not** wired day-one anyway — see the 3-signal correction in §6/§7 M-B1.)

### OPEN-8 — Neo4j-backed `GraphPersistence` → **RESOLVED · BLOCKED-ON-M0**
**Decision:** implement `Neo4jGraphPersistence` behind the existing interface. **Mechanics:** see §7 **M-B-N (cluster R3)** — net-new `cobeing/layer3_knowledge/infrastructure/` package: `__init__.py`, `neo4j_persistence.py` (the dangling class `skill_reset.py:103/206/299` already imports + isinstance-checks; must expose `_driver`), and `neo4j_schema.py` (second dangling import at `semantic_query_benchmark.py:70`). All `GraphPersistence` methods async; `find_nodes_by_embedding` is the A.5 boundary. **CRITICAL serialization:** `bounding_box` is a nested dict → Neo4j cannot store maps → **JSON-encode to `prop_bounding_box`, `json.loads` on read** (else every A.5 spatial/size score is silently 0.0). Vector index dimension is **1280** for the in-Python path's EfficientNet store today; the in-Python cosine-over-shortlist path is the safe default (works on any Neo4j 5.x), native vector index optional fast-path. **Note:** building the class closes OPEN-8 but does **not** by itself wire it into the live HTTP path — confirm scope (class-correct vs live-wired) when sequencing.

### OPEN-9 — A.5 spatial-IoU cross-session invalidity → **RESOLVED (verbatim adjudication below)** · BUILDABLE NOW (Python-side)

> **OPEN-9 — RESOLVED (correctness mechanic, within the authorized envelope; flagged for Jim's veto).** Adjudication: a CORRECTNESS MECHANIC inside A.5's existing architecture, NOT a change to the Piaget-R1 weighting philosophy. Fork B's reuse of the in-session A.5 scorer cross-session introduced a regime where the spatial-IoU signal (heaviest weight 0.50 for new nodes) is structurally invalid (same object, different day ⇒ different frame position ⇒ IoU≈0), capping a perfect-embedding cross-session re-id at ~0.50 < the 0.75 match threshold ⇒ silent duplicate-node spawn. **Fix:** when a candidate is cross-session/stale, DROP the spatial signal and renormalize the surviving four weights (embedding/color/size/label) to sum to 1.0; keep current behavior verbatim in-session. Cross-session-ness derives from a RECENCY proxy reusing the already-present-but-unused `PersistenceCheckConfig.recency_window_hours=24.0` (config.py:230) vs `node.last_confirmed`/`valid_from` — **zero schema change**. Worked example: the moved object goes from a 0.50 structural ceiling (duplicate) to 0.84 (correct re-bind); embedding-only lands at 0.50 ⇒ reported ambiguous for Layer-3 dedupe (D-TS-01) rather than silently duplicating. `_NEW_WEIGHTS`/`_KNOWN_WEIGHTS`, the 5/10 confirmation thresholds, and the interpolation are untouched — it only removes a signal the design's own docstring calls 'short-range' (in-session), in the regime where it's invalid. It would become architectural only in the rejected alternative (statically lowering spatial globally). **Code:** `persistence_check_service.py::compute_match_score` gains `same_session: bool=True` + a `_renormalize_drop(weights,'spatial')` helper; `find_match` derives `same_session` per candidate from recency. **Durable follow-up:** add `session_id` to instance-node properties (`observation_ingestion.py::_build_instance_properties`) for a true session match.

**Mechanics (cluster R8):** `compute_match_score` signature → `(…, *, same_session: bool = True)`; helper `_renormalize_drop(weights,'spatial')` near `_interpolate_weights` (`:110`). In `find_match` (loop `for node, _ in candidates:` at `:566`): `same_session = (now - (node.last_confirmed or node.valid_from)) <= timedelta(hours=self._config.recency_window_hours)` (needs `from datetime import timedelta`, `from cobeing.shared.time_utils import utc_now`). Worked renormalization: `_NEW_WEIGHTS` drop spatial 0.50; survivors `{embedding:0.25,color:0.15,size:0.05,label:0.05}` (sum 0.50) ÷ 0.50 → `{embedding:0.50,color:0.30,size:0.10,label:0.10}`. No existing test pins the weights, so this breaks no assertion. **Durable follow-up** (optional): thread `session_id` into `_build_instance_properties` (`observation_ingestion.py:558-588`, new-node sites `:353/:392`) — flat scalar, isolation-safe, also fixes `get_similar_to_cluster`'s empty `session_ids`.

### OPEN-10 — `_NullPersistenceCheck` on the live path → **RESOLVED (moot under NestJS seam)**
`_NullPersistenceCheck` is never instantiated; the live `/detect` runs no persistence check; the only `find_match` call site is the dormant `pipeline.py:504`. **Because the unified binder runs NestJS-side (OPEN-11/12/13 below), there is no "swap `_Null→real` on the Python live path" to do** — the Python scorer stays dormant/test-only as the reference spec. Closed by the seam decision.

### OPEN-11 / OPEN-12 / OPEN-13 — Unified binding → **RESOLVED · BUILDABLE NOW (NestJS) / BLOCKED-ON-M0 (Person face data)**
**Decision:** accept B as **net-new**; **ONE unified masklet→node binding abstraction**; the **A.5 five-signal scorer is the shared matcher**; the **A.5 thresholds (0.75 / 0.45) are the single set**; **retire the VWM cosine threshold**. **Corrected seam (honesty correction #1):** the unified binder runs **NestJS-side** (`apps/sylphie/src/services/binding.service.ts`), porting `compute_match_score` to TypeScript; the Python `persistence_check_service.py` stays as the **reference spec, not called over the wire**. Rationale: the candidate stores (`visual_object_embeddings` + `face_embeddings` pgvector) and node-write authority (Neo4j WORLD/OTHER) are **NestJS-only**; the Python scorer is a stateless pure-function library. **Mechanics:** see §7 **M-B1…M-B6 (cluster R4)**. Binding key = `SceneEntity.id` (§1.2). Person path = OPEN-12 fix (ArcFace face-crop query, stop the body-track contamination of `face_embeddings`).

> **Honesty correction #2 (≈3-signal-real day one):** `visual_object_embeddings` stores **only embedding + label** (`vwm.ts:147-158`). `_score_spatial`/`_score_color`/`_score_size` return **0.0** when node data is absent. So on day one the "5-signal scorer" is **embedding + label + (spatial once node-bbox is persisted)** — **color and size are 0.0** until (a) the schema is extended (`ALTER … ADD bounding_box jsonb, dominant_colors jsonb`) and (b) a **NestJS-side color path** exists (none today — `DominantColorExtractor` is sidecar-only and not returned by `/detect`). **Do NOT claim 5-signal parity day one.** Build with embedding-dominant per-node-type weight profiles and flag color/size as deferred enrichment.

### OPEN-14 — `nudgeSceneChange` subsumption → **RESOLVED · BUILDABLE NOW (with the trap held)**
**Decision:** C's surprise gate **subsumes `nudgeSceneChange` into the unified `SurpriseEvent`** (presence source). **Mechanics:** see §7 **M-C2/M-C3 (cluster R5)**. **TRAP (honesty correction #5, load-bearing):** `nudgeSceneChange` is a cycle-**TRIGGER** (enqueues a turn) while `reportOutcome` is a drive-**SIGNAL** (fire-and-forget into the child; runs only mid-cycle). **The unified path MUST keep the cycle-enqueue** (route the `sceneNudge` enqueue through the unified emitter, or keep it alive) — otherwise salient-but-**calm** frames on a drive-cold backend stop getting cycles and **P3/P4 regress** (the self-tick is gated at `IDLE_PRESSURE_THRESHOLD=4.0`; `scene` is deliberately not event-driven). Keep `InboundTurn.sceneNudge` and the null-`currentTurnContext` handling as the originator-less marker.

### OPEN-15 — `VISUAL_INPUT` is the wrong hook → **RESOLVED · BUILDABLE NOW**
A live surprise frame sets ≥2 non-drive modalities (`video`+`scene`(+`faces`)) → `categorizeFrame` returns `MULTIMODAL_INPUT`, not `VISUAL_INPUT`. **Resolution:** use the **already-declared-but-never-emitted `'SYSTEM_TRIGGER'`** category (`process-input.service.ts:50`) for an originator-less surprise/scene cycle (no text/audio). New branch in `categorizeFrame`: `if (modalities.has('scene') && !modalities.has('text') && !modalities.has('audio')) return 'SYSTEM_TRIGGER';`. Type-safe (legal union member). See §7 M-C4.

### OPEN-16 — C.2 raw-signal-in → **RESOLVED (assert+extend, NOT a rewrite) · BUILDABLE NOW**
**Decision:** rewrite C.2 to raw-signal-in (assert+extend the existing compliant `reportOutcome` pattern; **axis+delta computed inside the isolated drive process**). **Honesty correction #4: the "rewrite" is ALREADY SATISFIED at HEAD.** The IPC metadata (`ipc.types.ts:138-149`) carries **raw magnitudes only**; the comment at `:132-137` states the contract verbatim ("No pre-computed drive deltas — the drive engine is fully isolated"); axis+delta is computed in-child via `computeDefaultAffect` (`rules.ts:218-258`, scaling base `ACTION_TYPE_DEFAULTS` by the raw metadata magnitude). **There is NO RAW-SIGNAL-IN violation to fix.** The work is purely additive: **one `presenceSurprise` magnitude field + its Zod line + its `rules.ts` mapping** (axis chosen in-child). See §7 M-C2.

### OPEN-17 — surprise → same-frame tick via pressure → **RESOLVED (use the nudge, not pressure)**
Pressure can't fire this frame's tick (threshold 4.0; drives 1–2 ticks stale). The "run a cycle on a salient frame" mechanism is the direct `nudgeSceneChange()` enqueue (writes nothing to drives). v2 keeps the **cycle-enqueue** as the trigger mechanism (subsumed into the unified surprise path per OPEN-14) and keeps the **drive-signal** as the separate magnitude report. The two are distinct and **both** are preserved.

### OPEN-18 — enforce-canon reads a non-existent CANON → **RESOLVED · BUILDABLE NOW**
**Decision:** fix enforce-canon to read the real CANON (`sylphie-tech-spec.md §9`). **Mechanics:** see §7 **M-CANON (cluster R7)**. `wiki/CANON.md` never existed (`git log --all -- wiki/CANON.md` empty). Real canon: `sylphie-tech-spec.md §9` (`:326`, Six Immutable Standards) + `§3.2` (`:99`, Drive Isolation). Repoint `canon-check.cjs:64` + `enforce-canon/SKILL.md:23`; add an `fs.existsSync` fail-loud guard; flip the unparseable-response fallback (`:132-137`) from `exit(0)` to `exit(2)`. The automated Stop-hook spawns a generic `claude -p`, **not** the `canon` agent — so the hook prompt + guards must be edited directly (fixing only the skill/agent does not fix the gate).

---

## 4. Cross-agent ratifications required

These are **not** Jim decisions and **not** re-opened decisions — they are coordination the decisions *imply*, owed to the agents whose ratified domains the changes touch. Surface and obtain sign-off; do not silently absorb.

- **ashby — `SCENE_CYCLE_COOLDOWN_MS` loop-gain bound (re-confirm in its new home).** Subsuming the scene-nudge into the unified surprise path changes **where and how often** scene-presence events enter the drive-feedback loop. The cooldown that bounds that rate is **ashby's ratified domain** (`perception.gateway.ts:26-37`: "held conservative … pending ashby's loop-gain sign-off … must stay ≥ the rumination-breaker window so a flapping scene can't out-pace the breaker"). **ashby must re-confirm the bound still holds (≥ rumination-breaker window) before the deletion/relocation ships.**
- **cortex — fingerprint-widening recall discontinuity + `queryByContent` threshold.** Widening `generateFingerprint` from `slice(0,64)` to the full latent changes the SHA for **every** frame → **all pre-existing episode fingerprints become misses** until re-keyed (a one-time recall discontinuity), and 2dp-quantizing the full vector makes the collision predicate **stricter**. **cortex owns this; land it with/after WS5 T2** (the `queryByContent` split that carries semantic recall on content tokens, not the SHA), and re-validate the `CONTEXT_SIMILARITY_THRESHOLD=0.70` include-gate.
- **atlas — `visual_object_embeddings` schema extension + Person-vs-VisualObject threshold reconciliation.** (a) Adding `bounding_box`/`dominant_colors` to `visual_object_embeddings` (to make spatial/color/size non-vacuous) is a schema change in **atlas's** domain. (b) **Do NOT silently collapse Person 0.55 → VisualObject 0.75.** The Person store is **embedding-only** (no spatial/color/size), so a 0.75 weighted threshold on raw face cosine would **regress recognition** and break the WS4 multi-person gate. Use **per-node-type weight profiles**: `Person = embedding-1.0 @ 0.55`; `VisualObject = multi-signal @ 0.75`. The "single threshold set" means a single *scorer + ambiguity semantics*, **per-signal-profile**, not one literal cutoff. **atlas ratifies the reconciliation.**

---

## 5. Preserved architecture spine (faculties A/B/C)

*(Jim's decisions intact; substrate-parked items annotated.)*

- **A — Unified perception core.** *Intended:* one open-vocab model (SAM 3.1) for detect+segment+track + one embedding backbone replacing YOLOv8n-seg + greedy IoU + EfficientNet. **As-resolved:** the SAM perception-core swap is **PARKED (§1.1)**; the **DINOv2 object-embedding backbone swap ships** (1024-D, `facebook/dinov2-large`), **fixing the already-dead object-embedding path**; YOLO-seg remains the detector/segmenter and supplies the mask; EfficientNet stays live until both object **and** face paths are migrated.
- **B — Persistent cross-session identity.** Bind the stable per-object key (**`SceneEntity.id`**, §1.2 — not a "masklet") to durable Neo4j nodes via the A.5 multi-signal scorer, **ported to TypeScript NestJS-side** (the algorithm-of-record stays as the Python reference spec). Net-new unified `BindingService`; single threshold set; VWM cosine retired. **≈3-signal-real day one** (§3 OPEN-11/12/13).
- **C — Surprise as the universal gate.** Collapse the orphaned triggers into one `SurpriseEvent` feeding the homeostatic drive engine. **Assert+extend** the already-compliant raw-signal-in path (§3 OPEN-16); **keep the cycle-enqueue** when subsuming `nudgeSceneChange` (§3 OPEN-14 trap).

**Internal build order (re-scoped):** the original `A → (B+A.5) → C` assumed SAM masklets exist. With SAM parked, the **SAM-independent buildables proceed in parallel/any order after M0**; the SAM perception-core is a **later, separately-scoped workstream**. See §8.

### D1–D4 (with the D4 per-modality-dim correction)

| # | Decision | As-resolved status |
|---|----------|--------------------|
| D1 | **DINOv2 ViT-L/14** as the per-track **object** embedding backbone (1024-D) | **BUILDABLE NOW.** `facebook/dinov2-large` (1024-D CLS/pooler; `dinov2-base` is only 768-D). torch+transformers installed; weights are a ~1.1GB one-time download (same auto-download pattern as Moondream/YOLO). Object-path only. |
| D2 | **Moondream2** as the gated VLM | Unchanged; fires on surprise (Fork C). |
| D3 | **SAM masklets are the tracks** — retire greedy IoU | **PARKED (SAM, §1.1).** Greedy IoU tracker stays until a real stateful tracker exists; `SceneEntity.id` re-association is the stable identity anchor in the interim. |
| D4 | **~~Embedding dim migrates 1280 → 1024 across all stores~~** → **CORRECTED: per-modality dims** | **OBJECT store → 1024 (DINOv2). FACE store → 512 (ArcFace). NOT a uniform 1024.** `visual_object_embeddings`: `vector(1280) → vector(1024)` (DINOv2). `face_embeddings`: `vector(1280) → vector(512)` (ArcFace) — **face store keeps its own native dim**. Each is a destructive pgvector migration (column dim is fixed at creation; old EfficientNet rows are incompatible and, for faces, are the OPEN-12 contamination being eliminated). |

### Acceptance tests (preserved; annotated)

- **A:** open-vocab detect+seg+track at interactive FPS, masklet-ID stability under occlusion. **PARKED with SAM.** The *buildable* A acceptance is narrower: DINOv2 1024-D object embeddings flow end-to-end, the previously-null object-embedding path is live, mask-zeroing intact via YOLO-seg.
- **B:** power-cycle Sylphie; next session, same object/person **re-binds to the same node** above a confidence bar. **BLOCKED-ON-M0** (needs Neo4j backend + ArcFace face data live). The OPEN-9 fix is what makes the moved-object case pass instead of structurally failing.
- **C:** show a known object, change it → appearance surprise → drive pressure → VLM looks → tick → Sylphie reacts to **the change**, not just presence. **BUILDABLE NOW** for the presence/scene-surprise + SYSTEM_TRIGGER + fingerprint pieces; appearance-surprise depends on B being live.

### Out of scope (preserved)
- Audio → latent path (own doc). WebRTC `/ws/webrtc` (dead stub; finish/delete separately). WebGPU in-browser privacy tier. Full learned multi-modal projection head beyond the fingerprint fix.

---

## 6. Per-fork Grounded/Resolved targets

Status tags per milestone. Coordinates by-symbol at HEAD `4f0b473`.

### P1 — Frame normalization (cluster R6) — **BUILDABLE NOW**

Net-new end-to-end plumbing; eight `FRAME_W/FRAME_H` const decls across five files; **all new DTO fields optional, default `?? 640/480`** at each read site.

- **P1-1 (Python emit) · MODIFY `main.py`:** in `detect()`'s `return JSONResponse({…})` (`:478-497`), add `"frame_width": frame.width, "frame_height": frame.height` after `"scene_summary"` (`:496`). `frame` is in scope (`:358-360`), dims set at `:997-998`. Do **not** touch `/detect-annotated`.
- **P1-2 (shared DTOs) · MODIFY `scene.types.ts` + `sensory-frame.ts`:** add `frameWidth?/frameHeight?` to `SceneSnapshot` (`:76`), `VideoDetection` (`sensory-frame.ts:3`), `FaceDetection` (`:9`). **Load-bearing constraint:** `fuse()` (`sensory-fusion.ts:108-109`) hands each encoder **only its own slot value** — `video`/`faces` are **bare arrays** with no envelope, so dims **must ride on each detection element**; `scene` is a container, so dims ride on the snapshot.
- **P1-3 (gateway thread) · MODIFY `perception.gateway.ts`:** after `:118` read `const frameWidth = result.frame_width ?? 640; const frameHeight = result.frame_height ?? 480;`; add to the video map (`:131-135`), face map (`:140-145`); set `sceneSnapshot.frameWidth/Height` right after the `detectEvents` call (`~:194`, minimal blast radius); pass dims into `processFaceFrame` (`:153`).
- **P1-4 video.encoder.ts**, **P1-5 scene.encoder.ts**, **P1-6 face.encoder.ts**, **P1-7 face-snapshot.service.ts `classifyAngle`**, **P1-8 scene-prediction.service.ts `bboxCentroidDistance`** — replace each `FRAME_W/FRAME_H` use-site with true dims read from `detections[0]`/`faces[0]`/`snapshot`; keep consts as fallback defaults. **5th normalizer (`scene-prediction.service.ts:37-38`, used in `bboxCentroidDistance` `:387-396`, called from `compareScene` `:290`) is the one a prior pass missed — it IS in scope.** Leave dimension-free ratios alone (face yaw/roll; classifyAngle yaw). `/crop-face` needs no dims (reads its own server-side, `main.py:609`).
- **P1-verify:** curl a 1280×720 JPEG → assert `frame_width:1280, frame_height:720`; per-encoder unit test that a frame-center detection normalizes to ~0.5; confirm dims-less cassette still passes via fallbacks. `yarn` scripts only.

### Fork A (cluster R1)

- **M-A2 — DINOv2 object-embedding swap · BUILDABLE NOW.** **ADD** `class DINOv2EmbeddingExtractor` to `feature_extraction.py` after `OnnxEmbeddingExtractor` (ends `:510`); same `EmbeddingExtractor` protocol/signature/return contract (drop-in). Lazy-import `torch` + `transformers.Dinov2Model/AutoImageProcessor` (both installed); load `facebook/dinov2-large` (1024-D; `eval()`, `set_grad_enabled(False)`); reshape raw RGB exactly like `OnnxEmbeddingExtractor.extract` (`:446-459`), crop, processor, return `pooler_output`/`last_hidden_state[:,0]`. **MODIFY** `main.py:_extract_track_embedding` swap site (`:891-896`) — keep the `_embedding_init_failed` gate (`:881-882,899`), the double-checked lock (`:888-890`), and the `cv2.fillPoly` mask-zeroing (`:902-923`) **byte-for-byte**; broaden the `except` to also catch HF download failure (degrade to null, not crash). **This is the ONLY object-embedding swap site.** Embedding dim 1280→1024 → re-baseline any stored object vectors (old 1280-D are incomparable). **BONUS:** the `OnnxEmbeddingExtractor` is **already dead** (onnxruntime absent) → this swap **fixes** a broken path.
- **M-A1 — concept-prompt config · BUILDABLE NOW (additive, inert) / SAM session PARKED.** **ADD** `concept_prompts: list[str]` (pydantic, `default_factory=list`) to `DetectionConfig` (`config.py:80`) — **additive, alongside conf/NMS, NOT replacing them** (YOLO hard-depends on `confidence_threshold`/`nms_threshold`; removing them bricks the only detector). The per-stream SAM session (`_AppState.sam_sessions`, `session.add_frame`, `inference_state`) is the **decision spec, not buildable** — documented for when/if the substrate is satisfied (§1.1, §1.3).

### Fork B — unified binding (cluster R4) + Neo4j backend (R3) + face decouple (R2)

- **M-B0 — seam · VERIFY.** The unified `BindingService` runs **NestJS-side**; it does **not** call the Python scorer over the wire. `compute_match_score` is the **algorithm-of-record → ported to TS**; the Python file stays as the cross-checkable reference (do not delete).
- **M-B1 — net-new `BindingService` · BUILDABLE NOW (≈3-signal).** **CREATE** `apps/sylphie/src/services/binding.service.ts` (`@Injectable`), `bindMasklet(input): Promise<BindResult>` (input keyed by **`SceneEntity.id`**, `nodeType: 'VisualObject'|'Person'`). Port the 5 scorers (`_score_embedding/_spatial/_color/_size/_label_raw`, `persistence_check_service.py:161-374`), `_interpolate_weights` (`:110-153`), `_NEW/_KNOWN_WEIGHTS` (`:84-98`), `find_match` classification (best≥0.75 match; 0.45≤best<0.75 ambiguous; else none). **Confirmation_count proxy:** VWM has none on the node; use `visual_object_embeddings.sighting_count` (`vwm.ts:157`) in the candidate SELECT. **≈3-signal day one** (color/size = 0.0 until schema + NestJS color path land — see §3 OPEN-11/12/13 + the atlas ratification).
- **M-B2 — retire `OBJECT_MATCH_THRESHOLD` · BUILDABLE NOW.** **DELETE** const (`vwm.ts:36`) + the sole use-gate (`:473`); replaced by `BindingService` `MATCH_THRESHOLD=0.75` on the **weighted** score. **Not a no-op re-label** — embedding is only 0.25–0.45 of the weighted sum; re-validate against the WS5 perception cassette (a clean object that matched at raw cosine ≥0.75 may now score lower).
- **M-B3 — replace VWM single-signal cosine · BUILDABLE NOW.** **MODIFY** `vwm.ts:450-501`: replace the LIMIT-1 pgvector cosine block with `binding.bindMasklet({…, nodeType:'VisualObject'})`; candidate SELECT → **TOP-K (LIMIT 5)** for ambiguity; on `none` → `createUndiscoveredNode` (unchanged); on `ambiguous` → new guardian-disambiguation path (net-new behavior).
- **M-B4 — Person path (face decouple, cluster R2) · BLOCKED-ON-M0.** **Mechanics:** M1 install `insightface`/`onnxruntime`/`mediapipe`; **M2** new `cobeing/layer2_perception/face_embedding.py::ArcFaceEmbedder` (512-D, lazy insightface import, `buffalo_l`/`w600k_r50.onnx`); **M3** switch `crop_face._compute_embedding` (`main.py:665`) to ArcFace passing the **UNMASKED** crop (the convex-hull mask designed for EfficientNet **hurts** ArcFace), leave `_extract_track_embedding` on EfficientNet; **M4** migrate `face_embeddings` **1280→512 destructively** (DROP+CREATE in `ensureSchema`, retune `IDENTIFICATION_THRESHOLD` off 0.55 toward ~0.35–0.40 for ArcFace geometry); **M5 (OPEN-12 fix)** switch the person QUERY off the body-track embedding onto the fresh `/crop-face` 512-D vector (stamp `personId` via the face↔person bbox overlap already at `scene-event-detector.service.ts:62-71`) and **DELETE the body-track INSERT** into `face_embeddings` at `vwm.ts:595-609`. Threshold reconciliation per the **atlas** ratification (Person profile = embedding-1.0 @ 0.55).
- **M-B5 — binding hot-map · BUILDABLE NOW.** `private bindings = new Map<string, {nodeId; confidence; matchType; boundAt}>()` keyed by **`SceneEntity.id`** (§1.2); `bound_at=Date.now()`; `confidence=best_score` (not detection confidence); `clear()` wired into the gate `perception-reset`.
- **M-B6 — DI wiring · BUILDABLE NOW.** Register `BindingService` in `app.module.ts:209`, inject into VWM constructor (`vwm.ts:121-128`). `BindingService` injects `TimescaleService`/`FaceSnapshotService`/`Neo4jService`. **Must NOT inject VWM** (would create a DI cycle).
- **M-B-N — `Neo4jGraphPersistence` (cluster R3) · BLOCKED-ON-M0.** **CREATE** `cobeing/layer3_knowledge/infrastructure/{__init__.py, neo4j_persistence.py, neo4j_schema.py}` (package does not exist; the class is the dangling import at `skill_reset.py:103/206/299`, must expose `_driver`). Implement every async `GraphPersistence` method; mirror `in_memory_persistence.py` semantics (MERGE upsert, DETACH DELETE, AND filters); `_PROP_PREFIX='prop_'`; reserved top-level cols + `provenance_source/_source_id/_confidence`; **JSON-encode `bounding_box`** (nested dict → Neo4j cannot store maps; else spatial/size score 0.0). `find_nodes_by_embedding` = the A.5 boundary: **in-Python cosine-over-shortlist (safe default, any Neo4j 5.x)**, native vector index optional fast-path (dim **1280** for the EfficientNet store). Add `neo4j>=5.13,<6.0` (M0). `neo4j_schema.initialize_schema(driver)` satisfies the second dangling import (`semantic_query_benchmark.py:70`) + the pre-existing `SchemaNotInitializedError` contract.

### Fork C — surprise gate (cluster R5) — **BUILDABLE NOW** (no new deps; pure TS IPC + decision-loop refactor)

- **M-C2 (additive raw-signal-in) · BUILDABLE NOW.** **ADD** `presenceSurprise?: number` ([0,1]) after `sceneSurprise` in: `ipc.types.ts` `ActionOutcomePayload.metadata` (`:138-149`); the hand-duplicated `drive-engine.interfaces.ts` `IActionOutcomeReporter.reportOutcome` metadata (`:282-288`); the Zod schema `ipc-message-validator.ts` `ActionOutcomePayloadSchema.metadata` (`:42-48`, the `.min(0).max(1)` clamp is the load-bearing "no pre-computed delta" guard). **ADD `rules.ts` mapping (axis+delta IN-CHILD):** `ACTION_TYPE_DEFAULTS['PresencePressure'] = {Social:0.015, Curiosity:0.005, Anxiety:0.005}`; add `'PresencePressure'` to `METADATA_SCALED_ACTION_TYPES`; add the `computeDefaultAffect` branch scaling `delta * meta.presenceSurprise`. **Perception/decision never computes the drive delta.**
- **M-C1/M-C2b (unify) · BUILDABLE NOW.** **CREATE** `packages/decision-making/src/prediction/surprise-event.ts`: `SurpriseKind='scene'|'presence'`, `SurpriseEvent{kind; magnitude; source}`. **REFACTOR** `decision-making.service.ts`: new `private emitSurprise(event)` routing both the scene-surprise (`routeScenePredictionErrors`, def `:2413`, call `:1959`, `metadata.sceneSurprise` at `:2425`) and the unknown-person presence signal (`:1991-2013`) through **one** guarded `reportOutcome` shape; convert `unknownPersonCount → magnitude` via a named `PRESENCE_PER_PERSON` const so the child stays magnitude-scaled (replaces `UnknownPersonPressure` actionType with `PresencePressure` — **gate-row contract change**, flag to gate owner).
- **M-C3 (subsume the cycle-trigger) · BUILDABLE NOW — TRAP HELD.** **DELETE** the parallel `nudgeSceneChange` plumbing (`tick-sampler.ts` `sceneNudgeCallback`/`onSceneChange`/`nudgeSceneChange` `:132,135-137,147-152`; the `onSceneChange` registration in `startTickLoop` `:547-557`; gateway `SCENE_CYCLE_COOLDOWN_MS`/`lastSceneCycleAt`/nudge block `:37,61,251-255`) — **but re-home the `enqueue(sceneNudge turn)` cycle-trigger into the unified emitter** (§3 OPEN-14 trap). **ashby must ratify** the cooldown bound in its new home (§4).
- **M-C4 (SYSTEM_TRIGGER + full-latent fingerprint) · BUILDABLE NOW.** **MODIFY** `process-input.service.ts`: (1) `categorizeFrame` (`:213-239`) — emit the already-declared `'SYSTEM_TRIGGER'` (`:50`) for a scene/presence frame with no text/audio; (2) `generateFingerprint` (`:357-369`) — change `:363` `slice(0,64)` → the **full** `fused_embedding` (keep 2dp quantize at `:365`). **cortex must own** the recall discontinuity + threshold; **land with/after WS5 T2** (§4).
- **M-C-VERIFY:** `yarn build` + drive-engine/decision-making jest suites; confirm `presenceSurprise` typechecks end-to-end, the validator clamps [0,1], `computeDefaultAffect` returns the scaled map, and grep is clean of `nudgeSceneChange/onSceneChange/SCENE_CYCLE_COOLDOWN_MS` post-deletion. Update the P1b gate row's `UnknownPressure`→`PresencePressure` assertion.

### enforce-canon (cluster R7) — **BUILDABLE NOW**

- **MODIFY `canon-check.cjs:64`** — replace `Read wiki/CANON.md …` with a Read of `sylphie-tech-spec.md §9` (Six Immutable Standards, `:326`) + `§3.2` (Drive Isolation, `:99`).
- **MODIFY `canon-check.cjs`** — add `fs.existsSync(sylphie-tech-spec.md)` guard after `:8` → `exit(2)` if missing; flip the unparseable-response fallback (`:132-137`) `exit(0)`→`exit(2)`. Correct the parenthetical "Immutable Standard N" numbers at prompt `:72/74/76` to match real §9 ordering (Std 2 = Action ID Required). **Flag to Jim:** whether the CLI-launch-failure branch (`:116`) also becomes `exit(2)` (hard-block on flaky CLI) is a policy call.
- **MODIFY `enforce-canon/SKILL.md:23`** + (recommended same turn, it's in the execution path) `.claude/agents/canon.md:30`.
- **DEFER (sweep later, NOT this turn):** ~19 other dangling `wiki/CANON.md` refs + the distinct `docs/CANON.md` in `getConstraints.ts:104/143`. Leave `ws3-build-plan.md:34` (correct historical commentary); treat `update-canon/SKILL.md` as a semantics question for Jim.

---

## 7. Revised build sequence

```
M0  Substrate prereq (deps) ........... HARD GATE before any live verification   [§2]
│     pip install -r requirements.txt + add neo4j, insightface (watch numpy 2.x)
│
├─ SAM-INDEPENDENT BUILDABLES (after M0; parallel / any order) ──────────────────
│   M-A2  DINOv2 object-embedding swap (1024-D) — FIXES the already-dead path     [BUILDABLE NOW]
│   P1    Frame-dim plumbing incl. the 5th normalizer (ScenePredictionService)    [BUILDABLE NOW]
│   M-CANON  enforce-canon → real CANON (tech-spec §9) + fail-loud guards         [BUILDABLE NOW]
│   M-B-N  Neo4jGraphPersistence behind the interface (+ neo4j_schema)            [BLOCKED-ON-M0]
│   M-B4   ArcFace face path (512-D) + face_embeddings 1280→512 + query decouple  [BLOCKED-ON-M0]
│   M-B1…6 Unified BindingService (NestJS, keyed on SceneEntity.id) — ≈3-signal   [BUILDABLE NOW*]
│   OPEN-9 session-conditional spatial renormalization (recency proxy)            [BUILDABLE NOW]
│   M-C1…4 Surprise additive emitter + SYSTEM_TRIGGER + full-latent fingerprint   [BUILDABLE NOW]
│            (hold the cycle-enqueue trap; ashby + cortex ratify)
│   ── EfficientNet retired LAST, only after BOTH object(DINOv2)+face(ArcFace) live ──
│
└─ PARKED (pending video-core re-scope) ─────────────────────────────────────────
    M-A1  SAM 3.1 perception core (per-stream stateful push session)              [IMPOSSIBLE→PARKED]
    M-A3  retire greedy IoU / masklet-ID tracks (D3)                              [PARKED with SAM]
          ↳ Fork B binding key adapts to SceneEntity.id; nothing else moves
```
\* `BindingService` is buildable now but is **≈3-signal** until `visual_object_embeddings` gains `bounding_box`/`dominant_colors` (atlas) + a NestJS color path; Person path is BLOCKED-ON-M0 (ArcFace data).

**Ordering invariants:**
1. **M0 first** — nothing live-verifies before it.
2. **EfficientNet (`OnnxEmbeddingExtractor`) deleted LAST**, gated on `grep main.py` showing zero references — only after the object path is on DINOv2 **and** the face path is on ArcFace (it has two consumers).
3. **OPEN-9, P1, enforce-canon, the DINOv2 swap, and Fork C** are SAM-independent and need not wait on the parked perception core.
4. **The SAM perception-core swap is a separate, later workstream** scoped against SAM2.1-custom-predictor or a future real stateful SAM — not blocking A/B/C value delivery.

---

## 8. Resource budget (4080, 16 GB — preserved, annotated)

| Component | VRAM (fp16, est.) | Residency | Annotation |
|-----------|-------------------|-----------|------------|
| ~~SAM 3.1 (~840M) ~3.4 GB~~ | — | — | **PARKED (§1.1).** No SAM in substrate; row inert until the video-core re-scope. |
| DINOv2 ViT-L/14 (~300M) | ~0.6–1.2 GB | resident | `facebook/dinov2-large`, **~1.1GB one-time weight download** (HF hub cache empty; auto-downloads like Moondream/YOLO). **`torch` is CPU-only in this venv (`cuda=False`)** — DINOv2-large CPU inference is slower than EfficientNet (perf consideration, not a blocker). |
| ArcFace / InsightFace (`buffalo_l`) | ~0.1–0.3 GB | resident | **NEW (per-modality, 512-D).** Auto-downloads on first `FaceAnalysis()`; onnxruntime backend (CPU here). |
| MediaPipe Face Landmarker | ~0.1 GB | resident | Currently **absent from venv** → no faces today; restored by M0. |
| Moondream2 (~1.86B) | ~3.7 GB | **lazy** (surprise-gated) | Unchanged. |

Latency target drives D1 sizing (ViT-L vs ViT-B). With SAM parked there is no resident SAM cost; the buildable perception path is YOLO-seg + DINOv2 + (M0-restored) MediaPipe + lazy Moondream. The "set target FPS before M-A1 / drop-oldest FrameBuffer" caveat is **moot while M-A1 is parked** (the live path is the stateless per-POST `/detect` chain, not a streaming buffer).

---

## 9. Considered and dismissed (preserved — verified false against the repo)

Carried from v1 so they are not re-raised: (1) "A.5 spatial-IoU cap is a plan defect" — real property, now **resolved as OPEN-9**. (2) "D4 all-stores-vs-source-differs self-contradiction" — **resolved**: dims are per-modality (object 1024 / face 512). (3) "Deleting `feature_extraction.py` removes `DominantColorExtractor`" — real fact, handled (delete only the Onnx class; keep color extractor). (4) "C.2 surprise→drive is new" — confirmed **already-existing-and-compliant**; resolved as assert+extend (OPEN-16).

---

## Change log
- **2026-06-13 — Resolved v2.** Applies Jim's UNLOCK decisions over Grounded v1; resolves all 18 OPEN items. Substrate-verified at HEAD `4f0b473` + live `.venv` probe.
  - **IMPOSSIBLE→PARKED:** SAM 3.1 stateful push session does not exist as an installable model (no checkpoint, CLIP-from-git uninstalled, video predictors finite-video-bound, no `add_frame` API). Fork A perception-core swap parked per Jim's premise; **Fork B binding key adapts to `SceneEntity.id`** (not a "masklet" — 0 repo hits — and not the churning `trackId`).
  - **M0 hard gate:** the pipeline is largely dormant — `onnxruntime`/`mediapipe`/`neo4j` absent from venv (object embeddings already null, no faces detected, graph reads broken in-venv); add `neo4j` + `insightface`; watch numpy 2.x.
  - **Per-modality dims (D4 corrected):** object→1024 (DINOv2), face→512 (ArcFace), not uniform 1024.
  - **Honesty corrections baked in:** binder runs NestJS-side (Python = reference spec); A.5 is ≈3-signal day one for objects (color/size 0.0 until schema+color path); C.2 raw-signal-in is already satisfied (assert+extend, not rewrite); the `nudgeSceneChange` subsumption must keep the cycle-enqueue (trigger vs signal trap).
  - **OPEN-9 resolved** as a correctness mechanic (session/recency-conditional spatial renormalization; zero schema change), flagged for Jim's veto.
  - **Cross-agent ratifications surfaced:** ashby (`SCENE_CYCLE_COOLDOWN_MS` loop-gain), cortex (fingerprint-widening recall discontinuity + `queryByContent` threshold, land with WS5 T2), atlas (`visual_object_embeddings` schema extension + per-node-type weight profiles, no silent 0.55→0.75 collapse).

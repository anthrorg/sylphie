# Sylphie Computer Vision Framework

> **Living document.** Last updated: 2026-06-13.
> Scope: how Sylphie sees — capture, detection, tracking, embedding, face recognition,
> scene memory, and the cognitive encoders that turn pixels into the decision substrate.
> Maintained by the coordinator; update the *Change log* at the bottom on every edit.

---

## 0. TL;DR

- **Sensor is the browser.** `getUserMedia` → JPEG frames over a WebSocket. There is no
  server-side camera on the live path.
- **Models run in a Python FastAPI sidecar** (`perception-service`, port **8430**): YOLOv8n-seg
  (objects + masks), MediaPipe Face Landmarker (478 pts + 52 blendshapes), EfficientNet-Lite4
  ONNX (1280-D embeddings), Moondream2 VLM (scene captions).
- **NestJS orchestrates**: throttles to 15 FPS, calls the sidecar per frame, then runs scene-event
  detection, visual working memory (stabilization + identity resolution), and face recognition.
- **The "video model" into cognition is NOT learned.** Three hand-crafted feature encoders
  (video/scene/face) + fixed Xavier linear projections to a 768-D space, fused with the other
  modalities and EWMA-blended over time.
- **A second, richer pipeline exists but is dormant** (`PerceptionPipeline`): change-detection,
  spatial relations, observation building/validation, CANON A.5 persistence/surprise. Not on the
  live HTTP path.

---

## 1. Topology

```
Browser (getUserMedia)
  ├─ usePerception.ts ──JPEG/WS /ws/perception──► PerceptionGateway (NestJS) ──HTTP──► perception-service :8430
  │                                                     │                                  ├─ YOLOv8n-seg
  │                                                     │                                  ├─ MediaPipe Face Landmarker
  │                                                     │                                  ├─ IoUTracker (singleton)
  │                                                     │                                  ├─ EfficientNet-Lite4 (ONNX)
  │                                                     │                                  └─ Moondream2 VLM (/caption)
  │                                                     ▼
  │                                          SceneEventDetector → VisualWorkingMemory → FaceSnapshot
  │                                                     ▼
  │                                          TickSampler → SensoryFusion → SensoryFrame (768-D) → decision loop
  └─ useWebRTC.ts ──WebRTC /ws/webrtc──► WebRTCGateway (STUB — no SDP/ICE, no media consumed; see §11.4)
```

Two camera consumers in the frontend:
- **`usePerception`** → `/ws/perception`: the CV path (JPEG frames in, detection JSON out, overlays drawn client-side).
- **`useWebRTC`** → `/ws/webrtc`: peer-connection live streaming. **Does not feed detection.**

---

## 2. Stage 1 — Capture (`frontend/src/hooks/usePerception.ts`)

| Param | Value |
|-------|-------|
| Resolution | ideal **640×480** (`CAPTURE_WIDTH/HEIGHT`) |
| Frame rate | **15 FPS** (`CAPTURE_FPS`) |
| JPEG quality | **0.6** |
| Transport | `WebSocket('/ws/perception')`, frame sent as raw `ArrayBuffer` |

- Hidden `<video>` → offscreen canvas → `canvas.toBlob('image/jpeg', 0.6)`.
- Capture canvas sizes to `video.videoWidth/Height`, so the *true* frame size is whatever the
  camera negotiates (nominally 640×480, **not guaranteed** — see §11 caveat).
- A `requestAnimationFrame` loop renders overlays from the returned JSON: object contours,
  tracking boxes (VWM-resolved labels), face mesh/dots/contour/bbox, and the VLM caption bar.
- Toggleable annotation layers: `objects`, `tracking`, `face-mesh`, `face-dots`, `face-contour`, `face-bbox`.

---

## 3. Stage 2 — Gateway (`apps/sylphie/src/gateways/perception.gateway.ts`)

- `@WebSocketGateway({ path: '/ws/perception' })`.
- **Throttle: 15 FPS** + a `processing` boolean → "latest frame wins", no backlog.
- POSTs JPEG to `${PERCEPTION_HOST:-http://localhost:8430}/perception/detect`.
- Fans response out to: `TickSampler.updateVideoDetections / updateFaces / updateScene`,
  `SceneEventDetector.detectEvents`, `VisualWorkingMemory.updateScene`, `FaceSnapshot.processFaceFrame`,
  and a throttled VLM caption request.
- **VLM caption triggers**: cooldown **5 s**, periodic **30 s**, or on scene-change events
  (object/person appeared/disappeared). Fire-and-forget; never blocks detection.
- Sends enriched JSON back to the browser: `{...result, scene_events, vwm_entities, vlm_caption}`.

---

## 4. Stage 3 — Python model service (`packages/perception-service/main.py`)

FastAPI, port 8430. `_AppState` holds singletons (detector, tracker, face detector, lazy
embedding extractor, lazy VLM). Per-request detection (no running camera pipeline);
persistence check is a `_NullPersistenceCheck` (NestJS owns graph writes).

### `POST /perception/detect` per-frame chain
1. **Decode** JPEG → OpenCV BGR → **RGB raw bytes** in a `Frame` (`_decode_jpeg_to_frame`).
2. **YOLO** object detection + segmentation.
3. **MediaPipe** face detection (parallel).
4. **IoU tracking** (singleton, identity persists across calls).
5. **EfficientNet embedding** per CONFIRMED track (mask-aware).

Response: `{ detections[], faces[], face_connections[], face_oval[], tracked_objects[] (w/ embeddings), scene_summary }`.

### Endpoints
| Endpoint | Purpose | State |
|----------|---------|-------|
| `POST /perception/detect` | objects + faces + tracks + embeddings | **active** |
| `POST /perception/detect-annotated` | + server-drawn boxes (base64 JPEG) | active |
| `POST /perception/crop-face` | masked face crop + 1280-D embedding | active |
| `POST /perception/caption` | Moondream2 scene caption | active (lazy) |
| `GET /perception/health` | model-loaded flags | active |
| `GET /perception/status` | pipeline state + track count | active |
| ~~`GET /perception/stream[/raw]`~~ | MJPEG | **deleted** (Phase 4 Wave 1 — dead code, pipeline never active) |

### Models (exact)
| Role | Model | Config | Source |
|------|-------|--------|--------|
| Objects + **instance segmentation** | **YOLOv8n-seg** (ultralytics) | `yolov8n-seg.pt` (default in `config.py::DetectionConfig`); conf **0.25**; NMS IoU **0.45**; raw COCO labels; `mask_polygon` emitted | `config.py` / `detector.py` |
| Face | **MediaPipe Face Landmarker** | `face_landmarker.task` (float16); **478** landmarks; **52** blendshapes; `num_faces=5`; conf **0.5**; short-range (`model_selection=0`, <2 m) | `face_detector.py` |
| Visual embedding | **EfficientNet-Lite4 ONNX** → **1280-D** | input **224×224**, ImageNet mean/std, NCHW; providers `[CUDA, CPU]`; auto-download | `feature_extraction.py` |
| Scene caption | **Moondream2** (`vikhyatk/moondream2`, ~1.86 B) | transformers, `trust_remote_code`; float16/CUDA, **float32/CPU**; lazy | `main.py::_init_vlm` |

### IoU tracker (`tracker.py`)
- **Greedy** highest-IoU assignment (intentionally replaces scipy Hungarian; pure stdlib).
- `iou_threshold=0.3`, `min_confirm_frames=3`, `max_lost_frames=15`.
- States `TENTATIVE → CONFIRMED → LOST → DELETED`; IDs monotonic from 1.
- `TrackedObject` frozen (Pydantic) — transitions create new instances. Singleton on `_AppState`.
- Transition rules: TENTATIVE+match → `frames_seen++`, promote at ≥3; CONFIRMED/TENTATIVE+miss → LOST(1);
  LOST+match → CONFIRMED(reset); LOST+miss → `frames_lost++`, DELETED at ≥15.

### Embedding extraction (`main.py::_extract_track_embedding`)
- CONFIRMED tracks only. Crops bbox; if a YOLO-seg `mask_polygon` is present, **zeroes background
  pixels** (cv2.fillPoly) before embedding → vector represents the object, not its surroundings.
- Lazy `OnnxEmbeddingExtractor`, thread-safe double-checked locking. Returns `null` on failure
  (sets a global `_embedding_init_failed` to stop retrying).

---

## 5. Stage 4 — Scene understanding (NestJS)

### SceneEventDetector (`scene-event-detector.service.ts`)
Diffs CONFIRMED tracks frame-to-frame → emits events:
`OBJECT_APPEARED/DISAPPEARED`, `PERSON_ARRIVED/LEFT`, `FACE_IDENTIFIED`, `FACE_OCCLUDED`
(person bbox persists but its overlapping face vanished). Person appearances/re-ids call
`FaceSnapshot.identifyFace(embedding)`. Keeps `previousObjects` + `previousFaceTracks` maps.

### VisualWorkingMemory (`visual-working-memory.service.ts`)
Stabilizes noisy tracker output into durable **SceneEntity** objects.

| Param | Value | Meaning |
|-------|-------|---------|
| `PRESENCE_WINDOW_SIZE` | **30** frames (~2 s) | rolling presence window |
| `ENTER_RATIO` | **0.70** | entering→present |
| `EXIT_RATIO` | **0.20** | present→leaving |
| `GONE_RATIO` | **0.0** + `LEAVING_TIMEOUT_MS` 2000 | leaving→gone |
| `OBJECT_MATCH_THRESHOLD` | **0.75** cosine | object re-id via pgvector |
| `REASSOCIATION_IOU_THRESHOLD` | **0.3** | re-bind new track to leaving entity |
| `MAX_SCENE_ENTITIES` | **100** | prune oldest gone |

- **Object identity**: cosine search over TimescaleDB `visual_object_embeddings`
  (`vector(1280)`, ivfflat `lists=100`). Unknown → `:VisualObject` WKG node (`confidence 0.40`,
  provenance `SENSOR`), embedding stored. Discovery (guardian names it) → confidence floor **0.60**,
  provenance `GUARDIAN`.
- **Person identity**: face centroid match; new face → OKG `:Person` placeholder
  `unknown-person-<uuid8>` + face embedding stored for later matching.
- Exposes `getSceneDescription()` (deliberation prompt "What I see"), `getVisibleEntities()`
  (frontend widget), and undiscovered-object / unknown-person counts (feed curiosity & social drives).

### FaceSnapshot (`face-snapshot.service.ts`) — face recognition
Three tiers: **hot** (in-memory per-person centroid), **warm** (TimescaleDB `face_embeddings vector(1280)`),
**cold** (OKG `FaceSnapshot` nodes w/ base64 crops).

| Param | Value |
|-------|-------|
| Angles collected | frontal / left / right / up / down |
| `IDENTIFICATION_THRESHOLD` | **0.55** cosine (low — embeddings vary by head angle) |
| `CROP_INTERVAL_MS` | **1500** |
| `MIN_CONFIDENCE` | **0.65** (face conf to attempt crop); needs ≥455 landmarks |
| `FACE_EMBEDDING_DIM` | **1280** |

- `classifyAngle` uses landmarks **1** (nose), **234/454** (cheeks), **159/386** (eyes) → yaw/pitch
  proxies with dead zones (same math as `FaceEncoder`).
- `/crop-face` pads bbox 15%, builds a **convex hull mask** from landmarks, embeds the masked crop.
- Centroid update = incremental mean; hot layer hydrated from TimescaleDB on startup.

---

## 6. Stage 5 — Cognitive encoders (`packages/decision-making/src/inputs`)

> **These are hand-crafted feature extractors + a fixed Xavier-initialized linear projection — NOT learned vision models.** Target `EMBEDDING_DIM = 768`.

| Encoder | Modality name | Features → 768 | Captures |
|---------|---------------|----------------|----------|
| `VideoEncoder` | `video` | **26** | 20-slot COCO histogram + count + mean bbox center/area + mean/max conf |
| `SceneEncoder` | `scene` | **35** | histogram + person count + primary-person bbox + mean conf + scene stability + appeared/lost + identified-face count + 4-quadrant density |
| `FaceEncoder` | `faces` | **20** | face count + primary bbox + 6 blendshape-group means + landmark mean/spread + yaw/pitch/roll proxies + expression intensity |

- Shared 20-class vocabulary (video + scene kept in sync):
  `person, car, chair, book, bottle, cup, laptop, cell phone, tv, cat, dog, bed, couch,
  dining table, potted plant, backpack, handbag, keyboard, mouse, remote`.
- All return a zero vector when their modality is empty.
- Per-encoder deterministic seeds: video `0xa1de0`, scene `0x5ce0e`, face `0xface0`.

### Fusion + temporal blend
- **`SensoryFusionService`**: concatenate all registered modality embeddings (N × 768) → project
  to 768 via one Xavier matrix (seed `0xf05e`). Missing modalities contribute zeros. Registry-driven
  (adding a modality never touches fusion). `skipNetworkEmbedding` zeroes network-bound encoders
  (`text`) under the Lesion Test.
- **Concat order is ALPHABETICAL** by `modalityName` (`ModalityRegistryService.getAll()` sorts via
  `localeCompare`). So the concatenated vector is ordered `audio, drives, faces, scene, text, video, …`.
  Deterministic; both fusion and the per-encoder slot mapping depend on it.
- **`TickSamplerService`**: holds latest raw value per modality; on `sample()` fuses then **EWMA-blends**
  (`alpha=0.3`, rolling window 30) into `SensoryFrame.fused_embedding`. Video/face/scene are **not**
  event-driven (only text/audio force a tick).

### Projection math (`linear-algebra.ts`) — verified
- `xavierMatrix(rows, cols, seed)`: fills `rows×cols` with `U(-limit, +limit)`, `limit = √(6/(rows+cols))`
  (Glorot uniform), drawn from a **mulberry32** seeded PRNG. **Deterministic across restarts — there is
  no training pipeline.** Every encoder + fusion projection is a fixed random linear map.
- `linearProject(W, x, b)`: plain `y = Wx + b`. No nonlinearity anywhere in the encode→fuse path.
- `ModalityRegistryService.register()` **throws on duplicate** `modalityName`. `getEventDrivenNames()`
  drives which slots TickSampler clears each tick.

### SensoryFrame shape (`sensory-frame.ts`)
`{ timestamp, fused_embedding[768], modality_embeddings{name→[768]}, active_modalities[], raw{name→value} }`.
`EMBEDDING_DIM = 768`. `VideoDetection = {class, confidence, bbox[]}`. The shared `FaceDetection` carries
`landmarks: number[][]|null` + `blendshapes: Record<string,number>|null`.

### Gate discriminator (`scene.types.ts`)
`TrackedObjectDTO.synthetic?` (WS5 T0.8): the real Python sidecar never sets it (absent→false); the gate's
perception cassette sets it `true` so VWM marks the WORLD `:VisualObject` node `synthetic:true` (a distinct
boolean — `provenance_type` stays `SENSOR`, atlas ruling 2026-06-13). `perception-reset` then deletes
`MATCH (n:VisualObject {synthetic:true})`. Data-carried, not a `GATE_MODE` code branch.

---

## 6b. Stage 6 — Downstream into cognition (`process-input.service.ts`)

The fused `SensoryFrame` enters the decision FSM's CATEGORIZING + RETRIEVING states:

1. **Categorize** by active modalities → `VISUAL_INPUT` (video only), `MULTIMODAL_INPUT`
   (>1 non-drive modality), `GUARDIAN_FEEDBACK`, `DRIVE_SENSOR_TRIGGER`, etc.
2. **Entity extraction** from raw modality data (not the embedding):
   - video: YOLO `det.class` where `confidence > 0.5`
   - scene: VWM CONFIRMED object `label` + `personId`
   - `undiscovered_count > 0` → injects `unknown, unrecognized, object` (curiosity routing)
   - `unknown_person_count > 0` → injects `unknown, person, stranger, face, who` (social routing)
3. **Context fingerprint** = `SHA-256( category :: first-64-dims-of-fused-embedding(quantized 2dp) :: dominantDrive )`.
   ⚠️ Only the **first 64 of 768** fused dims feed the fingerprint.
4. Fingerprint → episodic-memory context query + WKG action-candidate retrieval; candidates capped at
   **5** (Cowan's limit), Type-1 (has procedure) ranked before Type-2.

**Architectural fact:** vision is **ambient context, not a trigger.** Because `video/scene/faces` are
not event-driven, a camera change alone never forces a decision cycle — it only colors the next tick
that text/audio or the continuous loop produces. Curiosity/social *pressure* (undiscovered counts) is
how the visual field actually pulls Sylphie's attention.

---

## 7. Dormant pipeline (built, not on the live path)

`PerceptionPipeline` (`pipeline.py`) — the "real" async design, used in tests and ready but not
driven by the HTTP service:

- **Producer/consumer**: capture task fills a drop-oldest `FrameBuffer`; processing loop runs at
  **3 FPS**. CPU-bound detect/track dispatched to a thread executor.
- **Change-detection gate**: MD5 frame hash; **30-frame warmup** (`_WARMUP_FRAMES`), then skips
  unchanged frames — **disabled by default** (`_change_detection_enabled=False`).
- **ObservationBuilder** (`observation_builder.py`): CONFIRMED tracks → `Observation` (normalized
  bbox, embedding, dominant colors, provenance SENSOR, candidate_node_id from persistence). Debounce:
  skip re-emit when IoU > `debounce_iou_threshold` (default **0.95**) **and** features unchanged.
- **ObservationValidator** (`observation_validator.py`): rejects on min area fraction (**0.001**),
  min confidence (**0.30**), embedding L2 norm (**0.1**–**100**), aspect ratio (**0.1**–**10**).
  Cumulative reject counters.
- **SpatialRelationshipExtractor** (`spatial_extractor.py`): geometry predicates between CONFIRMED
  objects — `left_of/right_of/above/below` (margin **0.05**), `near` (centroid dist < **0.15**),
  `on_top_of` (A's base in B's top half + A smaller). Normalized coords; provenance INFERENCE; **no
  depth** (monocular). "Dorsal stream / where pathway" per Luria.
- **CANON A.5 persistence check** (`persistence_check_service.py`): the *only* Layer 2→Layer 3 read
  boundary — calls exactly one method, `find_nodes_by_embedding()`. **Multi-modal match score** over
  5 signals with **Piaget R1 dynamic weights** that shift by `confirmation_count`:
  - new (`<5`): `spatial 0.50, embedding 0.25, color 0.15, size 0.05, label 0.05`
  - known (`≥10`): `embedding 0.45, color 0.25, spatial 0.15, size 0.10, label 0.05`
  - 5–10: linear interpolation.
  Signals: embedding cosine, spatial IoU, color Jaccard (4×4×4 bins), size ratio, label exact (soft
  bonus, Piaget R3). Classify by `match_threshold 0.75` / `ambiguity_threshold 0.45`. **surprise_flag**
  (Piaget R2): set when a well-known object (`confirmation_count ≥ 5`) has embedding distance >
  `surprise_threshold 0.3`. Does **not** create POSSIBLE_DUPLICATE_OF edges (that's Layer 3, D-TS-01).
- **DominantColorExtractor**: 8×8×8 RGB histogram (512 bins), pure-Python, no cv2.

Also dormant: `CameraFrameSource` + `VideoFileSource` (cv2.VideoCapture, JPEG-encode, run in executor;
`CameraConfig` 1280×720/15fps/device 0), MJPEG streams, `DebugAnnotator`/`DebugFrameStore`.

**Activation status:** `PerceptionPipeline` is **never instantiated in `main.py`** — `_startup()` builds
only the detector, tracker, and face detector; `_run_pipeline()` is defined but never called.
`_AppState.pipeline` stays `None`. Only the test suite constructs the pipeline. Promoting it to the live
path would mean wiring a `FrameSource` (browser frames or camera) + a real `PersistenceCheck` (replacing
`_NullPersistenceCheck`) + the A.5 graph backend.

### Two object-identity systems (only one is live)
| | Live (VWM, NestJS) | Dormant (A.5, Python) |
|---|---|---|
| Signals | embedding cosine only | embedding + spatial + color + size + label |
| Weights | n/a (single signal) | dynamic by confirmation_count (Piaget R1) |
| Threshold | 0.75 cosine | match 0.75 / ambiguity 0.45 |
| Surprise/novelty | none (VWM has no surprise flag) | surprise_flag (Piaget R2) |
| Store | TimescaleDB pgvector | Neo4j via `find_nodes_by_embedding` |

The live path therefore loses the multi-signal robustness and the surprise/novelty signal that the
dormant A.5 scorer was designed to provide.

---

## 8. Core data types (`types.py`, Pydantic, frozen)

- `Frame`: frame_id, frame_sequence, observed_at, width, height, `data: bytes`, session_id.
- `Detection`: label_raw, confidence, bbox_{x,y}_{min,max}, frame_id, `mask_polygon?`.
- `FaceDetection`: confidence, bbox, `landmarks: [(x,y)×478]?`, frame_id, `blendshapes: {name:score}?`.
- `FeatureProfile`: `dominant_colors?`, `embedding?`.
- `TrackedObject`: track_id, state, detection, features?, frames_seen, frames_lost, first/last_seen_at.
- `PersistenceResult`: matched_node_id?, confidence, match_type, surprise_flag, ambiguous_candidates.

**Layer 2→3 contract** (`shared/observation.py`, dormant path):
- `BoundingBox`: pixel coords + frame dims; validates `x_min<x_max`, `y_min<y_max`; computed
  `center_x/y`, `width`, `height`, `area_fraction = box_area / (frame_w*frame_h)`.
- `Observation` (frozen): observation_id, session_id, label_raw, confidence, bounding_box, embedding?,
  dominant_colors?, timestamp, provenance, candidate_node_id?.
- `Provenance` (`shared/provenance.py`, frozen): source, source_id, timestamp, confidence. **Five fixed
  CANON A.11/A.18 categories:** `SENSOR`, `GUARDIAN`, `INFERENCE`, `GUARDIAN_APPROVED_INFERENCE`,
  `TAUGHT_PROCEDURE`. Camera detections are `SENSOR`; spatial relations are `INFERENCE`.

---

## 9. Persistence surfaces

| Store | What | Where |
|-------|------|-------|
| TimescaleDB `face_embeddings` | `vector(1280)` per (person, angle) | FaceSnapshot warm layer |
| TimescaleDB `visual_object_embeddings` | `vector(1280)` + node_id, discovered, sighting_count | VWM object re-id |
| Neo4j WORLD (WKG) | `:VisualObject` nodes (conf 0.40 → 0.60 on discovery) | VWM |
| Neo4j OTHER (OKG) | `:Person` + `:FaceSnapshot` (HAS_FACE_SNAPSHOT) | FaceSnapshot / VWM |
| In-memory | face centroids, scene entities, tracker state | hot layers |

---

## 10. Key constants quick-reference

```
Capture:     640×480 ideal, 15 FPS, JPEG q0.6
Gateway:     15 FPS cap, drop-if-processing
YOLO:        yolov8n-seg, conf 0.25, NMS 0.45
Face:        MediaPipe, 478 lm, 52 blendshapes, num_faces 5, conf 0.5
Embedding:   EfficientNet-Lite4 ONNX, 224×224, 1280-D
VLM:         Moondream2, caption cooldown 5s / periodic 30s
Tracker:     IoU 0.3, confirm 3, lost 15 (greedy)
VWM:         window 30, enter 0.70, exit 0.20, gone 0.0+2s, obj match 0.75, reassoc IoU 0.3
Face id:     cosine 0.55, crop every 1500ms, min conf 0.65
Encoders:    video 26→768, scene 35→768, face 20→768 (hand-crafted + Xavier)
Fusion:      concat N×768 → 768; EWMA alpha 0.3, window 30
Dormant:     pipeline 3 FPS, warmup 30, debounce IoU 0.95, persistence sim 0.7/match 0.75
```

---

## 11. Known inconsistencies / risks

1. **"EfficientNet-B0" is actually EfficientNet-Lite4.** Class name, filename (`efficientnet_b0.onnx`),
   and docstrings say B0; `_DEFAULT_MODEL_URL` downloads `efficientnet-lite4-11.onnx`. 1280-D either
   way, but the label is wrong throughout (also propagated into FaceSnapshot/types comments). Matters
   if preprocessing/normalization is ever tuned. *(Cross-check confirmed: `_DEFAULT_MODEL_FILENAME=efficientnet_b0.onnx`
   and `scene.types.ts` carries the B0 label in its comment.)*
1b. **`model_path` docstring drift.** The effective YOLO default is `yolov8n-seg.pt` (the `config.py::DetectionConfig`
   Field — what actually loads). But `detector.py`'s own module/class **docstring still says `yolov8n.pt`**
   (the non-seg variant). Harmless today, but a reader trusting the docstring would think masks are off.
2. **640×480 hardcoded normalization.** `VideoEncoder`, `SceneEncoder`, `FaceEncoder`, and
   `FaceSnapshot.classifyAngle` hardcode `FRAME_W/H = 640/480`. Browser requests *ideal* 640×480, so
   usually matches — but `getUserMedia` "ideal" is not a guarantee; if the camera negotiates e.g.
   1280×720, all normalized center/area/pose features silently skew. Python `CameraConfig 1280×720`
   only affects the dormant pipeline.
3. **Two coexisting pipelines.** The sophisticated machinery (surprise/expectation, spatial relations,
   change detection, validation) lives only in the dormant `PerceptionPipeline`. The live path is
   per-frame detection with all "memory" reconstructed NestJS-side in VWM.
4. **`/ws/webrtc` is a non-functional stub.** `WebRTCGateway` accepts the connection and logs — no
   SDP/ICE handling exists ("handled when implemented"). The frontend `useWebRTC` waits for a `ready`
   message the server never sends, so no peer connection forms and no media is streamed server-side.
   `usePerception` mislabels its feed mode `'webrtc'` on WS open, but it is the JPEG-over-WS path.
   **All vision flows through `/ws/perception`.** WebRTC streaming is effectively dead code today.
5. **Fingerprint truncation.** Context fingerprints hash only the first 64 of 768 fused dims (§6b),
   so two scenes differing only in later dims collide. Likely fine in practice (early dims carry the
   projection's dominant variance) but worth knowing when debugging episodic-recall collisions.

---

## 12. Open questions / to investigate

- [x] ~~How does the fused video embedding flow downstream?~~ → §6b. Categorize → fingerprint (first
      64 dims) → episodic + WKG retrieval. Vision is ambient, non-triggering context.
- [x] ~~Server-side `/ws/webrtc` — what consumes the tracks?~~ → Nothing; it's a stub (§11.4).
- [x] ~~`PersonModelService` / active person id~~ → `getActivePersonId()` (idle/self-tick fallback,
      last speaker) gates `FaceSnapshot.processFaceFrame` so collected face snapshots associate with
      whoever was last active. Per-turn code uses explicit `userId` instead (WS4-T4 anti-thrash).
- [x] ~~Is `PerceptionPipeline` ever activated?~~ → No; never instantiated in `main.py` (tests only).
      Promotion needs a FrameSource + real PersistenceCheck + A.5 graph backend (§7).
- [ ] Frame-size negotiation: should encoders read true frame dims instead of hardcoding 640×480?
- [ ] Should the fingerprint hash more than the first 64 fused dims? (collision risk, §11.5)
- [ ] Should the live path adopt the dormant A.5 multi-signal scorer + surprise flag? (§7 table)
- [ ] Audio modality is referenced (event-driven, audio.encoder) but out of scope here — does the
      audio→latent path mirror this one? (separate doc candidate)

---

## Change log
- **2026-06-13** — Initial document. Full map of live path (capture → sidecar → scene/face → encoders →
  fusion) and dormant `PerceptionPipeline`. Authored from direct code read of `perception-service`,
  `apps/sylphie/src` perception services/gateway, and `decision-making/src/inputs`.
- **2026-06-13** — Round 2. Added §6b downstream-into-cognition (categorize → fingerprint → retrieval;
  vision is ambient/non-triggering). Read the dormant `observation_builder`/`observation_validator`/
  `spatial_extractor`/`frame_sources`/`types`. Resolved 3 open questions: `/ws/webrtc` is a
  non-functional stub (§11.4), fingerprint hashes only first 64/768 dims (§11.5), `PersonModelService`
  active-person gating of face-snapshot collection.
- **2026-06-13** — Round 3. Read `persistence_check_service.py` (A.5 multi-modal scorer) and confirmed
  `PerceptionPipeline` is never instantiated in the service (tests only). Documented the dormant A.5
  scorer (5 signals, Piaget R1 dynamic weights, R2 surprise) and the **two object-identity systems**
  table — live VWM single-signal cosine vs. dormant A.5 multi-signal. Framework dive complete.
- **2026-06-13** — Round 4 (cross-verification). Diffed every claim against the independent per-file
  fragment reads in `wiki/architecture/_data/` (separate agents, separate reads). **All constants matched**
  — config thresholds, tracker, embedding dims, A.5 weights, VWM, FaceSnapshot, gateway, capture params,
  provenance. Two refinements: YOLO default `yolov8n-seg.pt` cited to `config.py` (not `detector.py`),
  and added §11.1b — `detector.py`'s docstring still says `yolov8n.pt`. No factual errors found.

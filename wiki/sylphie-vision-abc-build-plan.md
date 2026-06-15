> **Provenance.** This document is the synthesized, final vision build plan. It derives from four source documents — `wiki/cv-framework.md` (the live pipeline map), `docs/explorations/sylphie-vision-architecture.md` ("Seeing Clearly" keep/change/remove/add), `docs/explorations/2026-06-13-advanced-computer-vision.md` (the 6-agent exploration / 12-move sequence), and the resolved A/B/C decision docs (`wiki/sylphie-abc-build-plan-grounded.md` + `wiki/sylphie-abc-build-plan-resolved.md`) — merged with a phase-1 ground-truth pass, three design tracks (testing suite / improvement roadmap / integration verification), and three adversarial reviews (mythos, canon, ashby). Synthesized via the coordinator workflow. Baseline: **HEAD `4f0b473`** (worktree `worktree-vision-abc-plan`; note the worktree is one commit behind main `d123504` — verify every `file:line` against the branch the implementation actually targets before writing code). Jim's resolved A/B/C decisions are carried as **FIXED** and are not re-litigated here; see `sylphie-abc-build-plan-resolved.md` for their full adjudication.
>
> **Citation discipline.** The three adversarial reviews caught several `file:line` anchors that had drifted from source or referenced symbols that do not exist. Those have been corrected inline and re-verified against HEAD in this pass (see §2 and the "review correction" callouts). Treat all remaining line numbers as hints — the architecture map is generated at `4f0b473` and may be stale; re-grep each symbol before implementing.

# Sylphie Vision — Improve, Integrate, and Test (the A/B/C build plan)

## 1. TL;DR

- **The vision path is built but dormant.** The live CV path (Browser `getUserMedia` → JPEG over `/ws/perception` → `PerceptionGateway` 15fps throttle → FastAPI sidecar `:8430` → YOLOv8n-seg + IoU tracker + EfficientNet ONNX + MediaPipe + Moondream2 → NestJS `SceneEventDetector`/VWM/`FaceSnapshot` → 768-D `SensoryFrame` → decision loop) executes end-to-end **only when the Python sidecar is healthy** — and it is not.
- **M0 is a hard substrate gate.** The perception-service `.venv` is missing `onnxruntime` (→ object embeddings are NULL in prod today), `mediapipe` (→ zero faces detected), `neo4j` (→ in-venv graph reads broken), and `insightface` (→ ArcFace blocked). `requirements.txt` lists `onnxruntime`+`mediapipe` but not `neo4j`/`insightface`. **Nothing live-verifies until M0 closes.** torch is CPU-only (`cuda=False`).
- **The single highest-leverage flaw: the richest visual signal is computed, then discarded at the cognitive boundary.** The 1280-D EfficientNet embedding is computed per *confirmed track* and reaches NestJS on `tracked_objects[].embedding` (`perception.gateway.ts:142`), flows to `SceneEventDetector`/VWM — but is **never handed to the fusion encoders**. Cognition's entire "video understanding" is a 26-float COCO histogram → fixed-random 768-D projection (`video.encoder.ts`). Two visually distinct same-class scenes (mug-on-desk vs book-on-desk) collapse to near-identical latents.
- **Review correction (mythos, blocker).** This discard is a *cross-array topology* issue, not "`VideoEncoder` ignores `TrackedObjectDTO.embedding`." `VideoEncoder` is fed `VideoDetection[]` = `{class,confidence,bbox}` (no embedding field, verified `video.encoder.ts:2`); the embedding rides a *separate* array (`tracked_objects`). The #0 fix is therefore a **new `visual_embedding` modality sourced from `tracked_objects[].embedding`**, not a tweak to `VideoEncoder`. Effort revised up from "1–2d near-zero" to "small–medium, low-but-not-trivial" because it touches fusion registration and the fingerprint version.
- **Strategy: promote what's already built, in dependency order, behind one hard deps gate, with recall before triggering.** The do-first cluster (#0 visual_embedding modality, #1 A.5 multi-signal scorer ported to a NestJS `BindingService`, #2 mutable instance centroids, #3 full-latent versioned fingerprint) is mostly *promotion of dormant code* on the *existing* EfficientNet vectors, stability-neutral-to-positive, and it unblocks everything downstream.
- **Recall-before-triggering is a verified correctness constraint, not a preference.** `latent-space.service.ts:387-397` hard-requires a *text* match for any multimodal retrieval hit (verified verbatim). A vision-only `SYSTEM_TRIGGER` cycle before grounded visual recall enters deliberation with **nothing retrievable** — pure ungrounded Type-2 load, driving toward the "Type-2 Addict" attractor (ashby). So triggering (Fork C) lands **last** among the SAM-independent buildables.
- **Review correction (mythos, blocker).** #0 alone does **not** make vision-only scenes recallable — `searchMultiModal` still returns null without a text match after #0. A concrete code change is therefore added as **P1.5**: route vision recall through a per-modality `searchByModality('visual_embedding')` path (or relax the text-required gate for `SYSTEM_TRIGGER` frames), with its own test. Without it, the C-acceptance is un-passable as written.
- **Three stability invariants are protected through every change.** (1) Relief stays epistemic — never pay curiosity/social relief for anything but durable knowledge/identity change; (2) the embedding stays stable OR its change is a frozen+versioned+migration-gated phase transition; (3) the world cannot unconditionally command the decision loop (trigger only on settled-semantic change, rate-limited, habituating).
- **Backbone swaps are versioned destructive migrations, never online drift.** DINOv2-base 768-D for objects (buildable now — torch/transformers installed; 768 == fused EMBEDDING_DIM so the JL projection is deleted), ArcFace 512-D for faces (M0-blocked on `insightface`), per-modality dims (768 object / 512 face, NOT uniform). EfficientNet is retired LAST behind a grep gate (two consumers).
- **Fork C is fully net-new triggering — there is no legacy enqueue to "keep."** Review correction (mythos, blocker): `nudgeSceneChange`, `SCENE_CYCLE_COOLDOWN_MS`, `sceneNudgeCallback`, `onSceneChange` **do not exist in source** (zero `.ts` matches; they appear only in earlier plan drafts). `determineCategory` never produces `SYSTEM_TRIGGER` today (the category exists in the union at `process-input.service.ts:50` with no producer). Fork C is written as a *forward requirement* (a new emitter that enqueues a `SYSTEM_TRIGGER` cycle AND emits a clamped raw-magnitude drive signal as two distinct actions) — not as preservation of existing code.
- **The cassette does NOT mask a regression.** Review correction (mythos, blocker): `test/gate/cassette.json` is keyed by Ollama request-body hashes; it has zero perception entries, and `gate.ts` never intercepts `:8430`. The "1280-D vector masking prod-null" narrative is **false** — vision is simply untested. The honest regression sentinel is the **live pgvector null-rate query** plus **net-new perception-path interception** added to the gate harness.
- **The CANON no-precomputed-delta guard is real but the "Zod rejects `driveEffects`" test is not writable.** Review correction (mythos/canon, major): `ipc-message-validator.ts:68` ends in `.passthrough()`, so an injected top-level `driveEffects` is *silently preserved*, not rejected. The real, verified guarantee: the drive engine never *reads* a payload `driveEffects` field (effects computed in-child via `computeDefaultAffect`). The fix: either tighten to `.strict()` (a small real CANON-hardening change) **or** assert the engine *ignores* an injected field. The `sceneSurprise`/`sensoryPredictionError` `.min(0).max(1)` clamps ARE genuine executable guards.
- **The headline deliverable: there is no integrated vision test suite today, and this plan builds one.** Today: 2 Python test files (neither constructs the pipeline), zero `*.spec.ts` in `apps/sylphie` (no jest config), zero vision specs in `decision-making`, a gate that exercises only the text WebSocket, an E2E "vision" phase that is a 30-second manual wave-at-camera window with **zero automated assertions**, and **no fixtures** (no synthetic JPEGs, golden vectors, or seeded DB rows). The plan adds a 7-layer suite (unit / component / contract / integration / E2E-smoke / regression-property / fixtures+tooling), CI-blocking vs nightly, each improvement shipping **with** its test.
- **Verification is end-to-end and live.** Eight integration seams each get one copy-pasteable assertion; the A/B/C acceptance tests become runnable tsx smokes; a mythos live-smoke checklist must tick on a real run before any phase closes; and a health/observability dashboard (embedding-null rate, face-detect rate, re-id hit rate, surprise/cycle rate, relief=0 sanity, provenance integrity) provides the ongoing "is it actually working" backbone.
- **Open questions surfaced for Jim, not invented around:** unmeasured CPU latency (DINOv2-base at 15fps ~69ms/crop — mitigated by P3.1's confirm-gate + every-Nth throttle, but still watch effective FPS); Neo4j class-correct-vs-live-wired scope; object-crop retention for re-embedding migration; ByteTrack adopt/forbid (the one Seeing-Clearly item with no home in either other doc); cassette honesty-vs-green default; and the `.passthrough()`→`.strict()` CANON-hardening decision.

---

## 2. Current state — what works, what's dormant, what's broken

All claims below were re-verified against source this pass. The architecture map is generated at `4f0b473` and may be stale — these are the load-bearing facts re-read directly.

### 2.1 The live CV path (topology)

```
Browser getUserMedia @640×480, 15fps, JPEG q0.6
  └─► WS /ws/perception  (usePerception.ts — raw JPEG bytes, NO frame-dims, NO sequence in envelope)
        └─► PerceptionGateway (NestJS)  — 2-level throttle: time-gate 66ms + in-flight mutex; latest-wins drop
              └─► POST :8430/perception/detect  (FastAPI sidecar, image/jpeg body)
                    • YOLOv8n-seg            → detections[] {label_raw, confidence, bbox_*, mask_polygon}
                    • IoU tracker            → tracked_objects[] {track_id, state, bbox, embedding|null}
                    • EfficientNet-Lite4 ONNX (1280-D) per CONFIRMED track  ← NULL in prod (onnxruntime absent)
                    • MediaPipe Face Landmarker → faces[]                    ← EMPTY in prod (mediapipe absent)
                    • Moondream2 VLM (lazy)  → /perception/caption
              ◄─ JSON {detections, faces, tracked_objects, scene_summary}   (NO frame_width/height)
              ├─► tickSampler.updateVideoDetections({class,confidence,bbox})  ← embedding DROPPED here
              ├─► faceSnapshot.processFaceFrame(...)  (fire-and-forget)
              ├─► sceneEventDetector.detectEvents(trackedObjects, faces, summary)
              ├─► vwm.updateScene(...)  (writes :VisualObject to neo4j-world + pgvector visual_object_embeddings)
              └─► VLM caption trigger (scene-change OR periodic)
  Encoders (VideoEncoder/SceneEncoder/FaceEncoder) → SensoryFusion → 768-D SensoryFrame → decision loop
```

**Topology constants (from `docker-compose.yml`):** perception sidecar `:8430`; NestJS app + frontend `:3000`; Neo4j **WORLD** (WKG `:VisualObject`) browser `:7474` / bolt `:7687`, auth `neo4j/sylphie_world`; Neo4j **OTHER** (OKG `:Person`/`:FaceSnapshot`) browser `:7476` / bolt `:7689`, auth `neo4j/sylphie_other`; TimescaleDB (pgvector) `:5433`.

### 2.2 What WORKS (verified)

| Component | Evidence |
|---|---|
| FastAPI sidecar boots with partial function | `model_loaded=True` (YOLO init OK against `yolov8n-seg.pt`), tracker OK, VLM lazy-loads on first `/caption` |
| YOLOv8n-seg detect + IoU tracking | `ultralytics 8.4.33`; `tracked_objects` with state transitions flow to NestJS |
| Frame transport seams (a),(b),(g),(h) | `usePerception.ts` send loop; gateway throttle; scene-nudge edge; drive path all execute correctly when the sidecar is healthy |
| Drive path is CANON-clean | `rules.ts:165-168` maps ScenePrediction → Curiosity **+0.02** / Anxiety **+0.01** (both PRESSURE, never relief); `ipc-message-validator.ts:45-46` clamps `sceneSurprise`/`sensoryPredictionError` to `[0,1]`; axis+delta computed in-child via `computeDefaultAffect` |
| torch / transformers present | `torch 2.11.0+cpu`, `transformers 4.57.6` — DINOv2 path needs **no install** |
| Habituation gate works | `routeScenePredictionErrors` early-returns below `totalSurprise=0.05`; quiet scenes never pollute drives |

### 2.3 What's DORMANT (built but not wired into the live path)

| Dormant module | State |
|---|---|
| **A.5 `PersistenceCheckService`** (`persistence_check_service.py`) | Imports OK, pure-Python scorer (embedding cosine + spatial IoU + color + size + label, Piaget dynamic weights, `surprise_flag`). Dormant: `main.py` wires `_NullPersistenceCheck` (always returns None). **Ready to promote.** |
| `SpatialRelationshipExtractor` (`spatial_extractor.py`) | Dorsal "where" stream; relations computed then DESTROYED by the Xavier projection. Not wired into `/detect`. |
| `DominantColorExtractor` | Zero external deps (pure Python on raw bytes). Not wired. **Preserve** (A.5 color-signal dependency). |
| `ObservationBuilder` / `ObservationValidator` | Validator tested in isolation (22 tests); builder untested; neither wired. |
| `PerceptionPipeline` (`pipeline.py`) | The dead camera-loop path. **Do NOT boot** (unanimous decision — promote the stateless scorer instead). |
| `ScenePredictionService` graded surprise | LIVE (not dormant) — provides habituating per-object surprise. Note: `cv-framework.md` is **STALE** here (claims vision is purely ambient; it is not post-WS5, and a graded habituating surprise signal already exists). |

### 2.4 What's BROKEN — the M0 reality (verified live)

| Item | Status | Consequence |
|---|---|---|
| `onnxruntime` | MISSING from `.venv` (req lists `>=1.17,<2.0`) | `OnnxEmbeddingExtractor.__init__` raises → `_embedding_init_failed=True` → **all `tracked_objects[].embedding` = None** in every response |
| `mediapipe` | MISSING from `.venv` (req lists `>=0.10,<1.0`) | `MediaPipeFaceDetector.__init__` raises → `face_model_loaded=False` → **`faces:[]` always** |
| `neo4j` | MISSING from `.venv` AND from `requirements.txt` | Module-level imports in 8+ `layer3_knowledge` files fail → in-venv graph stack uncallable |
| `insightface` | MISSING from `.venv` AND from `requirements.txt` | ArcFace/face embeddings blocked until added + installed |
| EfficientNet ONNX model file | MISSING from disk | First confirmed-track call would auto-download ~100MB from github; **code filename `efficientnet_b0.onnx` ≠ URL `efficientnet-lite4-11.onnx` (different architectures) — the 1280-D claim must be verified against actual output shape** |
| `Neo4jGraphPersistence` class | Class/file **does not exist** (`infrastructure/` subdir absent) | Dangling import at `skill_reset.py:103/206/299`, `protocols.py:45`. **Function-local → crashes at call-time, NOT import-time → does NOT block the live `/detect` path** (verified — separate item, not an M0 blocker) |
| `frame_width`/`frame_height` | NEVER emitted from `/detect` (`main.py` response dict) | 5 normalizers hardcode 640×480 → silently-wrong spatial features on non-640×480 cameras |

**Environment corrections (third design track, verified):** the venv Python is **3.13.11** (not 3.12 — all four M0 packages install cleanly on 3.13). The **worktree has NO `.venv`** — the live venv is in the **main repo** at `C:/Users/Jim/OneDrive/desktop/Code/sylphie/packages/perception-service/.venv`; all Python commands must target that path. Pin **`insightface>=1.0,<2.0`** (1.0.1 is numpy-2.4.4-safe at install AND runtime and pulls `onnxruntime` transitively; the resolved-plan's `0.7.3` is runtime-unsafe on numpy 2.x via removed `np.bool`/`np.int`).

### 2.5 Test coverage baseline (the headline gap)

| Layer | Today |
|---|---|
| Python (`packages/perception-service/tests/`) | **2 files** — `test_observation_validator.py` (22 tests, validator only), `test_thread_safety.py` (6 tests, concurrency primitives). **Neither constructs the pipeline.** No `pytest` config, no `conftest.py`, no CI. |
| NestJS `apps/sylphie` | **Zero `*.spec.ts`, no jest config.** All 5 vision services (PerceptionGateway, VWM, SceneEventDetector, FaceSnapshot, sensory-logger) uncovered. |
| NestJS `decision-making` | jest config exists + active suite for other services, but **zero** vision specs (VideoEncoder, SceneEncoder, FaceEncoder, ScenePredictionService, SensoryFusion, TickSampler, ProcessInput vision path). |
| Gate harness (`test/gate/`) | Exercises **only** `/ws/conversation`. Never sends a frame to `/ws/perception`; perception `:8430` HTTP not intercepted; no vision vector in the cassette. |
| E2E (`test/e2e/`) | `full-system.e2e.ts:423-473` Phase 6 is a 30s **manual** wave-at-camera window with **zero automated assertions**; `architecture-verification` and `agi-verification` have **zero** vision content. |
| Fixtures | **NONE** — no synthetic JPEGs, golden vectors, recorded clips, `.npy` files, or seeded DB rows. Only Playwright screenshots + architecture diagrams. |
| CI | No `.github/`, no pre-commit, no husky. All test execution is manual. |

---

## 3. Strategy & principles

### 3.1 Promote-what's-built-first

The do-first cluster (#0/#1/#2/#3) is mostly **promotion of code that already exists** — the A.5 scorer, the incremental-mean centroid, the spatial/color extractors — into the live path. It is the highest (value×safety)/effort cluster, stability-neutral-to-positive, and it unblocks everything downstream. We deliberately do **not** boot the dead `PerceptionPipeline`; instead we port the stateless scorer to a NestJS `BindingService` (Python file stays as reference spec). The genuinely structural net-new builds (Neo4j backend class, temporal scene-state graph, Fork C emitter) are sequenced after the cheap promotions.

### 3.2 The three stability invariants (protect through ANY change)

1. **Relief stays epistemic.** Never pay curiosity/social relief for anything but durable knowledge/identity change. A transient surprise *assimilates*; only persistent/durable change pays relief. (Verified clean at HEAD: `rules.ts:165-168` emits only positive PRESSURE deltas for ScenePrediction.)
2. **The embedding stays stable OR its change is a frozen+versioned+migration-gated phase transition.** Online/drifting backbones detonate memory: fingerprint catastrophe (every weight update re-hashes the same scene → all prior episodic memory unaddressable), re-id drift (stored vectors in old space, thresholds compare across two), fusion contamination. Backbone swaps are destructive `ALTER` + re-embed with an `embeddingVersion` provenance stamp and a clean one-time recall miss — never online.
3. **The world cannot unconditionally command the decision loop.** Trigger only on settled-semantic change, rate-limited and habituating. (Verified structurally satisfied at HEAD: a scene cycle is a pure *trigger* that runs a cycle, not a *signal* that injects drive pressure.)

Every milestone in §5 names the invariants it touches. Every regression test in §6.6 protects one.

### 3.3 Ship-each-improvement-with-its-test

No milestone is "done" without its exit test green. The do-first cluster's tests can largely land **today** (pure logic, no deps): the embedding-discard documentation test, SceneEventDetector pure-logic tests, the linear-algebra golden test, the IPC clamp test, the A.5 scorer Python tests. These immediately give regression protection on code that has none.

### 3.4 Resolved decisions carried forward (FIXED — not re-litigated)

From `sylphie-abc-build-plan-resolved.md` (Jim's FINAL adjudication of all 18 open items):

- **DINOv2-base 768-D** object embeddings (buildable now; 768 == fused dim → JL projection deleted); **ArcFace/InsightFace 512-D** face embeddings (M0-blocked); **per-modality dims** (object 768 / face 512, NOT uniform).
- **SAM 3.1 PARKED** (no checkpoint, CLIP-from-git dep, finite-video predictors, no push API). Fork A perception-core swap parked; Fork B binding key adapts to `SceneEntity.id` (NOT a masklet, NOT the churning trackId); greedy IoU stays.
- **Unified `BindingService` runs NestJS-side** keyed on `SceneEntity.id` (port the A.5 scorer to TS; Python = reference spec).
- **EfficientNet retired LAST** behind a grep gate (two consumers); `DominantColorExtractor` **preserved**.
- **Fork C** keeps a cycle-enqueue (trigger-vs-signal discipline), uses the already-declared `SYSTEM_TRIGGER` category, full-latent fingerprint, `presenceSurprise` as raw-signal-in (assert+extend; CANON-compliant). *(Carried as a design principle; see §5 P4 for the net-new framing per the mythos correction.)*
- **Frame-dim plumbing is P1** — net-new end-to-end plumbing (5 normalizers incl. `ScenePredictionService`), not a constant swap.
- **enforce-canon repoints** from non-existent `wiki/CANON.md` to `sylphie-tech-spec.md §9`.
- **OPEN-9** session-conditional spatial renormalization (correctness mechanic within A.5, accepted).

---

## 4. Phase 0 — M0 integration gate + dormant-path bring-up + first green baseline

**Goal:** make the live CV path runnable so every downstream "live-smoke" claim is valid, and stand up the first green test baseline (pure-logic tests + a pytest/jest scaffold) so the suite exists before improvements land. **Until M0 closes, every live claim below is invalid.**

### 4.1 M0 deps remediation

**`requirements.txt` edits** (append; keep CPU torch extra-index at top):

```diff
  onnxruntime>=1.17,<2.0
  transformers>=4.44,<5.0
  einops>=0.7
+ neo4j>=5.13,<6.0
+ insightface>=1.0,<2.0
```

**Install (against the MAIN-repo venv — the worktree shares it):**

```bash
PY="C:/Users/Jim/OneDrive/desktop/Code/sylphie/packages/perception-service/.venv/Scripts/python.exe"
"$PY" -m pip install onnxruntime mediapipe neo4j insightface==1.0.1
```

**`mediapipe` → `opencv-contrib-python` conflict** with existing `opencv-python-headless 4.13`: install mediapipe `--no-deps` then `pip check` and hand-install its remaining deps, OR pin opencv explicitly.

```bash
"$PY" -m pip install mediapipe --no-deps
"$PY" -m pip check    # report any now-missing mediapipe deps; add them individually
```

**insightface numpy-2 RUNTIME probe (hard M0-green precondition — not just import; canon elevated this from open question to blocking checkbox):**

```bash
"$PY" -c "from insightface.app import FaceAnalysis; a=FaceAnalysis(name='buffalo_l'); a.prepare(ctx_id=-1); print('insightface runtime OK')"
```

First run downloads `buffalo_l` (~280MB `w600k_r50.onnx`). An `np.bool`/`np.int` AttributeError is the numpy-2 incompatibility surfacing → fall back to a numpy-1 venv for the **face path only**, or a prebuilt wheel. Decide before P3 ArcFace.

**Pre-download weights** so first boot is deterministic: EfficientNet-Lite4 ONNX *(skip if going straight to DINOv2 — it retires this dead path; otherwise verify the actual output dim == 1280)*, DINOv2-base (~350MB), ArcFace `buffalo_l`, Moondream2.

**M0 import gate (all must print OK):**

```bash
"$PY" -c "import onnxruntime, mediapipe, neo4j, insightface; print('M0 imports OK')"
```

**`Neo4jGraphPersistence` dangling import — track separately, NOT an M0 blocker.** Function-local imports crash only at call-time; the HTTP `/detect` path never touches them. Build the class in P3 (with the canon KG-isolation assertion — see §8).

### 4.2 Bring-up sequence

```bash
# 1. Databases (docker owns all)
cd "C:/Users/Jim/OneDrive/desktop/Code/sylphie/.claude/worktrees/vision-abc-plan"
docker compose up -d neo4j-world neo4j-other postgres timescaledb
docker compose ps     # wait for all (healthy)

# 2. Perception sidecar (manual, for tight log-watching)
cd "C:/Users/Jim/OneDrive/desktop/Code/sylphie/packages/perception-service"
PYTHONPATH="." "./.venv/Scripts/python.exe" -m uvicorn main:app --host 0.0.0.0 --port 8430
#   watch for: model_loaded=True, face detector loaded (was silently skipped pre-M0), VLM lazy

# 3. M0 acceptance at the HTTP layer
curl -s http://localhost:8430/perception/health
#   PASS = {"status":"ok","model_loaded":true,"face_model_loaded":true,"vlm_enabled":true,...}

# 4. NestJS app + drive server + frontend
cd "C:/Users/Jim/OneDrive/desktop/Code/sylphie/.claude/worktrees/vision-abc-plan"
yarn dev:backend ; yarn dev:drive-server ; yarn dev
```

Drive a real frame (camera at `:3000`, OR a synthetic POST — see §7 for the fixture deliverable).

### 4.3 First green test baseline (lands during/right after M0; no improvements yet)

These give regression protection on code that has none, and they prove the scaffold works:

1. **pytest scaffold** — add `pyproject.toml` (markers `requires_models`, `slow`) + `conftest.py` that **auto-skips (loudly, with reason) — never silently passes** — model tests when a dep import fails.
2. **jest config for `apps/sylphie`** — it has none; required before any of the 5 vision-service specs can run.
3. **Pure-logic tests that need no deps** (can land before M0 install completes): `linear-algebra.spec.ts` (Xavier determinism golden), `scene-event-detector.service.spec.ts` (pure stateful diff), `ipc-message-validator.spec.ts` (the `[0,1]` clamp), `rules.spec.ts` (axis mapping), `test_persistence_scorer.py` (A.5 scorer signals).
4. **Embedding-discard documentation test** — pins the current cross-array discard as a known invariant TODAY so the #0 fix flips a red test green (see §6.3 for the corrected form — it does **not** test a non-existent `VideoEncoder` embedding field).

**EXIT GATE (Phase 0):** `M0 imports OK` + `FaceAnalysis.prepare()` OK; `curl /perception/health` all-true; `curl /perception/detect` on a real frame → `tracked_objects[].embedding` non-empty (1280-D today), `faces[]` non-empty on a face frame; pytest + jest scaffolds run green with the pure-logic baseline. **mythos live-smoke sign-off required.**

---

## 5. The improvement roadmap

Six sequential phases behind one hard deps gate, with the embedding+retrieval cluster landing strictly **before** any event-driven triggering. The exploration's 12-move sequence is harmonized with the resolved A/B/C milestones below; later moves (#4–#12) are surfaced (§5.8) so the implementer sees the full arc but are **not** scheduled into P1–P5.

| Phase | Theme | Gating property |
|---|---|---|
| **M0** | Substrate deps gate | HARD — nothing live-verifies before it (§4) |
| **P1** | Embedding+retrieval cluster (#0+#3 batched, #1, #2) on *existing EfficientNet vectors* | Proves the fusion/fingerprint migration BEFORE any backbone swap |
| **P1.5** | Vision-recall routing (relax the text-required gate for `SYSTEM_TRIGGER`) | Makes vision scenes actually *retrievable* — without it C-accept is un-passable |
| **P2** | Coordinate correctness + canon guard (frame-dim plumbing, enforce-canon repoint) | Makes drive-routed surprise honest; arms the gate before Fork C |
| **P3** | Backbone swaps as versioned migrations (DINOv2-base 768 objects, ArcFace 512 faces, Neo4j persistence) | Const-flip input-dim change *because* P1 built #0 generically (768==fused dim deletes the JL projection) |
| **P4** | Fork C surprise gate (event-driven triggering — net-new) | Lands only after recall (P1+P1.5) + honest coords (P2) + armed canon gate (P2) |
| **P5** | EfficientNet retirement (grep-gated, LAST) | Only after BOTH object(DINOv2)+face(ArcFace) paths live |
| **WS-SAM** | Parked perception-core (separately scoped) | Does not block A/B/C value delivery |

The deep rationale for putting #0 on the **existing EfficientNet 1280-D vectors** (per Jim's constraint): it proves the entire fusion-and-fingerprint migration machinery — new-modality registration, JL projection into the fused latent, the full-latent fingerprint re-key, the one-time recall discontinuity — against vectors you *already have*. So when DINOv2 arrives in P3 it is a single input-dim change against already-proven plumbing rather than two simultaneous continuity breaks. That is why #0+#3 batch into **one** fingerprint-version bump.

### 5.1 Phase P1 — Embedding+retrieval cluster (existing EfficientNet vectors)

**Goal:** make visual scenes *distinguishable in the fused latent* and *recallable by cosine*, on the EfficientNet 1280-D vectors that already exist.

**Milestones:**

- **#0 — `visual_embedding` modality (JL/Xavier 1280→768, ADDITIVE).** *(Corrected topology — mythos blocker.)* The embedding rides `tracked_objects[].embedding` (`perception.gateway.ts:142`), a *separate array* from the `VideoDetection[]` (`{class,confidence,bbox}`) fed to `VideoEncoder`. It reaches NestJS, flows to VWM/`SceneEventDetector`, but is **never handed to the fusion encoders** — the discard is at the cross-array join, not inside `VideoEncoder`. **Fix:** add a new `visual_embedding` modality fed from `tracked_objects[].embedding` (pooled/averaged across confirmed tracks), registered alongside video/scene, fused additively (keep video/scene for counts+geometry). JL preserves cosine neighborhoods so a fixed random 1280→768 projection is a legitimate no-training stopgap. **Build the input-dim generically (config const, not literal 1280)** so the P3 DINOv2 swap is a one-line change. *(S–M / LOW — but not the "near-zero 1–2d" earlier estimate: it touches fusion registration and the fingerprint version, batched with #3.)*
- **#3 — Grounded visual recall + full-latent versioned fingerprint.** Verified: `process-input.service.ts:341` keys the SHA on `frame.fused_embedding.slice(0, 64)` — with a random fusion matrix, variance is not concentrated early, so ~8% of dims decide identity and visually-distinct same-COCO scenes collide. Widen to the FULL fused vector (keep 2dp quantize); split exact-dedup (short hash) from similarity-recall (cosine over the full vector); stamp `embeddingVersion` provenance. **BATCH #0+#3 into ONE fingerprint-version bump** (exactly one recall discontinuity). **ashby scope-flag:** `generateFingerprint` is shared across ALL input categories — widening the slice changes equivalence classes for text/audio too. cortex must verify the discontinuity is vision-local, not system-wide, across all categories (not just mug-vs-book). *(M / MED — the discontinuity is the risk; it is a clean one-time re-key, not corruption.)*
- **#1 — A.5 multi-signal scorer ported STATELESS into a NestJS `BindingService` keyed on `SceneEntity.id`.** VWM today re-IDs on single-signal cosine `OBJECT_MATCH_THRESHOLD=0.75` LIMIT-1. Port `compute_match_score` to TS (Python stays reference spec; do NOT boot `PerceptionPipeline`). **Honest scope: ≈3-signal day one** — `visual_object_embeddings` stores only embedding+label, so spatial/color/size score 0.0 until P3's atlas schema extension. Use embedding-dominant per-node-type profiles. Fold in **OPEN-9** (session-conditional spatial renormalization via the `recency_window_hours=24.0` proxy; zero schema change) so cross-session re-id is not capped at ~0.50. *(M / MED.)*
- **#2 — Mutable instance centroids (running mean per `:VisualObject` on each confirmed sighting).** Precondition for accommodation (today objects store ONE write-once embedding). **Mirror the existing FaceSnapshot incremental-mean** (`face-snapshot.service.ts:535-553`, verified) for objects. *(S / LOW — a centroid update is bounded assimilation within a FIXED backbone space, explicitly NOT learned-backbone drift.)*

**Dependencies:** M0 (for live verification; net-new code can be written before M0 but not verified). **Invariants touched:** **#2 (embedding stability)** — additive+random projection and centroid-mean are stability-neutral within a fixed space; #3 IS the versioned/discretized change the invariant permits. **#1 (relief epistemic)** — A.5's `surprise_flag` may raise pressure but MUST NOT short-circuit the info-gain relief gate. **Ratifications owed:** **cortex** owns the fingerprint-widening recall discontinuity + `CONTEXT_SIMILARITY_THRESHOLD=0.70` re-validation (land with/after WS5 T2; scope verified system-wide per ashby). **atlas** ratifies per-node-type weight profiles (do NOT collapse Person 0.55 into VisualObject 0.75). **EXIT GATE:** decision-making jest green; two visually-distinct same-COCO scenes (mug-on-desk vs book-on-desk) produce a fused-latent cosine gap > margin where today they collapse — **and (ashby) the gap is bounded in BOTH directions** (the visual_embedding must not so dominate that two *different*-COCO scenes with similar embeddings falsely merge); the same two scenes now generate DIFFERENT fingerprints (no false dedup) and pre-existing episodes are a clean one-time miss, not corruption; cosine recall returns the right prior scene above threshold; `BindingService` unit test shows known-object→match on the WEIGHTED score (not raw cosine), near-identical→ambiguous(0.45–0.75) branch fires; #2 test shows the stored centroid drifts toward the running mean across N sightings with no duplicate node. **Re-validate the WS5 perception path** (a clean cosine-0.75 object may now score lower under the weighted scorer).

### 5.2 Phase P1.5 — Vision-recall routing (NEW, mythos blocker)

**Goal:** make a vision-only scene actually *retrievable*. **#0 alone does NOT do this** — verified: `latent-space.service.ts:387-397` hard-requires a `text` modality match for any `searchMultiModal` hit, and `decision-making.service.ts` is the only caller. So a Fork C vision-only `SYSTEM_TRIGGER` cycle still retrieves nothing after P1.

**Milestone:** route vision recall through `searchByModality('visual_embedding')` (the per-modality path `searchMultiModal` bypasses for non-text) for `SYSTEM_TRIGGER` frames, OR relax the text-required gate specifically for `SYSTEM_TRIGGER`. Add with its own test. *(S–M / MED — touches the retrieval gate; cortex-adjacent.)*

**Dependencies:** P1 (the modality must exist and be fused). **Invariants touched:** none directly, but it is the mechanism that makes the recall-before-triggering ordering *actually* satisfied rather than nominally. **Ratifications owed:** cortex (this is the concrete code form of the "recall before triggering" corollary). **EXIT GATE:** a unit/integration test shows a vision-only frame (no text modality) returns a non-null per-modality recall hit for a previously-seen scene; a previously-unseen scene returns null (no confabulated hit); accept-C deliberation no longer enters with empty retrieval.

### 5.3 Phase P2 — Coordinate correctness + canon guard

**Goal:** (a) make spatial features and the drive-routed surprise *magnitude* honest, and (b) repoint canon enforcement at the real spec so it can catch a Standard-6 violation. SAM-independent; can run in parallel with P1 but MUST land before Fork C (P4).

**Milestones:**

- **Frame-dim plumbing (net-new end-to-end, all 5 normalizers).** True dims are decoded server-side (`Frame.width/height`) then DISCARDED from `/detect` JSON. Emit them, thread through the gateway, ride on each detection element + on the `SceneSnapshot`. Fix all FIVE `FRAME_W/FRAME_H` sites: `VideoEncoder` (`video.encoder.ts:33-34`), `SceneEncoder`, `FaceEncoder`, `FaceSnapshot.classifyAngle`, AND `ScenePredictionService.bboxCentroidDistance` (`scene-prediction.service.ts:37-38,181-184` — the 5th, verified). Every new DTO field OPTIONAL defaulting 640/480 so existing gate behavior stays byte-identical. *(M / LOW — pure arithmetic, no new dep.)*
- **enforce-canon repoint + fail-loud.** `wiki/CANON.md` never existed; real canon is `sylphie-tech-spec.md §9` (Six Immutable Standards) + §3.2 (Drive Isolation). Repoint `canon-check.cjs:64` + `enforce-canon/SKILL.md:23` + `.claude/agents/canon.md:30` (already modified in this worktree per git status); add `fs.existsSync` fail-loud guard; flip the unparseable-response fallback from `exit(0)` to `exit(2)`. The automated Stop-hook spawns a generic `claude -p` (NOT the canon agent), so the hook prompt+guards must be edited directly. *(S / LOW.)*

**Dependencies:** M0 (for the 1280×720 live curl). **Invariants touched:** **#3 (world cannot command the loop)** — miscalibrated coords skew the surprise magnitude routed to drives; fixing it makes the gate honest BEFORE Fork C wires that magnitude through. enforce-canon is the **meta-guard protecting invariant 1 / CANON Standard 6** for all of Fork C. **Ratifications owed:** none new. **EXIT GATE:** `curl` a 1280×720 JPEG → `frame_width:1280/frame_height:720`; per-encoder unit test that a frame-center detection normalizes to ~0.5 at 720p; run the canon gate against a DELIBERATE Standard-6 violation (a perception-side pre-computed drive delta) → exit(2); rename the spec file → exit(2) (guard fires); confirm exit(0) is no longer reachable on a missing/unparseable response.

### 5.4 Phase P3 — Backbone swaps as versioned migrations

**Goal:** replace embedding backbones per Jim's FINAL per-modality decisions, each as a frozen+versioned+migration-gated phase transition — NEVER online drift. Because P1 built #0 generically, the DINOv2 swap is a one-line input-dim change.

**Milestones (carried as FIXED Jim decisions):**

- **DINOv2-base 768-D object embeddings (BUILDABLE NOW).** Add `DINOv2BaseEmbeddingExtractor` to `feature_extraction.py` (same protocol, drop-in; loads `facebook/dinov2-base` with `local_files_only=True`, CLS token = 768-D); modify ONLY the `_extract_track_embedding` swap site keeping the `_embedding_init_failed`-style gate, double-checked lock, and `cv2.fillPoly` mask-zeroing byte-for-byte; broaden `except` to degrade to null, not crash. Migrate `visual_object_embeddings vector(1280)→vector(768)` (standalone destructive script, NOT auto-run in ensureSchema; legacy rows NULLed, kept at version 1). **Flip #0's input-dim const 1280→768** AND **delete the JL projection** (768==EMBEDDING_DIM → projection collapses to a distorting random rotation; encoder becomes an L2-normalized identity passthrough with a fail-loud `OBJECT_EMBEDDING_DIM===EMBEDDING_DIM` assertion). BONUS: fixes the already-dead Onnx path. *(M / MED — CPU-only inference ~69ms/crop; confirm-gate + every-Nth throttle keeps /detect YOLO-dominated — see §9.)*
- **ArcFace/InsightFace 512-D face path (BLOCKED-ON-M0).** New `face_embedding.py::ArcFaceEmbedder`; switch `/crop-face` to pass the UNMASKED crop (the convex-hull mask designed for EfficientNet HURTS ArcFace); migrate `face_embeddings vector(1280)→512` destructively; retune `IDENTIFICATION_THRESHOLD` off 0.55 toward a real FMR operating point. **OPEN-12 fix:** switch the person QUERY off the contaminated body-track embedding onto the fresh `/crop-face` 512-D vector and DELETE the body-track INSERT into `face_embeddings`. *(M / MED.)*
- **Neo4jGraphPersistence backend (BLOCKED-ON-M0).** Build the dangling class+package (`infrastructure/{__init__,neo4j_persistence,neo4j_schema}.py`); implement every async `GraphPersistence` method; **JSON-encode `bounding_box`** (Neo4j can't store nested maps → else every A.5 spatial/size score is silently 0.0); `find_nodes_by_embedding` = in-Python cosine-over-shortlist (safe on any Neo4j 5.x). This also lands the **atlas schema extension** (`bounding_box`/`dominant_colors` on `visual_object_embeddings`) that promotes `BindingService` from ≈3-signal to full 5-signal. **Scope flag:** building the class closes the dangling import but does NOT by itself live-wire it into the HTTP path — confirm class-correct-vs-live-wired scope with Jim (§9). **canon KG-isolation assertion:** `:VisualObject` lands ONLY in neo4j-world, face/person ONLY in neo4j-other, no edge crosses instances (spec §4.1). *(L / MED.)*

**Dependencies:** M0 (ArcFace/Neo4j deps); P1 (#0 built generically; #3's `embeddingVersion`); P2's atlas schema lands here. **Invariants touched:** **#2 (embedding stability) — the SHARPEST test.** Both swaps are SPACE CHANGES: old 1280-D rows are incomparable to new 768-D/512-D rows. Each MUST be a frozen+versioned destructive migration with re-baselined vectors and re-validated thresholds — NEVER online. **Ratifications owed:** **atlas** ratifies the schema extension AND the per-node-type thresholds (Person stays embedding-1.0 @ 0.55, VisualObject multi-signal @ 0.75 — do NOT collapse). **EXIT GATE (D/B-acceptance + Python TestClient + live-smoke):** held-out objects/people across angles show intra-instance cosine margin > inter-instance by target (D1); object embeddings flow end-to-end (previously-null path live); enroll a user → re-entry identifies above the retuned threshold (1:N), WS4 multi-person gate still green under the Person profile; **power-cycle → same object/person re-binds to the SAME node** above a confidence bar (B-acceptance), `bounding_box` round-trips (JSON) so spatial score is non-zero; KG-isolation assertion green.

### 5.5 Phase P4 — Fork C surprise gate (event-driven triggering — net-new, LAST)

**Goal:** make scene/presence change a rate-limited, habituating cycle trigger feeding the isolated drive engine. **Sequenced LAST among the SAM-independent buildables** because it is the only one that makes the world *trigger* cycles — and per the verified `latent-space.service.ts:387-397` text-required gate, a vision-only trigger before P1+P1.5 grounded recall would enter deliberation with nothing retrievable, manufacturing Type-2 load (the Type-2 Addict attractor). P2's honest coords + armed canon gate are also prerequisites.

**Framing correction (mythos blocker — this is FULLY NET-NEW, not preservation).** `nudgeSceneChange`, `SCENE_CYCLE_COOLDOWN_MS`, `sceneNudgeCallback`, `onSceneChange` **do not exist in source** (zero `.ts` matches). `determineCategory` never produces `SYSTEM_TRIGGER` today (the category exists in the union at `process-input.service.ts:50` with no producer). There is no legacy scene→cycle enqueue to "keep" or "re-home." Write Fork C as a forward requirement.

**Milestones:**

- **Additive raw-signal-in (`presenceSurprise`).** ASSERT+EXTEND — raw-signal-in is ALREADY satisfied at HEAD (IPC carries raw magnitudes; axis+delta computed in-child via `computeDefaultAffect`). Add one `presenceSurprise:number [0,1]` field + its Zod `.min(0).max(1)` clamp + its `rules.ts` mapping (axis chosen IN-CHILD). *(S / LOW.)*
- **New `SurpriseEvent` emitter — two distinct actions.** The new emitter must (1) enqueue a `SYSTEM_TRIGGER` cycle (the trigger — a cycle RUNS) AND (2) emit a clamped raw-magnitude drive signal (the signal — drive pressure). These are two distinct actions; the **trigger-vs-signal discipline** is the forward design requirement (NOT preservation of phantom code): a salient-but-CALM frame on a drive-cold backend must still get a cycle, or P3/P4 regress. Use `SYSTEM_TRIGGER` (NOT `VISUAL_INPUT`/`MULTIMODAL_INPUT` — a live surprise frame sets ≥2 modalities). Rate-limit the trigger (a new cooldown constant); **ashby must ratify its value** ≥ the rumination-breaker detection horizon (see §8 for the corrected, unit-consistent statement). *(M / MED.)*

**Dependencies:** M0; **P1+P1.5 (grounded recall MUST precede triggering)**; P2 (honest surprise magnitude + armed canon gate). **Invariants touched:** **#3 (world cannot command the loop)** — rate-limited, settled-semantic-change only, habituating. **#1 (relief epistemic)** — scene surprise produces curiosity/anxiety PRESSURE, never relief. **CANON Standard 6** — the raw-signal-in boundary, guardable because P2 armed the gate. **ashby encode-side guard (new):** add a regression assertion that the surprise term still feeds ATTENTION only and does NOT open the episodic encode gate via a Curiosity/Anxiety path — the encode-side edge of the perception→drive→perception loop must stay cut (the retrieval-side rumination breaker alone does not contain it). **Ratifications owed:** **ashby** MUST ratify the trigger cooldown (loop-gain) AND sign off on the high-diversity arousal-ratchet bound (see §8). **EXIT GATE (drive-engine + decision-making jest + canon gate + live-smoke):** a scene/presence frame with no text/audio → `SYSTEM_TRIGGER` cycle fires; `presenceSurprise` typechecks end-to-end, validator clamps `[0,1]`, `computeDefaultAffect` returns the scaled map; the P2 canon gate confirms no perception-side pre-computed drive delta; live-smoke: wave at the camera → a `SYSTEM_TRIGGER` cycle in logs, drive process receives the raw magnitude (no perception-side delta); a static busy scene habituates (no fixation).

### 5.6 Phase P5 — EfficientNet retirement (grep-gated, LAST)

**Goal:** delete the shared EfficientNet `OnnxEmbeddingExtractor` ONLY after both consumers are migrated. **Milestones:** delete `OnnxEmbeddingExtractor` + download helpers; **KEEP `DominantColorExtractor`, the `EmbeddingExtractor` protocol, and `MockEmbeddingExtractor`** (color is an A.5 signal dependency). *(S / LOW — but gated.)* **Dependencies:** P3 (both DINOv2 object path AND ArcFace face path live and verified). **Invariants touched:** #2 — removing the old backbone is safe only once nothing reads it. **EXIT GATE:** grep shows ZERO `OnnxEmbeddingExtractor`/`efficientnet` references; full boot + `/detect` live-smoke returns 768-D object embeddings and 512-D face embeddings; retained `DominantColorExtractor` still imports.

### 5.7 Parked / later workstreams (do NOT block A/B/C)

**WS-SAM (PARKED, FINAL — do not re-litigate).** SAM 3.1 stateful push session is impossible on the substrate. Fork B binding key adapts to `SceneEntity.id`; greedy IoU stays; mask-zeroing degrades cleanly to YOLO-seg `mask_polygon`. SAM 2.1 may LATER serve as an optional periodic high-detail segmenter, not the continuous tracker.

### 5.8 Later dependency-ordered moves (exploration #4–#12) — surfaced, NOT scheduled

- **#4 content/appearance surprise** (`errorType:'changed'` on stable tracks + learning-progress gating) — depends on #0/#3 (P1) + B live (P3). Owners cortex+scout.
- **#5 dorsal stream** (SpatialRelationshipExtractor relations as WKG INFERENCE edges) — depends on Neo4j backend (P3) + P1 coords + #1 nodes. Owners opus-agent+atlas.
- **Temporal scene-state graph** (the keystone missing-middle layer) — the one genuinely structural NET-NEW build; depends on Neo4j + #1 + #5. **Scope call for Jim** (the resolved plan carries Neo4j+spatial pieces but no explicit full-temporal-graph milestone). Owners atlas+opus-agent.
- **#6 attention/foveation**, **#7 open-vocab YOLOE** (only after #0 so open-vocab labels flow as embeddings, not into the 20-slot histogram), **#9 queryable VLM** (BIGGEST theater risk — INFERENCE-typed, 0.60-capped, non-promoting; depends on Fork C + armed canon gate), **#10 :VisualConcept prototypes**, **#11 expression→drive route** (distinct from the ArcFace identity swap; M0-blocked on MediaPipe), **#12 depth** (lowest ROI, do last).
- **#8 frozen learned backbone + small head** — needs-ratification, HIGH-RISK; permissible ONLY as frozen+versioned+migration-gated with a SELF-SUPERVISED head (CANON Standard 6). #3 must prove the migration first. Owners learning+opus-agent+canon.

**ByteTrack (OPEN — needs Jim's call).** The one Seeing-Clearly item with no home in either the exploration's 12 moves or the resolved milestones. A runnable non-SAM tracker upgrade (real weights, push-compatible API) that fixes the exact occlusion/crossing failure greedy IoU has. **Recommendation:** slot where SAM is parked, AFTER P1–P3. Surface to Jim, not a re-litigation of SAM.

---

## 6. The full testing suite (the headline)

The headline ask: **there is no integrated vision test suite today.** This builds one. Philosophy: **assert invariants, not snapshots** — the WKG's evolving shape is never pinned; we assert what the pipeline must *never* violate (empty→zero-vector, declared-dim equality, provenance/confidence ceilings, relief-only-for-durable-knowledge, frame-center→~0.5 regardless of resolution, clean versioned fingerprint miss on migration). Every test names a real file/symbol so opus-agent can implement directly — but **re-anchor every `file:line` against HEAD first** (the reviews caught several drifted anchors).

### 6.1 Verification ground truth (re-confirmed this pass)

- **Encoders are deterministic and frame-dim-coupled.** `video.encoder.ts:31-34` (`FEATURE_DIM=26`, `VIDEO_PROJECTION_SEED=0xa1de0`, `FRAME_W=640`, `FRAME_H=480`); returns zero vector on empty. `VideoEncoder` imports `VideoDetection` = `{class,confidence,bbox}` (`video.encoder.ts:2`) — **no embedding field; never had one.** The discard is the cross-array join (§5.1 #0), not an encoder bug.
- **Xavier determinism is real and seed-driven** (`mulberry32`) — a golden-matrix test across restarts is valid.
- **A.5 scorer matches spec** (`persistence_check_service.py`): five pure scorers, weight profiles (`_NEW_WEIGHTS{spatial:0.50,...}` count<5, `_KNOWN_WEIGHTS{embedding:0.45,...}` count≥10, linear interp summing to 1.0), `surprise_flag` only when `confirmation_count≥5` AND `1.0-embedding_similarity>surprise_threshold`.
- **The CANON guard is the Zod clamp** (`ipc-message-validator.ts:45-46`), NOT a field-rejection — the schema ends in `.passthrough()` (`:68`), so injected fields are preserved. The real guarantee: the engine never *reads* a payload `driveEffects` field. `presenceSurprise` does not yet exist (Fork C work).
- **Fingerprint is the first-64-dims slice** (`process-input.service.ts:341`) — the visual-collision bug #3 fixes.
- **Embedding carried to DTO at `perception.gateway.ts:142`; dropped at `updateVideoDetections` (`tick-sampler.ts:185`, gateway call `:97-103`).**
- **`SYSTEM_TRIGGER` exists in the union** (`process-input.service.ts:50`) **with no producer today.**

### 6.2 Layer 1 — UNIT (pure functions, no I/O, CI-blocking, <2s each)

**NestJS (jest):**

| Test file (new) | Asserts | Symbol |
|---|---|---|
| `inputs/linear-algebra.spec.ts` | `xavierMatrix` byte-identical on two calls + matches a checked-in golden first-row hash (restart determinism); `linearProject` matches hand-computed toy; entries in `[-limit,+limit]`, `limit=sqrt(6/(rows+cols))`. | `xavierMatrix`, `linearProject` |
| `inputs/encoders/video.encoder.spec.ts` | empty `[]` → zero vector; center bbox → `features[21]≈0.5,[22]≈0.5` (golden, PARAMETERIZED by frame dims for P2); histogram slot 0 = 1.0 for one person; deterministic 768-vec golden hash. *(Corrected: do NOT test a non-existent embedding field — `VideoDetection` has none. The discard is pinned at the gateway contract test, §6.4.)* | `VideoEncoder` |
| `inputs/encoders/scene.encoder.spec.ts` | empty → zero vector; largest-area person → primary bbox; quadrant density sums to 1.0; stability=1.0 when no appear/disappear; center person → `features[22]≈0.5,[23]≈0.5` (PARAMETERIZED for P2). | `SceneEncoder` |
| `inputs/encoders/face.encoder.spec.ts` | empty → zero vector; blendshape group means; head-pose proxies bounded `[0,1]`; deterministic golden. | `FaceEncoder` |
| `process-input/fingerprint.spec.ts` | TODAY: two embeddings differing ONLY beyond index 64 → SAME fingerprint (documents collision bug #3); within first 64 → different. **After #3:** full-vector difference → different; `embeddingVersion` participates. | `generateFingerprint` (`process-input.service.ts:341`) |
| `prediction/scene-prediction.spec.ts` | novel→`novelObjects`; missing→`missingObjects`; centroid move > `MOVEMENT_THRESHOLD=0.15`→'moved'; `totalSurprise∈[0,1]`; quiet identical scene → `<0.05`. Frame-center math PARAMETERIZED for P2 (`FRAME_W/H` at `:37-38`). | `ScenePredictionService.compareScene` |

**Python (pytest):**

| Test file (new) | Asserts | Symbol |
|---|---|---|
| `test_persistence_scorer.py` | 5 signals isolated (`_score_embedding` identical→1.0, orthogonal→0.0, mismatched-len/None→0.0; `_score_spatial`/`_score_color`/`_score_size`/`_score_label_raw`); weight interpolation (`(0)['spatial']==0.50`, `(10)['embedding']==0.45`, `(7)` sums 1.0); threshold classification via `compute_match_score`; `surprise_flag` only at `count≥5` & distance>threshold; **OPEN-9 renorm**: a cross-session candidate drops spatial and renormalizes (≈0.84, not the 0.50 ceiling). | `persistence_check_service.py` |
| `test_tracker_lifecycle.py` | IoU matching across frames; tentative→confirmed after N; `max_lost_frames` eviction; stable ID; two-detection IoU disambiguation. (Extends constructor-only coverage.) | `IoUTracker.update` |
| `test_bbox_serialization.py` | `BoundingBox`→JSON round-trips; the **map-serialization trap**: a nested-dict bbox survives encode→decode so `_score_spatial`/`_score_size` are non-zero after a Neo4j round-trip. | `observation.py` BoundingBox |

### 6.3 Embedding-discard documentation test (the #0 red→green)

Corrected per mythos: the discard cannot be tested at `VideoEncoder` (no embedding field). It is pinned at the **gateway-to-fusion boundary** as a contract test (§6.4 `perception.gateway.spec.ts`): `tracked_objects[].embedding` is carried into `TrackedObjectDTO` (`:142`) but is **structurally absent from any fusion-modality input** (it never reaches `tickSampler` as a registered modality). #0 flips this from "no visual_embedding modality registered" to "registered and fused." Drop the earlier "pass a `VideoDetection` with an extra embedding field" test — it asserts a non-existent contract.

### 6.4 Layer 3 — CONTRACT (silent seams — highest regression ROI, CI-blocking)

| Test (new) | Seam | Asserts |
|---|---|---|
| `test/contract/detect-json.contract.spec.ts` | `/detect` JSON shape | Zod schema for `TrackedObjectDTO` incl. `embedding: number[]\|null`; **`frame_width`/`frame_height` present** (RED today, GREEN with P2 — the executable definition of the P2 fix); non-null embedding length equals declared object dim. |
| `apps/sylphie/src/gateways/perception.gateway.spec.ts` | gateway mapping + discard | snake_case→camelCase total; `embedding` preserved into `TrackedObjectDTO` (`:142`) BUT structurally absent from any fusion-modality input → **the discard is pinned**; #0 flips "no visual_embedding modality" → "registered + fused." |
| `packages/drive-engine/src/ipc-channel/ipc-message-validator.spec.ts` | CANON clamp | `sceneSurprise=1.5`→REJECT (`.max(1)`); `=-0.1`→REJECT (`.min(0)`); valid `∈[0,1]`→accept. **Corrected:** the schema ends in `.passthrough()`, so an injected `driveEffects` is NOT rejected — instead assert the engine IGNORES it (feed a payload with `driveEffects`, assert the computed delta equals the rule/default-affect value, unaffected). *(If Jim opts to tighten to `.strict()` per §9, then add the rejection assertion.)* After Fork C: same battery for `presenceSurprise`. |
| `packages/drive-engine/src/constants/rules.spec.ts` | axis mapping | `computeDefaultAffect({actionType:'ScenePrediction',metadata:{sceneSurprise:s}})` → `{Curiosity:0.02*s, Anxiety:0.01*s}` for s=0,0.5,1.0; `ScenePrediction ∈ METADATA_SCALED_ACTION_TYPES`; **relief invariant**: never a negative (relief) delta on any axis. |
| `test/gate/perception-path.contract.spec.ts` | **NEW perception interception** | Corrected: there is no cassette to lockstep. The gate never intercepts `:8430` today. This is net-new harness work — add a perception-path interception so the gate can replay a golden `/detect` response; a single source-of-truth `OBJECT_EMBEDDING_DIM` constant gates the vector length so the 1280→768 migration is a one-line change. |

### 6.5 Layer 2 (COMPONENT, deps-gated) + Layer 4 (INTEGRATION, seeded fixtures)

**Component (pytest + FastAPI TestClient, `@pytest.mark.requires_models`, skip-not-fail pre-M0):**

| Test (new) | Asserts | Symbol |
|---|---|---|
| `test_detect_endpoint.py` | `POST /perception/detect` synthetic JPEG → full contract; `model_loaded=True`; ≥1 detection on a drawn object. | `main.py /perception/detect` |
| `test_health_status.py` | `/health` 200; `/status` reports `model_loaded`/`face_model_loaded`/`vlm_enabled`/`embedding_init_failed` truthfully. | `main.py` health/status |
| `test_dinov2_extractor.py` *(ships w/ DINOv2)* | dim==768; deterministic; **mask-zeroing intact** (masked vs unmasked crop differ; all-background → near-constant). | new `DINOv2BaseEmbeddingExtractor` |
| `test_arcface_embedder.py` *(ships w/ ArcFace, M0-blocked)* | dim==512; UNMASKED crop (does NOT apply convex-hull mask); same face two angles → cosine above retuned threshold; two faces → below. | new `ArcFaceEmbedder` |
| `test_mediapipe_faces.py` *(M0-blocked)* | `/detect` on a face image → `faces[]` non-empty, `face_model_loaded=True`, blendshapes present. | `MediaPipeFaceDetector` |
| `test_yolo_seg.py` | YOLOv8n-seg returns `mask_polygon`; confidence threshold honored. | `YoloDetector.detect` |
| `test_caption_endpoint.py` *(slow, nightly)* | `/caption` lazy-loads VLM, non-empty string. | VLM path |

**Integration (jest, in-process fakes or seeded test containers):**

| Test (new) | Exercises | Asserts |
|---|---|---|
| `scene-event-detector.service.spec.ts` | pure stateful diff (zero I/O — trivially testable, currently zero coverage) | object gone → `OBJECT_DISAPPEARED`; new confirmed → `OBJECT_APPEARED`; person → `PERSON_ARRIVED/LEFT`; no change → no events. |
| `visual-working-memory.service.spec.ts` | VWM + pgvector re-id (seeded TimescaleDB) | known embedding re-IDs above `OBJECT_MATCH_THRESHOLD=0.75`; unseen → undiscovered node `provenance_type='SENSOR', confidence=0.40`; wrong-length vector → pgvector cast error caught, not silent. |
| `face-snapshot.service.spec.ts` | 3-tier face re-id (seeded `face_embeddings`) | cosine match returns seeded person; centroid incremental-mean updates (`:535-553`); **after ArcFace**: `vector(512)`, body-track embedding NOT inserted (OPEN-12). |
| `binding.service.spec.ts` *(ships w/ #1)* | ported A.5 vs seeded store | known→weighted-score match; near-identical→ambiguous(0.45–0.75)→guardian-disambiguation; OPEN-9 cross-session ≈0.84 not 0.50. Mirrors `test_persistence_scorer.py` goldens. |
| `perception.gateway.integration.spec.ts` | gateway↔sidecar (mock `/detect`) | mocked response flows detect→map→`detectEvents`→`updateScene`→`vwm.updateScene`; throttle drops in-flight frame; the new `SurpriseEvent` emitter fires a `SYSTEM_TRIGGER` cycle after the trigger cooldown (P4). |
| `test_neo4j_persistence.py` *(ships w/ Neo4j backend)* | round-trip (seeded Neo4j) | every async method round-trips; **map-serialization trap**: `bounding_box` JSON-encoded so spatial/size >0; `find_nodes_by_embedding` returns seeded node; power-cycle persists; **KG-isolation**: `:VisualObject`→world only, faces→other only, no cross-instance edge. |

**Trigger-vs-signal discipline** (the net-new Fork C requirement, P4) lives in `process-input.service.spec.ts` / the emitter's spec: the new emitter enqueues a `SYSTEM_TRIGGER` cycle as a *trigger* (does NOT set `lastInputAt` / does NOT fire the normal input callback) AND emits a clamped raw-magnitude drive *signal* — two distinct actions (Stability Invariant 3).

### 6.6 Layer 5 — E2E / SMOKE (live; A/B/C acceptance) — see §7

### 6.7 Layer 6 — REGRESSION / PROPERTY (protect invariants)

| Test / gate | Protects | Mechanism |
|---|---|---|
| WS5 gate cassettes stay green | existing behavior | `yarn gate --mode=replay` byte-identical; new optional DTO fields default 640/480. |
| Lesion test (`skipNetworkEmbedding`) | Lesion methodology | `yarn gate:lesion` green; with embeddings forced null, the system degrades to zero-vector visual_embedding modality + label/spatial re-id fallback, does NOT crash. |
| `test/property/fingerprint-migration.spec.ts` | Invariant 2 (versioned migration) | re-key with `embeddingVersion=v2`; every old `v1` fingerprint is a **clean versioned miss**, never a corrupted hit; new vectors recall under v2. cortex sets thresholds. |
| `test/property/drive-isolation.spec.ts` | CANON Standard 6 | grep gate: zero vision symbols importable from `packages/drive-engine`; PID separation (E2E); RLS on drive tables. |
| `test/property/no-theater.spec.ts` | Theater Prohibition / "every surprise has a consumer" | every `surprise_flag`/`presenceSurprise`/`sceneSurprise` emission site has a registered consumer; below-0.05 → no drive write; **(ashby) encode-side guard:** a salient frame on a drive-cold backend produces a cycle but does NOT by itself open the episodic encode gate via a Curiosity/Anxiety path. |
| `test/property/surprise-cascade.spec.ts` *(ashby, NEW)* | high-diversity arousal-ratchet bound | drive N DISTINCT salient changes in a short window → (a) the trigger cooldown still bounds cycle creation to ≤1/cooldown; (b) Curiosity/Anxiety pressure does NOT monotonically ratchet without bound (decay dominates between cycles). Route to ashby for written sign-off before P4. |
| Grep gates (`test/gate/grep-gates.spec.ts`) | clean retirement | **EfficientNet retired LAST**: grep fails if `efficientnet`/`OnnxEmbeddingExtractor` survive after DINOv2+ArcFace close. *(No `nudgeSceneChange` removal gate — those symbols never existed.)* |
| `enforce-canon` repoint verification | the meta-guard for Fork C | canon gate vs a deliberate Standard-6 violation → exit 2; rename `sylphie-tech-spec.md` → exit 2; exit 0 unreachable on missing/unparseable response. MUST pass before P4. |

### 6.8 Layer 7 — FIXTURES + TOOLING

New dir `test/fixtures/vision/`: a **synthetic frame generator** (`synth_frames.py`, Pillow — labeled rectangles at known pixel positions, parameterized by frame size for the P2 multi-resolution tests, emits JPEG + ground-truth JSON); **golden vectors** (`golden/` — 768-vec encoder outputs, a DINOv2-base 768-vec gated by `embeddingVersion`; the Xavier JL first-rows are obsolete now the projection is deleted); a **scripted occlusion/crossing clip** (feeds the tracker test + the future ByteTrack decision); a **multi-angle face set**; **seeded DB fixtures** (`seed_timescale.sql`, `seed_neo4j.cypher` with JSON `bounding_box`); a **mock extractor** (TS `FakeEmbeddingExtractor` / Python `_StubExtractor` returning deterministic unit vectors so Layer-4 runs WITHOUT loading the ~350MB DINOv2-base). **Runners:** pytest (`pyproject.toml` markers + skip-loud `conftest.py`), jest (extend 3 configs + **add one to `apps/sylphie`**), tsx (E2E). **docker-compose seeding in CI** (`docker-compose.test.yml` brings up TimescaleDB + Neo4j; net-new, no `.github/` exists today).

### 6.9 Coverage matrix: pipeline stage × test layer (today vs target)

Legend: ✅ exists · 🟡 partial · ❌ none today · →ship-with milestone.

| Pipeline stage | Unit | Component | Contract | Integration | E2E |
|---|---|---|---|---|---|
| YOLO detect (`detector.py`) | ❌→build | ❌→build (M0) | — | — | 🟡 preflight |
| IoU tracker (`tracker.py`) | 🟡→extend | — | — | ❌ (occlusion clip) | — |
| MediaPipe faces | ❌ | ❌→build (M0) | — | — | C accept |
| EfficientNet→**DINOv2-base 768** | — | ❌→build (DINOv2) | dim ❌→build | — | **A accept** |
| **ArcFace 512** (new) | — | ❌→build (M0) | dim ❌→build | FaceSnapshot ❌→build | C accept |
| A.5 scorer (`persistence_check_service.py`) | ❌→build (Py) | — | — | BindingService ❌→build (#1) | B accept |
| Neo4jGraphPersistence (missing) | bbox-JSON ❌ | — | — | round-trip ❌→build | B accept |
| **Embedding-discard boundary** | — | — | gateway-map ❌→build (#0) | — | A accept (#0) |
| Video/Scene/Face encoders | ❌→build (golden) | — | — | — | flow |
| Fingerprint (`process-input`) | ❌→build (collision) | — | — | — | — |
| ScenePrediction surprise | ❌→build | — | — | — | C accept |
| IPC Zod clamp (CANON guard) | — | — | ❌→build (Standard 6) | — | — |
| Drive rules mapping (`rules.ts`) | — | — | ❌→build | — | C accept |
| SceneEventDetector | ❌→build (pure logic) | — | — | — | flow |
| VWM pgvector re-id | — | — | dim-guard | ❌→build (seeded) | A/B accept |
| Vision-recall routing (P1.5) | — | — | — | ❌→build | C accept |
| Scene-trigger→cycle (P4) | — | — | — | ❌→build (trigger/signal) | C accept |
| Full live path | — | — | — | — | ❌→build (flow + A/B/C) |

### 6.10 CI-blocking vs nightly

- **Block every PR (<30s total):** Layer 1 (unit), Layer 3 (contract), the mocked parts of Layer 4 (integration with fakes).
- **Nightly (CPU model inference too slow per-PR):** Layer 2 model-load, Layer 5 E2E/acceptance, the VLM caption test.
- **Block any vision/drive-touching change:** the Lesion gate, the grep gates, the drive-isolation property test.

---

## 7. Integration verification & the A/B/C acceptance tests

### 7.1 Per-seam integration checks (8 seams, one observable assertion each)

After bring-up (§4.2), with the camera active or a synthetic POST in flight. **Fixture deliverable first:** create `test/fixtures/{person_640x480.jpg, mug_640x480.jpg, book_640x480.jpg, mug_1280x720.jpg}` — none exist today.

**(a) frontend → `/ws/perception`** — PASS: browser console shows `ws /ws/perception OPEN`, no red errors; Network tab shows recurring 15fps frames.

**(b/c) `/detect` embedding non-null + correct dim:**
```bash
curl -s -X POST http://localhost:8430/perception/detect --data-binary @test/fixtures/person_640x480.jpg -H 'Content-Type: image/jpeg' \
 | python -c "import sys,json; d=json.load(sys.stdin); t=[o for o in d['tracked_objects'] if o['state']=='confirmed']; e=t[0]['embedding'] if t else None; print('embedding_len=', len(e) if e else None, 'faces=', len(d['faces']))"
```
PASS (post-DINOv2): `embedding_len= 768`. PASS (pre-DINOv2): `1280`. FAIL: `None` (`_object_embedding_init_failed` set). A track must be CONFIRMED — POST the same frame 3–4×. `faces= >0` for a face frame.

**(c) frame-dim plumbing (P2 — expected FAIL until built):**
```bash
curl -s -X POST http://localhost:8430/perception/detect --data-binary @test/fixtures/mug_1280x720.jpg -H 'Content-Type: image/jpeg' \
 | python -c "import sys,json; d=json.load(sys.stdin); print('frame_width=', d.get('frame_width'), 'frame_height=', d.get('frame_height'))"
```
PASS (post-P2): `1280 720`. Today: `None` — the regression sentinel for the P2 milestone.

**(d/e) embedding reaches the cognitive boundary** — assert at the `SensoryFrame`: two visually-distinct same-COCO scenes (mug vs book on same desk) must produce different fused latents. PASS (post-#0): the `visual_embedding` slot is non-zero AND mug-vs-book cosine gap > margin (and, per ashby, two *different*-COCO scenes do NOT falsely merge). Today: they collapse.

**(f) Neo4j `:VisualObject` + pgvector row:**
```bash
docker exec sylphie-neo4j-world cypher-shell -u neo4j -p sylphie_world \
  "MATCH (v:VisualObject) RETURN v.label, v.provenance_type, v.confidence, v.node_id LIMIT 10;"
docker exec sylphie-timescaledb psql -U postgres -d sylphie -c \
  "SELECT node_id, label, vector_dims(embedding), sighting_count FROM visual_object_embeddings LIMIT 10;"
```
PASS: ≥1 node, `provenance_type='SENSOR'`, `confidence=0.40` (≤0.60 ceiling); `vector_dims` = 1280 pre-P3.1 / 768 post-DINOv2.

**(g) scene change enqueues a cycle** (P4) — walk into frame; NestJS log shows a `SYSTEM_TRIGGER` cycle within ~one frame; a second event inside the trigger cooldown is suppressed.

**(h) drive isolation — surprise → curiosity PRESSURE, not relief:**
```bash
docker exec sylphie-timescaledb psql -U postgres -d sylphie -c \
  "SELECT action_type, metadata->>'sceneSurprise' AS surprise, created_at FROM drive_events WHERE action_type='ScenePrediction' ORDER BY created_at DESC LIMIT 5;"
```
PASS: rows with `sceneSurprise≥0.05`, delta is Curiosity+/Anxiety+ (PRESSURE), NEVER relief. (Confirm `drive_events` table/column names against the live schema — used the seam-probe's stated names.)

### 7.2 The three acceptance tests (runnable tsx smokes under `test/e2e/vision/` — net-new)

**Pre-flight: `vision-preflight.e2e.ts`** — boots the sidecar, hits `/perception/status`, **fails loudly** if `model_loaded`/`face_model_loaded`/`embedding_init_failed` are not in the M0-satisfied state; runs the import probe + `FaceAnalysis.prepare()` and asserts exit 0. Every live claim is invalid until this passes.

**Test A — Embeddings flow end-to-end (#0 + DINOv2):** POST `mug` then `book` (same desk, same COCO superclass) 4× each. PASS: `tracked_objects[].embedding` non-null, len 768; intra-instance cosine (same object across angles) > inter-instance (mug vs book) by the target margin; mask-zeroing intact (masked vs unmasked differ). FAIL: embeddings null, or mug≈book collapse.

**Test B — Durable cross-session re-bind (Neo4j + A.5 + mutable centroid):** session 1 show a distinctive object, record `:VisualObject.node_id` + pgvector row; power-cycle the NestJS app (DBs stay up); session 2 show the SAME object. PASS: same `node_id`, `sighting_count≥2`, centroid drift>0, no duplicate, `bounding_box` round-trips (JSON) so A.5 spatial score >0, KG-isolation holds. FAIL: a new `unknown-*` node spawns (the cross-session IoU ceiling bug — OPEN-9 prevents it).

**Test C — Scene/presence surprise triggers a cycle AND maps to drive (Fork C):** a scene/presence frame with NO text/audio. PASS: a `SYSTEM_TRIGGER` cycle fires (NOT MULTIMODAL/VISUAL_INPUT); `presenceSurprise`/`totalSurprise ∈ [0,1]`, Zod-clamped; `computeDefaultAffect` produced a scaled Curiosity/Anxiety delta IN the isolated drive process; **a tick produces a response that reacts to the CHANGE** (requires P1.5 vision recall — else deliberation has empty retrieval and this row is un-passable); a static busy scene habituates (no fixation); the trigger survives a salient-but-calm frame on a drive-cold backend (trigger-vs-signal). FAIL: no cycle, empty retrieval, or a perception-side pre-computed drive delta (canon must catch it).

### 7.3 Mythos live-smoke checklist (mandatory before any phase close)

Per CLAUDE.md, mythos must SEE it run — not just static-analyze.

- **Services up:** `curl :8430/perception/health` all-true; `docker compose ps` all `(healthy)`; NestJS log shows PerceptionGateway registered + drive-engine isolated process connected; `yarn` workspace type-check green (NOT bare `tsc`); browser console at `:3000` zero red errors.
- **Critical path:** `[Perception]` log line per frame at ~15fps (66ms throttle, latest-wins drops silent not errors); `tracked_objects[].embedding` non-null correct dim on a CONFIRMED track; `faces[]` non-empty with a face present; a walk-in → `SYSTEM_TRIGGER` cycle, second change inside cooldown suppressed.
- **State changes (DB):** new `:VisualObject` (`provenance_type='SENSOR'`, `confidence=0.40`); new `visual_object_embeddings` row (correct `vector_dims`); `drive_events` `ScenePrediction` row with `sceneSurprise` + curiosity/anxiety PRESSURE (no relief); re-show object → `sighting_count` increments (no duplicate).
- **Honesty gates:** `/ws/webrtc` is still the known stub (don't claim it works); `TrackedObjectDTO.embedding` comment updated if dim changed (still says "EfficientNet-B0"); enforce-canon repointed and fail-loud guard fires (deliberate Standard-6 violation → exit 2).

A workstream is NOT closed until mythos watches every box tick on a live run.

### 7.4 Health / observability signals (the ongoing "is it working" backbone)

- **Embedding-null rate** (single most important sentinel): `SELECT count(*) FILTER (WHERE embedding IS NULL)::float / NULLIF(count(*),0) FROM visual_object_embeddings WHERE created_at > now() - interval '10 min';` — healthy ≈0; `1.0` ⇒ extractor init failed (back to dormant). Any non-zero is investigate.
- **Face-detect rate:** `count(*) FROM face_embeddings WHERE created_at > now() - interval '10 min'` — >0 when a guardian is present; zero with a face on camera ⇒ mediapipe dormant.
- **Re-id hit rate:** `MATCH (v:VisualObject) RETURN count(v), sum(CASE WHEN v.node_id STARTS WITH 'unknown' THEN 1 ELSE 0 END)` — `unknowns` ratio falls over a session; rising node count with flat sightings ⇒ duplicate-spawn (cross-session IoU bug, OPEN-9).
- **Surprise / cycle-trigger rate:** rate-limited by the trigger cooldown (bounded/min even in a chaotic scene); mean surprise DECAYS for a static scene (habituation); flat-high never-decaying ⇒ habituation broken (Invariant 3).
- **Relief sanity (CANON Standard 6):** `count(*) FROM drive_events WHERE action_type='ScenePrediction' AND (metadata->>'relief')::float > 0` — healthy **0**; any relief on raw scene-surprise is a CANON violation, investigate immediately.
- **Provenance integrity:** `MATCH (v:VisualObject) WHERE v.provenance_type IS NULL OR v.confidence > 0.60 RETURN count(v)` — healthy **0**.
- **Latency:** add per-`/detect` timing; healthy YOLO-only ~30–80ms CPU; DINOv2-base is ~69ms/crop on CPU (no CUDA) and stacks across confirmed tracks — P3.1 mitigates with a confirm-gate + every-Nth re-embed throttle (default N=8, `COBEING_PERCEPTION_EMBED_EVERY_N`), so steady-state /detect stays YOLO-dominated; still watch the effective FPS floor when many tracks confirm in the same frame.

---

## 8. CANON & cross-agent ratifications

### 8.1 Canon review (verdict: proceed-with-changes — no Six-Standards violation; the plan ENFORCES the standards)

- **Standard 6 (no self-modification of evaluation)** — UPHELD and made executable. The inbound payload carries raw magnitudes only; `sceneSurprise`/`sensoryPredictionError` Zod-clamped `[0,1]` (`ipc-message-validator.ts:45-46`); axis+delta computed in-child (`rules.ts:218-258`). **Action (major):** make P2's enforce-canon-before-P4 ordering machine-checkable — the P4 acceptance script must refuse to run if `canon-check.cjs` still contains `'wiki/CANON.md'` (a one-line grep guard), and the P4 EXIT GATE asserts the P2 canon verification ran green. Jim confirms this ordering is non-negotiable.
- **`.passthrough()` → `.strict()` — DECIDED (Jim, §9.3.1): TIGHTEN.** `:68` becomes `.strict()` so an injected top-level `driveEffects` hard-fails. Audit all `ActionOutcomePayload` producers first; `ipc-message-validator.spec.ts` then adds the rejection assertion. Milestone **P2.3**.
- **Standard 4 (provenance) + Standard 3 (confidence ceiling)** — pinned: SENSOR nodes `confidence=0.40` (ceiling 0.60), guardian touch promotes `provenance_type='GUARDIAN'`. Seam (f) + the provenance-integrity query enforce both. VLM/concept later-moves correctly tagged INFERENCE / 0.60-capped / non-promoting.
- **Drive Isolation (Standard 6 / §3.2)** — the grep gate (zero vision symbols importable from `drive-engine`) + PID separation + RLS protect it. **Action (major):** the new Neo4j persistence must not create edges spanning WKG and the OKG face store — add the KG-isolation assertion to the B-acceptance/Neo4j round-trip test (`:VisualObject`→world only, faces→other only, no cross-instance edge; spec §4.1).
- **Cassette honesty default — DECIDED (Jim, §9.3.7): HONEST-RED.** No cassette masks a regression today (the gate never touches `:8430`). The new perception-path interception fails the gate the moment an embedding is null — no temporarily-masked green path — plus the live pgvector null-rate sentinel.
- **insightface runtime probe (minor → blocking).** Elevate `FaceAnalysis.prepare()` to a blocking M0 checkbox (§4.1), not an open question.
- **Line-number drift (minor).** Several anchors drifted (e.g. embedding carry is `:142` not `:189` in this worktree; `main.py` response dict line varies). Re-grep each symbol before implementing.

### 8.2 mythos review (verdict: proceed-with-changes — corrections applied inline above)

All four mythos blockers are resolved in this document: (1) #0 retopologized to the `tracked_objects` array + effort revised up; (2) the cassette-masking narrative struck and replaced with a live null-rate sentinel + net-new perception interception; (3) Fork C reframed as fully net-new (no phantom `nudgeSceneChange` to keep; removal grep-gate deleted); (4) the `driveEffects`-rejection test replaced with an ignore-assertion (or `.strict()` per Jim). The two majors: (5) P1.5 added as the concrete vision-recall code change; (6) two separate dim constants (`OBJECT_EMBEDDING_DIM` near VWM, `FACE_EMBEDDING_DIM` in `face-snapshot.service.ts:50`) with independent migration versions — NOT collapsed.

### 8.3 ashby review (verdict: proceed-with-changes) — sign-offs owed

- **Trigger cooldown loop-gain — RATIFIED with a corrected statement.** Do NOT assert a numeric ms-vs-retrievals inequality (a category error: the cooldown is wall-clock ms, the rumination-breaker window is `RUMINATION_WINDOW=10` *retrievals*). The real guarantee: scene-triggered cycles are rate-limited to ≤1 per cooldown, and a single scene cycle contributes AT MOST one retrieval to the rumination window, so a flapping scene cannot fill the 10-retrieval window faster than ~10×cooldown wall-clock. The C-acceptance and the cooldown spec assert THIS form. Keep the cooldown ≥ a few seconds (a floor, raising is safe; below ~2s starts to matter).
- **High-diversity arousal-ratchet bound (major, owed to ashby).** Add `test/property/surprise-cascade.spec.ts` (§6.7): N distinct salient changes in a short window → cooldown still bounds cycle creation; pressure does not monotonically ratchet (decay dominates). The rumination breaker does NOT guard this case (it trips only on LOW episode diversity); the cooldown does. Route to ashby for written sign-off before P4.
- **Encode-side edge cut (minor, P4 exit gate).** Add the no-theater assertion that the surprise term still feeds ATTENTION only and does NOT open the episodic encode gate via a Curiosity/Anxiety path (both edges of the perception→drive→perception loop must stay cut).
- **Fingerprint widening is system-wide (minor).** `generateFingerprint` is shared across ALL input categories. cortex must verify the discontinuity is vision-local, not text/audio-wide, before #3 ships — measured across all categories, not just mug-vs-book.

### 8.4 cortex ratifications owed

The full-latent fingerprint widening (#3) → one-time recall discontinuity (land with WS5 T2); `CONTEXT_SIMILARITY_THRESHOLD=0.70` re-validate; and (per ashby) confirm the discontinuity's scope across all input categories. cortex also owns the P1.5 vision-recall routing decision (relax the text-required gate vs per-modality path).

### 8.5 atlas ratifications owed

The `visual_object_embeddings` schema extension (`bounding_box`/`dominant_colors`) that promotes BindingService 3→5-signal; per-node-type thresholds — do NOT collapse Person 0.55 into VisualObject 0.75. Blocks P3 + promotes P1 #1.

---

## 9. Risks, parked items, and open questions for Jim

### 9.1 Risks

- **Compounding-citation risk.** Several `file:line` anchors in the source designs drifted or referenced non-existent symbols. Before any implementation, **re-anchor every `file:line` against the target branch** (worktree `4f0b473` is one commit behind main `d123504`). The plan claims "every load-bearing claim re-read in code," but four central ones did not survive contact with source — they are corrected here, but treat all line numbers as hints.
- **Latency is genuinely unmeasured under load.** torch is CPU-only; DINOv2-base is ~69ms/crop, and even with P3.1's confirm-gate + every-Nth throttle, a frame in which many tracks confirm simultaneously (each pays a fresh embed) can still push `/detect` past the frame interval and trigger latest-wins drops (and make the scene-cycle rate bursty — harder for loop-gain). A real `/perception/detect`-under-load measurement is a mandatory live-smoke prerequisite before committing P3 (and #8/#9/#12). Route the budget to ashby; report nightly (CPU CI would be flaky as a hard gate).
- **#0 effort is higher than the original "1–2d near-zero."** The real wiring is a cross-array source + a new modality + a fusion-matrix/fingerprint-version bump (batched with #3), touching `process-input` fingerprinting and `latent-space` registration — non-trivial and continuity-affecting. The sequencing economics still hold (it's still the highest-leverage do-first), but plan the blast radius.
- **Object-crop retention for re-embedding.** The face cold layer keeps base64 crops; objects may NOT. A DINOv2 object-space migration cannot re-key prior nodes without retained crops — they become a clean miss, not a re-embed. **Unverified this pass** — verify before scheduling the object-space migration.

### 9.2 Parked

- **SAM 3.1 (FINAL — do not re-litigate).** Impossible on the substrate; Fork B adapts to `SceneEntity.id`; greedy IoU stays; mask-zeroing degrades to YOLO-seg `mask_polygon`. Separately scoped.

### 9.3 Resolved decisions (Jim, 2026-06-14)

All eight former open items were decided by Jim. Each carries its implication + where it propagates.

1. **`.passthrough()` → `.strict()` — TIGHTEN.** `ActionOutcomePayloadSchema` becomes `.strict()` so an injected top-level `driveEffects` hard-fails at the drive-isolation boundary (CANON Standard-6 hardening made executable). **Action:** audit all current `ActionOutcomePayload` producers FIRST so no legitimate field starts failing; then `ipc-message-validator.spec.ts` (§6.4) adds the rejection assertion. New milestone **P2.3** (§10).
2. **Neo4jGraphPersistence — CLASS-CORRECT + ROUND-TRIP ONLY.** Build the class so the dangling import resolves and it passes a seeded round-trip (incl. the bounding_box JSON-map trap); **do NOT live-wire it** into `/detect` — the live B-acceptance re-bind path runs NestJS-side via `Neo4jService` and does not use it. Python A.5 stays the reference spec. P3.3 drops `[open]`.
3. **Temporal scene-state graph — LATER WORKSTREAM (after A/B/C).** It depends on the Neo4j backend + BindingService + dorsal stream (#5), which land in/after P3; sequencing it afterward preserves cheap-promotions-first. Stays in §5.8 / the LATER row; NOT an A/B/C milestone.
4. **ByteTrack — ADOPT, scheduled after P3.** A buildable motion-model tracker (real weights, push-compatible API) that fixes the greedy-IoU occlusion/crossing failure; slots into the parked-SAM gap once re-id quality (P1–P3) is in place. Promoted from `[open]` to scheduled milestone **BT.1** (§10), shipping with the occlusion/crossing clip fixture as its exit test.
5. **insightface numpy-2 — PINNED `>=1.0`, PREBUILT-WHEEL FALLBACK.** Install `insightface>=1.0` (numpy-2-safe per the probe); if the `FaceAnalysis.prepare()` runtime probe crashes on `np.bool`/`np.int`, drop to a prebuilt wheel. Single venv; escalate to a separate numpy<2 env ONLY if the wheel also fails. (§4.1.)
6. **Object-crop retention — CLEAN-MISS NOW + RETAIN GOING FORWARD.** A backbone swap is a clean one-time recall miss (old nodes re-recognized on next sighting), consistent with Invariant 2. **Action:** start persisting object crops now (mirror the face cold layer) so FUTURE migrations can re-embed history without a gap. The B-acceptance test accepts a clean re-key, not a re-embed of pre-swap history. (§9.1.)
7. **Cassette honesty — HONEST-RED ON NULL FROM DAY ONE.** The new perception-path interception fails the gate the moment an embedding is null (no temporarily-masked green path) — matches no-silent-stubs / theater-prohibition. (§6.4, §8.1.)
8. **Cross-agent ratifications — SPECIALIST SIGN-OFF AT EACH PHASE GATE.** ashby (loop-gain/cascade → P4), cortex (fingerprint discontinuity + P1.5 routing → P1/P1.5), atlas (schema + per-node-type thresholds → P3) are invoked as ACTUAL reviews just before each gated phase's code lands (mythos-verification discipline); their decisions are captured into this doc and tests must not hardcode values still under their review.

---

## 10. Sequenced milestone list with test gates

Status tags: **[buildable-now]** (no M0 dep) · **[blocked-on-m0]** · **[needs-ratification]** · **[parked]** · **[open]** (needs Jim's call).

| # | Milestone | Status | Exit test gate |
|---|---|---|---|
| M0.1 | Add `neo4j`+`insightface` to `requirements.txt`; pip install all 4 into the **main-repo** venv | [blocked-on-m0] | `import onnxruntime, mediapipe, neo4j, insightface` → "M0 imports OK" |
| M0.2 | Resolve mediapipe↔opencv-contrib conflict (`--no-deps` + `pip check`) | [blocked-on-m0] | `pip check` clean; cv2 4.13 intact |
| M0.3 | insightface RUNTIME probe (`FaceAnalysis.prepare()`, downloads buffalo_l) | [blocked-on-m0] | prints "insightface runtime OK" (no `np.bool`/`np.int` crash) |
| M0.4 | Pre-download weights; verify EfficientNet ONNX actual output dim (or skip if DINOv2-first) | [blocked-on-m0] | weights cached; dim == 1280 confirmed (or path retired) |
| M0.5 | pytest scaffold (`pyproject.toml` markers + skip-loud `conftest.py`) + jest config for `apps/sylphie` | [buildable-now] | empty suites run green; skip reasons logged |
| M0.6 | Live bring-up + health all-true + `/detect` real frame | [blocked-on-m0] | `health` all-true; `embedding` non-null (1280); `faces[]` non-empty; **mythos live-smoke** |
| BL.1 | Pure-logic baseline: `linear-algebra`, `scene-event-detector`, `ipc-message-validator` (clamp), `rules`, `test_persistence_scorer` | [buildable-now] | all green; CI-blocking layer wired |
| BL.2 | Embedding-discard documentation contract (`perception.gateway.spec.ts`) | [buildable-now] | RED-as-documented (no visual_embedding modality registered) |
| P1.0 | **#0** `visual_embedding` modality from `tracked_objects[].embedding` (generic input-dim const) | [buildable-now] | discard contract flips GREEN; mug-vs-book cosine gap > margin (bounded both directions, ashby) |
| P1.1 | **#3** full-latent versioned fingerprint (batched w/ #0) | [needs-ratification] | `fingerprint.spec.ts` + `fingerprint-migration.spec.ts`; clean one-time miss; cortex scope-sign-off |
| P1.2 | **#1** A.5 scorer → NestJS `BindingService` (≈3-signal, OPEN-9 renorm) | [needs-ratification] | `binding.service.spec.ts` mirrors Python goldens; ambiguous-band + OPEN-9 ≈0.84; atlas profiles |
| P1.3 | **#2** mutable instance centroids (mirror FaceSnapshot mean) | [buildable-now] | centroid drift>0 across N sightings; no duplicate node |
| P1.5 | **Vision-recall routing** (per-modality / relax text-gate for `SYSTEM_TRIGGER`) | [needs-ratification] | vision-only frame returns a non-null recall for a seen scene, null for unseen; cortex sign-off |
| P2.1 | Frame-dim plumbing (all 5 normalizers, optional DTO fields default 640/480) | [buildable-now] | `curl 1280×720` → `frame_width:1280`; center→~0.5 at 720p; existing gate byte-identical |
| P2.2 | enforce-canon repoint + fail-loud (`exit(0)`→`exit(2)`, `fs.existsSync` guard) | [buildable-now] | deliberate Standard-6 violation → exit 2; rename spec → exit 2; exit 0 unreachable |
| P2.3 | Harden IPC schema `.passthrough()`→`.strict()` (audit producers first — §9.3.1) | [buildable-now] | injected top-level `driveEffects` REJECTED; all existing payload producers still validate |
| P3.1 | DINOv2-base 768-D object embeddings + `vector(1280)→768` destructive-script migration + #0 const→768 + JL projection DELETED (768==fused dim) + confirm-gate/throttle | [buildable-now] | D1 margin; embeddings flow end-to-end; mask-zeroing intact; cassette/golden 768 in lockstep |
| P3.2 | ArcFace 512-D face path (unmasked crop, `vector(1280)→512`, retune threshold, OPEN-12) | [blocked-on-m0] | 512-D; same-face two angles match; WS4 multi-person gate green; no body-crop contamination |
| P3.3 | Neo4jGraphPersistence (class-correct + round-trip ONLY, not live-wired — §9.3.2) + atlas schema extension + KG-isolation | [blocked-on-m0] | seeded round-trip + JSON bbox >0 spatial; power-cycle persists; KG-isolation green (live binding stays NestJS-side) |
| P4.1 | `presenceSurprise` field + Zod clamp + `rules.ts` mapping (assert+extend) | [buildable-now] | `presenceSurprise` clamp REJECT 1.5/-0.1; `computeDefaultAffect` scaled map |
| P4.2 | New `SurpriseEvent` emitter (trigger + signal, `SYSTEM_TRIGGER`, trigger cooldown) | [needs-ratification] | `SYSTEM_TRIGGER` cycle on vision-only frame; trigger-vs-signal discipline; **ashby cooldown + cascade sign-off** |
| P4.3 | Encode-side guard + surprise-cascade property test | [needs-ratification] | salient frame → cycle but no encode-gate-via-drive; N-distinct cascade bounded (ashby) |
| P5.1 | Retire EfficientNet `OnnxEmbeddingExtractor` (keep `DominantColorExtractor`) | [buildable-now] | grep ZERO `OnnxEmbeddingExtractor`/`efficientnet`; `/detect` still 768/512 |
| ACC.A | **A acceptance** (`accept-A.e2e.ts`) — embeddings flow end-to-end | [blocked-on-m0] | non-null 768; intra>inter margin; mask-zeroing; **mythos live-smoke** |
| ACC.B | **B acceptance** (`accept-B.e2e.ts`) — durable cross-session re-bind | [blocked-on-m0] | same `node_id` across power-cycle; centroid drift>0; bbox round-trips; **mythos live-smoke** |
| ACC.C | **C acceptance** (`accept-C.e2e.ts`) — surprise → trigger → recall → react | [needs-ratification] | `SYSTEM_TRIGGER` cycle; reacts to CHANGE (needs P1.5); habituation; no perception-side delta; **mythos live-smoke** |
| BT.1 | **ByteTrack** motion-model tracker (after P3 — §9.3.4; fills the parked-SAM gap) | [needs-ratification] | occlusion/crossing clip: track IDs stay stable through occlusion where greedy IoU breaks |
| LATER | #4–#12, temporal scene-state graph (later workstream — §9.3.3) | [open] | each ships with its acceptance test (§5.8) |
| WS-SAM | SAM 3.1 perception-core | [parked] | no test — separately scoped |

**Implementation routing:** the heavy multi-file work (new modality + fusion/fingerprint version bump, BindingService port, backbone swaps, Neo4j package, Fork C emitter) routes to **opus-agent per phase**; **mythos** does the mandatory live-smoke sign-off at each EXIT GATE. No phase closes on a passing build + unit tests alone — mythos must watch it run.

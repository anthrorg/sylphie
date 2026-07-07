# Plan — 20260702-007 — Perception service: fabricated face confidence, dead tracker config, unthrottled color loop

- **Type:** bug · **Route:** EPIC (4 tickets) · **DB:** no (see migration.md — dbcheck false-positive) · **size_hint:** large · **Priority:** P1 (source severity: high)
- **Owner:** `marr` (packages/perception-service CV) + `forge`/`vox`-adjacent for the `apps/sylphie` consumer edge · **conceptual reviewer:** `luria` · **code reviewer:** `code-reviewer`

## Discovery — verified against live source (all 4 load-bearing claims confirmed exactly)

Every line-level claim in `source.md` was re-read at the cited location. All hold:

1. **Fabricated face confidence** — `packages/perception-service/cobeing/layer2_perception/face_detector.py:256-258` (`MediaPipeFaceDetector.detect`): the comment says "Estimate confidence from the first blendshape category or fall back to the config threshold," but the code is only `confidence = self._config.confidence_threshold` — every face gets the constant config value, default `0.5` (`config.py:183`, `FaceDetectionConfig.confidence_threshold`). Consumer gate confirmed: `apps/sylphie/src/services/face-snapshot.service.ts:101` (`MIN_CONFIDENCE = 0.65`) and `:316` (`if (primary.confidence < MIN_CONFIDENCE) return;`) — `0.5 < 0.65` always, so `processFaceFrame` bails on every call once it reaches that line, silently (no log/error at the bail site — confirmed by reading lines 305-325).
2. **Tracker LOST→CONFIRMED bypasses `min_confirm_frames`** — `packages/perception-service/cobeing/layer2_perception/tracker.py:364-365` (`_apply_match`): the `elif track.state == TrackState.LOST:` branch sets `new_state = TrackState.CONFIRMED` unconditionally, with no check against `self._min_confirm_frames` or `new_frames_seen`. A track that went TENTATIVE(1)→LOST on one missed frame becomes CONFIRMED on the very next match, bypassing the 3-frame threshold the TENTATIVE branch enforces two lines above.
3. **Tracker config knobs are dead** — `packages/perception-service/main.py:376-380`: `IoUTracker(iou_threshold=0.3, min_confirm_frames=3, max_lost_frames=15)` is hardcoded; no reference to `cfg.tracking` anywhere in the file (confirmed via grep — zero hits for `cfg.tracking` or `COBEING_PERCEPTION_TRACKING` outside `config.py` itself). **Correction to source:** these three literals happen to exactly match `TrackingConfig`'s Pydantic field defaults (`config.py:151-166`: `iou_threshold=0.3`, `max_lost_frames=15`, `min_confirm_frames=3`), so there is **no observable behavioral bug on an unconfigured deployment** — the bug is purely that `COBEING_PERCEPTION_TRACKING__*` env vars validate (Pydantic accepts and parses them) but are silently discarded before reaching the tracker. Still a correctness bug (a documented, validated config surface that does nothing), just not a live-default malfunction like #1/#2/#4.
4. **Unthrottled per-pixel color loop** — `packages/perception-service/main.py:660-665` (re-verified at re-plan time: `_extract_track_color_and_crop` called via `loop.run_in_executor` unconditionally inside `if is_confirmed:`, immediately after the embedding branch which *does* check `_should_embed_track`/`_EMBED_EVERY_N` first) — confirmed no throttle guards the color call at all, for every confirmed track on every `/detect` call. `packages/perception-service/cobeing/layer2_perception/feature_extraction.py:154-166` (`DominantColorExtractor.extract`) confirmed as a pure-Python nested loop over every pixel in the bbox (`for row in range(y_min, y_max): for col_offset in range(0, ..., 3): ...`) — O(bbox area) Python-level byte ops, unvectorized. **Correction to source:** `source.md`'s "Where it lives" section names this file as `layer1_sensory/feature_extraction.py` — that path does not exist. The real (and only) `feature_extraction.py` in this repo is `packages/perception-service/cobeing/layer2_perception/feature_extraction.py` (confirmed via glob — no `layer1_sensory` directory exists in this package at all). Ticket -d below uses the correct path.

## Design fork found during verification (NOT in source — genuine gap)

The source proposes fixing #1 by deriving confidence "from the first blendshape category" or "from MediaPipe's detection confidence." **Both proposed signals were checked against the actual API surface and neither exists as described:**

- `MediaPipeFaceDetector` uses the **Face Landmarker** Tasks API (`mediapipe.tasks.python.vision.face_landmarker.FaceLandmarker`), not the separate Face Detector task. Its `FaceLandmarkerResult` (confirmed by reading `.venv/Lib/site-packages/mediapipe/tasks/python/vision/face_landmarker.py:2890-2901`) has exactly three fields: `face_landmarks`, `face_blendshapes`, `facial_transformation_matrixes`. **There is no per-face detection-confidence score in this result at all.** `confidence_threshold` is only consumed as an *input* filter (`min_face_detection_confidence`/`min_face_presence_confidence` passed to `FaceLandmarkerOptions`, `face_detector.py:159-165`) — MediaPipe uses it internally to decide what to return, but never hands the score back.
- Blendshape categories (`browDownLeft`, `jawOpen`, etc.) are per-expression activation scores, not a detection-confidence signal. Using one as a stand-in "confidence" would not be deriving a real detection confidence — it would be substituting a different fabricated number for the current one, which risks re-creating the exact theater problem this bug reports, just with a more convincing-looking source. (Repo precedent: `contract.yaml` DEC-32 already rejected an analogous move — "moving the bar on a still-fabricated confidence... just relocates the fabrication" — in a different subsystem's confidence gate.)

Real options that exist, none of them free:
- **(a)** Run MediaPipe's separate `FaceDetector` task (short/full-range) alongside or instead of the Landmarker to get a genuine `category.score` per face — adds a second CV model + inference cost to the same `/detect` hot path that ticket 20260702-007-d is trying to de-load.
- **(b)** Derive a legitimate quality proxy from existing landmark geometry (e.g., bbox stability across frames, landmark spread/completeness) — engineering-judgment call on what "legitimate" means here; not obviously exempt from the same theater concern.
- **(c)** Change the *consumer* contract: gate `face-snapshot.service.ts` on something other than a continuous confidence float (e.g., landmark completeness + blendshape presence, already partially used at `:317` `primary.landmarks.length < 455`), instead of manufacturing a number to compare against `MIN_CONFIDENCE`.

This is a cross-package (perception-service + apps/sylphie face-snapshot contract) design choice with a CANON theater-prohibition angle, not a pure code fix — filed as an open_question rather than guessed. See `open_questions` in the structured output.

## Contract overlap check (re-verified at re-plan time)

Searched `planning/contract.yaml` (read-only) for existing work on the four fix surfaces
(`face_detector.py`, `tracker.py`, `main.py`'s `IoUTracker` ctor / color-extraction call,
`feature_extraction.py`, `face-snapshot.service.ts`). Findings:

- **No existing ticket touches** face-detection confidence, the tracker LOST→CONFIRMED
  state machine, `cfg.tracking` wiring, or `DominantColorExtractor` throttling/vectorization.
  This is genuinely new scope, not a duplicate.
- **Adjacent but distinct:** TK-102 ("Bound app-side retained perception tracker state...
  confirmed tracks must decay/evict") and TK-105 (frontend perception-overlay buffer
  eviction) both live under `packages/perception-service` tracker-adjacent code, but they
  fix unbounded **retention/eviction** of already-confirmed tracks over time — a different
  defect class from this item's **premature promotion** (`-b`) and **dead config** (`-c`)
  bugs. No overlap; do not attach to TK-102/105.
- **Adjacent but distinct:** an existing (done) ticket under the P5.1b cluster
  (`files_in_scope: packages/perception-service/main.py, .../feature_extraction.py`)
  deleted `OnnxEmbeddingExtractor` while explicitly preserving `DominantColorExtractor` —
  it never touched color-extraction throttling/performance. No overlap.
- **Adjacent but distinct:** `face-snapshot.service.ts` appears in several `done` tasks
  under TK-84/TK-85 (grounding-collapse refactor, face/latent-space isolation POC) — none
  touch the `MIN_CONFIDENCE` gate or `processFaceFrame`'s bail behavior. No overlap.
- **Precedent worth citing for the open_question below:** `DEC-32` (accepted) rejected
  "moving the bar on a still-fabricated confidence" (lowering a threshold instead of fixing
  the underlying signal) as CANON Std-4 theater, in the deliberation-service debate-gate
  context. The same principle is directly relevant to ticket -a's design fork.
- `existing_contract_overlap`: none (empty) — this item's four fix surfaces are unclaimed
  by any existing epic/ticket. New epic under `FEAT-3` is warranted, following the
  established convention (`EP-23`=item 002, `EP-24`=item 003, `EP-25`=item 004,
  `EP-26`=item 005, `EP-27`=item 20260625-002).

## Proposed contract structure (STAGED — NOT written to contract.yaml)

New epic under `FEAT-3` (matches the established per-item convention for the 2026-07-02 audit batch — see `EP-23`/`EP-24` for items 002/003): working title "Perception service: real face confidence, tracker fidelity, hot-path throttling," `pipeline_item: "20260702-007"`. Numeric `EP-<n>` assigned at contract-write time.

| Working id | Ticket | Priority | eng_level | Depends on | Ready now? |
|---|---|---|---|---|---|
| 20260702-007-a | Real per-detection face confidence (replace the fabricated constant) | P1 | production | none | **NO — blocked on open_question Q-face-confidence-signal** |
| 20260702-007-b | Tracker LOST→CONFIRMED must respect `min_confirm_frames` | P1 | production | none | yes |
| 20260702-007-c | Thread `cfg.tracking` into the `IoUTracker` constructor (kill the dead env-var surface) | P1 | production | none | yes |
| 20260702-007-d | Throttle or vectorize per-frame dominant-color extraction | P1 | production | none | yes |

**Non-goal (explicit, from source):** wiring the dead layer3 spreading-activation engine — separate architectural decision, out of scope here (stub-inventory §2.9).

## Tickets

### 20260702-007-a — Real per-detection face confidence (replace the fabricated constant)
**Blocked on open_question** (see below) — staged here with acceptance criteria written against the *outcome*, not a specific MediaPipe call, so whichever option architect picks satisfies the same tests.

- Given a clear, well-lit face detected by `MediaPipeFaceDetector.detect`, when two frames with visibly different face quality/pose are run through it, then the returned `FaceDetection.confidence` values differ (not a constant `0.5`) — **runnable check:** a unit test feeding two fixture frames (a frontal clear face, a heavily occluded/angled face) through `MediaPipeFaceDetector.detect` (or its replacement) asserts `confidence_a != confidence_b` and neither equals `self._config.confidence_threshold` exactly.
- Given a face whose real detection quality is high, when `face-snapshot.service.ts.processFaceFrame` runs, then its confidence can exceed `MIN_CONFIDENCE` (0.65) and a crop is collected — **runnable check:** an integration test posting a known-good face fixture through `/perception/detect` then into `processFaceFrame` asserts `snapshotCount` increments for at least one angle bucket, where today it is provably zero for all frames (source repro #1).
- Given `processFaceFrame` bails on low confidence, when it does, then the bail is logged (level debug/info) with the confidence value and threshold — **runnable check:** a unit test asserts a log call fires on the `< MIN_CONFIDENCE` branch (currently silent, confirmed by reading `:316`).
- **Non-goal:** this ticket does not add a second CV model unless the architect ruling (open_question) selects option (a); it does not touch the ArcFace identification threshold (the separate `!!! PROVISIONAL_ARCFACE !!!` 0.55 constant at `face-snapshot.service.ts:~106`) — that is a different, already-flagged number, out of scope.
- **Depends on:** resolution of open_question Q-face-confidence-signal (architect ruling on which real signal to derive and whether hot-path cost (a) is acceptable against ticket -d's throttling goal).

### 20260702-007-b — Tracker LOST→CONFIRMED must respect `min_confirm_frames`
- Given a track in TENTATIVE state with `frames_seen=1` that misses a frame (→ LOST) and then matches again, when `_apply_match` runs on that LOST track, then it does NOT transition to CONFIRMED unless the track's accumulated `frames_seen` (post-increment) meets `self._min_confirm_frames` — otherwise it returns to TENTATIVE (or an equivalent non-CONFIRMED state) and continues accumulating — **runnable check:** unit test in `tracker.py`'s test suite: construct a tracker with `min_confirm_frames=3`, drive a track TENTATIVE(1)→LOST→match, assert resulting state is NOT `TrackState.CONFIRMED`; then drive a track that reaches `frames_seen>=3` before any LOST detour, assert it IS confirmed (regression guard for the existing correct path).
- Given a CONFIRMED track that goes LOST and recovers, when `_apply_match` runs, then it correctly returns to CONFIRMED (this path is legitimate and must not regress) — **runnable check:** unit test: track reaches CONFIRMED via 3 real matches, misses one frame (LOST), matches again, assert state is CONFIRMED (unchanged behavior for the already-confirmed case).
- **Non-goal:** does not change `max_lost_frames`/DELETED transition logic (`_apply_no_match`) — untouched.

### 20260702-007-c — Thread `cfg.tracking` into the `IoUTracker` constructor
- Given `COBEING_PERCEPTION_TRACKING__MIN_CONFIRM_FRAMES=5` (or any of the three tracking env vars) set at process start, when the perception service constructs its `IoUTracker` in `main.py`, then the tracker is built with `min_confirm_frames=5` (and correspondingly for `iou_threshold`/`max_lost_frames`), not the hardcoded literals — **runnable check:** a unit/integration test that sets the env var, boots (or re-invokes) the tracker-construction code path, and asserts the resulting `IoUTracker` instance's `_min_confirm_frames` (or public equivalent) equals the configured value.
- Given no tracking env vars set, when the service boots, then the tracker still uses `iou_threshold=0.3, min_confirm_frames=3, max_lost_frames=15` (the `TrackingConfig` Pydantic defaults) — **runnable check:** regression test asserting default-path behavior is unchanged (defaults already match the removed hardcoded literals, so this is a straightforward equality assertion, not a behavior change).
- **Non-goal:** does not add new config fields or change `TrackingConfig`'s schema — it already exists and validates; this ticket only wires it through.

### 20260702-007-d — Throttle or vectorize per-frame dominant-color extraction
- Given a confirmed track on a `/detect` call, when the pipeline decides whether to run `_extract_track_color_and_crop`, then it is throttled on the same or an analogous cadence to the existing embedding throttle (`_EMBED_EVERY_N`/`_should_embed_track` pattern at `main.py:264`) **or** `DominantColorExtractor.extract` is rewritten to a vectorized NumPy implementation (downsampling/binning without a per-pixel Python loop) — either branch satisfies the AC below — **runnable check:** a benchmark/profile test posting N frames with one person-sized bbox in view at simulated 15 fps asserts per-frame color-extraction wall-clock time drops by a defined margin (e.g. >=5x) versus the current unthrottled per-pixel-loop baseline, measured before/after.
- Given the throttled/vectorized path, when a track's color is not recomputed on a given frame, then the last computed dominant color is reused (carry-forward), matching the existing embedding-cache pattern — no `None`/blank color surfaces to consumers on throttled-out frames — **runnable check:** unit test: track color computed on frame 1, throttled out on frames 2-N, assert the reported color on frames 2-N equals frame 1's value (not null).
- **Non-goal:** does not touch the embedding throttle itself (`_EMBED_EVERY_N`) or the crop/base64 encoding path beyond what's needed to keep it working under the new cadence.

## Acceptance criteria summary
All four tickets' criteria are Given/When/Then with an explicit runnable check (unit test, integration test, or before/after benchmark) as required. Ticket -a's exact implementation is intentionally left open pending the open_question ruling; its acceptance criteria are written against observable behavior so they hold regardless of which option is chosen.

## Routing decision → **replan** (for ticket -a only; -b/-c/-d are refine-ready)

Three of four tickets (-b, -c, -d) are atomic, unambiguous, and fully ready for `refine` today — no design content, single fix surface, one runnable check each. Ticket -a — the source's own "highest-value" fix — has a genuine, previously-unstated design fork (no real per-detection confidence signal exists in the API surface the code currently calls) with cross-package and CANON theater-prohibition implications. Per pipeline rules, that ambiguity is written down as an open_question rather than guessed, which is why the item as a whole routes to `replan`: the coordinator should consider `split_recommendation` below so -b/-c/-d are not held up by -a's fork.

## Open questions (route to architect, do not guess)

- **Q-face-confidence-signal:** MediaPipe `FaceLandmarker`'s Tasks API result exposes no per-face detection-confidence score (confirmed: `FaceLandmarkerResult` has only `face_landmarks`/`face_blendshapes`/`facial_transformation_matrixes`). Given that, what should stand in for "face confidence" so `face-snapshot.service.ts`'s `MIN_CONFIDENCE` gate becomes a real signal rather than a differently-shaped fabrication? Concretely: (1) add MediaPipe's separate `FaceDetector` task alongside/instead of the Landmarker to get a genuine `category.score`, accepting the extra hot-path model cost this same audit batch is trying to reduce elsewhere (ticket -d); or (2) derive a geometry-based quality proxy (landmark stability/completeness) and accept it is a proxy, not a probability, documenting it as such; or (3) redesign the consumer gate to not require a continuous confidence float at all (e.g. gate on landmark completeness, already partially done at `face-snapshot.service.ts:317`). This determines both the perception-service fix and whether `apps/sylphie/src/services/face-snapshot.service.ts`'s `MIN_CONFIDENCE=0.65` threshold semantics need to change. Architect ruling requested; do not build ticket -a until answered.

## Split recommendation

Recommend the coordinator split this item so -b/-c/-d (clean, atomic, ready) advance to `refine`/`queue` now under the new epic, while -a is parked pending the architect ruling on Q-face-confidence-signal (either as a `replan`-held remainder of this same item, or spun into its own follow-up item once the ruling lands — coordinator's call per contract_write=autonomous process-decomposition authority; this is process routing, not new application direction, so it does not need to wait on Jim).

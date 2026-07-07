# Bug: Perception service — fabricated face confidence disables enrollment, dead tracker config, unthrottled per-pixel hot path

**Severity:** high  ·  **Priority:** P1
**Area / component:** packages/perception-service (Python CV) + face-snapshot consumer (apps/sylphie)

## What's broken (required)
The CV pipeline (YOLO, IoU tracking, DINOv2, ArcFace) is genuinely wired, but it ships a fabricated confidence constant that silently disables a downstream feature, ignores its own config, and carries an unthrottled pure-Python cost:
- **Fabricated face confidence disables enrollment (theater).** `face_detector.py:256-258` comments "Estimate confidence from the first blendshape category or fall back," but only does the fallback: `confidence = self._config.confidence_threshold` (default 0.5). Every face is reported at a constant 0.5. The consumer `face-snapshot.service.ts:101,316` gates crops on `MIN_CONFIDENCE=0.65`, so `0.5 < 0.65` bails on **every** frame — face-snapshot enrollment never collects a single crop, with no error or log. A hardcoded value presented as a model output that silently zeroes a feature.
- **Tracker LOST→CONFIRMED bypasses `min_confirm_frames`.** `tracker.py:364-368` — a TENTATIVE track (`frames_seen=1`) that misses one frame becomes LOST; on the next match it goes straight to CONFIRMED with `frames_seen=2 < 3`. Flickering false positives get confirmed, triggering DINOv2 embedding extraction, VWM entities, scene events, and drive pressure downstream.
- **Tracker config knobs are silently dead.** `perception-service/main.py:376-380` constructs `IoUTracker(iou_threshold=0.3, min_confirm_frames=3, max_lost_frames=15)` hardcoded, ignoring `cfg.tracking` — every `COBEING_PERCEPTION_TRACKING__*` env var validates and does nothing.
- **Pure-Python per-pixel color loop on the /detect hot path, unthrottled.** Embeddings are throttled to every Nth sighting, but `_extract_track_color_and_crop` runs for every confirmed track on every frame, and `DominantColorExtractor.extract` is a per-pixel Python loop — a 720p person bbox is millions of byte ops per frame per track, dominating frame latency at 15 fps and backing up the default executor.

## Expected (required)
Face detections carry a real per-detection confidence so the snapshot gate can pass on good faces; tracker promotion respects `min_confirm_frames`; tracker config is driven by `cfg.tracking`/env; and the color extraction is throttled or vectorized so it doesn't dominate frame latency.

## Steps to reproduce (required)
1. Run the perception service against a clear face feed; watch `face-snapshot.service.ts` — `processFaceFrame` bails on every frame (fabricated 0.5 < 0.65), zero crops collected, no log explaining why.
2. Set any `COBEING_PERCEPTION_TRACKING__*` env var; observe the tracker still uses the hardcoded ctor values.
3. Profile `/detect` at 15 fps with a person in frame — per-frame latency is dominated by the Python color loop.

**Reproducibility:** always for #1–#3.

## Evidence
- Face confidence: `packages/perception-service/cobeing/layer2_perception/face_detector.py:256-258`; default `config.py:183`; gate `apps/sylphie/src/services/face-snapshot.service.ts:101,316`.
- Tracker promotion: `tracker.py:364-368`.
- Dead config: `perception-service/main.py:376-380`.
- Color hot path: `main.py:660-665`; extractor `feature_extraction.py:154-166`; embedding throttle for contrast `main.py:264`.

Full detail: `docs/audits/repo-bug-audit-2026-07-02.md` §7 (perception half).

## Where it lives (scope hints)
`packages/perception-service/cobeing/layer2_perception/face_detector.py` (derive a real confidence from the detection/blendshape score, or from MediaPipe's detection confidence), `perception-service/main.py:376-380` (thread `cfg.tracking` into the tracker ctor), `layer2_perception/tracker.py:364-368` (respect `min_confirm_frames` on LOST→CONFIRMED), `layer1_sensory/feature_extraction.py` (vectorize the color loop with NumPy or downsample). Consumer gate `apps/sylphie/src/services/face-snapshot.service.ts`. Owned by `marr` (perception CV) per CLAUDE.md work-trio.

## Database impact (required)
**Touches a database / schema / migration?** no. Pure CV/service code; no schema/migration. (Face snapshots, once enrollment works, write to existing OTHER-graph paths — unchanged here.)

## Acceptance — how we'll know it's fixed (required)
- Given a clear face at good quality, when detected, then the reported confidence reflects the actual detection (varies, not a constant 0.5) and exceeds 0.65 so `processFaceFrame` collects a crop; the gate decision is logged either way.
- Given `COBEING_PERCEPTION_TRACKING__MIN_CONFIRM_FRAMES` (etc.) set, when the tracker is constructed, then it uses the configured value (unit test).
- Given a track that flickers TENTATIVE→LOST→match, when promotion is evaluated, then it is not CONFIRMED before `min_confirm_frames` (unit test).
- Given a person in frame at 15 fps, when `/detect` runs, then per-frame color extraction is not the dominant cost (profile/benchmark before/after).

## Environment
Local dev + any deploy running the perception sidecar with a camera feed. Source-trace at commit `228df73`.

## Notes / non-goals (optional)
- The face-confidence fix is the highest-value one: it silently disables an entire enrollment feature today.
- Non-goal: wiring the dead layer3 spreading-activation engine (separate architectural decision — leave as labeled Phase-3 reference spec per stub-inventory §2.9).

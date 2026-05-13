# Idea: Class-aware IoU association in IoUTracker

**Created:** 2026-04-27
**Status:** proposed

## Summary

Gate the IoU association in `IoUTracker._greedy_assign` (and the underlying cost matrix) by detection class label so that a track and a detection can only be matched when their `label_raw` values agree. Today the tracker is class-blind: any two overlapping bounding boxes are eligible to be matched regardless of YOLO class.

## Motivation

`packages/perception-service/cobeing/layer2_perception/tracker.py` currently builds the IoU cost matrix from `_compute_iou(track.detection, det)` alone, with no consideration of `Detection.label_raw`. In multi-class scenes that is a real correctness problem:

- **Cross-class ID swaps.** A `person` walking past a `chair` whose bbox overlaps significantly can have its track silently re-bound to the chair (and vice versa). Layer 3 then sees a `person`-typed track flip to `chair` mid-session. Because the track id is preserved, downstream consumers (observation ingestion, persistence checks, narration) treat it as the same identity, polluting the knowledge graph.
- **Noise promotion via LOST detour.** A spurious single-frame TENTATIVE detection that drops to LOST one frame, then is "matched" by any other class detection in the same region, jumps straight to CONFIRMED via the `LOST + matched -> CONFIRMED` rule in `_apply_match`. Class gating eliminates the most common version of this failure mode (cross-class re-acquisition) and keeps `min_confirm_frames` doing the work it was designed for.
- **Cheap, dependency-free fix.** The change is a one-line guard inside `_greedy_assign` (or `_compute_iou`): treat IoU as 0.0 whenever `track.detection.label_raw != det.label_raw`. No new libraries, no architectural changes, no impact on the no-numpy/no-OpenCV invariant the file is careful about.

This is also how mainstream SORT-family trackers (e.g. ByteTrack, OC-SORT) handle multi-class detection streams — per-class tracking is the default expectation, not a feature.

## Subsystems Affected

- Perception Layer 2 / `cobeing.layer2_perception.tracker` (primary)
- Perception Layer 2 pipeline (`pipeline.py`) — only insofar as track-id stability per object class improves
- Persistence-check service (`persistence_check_service.py`) — fewer cross-class identity flips reaching Layer 3

## Open Questions

- Should label gating be strict equality on `label_raw`, or should it operate on a normalized/canonical class (Layer 3 already normalizes labels in schema lookup)? Strict `label_raw` keeps Layer 2 self-contained; canonicalization would require importing the normalization map.
- Tunable knob? Most callers will want hard gating, but a `class_gating: bool` constructor flag (default True) preserves the current behavior for tests or experiments that intentionally rely on class-blind matching.
- Related but separate: should the TENTATIVE→LOST→CONFIRMED shortcut also be tightened so that recovery from LOST while still TENTATIVE-eligible requires `frames_seen >= min_confirm_frames`? Worth investigating in the same research pass since both bugs interact.
- Does the IoU cost matrix construction need to skip the `_compute_iou` call entirely on label mismatch (micro-optimization), or is short-circuiting inside `_compute_iou` sufficient given typical detection counts?
- Test coverage: extend `tests/test_observation_validator.py` (or a new `test_tracker.py`) with a multi-class overlap scenario asserting no ID swap between a `person` and a `chair` track.

"""Observation builder -- converts confirmed TrackedObjects into Observations.

This module provides :class:`ObservationBuilder`, which is the final stage
of the Layer 2 perception pipeline.  It accepts a batch of
:class:`~cobeing.layer2_perception.types.TrackedObject` instances (as
produced by the tracker) plus a mapping of
:class:`~cobeing.layer2_perception.types.PersistenceResult` values (from
the persistence-check service) and produces
:class:`~cobeing.shared.observation.Observation` instances that are ready
for Layer 3 ingestion.

Only **CONFIRMED** tracks produce Observations.  TENTATIVE, LOST, and
DELETED tracks are silent in the output -- they do not represent reliable
detections.

Debouncing
----------
For a static camera scene, the same object is detected frame after frame
without moving.  Re-emitting an identical Observation every frame would
flood Layer 3 with redundant data.  The builder maintains a per-track
record of the *last-emitted* detection bounding box and feature hash and
skips re-emission when:

1. The IoU between the current bounding box and the last-emitted bounding
   box exceeds ``debounce_iou_threshold`` (the object has not moved), AND
2. The features have not changed (same dominant colors and embedding hash).

When either condition is false the builder emits a fresh Observation and
updates the per-track record.

Usage::

    from cobeing.layer2_perception.observation_builder import ObservationBuilder
    from cobeing.layer2_perception.types import TrackState

    builder = ObservationBuilder(
        session_id="session-abc",
        source_id="camera-0",
        debounce_iou_threshold=0.95,
    )

    observations = builder.build(
        tracked_objects=tracks,
        persistence_results=results,
        frame_width=640,
        frame_height=480,
    )
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Optional

from cobeing.layer2_perception.types import (
    Detection,
    FeatureProfile,
    PersistenceResult,
    TrackId,
    TrackState,
    TrackedObject,
)
from cobeing.shared.observation import BoundingBox, Observation
from cobeing.shared.provenance import Provenance, ProvenanceSource


# ---------------------------------------------------------------------------
# Internal debounce record
# ---------------------------------------------------------------------------


@dataclass
class _EmittedRecord:
    """Per-track record of the last-emitted detection used for debounce checks.

    Attributes:
        detection: The Detection bounding box at the time of last emission.
        features_key: A hashable snapshot of the features at last emission.
            ``None`` means features were absent at emission time.
    """

    detection: Detection
    features_key: Optional[tuple[object, ...]]


def _features_key(features: FeatureProfile | None) -> tuple[object, ...] | None:
    """Derive a hashable snapshot of a FeatureProfile for change detection.

    Two profiles are considered identical when they produce the same key.
    The key encodes both the dominant colors list and a tuple of the
    embedding floats (or ``None`` sentinels when fields are absent).

    Args:
        features: The FeatureProfile to snapshot, or ``None``.

    Returns:
        A hashable tuple suitable for equality comparison, or ``None`` if
        ``features`` itself is ``None``.
    """
    if features is None:
        return None

    colors_part: tuple[object, ...]
    if features.dominant_colors is None:
        colors_part = (None,)
    else:
        colors_part = tuple(tuple(c) for c in features.dominant_colors)

    embedding_part: tuple[object, ...]
    if features.embedding is None:
        embedding_part = (None,)
    else:
        embedding_part = tuple(features.embedding)

    return (colors_part, embedding_part)


def _compute_iou_detection(det_a: Detection, det_b: Detection) -> float:
    """Compute Intersection over Union between two Detection bounding boxes.

    Uses pixel-space coordinates directly from the Detection fields.
    Returns 0.0 when the boxes do not overlap.

    Args:
        det_a: First detection.
        det_b: Second detection.

    Returns:
        IoU value in [0.0, 1.0].
    """
    x_left = max(det_a.bbox_x_min, det_b.bbox_x_min)
    y_top = max(det_a.bbox_y_min, det_b.bbox_y_min)
    x_right = min(det_a.bbox_x_max, det_b.bbox_x_max)
    y_bottom = min(det_a.bbox_y_max, det_b.bbox_y_max)

    if x_right <= x_left or y_bottom <= y_top:
        return 0.0

    intersection = (x_right - x_left) * (y_bottom - y_top)
    area_a = (det_a.bbox_x_max - det_a.bbox_x_min) * (det_a.bbox_y_max - det_a.bbox_y_min)
    area_b = (det_b.bbox_x_max - det_b.bbox_x_min) * (det_b.bbox_y_max - det_b.bbox_y_min)
    union = area_a + area_b - intersection

    return intersection / union if union > 0.0 else 0.0


def _is_static(
    current: TrackedObject,
    record: _EmittedRecord,
    debounce_iou_threshold: float,
) -> bool:
    """Return True if the track has not changed enough to warrant re-emission.

    A track is considered static when BOTH conditions hold:
    - The IoU between the current and previously emitted bounding boxes
      exceeds ``debounce_iou_threshold``.
    - The feature key is identical (same dominant colors and embedding).

    Either condition being false means re-emission is warranted.

    Args:
        current: The current TrackedObject state.
        record: The _EmittedRecord from the last emission for this track.
        debounce_iou_threshold: IoU above which the position is "unchanged".

    Returns:
        True if the object should be debounced (not re-emitted).
    """
    iou = _compute_iou_detection(current.detection, record.detection)
    if iou <= debounce_iou_threshold:
        return False

    current_key = _features_key(current.features)
    return current_key == record.features_key


# ---------------------------------------------------------------------------
# ObservationBuilder
# ---------------------------------------------------------------------------


class ObservationBuilder:
    """Converts CONFIRMED TrackedObjects into Observations for Layer 3.

    Instantiate once per session and call :meth:`build` each processing
    cycle.  The builder maintains debounce state across calls so that a
    static object is not re-emitted every frame.

    Args:
        session_id: The Layer 3 session ID to embed in every Observation.
        source_id: Camera device identifier placed in the Provenance
            ``source_id`` field.  Defaults to ``"camera-0"``.
        debounce_iou_threshold: IoU threshold above which a track is
            considered "static" and will not be re-emitted (provided its
            features also have not changed).  A value of 1.0 means only
            exactly identical bounding boxes are debounced; 0.95 is the
            recommended production default which tolerates tiny jitter.
    """

    def __init__(
        self,
        session_id: str,
        source_id: str = "camera-0",
        debounce_iou_threshold: float = 0.95,
    ) -> None:
        if not session_id:
            raise ValueError("session_id must not be empty")
        if not source_id:
            raise ValueError("source_id must not be empty")
        if not (0.0 <= debounce_iou_threshold <= 1.0):
            raise ValueError(
                f"debounce_iou_threshold must be in [0.0, 1.0], got {debounce_iou_threshold}"
            )

        self._session_id = session_id
        self._source_id = source_id
        self._debounce_iou_threshold = debounce_iou_threshold

        # Map from TrackId to the last-emitted record for that track.
        self._emitted: dict[TrackId, _EmittedRecord] = {}

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def build(
        self,
        tracked_objects: list[TrackedObject],
        persistence_results: dict[TrackId, PersistenceResult],
        frame_width: int,
        frame_height: int,
    ) -> list[Observation]:
        """Build Observations from confirmed tracked objects.

        Processes each TrackedObject and produces at most one Observation
        per CONFIRMED track per call.  Tracks in other states (TENTATIVE,
        LOST, DELETED) are silently skipped.

        Debouncing suppresses re-emission for tracks whose bounding box and
        features have not changed beyond the configured thresholds.

        Args:
            tracked_objects: All active tracks from the current pipeline
                cycle (may include TENTATIVE, CONFIRMED, LOST, DELETED).
            persistence_results: Mapping of TrackId to the PersistenceResult
                returned by the persistence-check service.  A track may be
                absent from this mapping (e.g., if the check was not run).
            frame_width: Width of the current frame in pixels.  Used to
                normalise bounding box coordinates.
            frame_height: Height of the current frame in pixels.  Used to
                normalise bounding box coordinates.

        Returns:
            A list of :class:`~cobeing.shared.observation.Observation`
            instances, one for each CONFIRMED track that passed the
            debounce filter.  May be empty.

        Raises:
            ValueError: If ``frame_width`` or ``frame_height`` is not a
                positive integer.
        """
        if frame_width <= 0:
            raise ValueError(f"frame_width must be > 0, got {frame_width}")
        if frame_height <= 0:
            raise ValueError(f"frame_height must be > 0, got {frame_height}")

        observations: list[Observation] = []

        for track in tracked_objects:
            if track.state != TrackState.CONFIRMED:
                continue

            # --- Debounce check ---
            prior = self._emitted.get(track.track_id)
            if prior is not None and _is_static(track, prior, self._debounce_iou_threshold):
                continue

            # --- Build Observation ---
            obs = self._build_one(
                track=track,
                persistence_result=persistence_results.get(track.track_id),
                frame_width=frame_width,
                frame_height=frame_height,
            )
            observations.append(obs)

            # --- Update debounce record ---
            self._emitted[track.track_id] = _EmittedRecord(
                detection=track.detection,
                features_key=_features_key(track.features),
            )

        return observations

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _build_one(
        self,
        track: TrackedObject,
        persistence_result: PersistenceResult | None,
        frame_width: int,
        frame_height: int,
    ) -> Observation:
        """Construct a single Observation from a confirmed TrackedObject.

        Args:
            track: The confirmed TrackedObject to convert.
            persistence_result: The PersistenceResult for this track, or
                ``None`` if the persistence check was not performed.
            frame_width: Frame width in pixels (for bbox normalisation).
            frame_height: Frame height in pixels (for bbox normalisation).

        Returns:
            A fully populated, immutable Observation.
        """
        det = track.detection

        # Normalise bounding box coordinates to [0.0, 1.0].
        norm_x_min = det.bbox_x_min / frame_width
        norm_y_min = det.bbox_y_min / frame_height
        norm_x_max = det.bbox_x_max / frame_width
        norm_y_max = det.bbox_y_max / frame_height

        bbox = BoundingBox(
            x_min=norm_x_min,
            y_min=norm_y_min,
            x_max=norm_x_max,
            y_max=norm_y_max,
            frame_width=frame_width,
            frame_height=frame_height,
        )

        # Timestamp: use last_seen_at if available, otherwise fall back to now.
        timestamp: datetime
        if track.last_seen_at is not None:
            timestamp = track.last_seen_at
        else:
            timestamp = datetime.now(UTC)

        # Provenance: all sensor observations use SENSOR.
        provenance = Provenance(
            source=ProvenanceSource.SENSOR,
            source_id=self._source_id,
            confidence=det.confidence,
        )

        # Extract optional fields from FeatureProfile.
        embedding: list[float] | None = None
        dominant_colors: list[tuple[int, int, int]] | None = None
        if track.features is not None:
            embedding = track.features.embedding
            dominant_colors = track.features.dominant_colors

        # candidate_node_id comes from the persistence result matched_node_id.
        candidate_node_id: str | None = None
        if persistence_result is not None:
            candidate_node_id = persistence_result.matched_node_id

        return Observation(
            observation_id=str(uuid.uuid4()),
            session_id=self._session_id,
            label_raw=det.label_raw,
            confidence=det.confidence,
            bounding_box=bbox,
            embedding=embedding,
            dominant_colors=dominant_colors,
            timestamp=timestamp,
            provenance=provenance,
            candidate_node_id=candidate_node_id,
        )


__all__ = ["ObservationBuilder"]

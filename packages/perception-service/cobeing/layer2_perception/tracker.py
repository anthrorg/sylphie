"""IoU-based frame-to-frame object tracker with a SORT-style state machine.

This module provides :class:`IoUTracker`, which implements the
:class:`~cobeing.layer2_perception.protocols.ObjectTracker` protocol.
It associates per-frame :class:`~cobeing.layer2_perception.types.Detection`
objects with persistent :class:`~cobeing.layer2_perception.types.TrackedObject`
tracks using Intersection over Union (IoU) overlap as the association metric.

State Machine
-------------
Each track moves through four lifecycle states defined in
:class:`~cobeing.layer2_perception.types.TrackState`:

- **TENTATIVE** -- created on first detection.  Requires
  ``min_confirm_frames`` consecutive matches to advance.
- **CONFIRMED** -- stable, fully evidenced track.
- **LOST** -- no matching detection in the current frame; retained until
  the next match or until ``max_lost_frames`` is exceeded.
- **DELETED** -- exceeded ``max_lost_frames``.  Removed from the active
  set and never returned.

Assignment Algorithm
--------------------
A greedy, pure-Python assignment replaces scipy's Hungarian algorithm.
The cost matrix is IoU between every existing track's last detection and
every incoming detection.  The greedy loop picks the highest-IoU pair
repeatedly until no pair exceeds ``iou_threshold``, then handles
unmatched tracks and unmatched detections.

No external libraries beyond the standard library and the project's own
types are required.  OpenCV and numpy are intentionally absent.

Usage::

    from cobeing.layer2_perception.tracker import IoUTracker
    from cobeing.layer2_perception.types import TrackState

    tracker = IoUTracker(
        iou_threshold=0.3,
        min_confirm_frames=3,
        max_lost_frames=15,
    )

    # Per-frame update loop:
    for frame_id, detections in stream:
        tracks = tracker.update(detections, frame_id)
        confirmed = [t for t in tracks if t.state == TrackState.CONFIRMED]
"""

from __future__ import annotations

from datetime import UTC, datetime

from cobeing.layer2_perception.protocols import ObjectTracker
from cobeing.layer2_perception.types import (
    Detection,
    TrackId,
    TrackState,
    TrackedObject,
)


# ---------------------------------------------------------------------------
# IoU helper
# ---------------------------------------------------------------------------


def _compute_iou(det_a: Detection, det_b: Detection) -> float:
    """Compute Intersection over Union between two bounding boxes.

    Both bounding boxes are axis-aligned rectangles described by their
    min/max pixel coordinates stored in the :class:`Detection` fields
    ``bbox_x_min``, ``bbox_y_min``, ``bbox_x_max``, ``bbox_y_max``.

    Returns 0.0 when the boxes do not overlap at all.  Returns 1.0 when
    the boxes are identical (or nearly so within floating-point precision).

    Args:
        det_a: First detection bounding box.
        det_b: Second detection bounding box.

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

    return intersection / union if union > 0 else 0.0


# ---------------------------------------------------------------------------
# Greedy assignment
# ---------------------------------------------------------------------------


def _greedy_assign(
    tracks: list[TrackedObject],
    detections: list[Detection],
    iou_threshold: float,
) -> tuple[dict[int, int], set[int], set[int]]:
    """Greedily assign detections to tracks by highest IoU.

    Builds an IoU matrix (tracks x detections) and iteratively picks the
    highest-scoring (track, detection) pair above ``iou_threshold``,
    records the assignment, then removes both from the candidate pool.

    Args:
        tracks: Current active tracks (in any non-DELETED state).
        detections: New-frame detections to assign.
        iou_threshold: Minimum IoU for a valid assignment.

    Returns:
        A 3-tuple:
        - ``assignments``: ``{track_index: detection_index}`` mapping.
        - ``unmatched_tracks``: Indices into ``tracks`` that received no
          assignment.
        - ``unmatched_detections``: Indices into ``detections`` that were
          not assigned to any track.
    """
    if not tracks or not detections:
        return {}, set(range(len(tracks))), set(range(len(detections)))

    # Build full IoU matrix: rows = tracks, cols = detections.
    iou_matrix: list[list[float]] = [
        [_compute_iou(track.detection, det) for det in detections]
        for track in tracks
    ]

    available_tracks = set(range(len(tracks)))
    available_detections = set(range(len(detections)))
    assignments: dict[int, int] = {}

    while True:
        best_iou = iou_threshold  # must strictly exceed threshold to match
        best_t = -1
        best_d = -1

        for t_idx in available_tracks:
            for d_idx in available_detections:
                iou = iou_matrix[t_idx][d_idx]
                if iou > best_iou:
                    best_iou = iou
                    best_t = t_idx
                    best_d = d_idx

        if best_t == -1:
            # No remaining pair exceeds the threshold.
            break

        assignments[best_t] = best_d
        available_tracks.remove(best_t)
        available_detections.remove(best_d)

    return assignments, available_tracks, available_detections


# ---------------------------------------------------------------------------
# IoUTracker
# ---------------------------------------------------------------------------


class IoUTracker:
    """IoU-based frame-to-frame object tracker with state machine.

    Implements :class:`~cobeing.layer2_perception.protocols.ObjectTracker`.

    Track lifecycle::

        TENTATIVE -> CONFIRMED -> LOST -> DELETED

    - New detection: TENTATIVE, ``frames_seen = 1``.
    - TENTATIVE + matched: ``frames_seen``++; if ``frames_seen >=
      min_confirm_frames`` -> CONFIRMED.
    - CONFIRMED + unmatched: LOST, ``frames_lost = 1``.
    - LOST + matched: CONFIRMED, ``frames_lost = 0``.
    - LOST + unmatched: ``frames_lost``++; if ``frames_lost >=
      max_lost_frames`` -> DELETED (removed from active set).
    - TENTATIVE + unmatched: treated like CONFIRMED -> LOST for one frame;
      if it was only ever seen once it transitions to LOST immediately.

    Track IDs are monotonically increasing integers starting at 1, scoped
    to the tracker instance lifetime.

    Args:
        iou_threshold: Minimum IoU overlap required to associate a detection
            with an existing track.  Default 0.3.
        min_confirm_frames: Consecutive matched frames required to transition
            from TENTATIVE to CONFIRMED.  Default 3.
        max_lost_frames: Consecutive unmatched frames before a LOST track is
            promoted to DELETED and removed.  Default 15.
    """

    def __init__(
        self,
        iou_threshold: float = 0.3,
        min_confirm_frames: int = 3,
        max_lost_frames: int = 15,
    ) -> None:
        self._iou_threshold = iou_threshold
        self._min_confirm_frames = min_confirm_frames
        self._max_lost_frames = max_lost_frames

        # Active tracks (all non-DELETED states).
        self._tracks: list[TrackedObject] = []
        # Next track ID to assign.
        self._next_id: int = 1

    # ------------------------------------------------------------------
    # Public interface (ObjectTracker protocol)
    # ------------------------------------------------------------------

    def update(
        self,
        detections: list[Detection],
        frame_id: str,
    ) -> list[TrackedObject]:
        """Process detections for one frame and return all active tracks.

        Runs the full association cycle:

        1. Greedy IoU assignment between existing tracks and incoming
           detections.
        2. Apply state transitions for matched tracks (TENTATIVE promotion,
           LOST recovery).
        3. Apply state transitions for unmatched tracks (CONFIRMED -> LOST,
           LOST -> DELETED).
        4. Create new TENTATIVE tracks for unmatched detections.
        5. Purge DELETED tracks from the active set.
        6. Return the remaining active tracks.

        Args:
            detections: All detections produced for the current frame.
                May be an empty list.
            frame_id: The ``frame_id`` of the frame these detections came
                from.  Used to set :attr:`TrackedObject.last_seen_at` on
                matched tracks.

        Returns:
            All currently active tracks (TENTATIVE, CONFIRMED, LOST).
            DELETED tracks are excluded.
        """
        now = datetime.now(UTC)

        assignments, unmatched_track_indices, unmatched_detection_indices = (
            _greedy_assign(self._tracks, detections, self._iou_threshold)
        )

        updated: list[TrackedObject] = []

        # --- Process existing tracks ---
        for t_idx, track in enumerate(self._tracks):
            if t_idx in assignments:
                d_idx = assignments[t_idx]
                matched_detection = detections[d_idx]
                updated.append(
                    self._apply_match(track, matched_detection, now)
                )
            else:
                transitioned = self._apply_no_match(track)
                if transitioned.state != TrackState.DELETED:
                    updated.append(transitioned)

        # --- Create new TENTATIVE tracks for unmatched detections ---
        for d_idx in unmatched_detection_indices:
            new_track = TrackedObject(
                track_id=TrackId(self._next_id),
                state=TrackState.TENTATIVE,
                detection=detections[d_idx],
                frames_seen=1,
                frames_lost=0,
                first_seen_at=now,
                last_seen_at=now,
            )
            self._next_id += 1
            updated.append(new_track)

        self._tracks = updated
        return list(self._tracks)

    def get_active_track_count(self) -> int:
        """Return the number of currently active (non-DELETED) tracks.

        Provides a safe, public alternative to reading ``_tracks`` directly
        from outside the class. Because ``_tracks`` is reassigned atomically
        by :meth:`update`, this method is safe to call from the async event
        loop without a lock -- CPython's GIL makes list-attribute reads
        atomic at the bytecode level and ``update()`` has no await points.

        Returns:
            The count of active tracks (TENTATIVE, CONFIRMED, or LOST).
        """
        return len(self._tracks)

    # ------------------------------------------------------------------
    # State transition helpers
    # ------------------------------------------------------------------

    def _apply_match(
        self,
        track: TrackedObject,
        detection: Detection,
        now: datetime,
    ) -> TrackedObject:
        """Return a new TrackedObject reflecting a successful match.

        Handles all states:

        - TENTATIVE: increment ``frames_seen``; promote to CONFIRMED if
          threshold reached.
        - CONFIRMED: increment ``frames_seen``, retain CONFIRMED state.
        - LOST: recover back to CONFIRMED, reset ``frames_lost``.

        Args:
            track: The existing track being updated.
            detection: The detection that was associated with this track.
            now: UTC timestamp for ``last_seen_at``.

        Returns:
            A new, immutable :class:`TrackedObject` with updated fields.
        """
        new_frames_seen = track.frames_seen + 1

        if track.state == TrackState.TENTATIVE:
            if new_frames_seen >= self._min_confirm_frames:
                new_state = TrackState.CONFIRMED
            else:
                new_state = TrackState.TENTATIVE
        elif track.state == TrackState.LOST:
            new_state = TrackState.CONFIRMED
        else:
            # CONFIRMED stays CONFIRMED.
            new_state = TrackState.CONFIRMED

        return TrackedObject(
            track_id=track.track_id,
            state=new_state,
            detection=detection,
            features=track.features,
            frames_seen=new_frames_seen,
            frames_lost=0,
            first_seen_at=track.first_seen_at,
            last_seen_at=now,
        )

    def _apply_no_match(self, track: TrackedObject) -> TrackedObject:
        """Return a new TrackedObject reflecting a missed match this frame.

        Handles all states:

        - TENTATIVE: transitions to LOST, ``frames_lost = 1``.
        - CONFIRMED: transitions to LOST, ``frames_lost = 1``.
        - LOST: increments ``frames_lost``; transitions to DELETED when
          ``frames_lost >= max_lost_frames``.

        Args:
            track: The existing track that received no detection this frame.

        Returns:
            A new, immutable :class:`TrackedObject` with updated state.
            May be DELETED -- the caller is responsible for filtering these
            out of the active set.
        """
        new_frames_lost = track.frames_lost + 1

        if track.state in (TrackState.TENTATIVE, TrackState.CONFIRMED):
            new_state = TrackState.LOST
        else:
            # Already LOST -- check whether we exceeded the budget.
            if new_frames_lost >= self._max_lost_frames:
                new_state = TrackState.DELETED
            else:
                new_state = TrackState.LOST

        return TrackedObject(
            track_id=track.track_id,
            state=new_state,
            detection=track.detection,
            features=track.features,
            frames_seen=track.frames_seen,
            frames_lost=new_frames_lost,
            first_seen_at=track.first_seen_at,
            last_seen_at=track.last_seen_at,
        )


__all__ = ["IoUTracker"]

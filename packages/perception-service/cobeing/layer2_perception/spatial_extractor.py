"""Spatial relationship extractor -- geometry-based predicates between tracked objects.

This module provides :class:`SpatialRelationshipExtractor`, which computes
spatial relationships between simultaneously detected objects.  It operates
on the bounding boxes of :class:`~cobeing.layer2_perception.types.TrackedObject`
instances from the same frame and emits :class:`SpatialRelation` dataclasses
describing how objects relate in image space.

Per Luria: this is the "dorsal stream" (where pathway), processed separately
from identity features (the "ventral stream").  The extractor has no knowledge
of object identity or category -- it only knows positions and sizes.

Provenance
----------
All relationships produced by this module are INFERENCE: they are computed
from SENSOR observations (bounding boxes) but are not directly observed.
The caller is responsible for attaching the appropriate provenance when
writing relationships to Layer 3.

Predicates
----------
Six predicates are extracted from normalized bounding box geometry:

- **left_of** / **right_of**: A is to the left/right of B by more than
  ``position_margin`` in normalised x-coordinate.
- **above** / **below**: A is above/below B by more than ``position_margin``
  in normalised y-coordinate (y increases downward).
- **near**: Euclidean centroid distance is less than ``near_threshold``.
- **on_top_of**: A's bottom edge overlaps B's top half AND A is smaller
  than B (area proxy for "A is resting on B's surface").

Only **CONFIRMED** tracked objects are considered.  TENTATIVE, LOST, and
DELETED tracks are silently filtered out before any pair-wise computation.

No depth estimation
-------------------
This module does not fabricate depth values.  Monocular cameras provide no
reliable depth signal.  Bounding-box area is used as a rough size proxy for
the ``on_top_of`` check, but no ``distance_estimate`` fields or world-space
coordinates are emitted.  Per CANON A.13 ultrasonic sensors are deferred to
Phase 2.

Usage::

    from cobeing.layer2_perception.spatial_extractor import (
        SpatialRelationshipExtractor,
        SpatialRelation,
    )

    extractor = SpatialRelationshipExtractor(
        near_threshold=0.15,
        position_margin=0.05,
    )

    relations = extractor.extract(
        tracked_objects=confirmed_tracks,
        frame_width=640,
        frame_height=480,
    )

    for rel in relations:
        print(rel.subject_track_id, rel.predicate, rel.object_track_id,
              f"conf={rel.confidence:.2f}")
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from cobeing.layer2_perception.types import TrackId, TrackState, TrackedObject


# ---------------------------------------------------------------------------
# Output type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SpatialRelation:
    """An extracted spatial relationship between two tracked objects.

    Instances are immutable value objects.  The relationship is directional:
    ``subject_track_id`` is "A" and ``object_track_id`` is "B" in the
    sentence "A is <predicate> B".

    Provenance of all SpatialRelation values is INFERENCE (computed from
    SENSOR observations).  The caller attaches full Provenance metadata when
    writing to Layer 3.

    Attributes:
        subject_track_id: The track that is the subject of the predicate
            (e.g., the smaller object that is "on top of").
        predicate: One of ``"left_of"``, ``"right_of"``, ``"above"``,
            ``"below"``, ``"near"``, ``"on_top_of"``.
        object_track_id: The track that is the object of the predicate.
        confidence: Geometric confidence in [0.0, 1.0].  See each
            predicate's formula for how confidence is derived.
    """

    subject_track_id: TrackId
    predicate: str
    object_track_id: TrackId
    confidence: float


# ---------------------------------------------------------------------------
# Internal normalised bbox helper
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _NormBBox:
    """Normalised bounding box in the [0.0, 1.0] coordinate space.

    Attributes:
        x_min: Left edge (normalised).
        y_min: Top edge (normalised, y increases downward).
        x_max: Right edge (normalised).
        y_max: Bottom edge (normalised).
    """

    x_min: float
    y_min: float
    x_max: float
    y_max: float

    @property
    def width(self) -> float:
        """Normalised width."""
        return self.x_max - self.x_min

    @property
    def height(self) -> float:
        """Normalised height."""
        return self.y_max - self.y_min

    @property
    def area(self) -> float:
        """Normalised area (width * height)."""
        return self.width * self.height

    @property
    def center_x(self) -> float:
        """Normalised horizontal centroid."""
        return (self.x_min + self.x_max) / 2.0

    @property
    def center_y(self) -> float:
        """Normalised vertical centroid."""
        return (self.y_min + self.y_max) / 2.0


def _normalise(obj: TrackedObject, frame_width: int, frame_height: int) -> _NormBBox:
    """Convert a TrackedObject's pixel-space bbox to normalised coordinates.

    Args:
        obj: The tracked object carrying pixel-space detection coordinates.
        frame_width: Frame width in pixels (positive).
        frame_height: Frame height in pixels (positive).

    Returns:
        A :class:`_NormBBox` with all coordinates in [0.0, 1.0].
    """
    det = obj.detection
    return _NormBBox(
        x_min=det.bbox_x_min / frame_width,
        y_min=det.bbox_y_min / frame_height,
        x_max=det.bbox_x_max / frame_width,
        y_max=det.bbox_y_max / frame_height,
    )


# ---------------------------------------------------------------------------
# SpatialRelationshipExtractor
# ---------------------------------------------------------------------------


class SpatialRelationshipExtractor:
    """Extracts geometry-based spatial predicates between confirmed objects.

    Takes a list of :class:`~cobeing.layer2_perception.types.TrackedObject`
    instances from the same frame, filters to CONFIRMED tracks only, and
    processes all ordered pairs (A, B) where A != B to produce
    :class:`SpatialRelation` instances.

    All computations use normalised [0.0, 1.0] coordinates derived by
    dividing pixel coordinates by ``frame_width`` and ``frame_height``.
    This makes the thresholds resolution-independent.

    Confidence formulas
    -------------------
    * **left_of / right_of / above / below**: confidence scales linearly
      from 0.0 at the margin threshold up to 1.0 at three times the margin.
      ``min(1.0, abs(delta) / (position_margin * 3))``.
    * **near**: confidence is ``1.0 - (dist / near_threshold)``.  Objects
      at zero distance produce confidence 1.0; objects at exactly the
      threshold produce confidence 0.0 (excluded before reaching the emit
      step because the check is ``dist < near_threshold``).
    * **on_top_of**: confidence is proportional to how well A sits on B.
      It is ``min(1.0, 1.0 - (A.y_max - B.y_min) / (B.height * 0.5))``,
      clamped to [0.0, 1.0].  The deeper into B's top half A's bottom edge
      reaches, the lower the confidence.  An area-difference bonus is also
      applied: ``min(1.0, 1.0 - (area_A / area_B))`` averaged with the
      positional term.

    Args:
        near_threshold: Normalised Euclidean centroid distance below which
            two objects are considered "near".  Default 0.15.
        position_margin: Minimum normalised centre-coordinate difference
            required to emit a directional predicate (left_of, right_of,
            above, below).  Default 0.05.

    Raises:
        ValueError: If ``near_threshold`` or ``position_margin`` is not a
            positive float less than or equal to 1.0.
    """

    def __init__(
        self,
        near_threshold: float = 0.15,
        position_margin: float = 0.05,
    ) -> None:
        if not (0.0 < near_threshold <= 1.0):
            raise ValueError(
                f"near_threshold must be in (0.0, 1.0], got {near_threshold}"
            )
        if not (0.0 < position_margin <= 1.0):
            raise ValueError(
                f"position_margin must be in (0.0, 1.0], got {position_margin}"
            )

        self._near_threshold = near_threshold
        self._position_margin = position_margin

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def extract(
        self,
        tracked_objects: list[TrackedObject],
        frame_width: int,
        frame_height: int,
    ) -> list[SpatialRelation]:
        """Extract spatial relationships between CONFIRMED tracked objects.

        Only CONFIRMED tracks are considered.  All other states (TENTATIVE,
        LOST, DELETED) are filtered out before any pair computation.

        Processes all ordered pairs (A, B) where A != B.  A pair (A, B) and
        the reverse pair (B, A) are both processed, so e.g. if A is left of B
        then B is right of A -- both predicates are emitted.

        Bounding box coordinates are normalised by dividing by
        ``frame_width`` / ``frame_height`` before all predicate computation.

        Args:
            tracked_objects: All active tracks from the current pipeline
                cycle.  May include any TrackState mix.
            frame_width: Width of the source frame in pixels.  Must be
                positive.
            frame_height: Height of the source frame in pixels.  Must be
                positive.

        Returns:
            A list of :class:`SpatialRelation` instances.  May be empty
            (e.g., fewer than two CONFIRMED tracks).

        Raises:
            ValueError: If ``frame_width`` or ``frame_height`` is not a
                positive integer.
        """
        if frame_width <= 0:
            raise ValueError(f"frame_width must be > 0, got {frame_width}")
        if frame_height <= 0:
            raise ValueError(f"frame_height must be > 0, got {frame_height}")

        # Filter to CONFIRMED tracks only.
        confirmed = [
            obj for obj in tracked_objects if obj.state == TrackState.CONFIRMED
        ]

        if len(confirmed) < 2:
            return []

        # Precompute normalised bboxes to avoid redundant division.
        norm_bboxes: dict[TrackId, _NormBBox] = {
            obj.track_id: _normalise(obj, frame_width, frame_height)
            for obj in confirmed
        }

        relations: list[SpatialRelation] = []

        # Process every ordered pair (A, B) where A != B.
        for i, obj_a in enumerate(confirmed):
            for j, obj_b in enumerate(confirmed):
                if i == j:
                    continue

                tid_a = obj_a.track_id
                tid_b = obj_b.track_id
                bbox_a = norm_bboxes[tid_a]
                bbox_b = norm_bboxes[tid_b]

                pair_relations = self._compute_pair(
                    tid_a, bbox_a, tid_b, bbox_b
                )
                relations.extend(pair_relations)

        return relations

    # ------------------------------------------------------------------
    # Predicate computation for a single (A, B) ordered pair
    # ------------------------------------------------------------------

    def _compute_pair(
        self,
        tid_a: TrackId,
        bbox_a: _NormBBox,
        tid_b: TrackId,
        bbox_b: _NormBBox,
    ) -> list[SpatialRelation]:
        """Compute all spatial predicates for ordered pair (A, B).

        Called with (A, B); the caller separately calls with (B, A) so
        inverse predicates are produced without any special casing here.

        Args:
            tid_a: Track ID of object A (subject).
            bbox_a: Normalised bounding box of A.
            tid_b: Track ID of object B (object).
            bbox_b: Normalised bounding box of B.

        Returns:
            Zero or more SpatialRelation instances for this pair.
        """
        relations: list[SpatialRelation] = []

        dx = bbox_b.center_x - bbox_a.center_x  # positive => B is right of A
        dy = bbox_b.center_y - bbox_a.center_y  # positive => B is below A
        dist = math.sqrt(dx * dx + dy * dy)

        margin = self._position_margin
        # Confidence formula for directional predicates.
        # Scales linearly from 0 at the margin to 1.0 at 3 * margin.
        # Result is clamped to [0.0, 1.0].
        def _dir_conf(delta: float) -> float:
            return min(1.0, abs(delta) / (margin * 3.0))

        # --- left_of: A's centre is meaningfully to the left of B's ---
        # dx > margin means B is to the right, i.e. A is to the left of B.
        if dx > margin:
            relations.append(
                SpatialRelation(
                    subject_track_id=tid_a,
                    predicate="left_of",
                    object_track_id=tid_b,
                    confidence=_dir_conf(dx),
                )
            )

        # --- right_of: A's centre is meaningfully to the right of B's ---
        # dx < -margin means B is to the left, i.e. A is to the right of B.
        if dx < -margin:
            relations.append(
                SpatialRelation(
                    subject_track_id=tid_a,
                    predicate="right_of",
                    object_track_id=tid_b,
                    confidence=_dir_conf(dx),
                )
            )

        # --- above: A's centre is meaningfully above B's ---
        # dy > margin means B is below A (y increases downward), i.e. A is above B.
        if dy > margin:
            relations.append(
                SpatialRelation(
                    subject_track_id=tid_a,
                    predicate="above",
                    object_track_id=tid_b,
                    confidence=_dir_conf(dy),
                )
            )

        # --- below: A's centre is meaningfully below B's ---
        # dy < -margin means B is above A (y increases downward), i.e. A is below B.
        if dy < -margin:
            relations.append(
                SpatialRelation(
                    subject_track_id=tid_a,
                    predicate="below",
                    object_track_id=tid_b,
                    confidence=_dir_conf(dy),
                )
            )

        # --- near: centroids are close ---
        if dist < self._near_threshold:
            near_conf = 1.0 - (dist / self._near_threshold)
            relations.append(
                SpatialRelation(
                    subject_track_id=tid_a,
                    predicate="near",
                    object_track_id=tid_b,
                    confidence=near_conf,
                )
            )

        # --- on_top_of: A sits on top of B ---
        # Conditions:
        # 1. A's bottom edge is within B's top half (y_min <= A.y_max <= y_min + height/2).
        # 2. A is smaller than B (area proxy).
        # We are in the (A, B) pair so we check if A is on top of B.
        on_top_relation = self._check_on_top_of(tid_a, bbox_a, tid_b, bbox_b)
        if on_top_relation is not None:
            relations.append(on_top_relation)

        return relations

    def _check_on_top_of(
        self,
        tid_a: TrackId,
        bbox_a: _NormBBox,
        tid_b: TrackId,
        bbox_b: _NormBBox,
    ) -> SpatialRelation | None:
        """Check if A is resting on top of B.

        Criteria (all must hold):
        - A's bottom edge falls at or after B's top edge (they touch or overlap).
        - A's bottom edge does not exceed the midpoint of B's bounding box
          (A is in B's upper half, not sunken into it).
        - A's area is strictly less than B's area (A is smaller -- the support
          surface should be larger than the object it supports).

        Confidence combines a positional term (how well A's bottom edge aligns
        with B's top surface) and an area-ratio term (how much smaller A is):

        .. code-block::

            pos_conf  = 1.0 - overlap_fraction  # 1.0 = just touching, 0.0 = at midpoint
            area_conf = 1.0 - (area_A / area_B)  # 1.0 = A infinitely small vs B
            confidence = (pos_conf + area_conf) / 2.0

        Args:
            tid_a: Track ID of object A (candidate subject -- "sits on").
            bbox_a: Normalised bounding box of A.
            tid_b: Track ID of object B (candidate object -- "support surface").
            bbox_b: Normalised bounding box of B.

        Returns:
            A :class:`SpatialRelation` with predicate ``"on_top_of"``, or
            ``None`` if the geometric conditions are not met.
        """
        area_a = bbox_a.area
        area_b = bbox_b.area

        # Guard: if B has zero area (degenerate bbox) avoid division.
        if area_b <= 0.0:
            return None

        # Condition 1: A's bottom edge is at or overlapping B's top edge.
        if bbox_a.y_max < bbox_b.y_min:
            # A is entirely above B -- no overlap at all.
            return None

        # Condition 2: A's bottom edge must be at most at the midpoint of B.
        b_midpoint_y = bbox_b.y_min + bbox_b.height * 0.5
        if bbox_a.y_max > b_midpoint_y:
            # A sinks too deep into B -- not a "resting on top" relationship.
            return None

        # Condition 3: A must be smaller than B.
        if area_a >= area_b:
            return None

        # Compute confidence.
        # How far has A's bottom edge penetrated into B's top half?
        # 0.0 = just touching (y_max == y_min), 1.0 = at midpoint (excluded by cond 2).
        b_top_half_height = bbox_b.height * 0.5
        if b_top_half_height <= 0.0:
            # B is degenerate in height -- cannot establish top-half geometry.
            return None

        overlap_depth = bbox_a.y_max - bbox_b.y_min
        # overlap_depth is in [0, b_top_half_height) due to the checks above.
        # Normalise to [0, 1).
        overlap_fraction = overlap_depth / b_top_half_height

        # pos_conf: 1.0 when just touching, decreasing as A sinks in.
        pos_conf = max(0.0, 1.0 - overlap_fraction)

        # area_conf: how much smaller is A relative to B?
        area_conf = max(0.0, 1.0 - (area_a / area_b))

        confidence = (pos_conf + area_conf) / 2.0
        confidence = min(1.0, max(0.0, confidence))

        return SpatialRelation(
            subject_track_id=tid_a,
            predicate="on_top_of",
            object_track_id=tid_b,
            confidence=confidence,
        )


__all__ = ["SpatialRelation", "SpatialRelationshipExtractor"]

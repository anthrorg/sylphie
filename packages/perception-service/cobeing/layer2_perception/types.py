"""Core domain types for the Layer 2 perception pipeline.

This module defines the data structures that flow through the perception
pipeline: captured frames, individual detections from the YOLO model,
tracked objects across frames, and the result of querying Layer 3 for
a matching persisted object.

These types are the communication contract between perception sub-components.
They carry no dependency on OpenCV, numpy, or any CV library -- raw frame
data is ``bytes`` (JPEG-encoded or raw pixel bytes), not a numpy array.
This keeps imports fast and allows the types to be used in tests without
any CV installation.

Key types:

- :class:`TrackState` -- lifecycle states for a tracked object.
- :class:`TrackId` -- type-safe integer identifier for a track.
- :class:`Frame` -- a single captured image frame, immutable.
- :class:`Detection` -- one YOLO detection result within a frame.
- :class:`FeatureProfile` -- visual features used for identity matching.
- :class:`TrackedObject` -- an object being tracked across multiple frames.
- :class:`PersistenceResult` -- Layer 3 match result for a tracked object.

Usage::

    from cobeing.layer2_perception.types import (
        TrackState, TrackId,
        Frame, Detection, FeatureProfile, TrackedObject, PersistenceResult,
    )

    frame = Frame(
        frame_id="frame-0001",
        frame_sequence=1,
        observed_at=datetime.now(UTC),
        width=1280,
        height=720,
        data=b"...",
        session_id="session-abc",
    )

    detection = Detection(
        label_raw="cup",
        confidence=0.87,
        bbox_x_min=120.0,
        bbox_y_min=80.0,
        bbox_x_max=240.0,
        bbox_y_max=200.0,
        frame_id=frame.frame_id,
    )
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import NewType

from pydantic import BaseModel, ConfigDict, Field


class TrackState(StrEnum):
    """Lifecycle states for a tracked object (SORT-style state machine).

    A track begins as TENTATIVE on first detection. It advances to CONFIRMED
    once it has been matched across a minimum number of consecutive frames
    (configured by ``TrackingConfig.min_confirm_frames``). A track becomes
    LOST when frames elapse without a match; it is promoted to DELETED once
    the lost-frame threshold is exceeded and cleaned from active tracking.

    Attributes:
        TENTATIVE: Newly created track awaiting confirmation. Not yet
            propagated to Layer 3. Requires ``min_confirm_frames``
            consecutive matches to advance.
        CONFIRMED: Stable track with sufficient evidence. Eligible for
            Layer 3 persistence checks and observation ingestion.
        LOST: The tracked object has not been matched for one or more
            frames but has not yet exceeded ``max_lost_frames``. The
            track is retained in case the object reappears.
        DELETED: The track exceeded ``max_lost_frames`` without recovery.
            Marked for removal from the active tracking set.
    """

    TENTATIVE = "tentative"
    CONFIRMED = "confirmed"
    LOST = "lost"
    DELETED = "deleted"


TrackId = NewType("TrackId", int)
"""Type-safe integer identifier for a tracked object.

``NewType`` creates a distinct type at type-check time so that a raw ``int``
cannot be accidentally passed where a ``TrackId`` is expected. At runtime it
is still an ``int``.

Example::

    track_id = TrackId(42)
"""


class Frame(BaseModel):
    """A single captured image frame from the camera source.

    Frames are immutable value objects. Once a frame is captured and
    constructed, nothing modifies it -- the capture pipeline hands it
    downstream and the original is not mutated.

    ``data`` is raw frame bytes (JPEG-encoded or uncompressed pixel data).
    It is intentionally ``bytes`` rather than a numpy array so that this
    type can be imported and used without any OpenCV or numpy installation.
    The CV layer converts to/from numpy arrays internally and never stores
    the numpy representation in this model.

    Attributes:
        frame_id: Unique string identifier for this frame. Typically a
            UUID or a prefixed sequence number.
        frame_sequence: Monotonically increasing integer counter within
            a session. Allows downstream consumers to detect dropped frames.
        observed_at: UTC timestamp at the moment of capture. Timezone-aware.
        width: Frame width in pixels.
        height: Frame height in pixels.
        data: Raw frame bytes. May be JPEG-compressed or uncompressed pixel
            data depending on the camera source implementation.
        session_id: Identifier of the ObservationSession (CANON A.10) during
            which this frame was captured. Ties frames to the Layer 3
            session node for temporal queries.
    """

    model_config = ConfigDict(frozen=True)

    frame_id: str = Field(min_length=1)
    frame_sequence: int = Field(ge=0)
    observed_at: datetime
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    data: bytes
    session_id: str = Field(min_length=1)


class Detection(BaseModel):
    """A single object detection produced by the YOLO detector.

    One ``Detection`` corresponds to one bounding box returned by the
    detection model for a single frame. Multiple detections may be
    produced for the same frame.

    Bounding box coordinates are in pixel space relative to the top-left
    corner of the frame. The coordinate system is:
    - ``x`` increases left to right.
    - ``y`` increases top to bottom.

    Attributes:
        label_raw: The raw string label returned by YOLO (e.g., ``"cup"``,
            ``"person"``). Not normalized or mapped -- that is done in
            Layer 3 during schema lookup.
        confidence: YOLO's detection confidence score, in [0.0, 1.0].
        bbox_x_min: Left edge of the bounding box in pixels.
        bbox_y_min: Top edge of the bounding box in pixels.
        bbox_x_max: Right edge of the bounding box in pixels.
        bbox_y_max: Bottom edge of the bounding box in pixels.
        frame_id: The ``frame_id`` of the :class:`Frame` this detection
            was produced from. Ties the detection back to provenance.
    """

    model_config = ConfigDict(frozen=True)

    label_raw: str = Field(min_length=1)
    confidence: float = Field(ge=0.0, le=1.0)
    bbox_x_min: float
    bbox_y_min: float
    bbox_x_max: float
    bbox_y_max: float
    frame_id: str = Field(min_length=1)


class FeatureProfile(BaseModel):
    """Extracted visual features used for cross-frame identity matching.

    A ``FeatureProfile`` is computed from the cropped bounding-box region
    of a detection and stored with the tracked object. When Layer 3 is
    queried for a matching persisted node (CANON A.5 narrow interface),
    the profile is compared against stored profiles to establish identity.

    Both fields are optional because feature extraction may not succeed
    (e.g., the bounding box is too small, the crop is blurry), and a
    tracked object can still be managed with spatial-only matching when
    the profile is absent.

    Attributes:
        dominant_colors: A list of the most prominent colors in the
            detection crop, each as an ``(R, G, B)`` tuple with values
            in [0, 255]. Typically 3-5 colors. ``None`` if color
            extraction was not performed or failed.
        embedding: Feature vector from EfficientNet-B0 (CANON tech stack).
            A list of floats representing the visual embedding of the
            detection crop. ``None`` if embedding extraction was not
            performed or failed.
    """

    model_config = ConfigDict(frozen=True)

    dominant_colors: list[tuple[int, int, int]] | None = None
    embedding: list[float] | None = None


class TrackedObject(BaseModel):
    """An object being tracked across multiple frames.

    A ``TrackedObject`` is the perception layer's persistent unit of
    identity within a session. It bridges individual per-frame detections
    into a coherent object-over-time representation that can be matched
    against the knowledge graph.

    Tracked objects are **immutable** (frozen). State transitions (e.g.,
    TENTATIVE -> CONFIRMED) produce new ``TrackedObject`` instances rather
    than mutating the existing one. This makes state transitions explicit
    and prevents accidental mutation during pipeline processing.

    Attributes:
        track_id: Unique integer identifier for this track within the
            current session. Assigned by the tracker on first detection.
        state: Current lifecycle state (see :class:`TrackState`).
        detection: The most recent ``Detection`` matched to this track.
            Updated each frame the object is matched.
        features: Visual feature profile for identity matching. May be
            ``None`` if feature extraction has not yet been performed or
            if extraction failed for all matched frames.
        frames_seen: Total number of frames in which this track was
            successfully matched to a detection. Incremented each match.
        frames_lost: Number of consecutive frames in which no detection
            was matched. Reset to 0 on recovery. When this exceeds
            ``TrackingConfig.max_lost_frames`` the state becomes DELETED.
        first_seen_at: UTC timestamp of the first frame this track was
            matched. Set once on track creation. ``None`` only transiently
            before the first match is recorded.
        last_seen_at: UTC timestamp of the most recent frame in which
            this track was matched. Updated each match. ``None`` only
            transiently before the first match.
    """

    model_config = ConfigDict(frozen=True)

    track_id: TrackId
    state: TrackState
    detection: Detection
    features: FeatureProfile | None = None
    frames_seen: int = Field(default=0, ge=0)
    frames_lost: int = Field(default=0, ge=0)
    first_seen_at: datetime | None = None
    last_seen_at: datetime | None = None


class FaceDetection(BaseModel):
    """A single face detection produced by the MediaPipe face detector.

    One ``FaceDetection`` corresponds to one face bounding box returned by
    MediaPipe for a single frame. Multiple face detections may be produced
    for the same frame.

    Bounding box coordinates are in pixel space relative to the top-left
    corner of the frame, matching the ``Detection`` coordinate system.

    Attributes:
        confidence: MediaPipe detection confidence score, in [0.0, 1.0].
        bbox_x_min: Left edge of the bounding box in pixels.
        bbox_y_min: Top edge of the bounding box in pixels.
        bbox_x_max: Right edge of the bounding box in pixels.
        bbox_y_max: Bottom edge of the bounding box in pixels.
        landmarks: MediaPipe returns 6 keypoints (right eye, left eye,
            nose tip, mouth center, right ear, left ear) as ``(x, y)``
            pixel coordinates. ``None`` if landmark extraction failed.
        frame_id: The ``frame_id`` of the :class:`Frame` this detection
            was produced from.
    """

    model_config = ConfigDict(frozen=True)

    confidence: float = Field(ge=0.0, le=1.0)
    bbox_x_min: float
    bbox_y_min: float
    bbox_x_max: float
    bbox_y_max: float
    landmarks: list[tuple[float, float]] | None = None
    frame_id: str = Field(min_length=1)


class PersistenceResult(BaseModel):
    """Result of querying Layer 3 for an object matching a tracked detection.

    This type represents the response from the narrow Layer 2 -> Layer 3
    persistence-check interface (CANON A.5). Layer 2 passes a detection and
    feature profile; Layer 3 returns whether a matching node was found, the
    match strategy used, and any ambiguous candidates.

    The ``surprise_flag`` implements the Piaget R2 novelty signal: when the
    matched object does not match what was spatially predicted (or no match
    is found in a location where one was expected), the flag is set so that
    the observation ingestion path can mark the resulting graph node with
    elevated novelty.

    Attributes:
        matched_node_id: The Layer 3 ``NodeId`` of the matched
            ``ObjectInstance`` node, if a match was found. ``None`` means
            no existing node met the threshold and a new node should be
            created.
        confidence: Confidence in the match, in [0.0, 1.0]. 0.0 when
            ``matched_node_id`` is ``None`` (no match).
        match_type: Strategy that produced the match. One of:
            ``"embedding"`` (visual feature similarity),
            ``"spatial"`` (bounding-box location proximity),
            ``"label"`` (label string + recent history),
            ``"none"`` (no match found).
        surprise_flag: ``True`` when the detection does not match spatial
            or type predictions from the previous observation of this
            location (Piaget R2 novelty signal). ``False`` for routine
            re-identification of expected objects.
        ambiguous_candidates: ``NodeId`` values of other Layer 3 nodes
            that scored above the ambiguity threshold but below the match
            threshold. A non-empty list signals that the identity decision
            was uncertain and the guardian may be queried to clarify.
    """

    model_config = ConfigDict(frozen=True)

    matched_node_id: str | None = None
    confidence: float = Field(ge=0.0, le=1.0, default=0.0)
    match_type: str = Field(default="none")
    surprise_flag: bool = False
    ambiguous_candidates: list[str] = Field(default_factory=list)


__all__ = [
    "Detection",
    "FaceDetection",
    "FeatureProfile",
    "Frame",
    "PersistenceResult",
    "TrackId",
    "TrackState",
    "TrackedObject",
]

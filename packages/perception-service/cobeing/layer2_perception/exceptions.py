"""Layer 2 perception pipeline exceptions.

Every exception in this module inherits from ``PerceptionError``, which
itself inherits from ``CoBeingError``. This allows callers to catch at the
granularity they need:

- ``CoBeingError`` catches everything application-level.
- ``PerceptionError`` catches any Layer 2 failure.
- A specific subclass (e.g., ``CaptureError``) catches one failure mode.

The hierarchy mirrors the perception pipeline stages:

1. **CaptureError** -- camera device, frame acquisition.
2. **DetectionError** -- YOLO model, inference failures.
3. **TrackingError** -- multi-object tracker, state machine errors.
4. **PersistenceCheckError** -- Layer 3 query failures via the A.5 interface.

Usage::

    from cobeing.layer2_perception.exceptions import (
        CaptureError,
        DetectionError,
    )

    try:
        frame = await camera.capture()
    except CaptureError as exc:
        logger.error("camera_capture_failed", detail=str(exc))
        raise
"""

from __future__ import annotations

from cobeing.shared.exceptions import CoBeingError


class PerceptionError(CoBeingError):
    """Base exception for all Layer 2 (perception pipeline) errors.

    All perception-specific exceptions inherit from this. Catching
    ``PerceptionError`` catches any Layer 2 failure without catching
    errors from other layers.
    """


class CaptureError(PerceptionError):
    """Raised when the camera source fails to produce a frame.

    This covers device-level failures:

    - The camera device is not present or not accessible.
    - The device was connected but has since been unplugged.
    - ``VideoCapture.read()`` returned ``False`` (no frame available).
    - The frame buffer overflowed and the capture thread fell behind.

    Note that a single dropped frame is not a ``CaptureError`` -- it is
    handled silently by the frame buffer. ``CaptureError`` signals that
    the capture source itself is unavailable and operation cannot continue
    without intervention.
    """


class DetectionError(PerceptionError):
    """Raised when the object detection model fails to produce results.

    This covers model-level failures:

    - The YOLO model file cannot be loaded or is corrupted.
    - The model produces malformed output that cannot be parsed.
    - An underlying runtime error (e.g., ONNX Runtime crash) occurs
      during inference.

    Low confidence or zero detections on a valid frame are **not** a
    ``DetectionError`` -- they are legitimate model outputs. ``DetectionError``
    signals that the detection pipeline itself has failed structurally.
    """


class TrackingError(PerceptionError):
    """Raised when the multi-object tracker enters an invalid state.

    This covers tracker-level failures:

    - The IOU matrix computation fails due to malformed bounding boxes.
    - A track state transition is attempted that violates the
      :class:`~cobeing.layer2_perception.types.TrackState` state machine.
    - The tracker's internal state becomes inconsistent (e.g., duplicate
      track IDs, orphaned tracks referencing non-existent detections).

    Routine state transitions (TENTATIVE -> CONFIRMED -> LOST -> DELETED)
    are not errors. ``TrackingError`` signals structural failures in the
    tracker itself, not normal track lifecycle events.
    """


class PersistenceCheckError(PerceptionError):
    """Raised when the Layer 3 persistence-check query fails.

    This covers failures in the narrow Layer 2 -> Layer 3 read interface
    defined by CANON A.5. The interface allows Layer 2 to ask "have I seen
    this object before?" and is the only Layer 3 read path available to
    Layer 2.

    Failure modes:

    - Layer 3 is unavailable (graph database down, not yet initialized).
    - The query times out.
    - The response is malformed and cannot be deserialized.

    A ``PersistenceCheckError`` is recoverable: the perception pipeline
    can treat the failed check as a cache miss (no match found) and
    continue processing. The error should be logged at WARNING level and
    the observation processed as novel.
    """


__all__ = [
    "CaptureError",
    "DetectionError",
    "PerceptionError",
    "PersistenceCheckError",
    "TrackingError",
]

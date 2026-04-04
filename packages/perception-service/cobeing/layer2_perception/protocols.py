"""Protocol contracts for Layer 2 perception components.

This module defines the four structural interfaces that the perception
pipeline uses to communicate between its own sub-components and across
the Layer 2 / Layer 3 boundary.

All four protocols are ``@runtime_checkable``, meaning ``isinstance()``
checks work at runtime (e.g., during dependency injection validation in
tests and at the composition root). Type-checker structural subtyping is
also enforced for callers that use mypy/pyright.

Protocols defined here:

- :class:`FrameSource` -- async context manager that produces camera frames.
- :class:`ObjectDetector` -- synchronous CPU-bound YOLO detection interface.
- :class:`ObjectTracker` -- synchronous CPU-bound SORT-style tracking interface.
- :class:`PersistenceCheck` -- the CANON A.5 narrow boundary to Layer 3.

Design notes:

``ObjectDetector`` and ``ObjectTracker`` are **synchronous** because the
underlying libraries (YOLO, SORT/deep-SORT) are CPU-bound and do not
benefit from ``async``. They run inside a thread executor called from the
async pipeline. Making them async would require the implementation to call
``asyncio.get_running_loop()`` or ``run_in_executor`` internally, which
leaks the event loop into domain logic. Instead, the async pipeline layer
wraps synchronous calls in ``loop.run_in_executor()``.

``FrameSource`` is an **async context manager** because camera initialisation
involves blocking I/O (opening device handles, setting resolution, warming up
the capture pipeline). The async context manager pattern allows that blocking
work to be pushed into a thread executor at ``__aenter__`` time, and ensures
teardown (releasing the device) is always called even if the pipeline raises.

``PersistenceCheck`` is deliberately **separate** from any ``GraphPersistence``
interface. CANON A.5 mandates a narrow, single-purpose crossing at the Layer 2
/ Layer 3 boundary. ``PersistenceCheck`` exposes exactly one public method
(``find_match``) so that Layer 2 cannot accidentally couple itself to graph
write operations, schema queries, or any other Layer 3 concern.

Usage::

    from cobeing.layer2_perception.protocols import (
        FrameSource,
        ObjectDetector,
        ObjectTracker,
        PersistenceCheck,
    )

    # Type-check at the composition root:
    assert isinstance(my_camera, FrameSource)
    assert isinstance(my_detector, ObjectDetector)
    assert isinstance(my_tracker, ObjectTracker)
    assert isinstance(my_persistence, PersistenceCheck)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from types import TracebackType

from cobeing.layer2_perception.types import (
    Detection,
    Frame,
    PersistenceResult,
    TrackedObject,
)
from cobeing.shared.observation import Observation


@runtime_checkable
class FrameSource(Protocol):
    """Async context manager that captures camera frames.

    Implementations are responsible for opening the camera device on
    ``__aenter__`` and releasing it on ``__aexit__``, regardless of whether
    the pipeline exits normally or via an exception.

    ``get_frame`` returns ``None`` when no frame is available (e.g., the
    camera is warming up or a transient read failed) so that the pipeline
    can continue without treating a momentary gap as a fatal error.

    Example::

        async with camera as source:
            while True:
                frame = await source.get_frame()
                if frame is not None:
                    process(frame)
    """

    async def __aenter__(self) -> FrameSource:
        """Open the camera device and prepare the capture pipeline.

        Returns:
            The FrameSource itself, ready to produce frames.

        Raises:
            CaptureError: If the device cannot be opened.
        """
        ...

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        """Release the camera device and free capture resources.

        This is always called, even when the body of the ``async with``
        block raises an exception. Implementations must not raise here.

        Args:
            exc_type: Exception type if the body raised, else None.
            exc_val: Exception instance if the body raised, else None.
            exc_tb: Traceback if the body raised, else None.
        """
        ...

    async def get_frame(self) -> Frame | None:
        """Capture and return a single frame.

        Returns:
            A :class:`~cobeing.layer2_perception.types.Frame` if a frame
            was captured successfully, or ``None`` if no frame is available
            at this moment (transient gap, device warming up, etc.).

        Raises:
            CaptureError: If the device is in an unrecoverable error state.
        """
        ...


@runtime_checkable
class ObjectDetector(Protocol):
    """Synchronous object detector interface (CPU-bound).

    Implementations wrap a YOLO model or equivalent detector. The method is
    synchronous because detection is CPU-bound inference -- the caller is
    responsible for dispatching to a thread executor if needed to avoid
    blocking the event loop.

    Example::

        detections = detector.detect(frame)
        for det in detections:
            print(det.label_raw, det.confidence)
    """

    def detect(self, frame: Frame) -> list[Detection]:
        """Run object detection on a single frame.

        Args:
            frame: The captured frame to run detection on. Only the ``data``
                bytes field is used; the frame is not mutated.

        Returns:
            A list of :class:`~cobeing.layer2_perception.types.Detection`
            objects, one per bounding box found. An empty list means no
            objects were detected above the confidence threshold.

        Raises:
            DetectionError: If the detection model encounters an unrecoverable
                error processing this frame.
        """
        ...


@runtime_checkable
class ObjectTracker(Protocol):
    """Synchronous object tracker interface (CPU-bound).

    Implementations wrap a SORT-style tracker that associates detections
    across consecutive frames into persistent :class:`TrackedObject` tracks.
    The method is synchronous for the same reason as ``ObjectDetector``.

    Example::

        tracked = tracker.update(detections, frame.frame_id)
        confirmed = [t for t in tracked if t.state == TrackState.CONFIRMED]
    """

    def update(
        self,
        detections: list[Detection],
        frame_id: str,
    ) -> list[TrackedObject]:
        """Update tracker state with new detections and return current tracks.

        Args:
            detections: All detections produced for the current frame by
                :class:`ObjectDetector`. May be an empty list if no objects
                were detected.
            frame_id: The ``frame_id`` of the frame these detections came
                from. Used to set provenance on returned track objects.

        Returns:
            All currently active :class:`~cobeing.layer2_perception.types.TrackedObject`
            instances after incorporating ``detections``. Includes tracks in
            all non-DELETED states (TENTATIVE, CONFIRMED, LOST). DELETED
            tracks are removed from the returned list.

        Raises:
            TrackingError: If the tracker encounters an internal inconsistency
                that prevents update.
        """
        ...


@runtime_checkable
class PersistenceCheck(Protocol):
    """CANON A.5 narrow interface from Layer 2 to Layer 3.

    This protocol enforces the CANON requirement that Layer 2 communicates
    with Layer 3 through a single-purpose boundary. ``PersistenceCheck``
    has exactly **one** public method: ``find_match``.

    Layer 2 calls ``find_match`` to ask "does the knowledge graph already
    have a node matching this observation?" Layer 3 answers with a
    :class:`~cobeing.layer2_perception.types.PersistenceResult` (or ``None``
    if the check could not be performed). Layer 2 never writes to the graph
    directly and never queries for anything beyond identity resolution.

    This is intentionally NOT a ``GraphPersistence`` interface. The graph
    persistence interface owns read/write operations on the graph as a whole.
    ``PersistenceCheck`` is only the narrow crossing point for the perception
    pipeline.

    Example::

        result = await persistence_check.find_match(observation)
        if result is not None and result.matched_node_id is not None:
            enrich_observation_with_known_identity(observation, result)
    """

    async def find_match(
        self,
        observation: Observation,
    ) -> PersistenceResult | None:
        """Query Layer 3 for a knowledge graph node matching this observation.

        Args:
            observation: The structured observation from the perception
                pipeline. Contains label, bounding box, confidence, and
                optional feature embedding for matching.

        Returns:
            A :class:`~cobeing.layer2_perception.types.PersistenceResult`
            describing the match outcome (matched node ID, confidence,
            match strategy, surprise flag, ambiguous candidates), or
            ``None`` if the check could not be completed (e.g., Layer 3
            is temporarily unavailable).

        Raises:
            PersistenceCheckError: If the query fails in a non-recoverable
                way (distinct from returning ``None`` for a "no match" result).
        """
        ...


__all__ = [
    "FrameSource",
    "ObjectDetector",
    "ObjectTracker",
    "PersistenceCheck",
]

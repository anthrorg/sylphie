"""PerceptionPipeline -- orchestrator for the full Layer 2 perception stack.

This module wires all Layer 2 sub-components into a single, runnable pipeline.
The architecture follows a producer-consumer pattern:

- A **capture task** runs in a background asyncio task, driving the
  :class:`~cobeing.layer2_perception.protocols.FrameSource` at capture rate
  and pushing frames into a :class:`~cobeing.layer2_perception.frame_buffer.FrameBuffer`.

- A **processing loop** runs at ``processing_fps``, pulling the latest frame
  from the buffer and running the full detection → tracking → feature extraction
  → persistence check → observation building → spatial extraction chain.

Both tasks run as asyncio coroutines under the same event loop.
CPU-bound calls (detection, tracking) are dispatched to a thread executor so
they do not block the event loop.

CANON A.5 boundary
------------------
The pipeline communicates with Layer 3 **only** through two injected
dependencies:

1. :class:`~cobeing.layer2_perception.protocols.PersistenceCheck` --
   the narrow A.5 identity-matching interface.
2. :class:`~cobeing.layer2_perception.frame_buffer.ObservationSessionManager` --
   which internally calls the Layer 3 session lifecycle functions.

No other Layer 3 symbols are imported by this module.

Change detection
----------------
A lightweight change-detection gate sits between the FrameBuffer and the
detector.  During a warm-up period (first ``_WARMUP_FRAMES`` frames) every
frame is forwarded to the detector.  After warm-up, the gate can optionally
skip frames whose content hash matches the previous frame -- avoiding a
full detector run on a static scene.

When ``_change_detection_enabled`` is ``False`` (the default for Phase 1),
every frame reaching the processing loop is forwarded to the detector
unconditionally.  Set it to ``True`` in environments where MOG2-equivalent
frame filtering is desirable; the infrastructure is in place and the
``_previous_frame_hash`` bookkeeping is maintained regardless.

Usage::

    from cobeing.layer2_perception.pipeline import PerceptionPipeline
    from cobeing.layer2_perception.synthetic_source import SyntheticFrameSource
    from cobeing.layer2_perception.detector import MockDetector
    from cobeing.layer2_perception.tracker import IoUTracker
    from cobeing.layer2_perception.feature_extraction import (
        DominantColorExtractor, MockEmbeddingExtractor,
    )
    from cobeing.layer2_perception.spatial_extractor import SpatialRelationshipExtractor
    from cobeing.layer2_perception.frame_buffer import (
        FrameBuffer, ObservationSessionManager,
    )
    from cobeing.layer3_knowledge.in_memory_persistence import InMemoryGraphPersistence

    source = SyntheticFrameSource(max_frames=10)
    pipeline = PerceptionPipeline(
        frame_source=source,
        detector=MockDetector(default_detections=[]),
        tracker=IoUTracker(),
        persistence_check=my_persistence_check,
        color_extractor=DominantColorExtractor(),
        embedding_extractor=MockEmbeddingExtractor(),
        spatial_extractor=SpatialRelationshipExtractor(),
        session_manager=ObservationSessionManager(InMemoryGraphPersistence()),
        processing_fps=3.0,
    )

    await pipeline.run()
    observations = pipeline.observations
    spatial_relations = pipeline.spatial_relations
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import TYPE_CHECKING

from cobeing.layer2_perception.feature_extraction import (
    DominantColorExtractor,
    EmbeddingExtractor,
)
from cobeing.layer2_perception.frame_buffer import FrameBuffer, ObservationSessionManager
from cobeing.layer2_perception.observation_builder import ObservationBuilder
from cobeing.layer2_perception.protocols import (
    FrameSource,
    ObjectDetector,
    ObjectTracker,
    PersistenceCheck,
)
from cobeing.layer2_perception.spatial_extractor import (
    SpatialRelation,
    SpatialRelationshipExtractor,
)
from cobeing.layer2_perception.types import (
    FeatureProfile,
    PersistenceResult,
    TrackId,
    TrackState,
    TrackedObject,
)
from cobeing.shared.observation import Observation

if TYPE_CHECKING:
    from cobeing.layer2_perception.config import PerceptionConfig

logger = logging.getLogger(__name__)

# MOG2 warm-up frames -- per D-TS-14: 30 frames before change detection activates.
_WARMUP_FRAMES: int = 30


class PerceptionPipeline:
    """Orchestrator for the full Layer 2 perception pipeline.

    Wires all perception sub-components (capture, detection, tracking,
    feature extraction, persistence check, observation building, spatial
    extraction) into a single runnable unit.

    All components are injected through their Protocol interfaces so that
    tests can substitute mocks for any stage without touching the pipeline
    logic.

    The pipeline runs two concurrent asyncio tasks:

    1. **Capture task** -- calls ``frame_source.get_frame()`` in a loop,
       writing frames into a ``FrameBuffer`` as fast as the source produces
       them.  This task runs independently of the processing loop so that
       the FrameBuffer always has the latest frame available.

    2. **Processing loop** -- runs at ``processing_fps``, pulling the latest
       frame from the buffer and running the full processing chain on it.

    Args:
        frame_source: Async context manager that produces camera frames.
        detector: Synchronous object detector (YOLO or mock).
        tracker: Synchronous IoU-based tracker.
        persistence_check: CANON A.5 narrow interface to Layer 3.
        color_extractor: Dominant colour extractor for feature profiles.
        embedding_extractor: Visual embedding extractor for feature profiles.
        spatial_extractor: Extracts spatial relationships between objects.
        session_manager: Manages the Layer 3 ObservationSession lifecycle.
        config: Full perception config (optional; only used for contextual
            metadata, not for driving processing logic which uses
            ``processing_fps`` directly).
        processing_fps: Target frames-per-second for the processing loop.
            The capture loop always runs as fast as the source allows;
            this governs how often a frame is consumed and processed.
            Default 3.0 fps.
    """

    def __init__(
        self,
        frame_source: FrameSource,
        detector: ObjectDetector,
        tracker: ObjectTracker,
        persistence_check: PersistenceCheck,
        color_extractor: DominantColorExtractor,
        embedding_extractor: EmbeddingExtractor,
        spatial_extractor: SpatialRelationshipExtractor,
        session_manager: ObservationSessionManager,
        config: PerceptionConfig | None = None,
        processing_fps: float = 3.0,
        debug_annotator: object | None = None,
        debug_frame_store: object | None = None,
    ) -> None:
        self._frame_source = frame_source
        self._detector = detector
        self._tracker = tracker
        self._persistence_check = persistence_check
        self._color_extractor = color_extractor
        self._embedding_extractor = embedding_extractor
        self._spatial_extractor = spatial_extractor
        self._session_manager = session_manager
        self._config = config
        self._debug_annotator = debug_annotator
        self._debug_frame_store = debug_frame_store

        if processing_fps <= 0.0:
            raise ValueError(f"processing_fps must be > 0, got {processing_fps}")
        self._processing_fps = processing_fps

        # Pipeline state
        self._stop_event = asyncio.Event()
        self._buffer = FrameBuffer()
        self._observations: list[Observation] = []
        self._spatial_relations: list[SpatialRelation] = []

        # Change detection state (MOG2 warm-up infrastructure, D-TS-14).
        # When _change_detection_enabled is False (Phase 1 default), all
        # frames are forwarded to the detector unconditionally.
        # When True, frames whose hash matches _previous_frame_hash are skipped.
        self._frames_processed: int = 0
        self._warmup_frames: int = _WARMUP_FRAMES
        self._change_detection_enabled: bool = False
        self._previous_frame_hash: str | None = None

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Run the perception pipeline until stopped or the frame source is exhausted.

        Lifecycle:
        1. Opens a Layer 3 observation session.
        2. Creates an ObservationBuilder bound to that session.
        3. Opens the frame source via async context manager.
        4. Starts the capture task and the processing loop concurrently.
        5. When the processing loop exits (stop signal or exhausted source):
           - Signals the FrameBuffer to stop.
           - Cancels the capture task.
           - Closes the observation session.
        """
        # Start the observation session (Layer 3 side effect via
        # ObservationSessionManager -- the only indirect Layer 3 call in
        # the pipeline aside from PersistenceCheck.find_match).
        session = await self._session_manager.start_session()
        session_id = session.session_id

        builder = ObservationBuilder(
            session_id=session_id,
            source_id="camera-0",
        )

        try:
            async with self._frame_source as source:
                # Start capture in a background task.
                capture_task = asyncio.create_task(
                    self._capture_loop(source),
                    name="perception-capture",
                )

                try:
                    await self._processing_loop(builder)
                finally:
                    # Signal the FrameBuffer to stop so the capture task exits.
                    self._buffer.stop()
                    capture_task.cancel()
                    try:
                        await capture_task
                    except asyncio.CancelledError:
                        pass
        finally:
            await self._session_manager.end_session()

    async def stop(self) -> None:
        """Signal the pipeline to stop gracefully.

        Sets the internal stop event, which causes the processing loop to
        exit cleanly after finishing the current processing cycle.  The
        FrameBuffer is stopped and the observation session is closed in
        the ``run()`` cleanup block.
        """
        self._stop_event.set()

    @property
    def observations(self) -> list[Observation]:
        """All observations produced since ``run()`` was called.

        Returns a copy so external callers cannot mutate the internal list.

        Returns:
            Immutable snapshot of produced observations.
        """
        return list(self._observations)

    @property
    def spatial_relations(self) -> list[SpatialRelation]:
        """All spatial relations produced since ``run()`` was called.

        Returns a copy so external callers cannot mutate the internal list.

        Returns:
            Immutable snapshot of produced spatial relations.
        """
        return list(self._spatial_relations)

    # ------------------------------------------------------------------
    # Capture loop
    # ------------------------------------------------------------------

    async def _capture_loop(self, source: FrameSource) -> None:
        """Continuously read frames from the source and push them into the buffer.

        Runs as a background asyncio task.  Exits when:
        - ``get_frame()`` returns ``None`` (source exhausted or max_frames
          reached).
        - The task is cancelled by the pipeline cleanup code.

        On every successful ``get_frame()`` call, the frame is placed into
        ``self._buffer``.  The FrameBuffer uses a drop-oldest policy so the
        processing loop always gets the latest frame without the capture loop
        stalling.

        Args:
            source: The FrameSource (already entered via ``async with``).
        """
        try:
            while not self._stop_event.is_set():
                frame = await source.get_frame()
                if frame is None:
                    # Source exhausted (max_frames reached or camera closed).
                    # Stop the buffer so the processing loop exits.
                    self._buffer.stop()
                    return
                self._buffer.put(frame)
                # Yield control so the event loop can run other tasks.
                await asyncio.sleep(0)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Capture loop encountered an unexpected error")
            self._buffer.stop()

    # ------------------------------------------------------------------
    # Processing loop
    # ------------------------------------------------------------------

    async def _processing_loop(self, builder: ObservationBuilder) -> None:
        """Process frames at ``processing_fps`` until stopped or exhausted.

        Each iteration:
        1. Wait for the inter-frame interval (1.0 / processing_fps seconds).
        2. Get the latest frame from the FrameBuffer (timeout = interval).
        3. If the buffer is stopped and returns None, exit.
        4. Apply change-detection gate (always pass during warm-up; after
           warm-up, pass if change detection is disabled or if the frame
           hash changed).
        5. Run detection (CPU-bound, dispatched to thread executor).
        6. Update tracker.
        7. For each CONFIRMED track: extract features, update track features.
        8. Build preliminary Observations (one per CONFIRMED track).
        9. For each CONFIRMED track: run persistence check.
        10. Collect persistence results.
        11. Call builder.build() with full persistence results.
        12. Collect spatial relations from all tracked objects.
        13. Store observations and spatial relations in instance lists.

        Args:
            builder: The ObservationBuilder bound to the active session.
        """
        loop = asyncio.get_event_loop()
        interval = 1.0 / self._processing_fps

        while not self._stop_event.is_set():
            # Wait for one processing interval, but bail out early if stopped.
            try:
                await asyncio.wait_for(
                    asyncio.shield(self._stop_event.wait()),
                    timeout=interval,
                )
                # If we get here, stop was signalled during the wait.
                break
            except asyncio.TimeoutError:
                # Normal case: interval elapsed without a stop signal.
                pass

            if self._stop_event.is_set():
                break

            # Get the latest frame from the buffer.
            # Use run_in_executor because FrameBuffer.get() is a blocking call.
            frame = await loop.run_in_executor(
                None, lambda: self._buffer.get(timeout=interval)
            )
            if frame is None:
                # FrameBuffer was stopped (source exhausted or stop() called).
                break

            # Change detection gate.
            frame_hash = hashlib.md5(frame.data, usedforsecurity=False).hexdigest()
            is_warmup = self._frames_processed < self._warmup_frames
            if not is_warmup and self._change_detection_enabled:
                if frame_hash == self._previous_frame_hash:
                    # Frame unchanged; skip detection this cycle.
                    self._previous_frame_hash = frame_hash
                    self._frames_processed += 1
                    continue
            self._previous_frame_hash = frame_hash
            self._frames_processed += 1

            # Run detector (CPU-bound) in a thread executor.
            detections = await loop.run_in_executor(
                None, lambda: self._detector.detect(frame)
            )

            # Update tracker (CPU-bound) in a thread executor.
            tracked_objects = await loop.run_in_executor(
                None, lambda: self._tracker.update(detections, frame.frame_id)
            )

            # Filter to CONFIRMED tracks only for feature extraction.
            confirmed = [
                t for t in tracked_objects if t.state == TrackState.CONFIRMED
            ]

            # Extract features and update tracks in-memory.
            # TrackedObject is frozen (Pydantic frozen=True), so we build a
            # new instance with updated features and replace it in our list.
            updated_confirmed: list[TrackedObject] = []
            for track in confirmed:
                det = track.detection
                bbox = (
                    det.bbox_x_min,
                    det.bbox_y_min,
                    det.bbox_x_max,
                    det.bbox_y_max,
                )

                # Extract dominant colours.
                colors = self._color_extractor.extract(
                    frame_data=frame.data,
                    bbox=bbox,
                    frame_width=frame.width,
                    frame_height=frame.height,
                )

                # Extract embedding.
                embedding = self._embedding_extractor.extract(
                    frame_data=frame.data,
                    bbox=bbox,
                    frame_width=frame.width,
                    frame_height=frame.height,
                )

                feature_profile = FeatureProfile(
                    dominant_colors=colors if colors else None,
                    embedding=embedding,
                )
                # Build an updated TrackedObject with the extracted features.
                updated_track = track.model_copy(update={"features": feature_profile})
                updated_confirmed.append(updated_track)

            # Build preliminary observations for each CONFIRMED track so we
            # can pass them to the persistence check.  These are full
            # Observations minus the candidate_node_id from persistence.
            # We use the builder to create them (which handles debounce) only
            # at the final step; here we need lightweight observation-like
            # objects for the persistence check API.
            #
            # Per the persistence check protocol, it accepts an Observation.
            # So we build real preliminary Observations with no
            # candidate_node_id, call find_match on each, collect results,
            # then call builder.build() with those results for the final emit.

            # Build preliminary Observations without persistence results.
            preliminary_obs_map: dict[TrackId, Observation] = {}
            preliminary_builder = ObservationBuilder(
                session_id=builder._session_id,
                source_id=builder._source_id,
                # Use a low debounce threshold so preliminary observations are
                # always emitted (they are only used for persistence check,
                # not stored).
                debounce_iou_threshold=0.0,
            )
            preliminary_list = preliminary_builder.build(
                tracked_objects=updated_confirmed,
                persistence_results={},
                frame_width=frame.width,
                frame_height=frame.height,
            )
            # Map from TrackId back to Observation for persistence lookup.
            # preliminary_builder iterates tracks in the same order as
            # updated_confirmed, so we can zip them.
            for track, obs in zip(updated_confirmed, preliminary_list):
                preliminary_obs_map[track.track_id] = obs

            # Run persistence check for each CONFIRMED track.
            persistence_results: dict[TrackId, PersistenceResult] = {}
            for track in updated_confirmed:
                obs = preliminary_obs_map.get(track.track_id)
                if obs is None:
                    continue
                result = await self._persistence_check.find_match(obs)
                if result is not None:
                    persistence_results[track.track_id] = result

            # Build final Observations with persistence results.
            # The builder applies debounce internally.
            new_observations = builder.build(
                tracked_objects=updated_confirmed,
                persistence_results=persistence_results,
                frame_width=frame.width,
                frame_height=frame.height,
            )
            self._observations.extend(new_observations)

            # Extract spatial relationships from ALL tracked objects (including
            # TENTATIVE and LOST -- the spatial extractor filters to CONFIRMED).
            # However, we must pass the updated_confirmed list which has feature
            # profiles; the full tracked_objects list has the original versions
            # without updated features.  We merge them back for the spatial call.
            # The spatial extractor only uses bounding boxes, so either list works;
            # we pass the full tracked_objects to preserve all track states for
            # the extractor's internal CONFIRMED-only filter.
            all_tracks_for_spatial = list(tracked_objects)
            # Replace confirmed tracks with the feature-updated versions in
            # the list to maintain consistency, though the spatial extractor
            # only uses bounding box data.
            updated_by_id = {t.track_id: t for t in updated_confirmed}
            all_tracks_for_spatial = [
                updated_by_id.get(t.track_id, t) for t in tracked_objects
            ]

            new_relations = self._spatial_extractor.extract(
                tracked_objects=all_tracks_for_spatial,
                frame_width=frame.width,
                frame_height=frame.height,
            )
            self._spatial_relations.extend(new_relations)

            # Debug overlay: annotate the frame and push to the store for
            # the MJPEG streaming endpoint. Zero impact when not wired.
            if self._debug_annotator and self._debug_frame_store:
                try:
                    annotated_jpeg = await loop.run_in_executor(
                        None,
                        self._debug_annotator.annotate,
                        frame,
                        all_tracks_for_spatial,
                        persistence_results,
                        new_relations,
                    )
                    await self._debug_frame_store.put(annotated_jpeg, frame.data)
                except Exception:
                    logger.debug("debug_annotator: frame annotation failed", exc_info=True)


__all__ = ["PerceptionPipeline"]

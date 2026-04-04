"""FrameBuffer and ObservationSessionManager for the Layer 2 perception pipeline.

This module provides two components that manage the infrastructure boundary
between raw frame capture and the Layer 3 knowledge graph:

**FrameBuffer:**
    Thread-safe single-slot frame buffer. The capture thread calls ``put()``
    at camera fps (e.g., 15 fps). The processing loop calls ``get()`` at its
    own rate (e.g., 3 fps). Only the most recent frame is retained -- older
    frames are silently dropped when a new one arrives before the processing
    loop has consumed the previous one. This is the correct policy for a
    perception pipeline: processing the latest state of the scene is always
    more valuable than processing stale frames.

    The buffer uses a threading.Event-based wait so that the processing loop
    blocks efficiently rather than polling, while still respecting a timeout
    and a stop signal (D-TS-13).

**ObservationSessionManager:**
    Manages the lifecycle of a Layer 3 ``ObservationSession`` node. Wraps the
    ``create_observation_session`` and ``close_observation_session`` functions
    from ``observation_ingestion`` so that the pipeline entry point has a
    single object to call at start and stop.

    The manager is async because it delegates to the async Layer 3 write path.
    ``FrameBuffer`` is pure threading -- no async -- because frame capture
    runs on a background thread, not an asyncio task.

Usage::

    from cobeing.layer2_perception.frame_buffer import (
        FrameBuffer,
        ObservationSessionManager,
    )
    from cobeing.layer3_knowledge.in_memory_persistence import (
        InMemoryGraphPersistence,
    )

    # FrameBuffer -- capture thread puts, processing loop gets
    buf = FrameBuffer()
    buf.put(frame)                        # capture thread
    latest = buf.get(timeout=1.0)        # processing loop; None on timeout/stop
    buf.stop()                           # signal consumers to exit

    # ObservationSessionManager -- pipeline start/stop
    manager = ObservationSessionManager(InMemoryGraphPersistence())
    session = await manager.start_session()   # creates Layer 3 session node
    await manager.end_session()               # closes Layer 3 session node
"""

from __future__ import annotations

import threading
import uuid
from typing import TYPE_CHECKING

from cobeing.layer2_perception.types import Frame

if TYPE_CHECKING:
    from cobeing.layer3_knowledge.observation_ingestion import ObservationSession
    from cobeing.layer3_knowledge.protocols import GraphPersistence


class FrameBuffer:
    """Thread-safe single-slot frame buffer with drop-oldest policy.

    The capture thread calls ``put()`` at camera fps (e.g., 15 fps).
    The processing loop calls ``get()`` at processing rate (e.g., 3 fps).
    Only the most recent frame is kept -- older frames are dropped when a
    new frame arrives before the consumer has retrieved the previous one.

    **Thread model:**
    - One writer thread (capture): calls ``put()``.
    - One reader thread (processing loop): calls ``get()``.
    - The stop signal is safe to call from any thread.

    **Stop protocol (D-TS-13):**
    When ``stop()`` is called, ``get()`` returns ``None`` immediately,
    even if a frame is available. This lets the processing loop exit
    cleanly without needing a sentinel frame object.

    Attributes:
        _frame: The most recently placed frame, or ``None`` if no frame
            has been placed since the last ``get()``.
        _lock: Mutex protecting ``_frame``. Only held briefly during
            reads and writes of the slot -- never while waiting.
        _new_frame_event: Signals that a new frame is available. Set by
            ``put()``, cleared by ``get()`` after retrieving the frame.
        _stop_event: Signals that the buffer is shutting down. Once set,
            ``get()`` returns ``None`` unconditionally.
    """

    def __init__(self) -> None:
        self._frame: Frame | None = None
        self._lock = threading.Lock()
        self._new_frame_event = threading.Event()
        self._stop_event = threading.Event()

    def put(self, frame: Frame) -> None:
        """Store a frame, replacing any previous frame (drop-oldest policy).

        The previous frame -- if any -- is silently discarded. This is the
        correct behaviour: the processing loop should always work with the
        most recent scene state, not an arbitrarily old one.

        This method is safe to call from any thread.

        Args:
            frame: The captured frame to store. Must be a valid ``Frame``
                instance (the type annotation is enforced by the caller's
                type checker, not at runtime).
        """
        with self._lock:
            self._frame = frame
        self._new_frame_event.set()

    def get(self, timeout: float = 1.0) -> Frame | None:
        """Get the latest frame, blocking until one is available or timeout.

        Returns ``None`` in three situations:
        1. The stop event is already set when ``get()`` is called.
        2. The stop event is set while waiting for a frame.
        3. The ``timeout`` elapses with no frame available.

        After returning a frame, the internal slot is not cleared -- the
        same frame can be returned again if ``put()`` is not called before
        the next ``get()``. In practice the processing loop calls ``get()``
        once per processing cycle, so this is harmless: the loop either
        gets a new frame (if one arrived since last cycle) or the same old
        frame (if none arrived). Callers that need to distinguish "new frame"
        from "same frame" should compare ``frame.frame_sequence``.

        Args:
            timeout: Maximum seconds to wait for a new frame event. Defaults
                to 1.0 second. The processing loop should set this to a value
                longer than its expected inter-frame interval so that it does
                not spin when the camera is slow.

        Returns:
            The most recent frame, or ``None`` if the stop event is set or
            the timeout elapses.
        """
        # Fast path: already stopped.
        if self._stop_event.is_set():
            return None

        # Wait for a new frame signal, or timeout, or stop.
        self._new_frame_event.wait(timeout=timeout)

        # Check stop again after the wait -- stop() may have fired during wait.
        if self._stop_event.is_set():
            return None

        # Clear the event so the next call waits for the next put().
        self._new_frame_event.clear()

        with self._lock:
            return self._frame

    def stop(self) -> None:
        """Signal all consumers to exit.

        After ``stop()`` is called, any blocked or future call to ``get()``
        will return ``None`` immediately. Safe to call from any thread and
        safe to call multiple times (idempotent).
        """
        self._stop_event.set()
        # Wake up any thread currently waiting in get() so it sees the stop.
        self._new_frame_event.set()

    @property
    def is_stopped(self) -> bool:
        """True if ``stop()`` has been called.

        Returns:
            Whether the buffer's stop event is set.
        """
        return self._stop_event.is_set()


class ObservationSessionManager:
    """Manages the Layer 3 ObservationSession lifecycle.

    At pipeline start, ``start_session()`` creates an ``ObservationSession``
    node in the knowledge graph. At pipeline stop, ``end_session()`` closes
    that node by recording its ``ended_at`` timestamp.

    This class is a thin wrapper around the ``create_observation_session``
    and ``close_observation_session`` functions in
    ``cobeing.layer3_knowledge.observation_ingestion``. Its purpose is to
    give the pipeline entry point a single object to manage the session
    rather than importing and calling those functions directly.

    All methods are async because they delegate to the async Layer 3 write
    path. The manager itself holds no state beyond the current session record.

    Attributes:
        _persistence: The graph storage backend to write session nodes into.
        _current_session: The active session, or ``None`` if no session is
            currently open.
    """

    def __init__(self, persistence: GraphPersistence) -> None:
        self._persistence = persistence
        self._current_session: ObservationSession | None = None

    async def start_session(self) -> ObservationSession:
        """Create a new observation session node in the knowledge graph.

        Generates a fresh UUID as the session identifier, delegates to
        ``create_observation_session``, and stores the result so that
        ``current_session`` returns it.

        Returns:
            The newly created ``ObservationSession`` with its graph node ID
            and start timestamp.
        """
        # Import here to avoid a module-level circular import: layer2 ->
        # layer3. The import is cheap after the first call (Python caches it).
        from cobeing.layer3_knowledge.observation_ingestion import (
            create_observation_session,
        )

        session_id = str(uuid.uuid4())
        self._current_session = await create_observation_session(
            self._persistence, session_id
        )
        return self._current_session

    async def end_session(self) -> None:
        """Close the current observation session.

        Delegates to ``close_observation_session`` to record the session's
        ``ended_at`` timestamp. Safe to call when no session is active --
        it is a no-op in that case.
        """
        if self._current_session is None:
            return

        from cobeing.layer3_knowledge.observation_ingestion import (
            close_observation_session,
        )

        await close_observation_session(
            self._persistence, self._current_session.session_id
        )
        self._current_session = None

    @property
    def current_session(self) -> ObservationSession | None:
        """The active observation session, or ``None`` if none is open.

        Returns:
            The ``ObservationSession`` returned by the most recent
            ``start_session()`` call, or ``None`` if ``end_session()``
            has been called since or ``start_session()`` has never been
            called.
        """
        return self._current_session


__all__ = [
    "FrameBuffer",
    "ObservationSessionManager",
]

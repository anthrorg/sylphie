"""CameraFrameSource and VideoFileSource for the Layer 2 perception pipeline.

This module provides two :class:`~cobeing.layer2_perception.protocols.FrameSource`
implementations built on ``cv2.VideoCapture``:

**CameraFrameSource:**
    Live camera capture. Opens a physical device by index on ``__aenter__``,
    configures capture properties (resolution, fps, buffer size), reads frames
    via ``VideoCapture.read()``, JPEG-encodes them, and returns immutable
    :class:`~cobeing.layer2_perception.types.Frame` objects.

    ``cv2`` is imported lazily -- inside ``__init__`` -- so this module can be
    imported in any context without the ``[cv]`` extras installed. The lazy
    import means the ``ImportError`` surfaces at construction time rather than
    at module import time, which is the appropriate failure point.

**VideoFileSource:**
    Video file playback. Identical architecture to ``CameraFrameSource`` but
    opens a file path instead of a device index. Returns ``None`` when the
    file reaches EOF, allowing the consumer loop to detect end-of-file cleanly
    without treating it as an error.

Both classes implement the :class:`~cobeing.layer2_perception.protocols.FrameSource`
protocol and are safe to use in an ``async with`` block.

Usage::

    from cobeing.layer2_perception.frame_sources import CameraFrameSource, VideoFileSource
    from cobeing.layer2_perception.config import CameraConfig

    # Live camera:
    config = CameraConfig(device=0, width=1280, height=720, fps=15)
    async with CameraFrameSource(config, session_id="session-abc") as source:
        frame = await source.get_frame()
        if frame is not None:
            process(frame)

    # Video file:
    async with VideoFileSource("recording.mp4", session_id="session-abc") as source:
        while True:
            frame = await source.get_frame()
            if frame is None:
                break  # EOF
            process(frame)

Design notes:

- Both classes run the blocking ``VideoCapture.open()`` and ``VideoCapture.read()``
  calls inside ``asyncio.get_event_loop().run_in_executor(None, ...)`` so they
  do not block the event loop during I/O waits.
- ``Frame.observed_at`` is set at the moment ``cap.read()`` returns, not at
  JPEG-encoding time.  The encoding happens after the timestamp is captured so
  that ``observed_at`` reflects actual sensor time.
- ``Frame.frame_sequence`` is a monotonically increasing counter scoped to the
  source instance.  Callers can detect dropped frames by checking for gaps in
  the sequence.
- A ``frame_id`` is a UUID generated per captured frame to guarantee global
  uniqueness across sessions and restarts.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from types import TracebackType

from cobeing.layer2_perception.config import CameraConfig
from cobeing.layer2_perception.exceptions import CaptureError
from cobeing.layer2_perception.types import Frame


class CameraFrameSource:
    """Live camera capture implementing the FrameSource protocol.

    Wraps ``cv2.VideoCapture`` to open a physical camera device and produce
    immutable :class:`~cobeing.layer2_perception.types.Frame` objects.

    cv2 is imported lazily inside ``__init__`` so this module can be imported
    without the ``[cv]`` extras package installed; the ``ImportError`` surfaces
    at construction time rather than at module import time.

    The source must be used as an async context manager::

        async with CameraFrameSource(config, session_id) as source:
            frame = await source.get_frame()

    Attributes:
        _config: Camera configuration (device index, resolution, fps, buffer).
        _session_id: Observation session identifier attached to every frame.
        _cap: The ``cv2.VideoCapture`` handle; ``None`` until ``__aenter__``.
        _sequence: Monotonically increasing frame sequence counter.
        _cv2: Lazily imported ``cv2`` module reference.
    """

    def __init__(self, config: CameraConfig, session_id: str) -> None:
        """Initialise the source with camera configuration.

        cv2 is imported here so that the ``ImportError`` surfaces at
        construction time, not at module import time.

        Args:
            config: Camera device configuration (device index, resolution, fps,
                buffer size).
            session_id: Identifier of the current ObservationSession. Attached
                to every :class:`~cobeing.layer2_perception.types.Frame` produced
                by this source.

        Raises:
            ImportError: If the ``[cv]`` extras are not installed.
        """
        import cv2  # noqa: PLC0415 -- intentional lazy import

        self._cv2 = cv2
        self._config = config
        self._session_id = session_id
        self._cap: object | None = None  # cv2.VideoCapture, typed as object to avoid cv2 at module level
        self._sequence: int = 0

    async def __aenter__(self) -> CameraFrameSource:
        """Open the camera device and apply capture settings.

        Runs the blocking ``VideoCapture`` constructor and property-setter
        calls in a thread executor so that the event loop is not blocked.

        Returns:
            ``self``, ready to produce frames via :meth:`get_frame`.

        Raises:
            CaptureError: If the device cannot be opened (i.e.,
                ``cap.isOpened()`` returns ``False``).
        """
        loop = asyncio.get_event_loop()
        cap = await loop.run_in_executor(None, self._open_device)
        self._cap = cap
        return self

    def _open_device(self) -> object:
        """Blocking device-open helper called from a thread executor.

        Opens the device, applies capture properties, and returns the
        ``VideoCapture`` handle.

        Returns:
            An opened ``cv2.VideoCapture`` instance.

        Raises:
            CaptureError: If the device cannot be opened.
        """
        cap = self._cv2.VideoCapture(self._config.device)
        if not cap.isOpened():
            cap.release()
            raise CaptureError(
                f"Cannot open camera device {self._config.device!r}. "
                "Check that the device is connected and not in use by another process."
            )
        cap.set(self._cv2.CAP_PROP_FRAME_WIDTH, self._config.width)
        cap.set(self._cv2.CAP_PROP_FRAME_HEIGHT, self._config.height)
        cap.set(self._cv2.CAP_PROP_FPS, self._config.fps)
        cap.set(self._cv2.CAP_PROP_BUFFERSIZE, self._config.buffer_size)
        return cap

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        """Release the camera device.

        Always called, even when the ``async with`` body raises. Does not
        re-raise or suppress exceptions from the body.

        Args:
            exc_type: Exception type if the body raised, else None.
            exc_val: Exception instance if the body raised, else None.
            exc_tb: Traceback if the body raised, else None.
        """
        if self._cap is not None:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self._cap.release)  # type: ignore[attr-defined]
            self._cap = None

    async def get_frame(self) -> Frame | None:
        """Capture and return a single frame from the camera.

        Reads a frame via ``VideoCapture.read()``. If the read succeeds, the
        frame is JPEG-encoded and wrapped in an immutable
        :class:`~cobeing.layer2_perception.types.Frame`.

        ``Frame.observed_at`` is the UTC wall-clock time captured immediately
        after ``cap.read()`` returns, before JPEG encoding. This best
        approximates the actual sensor capture time.

        ``Frame.frame_sequence`` increments by 1 for each successful read.
        When ``read()`` returns ``False`` (dropped frame), the sequence counter
        is also incremented to preserve the monotonic gap, allowing downstream
        consumers to detect the drop.

        Returns:
            A :class:`~cobeing.layer2_perception.types.Frame` if a frame was
            captured successfully. ``None`` if the read failed (transient
            dropped frame).

        Raises:
            CaptureError: If the source has not been opened (``__aenter__``
                was not called).
        """
        if self._cap is None:
            raise CaptureError(
                "CameraFrameSource is not open. Use 'async with' to open the device."
            )
        loop = asyncio.get_event_loop()
        frame = await loop.run_in_executor(None, self._read_frame)
        return frame

    def _read_frame(self) -> Frame | None:
        """Blocking frame-read helper called from a thread executor.

        Returns:
            A :class:`~cobeing.layer2_perception.types.Frame` on success,
            or ``None`` if the read fails (dropped frame).
        """
        ret, img = self._cap.read()  # type: ignore[union-attr]
        # Capture observed_at immediately after read() returns so it reflects
        # sensor time rather than encoding time.
        observed_at = datetime.now(UTC)

        if not ret or img is None:
            # Dropped frame: still advance sequence counter so downstream
            # consumers can detect the gap.
            self._sequence += 1
            return None

        ok, jpeg_buf = self._cv2.imencode(".jpg", img)
        if not ok:
            self._sequence += 1
            return None

        frame_id = str(uuid.uuid4())
        sequence = self._sequence
        self._sequence += 1

        return Frame(
            frame_id=frame_id,
            frame_sequence=sequence,
            observed_at=observed_at,
            width=img.shape[1],
            height=img.shape[0],
            data=jpeg_buf.tobytes(),
            session_id=self._session_id,
        )


class VideoFileSource:
    """Video file playback implementing the FrameSource protocol.

    Wraps ``cv2.VideoCapture`` to open a video file and play it back frame
    by frame. Identical architecture to :class:`CameraFrameSource` but
    returns ``None`` at end-of-file rather than raising an error.

    cv2 is imported lazily inside ``__init__`` for the same reason as
    :class:`CameraFrameSource`.

    Usage::

        async with VideoFileSource("recording.mp4", session_id="s1") as src:
            while True:
                frame = await src.get_frame()
                if frame is None:
                    break  # EOF reached

    Attributes:
        _file_path: Path to the video file.
        _session_id: Observation session identifier attached to every frame.
        _width: Requested output width (passed to ``CAP_PROP_FRAME_WIDTH``).
        _height: Requested output height (passed to ``CAP_PROP_FRAME_HEIGHT``).
        _cap: The ``cv2.VideoCapture`` handle; ``None`` until ``__aenter__``.
        _sequence: Monotonically increasing frame sequence counter.
        _cv2: Lazily imported ``cv2`` module reference.
    """

    def __init__(
        self,
        file_path: str,
        session_id: str,
        width: int = 1280,
        height: int = 720,
    ) -> None:
        """Initialise the source with a video file path.

        cv2 is imported here so that the ``ImportError`` surfaces at
        construction time.

        Args:
            file_path: Absolute or relative path to the video file. Must be
                readable by ``cv2.VideoCapture``.
            session_id: Identifier of the current ObservationSession. Attached
                to every :class:`~cobeing.layer2_perception.types.Frame` produced.
            width: Requested frame width. Passed to ``CAP_PROP_FRAME_WIDTH``.
                The file's native width is used if this property cannot be set.
            height: Requested frame height. Passed to ``CAP_PROP_FRAME_HEIGHT``.
                The file's native height is used if this property cannot be set.

        Raises:
            ImportError: If the ``[cv]`` extras are not installed.
        """
        import cv2  # noqa: PLC0415 -- intentional lazy import

        self._cv2 = cv2
        self._file_path = file_path
        self._session_id = session_id
        self._width = width
        self._height = height
        self._cap: object | None = None
        self._sequence: int = 0

    async def __aenter__(self) -> VideoFileSource:
        """Open the video file and prepare for playback.

        Runs the blocking ``VideoCapture`` constructor in a thread executor.

        Returns:
            ``self``, ready to produce frames via :meth:`get_frame`.

        Raises:
            CaptureError: If the file cannot be opened.
        """
        loop = asyncio.get_event_loop()
        cap = await loop.run_in_executor(None, self._open_file)
        self._cap = cap
        return self

    def _open_file(self) -> object:
        """Blocking file-open helper called from a thread executor.

        Returns:
            An opened ``cv2.VideoCapture`` instance.

        Raises:
            CaptureError: If the file cannot be opened.
        """
        cap = self._cv2.VideoCapture(self._file_path)
        if not cap.isOpened():
            cap.release()
            raise CaptureError(
                f"Cannot open video file {self._file_path!r}. "
                "Check that the file exists and is a supported video format."
            )
        cap.set(self._cv2.CAP_PROP_FRAME_WIDTH, self._width)
        cap.set(self._cv2.CAP_PROP_FRAME_HEIGHT, self._height)
        return cap

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        """Release the video file handle.

        Always called even when the ``async with`` body raises.

        Args:
            exc_type: Exception type if the body raised, else None.
            exc_val: Exception instance if the body raised, else None.
            exc_tb: Traceback if the body raised, else None.
        """
        if self._cap is not None:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self._cap.release)  # type: ignore[attr-defined]
            self._cap = None

    async def get_frame(self) -> Frame | None:
        """Read and return the next frame from the video file.

        Returns ``None`` at end-of-file or when ``read()`` fails, allowing
        the consumer loop to detect EOF cleanly without an exception.

        ``Frame.observed_at`` is the UTC wall-clock time at the moment the
        frame is read from disk -- a proxy for when the original sensor data
        was captured during re-processing. This is consistent with
        :class:`CameraFrameSource` behaviour.

        Returns:
            A :class:`~cobeing.layer2_perception.types.Frame` on success.
            ``None`` when EOF is reached or a frame cannot be read.

        Raises:
            CaptureError: If the source has not been opened (``__aenter__``
                was not called).
        """
        if self._cap is None:
            raise CaptureError(
                "VideoFileSource is not open. Use 'async with' to open the file."
            )
        loop = asyncio.get_event_loop()
        frame = await loop.run_in_executor(None, self._read_frame)
        return frame

    def _read_frame(self) -> Frame | None:
        """Blocking frame-read helper called from a thread executor.

        Returns:
            A :class:`~cobeing.layer2_perception.types.Frame` on success,
            or ``None`` at EOF or on any read failure.
        """
        ret, img = self._cap.read()  # type: ignore[union-attr]
        observed_at = datetime.now(UTC)

        if not ret or img is None:
            # EOF or unrecoverable read failure -- return None (not an error).
            self._sequence += 1
            return None

        ok, jpeg_buf = self._cv2.imencode(".jpg", img)
        if not ok:
            self._sequence += 1
            return None

        frame_id = str(uuid.uuid4())
        sequence = self._sequence
        self._sequence += 1

        return Frame(
            frame_id=frame_id,
            frame_sequence=sequence,
            observed_at=observed_at,
            width=img.shape[1],
            height=img.shape[0],
            data=jpeg_buf.tobytes(),
            session_id=self._session_id,
        )


__all__ = [
    "CameraFrameSource",
    "VideoFileSource",
]

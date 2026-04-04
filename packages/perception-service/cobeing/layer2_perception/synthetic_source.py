"""Synthetic frame source for deterministic testing of the perception pipeline.

This module provides :class:`SyntheticFrameSource`, which implements the
:class:`~cobeing.layer2_perception.protocols.FrameSource` protocol without
requiring any camera hardware or external CV library. It generates raw RGB
frames in-process using only the Python standard library, so it is safe to
import and use in any test environment.

Each frame is a flat ``bytes`` buffer of ``width * height * 3`` bytes (raw
RGB, one byte per channel per pixel, row-major). The background is filled with
a configurable color and then one rectangular region is painted per
:class:`SyntheticObject` defined for the current scene.

Because all operations are deterministic (same config, same objects, same
resulting pixel values), the source is appropriate for unit tests that need
to assert pixel-level behavior: verifying that a detection model reads the
correct color from a bounding box, that a tracker sees the right centroid,
or that a feature extractor produces a stable embedding.

Usage::

    from cobeing.layer2_perception.synthetic_source import (
        SyntheticFrameSource,
        SyntheticObject,
    )

    objects = [
        SyntheticObject(x_min=10, y_min=10, x_max=50, y_max=50, color=(255, 0, 0)),
    ]
    async with SyntheticFrameSource(width=320, height=240, objects=objects) as src:
        frame = await src.get_frame()
        assert frame is not None
        assert frame.frame_sequence == 0
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from types import TracebackType

from cobeing.layer2_perception.types import Frame


@dataclass(frozen=True)
class SyntheticObject:
    """A colored rectangle to paint in synthetic frames.

    Coordinates are in pixel space with the origin at the top-left corner.
    ``x_min`` and ``y_min`` are inclusive; ``x_max`` and ``y_max`` are
    exclusive (following Python slice convention). Coordinates outside the
    frame boundary are clamped during rendering -- no error is raised.

    Attributes:
        x_min: Left edge of the rectangle (inclusive), in pixels.
        y_min: Top edge of the rectangle (inclusive), in pixels.
        x_max: Right edge of the rectangle (exclusive), in pixels.
        y_max: Bottom edge of the rectangle (exclusive), in pixels.
        color: Fill color as an (R, G, B) tuple, each channel in [0, 255].
    """

    x_min: int
    y_min: int
    x_max: int
    y_max: int
    color: tuple[int, int, int]


def _render_frame(
    width: int,
    height: int,
    objects: list[SyntheticObject],
    background_color: tuple[int, int, int],
) -> bytes:
    """Render a single raw RGB frame to a bytes buffer.

    The buffer is row-major: pixel (x, y) starts at byte offset
    ``(y * width + x) * 3``. Channels are ordered R, G, B.

    Args:
        width: Frame width in pixels.
        height: Frame height in pixels.
        objects: Rectangles to paint over the background, in order. Later
            objects overwrite earlier ones where they overlap.
        background_color: (R, G, B) fill for the entire frame before
            any objects are painted.

    Returns:
        Raw RGB bytes of length ``width * height * 3``.
    """
    # Allocate a bytearray filled with the background color.
    # Three channels per pixel, replicated across all pixels.
    r_bg, g_bg, b_bg = background_color
    buf = bytearray(width * height * 3)

    # Fill background: write R, G, B for every pixel.
    for i in range(width * height):
        base = i * 3
        buf[base] = r_bg
        buf[base + 1] = g_bg
        buf[base + 2] = b_bg

    # Paint each synthetic object rectangle.
    for obj in objects:
        r_obj, g_obj, b_obj = obj.color
        # Clamp coordinates to frame bounds.
        x0 = max(0, min(obj.x_min, width))
        x1 = max(0, min(obj.x_max, width))
        y0 = max(0, min(obj.y_min, height))
        y1 = max(0, min(obj.y_max, height))
        for row in range(y0, y1):
            for col in range(x0, x1):
                base = (row * width + col) * 3
                buf[base] = r_obj
                buf[base + 1] = g_obj
                buf[base + 2] = b_obj

    return bytes(buf)


class SyntheticFrameSource:
    """Async context manager that produces synthetic camera frames for testing.

    Implements the :class:`~cobeing.layer2_perception.protocols.FrameSource`
    protocol with no hardware dependency. Each call to :meth:`get_frame`
    renders a new raw-RGB frame in memory and wraps it in a
    :class:`~cobeing.layer2_perception.types.Frame`.

    The scene is defined by a list of :class:`SyntheticObject` rectangles
    that can be updated between frames via :meth:`set_objects`. This allows
    tests to verify that the downstream tracker correctly handles objects
    appearing and disappearing.

    Args:
        width: Frame width in pixels. Default 640.
        height: Frame height in pixels. Default 480.
        session_id: Session identifier embedded in every produced
            :class:`~cobeing.layer2_perception.types.Frame`. Default
            ``"synthetic-session"``.
        objects: Initial list of :class:`SyntheticObject` specs to paint on
            each frame. ``None`` is treated as an empty list (background only).
        background_color: (R, G, B) tuple for the frame background.
            Default black ``(0, 0, 0)``.
        max_frames: Maximum number of frames to produce. Once this many
            frames have been returned by :meth:`get_frame`, subsequent calls
            return ``None``. ``None`` means unlimited.
    """

    def __init__(
        self,
        width: int = 640,
        height: int = 480,
        session_id: str = "synthetic-session",
        objects: list[SyntheticObject] | None = None,
        background_color: tuple[int, int, int] = (0, 0, 0),
        max_frames: int | None = None,
    ) -> None:
        self._width = width
        self._height = height
        self._session_id = session_id
        self._objects: list[SyntheticObject] = list(objects) if objects else []
        self._background_color = background_color
        self._max_frames = max_frames
        self._frame_sequence: int = 0

    # ------------------------------------------------------------------
    # Scene mutation
    # ------------------------------------------------------------------

    def set_objects(self, objects: list[SyntheticObject]) -> None:
        """Replace the current scene objects for all subsequent frames.

        Frames already returned are not affected. The next call to
        :meth:`get_frame` will use the new object list.

        Args:
            objects: New list of :class:`SyntheticObject` specs. An empty
                list produces background-only frames.
        """
        self._objects = list(objects)

    # ------------------------------------------------------------------
    # FrameSource protocol
    # ------------------------------------------------------------------

    async def __aenter__(self) -> "SyntheticFrameSource":
        """Enter the context manager; returns ``self``.

        No resources are acquired. The context manager exists to satisfy the
        :class:`~cobeing.layer2_perception.protocols.FrameSource` protocol
        and to allow ``SyntheticFrameSource`` to be used in ``async with``
        blocks alongside real camera sources.

        Returns:
            This :class:`SyntheticFrameSource` instance.
        """
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        """Exit the context manager; a no-op.

        No resources to release. Exceptions propagate unchanged.

        Args:
            exc_type: Exception type if the body raised, else None.
            exc_val: Exception instance if the body raised, else None.
            exc_tb: Traceback if the body raised, else None.
        """

    async def get_frame(self) -> Frame | None:
        """Generate and return the next synthetic frame.

        The frame contains a raw RGB raster with the background color filled
        across the entire image and each :class:`SyntheticObject` painted as
        a solid-color rectangle. Objects are painted in list order; later
        objects overwrite earlier ones where they overlap.

        The ``frame_sequence`` counter increments by one per call regardless
        of whether a frame is returned or ``None`` is returned due to
        ``max_frames`` being reached.

        Returns:
            A :class:`~cobeing.layer2_perception.types.Frame` with raw RGB
            bytes in ``data``, or ``None`` if ``max_frames`` has been
            exceeded.
        """
        if self._max_frames is not None and self._frame_sequence >= self._max_frames:
            return None

        sequence = self._frame_sequence
        self._frame_sequence += 1

        data = _render_frame(
            width=self._width,
            height=self._height,
            objects=self._objects,
            background_color=self._background_color,
        )

        return Frame(
            frame_id=f"synthetic-{sequence}",
            frame_sequence=sequence,
            observed_at=datetime.now(UTC),
            width=self._width,
            height=self._height,
            data=data,
            session_id=self._session_id,
        )


__all__ = [
    "SyntheticFrameSource",
    "SyntheticObject",
]

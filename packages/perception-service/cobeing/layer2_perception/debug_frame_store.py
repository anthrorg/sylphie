"""One-slot async frame buffer for the debug camera overlay.

The perception pipeline writes the latest annotated and raw JPEG frames
into this store. The MJPEG streaming endpoint reads the latest frame on
a polling basis. Only the most recent frame is kept -- older frames are
silently dropped.

Usage::

    store = DebugFrameStore()
    await store.put(annotated_jpeg, raw_jpeg)
    frame = await store.get_annotated()  # latest annotated JPEG or None
"""

from __future__ import annotations

import asyncio


class DebugFrameStore:
    """Thread-safe one-slot buffer for debug camera frames.

    Attributes:
        _frame_bytes: Latest annotated JPEG bytes, or None.
        _raw_bytes: Latest raw (unannotated) JPEG bytes, or None.
        _lock: Async lock protecting concurrent reads/writes.
    """

    def __init__(self) -> None:
        self._frame_bytes: bytes | None = None
        self._raw_bytes: bytes | None = None
        self._lock = asyncio.Lock()

    async def put(self, annotated: bytes, raw: bytes) -> None:
        """Store the latest annotated and raw JPEG frames.

        Overwrites any previously stored frame (one-slot policy).

        Args:
            annotated: JPEG bytes with debug annotations drawn.
            raw: Original JPEG bytes without annotations.
        """
        async with self._lock:
            self._frame_bytes = annotated
            self._raw_bytes = raw

    async def get_annotated(self) -> bytes | None:
        """Return the latest annotated JPEG bytes, or None if no frame yet."""
        async with self._lock:
            return self._frame_bytes

    async def get_raw(self) -> bytes | None:
        """Return the latest raw JPEG bytes, or None if no frame yet."""
        async with self._lock:
            return self._raw_bytes


__all__ = ["DebugFrameStore"]

"""Ring buffer for training samples.

Fixed-capacity FIFO buffer with thread-safe access. Supports experience replay
via mixed batching: a configurable fraction of each batch comes from random
positions in the buffer (replay), the rest from the most recent additions.
"""

from __future__ import annotations

import threading
from typing import Any

import numpy as np

import config


class DataBuffer:
    """Fixed-capacity ring buffer for training samples.

    Capacity defaults to config.REPLAY_BUFFER_SIZE (default 10000).
    All public methods are thread-safe — the training thread and the FastAPI
    request handlers both call into this object concurrently.

    Samples are stored as plain dicts. List fields from TrainingSample are
    converted to numpy arrays on insertion for efficient batch construction.
    """

    def __init__(self, capacity: int = config.REPLAY_BUFFER_SIZE) -> None:
        self._capacity = capacity
        self._buffer: list[dict[str, Any]] = [None] * capacity  # type: ignore[list-item]
        self._head: int = 0          # index where the next write goes
        self._count: int = 0         # number of valid entries currently held
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def add(self, sample: dict[str, Any]) -> None:
        """Add a training sample to the buffer, overwriting the oldest entry
        when the buffer is full.

        List fields are converted to float32 numpy arrays. All other fields
        are stored as-is.

        Args:
            sample: Dict with the same fields as TrainingSample (already
                    converted from the Pydantic model via model_dump()).
        """
        converted = _convert_to_numpy(sample)
        with self._lock:
            self._buffer[self._head] = converted
            self._head = (self._head + 1) % self._capacity
            if self._count < self._capacity:
                self._count += 1

    def sample_batch(
        self,
        batch_size: int,
        replay_fraction: float = 0.5,
    ) -> list[dict[str, Any]]:
        """Return a mixed batch of training samples.

        The batch consists of:
          - ``replay_fraction`` * batch_size samples drawn uniformly at random
            from the entire valid buffer (experience replay).
          - The remainder drawn from the most recently added samples (recency
            bias ensures the model learns from fresh experience quickly).

        If the buffer holds fewer samples than requested, all valid samples are
        returned (no repetition — caller must handle small batches).

        Args:
            batch_size: Number of samples to return.
            replay_fraction: Fraction [0, 1] of the batch that should come
                             from random replay positions.

        Returns:
            List of sample dicts. May be shorter than batch_size if the buffer
            is not yet full enough.
        """
        with self._lock:
            count = self._count
            if count == 0:
                return []

            # Collect the valid entries in insertion order for the recency slice.
            # The valid region in the circular buffer:
            #   if count < capacity: indices 0..count-1 are valid, oldest first.
            #   if count == capacity: the oldest is at _head, wrapping around.
            if count < self._capacity:
                # Buffer not yet full — valid entries are 0..(count-1).
                valid_indices = list(range(count))
            else:
                # Buffer is full — oldest entry is at self._head.
                valid_indices = [
                    (self._head + i) % self._capacity for i in range(self._capacity)
                ]

            total_available = len(valid_indices)
            actual_batch = min(batch_size, total_available)

            n_replay = int(actual_batch * replay_fraction)
            n_recent = actual_batch - n_replay

            batch: list[dict[str, Any]] = []

            # Replay slice: uniform random from all valid entries.
            if n_replay > 0:
                replay_picks = np.random.choice(total_available, size=n_replay, replace=False)
                for idx in replay_picks:
                    batch.append(self._buffer[valid_indices[idx]])

            # Recent slice: the most recent n_recent entries (end of valid_indices).
            if n_recent > 0:
                recent_indices = valid_indices[-n_recent:]
                for idx in recent_indices:
                    batch.append(self._buffer[idx])

            return batch

    # ------------------------------------------------------------------
    # Dunder helpers
    # ------------------------------------------------------------------

    def __len__(self) -> int:
        """Return the number of valid samples currently in the buffer."""
        with self._lock:
            return self._count

    @property
    def is_empty(self) -> bool:
        """True when the buffer contains no samples."""
        with self._lock:
            return self._count == 0


# ------------------------------------------------------------------
# Internal helpers
# ------------------------------------------------------------------

_LIST_FIELDS = {
    "fused_embedding",
    "drive_vector",
    "drive_deltas",
    "episodic_context",
    "response_embedding",
}


def _convert_to_numpy(sample: dict[str, Any]) -> dict[str, Any]:
    """Convert list fields in a TrainingSample dict to float32 numpy arrays.

    Non-list fields (scalars, strings, dicts) are passed through unchanged.
    None values are preserved as None.
    """
    result: dict[str, Any] = {}
    for key, value in sample.items():
        if key in _LIST_FIELDS and isinstance(value, list):
            result[key] = np.array(value, dtype=np.float32)
        else:
            result[key] = value
    return result

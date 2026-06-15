"""Ring buffer for training samples.

Fixed-capacity FIFO buffer with thread-safe access. Supports experience replay
via mixed batching: a configurable fraction of each batch comes from random
positions in the buffer (replay), the rest from the most recent additions.

Each sample carries a ``salience`` weight (default 1.0). The replay slice of a
batch is drawn with probability proportional to salience, so supervisor-injected
corrective / reinforced samples (which arrive with salience > 1.0) are
preferentially replayed rather than being diluted into the uniform pool and
evicted FIFO before they ever influence the weights. This is the mechanism that
lets a reinforce / correct / boost-salience signal actually *land* on the model
instead of being a transient, quickly-overwritten ring entry.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

import numpy as np

import config

logger = logging.getLogger("cognition_service.training.data_buffer")


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
        # Every buffered sample carries a replay-salience weight. Normal-path
        # samples (from /cognition/train) default to 1.0; reinforce / correct /
        # boost-salience override it. Stored as a plain float so sample_batch()
        # can read it without a type check.
        if converted.get("salience") is None:
            converted["salience"] = 1.0
        else:
            converted["salience"] = max(0.0, float(converted["salience"]))
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
          - ``replay_fraction`` * batch_size samples drawn from the entire valid
            buffer with probability proportional to each sample's ``salience``
            (salience-weighted experience replay). A sample injected by the
            supervisor with salience 3.0 is ~3× more likely to be drawn than a
            default salience-1.0 sample, so corrective / reinforced signal is
            preferentially trained on instead of being diluted to a uniform
            1/N chance.
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

            # Replay slice: salience-weighted random draw across all valid
            # entries. Salience defaults to 1.0; supervisor reinforce / correct
            # / boost-salience samples carry > 1.0, biasing the draw toward them.
            if n_replay > 0:
                weights = np.array(
                    [
                        float(self._buffer[gi].get("salience", 1.0) or 1.0)
                        for gi in valid_indices
                    ],
                    dtype=np.float64,
                )
                weight_sum = weights.sum()
                if weight_sum <= 0.0 or not np.isfinite(weight_sum):
                    # Degenerate weights — fall back to uniform so a bad salience
                    # value can never deadlock the training loop.
                    probs = None
                else:
                    probs = weights / weight_sum
                replay_picks = np.random.choice(
                    total_available,
                    size=n_replay,
                    replace=False,
                    p=probs,
                )
                for idx in replay_picks:
                    batch.append(self._buffer[valid_indices[int(idx)]])

            # Recent slice: the most recent n_recent entries (end of valid_indices).
            if n_recent > 0:
                recent_indices = valid_indices[-n_recent:]
                for idx in recent_indices:
                    batch.append(self._buffer[idx])

            return batch

    def snapshot_calibration(
        self,
        n_samples: int,
        stratified: bool = True,
    ) -> list[dict[str, Any]]:
        """Draw a calibration set for Fisher-information estimation (EWC).

        Unlike sample_batch(), this draws purely at random across the entire
        valid buffer (no recency bias from the ring head), which is what the
        empirical Fisher diagonal needs at a phase boundary. When ``stratified``
        is True and samples carry an ``action_category`` field, the draw is
        stratified by category so rare categories are not crowded out by the
        dominant one (recency / class-imbalance bias is the documented failure
        mode for calibration sets).

        If the buffer holds fewer than ``n_samples`` valid entries, all valid
        entries are returned (no repetition).

        Args:
            n_samples:  Target number of calibration samples.
            stratified: If True, balance the draw across action categories when
                        the field is present. Falls back to plain random draw
                        when no category field exists on the samples.

        Returns:
            List of sample dicts (the same dict objects stored in the buffer).
        """
        with self._lock:
            count = self._count
            if count == 0:
                return []

            if count < self._capacity:
                valid_indices = list(range(count))
            else:
                valid_indices = [
                    (self._head + i) % self._capacity for i in range(self._capacity)
                ]

            samples = [self._buffer[i] for i in valid_indices]

        target = min(n_samples, len(samples))
        if target == 0:
            return []

        # Determine whether stratification is possible (any sample carries a
        # usable action_category). If not, fall back to a plain random draw.
        categories = [s.get("action_category") for s in samples]
        can_stratify = stratified and any(c is not None for c in categories)

        if not can_stratify:
            picks = np.random.choice(len(samples), size=target, replace=False)
            return [samples[int(i)] for i in picks]

        # Stratified draw: bucket sample indices by category, then round-robin
        # across buckets drawing without replacement until we hit ``target``.
        buckets: dict[Any, list[int]] = {}
        for idx, cat in enumerate(categories):
            key = cat if cat is not None else "__none__"
            buckets.setdefault(key, []).append(idx)

        # Shuffle within each bucket so we don't bias toward insertion order.
        for key in buckets:
            np.random.shuffle(buckets[key])

        selected: list[int] = []
        bucket_keys = list(buckets.keys())
        np.random.shuffle(bucket_keys)
        cursor = {key: 0 for key in bucket_keys}

        # Round-robin: one sample per category per pass until target is met or
        # every bucket is exhausted.
        while len(selected) < target:
            progressed = False
            for key in bucket_keys:
                if len(selected) >= target:
                    break
                pos = cursor[key]
                if pos < len(buckets[key]):
                    selected.append(buckets[key][pos])
                    cursor[key] = pos + 1
                    progressed = True
            if not progressed:
                # Every bucket exhausted before reaching target — buffer simply
                # doesn't hold enough distinct samples. Return what we have.
                break

        return [samples[i] for i in selected]

    def add_sample(
        self,
        fused_embedding: list[float] | np.ndarray,
        drive_vector: list[float] | np.ndarray,
        drive_deltas: list[float] | np.ndarray,
        total_pressure: float,
        episodic_context: list[float] | np.ndarray,
        action_category: str | None = None,
        arbitration_type: str = "TYPE_1",
        salience: float = 1.0,
        **extra: Any,
    ) -> None:
        """Convenience constructor + add for an explicitly-componented sample.

        Used by the supervisor control endpoints (reinforce / correct) which
        inject hand-built samples rather than relaying a full TrainingSample
        from NestJS. Mirrors the field layout that _build_input_batch() and
        _build_labels() expect on the training side.

        Args:
            fused_embedding:  768-float fused multimodal embedding.
            drive_vector:     12-float drive state vector.
            drive_deltas:     12-float drive deltas.
            total_pressure:   Scalar total drive pressure.
            episodic_context: 768-float episodic context embedding.
            action_category:  Category label for the one-hot training target.
            arbitration_type: Arbitration type tag (default TYPE_1).
            salience:         Replay weight (default 1.0). Values > 1.0 make the
                              sample proportionally more likely to be drawn in
                              the replay slice of a batch — this is how a
                              reinforce / correct signal is made to land durably.
            **extra:          Any additional fields to store on the sample dict.
        """
        sample: dict[str, Any] = {
            "fused_embedding": fused_embedding,
            "drive_vector": drive_vector,
            "drive_deltas": drive_deltas,
            "total_pressure": float(total_pressure),
            "episodic_context": episodic_context,
            "action_category": action_category,
            "arbitration_type": arbitration_type,
            "salience": max(0.0, float(salience)),
        }
        sample.update(extra)
        self.add(sample)

    def boost_category_salience(
        self,
        category: str,
        multiplier: float,
        max_salience: float = 10.0,
    ) -> int:
        """Multiply the replay salience of every buffered sample of a category.

        This is the in-buffer half of the supervisor ``boost_salience``
        intervention: "pay more attention to this pattern when it recurs". It
        raises the replay-draw probability of the matching samples already in
        the buffer (capped at ``max_salience`` so one over-eager boost can't
        starve every other sample out of the replay mix).

        Args:
            category:    The action_category whose samples should be boosted
                         (matched case-insensitively, trimmed — same
                         normalisation the ActionVocabulary applies).
            multiplier:  Salience multiplier (> 0). 1.0 is a no-op; 2.0 doubles.
            max_salience: Per-sample salience ceiling after the boost.

        Returns:
            The number of buffered samples whose salience was raised.
        """
        if multiplier <= 0:
            raise ValueError(f"multiplier must be > 0, got {multiplier}")
        key = (category or "").strip().lower()
        if not key:
            return 0
        boosted = 0
        with self._lock:
            for i in range(self._capacity):
                sample = self._buffer[i]
                if sample is None:
                    continue
                cat = sample.get("action_category")
                if cat is None or str(cat).strip().lower() != key:
                    continue
                current = float(sample.get("salience", 1.0) or 1.0)
                sample["salience"] = min(max_salience, current * multiplier)
                boosted += 1
        return boosted

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

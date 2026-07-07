"""TK-121 lock discipline (pipeline item 20260702-002, DEC-33 / AD-0049).

Drives _consolidate_phase_boundary() against a REAL (non-mock) CognitiveCycle
+ Trainer + DataBuffer, with the trainer's background training loop
concurrently running (a real threading.Thread doing real forward/backward/
weight-write work under trainer._weight_lock), to prove:

  AC2 (deadlock regression): invoking the helper from a worker thread while
      the background training loop is live does not deadlock — the worker
      thread completes well within a 5s timeout. This is the direct
      regression test for the old "hold _weight_lock across both EWC calls"
      AC that the architect ruled out as a self-deadlock risk (get_weights()
      already acquires the same non-reentrant Lock internally).

  AC3 (lock scope): trainer._weight_lock.locked() is False at the moment
      compute_fisher() and set_reference() are entered, get_weights() is
      called exactly once and returns before compute_fisher() runs, and no
      new lock object is introduced anywhere in the call path.

Uses the real NumPy fallback model path (no TensorFlow required) — small
enough to construct and step in milliseconds.
"""

from __future__ import annotations

import threading
import time

import config
import numpy as np
import pytest
from inference.cycle import CognitiveCycle
from main import _consolidate_phase_boundary
from training.data_buffer import DataBuffer
from training.trainer import Trainer

_EMB = config.EMBEDDING_DIM
_DRIVE = config.DRIVE_VECTOR_DIM


def _seed_buffer(buffer: DataBuffer, n: int = 40) -> None:
    """Seed the buffer with n samples across a handful of categories."""
    rng = np.random.RandomState(7)
    categories = ["greet", "focus", "wave", "shrug"]
    for i in range(n):
        buffer.add_sample(
            fused_embedding=rng.standard_normal(_EMB).astype(np.float32),
            drive_vector=rng.standard_normal(_DRIVE).astype(np.float32),
            drive_deltas=rng.standard_normal(_DRIVE).astype(np.float32),
            total_pressure=float(rng.standard_normal()),
            episodic_context=rng.standard_normal(_EMB).astype(np.float32),
            action_category=categories[i % len(categories)],
        )


@pytest.fixture()
def live_trainer():
    """A real Trainer with its background training thread running."""
    cycle = CognitiveCycle()
    buffer = DataBuffer(capacity=256)
    _seed_buffer(buffer)
    trainer = Trainer(cycle=cycle, buffer=buffer)
    trainer.start()
    # Let the background loop take at least one real step before the test
    # body starts hammering the same trainer from another thread.
    deadline = time.monotonic() + 2.0
    while trainer.training_steps == 0 and time.monotonic() < deadline:
        time.sleep(0.01)
    try:
        yield trainer, buffer
    finally:
        trainer.stop()


def test_deadlock_regression_helper_completes_while_training_loop_is_live(live_trainer) -> None:
    """AC2: the helper must not deadlock against a live background trainer."""
    trainer, buffer = live_trainer
    assert trainer.training_steps > 0, "setup failed: background training loop never stepped"

    results: list[object] = []
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            for _ in range(5):
                results.append(_consolidate_phase_boundary(trainer, buffer))
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    t = threading.Thread(target=worker, name="consolidate-worker")
    t.start()
    t.join(timeout=5.0)

    assert not t.is_alive(), (
        "_consolidate_phase_boundary() deadlocked against the live training "
        "loop — worker thread did not complete within the 5s timeout"
    )
    assert not errors, f"worker thread raised: {errors}"
    assert len(results) == 5
    assert all(r.weights_captured for r in results)


def test_lock_scope_no_lock_held_at_compute_fisher_or_set_reference_entry(live_trainer) -> None:
    """AC3: neither compute_fisher() nor set_reference() is entered while
    trainer._weight_lock is held, and get_weights() runs exactly once, before
    compute_fisher()."""
    trainer, buffer = live_trainer

    events: list[tuple[str, bool]] = []  # (event_name, lock_locked_at_entry)
    get_weights_calls = {"count": 0}

    orig_get_weights = trainer.get_weights
    orig_compute_fisher = trainer.ewc.compute_fisher
    orig_set_reference = trainer.ewc.set_reference

    def get_weights_wrapper():
        get_weights_calls["count"] += 1
        events.append(("get_weights", trainer._weight_lock.locked()))
        return orig_get_weights()

    def compute_fisher_wrapper(model, calibration_samples, chunk_size=32):
        events.append(("compute_fisher", trainer._weight_lock.locked()))
        return orig_compute_fisher(model, calibration_samples, chunk_size)

    def set_reference_wrapper(weights):
        events.append(("set_reference", trainer._weight_lock.locked()))
        return orig_set_reference(weights)

    trainer.get_weights = get_weights_wrapper  # type: ignore[assignment]
    trainer.ewc.compute_fisher = compute_fisher_wrapper  # type: ignore[assignment]
    trainer.ewc.set_reference = set_reference_wrapper  # type: ignore[assignment]
    try:
        result = _consolidate_phase_boundary(trainer, buffer)
    finally:
        trainer.get_weights = orig_get_weights  # type: ignore[assignment]
        trainer.ewc.compute_fisher = orig_compute_fisher  # type: ignore[assignment]
        trainer.ewc.set_reference = orig_set_reference  # type: ignore[assignment]

    assert result.weights_captured is True
    assert get_weights_calls["count"] == 1, "get_weights() must be called exactly once"

    event_names = [name for name, _ in events]
    assert event_names == ["get_weights", "compute_fisher", "set_reference"], (
        f"unexpected call order: {event_names}"
    )
    for name, locked in events:
        assert locked is False, (
            f"trainer._weight_lock was held at entry to {name}() — the helper "
            "must never enter compute_fisher()/set_reference() while the "
            "lock is held (AD-0049 lock discipline)"
        )

    # No new lock object introduced: still exactly the one Lock instance the
    # Trainer constructed for itself.
    assert isinstance(trainer._weight_lock, type(threading.Lock()))

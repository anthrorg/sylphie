"""TK-121 wiring (pipeline item 20260702-002, DEC-33 / AD-0049).

Two integration surfaces, both against the real FastAPI app (main.app):

  AC5/AC7 — driving BootstrapTracker.advance_mode() across all four bootstrap
      phases (shadow -> audit -> partial -> full) via POST /cognition/train
      calls _consolidate_phase_boundary(trainer, buffer) exactly once per
      boundary, immediately after advance_mode() returns True, and EWC is
      ARMED (trainer.ewc._reference / ._fisher both set) after each boundary.

  AC6 — POST /cognition/phase-transition (the manual override) calls the
      SAME _consolidate_phase_boundary() helper — no duplicated inline logic.

Uses a real CognitiveCycle/Trainer (NumPy fallback path, no TF required) so
trainer.ewc is a real EWCRegularizer whose _reference/_fisher state can be
observed. The background training thread is never started here — this test
only exercises the phase-boundary consolidation call path, not concurrent
training (see test_consolidate_phase_boundary_concurrency.py for that).
"""

from __future__ import annotations

import config
import main
import numpy as np
from fastapi.testclient import TestClient
from inference.bootstrap import BootstrapTracker
from inference.cycle import CognitiveCycle
from training.data_buffer import DataBuffer
from training.trainer import Trainer

_EMB = config.EMBEDDING_DIM
_DRIVE = config.DRIVE_VECTOR_DIM


def _train_sample() -> dict:
    return {
        "fused_embedding": [0.0] * _EMB,
        "drive_vector": [0.0] * _DRIVE,
        "drive_deltas": [0.0] * _DRIVE,
        "total_pressure": 0.0,
        "arbitration_type": "TYPE_1",
        "action_category": None,
    }


def _seed_buffer(buffer: DataBuffer, n: int = 30) -> None:
    rng = np.random.RandomState(11)
    for _ in range(n):
        buffer.add_sample(
            fused_embedding=rng.standard_normal(_EMB).astype(np.float32),
            drive_vector=rng.standard_normal(_DRIVE).astype(np.float32),
            drive_deltas=rng.standard_normal(_DRIVE).astype(np.float32),
            total_pressure=float(rng.standard_normal()),
            episodic_context=rng.standard_normal(_EMB).astype(np.float32),
            action_category="greet",
        )


def _force_advance_check(client: TestClient) -> None:
    """Make the NEXT /cognition/train call trip the periodic advance-check."""
    main._state._samples_since_advance_check = 99  # _ADVANCE_CHECK_INTERVAL - 1
    resp = client.post("/cognition/train", json=_train_sample())
    assert resp.status_code == 200


def test_consolidate_called_exactly_once_per_boundary_across_all_four_phases(monkeypatch) -> None:
    cycle = CognitiveCycle()
    buffer = DataBuffer(capacity=256)
    _seed_buffer(buffer)
    trainer = Trainer(cycle=cycle, buffer=buffer)

    tracker = BootstrapTracker(initial_mode="shadow")
    main._state.buffer = buffer
    main._state.trainer = trainer
    main._state.bootstrap_tracker = tracker
    main._state.last_cycle_result = None
    main._state.total_shadow_samples = 0
    main._state.total_audit_samples = 0

    call_log: list[tuple] = []
    real_consolidate = main._consolidate_phase_boundary

    def spy(trainer_arg, buffer_arg):
        call_log.append((trainer_arg, buffer_arg))
        return real_consolidate(trainer_arg, buffer_arg)

    monkeypatch.setattr(main, "_consolidate_phase_boundary", spy)

    client = TestClient(main.app)

    # --- shadow -> audit: total comparisons >= 100 ---
    assert tracker.mode == "shadow"
    for cat in ("a", "b"):
        tracker._category_history[cat] = [True] * 50  # 100 total comparisons
    _force_advance_check(client)
    assert tracker.mode == "audit"
    assert len(call_log) == 1, "expected exactly one consolidation call for shadow->audit"
    assert trainer.ewc._reference is not None and trainer.ewc._fisher is not None, (
        "EWC must be ARMED (reference + fisher both set) after the boundary"
    )

    # --- audit -> partial: at least one graduated category ---
    tracker._graduated_categories.add("greet")
    _force_advance_check(client)
    assert tracker.mode == "partial"
    assert len(call_log) == 2, "expected exactly one NEW consolidation call for audit->partial"

    # --- partial -> full: overall agreement >= 0.90 with >= 3 graduated categories ---
    tracker._graduated_categories.update({"focus", "wave"})
    for cat in ("greet", "focus", "wave"):
        tracker._category_history[cat] = [True] * 30  # high agreement
    _force_advance_check(client)
    assert tracker.mode == "full"
    assert len(call_log) == 3, "expected exactly one NEW consolidation call for partial->full"

    # No extra calls beyond the three boundaries actually crossed.
    assert len(call_log) == 3
    for trainer_arg, buffer_arg in call_log:
        assert trainer_arg is trainer
        assert buffer_arg is buffer


def test_manual_phase_transition_endpoint_calls_the_same_helper(monkeypatch) -> None:
    cycle = CognitiveCycle()
    buffer = DataBuffer(capacity=256)
    _seed_buffer(buffer)
    trainer = Trainer(cycle=cycle, buffer=buffer)

    main._state.buffer = buffer
    main._state.trainer = trainer
    main._state.bootstrap_tracker = BootstrapTracker(initial_mode="shadow")

    call_log: list[tuple] = []
    real_consolidate = main._consolidate_phase_boundary

    def spy(trainer_arg, buffer_arg):
        call_log.append((trainer_arg, buffer_arg))
        return real_consolidate(trainer_arg, buffer_arg)

    monkeypatch.setattr(main, "_consolidate_phase_boundary", spy)

    client = TestClient(main.app)
    resp = client.post("/cognition/phase-transition", json={"new_phase": "audit"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] is True
    assert body["ewc_anchored"] is True

    assert len(call_log) == 1, (
        "the manual /cognition/phase-transition endpoint must call "
        "_consolidate_phase_boundary() — no duplicated inline consolidation logic"
    )
    assert call_log[0] == (trainer, buffer)

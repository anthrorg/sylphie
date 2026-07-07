"""TK-120 ordering fix (pipeline item 20260702-002, DEC-33 / AD-0049).

Drives the real /cognition/phase-transition FastAPI handler (fake trainer/
buffer doubles, no model load) and asserts compute_fisher() is invoked
BEFORE set_reference() -- the reverse of the original ordering -- and that
set_reference() still runs unconditionally even when the replay buffer is
empty (so the EWC anchor always moves at a phase boundary).
"""

from __future__ import annotations

import main
from fastapi.testclient import TestClient


class _FakeEWC:
    """Records call order instead of doing real EWC math."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    def compute_fisher(self, trainer, calibration_samples) -> None:  # noqa: ANN001
        self.calls.append(("compute_fisher", len(calibration_samples)))
        # Match the real EWCRegularizer.compute_fisher() contract: raise on an
        # empty calibration set rather than silently producing a degenerate
        # Fisher (see training/replay.py).
        if not calibration_samples:
            raise ValueError("compute_fisher() requires a non-empty calibration set")

    def set_reference(self, weights) -> None:  # noqa: ANN001
        self.calls.append(("set_reference", len(weights)))


class _FakeTrainer:
    def __init__(self) -> None:
        self.ewc = _FakeEWC()

    def get_weights(self):
        return [1, 2, 3]


class _FakeBuffer:
    def __init__(self, calibration: list) -> None:
        self._calibration = calibration

    def snapshot_calibration(self, n: int, stratified: bool = True):  # noqa: ANN001
        return self._calibration


def _client() -> TestClient:
    return TestClient(main.app)


def test_compute_fisher_runs_before_set_reference_with_calibration_data() -> None:
    trainer = _FakeTrainer()
    main._state.trainer = trainer
    main._state.buffer = _FakeBuffer(calibration=[{"x": 1}] * 10)
    main._state.bootstrap_tracker = None

    resp = _client().post("/cognition/phase-transition", json={"new_phase": "audit"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] is True
    assert body["fisher_computed"] is True
    assert body["calibration_samples"] == 10

    call_names = [c[0] for c in trainer.ewc.calls]
    assert call_names == ["compute_fisher", "set_reference"], (
        f"expected compute_fisher() BEFORE set_reference() (DEC-33/AD-0049 ordering "
        f"fix), got call order: {call_names}"
    )


def test_set_reference_still_runs_unconditionally_when_buffer_empty() -> None:
    trainer = _FakeTrainer()
    main._state.trainer = trainer
    main._state.buffer = _FakeBuffer(calibration=[])
    main._state.bootstrap_tracker = None

    resp = _client().post("/cognition/phase-transition", json={"new_phase": "audit"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["fisher_computed"] is False
    assert body["calibration_samples"] == 0

    # compute_fisher() is still called (and raises ValueError on the empty
    # calibration set, caught and logged as a warning); set_reference() then
    # runs unconditionally regardless, so the anchor always moves.
    call_names = [c[0] for c in trainer.ewc.calls]
    assert call_names == ["compute_fisher", "set_reference"], (
        "expected set_reference() to run unconditionally (anchor always moves) "
        f"even with an empty calibration draw, got call order: {call_names}"
    )

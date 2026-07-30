"""TK-120 demotion wiring (pipeline item 20260702-002).

check_demotions() must be called from the SAME guarded block in
POST /cognition/train that already calls check_graduations() -- on the same
call, only when the existing bootstrap-comparison preconditions are met --
not on every /cognition/train call unconditionally.
"""

from __future__ import annotations

import config
import main
from fastapi.testclient import TestClient
from inference.bootstrap import BootstrapTracker
from schemas import CognitionCycleResponse, GlobalPrior
from training.data_buffer import DataBuffer

_EMB = config.EMBEDDING_DIM
_DRIVE = config.DRIVE_VECTOR_DIM


def _sample(action_category: str | None) -> dict:
    return {
        "fused_embedding": [0.0] * _EMB,
        "drive_vector": [0.0] * _DRIVE,
        "drive_deltas": [0.0] * _DRIVE,
        "total_pressure": 0.0,
        "arbitration_type": "TYPE_1",
        "action_category": action_category,
    }


def _cycle_result(tensor_top_category: str | None) -> CognitionCycleResponse:
    return CognitionCycleResponse(
        global_prior=GlobalPrior(
            action_bias=[0.0] * config.ACTION_SPACE_DIM, urgency=0.0, novelty_score=0.0,
        ),
        tensor_top_category=tensor_top_category,
    )


def _reset_state(tracker: BootstrapTracker) -> None:
    main._state.buffer = DataBuffer(capacity=256)
    main._state.trainer = None  # untouched by this code path
    main._state.bootstrap_tracker = tracker
    main._state.total_shadow_samples = 0
    main._state.total_audit_samples = 0
    main._state._samples_since_advance_check = 0


def test_check_demotions_fires_alongside_check_graduations() -> None:
    tracker = BootstrapTracker(initial_mode="partial")
    _reset_state(tracker)
    client = TestClient(main.app)

    # Graduate "greet" with 20 agreeing samples (tensor top category == LLM's).
    for _ in range(20):
        main._state.last_cycle_result = _cycle_result("greet")
        resp = client.post("/cognition/train", json=_sample("greet"))
        assert resp.status_code == 200
    assert "greet" in tracker._graduated_categories

    # Flood 80 disagreements: 20 agrees / 100-sample window = 0.20 < 0.70.
    for _ in range(80):
        main._state.last_cycle_result = _cycle_result("other")
        resp = client.post("/cognition/train", json=_sample("greet"))
        assert resp.status_code == 200

    # check_demotions() ran alongside check_graduations() on that same call --
    # no separate trigger or polling loop needed.
    assert "greet" not in tracker._graduated_categories


def test_check_demotions_not_wired_unconditionally() -> None:
    """When the guard's preconditions aren't met, check_demotions() must NOT run.

    Manually push a graduated category below the demotion threshold via direct
    tracker calls (bypassing the guarded block), then hit /cognition/train
    WITHOUT a last_cycle_result set (the guard's precondition) and confirm the
    category is untouched -- proving check_demotions() is gated by the same
    block as check_graduations(), not called on every request.
    """
    tracker = BootstrapTracker(initial_mode="partial")
    _reset_state(tracker)
    client = TestClient(main.app)

    for _ in range(20):
        tracker.record_comparison("greet", "greet")
    assert "greet" in tracker.check_graduations()
    for _ in range(80):
        tracker.record_comparison("other", "greet")  # agreement now 0.20

    # No last_cycle_result set -> the guarded block's precondition fails ->
    # check_demotions() must not be reached by this request.
    main._state.last_cycle_result = None
    resp = client.post("/cognition/train", json=_sample("greet"))
    assert resp.status_code == 200

    assert "greet" in tracker._graduated_categories, (
        "check_demotions() ran even though the guarded block's precondition "
        "(last_cycle_result present) was not met"
    )

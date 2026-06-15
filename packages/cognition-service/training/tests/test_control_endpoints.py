"""Endpoint-level tests for the supervisor control path (cluster 3b).

Drives the real FastAPI handlers for /cognition/control/{reinforce,correct,
boost_salience} against a bare DataBuffer (no model load), asserting that the
injected signal actually lands in the buffer with the expected salience — i.e.
the final reinforcement step is no longer a no-op.
"""

from __future__ import annotations

import config
import main
from fastapi.testclient import TestClient
from training.data_buffer import DataBuffer

_DIM = config.GLOBAL_INPUT_DIM


def _client_with_buffer() -> tuple[TestClient, DataBuffer]:
    buf = DataBuffer(capacity=128)
    main._state.buffer = buf
    main._state.trainer = None  # correct's zero_pending hook is guarded on this
    return TestClient(main.app), buf


def _input_vector() -> list[float]:
    return [0.0] * _DIM


def test_reinforce_lands_in_buffer_with_elevated_salience() -> None:
    client, buf = _client_with_buffer()
    resp = client.post(
        "/cognition/control/reinforce",
        json={"actionId": "wave", "inputVector": _input_vector(), "strengthFactor": 1.0},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] is True
    assert body["injected"] >= 1
    assert body["salience"] > 1.0  # the landing signal: elevated replay weight

    drained = buf.sample_batch(batch_size=128, replay_fraction=1.0)
    waves = [s for s in drained if s["action_category"] == "wave"]
    assert len(waves) == body["injected"]
    assert all(s["salience"] == body["salience"] for s in waves)


def test_correct_lands_corrective_label_with_high_salience() -> None:
    client, buf = _client_with_buffer()
    resp = client.post(
        "/cognition/control/correct",
        json={
            "actionId": "wrong_action",
            "inputVector": _input_vector(),
            "correctCategory": "right_action",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["correct_category"] == "right_action"

    drained = buf.sample_batch(batch_size=128, replay_fraction=1.0)
    # The corrective label is what's buffered, not the wrong action.
    assert all(s["action_category"] == "right_action" for s in drained)
    assert all(s["salience"] > 1.0 for s in drained)


def test_boost_salience_endpoint_raises_buffered_pattern() -> None:
    client, buf = _client_with_buffer()
    # Pre-load two samples of the pattern at default salience via the buffer.
    for _ in range(2):
        buf.add_sample(
            action_category="focus",
            salience=1.0,
            fused_embedding=[0.0] * 768,
            drive_vector=[0.0] * 12,
            drive_deltas=[0.0] * 12,
            total_pressure=0.0,
            episodic_context=[0.0] * 768,
        )

    resp = client.post(
        "/cognition/control/boost_salience",
        json={"category": "focus", "multiplier": 3.0},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] is True
    assert body["boosted"] == 2

    drained = buf.sample_batch(batch_size=128, replay_fraction=1.0)
    focus = [s for s in drained if s["action_category"] == "focus"]
    assert all(s["salience"] == 3.0 for s in focus)


def test_boost_salience_with_seed_vector_injects() -> None:
    client, buf = _client_with_buffer()
    resp = client.post(
        "/cognition/control/boost_salience",
        json={"category": "rare", "multiplier": 4.0, "inputVector": _input_vector()},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["injected"] == 1
    # The seeded sample is itself boosted (boost runs after the inject).
    drained = buf.sample_batch(batch_size=128, replay_fraction=1.0)
    rare = [s for s in drained if s["action_category"] == "rare"]
    assert len(rare) == 1
    assert rare[0]["salience"] > 1.0


def test_boost_salience_rejects_empty_category() -> None:
    client, _ = _client_with_buffer()
    resp = client.post(
        "/cognition/control/boost_salience",
        json={"category": "  ", "multiplier": 2.0},
    )
    assert resp.status_code == 400


def test_reinforce_rejects_bad_dimensionality() -> None:
    client, _ = _client_with_buffer()
    resp = client.post(
        "/cognition/control/reinforce",
        json={"actionId": "x", "inputVector": [0.0] * 10, "strengthFactor": 1.0},
    )
    assert resp.status_code == 400

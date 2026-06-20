"""Tests for ConvergenceModel use_learned graduation criterion (TK-41 / EP8-4).

Acceptance criteria:
  AC1: Given >=1000 samples AND proxy_accuracy >=0.80 (where accuracy is
       1 - |learned_divergence - heuristic_divergence|), when a training step
       runs, then use_learned flips True; INFO is logged.
  AC2: Given <1000 samples, use_learned stays False regardless of accuracy.
       A persisted True survives save/load (restart simulation).

Run from the package root:
    cd packages/cognition-service && python -m pytest models/tests/test_convergence_graduation.py
"""

from __future__ import annotations

import logging
import os
import tempfile
from dataclasses import dataclass
from unittest.mock import patch

import numpy as np
import pytest

from models.convergence import ConvergenceModel, DEFAULT_CONSENSUS_THRESHOLD


# ---------------------------------------------------------------------------
# Minimal panel stub
# ---------------------------------------------------------------------------

@dataclass
class _FakePanel:
    """Minimal PanelOutput stub with just the fields ConvergenceModel needs."""
    panel_name: str
    action_bias: list[float]


def _make_global_bias(seed: int = 0) -> list[float]:
    """Return a normalized 32-dim action bias vector."""
    rng = np.random.RandomState(seed)
    v = rng.standard_normal(32).astype(np.float32)
    # Normalise so cosine similarity is well-defined.
    v = v / (np.linalg.norm(v) + 1e-8)
    return v.tolist()


def _make_panel(name: str, seed: int = 1) -> _FakePanel:
    rng = np.random.RandomState(seed)
    v = rng.standard_normal(32).astype(np.float32)
    v = v / (np.linalg.norm(v) + 1e-8)
    return _FakePanel(panel_name=name, action_bias=v.tolist())


# ---------------------------------------------------------------------------
# Helpers to manipulate the graduation criterion
# ---------------------------------------------------------------------------

def _patch_learned_divergence(model: ConvergenceModel, value: float):
    """Context manager: force _predict_learned to return a fixed value."""
    return patch.object(model, "_predict_learned", return_value=value)


def _run_check(model: ConvergenceModel, global_bias=None, panels=None):
    """Single call to model.check() with reasonable defaults."""
    if global_bias is None:
        global_bias = _make_global_bias(0)
    if panels is None:
        panels = [_make_panel("p0", seed=1)]
    return model.check(global_bias, panels)


# ---------------------------------------------------------------------------
# AC1 — graduation flips use_learned after >=1000 samples with accuracy >=0.80
# ---------------------------------------------------------------------------

def test_graduation_flips_use_learned(caplog: pytest.LogCaptureFixture) -> None:
    """AC1: use_learned becomes True once sample count and accuracy both pass."""
    model = ConvergenceModel()
    assert model.use_learned is False
    assert model.convergence_sample_count == 0

    global_bias = _make_global_bias(0)
    panels = [_make_panel("p0", seed=1)]

    # Compute what heuristic divergence will be for this input so we can set
    # a learned value close enough to meet the 0.80 proxy accuracy threshold.
    p_arr = np.array(panels[0].action_bias, dtype=np.float32)
    g_arr = np.array(global_bias, dtype=np.float32)
    cos_sim = float(np.dot(g_arr, p_arr) / (np.linalg.norm(g_arr) * np.linalg.norm(p_arr)))
    heuristic = 1.0 - cos_sim
    # learned divergence within 0.19 of heuristic → proxy_accuracy >= 0.81
    high_accuracy_learned = heuristic + 0.10

    # Run 999 checks with high-accuracy learned values — should NOT graduate yet.
    with _patch_learned_divergence(model, high_accuracy_learned):
        for _ in range(999):
            _run_check(model, global_bias, panels)

    assert model.use_learned is False
    assert model.convergence_sample_count == 999

    # The 1000th check should trigger graduation.
    with caplog.at_level(logging.INFO, logger="cognition_service.convergence"):
        with _patch_learned_divergence(model, high_accuracy_learned):
            _run_check(model, global_bias, panels)

    assert model.use_learned is True
    assert model.convergence_sample_count == 1000
    assert any(
        "graduated to learned mode" in r.message
        for r in caplog.records
        if r.levelno == logging.INFO
    ), "Expected INFO log about graduation"


def test_after_graduation_output_uses_learned_divergence() -> None:
    """AC1: After graduation, check() returns the learned divergence score."""
    model = ConvergenceModel()

    global_bias = _make_global_bias(0)
    panels = [_make_panel("p0", seed=1)]

    p_arr = np.array(panels[0].action_bias, dtype=np.float32)
    g_arr = np.array(global_bias, dtype=np.float32)
    cos_sim = float(np.dot(g_arr, p_arr) / (np.linalg.norm(g_arr) * np.linalg.norm(p_arr)))
    heuristic = 1.0 - cos_sim
    learned_value = heuristic + 0.10  # within 0.20 → proxy_accuracy >= 0.80

    # Get to exactly 1000 samples so the next call graduates.
    with _patch_learned_divergence(model, learned_value):
        for _ in range(1000):
            _run_check(model, global_bias, panels)

    assert model.use_learned is True

    # After graduation, the output divergence_score should match the learned path.
    known_learned = 0.42
    with _patch_learned_divergence(model, known_learned):
        result = _run_check(model, global_bias, panels)

    assert abs(result.divergence_score - known_learned) < 1e-5


# ---------------------------------------------------------------------------
# AC2 — <1000 samples: use_learned stays False
# ---------------------------------------------------------------------------

def test_no_graduation_below_1000_samples() -> None:
    """AC2: Even with perfect proxy accuracy, <1000 samples cannot graduate."""
    model = ConvergenceModel()

    global_bias = _make_global_bias(0)
    panels = [_make_panel("p0", seed=1)]

    p_arr = np.array(panels[0].action_bias, dtype=np.float32)
    g_arr = np.array(global_bias, dtype=np.float32)
    cos_sim = float(np.dot(g_arr, p_arr) / (np.linalg.norm(g_arr) * np.linalg.norm(p_arr)))
    heuristic = 1.0 - cos_sim
    # Perfect accuracy: learned == heuristic → proxy_accuracy = 1.0
    with _patch_learned_divergence(model, heuristic):
        for _ in range(999):
            _run_check(model, global_bias, panels)

    assert model.use_learned is False
    assert model.convergence_sample_count == 999


def test_no_graduation_below_accuracy_threshold() -> None:
    """AC2 (accuracy guard): >=1000 samples but bad accuracy → no graduation."""
    model = ConvergenceModel()

    global_bias = _make_global_bias(0)
    panels = [_make_panel("p0", seed=1)]

    p_arr = np.array(panels[0].action_bias, dtype=np.float32)
    g_arr = np.array(global_bias, dtype=np.float32)
    cos_sim = float(np.dot(g_arr, p_arr) / (np.linalg.norm(g_arr) * np.linalg.norm(p_arr)))
    heuristic = 1.0 - cos_sim
    # Learned divergence 0.25 away → proxy_accuracy = 0.75 < 0.80
    bad_learned = heuristic + 0.25
    bad_learned = max(0.0, min(1.0, bad_learned))  # clamp to [0,1]

    with _patch_learned_divergence(model, bad_learned):
        for _ in range(1000):
            _run_check(model, global_bias, panels)

    assert model.use_learned is False


# ---------------------------------------------------------------------------
# AC2 — persisted True survives save/load (restart simulation)
# ---------------------------------------------------------------------------

def test_use_learned_persists_across_save_load() -> None:
    """AC2: A graduated use_learned=True survives save() and load() (restart)."""
    model = ConvergenceModel()
    # Force use_learned to True directly, simulating post-graduation state.
    model.use_learned = True
    model.convergence_sample_count = 1500

    with tempfile.TemporaryDirectory() as tmpdir:
        model.save(tmpdir)

        # Simulate restart: fresh model, then load from disk.
        reloaded = ConvergenceModel()
        assert reloaded.use_learned is False  # sanity: starts False
        ok = reloaded.load(tmpdir)

    assert ok is True
    assert reloaded.use_learned is True
    assert reloaded.convergence_sample_count == 1500


def test_sample_count_persists_across_save_load() -> None:
    """Sample count survives a checkpoint cycle (used for graduation after restart)."""
    model = ConvergenceModel()
    model.convergence_sample_count = 750

    with tempfile.TemporaryDirectory() as tmpdir:
        model.save(tmpdir)
        reloaded = ConvergenceModel()
        reloaded.load(tmpdir)

    assert reloaded.convergence_sample_count == 750
    assert reloaded.use_learned is False  # not yet graduated


def test_old_checkpoint_without_sample_count_defaults_to_zero() -> None:
    """Backward compat: old NPZ without convergence_sample_count loads cleanly."""
    model = ConvergenceModel()
    with tempfile.TemporaryDirectory() as tmpdir:
        # Write an NPZ without the new key to simulate an older checkpoint.
        path = os.path.join(tmpdir, "convergence_model.npz")
        np.savez(
            path,
            w1=model.w1, b1=model.b1,
            w_div=model.w_div, b_div=model.b_div,
            use_learned=np.array([False]),
            # No convergence_sample_count key
        )
        reloaded = ConvergenceModel()
        reloaded.load(tmpdir)

    assert reloaded.convergence_sample_count == 0
    assert reloaded.use_learned is False


# ---------------------------------------------------------------------------
# Graduation does not fire repeatedly
# ---------------------------------------------------------------------------

def test_graduation_fires_exactly_once(caplog: pytest.LogCaptureFixture) -> None:
    """use_learned only flips once; the graduation log only appears once."""
    model = ConvergenceModel()

    global_bias = _make_global_bias(0)
    panels = [_make_panel("p0", seed=1)]

    p_arr = np.array(panels[0].action_bias, dtype=np.float32)
    g_arr = np.array(global_bias, dtype=np.float32)
    cos_sim = float(np.dot(g_arr, p_arr) / (np.linalg.norm(g_arr) * np.linalg.norm(p_arr)))
    heuristic = 1.0 - cos_sim
    high_accuracy_learned = heuristic + 0.05

    with caplog.at_level(logging.INFO, logger="cognition_service.convergence"):
        with _patch_learned_divergence(model, high_accuracy_learned):
            for _ in range(1100):
                _run_check(model, global_bias, panels)

    graduation_logs = [
        r for r in caplog.records
        if "graduated to learned mode" in r.message and r.levelno == logging.INFO
    ]
    assert len(graduation_logs) == 1, (
        f"Expected exactly 1 graduation log, got {len(graduation_logs)}"
    )
    assert model.use_learned is True

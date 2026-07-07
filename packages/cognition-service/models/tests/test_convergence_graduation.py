"""Tests for ConvergenceModel.use_learned (TK-41 / EP8-4, SUPERSEDED by TK-122).

TK-41's original graduation criterion (use_learned flips True after >=1000
samples with proxy_accuracy >= 0.80 against an untrained random head) was
hard-disabled by DEC-33 / AD-0050 (pipeline item 20260702-002, TK-122) — a
single lucky proxy-accuracy sample against a head that was never actually
trained is not a safe graduation signal, and routing real decisions through
it was a theater-prohibition violation. This file now tests the hard-disable
at both writers instead of the old graduation behavior:

  AC1: use_learned can never be set True by check(), regardless of sample
       count or proxy accuracy — asserted across 1000+ calls.
  AC2: load()'ing a checkpoint with a persisted use_learned=True forces it
       back to False (with a WARNING logged); the checkpoint file itself is
       left unmodified (load() stays read-only) and self-heals on the next
       save().
  AC3: After a forced-True-then-loaded-False checkpoint, check() resolves to
       the heuristic divergence path (not _predict_learned()'s output).

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

from models.convergence import ConvergenceModel


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
    v = v / (np.linalg.norm(v) + 1e-8)
    return v.tolist()


def _make_panel(name: str, seed: int = 1) -> _FakePanel:
    rng = np.random.RandomState(seed)
    v = rng.standard_normal(32).astype(np.float32)
    v = v / (np.linalg.norm(v) + 1e-8)
    return _FakePanel(panel_name=name, action_bias=v.tolist())


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
# AC1 — use_learned can never be flipped True by check(), at any sample
# count or proxy accuracy (DEC-33 / AD-0050 hard-disable)
# ---------------------------------------------------------------------------

def test_use_learned_stays_false_even_with_high_accuracy_past_1000_samples() -> None:
    """AC1: >=1000 samples + proxy_accuracy that would have cleared 0.80 -> still False."""
    model = ConvergenceModel()
    assert model.use_learned is False
    assert model.convergence_sample_count == 0

    global_bias = _make_global_bias(0)
    panels = [_make_panel("p0", seed=1)]

    p_arr = np.array(panels[0].action_bias, dtype=np.float32)
    g_arr = np.array(global_bias, dtype=np.float32)
    cos_sim = float(np.dot(g_arr, p_arr) / (np.linalg.norm(g_arr) * np.linalg.norm(p_arr)))
    heuristic = 1.0 - cos_sim
    # Would have cleared the old 0.80 proxy-accuracy threshold (accuracy ~0.90).
    high_accuracy_learned = heuristic + 0.10

    with _patch_learned_divergence(model, high_accuracy_learned):
        for _ in range(1100):
            _run_check(model, global_bias, panels)

    assert model.convergence_sample_count == 1100
    assert model.use_learned is False, (
        "use_learned must be hard-disabled (DEC-33/AD-0050) — it must never "
        "flip True regardless of sample count or proxy accuracy"
    )


def test_check_output_always_uses_heuristic_divergence_not_learned() -> None:
    """AC1/AC3: check() always resolves to the heuristic path, never _predict_learned()."""
    model = ConvergenceModel()

    global_bias = _make_global_bias(0)
    panels = [_make_panel("p0", seed=1)]

    p_arr = np.array(panels[0].action_bias, dtype=np.float32)
    g_arr = np.array(global_bias, dtype=np.float32)
    cos_sim = float(np.dot(g_arr, p_arr) / (np.linalg.norm(g_arr) * np.linalg.norm(p_arr)))
    heuristic = 1.0 - cos_sim

    # Even with a wildly different "learned" value, output must match heuristic.
    with _patch_learned_divergence(model, 0.999):
        result = _run_check(model, global_bias, panels)

    assert abs(result.divergence_score - heuristic) < 1e-5
    assert model.use_learned is False


def test_disablement_logged_once_at_construction(caplog: pytest.LogCaptureFixture) -> None:
    """AC1: the hard-disable is logged with an explicit reason."""
    with caplog.at_level(logging.WARNING, logger="cognition_service.convergence"):
        ConvergenceModel()

    disable_logs = [
        r for r in caplog.records
        if "use_learned" in r.message and "hard-disabled" in r.message
    ]
    assert disable_logs, "Expected a WARNING logging the use_learned hard-disable reason"


# ---------------------------------------------------------------------------
# AC2 — a persisted use_learned=True checkpoint is forced back to False on load()
# ---------------------------------------------------------------------------

def test_persisted_use_learned_true_is_overridden_to_false_on_load(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """AC2: load() forces use_learned=False even when the checkpoint says True."""
    model = ConvergenceModel()
    # Simulate a pre-TK-122 checkpoint that had graduated.
    model.use_learned = True
    model.convergence_sample_count = 1500

    with tempfile.TemporaryDirectory() as tmpdir:
        model.save(tmpdir)

        reloaded = ConvergenceModel()
        assert reloaded.use_learned is False  # sanity: starts False

        with caplog.at_level(logging.WARNING, logger="cognition_service.convergence"):
            ok = reloaded.load(tmpdir)

    assert ok is True
    assert reloaded.use_learned is False, (
        "load() must force use_learned=False regardless of the persisted "
        "value (DEC-33/AD-0050) — a graduated checkpoint must NOT survive"
    )
    assert reloaded.convergence_sample_count == 1500  # sample count itself is unaffected

    override_logs = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "use_learned=True" in r.message
    ]
    assert override_logs, "Expected a WARNING logging the override of a persisted True flag"


def test_load_does_not_rewrite_checkpoint_file() -> None:
    """AC2: load() is read-only -- the on-disk flag is left as-is (self-heals on save())."""
    model = ConvergenceModel()
    model.use_learned = True

    with tempfile.TemporaryDirectory() as tmpdir:
        model.save(tmpdir)
        path = os.path.join(tmpdir, "convergence_model.npz")
        before_mtime = os.path.getmtime(path)
        before_bytes = open(path, "rb").read()

        reloaded = ConvergenceModel()
        reloaded.load(tmpdir)

        after_mtime = os.path.getmtime(path)
        after_bytes = open(path, "rb").read()

    assert reloaded.use_learned is False
    assert before_mtime == after_mtime, "load() must not touch the checkpoint file on disk"
    assert before_bytes == after_bytes

    # Self-heals the next time save() runs.
    with tempfile.TemporaryDirectory() as tmpdir2:
        reloaded.save(tmpdir2)
        healed = ConvergenceModel()
        healed.load(tmpdir2)
        assert healed.use_learned is False


def test_sample_count_persists_across_save_load() -> None:
    """Sample count survives a checkpoint cycle (diagnostic only now, no graduation gate)."""
    model = ConvergenceModel()
    model.convergence_sample_count = 750

    with tempfile.TemporaryDirectory() as tmpdir:
        model.save(tmpdir)
        reloaded = ConvergenceModel()
        reloaded.load(tmpdir)

    assert reloaded.convergence_sample_count == 750
    assert reloaded.use_learned is False


def test_old_checkpoint_without_sample_count_defaults_to_zero() -> None:
    """Backward compat: old NPZ without convergence_sample_count loads cleanly."""
    model = ConvergenceModel()
    with tempfile.TemporaryDirectory() as tmpdir:
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


def test_old_checkpoint_with_persisted_false_loads_false_without_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A checkpoint that was already False loads cleanly with no override warning."""
    model = ConvergenceModel()
    assert model.use_learned is False

    with tempfile.TemporaryDirectory() as tmpdir:
        model.save(tmpdir)
        reloaded = ConvergenceModel()
        with caplog.at_level(logging.WARNING, logger="cognition_service.convergence"):
            reloaded.load(tmpdir)

    assert reloaded.use_learned is False
    override_logs = [r for r in caplog.records if "use_learned=True" in r.message]
    assert not override_logs, "No override warning expected when the persisted flag was already False"

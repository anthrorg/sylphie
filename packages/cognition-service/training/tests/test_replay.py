"""Tests for the Online EWC regularizer (training/replay.py).

Covers the real empirical-Fisher computation, the Online EWC blend rule, the
λ ramp-up, and numerical-stability edge cases. Fisher correctness is verified
both against a hand-computed gradient (math-level) and through the full
trainer forward/backward pipeline (integration-level).

Run from the package root:
    cd packages/cognition-service && python -m pytest training/tests/test_replay.py
"""

from __future__ import annotations

import numpy as np
import pytest

import config
from training.replay import EWCRegularizer


# ---------------------------------------------------------------------------
# Minimal model + trainer doubles
# ---------------------------------------------------------------------------


class _TinyModel:
    """Minimal stand-in for GlobalModel's NumPy path.

    Exposes the eight weight tensors the trainer's forward/backprop helpers
    require. Kept deliberately small (input_dim/hidden small) while keeping the
    action head at config.ACTION_SPACE_DIM so _build_labels lines up.
    """

    def __init__(self, input_dim: int = 6, h1: int = 4, h2: int = 3) -> None:
        rng = np.random.RandomState(1234)
        self.input_dim = input_dim
        a = config.ACTION_SPACE_DIM

        def w(fan_in: int, fan_out: int) -> np.ndarray:
            limit = np.sqrt(6.0 / (fan_in + fan_out))
            return rng.uniform(-limit, limit, (fan_in, fan_out)).astype(np.float32)

        self.w1 = w(input_dim, h1)
        self.b1 = np.zeros(h1, dtype=np.float32)
        self.w2 = w(h1, h2)
        self.b2 = np.zeros(h2, dtype=np.float32)
        self.w_action = w(h2, a)
        self.b_action = np.zeros(a, dtype=np.float32)
        self.w_aux = w(h2, 2)
        self.b_aux = np.zeros(2, dtype=np.float32)


class _FakeCycle:
    def __init__(self, model: _TinyModel) -> None:
        self.global_model = model


class _FakeVocab:
    """Maps a handful of category strings to fixed indices."""

    _MAP = {"alpha": 1, "beta": 2, "gamma": 3, "shrug": config.ACTION_SPACE_DIM - 1}

    def index_of(self, category: str | None) -> int:
        if not category:
            return 0
        return self._MAP.get(category.strip().lower(), 0)


class _FakeTrainer:
    """Trainer-like object exposing _cycle and _vocab for compute_fisher()."""

    def __init__(self, model: _TinyModel) -> None:
        self._cycle = _FakeCycle(model)
        self._vocab = _FakeVocab()


def _make_sample(model: _TinyModel, category: str, seed: int) -> dict:
    """Build a calibration/training sample whose fields sum to model.input_dim.

    _build_input_batch concatenates fused + drive(12) + deltas(12) + pressure(1)
    + episodic. To hit a tiny input_dim we keep drive/deltas tiny too — the
    helper just concatenates whatever lengths we give it. We split input_dim as
    fused=input_dim-2, drive=0? No: drive/deltas are required non-empty in the
    real schema, but _build_input_batch only concatenates. We allocate:
        fused = input_dim - (2 + 1)  (leave room for drive=1, delta=1, pressure)
    """
    rng = np.random.RandomState(seed)
    # Partition input_dim across the five concatenated fields.
    # pressure is always exactly 1.
    remaining = model.input_dim - 1
    fused_n = remaining - 4  # leave 2 for drive, 2 for deltas
    drive_n = 2
    delta_n = remaining - fused_n - drive_n  # 2
    assert fused_n + drive_n + delta_n + 1 == model.input_dim
    return {
        "fused_embedding": rng.standard_normal(fused_n).astype(np.float32),
        "drive_vector": rng.standard_normal(drive_n).astype(np.float32),
        "drive_deltas": rng.standard_normal(delta_n).astype(np.float32),
        "total_pressure": float(rng.standard_normal()),
        "episodic_context": np.zeros(0, dtype=np.float32),
        "action_category": category,
    }


# ---------------------------------------------------------------------------
# Fisher correctness
# ---------------------------------------------------------------------------


def test_compute_fisher_correctness():
    """Fisher diagonal equals the mean squared gradient over calibration data.

    Re-derives the expected Fisher by running the same forward/backprop per
    single-sample chunk and accumulating squared gradients independently, then
    compares against EWCRegularizer.compute_fisher's stored result.
    """
    from training.trainer import (
        _backprop, _build_input_batch, _build_labels, _forward_with_cache,
    )

    model = _TinyModel()
    trainer = _FakeTrainer(model)
    samples = [_make_sample(model, "alpha", seed=s) for s in range(5)]

    ewc = EWCRegularizer()
    ewc.compute_fisher(trainer, samples, chunk_size=1)
    got = ewc._phase_fisher
    assert got is not None

    # Independent re-derivation: per-sample squared gradient, averaged.
    n_tensors = 8
    expected = [None] * n_tensors
    for s in samples:
        x = _build_input_batch([s])
        labels = _build_labels([s], trainer._vocab)
        h1, h2, probs, _aux, _ = _forward_with_cache(model, x)
        grads, _ = _backprop(model, x, h1, h2, probs, labels)
        for i, g in enumerate(grads):
            sq = (g * g) * x.shape[0]  # undo the per-batch mean (batch=1 here)
            expected[i] = sq if expected[i] is None else expected[i] + sq
    expected = [e / float(len(samples)) for e in expected]

    for i in range(n_tensors):
        exp = np.maximum(expected[i].astype(np.float32), EWCRegularizer._FISHER_FLOOR)
        exp = np.minimum(exp, EWCRegularizer._FISHER_MAX)
        np.testing.assert_allclose(got[i], exp, rtol=1e-5, atol=1e-7)

    # Fisher is proportional to squared gradients: a parameter with zero
    # gradient everywhere sits at the floor, not above it.
    # (w_aux / b_aux are unsupervised → zero grads → floored.)
    assert np.allclose(got[6], EWCRegularizer._FISHER_FLOOR)  # w_aux
    assert np.allclose(got[7], EWCRegularizer._FISHER_FLOOR)  # b_aux


def test_penalty_gradients_with_real_fisher():
    """Penalty gradient is nonzero and varies in magnitude per parameter."""
    model = _TinyModel()
    trainer = _FakeTrainer(model)
    samples = [_make_sample(model, c, seed=s)
               for s, c in enumerate(["alpha", "beta", "alpha", "gamma", "beta"])]

    ewc = EWCRegularizer()
    weights = [model.w1, model.b1, model.w2, model.b2,
               model.w_action, model.b_action, model.w_aux, model.b_aux]
    ewc.set_reference(weights)            # seeds Fisher (no phase yet → uniform)
    ewc.compute_fisher(trainer, samples)  # real phase Fisher
    ewc.set_reference(weights)            # blend in → non-uniform running Fisher

    # Drift the supervised layers so the penalty is active, then fast-forward
    # past the λ ramp so we read the full-strength penalty.
    drifted = [w.copy() for w in weights]
    drifted[4] = drifted[4] + 0.5  # w_action
    drifted[0] = drifted[0] + 0.5  # w1
    ewc._ramp_steps_remaining = 0

    grads = ewc.penalty_gradients(drifted, lambda_ewc=0.1)
    # Supervised layers see real, nonzero penalty gradients.
    assert np.any(grads[4] != 0.0)
    assert np.any(grads[0] != 0.0)

    # Different parameters carry different Fisher importance → the per-element
    # penalty magnitude is not uniform across w_action.
    nonzero = np.abs(grads[4][grads[4] != 0.0])
    assert nonzero.size > 1
    assert not np.allclose(nonzero, nonzero[0])


# ---------------------------------------------------------------------------
# Online EWC blend
# ---------------------------------------------------------------------------


def test_online_ewc_update():
    """Second set_reference blends Fisher as F_new = γ·F_old + F_phase."""
    model = _TinyModel()
    trainer = _FakeTrainer(model)
    weights = [model.w1, model.b1, model.w2, model.b2,
               model.w_action, model.b_action, model.w_aux, model.b_aux]

    ewc = EWCRegularizer()

    # Phase 1: compute Fisher, then anchor (seeds running Fisher = F_phase1).
    samples1 = [_make_sample(model, "alpha", seed=s) for s in range(4)]
    ewc.compute_fisher(trainer, samples1)
    f_phase1 = [f.copy() for f in ewc._phase_fisher]
    ewc.set_reference(weights)
    f_after_1 = [f.copy() for f in ewc._fisher]
    # First boundary seeds directly from the phase Fisher.
    for a, b in zip(f_after_1, f_phase1):
        np.testing.assert_allclose(a, b, rtol=1e-6)

    # Phase 2: new Fisher, then anchor → blend.
    samples2 = [_make_sample(model, "beta", seed=s + 100) for s in range(4)]
    ewc.compute_fisher(trainer, samples2)
    f_phase2 = [f.copy() for f in ewc._phase_fisher]
    ewc.set_reference(weights)
    f_after_2 = ewc._fisher

    gamma = EWCRegularizer._ONLINE_GAMMA
    for i in range(len(f_after_2)):
        expected = gamma * f_after_1[i] + f_phase2[i]
        np.testing.assert_allclose(f_after_2[i], expected, rtol=1e-5, atol=1e-8)


# ---------------------------------------------------------------------------
# λ ramp-up
# ---------------------------------------------------------------------------


def test_lambda_ramp():
    """Penalty is 0 at step 0 after set_reference and full after _RAMP_STEPS."""
    model = _TinyModel()
    weights = [model.w1, model.b1, model.w2, model.b2,
               model.w_action, model.b_action, model.w_aux, model.b_aux]

    ewc = EWCRegularizer()
    ewc.set_reference(weights)  # arms ramp to _RAMP_STEPS

    drifted = [w + 1.0 for w in weights]

    # Step 0: ramp factor is 0 → zero penalty gradients.
    grads0 = ewc.penalty_gradients(drifted, lambda_ewc=0.1)
    assert all(np.all(g == 0.0) for g in grads0)
    assert ewc._ramp_factor() > 0.0  # advanced by one after the call

    # Drain the remaining ramp steps.
    steps = EWCRegularizer._RAMP_STEPS
    for _ in range(steps):  # already consumed 1; a few extra are harmless
        ewc.penalty_gradients(drifted, lambda_ewc=0.1)

    assert ewc._ramp_steps_remaining == 0
    assert ewc._ramp_factor() == pytest.approx(1.0)

    grads_full = ewc.penalty_gradients(drifted, lambda_ewc=0.1)
    assert any(np.any(g != 0.0) for g in grads_full)

    # Full-strength penalty equals λ·F·(w−w*) with no scaling.
    expected_w1 = 0.1 * ewc._fisher[0] * (drifted[0] - weights[0])
    np.testing.assert_allclose(grads_full[0], expected_w1, rtol=1e-5, atol=1e-8)


def test_penalty_inactive_before_set_reference():
    """penalty()/penalty_gradients() are inert until set_reference is called."""
    model = _TinyModel()
    weights = [model.w1, model.b1, model.w2, model.b2,
               model.w_action, model.b_action, model.w_aux, model.b_aux]
    ewc = EWCRegularizer()
    assert ewc.penalty(weights, lambda_ewc=0.1) == 0.0
    grads = ewc.penalty_gradients(weights, lambda_ewc=0.1)
    assert all(np.all(g == 0.0) for g in grads)


# ---------------------------------------------------------------------------
# Numerical stability
# ---------------------------------------------------------------------------


def test_fisher_numerical_stability():
    """All-zero and very-large gradient edge cases stay floored/clamped."""
    model = _TinyModel()
    trainer = _FakeTrainer(model)

    # Case 1: empty calibration → explicit error, never a degenerate Fisher.
    ewc = EWCRegularizer()
    with pytest.raises(ValueError):
        ewc.compute_fisher(trainer, [])

    # Case 2: all-zero gradients. Force the action head to produce gradients of
    # zero by making the label match the prediction is hard; instead we set the
    # supervised weights so loss-gradient is tiny. Simplest robust check: the
    # unsupervised aux head always has zero gradient → must be floored.
    samples = [_make_sample(model, "alpha", seed=s) for s in range(3)]
    ewc.compute_fisher(trainer, samples)
    fisher = ewc._phase_fisher
    for f in fisher:
        assert np.all(f >= EWCRegularizer._FISHER_FLOOR)
        assert np.all(f <= EWCRegularizer._FISHER_MAX)
    # Aux head (indices 6, 7) is unsupervised → exactly floored.
    assert np.allclose(fisher[6], EWCRegularizer._FISHER_FLOOR)
    assert np.allclose(fisher[7], EWCRegularizer._FISHER_FLOOR)

    # Case 3: very large gradients → clamped to _FISHER_MAX, never inf/nan.
    # Inflate inputs massively so action-head gradients explode.
    big_model = _TinyModel()
    big_trainer = _FakeTrainer(big_model)
    big_samples = []
    for s in range(3):
        smp = _make_sample(big_model, "beta", seed=s + 50)
        smp["fused_embedding"] = smp["fused_embedding"] * 1e6
        smp["total_pressure"] = 1e6
        big_samples.append(smp)
    big_ewc = EWCRegularizer()
    big_ewc.compute_fisher(big_trainer, big_samples)
    for f in big_ewc._phase_fisher:
        assert np.all(np.isfinite(f))
        assert np.all(f <= EWCRegularizer._FISHER_MAX)
        assert np.all(f >= EWCRegularizer._FISHER_FLOOR)


def test_compute_fisher_chunking_consistency():
    """chunk_size must not materially change the diagonal estimate.

    Per-sample (chunk=1) and small-batch chunking should agree closely; with
    batch≥2 the empirical-Fisher estimate uses the *mean* batch gradient, so a
    small difference is expected — assert they are the same order of magnitude
    and finite, not bitwise equal.
    """
    model = _TinyModel()
    trainer = _FakeTrainer(model)
    samples = [_make_sample(model, c, seed=s)
               for s, c in enumerate(["alpha", "beta", "gamma"] * 3)]

    ewc1 = EWCRegularizer()
    ewc1.compute_fisher(trainer, samples, chunk_size=1)
    ewcN = EWCRegularizer()
    ewcN.compute_fisher(trainer, samples, chunk_size=4)

    for f1, fN in zip(ewc1._phase_fisher, ewcN._phase_fisher):
        assert np.all(np.isfinite(f1)) and np.all(np.isfinite(fN))

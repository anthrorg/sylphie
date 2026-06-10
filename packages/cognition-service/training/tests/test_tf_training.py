"""TF-path training tests — parity with the validated NumPy path.

The TF path uses GradientTape purely as the gradient engine; everything
downstream (NumPy Adam, EWC, write-back) is shared with the NumPy path.
These tests pin the load-bearing assumptions:

  1. TF trainable_variables order matches the canonical 8-tensor convention.
  2. Weight round-trip TF<->NumPy preserves forward-pass outputs.
  3. GradientTape gradients match the hand-derived backprop.
  4. compute_fisher() produces the same Fisher under TF as under NumPy.
  5. Training actually reduces loss on the TF path.
  6. Trainer.get_weights() / _train_step() work end-to-end under TF.

Run from the package root:
    cd packages/cognition-service && python -m pytest training/tests/test_tf_training.py
"""

from __future__ import annotations

import numpy as np
import pytest

tf = pytest.importorskip("tensorflow")

import config
import models.global_model as global_model_mod
from models.global_model import GlobalModel
from training.replay import EWCRegularizer
from training.trainer import (
    ActionVocabulary,
    AdamOptimizer,
    Trainer,
    _build_input_batch,
    _build_labels,
    compute_batch_gradients,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def tf_model() -> GlobalModel:
    m = GlobalModel()
    assert m.uses_tf, "TF must be active for this suite (importorskip passed)"
    return m


@pytest.fixture(scope="module")
def np_model() -> GlobalModel:
    """Build a NumPy-path GlobalModel by temporarily masking HAS_TF."""
    original = global_model_mod.HAS_TF
    global_model_mod.HAS_TF = False
    try:
        m = GlobalModel()
    finally:
        global_model_mod.HAS_TF = original
    assert hasattr(m, "w1") and not hasattr(m, "model")
    return m


def _make_sample(category: str, seed: int) -> dict:
    """Full-dimension training sample matching the real schema."""
    rng = np.random.RandomState(seed)
    return {
        "fused_embedding": rng.standard_normal(config.EMBEDDING_DIM).astype(np.float32),
        "drive_vector": rng.standard_normal(config.DRIVE_VECTOR_DIM).astype(np.float32),
        "drive_deltas": rng.standard_normal(config.DRIVE_VECTOR_DIM).astype(np.float32),
        "total_pressure": float(rng.standard_normal()),
        "episodic_context": rng.standard_normal(config.EMBEDDING_DIM).astype(np.float32),
        "action_category": category,
    }


def _make_batch(vocab: ActionVocabulary, n: int = 8) -> tuple[np.ndarray, np.ndarray]:
    cats = ["greet", "recall", "shrug", "teach"]
    samples = [_make_sample(cats[i % len(cats)], seed=i) for i in range(n)]
    return _build_input_batch(samples), _build_labels(samples, vocab)


class _CycleStub:
    def __init__(self, model: GlobalModel) -> None:
        self.global_model = model


class _BufferStub:
    def __len__(self) -> int:
        return 0


# ---------------------------------------------------------------------------
# 1. Canonical ordering
# ---------------------------------------------------------------------------


def test_tf_variable_order_canonical(tf_model: GlobalModel):
    variables = tf_model.tf_variables()
    expected = [
        (config.GLOBAL_INPUT_DIM, 512), (512,),
        (512, 256), (256,),
        (256, config.ACTION_SPACE_DIM), (config.ACTION_SPACE_DIM,),
        (256, 2), (2,),
    ]
    got = [tuple(int(d) for d in v.shape) for v in variables]
    assert got == expected
    assert tf_model.total_params == 939_810

    weights = tf_model.weights_np()
    assert len(weights) == 8
    assert [w.shape for w in weights] == expected


# ---------------------------------------------------------------------------
# 2. Weight round-trip + forward parity
# ---------------------------------------------------------------------------


def test_forward_parity_after_weight_transfer(tf_model: GlobalModel, np_model: GlobalModel):
    tf_model.set_weights_np(np_model.weights_np())

    rng = np.random.RandomState(42)
    x = rng.standard_normal(config.GLOBAL_INPUT_DIM).astype(np.float32)

    out_tf = tf_model.predict(x)
    out_np = np_model._predict_numpy(x.reshape(1, -1))

    np.testing.assert_allclose(
        out_tf["action_bias"], out_np["action_bias"], rtol=1e-4, atol=1e-6
    )
    assert out_tf["urgency"] == pytest.approx(out_np["urgency"], rel=1e-4)
    assert out_tf["novelty_score"] == pytest.approx(out_np["novelty_score"], rel=1e-4)

    # Round-trip: weights read back out are what went in.
    back = tf_model.weights_np()
    for a, b in zip(back, np_model.weights_np()):
        np.testing.assert_allclose(a, b, rtol=1e-6, atol=1e-7)


# ---------------------------------------------------------------------------
# 3. Gradient parity: GradientTape vs hand-derived backprop
# ---------------------------------------------------------------------------


def test_gradient_parity(tf_model: GlobalModel, np_model: GlobalModel):
    tf_model.set_weights_np(np_model.weights_np())
    vocab = ActionVocabulary()
    x, labels = _make_batch(vocab, n=8)

    grads_tf, loss_tf = compute_batch_gradients(tf_model, x, labels)
    grads_np, loss_np = compute_batch_gradients(np_model, x, labels)

    assert loss_tf == pytest.approx(loss_np, rel=1e-4)
    assert len(grads_tf) == len(grads_np) == 8
    for i, (gt, gn) in enumerate(zip(grads_tf, grads_np)):
        assert gt.shape == gn.shape, f"tensor {i} shape mismatch"
        np.testing.assert_allclose(
            gt, gn, rtol=1e-3, atol=1e-6,
            err_msg=f"gradient mismatch at canonical tensor {i}",
        )

    # Aux head is unsupervised on both paths -> exactly zero gradients.
    assert np.all(grads_tf[6] == 0.0) and np.all(grads_tf[7] == 0.0)
    assert np.all(grads_np[6] == 0.0) and np.all(grads_np[7] == 0.0)


# ---------------------------------------------------------------------------
# 4. Fisher parity under TF
# ---------------------------------------------------------------------------


def test_fisher_parity(tf_model: GlobalModel, np_model: GlobalModel):
    tf_model.set_weights_np(np_model.weights_np())
    samples = [_make_sample(c, seed=s)
               for s, c in enumerate(["greet", "recall", "teach", "shrug"] * 2)]

    class _TrainerStub:
        def __init__(self, model):
            self._cycle = _CycleStub(model)
            self._vocab = ActionVocabulary()

    ewc_tf = EWCRegularizer()
    ewc_tf.compute_fisher(_TrainerStub(tf_model), samples, chunk_size=4)
    ewc_np = EWCRegularizer()
    ewc_np.compute_fisher(_TrainerStub(np_model), samples, chunk_size=4)

    assert ewc_tf._phase_fisher is not None
    for i, (ft, fn) in enumerate(zip(ewc_tf._phase_fisher, ewc_np._phase_fisher)):
        np.testing.assert_allclose(
            ft, fn, rtol=1e-3, atol=1e-8,
            err_msg=f"Fisher mismatch at canonical tensor {i}",
        )

    # Real (non-uniform) Fisher on supervised layers; aux head floored.
    assert float(ewc_tf._phase_fisher[4].max()) > EWCRegularizer._FISHER_FLOOR * 10
    assert np.allclose(ewc_tf._phase_fisher[6], EWCRegularizer._FISHER_FLOOR)
    assert np.allclose(ewc_tf._phase_fisher[7], EWCRegularizer._FISHER_FLOOR)


# ---------------------------------------------------------------------------
# 5. TF training reduces loss
# ---------------------------------------------------------------------------


def test_tf_training_reduces_loss(tf_model: GlobalModel):
    vocab = ActionVocabulary()
    x, labels = _make_batch(vocab, n=16)
    optimizer = AdamOptimizer(lr=0.001)

    _, initial_loss = compute_batch_gradients(tf_model, x, labels)
    for _ in range(40):
        grads, _ = compute_batch_gradients(tf_model, x, labels)
        weights = tf_model.weights_np()
        optimizer.step(weights, grads)
        tf_model.set_weights_np(weights)
    _, final_loss = compute_batch_gradients(tf_model, x, labels)

    assert np.isfinite(final_loss)
    assert final_loss < initial_loss * 0.5, (
        f"TF training did not reduce loss: {initial_loss:.4f} -> {final_loss:.4f}"
    )


# ---------------------------------------------------------------------------
# 6. Trainer end-to-end under TF
# ---------------------------------------------------------------------------


def test_trainer_train_step_tf(tf_model: GlobalModel):
    trainer = Trainer(cycle=_CycleStub(tf_model), buffer=_BufferStub())

    # get_weights must return real weights under TF (was [] before Option B).
    weights_before = trainer.get_weights()
    assert len(weights_before) == 8

    batch = [_make_sample("greet", seed=s) for s in range(8)]
    loss = trainer._train_step(batch)
    assert np.isfinite(loss) and loss > 0.0

    weights_after = trainer.get_weights()
    changed = any(
        not np.allclose(b, a) for b, a in zip(weights_before, weights_after)
    )
    assert changed, "_train_step under TF did not update model weights"

    # Freeze must hold weights fixed without erroring.
    trainer.freeze()
    frozen_loss = trainer._train_step(batch)
    weights_frozen = trainer.get_weights()
    assert all(np.allclose(a, f) for a, f in zip(weights_after, weights_frozen))
    assert np.isfinite(frozen_loss)
    trainer.unfreeze()

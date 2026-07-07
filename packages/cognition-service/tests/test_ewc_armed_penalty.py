"""TK-121 EWC-armed / non-zero-gradient ACs (pipeline item 20260702-002).

Replaces the old (architect-deleted, DEC-33) "penalty_gradients() non-zero
at the boundary" assertion, which is false at t=0 (immediately after
set_reference(), current weights == reference, so a zero gradient there is
CORRECT, not a defect). Instead:

  1. Immediately after _consolidate_phase_boundary(), EWC is ARMED
     (ewc._reference is not None and ewc._fisher is not None) and the
     gradient at that exact instant is zero (w == ref).
  2. Once weights are perturbed away from the anchor, penalty_gradients()
     called twice (the first call consumes the initial ramp factor) returns
     a gradient with at least one non-zero element.
"""

from __future__ import annotations

import config
import numpy as np
from inference.cycle import CognitiveCycle
from main import _consolidate_phase_boundary
from training.data_buffer import DataBuffer
from training.trainer import Trainer

_EMB = config.EMBEDDING_DIM
_DRIVE = config.DRIVE_VECTOR_DIM


def _seed_buffer(buffer: DataBuffer, n: int = 30) -> None:
    rng = np.random.RandomState(3)
    for _ in range(n):
        buffer.add_sample(
            fused_embedding=rng.standard_normal(_EMB).astype(np.float32),
            drive_vector=rng.standard_normal(_DRIVE).astype(np.float32),
            drive_deltas=rng.standard_normal(_DRIVE).astype(np.float32),
            total_pressure=float(rng.standard_normal()),
            episodic_context=rng.standard_normal(_EMB).astype(np.float32),
            action_category="greet",
        )


def test_ewc_armed_and_zero_gradient_at_boundary_then_nonzero_after_perturbation() -> None:
    cycle = CognitiveCycle()
    buffer = DataBuffer(capacity=256)
    _seed_buffer(buffer)
    trainer = Trainer(cycle=cycle, buffer=buffer)

    result = _consolidate_phase_boundary(trainer, buffer)
    assert result.weights_captured is True

    ewc = trainer.ewc
    assert ewc._reference is not None, "EWC reference must be set after a boundary"
    assert ewc._fisher is not None, "EWC fisher must be set after a boundary"

    current_weights = trainer.get_weights()

    # At t=0, current weights == reference -> zero gradient is CORRECT.
    zero_grads = ewc.penalty_gradients(current_weights, lambda_ewc=0.1)
    assert all(np.allclose(g, 0.0) for g in zero_grads), (
        "gradient immediately at the boundary (w == ref) should be exactly zero"
    )

    # Perturb weights away from the anchor.
    perturbed = [w + 0.5 for w in current_weights]

    # First call after perturbation still consumes the initial ramp factor
    # (may be zero-scaled); the SECOND call is where real pressure shows up.
    ewc.penalty_gradients(perturbed, lambda_ewc=0.1)
    grads = ewc.penalty_gradients(perturbed, lambda_ewc=0.1)

    assert any(np.any(g != 0.0) for g in grads), (
        "EWC penalty must exert real (non-zero) pressure once weights have "
        "diverged from the anchor, after the ramp has advanced"
    )

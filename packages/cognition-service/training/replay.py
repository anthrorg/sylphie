"""Experience replay and Elastic Weight Consolidation (EWC) regularizer.

ExperienceReplay is a thin coordination layer — the actual sample mixing
logic lives in DataBuffer.sample_batch().

EWCRegularizer provides the interface for continual learning. The full
Fisher information matrix computation is deferred (TODO) because it
requires a dedicated calibration pass over a held-out task dataset.
For now it provides an L2 penalty on weight drift from a saved reference
point, which is sufficient to slow catastrophic forgetting during early
bootstrap training.
"""

from __future__ import annotations

import logging

import numpy as np

logger = logging.getLogger("cognition_service.training.replay")


# ---------------------------------------------------------------------------
# Experience Replay
# ---------------------------------------------------------------------------


class ExperienceReplay:
    """Coordinates the replay fraction of training batches.

    This class is intentionally thin. The mixing logic (replay vs. recent)
    lives in DataBuffer.sample_batch() so that the buffer can enforce its
    own capacity and index arithmetic. ExperienceReplay holds the policy
    parameters (replay_fraction, batch_size) that govern how batches are
    drawn and exposes them as a single call site for the Trainer.
    """

    def __init__(
        self,
        batch_size: int = 32,
        replay_fraction: float = 0.5,
    ) -> None:
        """
        Args:
            batch_size: Number of samples per training mini-batch.
            replay_fraction: Fraction of each batch drawn from random replay
                             positions (vs. most recent additions).
        """
        if not 0.0 <= replay_fraction <= 1.0:
            raise ValueError(f"replay_fraction must be in [0, 1], got {replay_fraction}")
        self.batch_size = batch_size
        self.replay_fraction = replay_fraction

    def sample(self, buffer: "DataBuffer") -> list[dict]:  # noqa: F821  # type: ignore[name-defined]
        """Draw a mini-batch from the buffer using the configured replay policy.

        Args:
            buffer: DataBuffer instance to draw from.

        Returns:
            List of sample dicts, possibly shorter than batch_size if the
            buffer does not yet hold enough samples.
        """
        return buffer.sample_batch(self.batch_size, self.replay_fraction)


# ---------------------------------------------------------------------------
# Elastic Weight Consolidation
# ---------------------------------------------------------------------------


class EWCRegularizer:
    """Elastic Weight Consolidation stub for continual learning.

    EWC protects important weights from being overwritten when Sylphie
    transitions between operational phases (bootstrap -> audit -> partial).

    Full EWC:
      After completing a task/phase, compute the Fisher information matrix F
      by averaging squared gradients of the log-likelihood over a held-out
      sample set. The penalty term is:
          lambda/2 * sum_i F_i * (theta_i - theta*_i)^2
      where theta*_i is the weight value at the end of the prior phase.

    Current implementation:
      Uses simple L2 weight regularization as a stand-in. F_i = 1 for all
      parameters (uniform importance). This is equivalent to L2 weight decay
      anchored to a saved reference point rather than to zero. It is a
      meaningful regularizer that prevents large weight drift, even if it
      does not weight parameters by their task importance.

    TODO: Replace _compute_uniform_fisher() with real Fisher diagonal after
          integrating a calibration dataset and a per-phase evaluation hook.
    """

    def __init__(self, reference_weights: list[np.ndarray] | None = None) -> None:
        """
        Args:
            reference_weights: Optional initial reference point. If None,
                               set_reference() must be called before using
                               penalty() or penalty_gradients().
        """
        self._reference: list[np.ndarray] | None = None
        self._fisher: list[np.ndarray] | None = None   # importance per parameter

        if reference_weights is not None:
            self.set_reference(reference_weights)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def set_reference(self, weights: list[np.ndarray]) -> None:
        """Save current weights as the EWC anchor point.

        Call this at the end of each operational phase (e.g., after the
        shadow phase concludes). Subsequent training steps will be penalised
        for drifting away from these weights.

        Args:
            weights: List of weight arrays in the same order as the model's
                     get_weights() / set_weights() convention
                     [w1, b1, w2, b2, w_action, b_action, w_aux, b_aux].
        """
        self._reference = [w.copy() for w in weights]
        self._fisher = self._compute_uniform_fisher(weights)
        logger.info(
            "EWC reference set (%d weight tensors, %d total params)",
            len(weights),
            sum(w.size for w in weights),
        )

    def penalty(
        self,
        current_weights: list[np.ndarray],
        lambda_ewc: float = 0.1,
    ) -> float:
        """Compute the EWC regularization penalty.

        Returns 0.0 if no reference point has been set (safe to call before
        set_reference() — penalty is simply inactive).

        Args:
            current_weights: Current model weight arrays (same order as
                             the reference).
            lambda_ewc: Regularization strength. Higher values resist drift
                        more strongly.

        Returns:
            Scalar penalty value to be added to the training loss.
        """
        if self._reference is None or self._fisher is None:
            return 0.0

        total = 0.0
        for w, ref, fisher in zip(current_weights, self._reference, self._fisher):
            diff = w - ref
            total += float(np.sum(fisher * diff * diff))
        return (lambda_ewc / 2.0) * total

    def penalty_gradients(
        self,
        current_weights: list[np.ndarray],
        lambda_ewc: float = 0.1,
    ) -> list[np.ndarray]:
        """Compute gradients of the EWC penalty w.r.t. current weights.

        Returns zero arrays (same shapes as current_weights) if no reference
        point has been set.

        The gradient of lambda/2 * sum_i F_i*(w_i - w*_i)^2 w.r.t. w_i is:
            lambda * F_i * (w_i - w*_i)

        Args:
            current_weights: Current model weight arrays.
            lambda_ewc: Regularization strength (must match the value used
                        in penalty() for consistent loss/gradient values).

        Returns:
            List of gradient arrays, one per weight tensor, same shapes.
        """
        if self._reference is None or self._fisher is None:
            return [np.zeros_like(w) for w in current_weights]

        grads: list[np.ndarray] = []
        for w, ref, fisher in zip(current_weights, self._reference, self._fisher):
            grads.append(lambda_ewc * fisher * (w - ref))
        return grads

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _compute_uniform_fisher(
        self, weights: list[np.ndarray]
    ) -> list[np.ndarray]:
        """Return all-ones Fisher diagonal (uniform importance).

        This is the stand-in until real Fisher information is implemented.
        Each parameter is treated as equally important, reducing EWC to
        standard L2 weight anchoring.

        Args:
            weights: Model weight arrays — used only for shape.

        Returns:
            List of all-ones arrays with the same shapes as weights.
        """
        return [np.ones_like(w, dtype=np.float32) for w in weights]

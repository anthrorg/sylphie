"""Experience replay and Elastic Weight Consolidation (EWC) regularizer.

ExperienceReplay is a thin coordination layer — the actual sample mixing
logic lives in DataBuffer.sample_batch().

EWCRegularizer implements **Online EWC** (Schwarz et al., 2018, "Progress &
Compress") for continual learning across Sylphie's operational phases
(bootstrap -> audit -> partial -> full). At each phase boundary the empirical
Fisher information diagonal is computed from a calibration set drawn from the
replay buffer (squared gradients of the log-likelihood on observed labels),
the running Fisher estimate is updated as ``F_new = γ·F_old + F_phase``, and
the weight anchor is reset to the current weights. The penalty term is:

    λ/2 · Σ_i F_i · (θ_i − θ*_i)²

with a per-phase λ ramp-up over the first ``_RAMP_STEPS`` training steps to
avoid an Adam-momentum shock when the penalty suddenly turns on.

See wiki/researchedIdeas/2026-04-27-ewc-real-fisher-computation.md for the
design rationale (empirical Fisher, diagonal-only, Online EWC from day one).
"""

from __future__ import annotations

import logging
from typing import Any

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
    """Online Elastic Weight Consolidation regularizer for continual learning.

    EWC protects important weights from being overwritten when Sylphie
    transitions between operational phases (bootstrap -> audit -> partial ->
    full). Importance is the **empirical Fisher information diagonal**:
    averaged squared gradients of the log-likelihood over a calibration set.
    The penalty term is:

        λ/2 · Σ_i F_i · (θ_i − θ*_i)²

    where θ*_i is the anchor weight value at the most recent phase boundary.

    Online EWC (Schwarz 2018): rather than stacking one quadratic penalty per
    phase (which causes rigidity as phases accumulate), a single running Fisher
    estimate is maintained and updated on each phase boundary as:

        F_new = γ · F_old + F_phase   (γ = _ONLINE_GAMMA)

    The anchor weights θ* are always reset to the current weights at each
    boundary; the Fisher carries the accumulated historical importance.

    λ ramp-up: for the first ``_RAMP_STEPS`` calls to penalty_gradients() after
    a set_reference(), λ is scaled linearly from 0 to its target value. This
    avoids slamming a large quadratic gradient into Adam's momentum buffers at
    the instant of a phase transition.

    Until set_reference() is called, the regularizer is fully inactive
    (penalty()/penalty_gradients() return 0). The legacy uniform-Fisher
    path (_compute_uniform_fisher) is retained for backward compatibility and
    used as a safe fallback when set_reference() is called without a prior
    compute_fisher() pass.
    """

    # Online EWC decay on the previous Fisher estimate when blending in a new
    # phase's Fisher. 0.7 keeps history meaningful without unbounded growth.
    _ONLINE_GAMMA: float = 0.7

    # Number of training steps over which λ ramps from 0 to full after a
    # phase transition (Adam-momentum-shock mitigation).
    _RAMP_STEPS: int = 200

    # Numerical-stability bounds for the Fisher diagonal. Floor prevents a
    # collapsed (all-zero) Fisher from silently disabling EWC's directionality;
    # the per-layer max clamp prevents any single parameter from dominating.
    _FISHER_FLOOR: float = 1e-8
    _FISHER_MAX: float = 1e2

    def __init__(self, reference_weights: list[np.ndarray] | None = None) -> None:
        """
        Args:
            reference_weights: Optional initial reference point. If None,
                               set_reference() must be called before using
                               penalty() or penalty_gradients().
        """
        self._reference: list[np.ndarray] | None = None
        self._fisher: list[np.ndarray] | None = None   # importance per parameter

        # Fisher computed for the *current* phase, awaiting blend into the
        # running estimate at the next set_reference() call. None until a
        # compute_fisher() pass has run.
        self._phase_fisher: list[np.ndarray] | None = None

        # λ ramp-up counter. >0 means we are still ramping λ up after the most
        # recent phase transition. Decremented once per penalty_gradients() call.
        self._ramp_steps_remaining: int = 0

        if reference_weights is not None:
            self.set_reference(reference_weights)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def set_reference(self, weights: list[np.ndarray]) -> None:
        """Anchor to current weights and roll the Online EWC Fisher estimate.

        Call this at each operational phase boundary (shadow -> audit, etc.),
        normally immediately *before* compute_fisher() for the new calibration
        set. The typical phase-transition sequence is:

            ewc.set_reference(trainer.get_weights())          # anchor + roll
            ewc.compute_fisher(trainer, calibration_samples)  # estimate F_phase

        Update rule:
          - The weight anchor θ* is always reset to ``weights``.
          - On the *first* call, the Fisher is seeded: if a phase Fisher has
            already been computed it is used directly, otherwise it falls back
            to the uniform (all-ones) Fisher — equivalent to plain L2 anchoring
            until the first compute_fisher() pass runs.
          - On *subsequent* calls, Online EWC blends the previously accumulated
            Fisher with the most recent phase Fisher:
                F_new = γ · F_old + F_phase

        λ ramp-up is (re)armed to _RAMP_STEPS on every call.

        Args:
            weights: List of weight arrays in the same order as the model's
                     get_weights() / set_weights() convention
                     [w1, b1, w2, b2, w_action, b_action, w_aux, b_aux].
        """
        new_reference = [w.copy() for w in weights]

        if self._fisher is None:
            # First phase boundary. Seed Fisher from the most recent phase
            # estimate if available, else uniform (L2 anchor) fallback.
            if self._phase_fisher is not None:
                self._fisher = [f.copy() for f in self._phase_fisher]
            else:
                self._fisher = self._compute_uniform_fisher(weights)
                logger.warning(
                    "EWC set_reference() called before any compute_fisher() — "
                    "falling back to uniform Fisher (L2 anchor) for this phase."
                )
        else:
            # Online EWC blend. If no new phase Fisher was computed since the
            # last boundary, the previous estimate simply decays by γ.
            phase = self._phase_fisher
            blended: list[np.ndarray] = []
            for i, f_old in enumerate(self._fisher):
                f_phase = (
                    phase[i] if phase is not None and i < len(phase)
                    else np.zeros_like(f_old)
                )
                blended.append(self._ONLINE_GAMMA * f_old + f_phase)
            self._fisher = blended

        self._reference = new_reference
        self._phase_fisher = None
        self._ramp_steps_remaining = self._RAMP_STEPS

        self._log_fisher_stats("set_reference")
        logger.info(
            "EWC reference set (%d weight tensors, %d total params, "
            "lambda ramp over %d steps)",
            len(weights),
            sum(w.size for w in weights),
            self._RAMP_STEPS,
        )

    def compute_fisher(
        self,
        model: Any,
        calibration_samples: list[dict],
        chunk_size: int = 32,
    ) -> None:
        """Compute the empirical Fisher diagonal for the current phase.

        Iterates the calibration samples in small chunks, runs a forward +
        backward pass on the GlobalModel for each chunk (hand-derived backprop
        on the NumPy path, GradientTape on the TF path), and accumulates
        the squared per-chunk gradients into a running diagonal. The result is
        normalized by the number of samples used, floored at ``_FISHER_FLOOR``,
        and clamped to ``_FISHER_MAX`` per layer, then stored in
        ``self._phase_fisher`` (it is *not* blended into the running estimate
        here — that happens at the next set_reference()).

        Empirical Fisher (squared gradients on observed labels) rather than the
        true Fisher (expectation over the model's predictive distribution) is
        used by design; see the research note for justification.

        NOTE: This uses the *batch-aggregated* gradient per chunk as the
        empirical-Fisher contribution, scaled by the chunk size. This matches
        the gradient shape the existing _backprop() produces (per-sample grads
        are not exposed). With ``chunk_size=1`` it is the exact per-sample
        empirical Fisher; larger chunks trade a small amount of estimator
        variance for speed, which is acceptable for a diagonal estimate.

        Args:
            model: The Trainer instance (duck-typed: must expose ``_cycle``
                   with a ``global_model`` and an ``_vocab`` ActionVocabulary).
                   Accepting the Trainer keeps the forward/backward and label-
                   building logic in one place and matches the phase-transition
                   endpoint call site.
            calibration_samples: Samples drawn from the replay buffer
                   (typically via DataBuffer.snapshot_calibration()).
            chunk_size: Number of samples per forward/backward chunk.

        Raises:
            ValueError: If calibration_samples is empty.
        """
        if not calibration_samples:
            raise ValueError(
                "compute_fisher() requires a non-empty calibration set — "
                "refusing to silently produce a degenerate Fisher."
            )

        # Resolve the GlobalModel and the label-building dependencies.
        # Imported lazily to avoid a circular import (trainer imports replay).
        from training.trainer import (  # noqa: PLC0415
            _build_input_batch,
            _build_labels,
            compute_batch_gradients,
        )

        global_model, vocab = self._resolve_model_and_vocab(model)

        # Canonical-order weight list — live references on the NumPy path,
        # host copies on the TF path. Only used for shapes here.
        if hasattr(global_model, "w1"):
            weights = [
                global_model.w1, global_model.b1,
                global_model.w2, global_model.b2,
                global_model.w_action, global_model.b_action,
                global_model.w_aux, global_model.b_aux,
            ]
        else:
            weights = global_model.weights_np()
        fisher_accum = [np.zeros_like(w, dtype=np.float64) for w in weights]

        n_used = 0
        for start in range(0, len(calibration_samples), chunk_size):
            chunk = calibration_samples[start:start + chunk_size]
            if not chunk:
                continue

            x = _build_input_batch(chunk)
            labels = _build_labels(chunk, vocab)

            # Same gradient entry point the training step uses — hand-derived
            # backprop on the NumPy path, GradientTape on the TF path.
            grads, _loss = compute_batch_gradients(global_model, x, labels)

            # _backprop returns the *mean* gradient over the chunk (it divides
            # by batch internally). The empirical-Fisher contribution of the
            # chunk is the squared gradient scaled back up by the chunk size,
            # so the final normalization by n_used yields the correct mean of
            # per-sample squared gradients in expectation.
            batch = x.shape[0]
            for i, g in enumerate(grads):
                fisher_accum[i] += (g * g) * batch
            n_used += batch

        if n_used == 0:
            raise ValueError("compute_fisher() processed zero usable samples")

        phase_fisher: list[np.ndarray] = []
        for acc in fisher_accum:
            f = (acc / float(n_used)).astype(np.float32)
            np.maximum(f, self._FISHER_FLOOR, out=f)   # floor
            np.minimum(f, self._FISHER_MAX, out=f)     # per-layer clamp
            phase_fisher.append(f)

        self._phase_fisher = phase_fisher
        logger.info(
            "EWC Fisher computed over %d calibration samples (%d chunks)",
            n_used,
            (len(calibration_samples) + chunk_size - 1) // chunk_size,
        )
        self._log_fisher_stats("compute_fisher (phase)", fisher=phase_fisher)

    def penalty(
        self,
        current_weights: list[np.ndarray],
        lambda_ewc: float = 0.1,
    ) -> float:
        """Compute the EWC regularization penalty.

        Returns 0.0 if no reference point has been set (safe to call before
        set_reference() — penalty is simply inactive). The λ ramp factor is
        applied but this read-only accessor does NOT decrement the ramp
        counter (only penalty_gradients() advances the ramp).

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

        scaled_lambda = lambda_ewc * self._ramp_factor()
        if scaled_lambda == 0.0:
            return 0.0

        total = 0.0
        for w, ref, fisher in zip(current_weights, self._reference, self._fisher):
            diff = w - ref
            total += float(np.sum(fisher * diff * diff))
        return (scaled_lambda / 2.0) * total

    def penalty_gradients(
        self,
        current_weights: list[np.ndarray],
        lambda_ewc: float = 0.1,
    ) -> list[np.ndarray]:
        """Compute gradients of the EWC penalty w.r.t. current weights.

        Returns zero arrays (same shapes as current_weights) if no reference
        point has been set.

        The gradient of λ/2 · Σ_i F_i·(w_i − w*_i)² w.r.t. w_i is:
            λ · F_i · (w_i − w*_i)

        λ is scaled by the current ramp factor (0 → 1 over _RAMP_STEPS after a
        phase transition) and the ramp counter is decremented by one on each
        call. This is the single advancement point for the ramp.

        Args:
            current_weights: Current model weight arrays.
            lambda_ewc: Regularization strength (must match the value used
                        in penalty() for consistent loss/gradient values).

        Returns:
            List of gradient arrays, one per weight tensor, same shapes.
        """
        if self._reference is None or self._fisher is None:
            return [np.zeros_like(w) for w in current_weights]

        scaled_lambda = lambda_ewc * self._ramp_factor()

        # Advance the ramp exactly once per gradient step.
        if self._ramp_steps_remaining > 0:
            self._ramp_steps_remaining -= 1

        if scaled_lambda == 0.0:
            return [np.zeros_like(w) for w in current_weights]

        grads: list[np.ndarray] = []
        for w, ref, fisher in zip(current_weights, self._reference, self._fisher):
            grads.append(scaled_lambda * fisher * (w - ref))
        return grads

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ramp_factor(self) -> float:
        """Current λ scale in [0, 1].

        At the instant of set_reference() the counter is _RAMP_STEPS, giving a
        factor of 0 (penalty fully off). It rises linearly to 1.0 as the
        counter decrements to 0.
        """
        if self._RAMP_STEPS <= 0:
            return 1.0
        return 1.0 - (self._ramp_steps_remaining / float(self._RAMP_STEPS))

    @staticmethod
    def _resolve_model_and_vocab(model: Any) -> tuple[Any, Any]:
        """Extract (global_model, vocab) from a Trainer-like object.

        Accepts the Trainer instance (its ``_cycle.global_model`` and
        ``_vocab``). Raises a clear error rather than silently degrading if the
        expected attributes are missing.
        """
        cycle = getattr(model, "_cycle", None)
        vocab = getattr(model, "_vocab", None)
        if cycle is None or vocab is None:
            raise TypeError(
                "compute_fisher() expects a Trainer-like object exposing "
                "'_cycle' (with .global_model) and '_vocab'. "
                f"Got {type(model).__name__}."
            )
        global_model = getattr(cycle, "global_model", None)
        if global_model is None:
            raise TypeError(
                "compute_fisher(): trainer._cycle has no 'global_model'."
            )
        return global_model, vocab

    def _log_fisher_stats(
        self,
        context: str,
        fisher: list[np.ndarray] | None = None,
    ) -> None:
        """Log per-layer Fisher statistics — Fisher collapse is silent.

        Logs mean, max, and fraction-near-zero per weight tensor. A Fisher that
        has collapsed to (near) all-floor values means EWC has stopped weighting
        parameters by importance and degenerated to a weak L2 anchor; this is
        easy to miss without explicit diagnostics.
        """
        target = fisher if fisher is not None else self._fisher
        if target is None:
            return
        for i, f in enumerate(target):
            size = f.size if f.size else 1
            near_zero = float(np.count_nonzero(f <= self._FISHER_FLOOR * 10.0)) / size
            logger.info(
                "EWC Fisher[%s] layer %d: mean=%.3e max=%.3e near_zero=%.1f%%",
                context, i, float(f.mean()), float(f.max()), near_zero * 100.0,
            )

    def _compute_uniform_fisher(
        self, weights: list[np.ndarray]
    ) -> list[np.ndarray]:
        """Return all-ones Fisher diagonal (uniform importance).

        Backward-compatible fallback used when set_reference() is called before
        any compute_fisher() pass. Each parameter is treated as equally
        important, reducing EWC to standard L2 weight anchoring.

        Args:
            weights: Model weight arrays — used only for shape.

        Returns:
            List of all-ones arrays with the same shapes as weights.
        """
        return [np.ones_like(w, dtype=np.float32) for w in weights]

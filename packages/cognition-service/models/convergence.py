"""Convergence Check — determines consensus between global and panel models.

Compares the global model's action prior against each panel model's opinion
using cosine similarity. If all panels agree with the global prior above a
threshold, consensus is reached (Type 1 fast path). Otherwise, divergence
triggers Type 2 deliberation.

The convergence checker itself is a tiny learned model (~10K params) that
takes the concatenated global + panel action biases and outputs:
  - consensus: bool (above threshold = Type 1, below = Type 2)
  - divergence_score: float [0,1] — magnitude of disagreement
  - panel_agreement: per-panel cosine similarity to global prior

The learned convergence model replaces heuristic threshold routing with
routing that adapts based on experience.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import numpy as np

import config
from models.panel_models import PanelOutput

logger = logging.getLogger("cognition_service.convergence")

# Convergence threshold — below this divergence score, consensus is declared
DEFAULT_CONSENSUS_THRESHOLD = 0.3


@dataclass
class ConvergenceOutput:
    """Result of the convergence check."""
    consensus: bool
    divergence_score: float  # [0,1] — 0 = perfect agreement, 1 = max disagreement
    panel_agreement: dict[str, float]  # per-panel cosine similarity to global


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a < 1e-8 or norm_b < 1e-8:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


class ConvergenceModel:
    """Learned convergence checker.

    Input: global_prior(32) + 4 * panel_opinion(32) = 160 floats
    Architecture: Dense(160→64→1+4)
    Output: divergence_score (sigmoid) + per-panel agreement adjustments

    ~10K parameters.

    During early bootstrap, this falls back to pure cosine similarity
    (the learned model's random weights would be unreliable). The model
    learns to refine the threshold based on which types of disagreement
    actually warranted escalation.

    Graduation criterion (DEC-13, mvp-level):
        use_learned flips True when convergence_sample_count >= 1000 AND
        the proxy accuracy >= 0.80 over the last sample. Proxy accuracy is
        1 - |learned_divergence - heuristic_divergence|, which measures how
        closely the learned head tracks the heuristic baseline (no ground-truth
        labels available at mvp level).
    """

    # Minimum samples before use_learned can be flipped.
    _GRAD_MIN_SAMPLES: int = 1000
    # Proxy accuracy threshold for graduation (DEC-13 assumption).
    _GRAD_MIN_ACCURACY: float = 0.80

    def __init__(self) -> None:
        self.input_dim = config.ACTION_SPACE_DIM * 5  # 32 * 5 = 160
        self.total_params = 0
        self.use_learned = False  # Start with heuristic, switch when trained
        # Counts how many check() calls have run (proxy for training exposure).
        self.convergence_sample_count: int = 0

        self._build()

    def _build(self) -> None:
        """Initialize weights with Xavier uniform."""
        rng = np.random.RandomState(0xC0DE)

        def xavier(fan_in: int, fan_out: int) -> np.ndarray:
            limit = np.sqrt(6.0 / (fan_in + fan_out))
            return rng.uniform(-limit, limit, (fan_in, fan_out)).astype(np.float32)

        # Layer 1: 160 → 64
        self.w1 = xavier(self.input_dim, 64)
        self.b1 = np.zeros(64, dtype=np.float32)

        # Divergence head: 64 → 1 (sigmoid)
        self.w_div = xavier(64, 1)
        self.b_div = np.zeros(1, dtype=np.float32)

        # NOTE: A panel-adjustment head (64 → 4) was removed here. It was never
        # activated (use_learned stayed False, _predict_learned never read it)
        # and contributed 260 random floats that influenced nothing. Wiring a
        # real adjustment head is deferred until there is a training signal for
        # it; see the graduation TODO in _predict_learned().

        self.total_params = sum(
            a.size for a in [
                self.w1, self.b1,
                self.w_div, self.b_div,
            ]
        )

        logger.info("Convergence model built: %d params", self.total_params)

    def check(
        self,
        global_action_bias: list[float],
        panel_outputs: list[PanelOutput],
        threshold: float = DEFAULT_CONSENSUS_THRESHOLD,
    ) -> ConvergenceOutput:
        """Check convergence between global and panel models.

        Uses heuristic cosine similarity during early bootstrap,
        switches to learned model when trained. After each call the sample
        count is incremented and the graduation criterion is evaluated so
        use_learned can flip automatically without an external trigger.
        """
        global_arr = np.array(global_action_bias, dtype=np.float32)

        # Compute per-panel cosine similarity (always computed, even with learned model)
        panel_agreement = {}
        for panel in panel_outputs:
            panel_arr = np.array(panel.action_bias, dtype=np.float32)
            sim = cosine_similarity(global_arr, panel_arr)
            panel_agreement[panel.panel_name] = sim

        # Heuristic baseline is always cheap to compute and needed for the
        # graduation proxy even after graduation (for logging continuity).
        mean_sim = np.mean(list(panel_agreement.values())) if panel_agreement else 1.0
        heuristic_divergence = 1.0 - mean_sim

        learned_divergence = self._predict_learned(global_arr, panel_outputs)

        self.convergence_sample_count += 1

        # Graduation check: flip use_learned once when the criterion is first met.
        # Guarded by `not self.use_learned` so we never re-evaluate after graduation.
        if not self.use_learned:
            # Proxy accuracy: how closely does the learned head track heuristic?
            # (DEC-13 mvp assumption — no ground-truth labels available.)
            proxy_accuracy = 1.0 - abs(learned_divergence - heuristic_divergence)
            if (
                self.convergence_sample_count >= self._GRAD_MIN_SAMPLES
                and proxy_accuracy >= self._GRAD_MIN_ACCURACY
            ):
                self.use_learned = True
                logger.info(
                    "ConvergenceModel graduated to learned mode "
                    "(sample_count=%d, proxy_accuracy=%.4f)",
                    self.convergence_sample_count,
                    proxy_accuracy,
                )

        divergence_score = learned_divergence if self.use_learned else heuristic_divergence

        consensus = divergence_score < threshold

        return ConvergenceOutput(
            consensus=consensus,
            divergence_score=float(divergence_score),
            panel_agreement=panel_agreement,
        )

    def _predict_learned(
        self,
        global_arr: np.ndarray,
        panel_outputs: list[PanelOutput],
    ) -> float:
        """Forward pass through the learned convergence model."""
        # Assemble input: global(32) + panels(4×32) = 160
        parts = [global_arr]
        for panel in panel_outputs:
            parts.append(np.array(panel.action_bias, dtype=np.float32))

        # Pad if fewer than 4 panels
        while len(parts) < 5:
            parts.append(np.zeros(config.ACTION_SPACE_DIM, dtype=np.float32))

        x = np.concatenate(parts).reshape(1, -1)

        # Forward pass
        h1 = np.maximum(0, x @ self.w1 + self.b1)
        div_raw = h1 @ self.w_div + self.b_div
        divergence = 1.0 / (1.0 + np.exp(-div_raw))

        return float(divergence[0, 0])

    def save(self, directory: str) -> None:
        """Save convergence model weights atomically."""
        os.makedirs(directory, exist_ok=True)
        final_path = os.path.join(directory, "convergence_model.npz")
        tmp_stem = final_path[:-4] + ".tmp"  # strip ".npz", np.savez re-appends it
        np.savez(
            tmp_stem,
            w1=self.w1, b1=self.b1,
            w_div=self.w_div, b_div=self.b_div,
            use_learned=np.array([self.use_learned]),
            convergence_sample_count=np.array([self.convergence_sample_count]),
        )
        os.replace(tmp_stem + ".npz", final_path)

    def load(self, directory: str) -> bool:
        """Load convergence model weights. Tolerates corrupted checkpoints."""
        path = os.path.join(directory, "convergence_model.npz")
        if not os.path.exists(path):
            return False
        try:
            data = np.load(path)
            self.w1 = data["w1"]
            self.b1 = data["b1"]
            self.w_div = data["w_div"]
            self.b_div = data["b_div"]
            # Backward compat: older checkpoints carry "w_adj"/"b_adj" from the
            # removed panel-adjustment head. Silently ignore them.
            if "w_adj" in data or "b_adj" in data:
                logger.debug(
                    "Ignoring legacy w_adj/b_adj keys in %s (dead head removed)",
                    path,
                )
            if "use_learned" in data:
                self.use_learned = bool(data["use_learned"][0])
            if "convergence_sample_count" in data:
                self.convergence_sample_count = int(data["convergence_sample_count"][0])
            # Recompute param count from the live tensors (the loaded arrays may
            # differ in shape from the build-time defaults across versions).
            self.total_params = sum(
                a.size for a in [self.w1, self.b1, self.w_div, self.b_div]
            )
            logger.info("Convergence model loaded from %s", path)
            return True
        except Exception as e:
            logger.warning(
                "Failed to load convergence model from %s: %s. "
                "Keeping initialized weights.", path, e,
            )
            return False

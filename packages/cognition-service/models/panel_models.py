"""Panel Models ("Cortex") — domain-specific models for each CANON panel.

Each panel model processes the global input tensor PLUS its own domain-specific
slice and produces:
  - action_bias: 32-dim soft distribution (its "opinion" on what to do)
  - confidence: scalar [0,1] — how confident this panel is in its opinion
  - domain_signal: 8-dim auxiliary output (panel-specific signals)

Four panels:
  - Drive Engine: specializes in drive dynamics, pressure patterns, relief detection
  - Decision Making: specializes in action selection, latent space matches
  - Learning: specializes in novelty detection, knowledge gaps, consolidation needs
  - Planning: specializes in opportunity assessment, temporal reasoning

Each panel is ~100K parameters. Total ~400K across all four.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import numpy as np

import config

logger = logging.getLogger("cognition_service.panel_models")


@dataclass
class PanelOutput:
    """Output from a single panel model."""
    panel_name: str
    action_bias: list[float]  # 32-dim
    confidence: float  # [0,1]
    domain_signal: list[float]  # 8-dim


class PanelModel:
    """A single panel model: Dense(input→256→128→32+1+8).

    NumPy-only implementation (same pattern as GlobalModel).
    Each panel has a different input size depending on its domain slice.
    """

    def __init__(self, name: str, input_dim: int) -> None:
        self.name = name
        self.input_dim = input_dim
        self.action_dim = config.ACTION_SPACE_DIM  # 32
        self.total_params = 0

        self._build(input_dim)

    def _build(self, input_dim: int) -> None:
        """Initialize weights with Xavier uniform."""
        rng = np.random.RandomState(hash(self.name) & 0xFFFFFFFF)

        def xavier(fan_in: int, fan_out: int) -> np.ndarray:
            limit = np.sqrt(6.0 / (fan_in + fan_out))
            return rng.uniform(-limit, limit, (fan_in, fan_out)).astype(np.float32)

        # Layer 1: input → 256
        self.w1 = xavier(input_dim, 256)
        self.b1 = np.zeros(256, dtype=np.float32)

        # Layer 2: 256 → 128
        self.w2 = xavier(256, 128)
        self.b2 = np.zeros(128, dtype=np.float32)

        # Action head: 128 → 32
        self.w_action = xavier(128, self.action_dim)
        self.b_action = np.zeros(self.action_dim, dtype=np.float32)

        # Confidence head: 128 → 1
        self.w_conf = xavier(128, 1)
        self.b_conf = np.zeros(1, dtype=np.float32)

        # Domain signal head: 128 → 8
        self.w_domain = xavier(128, 8)
        self.b_domain = np.zeros(8, dtype=np.float32)

        self.total_params = sum(
            a.size for a in [
                self.w1, self.b1, self.w2, self.b2,
                self.w_action, self.b_action,
                self.w_conf, self.b_conf,
                self.w_domain, self.b_domain,
            ]
        )

    def predict(self, panel_input: np.ndarray) -> PanelOutput:
        """Forward pass through the panel model.

        Args:
            panel_input: 1D array of the panel's full input (global + domain slice).

        Returns:
            PanelOutput with action_bias, confidence, and domain_signal.
        """
        if panel_input.ndim == 1:
            panel_input = panel_input.reshape(1, -1)

        # Layer 1: ReLU
        h1 = np.maximum(0, panel_input @ self.w1 + self.b1)
        # Layer 2: ReLU
        h2 = np.maximum(0, h1 @ self.w2 + self.b2)

        # Action head: softmax
        logits = h2 @ self.w_action + self.b_action
        exp_logits = np.exp(logits - np.max(logits, axis=-1, keepdims=True))
        action_bias = exp_logits / exp_logits.sum(axis=-1, keepdims=True)

        # Confidence head: sigmoid
        conf_raw = h2 @ self.w_conf + self.b_conf
        confidence = 1.0 / (1.0 + np.exp(-conf_raw))

        # Domain signal head: tanh (allow negative values for richer signals)
        domain_raw = h2 @ self.w_domain + self.b_domain
        domain_signal = np.tanh(domain_raw)

        return PanelOutput(
            panel_name=self.name,
            action_bias=action_bias[0].tolist(),
            confidence=float(confidence[0, 0]),
            domain_signal=domain_signal[0].tolist(),
        )

    def save(self, directory: str) -> None:
        """Save weights to disk atomically.

        Writes to a temp file first, then renames. This prevents truncated
        checkpoint files when the process is killed mid-save.
        """
        os.makedirs(directory, exist_ok=True)
        final_path = os.path.join(directory, f"panel_{self.name}.npz")
        tmp_path = final_path + ".tmp"
        np.savez(
            tmp_path,
            w1=self.w1, b1=self.b1,
            w2=self.w2, b2=self.b2,
            w_action=self.w_action, b_action=self.b_action,
            w_conf=self.w_conf, b_conf=self.b_conf,
            w_domain=self.w_domain, b_domain=self.b_domain,
        )
        os.replace(tmp_path, final_path)

    def load(self, directory: str) -> bool:
        """Load weights from disk. Returns True if loaded.

        Handles corrupted checkpoint files gracefully — logs a warning and
        keeps the existing Xavier-initialized weights rather than crashing.
        """
        path = os.path.join(directory, f"panel_{self.name}.npz")
        if not os.path.exists(path):
            return False
        try:
            data = np.load(path)
            self.w1 = data["w1"]
            self.b1 = data["b1"]
            self.w2 = data["w2"]
            self.b2 = data["b2"]
            self.w_action = data["w_action"]
            self.b_action = data["b_action"]
            self.w_conf = data["w_conf"]
            self.b_conf = data["b_conf"]
            self.w_domain = data["w_domain"]
            self.b_domain = data["b_domain"]
            return True
        except Exception as e:
            logger.warning(
                "Failed to load panel '%s' weights from %s: %s. "
                "Keeping Xavier-initialized weights.",
                self.name, path, e,
            )
            return False


# ---------------------------------------------------------------------------
# Panel input dimensions
# ---------------------------------------------------------------------------
# Each panel gets the full global input (1561) plus domain-specific features.

# Drive Engine panel: global + recent drive history (last 10 ticks × 12 = 120)
DRIVE_PANEL_EXTRA = 120
DRIVE_PANEL_INPUT = config.GLOBAL_INPUT_DIM + DRIVE_PANEL_EXTRA  # 1681

# Decision Making panel: global + latent match scores (top 5)
DECISION_PANEL_EXTRA = 5
DECISION_PANEL_INPUT = config.GLOBAL_INPUT_DIM + DECISION_PANEL_EXTRA  # 1566

# Learning panel: global + recent MAE values (10) + novelty indicators (4)
LEARNING_PANEL_EXTRA = 14
LEARNING_PANEL_INPUT = config.GLOBAL_INPUT_DIM + LEARNING_PANEL_EXTRA  # 1575

# Planning panel: global + opportunity features (priority scores, counts = 8)
PLANNING_PANEL_EXTRA = 8
PLANNING_PANEL_INPUT = config.GLOBAL_INPUT_DIM + PLANNING_PANEL_EXTRA  # 1569


class PanelModels:
    """Container for all four panel models."""

    def __init__(self) -> None:
        self.drive = PanelModel("drive", DRIVE_PANEL_INPUT)
        self.decision = PanelModel("decision", DECISION_PANEL_INPUT)
        self.learning = PanelModel("learning", LEARNING_PANEL_INPUT)
        self.planning = PanelModel("planning", PLANNING_PANEL_INPUT)

        self.panels = [self.drive, self.decision, self.learning, self.planning]
        self.total_params = sum(p.total_params for p in self.panels)

        logger.info(
            "Panel models built: %s (total %d params)",
            ", ".join(f"{p.name}={p.total_params}" for p in self.panels),
            self.total_params,
        )

    def predict_all(
        self,
        global_tensor: np.ndarray,
        drive_history: np.ndarray | None = None,
        latent_scores: np.ndarray | None = None,
        mae_values: np.ndarray | None = None,
        opportunity_features: np.ndarray | None = None,
    ) -> list[PanelOutput]:
        """Run all four panel models and return their opinions.

        Args:
            global_tensor: The same 1561-float tensor used by the global model.
            drive_history: (120,) recent drive vectors. Zero-padded if unavailable.
            latent_scores: (5,) top-K latent space match scores. Zero if unavailable.
            mae_values: (14,) recent MAE + novelty indicators. Zero if unavailable.
            opportunity_features: (8,) opportunity queue features. Zero if unavailable.
        """
        results = []

        # Drive panel
        drive_extra = drive_history if drive_history is not None else np.zeros(DRIVE_PANEL_EXTRA, dtype=np.float32)
        drive_input = np.concatenate([global_tensor, drive_extra])
        results.append(self.drive.predict(drive_input))

        # Decision panel
        decision_extra = latent_scores if latent_scores is not None else np.zeros(DECISION_PANEL_EXTRA, dtype=np.float32)
        decision_input = np.concatenate([global_tensor, decision_extra])
        results.append(self.decision.predict(decision_input))

        # Learning panel
        learning_extra = mae_values if mae_values is not None else np.zeros(LEARNING_PANEL_EXTRA, dtype=np.float32)
        learning_input = np.concatenate([global_tensor, learning_extra])
        results.append(self.learning.predict(learning_input))

        # Planning panel
        planning_extra = opportunity_features if opportunity_features is not None else np.zeros(PLANNING_PANEL_EXTRA, dtype=np.float32)
        planning_input = np.concatenate([global_tensor, planning_extra])
        results.append(self.planning.predict(planning_input))

        return results

    def save(self, directory: str) -> None:
        """Save all panel model weights."""
        for panel in self.panels:
            panel.save(directory)
        logger.info("Panel model weights saved to %s", directory)

    def load(self, directory: str) -> int:
        """Load all panel model weights. Returns count of successfully loaded."""
        loaded = sum(1 for p in self.panels if p.load(directory))
        if loaded:
            logger.info("Loaded %d/%d panel models from %s", loaded, len(self.panels), directory)
        return loaded

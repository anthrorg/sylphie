"""Deliberation Pipelines — three specialized tensor pipelines for Type 2.

When the convergence check detects divergence between global and panel models,
the system escalates to Type 2 deliberation. Instead of multi-LLM focus groups,
three learned tensor pipelines process the same input from genuinely different
perspectives:

  Pragmatist (Outcome Pipeline):
    - Trained on outcome data — what happened when similar decisions were made
    - Weights encode consequence patterns
    - "What has worked before in situations like this?"

  Conservative (Constraint Pipeline):
    - Trained on constraint data — drive boundaries, safety thresholds, invariants
    - Weights encode limits
    - "What must not be broken?"

  Advocate (Novelty Pipeline):
    - Trained on novelty data — when breaking from patterns led to positive outcomes
    - Weights encode possibility
    - "What could we gain by doing something different?"

The Synthesis Model weighs the three pipeline outputs to produce a final
action bias. Over time, it learns *how Sylphie deliberates*.

Architecture per pipeline: Dense(1561→512→256→32), ~450K params each.
Synthesis model: Dense(96→64→32+4), ~7K params.
Total: ~1.36M params.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import numpy as np

import config

logger = logging.getLogger("cognition_service.deliberation")


@dataclass
class PipelineOutput:
    """Output from a single deliberation pipeline."""
    pipeline_name: str
    action_bias: list[float]  # 32-dim
    confidence: float  # [0,1]


@dataclass
class DeliberationOutput:
    """Synthesized output from all three deliberation pipelines."""
    action_bias: list[float]  # 32-dim — final synthesized prior
    confidence: float  # [0,1]
    pipeline_weights: list[float]  # [pragmatist, conservative, advocate] contributions
    pipeline_outputs: list[PipelineOutput]


class DeliberationPipeline:
    """A single deliberation pipeline: Dense(1561→512→256→32+1).

    Same architecture as the global model but trained on different data:
      - Pragmatist: outcome-positive samples
      - Conservative: outcome-negative / constraint-violation samples
      - Advocate: high-novelty + outcome-positive samples
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self.input_dim = config.GLOBAL_INPUT_DIM  # 1561
        self.action_dim = config.ACTION_SPACE_DIM  # 32
        self.total_params = 0

        self._build()

    def _build(self) -> None:
        """Initialize with Xavier uniform (deterministic seed per pipeline)."""
        seed_map = {
            "pragmatist": 0xD1A6,
            "conservative": 0xC0A5,
            "advocate": 0xAD10,
        }
        rng = np.random.RandomState(seed_map.get(self.name, hash(self.name) & 0xFFFFFFFF))

        def xavier(fan_in: int, fan_out: int) -> np.ndarray:
            limit = np.sqrt(6.0 / (fan_in + fan_out))
            return rng.uniform(-limit, limit, (fan_in, fan_out)).astype(np.float32)

        # Layer 1: input → 512
        self.w1 = xavier(self.input_dim, 512)
        self.b1 = np.zeros(512, dtype=np.float32)

        # Layer 2: 512 → 256
        self.w2 = xavier(512, 256)
        self.b2 = np.zeros(256, dtype=np.float32)

        # Action head: 256 → 32 (softmax)
        self.w_action = xavier(256, self.action_dim)
        self.b_action = np.zeros(self.action_dim, dtype=np.float32)

        # Confidence head: 256 → 1 (sigmoid)
        self.w_conf = xavier(256, 1)
        self.b_conf = np.zeros(1, dtype=np.float32)

        self.total_params = sum(
            a.size for a in [
                self.w1, self.b1, self.w2, self.b2,
                self.w_action, self.b_action,
                self.w_conf, self.b_conf,
            ]
        )

    def predict(self, state_tensor: np.ndarray) -> PipelineOutput:
        """Forward pass through the pipeline."""
        if state_tensor.ndim == 1:
            state_tensor = state_tensor.reshape(1, -1)

        # Layer 1: ReLU
        h1 = np.maximum(0, state_tensor @ self.w1 + self.b1)
        # Layer 2: ReLU
        h2 = np.maximum(0, h1 @ self.w2 + self.b2)

        # Action head: softmax
        logits = h2 @ self.w_action + self.b_action
        exp_logits = np.exp(logits - np.max(logits, axis=-1, keepdims=True))
        action_bias = exp_logits / exp_logits.sum(axis=-1, keepdims=True)

        # Confidence head: sigmoid
        conf_raw = h2 @ self.w_conf + self.b_conf
        confidence = 1.0 / (1.0 + np.exp(-conf_raw))

        return PipelineOutput(
            pipeline_name=self.name,
            action_bias=action_bias[0].tolist(),
            confidence=float(confidence[0, 0]),
        )

    def save(self, directory: str) -> None:
        """Save pipeline weights atomically."""
        os.makedirs(directory, exist_ok=True)
        final_path = os.path.join(directory, f"delib_{self.name}.npz")
        tmp_path = final_path + ".tmp"
        np.savez(
            tmp_path,
            w1=self.w1, b1=self.b1,
            w2=self.w2, b2=self.b2,
            w_action=self.w_action, b_action=self.b_action,
            w_conf=self.w_conf, b_conf=self.b_conf,
        )
        os.replace(tmp_path, final_path)

    def load(self, directory: str) -> bool:
        """Load pipeline weights. Tolerates corrupted checkpoints."""
        path = os.path.join(directory, f"delib_{self.name}.npz")
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
            return True
        except Exception as e:
            logger.warning(
                "Failed to load deliberation pipeline '%s' from %s: %s. "
                "Keeping initialized weights.", self.name, path, e,
            )
            return False


class SynthesisModel:
    """Learned weighting function across three deliberation pipelines.

    Input: 3 * action_bias(32) = 96 floats
    Architecture: Dense(96→64→32+4)
    Output:
      - action_bias: 32-dim final synthesized action prior
      - pipeline_weights: 3 floats (softmax) — how much each pipeline contributed
      - confidence: 1 float (sigmoid)

    ~7K parameters.
    """

    def __init__(self) -> None:
        self.input_dim = config.ACTION_SPACE_DIM * 3  # 96
        self.action_dim = config.ACTION_SPACE_DIM  # 32
        self.total_params = 0

        self._build()

    def _build(self) -> None:
        rng = np.random.RandomState(0x5171)

        def xavier(fan_in: int, fan_out: int) -> np.ndarray:
            limit = np.sqrt(6.0 / (fan_in + fan_out))
            return rng.uniform(-limit, limit, (fan_in, fan_out)).astype(np.float32)

        # Layer 1: 96 → 64
        self.w1 = xavier(self.input_dim, 64)
        self.b1 = np.zeros(64, dtype=np.float32)

        # Action head: 64 → 32 (softmax)
        self.w_action = xavier(64, self.action_dim)
        self.b_action = np.zeros(self.action_dim, dtype=np.float32)

        # Pipeline weight head: 64 → 3 (softmax — which pipeline to trust)
        self.w_weights = xavier(64, 3)
        self.b_weights = np.zeros(3, dtype=np.float32)

        # Confidence head: 64 → 1 (sigmoid)
        self.w_conf = xavier(64, 1)
        self.b_conf = np.zeros(1, dtype=np.float32)

        self.total_params = sum(
            a.size for a in [
                self.w1, self.b1,
                self.w_action, self.b_action,
                self.w_weights, self.b_weights,
                self.w_conf, self.b_conf,
            ]
        )

    def synthesize(self, pipeline_outputs: list[PipelineOutput]) -> DeliberationOutput:
        """Combine three pipeline outputs into a final action prior."""
        # Assemble input: concat all action biases
        parts = [np.array(p.action_bias, dtype=np.float32) for p in pipeline_outputs]
        # Pad if fewer than 3 pipelines
        while len(parts) < 3:
            parts.append(np.zeros(self.action_dim, dtype=np.float32))
        x = np.concatenate(parts).reshape(1, -1)

        # Forward pass
        h1 = np.maximum(0, x @ self.w1 + self.b1)

        # Action head: softmax
        logits = h1 @ self.w_action + self.b_action
        exp_logits = np.exp(logits - np.max(logits, axis=-1, keepdims=True))
        action_bias = exp_logits / exp_logits.sum(axis=-1, keepdims=True)

        # Pipeline weights: softmax over 3
        wt_logits = h1 @ self.w_weights + self.b_weights
        wt_exp = np.exp(wt_logits - np.max(wt_logits, axis=-1, keepdims=True))
        pipeline_weights = wt_exp / wt_exp.sum(axis=-1, keepdims=True)

        # Confidence: sigmoid
        conf_raw = h1 @ self.w_conf + self.b_conf
        confidence = 1.0 / (1.0 + np.exp(-conf_raw))

        return DeliberationOutput(
            action_bias=action_bias[0].tolist(),
            confidence=float(confidence[0, 0]),
            pipeline_weights=pipeline_weights[0].tolist(),
            pipeline_outputs=pipeline_outputs,
        )

    def save(self, directory: str) -> None:
        """Save synthesis model weights atomically."""
        os.makedirs(directory, exist_ok=True)
        final_path = os.path.join(directory, "synthesis_model.npz")
        tmp_path = final_path + ".tmp"
        np.savez(
            tmp_path,
            w1=self.w1, b1=self.b1,
            w_action=self.w_action, b_action=self.b_action,
            w_weights=self.w_weights, b_weights=self.b_weights,
            w_conf=self.w_conf, b_conf=self.b_conf,
        )
        os.replace(tmp_path, final_path)

    def load(self, directory: str) -> bool:
        """Load synthesis model weights. Tolerates corrupted checkpoints."""
        path = os.path.join(directory, "synthesis_model.npz")
        if not os.path.exists(path):
            return False
        try:
            data = np.load(path)
            self.w1 = data["w1"]
            self.b1 = data["b1"]
            self.w_action = data["w_action"]
            self.b_action = data["b_action"]
            self.w_weights = data["w_weights"]
            self.b_weights = data["b_weights"]
            self.w_conf = data["w_conf"]
            self.b_conf = data["b_conf"]
            return True
        except Exception as e:
            logger.warning(
                "Failed to load synthesis model from %s: %s. "
                "Keeping initialized weights.", path, e,
            )
            return False


class DeliberationSystem:
    """Container for all deliberation components."""

    def __init__(self) -> None:
        self.pragmatist = DeliberationPipeline("pragmatist")
        self.conservative = DeliberationPipeline("conservative")
        self.advocate = DeliberationPipeline("advocate")
        self.synthesis = SynthesisModel()

        self.pipelines = [self.pragmatist, self.conservative, self.advocate]
        self.total_params = (
            sum(p.total_params for p in self.pipelines)
            + self.synthesis.total_params
        )

        logger.info(
            "Deliberation system built: %s + synthesis=%d (total %d params)",
            ", ".join(f"{p.name}={p.total_params}" for p in self.pipelines),
            self.synthesis.total_params,
            self.total_params,
        )

    def deliberate(self, state_tensor: np.ndarray) -> DeliberationOutput:
        """Run all three pipelines and synthesize the result.

        Args:
            state_tensor: The same 1561-float tensor used by the global model.

        Returns:
            DeliberationOutput with synthesized action bias and pipeline weights.
        """
        # Run all three pipelines on the same input
        pipeline_outputs = [p.predict(state_tensor) for p in self.pipelines]

        # Synthesize
        return self.synthesis.synthesize(pipeline_outputs)

    def save(self, directory: str) -> None:
        for pipeline in self.pipelines:
            pipeline.save(directory)
        self.synthesis.save(directory)
        logger.info("Deliberation system saved to %s", directory)

    def load(self, directory: str) -> int:
        loaded = sum(1 for p in self.pipelines if p.load(directory))
        if self.synthesis.load(directory):
            loaded += 1
        if loaded:
            logger.info("Loaded %d/4 deliberation components from %s", loaded, directory)
        return loaded

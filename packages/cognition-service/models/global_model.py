"""Global Model ("Brainstem") — full fused state tensor to action prior.

Receives the complete cognitive state (fused embedding + drive vector + drive
deltas + total pressure + episodic context = 1561 floats) and produces:
  - action_bias: 32-dim soft distribution over response categories
  - urgency: scalar [0,1] — how urgently action is needed
  - novelty_score: scalar [0,1] — how novel this situation appears

Single forward pass. Sub-millisecond inference on CPU.
~450K parameters.

This is the first model to go online during bootstrap. It provides the
fast global action prior that panel models refine.
"""

from __future__ import annotations

import logging
import os

import numpy as np

logger = logging.getLogger("cognition_service.global_model")

try:
    import tensorflow as tf
    HAS_TF = True
except ImportError:
    HAS_TF = False
    logger.warning("TensorFlow not installed — using NumPy fallback for global model")

import config


class GlobalModel:
    """Dense network: 1561 → 512 → 256 → (32 + 2).

    Uses TensorFlow when available, falls back to NumPy matrix math
    for environments where TF is not installed (e.g., lightweight testing).
    """

    def __init__(self) -> None:
        self.input_dim = config.GLOBAL_INPUT_DIM  # 1561
        self.action_dim = config.ACTION_SPACE_DIM  # 32
        self.total_params = 0
        self._built = False

        if HAS_TF:
            self._build_tf()
        else:
            self._build_numpy()

    # ------------------------------------------------------------------
    # TensorFlow implementation
    # ------------------------------------------------------------------

    def _build_tf(self) -> None:
        """Build the model using TensorFlow Keras functional API."""
        inp = tf.keras.Input(shape=(self.input_dim,), name="state_tensor")

        x = tf.keras.layers.Dense(512, activation="relu", name="hidden_1")(inp)
        x = tf.keras.layers.Dense(256, activation="relu", name="hidden_2")(x)

        # Action prior: softmax distribution over action categories
        action_bias = tf.keras.layers.Dense(
            self.action_dim, activation="softmax", name="action_bias"
        )(x)

        # Auxiliary outputs: urgency + novelty
        aux = tf.keras.layers.Dense(2, activation="sigmoid", name="aux_outputs")(x)

        self.model = tf.keras.Model(inputs=inp, outputs=[action_bias, aux])
        self.total_params = self.model.count_params()
        self._built = True

        logger.info(
            "Global model built (TensorFlow): %d parameters", self.total_params
        )

    # ------------------------------------------------------------------
    # NumPy fallback (for testing without TF)
    # ------------------------------------------------------------------

    def _build_numpy(self) -> None:
        """Initialize weight matrices with Xavier uniform initialization."""
        rng = np.random.RandomState(0xBEEF)  # deterministic seed

        def xavier(fan_in: int, fan_out: int) -> np.ndarray:
            limit = np.sqrt(6.0 / (fan_in + fan_out))
            return rng.uniform(-limit, limit, (fan_in, fan_out)).astype(np.float32)

        # Layer 1: input_dim → 512
        self.w1 = xavier(self.input_dim, 512)
        self.b1 = np.zeros(512, dtype=np.float32)

        # Layer 2: 512 → 256
        self.w2 = xavier(512, 256)
        self.b2 = np.zeros(256, dtype=np.float32)

        # Action head: 256 → action_dim
        self.w_action = xavier(256, self.action_dim)
        self.b_action = np.zeros(self.action_dim, dtype=np.float32)

        # Aux head: 256 → 2
        self.w_aux = xavier(256, 2)
        self.b_aux = np.zeros(2, dtype=np.float32)

        self.total_params = (
            self.w1.size + self.b1.size
            + self.w2.size + self.b2.size
            + self.w_action.size + self.b_action.size
            + self.w_aux.size + self.b_aux.size
        )
        self._built = True

        logger.info(
            "Global model built (NumPy fallback): %d parameters", self.total_params
        )

    # ------------------------------------------------------------------
    # Forward pass
    # ------------------------------------------------------------------

    def predict(self, state_tensor: np.ndarray) -> dict:
        """Run a forward pass.

        Args:
            state_tensor: 1D array of shape (1561,) or 2D (1, 1561).

        Returns:
            dict with keys: action_bias (32,), urgency (float), novelty_score (float)
        """
        if not self._built:
            raise RuntimeError("Global model not built")

        # Ensure 2D input
        if state_tensor.ndim == 1:
            state_tensor = state_tensor.reshape(1, -1)

        if HAS_TF and hasattr(self, "model"):
            return self._predict_tf(state_tensor)
        else:
            return self._predict_numpy(state_tensor)

    def _predict_tf(self, x: np.ndarray) -> dict:
        """Forward pass using TensorFlow."""
        action_bias, aux = self.model(x, training=False)
        action_bias = action_bias.numpy()[0]
        aux = aux.numpy()[0]
        return {
            "action_bias": action_bias.tolist(),
            "urgency": float(aux[0]),
            "novelty_score": float(aux[1]),
        }

    def _predict_numpy(self, x: np.ndarray) -> dict:
        """Forward pass using NumPy (fallback)."""
        # Layer 1: ReLU
        h1 = np.maximum(0, x @ self.w1 + self.b1)
        # Layer 2: ReLU
        h2 = np.maximum(0, h1 @ self.w2 + self.b2)
        # Action head: softmax
        logits = h2 @ self.w_action + self.b_action
        exp_logits = np.exp(logits - np.max(logits, axis=-1, keepdims=True))
        action_bias = exp_logits / exp_logits.sum(axis=-1, keepdims=True)
        # Aux head: sigmoid
        aux_raw = h2 @ self.w_aux + self.b_aux
        aux = 1.0 / (1.0 + np.exp(-aux_raw))

        return {
            "action_bias": action_bias[0].tolist(),
            "urgency": float(aux[0, 0]),
            "novelty_score": float(aux[0, 1]),
        }

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save(self, directory: str) -> None:
        """Save model weights to disk atomically."""
        os.makedirs(directory, exist_ok=True)
        if HAS_TF and hasattr(self, "model"):
            # Keras save_weights is already fairly safe, but use tmp+rename for npz
            self.model.save_weights(os.path.join(directory, "global_model.weights.h5"))
        else:
            final_path = os.path.join(directory, "global_model_np.npz")
            tmp_path = final_path + ".tmp"
            np.savez(
                tmp_path,
                w1=self.w1, b1=self.b1,
                w2=self.w2, b2=self.b2,
                w_action=self.w_action, b_action=self.b_action,
                w_aux=self.w_aux, b_aux=self.b_aux,
            )
            os.replace(tmp_path, final_path)
        logger.info("Global model weights saved to %s", directory)

    def load(self, directory: str) -> bool:
        """Load model weights from disk. Returns True if loaded, False if no checkpoint.

        Handles the transition from NumPy-saved weights (.npz) to TensorFlow
        Keras weights (.h5). If TF is available, tries .h5 first; if not found,
        loads from .npz and copies weights into the TF model layers.

        Tolerates corrupted checkpoint files — logs a warning and keeps the
        existing Xavier-initialized weights rather than crashing.
        """
        h5_path = os.path.join(directory, "global_model.weights.h5")
        npz_path = os.path.join(directory, "global_model_np.npz")

        try:
            if HAS_TF and hasattr(self, "model"):
                # Prefer native Keras weights
                if os.path.exists(h5_path):
                    self.model.load_weights(h5_path)
                    logger.info("Global model weights loaded from %s", h5_path)
                    return True
                # Fall back to NumPy checkpoint — copy weights into TF model
                if os.path.exists(npz_path):
                    data = np.load(npz_path)
                    weights = [
                        data["w1"], data["b1"],
                        data["w2"], data["b2"],
                        data["w_action"], data["b_action"],
                        data["w_aux"], data["b_aux"],
                    ]
                    self.model.set_weights(weights)
                    logger.info("Global model (TF) loaded from NumPy checkpoint %s", npz_path)
                    return True
            else:
                if os.path.exists(npz_path):
                    data = np.load(npz_path)
                    self.w1 = data["w1"]
                    self.b1 = data["b1"]
                    self.w2 = data["w2"]
                    self.b2 = data["b2"]
                    self.w_action = data["w_action"]
                    self.b_action = data["b_action"]
                    self.w_aux = data["w_aux"]
                    self.b_aux = data["b_aux"]
                    logger.info("Global model (NumPy) weights loaded from %s", npz_path)
                    return True
        except Exception as e:
            logger.warning(
                "Failed to load global model from %s: %s. "
                "Keeping initialized weights.", directory, e,
            )
        return False

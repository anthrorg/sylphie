"""Background training loop for the cognition service.

Runs in a daemon thread so it dies cleanly with the main process. Inference
is never blocked — the training thread only acquires the model weight lock
during the brief window when it copies gradients into the weight matrices.

Architecture note:
    Training targets the NumPy model exclusively. TensorFlow GradientTape
    training can be layered on later when TF is confirmed to be installed
    in production. The NumPy path is self-contained, has no external
    dependencies, and is straightforward to test.

Loss signal during bootstrap:
    Primary: cross-entropy between the model's softmax action_bias output
             and a one-hot label derived from action_category.
    The 32-dim action space is an open vocabulary. Unknown categories are
    mapped to index 0 on first sight. Index 31 is reserved for "shrug"
    (the LLM declined to act). As the vocabulary fills in, early index-0
    assignments are left as-is — they act as a soft "unknown" class.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

import numpy as np

import config
from inference.cycle import CognitiveCycle
from training.data_buffer import DataBuffer
from training.replay import EWCRegularizer, ExperienceReplay

logger = logging.getLogger("cognition_service.training")

# ---------------------------------------------------------------------------
# Action category vocabulary
# ---------------------------------------------------------------------------

# Index 31 is permanently reserved for "shrug" so it never gets displaced.
_SHRUG_INDEX = config.ACTION_SPACE_DIM - 1   # 31
_UNKNOWN_INDEX = 0


class ActionVocabulary:
    """Growing mapping from action_category strings to 0-based indices.

    Thread-safe. Built lazily as new categories arrive in training samples.
    Index 0 is permanently "unknown", index 31 is permanently "shrug".
    Indices 1-30 are assigned in arrival order to other categories.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._vocab: dict[str, int] = {
            "unknown": _UNKNOWN_INDEX,
            "shrug": _SHRUG_INDEX,
        }
        self._next_idx: int = 1   # next assignable index (skips 0 and 31)

    def index_of(self, category: str | None) -> int:
        """Return the integer index for a category, registering it if new.

        Args:
            category: Action category string (may be None).

        Returns:
            Integer in [0, ACTION_SPACE_DIM).
        """
        if not category:
            return _UNKNOWN_INDEX
        category = category.strip().lower()
        with self._lock:
            if category in self._vocab:
                return self._vocab[category]
            if self._next_idx >= _SHRUG_INDEX:
                # Vocabulary full — collapse into unknown rather than evict shrug.
                logger.warning(
                    "Action vocabulary full (%d categories). "
                    "New category '%s' mapped to unknown (0).",
                    len(self._vocab),
                    category,
                )
                return _UNKNOWN_INDEX
            idx = self._next_idx
            self._vocab[category] = idx
            self._next_idx += 1
            logger.debug("New action category '%s' -> index %d", category, idx)
            return idx

    def get_name(self, index: int) -> str:
        """Get the category name for a given vocabulary index.

        Performs a reverse lookup by scanning the vocab dict. This is only
        called during bootstrap comparison, not in the hot inference path,
        so linear scan is acceptable.

        Args:
            index: Integer index in [0, ACTION_SPACE_DIM).

        Returns:
            The category name, or "unknown" if the index has not been assigned.
        """
        with self._lock:
            for name, idx in self._vocab.items():
                if idx == index:
                    return name
        return "unknown"

    def __len__(self) -> int:
        with self._lock:
            return len(self._vocab)


# ---------------------------------------------------------------------------
# Adam optimizer (NumPy)
# ---------------------------------------------------------------------------


class AdamOptimizer:
    """Standard Adam optimizer operating on lists of numpy weight arrays.

    Maintains first- and second-moment estimates per weight tensor.
    State is initialised lazily on the first call to step() so the
    optimizer does not need to know the weight shapes at construction time.

    Reference: Kingma & Ba (2014), https://arxiv.org/abs/1412.6980
    """

    def __init__(
        self,
        lr: float = 0.001,
        beta1: float = 0.9,
        beta2: float = 0.999,
        epsilon: float = 1e-8,
    ) -> None:
        self.lr = lr
        self.beta1 = beta1
        self.beta2 = beta2
        self.epsilon = epsilon
        self._t: int = 0
        self._m: list[np.ndarray] | None = None   # first moment
        self._v: list[np.ndarray] | None = None   # second moment

    def step(
        self,
        params: list[np.ndarray],
        grads: list[np.ndarray],
    ) -> None:
        """Apply one Adam update step in-place to all parameters.

        m_t = beta1 * m_{t-1} + (1 - beta1) * g_t
        v_t = beta2 * v_{t-1} + (1 - beta2) * g_t^2
        m_hat = m_t / (1 - beta1^t)
        v_hat = v_t / (1 - beta2^t)
        param -= lr * m_hat / (sqrt(v_hat) + eps)

        Args:
            params: List of weight arrays. Modified in-place.
            grads:  List of gradient arrays, same shapes as params.
        """
        if self._m is None:
            self._m = [np.zeros_like(p) for p in params]
            self._v = [np.zeros_like(p) for p in params]

        self._t += 1
        bc1 = 1.0 - self.beta1 ** self._t
        bc2 = 1.0 - self.beta2 ** self._t

        for i, (p, g) in enumerate(zip(params, grads)):
            self._m[i] = self.beta1 * self._m[i] + (1.0 - self.beta1) * g
            self._v[i] = self.beta2 * self._v[i] + (1.0 - self.beta2) * (g * g)
            m_hat = self._m[i] / bc1
            v_hat = self._v[i] / bc2
            p -= self.lr * m_hat / (np.sqrt(v_hat) + self.epsilon)


# ---------------------------------------------------------------------------
# Backpropagation for the GlobalModel (NumPy path)
# ---------------------------------------------------------------------------


def _forward_with_cache(
    model: Any,
    x: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Forward pass through the NumPy GlobalModel, returning all activations.

    Architecture: input(1561) -> Dense(512,relu) -> Dense(256,relu)
                              -> Dense(32,softmax)  [action head]
                              -> Dense(2,sigmoid)   [aux head]

    Args:
        model: GlobalModel instance (NumPy path; must have w1,b1,w2,b2,...).
        x:     Input array of shape (batch, 1561).

    Returns:
        Tuple (h1, h2, action_probs, aux_probs, logits_action) where:
            h1:            (batch, 512) relu activations after layer 1.
            h2:            (batch, 256) relu activations after layer 2.
            action_probs:  (batch, 32)  softmax action distribution.
            aux_probs:     (batch, 2)   sigmoid aux outputs.
            logits_action: (batch, 32)  pre-softmax logits (needed for stable CE grad).
    """
    # Layer 1
    z1 = x @ model.w1 + model.b1          # (batch, 512)
    h1 = np.maximum(0.0, z1)              # ReLU

    # Layer 2
    z2 = h1 @ model.w2 + model.b2         # (batch, 256)
    h2 = np.maximum(0.0, z2)              # ReLU

    # Action head — numerically stable softmax
    logits_action = h2 @ model.w_action + model.b_action  # (batch, 32)
    shifted = logits_action - logits_action.max(axis=-1, keepdims=True)
    exp_a = np.exp(shifted)
    action_probs = exp_a / exp_a.sum(axis=-1, keepdims=True)

    # Aux head — sigmoid
    logits_aux = h2 @ model.w_aux + model.b_aux           # (batch, 2)
    aux_probs = 1.0 / (1.0 + np.exp(-logits_aux))

    return h1, h2, action_probs, aux_probs, logits_action


def _backprop(
    model: Any,
    x: np.ndarray,
    h1: np.ndarray,
    h2: np.ndarray,
    action_probs: np.ndarray,
    labels: np.ndarray,
) -> tuple[list[np.ndarray], float]:
    """Backpropagation through the NumPy GlobalModel.

    Computes gradients for all eight weight tensors using the cross-entropy
    loss on the action head. The aux head (urgency / novelty) is not
    supervised during bootstrap — it will be trained once observed drive
    effects are reliable enough to serve as labels.

    Cross-entropy gradient through softmax has the elegant form:
        d_L/d_logits = (action_probs - one_hot_label) / batch_size

    ReLU gradient: d_z = d_h * (h > 0)  (zero where the unit was inactive).

    Args:
        model:        GlobalModel instance.
        x:            Input batch (batch, 1561).
        h1:           Hidden layer 1 activations (batch, 512).
        h2:           Hidden layer 2 activations (batch, 256).
        action_probs: Softmax output (batch, 32).
        labels:       One-hot target labels (batch, 32).

    Returns:
        Tuple (grads, loss) where grads is a list of eight arrays in the
        weight order [w1, b1, w2, b2, w_action, b_action, w_aux, b_aux].
        w_aux and b_aux gradients are zero (aux head not supervised yet).
    """
    batch = x.shape[0]

    # --- Action head cross-entropy loss ---
    # Clip probs for numerical safety before log.
    loss = float(-np.sum(labels * np.log(np.clip(action_probs, 1e-12, 1.0))) / batch)

    # Gradient of CE w.r.t. pre-softmax logits (combined softmax+CE derivative).
    d_logits_action = (action_probs - labels) / batch   # (batch, 32)

    # Gradients for action head weights.
    d_w_action = h2.T @ d_logits_action                  # (256, 32)
    d_b_action = d_logits_action.sum(axis=0)             # (32,)

    # Backprop through action head into h2.
    d_h2_from_action = d_logits_action @ model.w_action.T  # (batch, 256)

    # Aux head contributes zero gradient (not supervised during bootstrap).
    d_h2 = d_h2_from_action                               # (batch, 256)

    # --- Layer 2 ---
    # ReLU gate: zero gradient where h2 == 0.
    d_z2 = d_h2 * (h2 > 0.0)                             # (batch, 256)
    d_w2 = h1.T @ d_z2                                   # (512, 256)
    d_b2 = d_z2.sum(axis=0)                              # (256,)

    # Backprop into h1.
    d_h1 = d_z2 @ model.w2.T                             # (batch, 512)

    # --- Layer 1 ---
    d_z1 = d_h1 * (h1 > 0.0)                             # (batch, 512)
    d_w1 = x.T @ d_z1                                    # (1561, 512)
    d_b1 = d_z1.sum(axis=0)                              # (512,)

    # Aux gradients — zeros, same shapes as the actual weights.
    d_w_aux = np.zeros_like(model.w_aux)
    d_b_aux = np.zeros_like(model.b_aux)

    grads = [d_w1, d_b1, d_w2, d_b2, d_w_action, d_b_action, d_w_aux, d_b_aux]
    return grads, loss


def _build_labels(
    samples: list[dict[str, Any]],
    vocab: ActionVocabulary,
) -> np.ndarray:
    """Build a one-hot label matrix from a batch of training samples.

    Args:
        samples: Batch of sample dicts (from DataBuffer).
        vocab:   ActionVocabulary for mapping category strings to indices.

    Returns:
        Float32 array of shape (batch, ACTION_SPACE_DIM).
    """
    batch = len(samples)
    labels = np.zeros((batch, config.ACTION_SPACE_DIM), dtype=np.float32)
    for i, s in enumerate(samples):
        idx = vocab.index_of(s.get("action_category"))
        labels[i, idx] = 1.0
    return labels


def _build_input_batch(samples: list[dict[str, Any]]) -> np.ndarray:
    """Stack sample input tensors into a 2D batch array.

    Each sample provides fused_embedding + drive_vector + drive_deltas +
    total_pressure + episodic_context, mirroring the layout in
    CognitiveCycle._assemble_global_input().

    Args:
        samples: Batch of sample dicts.

    Returns:
        Float32 array of shape (batch, GLOBAL_INPUT_DIM).
    """
    rows = []
    for s in samples:
        fused = s["fused_embedding"]
        drive = s["drive_vector"]
        deltas = s["drive_deltas"]
        pressure = np.array([float(s["total_pressure"])], dtype=np.float32)
        episodic = s["episodic_context"]

        # All of these were converted to numpy in DataBuffer.add(); handle the
        # edge case where a test injects raw lists.
        def _ensure(v: Any) -> np.ndarray:
            if isinstance(v, np.ndarray):
                return v.astype(np.float32)
            return np.array(v, dtype=np.float32)

        row = np.concatenate([
            _ensure(fused),
            _ensure(drive),
            _ensure(deltas),
            pressure,
            _ensure(episodic),
        ])
        rows.append(row)
    return np.stack(rows, axis=0)


# ---------------------------------------------------------------------------
# Trainer
# ---------------------------------------------------------------------------


class Trainer:
    """Background training thread that continuously updates model weights.

    Threading model:
        - One daemon thread runs _training_loop().
        - Inference (CognitiveCycle.run) reads model weights directly and
          never acquires a lock — reads on numpy float32 arrays are atomic
          on all platforms we target.
        - The trainer acquires _weight_lock only for the brief period when
          it copies updated weight values back into the model (in-place
          array assignment). This is sub-millisecond and does not stall
          inference in practice.
        - A threading.Event (_stop_event) signals the loop to exit cleanly.

    Weight order convention (same as GlobalModel.save / GlobalModel.load):
        [w1, b1, w2, b2, w_action, b_action, w_aux, b_aux]
    """

    _BATCH_SIZE = 32
    _LOG_INTERVAL = 100   # log metrics every N steps

    def __init__(self, cycle: CognitiveCycle, buffer: DataBuffer) -> None:
        self._cycle = cycle
        self._buffer = buffer
        self._replay = ExperienceReplay(
            batch_size=self._BATCH_SIZE,
            replay_fraction=0.5,
        )
        self._optimizer = AdamOptimizer(lr=0.001)
        self._ewc = EWCRegularizer()
        self._vocab = ActionVocabulary()

        self._weight_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

        self._training_steps: int = 0
        self._last_loss: float | None = None
        self._step_lock = threading.Lock()  # protects _training_steps / _last_loss

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the background training thread.

        Safe to call multiple times — a second call is a no-op if the
        thread is already running.
        """
        if self._thread is not None and self._thread.is_alive():
            logger.warning("Trainer.start() called but thread is already running")
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._training_loop,
            name="cognition-trainer",
            daemon=True,
        )
        self._thread.start()
        logger.info("Training thread started")

    def stop(self) -> None:
        """Signal the training thread to stop and wait for it to exit.

        Blocks for up to 5 seconds. If the thread does not exit in that
        window (e.g., stuck in a slow NumPy op) it is abandoned — it is a
        daemon thread so the process will exit cleanly regardless.
        """
        if self._thread is None:
            return
        self._stop_event.set()
        self._thread.join(timeout=5.0)
        if self._thread.is_alive():
            logger.warning("Training thread did not stop within 5 s — abandoning")
        else:
            logger.info("Training thread stopped (total_steps=%d)", self._training_steps)

    # ------------------------------------------------------------------
    # Public properties (thread-safe reads)
    # ------------------------------------------------------------------

    @property
    def training_steps(self) -> int:
        """Total number of completed training steps."""
        with self._step_lock:
            return self._training_steps

    @property
    def last_loss(self) -> float | None:
        """Cross-entropy loss from the most recent training step, or None."""
        with self._step_lock:
            return self._last_loss

    # ------------------------------------------------------------------
    # Bootstrap support
    # ------------------------------------------------------------------

    def get_top_category(self, action_bias: list[float]) -> str:
        """Convert the model's action_bias vector to the top category name.

        Looks up the argmax index in the ActionVocabulary. If the index has
        not yet been registered (e.g., the model is brand-new and the vocab
        only contains "unknown" and "shrug"), returns "unknown".

        Called by main.py during POST /cognition/train to build the tensor
        side of each bootstrap comparison pair.

        Args:
            action_bias: The 32-float softmax action distribution from a
                         CognitionCycleResponse.global_prior.action_bias.

        Returns:
            The category name string for the highest-probability action slot.
        """
        import numpy as np
        top_idx = int(np.argmax(action_bias))
        return self._vocab.get_name(top_idx)

    # ------------------------------------------------------------------
    # Training loop
    # ------------------------------------------------------------------

    # Minimum samples before training begins. With fewer samples the model
    # memorises instantly (loss→0) and checkpoints burn disk I/O for nothing.
    _MIN_BUFFER_SIZE = 10

    # Minimum seconds between weight checkpoints. Prevents save-spamming
    # when the training loop spins faster than the checkpoint interval
    # would suggest (e.g., 1000 steps takes <1s with a tiny buffer).
    _MIN_CHECKPOINT_INTERVAL_SEC = 60.0

    def _training_loop(self) -> None:
        """Main loop executed by the background thread.

        Runs until _stop_event is set. Sleeps briefly when the buffer is
        too small to form a batch to avoid busy-spinning.
        """
        logger.info("Training loop started — waiting for samples")
        last_checkpoint_time = time.monotonic()
        while not self._stop_event.is_set():
            # Wait for meaningful data before starting to train.
            if len(self._buffer) < self._MIN_BUFFER_SIZE:
                self._stop_event.wait(timeout=1.0)
                continue

            batch = self._replay.sample(self._buffer)
            if len(batch) < 2:
                self._stop_event.wait(timeout=0.5)
                continue

            try:
                loss = self._train_step(batch)
            except Exception:
                logger.exception("Training step failed — continuing")
                continue

            with self._step_lock:
                self._training_steps += 1
                self._last_loss = loss
                steps = self._training_steps

            if steps % self._LOG_INTERVAL == 0:
                logger.info(
                    "Training step %d | loss=%.6f | vocab=%d | buffer=%d",
                    steps,
                    loss,
                    len(self._vocab),
                    len(self._buffer),
                )

            # Checkpoint gated on both step count AND wall-clock time.
            # Prevents save-spamming when steps fly at thousands/second.
            if steps % config.CHECKPOINT_INTERVAL == 0:
                now = time.monotonic()
                if (now - last_checkpoint_time) >= self._MIN_CHECKPOINT_INTERVAL_SEC:
                    self._save_checkpoint(steps)
                    last_checkpoint_time = now

            # Yield between steps to prevent busy-spinning when the buffer
            # is small and steps complete in microseconds.
            self._stop_event.wait(timeout=0.01)

        logger.info("Training loop exited")

    # ------------------------------------------------------------------
    # Single training step
    # ------------------------------------------------------------------

    def _train_step(self, batch: list[dict[str, Any]]) -> float:
        """Run one forward+backward+update cycle on a mini-batch.

        1. Build input batch and one-hot labels from the samples.
        2. Forward pass (saving intermediate activations).
        3. Backprop to get gradients.
        4. Add EWC penalty gradients (zero until set_reference() is called).
        5. Apply Adam update.
        6. Write updated weights back into the model (brief lock).

        Args:
            batch: List of sample dicts from the DataBuffer.

        Returns:
            Cross-entropy loss scalar for this batch.
        """
        model = self._cycle.global_model

        # Only the NumPy path is trained here. If TF is loaded, skip.
        if not hasattr(model, "w1"):
            # TF model present — not training via NumPy path.
            return 0.0

        x = _build_input_batch(batch)
        labels = _build_labels(batch, self._vocab)

        # Forward
        h1, h2, action_probs, aux_probs, _ = _forward_with_cache(model, x)

        # Backprop
        grads, loss = _backprop(model, x, h1, h2, action_probs, labels)

        # EWC penalty gradients (zero until a reference point is set)
        current_weights = self._get_weights(model)
        ewc_grads = self._ewc.penalty_gradients(current_weights, lambda_ewc=0.1)
        grads = [g + eg for g, eg in zip(grads, ewc_grads)]

        # Adam update (operates on separate copies to avoid partial writes)
        weight_copies = [w.copy() for w in current_weights]
        self._optimizer.step(weight_copies, grads)

        # Write updated weights back into the model under the lock.
        with self._weight_lock:
            self._set_weights(model, weight_copies)

        return loss

    # ------------------------------------------------------------------
    # Weight access helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _get_weights(model: Any) -> list[np.ndarray]:
        """Return the model's weight arrays as a list (no copy).

        Order: [w1, b1, w2, b2, w_action, b_action, w_aux, b_aux]
        """
        return [
            model.w1, model.b1,
            model.w2, model.b2,
            model.w_action, model.b_action,
            model.w_aux, model.b_aux,
        ]

    @staticmethod
    def _set_weights(model: Any, weights: list[np.ndarray]) -> None:
        """Copy updated weight values into the model arrays in-place.

        In-place copy (np.copyto) avoids object replacement — the model's
        forward pass code reads the same array objects, so no reference
        changes are needed.

        Args:
            model:   GlobalModel instance (NumPy path).
            weights: Eight updated weight arrays in canonical order.
        """
        np.copyto(model.w1, weights[0])
        np.copyto(model.b1, weights[1])
        np.copyto(model.w2, weights[2])
        np.copyto(model.b2, weights[3])
        np.copyto(model.w_action, weights[4])
        np.copyto(model.b_action, weights[5])
        np.copyto(model.w_aux, weights[6])
        np.copyto(model.b_aux, weights[7])

    # ------------------------------------------------------------------
    # Checkpoint
    # ------------------------------------------------------------------

    def _save_checkpoint(self, step: int) -> None:
        """Save a periodic checkpoint without blocking inference.

        Args:
            step: Current training step count (for log messages only).
        """
        try:
            path = self._cycle.save_checkpoint(foundation=False)
            logger.info("Checkpoint saved at step %d -> %s", step, path)
        except Exception:
            logger.exception("Checkpoint save failed at step %d", step)

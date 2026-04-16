"""Configuration for the cognition service.

All settings are read from environment variables with sensible defaults
for local development.
"""

from __future__ import annotations

import os

# --- Server ---
PORT = int(os.getenv("COGNITION_PORT", "8431"))

# --- Bootstrap ---
BOOTSTRAP_MODE = os.getenv("COGNITION_BOOTSTRAP_MODE", "shadow")  # shadow|audit|partial|full

# --- Training ---
TRAINING_ENABLED = os.getenv("COGNITION_TRAINING_ENABLED", "true").lower() == "true"
CHECKPOINT_INTERVAL = int(os.getenv("COGNITION_CHECKPOINT_INTERVAL", "1000"))
REPLAY_BUFFER_SIZE = int(os.getenv("COGNITION_REPLAY_BUFFER_SIZE", "100000"))

# --- Weights ---
WEIGHTS_DIR = os.getenv("COGNITION_WEIGHTS_DIR", os.path.join(os.path.dirname(__file__), "weights"))
FOUNDATION_DIR = os.path.join(WEIGHTS_DIR, "foundation")

# --- Model Hyperparameters ---
# Input dimensions (must match NestJS SensoryFrame + DriveSnapshot)
EMBEDDING_DIM = 768
DRIVE_VECTOR_DIM = 12
GLOBAL_INPUT_DIM = EMBEDDING_DIM + DRIVE_VECTOR_DIM + DRIVE_VECTOR_DIM + 1 + EMBEDDING_DIM  # 1561
ACTION_SPACE_DIM = 32

# --- Inference ---
MAX_INFERENCE_TIMEOUT_MS = int(os.getenv("COGNITION_INFERENCE_TIMEOUT_MS", "50"))

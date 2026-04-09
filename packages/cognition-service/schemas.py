"""Pydantic request/response schemas for the cognition service API."""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

import config


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class BootstrapMode(str, Enum):
    SHADOW = "shadow"
    AUDIT = "audit"
    PARTIAL = "partial"
    FULL = "full"


# ---------------------------------------------------------------------------
# Inference — /cognition/cycle
# ---------------------------------------------------------------------------

class CognitionCycleRequest(BaseModel):
    """Full state tensor submitted by the NestJS orchestrator each cognitive cycle."""

    # Core state (required)
    fused_embedding: list[float] = Field(..., min_length=config.EMBEDDING_DIM, max_length=config.EMBEDDING_DIM)
    drive_vector: list[float] = Field(..., min_length=config.DRIVE_VECTOR_DIM, max_length=config.DRIVE_VECTOR_DIM)
    drive_deltas: list[float] = Field(..., min_length=config.DRIVE_VECTOR_DIM, max_length=config.DRIVE_VECTOR_DIM)
    total_pressure: float

    # Episodic context (optional — zero vector if no episodes available)
    episodic_context: list[float] = Field(
        default_factory=lambda: [0.0] * config.EMBEDDING_DIM,
        min_length=config.EMBEDDING_DIM,
        max_length=config.EMBEDDING_DIM,
    )

    # Per-modality embeddings for panel models (optional, keyed by modality name)
    modality_embeddings: dict[str, list[float]] = Field(default_factory=dict)

    # Panel-specific domain slices (optional, populated as panels are wired)
    drive_history: list[list[float]] | None = None  # last N drive vectors
    latent_match_scores: list[float] | None = None  # top-K similarity scores
    recent_mae_values: list[float] | None = None  # recent prediction MAEs
    opportunity_features: list[float] | None = None  # planning opportunity scores


class GlobalPrior(BaseModel):
    """Output from the global model (Brainstem)."""

    action_bias: list[float] = Field(..., min_length=config.ACTION_SPACE_DIM, max_length=config.ACTION_SPACE_DIM)
    urgency: float = Field(..., ge=0.0, le=1.0)
    novelty_score: float = Field(..., ge=0.0, le=1.0)


class PanelOpinion(BaseModel):
    """Output from a single panel model."""

    panel_name: str
    action_bias: list[float] = Field(..., min_length=config.ACTION_SPACE_DIM, max_length=config.ACTION_SPACE_DIM)
    confidence: float = Field(..., ge=0.0, le=1.0)
    domain_signal: list[float] = Field(default_factory=lambda: [0.0] * 8)


class ConvergenceResult(BaseModel):
    """Result of the convergence check between global and panel models."""

    consensus: bool
    divergence_score: float = Field(..., ge=0.0, le=1.0)
    panel_agreement: dict[str, float] = Field(default_factory=dict)  # per-panel cosine sim to global


class CognitionCycleResponse(BaseModel):
    """Full cognitive cycle output returned to the NestJS orchestrator."""

    global_prior: GlobalPrior
    panel_opinions: list[PanelOpinion] = Field(default_factory=list)
    convergence: ConvergenceResult | None = None
    inference_ms: float = 0.0

    # Deliberation outputs (populated when convergence indicates divergence)
    deliberation_bias: list[float] | None = None  # 32-dim synthesized action prior
    deliberation_confidence: float | None = None
    deliberation_pipeline_weights: list[float] | None = None  # [pragmatist, conservative, advocate]

    # Bootstrap audit field — populated during shadow/audit/partial modes so
    # the NestJS orchestrator can compare the tensor's top category against
    # the LLM's decision when it submits the TrainingSample.
    tensor_top_category: str | None = None


# ---------------------------------------------------------------------------
# Training — /cognition/train
# ---------------------------------------------------------------------------

class TrainingSample(BaseModel):
    """A labeled training example submitted by the NestJS orchestrator after each cycle."""

    # Input state (same as CognitionCycleRequest)
    fused_embedding: list[float]
    drive_vector: list[float]
    drive_deltas: list[float]
    total_pressure: float
    episodic_context: list[float] = Field(default_factory=lambda: [0.0] * config.EMBEDDING_DIM)
    modality_embeddings: dict[str, list[float]] = Field(default_factory=dict)

    # Labels (from LLM execution during bootstrap)
    arbitration_type: str  # TYPE_1, TYPE_2, SHRUG
    action_category: str | None = None  # WKG procedure category chosen by the LLM
    response_embedding: list[float] | None = None  # 768D embedding of the response text
    outcome: str | None = None  # positive, negative, neutral
    drive_effects: dict[str, float] = Field(default_factory=dict)  # observed drive changes
    prediction_mae: float | None = None

    # Bootstrap audit field — the NestJS orchestrator echoes tensor_top_category
    # from the CognitionCycleResponse back here so the Python side can record a
    # real tensor-vs-LLM comparison without re-running the forward pass.
    tensor_top_category: str | None = None

    # Supervisor labels (when available)
    supervisor_verdict: str | None = None  # good, acceptable, questionable, wrong
    supervisor_correction: str | None = None


# ---------------------------------------------------------------------------
# Health / Metrics / Bootstrap
# ---------------------------------------------------------------------------

class HealthResponse(BaseModel):
    status: str = "ok"
    models_loaded: bool = False
    bootstrap_mode: str = "shadow"
    training_enabled: bool = False
    total_parameters: int = 0
    weight_checkpoint: str | None = None


class MetricsResponse(BaseModel):
    training_steps: int = 0
    training_loss: float | None = None
    inference_latency_ms: float = 0.0
    samples_in_buffer: int = 0
    checkpoint_count: int = 0
    per_category_confidence: dict[str, float] = Field(default_factory=dict)


class BootstrapStatus(BaseModel):
    mode: str = "shadow"
    agreement_rate: float = 0.0
    per_category_agreement: dict[str, float] = Field(default_factory=dict)
    total_shadow_samples: int = 0
    total_audit_samples: int = 0
    categories_graduated: list[str] = Field(default_factory=list)

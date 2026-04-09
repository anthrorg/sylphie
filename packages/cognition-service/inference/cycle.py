"""Cognitive cycle orchestration — assembles input tensor and runs models.

This module owns the hot path: receive state from NestJS, assemble the
input tensor, run the global model (and later panel models, convergence
check, deliberation pipelines), and return the result.

The cycle is designed to be stateless — all state lives in the model
weights and the NestJS side. The sidecar is pure computation.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Protocol

import numpy as np

import config
from models.global_model import GlobalModel
from models.panel_models import PanelModels
from models.convergence import ConvergenceModel
from models.deliberation import DeliberationSystem
from schemas import (
    CognitionCycleRequest,
    CognitionCycleResponse,
    ConvergenceResult,
    GlobalPrior,
    PanelOpinion,
)

logger = logging.getLogger("cognition_service.cycle")


class _VocabLookup(Protocol):
    """Structural type for any object that can map an action index to a name.

    Satisfied by ActionVocabulary without importing it directly here (avoids
    a cycle between inference/ and training/).
    """

    def get_name(self, index: int) -> str:
        """Return the category name for the given action index."""
        ...


class CognitiveCycle:
    """Orchestrates a full cognitive cycle through all loaded models."""

    def __init__(self) -> None:
        self.global_model = GlobalModel()
        self.panel_models = PanelModels()
        self.convergence_model = ConvergenceModel()
        self.deliberation = DeliberationSystem()

        self.total_params = (
            self.global_model.total_params
            + self.panel_models.total_params
            + self.convergence_model.total_params
            + self.deliberation.total_params
        )

        # Try loading saved weights
        loaded_global = self.global_model.load(config.WEIGHTS_DIR + "/global")
        loaded_panels = self.panel_models.load(config.WEIGHTS_DIR + "/panels")
        self.convergence_model.load(config.WEIGHTS_DIR + "/convergence")
        self.deliberation.load(config.WEIGHTS_DIR + "/deliberation")

        if loaded_global or loaded_panels:
            logger.info("Resumed from saved checkpoint")
        else:
            logger.info("Starting with fresh (random) weights")

    def run(
        self,
        req: CognitionCycleRequest,
        vocab: _VocabLookup | None = None,
    ) -> CognitionCycleResponse:
        """Execute a full cognitive cycle.

        Args:
            req:   The state tensor from the NestJS orchestrator.
            vocab: Optional action vocabulary for reverse-mapping the tensor's
                   argmax to a category name. When provided, the response
                   includes tensor_top_category for bootstrap audit comparison.
                   Pass None (default) to omit the field.

        Returns:
            CognitionCycleResponse with global prior and (later) panel opinions.
        """
        start = time.perf_counter()

        # Step 1: Assemble the global input tensor
        state_tensor = self._assemble_global_input(req)

        # Step 2: Global model forward pass
        global_result = self.global_model.predict(state_tensor)

        # Step 3: Panel models — each gets global tensor + domain slice
        drive_history = (
            np.array(req.drive_history, dtype=np.float32).flatten()
            if req.drive_history else None
        )
        latent_scores = (
            np.array(req.latent_match_scores, dtype=np.float32)
            if req.latent_match_scores else None
        )
        mae_values = (
            np.array(req.recent_mae_values, dtype=np.float32)
            if req.recent_mae_values else None
        )
        opportunity_features = (
            np.array(req.opportunity_features, dtype=np.float32)
            if req.opportunity_features else None
        )

        panel_outputs = self.panel_models.predict_all(
            state_tensor,
            drive_history=drive_history,
            latent_scores=latent_scores,
            mae_values=mae_values,
            opportunity_features=opportunity_features,
        )

        # Step 4: Convergence check
        convergence = self.convergence_model.check(
            global_result["action_bias"],
            panel_outputs,
        )

        # Step 5: Deliberation pipelines if divergence
        delib_result = None
        if not convergence.consensus:
            delib_result = self.deliberation.deliberate(state_tensor)

        elapsed_ms = (time.perf_counter() - start) * 1000

        # Resolve tensor_top_category for bootstrap audit when a vocab is available.
        tensor_top_category: str | None = None
        if vocab is not None:
            top_idx = int(np.argmax(global_result["action_bias"]))
            tensor_top_category = vocab.get_name(top_idx)

        return CognitionCycleResponse(
            global_prior=GlobalPrior(
                action_bias=global_result["action_bias"],
                urgency=global_result["urgency"],
                novelty_score=global_result["novelty_score"],
            ),
            panel_opinions=[
                PanelOpinion(
                    panel_name=p.panel_name,
                    action_bias=p.action_bias,
                    confidence=p.confidence,
                    domain_signal=p.domain_signal,
                )
                for p in panel_outputs
            ],
            convergence=ConvergenceResult(
                consensus=convergence.consensus,
                divergence_score=convergence.divergence_score,
                panel_agreement=convergence.panel_agreement,
            ),
            inference_ms=elapsed_ms,
            tensor_top_category=tensor_top_category,
            deliberation_bias=delib_result.action_bias if delib_result else None,
            deliberation_confidence=delib_result.confidence if delib_result else None,
            deliberation_pipeline_weights=delib_result.pipeline_weights if delib_result else None,
        )

    def _assemble_global_input(self, req: CognitionCycleRequest) -> np.ndarray:
        """Build the 1561-float global input tensor from the request.

        Layout:
            [0:768]      fused_embedding
            [768:780]    drive_vector (12)
            [780:792]    drive_deltas (12)
            [792]        total_pressure (1)
            [793:1561]   episodic_context (768)
        """
        parts = [
            np.array(req.fused_embedding, dtype=np.float32),
            np.array(req.drive_vector, dtype=np.float32),
            np.array(req.drive_deltas, dtype=np.float32),
            np.array([req.total_pressure], dtype=np.float32),
            np.array(req.episodic_context, dtype=np.float32),
        ]
        tensor = np.concatenate(parts)

        assert tensor.shape == (config.GLOBAL_INPUT_DIM,), (
            f"Expected {config.GLOBAL_INPUT_DIM} floats, got {tensor.shape[0]}"
        )
        return tensor

    def save_checkpoint(self, foundation: bool = False) -> str:
        """Save all model weights.

        Args:
            foundation: If True, save to foundation dir for Society of Mind forking.

        Returns:
            Path where weights were saved.
        """
        if foundation:
            base = config.FOUNDATION_DIR
        else:
            base = config.WEIGHTS_DIR

        self.global_model.save(base + "/global")
        self.panel_models.save(base + "/panels")
        self.convergence_model.save(base + "/convergence")
        self.deliberation.save(base + "/deliberation")
        return base

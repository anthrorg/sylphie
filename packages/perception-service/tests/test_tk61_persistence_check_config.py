"""Tests for TK-61: configurable persistence-check weight profiles.

Acceptance criteria:

AC1. Given a PersistenceCheckConfig with custom new_weights, when the service
     is constructed, then interpolation uses the custom profile; module
     constants unchanged.

AC2. Given weights not summing to 1.0 / no-arg config, when constructed, then
     Pydantic ValidationError / identical-to-current behavior respectively.

Run with::

    cd packages/perception-service
    .venv/Scripts/python.exe -m pytest tests/test_tk61_persistence_check_config.py -q
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pydantic import ValidationError

from cobeing.layer2_perception.config import PersistenceCheckConfig
from cobeing.layer2_perception.persistence_check_service import (
    PersistenceCheckService,
    _KNOWN_WEIGHTS,
    _NEW_WEIGHTS,
    _interpolate_weights,
    compute_match_score,
)
from cobeing.layer3_knowledge.node_types import KnowledgeNode, SchemaLevel
from cobeing.shared.observation import BoundingBox, Observation
from cobeing.shared.provenance import Provenance, ProvenanceSource

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

_PROVENANCE = Provenance(
    source=ProvenanceSource.SENSOR,
    source_id="test-frame-001",
    confidence=0.90,
)

_EMB: list[float] = [1.0, 2.0, 3.0, 4.0]

_NODE_BBOX: dict[str, float] = {
    "x_min": 100.0,
    "y_min": 100.0,
    "x_max": 300.0,
    "y_max": 400.0,
}

_CUSTOM_NEW_WEIGHTS: dict[str, float] = {
    "embedding": 0.60,
    "color": 0.20,
    "spatial": 0.10,
    "size": 0.05,
    "label_raw": 0.05,
}

_CUSTOM_KNOWN_WEIGHTS: dict[str, float] = {
    "embedding": 0.70,
    "color": 0.15,
    "spatial": 0.05,
    "size": 0.05,
    "label_raw": 0.05,
}


def _make_bbox() -> BoundingBox:
    return BoundingBox(
        x_min=100.0,
        y_min=100.0,
        x_max=300.0,
        y_max=400.0,
        frame_width=1280,
        frame_height=720,
    )


def _make_obs() -> Observation:
    return Observation(
        observation_id="obs-tk61-001",
        session_id="session-tk61-001",
        label_raw="cup",
        confidence=0.90,
        bounding_box=_make_bbox(),
        embedding=list(_EMB),
        dominant_colors=[(200, 50, 50)],
        provenance=_PROVENANCE,
    )


def _make_node(
    node_id: str,
    properties: dict[str, Any],
    confirmation_count: int,
) -> KnowledgeNode:
    return KnowledgeNode(
        node_id=node_id,
        node_type="ObjectInstance",
        schema_level=SchemaLevel.INSTANCE,
        properties=properties,
        provenance=_PROVENANCE,
        confidence=0.50,
        confirmation_count=confirmation_count,
    )


class _FakeGraph:
    def __init__(self, candidates: list[tuple[KnowledgeNode, float]]) -> None:
        self._candidates = candidates

    async def find_nodes_by_embedding(
        self,
        embedding: list[float],
        embedding_key: str = "embedding",
        min_similarity: float = 0.7,
        limit: int = 10,
        schema_level: Any = None,
    ) -> list[tuple[KnowledgeNode, float]]:
        return list(self._candidates)


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# AC1 — custom profile is used; module constants are unchanged
# ---------------------------------------------------------------------------


class TestAC1CustomWeightProfile:
    """AC1: custom new_weights flows into interpolation; module constants untouched."""

    def test_custom_new_weights_used_by_interpolate_weights(self) -> None:
        """_interpolate_weights respects config.new_weights for count=0."""
        config = PersistenceCheckConfig(new_weights=_CUSTOM_NEW_WEIGHTS)
        weights = _interpolate_weights(0, config=config)
        assert weights == _CUSTOM_NEW_WEIGHTS

    def test_custom_known_weights_used_by_interpolate_weights(self) -> None:
        """_interpolate_weights respects config.known_weights for high count."""
        config = PersistenceCheckConfig(known_weights=_CUSTOM_KNOWN_WEIGHTS)
        weights = _interpolate_weights(10, config=config)
        assert weights == _CUSTOM_KNOWN_WEIGHTS

    def test_module_constants_unchanged_after_custom_config(self) -> None:
        """Creating a config with custom weights must not mutate module-level dicts."""
        before_new = dict(_NEW_WEIGHTS)
        before_known = dict(_KNOWN_WEIGHTS)
        PersistenceCheckConfig(
            new_weights=_CUSTOM_NEW_WEIGHTS,
            known_weights=_CUSTOM_KNOWN_WEIGHTS,
        )
        assert _NEW_WEIGHTS == before_new
        assert _KNOWN_WEIGHTS == before_known

    def test_compute_match_score_uses_custom_profile(self) -> None:
        """compute_match_score routes through config weights, not module constants."""
        config = PersistenceCheckConfig(new_weights=_CUSTOM_NEW_WEIGHTS)
        props = {
            "embedding": list(_EMB),
            "bounding_box": dict(_NODE_BBOX),
            "dominant_colors": [(200, 50, 50)],
            "label_raw": "cup",
        }
        # All five signals == 1.0, so score == sum(custom weights) == 1.0 regardless.
        # Use confirmation_count=0 so new_weights is selected.
        score_custom = compute_match_score(
            _make_obs(), props, confirmation_count=0, config=config
        )
        assert score_custom == pytest.approx(1.0)

    def test_custom_new_weights_produce_different_score_than_defaults(self) -> None:
        """A partial-signal scenario with custom weights diverges from the default score."""
        # Observation: embedding-only match (no bbox, no color, no label match).
        obs = _make_obs()
        props = {
            "embedding": list(_EMB),  # perfect embedding match
            # no bounding_box, no dominant_colors, no label_raw
        }
        # Default new_weights: embedding weight = 0.25 -> score 0.25 for perfect emb.
        default_score = compute_match_score(obs, props, confirmation_count=0)
        # Custom new_weights: embedding weight = 0.60 -> score 0.60.
        config = PersistenceCheckConfig(new_weights=_CUSTOM_NEW_WEIGHTS)
        custom_score = compute_match_score(obs, props, confirmation_count=0, config=config)
        assert default_score == pytest.approx(0.25)
        assert custom_score == pytest.approx(0.60)

    def test_service_construction_with_custom_config_uses_custom_weights(self) -> None:
        """PersistenceCheckService.find_match uses config-supplied weights end-to-end."""
        props = {
            "embedding": list(_EMB),
            # No bbox, no colors, no label — only embedding signal fires.
        }
        config = PersistenceCheckConfig(
            new_weights=_CUSTOM_NEW_WEIGHTS,
            # Raise match_threshold so the custom score (0.60) falls in matched range.
            match_threshold=0.55,
            ambiguity_threshold=0.40,
        )
        svc = PersistenceCheckService(
            _FakeGraph([(_make_node("n-custom", props, 0), 1.0)]),
            config,
        )
        result = _run(svc.find_match(_make_obs()))
        assert result is not None
        # With default weights, score=0.25 is below ambiguity_threshold=0.45 (default),
        # so no match. With custom embedding weight 0.60 and match_threshold=0.55, it
        # matches.
        assert result.matched_node_id == "n-custom"
        assert result.confidence == pytest.approx(0.60)

    def test_custom_thresholds_change_interpolation_band(self) -> None:
        """new_threshold and known_threshold control which profile applies."""
        config = PersistenceCheckConfig(
            new_threshold=3,
            known_threshold=6,
        )
        # count=2 (<3) -> new_weights
        assert _interpolate_weights(2, config=config) == config.new_weights
        # count=6 (>=6) -> known_weights
        assert _interpolate_weights(6, config=config) == config.known_weights
        # count=4 (in [3,6)) -> interpolated, not pure new or known
        mid = _interpolate_weights(4, config=config)
        assert mid != config.new_weights
        assert mid != config.known_weights
        assert sum(mid.values()) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# AC2 — invalid weights raise ValidationError; no-arg config is identical
# ---------------------------------------------------------------------------


class TestAC2ValidationAndDefaults:
    """AC2: bad weight sums raise ValidationError; default config == current behavior."""

    def test_new_weights_not_summing_to_one_raises(self) -> None:
        """new_weights summing to 0.9 (not 1.0) must raise Pydantic ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            PersistenceCheckConfig(
                new_weights={
                    "spatial": 0.40,
                    "embedding": 0.20,
                    "color": 0.15,
                    "size": 0.10,
                    "label_raw": 0.05,
                    # sum = 0.90
                }
            )
        assert "new_weights" in str(exc_info.value)

    def test_known_weights_not_summing_to_one_raises(self) -> None:
        """known_weights summing to 1.1 must raise Pydantic ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            PersistenceCheckConfig(
                known_weights={
                    "embedding": 0.60,
                    "color": 0.25,
                    "spatial": 0.15,
                    "size": 0.10,
                    "label_raw": 0.00,
                    # sum = 1.10
                }
            )
        assert "known_weights" in str(exc_info.value)

    def test_weights_summing_to_zero_raises(self) -> None:
        """All-zero weights do not sum to 1.0; must raise ValidationError."""
        with pytest.raises(ValidationError):
            PersistenceCheckConfig(
                new_weights={
                    "spatial": 0.0,
                    "embedding": 0.0,
                    "color": 0.0,
                    "size": 0.0,
                    "label_raw": 0.0,
                }
            )

    def test_known_threshold_equal_to_new_threshold_raises(self) -> None:
        """known_threshold == new_threshold => divide-by-zero in interpolation."""
        with pytest.raises(ValidationError) as exc_info:
            PersistenceCheckConfig(new_threshold=5, known_threshold=5)
        assert "known_threshold" in str(exc_info.value)

    def test_known_threshold_less_than_new_threshold_raises(self) -> None:
        """known_threshold < new_threshold is incoherent."""
        with pytest.raises(ValidationError):
            PersistenceCheckConfig(new_threshold=10, known_threshold=5)

    def test_no_arg_config_matches_current_default_behavior(self) -> None:
        """PersistenceCheckConfig() with no args produces weights == module constants."""
        config = PersistenceCheckConfig()
        # Default weight profiles must be identical to module-level constants.
        assert config.new_weights == _NEW_WEIGHTS
        assert config.known_weights == _KNOWN_WEIGHTS
        assert config.new_threshold == 5
        assert config.known_threshold == 10

    def test_no_arg_config_interpolation_matches_module_constants(self) -> None:
        """_interpolate_weights with default config produces same results as no config."""
        config = PersistenceCheckConfig()
        for count in (0, 4, 5, 7, 9, 10, 20):
            assert _interpolate_weights(count, config=config) == pytest.approx(
                _interpolate_weights(count)
            )

    def test_float_precision_near_one_accepted(self) -> None:
        """Floating-point sums within 1e-6 of 1.0 must not raise."""
        # 0.1 + 0.1 + 0.1 + 0.1 + 0.6 in IEEE 754 may not be exactly 1.0.
        # The tolerance gate should accept this.
        weights = {
            "spatial": 0.10,
            "embedding": 0.60,
            "color": 0.10,
            "size": 0.10,
            "label_raw": 0.10,
        }
        # Should not raise.
        cfg = PersistenceCheckConfig(new_weights=weights)
        assert cfg.new_weights == weights

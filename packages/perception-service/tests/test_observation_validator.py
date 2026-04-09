"""Unit tests for ObservationValidator.

Each test exercises one validation check in isolation, plus the pass-through
case and the enabled=False bypass. The tests use only the standard library
and the cobeing package -- no pytest plugins, no mocks beyond simple data
construction.

Run with::

    cd packages/perception-service
    python -m pytest tests/test_observation_validator.py -v
"""

from __future__ import annotations

import math

import pytest

from cobeing.layer2_perception.config import ValidationConfig
from cobeing.layer2_perception.observation_validator import ObservationValidator, ValidationResult
from cobeing.shared.observation import BoundingBox, Observation
from cobeing.shared.provenance import Provenance, ProvenanceSource


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_PROVENANCE = Provenance(
    source=ProvenanceSource.SENSOR,
    source_id="test-frame-001",
    confidence=0.90,
)


def _make_obs(
    *,
    x_min: float = 100.0,
    y_min: float = 100.0,
    x_max: float = 300.0,
    y_max: float = 400.0,
    frame_width: int = 1280,
    frame_height: int = 720,
    confidence: float = 0.80,
    embedding: list[float] | None = None,
    label: str = "cup",
) -> Observation:
    """Build a minimal valid Observation for testing."""
    bbox = BoundingBox(
        x_min=x_min,
        y_min=y_min,
        x_max=x_max,
        y_max=y_max,
        frame_width=frame_width,
        frame_height=frame_height,
    )
    return Observation(
        observation_id="obs-test-001",
        session_id="session-test-001",
        label_raw=label,
        confidence=confidence,
        bounding_box=bbox,
        embedding=embedding,
        provenance=_PROVENANCE,
    )


def _unit_embedding(dims: int = 8, norm: float = 1.0) -> list[float]:
    """Return a uniform embedding vector with the given L2 norm."""
    component = math.sqrt(norm * norm / dims)
    return [component] * dims


# ---------------------------------------------------------------------------
# Test: valid observation passes all checks
# ---------------------------------------------------------------------------


class TestValidObservation:
    def test_valid_observation_passes(self) -> None:
        """A well-formed observation should pass all default checks."""
        validator = ObservationValidator(ValidationConfig())
        obs = _make_obs()
        result = validator.validate(obs)

        assert result.is_valid is True
        assert result.rejection_reasons == []

    def test_valid_observation_with_embedding_passes(self) -> None:
        """A valid observation with a normal embedding should pass."""
        validator = ObservationValidator(ValidationConfig())
        obs = _make_obs(embedding=_unit_embedding(dims=1280, norm=2.5))
        result = validator.validate(obs)

        assert result.is_valid is True

    def test_filter_returns_all_when_all_valid(self) -> None:
        """filter() should return the full list when all observations are valid."""
        validator = ObservationValidator(ValidationConfig())
        obs_list = [_make_obs() for _ in range(5)]
        result = validator.filter(obs_list)

        assert len(result) == 5


# ---------------------------------------------------------------------------
# Test: enabled=False bypass
# ---------------------------------------------------------------------------


class TestDisabledValidation:
    def test_disabled_bypasses_all_checks(self) -> None:
        """When enabled=False, every observation should pass regardless."""
        config = ValidationConfig(enabled=False)
        validator = ObservationValidator(config)

        # Build an observation that would fail every check when enabled.
        obs = _make_obs(
            x_min=639.0,
            y_min=359.0,
            x_max=640.0,
            y_max=360.0,  # tiny bbox, area_fraction << 0.001
            confidence=0.05,  # below min_confidence
            embedding=[0.0] * 8,  # zero-norm embedding
        )
        result = validator.validate(obs)

        assert result.is_valid is True
        assert result.rejection_reasons == []

    def test_disabled_does_not_increment_counters(self) -> None:
        """Disabled validation should not touch any counters."""
        config = ValidationConfig(enabled=False)
        validator = ObservationValidator(config)

        validator.validate(_make_obs())
        metrics = validator.get_metrics()

        assert metrics["observations_validated"] == 0
        assert metrics["observations_rejected"] == 0


# ---------------------------------------------------------------------------
# Test: minimum area fraction check
# ---------------------------------------------------------------------------


class TestAreaFractionCheck:
    def test_tiny_bbox_is_rejected(self) -> None:
        """A sub-pixel bounding box (area << 0.1% of frame) should be rejected."""
        # 2x2 pixels in a 1280x720 frame: area_fraction = 4 / 921600 ≈ 0.0000043
        obs = _make_obs(x_min=100.0, y_min=100.0, x_max=102.0, y_max=102.0)
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is False
        assert any("area_fraction" in r for r in result.rejection_reasons)

    def test_bbox_at_threshold_passes(self) -> None:
        """A bbox with area_fraction exactly at the minimum should pass."""
        # min_area_fraction default = 0.001
        # frame area = 1280 * 720 = 921600
        # required box area = 921600 * 0.001 = 921.6 pixels
        # Use a 31x30 box = 930 pixels > 921.6
        obs = _make_obs(x_min=100.0, y_min=100.0, x_max=131.0, y_max=130.0)
        validator = ObservationValidator(ValidationConfig(min_area_fraction=0.001))
        result = validator.validate(obs)

        assert result.is_valid is True

    def test_custom_area_threshold_respected(self) -> None:
        """Custom min_area_fraction from config should be used."""
        # A 200x200 box in 1280x720: area_fraction = 40000 / 921600 ≈ 0.0434
        obs = _make_obs(x_min=0.0, y_min=0.0, x_max=200.0, y_max=200.0)
        # Set a very high threshold that this box won't meet
        validator = ObservationValidator(ValidationConfig(min_area_fraction=0.5))
        result = validator.validate(obs)

        assert result.is_valid is False
        assert any("area_fraction" in r for r in result.rejection_reasons)

    def test_rejected_by_area_counter_increments(self) -> None:
        """rejected_by_area counter should increment on area rejection."""
        obs = _make_obs(x_min=100.0, y_min=100.0, x_max=101.0, y_max=101.0)
        validator = ObservationValidator(ValidationConfig())
        validator.validate(obs)

        metrics = validator.get_metrics()
        assert metrics["rejected_by_area"] == 1
        assert metrics["observations_rejected"] == 1


# ---------------------------------------------------------------------------
# Test: minimum confidence check
# ---------------------------------------------------------------------------


class TestConfidenceCheck:
    def test_low_confidence_is_rejected(self) -> None:
        """An observation below min_confidence should be rejected."""
        obs = _make_obs(confidence=0.10)  # below default 0.30
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is False
        assert any("confidence" in r for r in result.rejection_reasons)

    def test_confidence_at_threshold_passes(self) -> None:
        """An observation exactly at min_confidence should pass."""
        obs = _make_obs(confidence=0.30)
        validator = ObservationValidator(ValidationConfig(min_confidence=0.30))
        result = validator.validate(obs)

        assert result.is_valid is True

    def test_high_confidence_passes(self) -> None:
        """An observation well above min_confidence should pass."""
        obs = _make_obs(confidence=0.95)
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is True

    def test_rejected_by_confidence_counter_increments(self) -> None:
        """rejected_by_confidence counter should increment on confidence rejection."""
        obs = _make_obs(confidence=0.01)
        validator = ObservationValidator(ValidationConfig())
        validator.validate(obs)

        metrics = validator.get_metrics()
        assert metrics["rejected_by_confidence"] == 1


# ---------------------------------------------------------------------------
# Test: embedding L2 norm check
# ---------------------------------------------------------------------------


class TestEmbeddingNormCheck:
    def test_zero_embedding_is_rejected(self) -> None:
        """An all-zero embedding (failed ONNX run) should be rejected."""
        obs = _make_obs(embedding=[0.0] * 1280)
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is False
        assert any("embedding_norm" in r for r in result.rejection_reasons)

    def test_exploded_embedding_is_rejected(self) -> None:
        """An embedding with norm >> 100.0 should be rejected."""
        # 1280 components each = 10.0 gives norm = sqrt(1280) * 10 ≈ 357.8
        obs = _make_obs(embedding=[10.0] * 1280)
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is False
        assert any("embedding_norm" in r for r in result.rejection_reasons)

    def test_normal_embedding_passes(self) -> None:
        """An embedding with norm in [0.1, 100.0] should pass."""
        obs = _make_obs(embedding=_unit_embedding(dims=1280, norm=5.0))
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is True

    def test_no_embedding_skips_check(self) -> None:
        """When embedding is None, the norm check should not run."""
        obs = _make_obs(embedding=None)
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is True
        assert not any("embedding_norm" in r for r in result.rejection_reasons)

    def test_rejected_by_embedding_norm_counter_increments(self) -> None:
        """rejected_by_embedding_norm counter should increment on norm rejection."""
        obs = _make_obs(embedding=[0.0] * 8)
        validator = ObservationValidator(ValidationConfig())
        validator.validate(obs)

        metrics = validator.get_metrics()
        assert metrics["rejected_by_embedding_norm"] == 1


# ---------------------------------------------------------------------------
# Test: bounding box aspect ratio check
# ---------------------------------------------------------------------------


class TestAspectRatioCheck:
    def test_too_thin_bbox_is_rejected(self) -> None:
        """A pathologically thin vertical box (width/height << 0.1) should be rejected."""
        # width=5, height=500 -> aspect=0.01 < 0.1
        obs = _make_obs(x_min=100.0, y_min=100.0, x_max=105.0, y_max=600.0)
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is False
        assert any("aspect_ratio" in r for r in result.rejection_reasons)

    def test_too_wide_bbox_is_rejected(self) -> None:
        """A pathologically wide box (width/height >> 10.0) should be rejected."""
        # width=600, height=5 -> aspect=120 > 10.0
        obs = _make_obs(x_min=0.0, y_min=100.0, x_max=600.0, y_max=105.0)
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is False
        assert any("aspect_ratio" in r for r in result.rejection_reasons)

    def test_square_bbox_passes(self) -> None:
        """A square bbox (aspect=1.0) should pass."""
        obs = _make_obs(x_min=100.0, y_min=100.0, x_max=300.0, y_max=300.0)
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is True

    def test_typical_person_bbox_passes(self) -> None:
        """A typical person bbox (~0.4 aspect) should pass."""
        # width=150, height=350 -> aspect ≈ 0.43
        obs = _make_obs(x_min=100.0, y_min=50.0, x_max=250.0, y_max=400.0)
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is True

    def test_rejected_by_aspect_ratio_counter_increments(self) -> None:
        """rejected_by_aspect_ratio counter should increment on aspect rejection."""
        obs = _make_obs(x_min=100.0, y_min=100.0, x_max=105.0, y_max=600.0)
        validator = ObservationValidator(ValidationConfig())
        validator.validate(obs)

        metrics = validator.get_metrics()
        assert metrics["rejected_by_aspect_ratio"] == 1


# ---------------------------------------------------------------------------
# Test: multiple failures collected
# ---------------------------------------------------------------------------


class TestMultipleFailures:
    def test_multiple_checks_fail_simultaneously(self) -> None:
        """All failing checks should be reported in rejection_reasons, not just the first."""
        # tiny bbox + low confidence + zero embedding
        obs = _make_obs(
            x_min=100.0, y_min=100.0, x_max=101.0, y_max=101.0,  # tiny
            confidence=0.01,  # low
            embedding=[0.0] * 8,  # zero norm
        )
        validator = ObservationValidator(ValidationConfig())
        result = validator.validate(obs)

        assert result.is_valid is False
        # Must report at least area, confidence, and embedding failures.
        reason_text = " ".join(result.rejection_reasons)
        assert "area_fraction" in reason_text
        assert "confidence" in reason_text
        assert "embedding_norm" in reason_text


# ---------------------------------------------------------------------------
# Test: diagnostic metrics
# ---------------------------------------------------------------------------


class TestMetrics:
    def test_observations_validated_counts_all_calls(self) -> None:
        """observations_validated should increment for each validate() call."""
        validator = ObservationValidator(ValidationConfig())
        for _ in range(7):
            validator.validate(_make_obs())

        assert validator.get_metrics()["observations_validated"] == 7

    def test_rejection_counts_accumulate_correctly(self) -> None:
        """Rejection counters should accumulate across multiple validate() calls."""
        validator = ObservationValidator(ValidationConfig())

        # 2 tiny-bbox rejections
        tiny = _make_obs(x_min=100.0, y_min=100.0, x_max=101.0, y_max=101.0)
        validator.validate(tiny)
        validator.validate(tiny)

        # 1 low-confidence rejection
        low_conf = _make_obs(confidence=0.01)
        validator.validate(low_conf)

        metrics = validator.get_metrics()
        assert metrics["rejected_by_area"] == 2
        assert metrics["rejected_by_confidence"] == 1
        assert metrics["observations_rejected"] == 3

    def test_filter_passes_only_valid(self) -> None:
        """filter() should return only the observations that pass validation."""
        validator = ObservationValidator(ValidationConfig())

        good = _make_obs()
        tiny = _make_obs(x_min=100.0, y_min=100.0, x_max=101.0, y_max=101.0)
        low = _make_obs(confidence=0.05)

        result = validator.filter([good, tiny, low, good])
        assert len(result) == 2
        for obs in result:
            assert obs.confidence >= 0.30

"""Observation validation gate for the Layer 2 / Layer 3 boundary.

Filters observations produced by
:class:`~cobeing.layer2_perception.observation_builder.ObservationBuilder`
before they are forwarded to Layer 3 ingestion. The validator applies a
configurable set of quality checks and rejects observations that fail any
enabled check. Rejected observations are logged at DEBUG level and counted
in per-reason diagnostic metrics.

Design rationale
----------------
The insertion point is deliberately outside ``ObservationBuilder`` so that
the builder remains responsible only for constructing observations, not for
deciding their quality. Validation is a separate concern that can be tuned,
disabled, and instrumented independently.

All checks are computationally trivial (no I/O, no ML inference):

* ``min_area_fraction`` -- rejects sub-pixel sensor artefacts by checking
  ``bounding_box.area_fraction``, which is already computed as a property on
  :class:`~cobeing.shared.observation.BoundingBox`.

* ``min_confidence`` -- rejects low-confidence detections that survived
  tracker confirmation but remain below the Layer 3 quality floor.

* ``embedding_norm`` -- rejects degenerate embedding vectors (all-zero from
  a failed ONNX run, or unnormally large from numerical overflow). Only
  applied when the observation actually carries an embedding.

* ``aspect_ratio`` -- rejects pathologically thin or wide bounding boxes
  (lines from sensor noise, partial detections at frame edges).

Usage::

    from cobeing.layer2_perception.config import ValidationConfig
    from cobeing.layer2_perception.observation_validator import ObservationValidator

    validator = ObservationValidator(ValidationConfig())

    valid_obs = [obs for obs, result in
                 ((obs, validator.validate(obs)) for obs in new_observations)
                 if result.is_valid]

    # Or use the convenience helper:
    valid_obs = validator.filter(new_observations)

    # Inspect aggregate rejection counts:
    metrics = validator.get_metrics()
    print(metrics)
    # {'observations_validated': 120, 'observations_rejected': 3,
    #  'rejected_by_area': 1, 'rejected_by_confidence': 1,
    #  'rejected_by_embedding_norm': 0, 'rejected_by_aspect_ratio': 1}
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cobeing.layer2_perception.config import ValidationConfig
    from cobeing.shared.observation import Observation

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# ValidationResult
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ValidationResult:
    """Outcome of a single observation validation run.

    Attributes:
        is_valid: True if the observation passed all enabled checks.
        rejection_reasons: List of human-readable strings describing which
            checks failed. Empty when ``is_valid`` is True.
    """

    is_valid: bool
    rejection_reasons: list[str] = field(default_factory=list)

    def __repr__(self) -> str:
        if self.is_valid:
            return "ValidationResult(is_valid=True)"
        return f"ValidationResult(is_valid=False, reasons={self.rejection_reasons!r})"


# ---------------------------------------------------------------------------
# ObservationValidator
# ---------------------------------------------------------------------------


class ObservationValidator:
    """Quality gate for observations at the Layer 2 / Layer 3 boundary.

    Applies the checks configured in :class:`~cobeing.layer2_perception.config.ValidationConfig`
    to each observation. Each check is evaluated independently; all failures are
    collected into the :class:`ValidationResult` so callers can see which checks
    failed without short-circuiting on the first failure.

    The validator maintains running counters for telemetry. These are never
    reset during the lifetime of the validator -- they represent the cumulative
    counts since the pipeline started.

    Args:
        config: The validation subsection of :class:`PerceptionConfig`.
            Controls whether validation is enabled and sets the threshold
            values for all checks.
    """

    def __init__(self, config: ValidationConfig) -> None:
        self._config = config

        # Diagnostic counters -- cumulative since instantiation.
        self._observations_validated: int = 0
        self._observations_rejected: int = 0
        self._rejected_by_area: int = 0
        self._rejected_by_confidence: int = 0
        self._rejected_by_embedding_norm: int = 0
        self._rejected_by_aspect_ratio: int = 0

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def validate(self, obs: Observation) -> ValidationResult:
        """Run all enabled validation checks on a single observation.

        If ``config.enabled`` is False, returns a passing result immediately
        without touching any counters.

        Args:
            obs: The observation to validate.

        Returns:
            A :class:`ValidationResult` with ``is_valid=True`` if all checks
            pass, or ``is_valid=False`` with the list of failing check names
            and their measured values.
        """
        if not self._config.enabled:
            return ValidationResult(is_valid=True)

        self._observations_validated += 1
        reasons: list[str] = []

        # --- Check 1: minimum bounding box area fraction ---
        area_frac = obs.bounding_box.area_fraction
        if area_frac < self._config.min_area_fraction:
            reasons.append(
                f"area_fraction={area_frac:.6f} < min={self._config.min_area_fraction}"
            )
            self._rejected_by_area += 1

        # --- Check 2: minimum confidence ---
        if obs.confidence < self._config.min_confidence:
            reasons.append(
                f"confidence={obs.confidence:.4f} < min={self._config.min_confidence}"
            )
            self._rejected_by_confidence += 1

        # --- Check 3: embedding L2 norm (only when embedding is present) ---
        if obs.embedding is not None and len(obs.embedding) > 0:
            norm = math.sqrt(sum(x * x for x in obs.embedding))
            if norm < self._config.embedding_norm_min:
                reasons.append(
                    f"embedding_norm={norm:.6f} < min={self._config.embedding_norm_min}"
                )
                self._rejected_by_embedding_norm += 1
            elif norm > self._config.embedding_norm_max:
                reasons.append(
                    f"embedding_norm={norm:.6f} > max={self._config.embedding_norm_max}"
                )
                self._rejected_by_embedding_norm += 1

        # --- Check 4: bounding box aspect ratio (width / height) ---
        bbox_height = obs.bounding_box.height
        if bbox_height > 0:
            aspect = obs.bounding_box.width / bbox_height
            if aspect < self._config.min_aspect_ratio:
                reasons.append(
                    f"aspect_ratio={aspect:.4f} < min={self._config.min_aspect_ratio}"
                )
                self._rejected_by_aspect_ratio += 1
            elif aspect > self._config.max_aspect_ratio:
                reasons.append(
                    f"aspect_ratio={aspect:.4f} > max={self._config.max_aspect_ratio}"
                )
                self._rejected_by_aspect_ratio += 1

        is_valid = len(reasons) == 0

        if not is_valid:
            self._observations_rejected += 1
            logger.debug(
                "observation_rejected obs_id=%s label=%s reasons=%s",
                obs.observation_id,
                obs.label_raw,
                reasons,
            )

        return ValidationResult(is_valid=is_valid, rejection_reasons=reasons)

    def filter(self, observations: list[Observation]) -> list[Observation]:
        """Validate a list of observations and return only the passing ones.

        This is the primary entry point for the pipeline: pass the full list
        produced by ``builder.build()`` and receive back only the observations
        that should be forwarded to Layer 3.

        Args:
            observations: All observations from a single processing cycle.

        Returns:
            The subset of observations that passed all enabled checks. May be
            empty if all observations were rejected, or equal to the input list
            if all passed (or validation is disabled).
        """
        return [obs for obs in observations if self.validate(obs).is_valid]

    def get_metrics(self) -> dict[str, int]:
        """Return cumulative diagnostic counters since instantiation.

        Intended for telemetry endpoints and periodic log summaries. The
        counts are never reset during the lifetime of the validator.

        Returns:
            Dictionary with keys:
            - ``observations_validated``: Total observations that entered the
              validator (not incremented when ``enabled=False``).
            - ``observations_rejected``: Total observations rejected by any check.
            - ``rejected_by_area``: Rejections caused by the area fraction check.
            - ``rejected_by_confidence``: Rejections caused by the confidence check.
            - ``rejected_by_embedding_norm``: Rejections caused by the embedding
              norm check (both under-min and over-max).
            - ``rejected_by_aspect_ratio``: Rejections caused by the aspect ratio
              check (both under-min and over-max).
        """
        return {
            "observations_validated": self._observations_validated,
            "observations_rejected": self._observations_rejected,
            "rejected_by_area": self._rejected_by_area,
            "rejected_by_confidence": self._rejected_by_confidence,
            "rejected_by_embedding_norm": self._rejected_by_embedding_norm,
            "rejected_by_aspect_ratio": self._rejected_by_aspect_ratio,
        }


__all__ = ["ObservationValidator", "ValidationResult"]

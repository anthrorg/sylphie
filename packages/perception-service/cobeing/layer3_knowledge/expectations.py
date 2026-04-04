"""Expectation verification types for the Co-Being knowledge graph.

This module defines the data structures produced by Epic 4's expectation
verification pipeline: the result of comparing an observed property value
against a schema-level statistical expectation, and the events emitted
when that comparison succeeds or fails.

Expectations live as ``PropertyExpectation`` nodes at the SCHEMA level.
Each expectation records the mean and standard deviation of a property
(e.g., ``"color_dominant"``) observed across all instances of a schema
type (e.g., ``"cup"``). When a new instance is ingested, its property
values are compared against these expectations. Deviations beyond a
sigma threshold (``D-TS-09``: 2.0) constitute a prediction error and
trigger the ``PREDICTION_ERROR_DEMOTION`` EvolutionRule (CANON A.2).

Key types:

- :class:`PredictionError` -- the structured description of a single
  expectation violation: which node, which expectation, which property,
  and how far the observed value was from the expected range.
- :class:`PredictionErrorDetectedEvent` -- event emitted when at least
  one expectation violation is detected for a node.
- :class:`PredictionSuccessEvent` -- event emitted when an observation
  confirms an expectation (no violation detected), incrementing the
  confirmation count on the expectation node.

Usage::

    from cobeing.layer3_knowledge.expectations import (
        PredictionError,
        PredictionErrorDetectedEvent,
        PredictionSuccessEvent,
    )
    from cobeing.shared.types import CorrelationId, NodeId

    error = PredictionError(
        instance_node_id=NodeId("inst-cup-007"),
        schema_type_id=NodeId("type-cup"),
        expectation_id="exp-color-001",
        property_key="color_dominant_hue",
        observed_sigma_distance=3.4,
        expected_sigma_range=2.0,
        correlation_id=CorrelationId("corr-xyz-789"),
    )

    error_event = PredictionErrorDetectedEvent(
        prediction_error=error,
        session_id="session-2026-02-25-001",
        correlation_id=CorrelationId("corr-xyz-789"),
    )

    success_event = PredictionSuccessEvent(
        instance_node_id=NodeId("inst-cup-007"),
        schema_type_id=NodeId("type-cup"),
        expectation_id="exp-color-001",
        property_key="color_dominant_hue",
        deviation_from_mean=-0.3,
        confirmation_count=12,
        session_id="session-2026-02-25-001",
        correlation_id=CorrelationId("corr-xyz-789"),
    )
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from cobeing.shared.types import CorrelationId, NodeId


class PredictionError(BaseModel):
    """A single expectation violation for one instance node.

    Created when the observed value of a property (e.g., color hue) on
    a new instance node falls more than ``expected_sigma_range`` standard
    deviations from the mean stored on the corresponding
    ``PropertyExpectation`` node (D-TS-09: threshold = 2.0).

    This record feeds the ``PREDICTION_ERROR_DEMOTION`` EvolutionRule
    (CANON A.2): the expectation node's confidence is lowered when its
    prediction errors accumulate.

    This model is **frozen** (immutable). A prediction error is a record
    of what was observed at a point in time. It must not be modified.

    Attributes:
        instance_node_id: The instance node whose property value violated
            the expectation.
        schema_type_id: The SCHEMA-level node (e.g., ``NodeId("type-cup")``)
            that this instance belongs to.
        expectation_id: The identifier of the ``PropertyExpectation`` node
            that was violated (e.g., ``"exp-color-001"``).
        property_key: The name of the property that violated the expectation
            (e.g., ``"color_dominant_hue"``). Used for logging and for
            targeted confidence updates on the expectation node.
        observed_sigma_distance: How many standard deviations the observed
            value was from the expectation's mean. Always >= 0.0 because
            this is a distance (unsigned magnitude). The sign of the
            deviation is intentionally discarded here; use
            ``PredictionSuccessEvent.deviation_from_mean`` when the signed
            value matters.
        expected_sigma_range: The threshold that was exceeded (D-TS-09:
            2.0). Stored here so the event is self-contained -- consumers
            do not need to re-read the EvolutionRule to understand the
            context.
        correlation_id: Traces this error back to the originating
            observation session. Correlates with structured log entries
            across the ingestion and verification pipeline.

    Example::

        error = PredictionError(
            instance_node_id=NodeId("inst-007"),
            schema_type_id=NodeId("type-cup"),
            expectation_id="exp-color-001",
            property_key="color_dominant_hue",
            observed_sigma_distance=3.4,
            expected_sigma_range=2.0,
            correlation_id=CorrelationId("corr-xyz"),
        )
        assert error.observed_sigma_distance >= 0.0
        assert error.observed_sigma_distance > error.expected_sigma_range
    """

    model_config = ConfigDict(frozen=True)

    instance_node_id: NodeId
    schema_type_id: NodeId
    expectation_id: str
    property_key: str
    observed_sigma_distance: float = Field(ge=0.0)
    expected_sigma_range: float
    correlation_id: CorrelationId


class PredictionErrorDetectedEvent(BaseModel):
    """Event emitted when an expectation violation is detected for a node.

    The expectation verification function (T046) emits one of these events
    each time it finds that an instance node's property value falls outside
    the expected sigma range for its schema type. This event triggers:

    - A ``prediction_errors`` increment on the ``PropertyExpectation`` node.
    - A confidence re-calculation via ``PREDICTION_ERROR_DEMOTION`` (CANON A.2).
    - A structured log entry at WARNING level.

    This model is **frozen** (immutable). Events are append-only records.

    Attributes:
        prediction_error: The structured description of the specific
            violation that was detected. Contains the node IDs, property
            key, and measured sigma distance.
        session_id: The observation session during which the violation was
            detected. Used by the ``SessionAccumulator`` (T051) to count
            prediction errors per session.
        correlation_id: Traces this event to the originating observation.
            Must match ``prediction_error.correlation_id``.

    Example::

        event = PredictionErrorDetectedEvent(
            prediction_error=error,
            session_id="session-001",
            correlation_id=CorrelationId("corr-xyz"),
        )
        assert event.prediction_error.observed_sigma_distance > 2.0
    """

    model_config = ConfigDict(frozen=True)

    prediction_error: PredictionError
    session_id: str
    correlation_id: CorrelationId


class PredictionSuccessEvent(BaseModel):
    """Event emitted when an observation confirms an expectation.

    The expectation verification function (T046) emits one of these events
    each time it finds that an instance node's property value falls within
    the expected sigma range for its schema type. This event triggers:

    - A ``confirmation_count`` increment on the ``PropertyExpectation`` node
      (D-TS-10: ``min(1.0, current + (1.0 - current) * 0.1)`` for confidence).
    - A structured log entry at DEBUG level.

    Successful predictions strengthen the graph's self-model: the system
    becomes more confident in its schema types as predictions are confirmed.

    This model is **frozen** (immutable). Events are append-only records.

    Attributes:
        instance_node_id: The instance node whose property value fell within
            the expected range.
        schema_type_id: The SCHEMA-level node that this instance belongs to.
        expectation_id: The identifier of the ``PropertyExpectation`` node
            that was confirmed.
        property_key: The name of the property that was verified
            (e.g., ``"color_dominant_hue"``).
        deviation_from_mean: The signed distance from the expectation mean,
            in standard deviations. Negative means the observed value was
            below the mean; positive means above. Unlike
            ``PredictionError.observed_sigma_distance``, this is signed --
            it carries directional information useful for tracking systematic
            biases in the schema's mean estimates over time.
        confirmation_count: The new confirmation count on the expectation
            node after this increment. Always >= 0. Consumers can use this
            to determine how many times this expectation has been validated.
        session_id: The observation session during which the confirmation
            occurred. Used by the ``SessionAccumulator`` (T051) to count
            successes per session.
        correlation_id: Traces this event to the originating observation.

    Example::

        event = PredictionSuccessEvent(
            instance_node_id=NodeId("inst-007"),
            schema_type_id=NodeId("type-cup"),
            expectation_id="exp-color-001",
            property_key="color_dominant_hue",
            deviation_from_mean=-0.3,
            confirmation_count=12,
            session_id="session-001",
            correlation_id=CorrelationId("corr-xyz"),
        )
        assert event.deviation_from_mean == -0.3   # below mean, within range
        assert event.confirmation_count == 12
    """

    model_config = ConfigDict(frozen=True)

    instance_node_id: NodeId
    schema_type_id: NodeId
    expectation_id: str
    property_key: str
    deviation_from_mean: float
    confirmation_count: int = Field(ge=0)
    session_id: str
    correlation_id: CorrelationId


__all__ = [
    "PredictionError",
    "PredictionErrorDetectedEvent",
    "PredictionSuccessEvent",
]

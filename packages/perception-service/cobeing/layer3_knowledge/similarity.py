"""Similarity computation types for the Co-Being knowledge graph.

This module defines the data structures produced by Epic 4's similarity
pipeline: the result of comparing two graph nodes via embedding distance,
and the event emitted when SIMILAR_TO edges are written to the graph.

These types are consumed by:

- The similarity computation function (Epic 4, T043) that reads embeddings
  from PropertyExpectation nodes and creates SIMILAR_TO edges.
- The knowledge graph writer that persists SIMILAR_TO edges.
- The LLM orchestration layer (Layer 4) that queries the graph for clusters
  of similar objects.

Key types:

- :class:`SimilarityResult` -- a single pairwise similarity score between
  two nodes, produced by the comparison algorithm.
- :class:`SimilarityComputedEvent` -- event emitted after the similarity
  pipeline processes one node and creates its SIMILAR_TO edges.

Usage::

    from cobeing.layer3_knowledge.similarity import (
        SimilarityResult,
        SimilarityComputedEvent,
    )
    from cobeing.shared.types import CorrelationId, NodeId

    result = SimilarityResult(
        source_node_id=NodeId("inst-001"),
        target_node_id=NodeId("inst-002"),
        similarity_score=0.87,
    )

    event = SimilarityComputedEvent(
        observed_node_id=NodeId("inst-001"),
        edges_created=3,
        label_raw="cup",
        correlation_id=CorrelationId("corr-abc-123"),
    )
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator

from cobeing.shared.types import CorrelationId, NodeId


class SimilarityResult(BaseModel):
    """A single pairwise similarity score between two knowledge graph nodes.

    Produced by the similarity computation function (Epic 4, T043) when
    comparing a newly observed instance node against existing instances
    of the same schema type. The score drives whether a SIMILAR_TO edge
    is created between the two nodes.

    This model is **frozen** (immutable). A similarity score is a point-in-
    time measurement -- it should not be mutated after creation. New
    measurements produce new ``SimilarityResult`` instances.

    The ``similarity_score`` is clamped to [0.0, 1.0] by the validator.
    Floating-point arithmetic can produce values like 1.0000000002 or
    -0.0000001; the clamp absorbs these edge cases without surfacing
    spurious validation errors to callers.

    Attributes:
        source_node_id: The node being compared (the newly observed instance).
        target_node_id: The node being compared against (an existing instance).
        similarity_score: Cosine or Euclidean similarity in [0.0, 1.0].
            0.0 means completely dissimilar. 1.0 means identical.
            Values outside this range are silently clamped by the validator.
        embedding_key: The property key on both nodes that holds the embedding
            vector used for comparison. Defaults to ``"embedding"``, which is
            the standard key set by the perception pipeline.

    Example::

        result = SimilarityResult(
            source_node_id=NodeId("inst-cup-001"),
            target_node_id=NodeId("inst-cup-002"),
            similarity_score=0.92,
        )
        assert result.similarity_score == 0.92

        # Floating-point overshoot is clamped silently:
        clamped = SimilarityResult(
            source_node_id=NodeId("a"),
            target_node_id=NodeId("b"),
            similarity_score=1.0000000002,
        )
        assert clamped.similarity_score == 1.0
    """

    model_config = ConfigDict(frozen=True)

    source_node_id: NodeId
    target_node_id: NodeId
    similarity_score: float
    embedding_key: str = Field(default="embedding")

    @field_validator("similarity_score", mode="before")
    @classmethod
    def _clamp_similarity_score(cls, v: object) -> float:
        """Clamp similarity_score to [0.0, 1.0].

        Accepts any numeric value and clamps it to the valid range.
        Floating-point arithmetic (e.g., dot-product normalization) can
        produce values just outside [0.0, 1.0]. The clamp absorbs these
        without raising a validation error.

        Args:
            v: The raw value passed to the field. Must be numeric.

        Returns:
            The clamped float in [0.0, 1.0].

        Raises:
            ValueError: If ``v`` is not a numeric type.
        """
        if not isinstance(v, (int, float)):
            raise ValueError(
                f"similarity_score must be a number, got {type(v).__name__!r}"
            )
        return float(min(1.0, max(0.0, v)))


class SimilarityComputedEvent(BaseModel):
    """Event emitted after the similarity pipeline processes one node.

    The similarity computation function (T043) processes one instance node
    at a time: it compares the node against all other instances of the same
    schema type and creates SIMILAR_TO edges for pairs above the threshold.
    This event records the outcome of that processing for one source node.

    This model is **frozen** (immutable). Events are append-only records of
    what happened; they must not be modified after creation.

    Consumers of this event include:

    - Structured logging (the event is logged at INFO level with
      ``correlation_id`` for tracing).
    - The LLM orchestration layer, which may use ``edges_created`` as a
      signal that new graph structure is available for reasoning.
    - Test assertions (verifying that the similarity pipeline produced the
      expected number of edges).

    Attributes:
        observed_node_id: The instance node that was processed.
        edges_created: How many SIMILAR_TO edges were written to the graph
            for this node during this computation. Zero is valid (the node
            had no similar neighbours above the threshold). Must be >= 0.
        label_raw: The raw detection label of the observed node (e.g.,
            ``"cup"``, ``"book"``). Included so log consumers can identify
            what the node represents without a graph lookup.
        correlation_id: Traces this event back to the originating observation
            session or API call. Correlates with structured log entries in
            the perception pipeline and ingestion layer.

    Example::

        event = SimilarityComputedEvent(
            observed_node_id=NodeId("inst-cup-001"),
            edges_created=2,
            label_raw="cup",
            correlation_id=CorrelationId("corr-abc-123"),
        )
        assert event.edges_created == 2
    """

    model_config = ConfigDict(frozen=True)

    observed_node_id: NodeId
    edges_created: int = Field(ge=0)
    label_raw: str
    correlation_id: CorrelationId


__all__ = [
    "SimilarityComputedEvent",
    "SimilarityResult",
]

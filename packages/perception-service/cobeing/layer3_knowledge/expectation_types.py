"""Epic 4 similarity and expectation data model types.

This module defines the two value objects that the ExpectationManager and
similarity protocols operate on:

- :class:`PropertyExpectation` -- a schema-type-level statistical summary
  of how a specific property (e.g. ``"embedding"``) is distributed across
  its instance nodes. Drives CANON A.2 prediction/verification logic.
- :class:`SimilarityCluster` -- a group of instance nodes identified as
  similar by the clustering pipeline, with within-cluster and cross-cluster
  similarity statistics.

Both types are **frozen** (immutable after construction). Expectations and
cluster snapshots are recalculated from the graph state rather than mutated
in place. This makes the data flow explicit: ExpectationManager reads the
graph, computes a new ``PropertyExpectation``, and writes it back -- never
patching fields on an existing instance.

Usage::

    from cobeing.layer3_knowledge.expectation_types import (
        PropertyExpectation, SimilarityCluster,
    )
    from cobeing.shared.provenance import ProvenanceSource
    from cobeing.shared.types import NodeId

    expectation = PropertyExpectation(
        expectation_id="exp-mug-embedding-001",
        schema_type_id=NodeId("type-mug"),
        property_key="embedding",
        mean_vector=[0.1, 0.2, 0.3],
        variance=0.04,
        sample_count=7,
        confirmation_count=5,
        prediction_errors=2,
        confidence=0.71,
        provenance=ProvenanceSource.INFERENCE,
        is_active=True,
    )

    cluster = SimilarityCluster(
        member_node_ids=[NodeId("obj-001"), NodeId("obj-002")],
        centroid_node_id=NodeId("obj-001"),
        mean_pairwise_similarity=0.88,
        mean_cross_similarity=0.31,
        contrast_ratio=0.88 / 0.31,
        label_raw_distribution={"mug": 2},
        session_ids=["sess-a", "sess-b"],
    )
"""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field

from cobeing.shared.provenance import ProvenanceSource
from cobeing.shared.types import NodeId


class PropertyExpectation(BaseModel):
    """Statistical summary of how a property is distributed across instances.

    A ``PropertyExpectation`` is owned by a schema type node (e.g., "mug") and
    tracks a single property (e.g., ``"embedding"``). Each time an instance of
    that type is observed, its property value is compared against the running
    centroid (``mean_vector``). If the value is within the expected spread
    (``variance``), it is a confirmation. If it is an outlier, it is a
    prediction error (CANON A.2 PREDICTION_ERROR_DEMOTION).

    The model is frozen (immutable). When the ExpectationManager updates
    statistics after a new observation, it creates a new ``PropertyExpectation``
    instance rather than mutating the existing one.

    Attributes:
        expectation_id: Unique identifier for this expectation record.
            Typically includes the schema type and property key, e.g.
            ``"exp-mug-embedding-001"``.
        schema_type_id: The schema node (SchemaLevel.SCHEMA) that this
            expectation belongs to. The expectation tracks instances of this
            type.
        property_key: The property name being tracked, e.g. ``"embedding"``,
            ``"color_dominant"``, ``"area_px"``.
        mean_vector: Running centroid of observed property values across all
            contributing instances. Each element is a float. For scalar
            properties, this is a one-element list. For embedding vectors,
            this is the full-dimensional centroid.
        variance: Scalar measure of spread of cosine distances from the
            centroid across all contributing instances. A low variance means
            instances of this type have consistent embeddings. Must be >= 0.0.
        sample_count: Number of distinct instance observations that have
            contributed to ``mean_vector`` and ``variance``. Must be >= 0.
        confirmation_count: Number of observations whose property value fell
            within the expected spread (i.e., supported the expectation).
            Must be >= 0.
        prediction_errors: Number of observations whose property value was
            an outlier (i.e., contradicted the expectation). Used by
            PREDICTION_ERROR_DEMOTION (CANON A.2) to lower confidence.
            Must be >= 0.
        confidence: How reliable this expectation is, on a 0.0 to 1.0 scale.
            Starts low and rises as confirmations accumulate relative to
            prediction errors. Updated per D-TS-10:
            ``min(1.0, current + (1.0 - current) * 0.1)`` on confirmation.
        provenance: Which of the four CANON A.11 source categories produced
            this expectation. Typically ``ProvenanceSource.INFERENCE`` since
            expectations are computed by the system, not directly observed.
            This is the enum value itself, not a full ``Provenance`` object --
            the expectation is a derived aggregate, not a single-source record.
        is_active: Whether this expectation has met the activation threshold
            and is being used for prediction. New expectations start as
            ``False`` until ``sample_count`` reaches the minimum required
            (D-TS-15: at least 3 instances across multiple sessions).
    """

    model_config = ConfigDict(frozen=True)

    expectation_id: str = Field(min_length=1)
    schema_type_id: NodeId
    property_key: str = Field(min_length=1)
    mean_vector: list[float]
    variance: float = Field(ge=0.0)
    sample_count: int = Field(ge=0)
    confirmation_count: int = Field(ge=0)
    prediction_errors: int = Field(ge=0)
    confidence: float = Field(ge=0.0, le=1.0)
    provenance: ProvenanceSource
    is_active: bool


@dataclass(frozen=True)
class SimilarityCluster:
    """A group of instance nodes identified as similar by the clustering pipeline.

    ``SimilarityCluster`` is a snapshot produced by the similarity analysis
    pipeline (Epic 4). It describes a set of instance nodes that have been
    grouped together because their embeddings are close in vector space,
    along with statistics characterizing how tight the cluster is and how
    distinct it is from neighboring clusters.

    The contrast ratio captures discriminability: a high ratio means the
    cluster is internally cohesive AND well-separated from other clusters.
    A ratio of ``float('inf')`` means there are no other clusters to compare
    against (i.e., only one cluster exists).

    The frozen dataclass is used rather than a frozen Pydantic model because
    ``SimilarityCluster`` is computed purely from graph data during analysis
    passes and never crosses API boundaries requiring JSON serialization or
    runtime validation. Pydantic's overhead is not justified here.

    Attributes:
        member_node_ids: The NodeIds of all instance nodes belonging to this
            cluster. Includes the centroid node.
        centroid_node_id: The NodeId of the node closest to the geometric
            centroid of the cluster (the most "typical" member). Must be in
            ``member_node_ids``.
        mean_pairwise_similarity: Average cosine similarity between all pairs
            of nodes within this cluster. Range 0.0 to 1.0. A value close to
            1.0 means the cluster is tight and internally consistent.
        mean_cross_similarity: Average cosine similarity between this cluster's
            centroid and the centroids of all other clusters. Range 0.0 to 1.0.
            A value close to 0.0 means this cluster is well-separated from
            its neighbors.
        contrast_ratio: ``mean_pairwise_similarity / mean_cross_similarity``
            when ``mean_cross_similarity > 0``, else ``float('inf')``. Values
            above 1.0 indicate a cluster that is more cohesive internally
            than it is similar to other clusters.
        label_raw_distribution: A count of each ``label_raw`` property value
            among the nodes in this cluster. Example: ``{"mug": 5, "cup": 1}``.
            Used to assess label homogeneity -- a well-formed cluster should
            have one dominant label.
        session_ids: Unique session identifiers of all observation sessions
            that contributed at least one node to this cluster. Clusters
            spanning multiple sessions are more reliable than single-session
            clusters (CANON D-TS-15 activation threshold).
    """

    member_node_ids: list[NodeId]
    centroid_node_id: NodeId
    mean_pairwise_similarity: float
    mean_cross_similarity: float
    contrast_ratio: float
    label_raw_distribution: dict[str, int]
    session_ids: list[str]


__all__ = [
    "PropertyExpectation",
    "SimilarityCluster",
]

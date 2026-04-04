"""Query and filter types for the Co-Being knowledge graph.

This module defines the data structures used to query, filter, and report
on the state of the knowledge graph. All models are **frozen** (immutable
after construction) because they represent query parameters and snapshot
reports -- neither of which should be mutated after creation.

Key types:

- :class:`TemporalWindow` -- a time range for filtering nodes/edges.
- :class:`NodeFilter` -- criteria for selecting a subset of nodes.
- :class:`EdgeFilter` -- criteria for selecting a subset of edges.
- :class:`SchemaHealthReport` -- a snapshot of graph health metrics.

Usage::

    from cobeing.layer3_knowledge.query_types import (
        EdgeFilter, NodeFilter, TemporalWindow, SchemaHealthReport,
    )
    from cobeing.layer3_knowledge.node_types import SchemaLevel

    # Filter for recent high-confidence instance nodes
    window = TemporalWindow(start=one_hour_ago)
    node_filter = NodeFilter(
        schema_level=SchemaLevel.INSTANCE,
        temporal_window=window,
        min_confidence=0.7,
    )

    # Filter for all INSTANCE_OF edges above a confidence threshold
    edge_filter = EdgeFilter(edge_type="INSTANCE_OF", min_confidence=0.8)

    # Schema health snapshot
    report = SchemaHealthReport(
        total_instance_count=42,
        total_type_count=5,
        type_coverage_ratio=0.85,
        avg_confidence=0.72,
        pending_proposal_count=2,
        orphan_node_count=1,
    )
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from cobeing.layer3_knowledge.node_types import SchemaLevel


class TemporalWindow(BaseModel):
    """A time range for filtering nodes and edges by their temporal fields.

    Defines a half-open interval ``[start, end)`` where ``start`` is inclusive
    and ``end`` is exclusive. If ``end`` is ``None``, the window extends from
    ``start`` up to the current moment (i.e., "everything since ``start``").

    Both ``start`` and ``end`` should be timezone-aware UTC datetimes to match
    the timestamps stored on ``KnowledgeNode`` and ``KnowledgeEdge``.

    Attributes:
        start: Beginning of the time window (inclusive).
        end: End of the time window (exclusive). ``None`` means "up to now".
    """

    model_config = ConfigDict(frozen=True)

    start: datetime
    end: datetime | None = Field(default=None)


class NodeFilter(BaseModel):
    """Criteria for selecting a subset of knowledge graph nodes.

    All fields are optional. When multiple fields are set, they combine
    with AND semantics -- a node must satisfy every non-None criterion
    to pass the filter.

    When all fields are ``None``, the filter matches every node (no
    filtering applied).

    Attributes:
        node_type: If set, only match nodes whose ``node_type`` equals this
            string. Example: ``"ObjectInstance"``, ``"SchemaType"``.
        schema_level: If set, only match nodes at this schema level.
        temporal_window: If set, only match nodes whose ``valid_from`` falls
            within this time range.
        min_confidence: If set, only match nodes whose ``confidence`` is
            greater than or equal to this value. Must be between 0.0 and 1.0.
    """

    model_config = ConfigDict(frozen=True)

    node_type: str | None = Field(default=None)
    schema_level: SchemaLevel | None = Field(default=None)
    temporal_window: TemporalWindow | None = Field(default=None)
    min_confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class EdgeFilter(BaseModel):
    """Criteria for selecting a subset of knowledge graph edges.

    All fields are optional. When multiple fields are set, they combine
    with AND semantics -- an edge must satisfy every non-None criterion
    to pass the filter.

    When all fields are ``None`` (or the filter itself is ``None``), every
    edge is returned. This matches the behaviour of ``NodeFilter`` for nodes.

    Attributes:
        edge_type: If set, only match edges whose ``edge_type`` equals this
            string. Example: ``"INSTANCE_OF"``, ``"SPATIAL_ON"``,
            ``"SIMILAR_TO"``.
        source_node_id: If set, only match edges whose ``source_id`` equals
            this node identifier.
        target_node_id: If set, only match edges whose ``target_id`` equals
            this node identifier.
        min_confidence: If set, only match edges whose ``confidence`` is
            greater than or equal to this value. Must be between 0.0 and 1.0.

    Example::

        from cobeing.layer3_knowledge.query_types import EdgeFilter

        # All INSTANCE_OF edges
        f = EdgeFilter(edge_type="INSTANCE_OF")

        # Edges from a specific source node above a confidence floor
        f = EdgeFilter(source_node_id=NodeId("node-abc"), min_confidence=0.7)

        # Return all edges (no criteria set)
        all_edges = await store.query_edges(None)
    """

    model_config = ConfigDict(frozen=True)

    edge_type: str | None = Field(default=None)
    source_node_id: str | None = Field(default=None)
    target_node_id: str | None = Field(default=None)
    min_confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class SchemaHealthReport(BaseModel):
    """A point-in-time snapshot of knowledge graph health metrics.

    This report is produced by graph introspection operations and consumed
    by the reasoning layer (Layer 4) to decide when schema evolution
    proposals are warranted. For example, a low ``type_coverage_ratio``
    suggests many instance nodes lack type assignments.

    All counts are non-negative integers. Ratios and averages are floats
    in the 0.0 to 1.0 range.

    The six fields correspond to the D-TS-08 decision specification.

    Attributes:
        total_instance_count: Number of nodes at SchemaLevel.INSTANCE.
        total_type_count: Number of nodes at SchemaLevel.SCHEMA.
        type_coverage_ratio: Fraction of instance nodes that have at least
            one INSTANCE_OF edge to a schema type. Range 0.0 to 1.0.
            A value of 1.0 means every instance is typed.
        avg_confidence: Mean confidence across all ACTIVE nodes in the graph.
            Range 0.0 to 1.0.
        pending_proposal_count: Number of nodes with status PENDING (schema
            evolution proposals awaiting guardian review).
        orphan_node_count: Number of nodes with zero edges (neither incoming
            nor outgoing). These may indicate incomplete graph construction.
    """

    model_config = ConfigDict(frozen=True)

    total_instance_count: int = Field(ge=0)
    total_type_count: int = Field(ge=0)
    type_coverage_ratio: float = Field(ge=0.0, le=1.0)
    avg_confidence: float = Field(ge=0.0, le=1.0)
    pending_proposal_count: int = Field(ge=0)
    orphan_node_count: int = Field(ge=0)


__all__ = [
    "EdgeFilter",
    "NodeFilter",
    "SchemaHealthReport",
    "TemporalWindow",
]

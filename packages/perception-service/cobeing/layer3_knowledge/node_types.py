"""Core domain types for the Co-Being knowledge graph.

This module defines the fundamental data structures for Layer 3 (Knowledge
Graph): nodes, edges, and the enums that classify them. These types are the
lingua franca of the graph -- every component that reads or writes graph
data works with these models.

Key types:

- :class:`SchemaLevel` -- the three-tier structure (CANON Section 4).
- :class:`NodeStatus` -- lifecycle states for graph nodes.
- :class:`KnowledgeNode` -- a single node in the knowledge graph.
- :class:`KnowledgeEdge` -- a directed relationship between two nodes.

Both ``KnowledgeNode`` and ``KnowledgeEdge`` are **mutable** Pydantic models.
They represent living domain objects whose confidence, status, and temporal
validity change over their lifetime. Provenance is still immutable (frozen
on the ``Provenance`` model itself) -- but the *reference* to which provenance
object a node carries can change (e.g., when an inference is later approved
by the guardian, the node gets a new ``Provenance`` instance).

Usage::

    from cobeing.shared import NodeId, Provenance, ProvenanceSource
    from cobeing.layer3_knowledge.node_types import (
        KnowledgeNode, KnowledgeEdge, SchemaLevel, NodeStatus,
    )

    node = KnowledgeNode(
        node_id=NodeId("obj-001"),
        node_type="ObjectInstance",
        schema_level=SchemaLevel.INSTANCE,
        properties={"label_raw": "cup", "color_dominant": [0.8, 0.1, 0.1]},
        provenance=Provenance(
            source=ProvenanceSource.SENSOR,
            source_id="camera-frame-0042",
            confidence=0.85,
        ),
        confidence=0.85,
    )
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from cobeing.shared.provenance import Provenance
from cobeing.shared.time_utils import utc_now
from cobeing.shared.types import EdgeId, NodeId


class SchemaLevel(StrEnum):
    """The three levels of the knowledge graph schema (CANON Section 4).

    The knowledge graph operates on three tiers. Every node belongs to
    exactly one level. Dependencies point upward: instance nodes reference
    schema nodes (via INSTANCE_OF edges), and schema nodes are governed
    by meta-schema rules.

    Attributes:
        INSTANCE: Individual observed objects and their relationships.
            Example: "this specific mug on Jim's desk."
        SCHEMA: Types and categories that group instances.
            Example: "mug" as a type, "spatial_on" as a relationship category.
        META_SCHEMA: Rules governing how the schema itself evolves.
            Example: TYPE_CREATION_THRESHOLD, GUARDIAN_NAME_TRIGGERS_TYPE,
            PREDICTION_ERROR_DEMOTION (CANON A.2).
    """

    INSTANCE = "instance"
    SCHEMA = "schema"
    META_SCHEMA = "meta_schema"


class NodeStatus(StrEnum):
    """Lifecycle states for knowledge graph nodes.

    A node transitions through these states over its lifetime. The
    typical lifecycle is ACTIVE -> SUPERSEDED (when replaced by a
    refined version). PENDING and REJECTED apply to schema proposals
    awaiting guardian approval (CANON A.4).

    Attributes:
        ACTIVE: Currently valid and in use. The default state for new nodes.
        SUPERSEDED: Replaced by a newer version. Kept for audit trail.
            The ``valid_to`` timestamp records when supersession occurred.
        PENDING: Awaiting guardian approval. Used for schema evolution
            proposals (new types, splits, merges) that the system has
            generated but the guardian has not yet reviewed.
        REJECTED: Explicitly rejected by the guardian. Kept so the system
            does not re-propose identical changes.
    """

    ACTIVE = "active"
    SUPERSEDED = "superseded"
    PENDING = "pending"
    REJECTED = "rejected"


class KnowledgeNode(BaseModel):
    """A single node in the knowledge graph.

    Every piece of knowledge the system has -- from a specific observed mug
    to a schema type like "container" to a meta-schema rule like
    TYPE_CREATION_THRESHOLD -- is represented as a KnowledgeNode.

    This model is **mutable** (not frozen). Nodes are living objects: their
    confidence changes as evidence accumulates, their status transitions
    through lifecycle states, and their temporal validity gets updated when
    they are superseded.

    Attributes:
        node_id: Unique identifier for this node. Format is determined by
            the graph layer (typically a UUID or prefixed string).
        node_type: The kind of node, e.g. "ObjectInstance", "SchemaType",
            "EvolutionRule". This is a free-form string rather than an enum
            to allow the schema to evolve without code changes.
        schema_level: Which of the three schema tiers this node belongs to.
        properties: Flexible key-value store for node-specific data. Contents
            depend on ``node_type`` -- an ObjectInstance might have
            ``{"label_raw": "cup", "color_dominant": [0.8, 0.1, 0.1]}``,
            while an EvolutionRule might have ``{"threshold": 3}``.
        provenance: CANON A.11 provenance metadata tracing this node to its
            source. Immutable on the Provenance object itself, but the node
            can be assigned a new Provenance instance (e.g., when an
            inference is later guardian-approved).
        confidence: How confident the system is in this node's validity,
            on a 0.0 to 1.0 scale. Updated as evidence accumulates or
            contradicts. Guardian statements default to 1.0.
        status: Current lifecycle state of this node.
        created_at: When this node was first created (system time, UTC).
            Set once at creation, never changed.
        valid_from: When this node became valid in the temporal model.
            For observations, this is the observation time. For schema
            proposals, this is the approval time.
        valid_to: When this node was superseded or invalidated. ``None``
            means the node is still valid. Set when status transitions
            to SUPERSEDED.
        last_confirmed: The most recent time that evidence supported this
            node's existence or correctness. ``None`` if never confirmed
            after initial creation.
        confirmation_count: Number of times this node has been confirmed
            by new evidence. Starts at 0. Incremented each time a new
            observation matches this node or a guardian confirms it.
        prediction_errors: Number of times predictions based on this node
            were wrong. Used by PREDICTION_ERROR_DEMOTION (CANON A.2)
            to autonomously lower confidence on PropertyExpectation nodes.
    """

    model_config = ConfigDict(
        # Not frozen -- nodes are mutable domain objects.
        # Provenance immutability is enforced on the Provenance model itself.
        validate_assignment=True,
    )

    node_id: NodeId
    node_type: str = Field(min_length=1)
    schema_level: SchemaLevel
    properties: dict[str, Any] = Field(default_factory=dict)
    provenance: Provenance
    confidence: float = Field(ge=0.0, le=1.0)
    status: NodeStatus = Field(default=NodeStatus.ACTIVE)
    created_at: datetime = Field(default_factory=utc_now)
    valid_from: datetime = Field(default_factory=utc_now)
    valid_to: datetime | None = Field(default=None)
    last_confirmed: datetime | None = Field(default=None)
    confirmation_count: int = Field(default=0, ge=0)
    prediction_errors: int = Field(default=0, ge=0)


class KnowledgeEdge(BaseModel):
    """A directed relationship between two nodes in the knowledge graph.

    Edges carry the same temporal and provenance metadata as nodes. An edge
    like ``(mug-001) -[SPATIAL_ON]-> (desk-001)`` records not just the
    relationship but *when* it was observed, *how confident* the system is,
    and *where* the information came from.

    This model is **mutable** (not frozen). Edge confidence and temporal
    validity change over the edge's lifetime.

    Attributes:
        edge_id: Unique identifier for this edge.
        source_id: The node this edge originates from.
        target_id: The node this edge points to.
        edge_type: The kind of relationship, e.g. "INSTANCE_OF",
            "SPATIAL_ON", "HAS_PROPERTY". Free-form string to allow
            schema evolution without code changes.
        properties: Flexible key-value store for edge-specific data.
            A SPATIAL_ON edge might have ``{"relative_position": "left_of"}``.
        provenance: CANON A.11 provenance metadata.
        confidence: How confident the system is in this relationship,
            0.0 to 1.0. Updated as evidence accumulates or contradicts.
        valid_from: When this relationship was first observed or established.
        valid_to: When this relationship was superseded or invalidated.
            ``None`` means the relationship is still valid.
    """

    model_config = ConfigDict(
        validate_assignment=True,
    )

    edge_id: EdgeId
    source_id: NodeId
    target_id: NodeId
    edge_type: str = Field(min_length=1)
    properties: dict[str, Any] = Field(default_factory=dict)
    provenance: Provenance
    confidence: float = Field(ge=0.0, le=1.0)
    valid_from: datetime = Field(default_factory=utc_now)
    valid_to: datetime | None = Field(default=None)


__all__ = [
    "KnowledgeEdge",
    "KnowledgeNode",
    "NodeStatus",
    "SchemaLevel",
]

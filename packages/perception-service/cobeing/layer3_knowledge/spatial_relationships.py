"""Spatial relationship write path for the Co-Being knowledge graph.

This module implements the write path for spatial relationships between
objects. A spatial relationship is represented as an intermediate
SpatialObservation Instance node connected by two directed edges -- one
from the subject node, one to the object node. This pattern (intermediate
node reification) is the CANON-correct approach: spatial relationships
carry provenance, confidence, and temporal metadata, and they must be
queryable independently of the objects they relate.

**Structure:**

A spatial relationship ``subject SPATIAL_ON object`` is stored as::

    (subject) -[SPATIAL_SUBJECT]-> (spatial_node) -[SPATIAL_OBJECT]-> (object)

The spatial_node has:
- ``node_type = "SpatialObservation"``
- ``schema_level = INSTANCE``
- ``properties["spatial_type"] = relationship_type`` (e.g. "SPATIAL_ON")
- INFERENCE provenance (D-TS-04: computed from sensor data, not raw sensor)

**Supersession:**

If an active spatial relationship of the same type already exists between
the same subject and object (identified by scanning for SpatialObservation
nodes), the old node's valid_to is set and its status becomes SUPERSEDED
before the new node is created. The supersession sequence is atomic within
the sense that all writes to the persistence backend occur sequentially
with no observable intermediate state exposed to callers.

**Provenance:**

All spatial observations carry INFERENCE provenance. Spatial positions are
computed from bounding box data and camera geometry -- they are the result
of system reasoning over sensor data, not direct sensor readings.
Per D-TS-04, this correctly classifies them as INFERENCE rather than SENSOR.

Usage::

    from cobeing.layer3_knowledge.spatial_relationships import (
        SpatialResult,
        add_spatial_relationship,
        supersede_spatial_relationship,
    )
    from cobeing.layer3_knowledge.in_memory_persistence import (
        InMemoryGraphPersistence,
    )
    from cobeing.shared.types import NodeId

    persistence = InMemoryGraphPersistence()
    subject_id = NodeId("instance-mug-001")
    object_id = NodeId("instance-desk-001")

    result = await add_spatial_relationship(
        persistence,
        subject_id=subject_id,
        object_id=object_id,
        relationship_type="SPATIAL_ON",
        properties={"estimated_distance_px": 42},
    )
    print(result.spatial_node_id)     # The SpatialObservation node ID
    print(result.subject_edge_id)     # subject -> spatial_node edge ID
    print(result.object_edge_id)      # spatial_node -> object edge ID
    print(result.superseded_node_id)  # None on first write

See Also:
    - ``cobeing.layer3_knowledge.protocols`` -- GraphPersistence Protocol
    - ``cobeing.layer3_knowledge.node_types`` -- KnowledgeNode, KnowledgeEdge
    - ``cobeing.shared.provenance`` -- Provenance, ProvenanceSource
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import NodeFilter
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.time_utils import utc_now
from cobeing.shared.types import EdgeId, NodeId


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SpatialResult:
    """Result of a spatial relationship write operation.

    Returned by ``add_spatial_relationship`` to give the caller the
    identifiers of the SpatialObservation node and its two connecting edges.
    If a previous active spatial relationship of the same type was superseded,
    its node ID is recorded here for audit purposes.

    Attributes:
        spatial_node_id: ID of the created SpatialObservation Instance node.
        subject_edge_id: ID of the SPATIAL_SUBJECT edge from the subject
            node to the spatial observation node.
        object_edge_id: ID of the SPATIAL_OBJECT edge from the spatial
            observation node to the object node.
        superseded_node_id: ID of the old SpatialObservation node that was
            superseded by this write, or ``None`` if no supersession occurred.
    """

    spatial_node_id: NodeId
    subject_edge_id: EdgeId
    object_edge_id: EdgeId
    superseded_node_id: NodeId | None


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _spatial_node_id() -> NodeId:
    """Generate a unique NodeId for a new SpatialObservation node."""
    return NodeId(f"spatial-{uuid.uuid4().hex[:12]}")


def _spatial_edge_id(prefix: str) -> EdgeId:
    """Generate a unique EdgeId for a spatial relationship edge.

    Args:
        prefix: Short descriptor for the edge role ("subj" or "obj"),
            included in the ID to aid debugging.

    Returns:
        A unique EdgeId with the given prefix.
    """
    return EdgeId(f"edge-{prefix}-{uuid.uuid4().hex[:12]}")


def _make_inference_provenance(source_id: str) -> Provenance:
    """Build INFERENCE provenance for a spatial computation.

    All spatial observations carry INFERENCE provenance. Spatial positions
    are computed from sensor data, not measured directly (D-TS-04).

    Args:
        source_id: Identifier for what triggered this spatial computation.
            Typically references the spatial node ID being created.

    Returns:
        A Provenance instance with INFERENCE source and full confidence.
    """
    return Provenance(
        source=ProvenanceSource.INFERENCE,
        source_id=source_id,
        confidence=1.0,
    )


async def _find_active_spatial_node(
    persistence: GraphPersistence,
    subject_id: NodeId,
    object_id: NodeId,
    relationship_type: str,
) -> KnowledgeNode | None:
    """Find an active SpatialObservation node for this subject/object/type triple.

    Scans all SpatialObservation instance nodes looking for one that:
    1. Has ``status == ACTIVE``
    2. Has ``spatial_type == relationship_type`` in its properties
    3. Has an edge from subject_id (via SPATIAL_SUBJECT) and to object_id
       (via SPATIAL_OBJECT)

    The scan checks edge participation by loading all ACTIVE SpatialObservation
    nodes and then verifying each one's edges. This is O(n) over spatial nodes,
    which is acceptable for the expected Phase 1 graph size.

    Args:
        persistence: The graph storage backend.
        subject_id: The subject node we are checking from.
        object_id: The object node we are checking to.
        relationship_type: The spatial type to match (e.g. "SPATIAL_ON").

    Returns:
        The active SpatialObservation node if found, or ``None``.
    """
    # Query all active SpatialObservation instance nodes with the matching type.
    # node_type filter alone is sufficient to narrow the scan significantly.
    node_filter = NodeFilter(
        node_type="SpatialObservation",
        schema_level=SchemaLevel.INSTANCE,
    )
    candidates = await persistence.query_nodes(node_filter)

    for node in candidates:
        # Only consider active nodes (not already superseded).
        if node.status != NodeStatus.ACTIVE:
            continue

        # Check the spatial_type property matches.
        if node.properties.get("spatial_type") != relationship_type:
            continue

        # Check subject and object linkage in properties (fast path).
        # The subject_id and object_id are stored directly on the spatial node
        # to avoid a second round of edge scans. This is a deliberate denormalization:
        # the edges are the canonical representation, but storing the endpoint IDs
        # as properties enables efficient lookup without traversal.
        if (
            node.properties.get("subject_id") == subject_id
            and node.properties.get("object_id") == object_id
        ):
            return node

    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def add_spatial_relationship(
    persistence: GraphPersistence,
    subject_id: NodeId,
    object_id: NodeId,
    relationship_type: str,
    properties: dict | None = None,
) -> SpatialResult:
    """Create a spatial relationship between two nodes in the knowledge graph.

    A spatial relationship is stored as a SpatialObservation Instance node
    connected by two directed edges::

        (subject_id) -[SPATIAL_SUBJECT]-> (spatial_node) -[SPATIAL_OBJECT]-> (object_id)

    The spatial_node carries:
    - ``node_type = "SpatialObservation"``
    - ``schema_level = INSTANCE``
    - INFERENCE provenance (D-TS-04)
    - ``properties["spatial_type"] = relationship_type``
    - ``properties["subject_id"] = subject_id`` (denormalized for lookup)
    - ``properties["object_id"] = object_id`` (denormalized for lookup)
    - Any additional key-value pairs from ``properties``

    **Supersession:** If an ACTIVE SpatialObservation node already exists for
    the same (subject, object, relationship_type) triple, it is superseded
    atomically: its status is set to SUPERSEDED and its valid_to is recorded
    before the new node is written.

    All writes occur sequentially on the persistence backend. The method does
    not use transactions (the in-memory backend has none), so a crash between
    writes would leave a partial state -- this is acceptable for Phase 1
    where Neo4j transaction support will be added at the infrastructure layer.

    Args:
        persistence: The graph storage backend to write into.
        subject_id: NodeId of the subject in the spatial relationship.
        object_id: NodeId of the object in the spatial relationship.
        relationship_type: Type of spatial relationship. Examples:
            "SPATIAL_ON", "SPATIAL_LEFT_OF", "SPATIAL_NEAR".
        properties: Optional additional properties to store on the spatial
            observation node. ``spatial_type``, ``subject_id``, and
            ``object_id`` are always set and will override any values
            provided here for those keys.

    Returns:
        A ``SpatialResult`` with the IDs of the new spatial node and its
        two edges. ``superseded_node_id`` is set if a previous active
        relationship was superseded, otherwise ``None``.
    """
    extra_props = dict(properties) if properties else {}

    # ------------------------------------------------------------------
    # Step 1: Find and supersede any active spatial relationship of the
    # same type between the same subject and object.
    # ------------------------------------------------------------------
    superseded_node_id: NodeId | None = None
    old_node = await _find_active_spatial_node(
        persistence, subject_id, object_id, relationship_type
    )
    if old_node is not None:
        superseded_node_id = old_node.node_id
        await supersede_spatial_relationship(persistence, old_node.node_id)

    # ------------------------------------------------------------------
    # Step 2: Create the new SpatialObservation node.
    # ------------------------------------------------------------------
    new_node_id = _spatial_node_id()
    provenance = _make_inference_provenance(str(new_node_id))

    node_properties = {
        **extra_props,
        # These keys are always set and always override extra_props values
        # to ensure the lookup denormalization remains consistent.
        "spatial_type": relationship_type,
        "subject_id": subject_id,
        "object_id": object_id,
    }

    spatial_node = KnowledgeNode(
        node_id=new_node_id,
        node_type="SpatialObservation",
        schema_level=SchemaLevel.INSTANCE,
        properties=node_properties,
        provenance=provenance,
        confidence=1.0,
    )
    await persistence.save_node(spatial_node)

    # ------------------------------------------------------------------
    # Step 3: Create the two directed edges.
    # ------------------------------------------------------------------
    subject_edge_id = _spatial_edge_id("subj")
    subject_edge = KnowledgeEdge(
        edge_id=subject_edge_id,
        source_id=subject_id,
        target_id=new_node_id,
        edge_type="SPATIAL_SUBJECT",
        provenance=provenance,
        confidence=1.0,
    )
    await persistence.save_edge(subject_edge)

    object_edge_id = _spatial_edge_id("obj")
    object_edge = KnowledgeEdge(
        edge_id=object_edge_id,
        source_id=new_node_id,
        target_id=object_id,
        edge_type="SPATIAL_OBJECT",
        provenance=provenance,
        confidence=1.0,
    )
    await persistence.save_edge(object_edge)

    return SpatialResult(
        spatial_node_id=new_node_id,
        subject_edge_id=subject_edge_id,
        object_edge_id=object_edge_id,
        superseded_node_id=superseded_node_id,
    )


async def supersede_spatial_relationship(
    persistence: GraphPersistence,
    old_node_id: NodeId,
) -> None:
    """Mark a SpatialObservation node as superseded.

    Retrieves the node and sets:
    - ``status = NodeStatus.SUPERSEDED``
    - ``valid_to = utc_now()``

    This records when the spatial relationship was invalidated, enabling
    temporal queries to distinguish current from historical spatial data.

    If no node exists for ``old_node_id``, the function returns without
    error -- superseding a non-existent node is a safe no-op.

    Args:
        persistence: The graph storage backend to read from and write to.
        old_node_id: NodeId of the SpatialObservation node to supersede.
    """
    node = await persistence.get_node(old_node_id)
    if node is None:
        return

    superseded_at = utc_now()
    node.status = NodeStatus.SUPERSEDED
    node.valid_to = superseded_at
    await persistence.save_node(node)


__all__ = [
    "SpatialResult",
    "add_spatial_relationship",
    "supersede_spatial_relationship",
]

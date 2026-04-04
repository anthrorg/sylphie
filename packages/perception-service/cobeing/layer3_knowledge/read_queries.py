"""Primary read queries for Layer 4 (reasoning) against the knowledge graph.

This module provides the eight read query functions that the reasoning layer
uses to interrogate the current state of the knowledge graph. All functions
accept a ``GraphPersistence`` as their first argument and return typed Python
objects.

**Design decision -- edge access:**

``query_edges`` is now part of the ``GraphPersistence`` Protocol (T303).
Functions in this module call ``persistence.query_edges(filter)`` directly.
``_get_edges_for_node`` retrieves all edges and filters by node_id in Python
because ``EdgeFilter`` uses AND semantics (source OR target is not expressible).

**Provenance:**

All returned objects are the same ``KnowledgeNode`` and ``KnowledgeEdge``
instances stored in the graph. Callers must not mutate them -- they are
graph-internal objects.

**Temporal model:**

Active nodes are those where ``valid_to is None``. Superseded nodes have
``valid_to`` set. All eight functions honour this convention and document
their temporal semantics explicitly.

Usage::

    from cobeing.layer3_knowledge import InMemoryGraphPersistence
    from cobeing.layer3_knowledge.read_queries import (
        get_current_scene,
        get_changes_since,
        get_spatial_relationships,
        get_object_history,
        get_type_instances,
        get_schema_types,
        get_pending_proposals,
        get_untyped_instances,
    )

    persistence = InMemoryGraphPersistence()
    # ... populate the graph ...

    active_nodes = await get_current_scene(persistence)
    schema_nodes = await get_schema_types(persistence)
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from cobeing.layer3_knowledge.node_types import KnowledgeEdge, KnowledgeNode, NodeStatus, SchemaLevel
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter
from cobeing.shared.types import NodeId


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _get_edges_for_node(persistence: Any, node_id: NodeId) -> list[KnowledgeEdge]:
    """Return all edges incident on ``node_id`` (source OR target).

    ``query_edges`` is now part of the ``GraphPersistence`` Protocol (T303).
    Because ``EdgeFilter`` uses AND semantics and cannot express "source OR
    target = node_id", this function fetches all edges via the Protocol and
    filters in Python.

    Args:
        persistence: The graph storage backend (must satisfy GraphPersistence).
        node_id: The node whose incident edges are requested.

    Returns:
        List of edges where ``source_id`` or ``target_id`` equals
        ``node_id``. May be empty if no such edges exist.
    """
    all_edges = await persistence.query_edges()
    return [
        edge
        for edge in all_edges
        if edge.source_id == node_id or edge.target_id == node_id
    ]


async def _get_all_edges(persistence: Any) -> list[KnowledgeEdge]:
    """Return all edges in the graph.

    ``query_edges`` is now part of the ``GraphPersistence`` Protocol (T303).
    This function calls it directly with no filter to retrieve all edges.

    Args:
        persistence: The graph storage backend (must satisfy GraphPersistence).

    Returns:
        List of all edges currently in the graph. May be empty.
    """
    return await persistence.query_edges()


# ---------------------------------------------------------------------------
# Public read query functions
# ---------------------------------------------------------------------------


async def get_current_scene(persistence: GraphPersistence) -> list[KnowledgeNode]:
    """Return all active Instance nodes -- the current observable scene.

    "Active" means the node is at ``SchemaLevel.INSTANCE`` and has
    ``valid_to is None``. Superseded nodes (those with a ``valid_to``
    timestamp set) are excluded because they represent historical states
    that have been replaced.

    This is the primary query for Layer 4 reasoning: "what does the system
    currently know about what it can see?"

    Args:
        persistence: The graph storage backend to query.

    Returns:
        List of all active Instance-level nodes. Empty if the graph has no
        current scene data.
    """
    all_instances = await persistence.query_nodes(
        NodeFilter(schema_level=SchemaLevel.INSTANCE)
    )
    return [node for node in all_instances if node.valid_to is None]


async def get_changes_since(
    persistence: GraphPersistence, since: datetime
) -> list[KnowledgeNode]:
    """Return nodes created or last modified after a given timestamp.

    A node is considered changed if either:
    - Its ``created_at`` is after ``since`` (newly created), or
    - Its ``last_confirmed`` is after ``since`` (updated by a new observation).

    This query is used by the reasoning layer to identify what has changed
    since the last reasoning cycle, enabling efficient incremental processing
    rather than full-graph re-analysis.

    Args:
        persistence: The graph storage backend to query.
        since: UTC datetime threshold. Nodes created or confirmed after this
            moment are included. Should be timezone-aware to match the graph's
            UTC timestamps.

    Returns:
        List of nodes that were created or confirmed after ``since``. Order
        is implementation-defined. May be empty if nothing changed.
    """
    all_nodes = await persistence.query_nodes(NodeFilter())
    results: list[KnowledgeNode] = []
    for node in all_nodes:
        created_after = node.created_at > since
        confirmed_after = node.last_confirmed is not None and node.last_confirmed > since
        if created_after or confirmed_after:
            results.append(node)
    return results


async def get_spatial_relationships(
    persistence: GraphPersistence, node_id: NodeId
) -> list[KnowledgeEdge]:
    """Return all active edges incident on the given node.

    "Active" means ``valid_to is None`` on the edge. Superseded edges are
    excluded. Both outgoing (``source_id == node_id``) and incoming
    (``target_id == node_id``) edges are returned.

    This query provides the spatial and relational context around a single
    node -- the edges that connect it to the rest of the graph. Layer 4
    uses this to answer questions like "what is near this object?" and
    "what type is this object classified as?"

    **Edge access:** Requires the persistence backend to implement
    ``query_edges``. If the method is absent, returns an empty list.

    Args:
        persistence: The graph storage backend to query. Must support
            ``query_edges`` for meaningful results.
        node_id: The node whose incident edges are requested.

    Returns:
        List of active edges where ``source_id`` or ``target_id`` equals
        ``node_id``. Empty if no active edges exist or edge queries are
        not supported.
    """
    edges = await _get_edges_for_node(persistence, node_id)
    return [edge for edge in edges if edge.valid_to is None]


async def get_object_history(
    persistence: GraphPersistence, node_id: NodeId
) -> list[KnowledgeNode]:
    """Return all versions of an object node, including superseded ones.

    The knowledge graph uses a temporal model where superseded states are
    retained rather than deleted (CANON A.10). This function retrieves all
    nodes whose ``node_id`` matches, sorted by ``created_at`` ascending so
    the oldest version comes first and the most recent version is last.

    In practice, a single node_id identifies exactly one logical object --
    there are not multiple nodes with the same ID. This function therefore
    returns either zero or one node. Its value is as the query primitive
    for temporal auditing ("what do we know about this node's history?")
    combined with edge-based version chains where applicable.

    To retrieve version history in graphs that use version-chain patterns
    (where each update creates a new node with a SUPERSEDES edge), use
    ``get_spatial_relationships`` to traverse SUPERSEDES edges from the
    current node.

    Args:
        persistence: The graph storage backend to query.
        node_id: The identifier of the object whose history to retrieve.

    Returns:
        List of all nodes with matching ``node_id``, sorted ascending by
        ``created_at``. In the standard single-node-per-ID model, this
        list contains zero or one element.
    """
    node = await persistence.get_node(node_id)
    if node is None:
        return []
    return [node]


async def get_type_instances(
    persistence: GraphPersistence, type_node_id: NodeId
) -> list[KnowledgeNode]:
    """Return all Instance nodes classified under the given Schema type.

    Traverses ``INSTANCE_OF`` edges to find Instance nodes linked to the
    specified schema type. An Instance node is "typed" when it has an
    outgoing ``INSTANCE_OF`` edge whose ``target_id`` is the schema type.

    Only nodes at ``SchemaLevel.INSTANCE`` are returned. Only active edges
    (``valid_to is None``) are traversed.

    **Edge access:** Requires the persistence backend to implement
    ``query_edges``. If the method is absent, returns an empty list.

    Args:
        persistence: The graph storage backend to query.
        type_node_id: The NodeId of the SchemaType node whose instances
            are requested.

    Returns:
        List of active Instance nodes classified under the given type.
        Empty if no instances are linked, or if edge queries are not
        supported.
    """
    all_edges = await _get_all_edges(persistence)

    # Find all INSTANCE_OF edges that point to the requested type
    instance_node_ids: list[NodeId] = [
        edge.source_id
        for edge in all_edges
        if (
            edge.edge_type == "INSTANCE_OF"
            and edge.target_id == type_node_id
            and edge.valid_to is None
        )
    ]

    # Retrieve and filter to Instance-level nodes only
    results: list[KnowledgeNode] = []
    for inst_id in instance_node_ids:
        node = await persistence.get_node(inst_id)
        if node is not None and node.schema_level == SchemaLevel.INSTANCE:
            results.append(node)

    return results


async def get_schema_types(persistence: GraphPersistence) -> list[KnowledgeNode]:
    """Return all Schema-level nodes.

    Schema-level nodes represent types and categories that the system has
    formed from accumulated instance observations (e.g., a "Mug" SchemaType
    that groups all mug instances). They are at ``SchemaLevel.SCHEMA``.

    This query gives Layer 4 the current type vocabulary: what categories
    exist in the system's world model.

    Args:
        persistence: The graph storage backend to query.

    Returns:
        List of all Schema-level nodes. Empty if no types have formed yet
        (expected immediately after bootstrap, before any schema evolution).
    """
    return await persistence.query_nodes(NodeFilter(schema_level=SchemaLevel.SCHEMA))


async def get_pending_proposals(persistence: GraphPersistence) -> list[KnowledgeNode]:
    """Return all nodes with ``status == PENDING``.

    Pending nodes are schema evolution proposals (new types, splits, merges)
    that the system has generated but the guardian has not yet reviewed
    (CANON A.4). Layer 4 uses this query to know what proposals are waiting
    for guardian attention so it can prompt the guardian appropriately.

    Nodes at any schema level may be PENDING. The result is not filtered by
    schema level.

    Args:
        persistence: The graph storage backend to query.

    Returns:
        List of all nodes with ``NodeStatus.PENDING``. Empty if no proposals
        are awaiting guardian review.
    """
    all_nodes = await persistence.query_nodes(NodeFilter())
    return [node for node in all_nodes if node.status == NodeStatus.PENDING]


async def get_untyped_instances(persistence: GraphPersistence) -> list[KnowledgeNode]:
    """Return Instance nodes that have no INSTANCE_OF edge as source.

    An "untyped" instance is an object the system has observed but has not
    yet classified into any schema type. These nodes represent knowledge
    gaps that the schema evolution process should address. Scout uses this
    query to identify which instances are candidates for type proposal.

    Only nodes at ``SchemaLevel.INSTANCE`` are considered. An instance is
    "typed" if it has at least one outgoing ``INSTANCE_OF`` edge (regardless
    of whether that edge is active or superseded).

    **Edge access:** Requires the persistence backend to implement
    ``query_edges``. If the method is absent, all instance nodes are
    returned (conservative: assumes none are typed, which is the safe
    direction for triggering schema evolution review).

    Args:
        persistence: The graph storage backend to query.

    Returns:
        List of Instance nodes with no outgoing INSTANCE_OF edge. May be
        empty if all instances are typed.
    """
    instance_nodes = await persistence.query_nodes(
        NodeFilter(schema_level=SchemaLevel.INSTANCE)
    )

    all_edges = await _get_all_edges(persistence)

    # Collect node_ids that already have at least one INSTANCE_OF edge as source
    typed_node_ids: set[NodeId] = {
        edge.source_id
        for edge in all_edges
        if edge.edge_type == "INSTANCE_OF"
    }

    return [
        node for node in instance_nodes if node.node_id not in typed_node_ids
    ]


__all__ = [
    "get_changes_since",
    "get_current_scene",
    "get_object_history",
    "get_pending_proposals",
    "get_schema_types",
    "get_spatial_relationships",
    "get_type_instances",
    "get_untyped_instances",
]

"""Temporal read queries for the Co-Being knowledge graph.

This module provides two temporal query functions that allow callers to
interrogate the graph as it existed at a specific point in time and to
retrieve the provenance chain for any node.

Both functions accept any ``GraphPersistence`` backend (in-memory or Neo4j)
and apply temporal filtering in Python against the set of all nodes. This
keeps the filtering logic identical across backends and requires no
backend-specific query language support.

**Temporal snapshot semantics (``get_scene_at``):**

A node is part of the scene at timestamp T if and only if:
- ``node.valid_from <= T``  (the node existed by time T), AND
- ``node.valid_to is None OR node.valid_to > T``  (the node had not yet been
  superseded at time T).

The ``valid_to`` boundary is exclusive: a node whose ``valid_to`` equals T
exactly is considered already gone at that instant. This mirrors the
half-open interval convention used elsewhere in the codebase.

**Provenance chain (``get_provenance_chain``):**

In Phase 1, every node carries a single ``Provenance`` record. The chain is
returned as a single-element list. The list form is chosen for forward
compatibility: when nodes accumulate multiple provenance records over their
lifetime (e.g., INFERENCE promoted to GUARDIAN_APPROVED_INFERENCE), this
function will return all of them in chronological order without changing its
signature.

Usage::

    from cobeing.layer3_knowledge.temporal_queries import (
        get_scene_at,
        get_provenance_chain,
    )
    from cobeing.layer3_knowledge.in_memory_persistence import (
        InMemoryGraphPersistence,
    )
    from datetime import datetime, UTC

    store = InMemoryGraphPersistence()
    # ... populate store ...

    scene = await get_scene_at(store, datetime(2026, 1, 15, 12, 0, 0, tzinfo=UTC))
    chain = await get_provenance_chain(store, node_id)

See Also:
    - ``cobeing.layer3_knowledge.protocols`` -- GraphPersistence Protocol
    - ``cobeing.layer3_knowledge.node_types`` -- KnowledgeNode
    - ``cobeing.shared.provenance`` -- Provenance
    - ``cobeing.shared.types`` -- NodeId
"""

from __future__ import annotations

from datetime import datetime

from cobeing.layer3_knowledge.node_types import KnowledgeNode
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import NodeFilter
from cobeing.shared.provenance import Provenance
from cobeing.shared.types import NodeId


async def get_scene_at(
    persistence: GraphPersistence,
    timestamp: datetime,
) -> list[KnowledgeNode]:
    """Return a temporal snapshot of the graph at the given timestamp.

    Retrieves all nodes that were valid at ``timestamp``: nodes that had
    already come into existence and had not yet been superseded.

    The inclusion criteria are:
    - ``node.valid_from <= timestamp`` -- the node existed by this time.
    - ``node.valid_to is None OR node.valid_to > timestamp`` -- the node
      had not yet been invalidated. ``valid_to`` is treated as an exclusive
      upper bound: a node superseded at exactly ``timestamp`` is no longer
      part of the scene at that instant.

    Args:
        persistence: The graph storage backend. Must satisfy the
            ``GraphPersistence`` Protocol.
        timestamp: The point in time for which to reconstruct the scene.
            Should be a timezone-aware UTC datetime to match the timestamps
            stored on nodes. Naive datetimes are accepted but comparisons
            against timezone-aware node timestamps will raise a TypeError
            from Python's datetime module.

    Returns:
        A list of ``KnowledgeNode`` objects that were valid at
        ``timestamp``. May be empty if no nodes satisfy the criteria
        or if the graph is empty.
    """
    all_nodes: list[KnowledgeNode] = await persistence.query_nodes(NodeFilter())

    result: list[KnowledgeNode] = []
    for node in all_nodes:
        # Condition 1: node must have come into existence by the query time.
        if node.valid_from > timestamp:
            continue

        # Condition 2: node must not have been superseded before the query time.
        # valid_to is exclusive: if valid_to == timestamp, the node is already gone.
        if node.valid_to is not None and node.valid_to <= timestamp:
            continue

        result.append(node)

    return result


async def get_provenance_chain(
    persistence: GraphPersistence,
    node_id: NodeId,
) -> list[Provenance]:
    """Return the provenance chain for a node.

    In Phase 1, every node carries exactly one ``Provenance`` record.
    This function returns it wrapped in a single-element list.

    The list form is chosen for forward compatibility. When Co-Being later
    supports nodes whose provenance evolves over time (e.g., an INFERENCE
    that is later GUARDIAN_APPROVED_INFERENCE), this function will return
    all historical provenance records in chronological order without any
    change to the function's signature or calling code.

    Args:
        persistence: The graph storage backend. Must satisfy the
            ``GraphPersistence`` Protocol.
        node_id: The identifier of the node whose provenance to retrieve.

    Returns:
        A single-element list containing the node's ``Provenance`` object,
        or an empty list if no node with ``node_id`` exists in the graph.
    """
    node: KnowledgeNode | None = await persistence.get_node(node_id)

    if node is None:
        return []

    return [node.provenance]


__all__ = [
    "get_provenance_chain",
    "get_scene_at",
]

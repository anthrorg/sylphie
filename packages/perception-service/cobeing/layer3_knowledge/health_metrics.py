"""Graph health metrics for the Co-Being knowledge graph.

This module computes the six health metrics described in D-TS-08 and returns
them as a :class:`SchemaHealthReport`.  The function is called by Layer 4
(reasoning) to decide when schema evolution proposals are warranted.

**Metric definitions (D-TS-08):**

1. ``total_instance_count`` -- number of nodes whose ``schema_level`` is
   ``SchemaLevel.INSTANCE``.

2. ``total_type_count`` -- number of nodes whose ``schema_level`` is
   ``SchemaLevel.SCHEMA``.

3. ``type_coverage_ratio`` -- fraction of instance nodes that have at least
   one outgoing ``INSTANCE_OF`` edge to a schema node.  0.0 when there are
   no instance nodes.

4. ``avg_confidence`` -- arithmetic mean of ``confidence`` across all nodes
   whose ``status`` is ``NodeStatus.ACTIVE``.  0.0 when there are no active
   nodes.

5. ``pending_proposal_count`` -- number of nodes whose ``status`` is
   ``NodeStatus.PENDING``.

6. ``orphan_node_count`` -- number of nodes that appear in no edge (neither
   as ``source_id`` nor as ``target_id``).

**Edge access:**

The :class:`~cobeing.layer3_knowledge.protocols.GraphPersistence` Protocol
does not expose a ``query_edges`` method.  This function uses duck typing
to call ``persistence.query_edges()`` when it is available (as it is on
:class:`~cobeing.layer3_knowledge.in_memory_persistence.InMemoryGraphPersistence`).
When ``query_edges`` is not available, edges are not consulted and type
coverage and orphan counts cannot be computed; both are returned as 0.0 / 0
respectively.  Production Neo4j implementations are expected to provide
``query_edges`` (deferred to the Neo4j epic).

Usage::

    from cobeing.layer3_knowledge import InMemoryGraphPersistence
    from cobeing.layer3_knowledge.health_metrics import get_health_metrics

    persistence = InMemoryGraphPersistence()
    # ... populate the graph ...
    report = await get_health_metrics(persistence)
    print(report.type_coverage_ratio)
"""

from __future__ import annotations

from cobeing.layer3_knowledge.node_types import NodeStatus, SchemaLevel
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import NodeFilter, SchemaHealthReport


async def get_health_metrics(persistence: GraphPersistence) -> SchemaHealthReport:
    """Compute graph health metrics.

    Queries the persistence layer for the current state of the graph and
    returns a :class:`SchemaHealthReport` capturing six metrics per D-TS-08.

    Edge-dependent metrics (``type_coverage_ratio`` and ``orphan_node_count``)
    require that ``persistence`` implements a ``query_edges()`` method beyond
    the base Protocol.  :class:`~cobeing.layer3_knowledge.in_memory_persistence.InMemoryGraphPersistence`
    provides this method.  When it is absent, both metrics are returned as
    their zero-value defaults (0.0 and 0).

    Args:
        persistence: The graph storage backend to query.  Must implement the
            :class:`~cobeing.layer3_knowledge.protocols.GraphPersistence`
            Protocol.  Optionally implements ``query_edges`` for full metric
            computation.

    Returns:
        A frozen :class:`SchemaHealthReport` with the six computed metrics.
    """
    # ------------------------------------------------------------------
    # Fetch all nodes in one pass.
    # ------------------------------------------------------------------
    all_nodes = await persistence.query_nodes(NodeFilter())

    # ------------------------------------------------------------------
    # Metric 1 -- total_instance_count
    # ------------------------------------------------------------------
    instance_nodes = [n for n in all_nodes if n.schema_level == SchemaLevel.INSTANCE]
    total_instance_count = len(instance_nodes)

    # ------------------------------------------------------------------
    # Metric 2 -- total_type_count
    # ------------------------------------------------------------------
    total_type_count = sum(
        1 for n in all_nodes if n.schema_level == SchemaLevel.SCHEMA
    )

    # ------------------------------------------------------------------
    # Metric 4 -- avg_confidence (ACTIVE nodes only)
    # Computed before edge queries so the loop is independent.
    # ------------------------------------------------------------------
    active_confidences = [
        n.confidence for n in all_nodes if n.status == NodeStatus.ACTIVE
    ]
    avg_confidence = (
        sum(active_confidences) / len(active_confidences)
        if active_confidences
        else 0.0
    )

    # ------------------------------------------------------------------
    # Metric 5 -- pending_proposal_count
    # ------------------------------------------------------------------
    pending_proposal_count = sum(
        1 for n in all_nodes if n.status == NodeStatus.PENDING
    )

    # ------------------------------------------------------------------
    # Edge-dependent metrics.
    # Use duck typing: call query_edges() only if the implementation
    # provides it.  The Protocol does not guarantee this method.
    # ------------------------------------------------------------------
    if not hasattr(persistence, "query_edges"):
        # Cannot compute edge-based metrics -- return safe zero values.
        return SchemaHealthReport(
            total_instance_count=total_instance_count,
            total_type_count=total_type_count,
            type_coverage_ratio=0.0,
            avg_confidence=avg_confidence,
            pending_proposal_count=pending_proposal_count,
            orphan_node_count=0,
        )

    all_edges = await persistence.query_edges()  # type: ignore[attr-defined]

    # ------------------------------------------------------------------
    # Metric 3 -- type_coverage_ratio
    # A "typed" instance is one that appears as the source of at least
    # one INSTANCE_OF edge.
    # ------------------------------------------------------------------
    if total_instance_count == 0:
        type_coverage_ratio = 0.0
    else:
        instance_of_sources = {
            edge.source_id
            for edge in all_edges
            if edge.edge_type == "INSTANCE_OF"
        }
        instance_node_ids = {n.node_id for n in instance_nodes}
        typed_count = len(instance_node_ids & instance_of_sources)
        type_coverage_ratio = typed_count / total_instance_count

    # ------------------------------------------------------------------
    # Metric 6 -- orphan_node_count
    # A node is an orphan if its node_id appears in no edge at all
    # (neither as source_id nor as target_id).
    # ------------------------------------------------------------------
    connected_node_ids: set = set()
    for edge in all_edges:
        connected_node_ids.add(edge.source_id)
        connected_node_ids.add(edge.target_id)

    all_node_ids = {n.node_id for n in all_nodes}
    orphan_node_count = len(all_node_ids - connected_node_ids)

    return SchemaHealthReport(
        total_instance_count=total_instance_count,
        total_type_count=total_type_count,
        type_coverage_ratio=type_coverage_ratio,
        avg_confidence=avg_confidence,
        pending_proposal_count=pending_proposal_count,
        orphan_node_count=orphan_node_count,
    )


__all__ = ["get_health_metrics"]

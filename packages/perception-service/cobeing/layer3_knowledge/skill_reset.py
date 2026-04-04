"""Skill package reset operations for the Co-Being knowledge graph.

This module implements three-layer reset operations for the skill package system:

1. **Hard reset** - removes all skill layer nodes/edges (those with installed_by_skill property)
2. **Experience reset** - removes all experience layer nodes/edges (SENSOR/GUARDIAN/INFERENCE provenance)
3. **Skill reset** - removes nodes/edges for a specific skill package

The three-layer architecture ensures clean separation:
- **Anchor layer** - META_SCHEMA infrastructure (SkillRegistry, EvolutionRules, CoBeing self-node) - never deleted
- **Skill layer** - nodes/edges created by skill packages (tagged with installed_by_skill property)
- **Experience layer** - nodes/edges created through observation and interaction

Reset operations use Neo4j DETACH DELETE for atomic removal of nodes and their
incident edges. All operations are wrapped in transactions with proper error
handling and KnowledgeGraphError wrapping.

Usage::

    from cobeing.layer3_knowledge.skill_reset import reset_hard, reset_experience, reset_skill

    # Reset all skill packages but preserve anchor layer and experience
    result = await reset_hard(persistence)
    # result.nodes_deleted == number of skill nodes removed

    # Reset all experience data but preserve anchor and skill layers
    result = await reset_experience(persistence)

    # Reset specific skill package
    result = await reset_skill(persistence, "arithmetic")
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from cobeing.layer3_knowledge.exceptions import KnowledgeGraphError

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from cobeing.layer3_knowledge.protocols import GraphPersistence


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ResetResult:
    """Result of a reset operation.

    Attributes:
        nodes_deleted: Number of nodes deleted by the reset operation.
        edges_deleted: Number of edges deleted by the reset operation.
        operation: Description of the reset operation performed.
    """

    nodes_deleted: int
    edges_deleted: int
    operation: str


# ---------------------------------------------------------------------------
# Reset operations
# ---------------------------------------------------------------------------


async def reset_hard(persistence: GraphPersistence) -> ResetResult:
    """Remove all skill layer and bootstrap layer nodes from the knowledge graph.

    Deletes two categories of nodes:
    1. Skill package nodes (have `installed_by_skill` property)
    2. Bootstrap nodes (have `taught_procedure` provenance) except core anchor nodes

    This preserves only the core anchor layer (SkillRegistry, core EvolutionRules,
    CoBeing self-node) and experience layer (sensor/guardian/inference provenance)
    while removing all skill packages AND bootstrap data (language forms, procedures, etc.).

    The operation uses DETACH DELETE to atomically remove nodes and their
    incident edges. Edges are automatically deleted when their endpoint
    nodes are deleted.

    Cypher::

        MATCH (n) WHERE (n.prop_installed_by_skill IS NOT NULL
        OR (n.provenance_source = 'taught_procedure' AND NOT n.node_id IN $anchor_nodes))
        DETACH DELETE n

    Args:
        persistence: Graph persistence backend that implements the Neo4j interface.

    Returns:
        ResetResult with counts of deleted nodes and edges and operation description.

    Raises:
        KnowledgeGraphError: If the Neo4j delete operation fails.
    """
    # Import here to avoid circular dependency
    from cobeing.layer3_knowledge.infrastructure.neo4j_persistence import Neo4jGraphPersistence

    if not isinstance(persistence, Neo4jGraphPersistence):
        raise KnowledgeGraphError(
            "reset_hard only supports Neo4jGraphPersistence, "
            f"got {type(persistence).__name__}"
        )

    # Count edges before deletion (since they'll be auto-deleted with nodes)
    anchor_node_ids = [
        'registry:skills',                                    # SkillRegistry
        'evolution-rule-type-creation-threshold',             # Core EvolutionRule nodes
        'evolution-rule-guardian-name-triggers-type',
        'evolution-rule-prediction-error-demotion',
        'rule:retrieval_threshold',
        'cobeing-self'                                        # CoBeing self-reference node
    ]

    count_edges_cypher = (
        "MATCH (n)-[r]-() WHERE "
        "(n.prop_installed_by_skill IS NOT NULL "
        "OR (n.provenance_source = 'taught_procedure' AND NOT n.node_id IN $anchor_nodes)) "
        "RETURN count(DISTINCT r) AS edge_count"
    )

    # Delete skill layer and bootstrap layer nodes, but preserve anchor layer
    # Anchor layer nodes that should never be deleted:
    anchor_node_ids = [
        'registry:skills',                                    # SkillRegistry
        'evolution-rule-type-creation-threshold',             # Core EvolutionRule nodes
        'evolution-rule-guardian-name-triggers-type',
        'evolution-rule-prediction-error-demotion',
        'rule:retrieval_threshold',
        'cobeing-self'                                        # CoBeing self-reference node
    ]

    delete_cypher = (
        "MATCH (n) WHERE "
        # Delete skill package nodes
        "(n.prop_installed_by_skill IS NOT NULL "
        # Also delete bootstrap nodes except anchor nodes
        "OR (n.provenance_source = 'taught_procedure' AND NOT n.node_id IN $anchor_nodes)) "
        "WITH n, count(n) AS node_count "
        "DETACH DELETE n "
        "RETURN node_count"
    )

    try:
        # Access the private _driver attribute from Neo4jGraphPersistence
        driver = persistence._driver
        with driver.session() as session:
            def _count_and_delete(tx) -> tuple[int, int]:
                # Count edges that will be deleted
                edge_result = tx.run(count_edges_cypher, anchor_nodes=anchor_node_ids)
                edge_count = edge_result.single()["edge_count"]

                # Count and delete nodes (edges auto-deleted)
                delete_result = tx.run(delete_cypher, anchor_nodes=anchor_node_ids)
                node_record = delete_result.single()
                node_count = node_record["node_count"] if node_record else 0

                return node_count, edge_count

            node_count, edge_count = session.execute_write(_count_and_delete)

        return ResetResult(
            nodes_deleted=node_count,
            edges_deleted=edge_count,
            operation="Hard reset - all skill packages and bootstrap data removed",
        )

    except Exception as exc:
        raise KnowledgeGraphError(
            f"Failed to perform hard reset: {exc}"
        ) from exc


async def reset_experience(persistence: GraphPersistence) -> ResetResult:
    """Remove all experience layer nodes and edges from the knowledge graph.

    Deletes all nodes with SENSOR, GUARDIAN, or INFERENCE provenance_source,
    which represents learned experience data. This preserves both the anchor
    layer (META_SCHEMA infrastructure) and skill layer (installed packages)
    while removing observational and interaction data.

    The operation uses DETACH DELETE to atomically remove nodes and their
    incident edges.

    Cypher::

        MATCH (n) WHERE n.provenance_source IN ['sensor', 'guardian', 'inference']
        DETACH DELETE n

    Args:
        persistence: Graph persistence backend that implements the Neo4j interface.

    Returns:
        ResetResult with counts of deleted nodes and edges and operation description.

    Raises:
        KnowledgeGraphError: If the Neo4j delete operation fails.
    """
    # Import here to avoid circular dependency
    from cobeing.layer3_knowledge.infrastructure.neo4j_persistence import Neo4jGraphPersistence

    if not isinstance(persistence, Neo4jGraphPersistence):
        raise KnowledgeGraphError(
            "reset_experience only supports Neo4jGraphPersistence, "
            f"got {type(persistence).__name__}"
        )

    # Count edges before deletion (exclude anchor nodes)
    count_edges_cypher = (
        "MATCH (n)-[r]-() WHERE n.provenance_source IN ['sensor', 'guardian', 'inference'] "
        "AND NOT n.node_id IN $anchor_nodes "
        "RETURN count(DISTINCT r) AS edge_count"
    )

    # Anchor layer nodes that should never be deleted (same as reset_hard)
    anchor_node_ids = [
        'registry:skills',                                    # SkillRegistry
        'evolution-rule-type-creation-threshold',             # Core EvolutionRule nodes
        'evolution-rule-guardian-name-triggers-type',
        'evolution-rule-prediction-error-demotion',
        'rule:retrieval_threshold',
        'cobeing-self'                                        # CoBeing self-reference node
    ]

    # Delete all experience layer nodes EXCEPT anchor nodes
    delete_cypher = (
        "MATCH (n) WHERE n.provenance_source IN ['sensor', 'guardian', 'inference'] "
        "AND NOT n.node_id IN $anchor_nodes "
        "WITH n, count(n) AS node_count "
        "DETACH DELETE n "
        "RETURN node_count"
    )

    try:
        driver = persistence._driver
        with driver.session() as session:
            def _count_and_delete(tx) -> tuple[int, int]:
                # Count edges that will be deleted
                edge_result = tx.run(count_edges_cypher, anchor_nodes=anchor_node_ids)
                edge_count = edge_result.single()["edge_count"]

                # Count and delete nodes (pass anchor_nodes parameter)
                delete_result = tx.run(delete_cypher, anchor_nodes=anchor_node_ids)
                node_record = delete_result.single()
                node_count = node_record["node_count"] if node_record else 0

                return node_count, edge_count

            node_count, edge_count = session.execute_write(_count_and_delete)

        return ResetResult(
            nodes_deleted=node_count,
            edges_deleted=edge_count,
            operation="Experience reset - all learned data removed",
        )

    except Exception as exc:
        raise KnowledgeGraphError(
            f"Failed to perform experience reset: {exc}"
        ) from exc


async def reset_skill(persistence: GraphPersistence, package_id: str) -> ResetResult:
    """Remove all nodes and edges for a specific skill package.

    Deletes all nodes where `installed_by_skill` property equals the given
    package_id. This allows clean removal of individual skill packages
    without affecting other skills, anchor layer infrastructure, or
    experience data.

    The operation uses DETACH DELETE to atomically remove nodes and their
    incident edges.

    Cypher::

        MATCH (n) WHERE n.prop_installed_by_skill = $package_id
        DETACH DELETE n

    Args:
        persistence: Graph persistence backend that implements the Neo4j interface.
        package_id: The skill package identifier to remove (e.g., "arithmetic").

    Returns:
        ResetResult with counts of deleted nodes and edges and operation description.

    Raises:
        KnowledgeGraphError: If the Neo4j delete operation fails or package_id is empty.
    """
    if not package_id or not package_id.strip():
        raise KnowledgeGraphError("package_id cannot be empty")

    # Import here to avoid circular dependency
    from cobeing.layer3_knowledge.infrastructure.neo4j_persistence import Neo4jGraphPersistence

    if not isinstance(persistence, Neo4jGraphPersistence):
        raise KnowledgeGraphError(
            "reset_skill only supports Neo4jGraphPersistence, "
            f"got {type(persistence).__name__}"
        )

    # Count edges before deletion
    count_edges_cypher = (
        "MATCH (n)-[r]-() WHERE n.prop_installed_by_skill = $package_id "
        "RETURN count(DISTINCT r) AS edge_count"
    )

    # Delete all nodes for the specific skill package
    delete_cypher = (
        "MATCH (n) WHERE n.prop_installed_by_skill = $package_id "
        "WITH n, count(n) AS node_count "
        "DETACH DELETE n "
        "RETURN node_count"
    )

    try:
        driver = persistence._driver
        with driver.session() as session:
            def _count_and_delete(tx) -> tuple[int, int]:
                # Count edges that will be deleted
                edge_result = tx.run(count_edges_cypher, package_id=package_id)
                edge_count = edge_result.single()["edge_count"]

                # Count and delete nodes
                delete_result = tx.run(delete_cypher, package_id=package_id)
                node_record = delete_result.single()
                node_count = node_record["node_count"] if node_record else 0

                return node_count, edge_count

            node_count, edge_count = session.execute_write(_count_and_delete)

        return ResetResult(
            nodes_deleted=node_count,
            edges_deleted=edge_count,
            operation=f"Skill reset - package '{package_id}' removed",
        )

    except Exception as exc:
        raise KnowledgeGraphError(
            f"Failed to reset skill package '{package_id}': {exc}"
        ) from exc


__all__ = [
    "ResetResult",
    "reset_hard",
    "reset_experience",
    "reset_skill",
]

"""Semantic graph minimum viable population check (P1.8-E3/T016).

Verifies that the semantic graph has sufficient density before enabling
semantic query procedures. Prevents premature activation of definition,
classification, and inference queries on sparse graphs where results
would be misleading or degenerate.

The MVP check enforces five thresholds:

  1. Minimum semantic fact count (30): total active semantic edges across
     all 16 semantic edge types (excluding DENOTES, which is counted
     separately as cross-domain).

  2. Minimum concept clusters (3): distinct IS_A target nodes with at
     least one active IS_A edge. Each target represents a concept cluster
     (e.g., "animal", "vehicle", "furniture"). This ensures the graph
     has taxonomic diversity, not just depth within one cluster.

  3. Minimum semantic edge types (5): at least 5 different semantic
     relationship types must have at least one active edge instance.
     This ensures the graph has structural variety (not just IS_A facts).

  4. Minimum cross-domain bridges (3): active DENOTES edges linking
     WordSenseNodes in LanguageDomain to concept nodes in SemanticDomain.
     These bridges are required per CANON A.20 and are the pathway
     through which language queries reach semantic knowledge.

  5. Minimum facts per cluster (5): no concept cluster should have fewer
     than 5 semantic facts. This prevents a graph where one cluster is
     rich (30 facts) and others are empty (0 facts each). The check
     uses the mean facts-per-cluster, not a per-cluster minimum, to
     allow some natural variation.

Integration points:
  - SemanticQueryHandler (T010) calls ``check_semantic_mvp`` before
    executing any semantic query procedure. If the check fails, the
    handler returns an honest-ignorance response explaining what the
    graph needs.
  - DevelopmentalGate (T012) uses the MVP check as an additional gate
    condition: even if a query type is developmentally enabled, it
    will not fire on a graph that fails the MVP check.

CANON references:
  A.1  -- Experience-first. MVP thresholds ensure sufficient experience
          has accumulated before the system claims semantic competence.
  A.20 -- Domain structure. Cross-domain bridges are structural, not
          optional.

Phase 1.8 (Comprehension Layer, P1.8-E3/T016).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Threshold constants
# ---------------------------------------------------------------------------

MIN_SEMANTIC_FACTS: int = 30
"""Minimum total active semantic edges (excluding DENOTES) before semantic
queries can activate. The range 30-50 from the ticket spec; we use the lower
bound as the hard gate and report distance-to-50 as a health signal."""

IDEAL_SEMANTIC_FACTS: int = 50
"""Ideal semantic fact count. Not a hard gate -- used for readiness
percentage reporting (0-100% where 100% = ideal reached)."""

MIN_CONCEPT_CLUSTERS: int = 3
"""Minimum distinct IS_A target nodes with active edges. Each target is
a concept cluster root (e.g., "animal" in "cat IS_A animal")."""

MIN_SEMANTIC_EDGE_TYPES: int = 5
"""Minimum number of distinct semantic edge types with at least one
active edge instance each."""

MIN_CROSS_DOMAIN_BRIDGES: int = 3
"""Minimum active DENOTES edges bridging LanguageDomain to SemanticDomain."""

MIN_MEAN_FACTS_PER_CLUSTER: float = 5.0
"""Minimum mean semantic facts per concept cluster. Ensures density is
distributed, not concentrated in one cluster."""

# The 16 semantic edge types (excluding DENOTES, which is cross-domain).
_SEMANTIC_EDGE_TYPES: tuple[str, ...] = (
    "IS_A",
    "HAS_PROPERTY",
    "LACKS_PROPERTY",
    "PART_OF",
    "LOCATED_IN",
    "USED_FOR",
    "CAUSES",
    "ENABLES",
    "PREVENTS",
    "REQUIRES",
    "ACHIEVES",
    "PRODUCES",
    "CONSUMES",
    "CONTRADICTS",
    "SIMILAR_TO",
    "OPPOSITE_OF",
)


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MVPCheckResult:
    """Result of the semantic graph minimum viable population check.

    Attributes:
        ready: True if all five thresholds are met. When False, the
            ``failures`` list contains human-readable messages explaining
            what the graph lacks.
        total_semantic_facts: Count of active semantic edges (not DENOTES).
        concept_cluster_count: Count of distinct IS_A target nodes.
        semantic_edge_type_count: Count of distinct semantic edge types
            with at least one active instance.
        cross_domain_bridge_count: Count of active DENOTES edges.
        mean_facts_per_cluster: Mean semantic facts per concept cluster.
            0.0 when there are no concept clusters.
        readiness_pct: Overall readiness percentage (0-100). Computed as
            the minimum of the five individual readiness percentages.
            Useful for progressive UI display.
        failures: Human-readable failure messages. Empty when ``ready``
            is True.
        edge_type_distribution: Mapping from semantic edge type to count
            of active instances. Only includes types with count > 0.
        cluster_node_ids: Set of node_ids that are IS_A targets (cluster
            roots). Useful for downstream analysis.
        checked_at: UTC timestamp of when the check ran.
    """

    ready: bool
    total_semantic_facts: int
    concept_cluster_count: int
    semantic_edge_type_count: int
    cross_domain_bridge_count: int
    mean_facts_per_cluster: float
    readiness_pct: float
    failures: list[str] = field(default_factory=list)
    edge_type_distribution: dict[str, int] = field(default_factory=dict)
    cluster_node_ids: frozenset[str] = field(default_factory=frozenset)
    checked_at: datetime = field(default_factory=lambda: datetime.now(UTC))


# ---------------------------------------------------------------------------
# Core check function (persistence-based, no Neo4j dependency)
# ---------------------------------------------------------------------------


async def check_semantic_mvp(
    persistence: GraphPersistence,
) -> MVPCheckResult:
    """Check whether the semantic graph meets minimum viable population.

    Queries the graph persistence layer for active semantic edges across
    all 16 semantic edge types plus DENOTES. Computes five readiness
    metrics and returns a structured result indicating whether the graph
    is ready for semantic query activation.

    This function uses the ``GraphPersistence`` protocol exclusively --
    no Neo4j driver is required. It works with both InMemoryGraphPersistence
    (tests) and Neo4jGraphPersistence (production).

    Args:
        persistence: Graph storage backend satisfying the GraphPersistence
            protocol.

    Returns:
        MVPCheckResult with readiness assessment and detailed metrics.
    """
    # ------------------------------------------------------------------
    # Step 1: Count active semantic edges by type.
    # ------------------------------------------------------------------
    edge_type_counts: dict[str, int] = {}
    total_semantic_facts = 0
    cluster_targets: set[str] = set()

    for edge_type in _SEMANTIC_EDGE_TYPES:
        try:
            edges = await persistence.query_edges(
                EdgeFilter(edge_type=edge_type)
            )
            # Only count active edges (valid_to is None).
            active_edges = [e for e in edges if e.valid_to is None]
            count = len(active_edges)
            if count > 0:
                edge_type_counts[edge_type] = count
            total_semantic_facts += count

            # Track IS_A targets for concept cluster counting.
            if edge_type == "IS_A":
                for e in active_edges:
                    cluster_targets.add(str(e.target_id))
        except Exception as exc:
            _logger.warning(
                "semantic_mvp_check: failed to query edge type %s: %s",
                edge_type,
                exc,
            )
            continue

    # ------------------------------------------------------------------
    # Step 2: Count active DENOTES (cross-domain bridge) edges.
    # ------------------------------------------------------------------
    cross_domain_count = 0
    try:
        denotes_edges = await persistence.query_edges(
            EdgeFilter(edge_type="DENOTES")
        )
        cross_domain_count = sum(1 for e in denotes_edges if e.valid_to is None)
    except Exception as exc:
        _logger.warning(
            "semantic_mvp_check: failed to query DENOTES edges: %s", exc
        )

    # ------------------------------------------------------------------
    # Step 3: Compute derived metrics.
    # ------------------------------------------------------------------
    concept_cluster_count = len(cluster_targets)
    semantic_edge_type_count = len(edge_type_counts)
    mean_facts_per_cluster = (
        total_semantic_facts / concept_cluster_count
        if concept_cluster_count > 0
        else 0.0
    )

    # ------------------------------------------------------------------
    # Step 4: Evaluate each threshold and build failure messages.
    # ------------------------------------------------------------------
    failures: list[str] = []

    if total_semantic_facts < MIN_SEMANTIC_FACTS:
        failures.append(
            f"Semantic graph has {total_semantic_facts} facts, "
            f"need at least {MIN_SEMANTIC_FACTS}. "
            f"Teach me more about the world to build up semantic knowledge."
        )

    if concept_cluster_count < MIN_CONCEPT_CLUSTERS:
        failures.append(
            f"Semantic graph has {concept_cluster_count} concept cluster(s), "
            f"need at least {MIN_CONCEPT_CLUSTERS}. "
            f"Teach 'is a' relationships across different categories "
            f"(e.g., animals, objects, places)."
        )

    if semantic_edge_type_count < MIN_SEMANTIC_EDGE_TYPES:
        present = sorted(edge_type_counts.keys())
        failures.append(
            f"Semantic graph uses {semantic_edge_type_count} relationship type(s) "
            f"({', '.join(present) if present else 'none'}), "
            f"need at least {MIN_SEMANTIC_EDGE_TYPES}. "
            f"Teach diverse facts: properties, locations, causes, purposes."
        )

    if cross_domain_count < MIN_CROSS_DOMAIN_BRIDGES:
        failures.append(
            f"Semantic graph has {cross_domain_count} cross-domain bridge(s) "
            f"(DENOTES), need at least {MIN_CROSS_DOMAIN_BRIDGES}. "
            f"These are created automatically when teaching semantic facts "
            f"about words the system already knows."
        )

    if concept_cluster_count > 0 and mean_facts_per_cluster < MIN_MEAN_FACTS_PER_CLUSTER:
        failures.append(
            f"Mean facts per cluster is {mean_facts_per_cluster:.1f}, "
            f"need at least {MIN_MEAN_FACTS_PER_CLUSTER:.1f}. "
            f"Teach more facts about each concept category, not just 'is a' "
            f"relationships."
        )

    ready = len(failures) == 0

    # ------------------------------------------------------------------
    # Step 5: Compute readiness percentage (minimum of five sub-percentages).
    # ------------------------------------------------------------------
    sub_pcts: list[float] = [
        min(100.0, 100.0 * total_semantic_facts / IDEAL_SEMANTIC_FACTS),
        min(100.0, 100.0 * concept_cluster_count / MIN_CONCEPT_CLUSTERS),
        min(100.0, 100.0 * semantic_edge_type_count / MIN_SEMANTIC_EDGE_TYPES),
        min(100.0, 100.0 * cross_domain_count / MIN_CROSS_DOMAIN_BRIDGES),
    ]
    if concept_cluster_count > 0:
        sub_pcts.append(
            min(100.0, 100.0 * mean_facts_per_cluster / MIN_MEAN_FACTS_PER_CLUSTER)
        )
    readiness_pct = min(sub_pcts) if sub_pcts else 0.0

    # ------------------------------------------------------------------
    # Step 6: Log and return.
    # ------------------------------------------------------------------
    if ready:
        _logger.info(
            "semantic_mvp_check PASSED: facts=%d clusters=%d edge_types=%d "
            "bridges=%d mean_per_cluster=%.1f readiness=%.0f%%",
            total_semantic_facts,
            concept_cluster_count,
            semantic_edge_type_count,
            cross_domain_count,
            mean_facts_per_cluster,
            readiness_pct,
        )
    else:
        _logger.info(
            "semantic_mvp_check FAILED (%d issue(s)): facts=%d/%d "
            "clusters=%d/%d edge_types=%d/%d bridges=%d/%d "
            "mean_per_cluster=%.1f/%.1f readiness=%.0f%%",
            len(failures),
            total_semantic_facts,
            MIN_SEMANTIC_FACTS,
            concept_cluster_count,
            MIN_CONCEPT_CLUSTERS,
            semantic_edge_type_count,
            MIN_SEMANTIC_EDGE_TYPES,
            cross_domain_count,
            MIN_CROSS_DOMAIN_BRIDGES,
            mean_facts_per_cluster,
            MIN_MEAN_FACTS_PER_CLUSTER,
            readiness_pct,
        )

    return MVPCheckResult(
        ready=ready,
        total_semantic_facts=total_semantic_facts,
        concept_cluster_count=concept_cluster_count,
        semantic_edge_type_count=semantic_edge_type_count,
        cross_domain_bridge_count=cross_domain_count,
        mean_facts_per_cluster=mean_facts_per_cluster,
        readiness_pct=readiness_pct,
        failures=failures,
        edge_type_distribution=edge_type_counts,
        cluster_node_ids=frozenset(cluster_targets),
        checked_at=datetime.now(UTC),
    )


# ---------------------------------------------------------------------------
# Neo4j-optimised variant (single Cypher query)
# ---------------------------------------------------------------------------


async def check_semantic_mvp_neo4j(
    neo4j_driver: object,
) -> MVPCheckResult:
    """Check semantic MVP using a single optimised Cypher query.

    This variant uses direct Neo4j access for better performance on large
    graphs. It collapses all five metric computations into two Cypher
    queries (one for semantic edges, one for DENOTES), avoiding the
    per-edge-type round-trip overhead of the persistence-based variant.

    Args:
        neo4j_driver: Neo4j driver instance with a ``session()`` method.

    Returns:
        MVPCheckResult with readiness assessment and detailed metrics.

    Raises:
        RuntimeError: If the Neo4j driver does not support ``session()``.
    """
    if not hasattr(neo4j_driver, "session"):
        raise RuntimeError(
            "check_semantic_mvp_neo4j requires a Neo4j driver with session() method"
        )

    # Query 1: Aggregate semantic edge counts by type, plus IS_A cluster targets.
    semantic_query = """
    UNWIND $types AS edge_type
    OPTIONAL MATCH ()-[r]->()
    WHERE type(r) = edge_type AND r.valid_to IS NULL
    WITH edge_type, count(r) AS cnt
    RETURN edge_type, cnt
    """

    cluster_query = """
    MATCH ()-[r:IS_A]->()
    WHERE r.valid_to IS NULL
    RETURN DISTINCT elementId(endNode(r)) AS cluster_id,
           endNode(r).prop_node_id AS cluster_node_id
    """

    denotes_query = """
    MATCH ()-[r:DENOTES]->()
    WHERE r.valid_to IS NULL
    RETURN count(r) AS denotes_count
    """

    edge_type_counts: dict[str, int] = {}
    total_semantic_facts = 0
    cluster_targets: set[str] = set()
    cross_domain_count = 0

    session = neo4j_driver.session(database="neo4j")  # type: ignore[union-attr]
    try:
        # Semantic edge counts by type.
        result = session.run(semantic_query, types=list(_SEMANTIC_EDGE_TYPES))
        for record in result:
            et = record["edge_type"]
            cnt = int(record["cnt"])
            if cnt > 0:
                edge_type_counts[et] = cnt
                total_semantic_facts += cnt

        # IS_A cluster targets.
        result = session.run(cluster_query)
        for record in result:
            nid = record.get("cluster_node_id")
            if nid:
                cluster_targets.add(str(nid))
            else:
                # Fallback to element ID if prop_node_id not available.
                eid = record.get("cluster_id")
                if eid:
                    cluster_targets.add(str(eid))

        # DENOTES count.
        result = session.run(denotes_query)
        record = result.single()
        if record:
            cross_domain_count = int(record["denotes_count"])
    finally:
        session.close()

    # Compute derived metrics (same logic as persistence-based variant).
    concept_cluster_count = len(cluster_targets)
    semantic_edge_type_count = len(edge_type_counts)
    mean_facts_per_cluster = (
        total_semantic_facts / concept_cluster_count
        if concept_cluster_count > 0
        else 0.0
    )

    failures: list[str] = []

    if total_semantic_facts < MIN_SEMANTIC_FACTS:
        failures.append(
            f"Semantic graph has {total_semantic_facts} facts, "
            f"need at least {MIN_SEMANTIC_FACTS}. "
            f"Teach me more about the world to build up semantic knowledge."
        )

    if concept_cluster_count < MIN_CONCEPT_CLUSTERS:
        failures.append(
            f"Semantic graph has {concept_cluster_count} concept cluster(s), "
            f"need at least {MIN_CONCEPT_CLUSTERS}. "
            f"Teach 'is a' relationships across different categories "
            f"(e.g., animals, objects, places)."
        )

    if semantic_edge_type_count < MIN_SEMANTIC_EDGE_TYPES:
        present = sorted(edge_type_counts.keys())
        failures.append(
            f"Semantic graph uses {semantic_edge_type_count} relationship type(s) "
            f"({', '.join(present) if present else 'none'}), "
            f"need at least {MIN_SEMANTIC_EDGE_TYPES}. "
            f"Teach diverse facts: properties, locations, causes, purposes."
        )

    if cross_domain_count < MIN_CROSS_DOMAIN_BRIDGES:
        failures.append(
            f"Semantic graph has {cross_domain_count} cross-domain bridge(s) "
            f"(DENOTES), need at least {MIN_CROSS_DOMAIN_BRIDGES}. "
            f"These are created automatically when teaching semantic facts "
            f"about words the system already knows."
        )

    if concept_cluster_count > 0 and mean_facts_per_cluster < MIN_MEAN_FACTS_PER_CLUSTER:
        failures.append(
            f"Mean facts per cluster is {mean_facts_per_cluster:.1f}, "
            f"need at least {MIN_MEAN_FACTS_PER_CLUSTER:.1f}. "
            f"Teach more facts about each concept category, not just 'is a' "
            f"relationships."
        )

    ready = len(failures) == 0

    sub_pcts: list[float] = [
        min(100.0, 100.0 * total_semantic_facts / IDEAL_SEMANTIC_FACTS),
        min(100.0, 100.0 * concept_cluster_count / MIN_CONCEPT_CLUSTERS),
        min(100.0, 100.0 * semantic_edge_type_count / MIN_SEMANTIC_EDGE_TYPES),
        min(100.0, 100.0 * cross_domain_count / MIN_CROSS_DOMAIN_BRIDGES),
    ]
    if concept_cluster_count > 0:
        sub_pcts.append(
            min(100.0, 100.0 * mean_facts_per_cluster / MIN_MEAN_FACTS_PER_CLUSTER)
        )
    readiness_pct = min(sub_pcts) if sub_pcts else 0.0

    if ready:
        _logger.info(
            "semantic_mvp_check_neo4j PASSED: facts=%d clusters=%d "
            "edge_types=%d bridges=%d readiness=%.0f%%",
            total_semantic_facts,
            concept_cluster_count,
            semantic_edge_type_count,
            cross_domain_count,
            readiness_pct,
        )
    else:
        _logger.info(
            "semantic_mvp_check_neo4j FAILED (%d issue(s)): facts=%d/%d "
            "clusters=%d/%d edge_types=%d/%d bridges=%d/%d readiness=%.0f%%",
            len(failures),
            total_semantic_facts,
            MIN_SEMANTIC_FACTS,
            concept_cluster_count,
            MIN_CONCEPT_CLUSTERS,
            semantic_edge_type_count,
            MIN_SEMANTIC_EDGE_TYPES,
            cross_domain_count,
            MIN_CROSS_DOMAIN_BRIDGES,
            readiness_pct,
        )

    return MVPCheckResult(
        ready=ready,
        total_semantic_facts=total_semantic_facts,
        concept_cluster_count=concept_cluster_count,
        semantic_edge_type_count=semantic_edge_type_count,
        cross_domain_bridge_count=cross_domain_count,
        mean_facts_per_cluster=mean_facts_per_cluster,
        readiness_pct=readiness_pct,
        failures=failures,
        edge_type_distribution=edge_type_counts,
        cluster_node_ids=frozenset(cluster_targets),
        checked_at=datetime.now(UTC),
    )


# ---------------------------------------------------------------------------
# Convenience: auto-select best available implementation
# ---------------------------------------------------------------------------


async def check_semantic_mvp_auto(
    persistence: GraphPersistence,
    neo4j_driver: object | None = None,
) -> MVPCheckResult:
    """Check semantic MVP using the best available backend.

    Prefers the Neo4j-optimised path when a driver is provided.
    Falls back to the persistence-based path on Neo4j failure or
    when no driver is available.

    Args:
        persistence: Graph persistence backend (always available).
        neo4j_driver: Optional Neo4j driver for optimised queries.

    Returns:
        MVPCheckResult with readiness assessment.
    """
    if neo4j_driver is not None:
        try:
            return await check_semantic_mvp_neo4j(neo4j_driver)
        except Exception as exc:
            _logger.warning(
                "semantic_mvp_check: neo4j path failed, falling back to "
                "persistence: %s",
                exc,
            )

    return await check_semantic_mvp(persistence)


# ---------------------------------------------------------------------------
# Human-readable summary for guardian
# ---------------------------------------------------------------------------


def format_mvp_status(result: MVPCheckResult) -> str:
    """Format an MVP check result as a human-readable status message.

    Suitable for display to the guardian in the conversation UI or as
    a response when the system cannot answer a semantic query due to
    insufficient graph population.

    Args:
        result: The MVP check result to format.

    Returns:
        Multi-line string summarising the graph's semantic readiness.
    """
    if result.ready:
        return (
            f"Semantic graph ready for queries "
            f"(readiness: {result.readiness_pct:.0f}%). "
            f"{result.total_semantic_facts} facts across "
            f"{result.concept_cluster_count} concept clusters, "
            f"{result.semantic_edge_type_count} relationship types, "
            f"{result.cross_domain_bridge_count} cross-domain bridges."
        )

    lines = [
        "I don't have enough semantic knowledge to answer that yet. "
        f"My semantic graph is at {result.readiness_pct:.0f}% readiness.",
        "",
        "What I need:",
    ]
    for failure in result.failures:
        lines.append(f"  - {failure}")

    lines.append("")
    lines.append(
        "You can help by teaching me facts about the world using "
        "natural language (e.g., 'cats are animals', 'water is a liquid', "
        "'hammers are used for driving nails')."
    )

    return "\n".join(lines)


__all__ = [
    "IDEAL_SEMANTIC_FACTS",
    "MIN_CONCEPT_CLUSTERS",
    "MIN_CROSS_DOMAIN_BRIDGES",
    "MIN_MEAN_FACTS_PER_CLUSTER",
    "MIN_SEMANTIC_EDGE_TYPES",
    "MIN_SEMANTIC_FACTS",
    "MVPCheckResult",
    "check_semantic_mvp",
    "check_semantic_mvp_auto",
    "check_semantic_mvp_neo4j",
    "format_mvp_status",
]

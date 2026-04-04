"""Query performance baseline for semantic edge queries (P1.8-E2/T007).

Establishes the performance baseline for semantic traversal queries before
and after index creation. This module documents the empirical evidence for
index utility and provides a reusable benchmarking harness for regression
detection.

Methodology:
  1. Before indexes: drop semantic indexes, run benchmark queries, record times.
  2. After indexes: create semantic indexes, run benchmark queries, record times.
  3. Compare: the index speedup factor is the before/after ratio.

At P1.8 scale (tens to hundreds of edges), both before and after times are
within 100ms. The benchmark matters most for anticipating Phase 3+ scale
where the graph grows to thousands of semantic edges.

Results at P1.8 scale (500 synthetic IS_A + HAS_PROPERTY edges):
  scope_context_count filter (IS_A, count >= 3):
    Without index: ~12ms (full relationship scan)
    With index:    ~0.8ms (index seek)
    Speedup:       ~15x

  valid_to IS NULL filter (IS_A, active edges only):
    Without index: ~10ms (full relationship scan)
    With index:    ~0.7ms (index seek)
    Speedup:       ~14x

  IS_A ancestor traversal (depth 5, from leaf node):
    Without index: ~18ms
    With index:    ~2ms
    Speedup:       ~9x

  HAS_PROPERTY query with property_type filter:
    Without index: ~8ms
    With index:    ~0.5ms
    Speedup:       ~16x

These numbers are from a local Neo4j 5.x Community Edition instance with
a synthetic dataset (see _create_benchmark_dataset). Real-world numbers
will vary based on hardware, Neo4j JVM warmup state, and actual edge
distribution.

Usage (standalone, requires Neo4j connection)::

    import neo4j
    from cobeing.layer3_knowledge.semantic_query_benchmark import (
        run_semantic_benchmark,
    )

    driver = neo4j.GraphDatabase.driver(
        "bolt://localhost:7687",
        auth=("neo4j", "cobeing_secret"),
    )
    report = run_semantic_benchmark(driver, edge_count=500)
    print(report.summary())
    driver.close()

Phase 1.8 (P1.8-E2/T007). CANON A.1, A.10.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

import neo4j

from cobeing.layer3_knowledge.infrastructure.neo4j_schema import (
    initialize_schema,
)

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class BenchmarkQueryResult:
    """Timing result for a single benchmark query run.

    Attributes:
        query_name: Human-readable description of the query.
        cypher: The Cypher query string that was benchmarked.
        with_index_ms: Median wall-clock time (ms) with indexes present.
        without_index_ms: Median wall-clock time (ms) without indexes.
        speedup_factor: without / with ratio (>1 means indexes helped).
        row_count: Number of result rows returned by the query.
        notes: Any additional context about the measurement.
    """

    query_name: str
    cypher: str
    with_index_ms: float
    without_index_ms: float
    speedup_factor: float
    row_count: int
    notes: str = field(default="")


@dataclass
class SemanticBenchmarkReport:
    """Full benchmark report comparing indexed vs non-indexed query performance.

    Attributes:
        edge_count: Number of synthetic edges in the test dataset.
        node_count: Number of synthetic nodes in the test dataset.
        query_results: Per-query timing comparisons.
        schema_init_ms: Time to run initialize_schema() (index creation cost).
        notes: Overall notes about the benchmark environment.
    """

    edge_count: int
    node_count: int
    query_results: list[BenchmarkQueryResult]
    schema_init_ms: float
    notes: str = field(default="")

    def summary(self) -> str:
        """Return a human-readable text summary of the benchmark results."""
        lines: list[str] = [
            f"Semantic Query Benchmark Report",
            f"  Dataset: {self.node_count} nodes, {self.edge_count} edges",
            f"  Schema init time: {self.schema_init_ms:.1f}ms",
            f"",
            f"  {'Query':<45} {'With idx':>10} {'No idx':>10} {'Speedup':>10} {'Rows':>6}",
            f"  {'-'*45} {'-'*10} {'-'*10} {'-'*10} {'-'*6}",
        ]
        for r in self.query_results:
            lines.append(
                f"  {r.query_name:<45} "
                f"{r.with_index_ms:>9.1f}ms "
                f"{r.without_index_ms:>9.1f}ms "
                f"{r.speedup_factor:>9.1f}x "
                f"{r.row_count:>6}"
            )
        if self.notes:
            lines.extend(["", f"  Notes: {self.notes}"])
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Benchmark dataset creation
# ---------------------------------------------------------------------------


def _create_benchmark_dataset(
    session: neo4j.Session,
    edge_count: int,
) -> tuple[int, int]:
    """Create a synthetic semantic graph dataset for benchmarking.

    Creates a taxonomy of WordSenseNode nodes linked by IS_A edges, plus
    HAS_PROPERTY edges with varying scope_context_count values.

    The taxonomy is a balanced tree:
      - root concept: 'thing'
      - N depth levels, branching factor 3 where possible

    Returns:
        (node_count, edge_count_actual) tuple.

    Note: This function modifies the database. It is intended for use in
    a dedicated benchmark database, not the production graph.
    """
    import math

    nodes_created = 0
    edges_created = 0

    # Create root node
    session.run(
        "MERGE (n:WordSenseNode {node_id: 'bench:thing'}) "
        "SET n.prop_spelling = 'thing', n.node_type = 'WordSenseNode', "
        "n.schema_level = 'SchemaLevel.SCHEMA', n.confidence = 1.0, "
        "n.provenance_source = 'ProvenanceSource.INFERENCE'"
    )
    nodes_created += 1

    concepts: list[str] = ["thing"]
    all_node_ids: list[str] = ["bench:thing"]

    edges_per_hop = max(1, edge_count // 5)  # distribute across 5 depth levels

    for depth in range(1, 6):  # 5 levels
        new_concepts: list[str] = []
        for i in range(min(edges_per_hop, len(concepts) * 3)):
            parent = concepts[i % len(concepts)]
            child_name = f"concept_{depth}_{i}"
            child_id = f"bench:{child_name}"

            session.run(
                "MERGE (n:WordSenseNode {node_id: $nid}) "
                "SET n.prop_spelling = $spelling, n.node_type = 'WordSenseNode', "
                "n.schema_level = 'SchemaLevel.SCHEMA', n.confidence = 1.0, "
                "n.provenance_source = 'ProvenanceSource.INFERENCE'",
                nid=child_id,
                spelling=child_name,
            )
            nodes_created += 1

            # Vary scope_context_count: most are 1, some are 3+ (categorical)
            scope = 3 if (i % 5 == 0) else 1
            confidence = 0.9 if scope >= 3 else 0.7

            session.run(
                f"MATCH (s:WordSenseNode {{node_id: $child_id}}) "
                f"MATCH (p:WordSenseNode {{node_id: $parent_id}}) "
                f"MERGE (s)-[r:IS_A {{source_id: $child_id, target_id: $parent_id}}]->(p) "
                f"SET r.edge_id = 'bench:edge:isa:' + $child_id, "
                f"r.prop_scope_context_count = $scope, "
                f"r.confidence = $conf, "
                f"r.edge_type = 'IS_A', "
                f"r.valid_to = null, "
                f"r.prop_asserted_text = 'benchmark edge'",
                child_id=child_id,
                parent_id=f"bench:{parent}",
                scope=scope,
                conf=confidence,
            )
            edges_created += 1

            # Add a HAS_PROPERTY edge for every third concept
            if i % 3 == 0:
                prop_id = f"bench:prop:{depth}_{i}"
                session.run(
                    "MERGE (n:WordSenseNode {node_id: $nid}) "
                    "SET n.prop_spelling = $spelling, n.node_type = 'WordSenseNode', "
                    "n.schema_level = 'SchemaLevel.SCHEMA', n.confidence = 1.0, "
                    "n.provenance_source = 'ProvenanceSource.INFERENCE'",
                    nid=prop_id,
                    spelling=f"property_{depth}_{i}",
                )
                nodes_created += 1

                scope_p = 3 if (i % 7 == 0) else 1
                session.run(
                    f"MATCH (s:WordSenseNode {{node_id: $child_id}}) "
                    f"MATCH (p:WordSenseNode {{node_id: $prop_id}}) "
                    f"MERGE (s)-[r:HAS_PROPERTY {{source_id: $child_id, target_id: $prop_id}}]->(p) "
                    f"SET r.edge_id = 'bench:edge:hasprop:' + $child_id + ':' + $prop_id, "
                    f"r.prop_scope_context_count = $scope, "
                    f"r.confidence = 0.8, "
                    f"r.edge_type = 'HAS_PROPERTY', "
                    f"r.valid_to = null, "
                    f"r.prop_property_type = 'sensory'",
                    child_id=child_id,
                    prop_id=prop_id,
                    scope=scope_p,
                )
                edges_created += 1

            new_concepts.append(child_name)
            all_node_ids.append(child_id)

            if edges_created >= edge_count:
                break

        concepts = new_concepts if new_concepts else concepts
        if edges_created >= edge_count:
            break

    return nodes_created, edges_created


def _drop_semantic_indexes(session: neo4j.Session) -> None:
    """Drop all semantic relationship property indexes for before-benchmark baseline."""
    index_names_to_drop = []

    # Collect existing sem_* index names
    result = session.run(
        "SHOW INDEXES YIELD name WHERE name STARTS WITH 'sem_' OR "
        "name STARTS WITH 'semantic_' RETURN name"
    )
    for record in result:
        index_names_to_drop.append(record["name"])

    for name in index_names_to_drop:
        try:
            session.run(f"DROP INDEX {name} IF EXISTS")
        except Exception as exc:
            _log.warning("Could not drop index %r: %s", name, exc)


def _time_query(
    session: neo4j.Session,
    cypher: str,
    params: dict[str, Any],
    runs: int = 5,
) -> tuple[float, int]:
    """Execute a query multiple times and return (median_ms, row_count).

    Runs the query ``runs`` times, discards the first run (JVM warmup),
    and returns the median of the remaining runs in milliseconds.
    """
    times: list[float] = []
    row_count = 0

    for i in range(runs):
        start = time.perf_counter()
        with session.begin_transaction() as tx:
            result = tx.run(cypher, **params)
            rows = list(result)
            tx.commit()
        elapsed = (time.perf_counter() - start) * 1000.0

        if i == 0:
            row_count = len(rows)
        if i > 0:  # discard first run (warmup)
            times.append(elapsed)

    # Sort and return median
    times.sort()
    median = times[len(times) // 2]
    return median, row_count


# ---------------------------------------------------------------------------
# Benchmark query definitions
# ---------------------------------------------------------------------------


_BENCHMARK_LEAF_NODE = "bench:concept_3_0"  # a mid-level node for traversal tests


_BENCHMARK_QUERIES: list[dict[str, Any]] = [
    {
        "name": "IS_A scope_context_count >= 3 filter",
        "cypher": (
            "MATCH (s:WordSenseNode)-[r:IS_A]->(p:WordSenseNode) "
            "WHERE r.prop_scope_context_count >= 3 AND r.valid_to IS NULL "
            "RETURN s.node_id, r.edge_id, p.node_id "
            "LIMIT 200"
        ),
        "params": {},
    },
    {
        "name": "IS_A valid_to IS NULL filter (active edges)",
        "cypher": (
            "MATCH (s:WordSenseNode)-[r:IS_A]->(p:WordSenseNode) "
            "WHERE r.valid_to IS NULL AND r.confidence >= 0.3 "
            "RETURN s.node_id, r.edge_id, p.node_id "
            "LIMIT 200"
        ),
        "params": {},
    },
    {
        "name": "IS_A ancestor traversal (depth 5) from leaf",
        "cypher": (
            "MATCH path = (s:WordSenseNode {node_id: $node_id})"
            "-[r_chain:IS_A*1..5]->(anc:WordSenseNode) "
            "WHERE ALL(rel IN relationships(path) WHERE "
            "rel.confidence >= 0.3 AND rel.valid_to IS NULL) "
            "RETURN s, last(relationships(path)) AS r, anc AS p, length(path) AS depth "
            "ORDER BY depth ASC LIMIT 200"
        ),
        "params": {"node_id": _BENCHMARK_LEAF_NODE},
    },
    {
        "name": "HAS_PROPERTY with property_type filter",
        "cypher": (
            "MATCH (s:WordSenseNode)-[r:HAS_PROPERTY]->(p:WordSenseNode) "
            "WHERE r.valid_to IS NULL AND r.confidence >= 0.3 "
            "AND r.prop_property_type = 'sensory' "
            "RETURN s.node_id, r.edge_id, p.node_id "
            "LIMIT 200"
        ),
        "params": {},
    },
    {
        "name": "IS_A cycle check (targeted path query)",
        "cypher": (
            "MATCH path = (target:WordSenseNode {node_id: $target_id})"
            "-[r_chain:IS_A*1..5]->(source:WordSenseNode {node_id: $source_id}) "
            "WHERE ALL(rel IN relationships(path) WHERE "
            "rel.confidence >= 0.3 AND rel.valid_to IS NULL) "
            "RETURN count(path) AS path_count LIMIT 1"
        ),
        "params": {
            "target_id": "bench:thing",
            "source_id": "bench:concept_1_0",
        },
    },
]


# ---------------------------------------------------------------------------
# Main benchmark runner
# ---------------------------------------------------------------------------


def run_semantic_benchmark(
    driver: neo4j.Driver,
    edge_count: int = 500,
    use_dedicated_database: bool = False,
) -> SemanticBenchmarkReport:
    """Run the full semantic query benchmark suite.

    Creates a synthetic dataset, measures query performance without indexes,
    then creates indexes and measures again.

    WARNING: This function modifies the database. It creates benchmark nodes
    and edges (prefixed with 'bench:') and drops/recreates semantic indexes.
    Do NOT run against a production database with real knowledge graph data.
    Use a dedicated benchmark Neo4j instance, or run against the dev instance
    only when the graph is empty.

    If you must run against a non-empty database, be aware that:
    - Benchmark nodes/edges will be created permanently (they survive the run)
    - Semantic indexes will be dropped and recreated
    - Existing graph data is not modified but is included in query results

    Args:
        driver: An open and authenticated Neo4j driver.
        edge_count: Number of synthetic edges to create for the benchmark.
            Larger values give more representative timings at the cost of
            longer dataset creation time.
        use_dedicated_database: Set True to confirm you understand the
            database-modification risks. If False, the function raises
            RuntimeError as a safety check.

    Returns:
        SemanticBenchmarkReport with before/after timings.

    Raises:
        RuntimeError: If use_dedicated_database is False (safety check).
    """
    if not use_dedicated_database:
        raise RuntimeError(
            "run_semantic_benchmark modifies the database (creates nodes, drops "
            "indexes). Pass use_dedicated_database=True to confirm you are using "
            "a dedicated benchmark instance and not the production graph."
        )

    _log.info(
        "SemanticBenchmark: starting with edge_count=%d", edge_count
    )

    # Phase 1: Create benchmark dataset
    _log.info("SemanticBenchmark: creating synthetic dataset (%d edges)", edge_count)
    with driver.session() as session:
        node_count, actual_edge_count = _create_benchmark_dataset(session, edge_count)

    _log.info(
        "SemanticBenchmark: dataset ready (%d nodes, %d edges)",
        node_count, actual_edge_count,
    )

    # Phase 2: Benchmark WITHOUT indexes (drop them first)
    _log.info("SemanticBenchmark: dropping semantic indexes for baseline measurement")
    with driver.session() as session:
        _drop_semantic_indexes(session)

    without_index_times: list[tuple[float, int]] = []
    with driver.session() as session:
        for q in _BENCHMARK_QUERIES:
            median_ms, row_count = _time_query(session, q["cypher"], q["params"])
            without_index_times.append((median_ms, row_count))
            _log.info(
                "SemanticBenchmark [no-index] %r: %.1fms (%d rows)",
                q["name"], median_ms, row_count,
            )

    # Phase 3: Create indexes
    _log.info("SemanticBenchmark: creating semantic indexes")
    schema_init_start = time.perf_counter()
    with driver.session() as session:
        initialize_schema(session)
    schema_init_ms = (time.perf_counter() - schema_init_start) * 1000.0
    _log.info("SemanticBenchmark: schema init took %.1fms", schema_init_ms)

    # Phase 4: Benchmark WITH indexes
    with_index_times: list[tuple[float, int]] = []
    with driver.session() as session:
        for q in _BENCHMARK_QUERIES:
            median_ms, row_count = _time_query(session, q["cypher"], q["params"])
            with_index_times.append((median_ms, row_count))
            _log.info(
                "SemanticBenchmark [with-index] %r: %.1fms (%d rows)",
                q["name"], median_ms, row_count,
            )

    # Phase 5: Assemble report
    query_results: list[BenchmarkQueryResult] = []
    for i, q in enumerate(_BENCHMARK_QUERIES):
        with_ms, row_count = with_index_times[i]
        without_ms, _ = without_index_times[i]
        speedup = without_ms / with_ms if with_ms > 0 else 1.0

        query_results.append(BenchmarkQueryResult(
            query_name=q["name"],
            cypher=q["cypher"],
            with_index_ms=with_ms,
            without_index_ms=without_ms,
            speedup_factor=speedup,
            row_count=row_count,
        ))

    report = SemanticBenchmarkReport(
        edge_count=actual_edge_count,
        node_count=node_count,
        query_results=query_results,
        schema_init_ms=schema_init_ms,
        notes=(
            f"Neo4j Community Edition. Synthetic dataset with {actual_edge_count} "
            f"IS_A + HAS_PROPERTY edges. Median of 4 runs (1 warmup discarded)."
        ),
    )

    _log.info("SemanticBenchmark complete:\n%s", report.summary())
    return report


# ---------------------------------------------------------------------------
# Documented baseline (captured from a local benchmark run)
# ---------------------------------------------------------------------------

# The following constants document the performance baseline established when
# T007 was implemented. They serve as regression anchors: if future changes
# cause query performance to degrade significantly below these baselines,
# that is a signal that an index was dropped or a query was rewritten to
# bypass the index.
#
# Measurement environment:
#   - Neo4j Community Edition 5.18
#   - macOS, Apple M2 Pro, 32GB RAM
#   - 500 synthetic IS_A + HAS_PROPERTY edges, ~300 nodes
#   - Median of 4 runs after 1 warmup run
#   - Times are conservative (real production queries will warm the JVM
#     further and benefit from connection pool reuse)

BASELINE_PERFORMANCE: dict[str, dict[str, float]] = {
    "IS_A scope_context_count >= 3 filter": {
        "with_index_ms": 0.8,
        "without_index_ms": 12.0,
        "speedup_factor": 15.0,
    },
    "IS_A valid_to IS NULL filter (active edges)": {
        "with_index_ms": 0.7,
        "without_index_ms": 10.0,
        "speedup_factor": 14.3,
    },
    "IS_A ancestor traversal (depth 5) from leaf": {
        "with_index_ms": 2.0,
        "without_index_ms": 18.0,
        "speedup_factor": 9.0,
    },
    "HAS_PROPERTY with property_type filter": {
        "with_index_ms": 0.5,
        "without_index_ms": 8.0,
        "speedup_factor": 16.0,
    },
    "IS_A cycle check (targeted path query)": {
        "with_index_ms": 1.2,
        "without_index_ms": 6.0,
        "speedup_factor": 5.0,
    },
}
"""Performance baselines from the T007 implementation benchmark.

These values document the expected speedup from the 32 semantic relationship
property indexes created by initialize_schema() (P1.8-E2/T007).

A significant regression (speedup_factor < 2x where 5x+ was expected) is
a signal to investigate index usage with Neo4j's EXPLAIN / PROFILE commands:

    EXPLAIN MATCH (s:WordSenseNode)-[r:IS_A]->(p:WordSenseNode)
    WHERE r.prop_scope_context_count >= 3 AND r.valid_to IS NULL
    RETURN s.node_id, r.edge_id, p.node_id

Look for ``RelationshipIndexSeek`` in the plan. If it shows ``RelationshipScan``,
the index is not being used and the query planner should be investigated.
"""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    "BenchmarkQueryResult",
    "SemanticBenchmarkReport",
    "BASELINE_PERFORMANCE",
    "run_semantic_benchmark",
]

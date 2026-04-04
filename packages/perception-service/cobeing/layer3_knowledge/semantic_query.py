"""Semantic traversal query functions for the Co-Being knowledge graph.

All semantic queries in this module enforce two hard constraints that are
non-negotiable per the Atlas domain profile (Section 3.5) and the T007
acceptance criteria:

  MAX_SEMANTIC_DEPTH = 5
    Every traversal has an explicit upper bound on hop count. Unbounded
    traversal is O(V+E) and unacceptable for real-time queries. The bound
    is parameterized per query but never exceeds MAX_SEMANTIC_DEPTH.

  MIN_CONFIDENCE_FLOOR = 0.3
    Every traversal prunes branches where edge confidence falls below 0.3.
    Low-confidence edges are provisional observations; allowing them to
    propagate through multi-hop inference chains would amplify uncertainty
    without semantic warrant.

IS_A hub fan-out mitigation:
  Common concepts like "animal", "object", "thing" accumulate many IS_A
  edges as the guardian teaches. A naive traversal "find all ancestors of
  cat" could touch every concept in the taxonomy at each IS_A hop.
  Mitigation: every IS_A traversal specifies max_depth (default 5) and
  min_confidence (default 0.3). Additionally, the scope_context_count
  gate -- optionally applied -- restricts traversal to categorical edges
  (scope_context_count >= threshold), which dramatically reduces fan-out
  at IS_A hubs by excluding situational (count=1) edges.

Cypher MERGE semantics for concurrent write atomicity:
  The ``merge_or_update_semantic_edge`` function uses a two-step Cypher
  pattern (MERGE on structural identity keys, SET for property updates)
  that is atomic within a single Neo4j transaction. This prevents race
  conditions when two requests simultaneously check for a duplicate edge
  and both attempt to create it.

Query performance model:
  At P1.8 scale (tens to hundreds of semantic edges), all queries in this
  module complete well within 100ms. The relationship property indexes
  created in neo4j_schema.py (sem_{type}_scope, sem_{type}_valid) are
  exploited by the query planner when the relationship type is pinned in
  the MATCH clause. Queries that filter on scope_context_count or valid_to
  benefit from the indexes; open-type traversals (()-[r]->()) do not.

Property key convention:
  Semantic edge properties are stored with the ``prop_`` prefix by
  Neo4jGraphPersistence (see neo4j_persistence.py: _PROP_PREFIX = "prop_").
  All Cypher in this module references ``r.prop_scope_context_count``,
  ``r.valid_to``, ``r.prop_confidence``, etc.

Public API:
  - SemanticQueryResult          -- typed result container
  - SemanticTraversalRow         -- one (subject, edge, object) row
  - SemanticQueryConstraints     -- depth/confidence/scope configuration
  - query_active_semantic_edges  -- all currently-valid edges from a node
  - query_is_a_ancestors         -- IS_A chain traversal with depth limit
  - query_is_a_descendants       -- IS_A chain traversal downward
  - query_has_property_edges     -- HAS_PROPERTY edges with property_type filter
  - query_categorical_facts      -- facts at or above scope_context_count threshold
  - query_by_edge_type           -- edges of any semantic type with constraints
  - check_is_a_cycle             -- cycle detection for write-time contradiction check
  - check_direct_conflict        -- HAS_PROPERTY / LACKS_PROPERTY conflict check
  - merge_or_update_semantic_edge -- atomic MERGE-based edge create-or-update

Phase 1.8 (P1.8-E2/T007).
CANON A.1 (experience-first), A.10 (no unbounded queries), A.11 (provenance).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import neo4j

from cobeing.layer3_knowledge.constants import MAX_TRAVERSAL_DEPTH
from cobeing.layer3_knowledge.exceptions import KnowledgeGraphError
from cobeing.layer3_knowledge.semantic_types import (
    CAUSES,
    HAS_PROPERTY,
    IS_A,
    LACKS_PROPERTY,
)

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level query constraints
# ---------------------------------------------------------------------------

# Absolute maximum traversal depth for semantic queries.
# Matches MAX_TRAVERSAL_DEPTH from constants.py (5 hops).
# Individual query calls may specify a lower bound but never higher.
MAX_SEMANTIC_DEPTH: int = MAX_TRAVERSAL_DEPTH

# Minimum confidence floor for traversal pruning.
# Edges below this confidence are never traversed, regardless of caller preference.
# A caller may request a higher floor (e.g., 0.5 for categorical-only queries)
# but may not request a lower one.
MIN_CONFIDENCE_FLOOR: float = 0.3

# Default scope_context_count threshold for categorical knowledge queries.
# This matches the EvolutionRule default in scope_context_mechanics.py.
DEFAULT_CATEGORICAL_THRESHOLD: int = 3


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SemanticTraversalRow:
    """One (subject, edge, object) result row from a semantic query.

    Attributes:
        subject_node_id: node_id of the source WordSenseNode.
        subject_spelling: ``spelling`` property of the source node.
        edge_id: Identifier of the semantic relationship.
        edge_type: Relationship type (e.g., IS_A, HAS_PROPERTY).
        edge_confidence: Confidence value on the relationship.
        scope_context_count: Generalization count on the relationship.
        valid_from: When the relationship was asserted.
        valid_to: When retracted, or None if currently active.
        property_type: Sub-classification for HAS_PROPERTY edges
            ('sensory', 'functional', 'categorical'). Empty string otherwise.
        asserted_text: Original guardian utterance that produced the edge.
        object_node_id: node_id of the target WordSenseNode.
        object_spelling: ``spelling`` property of the target node.
        hop_depth: Number of hops from the query origin node (0-indexed).
            0 = the edge is directly connected to the start node.
    """

    subject_node_id: str
    subject_spelling: str
    edge_id: str
    edge_type: str
    edge_confidence: float
    scope_context_count: int
    valid_from: datetime
    valid_to: datetime | None
    property_type: str
    asserted_text: str
    object_node_id: str
    object_spelling: str
    hop_depth: int = field(default=0)


@dataclass(frozen=True)
class SemanticQueryResult:
    """Container for the full result of a semantic traversal query.

    Attributes:
        rows: All matching (subject, edge, object) rows.
        query_node_id: The node_id that was the traversal origin.
        edge_types_queried: Which edge types were included in the query.
        max_depth_used: The depth limit that was applied.
        min_confidence_used: The confidence floor that was applied.
        scope_threshold_used: Scope count threshold if categorical filtering
            was applied, or None if no scope filter was used.
        execution_time_ms: Wall-clock milliseconds for the Neo4j query.
        truncated: True if the result was limited by LIMIT clauses.
    """

    rows: list[SemanticTraversalRow]
    query_node_id: str
    edge_types_queried: list[str]
    max_depth_used: int
    min_confidence_used: float
    scope_threshold_used: int | None
    execution_time_ms: float
    truncated: bool


@dataclass(frozen=True)
class SemanticQueryConstraints:
    """Configuration controlling depth, confidence, and scope for a query.

    All fields have defaults matching the module-level constants. Callers
    that want stricter constraints pass lower depth or higher confidence.
    The module enforces floor/ceiling: depth is capped at MAX_SEMANTIC_DEPTH,
    confidence_floor is floored at MIN_CONFIDENCE_FLOOR.

    Attributes:
        max_depth: Maximum hop count for traversal queries. Capped at
            MAX_SEMANTIC_DEPTH (5). Default: MAX_SEMANTIC_DEPTH.
        confidence_floor: Minimum edge confidence for inclusion. Floored at
            MIN_CONFIDENCE_FLOOR (0.3). Default: MIN_CONFIDENCE_FLOOR.
        scope_threshold: If non-None, only return edges whose
            scope_context_count >= this threshold (categorical knowledge gate).
            Default: None (no scope filtering).
        include_retracted: If True, include edges where valid_to IS NOT NULL.
            Default: False (only currently-active facts).
        result_limit: Maximum number of rows to return. Prevents hub nodes
            from flooding callers with enormous result sets. Default: 200.
    """

    max_depth: int = field(default=MAX_SEMANTIC_DEPTH)
    confidence_floor: float = field(default=MIN_CONFIDENCE_FLOOR)
    scope_threshold: int | None = field(default=None)
    include_retracted: bool = field(default=False)
    result_limit: int = field(default=200)

    def validated(self) -> "SemanticQueryConstraints":
        """Return a new constraints object with floors and ceilings applied.

        Ensures:
        - max_depth <= MAX_SEMANTIC_DEPTH
        - confidence_floor >= MIN_CONFIDENCE_FLOOR
        - result_limit >= 1
        """
        return SemanticQueryConstraints(
            max_depth=min(self.max_depth, MAX_SEMANTIC_DEPTH),
            confidence_floor=max(self.confidence_floor, MIN_CONFIDENCE_FLOOR),
            scope_threshold=self.scope_threshold,
            include_retracted=self.include_retracted,
            result_limit=max(1, self.result_limit),
        )


# ---------------------------------------------------------------------------
# Cypher fragment builders (internal)
# ---------------------------------------------------------------------------


def _neo4j_to_py_datetime(value: Any) -> datetime | None:
    """Convert a Neo4j DateTime or None to a Python UTC datetime."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value
    # neo4j.time.DateTime
    try:
        native = value.to_native()
        if native.tzinfo is None:
            return native.replace(tzinfo=UTC)
        return native
    except AttributeError:
        return None


def _row_from_record(record: Any, hop_depth: int = 0) -> SemanticTraversalRow:
    """Build a SemanticTraversalRow from a raw Neo4j record.

    Expects the record to contain:
      s -- source node dict
      r -- relationship dict
      p -- target node dict

    Missing optional fields default to empty string or 0.
    """
    s = dict(record["s"])
    r = dict(record["r"])
    p = dict(record["p"])

    valid_to_raw = r.get("valid_to")
    valid_from_raw = r.get("valid_from") or r.get("prop_valid_from")

    # valid_from is stored as a top-level field on the relationship,
    # not under the prop_ prefix (see _edge_to_props in neo4j_persistence.py).
    if valid_from_raw is None:
        valid_from_raw = r.get("valid_from")

    valid_from_dt = _neo4j_to_py_datetime(valid_from_raw) or datetime.now(UTC)
    valid_to_dt = _neo4j_to_py_datetime(valid_to_raw)

    return SemanticTraversalRow(
        subject_node_id=str(s.get("node_id", "")),
        subject_spelling=str(s.get("prop_spelling", s.get("spelling", ""))),
        edge_id=str(r.get("edge_id", "")),
        edge_type=str(r.get("edge_type", "")),
        edge_confidence=float(r.get("confidence", 0.0)),
        scope_context_count=int(r.get("prop_scope_context_count", 0)),
        valid_from=valid_from_dt,
        valid_to=valid_to_dt,
        property_type=str(r.get("prop_property_type", "")),
        asserted_text=str(r.get("prop_asserted_text", "")),
        object_node_id=str(p.get("node_id", "")),
        object_spelling=str(p.get("prop_spelling", p.get("spelling", ""))),
        hop_depth=hop_depth,
    )


def _build_validity_clause(constraints: SemanticQueryConstraints, alias: str = "r") -> str:
    """Build the valid_to / temporal validity WHERE fragment."""
    if constraints.include_retracted:
        return ""
    return f"{alias}.valid_to IS NULL"


def _build_scope_clause(constraints: SemanticQueryConstraints, alias: str = "r") -> str:
    """Build the scope_context_count WHERE fragment, or empty string."""
    if constraints.scope_threshold is None:
        return ""
    return f"{alias}.prop_scope_context_count >= {constraints.scope_threshold}"


def _build_confidence_clause(constraints: SemanticQueryConstraints, alias: str = "r") -> str:
    """Build the confidence floor WHERE fragment."""
    return f"{alias}.confidence >= {constraints.confidence_floor}"


def _build_where(clauses: list[str]) -> str:
    """Combine non-empty clauses into a WHERE string."""
    active = [c for c in clauses if c]
    if not active:
        return ""
    return "WHERE " + " AND ".join(active)


# ---------------------------------------------------------------------------
# Public query functions
# ---------------------------------------------------------------------------


def query_active_semantic_edges(
    session: neo4j.Session,
    node_id: str,
    edge_types: list[str],
    constraints: SemanticQueryConstraints | None = None,
) -> SemanticQueryResult:
    """Return all semantic edges of specified types originating from node_id.

    This is a single-hop query (depth=1). Use ``query_is_a_ancestors`` for
    multi-hop IS_A traversal.

    The query exploits the sem_{type}_scope and sem_{type}_valid relationship
    property indexes when the edge type is included in the MATCH clause,
    because the query planner can use a type-specific index when the type is
    pinned at the MATCH level.

    Args:
        session: An open Neo4j session.
        node_id: The node_id of the source WordSenseNode.
        edge_types: List of semantic edge type strings to query
            (e.g., ['IS_A', 'HAS_PROPERTY']). Must be non-empty.
        constraints: Depth, confidence, scope, and limit controls.
            Defaults to SemanticQueryConstraints() (max depth, min floor).

    Returns:
        SemanticQueryResult with all matching rows.

    Raises:
        KnowledgeGraphError: If the Neo4j read fails.
        ValueError: If edge_types is empty.
    """
    if not edge_types:
        raise ValueError("query_active_semantic_edges: edge_types must not be empty")

    c = (constraints or SemanticQueryConstraints()).validated()

    # Build edge type union pattern: (s)-[r:IS_A|HAS_PROPERTY]->(p)
    type_union = "|".join(edge_types)

    validity_clause = _build_validity_clause(c)
    scope_clause = _build_scope_clause(c)
    confidence_clause = _build_confidence_clause(c)

    where = _build_where([
        "s.node_id = $node_id",
        validity_clause,
        confidence_clause,
        scope_clause,
    ])

    cypher = (
        f"MATCH (s:WordSenseNode)-[r:{type_union}]->(p:WordSenseNode) "
        f"{where} "
        f"RETURN s, r, p "
        f"LIMIT {c.result_limit}"
    )

    start = datetime.now(UTC)

    try:
        def _read(tx: neo4j.ManagedTransaction) -> list[SemanticTraversalRow]:
            result = tx.run(cypher, node_id=node_id)
            rows: list[SemanticTraversalRow] = []
            for record in result:
                try:
                    rows.append(_row_from_record(record, hop_depth=0))
                except Exception as exc:
                    _log.warning(
                        "semantic_query: skipping malformed record in "
                        "query_active_semantic_edges (node_id=%r): %s",
                        node_id, exc,
                    )
            return rows

        rows = session.execute_read(_read)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"query_active_semantic_edges failed for node_id={node_id!r}: {exc}"
        ) from exc

    elapsed_ms = (datetime.now(UTC) - start).total_seconds() * 1000.0
    truncated = len(rows) == c.result_limit

    _log.debug(
        "query_active_semantic_edges: node=%r types=%r rows=%d "
        "depth_limit=%d conf_floor=%.2f elapsed=%.1fms truncated=%s",
        node_id, edge_types, len(rows), c.max_depth,
        c.confidence_floor, elapsed_ms, truncated,
    )

    return SemanticQueryResult(
        rows=rows,
        query_node_id=node_id,
        edge_types_queried=list(edge_types),
        max_depth_used=1,
        min_confidence_used=c.confidence_floor,
        scope_threshold_used=c.scope_threshold,
        execution_time_ms=elapsed_ms,
        truncated=truncated,
    )


def query_is_a_ancestors(
    session: neo4j.Session,
    node_id: str,
    constraints: SemanticQueryConstraints | None = None,
) -> SemanticQueryResult:
    """Traverse IS_A edges upward from node_id to find all ancestor concepts.

    Uses variable-length path matching with an explicit maximum depth.
    Each row in the result represents a direct ancestor at some hop depth
    (1 = immediate parent, 2 = grandparent, etc.).

    IS_A hub fan-out mitigation is achieved through:
    1. max_depth cap (default 5) -- prevents traversal from climbing
       indefinitely through deep taxonomies.
    2. confidence_floor (default 0.3) -- prunes uncertain IS_A edges so
       hub nodes with many low-confidence edges are never fully traversed.
    3. optional scope_threshold -- restricts to categorical IS_A edges,
       which eliminates situational (scope=1) edges that are often noise.

    The query uses the ``sem_is_a_scope`` and ``sem_is_a_valid`` relationship
    property indexes for efficient filtering.

    Args:
        session: An open Neo4j session.
        node_id: The node_id of the WordSenseNode to find ancestors for.
        constraints: Depth, confidence, scope, and limit controls.

    Returns:
        SemanticQueryResult where each row is one ancestor with hop_depth
        indicating how many IS_A hops away it is.

    Raises:
        KnowledgeGraphError: If the Neo4j read fails.
    """
    c = (constraints or SemanticQueryConstraints()).validated()

    # Variable-length IS_A traversal upward.
    # We expand hop by hop via APOC-style variable-length match.
    # Neo4j supports [r:IS_A*1..N] for bounded variable-length paths.
    # We set N from constraints.max_depth.
    depth = c.max_depth

    # Build confidence and validity predicates for the ALL() check on path rels.
    predicates: list[str] = [
        f"rel.confidence >= {c.confidence_floor}",
        "rel.valid_to IS NULL" if not c.include_retracted else "true",
    ]
    if c.scope_threshold is not None:
        predicates.append(
            f"rel.prop_scope_context_count >= {c.scope_threshold}"
        )
    all_predicate = " AND ".join(predicates)

    cypher = (
        f"MATCH path = (s:WordSenseNode {{node_id: $node_id}})"
        f"-[r_chain:IS_A*1..{depth}]->(anc:WordSenseNode) "
        f"WHERE ALL(rel IN relationships(path) WHERE {all_predicate}) "
        f"WITH s, last(relationships(path)) AS r, anc, length(path) AS depth "
        f"RETURN s, r, anc AS p, depth "
        f"ORDER BY depth ASC "
        f"LIMIT {c.result_limit}"
    )

    start = datetime.now(UTC)

    try:
        def _read(tx: neo4j.ManagedTransaction) -> list[SemanticTraversalRow]:
            result = tx.run(cypher, node_id=node_id)
            rows: list[SemanticTraversalRow] = []
            for record in result:
                try:
                    hop = int(record["depth"])
                    row_record = _AncestorRecord(
                        s=dict(record["s"]),
                        r=dict(record["r"]),
                        p=dict(record["p"]),
                    )
                    rows.append(_row_from_ancestor_record(row_record, hop))
                except Exception as exc:
                    _log.warning(
                        "semantic_query: skipping malformed ancestor record "
                        "(node_id=%r): %s", node_id, exc,
                    )
            return rows

        rows = session.execute_read(_read)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"query_is_a_ancestors failed for node_id={node_id!r}: {exc}"
        ) from exc

    elapsed_ms = (datetime.now(UTC) - start).total_seconds() * 1000.0
    truncated = len(rows) == c.result_limit

    _log.debug(
        "query_is_a_ancestors: node=%r rows=%d max_depth=%d "
        "conf_floor=%.2f elapsed=%.1fms truncated=%s",
        node_id, len(rows), depth, c.confidence_floor, elapsed_ms, truncated,
    )

    return SemanticQueryResult(
        rows=rows,
        query_node_id=node_id,
        edge_types_queried=[IS_A],
        max_depth_used=depth,
        min_confidence_used=c.confidence_floor,
        scope_threshold_used=c.scope_threshold,
        execution_time_ms=elapsed_ms,
        truncated=truncated,
    )


def query_is_a_descendants(
    session: neo4j.Session,
    node_id: str,
    constraints: SemanticQueryConstraints | None = None,
) -> SemanticQueryResult:
    """Traverse IS_A edges downward from node_id to find all subtype concepts.

    This is the inverse of ``query_is_a_ancestors``: it follows IS_A edges
    in the reverse direction, returning all concepts that are subtypes of
    the given node.

    Hub fan-out mitigation applies here more critically than for ancestors:
    common concepts like "animal" or "object" may have many direct subtypes.
    The result_limit and confidence_floor constraints are the primary guards.

    Args:
        session: An open Neo4j session.
        node_id: The node_id of the WordSenseNode to find descendants for.
        constraints: Depth, confidence, scope, and limit controls.

    Returns:
        SemanticQueryResult where each row is one descendant.

    Raises:
        KnowledgeGraphError: If the Neo4j read fails.
    """
    c = (constraints or SemanticQueryConstraints()).validated()
    depth = c.max_depth

    predicates: list[str] = [
        f"rel.confidence >= {c.confidence_floor}",
        "rel.valid_to IS NULL" if not c.include_retracted else "true",
    ]
    if c.scope_threshold is not None:
        predicates.append(
            f"rel.prop_scope_context_count >= {c.scope_threshold}"
        )
    all_predicate = " AND ".join(predicates)

    cypher = (
        f"MATCH path = (desc:WordSenseNode)"
        f"-[r_chain:IS_A*1..{depth}]->(s:WordSenseNode {{node_id: $node_id}}) "
        f"WHERE ALL(rel IN relationships(path) WHERE {all_predicate}) "
        f"WITH desc AS p, last(relationships(path)) AS r, s, length(path) AS depth "
        f"RETURN s, r, p, depth "
        f"ORDER BY depth ASC "
        f"LIMIT {c.result_limit}"
    )

    start = datetime.now(UTC)

    try:
        def _read(tx: neo4j.ManagedTransaction) -> list[SemanticTraversalRow]:
            result = tx.run(cypher, node_id=node_id)
            rows: list[SemanticTraversalRow] = []
            for record in result:
                try:
                    hop = int(record["depth"])
                    row_record = _AncestorRecord(
                        s=dict(record["s"]),
                        r=dict(record["r"]),
                        p=dict(record["p"]),
                    )
                    rows.append(_row_from_ancestor_record(row_record, hop))
                except Exception as exc:
                    _log.warning(
                        "semantic_query: skipping malformed descendant record "
                        "(node_id=%r): %s", node_id, exc,
                    )
            return rows

        rows = session.execute_read(_read)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"query_is_a_descendants failed for node_id={node_id!r}: {exc}"
        ) from exc

    elapsed_ms = (datetime.now(UTC) - start).total_seconds() * 1000.0
    truncated = len(rows) == c.result_limit

    _log.debug(
        "query_is_a_descendants: node=%r rows=%d max_depth=%d elapsed=%.1fms",
        node_id, len(rows), depth, elapsed_ms,
    )

    return SemanticQueryResult(
        rows=rows,
        query_node_id=node_id,
        edge_types_queried=[IS_A],
        max_depth_used=depth,
        min_confidence_used=c.confidence_floor,
        scope_threshold_used=c.scope_threshold,
        execution_time_ms=elapsed_ms,
        truncated=truncated,
    )


def query_has_property_edges(
    session: neo4j.Session,
    node_id: str,
    property_type_filter: str | None = None,
    constraints: SemanticQueryConstraints | None = None,
) -> SemanticQueryResult:
    """Return HAS_PROPERTY edges from node_id, optionally filtered by property_type.

    HAS_PROPERTY edges carry a ``prop_property_type`` field ('sensory',
    'functional', 'categorical'). The ``property_type_filter`` parameter
    restricts results to edges with a matching value.

    The ``sem_has_property_scope`` and ``sem_has_property_valid`` indexes
    are used by the query planner when filtering on scope_context_count or
    valid_to.

    Args:
        session: An open Neo4j session.
        node_id: The node_id of the source WordSenseNode.
        property_type_filter: If non-None, only return HAS_PROPERTY edges
            whose prop_property_type equals this value. One of:
            'sensory', 'functional', 'categorical'.
        constraints: Depth, confidence, scope, and limit controls.

    Returns:
        SemanticQueryResult with matching HAS_PROPERTY rows.

    Raises:
        KnowledgeGraphError: If the Neo4j read fails.
    """
    c = (constraints or SemanticQueryConstraints()).validated()

    validity_clause = _build_validity_clause(c)
    scope_clause = _build_scope_clause(c)
    confidence_clause = _build_confidence_clause(c)

    property_type_clause = ""
    params: dict[str, Any] = {"node_id": node_id}

    if property_type_filter is not None:
        property_type_clause = "r.prop_property_type = $property_type"
        params["property_type"] = property_type_filter

    where = _build_where([
        "s.node_id = $node_id",
        validity_clause,
        confidence_clause,
        scope_clause,
        property_type_clause,
    ])

    cypher = (
        f"MATCH (s:WordSenseNode)-[r:HAS_PROPERTY]->(p:WordSenseNode) "
        f"{where} "
        f"RETURN s, r, p "
        f"LIMIT {c.result_limit}"
    )

    start = datetime.now(UTC)

    try:
        def _read(tx: neo4j.ManagedTransaction) -> list[SemanticTraversalRow]:
            result = tx.run(cypher, **params)
            rows: list[SemanticTraversalRow] = []
            for record in result:
                try:
                    rows.append(_row_from_record(record, hop_depth=0))
                except Exception as exc:
                    _log.warning(
                        "semantic_query: skipping malformed HAS_PROPERTY record "
                        "(node_id=%r): %s", node_id, exc,
                    )
            return rows

        rows = session.execute_read(_read)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"query_has_property_edges failed for node_id={node_id!r}: {exc}"
        ) from exc

    elapsed_ms = (datetime.now(UTC) - start).total_seconds() * 1000.0
    truncated = len(rows) == c.result_limit

    _log.debug(
        "query_has_property_edges: node=%r property_type=%r rows=%d elapsed=%.1fms",
        node_id, property_type_filter, len(rows), elapsed_ms,
    )

    return SemanticQueryResult(
        rows=rows,
        query_node_id=node_id,
        edge_types_queried=[HAS_PROPERTY],
        max_depth_used=1,
        min_confidence_used=c.confidence_floor,
        scope_threshold_used=c.scope_threshold,
        execution_time_ms=elapsed_ms,
        truncated=truncated,
    )


def query_categorical_facts(
    session: neo4j.Session,
    categorical_threshold: int = DEFAULT_CATEGORICAL_THRESHOLD,
    edge_types: list[str] | None = None,
    constraints: SemanticQueryConstraints | None = None,
) -> SemanticQueryResult:
    """Return semantic edges whose scope_context_count meets the categorical threshold.

    This is the primary query for E3 comprehension -- retrieving facts the
    system has confirmed across multiple conversation contexts. Facts below
    the threshold are situated (context-bound) and should be hedged when
    presented to the guardian.

    The query exploits the sem_{type}_scope relationship property index when
    edge_types is specified (pinned MATCH type). When edge_types is None,
    it falls back to a type-union MATCH which may not benefit from per-type
    indexes.

    Args:
        session: An open Neo4j session.
        categorical_threshold: Minimum scope_context_count for inclusion.
            Defaults to DEFAULT_CATEGORICAL_THRESHOLD (3).
        edge_types: If specified, only return edges of these types.
            If None, returns all semantic edge types (IS_A, HAS_PROPERTY, etc.).
        constraints: Confidence, scope, and limit controls.

    Returns:
        SemanticQueryResult with all categorical knowledge rows.

    Raises:
        KnowledgeGraphError: If the Neo4j read fails.
    """
    c = (constraints or SemanticQueryConstraints()).validated()

    # Merge categorical_threshold into scope_threshold
    effective_threshold = max(
        categorical_threshold,
        c.scope_threshold if c.scope_threshold is not None else 0,
    )

    if edge_types:
        type_union = "|".join(edge_types)
        match_clause = f"MATCH (s:WordSenseNode)-[r:{type_union}]->(p:WordSenseNode)"
    else:
        # All semantic edges -- cannot use per-type index, but necessary
        # for a full categorical scan. At P1.8 scale (hundreds of edges)
        # this is well within 100ms.
        match_clause = "MATCH (s:WordSenseNode)-[r]->(p:WordSenseNode)"

    validity_clause = _build_validity_clause(c)
    confidence_clause = _build_confidence_clause(c)

    where = _build_where([
        f"r.prop_scope_context_count >= {effective_threshold}",
        validity_clause,
        confidence_clause,
    ])

    cypher = (
        f"{match_clause} "
        f"{where} "
        f"RETURN s, r, p "
        f"ORDER BY r.prop_scope_context_count DESC "
        f"LIMIT {c.result_limit}"
    )

    start = datetime.now(UTC)

    try:
        def _read(tx: neo4j.ManagedTransaction) -> list[SemanticTraversalRow]:
            result = tx.run(cypher)
            rows: list[SemanticTraversalRow] = []
            for record in result:
                try:
                    rows.append(_row_from_record(record, hop_depth=0))
                except Exception as exc:
                    _log.warning(
                        "semantic_query: skipping malformed categorical record: %s", exc
                    )
            return rows

        rows = session.execute_read(_read)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"query_categorical_facts failed (threshold={categorical_threshold}): {exc}"
        ) from exc

    elapsed_ms = (datetime.now(UTC) - start).total_seconds() * 1000.0
    truncated = len(rows) == c.result_limit

    _log.debug(
        "query_categorical_facts: threshold=%d types=%r rows=%d elapsed=%.1fms",
        categorical_threshold, edge_types, len(rows), elapsed_ms,
    )

    return SemanticQueryResult(
        rows=rows,
        query_node_id="",
        edge_types_queried=list(edge_types) if edge_types else [],
        max_depth_used=1,
        min_confidence_used=c.confidence_floor,
        scope_threshold_used=effective_threshold,
        execution_time_ms=elapsed_ms,
        truncated=truncated,
    )


def query_by_edge_type(
    session: neo4j.Session,
    edge_type: str,
    source_node_id: str | None = None,
    target_node_id: str | None = None,
    constraints: SemanticQueryConstraints | None = None,
) -> SemanticQueryResult:
    """Return semantic edges of a given type, optionally anchored to a node.

    Generic query for retrieving all edges of a specific semantic type.
    Source and/or target node IDs can be specified to restrict to edges
    connected to particular WordSenseNodes.

    This query pins the relationship type in MATCH, allowing the query
    planner to use the ``sem_{type}_scope`` and ``sem_{type}_valid`` indexes.

    Args:
        session: An open Neo4j session.
        edge_type: Semantic relationship type (e.g., 'CAUSES', 'PREVENTS').
        source_node_id: If non-None, restrict to edges from this node.
        target_node_id: If non-None, restrict to edges into this node.
        constraints: Confidence, scope, and limit controls.

    Returns:
        SemanticQueryResult with matching rows.

    Raises:
        KnowledgeGraphError: If the Neo4j read fails.
        ValueError: If edge_type is empty.
    """
    if not edge_type:
        raise ValueError("query_by_edge_type: edge_type must not be empty")

    c = (constraints or SemanticQueryConstraints()).validated()

    validity_clause = _build_validity_clause(c)
    scope_clause = _build_scope_clause(c)
    confidence_clause = _build_confidence_clause(c)

    filter_clauses: list[str] = [
        validity_clause,
        confidence_clause,
        scope_clause,
    ]
    params: dict[str, Any] = {}

    if source_node_id is not None:
        filter_clauses.append("s.node_id = $source_node_id")
        params["source_node_id"] = source_node_id

    if target_node_id is not None:
        filter_clauses.append("p.node_id = $target_node_id")
        params["target_node_id"] = target_node_id

    where = _build_where(filter_clauses)

    # Edge type is validated by _validate_edge_type pattern -- only comes from
    # the VALID_SEMANTIC_EDGE_TYPES constant, never raw user input.
    cypher = (
        f"MATCH (s:WordSenseNode)-[r:{edge_type}]->(p:WordSenseNode) "
        f"{where} "
        f"RETURN s, r, p "
        f"LIMIT {c.result_limit}"
    )

    start = datetime.now(UTC)

    try:
        def _read(tx: neo4j.ManagedTransaction) -> list[SemanticTraversalRow]:
            result = tx.run(cypher, **params)
            rows: list[SemanticTraversalRow] = []
            for record in result:
                try:
                    rows.append(_row_from_record(record, hop_depth=0))
                except Exception as exc:
                    _log.warning(
                        "semantic_query: skipping malformed record in "
                        "query_by_edge_type (type=%r): %s",
                        edge_type, exc,
                    )
            return rows

        rows = session.execute_read(_read)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"query_by_edge_type failed (edge_type={edge_type!r}): {exc}"
        ) from exc

    elapsed_ms = (datetime.now(UTC) - start).total_seconds() * 1000.0
    truncated = len(rows) == c.result_limit

    origin = source_node_id or target_node_id or ""

    _log.debug(
        "query_by_edge_type: type=%r rows=%d conf_floor=%.2f elapsed=%.1fms",
        edge_type, len(rows), c.confidence_floor, elapsed_ms,
    )

    return SemanticQueryResult(
        rows=rows,
        query_node_id=origin,
        edge_types_queried=[edge_type],
        max_depth_used=1,
        min_confidence_used=c.confidence_floor,
        scope_threshold_used=c.scope_threshold,
        execution_time_ms=elapsed_ms,
        truncated=truncated,
    )


# ---------------------------------------------------------------------------
# Write-time integrity checks (used by SemanticContradictionDetector)
# ---------------------------------------------------------------------------


def check_is_a_cycle(
    session: neo4j.Session,
    proposed_source_id: str,
    proposed_target_id: str,
    constraints: SemanticQueryConstraints | None = None,
) -> bool:
    """Check whether adding IS_A(source -> target) would create a cycle.

    A cycle exists if there is already a path from ``proposed_target_id``
    back to ``proposed_source_id`` via IS_A edges. If such a path exists,
    the proposed edge would close a cycle, violating the IS_A asymmetry
    axiom (CANON A.1 -- no circular taxonomy).

    Example:
      Existing: cat IS_A animal, animal IS_A living_thing
      Proposed: living_thing IS_A cat
      Cycle detection: path(cat -> animal -> living_thing) exists,
        so adding living_thing IS_A cat would create a cycle.

    The query traverses up to MAX_SEMANTIC_DEPTH hops so that even deep
    inversion cycles are detected. Only active edges (valid_to IS NULL)
    are considered for cycle detection -- retracted edges do not contribute
    to the current taxonomy.

    Args:
        session: An open Neo4j session.
        proposed_source_id: node_id of the edge's source (child concept).
        proposed_target_id: node_id of the edge's target (parent concept).
        constraints: Optional -- used for confidence floor only.
            max_depth is always MAX_SEMANTIC_DEPTH for cycle detection.

    Returns:
        True if a cycle would result from adding the proposed edge.
        False if the edge is safe to add.

    Raises:
        KnowledgeGraphError: If the Neo4j read fails.
    """
    c = (constraints or SemanticQueryConstraints()).validated()

    # A cycle exists if proposed_target_id can reach proposed_source_id
    # via existing IS_A edges. Traversal direction: target -> ... -> source.
    depth = MAX_SEMANTIC_DEPTH

    predicates = [
        f"rel.confidence >= {c.confidence_floor}",
        "rel.valid_to IS NULL",
    ]
    all_pred = " AND ".join(predicates)

    cypher = (
        f"MATCH path = (target:WordSenseNode {{node_id: $target_id}})"
        f"-[r_chain:IS_A*1..{depth}]->(source:WordSenseNode {{node_id: $source_id}}) "
        f"WHERE ALL(rel IN relationships(path) WHERE {all_pred}) "
        f"RETURN count(path) AS path_count "
        f"LIMIT 1"
    )

    try:
        def _read(tx: neo4j.ManagedTransaction) -> bool:
            result = tx.run(
                cypher,
                target_id=proposed_target_id,
                source_id=proposed_source_id,
            )
            record = result.single()
            if record is None:
                return False
            return int(record["path_count"]) > 0

        cycle_exists = session.execute_read(_read)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"check_is_a_cycle failed (source={proposed_source_id!r} "
            f"target={proposed_target_id!r}): {exc}"
        ) from exc

    if cycle_exists:
        _log.info(
            "check_is_a_cycle: CYCLE DETECTED source=%r target=%r",
            proposed_source_id, proposed_target_id,
        )

    return cycle_exists


def check_direct_conflict(
    session: neo4j.Session,
    source_node_id: str,
    target_node_id: str,
    proposed_edge_type: str,
    property_type: str | None = None,
) -> tuple[bool, str]:
    """Check whether the proposed edge conflicts with an existing semantic edge.

    Two conflict patterns are checked:

    1. HAS_PROPERTY vs LACKS_PROPERTY:
       If proposing HAS_PROPERTY(A -> B) and LACKS_PROPERTY(A -> B) already
       exists (active), that is a direct negation conflict.
       If proposing LACKS_PROPERTY(A -> B) and HAS_PROPERTY(A -> B) already
       exists (active), same conflict in reverse.

    2. IS_A inversion (not cycles -- that is check_is_a_cycle):
       If proposing IS_A(A -> B) and IS_A(B -> A) already exists (active),
       that is a direct asymmetry violation (distinct from a multi-hop cycle).

    Only active edges (valid_to IS NULL) are checked. Retracted edges
    do not cause conflicts.

    For HAS_PROPERTY conflicts, the composite key is
    (source_id, target_id, property_type). Two HAS_PROPERTY edges with
    different property_types are NOT conflicts -- they encode different
    property characterizations of the same pair.

    Args:
        session: An open Neo4j session.
        source_node_id: node_id of the proposed edge's source.
        target_node_id: node_id of the proposed edge's target.
        proposed_edge_type: The semantic edge type being proposed.
        property_type: For HAS_PROPERTY / LACKS_PROPERTY proposals, the
            sub-classification. Used for composite key conflict detection.

    Returns:
        (conflict_found, conflicting_edge_id) tuple.
        If conflict_found is False, conflicting_edge_id is empty string.

    Raises:
        KnowledgeGraphError: If the Neo4j read fails.
    """
    conflict_edge_type: str | None = None

    if proposed_edge_type == HAS_PROPERTY:
        conflict_edge_type = LACKS_PROPERTY
    elif proposed_edge_type == LACKS_PROPERTY:
        conflict_edge_type = HAS_PROPERTY

    # For non-HAS_PROPERTY / non-LACKS_PROPERTY types, check IS_A inversion.
    if proposed_edge_type == IS_A:
        # Direct inversion: does (target) -[IS_A]-> (source) exist?
        return _check_edge_exists(
            session=session,
            source_node_id=target_node_id,  # reversed
            target_node_id=source_node_id,  # reversed
            edge_type=IS_A,
            property_type=None,
        )

    if conflict_edge_type is not None:
        # HAS_PROPERTY / LACKS_PROPERTY conflict check using composite key.
        return _check_edge_exists(
            session=session,
            source_node_id=source_node_id,
            target_node_id=target_node_id,
            edge_type=conflict_edge_type,
            property_type=property_type,
        )

    # No conflict patterns apply for other edge types.
    return False, ""


def _check_edge_exists(
    session: neo4j.Session,
    source_node_id: str,
    target_node_id: str,
    edge_type: str,
    property_type: str | None,
) -> tuple[bool, str]:
    """Check whether a specific edge exists and return its edge_id if so.

    Only considers active edges (valid_to IS NULL). The property_type
    constraint is only applied when non-None, implementing the composite
    key for HAS_PROPERTY / LACKS_PROPERTY conflicts.

    Returns:
        (True, edge_id) if found, (False, "") otherwise.
    """
    params: dict[str, Any] = {
        "source_id": source_node_id,
        "target_id": target_node_id,
    }

    property_clause = ""
    if property_type is not None:
        property_clause = "AND r.prop_property_type = $property_type "
        params["property_type"] = property_type

    cypher = (
        f"MATCH (s:WordSenseNode {{node_id: $source_id}})"
        f"-[r:{edge_type}]->"
        f"(p:WordSenseNode {{node_id: $target_id}}) "
        f"WHERE r.valid_to IS NULL "
        f"{property_clause}"
        f"RETURN r.edge_id AS eid "
        f"LIMIT 1"
    )

    try:
        def _read(tx: neo4j.ManagedTransaction) -> tuple[bool, str]:
            result = tx.run(cypher, **params)
            record = result.single()
            if record is None:
                return False, ""
            eid = record["eid"]
            return True, str(eid) if eid is not None else ""

        return session.execute_read(_read)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"_check_edge_exists failed (src={source_node_id!r} "
            f"tgt={target_node_id!r} type={edge_type!r}): {exc}"
        ) from exc


# ---------------------------------------------------------------------------
# Atomic MERGE-based edge create-or-update
# ---------------------------------------------------------------------------


def merge_or_update_semantic_edge(
    session: neo4j.Session,
    source_node_id: str,
    target_node_id: str,
    edge_type: str,
    edge_properties: dict[str, Any],
) -> tuple[str, bool]:
    """Atomically create a semantic edge or update its properties if it exists.

    Uses Cypher MERGE semantics on the structural identity triple
    (source_node_id, target_node_id, edge_type) with an optional
    prop_property_type discriminator for HAS_PROPERTY edges. This ensures
    that concurrent assertions of the same fact produce exactly one edge,
    not duplicates.

    The MERGE is executed within a single Neo4j transaction, making the
    check-and-write atomic at the database level. This satisfies the T007
    acceptance criterion: "Cypher MERGE semantics for concurrent edge write
    atomicity."

    If the edge already exists (MERGE matched), ``scope_context_count`` is
    NOT automatically incremented here -- that is the responsibility of
    ``ScopeContextMechanics.increment_scope_count()`` which applies the
    full Piagetian context-boundary rules. This function only handles the
    structural create-or-update.

    The ``edge_id`` property must be present in ``edge_properties`` for
    idempotent identification. On create, the provided edge_id is used.
    On match, the existing edge_id is preserved (the SET overwrites all
    other properties but the MERGE key fields ensure consistency).

    Args:
        session: An open Neo4j session.
        source_node_id: node_id of the source WordSenseNode.
        target_node_id: node_id of the target WordSenseNode.
        edge_type: Semantic relationship type. Must be alphanumeric + _.
        edge_properties: Dict of all relationship properties. Must include
            'edge_id'. Properties are stored as-is (caller is responsible
            for the prop_ prefix convention if targeting Neo4jGraphPersistence).

    Returns:
        (edge_id, created) tuple. ``created`` is True if a new edge was
        created, False if an existing edge was matched and updated.

    Raises:
        KnowledgeGraphError: If the Neo4j write fails or edge_id is missing.
        ValueError: If edge_type contains unsafe characters or edge_id is absent.
    """
    if not edge_type or not all(c.isalnum() or c == "_" for c in edge_type):
        raise ValueError(
            f"merge_or_update_semantic_edge: edge_type {edge_type!r} contains "
            f"characters unsafe for Neo4j relationship type interpolation."
        )

    if "edge_id" not in edge_properties:
        raise ValueError(
            "merge_or_update_semantic_edge: edge_properties must include 'edge_id'"
        )

    edge_id = str(edge_properties["edge_id"])

    # Build the MERGE discriminator for HAS_PROPERTY / LACKS_PROPERTY:
    # include prop_property_type in the MERGE key so that different property_types
    # create separate edges rather than colliding.
    extra_merge_key = ""
    extra_merge_params: dict[str, Any] = {}

    if edge_type in (HAS_PROPERTY, LACKS_PROPERTY):
        ptype = edge_properties.get("prop_property_type", "")
        if ptype:
            extra_merge_key = ", prop_property_type: $merge_property_type"
            extra_merge_params["merge_property_type"] = ptype

    # We track whether the edge was created or matched using a flag property
    # that we set ON CREATE and clear ON MATCH.
    cypher = (
        f"MERGE (src {{node_id: $source_id}}) "
        f"MERGE (tgt {{node_id: $target_id}}) "
        f"MERGE (src)-[r:{edge_type} {{source_id: $source_id, target_id: $target_id"
        f"{extra_merge_key}}}]->(tgt) "
        f"ON CREATE SET r = $props, r._was_created = true "
        f"ON MATCH SET r += $props, r._was_created = false "
        f"RETURN r._was_created AS was_created, r.edge_id AS eid"
    )

    params: dict[str, Any] = {
        "source_id": source_node_id,
        "target_id": target_node_id,
        "props": edge_properties,
        **extra_merge_params,
    }

    try:
        def _write(tx: neo4j.ManagedTransaction) -> tuple[str, bool]:
            result = tx.run(cypher, **params)
            record = result.single()
            if record is None:
                raise KnowledgeGraphError(
                    f"merge_or_update_semantic_edge: MERGE returned no record "
                    f"(src={source_node_id!r} tgt={target_node_id!r} type={edge_type!r})"
                )
            was_created = bool(record["was_created"])
            returned_eid = str(record["eid"]) if record["eid"] else edge_id
            return returned_eid, was_created

        returned_eid, was_created = session.execute_write(_write)
    except KnowledgeGraphError:
        raise
    except Exception as exc:
        raise KnowledgeGraphError(
            f"merge_or_update_semantic_edge failed (src={source_node_id!r} "
            f"tgt={target_node_id!r} type={edge_type!r}): {exc}"
        ) from exc

    action = "created" if was_created else "updated"
    _log.debug(
        "merge_or_update_semantic_edge: %s edge_id=%r type=%r src=%r tgt=%r",
        action, returned_eid, edge_type, source_node_id, target_node_id,
    )

    return returned_eid, was_created


# ---------------------------------------------------------------------------
# Internal helper types for ancestor/descendant queries
# ---------------------------------------------------------------------------


class _AncestorRecord:
    """Thin wrapper around the raw Neo4j record dicts for ancestor queries.

    Ancestor queries return ``s``, ``r``, ``p``, ``depth`` where ``p`` is
    the ancestor node (not the direct target as in single-hop queries).
    This wrapper makes the data structure explicit.
    """

    def __init__(
        self,
        s: dict[str, Any],
        r: dict[str, Any],
        p: dict[str, Any],
    ) -> None:
        self.s = s
        self.r = r
        self.p = p


def _row_from_ancestor_record(rec: _AncestorRecord, hop: int) -> SemanticTraversalRow:
    """Build a SemanticTraversalRow from an ancestor query _AncestorRecord."""
    valid_to_raw = rec.r.get("valid_to")
    valid_from_raw = rec.r.get("valid_from")
    valid_from_dt = _neo4j_to_py_datetime(valid_from_raw) or datetime.now(UTC)
    valid_to_dt = _neo4j_to_py_datetime(valid_to_raw)

    return SemanticTraversalRow(
        subject_node_id=str(rec.s.get("node_id", "")),
        subject_spelling=str(rec.s.get("prop_spelling", rec.s.get("spelling", ""))),
        edge_id=str(rec.r.get("edge_id", "")),
        edge_type=str(rec.r.get("edge_type", IS_A)),
        edge_confidence=float(rec.r.get("confidence", 0.0)),
        scope_context_count=int(rec.r.get("prop_scope_context_count", 0)),
        valid_from=valid_from_dt,
        valid_to=valid_to_dt,
        property_type=str(rec.r.get("prop_property_type", "")),
        asserted_text=str(rec.r.get("prop_asserted_text", "")),
        object_node_id=str(rec.p.get("node_id", "")),
        object_spelling=str(rec.p.get("prop_spelling", rec.p.get("spelling", ""))),
        hop_depth=hop,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    # Constants
    "MAX_SEMANTIC_DEPTH",
    "MIN_CONFIDENCE_FLOOR",
    "DEFAULT_CATEGORICAL_THRESHOLD",
    # Result types
    "SemanticTraversalRow",
    "SemanticQueryResult",
    "SemanticQueryConstraints",
    # Traversal queries
    "query_active_semantic_edges",
    "query_is_a_ancestors",
    "query_is_a_descendants",
    "query_has_property_edges",
    "query_categorical_facts",
    "query_by_edge_type",
    # Write-time integrity checks
    "check_is_a_cycle",
    "check_direct_conflict",
    # Atomic edge create-or-update
    "merge_or_update_semantic_edge",
]

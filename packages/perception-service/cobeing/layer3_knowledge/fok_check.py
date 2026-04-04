"""Feeling of Knowing (FOK) feasibility check for semantic queries (P1.8-E3/T011).

Luria's Feeling of Knowing is a lightweight metacognitive probe that runs
*before* expensive semantic query execution. It answers: "does the graph have
enough structure in the vicinity of this entity to make a query worth
executing?" If the probe says no, the system routes directly to LLM_REQUIRED
without burning cycles on a traversal that will return empty.

FOK is Cortex infrastructure: a guard condition layer that sits between PT-9
classification and query executor dispatch in the SemanticQueryHandler pipeline.
It is deterministic (no LLM calls), fast (single bounded Cypher count query),
and conservative (it blocks only when it is confident the query will fail).

Architecture:

  1. **Probing**: For a given subject node (and optional target node), count
     semantic edges reachable within ``max_hop_distance`` hops that meet
     minimum confidence requirements. This is a *count* query, not a full
     traversal -- it returns edge_count and distinct_edge_types only.

  2. **Feasibility decision**: The probe is FEASIBLE if:
        edge_count >= min_edge_count (default 1)
        AND at least one edge has confidence >= min_confidence (default 0.3)

  3. **Dynamic max_hop_distance**: The probe looks one hop further than the
     current operational depth of the query procedure being guarded:
        max_hop_distance = min(fok_probe_max, current_max_depth + 1)

     This means:
       - At E3 depth=1: FOK probes depth 2 (sees whether 2-hop paths exist)
       - At E3 depth=2: FOK probes depth 3
       - At E3 depth=3: FOK probes depth 4 (but E5 gating may block)

  4. **E5 gating**: When ``e5_prerequisite_met=False``, FOK probes are capped
     at depth 3 (the E3 architectural maximum). Even if current_max_depth + 1
     would yield 4, the probe does not explore beyond 3 because the system
     cannot *use* results at depth 4+ without E5 inner monologue.

  5. **Per-query-type adaptation**: Different query types have different
     feasibility criteria:
       - definition_query: FEASIBLE if *any* semantic edges exist from subject
       - classification_query: FEASIBLE if any IS_A edge exists from subject
       - inference_query: FEASIBLE if edges exist from *both* subject and target

  6. **Performance metrics**: Every FOK check records whether its prediction
     matched the full query result (true positive, false positive, true negative,
     false negative). These feed into FOK accuracy tracking for calibration.

Integration point:
  SemanticQueryHandler.handle() calls ``fok_check()`` after PT-9 classification
  and before query executor dispatch (between Steps E and G). If the FOK check
  returns infeasible, the handler routes to LLM_REQUIRED early.

CANON compliance:
  A.2  -- LLM as tool. FOK is a deterministic rule that prevents unnecessary
          LLM calls by catching queries that would fail anyway.
  A.10 -- Bounded traversal. FOK probes respect the same depth ceiling as
          full queries (MAX_TRAVERSAL_DEPTH from constants.py).
  A.19 -- FOK results are not inference traces. They are pre-execution
          feasibility checks, not post-execution reasoning records.

Phase 1.8 (Comprehension Layer, P1.8-E3/T011).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

import neo4j

from cobeing.layer3_knowledge.constants import MAX_TRAVERSAL_DEPTH
from cobeing.layer3_knowledge.inference_query import (
    DEFAULT_INFERENCE_ARCHITECTURAL_MAX,
    DEFAULT_INFERENCE_START_DEPTH,
    INFERENCE_DEPTH_RULE_ID,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.semantic_query import MIN_CONFIDENCE_FLOOR
from cobeing.layer3_knowledge.semantic_types import IS_A

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# FOK probe defaults (from T011 acceptance criteria)
FOK_MIN_EDGE_COUNT: int = 1
"""Minimum number of semantic edges required for feasibility."""

FOK_MIN_CONFIDENCE: float = 0.3
"""Minimum confidence on at least one edge for feasibility.

Matches MIN_CONFIDENCE_FLOOR from semantic_query.py so that the FOK probe
and the full query agree on what edges are traversable."""

FOK_PROBE_MAX: int = 4
"""Absolute maximum probe depth. Even with E5 unlocked, the FOK probe
does not explore beyond this depth. The probe is a lightweight count,
not a full traversal -- deeper probes lose their cost advantage."""

FOK_E3_DEPTH_CAP: int = 3
"""Maximum FOK probe depth when e5_prerequisite_met is False.

This is the E3 architectural maximum from inference_query.py
(DEFAULT_INFERENCE_ARCHITECTURAL_MAX). FOK probes at depth 4+ are
blocked because the system cannot use results at that depth without
E5 inner monologue."""


# ---------------------------------------------------------------------------
# Result dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FOKProbeResult:
    """Result of a single FOK feasibility probe.

    Attributes:
        feasible: True if the probe deems the query worth executing.
        edge_count: Number of semantic edges found within the probe radius.
        max_confidence: Highest edge confidence found, or 0.0 if no edges.
        distinct_edge_types: Number of distinct edge types found.
        probe_depth_used: The actual max_hop_distance used for the probe.
        probe_time_ms: Wall-clock milliseconds for the probe execution.
        reason: Human-readable reason string for the feasibility decision.
        subject_node_id: The subject node that was probed.
        target_node_id: The target node that was probed (empty for definition).
        query_type: The query type this probe was for.
        gated_by_e5: True if the probe depth was capped by E5 gating.
    """

    feasible: bool
    edge_count: int
    max_confidence: float
    distinct_edge_types: int
    probe_depth_used: int
    probe_time_ms: float
    reason: str
    subject_node_id: str
    target_node_id: str
    query_type: str
    gated_by_e5: bool


@dataclass
class FOKAccuracyTracker:
    """Session-scoped tracker for FOK prediction accuracy.

    Compares FOK predictions (feasible/infeasible) against actual query
    outcomes (produced results / empty results). This feeds the T015
    metrics framework for FOK calibration.

    The tracker is deliberately simple: four counters. No persistence
    (session-scoped), no LLM calls, no graph writes. Metrics are logged
    at session end for developmental tracking.

    Attributes:
        true_positive: FOK said feasible, query produced results.
        false_positive: FOK said feasible, query produced no results.
        true_negative: FOK said infeasible, query would have been empty.
        false_negative: FOK said infeasible, query would have produced results.
            (This is estimated: when FOK blocks, we do not run the query.
            Estimated by running periodic shadow probes at DEBUG level.)
    """

    true_positive: int = 0
    false_positive: int = 0
    true_negative: int = 0
    false_negative: int = 0

    @property
    def total_checks(self) -> int:
        """Total number of FOK checks recorded."""
        return (
            self.true_positive
            + self.false_positive
            + self.true_negative
            + self.false_negative
        )

    @property
    def accuracy(self) -> float:
        """FOK accuracy: fraction of correct predictions.

        Returns 1.0 if no checks have been recorded (vacuously correct).
        """
        total = self.total_checks
        if total == 0:
            return 1.0
        return (self.true_positive + self.true_negative) / total

    @property
    def precision(self) -> float:
        """Precision: of queries FOK deemed feasible, how many produced results.

        Returns 1.0 if no feasible predictions were made.
        """
        positives = self.true_positive + self.false_positive
        if positives == 0:
            return 1.0
        return self.true_positive / positives

    @property
    def recall(self) -> float:
        """Recall: of queries that would produce results, how many did FOK allow.

        Returns 1.0 if no results-producing queries were observed.
        """
        actual_positives = self.true_positive + self.false_negative
        if actual_positives == 0:
            return 1.0
        return self.true_positive / actual_positives

    def record_outcome(self, fok_feasible: bool, query_produced_results: bool) -> None:
        """Record one FOK prediction vs actual query outcome.

        Args:
            fok_feasible: What FOK predicted (True = feasible).
            query_produced_results: Whether the query actually produced results.
        """
        if fok_feasible and query_produced_results:
            self.true_positive += 1
        elif fok_feasible and not query_produced_results:
            self.false_positive += 1
        elif not fok_feasible and not query_produced_results:
            self.true_negative += 1
        else:
            # not fok_feasible and query_produced_results
            self.false_negative += 1

    def reset(self) -> None:
        """Reset all counters for a new session."""
        self.true_positive = 0
        self.false_positive = 0
        self.true_negative = 0
        self.false_negative = 0

    def summary(self) -> dict[str, Any]:
        """Return a summary dict for logging and metrics.

        Returns:
            Dict with accuracy, precision, recall, and raw counts.
        """
        return {
            "total_checks": self.total_checks,
            "accuracy": round(self.accuracy, 3),
            "precision": round(self.precision, 3),
            "recall": round(self.recall, 3),
            "true_positive": self.true_positive,
            "false_positive": self.false_positive,
            "true_negative": self.true_negative,
            "false_negative": self.false_negative,
        }


# ---------------------------------------------------------------------------
# Core FOK probe logic
# ---------------------------------------------------------------------------


def compute_fok_probe_depth(
    current_max_depth: int,
    e5_prerequisite_met: bool,
) -> int:
    """Compute the dynamic FOK probe depth.

    The probe looks one hop further than the current operational depth,
    capped by E5 gating and the absolute probe maximum.

    Formula:
        max_hop_distance = min(FOK_PROBE_MAX, current_max_depth + 1)
        if not e5_prerequisite_met:
            max_hop_distance = min(max_hop_distance, FOK_E3_DEPTH_CAP)

    Examples:
        current_max_depth=1, e5=False -> probe_depth=2
        current_max_depth=2, e5=False -> probe_depth=3
        current_max_depth=3, e5=False -> probe_depth=3 (capped by E3)
        current_max_depth=3, e5=True  -> probe_depth=4
        current_max_depth=4, e5=True  -> probe_depth=4 (capped by FOK_PROBE_MAX)

    Args:
        current_max_depth: The current operational max depth of the query
            procedure being guarded (from EvolutionRule).
        e5_prerequisite_met: Whether E5 inner monologue has been delivered.

    Returns:
        The maximum hop distance for the FOK probe. Always >= 1.
    """
    probe_depth = min(FOK_PROBE_MAX, current_max_depth + 1)
    if not e5_prerequisite_met:
        probe_depth = min(probe_depth, FOK_E3_DEPTH_CAP)
    # Safety: never go below 1 or above MAX_TRAVERSAL_DEPTH
    return max(1, min(probe_depth, MAX_TRAVERSAL_DEPTH))


def _run_fok_probe_cypher(
    neo4j_session: neo4j.Session,
    node_id: str,
    max_hop_distance: int,
    min_confidence: float,
    edge_type_filter: str | None = None,
) -> tuple[int, float, int]:
    """Execute the lightweight FOK count query against Neo4j.

    This is a *count* query, not a full traversal. It returns aggregate
    metrics about the local graph neighborhood without materializing rows.
    The Cypher uses variable-length path matching with count aggregation.

    Args:
        neo4j_session: Open Neo4j session.
        node_id: The node_id to probe from.
        max_hop_distance: Maximum hops for the probe.
        min_confidence: Minimum edge confidence to count.
        edge_type_filter: If provided, only count edges of this type
            (e.g., "IS_A" for classification queries). If None, count
            all semantic edge types.

    Returns:
        Tuple of (edge_count, max_confidence, distinct_edge_types).
        Returns (0, 0.0, 0) on any failure.
    """
    # Build the relationship pattern. If edge_type_filter is set, pin the type.
    # Otherwise, match any relationship.
    if edge_type_filter:
        rel_pattern = f"[r:{edge_type_filter}*1..{max_hop_distance}]"
    else:
        rel_pattern = f"[r*1..{max_hop_distance}]"

    # The ALL() predicate ensures every edge in the path meets confidence
    # and validity requirements. This matches the full query semantics.
    cypher = (
        f"MATCH path = (s:WordSenseNode {{node_id: $node_id}})-{rel_pattern}->(t:WordSenseNode) "
        f"WHERE ALL(rel IN relationships(path) WHERE "
        f"  rel.confidence >= $min_confidence AND rel.valid_to IS NULL) "
        f"WITH DISTINCT last(relationships(path)) AS edge "
        f"RETURN count(edge) AS edge_count, "
        f"  CASE WHEN count(edge) > 0 THEN max(edge.confidence) ELSE 0.0 END AS max_conf, "
        f"  count(DISTINCT type(edge)) AS distinct_types"
    )

    try:
        def _read(tx: neo4j.ManagedTransaction) -> tuple[int, float, int]:
            result = tx.run(
                cypher,
                node_id=node_id,
                min_confidence=min_confidence,
            )
            record = result.single()
            if record is None:
                return (0, 0.0, 0)
            return (
                int(record["edge_count"]),
                float(record["max_conf"]),
                int(record["distinct_types"]),
            )

        return neo4j_session.execute_read(_read)
    except Exception as exc:
        _log.warning(
            "fok_probe_cypher_failed node_id=%r max_hops=%d error=%s",
            node_id, max_hop_distance, exc,
        )
        return (0, 0.0, 0)


def _run_fok_target_probe_cypher(
    neo4j_session: neo4j.Session,
    target_node_id: str,
    min_confidence: float,
) -> tuple[int, float]:
    """Probe whether the target node has any incoming semantic edges.

    For inference queries, feasibility requires structure on *both* ends.
    This probe checks the target side with a single-hop incoming edge count.

    Args:
        neo4j_session: Open Neo4j session.
        target_node_id: The target node_id to check.
        min_confidence: Minimum edge confidence.

    Returns:
        Tuple of (edge_count, max_confidence). Returns (0, 0.0) on failure.
    """
    cypher = (
        "MATCH (s:WordSenseNode)-[r]->(t:WordSenseNode {node_id: $node_id}) "
        "WHERE r.confidence >= $min_confidence AND r.valid_to IS NULL "
        "RETURN count(r) AS edge_count, "
        "  CASE WHEN count(r) > 0 THEN max(r.confidence) ELSE 0.0 END AS max_conf"
    )

    try:
        def _read(tx: neo4j.ManagedTransaction) -> tuple[int, float]:
            result = tx.run(
                cypher,
                node_id=target_node_id,
                min_confidence=min_confidence,
            )
            record = result.single()
            if record is None:
                return (0, 0.0)
            return (int(record["edge_count"]), float(record["max_conf"]))

        return neo4j_session.execute_read(_read)
    except Exception as exc:
        _log.warning(
            "fok_target_probe_failed target=%r error=%s",
            target_node_id, exc,
        )
        return (0, 0.0)


# ---------------------------------------------------------------------------
# Per-query-type FOK checks
# ---------------------------------------------------------------------------


def fok_check_definition(
    neo4j_session: neo4j.Session,
    subject_node_id: str,
    current_max_depth: int = 5,
    e5_prerequisite_met: bool = False,
    min_edge_count: int = FOK_MIN_EDGE_COUNT,
    min_confidence: float = FOK_MIN_CONFIDENCE,
) -> FOKProbeResult:
    """FOK feasibility check for definition_query.

    Definition queries need at least one semantic edge from the subject.
    Any edge type counts (IS_A, HAS_PROPERTY, PART_OF, etc.).

    Definition_query has depth=5 from launch (independent-per-level working
    memory), so its FOK probe also uses a more generous depth. However, the
    dynamic probe depth formula still applies: the probe looks ahead by one
    hop relative to the query's operational depth.

    Args:
        neo4j_session: Open Neo4j session.
        subject_node_id: The subject entity to probe.
        current_max_depth: Current operational depth for definition queries.
        e5_prerequisite_met: Whether E5 is delivered.
        min_edge_count: Minimum edges for feasibility.
        min_confidence: Minimum confidence threshold.

    Returns:
        FOKProbeResult with feasibility decision.
    """
    start = time.monotonic()

    probe_depth = compute_fok_probe_depth(current_max_depth, e5_prerequisite_met)
    gated = not e5_prerequisite_met and (current_max_depth + 1) > FOK_E3_DEPTH_CAP

    edge_count, max_conf, distinct_types = _run_fok_probe_cypher(
        neo4j_session=neo4j_session,
        node_id=subject_node_id,
        max_hop_distance=probe_depth,
        min_confidence=min_confidence,
    )

    elapsed_ms = (time.monotonic() - start) * 1000

    feasible = edge_count >= min_edge_count and max_conf >= min_confidence

    if feasible:
        reason = (
            f"definition feasible: {edge_count} edges, "
            f"{distinct_types} types, max_conf={max_conf:.2f} "
            f"within {probe_depth} hops"
        )
    elif edge_count == 0:
        reason = (
            f"definition infeasible: no semantic edges from "
            f"{subject_node_id} within {probe_depth} hops"
        )
    else:
        reason = (
            f"definition infeasible: {edge_count} edges found but "
            f"max_confidence={max_conf:.2f} < {min_confidence}"
        )

    _log.debug(
        "fok_check_definition subject=%r feasible=%s edges=%d "
        "max_conf=%.2f types=%d depth=%d gated=%s time_ms=%.1f",
        subject_node_id, feasible, edge_count,
        max_conf, distinct_types, probe_depth, gated, elapsed_ms,
    )

    return FOKProbeResult(
        feasible=feasible,
        edge_count=edge_count,
        max_confidence=max_conf,
        distinct_edge_types=distinct_types,
        probe_depth_used=probe_depth,
        probe_time_ms=elapsed_ms,
        reason=reason,
        subject_node_id=subject_node_id,
        target_node_id="",
        query_type="definition",
        gated_by_e5=gated,
    )


def fok_check_classification(
    neo4j_session: neo4j.Session,
    subject_node_id: str,
    current_max_depth: int = 5,
    e5_prerequisite_met: bool = False,
    min_edge_count: int = FOK_MIN_EDGE_COUNT,
    min_confidence: float = FOK_MIN_CONFIDENCE,
) -> FOKProbeResult:
    """FOK feasibility check for classification_query.

    Classification queries traverse IS_A edges only. The probe checks
    specifically for IS_A edges from the subject, because other edge types
    (HAS_PROPERTY, CAUSES, etc.) are irrelevant for classification.

    Args:
        neo4j_session: Open Neo4j session.
        subject_node_id: The subject entity to probe.
        current_max_depth: Current operational depth for classification.
        e5_prerequisite_met: Whether E5 is delivered.
        min_edge_count: Minimum IS_A edges for feasibility.
        min_confidence: Minimum confidence threshold.

    Returns:
        FOKProbeResult with feasibility decision.
    """
    start = time.monotonic()

    probe_depth = compute_fok_probe_depth(current_max_depth, e5_prerequisite_met)
    gated = not e5_prerequisite_met and (current_max_depth + 1) > FOK_E3_DEPTH_CAP

    edge_count, max_conf, distinct_types = _run_fok_probe_cypher(
        neo4j_session=neo4j_session,
        node_id=subject_node_id,
        max_hop_distance=probe_depth,
        min_confidence=min_confidence,
        edge_type_filter=IS_A,
    )

    elapsed_ms = (time.monotonic() - start) * 1000

    feasible = edge_count >= min_edge_count and max_conf >= min_confidence

    if feasible:
        reason = (
            f"classification feasible: {edge_count} IS_A edges, "
            f"max_conf={max_conf:.2f} within {probe_depth} hops"
        )
    elif edge_count == 0:
        reason = (
            f"classification infeasible: no IS_A edges from "
            f"{subject_node_id} within {probe_depth} hops"
        )
    else:
        reason = (
            f"classification infeasible: {edge_count} IS_A edges but "
            f"max_confidence={max_conf:.2f} < {min_confidence}"
        )

    _log.debug(
        "fok_check_classification subject=%r feasible=%s edges=%d "
        "max_conf=%.2f depth=%d gated=%s time_ms=%.1f",
        subject_node_id, feasible, edge_count,
        max_conf, probe_depth, gated, elapsed_ms,
    )

    return FOKProbeResult(
        feasible=feasible,
        edge_count=edge_count,
        max_confidence=max_conf,
        distinct_edge_types=distinct_types,
        probe_depth_used=probe_depth,
        probe_time_ms=elapsed_ms,
        reason=reason,
        subject_node_id=subject_node_id,
        target_node_id="",
        query_type="classification",
        gated_by_e5=gated,
    )


def fok_check_inference(
    neo4j_session: neo4j.Session,
    subject_node_id: str,
    target_node_id: str,
    current_max_depth: int = DEFAULT_INFERENCE_START_DEPTH,
    e5_prerequisite_met: bool = False,
    min_edge_count: int = FOK_MIN_EDGE_COUNT,
    min_confidence: float = FOK_MIN_CONFIDENCE,
) -> FOKProbeResult:
    """FOK feasibility check for inference_query.

    Inference queries traverse from subject toward target across multiple
    edge types. Feasibility requires structure on *both* ends: the subject
    must have outgoing semantic edges, and the target must have incoming
    semantic edges. If either end is structurally barren, the multi-hop
    BFS will fail.

    The probe also applies E5 gating: at depth 3 (E3 max), the FOK probe
    sees depth 3 (not 4) because the system cannot use depth-4 results
    without E5 inner monologue.

    Args:
        neo4j_session: Open Neo4j session.
        subject_node_id: The subject entity to probe.
        target_node_id: The target entity to probe.
        current_max_depth: Current operational depth for inference.
        e5_prerequisite_met: Whether E5 is delivered.
        min_edge_count: Minimum edges for feasibility.
        min_confidence: Minimum confidence threshold.

    Returns:
        FOKProbeResult with feasibility decision.
    """
    start = time.monotonic()

    probe_depth = compute_fok_probe_depth(current_max_depth, e5_prerequisite_met)
    gated = not e5_prerequisite_met and (current_max_depth + 1) > FOK_E3_DEPTH_CAP

    # Probe subject side: outgoing edges
    subject_edge_count, subject_max_conf, subject_types = _run_fok_probe_cypher(
        neo4j_session=neo4j_session,
        node_id=subject_node_id,
        max_hop_distance=probe_depth,
        min_confidence=min_confidence,
    )

    # Probe target side: incoming edges (single-hop check)
    target_edge_count, target_max_conf = _run_fok_target_probe_cypher(
        neo4j_session=neo4j_session,
        target_node_id=target_node_id,
        min_confidence=min_confidence,
    )

    elapsed_ms = (time.monotonic() - start) * 1000

    # Both ends must have structure
    subject_feasible = (
        subject_edge_count >= min_edge_count
        and subject_max_conf >= min_confidence
    )
    target_feasible = (
        target_edge_count >= min_edge_count
        and target_max_conf >= min_confidence
    )
    feasible = subject_feasible and target_feasible

    # Combined edge count for reporting
    total_edges = subject_edge_count + target_edge_count
    max_conf = max(subject_max_conf, target_max_conf)

    if feasible:
        reason = (
            f"inference feasible: subject has {subject_edge_count} edges "
            f"(max_conf={subject_max_conf:.2f}), target has "
            f"{target_edge_count} edges (max_conf={target_max_conf:.2f}) "
            f"within {probe_depth} hops"
        )
    elif not subject_feasible and not target_feasible:
        reason = (
            f"inference infeasible: neither subject ({subject_node_id}) "
            f"nor target ({target_node_id}) has sufficient semantic edges"
        )
    elif not subject_feasible:
        reason = (
            f"inference infeasible: subject ({subject_node_id}) has "
            f"{subject_edge_count} edges with max_conf={subject_max_conf:.2f}"
        )
    else:
        reason = (
            f"inference infeasible: target ({target_node_id}) has "
            f"{target_edge_count} incoming edges with "
            f"max_conf={target_max_conf:.2f}"
        )

    _log.debug(
        "fok_check_inference subject=%r target=%r feasible=%s "
        "subject_edges=%d target_edges=%d max_conf=%.2f "
        "depth=%d gated=%s time_ms=%.1f",
        subject_node_id, target_node_id, feasible,
        subject_edge_count, target_edge_count, max_conf,
        probe_depth, gated, elapsed_ms,
    )

    return FOKProbeResult(
        feasible=feasible,
        edge_count=total_edges,
        max_confidence=max_conf,
        distinct_edge_types=subject_types,
        probe_depth_used=probe_depth,
        probe_time_ms=elapsed_ms,
        reason=reason,
        subject_node_id=subject_node_id,
        target_node_id=target_node_id,
        query_type="inference",
        gated_by_e5=gated,
    )


# ---------------------------------------------------------------------------
# Unified FOK check dispatcher
# ---------------------------------------------------------------------------


async def fok_check(
    neo4j_session: neo4j.Session,
    persistence: GraphPersistence,
    query_type: str,
    subject_node_id: str,
    target_node_id: str = "",
    min_edge_count: int = FOK_MIN_EDGE_COUNT,
    min_confidence: float = FOK_MIN_CONFIDENCE,
) -> FOKProbeResult:
    """Unified FOK feasibility check -- the primary integration point.

    Reads the current developmental depth and E5 prerequisite from the
    graph's EvolutionRule nodes, then dispatches to the appropriate
    per-query-type FOK checker.

    This is an async function because it reads the EvolutionRule node
    via GraphPersistence (async). The actual Cypher probe is synchronous
    (Neo4j driver), but the config read is async.

    Args:
        neo4j_session: Open Neo4j session for Cypher probes.
        persistence: GraphPersistence for EvolutionRule reads.
        query_type: One of "definition", "classification", "inference".
        subject_node_id: The subject entity node_id.
        target_node_id: The target entity node_id (required for inference,
            ignored for definition and classification).
        min_edge_count: Override minimum edge count threshold.
        min_confidence: Override minimum confidence threshold.

    Returns:
        FOKProbeResult with the feasibility decision.
    """
    # Read current depth config from EvolutionRule
    current_max_depth = DEFAULT_INFERENCE_START_DEPTH
    e5_prerequisite_met = False

    depth_rule = await persistence.get_node(INFERENCE_DEPTH_RULE_ID)
    if depth_rule is not None:
        current_max_depth = int(
            depth_rule.properties.get(
                "current_max_depth", DEFAULT_INFERENCE_START_DEPTH
            )
        )
        e5_prerequisite_met = bool(
            depth_rule.properties.get("e5_prerequisite_met", False)
        )

    # For definition and classification, use their own depth configs.
    # Definition uses depth=5 from launch; classification uses depth=5 default.
    # The dynamic probe depth formula still applies via compute_fok_probe_depth.
    if query_type == "definition":
        # Definition has generous depth (5 from launch, independent levels)
        return fok_check_definition(
            neo4j_session=neo4j_session,
            subject_node_id=subject_node_id,
            current_max_depth=5,  # definition gets depth=5 from launch
            e5_prerequisite_met=e5_prerequisite_met,
            min_edge_count=min_edge_count,
            min_confidence=min_confidence,
        )

    elif query_type == "classification":
        # Classification uses depth=5 default (IS_A only)
        return fok_check_classification(
            neo4j_session=neo4j_session,
            subject_node_id=subject_node_id,
            current_max_depth=5,  # classification starts at depth=5
            e5_prerequisite_met=e5_prerequisite_met,
            min_edge_count=min_edge_count,
            min_confidence=min_confidence,
        )

    elif query_type == "inference":
        return fok_check_inference(
            neo4j_session=neo4j_session,
            subject_node_id=subject_node_id,
            target_node_id=target_node_id,
            current_max_depth=current_max_depth,
            e5_prerequisite_met=e5_prerequisite_met,
            min_edge_count=min_edge_count,
            min_confidence=min_confidence,
        )

    else:
        # Unknown query type -- conservatively return feasible so we do not
        # block unknown future query types. Log a warning.
        _log.warning(
            "fok_check: unknown query_type=%r -- defaulting to feasible",
            query_type,
        )
        return FOKProbeResult(
            feasible=True,
            edge_count=0,
            max_confidence=0.0,
            distinct_edge_types=0,
            probe_depth_used=0,
            probe_time_ms=0.0,
            reason=f"unknown query_type '{query_type}' -- defaulting feasible",
            subject_node_id=subject_node_id,
            target_node_id=target_node_id,
            query_type=query_type,
            gated_by_e5=False,
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    "FOKAccuracyTracker",
    "FOKProbeResult",
    "FOK_E3_DEPTH_CAP",
    "FOK_MIN_CONFIDENCE",
    "FOK_MIN_EDGE_COUNT",
    "FOK_PROBE_MAX",
    "compute_fok_probe_depth",
    "fok_check",
    "fok_check_classification",
    "fok_check_definition",
    "fok_check_inference",
]

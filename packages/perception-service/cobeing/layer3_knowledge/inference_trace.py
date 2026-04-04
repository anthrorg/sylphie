"""SemanticInferenceTrace nodes for A.19 reasoning trace persistence.

Phase 1.8, P1.8-E3/T001.

Implements first-class graph artifacts for semantic inference reasoning paths
as required by CANON A.19: "problem-solving traces are first-class graph
artifacts, not ephemeral LLM chain-of-thought."

Design (from agent discussion resolution in discussion-resolutions-final.md):
  - Single SemanticInferenceTrace node per inference with serialized reasoning
    path (not per-hop nodes). This avoids node explosion on multi-hop inference
    while keeping the full chain queryable via JSON properties.
  - Immediate write after traversal completion (synchronous, not async).
  - USED_FACT edges create a reverse index from trace to every semantic edge
    the inference relied on. When a USED_FACT target edge is corrected or
    retracted, ``query_traces_using_edge`` finds all affected traces for
    cascade invalidation.

Node schema:
  - node_type: ``SemanticInferenceTrace``
  - schema_level: INSTANCE (each trace is a concrete observation of reasoning)
  - provenance: INFERRED (A.19.1)
  - Properties:
      query_id         -- unique identifier for this inference query invocation
      query_type       -- "definition_query" | "classification_query" | "inference_query"
      subject_node_id  -- the node_id of the entity being queried about
      target_node_id   -- the node_id of the inference target (may be None for definitions)
      reasoning_path   -- JSON-serialized list of reasoning steps
      termination_reason -- why traversal stopped (from TerminationReason enum)
      confidence       -- final confidence of the inference result
      depth_reached    -- how many hops deep the traversal went
      path_found_but_truncated -- True if DEPTH_LIMIT_REACHED with live frontier
      truncation_depth -- depth at which truncation occurred (None if not truncated)
      continuation_available_at_depth -- next depth that could continue (None if N/A)
      execution_time_ms -- wall-clock time for the traversal
      session_id       -- conversation session this trace belongs to

Edge types:
  - REASONED_ABOUT: trace -> subject node (what entity the inference was about)
  - CONCLUDED:      trace -> result node (what entity/fact the inference concluded)
  - USED_FACT:      trace -> semantic edge source node (reverse index per edge used)
      Properties: edge_id (the semantic edge_id used), edge_type, hop_position

Usage::

    from cobeing.layer3_knowledge.inference_trace import (
        InferenceTraceWriter,
        ReasoningStep,
        query_traces_using_edge,
        query_traces_for_node,
    )

    writer = InferenceTraceWriter(persistence)
    trace_id = await writer.record_trace(
        query_id="q-001",
        query_type="inference_query",
        subject_node_id="ws:cat",
        target_node_id="ws:breathe_air",
        reasoning_steps=[
            ReasoningStep(
                hop=0,
                source_node_id="ws:cat",
                edge_type="IS_A",
                edge_id="edge:cat-animal",
                target_node_id="ws:animal",
                edge_confidence=0.95,
            ),
            ReasoningStep(
                hop=1,
                source_node_id="ws:animal",
                edge_type="HAS_PROPERTY",
                edge_id="edge:animal-breathe",
                target_node_id="ws:breathe_air",
                edge_confidence=0.90,
            ),
        ],
        termination_reason="answer_found",
        confidence=0.855,
        depth_reached=2,
        execution_time_ms=12.5,
        session_id="session-abc",
    )

CANON compliance:
  A.19   -- reasoning traces as first-class graph artifacts
  A.19.1 -- INFERRED provenance for reasoning steps
  A.19.2 -- graph holds the reasoning work, guardian sees conclusions
  A.11   -- provenance on every node and edge
  A.1    -- traces are derived from observed/taught semantic edges (experience-first)
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

import neo4j

from cobeing.layer3_knowledge.exceptions import KnowledgeGraphError
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Node and edge type constants
# ---------------------------------------------------------------------------

SEMANTIC_INFERENCE_TRACE = "SemanticInferenceTrace"
"""INSTANCE-level node: a first-class record of one semantic inference traversal.

node_id format: trace:{uuid4}.
Provenance: INFERRED (A.19.1).
Properties: query_id, query_type, subject_node_id, target_node_id,
reasoning_path (JSON), termination_reason, confidence, depth_reached,
path_found_but_truncated, truncation_depth, continuation_available_at_depth,
execution_time_ms, session_id."""

REASONED_ABOUT = "REASONED_ABOUT"
"""Edge from SemanticInferenceTrace to the subject node (the entity queried).

One REASONED_ABOUT edge per trace, pointing to the WordSenseNode or
ConceptPrimitive that was the subject of the inference query.
Properties: none beyond standard provenance."""

CONCLUDED = "CONCLUDED"
"""Edge from SemanticInferenceTrace to the conclusion node (the result entity).

One CONCLUDED edge per trace (absent if no conclusion was reached, i.e.,
termination_reason is NO_EVIDENCE or DEPTH_LIMIT_REACHED without a result).
Properties: conclusion_confidence (float)."""

USED_FACT = "USED_FACT"
"""Edge from SemanticInferenceTrace to a node that was the source of a
semantic edge used during the inference.

One USED_FACT edge per semantic edge traversed. This is the reverse index
that enables cascade detection: when a semantic edge is corrected or retracted,
querying USED_FACT edges pointing to its source reveals all inference traces
that depended on it.

Properties:
  edge_id:       the edge_id of the semantic edge that was used
  edge_type:     the relationship type of the semantic edge (IS_A, HAS_PROPERTY, etc.)
  hop_position:  the step number in the reasoning chain where this edge was used (0-indexed)
"""


# ---------------------------------------------------------------------------
# Termination reason enum
# ---------------------------------------------------------------------------


class TerminationReason(StrEnum):
    """Why a semantic inference traversal stopped.

    These are categorically distinct states. PT-11 narrates them with
    different language. SemanticInferenceTrace nodes persist the distinction
    for developmental analytics.

    From discussion-resolutions-final.md (T1.2 resolution):
      NO_EVIDENCE: graph exhausted, no path leads toward target
      DEPTH_LIMIT_REACHED: frontier non-empty when depth cap fired
    """

    ANSWER_FOUND = "answer_found"
    NO_EVIDENCE = "no_evidence"
    DEPTH_LIMIT_REACHED = "depth_limit_reached"
    CONFIDENCE_FLOOR = "confidence_floor"
    CYCLE_DETECTED = "cycle_detected"
    TRAVERSAL_TIMEOUT = "traversal_timeout"
    WORKING_MEMORY_EXHAUSTED = "working_memory_exhausted"


# ---------------------------------------------------------------------------
# Reasoning step data structure
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReasoningStep:
    """One hop in a semantic inference reasoning chain.

    These are serialized to JSON and stored in the SemanticInferenceTrace
    node's ``reasoning_path`` property. They are NOT individual graph nodes
    (single-node design per agent discussion resolution).

    Attributes:
        hop: Position in the chain (0-indexed).
        source_node_id: The node_id where this hop started.
        edge_type: The semantic relationship type traversed.
        edge_id: The edge_id of the semantic edge traversed.
        target_node_id: The node_id where this hop ended.
        edge_confidence: Confidence of the traversed edge.
        scope_context_count: Generalization count on the traversed edge.
    """

    hop: int
    source_node_id: str
    edge_type: str
    edge_id: str
    target_node_id: str
    edge_confidence: float
    scope_context_count: int = 0


# ---------------------------------------------------------------------------
# Trace result data structure (returned by the writer)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class InferenceTraceResult:
    """Outcome of recording a SemanticInferenceTrace.

    Attributes:
        trace_node_id: The node_id of the created trace node.
        used_fact_edges_created: Number of USED_FACT edges created.
        reasoned_about_created: Whether the REASONED_ABOUT edge was created.
        concluded_created: Whether the CONCLUDED edge was created.
    """

    trace_node_id: str
    used_fact_edges_created: int
    reasoned_about_created: bool
    concluded_created: bool


# ---------------------------------------------------------------------------
# Cascade detection result
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AffectedTrace:
    """A trace affected by a corrected or retracted semantic edge.

    Returned by ``query_traces_using_edge`` for cascade detection.

    Attributes:
        trace_node_id: node_id of the affected SemanticInferenceTrace.
        query_id: The query_id stored on the trace.
        query_type: The query_type stored on the trace.
        hop_position: Where in the reasoning chain the affected edge was used.
        trace_confidence: The overall confidence of the trace's conclusion.
        created_at: When the trace was created.
    """

    trace_node_id: str
    query_id: str
    query_type: str
    hop_position: int
    trace_confidence: float
    created_at: str


# ---------------------------------------------------------------------------
# Provenance helper
# ---------------------------------------------------------------------------


def _inferred_provenance(confidence: float, source_id: str) -> Provenance:
    """Build INFERRED provenance for a trace node or edge (A.19.1)."""
    return Provenance(
        source=ProvenanceSource.INFERENCE,
        source_id=source_id,
        confidence=min(max(confidence, 0.0), 1.0),
    )


# ---------------------------------------------------------------------------
# InferenceTraceWriter
# ---------------------------------------------------------------------------


class InferenceTraceWriter:
    """Writes SemanticInferenceTrace nodes with edges to the knowledge graph.

    Immediate write after traversal completion (not async/deferred).
    Uses the GraphPersistence protocol for storage-backend independence.

    Usage::

        writer = InferenceTraceWriter(persistence)
        result = await writer.record_trace(
            query_id="q-001",
            query_type="inference_query",
            ...
        )
    """

    def __init__(self, persistence: GraphPersistence) -> None:
        self._persistence = persistence

    async def record_trace(
        self,
        *,
        query_id: str,
        query_type: str,
        subject_node_id: str,
        reasoning_steps: list[ReasoningStep],
        termination_reason: str | TerminationReason,
        confidence: float,
        depth_reached: int,
        execution_time_ms: float,
        session_id: str,
        target_node_id: str | None = None,
        path_found_but_truncated: bool = False,
        truncation_depth: int | None = None,
        continuation_available_at_depth: int | None = None,
        concluded_node_id: str | None = None,
        conclusion_confidence: float | None = None,
    ) -> InferenceTraceResult:
        """Record a complete semantic inference trace as graph artifacts.

        This method writes synchronously (immediate write after traversal
        completion) per the Canon agreement in discussion-resolutions-final.md.

        Creates:
          1. One SemanticInferenceTrace node with INFERRED provenance
          2. One REASONED_ABOUT edge (trace -> subject)
          3. Zero or one CONCLUDED edge (trace -> conclusion, if conclusion exists)
          4. N USED_FACT edges (trace -> source nodes of each edge traversed)

        Args:
            query_id: Unique identifier for this query invocation.
            query_type: "definition_query", "classification_query", or "inference_query".
            subject_node_id: The node_id of the entity being queried about.
            reasoning_steps: Ordered list of hops in the reasoning chain.
            termination_reason: Why traversal stopped (TerminationReason value).
            confidence: Final confidence of the inference result.
            depth_reached: How many hops deep the traversal went.
            execution_time_ms: Wall-clock time for the traversal.
            session_id: Conversation session this trace belongs to.
            target_node_id: The inference target node_id (None for definitions).
            path_found_but_truncated: True if DEPTH_LIMIT_REACHED with live frontier.
            truncation_depth: Depth at which truncation occurred.
            continuation_available_at_depth: Next depth that could continue.
            concluded_node_id: The node_id of the conclusion entity (if any).
            conclusion_confidence: Confidence of the conclusion (if any).

        Returns:
            InferenceTraceResult with creation counts.

        Raises:
            KnowledgeGraphError: If any graph write fails.
        """
        trace_uuid = str(uuid.uuid4())
        trace_node_id = NodeId(f"trace:{trace_uuid}")
        source_id = f"semantic-inference-{query_id}"

        # Normalize termination_reason to string
        term_reason_str = str(termination_reason)

        # Serialize reasoning steps to JSON
        reasoning_path_json = json.dumps(
            [asdict(step) for step in reasoning_steps],
            default=str,
        )

        # --- 1. Create SemanticInferenceTrace node ---
        trace_node = KnowledgeNode(
            node_id=trace_node_id,
            node_type=SEMANTIC_INFERENCE_TRACE,
            schema_level=SchemaLevel.INSTANCE,
            properties={
                "query_id": query_id,
                "query_type": query_type,
                "subject_node_id": subject_node_id,
                "target_node_id": target_node_id or "",
                "reasoning_path": reasoning_path_json,
                "termination_reason": term_reason_str,
                "depth_reached": depth_reached,
                "path_found_but_truncated": path_found_but_truncated,
                "truncation_depth": truncation_depth if truncation_depth is not None else -1,
                "continuation_available_at_depth": (
                    continuation_available_at_depth
                    if continuation_available_at_depth is not None
                    else -1
                ),
                "execution_time_ms": execution_time_ms,
                "session_id": session_id,
                "steps_count": len(reasoning_steps),
                "used_edge_ids": json.dumps(
                    [step.edge_id for step in reasoning_steps]
                ),
            },
            provenance=_inferred_provenance(confidence, source_id),
            confidence=confidence,
            status=NodeStatus.ACTIVE,
        )

        try:
            await self._persistence.save_node(trace_node)
        except Exception as exc:
            raise KnowledgeGraphError(
                f"Failed to save SemanticInferenceTrace node "
                f"'{trace_node_id}': {exc}"
            ) from exc

        _log.info(
            "inference_trace: created trace node %s (query_type=%s, "
            "termination=%s, steps=%d, confidence=%.3f)",
            trace_node_id,
            query_type,
            term_reason_str,
            len(reasoning_steps),
            confidence,
        )

        # --- 2. Create REASONED_ABOUT edge (trace -> subject) ---
        reasoned_about_created = False
        reasoned_about_edge = KnowledgeEdge(
            edge_id=EdgeId(f"edge:reasoned_about:{trace_uuid}"),
            source_id=trace_node_id,
            target_id=NodeId(subject_node_id),
            edge_type=REASONED_ABOUT,
            properties={},
            provenance=_inferred_provenance(confidence, source_id),
            confidence=confidence,
        )
        try:
            await self._persistence.save_edge(reasoned_about_edge)
            reasoned_about_created = True
        except Exception as exc:
            _log.warning(
                "inference_trace: failed to save REASONED_ABOUT edge "
                "from %s to %s: %s",
                trace_node_id,
                subject_node_id,
                exc,
            )

        # --- 3. Create CONCLUDED edge (trace -> conclusion, if present) ---
        concluded_created = False
        if concluded_node_id is not None:
            concluded_edge = KnowledgeEdge(
                edge_id=EdgeId(f"edge:concluded:{trace_uuid}"),
                source_id=trace_node_id,
                target_id=NodeId(concluded_node_id),
                edge_type=CONCLUDED,
                properties={
                    "conclusion_confidence": (
                        conclusion_confidence
                        if conclusion_confidence is not None
                        else confidence
                    ),
                },
                provenance=_inferred_provenance(confidence, source_id),
                confidence=confidence,
            )
            try:
                await self._persistence.save_edge(concluded_edge)
                concluded_created = True
            except Exception as exc:
                _log.warning(
                    "inference_trace: failed to save CONCLUDED edge "
                    "from %s to %s: %s",
                    trace_node_id,
                    concluded_node_id,
                    exc,
                )

        # --- 4. Create USED_FACT edges (trace -> source of each semantic edge) ---
        used_fact_count = 0
        for step in reasoning_steps:
            used_fact_edge = KnowledgeEdge(
                edge_id=EdgeId(
                    f"edge:used_fact:{trace_uuid}:{step.hop}"
                ),
                source_id=trace_node_id,
                target_id=NodeId(step.source_node_id),
                edge_type=USED_FACT,
                properties={
                    "edge_id": step.edge_id,
                    "edge_type": step.edge_type,
                    "hop_position": step.hop,
                },
                provenance=_inferred_provenance(confidence, source_id),
                confidence=confidence,
            )
            try:
                await self._persistence.save_edge(used_fact_edge)
                used_fact_count += 1
            except Exception as exc:
                _log.warning(
                    "inference_trace: failed to save USED_FACT edge "
                    "for hop %d (edge_id=%s): %s",
                    step.hop,
                    step.edge_id,
                    exc,
                )

        _log.info(
            "inference_trace: trace %s complete -- "
            "reasoned_about=%s, concluded=%s, used_facts=%d",
            trace_node_id,
            reasoned_about_created,
            concluded_created,
            used_fact_count,
        )

        return InferenceTraceResult(
            trace_node_id=str(trace_node_id),
            used_fact_edges_created=used_fact_count,
            reasoned_about_created=reasoned_about_created,
            concluded_created=concluded_created,
        )


# ---------------------------------------------------------------------------
# Neo4j direct query functions (for cascade detection and trace retrieval)
# ---------------------------------------------------------------------------


def query_traces_using_edge(
    session: neo4j.Session,
    *,
    edge_id: str,
) -> list[AffectedTrace]:
    """Find all SemanticInferenceTrace nodes that used a specific semantic edge.

    This is the USED_FACT reverse index query that enables cascade detection.
    When a semantic edge is corrected or retracted, this function identifies
    all inference traces that depended on that edge, so their conclusions can
    be flagged as potentially invalid.

    The query matches USED_FACT edges where the ``edge_id`` property matches
    the corrected edge, then returns the trace node's metadata.

    Args:
        session: An open Neo4j session.
        edge_id: The edge_id of the semantic edge that was corrected/retracted.

    Returns:
        List of AffectedTrace objects, one per trace that used the edge.
        Empty list if no traces used the edge.

    Raises:
        KnowledgeGraphError: If the Neo4j query fails.
    """
    cypher = (
        "MATCH (trace:SemanticInferenceTrace)-[uf:USED_FACT]->(source) "
        "WHERE uf.prop_edge_id = $edge_id "
        "RETURN trace.node_id AS trace_node_id, "
        "       trace.prop_query_id AS query_id, "
        "       trace.prop_query_type AS query_type, "
        "       uf.prop_hop_position AS hop_position, "
        "       trace.confidence AS trace_confidence, "
        "       toString(trace.created_at) AS created_at "
        "ORDER BY trace.created_at DESC"
    )
    try:

        def _run(tx: neo4j.ManagedTransaction) -> list[dict[str, Any]]:
            result = tx.run(cypher, edge_id=edge_id)
            return [dict(record) for record in result]

        records = session.execute_read(_run)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"query_traces_using_edge failed for edge_id={edge_id!r}: {exc}"
        ) from exc

    traces: list[AffectedTrace] = []
    for rec in records:
        traces.append(
            AffectedTrace(
                trace_node_id=rec.get("trace_node_id", ""),
                query_id=rec.get("query_id", ""),
                query_type=rec.get("query_type", ""),
                hop_position=int(rec.get("hop_position", 0)),
                trace_confidence=float(rec.get("trace_confidence", 0.0)),
                created_at=rec.get("created_at", ""),
            )
        )

    _log.debug(
        "query_traces_using_edge: edge_id=%s -> %d affected traces",
        edge_id,
        len(traces),
    )
    return traces


def query_traces_for_node(
    session: neo4j.Session,
    *,
    node_id: str,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Find all SemanticInferenceTrace nodes that reasoned about a specific node.

    This query follows REASONED_ABOUT edges in reverse to find all traces
    where the given node was the subject of an inference query.

    Args:
        session: An open Neo4j session.
        node_id: The node_id of the entity to find traces for.
        limit: Maximum number of traces to return. Default 50.

    Returns:
        List of dicts with trace metadata (trace_node_id, query_id,
        query_type, termination_reason, confidence, depth_reached,
        created_at, steps_count).

    Raises:
        KnowledgeGraphError: If the Neo4j query fails.
    """
    cypher = (
        "MATCH (trace:SemanticInferenceTrace)-[:REASONED_ABOUT]->(subject) "
        "WHERE subject.node_id = $node_id "
        "RETURN trace.node_id AS trace_node_id, "
        "       trace.prop_query_id AS query_id, "
        "       trace.prop_query_type AS query_type, "
        "       trace.prop_termination_reason AS termination_reason, "
        "       trace.confidence AS confidence, "
        "       trace.prop_depth_reached AS depth_reached, "
        "       toString(trace.created_at) AS created_at, "
        "       trace.prop_steps_count AS steps_count "
        "ORDER BY trace.created_at DESC "
        "LIMIT $limit"
    )
    try:

        def _run(tx: neo4j.ManagedTransaction) -> list[dict[str, Any]]:
            result = tx.run(cypher, node_id=node_id, limit=limit)
            return [dict(record) for record in result]

        records = session.execute_read(_run)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"query_traces_for_node failed for node_id={node_id!r}: {exc}"
        ) from exc

    _log.debug(
        "query_traces_for_node: node_id=%s -> %d traces",
        node_id,
        len(records),
    )
    return records


def query_trace_by_query_id(
    session: neo4j.Session,
    *,
    query_id: str,
) -> dict[str, Any] | None:
    """Retrieve a single SemanticInferenceTrace by its query_id.

    Args:
        session: An open Neo4j session.
        query_id: The query_id to look up.

    Returns:
        Dict with all trace properties, or None if not found.

    Raises:
        KnowledgeGraphError: If the Neo4j query fails.
    """
    cypher = (
        "MATCH (trace:SemanticInferenceTrace) "
        "WHERE trace.prop_query_id = $query_id "
        "RETURN trace "
        "LIMIT 1"
    )
    try:

        def _run(tx: neo4j.ManagedTransaction) -> dict[str, Any] | None:
            result = tx.run(cypher, query_id=query_id)
            record = result.single()
            if record is None:
                return None
            node = record["trace"]
            return dict(node)

        return session.execute_read(_run)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"query_trace_by_query_id failed for query_id={query_id!r}: {exc}"
        ) from exc


def invalidate_traces_using_edge(
    session: neo4j.Session,
    *,
    edge_id: str,
    reason: str = "source_edge_corrected",
) -> int:
    """Mark all traces that used a corrected semantic edge as SUPERSEDED.

    This is the cascade invalidation operation. When a semantic edge is
    corrected or retracted, all inference traces that depended on it are
    marked SUPERSEDED with a ``invalidation_reason`` property.

    The traces are not deleted (deprecation, not deletion -- Atlas Rule from
    agent profile section 3.6).

    Args:
        session: An open Neo4j session.
        edge_id: The edge_id of the corrected/retracted semantic edge.
        reason: Why the traces are being invalidated.

    Returns:
        Number of traces invalidated.

    Raises:
        KnowledgeGraphError: If the Neo4j write fails.
    """
    cypher = (
        "MATCH (trace:SemanticInferenceTrace)-[uf:USED_FACT]->(source) "
        "WHERE uf.prop_edge_id = $edge_id "
        "  AND trace.status <> 'superseded' "
        "SET trace.status = 'superseded', "
        "    trace.prop_invalidation_reason = $reason, "
        "    trace.valid_to = datetime() "
        "RETURN count(trace) AS invalidated_count"
    )
    try:

        def _run(tx: neo4j.ManagedTransaction) -> int:
            result = tx.run(cypher, edge_id=edge_id, reason=reason)
            record = result.single()
            return int(record["invalidated_count"]) if record else 0

        count = session.execute_write(_run)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"invalidate_traces_using_edge failed for edge_id={edge_id!r}: {exc}"
        ) from exc

    if count > 0:
        _log.info(
            "inference_trace: invalidated %d traces due to edge %s correction "
            "(reason=%s)",
            count,
            edge_id,
            reason,
        )
    return count


def count_traces_by_session(
    session: neo4j.Session,
    *,
    session_id: str,
) -> dict[str, int]:
    """Count inference traces grouped by termination reason for a session.

    Useful for developmental analytics: how many truncations vs genuine
    absences vs successful answers per session.

    Args:
        session: An open Neo4j session.
        session_id: The session_id to count traces for.

    Returns:
        Dict mapping termination_reason -> count.

    Raises:
        KnowledgeGraphError: If the Neo4j query fails.
    """
    cypher = (
        "MATCH (trace:SemanticInferenceTrace) "
        "WHERE trace.prop_session_id = $session_id "
        "RETURN trace.prop_termination_reason AS reason, "
        "       count(trace) AS cnt"
    )
    try:

        def _run(tx: neo4j.ManagedTransaction) -> dict[str, int]:
            result = tx.run(cypher, session_id=session_id)
            counts: dict[str, int] = {}
            for record in result:
                reason = record["reason"] or "unknown"
                counts[reason] = int(record["cnt"])
            return counts

        return session.execute_read(_run)
    except Exception as exc:
        raise KnowledgeGraphError(
            f"count_traces_by_session failed for session_id={session_id!r}: "
            f"{exc}"
        ) from exc


__all__ = [
    # Constants
    "SEMANTIC_INFERENCE_TRACE",
    "REASONED_ABOUT",
    "CONCLUDED",
    "USED_FACT",
    # Enums
    "TerminationReason",
    # Data structures
    "ReasoningStep",
    "InferenceTraceResult",
    "AffectedTrace",
    # Writer
    "InferenceTraceWriter",
    # Query functions
    "query_traces_using_edge",
    "query_traces_for_node",
    "query_trace_by_query_id",
    "invalidate_traces_using_edge",
    "count_traces_by_session",
]

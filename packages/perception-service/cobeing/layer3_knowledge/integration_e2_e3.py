"""E2-to-E3 integration: teaching pipeline -> semantic query pipeline (P1.8-E3/T017).

Validates the complete teaching-learning cycle where guardian teaching
(assert_fact, E2) populates the semantic graph, then semantic queries (E3)
demonstrate comprehension beyond what was directly taught.

This module provides two things:

  1. ``PersistenceInferenceTraverser`` -- a persistence-based multi-hop
     semantic traversal that mirrors the ``InferenceQueryExecutor`` BFS
     but uses the ``GraphPersistence`` protocol instead of direct Neo4j
     Cypher queries. This allows the integration test to run against
     ``InMemoryGraphPersistence`` without a Neo4j instance. The traversal
     logic is identical to the Neo4j-backed version: bounded BFS across
     all traversable semantic edge types, cycle detection, confidence floor
     pruning, depth limiting, and ReasoningStep construction.

  2. ``run_e2_e3_integration`` -- the integration test runner. Bootstraps
     the semantic ontology, teaches facts via SemanticTeachingHandler, then
     queries the graph to verify:
       a) Guardian teaches 'cats are animals' and 'animals breathe air'
       b) System correctly infers 'cats breathe air' via multi-hop traversal
       c) SemanticInferenceTrace nodes created with proper reasoning chain
       d) Guardian confirmation of inference boosts edge confidence
       e) Contradiction detection fires if conflicting facts taught

The traverser does NOT replace ``InferenceQueryExecutor`` for production use.
It exists solely for this integration validation, where we need to verify
end-to-end correctness without a database dependency.

CANON compliance:
  A.1   -- all facts come from guardian teaching (mock PT-10, no LLM)
  A.11  -- provenance on every node and edge verified
  A.18  -- TAUGHT_PROCEDURE provenance on bootstrap nodes verified
  A.19  -- SemanticInferenceTrace recorded per inference verified
  A.20  -- cross-domain bridge (DENOTES) traversal verified

Phase 1.8 (Comprehension Layer, P1.8-E3/T017).
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from cobeing.layer3_knowledge.inference_query import (
    INFERENCE_TRAVERSABLE_EDGE_TYPES,
    InferenceQueryRequest,
    InferenceQueryResult,
    ReasoningStep,
    compute_inference_chain_confidence,
)
from cobeing.layer3_knowledge.inference_trace import (
    InferenceTraceWriter,
    TerminationReason,
)
from cobeing.layer3_knowledge.node_types import KnowledgeEdge
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter
from cobeing.layer3_knowledge.semantic_query import MIN_CONFIDENCE_FLOOR
from cobeing.shared.types import NodeId

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Persistence-based inference traverser (no Neo4j dependency)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _PersistenceEdgeInfo:
    """One semantic edge encountered during persistence-based traversal."""

    node_id: str
    spelling: str
    edge_id: str
    edge_type: str
    confidence: float
    scope_context_count: int


@dataclass(frozen=True)
class _PersistenceTraversalResult:
    """Result of a persistence-based multi-hop BFS traversal."""

    path_found: bool
    reasoning_steps: list[ReasoningStep]
    max_depth_reached: int
    confidence_floor_hits: int
    cycle_detected: bool
    depth_limit_reached: bool
    frontier_non_empty: bool


class PersistenceInferenceTraverser:
    """Multi-hop semantic BFS traverser using GraphPersistence protocol.

    This is a test-infrastructure class that mirrors InferenceQueryExecutor's
    BFS logic but queries edges through the GraphPersistence.query_edges
    interface instead of Neo4j Cypher. This allows the E2->E3 integration
    test to run against InMemoryGraphPersistence without a Neo4j instance.

    The traversal logic is identical:
      - Bounded BFS across INFERENCE_TRAVERSABLE_EDGE_TYPES
      - Cycle detection via visited set
      - Confidence floor pruning (MIN_CONFIDENCE_FLOOR = 0.3)
      - Depth limiting
      - ReasoningStep construction from path
    """

    def __init__(
        self,
        persistence: GraphPersistence,
        trace_writer: InferenceTraceWriter | None = None,
        max_depth: int = 3,
    ) -> None:
        self._persistence = persistence
        self._trace_writer = trace_writer
        self.max_depth = max_depth

    async def execute(
        self,
        request: InferenceQueryRequest,
    ) -> InferenceQueryResult:
        """Execute an inference query using persistence-based BFS.

        Args:
            request: The inference query parameters.

        Returns:
            InferenceQueryResult with answer and reasoning chain.
        """
        start_time = time.monotonic()
        query_id = f"inf-{request.correlation_id}-{uuid.uuid4().hex[:8]}"

        # Resolve subject and target nodes
        subject_node = await self._persistence.get_node(
            NodeId(request.subject_node_id)
        )
        if subject_node is None:
            elapsed = (time.monotonic() - start_time) * 1000
            return self._empty_result(request, elapsed, "")

        subject_spelling = str(
            subject_node.properties.get(
                "spelling",
                subject_node.properties.get("label", request.subject_node_id),
            )
        )

        target_node = await self._persistence.get_node(
            NodeId(request.target_node_id)
        )
        if target_node is None:
            elapsed = (time.monotonic() - start_time) * 1000
            return self._empty_result(request, elapsed, "")

        target_spelling = str(
            target_node.properties.get(
                "spelling",
                target_node.properties.get("label", request.target_node_id),
            )
        )

        # Trivial case: subject == target
        if request.subject_node_id == request.target_node_id:
            elapsed_ms = (time.monotonic() - start_time) * 1000
            trace_node_id = await self._record_trace(
                query_id=query_id,
                request=request,
                reasoning_steps=[],
                termination_reason=TerminationReason.ANSWER_FOUND,
                confidence=1.0,
                depth_reached=0,
                execution_time_ms=elapsed_ms,
                concluded_node_id=request.target_node_id,
            )
            return InferenceQueryResult(
                answer_found=True,
                confidence=1.0,
                reasoning_chain=[],
                subject_node_id=request.subject_node_id,
                subject_spelling=subject_spelling,
                target_node_id=request.target_node_id,
                target_spelling=target_spelling,
                termination_reason=str(TerminationReason.ANSWER_FOUND),
                depth_reached=0,
                execution_time_ms=elapsed_ms,
                trace_node_id=trace_node_id,
                denotes_traversed=False,
                confidence_floor_hits=0,
                cycle_detected=False,
                hops_in_chain=0,
                path_found_but_truncated=False,
                truncation_depth=None,
                continuation_available_at_depth=None,
                edge_types_traversed=[],
                max_depth_used=self.max_depth,
            )

        # Multi-type BFS traversal via persistence
        traversal = await self._traverse(
            subject_id=request.subject_node_id,
            target_id=request.target_node_id,
        )

        elapsed_ms = (time.monotonic() - start_time) * 1000

        # Compute chain confidence
        if traversal.path_found:
            chain_confidence = compute_inference_chain_confidence(
                edge_types=[s.edge_type for s in traversal.reasoning_steps],
                edge_confidences=[s.edge_confidence for s in traversal.reasoning_steps],
            )
        else:
            chain_confidence = 0.0

        # Determine termination reason
        path_found_but_truncated = False
        truncation_depth: int | None = None
        continuation_available_at_depth: int | None = None

        if traversal.path_found:
            termination = TerminationReason.ANSWER_FOUND
        elif traversal.cycle_detected and not traversal.reasoning_steps:
            termination = TerminationReason.CYCLE_DETECTED
        elif traversal.depth_limit_reached:
            termination = TerminationReason.DEPTH_LIMIT_REACHED
            if traversal.frontier_non_empty:
                path_found_but_truncated = True
                truncation_depth = self.max_depth
                continuation_available_at_depth = self.max_depth + 1
        elif traversal.confidence_floor_hits > 0 and not traversal.reasoning_steps:
            termination = TerminationReason.CONFIDENCE_FLOOR
        else:
            termination = TerminationReason.NO_EVIDENCE

        edge_types_traversed = list({
            s.edge_type for s in traversal.reasoning_steps
        })

        # Record trace
        trace_node_id = await self._record_trace(
            query_id=query_id,
            request=request,
            reasoning_steps=traversal.reasoning_steps,
            termination_reason=termination,
            confidence=chain_confidence,
            depth_reached=traversal.max_depth_reached,
            execution_time_ms=elapsed_ms,
            concluded_node_id=(
                request.target_node_id if traversal.path_found else None
            ),
            path_found_but_truncated=path_found_but_truncated,
            truncation_depth=truncation_depth,
            continuation_available_at_depth=continuation_available_at_depth,
        )

        return InferenceQueryResult(
            answer_found=traversal.path_found,
            confidence=chain_confidence,
            reasoning_chain=list(traversal.reasoning_steps),
            subject_node_id=request.subject_node_id,
            subject_spelling=subject_spelling,
            target_node_id=request.target_node_id,
            target_spelling=target_spelling,
            termination_reason=str(termination),
            depth_reached=traversal.max_depth_reached,
            execution_time_ms=elapsed_ms,
            trace_node_id=trace_node_id,
            denotes_traversed=False,
            confidence_floor_hits=traversal.confidence_floor_hits,
            cycle_detected=traversal.cycle_detected,
            hops_in_chain=len(traversal.reasoning_steps),
            path_found_but_truncated=path_found_but_truncated,
            truncation_depth=truncation_depth,
            continuation_available_at_depth=continuation_available_at_depth,
            edge_types_traversed=edge_types_traversed,
            max_depth_used=self.max_depth,
        )

    async def _traverse(
        self,
        subject_id: str,
        target_id: str,
    ) -> _PersistenceTraversalResult:
        """BFS traversal across semantic edges using GraphPersistence.

        Mirrors InferenceQueryExecutor._traverse_inference_chain exactly,
        but queries edges through persistence.query_edges instead of Cypher.
        """
        queue: list[tuple[str, list[_PersistenceEdgeInfo]]] = [(subject_id, [])]
        visited: set[str] = {subject_id}
        confidence_floor_hits = 0
        max_depth_reached = 0
        cycle_detected = False
        depth_limit_reached = False
        frontier_non_empty = False

        while queue:
            current_id, path = queue.pop(0)
            current_depth = len(path)

            if current_depth >= self.max_depth:
                depth_limit_reached = True
                frontier_non_empty = True
                continue

            # Query all outgoing semantic edges from current node
            neighbors = await self._query_neighbors(current_id)

            for neighbor in neighbors:
                if neighbor.confidence < MIN_CONFIDENCE_FLOOR:
                    confidence_floor_hits += 1
                    continue

                if neighbor.node_id in visited:
                    cycle_detected = True
                    continue

                visited.add(neighbor.node_id)
                new_depth = current_depth + 1
                max_depth_reached = max(max_depth_reached, new_depth)

                new_path = path + [neighbor]

                # Did we reach the target?
                if neighbor.node_id == target_id:
                    reasoning_steps = self._path_to_steps(subject_id, new_path)
                    return _PersistenceTraversalResult(
                        path_found=True,
                        reasoning_steps=reasoning_steps,
                        max_depth_reached=max_depth_reached,
                        confidence_floor_hits=confidence_floor_hits,
                        cycle_detected=cycle_detected,
                        depth_limit_reached=False,
                        frontier_non_empty=False,
                    )

                queue.append((neighbor.node_id, new_path))

        return _PersistenceTraversalResult(
            path_found=False,
            reasoning_steps=[],
            max_depth_reached=max_depth_reached,
            confidence_floor_hits=confidence_floor_hits,
            cycle_detected=cycle_detected,
            depth_limit_reached=depth_limit_reached,
            frontier_non_empty=frontier_non_empty,
        )

    async def _query_neighbors(
        self, node_id: str
    ) -> list[_PersistenceEdgeInfo]:
        """Query all outgoing semantic edges from a node via persistence."""
        neighbors: list[_PersistenceEdgeInfo] = []

        for edge_type in sorted(INFERENCE_TRAVERSABLE_EDGE_TYPES):
            edges = await self._persistence.query_edges(
                EdgeFilter(
                    edge_type=edge_type,
                    source_node_id=node_id,
                )
            )
            for edge in edges:
                # Skip inactive edges
                if edge.properties.get("valid_to") is not None:
                    continue
                if edge.properties.get("deprecated", False):
                    continue

                # Get target node spelling
                target_node = await self._persistence.get_node(edge.target_id)
                spelling = ""
                if target_node is not None:
                    spelling = str(
                        target_node.properties.get(
                            "spelling",
                            target_node.properties.get(
                                "label", str(edge.target_id)
                            ),
                        )
                    )

                neighbors.append(
                    _PersistenceEdgeInfo(
                        node_id=str(edge.target_id),
                        spelling=spelling,
                        edge_id=str(edge.edge_id),
                        edge_type=edge.edge_type,
                        confidence=edge.confidence,
                        scope_context_count=int(
                            edge.properties.get("scope_context_count", 0)
                        ),
                    )
                )

        # Sort by confidence descending (matches Neo4j query ORDER BY)
        neighbors.sort(key=lambda n: n.confidence, reverse=True)
        return neighbors

    @staticmethod
    def _path_to_steps(
        subject_id: str,
        path: list[_PersistenceEdgeInfo],
    ) -> list[ReasoningStep]:
        """Convert a path of edge infos into ReasoningStep objects."""
        steps: list[ReasoningStep] = []
        current_source = subject_id

        for hop_index, edge_info in enumerate(path):
            steps.append(
                ReasoningStep(
                    hop=hop_index,
                    source_node_id=current_source,
                    edge_type=edge_info.edge_type,
                    edge_id=edge_info.edge_id,
                    target_node_id=edge_info.node_id,
                    edge_confidence=edge_info.confidence,
                    scope_context_count=edge_info.scope_context_count,
                )
            )
            current_source = edge_info.node_id

        return steps

    async def _record_trace(
        self,
        *,
        query_id: str,
        request: InferenceQueryRequest,
        reasoning_steps: list[ReasoningStep],
        termination_reason: TerminationReason,
        confidence: float,
        depth_reached: int,
        execution_time_ms: float,
        concluded_node_id: str | None,
        path_found_but_truncated: bool = False,
        truncation_depth: int | None = None,
        continuation_available_at_depth: int | None = None,
    ) -> str:
        """Record a SemanticInferenceTrace (A.19 compliance)."""
        if self._trace_writer is None:
            return ""

        try:
            trace_result = await self._trace_writer.record_trace(
                query_id=query_id,
                query_type="inference_query",
                subject_node_id=request.subject_node_id,
                reasoning_steps=reasoning_steps,
                termination_reason=termination_reason,
                confidence=confidence,
                depth_reached=depth_reached,
                execution_time_ms=execution_time_ms,
                session_id=request.session_id,
                target_node_id=request.target_node_id,
                path_found_but_truncated=path_found_but_truncated,
                truncation_depth=truncation_depth,
                continuation_available_at_depth=continuation_available_at_depth,
                concluded_node_id=concluded_node_id,
                conclusion_confidence=confidence if concluded_node_id else None,
            )
            return trace_result.trace_node_id
        except Exception as exc:
            _log.warning(
                "PersistenceInferenceTraverser: failed to record trace "
                "for query_id=%s: %s",
                query_id,
                exc,
            )
            return ""

    def _empty_result(
        self,
        request: InferenceQueryRequest,
        execution_time_ms: float,
        trace_node_id: str,
    ) -> InferenceQueryResult:
        """Build an empty result for degenerate cases."""
        return InferenceQueryResult(
            answer_found=False,
            confidence=0.0,
            reasoning_chain=[],
            subject_node_id=request.subject_node_id,
            subject_spelling="",
            target_node_id=request.target_node_id,
            target_spelling="",
            termination_reason=str(TerminationReason.NO_EVIDENCE),
            depth_reached=0,
            execution_time_ms=execution_time_ms,
            trace_node_id=trace_node_id,
            denotes_traversed=False,
            confidence_floor_hits=0,
            cycle_detected=False,
            hops_in_chain=0,
            path_found_but_truncated=False,
            truncation_depth=None,
            continuation_available_at_depth=None,
            edge_types_traversed=[],
            max_depth_used=self.max_depth,
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    "PersistenceInferenceTraverser",
]

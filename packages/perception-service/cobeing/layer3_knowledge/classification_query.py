"""Classification query executor for the Co-Being knowledge graph (P1.8-E3/T004).

Implements the ``proc:classification_query`` ProceduralTemplate that answers
"is X a Y?" questions through IS_A hierarchy traversal. This is the second
query type in the developmental sequence (D4: definition -> classification ->
inference), unlocked after 25 successful definition queries demonstrate
competence.

Architecture:

  1. Resolve subject and target nodes to their effective IDs (following
     DENOTES bridge if needed, matching definition_query behavior).
  2. Attempt direct IS_A edge lookup (subject -> target, hop 0).
  3. If no direct edge, perform bounded IS_A chain traversal upward from
     subject, checking each ancestor against the target.
  4. Apply confidence propagation: 5% degradation per IS_A hop, matching
     the IS_A transitivity axiom from the semantic-ontology skill package.
  5. Detect cycles using a visited-node set to prevent infinite loops.
  6. Record a SemanticInferenceTrace (A.19 compliance).
  7. Return a ClassificationQueryResult with boolean answer, confidence,
     and the full reasoning chain.

Confidence propagation formula:

  The classification confidence degrades multiplicatively across IS_A hops:

    chain_confidence = edge_1_confidence * edge_2_confidence * ... * edge_n_confidence
    hop_degradation  = 0.95 ^ n_hops  (5% per hop, matching IS_A transitivity axiom)
    final_confidence = chain_confidence * hop_degradation

  This means a 2-hop classification (cat IS_A animal, animal IS_A living_thing)
  with edge confidences 0.90 and 0.85 would produce:

    chain_confidence = 0.90 * 0.85 = 0.765
    hop_degradation  = 0.95 ^ 2     = 0.9025
    final_confidence = 0.765 * 0.9025 = 0.6904

  The minimum confidence floor (0.3) prunes entire branches: if any edge in
  the chain falls below 0.3, traversal does not continue through it.

Cycle detection:

  IS_A graphs should be acyclic (IS_A asymmetry axiom), but the system
  operates under Open World Assumption and may have temporarily inconsistent
  state during teaching. The traversal maintains a visited set of node_ids
  and immediately terminates any branch that revisits a node. This is O(1)
  per check and prevents infinite loops regardless of graph state.

Developmental gating (Piaget):

  classification_query is not available at bootstrap. It unlocks after the
  system demonstrates competence with definition_query:
    - 25 successful definition queries
    - 3 concept clusters (distinct IS_A root ancestors)
    - 15 guardian confirmations on semantic edges

  These thresholds are stored in the ``rule:classification_gate_config``
  EvolutionRule node and can be tuned by the guardian. The gate check is
  performed by the SemanticQueryHandler (T010/T012), not by this executor
  directly -- separation of concerns: the executor assumes it has been
  authorized to run.

Depth governance (from discussion-resolutions-final.md T1.2):

  classification_query starts with max_depth=5 (matching MAX_TRAVERSAL_DEPTH).
  IS_A chains deeper than 5 hops are unlikely in the early graph and would
  indicate either a very deep taxonomy or a traversal that has gone astray.

  The rule:classification_depth_config EvolutionRule node carries:
    current_max_depth: 5
    confidence_degradation_per_hop: 0.05

CANON compliance:
  A.1   -- all IS_A edges come from guardian teaching or inference
  A.10  -- bounded traversal (max_depth from EvolutionRule)
  A.11  -- provenance on every node and edge
  A.12  -- LLM never sees raw graph; receives only the result object
  A.19  -- SemanticInferenceTrace recorded per query
  A.20  -- cross-domain DENOTES traversal respects domain boundaries

Usage::

    from cobeing.layer3_knowledge.classification_query import (
        ClassificationQueryExecutor,
        ClassificationQueryRequest,
        ClassificationQueryResult,
    )

    executor = ClassificationQueryExecutor(
        persistence=graph,
        neo4j_session=session,
        trace_writer=trace_writer,
    )

    result = await executor.execute(
        ClassificationQueryRequest(
            subject_node_id="word:cat:1",
            target_node_id="word:animal:1",
            session_id="session-001",
            correlation_id="q-002",
        )
    )

    if result.is_classified:
        print(f"Yes! Confidence: {result.confidence:.2f}")
        for step in result.reasoning_chain:
            print(f"  hop {step.hop}: {step.source_node_id} "
                  f"-[{step.edge_type}]-> {step.target_node_id}")
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import neo4j

from cobeing.layer3_knowledge.constants import MAX_TRAVERSAL_DEPTH
from cobeing.layer3_knowledge.exceptions import KnowledgeGraphError
from cobeing.layer3_knowledge.inference_trace import (
    InferenceTraceWriter,
    ReasoningStep,
    TerminationReason,
)
from cobeing.layer3_knowledge.language_types import DENOTES, WORD_SENSE_NODE
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.procedure_types import PROCEDURAL_TEMPLATE
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.semantic_query import (
    MIN_CONFIDENCE_FLOOR,
    SemanticQueryConstraints,
)
from cobeing.layer3_knowledge.semantic_types import IS_A
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CLASSIFICATION_QUERY_TEMPLATE_ID = NodeId("proc:classification_query")
"""NodeId of the classification_query ProceduralTemplate in the graph."""

CLASSIFICATION_QUERY_TEMPLATE_NAME = "classification_query"
"""Human-readable template name for the classification query procedure."""

CLASSIFICATION_DEPTH_RULE_ID = NodeId("rule:classification_depth_config")
"""NodeId of the EvolutionRule governing classification query depth."""

CLASSIFICATION_GATE_RULE_ID = NodeId("rule:classification_gate_config")
"""NodeId of the EvolutionRule governing classification query developmental gating."""

# Default depth config
DEFAULT_CLASSIFICATION_MAX_DEPTH: int = 5

# Confidence degradation per IS_A hop (5% per hop, matching IS_A transitivity axiom).
# Applied multiplicatively: hop_factor = (1 - degradation) ^ n_hops.
DEFAULT_CONFIDENCE_DEGRADATION_PER_HOP: float = 0.05

# Developmental gating thresholds (Piaget D4 progression)
DEFAULT_GATE_DEFINITION_COUNT: int = 25
"""Minimum successful definition queries before classification unlocks."""

DEFAULT_GATE_CONCEPT_CLUSTERS: int = 3
"""Minimum distinct IS_A root ancestors (concept clusters)."""

DEFAULT_GATE_GUARDIAN_CONFIRMATIONS: int = 15
"""Minimum guardian confirmations on semantic edges."""


# ---------------------------------------------------------------------------
# Request / Result data structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ClassificationQueryRequest:
    """Input to ClassificationQueryExecutor.execute().

    Attributes:
        subject_node_id: The node_id of the entity to classify ("is X...").
        target_node_id: The node_id of the category ("...a Y?").
        session_id: Current conversation session identifier.
        correlation_id: Traces this request through logs and provenance.
        activation_map: Optional spreading activation map. Keys are node_ids,
            values are activation boost values (0.0-1.0). Not used for
            classification traversal itself but recorded in the trace.
    """

    subject_node_id: str
    target_node_id: str
    session_id: str
    correlation_id: str
    activation_map: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class ClassificationQueryResult:
    """Result of a classification_query execution.

    Attributes:
        is_classified: True if the subject IS_A target was confirmed
            through the IS_A chain. False otherwise.
        confidence: Overall confidence of the classification. Product of
            all edge confidences in the chain times hop degradation.
            0.0 if not classified.
        reasoning_chain: Ordered list of ReasoningStep objects showing
            the IS_A traversal path from subject to target. Empty if
            not classified.
        subject_node_id: The node_id that was queried as the subject.
        subject_spelling: Human-readable spelling of the subject.
        target_node_id: The node_id that was queried as the category.
        target_spelling: Human-readable spelling of the target.
        termination_reason: Why the traversal stopped.
        depth_reached: Maximum IS_A depth reached during traversal.
        execution_time_ms: Wall-clock time for the query.
        trace_node_id: NodeId of the SemanticInferenceTrace created.
        denotes_traversed: True if DENOTES bridge was used for either
            subject or target resolution.
        confidence_floor_hits: Number of edges pruned by the confidence
            floor during traversal.
        cycle_detected: True if a cycle was found during traversal
            (indicates graph inconsistency).
        hops_in_chain: Number of IS_A hops in the classification chain.
            0 if not classified.
    """

    is_classified: bool
    confidence: float
    reasoning_chain: list[ReasoningStep]
    subject_node_id: str
    subject_spelling: str
    target_node_id: str
    target_spelling: str
    termination_reason: str
    depth_reached: int
    execution_time_ms: float
    trace_node_id: str
    denotes_traversed: bool
    confidence_floor_hits: int
    cycle_detected: bool
    hops_in_chain: int


# ---------------------------------------------------------------------------
# Confidence propagation
# ---------------------------------------------------------------------------


def compute_chain_confidence(
    edge_confidences: list[float],
    degradation_per_hop: float = DEFAULT_CONFIDENCE_DEGRADATION_PER_HOP,
) -> float:
    """Compute the overall confidence for an IS_A classification chain.

    The confidence is the product of all individual edge confidences
    multiplied by a per-hop degradation factor. This captures two
    independent sources of uncertainty:

    1. Each individual IS_A edge may be uncertain (edge confidence < 1.0).
    2. Longer chains are inherently less reliable than shorter ones,
       even if every individual edge is highly confident (epistemic
       distance from direct observation increases with hop count).

    Args:
        edge_confidences: Confidence values for each edge in the chain,
            ordered from subject to target (hop 0 to hop N).
        degradation_per_hop: Confidence loss factor per hop. Default 0.05
            (5% per hop, matching IS_A transitivity axiom).

    Returns:
        Combined confidence in [0.0, 1.0]. Returns 0.0 for empty chains.
    """
    if not edge_confidences:
        return 0.0

    # Product of individual edge confidences
    chain_product = 1.0
    for conf in edge_confidences:
        chain_product *= max(0.0, min(1.0, conf))

    # Hop degradation: (1 - degradation)^n_hops
    n_hops = len(edge_confidences)
    hop_factor = (1.0 - degradation_per_hop) ** n_hops

    result = chain_product * hop_factor
    return max(0.0, min(1.0, result))


# ---------------------------------------------------------------------------
# ClassificationQueryExecutor
# ---------------------------------------------------------------------------


class ClassificationQueryExecutor:
    """Executes classification_query procedures through IS_A chain traversal.

    This executor is Layer 3 infrastructure. It never calls the LLM.
    It traverses the IS_A hierarchy from subject upward, checking each
    ancestor against the target, and returns a structured result that
    PT-11 can narrate.

    The executor reads its depth configuration from the
    ``rule:classification_depth_config`` EvolutionRule node in the graph.
    If the node does not exist, it falls back to the default (depth=5,
    degradation=0.05).

    Attributes:
        persistence: GraphPersistence backend for node/edge reads.
        neo4j_session: Direct Neo4j session for optimized Cypher queries.
        trace_writer: InferenceTraceWriter for A.19 compliance.
        max_depth: Maximum IS_A traversal depth.
        degradation_per_hop: Confidence degradation per IS_A hop.
    """

    def __init__(
        self,
        persistence: GraphPersistence,
        neo4j_session: neo4j.Session,
        trace_writer: InferenceTraceWriter | None = None,
        max_depth: int = DEFAULT_CLASSIFICATION_MAX_DEPTH,
        degradation_per_hop: float = DEFAULT_CONFIDENCE_DEGRADATION_PER_HOP,
    ) -> None:
        self._persistence = persistence
        self._session = neo4j_session
        self._trace_writer = trace_writer
        self.max_depth = max_depth
        self.degradation_per_hop = degradation_per_hop

    @classmethod
    async def from_graph(
        cls,
        persistence: GraphPersistence,
        neo4j_session: neo4j.Session,
        trace_writer: InferenceTraceWriter | None = None,
    ) -> "ClassificationQueryExecutor":
        """Create a ClassificationQueryExecutor with config read from the graph.

        Reads the ``rule:classification_depth_config`` EvolutionRule node to
        obtain the current max_depth and degradation_per_hop. Falls back to
        defaults if the node does not exist.

        Args:
            persistence: GraphPersistence backend.
            neo4j_session: Direct Neo4j session.
            trace_writer: Optional InferenceTraceWriter.

        Returns:
            A configured ClassificationQueryExecutor.
        """
        max_depth = DEFAULT_CLASSIFICATION_MAX_DEPTH
        degradation_per_hop = DEFAULT_CONFIDENCE_DEGRADATION_PER_HOP

        depth_rule = await persistence.get_node(CLASSIFICATION_DEPTH_RULE_ID)
        if depth_rule is not None:
            max_depth = int(
                depth_rule.properties.get(
                    "current_max_depth", DEFAULT_CLASSIFICATION_MAX_DEPTH
                )
            )
            degradation_per_hop = float(
                depth_rule.properties.get(
                    "confidence_degradation_per_hop",
                    DEFAULT_CONFIDENCE_DEGRADATION_PER_HOP,
                )
            )

        return cls(
            persistence=persistence,
            neo4j_session=neo4j_session,
            trace_writer=trace_writer,
            max_depth=min(max_depth, MAX_TRAVERSAL_DEPTH),
            degradation_per_hop=degradation_per_hop,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def execute(
        self,
        request: ClassificationQueryRequest,
    ) -> ClassificationQueryResult:
        """Execute a classification query: "is subject a target?"

        Performs bounded IS_A chain traversal from subject upward,
        checking each ancestor against the target. Uses cycle detection
        and confidence propagation through the chain.

        Steps:
          1. Resolve subject and target nodes, get spellings.
          2. Check for DENOTES bridges if nodes have no direct IS_A edges.
          3. Attempt direct IS_A edge lookup (subject -> target).
          4. If no direct edge, perform BFS over IS_A ancestors.
          5. At each hop, check if current ancestor matches target.
          6. Track visited nodes for cycle detection.
          7. Apply confidence propagation to the chain.
          8. Record SemanticInferenceTrace.
          9. Return ClassificationQueryResult.

        Args:
            request: The classification query parameters.

        Returns:
            ClassificationQueryResult with boolean answer and reasoning.

        Raises:
            KnowledgeGraphError: If graph queries fail.
        """
        start_time = time.monotonic()
        query_id = f"cls-{request.correlation_id}-{uuid.uuid4().hex[:8]}"

        # Step 1: Resolve subject node
        subject_node = await self._persistence.get_node(
            NodeId(request.subject_node_id)
        )
        if subject_node is None:
            elapsed = (time.monotonic() - start_time) * 1000
            return self._empty_result(
                request=request,
                termination_reason=TerminationReason.NO_EVIDENCE,
                execution_time_ms=elapsed,
                trace_node_id="",
            )

        subject_spelling = str(
            subject_node.properties.get(
                "spelling",
                subject_node.properties.get("label", request.subject_node_id),
            )
        )

        # Resolve target node
        target_node = await self._persistence.get_node(
            NodeId(request.target_node_id)
        )
        if target_node is None:
            elapsed = (time.monotonic() - start_time) * 1000
            return self._empty_result(
                request=request,
                termination_reason=TerminationReason.NO_EVIDENCE,
                execution_time_ms=elapsed,
                trace_node_id="",
            )

        target_spelling = str(
            target_node.properties.get(
                "spelling",
                target_node.properties.get("label", request.target_node_id),
            )
        )

        # Step 2: Resolve DENOTES bridges if needed
        denotes_traversed = False
        effective_subject_id = request.subject_node_id
        effective_target_id = request.target_node_id

        # Check if subject needs DENOTES resolution
        if not self._has_is_a_edges(effective_subject_id):
            denotes_target = self._resolve_denotes_target(effective_subject_id)
            if denotes_target is not None:
                denotes_traversed = True
                effective_subject_id = denotes_target
                _log.debug(
                    "classification_query: followed DENOTES bridge for "
                    "subject from %s to %s",
                    request.subject_node_id,
                    effective_subject_id,
                )

        # Check if target needs DENOTES resolution
        if not self._is_target_of_is_a_edges(effective_target_id):
            denotes_target = self._resolve_denotes_target(effective_target_id)
            if denotes_target is not None:
                denotes_traversed = True
                effective_target_id = denotes_target
                _log.debug(
                    "classification_query: followed DENOTES bridge for "
                    "target from %s to %s",
                    request.target_node_id,
                    effective_target_id,
                )

        # Step 3: Trivial case -- subject and target are the same node
        if effective_subject_id == effective_target_id:
            elapsed_ms = (time.monotonic() - start_time) * 1000
            reasoning_chain = []  # type: list[ReasoningStep]
            trace_node_id = await self._record_trace(
                query_id=query_id,
                request=request,
                reasoning_steps=reasoning_chain,
                termination_reason=TerminationReason.ANSWER_FOUND,
                confidence=1.0,
                depth_reached=0,
                execution_time_ms=elapsed_ms,
                concluded_node_id=effective_target_id,
            )
            return ClassificationQueryResult(
                is_classified=True,
                confidence=1.0,
                reasoning_chain=reasoning_chain,
                subject_node_id=request.subject_node_id,
                subject_spelling=subject_spelling,
                target_node_id=request.target_node_id,
                target_spelling=target_spelling,
                termination_reason=str(TerminationReason.ANSWER_FOUND),
                depth_reached=0,
                execution_time_ms=elapsed_ms,
                trace_node_id=trace_node_id,
                denotes_traversed=denotes_traversed,
                confidence_floor_hits=0,
                cycle_detected=False,
                hops_in_chain=0,
            )

        # Step 4: Perform IS_A chain traversal (BFS with cycle detection)
        traversal_result = self._traverse_is_a_chain(
            subject_id=effective_subject_id,
            target_id=effective_target_id,
        )

        elapsed_ms = (time.monotonic() - start_time) * 1000

        # Step 5: Compute chain confidence if path was found
        if traversal_result.path_found:
            edge_confidences = [
                step.edge_confidence
                for step in traversal_result.reasoning_steps
            ]
            chain_confidence = compute_chain_confidence(
                edge_confidences=edge_confidences,
                degradation_per_hop=self.degradation_per_hop,
            )
        else:
            chain_confidence = 0.0

        # Determine termination reason
        if traversal_result.path_found:
            termination = TerminationReason.ANSWER_FOUND
        elif traversal_result.cycle_detected:
            termination = TerminationReason.CYCLE_DETECTED
        elif traversal_result.depth_limit_reached:
            termination = TerminationReason.DEPTH_LIMIT_REACHED
        elif traversal_result.confidence_floor_hits > 0 and not traversal_result.reasoning_steps:
            termination = TerminationReason.CONFIDENCE_FLOOR
        else:
            termination = TerminationReason.NO_EVIDENCE

        # Step 6: Record SemanticInferenceTrace (A.19)
        trace_node_id = await self._record_trace(
            query_id=query_id,
            request=request,
            reasoning_steps=traversal_result.reasoning_steps,
            termination_reason=termination,
            confidence=chain_confidence,
            depth_reached=traversal_result.max_depth_reached,
            execution_time_ms=elapsed_ms,
            concluded_node_id=(
                effective_target_id if traversal_result.path_found else None
            ),
        )

        _log.info(
            "classification_query: subject=%r target=%r classified=%s "
            "confidence=%.3f hops=%d depth=%d denotes=%s termination=%s "
            "elapsed=%.1fms",
            request.subject_node_id,
            request.target_node_id,
            traversal_result.path_found,
            chain_confidence,
            len(traversal_result.reasoning_steps),
            traversal_result.max_depth_reached,
            denotes_traversed,
            termination,
            elapsed_ms,
        )

        return ClassificationQueryResult(
            is_classified=traversal_result.path_found,
            confidence=chain_confidence,
            reasoning_chain=list(traversal_result.reasoning_steps),
            subject_node_id=request.subject_node_id,
            subject_spelling=subject_spelling,
            target_node_id=request.target_node_id,
            target_spelling=target_spelling,
            termination_reason=str(termination),
            depth_reached=traversal_result.max_depth_reached,
            execution_time_ms=elapsed_ms,
            trace_node_id=trace_node_id,
            denotes_traversed=denotes_traversed,
            confidence_floor_hits=traversal_result.confidence_floor_hits,
            cycle_detected=traversal_result.cycle_detected,
            hops_in_chain=len(traversal_result.reasoning_steps),
        )

    # ------------------------------------------------------------------
    # IS_A chain traversal (BFS with cycle detection)
    # ------------------------------------------------------------------

    def _traverse_is_a_chain(
        self,
        subject_id: str,
        target_id: str,
    ) -> _TraversalResult:
        """Traverse IS_A edges upward from subject looking for target.

        Uses breadth-first search to find the shortest IS_A path from
        subject to target. The BFS explores all IS_A parents at each
        depth level before going deeper, which guarantees the shortest
        path is found first (and therefore the highest-confidence path,
        since hop degradation increases with depth).

        Cycle detection: maintains a visited set of node_ids. Any node
        already in the set is skipped. This prevents infinite loops even
        if the graph contains IS_A cycles (which violate the asymmetry
        axiom but may exist transiently during teaching).

        Confidence floor: edges with confidence < MIN_CONFIDENCE_FLOOR
        are skipped during traversal. They are counted as
        confidence_floor_hits for diagnostic purposes.

        Args:
            subject_id: The node_id to start traversal from.
            target_id: The node_id we are looking for in the ancestry.

        Returns:
            _TraversalResult with path information.
        """
        # BFS state: each entry is (node_id, path_so_far)
        # path_so_far is a list of _EdgeInfo describing edges traversed
        queue: list[tuple[str, list[_EdgeInfo]]] = [(subject_id, [])]
        visited: set[str] = {subject_id}
        confidence_floor_hits = 0
        max_depth_reached = 0
        cycle_detected = False
        depth_limit_reached = False

        while queue:
            current_id, path = queue.pop(0)
            current_depth = len(path)

            if current_depth >= self.max_depth:
                depth_limit_reached = True
                continue

            # Query IS_A parents of current node
            parents = self._query_is_a_parents(current_id)

            for parent in parents:
                # Confidence floor check
                if parent.confidence < MIN_CONFIDENCE_FLOOR:
                    confidence_floor_hits += 1
                    continue

                # Cycle detection
                if parent.node_id in visited:
                    cycle_detected = True
                    _log.warning(
                        "classification_query: IS_A cycle detected at "
                        "node %r (already visited from %r)",
                        parent.node_id,
                        current_id,
                    )
                    continue

                visited.add(parent.node_id)
                new_depth = current_depth + 1
                max_depth_reached = max(max_depth_reached, new_depth)

                new_path = path + [parent]

                # Check: did we reach the target?
                if parent.node_id == target_id:
                    # Build reasoning steps from the path
                    reasoning_steps = self._path_to_reasoning_steps(
                        subject_id, new_path
                    )
                    return _TraversalResult(
                        path_found=True,
                        reasoning_steps=reasoning_steps,
                        max_depth_reached=max_depth_reached,
                        confidence_floor_hits=confidence_floor_hits,
                        cycle_detected=cycle_detected,
                        depth_limit_reached=False,
                    )

                # Continue traversal
                queue.append((parent.node_id, new_path))

        # No path found
        return _TraversalResult(
            path_found=False,
            reasoning_steps=[],
            max_depth_reached=max_depth_reached,
            confidence_floor_hits=confidence_floor_hits,
            cycle_detected=cycle_detected,
            depth_limit_reached=depth_limit_reached,
        )

    # ------------------------------------------------------------------
    # Neo4j query helpers
    # ------------------------------------------------------------------

    def _query_is_a_parents(self, node_id: str) -> list[_EdgeInfo]:
        """Query direct IS_A parents of a node (single hop upward).

        Returns only active edges (valid_to IS NULL). Results are ordered
        by confidence descending so the BFS explores the most confident
        parents first.

        Args:
            node_id: The node_id to find IS_A parents for.

        Returns:
            List of _EdgeInfo for each IS_A parent.
        """
        cypher = (
            "MATCH (s:WordSenseNode {node_id: $node_id})"
            "-[r:IS_A]->(p:WordSenseNode) "
            "WHERE r.valid_to IS NULL "
            "RETURN p.node_id AS parent_id, "
            "       p.prop_spelling AS parent_spelling, "
            "       r.edge_id AS edge_id, "
            "       r.confidence AS confidence, "
            "       r.prop_scope_context_count AS scope_context_count "
            "ORDER BY r.confidence DESC"
        )

        try:
            def _read(tx: neo4j.ManagedTransaction) -> list[_EdgeInfo]:
                result = tx.run(cypher, node_id=node_id)
                parents: list[_EdgeInfo] = []
                for record in result:
                    parents.append(
                        _EdgeInfo(
                            node_id=str(record.get("parent_id", "")),
                            spelling=str(
                                record.get("parent_spelling")
                                or record.get("parent_id", "")
                            ),
                            edge_id=str(record.get("edge_id", "")),
                            confidence=float(record.get("confidence", 0.0)),
                            scope_context_count=int(
                                record.get("scope_context_count", 0)
                            ),
                        )
                    )
                return parents

            return self._session.execute_read(_read)
        except Exception as exc:
            _log.warning(
                "classification_query: _query_is_a_parents failed "
                "for node_id=%r: %s",
                node_id,
                exc,
            )
            return []

    def _has_is_a_edges(self, node_id: str) -> bool:
        """Check if a node has any outgoing IS_A edges.

        Used to determine whether DENOTES resolution is needed for
        the subject node.

        Args:
            node_id: The node_id to check.

        Returns:
            True if at least one active IS_A edge exists from this node.
        """
        cypher = (
            "MATCH (s:WordSenseNode {node_id: $node_id})-[r:IS_A]->() "
            "WHERE r.valid_to IS NULL "
            "RETURN count(r) AS cnt "
            "LIMIT 1"
        )

        try:
            def _read(tx: neo4j.ManagedTransaction) -> bool:
                result = tx.run(cypher, node_id=node_id)
                record = result.single()
                if record is None:
                    return False
                return int(record["cnt"]) > 0

            return self._session.execute_read(_read)
        except Exception as exc:
            _log.warning(
                "classification_query: _has_is_a_edges failed "
                "for node_id=%r: %s",
                node_id,
                exc,
            )
            return False

    def _is_target_of_is_a_edges(self, node_id: str) -> bool:
        """Check if a node is the target of any IS_A edges.

        Used to determine whether DENOTES resolution is needed for
        the target node. If nothing IS_A this node, it may be a
        WordSenseNode that needs DENOTES bridging.

        Args:
            node_id: The node_id to check.

        Returns:
            True if at least one active IS_A edge points to this node.
        """
        cypher = (
            "MATCH ()-[r:IS_A]->(t:WordSenseNode {node_id: $node_id}) "
            "WHERE r.valid_to IS NULL "
            "RETURN count(r) AS cnt "
            "LIMIT 1"
        )

        try:
            def _read(tx: neo4j.ManagedTransaction) -> bool:
                result = tx.run(cypher, node_id=node_id)
                record = result.single()
                if record is None:
                    return False
                return int(record["cnt"]) > 0

            return self._session.execute_read(_read)
        except Exception as exc:
            _log.warning(
                "classification_query: _is_target_of_is_a_edges failed "
                "for node_id=%r: %s",
                node_id,
                exc,
            )
            return False

    def _resolve_denotes_target(
        self,
        word_sense_node_id: str,
    ) -> str | None:
        """Follow DENOTES bridge from a WordSenseNode to its semantic target.

        Only follows the bridge if the WordSenseNode itself lacks the
        relevant IS_A edges. This is the selective DENOTES traversal --
        not unconditional.

        Returns:
            The node_id of the DENOTES target, or None if no bridge exists.
        """
        cypher = (
            "MATCH (ws:WordSenseNode {node_id: $node_id})"
            "-[d:DENOTES]->(target) "
            "WHERE d.valid_to IS NULL "
            "RETURN target.node_id AS target_id "
            "LIMIT 1"
        )

        try:
            def _read(
                tx: neo4j.ManagedTransaction,
            ) -> str | None:
                result = tx.run(cypher, node_id=word_sense_node_id)
                record = result.single()
                if record is None:
                    return None
                tid = record.get("target_id")
                return str(tid) if tid else None

            return self._session.execute_read(_read)
        except Exception as exc:
            _log.warning(
                "classification_query: DENOTES resolution failed for %r: %s",
                word_sense_node_id,
                exc,
            )
            return None

    # ------------------------------------------------------------------
    # Path-to-steps conversion
    # ------------------------------------------------------------------

    @staticmethod
    def _path_to_reasoning_steps(
        subject_id: str,
        path: list[_EdgeInfo],
    ) -> list[ReasoningStep]:
        """Convert a list of _EdgeInfo into ReasoningStep objects.

        Each _EdgeInfo represents one hop in the IS_A chain. The source
        of the first hop is the subject_id; subsequent hops chain from
        the previous hop's target.

        Args:
            subject_id: The starting node_id (the classification subject).
            path: Ordered list of _EdgeInfo from subject toward target.

        Returns:
            List of ReasoningStep objects, one per hop.
        """
        steps: list[ReasoningStep] = []
        current_source = subject_id

        for hop_index, edge_info in enumerate(path):
            steps.append(
                ReasoningStep(
                    hop=hop_index,
                    source_node_id=current_source,
                    edge_type=IS_A,
                    edge_id=edge_info.edge_id,
                    target_node_id=edge_info.node_id,
                    edge_confidence=edge_info.confidence,
                    scope_context_count=edge_info.scope_context_count,
                )
            )
            current_source = edge_info.node_id

        return steps

    # ------------------------------------------------------------------
    # Trace recording
    # ------------------------------------------------------------------

    async def _record_trace(
        self,
        *,
        query_id: str,
        request: ClassificationQueryRequest,
        reasoning_steps: list[ReasoningStep],
        termination_reason: TerminationReason,
        confidence: float,
        depth_reached: int,
        execution_time_ms: float,
        concluded_node_id: str | None,
    ) -> str:
        """Record a SemanticInferenceTrace for this classification query.

        Returns the trace_node_id, or empty string if recording failed
        or no trace_writer is configured.
        """
        if self._trace_writer is None:
            return ""

        try:
            trace_result = await self._trace_writer.record_trace(
                query_id=query_id,
                query_type="classification_query",
                subject_node_id=request.subject_node_id,
                reasoning_steps=reasoning_steps,
                termination_reason=termination_reason,
                confidence=confidence,
                depth_reached=depth_reached,
                execution_time_ms=execution_time_ms,
                session_id=request.session_id,
                target_node_id=request.target_node_id,
                path_found_but_truncated=False,
                concluded_node_id=concluded_node_id,
                conclusion_confidence=confidence if concluded_node_id else None,
            )
            return trace_result.trace_node_id
        except Exception as exc:
            _log.warning(
                "classification_query: failed to record inference trace "
                "for query_id=%s: %s",
                query_id,
                exc,
            )
            return ""

    # ------------------------------------------------------------------
    # Empty result builder
    # ------------------------------------------------------------------

    def _empty_result(
        self,
        request: ClassificationQueryRequest,
        termination_reason: TerminationReason | str,
        execution_time_ms: float,
        trace_node_id: str,
    ) -> ClassificationQueryResult:
        """Build an empty ClassificationQueryResult for degenerate cases."""
        return ClassificationQueryResult(
            is_classified=False,
            confidence=0.0,
            reasoning_chain=[],
            subject_node_id=request.subject_node_id,
            subject_spelling="",
            target_node_id=request.target_node_id,
            target_spelling="",
            termination_reason=str(termination_reason),
            depth_reached=0,
            execution_time_ms=execution_time_ms,
            trace_node_id=trace_node_id,
            denotes_traversed=False,
            confidence_floor_hits=0,
            cycle_detected=False,
            hops_in_chain=0,
        )


# ---------------------------------------------------------------------------
# Internal data structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _EdgeInfo:
    """Internal: one IS_A edge encountered during traversal.

    Represents a parent node reachable via one IS_A hop. Carries the
    edge metadata needed for reasoning step construction and confidence
    propagation.

    Attributes:
        node_id: The parent node's node_id.
        spelling: Human-readable spelling of the parent node.
        edge_id: The edge_id of the IS_A relationship.
        confidence: Confidence of the IS_A edge.
        scope_context_count: Scope context count of the IS_A edge.
    """

    node_id: str
    spelling: str
    edge_id: str
    confidence: float
    scope_context_count: int


@dataclass(frozen=True)
class _TraversalResult:
    """Internal: result of the BFS IS_A chain traversal.

    Attributes:
        path_found: True if a path from subject to target was found.
        reasoning_steps: The IS_A chain as ReasoningStep objects.
            Empty if no path was found.
        max_depth_reached: Maximum depth explored during traversal.
        confidence_floor_hits: Number of edges pruned by confidence floor.
        cycle_detected: True if any cycle was encountered during traversal.
        depth_limit_reached: True if traversal hit the max_depth boundary
            without finding the target.
    """

    path_found: bool
    reasoning_steps: list[ReasoningStep]
    max_depth_reached: int
    confidence_floor_hits: int
    cycle_detected: bool
    depth_limit_reached: bool


# ---------------------------------------------------------------------------
# Developmental gating check (called by SemanticQueryHandler / T012)
# ---------------------------------------------------------------------------


async def check_classification_gate(
    persistence: GraphPersistence,
    neo4j_session: neo4j.Session,
) -> tuple[bool, dict[str, Any]]:
    """Check whether classification_query is developmentally unlocked.

    Reads the ``rule:classification_gate_config`` EvolutionRule node for
    the threshold configuration, then queries the graph for current counts.

    The gate requires all three conditions to be met simultaneously:
      1. At least N successful definition queries (default 25)
      2. At least M distinct concept clusters (default 3)
      3. At least K guardian confirmations on semantic edges (default 15)

    This function is called by the SemanticQueryHandler (T010/T012) before
    routing to the classification executor. It is NOT called by the executor
    itself -- separation of concerns.

    Args:
        persistence: GraphPersistence backend.
        neo4j_session: Direct Neo4j session for counting queries.

    Returns:
        Tuple of (is_unlocked, details_dict). The details_dict contains
        the current counts and thresholds for diagnostic/logging purposes.
    """
    # Read gate config from graph
    gate_rule = await persistence.get_node(CLASSIFICATION_GATE_RULE_ID)

    if gate_rule is not None:
        required_definitions = int(
            gate_rule.properties.get(
                "required_definitions", DEFAULT_GATE_DEFINITION_COUNT
            )
        )
        required_clusters = int(
            gate_rule.properties.get(
                "required_concept_clusters", DEFAULT_GATE_CONCEPT_CLUSTERS
            )
        )
        required_confirmations = int(
            gate_rule.properties.get(
                "required_guardian_confirmations",
                DEFAULT_GATE_GUARDIAN_CONFIRMATIONS,
            )
        )
        # Check for guardian override
        guardian_override = bool(
            gate_rule.properties.get("guardian_override_enabled", False)
        )
        if guardian_override:
            _log.info(
                "classification_query: gate bypassed by guardian override"
            )
            return True, {"guardian_override": True}
    else:
        required_definitions = DEFAULT_GATE_DEFINITION_COUNT
        required_clusters = DEFAULT_GATE_CONCEPT_CLUSTERS
        required_confirmations = DEFAULT_GATE_GUARDIAN_CONFIRMATIONS

    # Count 1: Successful definition queries
    definition_count = _count_successful_definitions(neo4j_session)

    # Count 2: Distinct concept clusters (unique IS_A root ancestors)
    cluster_count = _count_concept_clusters(neo4j_session)

    # Count 3: Guardian confirmations on semantic edges
    confirmation_count = _count_guardian_confirmations(neo4j_session)

    is_unlocked = (
        definition_count >= required_definitions
        and cluster_count >= required_clusters
        and confirmation_count >= required_confirmations
    )

    details = {
        "is_unlocked": is_unlocked,
        "definition_count": definition_count,
        "required_definitions": required_definitions,
        "cluster_count": cluster_count,
        "required_clusters": required_clusters,
        "confirmation_count": confirmation_count,
        "required_confirmations": required_confirmations,
    }

    _log.debug(
        "classification_query gate check: unlocked=%s defs=%d/%d "
        "clusters=%d/%d confirms=%d/%d",
        is_unlocked,
        definition_count,
        required_definitions,
        cluster_count,
        required_clusters,
        confirmation_count,
        required_confirmations,
    )

    return is_unlocked, details


def _count_successful_definitions(session: neo4j.Session) -> int:
    """Count SemanticInferenceTrace nodes with query_type=definition_query
    and termination_reason=answer_found.

    Returns:
        Number of successful definition queries recorded in the graph.
    """
    cypher = (
        "MATCH (t:SemanticInferenceTrace) "
        "WHERE t.prop_query_type = 'definition_query' "
        "  AND t.prop_termination_reason = 'answer_found' "
        "  AND t.status <> 'superseded' "
        "RETURN count(t) AS cnt"
    )

    try:
        def _read(tx: neo4j.ManagedTransaction) -> int:
            result = tx.run(cypher)
            record = result.single()
            return int(record["cnt"]) if record else 0

        return session.execute_read(_read)
    except Exception as exc:
        _log.warning(
            "classification_query: _count_successful_definitions failed: %s",
            exc,
        )
        return 0


def _count_concept_clusters(session: neo4j.Session) -> int:
    """Count distinct IS_A root ancestors (nodes with no outgoing IS_A edges).

    A "concept cluster" is a root node in the IS_A taxonomy -- a concept
    that is not a subtype of anything else. Having multiple clusters means
    the system has learned about multiple independent concept hierarchies,
    indicating breadth of semantic knowledge.

    Returns:
        Number of distinct IS_A root concepts.
    """
    cypher = (
        "MATCH (child:WordSenseNode)-[r:IS_A]->(parent:WordSenseNode) "
        "WHERE r.valid_to IS NULL "
        "  AND r.confidence >= 0.3 "
        "WITH parent "
        "WHERE NOT EXISTS { "
        "  MATCH (parent)-[r2:IS_A]->() WHERE r2.valid_to IS NULL "
        "} "
        "RETURN count(DISTINCT parent) AS cnt"
    )

    try:
        def _read(tx: neo4j.ManagedTransaction) -> int:
            result = tx.run(cypher)
            record = result.single()
            return int(record["cnt"]) if record else 0

        return session.execute_read(_read)
    except Exception as exc:
        _log.warning(
            "classification_query: _count_concept_clusters failed: %s",
            exc,
        )
        return 0


def _count_guardian_confirmations(session: neo4j.Session) -> int:
    """Count semantic edges that have been confirmed by the guardian.

    Guardian confirmation is indicated by the prop_guardian_confirmed=True
    property on semantic edges (IS_A, HAS_PROPERTY, etc.).

    Returns:
        Number of guardian-confirmed semantic edges.
    """
    cypher = (
        "MATCH (:WordSenseNode)-[r]->(:WordSenseNode) "
        "WHERE r.prop_guardian_confirmed = true "
        "  AND r.valid_to IS NULL "
        "RETURN count(r) AS cnt"
    )

    try:
        def _read(tx: neo4j.ManagedTransaction) -> int:
            result = tx.run(cypher)
            record = result.single()
            return int(record["cnt"]) if record else 0

        return session.execute_read(_read)
    except Exception as exc:
        _log.warning(
            "classification_query: _count_guardian_confirmations failed: %s",
            exc,
        )
        return 0


# ---------------------------------------------------------------------------
# Bootstrap functions
# ---------------------------------------------------------------------------


async def bootstrap_classification_query_template(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Bootstrap the proc:classification_query ProceduralTemplate and its config.

    Creates:
      1. The ``proc:classification_query`` ProceduralTemplate node (SCHEMA level).
      2. The ``rule:classification_depth_config`` EvolutionRule node (META_SCHEMA).
      3. The ``rule:classification_gate_config`` EvolutionRule node (META_SCHEMA).
      4. DEPENDS_ON edges from template to rules and domain.

    All nodes use TAUGHT_PROCEDURE provenance. This function is idempotent.

    Args:
        persistence: The graph persistence backend.

    Returns:
        Dict with creation counts.
    """
    counts: dict[str, int] = {
        "template_created": 0,
        "rule_created": 0,
        "edges_created": 0,
        "template_existing": 0,
        "rule_existing": 0,
        "edges_existing": 0,
    }

    taught = Provenance(
        source=ProvenanceSource.TAUGHT_PROCEDURE,
        source_id="classification-query-bootstrap",
        confidence=1.0,
    )

    # 1. Create the ProceduralTemplate node
    template_id = CLASSIFICATION_QUERY_TEMPLATE_ID
    existing_template = await persistence.get_node(template_id)

    if existing_template is not None:
        counts["template_existing"] += 1
    else:
        template_node = KnowledgeNode(
            node_id=template_id,
            node_type=PROCEDURAL_TEMPLATE,
            schema_level=SchemaLevel.SCHEMA,
            properties={
                "name": CLASSIFICATION_QUERY_TEMPLATE_NAME,
                "display_name": "Classification Query",
                "domain": "semantic",
                "description": (
                    "Answers 'is X a Y?' questions by traversing the IS_A "
                    "hierarchy from subject to target. Uses BFS with cycle "
                    "detection and confidence propagation through the chain. "
                    "Returns boolean result with confidence and reasoning."
                ),
                "parameters": ["$subject", "$target"],
                "query_type": "classification_query",
                "depth_config_rule": str(CLASSIFICATION_DEPTH_RULE_ID),
                "gate_config_rule": str(CLASSIFICATION_GATE_RULE_ID),
                "prompt_description": (
                    "classification_query: answers 'is X a Y?' by "
                    "traversing IS_A chain from subject to target"
                ),
                "installed_by_skill": "semantic-ontology",
            },
            provenance=taught,
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        await persistence.save_node(template_node)
        counts["template_created"] += 1
        _log.info(
            "classification_query_bootstrap: created ProceduralTemplate %s",
            template_id,
        )

    # 2. Create the EvolutionRule depth config node
    depth_rule_id = CLASSIFICATION_DEPTH_RULE_ID
    existing_depth = await persistence.get_node(depth_rule_id)

    if existing_depth is not None:
        counts["rule_existing"] += 1
    else:
        depth_rule_node = KnowledgeNode(
            node_id=depth_rule_id,
            node_type="EvolutionRule",
            schema_level=SchemaLevel.META_SCHEMA,
            properties={
                "rule_name": "CLASSIFICATION_DEPTH_CONFIG",
                "current_max_depth": DEFAULT_CLASSIFICATION_MAX_DEPTH,
                "confidence_degradation_per_hop": DEFAULT_CONFIDENCE_DEGRADATION_PER_HOP,
                "description": (
                    "Governs classification_query IS_A traversal depth "
                    "and confidence degradation per hop. 5% degradation "
                    "per hop matches the IS_A transitivity axiom."
                ),
                "tunable_by_guardian": True,
                "installed_by_skill": "semantic-ontology",
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id="classification-query-bootstrap",
                confidence=1.0,
            ),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        await persistence.save_node(depth_rule_node)
        counts["rule_created"] += 1
        _log.info(
            "classification_query_bootstrap: created EvolutionRule %s",
            depth_rule_id,
        )

    # 3. Create the EvolutionRule gate config node
    gate_rule_id = CLASSIFICATION_GATE_RULE_ID
    existing_gate = await persistence.get_node(gate_rule_id)

    if existing_gate is not None:
        counts["rule_existing"] += 1
    else:
        gate_rule_node = KnowledgeNode(
            node_id=gate_rule_id,
            node_type="EvolutionRule",
            schema_level=SchemaLevel.META_SCHEMA,
            properties={
                "rule_name": "CLASSIFICATION_GATE_CONFIG",
                "required_definitions": DEFAULT_GATE_DEFINITION_COUNT,
                "required_concept_clusters": DEFAULT_GATE_CONCEPT_CLUSTERS,
                "required_guardian_confirmations": DEFAULT_GATE_GUARDIAN_CONFIRMATIONS,
                "guardian_override_enabled": False,
                "description": (
                    "Developmental gating for classification_query. "
                    "Requires 25 successful definitions, 3 concept clusters, "
                    "and 15 guardian confirmations before classification "
                    "becomes available. Guardian can override."
                ),
                "tunable_by_guardian": True,
                "installed_by_skill": "semantic-ontology",
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id="classification-query-bootstrap",
                confidence=1.0,
            ),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        await persistence.save_node(gate_rule_node)
        counts["rule_created"] += 1
        _log.info(
            "classification_query_bootstrap: created EvolutionRule %s",
            gate_rule_id,
        )

    # 4. Create DEPENDS_ON edges
    dep_edges = [
        (
            EdgeId("dep:cls_query:depth_config"),
            template_id,
            depth_rule_id,
            "depth_config",
        ),
        (
            EdgeId("dep:cls_query:gate_config"),
            template_id,
            gate_rule_id,
            "gate_config",
        ),
        (
            EdgeId("dep:cls_query:semantic_domain"),
            template_id,
            NodeId("domain:semantic"),
            "semantic_domain",
        ),
        (
            EdgeId("dep:cls_query:definition_query"),
            template_id,
            NodeId("proc:definition_query"),
            "prerequisite_query",
        ),
    ]

    for edge_id, source_id, target_id, dep_type in dep_edges:
        existing_edge = await persistence.get_edge(edge_id)
        if existing_edge is not None:
            counts["edges_existing"] += 1
            continue

        # Verify target exists before creating edge
        target_node = await persistence.get_node(target_id)
        if target_node is None:
            _log.warning(
                "classification_query_bootstrap: skipping DEPENDS_ON edge %s "
                "because target %s does not exist",
                edge_id,
                target_id,
            )
            continue

        dep_edge = KnowledgeEdge(
            edge_id=edge_id,
            source_id=source_id,
            target_id=target_id,
            edge_type="DEPENDS_ON",
            properties={
                "dependency_type": dep_type,
                "installed_by_skill": "semantic-ontology",
            },
            provenance=taught,
            confidence=1.0,
        )
        await persistence.save_edge(dep_edge)
        counts["edges_created"] += 1

    _log.info(
        "classification_query_bootstrap: complete -- "
        "template=%s rules=%d edges=%d",
        "created" if counts["template_created"] else "existing",
        counts["rule_created"],
        counts["edges_created"],
    )

    return counts


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    # Constants
    "CLASSIFICATION_QUERY_TEMPLATE_ID",
    "CLASSIFICATION_QUERY_TEMPLATE_NAME",
    "CLASSIFICATION_DEPTH_RULE_ID",
    "CLASSIFICATION_GATE_RULE_ID",
    "DEFAULT_CLASSIFICATION_MAX_DEPTH",
    "DEFAULT_CONFIDENCE_DEGRADATION_PER_HOP",
    "DEFAULT_GATE_DEFINITION_COUNT",
    "DEFAULT_GATE_CONCEPT_CLUSTERS",
    "DEFAULT_GATE_GUARDIAN_CONFIRMATIONS",
    # Data structures
    "ClassificationQueryRequest",
    "ClassificationQueryResult",
    # Confidence computation
    "compute_chain_confidence",
    # Executor
    "ClassificationQueryExecutor",
    # Developmental gating
    "check_classification_gate",
    # Bootstrap
    "bootstrap_classification_query_template",
]

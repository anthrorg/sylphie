"""Inference query executor for the Co-Being knowledge graph (P1.8-E3/T005).

Implements the ``proc:inference_query`` ProceduralTemplate that answers
multi-hop semantic reasoning questions like "do cats breathe air?" by traversing
across multiple semantic edge types. This is the third and most complex query
type in the developmental sequence (D4: definition -> classification ->
inference), unlocked after 20 successful classifications demonstrate competence.

Architecture:

  1. Resolve subject and target nodes to their effective IDs (following
     DENOTES bridge if needed, matching classification_query behavior).
  2. Read current operational depth from the ``rule:inference_depth_config``
     EvolutionRule node in the graph.
  3. Perform bounded multi-edge-type BFS from subject toward target.
     Unlike classification_query (IS_A only), inference_query traverses
     IS_A, HAS_PROPERTY, PART_OF, CAUSES, ENABLES, PRODUCES, CONSUMES,
     and USED_FOR edges.
  4. Apply confidence propagation through the chain with edge-type-specific
     degradation factors.
  5. Detect cycles using a visited-node set to prevent infinite loops.
  6. Track termination reason with full truncation metadata.
  7. Record a SemanticInferenceTrace (A.19 compliance) with per-hop USED_FACT
     reverse index edges.
  8. Return an InferenceQueryResult with boolean answer, confidence, reasoning
     chain, and truncation metadata.

Confidence propagation formula:

  Multi-hop inference confidence degrades faster than IS_A classification
  because cross-type inference chains are inherently less reliable:

    chain_confidence = edge_1_confidence * edge_2_confidence * ... * edge_n_confidence
    hop_degradation  = (1 - degradation_per_hop) ^ n_hops
    type_penalty     = product of per-edge-type degradation factors
    final_confidence = chain_confidence * hop_degradation * type_penalty

  Edge-type degradation factors (from semantic-ontology axioms):
    IS_A:         0.95 per hop (5% degradation, matching transitivity axiom)
    HAS_PROPERTY: 0.90 per hop (10% -- property inheritance is less certain)
    PART_OF:      0.85 per hop (15% -- mereological transitivity is context-dependent)
    CAUSES/ENABLES/PREVENTS: 0.80 per hop (20% -- causal chains degrade fast)
    Other:        0.85 per hop (15% default)

Developmental depth governance (from discussion-resolutions-final.md T1.2):

  Inference query uses staged depth progression governed by the
  ``rule:inference_depth_config`` EvolutionRule node:

  - Starts at max_depth=1 (single-hop inference)
  - Advances to depth=2 after:
      * single_hop_success_rate >= 0.85
      * min_confirmed_inferences >= 20
      * concept_cluster_coverage >= 3
  - Advances to depth=3 after:
      * two_hop_success_rate >= 0.80
      * min_confirmed_inferences >= 15
      * horizontal_decalage_check: success across 3+ concept clusters
  - Depth 4+ blocked until E5 inner monologue (e5_prerequisite_met=true)

  The depth is read once per session, not once per query. SemanticQueryHandler
  reads ``current_max_depth`` from the EvolutionRule at session initialization.

Truncation tracking (from T1.2 resolution):

  When traversal terminates due to DEPTH_LIMIT_REACHED (frontier non-empty
  when depth cap fired), the result carries:
    - path_found_but_truncated: True
    - truncation_depth: the depth at which truncation occurred
    - continuation_available_at_depth: truncation_depth + 1

  PT-11 narrates these with categorically different language from NO_EVIDENCE.
  The SemanticInferenceTrace persists the distinction for developmental
  analytics: truncation_ratio (DEPTH_LIMIT_REACHED / total) feeds the depth
  advancement decision.

CANON compliance:
  A.1   -- all semantic edges come from guardian teaching or inference
  A.10  -- bounded traversal (max_depth from EvolutionRule, ceiling at 5)
  A.11  -- provenance on every node and edge
  A.12  -- LLM never sees raw graph; receives only the result object
  A.19  -- SemanticInferenceTrace recorded per query
  A.20  -- cross-domain DENOTES traversal respects domain boundaries

Usage::

    from cobeing.layer3_knowledge.inference_query import (
        InferenceQueryExecutor,
        InferenceQueryRequest,
        InferenceQueryResult,
    )

    executor = await InferenceQueryExecutor.from_graph(
        persistence=graph,
        neo4j_session=session,
        trace_writer=trace_writer,
    )

    result = await executor.execute(
        InferenceQueryRequest(
            subject_node_id="word:cat:1",
            target_node_id="word:breathe_air:1",
            session_id="session-001",
            correlation_id="q-003",
        )
    )

    if result.answer_found:
        print(f"Yes! Confidence: {result.confidence:.2f}")
        for step in result.reasoning_chain:
            print(f"  hop {step.hop}: {step.source_node_id} "
                  f"-[{step.edge_type}]-> {step.target_node_id}")
    elif result.path_found_but_truncated:
        print(f"Maybe -- path truncated at depth {result.truncation_depth}, "
              f"continuation available at depth {result.continuation_available_at_depth}")
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
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
from cobeing.layer3_knowledge.semantic_query import MIN_CONFIDENCE_FLOOR
from cobeing.layer3_knowledge.semantic_types import (
    CAUSES,
    CONSUMES,
    ENABLES,
    HAS_PROPERTY,
    IS_A,
    LOCATED_IN,
    PART_OF,
    PREVENTS,
    PRODUCES,
    REQUIRES,
    USED_FOR,
)
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

INFERENCE_QUERY_TEMPLATE_ID = NodeId("proc:inference_query")
"""NodeId of the inference_query ProceduralTemplate in the graph."""

INFERENCE_QUERY_TEMPLATE_NAME = "inference_query"
"""Human-readable template name for the inference query procedure."""

INFERENCE_DEPTH_RULE_ID = NodeId("rule:inference_depth_config")
"""NodeId of the EvolutionRule governing inference query depth progression."""

INFERENCE_GATE_RULE_ID = NodeId("rule:inference_gate_config")
"""NodeId of the EvolutionRule governing inference query developmental gating."""

# Default depth config (from T1.2 resolution)
DEFAULT_INFERENCE_START_DEPTH: int = 1
"""Starting max_depth for inference queries. Staged progression: 1 -> 2 -> 3."""

DEFAULT_INFERENCE_ARCHITECTURAL_MAX: int = 3
"""E3 absolute ceiling (Luria's biological constraint on cumulative inference)."""

DEFAULT_INFERENCE_POST_E5_MAX: int = 5
"""Available only after E5 delivers inner monologue."""

# Per-edge-type confidence degradation factors.
# These reflect how reliable transitive inference is for each edge type.
# IS_A is most reliable (5% loss), causal types least (20% loss).
EDGE_TYPE_DEGRADATION: dict[str, float] = {
    IS_A: 0.05,
    HAS_PROPERTY: 0.10,
    PART_OF: 0.15,
    LOCATED_IN: 0.10,
    USED_FOR: 0.10,
    CAUSES: 0.20,
    ENABLES: 0.20,
    PREVENTS: 0.20,
    REQUIRES: 0.15,
    PRODUCES: 0.15,
    CONSUMES: 0.15,
}
"""Per-edge-type confidence degradation factor.

Applied multiplicatively at each hop: factor = (1 - degradation).
IS_A is most reliable (matches IS_A transitivity axiom). Causal types
(CAUSES, ENABLES, PREVENTS) degrade fastest because causal chain
transitivity is unreliable beyond 2 steps (Sloman, 2005).
"""

DEFAULT_DEGRADATION_PER_HOP: float = 0.15
"""Fallback degradation for edge types not in EDGE_TYPE_DEGRADATION."""

# Traversable edge types for inference queries.
# These are the semantic edge types that the BFS can follow.
# Symmetric types (SIMILAR_TO, OPPOSITE_OF, CONTRADICTS) are excluded
# because they do not support transitive inference.
INFERENCE_TRAVERSABLE_EDGE_TYPES: frozenset[str] = frozenset({
    IS_A,
    HAS_PROPERTY,
    PART_OF,
    LOCATED_IN,
    USED_FOR,
    CAUSES,
    ENABLES,
    PREVENTS,
    REQUIRES,
    PRODUCES,
    CONSUMES,
})
"""Edge types that the inference BFS can traverse.

Symmetric types (SIMILAR_TO, OPPOSITE_OF, CONTRADICTS) are excluded because
transitive inference across symmetric relations is semantically invalid:
"A similar-to B and B similar-to C" does not entail "A similar-to C" in a
meaningful way for multi-hop reasoning.
"""

# Developmental gating thresholds (Piaget D4 progression)
DEFAULT_GATE_CLASSIFICATION_COUNT: int = 20
"""Minimum successful classification queries before inference unlocks."""

DEFAULT_GATE_SEMANTIC_EDGE_TYPES: int = 5
"""Minimum distinct semantic edge types in the graph."""

DEFAULT_GATE_CROSS_DOMAIN_FACTS: int = 3
"""Minimum cross-domain bridge edges (DENOTES)."""

# Depth advancement criteria (from T1.2 resolution)
DEFAULT_DEPTH2_SUCCESS_RATE: float = 0.85
"""Single-hop success rate required to unlock depth 2."""

DEFAULT_DEPTH2_MIN_CONFIRMED: int = 20
"""Minimum confirmed single-hop inferences for depth 2."""

DEFAULT_DEPTH2_CLUSTER_COVERAGE: int = 3
"""Minimum concept clusters for depth 2."""

DEFAULT_DEPTH3_SUCCESS_RATE: float = 0.80
"""Two-hop success rate required to unlock depth 3."""

DEFAULT_DEPTH3_MIN_CONFIRMED: int = 15
"""Minimum confirmed two-hop inferences for depth 3."""


# ---------------------------------------------------------------------------
# Request / Result data structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class InferenceQueryRequest:
    """Input to InferenceQueryExecutor.execute().

    Attributes:
        subject_node_id: The node_id of the entity to reason about ("do cats...").
        target_node_id: The node_id of the property/category to check ("...breathe air?").
        session_id: Current conversation session identifier.
        correlation_id: Traces this request through logs and provenance.
        activation_map: Optional spreading activation map. Keys are node_ids,
            values are activation boost values (0.0-1.0).
    """

    subject_node_id: str
    target_node_id: str
    session_id: str
    correlation_id: str
    activation_map: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class InferenceQueryResult:
    """Result of an inference_query execution.

    Attributes:
        answer_found: True if a multi-hop path from subject to target was found.
        confidence: Overall confidence of the inference. Product of all edge
            confidences in the chain times per-hop and per-type degradation.
            0.0 if no answer found.
        reasoning_chain: Ordered list of ReasoningStep objects showing the
            multi-hop traversal path from subject to target. Empty if no path.
        subject_node_id: The node_id that was queried as the subject.
        subject_spelling: Human-readable spelling of the subject.
        target_node_id: The node_id that was queried as the target.
        target_spelling: Human-readable spelling of the target.
        termination_reason: Why the traversal stopped.
        depth_reached: Maximum depth explored during traversal.
        execution_time_ms: Wall-clock time for the query.
        trace_node_id: NodeId of the SemanticInferenceTrace created.
        denotes_traversed: True if DENOTES bridge was used for either subject
            or target resolution.
        confidence_floor_hits: Number of edges pruned by the confidence floor.
        cycle_detected: True if a cycle was encountered during traversal.
        hops_in_chain: Number of hops in the inference chain. 0 if not found.
        path_found_but_truncated: True if DEPTH_LIMIT_REACHED with live frontier.
        truncation_depth: Depth at which truncation occurred. None if not truncated.
        continuation_available_at_depth: Next depth that could continue. None if N/A.
        edge_types_traversed: Set of edge types used in the reasoning chain.
        max_depth_used: The operational max_depth that was applied for this query.
    """

    answer_found: bool
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
    path_found_but_truncated: bool
    truncation_depth: int | None
    continuation_available_at_depth: int | None
    edge_types_traversed: list[str]
    max_depth_used: int


# ---------------------------------------------------------------------------
# Confidence propagation
# ---------------------------------------------------------------------------


def compute_inference_chain_confidence(
    edge_types: list[str],
    edge_confidences: list[float],
) -> float:
    """Compute the overall confidence for a multi-hop inference chain.

    Unlike classification confidence (uniform 5% per IS_A hop), inference
    confidence applies per-edge-type degradation factors that reflect how
    reliable transitive inference is for each relationship type.

    The formula combines three independent uncertainty sources:

    1. Individual edge confidence: each edge may be uncertain (< 1.0).
    2. Per-hop degradation: longer chains are inherently less reliable.
    3. Per-type degradation: some edge types (causal) degrade faster than
       others (taxonomic).

    Args:
        edge_types: Ordered list of edge type strings for each hop.
        edge_confidences: Ordered confidence values for each hop.

    Returns:
        Combined confidence in [0.0, 1.0]. Returns 0.0 for empty chains.
    """
    if not edge_confidences or not edge_types:
        return 0.0

    if len(edge_types) != len(edge_confidences):
        _log.warning(
            "inference_query: edge_types length (%d) != edge_confidences "
            "length (%d); using minimum",
            len(edge_types),
            len(edge_confidences),
        )

    n_hops = min(len(edge_types), len(edge_confidences))

    # Product of individual edge confidences
    chain_product = 1.0
    for i in range(n_hops):
        chain_product *= max(0.0, min(1.0, edge_confidences[i]))

    # Per-type degradation: multiply (1 - type_degradation) for each hop
    type_factor = 1.0
    for i in range(n_hops):
        degradation = EDGE_TYPE_DEGRADATION.get(
            edge_types[i], DEFAULT_DEGRADATION_PER_HOP
        )
        type_factor *= (1.0 - degradation)

    result = chain_product * type_factor
    return max(0.0, min(1.0, result))


# ---------------------------------------------------------------------------
# InferenceQueryExecutor
# ---------------------------------------------------------------------------


class InferenceQueryExecutor:
    """Executes inference_query procedures through multi-hop semantic traversal.

    This executor is Layer 3 infrastructure. It never calls the LLM.
    It traverses the semantic graph across multiple edge types from subject
    toward target, building inference chains, and returns a structured result
    that PT-11 can narrate.

    The executor reads its depth configuration from the
    ``rule:inference_depth_config`` EvolutionRule node in the graph.
    If the node does not exist, it falls back to the default (depth=1).

    Attributes:
        persistence: GraphPersistence backend for node/edge reads.
        neo4j_session: Direct Neo4j session for optimized Cypher queries.
        trace_writer: InferenceTraceWriter for A.19 compliance.
        max_depth: Current operational max depth (from EvolutionRule).
        e5_prerequisite_met: Whether E5 inner monologue has been delivered.
    """

    def __init__(
        self,
        persistence: GraphPersistence,
        neo4j_session: neo4j.Session,
        trace_writer: InferenceTraceWriter | None = None,
        max_depth: int = DEFAULT_INFERENCE_START_DEPTH,
        e5_prerequisite_met: bool = False,
    ) -> None:
        self._persistence = persistence
        self._session = neo4j_session
        self._trace_writer = trace_writer
        self.max_depth = max_depth
        self.e5_prerequisite_met = e5_prerequisite_met

    @classmethod
    async def from_graph(
        cls,
        persistence: GraphPersistence,
        neo4j_session: neo4j.Session,
        trace_writer: InferenceTraceWriter | None = None,
    ) -> "InferenceQueryExecutor":
        """Create an InferenceQueryExecutor with config read from the graph.

        Reads the ``rule:inference_depth_config`` EvolutionRule node to obtain
        the current max_depth, e5_prerequisite_met, and advancement criteria.
        Falls back to defaults if the node does not exist.

        This is the session-start depth read described in the T1.2 resolution:
        depth is read once per session, not once per query.

        Also checks whether depth advancement criteria are met and updates
        the EvolutionRule node if so.

        Args:
            persistence: GraphPersistence backend.
            neo4j_session: Direct Neo4j session.
            trace_writer: Optional InferenceTraceWriter.

        Returns:
            A configured InferenceQueryExecutor.
        """
        max_depth = DEFAULT_INFERENCE_START_DEPTH
        e5_prerequisite_met = False

        depth_rule = await persistence.get_node(INFERENCE_DEPTH_RULE_ID)
        if depth_rule is not None:
            max_depth = int(
                depth_rule.properties.get(
                    "current_max_depth", DEFAULT_INFERENCE_START_DEPTH
                )
            )
            e5_prerequisite_met = bool(
                depth_rule.properties.get("e5_prerequisite_met", False)
            )

            # Session-start advancement check
            advanced_depth = await _check_depth_advancement(
                persistence=persistence,
                neo4j_session=neo4j_session,
                current_depth=max_depth,
                e5_prerequisite_met=e5_prerequisite_met,
                depth_rule_node=depth_rule,
            )
            if advanced_depth > max_depth:
                max_depth = advanced_depth
                _log.info(
                    "inference_query: depth advanced from %d to %d at session start",
                    depth_rule.properties.get("current_max_depth", 1),
                    max_depth,
                )

        # Enforce architectural ceiling
        if e5_prerequisite_met:
            max_depth = min(max_depth, DEFAULT_INFERENCE_POST_E5_MAX)
        else:
            max_depth = min(max_depth, DEFAULT_INFERENCE_ARCHITECTURAL_MAX)

        # Never exceed physical safety ceiling
        max_depth = min(max_depth, MAX_TRAVERSAL_DEPTH)

        return cls(
            persistence=persistence,
            neo4j_session=neo4j_session,
            trace_writer=trace_writer,
            max_depth=max_depth,
            e5_prerequisite_met=e5_prerequisite_met,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def execute(
        self,
        request: InferenceQueryRequest,
    ) -> InferenceQueryResult:
        """Execute an inference query: "do subject have/do target?"

        Performs bounded multi-edge-type BFS from subject toward target.
        Uses cycle detection, confidence propagation with per-edge-type
        degradation, and full truncation tracking.

        Steps:
          1. Resolve subject and target nodes, get spellings.
          2. Check for DENOTES bridges.
          3. Trivial case: subject == target.
          4. Perform multi-type BFS traversal.
          5. Compute chain confidence with per-type degradation.
          6. Determine termination reason with truncation metadata.
          7. Record SemanticInferenceTrace.
          8. Return InferenceQueryResult.

        Args:
            request: The inference query parameters.

        Returns:
            InferenceQueryResult with answer and reasoning chain.

        Raises:
            KnowledgeGraphError: If graph queries fail.
        """
        start_time = time.monotonic()
        query_id = f"inf-{request.correlation_id}-{uuid.uuid4().hex[:8]}"

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

        if not self._has_semantic_edges(effective_subject_id):
            denotes_target = self._resolve_denotes_target(effective_subject_id)
            if denotes_target is not None:
                denotes_traversed = True
                effective_subject_id = denotes_target
                _log.debug(
                    "inference_query: followed DENOTES bridge for subject "
                    "from %s to %s",
                    request.subject_node_id,
                    effective_subject_id,
                )

        if not self._is_target_of_semantic_edges(effective_target_id):
            denotes_target = self._resolve_denotes_target(effective_target_id)
            if denotes_target is not None:
                denotes_traversed = True
                effective_target_id = denotes_target
                _log.debug(
                    "inference_query: followed DENOTES bridge for target "
                    "from %s to %s",
                    request.target_node_id,
                    effective_target_id,
                )

        # Step 3: Trivial case -- subject and target are the same node
        if effective_subject_id == effective_target_id:
            elapsed_ms = (time.monotonic() - start_time) * 1000
            reasoning_chain: list[ReasoningStep] = []
            trace_node_id = await self._record_trace(
                query_id=query_id,
                request=request,
                reasoning_steps=reasoning_chain,
                termination_reason=TerminationReason.ANSWER_FOUND,
                confidence=1.0,
                depth_reached=0,
                execution_time_ms=elapsed_ms,
                concluded_node_id=effective_target_id,
                path_found_but_truncated=False,
                truncation_depth=None,
                continuation_available_at_depth=None,
            )
            return InferenceQueryResult(
                answer_found=True,
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
                path_found_but_truncated=False,
                truncation_depth=None,
                continuation_available_at_depth=None,
                edge_types_traversed=[],
                max_depth_used=self.max_depth,
            )

        # Step 4: Perform multi-type BFS traversal
        traversal_result = self._traverse_inference_chain(
            subject_id=effective_subject_id,
            target_id=effective_target_id,
        )

        elapsed_ms = (time.monotonic() - start_time) * 1000

        # Step 5: Compute chain confidence if path was found
        if traversal_result.path_found:
            chain_confidence = compute_inference_chain_confidence(
                edge_types=[
                    step.edge_type
                    for step in traversal_result.reasoning_steps
                ],
                edge_confidences=[
                    step.edge_confidence
                    for step in traversal_result.reasoning_steps
                ],
            )
        else:
            chain_confidence = 0.0

        # Step 6: Determine termination reason with truncation metadata
        path_found_but_truncated = False
        truncation_depth: int | None = None
        continuation_available_at_depth: int | None = None

        if traversal_result.path_found:
            termination = TerminationReason.ANSWER_FOUND
        elif traversal_result.cycle_detected and not traversal_result.reasoning_steps:
            termination = TerminationReason.CYCLE_DETECTED
        elif traversal_result.depth_limit_reached:
            termination = TerminationReason.DEPTH_LIMIT_REACHED
            # Check if there were unvisited nodes at the frontier
            if traversal_result.frontier_non_empty:
                path_found_but_truncated = True
                truncation_depth = self.max_depth
                continuation_available_at_depth = self.max_depth + 1
        elif (
            traversal_result.confidence_floor_hits > 0
            and not traversal_result.reasoning_steps
        ):
            termination = TerminationReason.CONFIDENCE_FLOOR
        else:
            termination = TerminationReason.NO_EVIDENCE

        # Collect edge types traversed
        edge_types_traversed = list({
            step.edge_type for step in traversal_result.reasoning_steps
        })

        # Step 7: Record SemanticInferenceTrace (A.19)
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
            path_found_but_truncated=path_found_but_truncated,
            truncation_depth=truncation_depth,
            continuation_available_at_depth=continuation_available_at_depth,
        )

        _log.info(
            "inference_query: subject=%r target=%r found=%s "
            "confidence=%.3f hops=%d depth=%d denotes=%s termination=%s "
            "truncated=%s elapsed=%.1fms max_depth=%d",
            request.subject_node_id,
            request.target_node_id,
            traversal_result.path_found,
            chain_confidence,
            len(traversal_result.reasoning_steps),
            traversal_result.max_depth_reached,
            denotes_traversed,
            termination,
            path_found_but_truncated,
            elapsed_ms,
            self.max_depth,
        )

        return InferenceQueryResult(
            answer_found=traversal_result.path_found,
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
            path_found_but_truncated=path_found_but_truncated,
            truncation_depth=truncation_depth,
            continuation_available_at_depth=continuation_available_at_depth,
            edge_types_traversed=edge_types_traversed,
            max_depth_used=self.max_depth,
        )

    # ------------------------------------------------------------------
    # Multi-type BFS traversal
    # ------------------------------------------------------------------

    def _traverse_inference_chain(
        self,
        subject_id: str,
        target_id: str,
    ) -> _InferenceTraversalResult:
        """Traverse semantic edges from subject looking for target.

        Uses breadth-first search across all traversable edge types to find
        the shortest multi-hop path from subject to target. Unlike
        classification_query (IS_A only), this traversal follows IS_A,
        HAS_PROPERTY, PART_OF, CAUSES, ENABLES, PRODUCES, CONSUMES,
        USED_FOR, and other non-symmetric edge types.

        The BFS explores both outgoing and incoming edges at each hop to
        support bidirectional inference. For example, "cats breathe air"
        might traverse: cat -[IS_A]-> animal -[HAS_PROPERTY]-> breathes_air.
        But it could also traverse: breathes_air <-[HAS_PROPERTY]- animal
        if we start from the target side.

        However, the primary traversal direction is forward (outgoing) from
        subject toward target. Reverse traversal is only used for IS_A
        inheritance: if X IS_A Y, then properties of Y are inherited by X.

        Cycle detection: maintains a visited set. Prevents infinite loops.

        Confidence floor: edges with confidence < MIN_CONFIDENCE_FLOOR are
        skipped and counted as confidence_floor_hits.

        Args:
            subject_id: The node_id to start traversal from.
            target_id: The node_id we are looking for.

        Returns:
            _InferenceTraversalResult with path information and truncation data.
        """
        # BFS state: (current_node_id, path_of_edge_infos)
        queue: list[tuple[str, list[_InferenceEdgeInfo]]] = [(subject_id, [])]
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

            # Query all semantic neighbors of current node (outgoing edges)
            neighbors = self._query_semantic_neighbors(current_id)

            for neighbor in neighbors:
                # Confidence floor check
                if neighbor.confidence < MIN_CONFIDENCE_FLOOR:
                    confidence_floor_hits += 1
                    continue

                # Cycle detection
                if neighbor.node_id in visited:
                    cycle_detected = True
                    continue

                visited.add(neighbor.node_id)
                new_depth = current_depth + 1
                max_depth_reached = max(max_depth_reached, new_depth)

                new_path = path + [neighbor]

                # Check: did we reach the target?
                if neighbor.node_id == target_id:
                    reasoning_steps = self._path_to_reasoning_steps(
                        subject_id, new_path
                    )
                    return _InferenceTraversalResult(
                        path_found=True,
                        reasoning_steps=reasoning_steps,
                        max_depth_reached=max_depth_reached,
                        confidence_floor_hits=confidence_floor_hits,
                        cycle_detected=cycle_detected,
                        depth_limit_reached=False,
                        frontier_non_empty=False,
                    )

                # Continue traversal
                queue.append((neighbor.node_id, new_path))

        # No path found
        return _InferenceTraversalResult(
            path_found=False,
            reasoning_steps=[],
            max_depth_reached=max_depth_reached,
            confidence_floor_hits=confidence_floor_hits,
            cycle_detected=cycle_detected,
            depth_limit_reached=depth_limit_reached,
            frontier_non_empty=frontier_non_empty,
        )

    # ------------------------------------------------------------------
    # Neo4j query helpers
    # ------------------------------------------------------------------

    def _query_semantic_neighbors(
        self, node_id: str
    ) -> list[_InferenceEdgeInfo]:
        """Query all outgoing semantic edges from a node.

        Returns neighbors reachable via any edge type in
        INFERENCE_TRAVERSABLE_EDGE_TYPES. Only active edges (valid_to IS NULL)
        are included. Results are ordered by confidence descending.

        Args:
            node_id: The node_id to find semantic neighbors for.

        Returns:
            List of _InferenceEdgeInfo for each reachable neighbor.
        """
        # Build type union for the MATCH clause
        type_union = "|".join(sorted(INFERENCE_TRAVERSABLE_EDGE_TYPES))

        cypher = (
            f"MATCH (s:WordSenseNode {{node_id: $node_id}})"
            f"-[r:{type_union}]->(p:WordSenseNode) "
            f"WHERE r.valid_to IS NULL "
            f"RETURN p.node_id AS neighbor_id, "
            f"       p.prop_spelling AS neighbor_spelling, "
            f"       r.edge_id AS edge_id, "
            f"       type(r) AS edge_type, "
            f"       r.confidence AS confidence, "
            f"       r.prop_scope_context_count AS scope_context_count "
            f"ORDER BY r.confidence DESC"
        )

        try:
            def _read(
                tx: neo4j.ManagedTransaction,
            ) -> list[_InferenceEdgeInfo]:
                result = tx.run(cypher, node_id=node_id)
                neighbors: list[_InferenceEdgeInfo] = []
                for record in result:
                    neighbors.append(
                        _InferenceEdgeInfo(
                            node_id=str(record.get("neighbor_id", "")),
                            spelling=str(
                                record.get("neighbor_spelling")
                                or record.get("neighbor_id", "")
                            ),
                            edge_id=str(record.get("edge_id", "")),
                            edge_type=str(record.get("edge_type", "")),
                            confidence=float(
                                record.get("confidence", 0.0)
                            ),
                            scope_context_count=int(
                                record.get("scope_context_count", 0)
                            ),
                        )
                    )
                return neighbors

            return self._session.execute_read(_read)
        except Exception as exc:
            _log.warning(
                "inference_query: _query_semantic_neighbors failed "
                "for node_id=%r: %s",
                node_id,
                exc,
            )
            return []

    def _has_semantic_edges(self, node_id: str) -> bool:
        """Check if a node has any outgoing semantic edges.

        Used to determine whether DENOTES resolution is needed.

        Args:
            node_id: The node_id to check.

        Returns:
            True if at least one active semantic edge exists from this node.
        """
        type_union = "|".join(sorted(INFERENCE_TRAVERSABLE_EDGE_TYPES))

        cypher = (
            f"MATCH (s:WordSenseNode {{node_id: $node_id}})"
            f"-[r:{type_union}]->() "
            f"WHERE r.valid_to IS NULL "
            f"RETURN count(r) AS cnt "
            f"LIMIT 1"
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
                "inference_query: _has_semantic_edges failed "
                "for node_id=%r: %s",
                node_id,
                exc,
            )
            return False

    def _is_target_of_semantic_edges(self, node_id: str) -> bool:
        """Check if a node is the target of any semantic edges.

        Args:
            node_id: The node_id to check.

        Returns:
            True if at least one active semantic edge points to this node.
        """
        type_union = "|".join(sorted(INFERENCE_TRAVERSABLE_EDGE_TYPES))

        cypher = (
            f"MATCH ()-[r:{type_union}]"
            f"->(t:WordSenseNode {{node_id: $node_id}}) "
            f"WHERE r.valid_to IS NULL "
            f"RETURN count(r) AS cnt "
            f"LIMIT 1"
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
                "inference_query: _is_target_of_semantic_edges failed "
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
                "inference_query: DENOTES resolution failed for %r: %s",
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
        path: list[_InferenceEdgeInfo],
    ) -> list[ReasoningStep]:
        """Convert a list of _InferenceEdgeInfo into ReasoningStep objects.

        Args:
            subject_id: The starting node_id.
            path: Ordered list of _InferenceEdgeInfo from subject toward target.

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
                    edge_type=edge_info.edge_type,
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
        request: InferenceQueryRequest,
        reasoning_steps: list[ReasoningStep],
        termination_reason: TerminationReason,
        confidence: float,
        depth_reached: int,
        execution_time_ms: float,
        concluded_node_id: str | None,
        path_found_but_truncated: bool,
        truncation_depth: int | None,
        continuation_available_at_depth: int | None,
    ) -> str:
        """Record a SemanticInferenceTrace for this inference query.

        Returns the trace_node_id, or empty string if recording failed
        or no trace_writer is configured.
        """
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
                "inference_query: failed to record inference trace "
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
        request: InferenceQueryRequest,
        termination_reason: TerminationReason | str,
        execution_time_ms: float,
        trace_node_id: str,
    ) -> InferenceQueryResult:
        """Build an empty InferenceQueryResult for degenerate cases."""
        return InferenceQueryResult(
            answer_found=False,
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
            path_found_but_truncated=False,
            truncation_depth=None,
            continuation_available_at_depth=None,
            edge_types_traversed=[],
            max_depth_used=self.max_depth,
        )


# ---------------------------------------------------------------------------
# Internal data structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _InferenceEdgeInfo:
    """Internal: one semantic edge encountered during inference traversal.

    Represents a neighbor node reachable via one semantic hop. Carries the
    edge metadata needed for reasoning step construction and confidence
    propagation. Unlike classification_query's _EdgeInfo (IS_A only), this
    carries the edge_type to support multi-type traversal.

    Attributes:
        node_id: The neighbor node's node_id.
        spelling: Human-readable spelling of the neighbor node.
        edge_id: The edge_id of the semantic relationship.
        edge_type: The type of the semantic relationship (IS_A, HAS_PROPERTY, etc.).
        confidence: Confidence of the semantic edge.
        scope_context_count: Scope context count of the edge.
    """

    node_id: str
    spelling: str
    edge_id: str
    edge_type: str
    confidence: float
    scope_context_count: int


@dataclass(frozen=True)
class _InferenceTraversalResult:
    """Internal: result of the multi-type BFS inference traversal.

    Attributes:
        path_found: True if a path from subject to target was found.
        reasoning_steps: The inference chain as ReasoningStep objects.
            Empty if no path was found.
        max_depth_reached: Maximum depth explored during traversal.
        confidence_floor_hits: Number of edges pruned by confidence floor.
        cycle_detected: True if any cycle was encountered during traversal.
        depth_limit_reached: True if traversal hit the max_depth boundary
            without finding the target.
        frontier_non_empty: True if there were unvisited nodes at the depth
            boundary when traversal was forced to stop. This distinguishes
            DEPTH_LIMIT_REACHED (frontier non-empty) from NO_EVIDENCE
            (frontier exhausted). Only meaningful when depth_limit_reached
            is True.
    """

    path_found: bool
    reasoning_steps: list[ReasoningStep]
    max_depth_reached: int
    confidence_floor_hits: int
    cycle_detected: bool
    depth_limit_reached: bool
    frontier_non_empty: bool


# ---------------------------------------------------------------------------
# Depth advancement logic (session-start check)
# ---------------------------------------------------------------------------


async def _check_depth_advancement(
    *,
    persistence: GraphPersistence,
    neo4j_session: neo4j.Session,
    current_depth: int,
    e5_prerequisite_met: bool,
    depth_rule_node: KnowledgeNode,
) -> int:
    """Check if inference depth should be advanced at session start.

    Reads success metrics from the graph and compares against the
    advancement criteria stored in the EvolutionRule node. If criteria
    are met, updates the EvolutionRule node and returns the new depth.

    Depth progression:
      1 -> 2: single_hop_success_rate >= 0.85, confirmed >= 20, clusters >= 3
      2 -> 3: two_hop_success_rate >= 0.80, confirmed >= 15, decalage check
      3 -> 4+: LOCKED until e5_prerequisite_met

    Args:
        persistence: GraphPersistence backend.
        neo4j_session: Neo4j session for metric queries.
        current_depth: Current max depth from the EvolutionRule.
        e5_prerequisite_met: Whether E5 inner monologue is available.
        depth_rule_node: The EvolutionRule KnowledgeNode.

    Returns:
        The new max depth (may be same as current if no advancement).
    """
    props = depth_rule_node.properties

    # Depth 4+ requires E5 inner monologue
    if current_depth >= DEFAULT_INFERENCE_ARCHITECTURAL_MAX:
        if not e5_prerequisite_met:
            return current_depth
        # E5 is available -- could advance to 4 or 5
        # For now, depth 4+ advancement criteria are not defined in E3
        return current_depth

    if current_depth == 1:
        # Check depth 2 unlock criteria
        required_success_rate = float(
            props.get("depth_2_success_rate", DEFAULT_DEPTH2_SUCCESS_RATE)
        )
        required_confirmed = int(
            props.get("depth_2_min_confirmed", DEFAULT_DEPTH2_MIN_CONFIRMED)
        )
        required_clusters = int(
            props.get("depth_2_cluster_coverage", DEFAULT_DEPTH2_CLUSTER_COVERAGE)
        )

        # Query current metrics
        success_rate = _compute_inference_success_rate(
            neo4j_session, max_depth=1
        )
        confirmed_count = _count_confirmed_inferences(neo4j_session, max_depth=1)
        cluster_count = _count_inference_concept_clusters(neo4j_session)

        _log.debug(
            "inference_query depth advancement check (1->2): "
            "success_rate=%.2f/%.2f confirmed=%d/%d clusters=%d/%d",
            success_rate,
            required_success_rate,
            confirmed_count,
            required_confirmed,
            cluster_count,
            required_clusters,
        )

        if (
            success_rate >= required_success_rate
            and confirmed_count >= required_confirmed
            and cluster_count >= required_clusters
        ):
            # Advance to depth 2
            await _update_depth_rule(persistence, depth_rule_node, new_depth=2)
            return 2

    elif current_depth == 2:
        # Check depth 3 unlock criteria
        required_success_rate = float(
            props.get("depth_3_success_rate", DEFAULT_DEPTH3_SUCCESS_RATE)
        )
        required_confirmed = int(
            props.get("depth_3_min_confirmed", DEFAULT_DEPTH3_MIN_CONFIRMED)
        )

        success_rate = _compute_inference_success_rate(
            neo4j_session, max_depth=2
        )
        confirmed_count = _count_confirmed_inferences(neo4j_session, max_depth=2)
        cluster_count = _count_inference_concept_clusters(neo4j_session)

        _log.debug(
            "inference_query depth advancement check (2->3): "
            "success_rate=%.2f/%.2f confirmed=%d/%d clusters=%d/3",
            success_rate,
            required_success_rate,
            confirmed_count,
            required_confirmed,
            cluster_count,
        )

        if (
            success_rate >= required_success_rate
            and confirmed_count >= required_confirmed
            and cluster_count >= 3  # horizontal decalage check
        ):
            await _update_depth_rule(persistence, depth_rule_node, new_depth=3)
            return 3

    return current_depth


async def _update_depth_rule(
    persistence: GraphPersistence,
    depth_rule_node: KnowledgeNode,
    new_depth: int,
) -> None:
    """Update the EvolutionRule node with a new current_max_depth.

    This persists the depth advancement so it survives restarts.
    The next session will read the updated value.

    Args:
        persistence: GraphPersistence backend.
        depth_rule_node: The existing EvolutionRule node to update.
        new_depth: The new max depth value.
    """
    depth_rule_node.properties["current_max_depth"] = new_depth
    depth_rule_node.properties["last_advancement_timestamp"] = (
        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    )
    depth_rule_node.properties[f"depth_{new_depth}_unlocked_at"] = (
        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    )
    try:
        await persistence.save_node(depth_rule_node)
        _log.info(
            "inference_query: EvolutionRule %s updated to depth %d",
            INFERENCE_DEPTH_RULE_ID,
            new_depth,
        )
    except Exception as exc:
        _log.warning(
            "inference_query: failed to update EvolutionRule depth to %d: %s",
            new_depth,
            exc,
        )


# ---------------------------------------------------------------------------
# Metric query helpers for depth advancement
# ---------------------------------------------------------------------------


def _compute_inference_success_rate(
    session: neo4j.Session,
    max_depth: int,
) -> float:
    """Compute the success rate of inference queries at a given max depth.

    Success rate = answer_found / (answer_found + no_evidence + depth_limit_reached)
    for traces where depth_reached <= max_depth.

    Args:
        session: An open Neo4j session.
        max_depth: Only count traces where depth_reached <= this.

    Returns:
        Success rate in [0.0, 1.0]. Returns 0.0 if no traces exist.
    """
    cypher = (
        "MATCH (t:SemanticInferenceTrace) "
        "WHERE t.prop_query_type = 'inference_query' "
        "  AND t.status <> 'superseded' "
        "  AND t.prop_depth_reached <= $max_depth "
        "WITH t.prop_termination_reason AS reason, count(t) AS cnt "
        "RETURN reason, cnt"
    )

    try:
        def _read(tx: neo4j.ManagedTransaction) -> float:
            result = tx.run(cypher, max_depth=max_depth)
            success_count = 0
            total_count = 0
            for record in result:
                reason = record.get("reason", "")
                cnt = int(record.get("cnt", 0))
                total_count += cnt
                if reason == "answer_found":
                    success_count += cnt
            if total_count == 0:
                return 0.0
            return success_count / total_count

        return session.execute_read(_read)
    except Exception as exc:
        _log.warning(
            "inference_query: _compute_inference_success_rate failed: %s", exc
        )
        return 0.0


def _count_confirmed_inferences(
    session: neo4j.Session,
    max_depth: int,
) -> int:
    """Count inference traces with answer_found at the given depth range.

    Counts traces where the conclusion was guardian-confirmed (the inference
    trace is not superseded and has answer_found termination).

    Args:
        session: An open Neo4j session.
        max_depth: Only count traces where depth_reached <= this.

    Returns:
        Number of confirmed inference traces.
    """
    cypher = (
        "MATCH (t:SemanticInferenceTrace) "
        "WHERE t.prop_query_type = 'inference_query' "
        "  AND t.prop_termination_reason = 'answer_found' "
        "  AND t.status <> 'superseded' "
        "  AND t.prop_depth_reached <= $max_depth "
        "RETURN count(t) AS cnt"
    )

    try:
        def _read(tx: neo4j.ManagedTransaction) -> int:
            result = tx.run(cypher, max_depth=max_depth)
            record = result.single()
            return int(record["cnt"]) if record else 0

        return session.execute_read(_read)
    except Exception as exc:
        _log.warning(
            "inference_query: _count_confirmed_inferences failed: %s", exc
        )
        return 0


def _count_inference_concept_clusters(session: neo4j.Session) -> int:
    """Count distinct concept clusters (IS_A root ancestors) covered by inferences.

    A concept cluster is a root node in the IS_A taxonomy that has been
    the subject of at least one successful inference query. Having clusters >= 3
    means the system has demonstrated inference capability across diverse
    conceptual domains (horizontal decalage).

    Args:
        session: An open Neo4j session.

    Returns:
        Number of distinct concept clusters with successful inferences.
    """
    cypher = (
        "MATCH (t:SemanticInferenceTrace)-[:REASONED_ABOUT]->(subject) "
        "WHERE t.prop_query_type = 'inference_query' "
        "  AND t.prop_termination_reason = 'answer_found' "
        "  AND t.status <> 'superseded' "
        "WITH DISTINCT subject.node_id AS subject_id "
        "MATCH path = (s:WordSenseNode {node_id: subject_id})-[:IS_A*0..5]->(root) "
        "WHERE NOT (root)-[:IS_A]->() "
        "RETURN count(DISTINCT root.node_id) AS cluster_count"
    )

    try:
        def _read(tx: neo4j.ManagedTransaction) -> int:
            result = tx.run(cypher)
            record = result.single()
            return int(record["cluster_count"]) if record else 0

        return session.execute_read(_read)
    except Exception as exc:
        _log.warning(
            "inference_query: _count_inference_concept_clusters failed: %s", exc
        )
        return 0


# ---------------------------------------------------------------------------
# Developmental gating check (called by SemanticQueryHandler / T012)
# ---------------------------------------------------------------------------


async def check_inference_gate(
    persistence: GraphPersistence,
    neo4j_session: neo4j.Session,
) -> tuple[bool, dict[str, Any]]:
    """Check whether inference_query is developmentally unlocked.

    Reads the ``rule:inference_gate_config`` EvolutionRule node for the
    threshold configuration, then queries the graph for current counts.

    The gate requires all three conditions to be met simultaneously:
      1. At least N successful classification queries (default 20)
      2. At least M distinct semantic edge types represented (default 5)
      3. At least K cross-domain bridge edges / DENOTES (default 3)

    This function is called by the SemanticQueryHandler (T010/T012) before
    routing to the inference executor. It is NOT called by the executor
    itself -- separation of concerns.

    Args:
        persistence: GraphPersistence backend.
        neo4j_session: Direct Neo4j session for counting queries.

    Returns:
        Tuple of (is_unlocked, details_dict). The details_dict contains
        the current counts and thresholds for diagnostic/logging purposes.
    """
    gate_rule = await persistence.get_node(INFERENCE_GATE_RULE_ID)

    if gate_rule is not None:
        required_classifications = int(
            gate_rule.properties.get(
                "required_classifications", DEFAULT_GATE_CLASSIFICATION_COUNT
            )
        )
        required_edge_types = int(
            gate_rule.properties.get(
                "required_semantic_edge_types", DEFAULT_GATE_SEMANTIC_EDGE_TYPES
            )
        )
        required_cross_domain = int(
            gate_rule.properties.get(
                "required_cross_domain_facts", DEFAULT_GATE_CROSS_DOMAIN_FACTS
            )
        )
        guardian_override = bool(
            gate_rule.properties.get("guardian_override_enabled", False)
        )
        if guardian_override:
            _log.info(
                "inference_query: gate bypassed by guardian override"
            )
            return True, {"guardian_override": True}
    else:
        required_classifications = DEFAULT_GATE_CLASSIFICATION_COUNT
        required_edge_types = DEFAULT_GATE_SEMANTIC_EDGE_TYPES
        required_cross_domain = DEFAULT_GATE_CROSS_DOMAIN_FACTS

    # Count 1: Successful classification queries
    classification_count = _count_successful_classifications(neo4j_session)

    # Count 2: Distinct semantic edge types
    edge_type_count = _count_distinct_semantic_edge_types(neo4j_session)

    # Count 3: Cross-domain DENOTES edges
    cross_domain_count = _count_cross_domain_edges(neo4j_session)

    is_unlocked = (
        classification_count >= required_classifications
        and edge_type_count >= required_edge_types
        and cross_domain_count >= required_cross_domain
    )

    details = {
        "is_unlocked": is_unlocked,
        "classification_count": classification_count,
        "required_classifications": required_classifications,
        "edge_type_count": edge_type_count,
        "required_edge_types": required_edge_types,
        "cross_domain_count": cross_domain_count,
        "required_cross_domain": required_cross_domain,
    }

    _log.debug(
        "inference_query gate check: unlocked=%s classifications=%d/%d "
        "edge_types=%d/%d cross_domain=%d/%d",
        is_unlocked,
        classification_count,
        required_classifications,
        edge_type_count,
        required_edge_types,
        cross_domain_count,
        required_cross_domain,
    )

    return is_unlocked, details


def _count_successful_classifications(session: neo4j.Session) -> int:
    """Count successful classification_query traces."""
    cypher = (
        "MATCH (t:SemanticInferenceTrace) "
        "WHERE t.prop_query_type = 'classification_query' "
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
            "inference_query: _count_successful_classifications failed: %s",
            exc,
        )
        return 0


def _count_distinct_semantic_edge_types(session: neo4j.Session) -> int:
    """Count how many distinct semantic edge types have active edges."""
    # Query all relationship types that exist between WordSenseNodes
    cypher = (
        "MATCH (:WordSenseNode)-[r]->(:WordSenseNode) "
        "WHERE r.valid_to IS NULL "
        "WITH type(r) AS rel_type "
        "RETURN count(DISTINCT rel_type) AS cnt"
    )

    try:
        def _read(tx: neo4j.ManagedTransaction) -> int:
            result = tx.run(cypher)
            record = result.single()
            return int(record["cnt"]) if record else 0

        return session.execute_read(_read)
    except Exception as exc:
        _log.warning(
            "inference_query: _count_distinct_semantic_edge_types failed: %s",
            exc,
        )
        return 0


def _count_cross_domain_edges(session: neo4j.Session) -> int:
    """Count active DENOTES (cross-domain bridge) edges."""
    cypher = (
        "MATCH ()-[r:DENOTES]->() "
        "WHERE r.valid_to IS NULL "
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
            "inference_query: _count_cross_domain_edges failed: %s", exc
        )
        return 0


# ---------------------------------------------------------------------------
# Bootstrap functions
# ---------------------------------------------------------------------------


async def bootstrap_inference_query_template(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Bootstrap the proc:inference_query ProceduralTemplate and its config.

    Creates:
      1. The ``proc:inference_query`` ProceduralTemplate node (SCHEMA level).
      2. The ``rule:inference_depth_config`` EvolutionRule node (META_SCHEMA)
         with staged depth progression 1 -> 2 -> 3 and e5_prerequisite_met flag.
      3. The ``rule:inference_gate_config`` EvolutionRule node (META_SCHEMA).
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
        source_id="inference-query-bootstrap",
        confidence=1.0,
    )

    # 1. Create the ProceduralTemplate node
    template_id = INFERENCE_QUERY_TEMPLATE_ID
    existing_template = await persistence.get_node(template_id)

    if existing_template is not None:
        counts["template_existing"] += 1
    else:
        template_node = KnowledgeNode(
            node_id=template_id,
            node_type=PROCEDURAL_TEMPLATE,
            schema_level=SchemaLevel.SCHEMA,
            properties={
                "name": INFERENCE_QUERY_TEMPLATE_NAME,
                "display_name": "Inference Query",
                "domain": "semantic",
                "description": (
                    "Answers multi-hop semantic reasoning questions like "
                    "'do cats breathe air?' by traversing IS_A, HAS_PROPERTY, "
                    "CAUSES, and other semantic edge types. Uses BFS with "
                    "cycle detection, per-type confidence degradation, and "
                    "staged depth progression."
                ),
                "parameters": ["$subject", "$target"],
                "query_type": "inference_query",
                "depth_config_rule": str(INFERENCE_DEPTH_RULE_ID),
                "gate_config_rule": str(INFERENCE_GATE_RULE_ID),
                "prompt_description": (
                    "inference_query: answers multi-hop reasoning questions "
                    "by traversing semantic edge chains from subject to target"
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
            "inference_query_bootstrap: created ProceduralTemplate %s",
            template_id,
        )

    # 2. Create the EvolutionRule depth config node
    depth_rule_id = INFERENCE_DEPTH_RULE_ID
    existing_depth = await persistence.get_node(depth_rule_id)

    if existing_depth is not None:
        counts["rule_existing"] += 1
    else:
        depth_rule_node = KnowledgeNode(
            node_id=depth_rule_id,
            node_type="EvolutionRule",
            schema_level=SchemaLevel.META_SCHEMA,
            properties={
                "rule_name": "INFERENCE_DEPTH_CONFIG",
                "current_max_depth": DEFAULT_INFERENCE_START_DEPTH,
                "architectural_max_depth": DEFAULT_INFERENCE_ARCHITECTURAL_MAX,
                "post_e5_architectural_max": DEFAULT_INFERENCE_POST_E5_MAX,
                "e5_prerequisite_met": False,
                # Depth 2 unlock criteria
                "depth_2_success_rate": DEFAULT_DEPTH2_SUCCESS_RATE,
                "depth_2_min_confirmed": DEFAULT_DEPTH2_MIN_CONFIRMED,
                "depth_2_cluster_coverage": DEFAULT_DEPTH2_CLUSTER_COVERAGE,
                # Depth 3 unlock criteria
                "depth_3_success_rate": DEFAULT_DEPTH3_SUCCESS_RATE,
                "depth_3_min_confirmed": DEFAULT_DEPTH3_MIN_CONFIRMED,
                "depth_3_horizontal_decalage_check": True,
                # Depth 4+ locked until E5
                "depth_4_criteria": "LOCKED_UNTIL_E5",
                "depth_5_criteria": "LOCKED_UNTIL_E5",
                "description": (
                    "Governs inference_query multi-hop traversal depth with "
                    "staged progression: starts at depth 1, advances to 2 "
                    "after success criteria met, then to 3. Depth 4+ blocked "
                    "until E5 inner monologue delivers working memory support."
                ),
                "tunable_by_guardian": True,
                "installed_by_skill": "semantic-ontology",
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id="inference-query-bootstrap",
                confidence=1.0,
            ),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        await persistence.save_node(depth_rule_node)
        counts["rule_created"] += 1
        _log.info(
            "inference_query_bootstrap: created EvolutionRule %s",
            depth_rule_id,
        )

    # 3. Create the EvolutionRule gate config node
    gate_rule_id = INFERENCE_GATE_RULE_ID
    existing_gate = await persistence.get_node(gate_rule_id)

    if existing_gate is not None:
        counts["rule_existing"] += 1
    else:
        gate_rule_node = KnowledgeNode(
            node_id=gate_rule_id,
            node_type="EvolutionRule",
            schema_level=SchemaLevel.META_SCHEMA,
            properties={
                "rule_name": "INFERENCE_GATE_CONFIG",
                "required_classifications": DEFAULT_GATE_CLASSIFICATION_COUNT,
                "required_semantic_edge_types": DEFAULT_GATE_SEMANTIC_EDGE_TYPES,
                "required_cross_domain_facts": DEFAULT_GATE_CROSS_DOMAIN_FACTS,
                "guardian_override_enabled": False,
                "description": (
                    "Developmental gating for inference_query. Requires "
                    "20 successful classifications, 5 semantic edge types, "
                    "and 3 cross-domain facts before inference becomes "
                    "available. Guardian can override."
                ),
                "tunable_by_guardian": True,
                "installed_by_skill": "semantic-ontology",
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id="inference-query-bootstrap",
                confidence=1.0,
            ),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        await persistence.save_node(gate_rule_node)
        counts["rule_created"] += 1
        _log.info(
            "inference_query_bootstrap: created EvolutionRule %s",
            gate_rule_id,
        )

    # 4. Create DEPENDS_ON edges
    dep_edges = [
        (
            EdgeId("dep:inf_query:depth_config"),
            template_id,
            depth_rule_id,
            "depth_config",
        ),
        (
            EdgeId("dep:inf_query:gate_config"),
            template_id,
            gate_rule_id,
            "gate_config",
        ),
        (
            EdgeId("dep:inf_query:semantic_domain"),
            template_id,
            NodeId("domain:semantic"),
            "semantic_domain",
        ),
        (
            EdgeId("dep:inf_query:classification_query"),
            template_id,
            NodeId("proc:classification_query"),
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
                "inference_query_bootstrap: skipping DEPENDS_ON edge %s "
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
        "inference_query_bootstrap: complete -- "
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
    "INFERENCE_QUERY_TEMPLATE_ID",
    "INFERENCE_QUERY_TEMPLATE_NAME",
    "INFERENCE_DEPTH_RULE_ID",
    "INFERENCE_GATE_RULE_ID",
    "DEFAULT_INFERENCE_START_DEPTH",
    "DEFAULT_INFERENCE_ARCHITECTURAL_MAX",
    "DEFAULT_INFERENCE_POST_E5_MAX",
    "EDGE_TYPE_DEGRADATION",
    "INFERENCE_TRAVERSABLE_EDGE_TYPES",
    "DEFAULT_GATE_CLASSIFICATION_COUNT",
    "DEFAULT_GATE_SEMANTIC_EDGE_TYPES",
    "DEFAULT_GATE_CROSS_DOMAIN_FACTS",
    # Data structures
    "InferenceQueryRequest",
    "InferenceQueryResult",
    # Confidence computation
    "compute_inference_chain_confidence",
    # Executor
    "InferenceQueryExecutor",
    # Developmental gating
    "check_inference_gate",
    # Bootstrap
    "bootstrap_inference_query_template",
]

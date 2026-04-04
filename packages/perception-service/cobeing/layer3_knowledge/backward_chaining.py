"""Backward chaining executor for goal decomposition (P1.8-E4).

Implements goal-directed problem-solving by working backward from a desired
goal through prerequisite chains in the semantic graph. Given a goal node
(a concept the system wants to achieve or understand), the executor traverses
REQUIRES, CAUSES, ENABLES, and ACHIEVES edges in reverse to discover what
prerequisites must be satisfied.

This is the fourth procedural query type in the developmental sequence:
  definition -> classification -> inference -> goal_decomposition

Architecture:

  1. Accept a goal node_id (the thing to achieve or reach).
  2. Read current depth gate from the ``rule:goal_decomposition_gate``
     EvolutionRule node in the graph.
  3. Perform bounded backward BFS from the goal node, following incoming
     REQUIRES, ENABLES, CAUSES, and ACHIEVES edges in reverse direction
     (if X REQUIRES Y, then from X we discover prerequisite Y).
  4. Apply confidence propagation through the chain with the same per-type
     degradation factors used by inference_query.
  5. Detect cycles using a visited-node set.
  6. Track which prerequisites are satisfied (exist as ACTIVE nodes in the
     graph) and which are missing.
  7. Record a SemanticInferenceTrace (A.19 compliance) with query_type
     "goal_decomposition".
  8. Return a GoalDecomposition result with the prerequisite chain, missing
     prerequisites, depth reached, and truncation metadata.

Developmental depth gating (Piaget-style staged progression):

  Backward chaining depth starts small and grows with demonstrated competence:

  - Stage 1: max_depth=1 (single prerequisite hop). Requires 5 successful
    decompositions to advance.
  - Stage 2: max_depth=3 (three-hop prerequisite chains). Requires 10
    successful decompositions to advance.
  - Stage 3: max_depth=7 (full prerequisite trees). Terminal stage.

  A "successful" decomposition is one where is_complete=True (all
  prerequisites in the chain are satisfied in the graph). The gate state
  is stored as a GoalDecompositionGate EvolutionRule node in the graph.

Design constraints (from CANON):

  - No direct graph writes from backward chaining. It produces plans
    (read-only analysis), not facts.
  - Depth gating is strict: cannot exceed current max_depth even if the
    chain continues deeper.
  - All results describe the current state of the graph. Missing
    prerequisites identify gaps that the guardian could fill.

Confidence propagation formula (matches inference_query):

  chain_confidence = product(edge_confidences) * product(1 - type_degradation)

CANON compliance:
  A.1   -- all semantic edges come from guardian teaching or inference
  A.10  -- bounded traversal (max_depth from gate, ceiling at 7)
  A.11  -- provenance on every node and edge
  A.19  -- SemanticInferenceTrace recorded per decomposition
  A.20  -- operates within SemanticDomain edges

Usage::

    from cobeing.layer3_knowledge.backward_chaining import (
        BackwardChainingExecutor,
        GoalDecomposition,
        GoalDecompositionRequest,
        PrerequisiteStep,
    )

    executor = await BackwardChainingExecutor.from_graph(
        persistence=graph,
        trace_writer=trace_writer,
    )

    result = await executor.decompose(
        GoalDecompositionRequest(
            goal_node_id="ws:passing_exam",
            session_id="session-001",
            correlation_id="goal-001",
        )
    )

    if result.is_complete:
        print("All prerequisites satisfied!")
    else:
        print(f"Missing: {result.missing_prerequisites}")
    for step in result.prerequisite_chain:
        print(f"  depth {step.depth}: {step.node_id} "
              f"({step.edge_type}, satisfied={step.is_satisfied})")
"""

from __future__ import annotations

import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass, field

from cobeing.layer3_knowledge.exceptions import KnowledgeGraphError
from cobeing.layer3_knowledge.inference_query import (
    EDGE_TYPE_DEGRADATION,
    DEFAULT_DEGRADATION_PER_HOP,
)
from cobeing.layer3_knowledge.inference_trace import (
    InferenceTraceWriter,
    ReasoningStep,
    TerminationReason,
)
from cobeing.layer3_knowledge.node_types import (
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter
from cobeing.layer3_knowledge.semantic_query import MIN_CONFIDENCE_FLOOR
from cobeing.layer3_knowledge.semantic_types import (
    ACHIEVES,
    CAUSES,
    ENABLES,
    REQUIRES,
)
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import NodeId

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GOAL_DECOMPOSITION_GATE_ID = NodeId("rule:goal_decomposition_gate")
"""NodeId of the EvolutionRule governing backward chaining depth progression."""

# Backward chaining traverses these edge types in reverse direction.
# If node A has edge "A REQUIRES B", then from goal A we discover
# prerequisite B by following the incoming REQUIRES edge.
BACKWARD_EDGE_TYPES: frozenset[str] = frozenset({
    REQUIRES,
    CAUSES,
    ENABLES,
    ACHIEVES,
})
"""Edge types traversed in reverse during backward chaining.

REQUIRES: X requires Y -> Y is a prerequisite for X.
CAUSES:   Y causes X  -> Y must happen for X to result.
ENABLES:  Y enables X  -> Y must be present for X to be possible.
ACHIEVES: Y achieves X -> Y is an action that accomplishes X.
"""

# Depth gate stages
STAGE_1_MAX_DEPTH: int = 1
"""Stage 1: single prerequisite hop."""

STAGE_1_SUCCESS_THRESHOLD: int = 5
"""Successful decompositions required to advance from stage 1 to stage 2."""

STAGE_2_MAX_DEPTH: int = 3
"""Stage 2: three-hop prerequisite chains."""

STAGE_2_SUCCESS_THRESHOLD: int = 10
"""Successful decompositions required to advance from stage 2 to stage 3."""

STAGE_3_MAX_DEPTH: int = 7
"""Stage 3: full prerequisite trees. Terminal stage."""

# Absolute architectural ceiling
ARCHITECTURAL_MAX_DEPTH: int = 7
"""Hard ceiling on backward chaining depth. Cannot be exceeded."""


# ---------------------------------------------------------------------------
# Request / Result data structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GoalDecompositionRequest:
    """Input to BackwardChainingExecutor.decompose().

    Attributes:
        goal_node_id: The node_id of the goal to decompose. This is the
            concept the system wants to achieve or understand.
        session_id: Current conversation session identifier.
        correlation_id: Traces this request through logs and provenance.
        description: Optional human-readable description of the goal.
            If not provided, the executor reads it from the node's properties.
    """

    goal_node_id: str
    session_id: str
    correlation_id: str
    description: str = ""


@dataclass(frozen=True)
class PrerequisiteStep:
    """One hop in a backward chaining prerequisite chain.

    Represents a single prerequisite discovered by traversing a semantic
    edge in reverse. Ordered by depth (closest prerequisites first).

    Attributes:
        node_id: The node_id of the prerequisite concept.
        description: Human-readable description of the prerequisite.
        edge_type: The semantic relationship type that connects this
            prerequisite to the next step toward the goal (REQUIRES,
            CAUSES, ENABLES, or ACHIEVES).
        edge_id: The edge_id of the semantic edge traversed.
        confidence: Confidence of the traversed edge.
        depth: How many hops back from the goal this prerequisite is.
            depth=1 means a direct prerequisite of the goal.
        is_satisfied: Whether this prerequisite node exists as an ACTIVE
            node in the graph. True means the prerequisite is known to
            be available; False means it is missing or inactive.
    """

    node_id: str
    description: str
    edge_type: str
    edge_id: str
    confidence: float
    depth: int
    is_satisfied: bool


@dataclass(frozen=True)
class GoalDecomposition:
    """Result of a backward chaining goal decomposition.

    Contains the full prerequisite chain from the goal backward through
    all discovered prerequisites, along with metadata about completeness,
    depth, confidence, and truncation.

    Attributes:
        goal_id: The node_id of the goal that was decomposed.
        goal_description: Human-readable description of the goal.
        prerequisite_chain: Ordered list of PrerequisiteStep objects.
            Steps are ordered by discovery (BFS order), with shallower
            prerequisites (closer to the goal) appearing first.
        max_depth_reached: The deepest hop level explored during traversal.
        confidence: Overall confidence of the decomposition. Product of
            all edge confidences in the chain with per-type degradation.
        is_complete: True if all prerequisites in the chain are satisfied
            (exist as ACTIVE nodes in the graph). A complete decomposition
            means the system has all the knowledge needed.
        missing_prerequisites: List of node_ids for prerequisites that
            are not satisfied in the graph. These represent knowledge gaps.
        truncated: True if the traversal hit the depth limit while the
            frontier was still non-empty (more prerequisites may exist
            beyond the depth cap).
        termination_reason: Why the traversal stopped.
        execution_time_ms: Wall-clock time for the decomposition.
        trace_node_id: NodeId of the SemanticInferenceTrace created for
            A.19 compliance. Empty string if trace writing was skipped.
        gate_max_depth: The depth gate limit that was applied for this
            decomposition.
        cycle_detected: True if a cycle was encountered during traversal.
    """

    goal_id: str
    goal_description: str
    prerequisite_chain: list[PrerequisiteStep]
    max_depth_reached: int
    confidence: float
    is_complete: bool
    missing_prerequisites: list[str]
    truncated: bool
    termination_reason: str
    execution_time_ms: float
    trace_node_id: str
    gate_max_depth: int
    cycle_detected: bool


# ---------------------------------------------------------------------------
# Depth gate state
# ---------------------------------------------------------------------------


@dataclass
class _DepthGateState:
    """Internal state for the developmental depth gate.

    Read from and written to the rule:goal_decomposition_gate EvolutionRule
    node in the graph. Not part of the public API.

    Attributes:
        current_max_depth: The current operational depth limit.
        successful_completions: Number of complete decompositions at
            the current depth stage.
    """

    current_max_depth: int = STAGE_1_MAX_DEPTH
    successful_completions: int = 0


# ---------------------------------------------------------------------------
# BFS frontier entry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _FrontierEntry:
    """Internal BFS frontier entry. Not part of the public API.

    Attributes:
        node_id: The node to explore.
        depth: How many hops from the goal.
        chain_confidence: Accumulated confidence from goal to this node.
        parent_edge_type: The edge type that led to this node.
        parent_edge_id: The edge_id that led to this node.
        parent_edge_confidence: Confidence of the edge that led here.
    """

    node_id: str
    depth: int
    chain_confidence: float
    parent_edge_type: str
    parent_edge_id: str
    parent_edge_confidence: float


# ---------------------------------------------------------------------------
# Confidence propagation
# ---------------------------------------------------------------------------


def _compute_step_confidence(
    chain_confidence: float,
    edge_type: str,
    edge_confidence: float,
) -> float:
    """Compute confidence after one backward hop.

    Uses the same per-type degradation factors as inference_query to
    maintain consistency across all semantic traversal operations.

    Args:
        chain_confidence: Accumulated confidence up to this point.
        edge_type: The semantic edge type being traversed.
        edge_confidence: Confidence of the specific edge.

    Returns:
        Updated chain confidence in [0.0, 1.0].
    """
    degradation = EDGE_TYPE_DEGRADATION.get(edge_type, DEFAULT_DEGRADATION_PER_HOP)
    type_factor = 1.0 - degradation
    return chain_confidence * edge_confidence * type_factor


# ---------------------------------------------------------------------------
# BackwardChainingExecutor
# ---------------------------------------------------------------------------


class BackwardChainingExecutor:
    """Executes goal decomposition through backward chaining over semantic edges.

    This executor is Layer 3 infrastructure. It never calls the LLM. It
    traverses the semantic graph backward from a goal node through REQUIRES,
    CAUSES, ENABLES, and ACHIEVES edges to discover prerequisite chains, and
    returns a structured GoalDecomposition result.

    The executor reads its depth gate configuration from the
    ``rule:goal_decomposition_gate`` EvolutionRule node in the graph. If the
    node does not exist, it falls back to Stage 1 defaults (max_depth=1).

    Attributes:
        persistence: GraphPersistence backend for node/edge reads.
        trace_writer: Optional InferenceTraceWriter for A.19 compliance.
        gate_state: Current depth gate state (read from graph at init).
    """

    def __init__(
        self,
        persistence: GraphPersistence,
        trace_writer: InferenceTraceWriter | None = None,
        gate_state: _DepthGateState | None = None,
    ) -> None:
        self._persistence = persistence
        self._trace_writer = trace_writer
        self._gate = gate_state if gate_state is not None else _DepthGateState()

    @classmethod
    async def from_graph(
        cls,
        persistence: GraphPersistence,
        trace_writer: InferenceTraceWriter | None = None,
    ) -> BackwardChainingExecutor:
        """Create a BackwardChainingExecutor with config read from the graph.

        Reads the ``rule:goal_decomposition_gate`` EvolutionRule node to
        obtain the current depth gate state. Falls back to Stage 1 defaults
        if the node does not exist.

        Args:
            persistence: GraphPersistence backend.
            trace_writer: Optional InferenceTraceWriter for A.19 traces.

        Returns:
            A configured BackwardChainingExecutor.
        """
        gate = _DepthGateState()

        gate_node = await persistence.get_node(GOAL_DECOMPOSITION_GATE_ID)
        if gate_node is not None:
            gate.current_max_depth = int(
                gate_node.properties.get("current_max_depth", STAGE_1_MAX_DEPTH)
            )
            gate.successful_completions = int(
                gate_node.properties.get("successful_completions", 0)
            )

        _log.info(
            "backward_chaining: initialized gate state "
            "(max_depth=%d, completions=%d)",
            gate.current_max_depth,
            gate.successful_completions,
        )

        return cls(
            persistence=persistence,
            trace_writer=trace_writer,
            gate_state=gate,
        )

    @property
    def current_max_depth(self) -> int:
        """The current operational depth limit from the gate."""
        return self._gate.current_max_depth

    async def decompose(
        self,
        request: GoalDecompositionRequest,
    ) -> GoalDecomposition:
        """Decompose a goal into its prerequisite chain via backward BFS.

        Traverses REQUIRES, CAUSES, ENABLES, and ACHIEVES edges in reverse
        from the goal node to discover what prerequisites must be satisfied.
        Respects the current depth gate and records an A.19 inference trace.

        This method is read-only. It does not write any semantic facts to
        the graph. It only reads existing edges and nodes, plus writes the
        trace node (which is metadata, not a semantic assertion).

        Args:
            request: The goal decomposition request specifying the goal
                node, session, and correlation identifiers.

        Returns:
            A GoalDecomposition with the prerequisite chain, completeness
            status, missing prerequisites, and trace metadata.

        Raises:
            KnowledgeGraphError: If graph reads fail during traversal.
        """
        start_time = time.monotonic()
        max_depth = min(self._gate.current_max_depth, ARCHITECTURAL_MAX_DEPTH)

        # Resolve the goal node
        goal_node = await self._persistence.get_node(NodeId(request.goal_node_id))
        goal_description = request.description
        if not goal_description and goal_node is not None:
            goal_description = (
                goal_node.properties.get("spelling", "")
                or goal_node.properties.get("display_name", "")
                or goal_node.properties.get("name", "")
                or request.goal_node_id
            )

        if goal_node is None:
            # Goal node does not exist in graph -- return empty decomposition
            elapsed_ms = (time.monotonic() - start_time) * 1000
            _log.warning(
                "backward_chaining: goal node %s not found in graph",
                request.goal_node_id,
            )
            return GoalDecomposition(
                goal_id=request.goal_node_id,
                goal_description=goal_description or request.goal_node_id,
                prerequisite_chain=[],
                max_depth_reached=0,
                confidence=0.0,
                is_complete=False,
                missing_prerequisites=[],
                truncated=False,
                termination_reason=str(TerminationReason.NO_EVIDENCE),
                execution_time_ms=elapsed_ms,
                trace_node_id="",
                gate_max_depth=max_depth,
                cycle_detected=False,
            )

        # BFS backward from goal
        prerequisite_chain: list[PrerequisiteStep] = []
        reasoning_steps: list[ReasoningStep] = []
        visited: set[str] = {request.goal_node_id}
        frontier: deque[_FrontierEntry] = deque()
        cycle_detected = False
        frontier_alive_at_depth_limit = False
        deepest_depth = 0

        # Seed frontier: find all edges pointing TO the goal node
        # (these are the direct prerequisites)
        initial_edges = await self._find_prerequisite_edges(request.goal_node_id)
        for edge in initial_edges:
            if edge.confidence < MIN_CONFIDENCE_FLOOR:
                continue
            frontier.append(_FrontierEntry(
                node_id=str(edge.source_id),
                depth=1,
                chain_confidence=_compute_step_confidence(
                    1.0, edge.edge_type, edge.confidence,
                ),
                parent_edge_type=edge.edge_type,
                parent_edge_id=str(edge.edge_id),
                parent_edge_confidence=edge.confidence,
            ))

        while frontier:
            entry = frontier.popleft()

            # Cycle detection
            if entry.node_id in visited:
                cycle_detected = True
                _log.debug(
                    "backward_chaining: cycle detected at node %s (depth %d)",
                    entry.node_id,
                    entry.depth,
                )
                continue

            visited.add(entry.node_id)

            if entry.depth > deepest_depth:
                deepest_depth = entry.depth

            # Check if this prerequisite node is satisfied
            prereq_node = await self._persistence.get_node(
                NodeId(entry.node_id)
            )
            is_satisfied = (
                prereq_node is not None
                and prereq_node.status == NodeStatus.ACTIVE
            )

            prereq_description = ""
            if prereq_node is not None:
                prereq_description = (
                    prereq_node.properties.get("spelling", "")
                    or prereq_node.properties.get("display_name", "")
                    or prereq_node.properties.get("name", "")
                    or entry.node_id
                )
            else:
                prereq_description = entry.node_id

            step = PrerequisiteStep(
                node_id=entry.node_id,
                description=prereq_description,
                edge_type=entry.parent_edge_type,
                edge_id=entry.parent_edge_id,
                confidence=entry.chain_confidence,
                depth=entry.depth,
                is_satisfied=is_satisfied,
            )
            prerequisite_chain.append(step)

            # Record reasoning step for trace
            reasoning_steps.append(ReasoningStep(
                hop=len(reasoning_steps),
                source_node_id=entry.node_id,
                edge_type=entry.parent_edge_type,
                edge_id=entry.parent_edge_id,
                target_node_id=request.goal_node_id if entry.depth == 1 else "",
                edge_confidence=entry.parent_edge_confidence,
            ))

            # Depth gate check: do not expand beyond max_depth
            if entry.depth >= max_depth:
                # Check if this node has further prerequisites (for
                # truncation detection)
                deeper_edges = await self._find_prerequisite_edges(entry.node_id)
                if deeper_edges:
                    frontier_alive_at_depth_limit = True
                continue

            # Expand: find prerequisites of this prerequisite
            next_edges = await self._find_prerequisite_edges(entry.node_id)
            for edge in next_edges:
                if edge.confidence < MIN_CONFIDENCE_FLOOR:
                    continue
                next_node_id = str(edge.source_id)
                if next_node_id in visited:
                    cycle_detected = True
                    continue
                next_confidence = _compute_step_confidence(
                    entry.chain_confidence,
                    edge.edge_type,
                    edge.confidence,
                )
                if next_confidence < MIN_CONFIDENCE_FLOOR:
                    continue
                frontier.append(_FrontierEntry(
                    node_id=next_node_id,
                    depth=entry.depth + 1,
                    chain_confidence=next_confidence,
                    parent_edge_type=edge.edge_type,
                    parent_edge_id=str(edge.edge_id),
                    parent_edge_confidence=edge.confidence,
                ))

        # Compute result metadata
        missing = [
            step.node_id for step in prerequisite_chain if not step.is_satisfied
        ]
        is_complete = len(prerequisite_chain) > 0 and len(missing) == 0
        truncated = frontier_alive_at_depth_limit

        # Overall confidence: minimum of all step confidences if chain is
        # non-empty, else 0.0. The minimum reflects the weakest link in the
        # prerequisite chain.
        if prerequisite_chain:
            overall_confidence = min(s.confidence for s in prerequisite_chain)
        else:
            overall_confidence = 0.0

        # Determine termination reason
        if not prerequisite_chain:
            termination_reason = TerminationReason.NO_EVIDENCE
        elif truncated:
            termination_reason = TerminationReason.DEPTH_LIMIT_REACHED
        elif cycle_detected and not prerequisite_chain:
            termination_reason = TerminationReason.CYCLE_DETECTED
        else:
            termination_reason = TerminationReason.ANSWER_FOUND

        elapsed_ms = (time.monotonic() - start_time) * 1000

        # Record A.19 trace
        trace_node_id = ""
        if self._trace_writer is not None:
            try:
                trace_result = await self._trace_writer.record_trace(
                    query_id=request.correlation_id,
                    query_type="goal_decomposition",
                    subject_node_id=request.goal_node_id,
                    reasoning_steps=reasoning_steps,
                    termination_reason=termination_reason,
                    confidence=overall_confidence,
                    depth_reached=deepest_depth,
                    execution_time_ms=elapsed_ms,
                    session_id=request.session_id,
                    path_found_but_truncated=truncated,
                    truncation_depth=max_depth if truncated else None,
                    continuation_available_at_depth=(
                        max_depth + 1 if truncated else None
                    ),
                )
                trace_node_id = trace_result.trace_node_id
            except KnowledgeGraphError:
                _log.warning(
                    "backward_chaining: failed to record trace for "
                    "goal %s (correlation_id=%s)",
                    request.goal_node_id,
                    request.correlation_id,
                    exc_info=True,
                )

        # Update gate state if this was a successful decomposition
        if is_complete:
            await self._record_success()

        _log.info(
            "backward_chaining: goal=%s depth=%d steps=%d "
            "complete=%s missing=%d truncated=%s confidence=%.3f "
            "elapsed=%.1fms",
            request.goal_node_id,
            deepest_depth,
            len(prerequisite_chain),
            is_complete,
            len(missing),
            truncated,
            overall_confidence,
            elapsed_ms,
        )

        return GoalDecomposition(
            goal_id=request.goal_node_id,
            goal_description=goal_description or request.goal_node_id,
            prerequisite_chain=prerequisite_chain,
            max_depth_reached=deepest_depth,
            confidence=overall_confidence,
            is_complete=is_complete,
            missing_prerequisites=missing,
            truncated=truncated,
            termination_reason=str(termination_reason),
            execution_time_ms=elapsed_ms,
            trace_node_id=trace_node_id,
            gate_max_depth=max_depth,
            cycle_detected=cycle_detected,
        )

    async def _find_prerequisite_edges(
        self,
        target_node_id: str,
    ) -> list:
        """Find all backward-chaining edges pointing TO the given node.

        Queries for edges of types in BACKWARD_EDGE_TYPES where the
        target_id matches the given node. These represent prerequisites:
        if edge "A REQUIRES B" exists and target_node_id is "B", this
        would NOT match. But if target_node_id is "A", we find "A REQUIRES B"
        and discover B as a prerequisite.

        Wait -- backward chaining from goal A means we want edges where
        A is the SOURCE (A REQUIRES B means B is a prerequisite of A),
        so we look for edges where source_id = target_node_id.

        Actually, let's be precise about the semantics:
        - "building_a_house REQUIRES having_a_foundation" means
          having_a_foundation is a prerequisite for building_a_house.
        - If our goal is building_a_house, we look for edges where
          source_id = "building_a_house" and edge_type = REQUIRES.
        - The target_id of such edges gives us the prerequisites.

        Similarly for ENABLES: "having_fuel ENABLES engine_running" means
        if goal is engine_running, we need edges where target_id = goal
        (engine_running), and the source gives us the prerequisite.

        The direction depends on the edge type semantics:
        - REQUIRES: goal REQUIRES prereq -> source=goal, look at target
        - ENABLES:  prereq ENABLES goal  -> target=goal, look at source
        - CAUSES:   prereq CAUSES goal   -> target=goal, look at source
        - ACHIEVES: prereq ACHIEVES goal -> target=goal, look at source

        For simplicity and consistency, we search BOTH directions:
        edges where the goal is source (REQUIRES pattern) and edges where
        the goal is target (ENABLES/CAUSES/ACHIEVES pattern). The
        prerequisite is always the "other" node.

        Args:
            target_node_id: The node_id to find prerequisites for.

        Returns:
            List of KnowledgeEdge objects representing prerequisite
            relationships. Each edge's "other" node is a prerequisite.
        """
        from cobeing.layer3_knowledge.node_types import KnowledgeEdge

        prerequisite_edges: list[KnowledgeEdge] = []

        for edge_type in BACKWARD_EDGE_TYPES:
            if edge_type == REQUIRES:
                # goal REQUIRES prereq -> source=goal, prereq is target
                edges = await self._persistence.query_edges(
                    EdgeFilter(
                        source_node_id=target_node_id,
                        edge_type=edge_type,
                    )
                )
                # Remap: we want the "prerequisite" to appear as source_id
                # in the returned edges so the caller can treat source_id
                # uniformly as the prerequisite node. We create a synthetic
                # edge with source/target swapped for caller convenience.
                for edge in edges:
                    prerequisite_edges.append(KnowledgeEdge(
                        edge_id=edge.edge_id,
                        source_id=edge.target_id,  # prereq
                        target_id=edge.source_id,  # goal
                        edge_type=edge.edge_type,
                        properties=edge.properties,
                        provenance=edge.provenance,
                        confidence=edge.confidence,
                        valid_from=edge.valid_from,
                        valid_to=edge.valid_to,
                    ))
            else:
                # prereq ENABLES/CAUSES/ACHIEVES goal -> target=goal
                # source_id is already the prerequisite
                edges = await self._persistence.query_edges(
                    EdgeFilter(
                        target_node_id=target_node_id,
                        edge_type=edge_type,
                    )
                )
                prerequisite_edges.extend(edges)

        return prerequisite_edges

    async def _record_success(self) -> None:
        """Record a successful decomposition and check for depth advancement.

        Increments the successful_completions counter on the gate state.
        If the threshold for the current stage is met, advances to the
        next depth stage and persists the updated gate to the graph.
        """
        self._gate.successful_completions += 1
        advanced = False

        if (
            self._gate.current_max_depth == STAGE_1_MAX_DEPTH
            and self._gate.successful_completions >= STAGE_1_SUCCESS_THRESHOLD
        ):
            self._gate.current_max_depth = STAGE_2_MAX_DEPTH
            self._gate.successful_completions = 0
            advanced = True
            _log.info(
                "backward_chaining: depth gate advanced to stage 2 "
                "(max_depth=%d)",
                STAGE_2_MAX_DEPTH,
            )
        elif (
            self._gate.current_max_depth == STAGE_2_MAX_DEPTH
            and self._gate.successful_completions >= STAGE_2_SUCCESS_THRESHOLD
        ):
            self._gate.current_max_depth = STAGE_3_MAX_DEPTH
            self._gate.successful_completions = 0
            advanced = True
            _log.info(
                "backward_chaining: depth gate advanced to stage 3 "
                "(max_depth=%d)",
                STAGE_3_MAX_DEPTH,
            )

        # Persist gate state to graph
        await self._persist_gate_state()

        if advanced:
            _log.info(
                "backward_chaining: gate state persisted "
                "(max_depth=%d, completions=%d)",
                self._gate.current_max_depth,
                self._gate.successful_completions,
            )

    async def _persist_gate_state(self) -> None:
        """Write the current gate state to the graph as an EvolutionRule node.

        The gate node is upserted (created or updated) each time the
        state changes. This ensures gate progression survives restarts.
        """
        gate_node = KnowledgeNode(
            node_id=GOAL_DECOMPOSITION_GATE_ID,
            node_type="EvolutionRule",
            schema_level=SchemaLevel.META_SCHEMA,
            properties={
                "rule_name": "goal_decomposition_gate",
                "current_max_depth": self._gate.current_max_depth,
                "successful_completions": self._gate.successful_completions,
                "stage_1_threshold": STAGE_1_SUCCESS_THRESHOLD,
                "stage_2_threshold": STAGE_2_SUCCESS_THRESHOLD,
                "stage_1_depth": STAGE_1_MAX_DEPTH,
                "stage_2_depth": STAGE_2_MAX_DEPTH,
                "stage_3_depth": STAGE_3_MAX_DEPTH,
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id="backward-chaining-gate",
                confidence=1.0,
            ),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        try:
            await self._persistence.save_node(gate_node)
        except Exception as exc:
            _log.warning(
                "backward_chaining: failed to persist gate state: %s",
                exc,
            )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    # Constants
    "GOAL_DECOMPOSITION_GATE_ID",
    "BACKWARD_EDGE_TYPES",
    "STAGE_1_MAX_DEPTH",
    "STAGE_2_MAX_DEPTH",
    "STAGE_3_MAX_DEPTH",
    "ARCHITECTURAL_MAX_DEPTH",
    # Data structures
    "GoalDecompositionRequest",
    "PrerequisiteStep",
    "GoalDecomposition",
    # Executor
    "BackwardChainingExecutor",
]

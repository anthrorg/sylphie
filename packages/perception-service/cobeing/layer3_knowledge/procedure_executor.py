"""ProcedureExecutor: deterministic graph-based computation engine (PKG-2.1/2.2).

The executor implements the three-step lookup that is the heart of the
Procedural Knowledge Graph (CANON A.18, Phase 1.6):

  Step 1 -- Instance check:
    Query for a COMPUTES_TO edge matching (operation, operand_ids) with
    confidence >= retrieval_threshold. If found, update encounter_count and
    return immediately with strategy="direct_recall".

  Step 2 -- Procedure execution:
    Retrieve the ProceduralTemplate and its AST. Execute by depth-first
    traversal. No LLM calls -- pure graph traversal + OPERATIONS dispatch.

  Step 3 -- Result storage:
    Find or create the result ValueNode. Create or update the COMPUTES_TO
    edge with initial confidence=0.15 (or updated count if edge existed below
    threshold). Return with strategy="procedural".

    When a contradiction detector is wired, Step 3 checks whether the new
    result conflicts with an existing COMPUTES_TO edge (PKG-3.4). If so,
    the detector records the conflict and the ExecutionResult carries the
    contradiction event for guardian escalation.

Architectural note (AlphaGeometry principle):
    Layer 4 (LLM) decides WHAT to compute.
    Layer 3 (this module) executes the computation.
    The boundary is never crossed. This module never calls the LLM.

Usage::

    executor = ProcedureExecutor(graph=persistence)
    request = ExecutionRequest(
        procedure_id=NodeId("proc:add"),
        operands=[NodeId("value:integer:5"), NodeId("value:integer:3")],
        correlation_id="session-0042",
    )
    result = await executor.execute(request)
    # result.result_value == 8
    # result.strategy == "procedural"  (first time)
    # result.instance_edge_created == True

    # Or create with threshold read from the graph:
    executor = await ProcedureExecutor.from_graph(persistence)

    # With contradiction detection (PKG-3.4):
    from cobeing.layer3_knowledge.contradiction_detector import ContradictionDetector
    detector = ContradictionDetector(graph=persistence, event_bus=bus)
    executor = await ProcedureExecutor.from_graph(
        persistence, contradiction_detector=detector,
    )
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from cobeing.layer3_knowledge.instance_confidence import (
    BASE_GUARDIAN_CONFIRMED,
    BASE_PROCEDURAL,
    PROCEDURAL_CAP,
    RETRIEVAL_THRESHOLD,
    calculate_confidence,
    hours_since,
    should_use_direct_recall,
)
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.procedure_types import (
    COMPUTES_TO,
    CircularProcedureError,
    HAS_OPERAND,
    HAS_PROCEDURE_BODY,
    OPERATIONS,
    PROCEDURAL_TEMPLATE,
    RecursionDepthExceededError,
    VALUE_NODE,
    DivisionByZeroError,
    ExecutionRequest,
    ExecutionResult,
    ExecutionTimeoutError,
    OperandTypeMismatchError,
    ProcedureNotFoundError,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

_EXECUTION_TIMEOUT_SECONDS = 5.0


@dataclass
class _ExecutionContext:
    """Per-invocation state threaded through AST traversal. Internal only.

    Created once per top-level ``execute()`` call and passed through every
    recursive ``_execute_ast()`` invocation. Carries the absolute deadline,
    remaining call depth for nested procedure calls, a DAG memoization cache,
    and a call stack for cycle detection.

    Attributes:
        correlation_id: Propagated from ExecutionRequest for log correlation.
        deadline: Absolute ``time.monotonic()`` timestamp at which execution
            must stop. Checked at the top of every ``_execute_ast()`` call.
        remaining_depth: Decremented on each ``call`` step type. When it
            reaches zero, ``RecursionDepthExceededError`` is raised.
        memo: Maps step NodeIds to their already-evaluated values. Prevents
            redundant graph lookups and computation when the AST is a DAG
            (multiple edges pointing to the same step node).
        call_stack: Ordered list of procedure NodeIds currently being
            executed, from outermost to innermost. Used to detect circular
            procedure calls (A calls B calls A).
    """

    correlation_id: str
    deadline: float
    remaining_depth: int
    memo: dict[NodeId, Any] = field(default_factory=dict)
    call_stack: list[NodeId] = field(default_factory=list)


class _DeadlineExceededError(Exception):
    """Internal: raised when execution deadline is exceeded.

    Caught by ``execute()`` and converted to the public
    ``ExecutionTimeoutError``. Never leaks outside the module.
    """


_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _value_to_node_id(value: Any) -> NodeId | None:
    """Convert a Python value to a canonical ValueNode node_id.

    Supports integer and boolean results. Returns None for list/float/other
    types that cannot be stored as stable ValueNodes in Phase 1.6 scope.
    """
    if isinstance(value, bool):
        return NodeId(f"value:boolean:{value}")
    if isinstance(value, int):
        return NodeId(f"value:integer:{value}")
    if isinstance(value, float) and value == int(value):
        return NodeId(f"value:integer:{int(value)}")
    return None


def _build_computed_value_node(value: Any, node_id: NodeId) -> KnowledgeNode:
    """Create a new ValueNode for a freshly-computed value (INFERENCE provenance)."""
    if isinstance(value, bool):
        value_type = "boolean"
    elif isinstance(value, (int, float)):
        value_type = "integer"
    else:
        value_type = "unknown"

    return KnowledgeNode(
        node_id=node_id,
        node_type=VALUE_NODE,
        schema_level=SchemaLevel.INSTANCE,
        properties={
            "value_type": value_type,
            "value": value if not isinstance(value, float) else int(value),
            "value_repr": str(value),
        },
        provenance=Provenance(
            source=ProvenanceSource.INFERENCE,
            source_id="procedure-executor",
            confidence=1.0,
        ),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


# ---------------------------------------------------------------------------
# ProcedureExecutor
# ---------------------------------------------------------------------------


class ProcedureExecutor:
    """Deterministic graph-based procedure execution engine.

    Executes ProceduralTemplate procedures by traversing their AST subgraph
    and dispatching to the OPERATIONS registry. Manages the COMPUTES_TO
    instance edge lifecycle: creation, encounter-count updates, and the
    confidence dynamics required for direct recall.

    This class never calls the LLM. It is Layer 3 infrastructure.

    Attributes:
        graph: The graph persistence backend.
        retrieval_threshold: Minimum COMPUTES_TO confidence for direct recall.
        procedural_cap: Maximum confidence achievable without guardian
            confirmation. Should be strictly less than retrieval_threshold
            (Piaget: cap=threshold creates floating-point boundary artifacts).
        guardian_confirmation_boost: Base confidence after guardian confirms.
            Must exceed retrieval_threshold to enable direct recall.
    """

    def __init__(
        self,
        graph: GraphPersistence,
        retrieval_threshold: float = RETRIEVAL_THRESHOLD,
        procedural_cap: float = PROCEDURAL_CAP,
        guardian_confirmation_boost: float = BASE_GUARDIAN_CONFIRMED,
        contradiction_detector: object | None = None,
    ) -> None:
        self.graph = graph
        self.retrieval_threshold = retrieval_threshold
        self.procedural_cap = procedural_cap
        self.guardian_confirmation_boost = guardian_confirmation_boost
        self._contradiction_detector = contradiction_detector

    # ------------------------------------------------------------------
    # Alternative constructors
    # ------------------------------------------------------------------

    @classmethod
    async def from_graph(
        cls,
        graph: GraphPersistence,
        contradiction_detector: object | None = None,
        **kwargs: Any,
    ) -> ProcedureExecutor:
        """Create a ProcedureExecutor with retrieval_threshold read from the graph.

        Reads the RETRIEVAL_THRESHOLD EvolutionRule node from the graph
        (bootstrapped by ``bootstrap_graph()``).  Falls back to the
        module-level constant (0.50) if the rule does not exist or has
        no ``current_value`` property.

        This is the preferred constructor when the graph has been
        bootstrapped and the guardian may have tuned the threshold.

        Args:
            graph: The graph persistence backend.
            contradiction_detector: Optional ContradictionDetector instance
                for detecting conflicting COMPUTES_TO edges (PKG-3.4).
                Typed as ``object`` to avoid circular imports. The actual
                runtime type should be ``ContradictionDetector``.
            **kwargs: Additional keyword arguments forwarded to ``__init__``
                (e.g., ``procedural_cap``, ``guardian_confirmation_boost``).

        Returns:
            A fully initialised ProcedureExecutor.
        """
        from cobeing.layer3_knowledge.bootstrap import get_evolution_rule_value

        threshold = await get_evolution_rule_value(graph, "RETRIEVAL_THRESHOLD")
        return cls(
            graph=graph,
            retrieval_threshold=threshold or RETRIEVAL_THRESHOLD,
            contradiction_detector=contradiction_detector,
            **kwargs,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        """Execute a procedure request via three-step lookup.

        Args:
            request: Specifies the procedure, operands, and correlation ID.

        Returns:
            ExecutionResult with the computed value, strategy used, and
            instance edge creation/update flags.

        Raises:
            ProcedureNotFoundError: If the procedure or its AST nodes are absent.
            OperandTypeMismatchError: If operand count doesn't match or a bound
                variable's ValueNode is missing.
            DivisionByZeroError: If a division operation receives a zero divisor.
            ExecutionTimeoutError: If AST traversal exceeds the deadline.
        """
        start = time.monotonic()

        # ---- Step 0: Load procedure template ----
        procedure_node = await self.graph.get_node(request.procedure_id)
        if procedure_node is None:
            raise ProcedureNotFoundError(
                f"ProceduralTemplate '{request.procedure_id}' not found in graph."
            )
        if procedure_node.node_type != PROCEDURAL_TEMPLATE:
            raise ProcedureNotFoundError(
                f"Node '{request.procedure_id}' exists but is a "
                f"'{procedure_node.node_type}', not a ProceduralTemplate."
            )

        parameters: list[str] = procedure_node.properties.get("parameters", [])
        if len(parameters) != len(request.operands):
            raise OperandTypeMismatchError(
                f"Procedure '{request.procedure_id}' declares {len(parameters)} "
                f"parameter(s) {parameters} but received {len(request.operands)} "
                f"operand(s) {list(request.operands)}."
            )

        operation = (
            procedure_node.properties.get("name")
            or procedure_node.properties.get("procedure_name", "")
        )
        operand_ids = [str(op) for op in request.operands]

        # ---- Step 1: Instance check (skip if force_procedural) ----
        if not request.force_procedural:
            recall = await self._try_direct_recall(
                operation=operation,
                operand_ids=operand_ids,
                start=start,
            )
            if recall is not None:
                return recall

        # ---- Step 2: Execute AST ----
        body_edges = await self.graph.query_edges(
            EdgeFilter(
                edge_type=HAS_PROCEDURE_BODY,
                source_node_id=request.procedure_id,
            )
        )
        if not body_edges:
            raise ProcedureNotFoundError(
                f"Procedure '{request.procedure_id}' has no body "
                f"(HAS_PROCEDURE_BODY edge missing)."
            )

        root_step_id = body_edges[0].target_id
        bindings: dict[str, NodeId] = {
            param: operand
            for param, operand in zip(parameters, request.operands)
        }

        # Determine deadline: inherit from recursive call or create fresh
        deadline = (
            request._deadline
            if request._deadline is not None
            else (time.monotonic() + _EXECUTION_TIMEOUT_SECONDS)
        )
        call_stack = (
            list(request._call_stack)
            if request._call_stack
            else [request.procedure_id]
        )

        ctx = _ExecutionContext(
            correlation_id=request.correlation_id,
            deadline=deadline,
            remaining_depth=request.max_call_depth,
            memo={},
            call_stack=call_stack,
        )

        try:
            result_value = await self._execute_ast(root_step_id, bindings, ctx)
        except _DeadlineExceededError as exc:
            raise ExecutionTimeoutError(
                f"Procedure '{request.procedure_id}' execution exceeded "
                f"{_EXECUTION_TIMEOUT_SECONDS}s deadline."
            ) from exc

        elapsed_ms = (time.monotonic() - start) * 1000

        # ---- Step 3: Store result ----
        return await self._store_result(
            result_value=result_value,
            operation=operation,
            operand_ids=operand_ids,
            request=request,
            elapsed_ms=elapsed_ms,
        )

    # ------------------------------------------------------------------
    # AST traversal (PKG-2.1)
    # ------------------------------------------------------------------

    async def _execute_ast(
        self,
        step_id: NodeId,
        bindings: dict[str, NodeId],
        ctx: _ExecutionContext,
    ) -> Any:
        """Depth-first AST traversal from a ProcedureStep node.

        Handles step_types: ``literal``, ``variable``, ``operation``,
        ``conditional``, ``call``. Syntactic step_types (``match_root``,
        ``match_edge``, ``match_optional``, ``extract_role``,
        ``match_property``) are recognised but raise
        ``NotImplementedError`` -- they require the SyntacticTemplateMatcher
        (P1.7-E4).

        The ``call`` step type enables inter-procedure invocation. It reads
        the ``target_procedure`` property from the step node, evaluates its
        HAS_OPERAND children to produce ValueNode IDs, then delegates to
        ``self.execute()`` with a sub-request that inherits the deadline and
        call stack. Self-recursion (a procedure calling itself) is permitted;
        cross-procedure cycles (A calls B calls A) are rejected via
        ``CircularProcedureError``. Recursion depth is bounded by
        ``ctx.remaining_depth``.

        Args:
            step_id: NodeId of the ProcedureStep to evaluate.
            bindings: Maps variable names (e.g. "$X") to ValueNode IDs.
            ctx: Per-invocation execution context carrying deadline, memo,
                remaining call depth, and call stack.

        Returns:
            The evaluated Python value.

        Raises:
            _DeadlineExceededError: If the deadline has passed.
            ProcedureNotFoundError: If a step node is missing.
            OperandTypeMismatchError: If a variable is unbound or a ValueNode
                is missing, or an unknown step_type is encountered, or a
                call step's operand cannot be stored as a ValueNode.
            DivisionByZeroError: If division by zero occurs.
            RecursionDepthExceededError: If a ``call`` step exceeds the
                maximum allowed call depth (``ctx.remaining_depth <= 0``).
            CircularProcedureError: If a ``call`` step would create a
                cross-procedure cycle (A calls B calls A). Self-recursion
                is allowed; depth limiting handles infinite self-recursion.
            NotImplementedError: If a syntactic step_type is encountered
                (requires SyntacticTemplateMatcher from P1.7-E4).
        """
        # Deadline check: abort immediately if time is up
        if time.monotonic() > ctx.deadline:
            raise _DeadlineExceededError(f"Deadline exceeded at step '{step_id}'.")

        # Memo check: return cached value if this step was already evaluated
        if step_id in ctx.memo:
            return ctx.memo[step_id]

        step_node = await self.graph.get_node(step_id)
        if step_node is None:
            raise ProcedureNotFoundError(
                f"ProcedureStep '{step_id}' not found in graph."
            )

        step_type = step_node.properties.get("step_type")

        if step_type == "literal":
            result = step_node.properties.get("literal_value")
            ctx.memo[step_id] = result
            return result

        if step_type == "variable":
            variable_name = step_node.properties.get("variable")
            operand_id = bindings.get(variable_name)
            if operand_id is None:
                raise OperandTypeMismatchError(
                    f"Variable '{variable_name}' is not bound. "
                    f"Available bindings: {list(bindings.keys())}"
                )
            operand_node = await self.graph.get_node(operand_id)
            if operand_node is None:
                raise OperandTypeMismatchError(
                    f"ValueNode '{operand_id}' (bound to '{variable_name}') "
                    f"not found in graph."
                )
            result = operand_node.properties.get("value")
            ctx.memo[step_id] = result
            return result

        if step_type == "operation":
            operation_name = step_node.properties.get("operation", "")
            if operation_name not in OPERATIONS:
                raise OperandTypeMismatchError(
                    f"Unknown operation '{operation_name}'. "
                    f"Registered operations: {list(OPERATIONS.keys())}"
                )

            # Get child operand steps, sorted by position
            operand_edges = await self.graph.query_edges(
                EdgeFilter(
                    edge_type=HAS_OPERAND,
                    source_node_id=step_id,
                )
            )
            operand_edges.sort(key=lambda e: e.properties.get("position", 0))

            # Recursively evaluate each operand
            operand_values = []
            for edge in operand_edges:
                value = await self._execute_ast(edge.target_id, bindings, ctx)
                operand_values.append(value)

            result = OPERATIONS[operation_name](*operand_values)

            if result is None:
                # _safe_divide returns None on zero divisor
                raise DivisionByZeroError(
                    f"Operation '{operation_name}' produced a zero-division error. "
                    f"Operands: {operand_values}"
                )

            ctx.memo[step_id] = result
            return result

        if step_type == "conditional":
            operand_edges = await self.graph.query_edges(
                EdgeFilter(
                    edge_type=HAS_OPERAND,
                    source_node_id=step_id,
                )
            )
            operand_edges.sort(key=lambda e: e.properties.get("position", 0))
            if len(operand_edges) != 3:
                raise OperandTypeMismatchError(
                    f"conditional step requires exactly 3 operands (condition, then, else), "
                    f"got {len(operand_edges)} on step {step_id}"
                )
            condition_value = await self._execute_ast(operand_edges[0].target_id, bindings, ctx)
            if condition_value:
                result = await self._execute_ast(operand_edges[1].target_id, bindings, ctx)
            else:
                result = await self._execute_ast(operand_edges[2].target_id, bindings, ctx)
            ctx.memo[step_id] = result
            return result

        if step_type == "call":
            # 1. Read target_procedure from step properties
            target_procedure = step_node.properties.get("target_procedure")
            if target_procedure is None:
                raise OperandTypeMismatchError(
                    f"call step '{step_id}' is missing required property "
                    f"'target_procedure'. Cannot determine which procedure to invoke."
                )

            # 2. Evaluate HAS_OPERAND children (same pattern as operation handler)
            operand_edges = await self.graph.query_edges(
                EdgeFilter(
                    edge_type=HAS_OPERAND,
                    source_node_id=step_id,
                )
            )
            operand_edges.sort(key=lambda e: e.properties.get("position", 0))

            operand_values = []
            for edge in operand_edges:
                value = await self._execute_ast(edge.target_id, bindings, ctx)
                operand_values.append(value)

            # 3. Convert evaluated Python values to ValueNode IDs
            operand_node_ids: list[NodeId] = []
            for i, value in enumerate(operand_values):
                node_id = _value_to_node_id(value)
                if node_id is None:
                    raise OperandTypeMismatchError(
                        f"call step '{step_id}' operand {i} evaluated to "
                        f"{value!r} (type {type(value).__name__}), which cannot "
                        f"be stored as a ValueNode. Only int and bool are supported."
                    )
                operand_node_ids.append(node_id)

            # 4. Ensure ValueNodes exist in graph for each operand
            for node_id, value in zip(operand_node_ids, operand_values):
                existing_node = await self.graph.get_node(node_id)
                if existing_node is None:
                    new_node = _build_computed_value_node(value, node_id)
                    await self.graph.save_node(new_node)

            # 5. Check recursion depth
            if ctx.remaining_depth <= 0:
                raise RecursionDepthExceededError(
                    f"call step '{step_id}' targeting '{target_procedure}' "
                    f"exceeded maximum call depth. "
                    f"Call stack: {[str(p) for p in ctx.call_stack]}"
                )

            # 6. Check for cross-procedure cycles (self-recursion is allowed)
            target_node_id = NodeId(target_procedure)
            current_procedure = ctx.call_stack[-1] if ctx.call_stack else None
            if (
                target_node_id in ctx.call_stack
                and target_node_id != current_procedure
            ):
                cycle_path = [str(p) for p in ctx.call_stack] + [target_procedure]
                raise CircularProcedureError(
                    f"call step '{step_id}' would create a circular procedure "
                    f"call: {' -> '.join(cycle_path)}. "
                    f"Cross-procedure cycles are not allowed. "
                    f"(Self-recursion is permitted; this is a cross-procedure cycle.)"
                )

            # 7. Construct sub-ExecutionRequest
            sub_request = ExecutionRequest(
                procedure_id=target_node_id,
                operands=operand_node_ids,
                correlation_id=ctx.correlation_id,
                force_procedural=False,
                max_call_depth=ctx.remaining_depth - 1,
                _deadline=ctx.deadline,
                _call_stack=ctx.call_stack + [target_node_id],
            )

            # 8. Execute the sub-procedure (full three-step lookup)
            sub_result = await self.execute(sub_request)

            # 9. Return and cache the result
            result = sub_result.result_value
            ctx.memo[step_id] = result
            return result

        # Syntactic step_types -- executed by SyntacticTemplateMatcher (P1.7-E4).
        # Direct execution through ProcedureExecutor is not supported.
        if step_type in (
            "match_root",
            "match_edge",
            "match_optional",
            "extract_role",
            "match_property",
        ):
            raise NotImplementedError(
                f"step_type '{step_type}' requires SyntacticTemplateMatcher "
                f"(implemented in P1.7-E4). Cannot execute directly via ProcedureExecutor."
            )

        raise OperandTypeMismatchError(
            f"Unknown step_type '{step_type}' on ProcedureStep '{step_id}'."
        )

    # ------------------------------------------------------------------
    # Instance check helper (Step 1)
    # ------------------------------------------------------------------

    async def _try_direct_recall(
        self,
        operation: str,
        operand_ids: list[str],
        start: float,
    ) -> ExecutionResult | None:
        """Attempt direct recall from an existing COMPUTES_TO edge.

        Returns an ExecutionResult if a suitable edge is found above the
        retrieval threshold; returns None otherwise.
        """
        existing = await self._find_computes_to(operation, operand_ids)
        if existing is None:
            return None

        edge_confidence = existing.properties.get("confidence", 0.0)
        if not should_use_direct_recall(edge_confidence, self.retrieval_threshold):
            return None

        # Found -- update encounter_count and confidence
        new_encounter = existing.properties.get("encounter_count", 1) + 1
        guardian_confirmed = existing.properties.get("guardian_confirmed", False)
        base = BASE_GUARDIAN_CONFIRMED if guardian_confirmed else BASE_PROCEDURAL
        new_confidence = calculate_confidence(
            base=base,
            encounter_count=new_encounter,
            hours_since_last_access=0.0,
            guardian_confirmed=guardian_confirmed,
            procedural_cap=self.procedural_cap,
        )

        existing.properties["encounter_count"] = new_encounter
        existing.properties["confidence"] = new_confidence
        existing.properties["last_accessed"] = _now_iso()
        await self.graph.save_edge(existing)

        result_node = await self.graph.get_node(existing.target_id)
        result_value = result_node.properties.get("value") if result_node else None
        elapsed_ms = (time.monotonic() - start) * 1000

        return ExecutionResult(
            result_node_id=existing.target_id,
            result_value=result_value,
            strategy="direct_recall",
            confidence=new_confidence,
            execution_time_ms=elapsed_ms,
            instance_edge_created=False,
            instance_edge_updated=True,
            procedure_id=None,
        )

    # ------------------------------------------------------------------
    # Result storage helper (Step 3)
    # ------------------------------------------------------------------

    async def _store_result(
        self,
        result_value: Any,
        operation: str,
        operand_ids: list[str],
        request: ExecutionRequest,
        elapsed_ms: float,
    ) -> ExecutionResult:
        """Find/create the result ValueNode and create/update the COMPUTES_TO edge.

        When a contradiction detector is wired and the new result differs
        from an existing COMPUTES_TO edge, the detector records the conflict
        and the returned ExecutionResult carries ``contradiction_detected=True``
        with the full ``ContradictionDetectedEvent`` for guardian escalation.
        In that case the normal edge update is skipped (the detector handles it).
        """
        result_node_id = _value_to_node_id(result_value)

        if result_node_id is None:
            # Non-storable result (list from set operations) -- skip COMPUTES_TO edge
            return ExecutionResult(
                result_node_id=NodeId(f"value:transient:{hash(repr(result_value))}"),
                result_value=result_value,
                strategy="procedural",
                confidence=0.0,
                execution_time_ms=elapsed_ms,
                instance_edge_created=False,
                instance_edge_updated=False,
                procedure_id=request.procedure_id,
            )

        # Find or create result ValueNode
        if await self.graph.get_node(result_node_id) is None:
            result_node = _build_computed_value_node(result_value, result_node_id)
            await self.graph.save_node(result_node)

        # Find existing COMPUTES_TO edge (may be below threshold)
        now_iso = _now_iso()
        existing = await self._find_computes_to(operation, operand_ids)

        # ---- Contradiction check (PKG-3.4) ----
        # If a contradiction detector is wired AND an existing edge points to
        # a DIFFERENT result, delegate to the detector. The detector creates
        # the conflict edge, halves confidence on both, and produces the event.
        # We skip normal edge update in this case.
        if (
            self._contradiction_detector is not None
            and existing is not None
            and existing.target_id != result_node_id
        ):
            contradiction_result = await self._contradiction_detector.check_and_record(  # type: ignore[union-attr]
                operation=operation,
                operand_ids=[NodeId(oid) for oid in operand_ids],
                new_result_node_id=result_node_id,
                new_result_value=result_value,
                existing_edge=existing,
                correlation_id=str(request.correlation_id),
            )

            if contradiction_result.contradiction_found:
                # Extract the event: from the event bus (already emitted) or
                # from pending_events (when no event bus is wired).
                contradiction_event = None
                if hasattr(self._contradiction_detector, "pending_events"):
                    pending = self._contradiction_detector.pending_events  # type: ignore[union-attr]
                    if pending:
                        contradiction_event = pending[-1]

                _logger.warning(
                    "Contradiction detected in _store_result: "
                    "operation=%s operands=%s existing_target=%s new_target=%s "
                    "correlation_id=%s",
                    operation,
                    operand_ids,
                    existing.target_id,
                    result_node_id,
                    request.correlation_id,
                )

                return ExecutionResult(
                    result_node_id=result_node_id,
                    result_value=result_value,
                    strategy="procedural",
                    confidence=BASE_PROCEDURAL,
                    execution_time_ms=elapsed_ms,
                    instance_edge_created=False,
                    instance_edge_updated=False,
                    procedure_id=request.procedure_id,
                    contradiction_detected=True,
                    contradiction_event=contradiction_event,
                )

        # ---- Normal edge create/update (no contradiction) ----
        edge_created = False
        edge_updated = False
        final_confidence = BASE_PROCEDURAL

        if existing is not None:
            # Update existing edge (sub-threshold, hence we're here after procedure run)
            new_encounter = existing.properties.get("encounter_count", 1) + 1
            guardian_confirmed = existing.properties.get("guardian_confirmed", False)
            base = BASE_GUARDIAN_CONFIRMED if guardian_confirmed else BASE_PROCEDURAL
            new_confidence = calculate_confidence(
                base=base,
                encounter_count=new_encounter,
                hours_since_last_access=0.0,
                guardian_confirmed=guardian_confirmed,
                procedural_cap=self.procedural_cap,
            )
            existing.properties["encounter_count"] = new_encounter
            existing.properties["confidence"] = new_confidence
            existing.properties["last_accessed"] = now_iso
            await self.graph.save_edge(existing)
            edge_updated = True
            final_confidence = new_confidence
        else:
            # Create new COMPUTES_TO edge
            safe_op = operation.replace(":", "_")
            edge_id = EdgeId(
                f"edge:computes_to:{operand_ids[0]}:{safe_op}:{result_node_id}"
            )
            new_edge = KnowledgeEdge(
                edge_id=edge_id,
                source_id=request.operands[0],
                target_id=result_node_id,
                edge_type=COMPUTES_TO,
                properties={
                    "operation": operation,
                    "operand_ids": operand_ids,
                    "confidence": BASE_PROCEDURAL,
                    "encounter_count": 1,
                    "first_computed": now_iso,
                    "last_accessed": now_iso,
                    "guardian_confirmed": False,
                    "guardian_confirmed_at": None,
                    "source_procedure_id": str(request.procedure_id),
                    "error_count": 0,
                    "deprecated": False,
                },
                provenance=Provenance(
                    source=ProvenanceSource.INFERENCE,
                    source_id=request.correlation_id,
                    confidence=BASE_PROCEDURAL,
                ),
                confidence=BASE_PROCEDURAL,
            )
            await self.graph.save_edge(new_edge)
            edge_created = True
            final_confidence = BASE_PROCEDURAL

        return ExecutionResult(
            result_node_id=result_node_id,
            result_value=result_value,
            strategy="procedural",
            confidence=final_confidence,
            execution_time_ms=elapsed_ms,
            instance_edge_created=edge_created,
            instance_edge_updated=edge_updated,
            procedure_id=request.procedure_id,
        )

    # ------------------------------------------------------------------
    # COMPUTES_TO edge lookup
    # ------------------------------------------------------------------

    async def _find_computes_to(
        self,
        operation: str,
        operand_ids: list[str],
    ) -> KnowledgeEdge | None:
        """Find a non-deprecated COMPUTES_TO edge for (operation, operand_ids).

        Queries all COMPUTES_TO edges from the first operand node, then
        filters by operation name, full operand list, and deprecated=False.

        Returns:
            The matching KnowledgeEdge, or None if not found.
        """
        if not operand_ids:
            return None

        edges = await self.graph.query_edges(
            EdgeFilter(
                edge_type=COMPUTES_TO,
                source_node_id=NodeId(operand_ids[0]),
            )
        )
        for edge in edges:
            if (
                edge.properties.get("operation") == operation
                and edge.properties.get("operand_ids") == operand_ids
                and not edge.properties.get("deprecated", False)
            ):
                return edge
        return None


__all__ = ["ProcedureExecutor"]

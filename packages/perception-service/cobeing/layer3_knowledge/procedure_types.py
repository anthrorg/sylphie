"""Data types for the Co-Being Procedural Knowledge Graph.

Defines the data structures used by the procedure execution engine
(ProcedureExecutor) and the ontology bootstrap. Covers:

- ExecutionRequest / ExecutionResult -- the executor's input/output contract
- OPERATIONS -- registry of deterministic primitive operations
- Node and edge type string constants

These are pure data types. No I/O, no graph access, no LLM calls.

Phase 1.6 (PKG-1.2). CANON A.18 (TAUGHT_PROCEDURE provenance).
String operations for morphological procedures added in Phase 1.7.
Boolean operations for conditional branching added in Phase 1.7.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from cobeing.layer3_knowledge.exceptions import BootstrapError  # re-export
from cobeing.shared.types import NodeId

# ---------------------------------------------------------------------------
# Node type string constants
# ---------------------------------------------------------------------------

PROCEDURAL_TEMPLATE = "ProceduralTemplate"
"""SCHEMA-level node: a named, reusable procedure with an AST body and
worked example. The teacher's demonstration."""

PROCEDURE_STEP = "ProcedureStep"
"""SCHEMA-level node: a single AST node within a procedure body.
step_type is one of: 'operation', 'literal', 'variable', 'conditional',
'loop_count', 'call'."""

WORKED_EXAMPLE = "WorkedExample"
"""SCHEMA-level node: a concrete demonstration of a procedure applied to
specific inputs, with a step trace. Pedagogical component."""

CONCEPT_PRIMITIVE = "ConceptPrimitive"
"""SCHEMA-level node: a foundational concept that procedures reference
but that is not itself a procedure. Examples: 'unit', 'integer', 'set'."""

VALUE_NODE = "ValueNode"
"""INSTANCE-level node: a specific value (integer, boolean, set).
Identity rule: exactly one ValueNode per (value_type, value) pair.
node_id pattern: 'value:{type}:{value}' e.g. 'value:integer:5'."""

# ---------------------------------------------------------------------------
# Edge type string constants
# ---------------------------------------------------------------------------

HAS_PROCEDURE_BODY = "HAS_PROCEDURE_BODY"
"""Structural edge: ProceduralTemplate -> root ProcedureStep (AST root)."""

HAS_WORKED_EXAMPLE = "HAS_WORKED_EXAMPLE"
"""Structural edge: ProceduralTemplate -> WorkedExample."""

DEPENDS_ON = "DEPENDS_ON"
"""Structural edge: ProceduralTemplate -> ConceptPrimitive or ProceduralTemplate.
Declares bootstrap dependency ordering."""

HAS_OPERAND = "HAS_OPERAND"
"""Structural edge: ProcedureStep -> ProcedureStep (AST child).
Carries 'position' property (int) for argument ordering."""

INSTANCE_OF_CONCEPT = "INSTANCE_OF_CONCEPT"
"""Structural edge: ValueNode -> ConceptPrimitive.
Types a value: value:integer:5 INSTANCE_OF_CONCEPT concept:integer.
Named INSTANCE_OF_CONCEPT to avoid collision with the existing INSTANCE_OF
edge used by ObjectInstance -> SchemaType."""

COMPUTES_TO = "COMPUTES_TO"
"""Instance edge: ValueNode -> ValueNode.
Direct-recall edge from the first operand to the computation result.
Carries: operation, operand_ids, confidence, encounter_count,
guardian_confirmed, source_procedure_id, deprecated, error_count."""

DOES_NOT_COMPUTE_TO = "DOES_NOT_COMPUTE_TO"
"""Negative knowledge edge: ValueNode -> ValueNode (Phase 1.9).
Records a known incorrect computation result. When Python validation
detects that Co-Being computed a wrong answer, this edge records the
error so it is not repeated. Carries: operation, operand_ids,
incorrect_result, correct_result, discovered_at, discovery_source,
reconsideration_age_hours, encounter_count."""

GENERATED_BY = "GENERATED_BY"
"""Provenance edge: ValueNode -> ProceduralTemplate.
Links a computed result back to the procedure that produced it.
Implemented as an edge from the source ValueNode with a
reifies_edge_id property containing the EdgeId of the COMPUTES_TO edge."""

# ---------------------------------------------------------------------------
# Operation registry
# ---------------------------------------------------------------------------

def _safe_divide(a: Any, b: Any) -> Any | None:
    if b == 0:
        return None
    return a / b


OPERATIONS: dict[str, Callable[..., Any]] = {
    "add": lambda a, b: a + b,
    "subtract": lambda a, b: a - b,
    "multiply": lambda a, b: a * b,
    "divide": _safe_divide,
    "modulo": lambda a, b: a % b if b != 0 else None,
    "count": lambda s: len(s),
    "set_union": lambda a, b: a + b,
    "set_removal": lambda a, b: [x for i, x in enumerate(a) if i >= len(b)],
    "compare_gt": lambda a, b: a > b,
    "compare_lt": lambda a, b: a < b,
    "compare_eq": lambda a, b: a == b,
    "successor": lambda n: n + 1,
    "set_representation": lambda n: [1] * int(n),
    # String operations for morphological procedures (Phase 1.7)
    "string_append": lambda base, suffix: str(base) + str(suffix),
    "string_strip_suffix": lambda s, n: str(s)[: -int(n)] if int(n) > 0 else str(s),
    "string_ends_with": lambda s, suffix: str(s).endswith(str(suffix)),
    "string_preceded_by_vowel": lambda s, pos: (
        int(pos) > 0 and str(s)[int(pos) - 1].lower() in "aeiou"
    ),
    "string_length": lambda s: len(str(s)),
    # Boolean operations for conditional branching (Phase 1.7)
    "boolean_or": lambda a, b: bool(a) or bool(b),
    "boolean_and": lambda a, b: bool(a) and bool(b),
    "boolean_not": lambda a: not bool(a),
}
"""Registry of deterministic primitive operations dispatched during AST traversal.

These are clear-box processing infrastructure (CANON A.2) -- deterministic,
inspectable Python callables. Analogous to the YOLO detector in Layer 2.
They are not world knowledge.

Keys are the string operation names stored as ProcedureStep.operation
properties. Values are callables that take positional arguments in the
order they appear in the AST (HAS_OPERAND position ordering).

'divide' returns None on division by zero; the executor raises
DivisionByZeroError when it receives None from this operation.
'modulo' returns None on zero divisor, following the same pattern as 'divide'.
"""

# ---------------------------------------------------------------------------
# Request / result dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ExecutionRequest:
    """Input to ProcedureExecutor.execute().

    Attributes:
        procedure_id: NodeId of the ProceduralTemplate to execute.
        operands: Ordered list of ValueNode IDs. Bound to the procedure's
            declared variables in order ($X -> operands[0], $Y -> operands[1]).
        correlation_id: Propagated through provenance edges for audit trail.
        force_procedural: When True, skip the instance check and always
            execute the procedure. Used for verification and testing.
        classification_confidence: PT-9 classification confidence (0.0-1.0).
            Flows from the LLM classifier to the handler so that Trigger 4
            (low confidence < 0.50) can format an uncertain response.
            Defaults to 1.0 (fully confident) when not provided.
        max_call_depth: Maximum nesting depth for 'call' step types.
            Prevents runaway recursion when procedures invoke other
            procedures. Defaults to 8.
        _deadline: Absolute monotonic timestamp (from time.monotonic()) at
            which execution must stop. Set by the executor on the outermost
            call and propagated to recursive calls. None means no deadline
            has been set yet (the executor will set one on first use).
            Private by convention -- callers should not set this.
        _call_stack: List of procedure NodeIds currently being executed,
            ordered from outermost to innermost. Used to detect circular
            procedure calls. Private by convention -- callers should not
            set this.
    """

    procedure_id: NodeId
    operands: list[NodeId]
    correlation_id: str
    force_procedural: bool = False
    classification_confidence: float = 1.0
    max_call_depth: int = 8
    _deadline: float | None = None
    _call_stack: list[NodeId] = field(default_factory=list)


@dataclass(frozen=True)
class ExecutionResult:
    """Output from ProcedureExecutor.execute().

    Attributes:
        result_node_id: The ValueNode containing the computation result.
        result_value: The computed value (Python native type).
        strategy: How the result was obtained. One of:
            'direct_recall' -- retrieved from a COMPUTES_TO edge above threshold.
            'procedural'    -- computed by traversing the procedure AST.
        confidence: The confidence of the result (instance edge confidence for
            direct_recall; initial 0.15 for new procedural results).
        execution_time_ms: Wall-clock time for the execution (float).
        instance_edge_created: True if a new COMPUTES_TO edge was created.
        instance_edge_updated: True if an existing COMPUTES_TO edge was updated
            (encounter_count incremented, confidence recalculated).
        procedure_id: NodeId of the ProceduralTemplate that was executed.
            None when strategy is 'direct_recall' and no procedure was run.
        contradiction_detected: True if the computation produced a result
            that conflicts with an existing COMPUTES_TO edge pointing to a
            different target. When True, ``contradiction_event`` carries the
            ContradictionDetectedEvent details for guardian escalation.
        contradiction_event: The ContradictionDetectedEvent from the
            contradiction detector, or None if no contradiction was found.
            Typed as ``object`` to avoid a circular import from
            ``cobeing.shared.event_types``. The actual runtime type is
            ``ContradictionDetectedEvent``.
    """

    result_node_id: NodeId
    result_value: Any
    strategy: str
    confidence: float
    execution_time_ms: float
    instance_edge_created: bool
    instance_edge_updated: bool
    procedure_id: NodeId | None
    contradiction_detected: bool = False
    contradiction_event: object | None = None


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class ProcedureError(Exception):
    """Base class for procedural execution errors."""


class ProcedureNotFoundError(ProcedureError):
    """The requested ProceduralTemplate does not exist in the graph."""


class OperandTypeMismatchError(ProcedureError):
    """A ValueNode operand has a type incompatible with the procedure."""


class DivisionByZeroError(ProcedureError):
    """A division operation received a zero divisor."""


class DependencyMissingError(ProcedureError):
    """A procedure references a ConceptPrimitive or ProceduralTemplate
    that does not exist in the graph (incomplete bootstrap)."""


class ExecutionTimeoutError(ProcedureError):
    """AST traversal exceeded the maximum allowed time (5 seconds)."""


class RecursionDepthExceededError(ProcedureError):
    """A 'call' step exceeded the maximum allowed call depth."""


class CircularProcedureError(ProcedureError):
    """A 'call' step would invoke a procedure already on the call stack."""


__all__ = [
    # Node type constants
    "PROCEDURAL_TEMPLATE",
    "PROCEDURE_STEP",
    "WORKED_EXAMPLE",
    "CONCEPT_PRIMITIVE",
    "VALUE_NODE",
    # Edge type constants
    "HAS_PROCEDURE_BODY",
    "HAS_WORKED_EXAMPLE",
    "DEPENDS_ON",
    "HAS_OPERAND",
    "INSTANCE_OF_CONCEPT",
    "COMPUTES_TO",
    "DOES_NOT_COMPUTE_TO",
    "GENERATED_BY",
    # Operations
    "OPERATIONS",
    # Request / result
    "ExecutionRequest",
    "ExecutionResult",
    # Errors
    "ProcedureError",
    "ProcedureNotFoundError",
    "OperandTypeMismatchError",
    "DivisionByZeroError",
    "DependencyMissingError",
    "ExecutionTimeoutError",
    "RecursionDepthExceededError",
    "CircularProcedureError",
    "BootstrapError",
]

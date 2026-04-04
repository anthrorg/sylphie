"""Type constants and data structures for the semantic teaching pipeline.

Defines the node/edge type constants, step configuration dataclasses, and
result types used by the SemanticTeachingHandler and the assert_fact
ProceduralTemplate node.

The assert_fact template differs from math and morphology templates in one
key way: its ProcedureStep children carry ``step_type: semantic_action`` and
are read as *configuration metadata* by SemanticTeachingHandler, not traversed
as a computational AST by ProcedureExecutor. The handler reads the step tree
to discover which six actions to run (their names and parameters), then
executes them through dedicated Python methods.

This separation is explicit per the epic plan: mathematical computation vs
semantic relationship creation are categorically different. ProcedureExecutor
operates on ValueNode operands to produce ValueNode outputs. SemanticTeachingHandler
operates on WordSenseNode pairs to produce semantic edges. Routing them through
the same executor would conflate two unrelated categories.

Six semantic actions (the pipeline steps stored as ProcedureStep nodes):

  1. ``validate_parse``       -- verify syntactic parse bindings are present
  2. ``call_pt10``            -- invoke PT-10 for semantic edge classification
  3. ``check_contradiction``  -- query graph for conflicting semantic edges
  4. ``create_edge``          -- write the semantic edge with full property schema
  5. ``update_scope_count``   -- increment scope_context_count on the edge
  6. ``generate_response``    -- produce the PT-7 confirmation text payload

Phase 1.8 (Comprehension Layer, P1.8-E2/T001).
CANON A.1 (experience-first), A.18 (TAUGHT_PROCEDURE), A.20 (domain structure).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from cobeing.layer3_knowledge.semantic_types import (
    IS_A,
    HAS_PROPERTY,
    LACKS_PROPERTY,
    PART_OF,
    LOCATED_IN,
    USED_FOR,
    CAUSES,
    ENABLES,
    PREVENTS,
    REQUIRES,
    ACHIEVES,
    PRODUCES,
    CONSUMES,
    CONTRADICTS,
    SIMILAR_TO,
    OPPOSITE_OF,
)
from cobeing.shared.types import EdgeId, NodeId

# ---------------------------------------------------------------------------
# ProceduralTemplate constants for the assert_fact template
# ---------------------------------------------------------------------------

ASSERT_FACT_TEMPLATE_ID = "proc:assert_fact"
"""NodeId of the assert_fact ProceduralTemplate in the graph.

Registered under domain='semantic' so that domain-aware lookup (e.g.,
DomainDispatcher) routes to SemanticTeachingHandler rather than
ProcedureExecutor."""

ASSERT_FACT_TEMPLATE_NAME = "assert_fact"
"""Human-readable template name stored in the ProceduralTemplate.name property."""

# ---------------------------------------------------------------------------
# ProcedureStep action name constants (the six pipeline steps)
# ---------------------------------------------------------------------------

ACTION_VALIDATE_PARSE = "validate_parse"
"""Step 1: verify syntactic parse bindings are present and non-empty.

Checks that the MatchResult from SyntacticTemplateMatcher carries at least
one of: subject+predicate_noun (copular) or agent+patient (transitive).
Raises SemanticParseValidationError if required bindings are absent."""

ACTION_CALL_PT10 = "call_pt10"
"""Step 2: call PT-10 LLM prompt for semantic edge type classification.

Routes to Haiku tier for copular statements (IS_A / HAS_PROPERTY boundary).
Routes to Sonnet tier for causal and conditional statements.
Returns a PT10Result with edge_type, confidence, property_type,
clarification_needed, and implicit_inferences_suppressed."""

ACTION_CHECK_CONTRADICTION = "check_contradiction"
"""Step 3: query the graph for semantic edges that conflict with the proposed fact.

Uses LogicalAxiom nodes (installed by E1) to detect IS_A cycle violations
and HAS_PROPERTY / LACKS_PROPERTY direct conflicts. If a contradiction is
found, creates an ArbitrationRequest node and aborts without writing the edge."""

ACTION_CREATE_EDGE = "create_edge"
"""Step 4: write the semantic edge to the graph with full property schema.

Creates the directed semantic edge between the subject and object
WordSenseNodes. Edge properties include scope_context_count=1, session_id,
turn_id, asserted_text, pt10_edge_type, pt10_confidence, property_type,
valid_from, valid_to=None, guardian_confirmed=False."""

ACTION_UPDATE_SCOPE_COUNT = "update_scope_count"
"""Step 5: increment scope_context_count on the semantic edge.

Only increments if the current ConversationContext differs from the context
in which the edge was first created (different session, or topic shift > 30 min).
Same-session repetition does NOT increment the count -- this implements the
Piagetian situated-to-categorical progression: scope_context_count measures
genuine contextual diversity, not utterance frequency."""

ACTION_GENERATE_RESPONSE = "generate_response"
"""Step 6: produce the PT-7 confirmation payload.

Returns a SemanticTeachingResponse that conversation.py passes to PT-7
for natural-language response generation. The payload carries the committed
edge properties so PT-7 can cite specific graph facts in its confirmation.
If implicit_inferences_suppressed is non-empty, the payload includes those
too so the guardian is informed of what the system chose NOT to infer."""

# ---------------------------------------------------------------------------
# Canonical set of valid semantic edge types (for validation)
# ---------------------------------------------------------------------------

VALID_SEMANTIC_EDGE_TYPES: frozenset[str] = frozenset({
    IS_A,
    HAS_PROPERTY,
    LACKS_PROPERTY,
    PART_OF,
    LOCATED_IN,
    USED_FOR,
    CAUSES,
    ENABLES,
    PREVENTS,
    REQUIRES,
    ACHIEVES,
    PRODUCES,
    CONSUMES,
    CONTRADICTS,
    SIMILAR_TO,
    OPPOSITE_OF,
})
"""The 16 semantic edge types that PT-10 may return.

DENOTES is excluded: it is a cross-domain bridge written by the language layer
when a WordSenseNode is linked to a semantic concept, never by assert_fact."""

# HAS_PROPERTY requires a property_type sub-classification
PROPERTY_TYPE_VALUES: frozenset[str] = frozenset({"sensory", "functional", "categorical"})
"""Valid values for the property_type field on HAS_PROPERTY edges.

sensory     -- perceivable via senses (red, loud, smooth)
functional  -- role or use (used for cutting, rolls, floats)
categorical -- categorical membership or abstract attribute (is a mammal, has legs)"""

# ---------------------------------------------------------------------------
# PT-10 result type (Protocol -- Layer 4 implements, Layer 3 consumes)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PT10Result:
    """Result returned by a PT-10 prompt executor call.

    Layer 3 defines this dataclass as the shape it expects from Layer 4.
    Layer 4's PT10PromptExecutor Protocol returns instances of this type.
    Clean Layer 3/4 boundary: Layer 3 never imports Layer 4 modules.

    Attributes:
        edge_type: One of the VALID_SEMANTIC_EDGE_TYPES string constants.
        confidence: Classification confidence from the LLM, 0.0-1.0.
        property_type: Sub-classification for HAS_PROPERTY edges -- one of
            'sensory', 'functional', 'categorical'. Empty string for all
            other edge types.
        clarification_needed: When True, PT-10 confidence was below 0.7 and
            the handler should request clarification from the guardian instead
            of creating the edge.
        clarification_question: The guardian-facing question to ask when
            clarification_needed is True. Empty string otherwise.
        implicit_inferences_suppressed: List of (edge_type, target_lemma)
            tuples that the LLM identified as reasonable inferences but chose
            not to assert per CANON A.1 (experience-first boundary). Surfaced
            to the guardian in the confirmation response so they can teach
            additional facts if desired.
        model_tier: Which tier was used -- 'haiku' or 'sonnet'.
        raw_response: Raw LLM JSON response text for audit trail.
    """

    edge_type: str
    confidence: float
    property_type: str
    clarification_needed: bool
    clarification_question: str
    implicit_inferences_suppressed: list[tuple[str, str]]
    model_tier: str
    raw_response: str = field(default="")


# ---------------------------------------------------------------------------
# Arbitration request type (for contradiction deferral)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ArbitrationRequest:
    """Deferred contradiction waiting for guardian resolution.

    When check_contradiction (Step 3) detects a conflict, no edge is written.
    Instead, an ArbitrationRequest is created -- both in the graph as an
    INSTANCE-level node and as this Python dataclass passed back to the caller.

    Attributes:
        arbitration_id: NodeId of the ArbitrationRequest graph node.
        subject_node_id: WordSenseNode ID of the fact subject.
        object_node_id: WordSenseNode ID of the fact object.
        proposed_edge_type: The edge type that was proposed but blocked.
        conflicting_edge_id: EdgeId of the existing edge that conflicts.
        conflict_type: Human-readable description of the conflict category
            (e.g., 'IS_A_cycle', 'HAS_PROPERTY_vs_LACKS_PROPERTY').
        asserted_text: The original guardian utterance that triggered the conflict.
    """

    arbitration_id: NodeId
    subject_node_id: NodeId
    object_node_id: NodeId
    proposed_edge_type: str
    conflicting_edge_id: EdgeId
    conflict_type: str
    asserted_text: str


# ---------------------------------------------------------------------------
# Teaching response type (payload passed to PT-7)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SemanticTeachingResponse:
    """Payload produced by Step 6 (generate_response) for PT-7 consumption.

    Describes the outcome of the assert_fact pipeline so that PT-7 can
    generate a natural-language confirmation that cites specific graph
    properties.

    Attributes:
        success: True if a semantic edge was created. False if the pipeline
            was blocked (contradiction, clarification needed, validation error).
        edge_id: EdgeId of the created semantic edge, or empty string if no
            edge was created.
        edge_type: The semantic edge type that was created (or proposed).
        subject_lemma: The lemma of the subject WordSenseNode.
        object_lemma: The lemma of the object WordSenseNode.
        scope_context_count: The scope_context_count on the created or updated edge.
        property_type: Sub-type for HAS_PROPERTY edges ('sensory', 'functional',
            'categorical'). Empty string for other edge types.
        implicit_inferences_suppressed: List of (edge_type, target_lemma)
            tuples the system chose not to assert. Surfaced to guardian so
            they can decide whether to teach those additional facts.
        clarification_needed: True when PT-10 confidence was below threshold
            and the handler is asking the guardian to clarify.
        clarification_question: The guardian-facing question when clarification
            is needed. Empty string otherwise.
        arbitration_id: NodeId of the ArbitrationRequest if a contradiction was
            detected. Empty string otherwise.
        conflict_description: Human-readable description of the conflict, if any.
        failure_reason: When success is False and neither clarification nor
            arbitration applies, describes the pipeline failure reason.
    """

    success: bool
    edge_id: str
    edge_type: str
    subject_lemma: str
    object_lemma: str
    scope_context_count: int
    property_type: str
    implicit_inferences_suppressed: list[tuple[str, str]]
    clarification_needed: bool
    clarification_question: str
    arbitration_id: str
    conflict_description: str
    failure_reason: str


# ---------------------------------------------------------------------------
# Teaching request type (input to SemanticTeachingHandler.assert_fact)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SemanticTeachingRequest:
    """Input to SemanticTeachingHandler.assert_fact().

    Carries all information needed to run the six-step pipeline:
    the parse bindings from the syntactic layer, the raw guardian text,
    and the conversation context identifiers.

    Attributes:
        raw_text: The guardian's utterance verbatim (for provenance and
            PT-10 input).
        template_name: Name of the syntactic template that matched
            (e.g., 'parse_copular', 'parse_transitive'). Determines which
            role_bindings keys are expected.
        role_bindings: The extracted role-to-lemma mapping from the
            SyntacticTemplateMatcher result. For copular templates:
            {'subject': 'cat', 'predicate_noun': 'animal'} or
            {'subject': 'apple', 'predicate_adj': 'red'}.
            For transitive templates:
            {'agent': 'fire', 'action': 'cause', 'patient': 'heat'}.
        subject_node_id: NodeId of the subject WordSenseNode (resolved by
            caller before invoking assert_fact). May be empty string if the
            lemma is not yet in the graph -- handler creates the node.
        object_node_id: NodeId of the object WordSenseNode (resolved by
            caller). May be empty string for the same reason.
        session_id: Current conversation session identifier.
        turn_id: Identifier of the ConversationTurnNode for this utterance.
        correlation_id: Traces this request through logs and events.
        conversation_context_id: NodeId of the active ConversationContext node.
            Used by Step 5 to determine whether scope_context_count should
            increment. Empty string if no context tracking is active.
    """

    raw_text: str
    template_name: str
    role_bindings: dict[str, str]
    subject_node_id: str
    object_node_id: str
    session_id: str
    turn_id: str
    correlation_id: str
    conversation_context_id: str = field(default="")


# ---------------------------------------------------------------------------
# Pipeline result type (internal use within handler)
# ---------------------------------------------------------------------------


@dataclass
class SemanticPipelineState:
    """Mutable state threaded through the six pipeline steps.

    Each step reads from and writes to this state object. Using a mutable
    state carrier rather than return values prevents parameter lists from
    growing unwieldy as steps accumulate outputs consumed by later steps.

    Attributes:
        request: The original SemanticTeachingRequest (immutable).
        subject_node_id: Resolved or created subject WordSenseNode NodeId.
        object_node_id: Resolved or created object WordSenseNode NodeId.
        subject_lemma: Human-readable lemma for the subject.
        object_lemma: Human-readable lemma for the object.
        pt10_result: Output of Step 2 (call_pt10). None until Step 2 runs.
        created_edge_id: EdgeId of the semantic edge written in Step 4.
            Empty string until Step 4 runs.
        scope_context_count: Final scope_context_count after Step 5. Starts at 0.
        arbitration: ArbitrationRequest if Step 3 detected a contradiction.
        aborted: True if any step determined the pipeline should not continue.
        abort_reason: Human-readable reason for abortion.
    """

    request: SemanticTeachingRequest
    subject_node_id: str = field(default="")
    object_node_id: str = field(default="")
    subject_lemma: str = field(default="")
    object_lemma: str = field(default="")
    pt10_result: PT10Result | None = field(default=None)
    created_edge_id: str = field(default="")
    scope_context_count: int = field(default=0)
    arbitration: ArbitrationRequest | None = field(default=None)
    aborted: bool = field(default=False)
    abort_reason: str = field(default="")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class SemanticTeachingError(Exception):
    """Base class for semantic teaching pipeline errors."""


class SemanticParseValidationError(SemanticTeachingError):
    """Step 1 failed: required role bindings missing from syntactic parse."""


class PT10ExecutorNotConfiguredError(SemanticTeachingError):
    """Step 2 failed: no PT10PromptExecutor was injected into the handler."""


class SemanticEdgeWriteError(SemanticTeachingError):
    """Step 4 failed: could not write the semantic edge to the graph."""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    # Template ID constants
    "ASSERT_FACT_TEMPLATE_ID",
    "ASSERT_FACT_TEMPLATE_NAME",
    # Pipeline step action name constants
    "ACTION_VALIDATE_PARSE",
    "ACTION_CALL_PT10",
    "ACTION_CHECK_CONTRADICTION",
    "ACTION_CREATE_EDGE",
    "ACTION_UPDATE_SCOPE_COUNT",
    "ACTION_GENERATE_RESPONSE",
    # Validation sets
    "VALID_SEMANTIC_EDGE_TYPES",
    "PROPERTY_TYPE_VALUES",
    # Data types
    "PT10Result",
    "ArbitrationRequest",
    "SemanticTeachingResponse",
    "SemanticTeachingRequest",
    "SemanticPipelineState",
    # Errors
    "SemanticTeachingError",
    "SemanticParseValidationError",
    "PT10ExecutorNotConfiguredError",
    "SemanticEdgeWriteError",
]

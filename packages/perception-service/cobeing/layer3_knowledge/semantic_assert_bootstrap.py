"""Bootstrap for the assert_fact ProceduralTemplate node (Phase 1.8, P1.8-E2/T001).

Creates the ``proc:assert_fact`` ProceduralTemplate node in the graph with:

  - ``domain: semantic`` property -- identifies it as a semantic template,
    routing to SemanticTeachingHandler instead of ProcedureExecutor.
  - Six ProcedureStep children carrying ``step_type: semantic_action`` and
    ``action_name`` properties naming each pipeline step.
  - One DEPENDS_ON edge to the SemanticDomain registration node
    (``domain:semantic``) to document the semantic domain dependency.

The ProcedureStep children are configuration metadata, not computational AST
nodes. SemanticTeachingHandler reads their ``action_name`` and ``parameters``
properties to discover the pipeline steps, then executes them through
dedicated Python methods. This is distinct from ProcedureExecutor which
traverses AST nodes as an expression tree.

All nodes use TAUGHT_PROCEDURE provenance (CANON A.11 / A.18). This function
is idempotent: if the ProceduralTemplate node already exists, the function
skips creation and returns the existing count.

The six steps stored as ProcedureStep children (ordered by HAS_OPERAND.position):

  Position 0 -- ``validate_parse``
    Verifies syntactic parse bindings before touching the LLM or graph.

  Position 1 -- ``call_pt10``
    Calls PT-10 to classify the semantic edge type. Haiku for copular
    statements; Sonnet for causal/conditional.

  Position 2 -- ``check_contradiction``
    Queries for conflicting semantic edges using LogicalAxiom rules.
    Creates ArbitrationRequest node on conflict; aborts pipeline.

  Position 3 -- ``create_edge``
    Writes the semantic edge with full property schema and GUARDIAN provenance.
    scope_context_count starts at 1.

  Position 4 -- ``update_scope_count``
    Increments scope_context_count if this is a genuinely new context.

  Position 5 -- ``generate_response``
    Produces the SemanticTeachingResponse payload for PT-7 to consume.

Usage::

    from cobeing.layer3_knowledge.semantic_assert_bootstrap import (
        bootstrap_assert_fact_template,
        AssertFactBootstrapResult,
    )

    result = await bootstrap_assert_fact_template(persistence)
    # result.template_created == True  (first call)
    # result.template_created == False (subsequent calls, idempotent)
    # result.steps_created == 6  (first call) or 0 (subsequent calls)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from cobeing.layer3_knowledge.exceptions import BootstrapError
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.procedure_types import (
    DEPENDS_ON,
    HAS_OPERAND,
    HAS_PROCEDURE_BODY,
    PROCEDURE_STEP,
    PROCEDURAL_TEMPLATE,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.semantic_teaching_types import (
    ACTION_CALL_PT10,
    ACTION_CHECK_CONTRADICTION,
    ACTION_CREATE_EDGE,
    ACTION_GENERATE_RESPONSE,
    ACTION_UPDATE_SCOPE_COUNT,
    ACTION_VALIDATE_PARSE,
    ASSERT_FACT_TEMPLATE_ID,
    ASSERT_FACT_TEMPLATE_NAME,
)
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Semantic domain dependency node ID (installed by P1.8-E1 bootstrap)
# ---------------------------------------------------------------------------

_SEMANTIC_DOMAIN_NODE_ID = NodeId("domain:semantic")
"""NodeId of the SemanticDomain DomainRegistration node installed by E1.

The assert_fact template depends on the SemanticDomain being registered.
A DEPENDS_ON edge is created from the template to this node."""


# ---------------------------------------------------------------------------
# Provenance helper
# ---------------------------------------------------------------------------


def _taught() -> Provenance:
    """Canonical TAUGHT_PROCEDURE provenance for all bootstrap nodes."""
    return Provenance(
        source=ProvenanceSource.TAUGHT_PROCEDURE,
        source_id="semantic-assert-fact-bootstrap",
        confidence=1.0,
    )


# ---------------------------------------------------------------------------
# Step definitions
#
# Each entry describes one ProcedureStep child of the assert_fact template.
# Properties carried on each step node:
#   step_type:   always "semantic_action" -- signals SemanticTeachingHandler,
#                not ProcedureExecutor, should process this template.
#   action_name: the pipeline step name matched by the handler dispatch table.
#   description: human-readable explanation of what this step does.
#   parameters:  dict of step-level configuration (may be empty).
#
# The template's AST root is the first step (validate_parse). Steps are
# chained in sequence via position-ordered HAS_OPERAND edges rather than
# nested expression-tree operands, because semantic actions are sequential
# pipeline stages, not recursive expression operands.
#
# Structure:
#   proc:assert_fact
#     --HAS_PROCEDURE_BODY-->  step:assert_fact:validate_parse  (root)
#     step root --HAS_OPERAND (position=1)--> step:assert_fact:call_pt10
#     step root --HAS_OPERAND (position=2)--> step:assert_fact:check_contradiction
#     step root --HAS_OPERAND (position=3)--> step:assert_fact:create_edge
#     step root --HAS_OPERAND (position=4)--> step:assert_fact:update_scope_count
#     step root --HAS_OPERAND (position=5)--> step:assert_fact:generate_response
# ---------------------------------------------------------------------------

_STEP_DEFS: list[dict] = [
    {
        "id": "step:assert_fact:validate_parse",
        "action_name": ACTION_VALIDATE_PARSE,
        "description": (
            "Verify that the syntactic parse bindings are present and non-empty. "
            "Checks for subject+predicate_noun (copular) or agent+patient (transitive). "
            "Raises SemanticParseValidationError if required bindings are absent. "
            "This step runs before any LLM call or graph access."
        ),
        "parameters": {
            "required_copular_bindings": ["subject", "predicate_noun"],
            "required_copular_adj_bindings": ["subject", "predicate_adj"],
            "required_transitive_bindings": ["agent", "patient"],
            "abort_on_failure": True,
        },
    },
    {
        "id": "step:assert_fact:call_pt10",
        "action_name": ACTION_CALL_PT10,
        "description": (
            "Call PT-10 to classify the semantic edge type from the parse bindings. "
            "Model tier: Haiku for copular statements (IS_A / HAS_PROPERTY boundary); "
            "Sonnet for causal and conditional statements (CAUSES, ENABLES, PREVENTS, REQUIRES). "
            "Returns PT10Result with edge_type, confidence, property_type, "
            "clarification_needed, and implicit_inferences_suppressed. "
            "If clarification_needed is True the pipeline aborts and asks the guardian."
        ),
        "parameters": {
            "confidence_threshold": 0.7,
            "copular_tier": "haiku",
            "causal_tier": "sonnet",
        },
    },
    {
        "id": "step:assert_fact:check_contradiction",
        "action_name": ACTION_CHECK_CONTRADICTION,
        "description": (
            "Query the graph for semantic edges that conflict with the proposed fact. "
            "Uses LogicalAxiom nodes (axiom:IS_A:asymmetry, axiom:CAUSES:asymmetry) "
            "to detect IS_A cycle violations. Detects HAS_PROPERTY vs LACKS_PROPERTY "
            "direct conflicts on the same (subject, object) pair. "
            "If a contradiction is found, creates an ArbitrationRequest INSTANCE node "
            "and aborts the pipeline without writing any semantic edge. "
            "No partial writes occur -- the graph remains consistent."
        ),
        "parameters": {
            "check_is_a_cycles": True,
            "check_property_negation_conflict": True,
            "max_cycle_detection_depth": 5,
        },
    },
    {
        "id": "step:assert_fact:create_edge",
        "action_name": ACTION_CREATE_EDGE,
        "description": (
            "Write the semantic edge to the graph with GUARDIAN provenance. "
            "Edge properties: scope_context_count=1, session_id, turn_id, "
            "asserted_text (original guardian utterance), pt10_edge_type, "
            "pt10_confidence, property_type (for HAS_PROPERTY), "
            "valid_from=current_timestamp, valid_to=null, "
            "guardian_confirmed=False, has_conflict=False. "
            "WordSenseNodes that do not yet exist in the graph are created "
            "with GUARDIAN provenance before the edge is written."
        ),
        "parameters": {
            "initial_scope_context_count": 1,
            "initial_guardian_confirmed": False,
            "initial_confidence": 1.0,
            "provenance_source": "guardian",
        },
    },
    {
        "id": "step:assert_fact:update_scope_count",
        "action_name": ACTION_UPDATE_SCOPE_COUNT,
        "description": (
            "Increment scope_context_count if this assertion comes from a genuinely "
            "different ConversationContext than the context in which the edge was last "
            "updated. Context boundary conditions: different session_id, topic shift "
            "detected in the ConversationContext node, or time gap > 30 minutes. "
            "Same-session repetition of the same fact does not increment the count. "
            "This implements the Piagetian situated-to-categorical progression: "
            "the count measures genuine contextual diversity, not utterance frequency."
        ),
        "parameters": {
            "topic_shift_gap_minutes": 30,
            "categorical_threshold": 3,
        },
    },
    {
        "id": "step:assert_fact:generate_response",
        "action_name": ACTION_GENERATE_RESPONSE,
        "description": (
            "Produce the SemanticTeachingResponse payload for PT-7 consumption. "
            "The payload cites the committed edge properties: edge_type, "
            "subject_lemma, object_lemma, scope_context_count, property_type. "
            "When implicit_inferences_suppressed is non-empty, the payload "
            "includes those tuples so PT-7 can surface them to the guardian. "
            "When the pipeline was aborted (contradiction or clarification needed), "
            "the payload describes the reason without referencing non-existent edges."
        ),
        "parameters": {},
    },
]


# ---------------------------------------------------------------------------
# Bootstrap result
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AssertFactBootstrapResult:
    """Outcome of a ``bootstrap_assert_fact_template()`` call.

    Attributes:
        template_created: True if the ProceduralTemplate node was newly created.
            False if it already existed (idempotent run).
        steps_created: Number of ProcedureStep nodes created this call.
            0 if the template already existed (all steps assumed present).
        edges_created: Number of structural edges created this call
            (HAS_PROCEDURE_BODY + HAS_OPERAND * 5 + DEPENDS_ON = 7 total
            on first run).
    """

    template_created: bool
    steps_created: int
    edges_created: int


# ---------------------------------------------------------------------------
# Internal builders
# ---------------------------------------------------------------------------


def _build_template_node() -> KnowledgeNode:
    """Build the assert_fact ProceduralTemplate KnowledgeNode."""
    return KnowledgeNode(
        node_id=NodeId(ASSERT_FACT_TEMPLATE_ID),
        node_type=PROCEDURAL_TEMPLATE,
        schema_level=SchemaLevel.SCHEMA,
        properties={
            "name": ASSERT_FACT_TEMPLATE_NAME,
            "description": (
                "Six-step semantic teaching pipeline that converts a guardian "
                "natural-language assertion ('cats are animals') into a semantic "
                "edge in the knowledge graph with GUARDIAN provenance. "
                "domain='semantic' routes to SemanticTeachingHandler, not ProcedureExecutor. "
                "Children are configuration metadata (step_type='semantic_action'), "
                "not computational AST operands."
            ),
            "parameters": [],
            "arity": 0,
            "domain": "semantic",
            "handler_class": "SemanticTeachingHandler",
            "version": "1.0.0",
        },
        provenance=_taught(),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _build_step_node(step_def: dict) -> KnowledgeNode:
    """Build one ProcedureStep KnowledgeNode from a step definition."""
    return KnowledgeNode(
        node_id=NodeId(step_def["id"]),
        node_type=PROCEDURE_STEP,
        schema_level=SchemaLevel.SCHEMA,
        properties={
            "step_type": "semantic_action",
            "action_name": step_def["action_name"],
            "description": step_def["description"],
            "parameters": step_def["parameters"],
        },
        provenance=_taught(),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _build_has_body_edge(template_id: NodeId, root_step_id: NodeId) -> KnowledgeEdge:
    """Build the HAS_PROCEDURE_BODY edge from template to root step."""
    return KnowledgeEdge(
        edge_id=EdgeId(f"edge:has_body:{ASSERT_FACT_TEMPLATE_ID}"),
        source_id=template_id,
        target_id=root_step_id,
        edge_type=HAS_PROCEDURE_BODY,
        properties={},
        provenance=_taught(),
        confidence=1.0,
    )


def _build_has_operand_edge(
    root_step_id: NodeId, child_step_id: NodeId, position: int
) -> KnowledgeEdge:
    """Build a HAS_OPERAND edge from root step to a pipeline step at position."""
    return KnowledgeEdge(
        edge_id=EdgeId(f"edge:has_operand:{ASSERT_FACT_TEMPLATE_ID}:{position}"),
        source_id=root_step_id,
        target_id=child_step_id,
        edge_type=HAS_OPERAND,
        properties={"position": position},
        provenance=_taught(),
        confidence=1.0,
    )


def _build_depends_on_edge(template_id: NodeId) -> KnowledgeEdge:
    """Build the DEPENDS_ON edge from assert_fact template to domain:semantic."""
    return KnowledgeEdge(
        edge_id=EdgeId(f"edge:depends_on:{ASSERT_FACT_TEMPLATE_ID}:{_SEMANTIC_DOMAIN_NODE_ID}"),
        source_id=template_id,
        target_id=_SEMANTIC_DOMAIN_NODE_ID,
        edge_type=DEPENDS_ON,
        properties={},
        provenance=_taught(),
        confidence=1.0,
    )


# ---------------------------------------------------------------------------
# Public bootstrap function
# ---------------------------------------------------------------------------


async def bootstrap_assert_fact_template(
    persistence: GraphPersistence,
) -> AssertFactBootstrapResult:
    """Create the assert_fact ProceduralTemplate node and its six step children.

    Idempotent: if the ProceduralTemplate node already exists (identified by
    ``proc:assert_fact``), the function returns immediately with
    ``template_created=False`` and ``steps_created=0``. The full step tree
    and DEPENDS_ON edge are assumed to exist when the template node exists.

    Graph structure created on first call:

    ``proc:assert_fact`` (ProceduralTemplate, domain='semantic')
        |--HAS_PROCEDURE_BODY-->  ``step:assert_fact:validate_parse``
        |--DEPENDS_ON----------->  ``domain:semantic``

    ``step:assert_fact:validate_parse``  (root step -- position 0)
        |--HAS_OPERAND (pos=1)--> ``step:assert_fact:call_pt10``
        |--HAS_OPERAND (pos=2)--> ``step:assert_fact:check_contradiction``
        |--HAS_OPERAND (pos=3)--> ``step:assert_fact:create_edge``
        |--HAS_OPERAND (pos=4)--> ``step:assert_fact:update_scope_count``
        |--HAS_OPERAND (pos=5)--> ``step:assert_fact:generate_response``

    Args:
        persistence: The graph persistence backend to write to.

    Returns:
        AssertFactBootstrapResult with creation counts.

    Raises:
        BootstrapError: If any node or edge cannot be saved.
    """
    template_node_id = NodeId(ASSERT_FACT_TEMPLATE_ID)

    # Idempotency check
    existing = await persistence.get_node(template_node_id)
    if existing is not None:
        _log.debug(
            "assert_fact ProceduralTemplate already exists -- skipping bootstrap"
        )
        return AssertFactBootstrapResult(
            template_created=False,
            steps_created=0,
            edges_created=0,
        )

    _log.info(
        "Bootstrapping assert_fact ProceduralTemplate (proc:assert_fact) with "
        "%d semantic action steps",
        len(_STEP_DEFS),
    )

    steps_created = 0
    edges_created = 0

    # 1. Write the ProceduralTemplate node
    template_node = _build_template_node()
    try:
        await persistence.save_node(template_node)
    except Exception as exc:
        raise BootstrapError(
            f"Failed to save ProceduralTemplate '{ASSERT_FACT_TEMPLATE_ID}': {exc}"
        ) from exc

    # 2. Write all ProcedureStep nodes
    for step_def in _STEP_DEFS:
        step_node = _build_step_node(step_def)
        try:
            await persistence.save_node(step_node)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to save ProcedureStep '{step_def['id']}': {exc}"
            ) from exc
        steps_created += 1

    # 3. Write HAS_PROCEDURE_BODY edge (template -> root step)
    root_step_id = NodeId(_STEP_DEFS[0]["id"])
    has_body_edge = _build_has_body_edge(template_node_id, root_step_id)
    try:
        await persistence.save_edge(has_body_edge)
    except Exception as exc:
        raise BootstrapError(
            f"Failed to save HAS_PROCEDURE_BODY edge for '{ASSERT_FACT_TEMPLATE_ID}': {exc}"
        ) from exc
    edges_created += 1

    # 4. Write HAS_OPERAND edges (root step -> each subsequent step at positions 1-5)
    for position, step_def in enumerate(_STEP_DEFS[1:], start=1):
        child_step_id = NodeId(step_def["id"])
        operand_edge = _build_has_operand_edge(root_step_id, child_step_id, position)
        try:
            await persistence.save_edge(operand_edge)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to save HAS_OPERAND edge at position {position} "
                f"for '{ASSERT_FACT_TEMPLATE_ID}': {exc}"
            ) from exc
        edges_created += 1

    # 5. Write DEPENDS_ON edge (template -> domain:semantic)
    depends_edge = _build_depends_on_edge(template_node_id)
    try:
        await persistence.save_edge(depends_edge)
    except Exception as exc:
        # Non-fatal: the semantic domain node may not exist yet if E1 has not
        # run. Log a warning rather than raising BootstrapError.
        _log.warning(
            "Could not save DEPENDS_ON edge from '%s' to '%s': %s -- "
            "this is expected if P1.8-E1 bootstrap has not run yet",
            ASSERT_FACT_TEMPLATE_ID,
            _SEMANTIC_DOMAIN_NODE_ID,
            exc,
        )
    else:
        edges_created += 1

    _log.info(
        "assert_fact bootstrap complete: template=1, steps=%d, edges=%d",
        steps_created,
        edges_created,
    )

    return AssertFactBootstrapResult(
        template_created=True,
        steps_created=steps_created,
        edges_created=edges_created,
    )


__all__ = [
    "AssertFactBootstrapResult",
    "bootstrap_assert_fact_template",
]

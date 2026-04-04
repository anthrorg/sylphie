"""SemanticTeachingHandler -- six-step assert_fact pipeline (Phase 1.8, P1.8-E2/T001).

Implements the dedicated handler class that executes the semantic teaching
pipeline when a guardian statement is identified as a semantic assertion.

This handler is NOT a subclass of ProcedureExecutor and DOES NOT share any
code with ProcedureExecutor. Mathematical computation (ProcedureExecutor)
and semantic relationship creation (SemanticTeachingHandler) are categorically
different operations:

  - ProcedureExecutor takes ValueNode operands, traverses an expression-tree
    AST, and returns a ValueNode result.
  - SemanticTeachingHandler takes syntactic parse bindings, calls PT-10 for
    classification, checks the graph for contradictions, and writes a directed
    semantic edge between two WordSenseNodes.

The six pipeline steps are:

  Step 1 -- validate_parse
    Check that the role_bindings from the SyntacticTemplateMatcher match the
    expected shape for the template type. Copular templates require subject +
    predicate_noun OR predicate_adj. Transitive templates require agent + patient.
    Raises SemanticParseValidationError on missing required bindings.

  Step 2 -- call_pt10
    Invoke the injected PT10PromptExecutor to classify the semantic edge type.
    The executor Protocol is defined in Layer 3 (here); the implementation
    lives in Layer 4 (the LLM caller). Haiku for copular; Sonnet for causal.
    If PT-10 confidence is below 0.7, set clarification_needed=True and abort.

  Step 3 -- check_contradiction
    Query the graph for semantic edges that would conflict with the proposed
    edge. Two conflict patterns are checked:
      a) IS_A cycle: proposed IS_A edge would create a cycle (cat IS_A animal,
         animal IS_A cat violates the IS_A asymmetry axiom).
      b) Property negation: a HAS_PROPERTY edge conflicts with an existing
         LACKS_PROPERTY edge on the same (subject, object) pair, or vice versa.
    On conflict: create ArbitrationRequest INSTANCE node, abort pipeline.
    No partial writes -- the graph remains consistent.

  Step 4 -- create_edge
    Resolve or create the subject and object WordSenseNodes.
    Write the semantic edge with GUARDIAN provenance and full property schema:
    scope_context_count=1, session_id, turn_id, asserted_text, pt10_edge_type,
    pt10_confidence, property_type, valid_from, valid_to=None,
    guardian_confirmed=False.

  Step 5 -- update_scope_count
    Increment scope_context_count on the edge if the current ConversationContext
    differs from the context recorded at edge creation. Same-session repetition
    does not increment. Topic shift (>30 min gap or different session) does.

  Step 6 -- generate_response
    Assemble a SemanticTeachingResponse payload for PT-7 consumption. The
    payload carries committed edge properties so PT-7 can cite specific graph
    facts in its natural-language confirmation. Surfaces suppressed inferences.

Registration with DomainDispatcher:
  DomainDispatcher routes incoming procedure calls to handlers by domain.
  SemanticTeachingHandler registers itself via the ``domain_name`` class
  attribute. The dispatcher calls ``handler.assert_fact(request)`` for
  any ProceduralTemplate node with ``properties["domain"] == "semantic"``.

Usage::

    from cobeing.layer3_knowledge.semantic_teaching_handler import (
        SemanticTeachingHandler,
    )

    handler = SemanticTeachingHandler(
        persistence=graph_persistence,
        pt10_executor=your_pt10_executor,   # Layer 4 implementation
        event_bus=event_bus,                # Optional
    )

    request = SemanticTeachingRequest(
        raw_text="cats are animals",
        template_name="parse_copular",
        role_bindings={"subject": "cat", "predicate_noun": "animal"},
        subject_node_id="word:cat:noun_1",
        object_node_id="word:animal:noun_1",
        session_id="sess-001",
        turn_id="turn:sess-001:0003",
        correlation_id="corr-abc",
    )

    response = await handler.assert_fact(request)
    # response.success == True
    # response.edge_type == "IS_A"
    # response.subject_lemma == "cat"
    # response.object_lemma == "animal"

Phase 1.8 (Comprehension Layer, P1.8-E2/T001).
CANON A.1 (experience-first), A.18 (TAUGHT_PROCEDURE), A.20 (domain structure).
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Protocol, runtime_checkable

from cobeing.layer3_knowledge.language_types import WORD_SENSE_NODE
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter
from cobeing.layer3_knowledge.semantic_teaching_types import (
    ASSERT_FACT_TEMPLATE_ID,
    VALID_SEMANTIC_EDGE_TYPES,
    PROPERTY_TYPE_VALUES,
    PT10Result,
    ArbitrationRequest,
    SemanticParseValidationError,
    SemanticPipelineState,
    SemanticTeachingRequest,
    SemanticTeachingResponse,
)
from cobeing.layer3_knowledge.semantic_contradiction import (
    SemanticContradictionDetector,
    SemanticConflict,
)
from cobeing.layer3_knowledge.semantic_types import (
    CAUSES,
    CONVERSATION_CONTEXT,
    HAS_PROPERTY,
    IS_A,
    LACKS_PROPERTY,
)
from cobeing.layer3_knowledge.scope_context_mechanics import ScopeContextMechanics
from cobeing.shared.event_bus import EventBus
from cobeing.shared.event_types import SemanticFactAssertedEvent
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import CorrelationId, EdgeId, NodeId

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Layer 3 Protocol for PT-10 (implementation lives in Layer 4)
# ---------------------------------------------------------------------------


@runtime_checkable
class PT10PromptExecutor(Protocol):
    """Contract for the Layer 4 PT-10 semantic formalization executor.

    Layer 3 defines this Protocol. Layer 4 implements it. This preserves the
    clean Layer 3/4 boundary: SemanticTeachingHandler never imports Layer 4
    modules directly.

    The executor receives the guardian's raw utterance and the syntactic role
    bindings, and returns a PT10Result classifying the semantic edge type.

    Model tier selection is the executor's responsibility:
      - Haiku for copular statements (IS_A / HAS_PROPERTY boundary).
      - Sonnet for causal and conditional statements.
    """

    async def classify_semantic_edge(
        self,
        raw_text: str,
        template_name: str,
        role_bindings: dict[str, str],
        correlation_id: str,
    ) -> PT10Result:
        """Classify a syntactic parse result as a semantic edge type.

        Args:
            raw_text: The guardian's original utterance verbatim.
            template_name: Which syntactic template matched (e.g.,
                'parse_copular', 'parse_transitive').
            role_bindings: Role-to-lemma mapping from SyntacticTemplateMatcher.
            correlation_id: Traces the call through logs.

        Returns:
            PT10Result with the classified edge type, confidence, property_type
            (for HAS_PROPERTY edges), clarification_needed flag, and any
            implicit inferences the system chose not to assert.

        Raises:
            Any exception from the underlying LLM call -- caller handles.
        """
        ...


# ---------------------------------------------------------------------------
# Node type constants for ArbitrationRequest
# ---------------------------------------------------------------------------

_ARBITRATION_REQUEST = "ArbitrationRequest"
"""INSTANCE-level node: a deferred contradiction waiting for guardian resolution.

Created by Step 3 when check_contradiction detects a conflict. The node
carries the two conflicting edge IDs and the proposed edge's properties.
The guardian can resolve it by approving one side or asserting a new fact."""


# ---------------------------------------------------------------------------
# Helper: resolve or create a WordSenseNode
# ---------------------------------------------------------------------------


async def _resolve_or_create_word_sense(
    lemma: str,
    persistence: GraphPersistence,
    session_id: str,
    correlation_id: str,
) -> tuple[NodeId, str]:
    """Find a WordSenseNode for the given lemma, or create one.

    Searches for nodes with node_type=WordSenseNode whose ``spelling``
    property matches the lemma (case-insensitive). Returns the first match.

    If no match is found, creates a new WordSenseNode with GUARDIAN provenance
    and a placeholder sense_tag of 'noun_1' (the most common default).

    Args:
        lemma: The word lemma to look up (e.g., 'cat', 'animal').
        persistence: The graph persistence backend.
        session_id: Current session ID for provenance.
        correlation_id: Correlation ID for logging.

    Returns:
        (node_id, lemma) tuple. The lemma is normalized to lowercase.
    """
    normalized = lemma.strip().lower()
    if not normalized:
        # Empty lemma -- generate an anonymous sense node ID.
        anonymous_id = NodeId(f"word:unknown:{uuid.uuid4().hex[:8]}")
        _log.warning(
            "Empty lemma passed to _resolve_or_create_word_sense "
            "(correlation_id=%s) -- creating anonymous node %s",
            correlation_id,
            anonymous_id,
        )
        return anonymous_id, "unknown"

    # Query for existing WordSenseNode with matching spelling
    candidates = await persistence.query_nodes(
        NodeFilter(node_type=WORD_SENSE_NODE)
    )
    for node in candidates:
        spelling = node.properties.get("word") or node.properties.get("spelling", "")
        if spelling.lower() == normalized:
            return node.node_id, normalized

    # No match -- create a new WordSenseNode with GUARDIAN provenance
    new_node_id = NodeId(f"word:{normalized}:noun_1")
    new_node = KnowledgeNode(
        node_id=new_node_id,
        node_type=WORD_SENSE_NODE,
        schema_level=SchemaLevel.SCHEMA,
        properties={
            "word": normalized,
            "spelling": normalized,
            "part_of_speech": "noun",
            "sense_tag": "noun_1",
            "frequency_rank": 0,
            "scope_contexts": 0,
        },
        provenance=Provenance(
            source=ProvenanceSource.GUARDIAN,
            source_id=session_id,
            confidence=1.0,
        ),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )
    await persistence.save_node(new_node)
    _log.info(
        "Created new WordSenseNode '%s' for novel lemma '%s' (correlation_id=%s)",
        new_node_id,
        normalized,
        correlation_id,
    )
    return new_node_id, normalized


# ---------------------------------------------------------------------------
# SemanticTeachingHandler
# ---------------------------------------------------------------------------


class SemanticTeachingHandler:
    """Execute the six-step assert_fact semantic teaching pipeline.

    This handler is the Python-level executor for the assert_fact
    ProceduralTemplate. It does NOT use ProcedureExecutor -- the semantic
    teaching pipeline is a different category of operation from mathematical
    computation. See module docstring for the full rationale.

    Constructor injection is used for all dependencies. No globals, no
    singletons. This makes the handler testable and replaceable.

    Attributes:
        domain_name: Class-level constant used by DomainDispatcher for
            automatic registration. Dispatcher routes any ProceduralTemplate
            with ``properties["domain"] == "semantic"`` to this handler.
        persistence: Graph read/write backend.
        pt10_executor: Layer 4 PT-10 LLM caller (Protocol-typed).
            May be None during construction -- Step 2 raises
            PT10ExecutorNotConfiguredError if called without an executor.
        event_bus: Optional event bus for publishing SemanticFactAssertedEvent
            and SemanticContradictionEvent. May be None.
    """

    domain_name: str = "semantic"
    """DomainDispatcher registration key. Routes domain='semantic' templates here."""

    def __init__(
        self,
        persistence: GraphPersistence,
        pt10_executor: PT10PromptExecutor | None = None,
        event_bus: EventBus | None = None,
        contradiction_detector: SemanticContradictionDetector | None = None,
        scope_mechanics: ScopeContextMechanics | None = None,
    ) -> None:
        """Construct a SemanticTeachingHandler.

        Args:
            persistence: Graph persistence backend. Required -- the handler
                reads and writes the graph in every step.
            pt10_executor: PT-10 LLM prompt executor for edge type
                classification. May be wired after construction via
                ``set_pt10_executor()``. If None at call time, Step 2
                raises PT10ExecutorNotConfiguredError.
            event_bus: Optional event bus. When provided, the handler
                publishes events after successful edge creation and on
                contradiction detection. When None, events are silently
                skipped.
            contradiction_detector: Optional SemanticContradictionDetector.
                When provided, Step 3 delegates to this detector for conflict
                detection and existing-edge marking. When None, Step 3 falls
                back to the handler's internal conflict detection logic.
                The detector is also constructed with the same event_bus so
                SemanticContradictionEvents are published on conflict.
            scope_mechanics: Optional ScopeContextMechanics instance. When
                provided, Step 5 delegates all context-boundary detection and
                scope_context_count incrementing to this object. When None,
                Step 5 falls back to the naive same-session check (legacy
                behaviour preserved for backward compatibility). Callers that
                want full Piagetian context-boundary tracking must inject this.
        """
        self._persistence = persistence
        self._pt10_executor = pt10_executor
        self._event_bus = event_bus
        # If no detector provided, create one using the same persistence and bus.
        # This ensures the detector is always available for Step 3 without
        # requiring callers that don't care about the dependency to inject it.
        self._contradiction_detector: SemanticContradictionDetector = (
            contradiction_detector
            if contradiction_detector is not None
            else SemanticContradictionDetector(
                persistence=persistence,
                event_bus=event_bus,
            )
        )
        # Optional Piagetian scope mechanics -- full context-boundary tracking.
        # When None, Step 5 uses a simplified same-session check.
        self._scope_mechanics: ScopeContextMechanics | None = scope_mechanics

    def set_pt10_executor(self, executor: PT10PromptExecutor) -> None:
        """Wire in the PT-10 executor after construction.

        Used when the factory builds the handler before the Layer 4
        components are initialized. The handler is wired via this setter
        once the LLM client is ready.

        Args:
            executor: The PT-10 LLM prompt executor to use for Step 2.
        """
        self._pt10_executor = executor

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    async def assert_fact(
        self, request: SemanticTeachingRequest
    ) -> SemanticTeachingResponse:
        """Execute the six-step semantic teaching pipeline for one guardian assertion.

        Reads the assert_fact ProceduralTemplate's step nodes from the graph to
        discover step configuration, then runs each step in sequence. The graph
        read happens once at the start and is cached in the pipeline state --
        subsequent steps use the cached configuration rather than re-querying.

        Args:
            request: All information needed to run the pipeline. See
                SemanticTeachingRequest for the full field list.

        Returns:
            SemanticTeachingResponse describing the outcome. ``success=True``
            means a semantic edge was created. ``success=False`` means the
            pipeline was aborted (with reason in ``failure_reason``,
            ``clarification_needed``, or ``arbitration_id``).

        Raises:
            SemanticParseValidationError: Step 1 failed (missing role bindings).
                Caller should surface this as a PT-7 error response.
        """
        state = SemanticPipelineState(request=request)

        # Initialize subject/object from request (may be overridden in Step 4
        # if lemmas are not yet in the graph)
        state.subject_node_id = request.subject_node_id
        state.object_node_id = request.object_node_id

        # Set lemmas from role_bindings for early logging
        bindings = request.role_bindings
        state.subject_lemma = bindings.get("subject", bindings.get("agent", ""))
        state.object_lemma = (
            bindings.get("predicate_noun")
            or bindings.get("predicate_adj")
            or bindings.get("patient")
            or ""
        )

        _log.info(
            "assert_fact pipeline start: raw_text=%r subject=%r object=%r "
            "template=%r session=%s correlation=%s",
            request.raw_text,
            state.subject_lemma,
            state.object_lemma,
            request.template_name,
            request.session_id,
            request.correlation_id,
        )

        # Run each step in sequence; abort on failure
        try:
            await self._step1_validate_parse(state)
        except SemanticParseValidationError:
            raise  # Propagate validation errors to caller

        if not state.aborted:
            await self._step2_call_pt10(state)

        if not state.aborted:
            await self._step3_check_contradiction(state)

        if not state.aborted:
            await self._step4_create_edge(state)

        if not state.aborted:
            await self._step5_update_scope_count(state)

        return await self._step6_generate_response(state)

    # ------------------------------------------------------------------
    # Step 1: validate_parse
    # ------------------------------------------------------------------

    async def _step1_validate_parse(self, state: SemanticPipelineState) -> None:
        """Verify that the syntactic parse bindings satisfy the template requirements.

        Accepted binding shapes:
          Copular: subject + predicate_noun  (cats ARE animals)
          Copular adj: subject + predicate_adj  (apples ARE red)
          Transitive: agent + patient  (fire CAUSES heat)

        Raises:
            SemanticParseValidationError: If no accepted shape is found.
        """
        bindings = state.request.role_bindings
        template = state.request.template_name

        has_copular_noun = bool(
            bindings.get("subject") and bindings.get("predicate_noun")
        )
        has_copular_adj = bool(
            bindings.get("subject") and bindings.get("predicate_adj")
        )
        has_transitive = bool(bindings.get("agent") and bindings.get("patient"))

        if not (has_copular_noun or has_copular_adj or has_transitive):
            _log.warning(
                "assert_fact Step 1 FAILED: template=%r bindings=%r "
                "correlation=%s",
                template,
                bindings,
                state.request.correlation_id,
            )
            raise SemanticParseValidationError(
                f"Template '{template}' role_bindings missing required keys. "
                f"Got: {list(bindings.keys())}. "
                f"Expected one of: [subject+predicate_noun], "
                f"[subject+predicate_adj], [agent+patient]."
            )

        # Update state with resolved lemmas
        state.subject_lemma = (
            bindings.get("subject") or bindings.get("agent") or ""
        ).strip().lower()
        state.object_lemma = (
            bindings.get("predicate_noun")
            or bindings.get("predicate_adj")
            or bindings.get("patient")
            or ""
        ).strip().lower()

        _log.debug(
            "assert_fact Step 1 PASS: subject=%r object=%r template=%r",
            state.subject_lemma,
            state.object_lemma,
            template,
        )

    # ------------------------------------------------------------------
    # Step 2: call_pt10
    # ------------------------------------------------------------------

    async def _step2_call_pt10(self, state: SemanticPipelineState) -> None:
        """Call PT-10 to classify the semantic edge type.

        If no pt10_executor is configured, aborts the pipeline with an
        informative message rather than raising -- the caller can inspect
        state.abort_reason.

        If clarification_needed is True in the result, aborts the pipeline
        with the clarification question in state.abort_reason.
        """
        if self._pt10_executor is None:
            _log.error(
                "assert_fact Step 2 ABORTED: no PT10PromptExecutor configured "
                "(correlation=%s)",
                state.request.correlation_id,
            )
            state.aborted = True
            state.abort_reason = (
                "PT-10 executor not configured. Cannot classify semantic edge type."
            )
            return

        _log.debug(
            "assert_fact Step 2: calling PT-10 for raw_text=%r (correlation=%s)",
            state.request.raw_text,
            state.request.correlation_id,
        )

        try:
            pt10_result = await self._pt10_executor.classify_semantic_edge(
                raw_text=state.request.raw_text,
                template_name=state.request.template_name,
                role_bindings=state.request.role_bindings,
                correlation_id=state.request.correlation_id,
            )
        except Exception as exc:
            _log.exception(
                "assert_fact Step 2 EXCEPTION from PT-10 (correlation=%s): %s",
                state.request.correlation_id,
                exc,
            )
            state.aborted = True
            state.abort_reason = f"PT-10 call failed: {exc}"
            return

        # Validate the returned edge_type against known vocabulary
        if pt10_result.edge_type not in VALID_SEMANTIC_EDGE_TYPES:
            _log.warning(
                "assert_fact Step 2: PT-10 returned unknown edge_type=%r "
                "(correlation=%s) -- aborting",
                pt10_result.edge_type,
                state.request.correlation_id,
            )
            state.aborted = True
            state.abort_reason = (
                f"PT-10 returned unknown edge type '{pt10_result.edge_type}'. "
                f"Valid types: {sorted(VALID_SEMANTIC_EDGE_TYPES)}"
            )
            return

        # Validate property_type for HAS_PROPERTY edges
        if pt10_result.edge_type == HAS_PROPERTY:
            if pt10_result.property_type not in PROPERTY_TYPE_VALUES:
                _log.warning(
                    "assert_fact Step 2: PT-10 returned HAS_PROPERTY with "
                    "invalid property_type=%r (correlation=%s) -- aborting",
                    pt10_result.property_type,
                    state.request.correlation_id,
                )
                state.aborted = True
                state.abort_reason = (
                    f"PT-10 returned HAS_PROPERTY with invalid property_type "
                    f"'{pt10_result.property_type}'. "
                    f"Valid values: {sorted(PROPERTY_TYPE_VALUES)}"
                )
                return

        # Handle clarification needed
        if pt10_result.clarification_needed:
            _log.info(
                "assert_fact Step 2: PT-10 confidence=%.2f below threshold -- "
                "requesting clarification (correlation=%s)",
                pt10_result.confidence,
                state.request.correlation_id,
            )
            state.aborted = True
            state.abort_reason = (
                f"clarification_needed: {pt10_result.clarification_question}"
            )
            state.pt10_result = pt10_result
            return

        state.pt10_result = pt10_result
        _log.debug(
            "assert_fact Step 2 PASS: edge_type=%r confidence=%.2f tier=%s",
            pt10_result.edge_type,
            pt10_result.confidence,
            pt10_result.model_tier,
        )

    # ------------------------------------------------------------------
    # Step 3: check_contradiction
    # ------------------------------------------------------------------

    async def _step3_check_contradiction(self, state: SemanticPipelineState) -> None:
        """Check for semantic contradictions before writing the edge.

        Delegates to SemanticContradictionDetector for conflict detection.
        The detector handles three patterns:

        Pattern A -- IS_A cycle (asymmetry violation):
          Proposed IS_A(cat, animal) + existing IS_A(animal, cat) would form
          a cycle. The IS_A asymmetry axiom forbids cycles.

        Pattern B -- CAUSES cycle (asymmetry violation):
          Same detection logic applied to CAUSES edges.

        Pattern C -- Property negation conflict:
          Proposed HAS_PROPERTY(apple, red) conflicts with existing
          LACKS_PROPERTY(apple, red) on the same pair, or vice versa.

        On conflict:
          1. SemanticContradictionDetector marks the existing conflicting edge
             with has_conflict=True and halves its confidence.
          2. This method creates an ArbitrationRequest INSTANCE node to
             record the deferred conflict for guardian resolution.
          3. Pipeline is aborted (state.aborted = True).
          4. No semantic edge is written -- the graph remains consistent.

        If no conflict is found, the state is unchanged and the pipeline
        continues to Step 4.
        """
        assert state.pt10_result is not None  # Step 2 must have run
        proposed_edge_type = state.pt10_result.edge_type

        # Resolve subject/object node IDs -- Step 4 also resolves these, but
        # Step 3 needs them to query for conflicting edges. If no nodes exist
        # yet (novel lemmas), there can be no contradicting edges.
        subject_id = state.subject_node_id
        object_id = state.object_node_id

        if not subject_id or not object_id:
            # No existing nodes -> no possible contradiction
            _log.debug(
                "assert_fact Step 3: subject or object node ID not yet resolved -- "
                "skipping contradiction check (correlation=%s)",
                state.request.correlation_id,
            )
            return

        # Delegate to SemanticContradictionDetector
        conflict: SemanticConflict = await self._contradiction_detector.check_and_record(
            subject_id=NodeId(subject_id),
            object_id=NodeId(object_id),
            proposed_edge_type=proposed_edge_type,
            subject_lemma=state.subject_lemma,
            object_lemma=state.object_lemma,
            session_id=state.request.session_id,
            correlation_id=state.request.correlation_id,
        )

        if not conflict.conflict_found:
            _log.debug(
                "assert_fact Step 3 PASS: no contradiction detected for "
                "%s(%r, %r) (correlation=%s)",
                proposed_edge_type,
                state.subject_lemma,
                state.object_lemma,
                state.request.correlation_id,
            )
            return

        # Contradiction found -- create ArbitrationRequest and abort pipeline
        _log.warning(
            "assert_fact Step 3: contradiction detected type=%s for "
            "'%s'->[%s]->'%s' (existing_edge=%s, correlation=%s)",
            conflict.conflict_type,
            state.subject_lemma,
            proposed_edge_type,
            state.object_lemma,
            conflict.existing_edge_id,
            state.request.correlation_id,
        )

        arbitration = await self._create_arbitration_request(
            state=state,
            proposed_edge_type=proposed_edge_type,
            conflicting_edge_id=EdgeId(conflict.existing_edge_id),
            conflict_type=conflict.conflict_type,
        )
        state.arbitration = arbitration
        state.aborted = True
        state.abort_reason = conflict.natural_language_summary

    async def _create_arbitration_request(
        self,
        state: SemanticPipelineState,
        proposed_edge_type: str,
        conflicting_edge_id: EdgeId,
        conflict_type: str,
    ) -> ArbitrationRequest:
        """Create an ArbitrationRequest INSTANCE node in the graph.

        The node stores enough information for the guardian to resolve the
        conflict in a later turn: both sides of the conflict, the original
        utterance, and the conflict category.

        Args:
            state: Current pipeline state.
            proposed_edge_type: The edge type that was blocked.
            conflicting_edge_id: EdgeId of the existing conflicting edge.
            conflict_type: Category label for the conflict.

        Returns:
            ArbitrationRequest dataclass with the new node's ID.
        """
        arbitration_id = NodeId(
            f"arbitration:{uuid.uuid4().hex}"
        )
        arb_node = KnowledgeNode(
            node_id=arbitration_id,
            node_type=_ARBITRATION_REQUEST,
            schema_level=SchemaLevel.INSTANCE,
            properties={
                "subject_node_id": state.subject_node_id,
                "object_node_id": state.object_node_id,
                "subject_lemma": state.subject_lemma,
                "object_lemma": state.object_lemma,
                "proposed_edge_type": proposed_edge_type,
                "conflicting_edge_id": str(conflicting_edge_id),
                "conflict_type": conflict_type,
                "asserted_text": state.request.raw_text,
                "session_id": state.request.session_id,
                "turn_id": state.request.turn_id,
                "resolution_status": "pending",
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id=state.request.session_id,
                confidence=1.0,
            ),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        await self._persistence.save_node(arb_node)
        _log.info(
            "Created ArbitrationRequest node '%s' for conflict_type=%r "
            "(correlation=%s)",
            arbitration_id,
            conflict_type,
            state.request.correlation_id,
        )
        return ArbitrationRequest(
            arbitration_id=arbitration_id,
            subject_node_id=NodeId(state.subject_node_id),
            object_node_id=NodeId(state.object_node_id),
            proposed_edge_type=proposed_edge_type,
            conflicting_edge_id=conflicting_edge_id,
            conflict_type=conflict_type,
            asserted_text=state.request.raw_text,
        )

    # ------------------------------------------------------------------
    # Step 4: create_edge
    # ------------------------------------------------------------------

    async def _step4_create_edge(self, state: SemanticPipelineState) -> None:
        """Write the semantic edge to the graph with full property schema.

        Resolves or creates WordSenseNodes for subject and object lemmas.
        Writes the semantic edge with GUARDIAN provenance and all required
        properties. scope_context_count starts at 1.

        Duplicate detection uses a composite key that includes property_type
        for HAS_PROPERTY edges. This prevents false-positive duplicate detection
        when the guardian asserts the same (subject, object) pair with different
        property_type sub-classifications (e.g., a cat being both
        HAS_PROPERTY(hunt, functional) and HAS_PROPERTY(hunt, categorical) is
        two distinct facts, not a duplicate).

        For all other edge types, the composite key is (source_id, target_id,
        edge_type). An edge that matches this composite key is a duplicate if
        it has valid_to=None (currently active).

        After successful edge creation, a SemanticFactAssertedEvent is published
        to the event bus (if one is configured) so that GraphBroadcaster can
        push a real-time delta to the browser UI.
        """
        assert state.pt10_result is not None

        # Resolve or create subject WordSenseNode
        subject_id, subject_lemma = await _resolve_or_create_word_sense(
            lemma=state.subject_lemma,
            persistence=self._persistence,
            session_id=state.request.session_id,
            correlation_id=state.request.correlation_id,
        )
        state.subject_node_id = str(subject_id)
        state.subject_lemma = subject_lemma

        # Resolve or create object WordSenseNode
        object_id, object_lemma = await _resolve_or_create_word_sense(
            lemma=state.object_lemma,
            persistence=self._persistence,
            session_id=state.request.session_id,
            correlation_id=state.request.correlation_id,
        )
        state.object_node_id = str(object_id)
        state.object_lemma = object_lemma

        edge_type = state.pt10_result.edge_type
        property_type = state.pt10_result.property_type
        now = now_utc = __import__("datetime", fromlist=["datetime", "UTC"]).datetime.now(
            __import__("datetime", fromlist=["UTC"]).UTC
        )

        # --- Composite key duplicate detection ---
        #
        # For HAS_PROPERTY edges: the composite key is
        #   (source_id, target_id, edge_type, property_type)
        # because the same (subject, object) pair can legitimately have
        # different property_type sub-classifications (sensory vs functional
        # vs categorical) that encode distinct facts.
        #
        # For all other edge types: the composite key is
        #   (source_id, target_id, edge_type)
        #
        # We query all active (valid_to=None) edges of edge_type from
        # subject to object and filter in Python to handle the composite key.
        existing_edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=edge_type,
                source_node_id=str(subject_id),
                target_node_id=str(object_id),
            )
        )

        duplicate_edge = None
        for e in existing_edges:
            # Only consider active (non-retracted) edges
            if e.properties.get("valid_to") is not None:
                continue
            if e.properties.get("deprecated", False):
                continue
            # For HAS_PROPERTY: also require matching property_type
            if edge_type == HAS_PROPERTY:
                if e.properties.get("property_type", "") == property_type:
                    duplicate_edge = e
                    break
            else:
                # All other edge types: matching (source, target, edge_type) is sufficient
                duplicate_edge = e
                break

        if duplicate_edge is not None:
            _log.info(
                "assert_fact Step 4: active edge '%s' already exists with "
                "same composite key -- skipping create, Step 5 will handle "
                "scope_context_count (correlation=%s)",
                duplicate_edge.edge_id,
                state.request.correlation_id,
            )
            state.created_edge_id = str(duplicate_edge.edge_id)
            state.scope_context_count = duplicate_edge.properties.get(
                "scope_context_count", 1
            )
            return

        # No duplicate found -- build the edge ID
        # Use a timestamp-based suffix to ensure uniqueness across retracted
        # and re-asserted edges (each new assertion gets a fresh identity).
        timestamp_ms = int(now.timestamp() * 1000)
        edge_id = EdgeId(
            f"sem:{edge_type.lower()}:"
            f"{state.subject_node_id}:{state.object_node_id}:"
            f"{timestamp_ms}"
        )

        # Build the semantic edge properties (full schema per T003)
        edge_properties: dict = {
            # --- Core provenance fields ---
            "scope_context_count": 1,
            "session_id": state.request.session_id,
            "turn_id": state.request.turn_id,
            "asserted_text": state.request.raw_text,
            # --- PT-10 classification metadata ---
            "pt10_edge_type": edge_type,
            "pt10_confidence": state.pt10_result.confidence,
            # --- Temporal validity ---
            "valid_from": now.isoformat(),
            "valid_to": None,
            # --- Conflict tracking ---
            "has_conflict": False,
            "conflicting_edge_id": None,
            "conflict_type": None,
            # --- Lifecycle ---
            "deprecated": False,
            "deprecated_at": None,
            "deprecated_by_turn_id": None,
            "guardian_confirmed": False,
            # --- Context tracking ---
            "conversation_context_id": state.request.conversation_context_id,
        }

        # property_type is mandatory for HAS_PROPERTY and LACKS_PROPERTY edges;
        # present but empty for all other edge types (consistent schema).
        edge_properties["property_type"] = property_type

        semantic_edge = KnowledgeEdge(
            edge_id=edge_id,
            source_id=NodeId(state.subject_node_id),
            target_id=NodeId(state.object_node_id),
            edge_type=edge_type,
            properties=edge_properties,
            provenance=Provenance(
                source=ProvenanceSource.GUARDIAN,
                source_id=state.request.session_id,
                confidence=1.0,
            ),
            confidence=1.0,
        )

        await self._persistence.save_edge(semantic_edge)
        state.created_edge_id = str(edge_id)
        state.scope_context_count = 1

        _log.info(
            "assert_fact Step 4 PASS: created semantic edge '%s' "
            "(%s --[%s]--> %s) property_type=%r (correlation=%s)",
            edge_id,
            state.subject_lemma,
            edge_type,
            state.object_lemma,
            property_type,
            state.request.correlation_id,
        )

        # Publish SemanticFactAssertedEvent for real-time graph UI update
        if self._event_bus is not None:
            try:
                event = SemanticFactAssertedEvent(
                    edge_id=str(edge_id),
                    source_node_id=str(subject_id),
                    target_node_id=str(object_id),
                    edge_type=edge_type,
                    subject_lemma=state.subject_lemma,
                    object_lemma=state.object_lemma,
                    scope_context_count=1,
                    property_type=property_type,
                    session_id=state.request.session_id,
                    correlation_id=CorrelationId(state.request.correlation_id),
                )
                await self._event_bus.publish(event)
            except Exception as exc:
                # Non-fatal: event publication failure does not roll back the
                # edge write. The fact is in the graph.
                _log.warning(
                    "assert_fact Step 4: failed to publish SemanticFactAssertedEvent "
                    "(correlation=%s): %s",
                    state.request.correlation_id,
                    exc,
                )

        # ------------------------------------------------------------------
    # Step 5: update_scope_count
    # ------------------------------------------------------------------

    async def _step5_update_scope_count(self, state: SemanticPipelineState) -> None:
        """Increment scope_context_count if the context has genuinely changed.

        When self._scope_mechanics is injected, delegates fully to
        ScopeContextMechanics.increment_scope_count(), which implements the
        three-tier Piagetian context-boundary detection: session change, time
        gap (30 min default), and Jaccard topic shift. That method also
        publishes ScopeContextCountUpdatedEvent on the event bus.

        Without scope_mechanics (legacy / test mode), a simplified same-session
        guard is applied: count increments only when the current session_id
        differs from the session_id recorded on the edge at creation, or when
        a 30-minute time gap has elapsed. Backward compatibility is preserved.

        In both paths, same-session repetition never increments the count --
        scope_context_count measures genuine contextual diversity, not
        utterance frequency (Tulving 1972, Barsalou 2003).
        """
        if not state.created_edge_id:
            _log.debug(
                "assert_fact Step 5: no created_edge_id -- skipping (correlation=%s)",
                state.request.correlation_id,
            )
            return

        # ------------------------------------------------------------------
        # Fast path: delegate to ScopeContextMechanics if available.
        # ------------------------------------------------------------------
        if self._scope_mechanics is not None:
            try:
                result = await self._scope_mechanics.increment_scope_count(
                    edge_id=state.created_edge_id,
                    session_id=state.request.session_id,
                    turn_id=state.request.turn_id,
                    correlation_id=state.request.correlation_id,
                )
                state.scope_context_count = result.new_scope_context_count
                _log.info(
                    "assert_fact Step 5: ScopeContextMechanics -- "
                    "count=%d boundary=%r context_changed=%s "
                    "skip=%r edge=%r (correlation=%s)",
                    result.new_scope_context_count,
                    result.boundary_type,
                    result.context_changed,
                    result.skip_reason,
                    state.created_edge_id,
                    state.request.correlation_id,
                )
            except Exception as exc:
                # Non-fatal: scope count failure must not abort the pipeline.
                _log.warning(
                    "assert_fact Step 5: ScopeContextMechanics raised %r -- "
                    "scope_context_count unchanged (correlation=%s)",
                    exc,
                    state.request.correlation_id,
                )
                try:
                    edge = await self._persistence.get_edge(EdgeId(state.created_edge_id))
                    if edge is not None:
                        state.scope_context_count = edge.properties.get(
                            "scope_context_count", 1
                        )
                except Exception:
                    state.scope_context_count = 1
            return

        # ------------------------------------------------------------------
        # Legacy path: simplified same-session + time-gap check.
        # Used when no ScopeContextMechanics was injected.
        # ------------------------------------------------------------------
        edge = await self._persistence.get_edge(EdgeId(state.created_edge_id))
        if edge is None:
            _log.warning(
                "assert_fact Step 5: edge %r not found -- skipping scope count "
                "(correlation=%s)",
                state.created_edge_id,
                state.request.correlation_id,
            )
            return

        current_scope = edge.properties.get("scope_context_count", 1)
        edge_session = edge.properties.get("session_id", "")
        current_session = state.request.session_id
        context_changed = current_session != edge_session

        if not context_changed and edge.valid_from is not None:
            gap_minutes = (
                datetime.now(UTC) - edge.valid_from
            ).total_seconds() / 60.0
            context_changed = gap_minutes > 30.0

        if not context_changed and state.request.conversation_context_id:
            ctx_node = await self._persistence.get_node(
                NodeId(state.request.conversation_context_id)
            )
            if ctx_node is not None:
                ctx_session = ctx_node.properties.get("session_id", "")
                if ctx_session and ctx_session != edge_session:
                    context_changed = True

        if context_changed:
            new_scope = current_scope + 1
            edge.properties["scope_context_count"] = new_scope
            edge.properties["last_context_session"] = current_session
            await self._persistence.save_edge(edge)
            state.scope_context_count = new_scope
            _log.info(
                "assert_fact Step 5 (legacy): scope_context_count -> %d "
                "edge=%r (correlation=%s)",
                new_scope, state.created_edge_id, state.request.correlation_id,
            )
        else:
            state.scope_context_count = current_scope
            _log.debug(
                "assert_fact Step 5 (legacy): same context -- unchanged at %d "
                "edge=%r (correlation=%s)",
                current_scope, state.created_edge_id, state.request.correlation_id,
            )

    # ------------------------------------------------------------------
    # Step 6: generate_response
    # ------------------------------------------------------------------

    async def _step6_generate_response(
        self, state: SemanticPipelineState
    ) -> SemanticTeachingResponse:
        """Produce the SemanticTeachingResponse payload for PT-7.

        Constructs the response based on the final pipeline state.
        Handles all four outcome paths:
          - success: edge created
          - clarification_needed: PT-10 confidence below threshold
          - contradiction: ArbitrationRequest created
          - other failure: abort_reason contains description
        """
        # Determine edge_type for the response
        edge_type = ""
        property_type = ""
        if state.pt10_result is not None:
            edge_type = state.pt10_result.edge_type
            property_type = state.pt10_result.property_type

        # Determine clarification fields
        clarification_needed = False
        clarification_question = ""
        if state.aborted and state.abort_reason.startswith("clarification_needed:"):
            clarification_needed = True
            clarification_question = state.abort_reason[len("clarification_needed:"):].strip()

        # Determine arbitration fields
        arbitration_id = ""
        conflict_description = ""
        if state.arbitration is not None:
            arbitration_id = str(state.arbitration.arbitration_id)
            conflict_description = state.abort_reason

        # Collect implicit inferences for guardian awareness
        implicit_inferences: list[tuple[str, str]] = []
        if state.pt10_result is not None:
            implicit_inferences = list(state.pt10_result.implicit_inferences_suppressed)

        # Determine failure_reason for other abort cases
        failure_reason = ""
        if state.aborted and not clarification_needed and not arbitration_id:
            failure_reason = state.abort_reason

        success = (
            not state.aborted
            and bool(state.created_edge_id)
        )

        response = SemanticTeachingResponse(
            success=success,
            edge_id=state.created_edge_id,
            edge_type=edge_type,
            subject_lemma=state.subject_lemma,
            object_lemma=state.object_lemma,
            scope_context_count=state.scope_context_count,
            property_type=property_type,
            implicit_inferences_suppressed=implicit_inferences,
            clarification_needed=clarification_needed,
            clarification_question=clarification_question,
            arbitration_id=arbitration_id,
            conflict_description=conflict_description,
            failure_reason=failure_reason,
        )

        if success:
            _log.info(
                "assert_fact pipeline COMPLETE: %s --[%s]--> %s "
                "scope_context_count=%d edge_id=%s (correlation=%s)",
                state.subject_lemma,
                edge_type,
                state.object_lemma,
                state.scope_context_count,
                state.created_edge_id,
                state.request.correlation_id,
            )
        else:
            _log.info(
                "assert_fact pipeline ABORTED: reason=%r "
                "clarification=%s arbitration=%s (correlation=%s)",
                state.abort_reason,
                clarification_needed,
                bool(arbitration_id),
                state.request.correlation_id,
            )

        return response


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    "PT10PromptExecutor",
    "SemanticTeachingHandler",
]

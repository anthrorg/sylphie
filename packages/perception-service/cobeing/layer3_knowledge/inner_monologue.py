"""Inner monologue executor for private reasoning episodes (P1.8-E5).

Implements the core inner monologue loop that mediates between incoming triggers
and external responses. The executor runs graph queries (definition, inference,
classification), tracks reasoning steps as first-class graph artifacts (A.19),
and produces a conclusion that PT-11 translates into guardian-facing language.

Architecture (CANON A.19, A.19.2):

  The inner monologue operates in a PRIVATE register. Inner speech is compressed,
  predicate-dominant, and references graph node IDs. It is never shown to the
  guardian directly.

  External speech operates in a PUBLIC register. It is conversational and
  guardian-appropriate. PT-11 translates the inner conclusion to the outer
  register. PT-12 provides retrospective transparency on explicit request.

  The executor does NOT call PT-11 or PT-12 itself. It produces a
  ReasoningResult that the caller (orchestrator or guardian processor) passes
  to PT-11 for translation. This keeps the executor as a pure graph-reasoning
  component with no LLM dependency.

Four-phase reasoning cycle (conversation engine Phase 3):

  Phase 1 (Decompose): Convert trigger text to primitive activation vectors.
    Each word is looked up in the graph via MEANS edges. Words with no edges
    are epistemic gaps. Output: DecompositionResult + SymbolicTrace.

  Phase 2 (Resolve): Run graph queries to address epistemic gaps and answer
    the trigger. Uses definition/classification/inference executors on the
    grounded words from Phase 1. Output: step summaries + SymbolicTrace.

  Phase 3 (Validate): Check internal coherence. Does the resolved information
    cohere with the primitive activation from Phase 1? Output: SymbolicTrace.

  Phase 4 (Decide): Choose the next action. If comprehension is too low,
    ask a clarifying question naming the missing primitives. If grounded and
    validated, respond. Output: SymbolicTrace with action in notes.

  SymbolicTrace is the output of each phase: an activation pattern, gap list,
  confidence, and private-register notes. It is NOT text narration.

Convergence detection (Phase 2):

  After each reasoning step, the executor tracks confidence changes. If
  confidence changes less than CONVERGENCE_THRESHOLD (0.02) for
  CONVERGENCE_WINDOW (2) consecutive steps, the episode terminates with
  reason "converged". This prevents unnecessary graph queries once the
  reasoning has stabilized.

  Additional termination conditions:
  - MAX_STEPS (5): Hard ceiling to prevent runaway reasoning.
  - no_evidence: If the first step finds no graph evidence, short-circuit.

CANON compliance:
  A.19   -- reasoning episodes as first-class graph artifacts
  A.19.1 -- INFERRED provenance for all nodes
  A.19.2 -- private inner register, public outer register via PT-11
  A.11   -- provenance on every node and edge
  A.12   -- LLM not invoked during reasoning; graph queries only

Debugging quick-ref:
  - If symbolic_traces is empty: SymbolicDecomposer failed silently
  - If comprehension_ratio is 0.0: no MEANS edges exist yet (cold start)
  - If action=clarify always fires: grounding_maintenance hasn't run yet
  - If clarifying_question_hint is None but gaps exist: check decide phase

Changed: Phase 3 (four-phase symbolic reasoning, SymbolicTrace, DecompositionResult)

Usage::

    from cobeing.layer3_knowledge.inner_monologue import (
        InnerMonologueExecutor,
        ReasoningResult,
    )

    executor = InnerMonologueExecutor(
        persistence=graph_persistence,
        definition_executor=def_executor,
        classification_executor=class_executor,
        inference_executor=inf_executor,
    )

    result = await executor.reason(
        trigger="What is a mammal?",
        trigger_type="question",
        session_id="session-abc",
        turn_node_id="turn:001",
    )

    # result.conclusion_text -- inner register, for PT-11 translation
    # result.confidence -- how confident the reasoning is
    # result.grounded -- whether graph evidence was found
    # result.termination_reason -- "converged", "depth_limit", "no_evidence"
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field

from cobeing.layer3_knowledge.exceptions import KnowledgeGraphError
from cobeing.layer3_knowledge.node_types import KnowledgeNode
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.reasoning_episode import (
    create_has_conclusion_edge,
    create_has_reasoning_step_edge,
    create_reasoning_conclusion,
    create_reasoning_episode,
    create_reasoning_step,
    create_references_edge,
    create_triggered_by_edge,
)

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

MAX_STEPS: int = 5
"""Maximum reasoning steps per episode. Prevents runaway reasoning.

Normal episodes terminate via convergence detection well before this limit.
If an episode hits MAX_STEPS, the termination reason is "depth_limit".
"""

CONVERGENCE_THRESHOLD: float = 0.02
"""Minimum confidence change to consider a step productive.

If confidence changes less than this threshold for CONVERGENCE_WINDOW
consecutive steps, the episode terminates with reason "converged".
"""

CONVERGENCE_WINDOW: int = 2
"""Number of consecutive low-change steps before declaring convergence."""

# ---------------------------------------------------------------------------
# Query type routing
# ---------------------------------------------------------------------------

# Maps trigger_type to the sequence of query types to attempt.
# The executor runs queries in this order, checking convergence after each.
_QUERY_SEQUENCE: dict[str, list[str]] = {
    "question": ["definition", "classification", "inference"],
    "gap": ["definition", "inference"],
    "contradiction": ["classification", "inference"],
    "prediction_error": ["definition", "classification"],
}

_DEFAULT_QUERY_SEQUENCE: list[str] = ["definition", "classification", "inference"]
"""Fallback query sequence for unrecognized trigger types."""


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SymbolicTrace:
    """Record of one reasoning phase expressed in primitive symbols.

    Each of the four phases (decompose, resolve, validate, decide) produces
    one SymbolicTrace. Together they form the inner monologue as symbolic
    rather than linguistic reasoning (conversation engine architecture §6).

    This is NOT text narration. It is the computable trace of what the system
    understood at each phase -- suitable for driving further graph queries,
    not for guardian display.

    Attributes:
        phase: One of ``"decompose"``, ``"resolve"``, ``"validate"``,
            ``"decide"``.
        activation_pattern: Primitive node ID → aggregate activation score
            (0.0-1.0). Captures which primitives were active at this phase.
        epistemic_gaps: Words or concepts where understanding is incomplete.
            For "decompose": words with no MEANS edges.
            For "resolve"/"validate": concepts not found in graph.
            For "decide": primitives still missing after resolution.
        phase_confidence: Overall confidence at this phase (0.0-1.0).
        notes: Compressed private-register description of phase state.
            Not narration -- a machine-readable summary.
            Examples:
              "decompose: 3/5 words grounded, ratio=0.60"
              "resolve: definition(mammal) -> IS_A(animal), conf=0.82"
              "validate: coherent, activation supports conclusion"
              "decide: action=clarify missing=[Valence, Cause]"
    """

    phase: str
    activation_pattern: dict[str, float] = field(default_factory=dict)
    epistemic_gaps: list[str] = field(default_factory=list)
    phase_confidence: float = 0.0
    notes: str = ""


@dataclass(frozen=True)
class ReasoningStepSummary:
    """Summary of one reasoning step, included in ReasoningResult for transparency.

    This is a lightweight view of the step -- not the full graph node. Used by
    PT-12 for retrospective transparency and by the caller for logging.

    Attributes:
        step_number: Position in the reasoning chain (0-indexed).
        query_type: What kind of graph query was performed.
        query_subject: What entity was queried about.
        result_summary: Compact summary of the query result.
        confidence_delta: How much this step changed overall confidence.
    """

    step_number: int
    query_type: str
    query_subject: str
    result_summary: str
    confidence_delta: float


@dataclass(frozen=True)
class ReasoningResult:
    """Outcome of an inner monologue reasoning episode.

    This is what the caller receives after the episode completes. The caller
    passes conclusion_text to PT-11 for translation into guardian-facing
    language.

    Attributes:
        episode_id: The node_id of the ReasoningEpisode in the graph.
        conclusion_text: Inner register conclusion. Analytical,
            graph-referencing, NOT guardian-facing. Pass to PT-11.
        external_text: Outer register placeholder. Empty string until
            PT-11 translation is applied by the caller.
        confidence: Overall confidence in the conclusion (0.0-1.0).
        step_count: How many reasoning steps were executed.
        grounded: Whether the conclusion is grounded in graph evidence.
            False if no graph evidence was found.
        referenced_node_count: How many distinct graph nodes were consulted.
        termination_reason: Why the episode terminated. One of:
            "converged" -- confidence stabilized across consecutive steps.
            "depth_limit" -- MAX_STEPS reached.
            "no_evidence" -- first step found no graph evidence.
        reasoning_steps: List of step summaries for transparency (PT-12).
    """

    episode_id: str
    conclusion_text: str
    external_text: str
    confidence: float
    step_count: int
    grounded: bool
    referenced_node_count: int
    termination_reason: str
    reasoning_steps: list[ReasoningStepSummary] = field(default_factory=list)
    # Phase 3: symbolic reasoning traces (one per phase)
    symbolic_traces: list[SymbolicTrace] = field(default_factory=list)
    # Phase 3: epistemic state from decomposition
    epistemic_gaps: list[str] = field(default_factory=list)
    comprehension_ratio: float = 1.0
    # Phase 3: hint for clarifying question generation (None if action != clarify)
    clarifying_question_hint: str | None = None


# ---------------------------------------------------------------------------
# Query executor protocol
# ---------------------------------------------------------------------------

# The InnerMonologueExecutor needs to call definition, classification, and
# inference queries. Rather than importing the concrete executor classes
# (which would create tight coupling), we define a minimal protocol for
# what the executor needs from each query type.
#
# Each query executor is expected to have:
#   async def execute(subject: str, ...) -> some result with confidence
#
# Since the existing executors have different signatures, the inner monologue
# wraps them via _run_query_step() which handles the per-type dispatch.


# ---------------------------------------------------------------------------
# InnerMonologueExecutor
# ---------------------------------------------------------------------------


class InnerMonologueExecutor:
    """Executes private reasoning episodes before producing external responses.

    The inner monologue mediates between incoming questions and external
    responses. It runs graph queries (definition, inference, classification),
    tracks reasoning steps, and produces a conclusion. The external response
    is a translation of the internal conclusion into guardian-appropriate
    language (performed by PT-11, which the caller invokes separately).

    This executor is a pure graph-reasoning component. It does NOT call any
    LLM. All reasoning is done through graph queries. The LLM is only involved
    later when PT-11 translates the conclusion.

    Args:
        persistence: The GraphPersistence backend for saving episode nodes.
        definition_executor: Executor for "what is X?" queries. Expected to
            have an async method that accepts a subject string and returns
            a result with facts and confidence.
        classification_executor: Executor for "is X a Y?" queries. May be
            None if classification queries are not yet unlocked.
        inference_executor: Executor for multi-hop inference queries. May be
            None if inference queries are not yet unlocked.
    """

    def __init__(
        self,
        persistence: GraphPersistence,
        definition_executor: object | None = None,
        classification_executor: object | None = None,
        inference_executor: object | None = None,
    ) -> None:
        self._persistence = persistence
        self._definition_executor = definition_executor
        self._classification_executor = classification_executor
        self._inference_executor = inference_executor

        # Phase 3: symbolic decomposer for primitive activation vectors
        from cobeing.layer3_knowledge.symbolic_decomposer import (  # noqa: PLC0415
            SymbolicDecomposer,
            format_activation_summary,
            primitive_name,
        )
        self._decomposer = SymbolicDecomposer(persistence)
        self._format_activation_summary = format_activation_summary
        self._primitive_name = primitive_name

    async def reason(
        self,
        trigger: str,
        trigger_type: str,
        session_id: str,
        turn_node_id: str | None = None,
    ) -> ReasoningResult:
        """Execute a private reasoning episode.

        Runs graph queries sequentially, tracking confidence after each step.
        Terminates when convergence is detected, the step limit is reached,
        or no evidence is found.

        All reasoning artifacts (episode, steps, conclusion, edges) are
        persisted to the graph as first-class nodes (A.19).

        Args:
            trigger: What prompted the reasoning. For questions, this is the
                guardian's question text. For gaps, a description of the gap.
            trigger_type: Category of trigger. One of: "question", "gap",
                "contradiction", "prediction_error".
            session_id: The conversation session this episode belongs to.
            turn_node_id: Optional node_id of the ConversationTurnNode that
                triggered reasoning. Used to create a TRIGGERED_BY edge.

        Returns:
            ReasoningResult with the episode outcome.

        Raises:
            KnowledgeGraphError: If persisting episode artifacts fails.
        """
        # 1. Create the episode node
        episode_node = create_reasoning_episode(
            trigger=trigger,
            trigger_type=trigger_type,
            session_id=session_id,
        )
        episode_id = str(episode_node.node_id)

        try:
            await self._persistence.save_node(episode_node)
        except Exception as exc:
            raise KnowledgeGraphError(
                f"Failed to save ReasoningEpisode '{episode_id}': {exc}"
            ) from exc

        _log.info(
            "inner_monologue: started episode %s (trigger_type=%s, trigger=%s)",
            episode_id,
            trigger_type,
            trigger[:80],
        )

        # 2. Create TRIGGERED_BY edge if we have a turn node
        if turn_node_id is not None:
            triggered_edge = create_triggered_by_edge(
                episode_id=episode_id,
                turn_node_id=turn_node_id,
            )
            try:
                await self._persistence.save_edge(triggered_edge)
            except Exception as exc:
                _log.warning(
                    "inner_monologue: failed to save TRIGGERED_BY edge "
                    "from %s to %s: %s",
                    episode_id,
                    turn_node_id,
                    exc,
                )

        # 3. Phase 1 (Decompose): primitive activation vectors from trigger text
        symbolic_traces: list[SymbolicTrace] = []
        decomp_result = None
        try:
            decomp_result = await self._decomposer.decompose(trigger)
            activation_summary = self._format_activation_summary(
                decomp_result.aggregate_activation,
                decomp_result.epistemic_gaps,
            )
            decomp_trace = SymbolicTrace(
                phase="decompose",
                activation_pattern=dict(decomp_result.aggregate_activation),
                epistemic_gaps=list(decomp_result.epistemic_gaps),
                phase_confidence=decomp_result.comprehension_ratio,
                notes=(
                    f"decompose: {len(decomp_result.grounded_words)}/"
                    f"{len(decomp_result.tokens)} words grounded, "
                    f"ratio={decomp_result.comprehension_ratio:.2f} "
                    f"{activation_summary}"
                ),
            )
            symbolic_traces.append(decomp_trace)
            _log.debug(
                "inner_monologue: episode %s decompose done -- "
                "ratio=%.2f gaps=%s",
                episode_id,
                decomp_result.comprehension_ratio,
                decomp_result.epistemic_gaps[:5],
            )
        except Exception as exc:
            _log.warning(
                "inner_monologue: decompose phase failed for episode %s: %s",
                episode_id,
                exc,
            )

        # 4. Determine query sequence based on trigger type
        query_sequence = _QUERY_SEQUENCE.get(
            trigger_type, _DEFAULT_QUERY_SEQUENCE
        )

        # 5. Phase 2 (Resolve): Execute reasoning steps (graph queries)
        step_summaries: list[ReasoningStepSummary] = []
        referenced_node_ids: set[str] = set()
        current_confidence = 0.0
        consecutive_low_change = 0
        termination_reason = "depth_limit"
        grounded = False

        # Extract the query subject from the trigger. For questions, use
        # the trigger text directly. A more sophisticated extraction would
        # parse the question, but for now the caller is expected to provide
        # a meaningful trigger string.
        query_subject = trigger

        for step_number in range(MAX_STEPS):
            # Determine which query type to run this step
            query_idx = step_number % len(query_sequence)
            query_type = query_sequence[query_idx]

            # Run the query step
            step_start = time.monotonic()
            step_result = await self._run_query_step(
                query_type=query_type,
                query_subject=query_subject,
                session_id=session_id,
            )
            execution_time_ms = (time.monotonic() - step_start) * 1000

            result_summary = step_result["summary"]
            step_confidence = step_result["confidence"]
            step_node_ids = step_result["referenced_node_ids"]

            # Calculate confidence delta
            confidence_delta = step_confidence - current_confidence

            # Build inner speech (private register, compressed)
            inner_speech = (
                f"{query_type}({query_subject}) -> "
                f"{result_summary[:120]}"
            )

            # Create and save the step node
            step_node = create_reasoning_step(
                episode_id=episode_id,
                step_number=step_number,
                query_type=query_type,
                query_subject=query_subject,
                query_result_summary=result_summary,
                confidence_delta=confidence_delta,
                inner_speech=inner_speech,
                execution_time_ms=execution_time_ms,
            )

            try:
                await self._persistence.save_node(step_node)
            except Exception as exc:
                _log.warning(
                    "inner_monologue: failed to save step %d node: %s",
                    step_number,
                    exc,
                )

            # Save HAS_REASONING_STEP edge
            step_edge = create_has_reasoning_step_edge(
                episode_id=episode_id,
                step_id=str(step_node.node_id),
                step_number=step_number,
            )
            try:
                await self._persistence.save_edge(step_edge)
            except Exception as exc:
                _log.warning(
                    "inner_monologue: failed to save HAS_REASONING_STEP "
                    "edge for step %d: %s",
                    step_number,
                    exc,
                )

            # Save REFERENCES edges for nodes consulted in this step
            for ref_node_id in step_node_ids:
                ref_edge = create_references_edge(
                    step_id=str(step_node.node_id),
                    referenced_node_id=ref_node_id,
                    reference_type="query_result",
                )
                try:
                    await self._persistence.save_edge(ref_edge)
                except Exception as exc:
                    _log.warning(
                        "inner_monologue: failed to save REFERENCES edge "
                        "to %s: %s",
                        ref_node_id,
                        exc,
                    )

            # Track referenced nodes
            referenced_node_ids.update(step_node_ids)

            # Record step summary
            step_summaries.append(
                ReasoningStepSummary(
                    step_number=step_number,
                    query_type=query_type,
                    query_subject=query_subject,
                    result_summary=result_summary,
                    confidence_delta=confidence_delta,
                )
            )

            # Update confidence
            if step_confidence > current_confidence:
                current_confidence = step_confidence
                grounded = True

            # Check for no_evidence on first step
            if step_number == 0 and not step_result["has_evidence"]:
                termination_reason = "no_evidence"
                _log.info(
                    "inner_monologue: episode %s short-circuited -- "
                    "no evidence on first step",
                    episode_id,
                )
                break

            # Check convergence
            if abs(confidence_delta) < CONVERGENCE_THRESHOLD:
                consecutive_low_change += 1
            else:
                consecutive_low_change = 0

            if consecutive_low_change >= CONVERGENCE_WINDOW:
                termination_reason = "converged"
                _log.info(
                    "inner_monologue: episode %s converged after %d steps "
                    "(confidence=%.3f)",
                    episode_id,
                    step_number + 1,
                    current_confidence,
                )
                break

        step_count = len(step_summaries)

        # 6. Phase 2 SymbolicTrace (resolve)
        resolve_activation = dict(decomp_result.aggregate_activation) if decomp_result else {}
        resolve_notes_parts = []
        for s in step_summaries[:3]:
            resolve_notes_parts.append(
                f"{s.query_type}({s.query_subject[:30]})"
                f"->conf={s.confidence_delta:+.2f}"
            )
        resolve_notes = "resolve: " + (
            ", ".join(resolve_notes_parts)
            if resolve_notes_parts
            else f"no_evidence term={termination_reason}"
        )
        resolve_trace = SymbolicTrace(
            phase="resolve",
            activation_pattern=resolve_activation,
            epistemic_gaps=list(decomp_result.epistemic_gaps) if decomp_result else [],
            phase_confidence=current_confidence,
            notes=resolve_notes,
        )
        symbolic_traces.append(resolve_trace)

        # 7. Phase 3 (Validate): coherence check
        # Simple: does the resolved confidence cohere with comprehension ratio?
        decomp_ratio = decomp_result.comprehension_ratio if decomp_result else 1.0
        coherent = grounded or decomp_ratio < 0.3  # ungrounded utterance = expected failure
        validate_notes = (
            "validate: coherent, evidence supports activation"
            if coherent and grounded
            else "validate: gap_detected, low comprehension or no evidence"
        )
        validate_trace = SymbolicTrace(
            phase="validate",
            activation_pattern=resolve_activation,
            epistemic_gaps=list(decomp_result.epistemic_gaps) if decomp_result else [],
            phase_confidence=current_confidence if coherent else current_confidence * 0.5,
            notes=validate_notes,
        )
        symbolic_traces.append(validate_trace)

        # 8. Phase 4 (Decide): choose action
        clarifying_question_hint: str | None = None
        if decomp_result and decomp_result.epistemic_gaps and not grounded:
            # Partial/no comprehension and no graph evidence → ask for clarification
            missing_names = [
                self._primitive_name(pid)
                for pid in decomp_result.missing_primitives[:4]
            ]
            gap_words = decomp_result.epistemic_gaps[:5]
            decide_action = "clarify"
            if missing_names:
                clarifying_question_hint = (
                    f"Partial comprehension. "
                    f"Ungrounded words: {gap_words}. "
                    f"Missing primitives: {missing_names}."
                )
            else:
                clarifying_question_hint = (
                    f"Ungrounded words: {gap_words}. Cannot decompose."
                )
            decide_notes = (
                f"decide: action=clarify "
                f"gaps={gap_words} "
                f"missing_primitives={missing_names}"
            )
        elif grounded:
            decide_action = "respond"
            decide_notes = (
                f"decide: action=respond "
                f"confidence={current_confidence:.2f} "
                f"grounded=True"
            )
        else:
            decide_action = "acknowledge_ignorance"
            decide_notes = (
                f"decide: action=acknowledge_ignorance "
                f"no_evidence term={termination_reason}"
            )
        decide_trace = SymbolicTrace(
            phase="decide",
            activation_pattern=resolve_activation,
            epistemic_gaps=list(decomp_result.epistemic_gaps) if decomp_result else [],
            phase_confidence=current_confidence,
            notes=decide_notes,
        )
        symbolic_traces.append(decide_trace)

        _log.debug(
            "inner_monologue: episode %s decide action=%s",
            episode_id,
            decide_action,
        )

        # 9. Build conclusion (now symbolic-trace-informed)
        if grounded:
            # Summarize the reasoning path from step summaries
            path_parts = [
                f"{s.query_type}({s.query_subject})" for s in step_summaries
            ]
            reasoning_path_summary = " -> ".join(path_parts) + f" -> {termination_reason}"

            conclusion_text = self._build_inner_conclusion(
                step_summaries=step_summaries,
                confidence=current_confidence,
                grounded=True,
            )
        elif clarifying_question_hint:
            # Partial comprehension -- conclusion names the gap precisely
            reasoning_path_summary = f"clarify after {step_count} step(s)"
            conclusion_text = clarifying_question_hint
        else:
            reasoning_path_summary = f"no_evidence after {step_count} step(s)"
            conclusion_text = (
                f"No graph evidence found for: {trigger[:100]}. "
                f"Cannot form a grounded conclusion."
            )

        # Create and save conclusion node
        conclusion_node = create_reasoning_conclusion(
            episode_id=episode_id,
            conclusion_text=conclusion_text,
            external_text="",  # Populated by PT-11 later
            confidence=current_confidence,
            grounded=grounded,
            referenced_node_count=len(referenced_node_ids),
            reasoning_path_summary=reasoning_path_summary,
        )

        try:
            await self._persistence.save_node(conclusion_node)
        except Exception as exc:
            _log.warning(
                "inner_monologue: failed to save conclusion node for "
                "episode %s: %s",
                episode_id,
                exc,
            )

        # Save HAS_CONCLUSION edge
        conc_edge = create_has_conclusion_edge(
            episode_id=episode_id,
            conclusion_id=str(conclusion_node.node_id),
        )
        try:
            await self._persistence.save_edge(conc_edge)
        except Exception as exc:
            _log.warning(
                "inner_monologue: failed to save HAS_CONCLUSION edge "
                "for episode %s: %s",
                episode_id,
                exc,
            )

        # 6. Update episode node with final state
        episode_node.properties["step_count"] = step_count
        episode_node.properties["conclusion_reached"] = grounded
        episode_node.properties["termination_reason"] = termination_reason
        episode_node.confidence = current_confidence
        try:
            await self._persistence.save_node(episode_node)
        except Exception as exc:
            _log.warning(
                "inner_monologue: failed to update episode %s with "
                "final state: %s",
                episode_id,
                exc,
            )

        _log.info(
            "inner_monologue: episode %s complete -- steps=%d, "
            "confidence=%.3f, grounded=%s, termination=%s, "
            "referenced_nodes=%d",
            episode_id,
            step_count,
            current_confidence,
            grounded,
            termination_reason,
            len(referenced_node_ids),
        )

        return ReasoningResult(
            episode_id=episode_id,
            conclusion_text=conclusion_text,
            external_text="",  # Caller applies PT-11
            confidence=current_confidence,
            step_count=step_count,
            grounded=grounded,
            referenced_node_count=len(referenced_node_ids),
            termination_reason=termination_reason,
            reasoning_steps=step_summaries,
            # Phase 3: symbolic reasoning traces
            symbolic_traces=symbolic_traces,
            epistemic_gaps=list(decomp_result.epistemic_gaps) if decomp_result else [],
            comprehension_ratio=decomp_result.comprehension_ratio if decomp_result else 1.0,
            clarifying_question_hint=clarifying_question_hint,
        )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _run_query_step(
        self,
        query_type: str,
        query_subject: str,
        session_id: str,
    ) -> dict:
        """Run a single graph query step and return structured results.

        Dispatches to the appropriate executor based on query_type. Returns
        a dict with standardized keys regardless of which executor ran.

        Args:
            query_type: One of "definition", "classification", "inference".
            query_subject: The entity or question to query about.
            session_id: Current session for trace recording.

        Returns:
            Dict with keys:
              summary (str): Compact text summary of the result.
              confidence (float): Confidence of the result (0.0-1.0).
              has_evidence (bool): Whether any graph evidence was found.
              referenced_node_ids (list[str]): Node IDs consulted.
        """
        # Default empty result for when no executor is available
        empty_result: dict = {
            "summary": f"no {query_type} executor available",
            "confidence": 0.0,
            "has_evidence": False,
            "referenced_node_ids": [],
        }

        try:
            if query_type == "definition" and self._definition_executor is not None:
                return await self._run_definition_query(query_subject, session_id)
            elif query_type == "classification" and self._classification_executor is not None:
                return await self._run_classification_query(query_subject, session_id)
            elif query_type == "inference" and self._inference_executor is not None:
                return await self._run_inference_query(query_subject, session_id)
            else:
                return empty_result
        except Exception as exc:
            _log.warning(
                "inner_monologue: %s query failed for '%s': %s",
                query_type,
                query_subject[:60],
                exc,
            )
            return {
                "summary": f"{query_type} query failed: {exc}",
                "confidence": 0.0,
                "has_evidence": False,
                "referenced_node_ids": [],
            }

    async def _run_definition_query(
        self,
        query_subject: str,
        session_id: str,
    ) -> dict:
        """Execute a definition query and return standardized result.

        Adapts the DefinitionQueryExecutor's result format to the inner
        monologue's standardized step result dict.

        Args:
            query_subject: The entity to define.
            session_id: Current session ID.

        Returns:
            Standardized step result dict.
        """
        executor = self._definition_executor
        if executor is None:
            return {
                "summary": "definition executor not available",
                "confidence": 0.0,
                "has_evidence": False,
                "referenced_node_ids": [],
            }

        # The definition executor may have varying signatures across versions.
        # Use a generic approach: call execute() if it exists, or fall back.
        if hasattr(executor, "execute"):
            result = await executor.execute(  # type: ignore[union-attr]
                subject=query_subject,
                session_id=session_id,
            )
            # Extract facts from the result
            facts = getattr(result, "facts", [])
            confidence = getattr(result, "confidence", 0.0)
            node_ids = []
            for fact in facts:
                if hasattr(fact, "target_node_id"):
                    node_ids.append(fact.target_node_id)

            fact_summaries = []
            for fact in facts[:5]:  # Limit to top 5 facts
                edge_type = getattr(fact, "edge_type", "?")
                target = getattr(fact, "target_label", None) or getattr(
                    fact, "target_node_id", "?"
                )
                fact_summaries.append(f"{edge_type}({target})")

            summary = ", ".join(fact_summaries) if fact_summaries else "no facts"

            return {
                "summary": summary,
                "confidence": float(confidence),
                "has_evidence": len(facts) > 0,
                "referenced_node_ids": node_ids,
            }

        return {
            "summary": "definition executor has no execute method",
            "confidence": 0.0,
            "has_evidence": False,
            "referenced_node_ids": [],
        }

    async def _run_classification_query(
        self,
        query_subject: str,
        session_id: str,
    ) -> dict:
        """Execute a classification query and return standardized result.

        Args:
            query_subject: The entity to classify.
            session_id: Current session ID.

        Returns:
            Standardized step result dict.
        """
        executor = self._classification_executor
        if executor is None:
            return {
                "summary": "classification executor not available",
                "confidence": 0.0,
                "has_evidence": False,
                "referenced_node_ids": [],
            }

        if hasattr(executor, "execute"):
            result = await executor.execute(  # type: ignore[union-attr]
                subject=query_subject,
                session_id=session_id,
            )
            answer = getattr(result, "answer", None)
            confidence = getattr(result, "confidence", 0.0)
            chain = getattr(result, "reasoning_chain", [])
            node_ids = [
                getattr(step, "target_node_id", "")
                for step in chain
                if hasattr(step, "target_node_id")
            ]

            summary = f"answer={answer}, confidence={confidence:.2f}"
            return {
                "summary": summary,
                "confidence": float(confidence),
                "has_evidence": answer is not None,
                "referenced_node_ids": node_ids,
            }

        return {
            "summary": "classification executor has no execute method",
            "confidence": 0.0,
            "has_evidence": False,
            "referenced_node_ids": [],
        }

    async def _run_inference_query(
        self,
        query_subject: str,
        session_id: str,
    ) -> dict:
        """Execute an inference query and return standardized result.

        Args:
            query_subject: The entity or question to reason about.
            session_id: Current session ID.

        Returns:
            Standardized step result dict.
        """
        executor = self._inference_executor
        if executor is None:
            return {
                "summary": "inference executor not available",
                "confidence": 0.0,
                "has_evidence": False,
                "referenced_node_ids": [],
            }

        if hasattr(executor, "execute"):
            result = await executor.execute(  # type: ignore[union-attr]
                subject=query_subject,
                session_id=session_id,
            )
            answer = getattr(result, "answer", None)
            confidence = getattr(result, "confidence", 0.0)
            chain = getattr(result, "reasoning_chain", [])
            node_ids = [
                getattr(step, "target_node_id", "")
                for step in chain
                if hasattr(step, "target_node_id")
            ]

            summary = f"answer={answer}, confidence={confidence:.2f}"
            return {
                "summary": summary,
                "confidence": float(confidence),
                "has_evidence": answer is not None,
                "referenced_node_ids": node_ids,
            }

        return {
            "summary": "inference executor has no execute method",
            "confidence": 0.0,
            "has_evidence": False,
            "referenced_node_ids": [],
        }

    def _build_inner_conclusion(
        self,
        step_summaries: list[ReasoningStepSummary],
        confidence: float,
        grounded: bool,
    ) -> str:
        """Build the inner register conclusion text from step summaries.

        The conclusion is in PRIVATE register (A.19.2): compressed,
        graph-referencing, not guardian-facing. It captures the key findings
        from the reasoning steps in a format suitable for PT-11 translation.

        Args:
            step_summaries: The reasoning steps that were executed.
            confidence: Overall confidence of the reasoning.
            grounded: Whether graph evidence was found.

        Returns:
            Inner register conclusion text.
        """
        if not step_summaries:
            return "No reasoning steps executed."

        # Collect non-empty results
        findings: list[str] = []
        for step in step_summaries:
            if step.result_summary and step.result_summary != "no facts":
                findings.append(
                    f"[{step.query_type}] {step.result_summary}"
                )

        if not findings:
            return "Reasoning steps produced no substantive findings."

        conclusion_parts = [
            f"Findings (confidence={confidence:.2f}, grounded={grounded}):",
        ]
        conclusion_parts.extend(findings)

        return " | ".join(conclusion_parts)


__all__ = [
    "CONVERGENCE_THRESHOLD",
    "CONVERGENCE_WINDOW",
    "InnerMonologueExecutor",
    "MAX_STEPS",
    "ReasoningResult",
    "ReasoningStepSummary",
    "SymbolicTrace",
]

"""Orchestration-level event type constants for the Co-Being event bus.

These are the frozen dataclass bus events used across the orchestration layer.
They are grouped by subsystem and all extend
:class:`~cobeing.shared.event_bus.Event`, making them directly publishable
via :class:`~cobeing.shared.event_bus.EventBus`.

Design note -- what lives here vs. elsewhere
--------------------------------------------
Several domain-level events already exist in their home packages:

- :class:`~cobeing.layer3_knowledge.similarity.SimilarityComputedEvent` --
  stays in ``layer3_knowledge.similarity``. Do not import or duplicate here.
- :class:`~cobeing.layer3_knowledge.behavioral_events.VerificationCompleteEvent` --
  stays in ``layer3_knowledge.behavioral_events``. Do not import or duplicate here.
- :class:`~cobeing.layer4_reasoning.guardian_events.SchemaProposalApproved`,
  ``SchemaProposalRejected``, ``GuardianCorrectionApplied`` -- stay in
  ``layer4_reasoning.guardian_events``. Do not import or duplicate here.

This module defines only the *orchestration-level* bus signals: events that
cross subsystem boundaries and are not already owned by a specific domain
package. Anything that purely concerns a single domain package lives there.

Event hierarchy::

    cobeing.shared.event_bus.Event
        -- Perception --
        ObservationIngestedEvent
        -- Teaching --
        TeachingNodeCreatedEvent
        TeachingNodeUpdatedEvent
        -- Expectation --
        ExpectationUpdatedEvent
        -- Rule engine --
        RuleFiredEvent
        -- Schema evolution --
        SchemaProposalCreatedEvent
        SchemaProposalOutcomeEvent
        -- Guardian --
        GuardianResponseReceivedEvent
        CorrectionAppliedEvent
        -- Verification --
        VerificationObservationEvent
        -- Gap lifecycle --
        GapIdentifiedEvent
        GapResolvedEvent
        GapEscalatedEvent
        -- Circuit breaker --
        CircuitBreakerOpenedEvent
        CircuitBreakerClosedEvent
        -- Camera --
        CameraDisconnectedEvent
        CameraReconnectedEvent
        -- Session lifecycle --
        SessionStartedEvent
        SessionEndedEvent
        -- Capability --
        CapabilityLevelChangedEvent
        -- Conversation (Phase 1.5) --
        ConversationTurnReceivedEvent
        ConversationResponseGeneratedEvent
        CostThresholdReachedEvent
        -- Attractor monitoring --
        AttractorWarningEvent
        -- Voice pipeline (Phase 1.5 / T206) --
        VoiceInputReceivedEvent
        TranscriptionCompleteEvent
        SpeechSynthesisCompleteEvent
        VoiceTurnCompletedEvent
        -- Procedural knowledge contradiction (Phase 1.6 / PKG-2.4) --
        ContradictionDetectedEvent
        -- Procedural computation (Phase 1.6 / PKG-3.3) --
        ProceduralComputationCompletedEvent
        -- Procedural correction (Phase 1.6 / PKG-3.4) --
        ProceduralCorrectionEvent
        -- Semantic knowledge (Phase 1.8 / P1.8-E2/T003) --
        SemanticFactAssertedEvent
        SemanticContradictionEvent
        ScopeContextCountUpdatedEvent
        -- Interface subsystem (Phase 1.5 / T501) --
        VoiceUnavailableEvent
        VoiceAvailableEvent
        WebDegradedEvent
        WebAvailableEvent

Usage::

    from cobeing.shared.event_types import (
        ObservationIngestedEvent,
        SessionStartedEvent,
        SessionEndedEvent,
        VoiceTurnCompletedEvent,
    )
    from cobeing.shared.event_bus import EventBus
    from cobeing.shared.types import CorrelationId
    from cobeing.voice.types import VoiceTurnLog

    bus = EventBus()

    async def on_session_start(event: SessionStartedEvent) -> None:
        print(f"Session {event.session_id} started")

    async def on_turn_complete(event: VoiceTurnCompletedEvent) -> None:
        log = event.turn_log
        print(f"Turn {log.turn_id} cost ${log.total_turn_cost_usd:.6f}")

    bus.subscribe(SessionStartedEvent, on_session_start)
    bus.subscribe(VoiceTurnCompletedEvent, on_turn_complete)
    await bus.publish(SessionStartedEvent(session_id="sess-001"))
"""

from __future__ import annotations

from dataclasses import dataclass, field

from typing import TYPE_CHECKING, Any

from cobeing.shared.event_bus import Event
from cobeing.shared.types import CorrelationId

if TYPE_CHECKING:
    from cobeing.voice.types import VoiceTurnLog


# ---------------------------------------------------------------------------
# Perception events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ObservationIngestedEvent(Event):
    """Emitted after a raw observation has been ingested into the knowledge graph.

    Published by the ingestion layer (Layer 2/3 boundary) after
    ``add_observation`` succeeds and an instance node has been created or
    updated in the graph.

    Attributes:
        node_id: The NodeId string of the instance node created or updated.
        label_raw: The raw YOLO detection label (e.g., ``"cup"``, ``"book"``).
        correlation_id: Traces this event to the originating camera frame.
    """

    node_id: str = field(default="")
    label_raw: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Teaching events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TeachingNodeCreatedEvent(Event):
    """Emitted when TeachingProposalAdapter writes a new node to the graph.

    Published once per node saved during a teaching turn so the
    GraphBroadcaster can push real-time ``node_created`` deltas to the
    browser UI.

    Attributes:
        node_id: The ``node_id`` of the newly-created node.
        label_raw: Human-readable label for the node (node_type or name).
        correlation_id: Traces the teaching turn that produced the node.
    """

    node_id: str = field(default="")
    label_raw: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class TeachingNodeUpdatedEvent(Event):
    """Emitted when TeachingProposalAdapter updates an existing node's properties.

    Published after modifying properties on an existing node (e.g. setting
    display_name on cobeing-self during guardian naming) so the
    GraphBroadcaster can push a real-time ``node_updated`` delta.

    Attributes:
        node_id: The ``node_id`` of the updated node.
        correlation_id: Traces the teaching turn that triggered the update.
    """

    node_id: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class TeachingEdgeCreatedEvent(Event):
    """Emitted when TeachingProposalAdapter writes a new edge to the graph.

    Published once per edge saved during a teaching turn so the
    GraphBroadcaster can push real-time ``edge_created`` deltas to the
    browser UI.

    Attributes:
        edge_id: The ``edge_id`` of the newly-created edge.
        source_node_id: Source end of the edge.
        target_node_id: Target end of the edge.
        edge_type: Relationship type (e.g. RELATES_TO, IS_NAMED, IS_GUARDIAN_OF).
        correlation_id: Traces the teaching turn that produced the edge.
    """

    edge_id: str = field(default="")
    source_node_id: str = field(default="")
    target_node_id: str = field(default="")
    edge_type: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Expectation events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExpectationUpdatedEvent(Event):
    """Emitted after a PropertyExpectation node has been updated for a graph node.

    Published by the expectation manager after running the confidence refresh
    formula on an existing PropertyExpectation (D-TS-10: new_confidence =
    min(1.0, current + (1.0 - current) * 0.1)).

    Attributes:
        node_id: The NodeId string of the instance node whose expectations
            were updated.
        correlation_id: Traces this event to the originating observation session.
    """

    node_id: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Rule engine events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RuleFiredEvent(Event):
    """Emitted when an EvolutionRule fires against a trigger node.

    Published by the rule engine each time a rule's condition evaluates to
    True and the rule's action has been queued or applied.

    Attributes:
        rule_name: The human-readable name of the rule that fired.
        trigger_node_id: The NodeId string of the node that triggered the rule.
        correlation_id: Traces this event to the observation that caused the
            rule evaluation pass.
    """

    rule_name: str = field(default="")
    trigger_node_id: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Schema evolution events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SchemaProposalCreatedEvent(Event):
    """Emitted after a new SchemaProposal node has been written to the graph.

    Published by the schema proposer (Layer 4) after ``create_schema_proposal``
    succeeds. Downstream consumers (e.g., the guardian queue, the orchestrator)
    subscribe to this event to react to new proposals without polling.

    Attributes:
        proposal_id: The NodeId string of the newly created SchemaProposal node.
        correlation_id: Traces this event to the observation session that
            surfaced the pattern prompting the proposal.
    """

    proposal_id: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class SchemaProposalOutcomeEvent(Event):
    """Emitted after a SchemaProposal has received a final disposition.

    Published by the guardian processor after the proposal status is updated
    to APPROVED, REJECTED, CORRECTED, or EXPIRED. Complements the more
    specific ``SchemaProposalApproved`` / ``SchemaProposalRejected`` events in
    ``layer4_reasoning.guardian_events`` by providing a single catch-all for
    subscribers that care about *any* outcome without subscribing to four
    separate event types.

    Attributes:
        proposal_id: The NodeId string of the SchemaProposal that was decided.
        outcome: The outcome string: one of ``"APPROVED"``, ``"REJECTED"``,
            ``"CORRECTED"``, or ``"EXPIRED"``.
        correlation_id: Traces this event to the originating guardian interaction.
    """

    proposal_id: str = field(default="")
    outcome: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Guardian events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GuardianResponseReceivedEvent(Event):
    """Emitted after a GuardianStatement has been parsed and validated.

    Published by the guardian processor immediately after the raw statement
    text has been converted into structured graph operations, before those
    operations are applied. Allows subscribers to observe the raw interaction
    record without waiting for graph writes to complete.

    Attributes:
        statement_id: The NodeId string of the GuardianStatement node that
            was parsed.
        correlation_id: Traces this event to the guardian interaction session.
    """

    statement_id: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class CorrectionAppliedEvent(Event):
    """Emitted after a guardian type-split correction has been applied to the graph.

    Published by the guardian processor after ``apply_correction`` writes the
    new schema type nodes and re-assigns existing instances. Distinct from
    ``GuardianCorrectionApplied`` in ``layer4_reasoning.guardian_events``:
    that event signals the *start* of a correction; this event signals the
    *completion*.

    Attributes:
        correction_id: The unique identifier of the CorrectionEvent record
            that was applied.
        original_type_id: The NodeId string of the schema type that was split.
        new_type_ids: The NodeId strings of the replacement schema type nodes.
        correlation_id: Traces this event to the guardian interaction that
            ordered the correction.
    """

    correction_id: str = field(default="")
    original_type_id: str = field(default="")
    new_type_ids: list[str] = field(default_factory=list)
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Verification events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VerificationObservationEvent(Event):
    """Emitted each time the verification tracker records a post-correction check.

    Published by the VerificationTracker (T056a) after each new observation is
    classified against the types produced by a guardian correction. This is the
    per-observation signal; ``VerificationCompleteEvent`` (in
    ``layer3_knowledge.behavioral_events``) is the window-closure signal.

    Attributes:
        verification_id: The unique identifier of the VerificationResult record
            that was created for this check.
        correct: ``True`` if the observation was classified into one of the
            new split types; ``False`` otherwise.
        correlation_id: Traces this event to the originating observation session.
    """

    verification_id: str = field(default="")
    correct: bool = field(default=False)
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Gap lifecycle events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GapIdentifiedEvent(Event):
    """Emitted when a new curiosity gap is detected in the knowledge graph.

    Published by the curiosity engine (Layer 4) when an incomplete edge or
    poorly characterized node is first identified. Triggers the gap manager
    to create a gap node and transition it to DETECTED state.

    Attributes:
        gap_id: The identifier of the newly detected curiosity gap node.
        correlation_id: Traces this event to the graph scan that found the gap.
    """

    gap_id: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class GapResolvedEvent(Event):
    """Emitted when a curiosity gap reaches a resolved terminal state.

    Published by the gap manager (T057) after a gap transitions to RESOLVED,
    ANSWERED, or SELF_RESOLVED. The ``resolution`` field indicates which
    terminal state was reached.

    Attributes:
        gap_id: The identifier of the curiosity gap that was resolved.
        resolution: One of ``"RESOLVED"``, ``"ANSWERED"``, or
            ``"SELF_RESOLVED"``.
        correlation_id: Traces this event to the operation that resolved the gap.
    """

    gap_id: str = field(default="")
    resolution: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class GapEscalatedEvent(Event):
    """Emitted when a curiosity gap is escalated to the guardian.

    Published by the curiosity engine when a gap that has been DETECTED is
    queued as a guardian question (transition to QUEUED state). Allows the
    orchestrator to track how many questions are in flight.

    Attributes:
        gap_id: The identifier of the curiosity gap being escalated.
        reason: Human-readable description of why this gap requires guardian
            input (derived from graph structure, not verbatim LLM text).
        correlation_id: Traces this event to the curiosity scan that triggered
            the escalation.
    """

    gap_id: str = field(default="")
    reason: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Circuit breaker events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CircuitBreakerOpenedEvent(Event):
    """Emitted when a circuit breaker transitions to the OPEN state.

    Published by :class:`~cobeing.shared.circuit_breaker.CircuitBreaker` when
    the failure threshold is exceeded. Subscribers (e.g., the orchestrator,
    the capability monitor) use this to trigger graceful degradation.

    Attributes:
        service_name: Human-readable name of the service whose circuit opened
            (e.g., ``"neo4j"``, ``"anthropic_api"``).
        reason: Description of the failure pattern that tripped the breaker.
    """

    service_name: str = field(default="")
    reason: str = field(default="")


@dataclass(frozen=True)
class CircuitBreakerClosedEvent(Event):
    """Emitted when a circuit breaker transitions back to the CLOSED (healthy) state.

    Published by :class:`~cobeing.shared.circuit_breaker.CircuitBreaker` when
    a probe call succeeds after the half-open wait period. Allows subscribers
    to restore full capability after a transient service outage.

    Attributes:
        service_name: Human-readable name of the service whose circuit closed.
    """

    service_name: str = field(default="")


# ---------------------------------------------------------------------------
# Camera events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CameraDisconnectedEvent(Event):
    """Emitted when the camera source becomes unavailable.

    Published by the camera capture loop (Layer 2) when ``VideoCapture.read()``
    fails after retries. Triggers the orchestrator to degrade to
    ``CapabilityLevel.REASONING_ONLY`` (no new observations possible).

    Attributes:
        reason: Description of why the camera is unavailable (e.g.,
            ``"VideoCapture.read() returned False after 3 retries"``).
    """

    reason: str = field(default="")


@dataclass(frozen=True)
class CameraReconnectedEvent(Event):
    """Emitted when the camera source becomes available again after a disconnect.

    Published by the camera capture loop when ``VideoCapture.read()`` succeeds
    after a previous ``CameraDisconnectedEvent``. Triggers the orchestrator to
    restore ``CapabilityLevel.FULL``.

    Attributes:
        downtime_seconds: Duration of the camera outage in seconds. Used by
            the session accumulator to record degraded periods.
    """

    downtime_seconds: float = field(default=0.0)


# ---------------------------------------------------------------------------
# Session lifecycle events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SessionStartedEvent(Event):
    """Emitted at the start of a new observation session.

    Published by the orchestrator after all subsystems are initialized and
    the session accumulator has been reset. Subscribers use this to reset
    per-session state.

    Attributes:
        session_id: Unique identifier for the new session.
    """

    session_id: str = field(default="")


@dataclass(frozen=True)
class SessionEndedEvent(Event):
    """Emitted at the end of an observation session.

    Published by the orchestrator before beginning shutdown. Subscribers use
    this to flush buffers, finalize the session accumulator, and persist the
    session summary.

    Attributes:
        session_id: Unique identifier for the session that ended.
    """

    session_id: str = field(default="")


# ---------------------------------------------------------------------------
# Capability events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CapabilityLevelChangedEvent(Event):
    """Emitted when the system's operational capability level changes.

    Published by the orchestrator when circuit breakers open/close or when
    a camera disconnect/reconnect occurs. Subscribers adjust their behavior
    based on which capabilities are currently available.

    Attributes:
        old_level: The ``CapabilityLevel`` integer value before this change.
            See ``cobeing.orchestrator.session.CapabilityLevel`` for values.
        new_level: The ``CapabilityLevel`` integer value after this change.
        reason: Human-readable description of what caused the capability change
            (e.g., ``"neo4j circuit breaker opened"``,
            ``"camera reconnected"``).
    """

    old_level: int = field(default=0)
    new_level: int = field(default=0)
    reason: str = field(default="")


# ---------------------------------------------------------------------------
# Conversation events (Phase 1.5)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ConversationTurnReceivedEvent(Event):
    """Emitted when a guardian question is classified by PT-8.

    Published by the conversation manager after PT-8 has classified the
    incoming text as a conversational turn (not a schema proposal or
    correction). Downstream subscribers (e.g., PT-7, cost monitor) use this
    to trigger response generation and per-session accounting.

    Attributes:
        turn_id: Unique identifier for this conversational exchange. Used to
            correlate this event with the subsequent
            ``ConversationResponseGeneratedEvent``.
        raw_text: The raw guardian input text as received, before any
            processing or sanitisation.
        correlation_id: Traces this event to the originating guardian
            interaction session.
    """

    turn_id: str = field(default="")
    raw_text: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class ConversationResponseGeneratedEvent(Event):
    """Emitted after PT-7 generates a response to a guardian conversation turn.

    Published by the conversation manager after the LLM response has been
    returned and cost metrics recorded. Carries A.8.5 (Chatbot Attractor)
    monitoring data so the orchestrator can track graph grounding ratios and
    detect drift toward unconstrained conversation.

    Attributes:
        turn_id: The same turn identifier from the originating
            ``ConversationTurnReceivedEvent``, allowing event correlation.
        referenced_node_count: Number of distinct knowledge graph nodes
            referenced in the PT-7 response. Used to compute the grounding
            ratio.
        graph_grounding_ratio: Fraction of the response that is grounded in
            the knowledge graph (referenced_node_count / total_claims). Range
            [0.0, 1.0]. Values below threshold trigger A.8.5 warnings.
        cost_usd: Estimated USD cost of the LLM call that produced this
            response, as reported by the Anthropic API usage metadata.
        model_tier: The model tier used for this call, e.g. ``"haiku"`` or
            ``"sonnet"``. Matches ``ModelTier`` string values.
        correlation_id: Traces this event to the originating guardian
            interaction session.
    """

    turn_id: str = field(default="")
    referenced_node_count: int = field(default=0)
    graph_grounding_ratio: float = field(default=0.0)
    cost_usd: float = field(default=0.0)
    model_tier: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class CostThresholdReachedEvent(Event):
    """Emitted when session LLM cost exceeds the configured soft ceiling.

    Published by the cost monitor when the cumulative cost of LLM calls in
    the current session reaches or exceeds the soft ceiling defined in
    ``Layer4Config.daily_cost_limit_usd``. This is a *warning* signal, not
    a hard stop: the system continues operating but subscribers (e.g., the
    orchestrator, Vox) may choose to limit further LLM calls or notify the
    guardian.

    Attributes:
        session_cost_usd: Total accumulated LLM cost in USD for the current
            session at the moment this event was emitted.
        ceiling_usd: The soft cost ceiling that was reached, as configured
            at startup. Allows subscribers to compute the overage fraction
            without reading config directly.
        call_count: Total number of LLM API calls made in the current session
            at the moment this event was emitted. Useful for diagnosing
            whether cost is driven by call frequency or volume.
    """

    session_cost_usd: float = field(default=0.0)
    ceiling_usd: float = field(default=0.0)
    call_count: int = field(default=0)


# ---------------------------------------------------------------------------
# Attractor monitoring events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AttractorWarningEvent(Event):
    """Emitted when a real-time attractor monitor detects a threshold breach.

    Published by stateful attractor monitors (e.g., ``ChatbotAttractorMonitor``)
    when sliding-window metrics cross a configured warning threshold. Unlike the
    batch-oriented ``AttractorStateDetector`` (which processes historical session
    snapshots), this event is emitted in real time as individual signals arrive
    on the event bus.

    Subscribers (orchestrator, logging subsystem, Vox) use this event to
    surface the warning to the guardian and log the grounding degradation for
    offline analysis.

    Attributes:
        attractor_type: String identifier for the attractor being detected.
            For A.8.5 this is ``"chatbot_attractor"``. Matches the string
            values of :class:`~cobeing.validation.attractor_detector.AttractorType`.
        severity: Severity level name as a string (``"WATCH"``, ``"WARNING"``,
            ``"ALERT"``, ``"CONFIRMED"``). Matches
            :class:`~cobeing.validation.attractor_detector.Severity` names.
        indicator: Short identifier for which specific threshold was breached.
            Examples: ``"low_grounding_ratio"``, ``"declining_node_diversity"``,
            ``"graph_growth_stalled"``.
        metric_value: The numeric value of the metric that triggered the
            warning. Allows subscribers to surface the raw number to the
            guardian without re-querying the monitor.
        threshold: The threshold value that ``metric_value`` violated.
        window_size: Number of responses included in the sliding window that
            produced this warning.
        correlation_id: Traces this event to the conversation turn that
            triggered the final threshold breach.
    """

    attractor_type: str = field(default="")
    severity: str = field(default="")
    indicator: str = field(default="")
    metric_value: float = field(default=0.0)
    threshold: float = field(default=0.0)
    window_size: int = field(default=0)
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Voice pipeline events (Phase 1.5 / T206)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VoiceInputReceivedEvent(Event):
    """Emitted when a raw audio chunk arrives and is accepted for processing.

    Published by the voice endpoint handler immediately after a PTT audio
    submission has been received and validated, before STT is called.
    Downstream subscribers (e.g., the latency tracker, the session cost
    monitor) use ``turn_id`` to correlate this with the subsequent
    ``TranscriptionCompleteEvent`` and ``VoiceTurnCompletedEvent``.

    Attributes:
        turn_id: Unique identifier for this voice turn. Same value carried
            through all four voice pipeline events for this turn.
        audio_duration_seconds: Duration of the audio clip in seconds, as
            reported by the HTTP header or computed from the audio payload
            length. Zero when duration is not available before STT.
        content_type: MIME type of the submitted audio (e.g.
            ``"audio/webm;codecs=opus"``). Used for routing to the correct
            decoder if multiple input formats are supported.
        correlation_id: Traces this event to the originating HTTP request or
            WebSocket session.
    """

    turn_id: str = field(default="")
    audio_duration_seconds: float = field(default=0.0)
    content_type: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class TranscriptionCompleteEvent(Event):
    """Emitted after the STT adapter returns a TranscriptionResult.

    Published by the voice pipeline immediately after the Whisper STT call
    completes (success or low-confidence result). Carries the key STT
    metrics so that subscribers can react to transcription quality without
    reading ``VoiceTurnLog`` fields.

    Note: if ``no_speech_prob`` exceeds ``VoiceConfig.no_speech_threshold``
    the transcription is still emitted here but the pipeline will suppress
    downstream processing (no LLM call, no TTS). This allows cost monitors
    to account for STT calls even when the turn produces no response.

    Attributes:
        turn_id: Correlates this event to ``VoiceInputReceivedEvent`` and
            ``VoiceTurnCompletedEvent`` for the same turn.
        text: The transcript text from the STT adapter.
        confidence: STT confidence score in the range 0.0--1.0.
        no_speech_prob: Whisper's no-speech probability in the range 0.0--1.0.
        stt_cost_usd: Estimated cost of the STT call in USD.
        correlation_id: Traces this event to the originating HTTP request or
            WebSocket session.
    """

    turn_id: str = field(default="")
    text: str = field(default="")
    confidence: float = field(default=0.0)
    no_speech_prob: float = field(default=0.0)
    stt_cost_usd: float = field(default=0.0)
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class SpeechSynthesisCompleteEvent(Event):
    """Emitted after the TTS adapter finishes (or fails) a synthesis request.

    Published by the voice pipeline after each TTS call, whether the call
    succeeded or raised an error. The ``succeeded`` flag distinguishes the
    two cases so subscribers do not need to subscribe to a separate error
    event type.

    If ``succeeded`` is ``False``, ``character_count`` and ``tts_cost_usd``
    are zero (no audio was produced and the API was not billed).

    Attributes:
        turn_id: Correlates this event to ``VoiceInputReceivedEvent`` and
            ``VoiceTurnCompletedEvent`` for the same turn.
        character_count: Number of characters in the text that was submitted
            to TTS. Zero if TTS failed before the API call.
        tts_cost_usd: Estimated cost of the TTS call in USD. Zero if the
            call failed.
        voice: The TTS voice name used (e.g. ``"alloy"``). Empty string if
            TTS was not reached.
        succeeded: ``True`` if the TTS call completed and audio was produced;
            ``False`` if an error prevented audio production.
        correlation_id: Traces this event to the originating HTTP request or
            WebSocket session.
    """

    turn_id: str = field(default="")
    character_count: int = field(default=0)
    tts_cost_usd: float = field(default=0.0)
    voice: str = field(default="")
    succeeded: bool = field(default=True)
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class VoiceTurnCompletedEvent(Event):
    """Emitted when all processing for a voice turn is finished.

    Published by the ``ConversationManager`` after TTS completes (or when
    an error terminates the turn early). This is the terminal event for a
    voice turn: once this event is emitted, no further events will be
    published for ``turn_id``.

    The ``turn_log`` field carries the complete audit record for this turn,
    giving any subscriber access to the full set of latency, cost, and
    quality metrics without querying storage.

    Attributes:
        turn_id: Unique identifier for the completed voice turn. Matches the
            ``turn_id`` of the three preceding voice pipeline events.
        turn_log: Complete ``VoiceTurnLog`` record for this turn, assembled
            at completion time. Contains all latency breakdowns, cost
            components, grounding ratio, and the V-MOD-1 modality tag.
        correlation_id: Traces this event to the originating HTTP request or
            WebSocket session.
    """

    turn_id: str = field(default="")
    turn_log: VoiceTurnLog = field(default_factory=lambda: __import__("cobeing.voice.types", fromlist=["VoiceTurnLog"]).VoiceTurnLog())
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Interface subsystem events (Phase 1.5 / T501)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VoiceUnavailableEvent(Event):
    """Emitted when the voice subsystem fails or OPENAI_API_KEY is missing.

    Published by the voice pipeline or the factory when the voice subsystem
    cannot be initialised (missing API key, adapter failure) or when it
    experiences a non-recoverable runtime failure. Subscribers (e.g., the
    orchestrator, the web broadcaster) use this to degrade the interface
    mode from FULL to TEXT_WEB and surface the unavailability to connected
    clients.

    Attributes:
        reason: Human-readable description of why the voice subsystem is
            unavailable (e.g., ``"OPENAI_API_KEY not set"``,
            ``"STT adapter failed to initialise"``).
        correlation_id: Traces this event to the startup or request that
            triggered the failure detection.
    """

    reason: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class VoiceAvailableEvent(Event):
    """Emitted when the voice subsystem recovers.

    Published when the voice adapter that previously failed becomes
    operational again (e.g., after a transient API outage clears).
    Subscribers use this to restore the interface mode from TEXT_WEB to FULL
    and re-enable voice controls in connected clients.

    Attributes:
        correlation_id: Traces this event to the recovery probe that
            confirmed voice availability.
    """

    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class WebDegradedEvent(Event):
    """Emitted when the web server crashes or port is unavailable.

    Published by the web server lifecycle manager when the FastAPI/uvicorn
    server fails to start (port conflict, bind error) or experiences a
    runtime crash. Subscribers (e.g., the orchestrator) use this to degrade
    the interface mode from FULL or TEXT_WEB to CLI_ONLY and log the
    degradation for diagnostics.

    Attributes:
        reason: Human-readable description of why the web server is
            unavailable (e.g., ``"port 8000 already in use"``,
            ``"uvicorn worker crashed"``).
        correlation_id: Traces this event to the startup or request that
            triggered the failure detection.
    """

    reason: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class WebAvailableEvent(Event):
    """Emitted when the web server recovers or becomes available.

    Published by the web server lifecycle manager after the FastAPI/uvicorn
    server successfully binds and starts accepting connections. Subscribers
    use this to restore the interface mode from CLI_ONLY to TEXT_WEB (or
    FULL if voice is also available) and re-enable web-facing features.

    Attributes:
        correlation_id: Traces this event to the startup or recovery probe
            that confirmed web server availability.
    """

    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# ESP32 Drive Engine events (Phase 2 / E3)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ESP32ConnectedEvent(Event):
    """Emitted when the ESP32 drive engine becomes reachable.

    Published when the first valid UDP pressure packet is received
    after a disconnection or at startup. Subscribers (e.g., frontend
    via WebSocket) use this to show the ESP32 connection status.

    Attributes:
        firmware_version: Firmware version string from the ESP32.
        host: IP address of the ESP32.
        correlation_id: Traces this event to the connection detection.
    """

    firmware_version: str = field(default="")
    host: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class ESP32DisconnectedEvent(Event):
    """Emitted when the ESP32 drive engine becomes unreachable.

    Published when no valid UDP packet has been received within the
    staleness threshold. Subscribers use this to show degraded status
    and indicate that the executor is running with stale pressure data.

    Attributes:
        last_sequence: The sequence number of the last valid packet.
        reason: Human-readable disconnection reason.
        correlation_id: Traces this event to the disconnect detection.
    """

    last_sequence: int = field(default=0)
    reason: str = field(default="udp_timeout")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class PressureVectorUpdateEvent(Event):
    """Periodic summary of the current pressure vector for UI subscribers.

    Published by the pressure listener at a reduced rate (1Hz) so the
    frontend can display live drive pressures without overwhelming the
    WebSocket. Not emitted on every UDP packet (10Hz would be too frequent).

    Attributes:
        drives: Dict of drive name to pressure value (all 9 drives).
        sequence: ESP32 sequence number.
        is_stale: Whether the pressure data is stale.
        correlation_id: Traces this event.
    """

    drives: dict = field(default_factory=dict)
    sequence: int = field(default=0)
    is_stale: bool = field(default=False)
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Procedural knowledge contradiction events (Phase 1.6 / PKG-2.4)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ContradictionDetectedEvent(Event):
    """Emitted when the contradiction detector finds conflicting COMPUTES_TO edges.

    Published by :class:`~cobeing.layer3_knowledge.contradiction_detector.ContradictionDetector`
    when the same (operation, operand_ids) pair produces two different result
    ValueNodes. This signals that a procedural computation is producing
    inconsistent results, requiring guardian intervention or confidence
    halving on both edges.

    Attributes:
        operation: The operation name (e.g., ``"add"``, ``"multiply"``) that
            produced conflicting results.
        operand_ids: NodeId strings of the operands involved in the computation.
        result_a_node_id: NodeId of the first (existing) result ValueNode.
        result_b_node_id: NodeId of the second (conflicting) result ValueNode.
        result_a_value: Python value of the first result.
        result_b_value: Python value of the second (conflicting) result.
        edge_id_a: EdgeId of the first COMPUTES_TO edge.
        edge_id_b: EdgeId of the second (newly created conflict) COMPUTES_TO edge.
        correlation_id: Traces this event to the execution that detected the
            contradiction.
    """

    operation: str = field(default="")
    operand_ids: list[str] = field(default_factory=list)
    result_a_node_id: str = field(default="")
    result_b_node_id: str = field(default="")
    result_a_value: Any = field(default=None)
    result_b_value: Any = field(default=None)
    edge_id_a: str = field(default="")
    edge_id_b: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Procedural computation events (Phase 1.6 / PKG-3.3)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProceduralComputationCompletedEvent(Event):
    """Emitted after a successful procedural computation.

    Published by :class:`~cobeing.guardian.procedure_handler.ProceduralRequestHandler`
    after a guardian-initiated computation is successfully executed by
    :class:`~cobeing.layer3_knowledge.procedure_executor.ProcedureExecutor`.

    This event signals that a complete PT-9 classify -> validate -> execute
    cycle has completed successfully. Downstream subscribers (e.g., the
    session cost monitor, the conversation logger) use this event to track
    procedural computation activity and costs.

    Attributes:
        operation: The human-readable operation name (e.g., ``"add"``,
            ``"multiply"``).
        operand_values: String representations of the operand values
            (e.g., ``["5", "3"]``).
        result_value: The computed value (Python native type, e.g., ``8``).
        strategy: How the result was obtained: ``"direct_recall"`` if
            retrieved from a cached COMPUTES_TO edge, ``"procedural"`` if
            computed by traversing the procedure AST.
        confidence: The confidence of the result (instance edge confidence
            for direct_recall; initial 0.15 for new procedural results).
        procedure_id: NodeId string of the ProceduralTemplate that was
            executed (e.g., ``"proc:add"``).
        correlation_id: Traces this event to the guardian conversation turn
            that triggered the computation.
    """

    operation: str = field(default="")
    operand_values: list[str] = field(default_factory=list)
    result_value: Any = field(default=None)
    strategy: str = field(default="")
    confidence: float = field(default=0.0)
    procedure_id: str = field(default="")
    correlation_id: str = field(default="")



# ---------------------------------------------------------------------------
# Procedural correction events (Phase 1.6 / PKG-3.4)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProceduralCorrectionEvent(Event):
    """Emitted when a guardian resolves a procedural computation contradiction.

    Published by :class:`~cobeing.guardian.procedure_handler.ProceduralRequestHandler`
    when the guardian picks the correct result from two conflicting COMPUTES_TO
    edges. The wrong edge is deprecated and the correct edge is confirmed.

    This event is distinct from :class:`~cobeing.layer3_knowledge.behavioral_events.CorrectionEvent`
    which handles type-split corrections. Procedural corrections operate on
    COMPUTES_TO edges, not INSTANCE_OF edges.

    Attributes:
        operation: The operation name (e.g., ``"add"``, ``"multiply"``).
        operand_ids: NodeId strings of the operands involved.
        correct_result_value: The value the guardian confirmed as correct.
        wrong_result_value: The value the guardian rejected.
        correct_edge_id: EdgeId of the confirmed COMPUTES_TO edge.
        deprecated_edge_id: EdgeId of the deprecated COMPUTES_TO edge.
        error_source: Fixed string identifying this as a procedural
            computation error (for downstream filtering).
        correlation_id: Traces this event to the conversation turn that
            resolved the contradiction.
    """

    operation: str = field(default="")
    operand_ids: list[str] = field(default_factory=list)
    correct_result_value: Any = field(default=None)
    wrong_result_value: Any = field(default=None)
    correct_edge_id: str = field(default="")
    deprecated_edge_id: str = field(default="")
    error_source: str = field(default="procedural_computation_error")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


# ---------------------------------------------------------------------------
# Semantic knowledge events (Phase 1.8 / P1.8-E2/T003)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SemanticFactAssertedEvent(Event):
    """Emitted after a semantic edge is successfully written by assert_fact pipeline.

    Published by :class:
    after Step 4 (create_edge) completes and a new semantic edge has been written
    to the graph with GUARDIAN provenance.

    This event signals that the knowledge graph has grown by one semantic fact.
    Downstream subscribers (GraphBroadcaster, session cost monitor, conversation
    logger) use this to push real-time graph deltas to the browser UI and track
    semantic teaching activity per session.

    Attributes:
        edge_id: The EdgeId string of the newly created semantic edge.
        source_node_id: NodeId of the subject WordSenseNode.
        target_node_id: NodeId of the object/predicate WordSenseNode.
        edge_type: The semantic edge type (e.g., 'IS_A', 'HAS_PROPERTY').
        subject_lemma: Human-readable lemma for the subject.
        object_lemma: Human-readable lemma for the object.
        scope_context_count: The scope_context_count on the edge after
            assert_fact completes (1 for new edges, higher if an existing
            edge was reinforced in a new context).
        property_type: Sub-classification for HAS_PROPERTY edges
            ('sensory', 'functional', 'categorical'). Empty string for
            all other edge types.
        session_id: The session in which the assertion was made.
        correlation_id: Traces this event to the conversation turn that
            triggered the assertion.
    """

    edge_id: str = field(default="")
    source_node_id: str = field(default="")
    target_node_id: str = field(default="")
    edge_type: str = field(default="")
    subject_lemma: str = field(default="")
    object_lemma: str = field(default="")
    scope_context_count: int = field(default=1)
    property_type: str = field(default="")
    session_id: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))


@dataclass(frozen=True)
class SemanticContradictionEvent(Event):
    """Emitted when a semantic edge conflicts with an existing semantic edge.

    Published by :class:
    when a proposed semantic edge would violate the IS_A asymmetry axiom, the
    CAUSES asymmetry axiom, or create a HAS_PROPERTY / LACKS_PROPERTY direct
    conflict.

    The proposed edge has NOT been written when this event is published. An
    ArbitrationRequest INSTANCE node has been created in the graph, and the
    existing conflicting edge has had its confidence halved and its
    has_conflict property set to True.

    Subscribers (ConversationManager, guardian interface) use this event to
    surface the conflict to the guardian in natural language and present the
    arbitration request for resolution.

    Attributes:
        subject_node_id: NodeId of the subject WordSenseNode in the conflict.
        object_node_id: NodeId of the object/predicate WordSenseNode.
        subject_lemma: Human-readable lemma for the subject.
        object_lemma: Human-readable lemma for the object.
        proposed_edge_type: The semantic edge type that was proposed but blocked.
        existing_edge_id: EdgeId of the existing edge that conflicts with the
            proposed edge. Its confidence has been halved.
        conflict_type: Category label for the conflict. One of:
            'IS_A_cycle', 'CAUSES_cycle', 'HAS_PROPERTY_vs_LACKS_PROPERTY'.
        natural_language_summary: Guardian-facing description of the conflict,
            phrased as a question that the guardian can answer to resolve it.
        session_id: The session in which the contradiction was detected.
        correlation_id: Traces this event to the conversation turn that
            triggered the contradiction.
    """

    subject_node_id: str = field(default="")
    object_node_id: str = field(default="")
    subject_lemma: str = field(default="")
    object_lemma: str = field(default="")
    proposed_edge_type: str = field(default="")
    existing_edge_id: str = field(default="")
    conflict_type: str = field(default="")
    natural_language_summary: str = field(default="")
    session_id: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))




# ---------------------------------------------------------------------------
# Scope context count events (Phase 1.8 / P1.8-E2/T005)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScopeContextCountUpdatedEvent(Event):
    """Emitted when a semantic edge scope_context_count increments in a new context.

    Published by ScopeContextMechanics.increment_scope_count() after a genuine
    context change is detected and scope_context_count on a semantic edge
    has been incremented.

    This event signals a developmental progression: the same semantic fact has
    been independently confirmed in a new conversational context. When
    scope_context_count reaches the categorical threshold (default: 3, stored
    as CATEGORICAL_KNOWLEDGE_THRESHOLD EvolutionRule), the fact transitions
    from situated knowledge to categorical knowledge per Piaget (Carey, 1978).

    Attributes:
        edge_id: The EdgeId string of the semantic edge whose count changed.
        source_node_id: NodeId of the subject WordSenseNode.
        target_node_id: NodeId of the object WordSenseNode.
        edge_type: The semantic edge type (e.g., 'IS_A', 'HAS_PROPERTY').
        subject_lemma: Human-readable lemma for the subject.
        object_lemma: Human-readable lemma for the object.
        old_scope_context_count: The count before this increment.
        new_scope_context_count: The count after this increment.
        categorical_threshold: The threshold at which this fact becomes categorical.
        is_now_categorical: True if new_scope_context_count >= categorical_threshold.
        boundary_type: Kind of context boundary that triggered the increment.
            One of: 'session_change', 'time_gap', 'topic_shift'.
        session_id: The session in which the new context was detected.
        correlation_id: Traces this event to the originating conversation turn.
    """

    edge_id: str = field(default="")
    source_node_id: str = field(default="")
    target_node_id: str = field(default="")
    edge_type: str = field(default="")
    subject_lemma: str = field(default="")
    object_lemma: str = field(default="")
    old_scope_context_count: int = field(default=1)
    new_scope_context_count: int = field(default=2)
    categorical_threshold: int = field(default=3)
    is_now_categorical: bool = field(default=False)
    boundary_type: str = field(default="")
    session_id: str = field(default="")
    correlation_id: CorrelationId = field(default_factory=lambda: CorrelationId(""))

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    # Perception
    "ObservationIngestedEvent",
    # Teaching
    "TeachingNodeCreatedEvent",
    "TeachingNodeUpdatedEvent",
    "TeachingEdgeCreatedEvent",
    # Expectation
    "ExpectationUpdatedEvent",
    # Rule engine
    "RuleFiredEvent",
    # Schema evolution
    "SchemaProposalCreatedEvent",
    "SchemaProposalOutcomeEvent",
    # Guardian
    "GuardianResponseReceivedEvent",
    "CorrectionAppliedEvent",
    # Verification
    "VerificationObservationEvent",
    # Gap lifecycle
    "GapIdentifiedEvent",
    "GapResolvedEvent",
    "GapEscalatedEvent",
    # Circuit breaker
    "CircuitBreakerOpenedEvent",
    "CircuitBreakerClosedEvent",
    # Camera
    "CameraDisconnectedEvent",
    "CameraReconnectedEvent",
    # Session lifecycle
    "SessionStartedEvent",
    "SessionEndedEvent",
    # Capability
    "CapabilityLevelChangedEvent",
    # Conversation (Phase 1.5)
    "ConversationTurnReceivedEvent",
    "ConversationResponseGeneratedEvent",
    "CostThresholdReachedEvent",
    # Attractor monitoring
    "AttractorWarningEvent",
    # Voice pipeline (Phase 1.5 / T206)
    "VoiceInputReceivedEvent",
    "TranscriptionCompleteEvent",
    "SpeechSynthesisCompleteEvent",
    "VoiceTurnCompletedEvent",
    # Interface subsystem (Phase 1.5 / T501)
    "VoiceUnavailableEvent",
    "VoiceAvailableEvent",
    "WebDegradedEvent",
    "WebAvailableEvent",
    # ESP32 Drive Engine (Phase 2 / E3)
    "ESP32ConnectedEvent",
    "ESP32DisconnectedEvent",
    "PressureVectorUpdateEvent",
    # Procedural knowledge contradiction (Phase 1.6 / PKG-2.4)
    "ContradictionDetectedEvent",
    # Procedural computation (Phase 1.6 / PKG-3.3)
    "ProceduralComputationCompletedEvent",
    # Procedural correction (Phase 1.6 / PKG-3.4)
    "ProceduralCorrectionEvent",
    # Semantic knowledge (Phase 1.8 / P1.8-E2/T003)
    "SemanticFactAssertedEvent",
    "SemanticContradictionEvent",
    # Scope context count (Phase 1.8 / P1.8-E2/T005)
    "ScopeContextCountUpdatedEvent",
]

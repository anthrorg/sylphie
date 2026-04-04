"""Core behavioral event types for the Co-Being knowledge graph.

This module defines the foundational data structures produced by Epic 5's
behavioral learning loop: proposal outcomes, correction events, and the
gap state lifecycle enum. These types record what the system has learned
from guardian interaction and track how the schema evolves over time.

Key types:

- :class:`ProposalOutcomeValue` -- how the guardian responded to a schema proposal.
- :class:`RejectionReasonCategory` -- structured reason for a guardian rejection
  (7-value enum per D5-01; raw guardian text is never stored here per CANON A.12).
- :class:`ProposalOutcome` -- immutable record of a single guardian verdict.
- :class:`CorrectionEvent` -- immutable record of a guardian-ordered type split,
  including the pre-correction snapshot of affected instances (D5-10).
- :class:`GapState` -- lifecycle states for curiosity gaps (A.3).
- :class:`VerificationResult` -- immutable record of a single post-correction
  classification check (T051b).
- :class:`GapLifecycleEvent` -- immutable record of a gap state transition (T051b).
- :class:`VerificationCompleteEvent` -- event emitted when a verification window
  closes or a single check completes (T051b).
- :class:`GapLifecycleTransitionEvent` -- lightweight event emitted on every gap
  state transition (T051b).
- :class:`SessionSummary` -- immutable aggregate of all counters and derived
  metrics for a single observation session (T051c).
- :class:`BaselineMetric` -- mean and variance for a single metric within a
  behavioral baseline (T051c).
- :class:`BehavioralBaseline` -- immutable aggregate of per-metric statistics
  computed across multiple sessions (T051c).
- :class:`BehavioralBaselineEstablishedEvent` -- event emitted when a new
  behavioral baseline is computed (T051c).
- :class:`SessionSummaryProducedEvent` -- event emitted when a session summary
  is assembled and persisted (T051c).

Import constraints: this module imports from ``cobeing.shared.types`` and the
standard library only. No imports from ``layer3_knowledge`` or any other
``cobeing`` sub-package. This prevents circular imports across the Epic 5
dependency chain (T051a → T051b/c → T051d).

Usage::

    from cobeing.layer3_knowledge.behavioral_events import (
        ProposalOutcomeValue,
        RejectionReasonCategory,
        ProposalOutcome,
        CorrectionEvent,
        GapState,
    )
    from cobeing.shared.time_utils import utc_now
from cobeing.shared.types import CorrelationId, NodeId

    outcome = ProposalOutcome(
        outcome_id="out-001",
        proposal_id="prop-cup-001",
        outcome=ProposalOutcomeValue.APPROVED,
        proposal_type="type_creation",
        correlation_id=CorrelationId("corr-abc-123"),
    )

    correction = CorrectionEvent(
        correction_id="corr-001",
        original_type_id=NodeId("type-cup"),
        new_type_ids=[NodeId("type-mug"), NodeId("type-tumbler")],
        split_reason="Guardian identified two visually distinct cup subtypes",
        instance_ids_at_split=[NodeId("inst-001"), NodeId("inst-002")],
        correlation_id=CorrelationId("corr-abc-456"),
    )
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from cobeing.shared.time_utils import utc_now
from cobeing.shared.types import CorrelationId, NodeId


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class ProposalOutcomeValue(StrEnum):
    """How the guardian responded to a schema evolution proposal.

    Values are lowercase strings so that serialized records are readable
    without consulting the enum definition. ``StrEnum`` ensures that
    ``str(ProposalOutcomeValue.APPROVED) == "APPROVED"`` and that the
    value is used directly in JSON/Neo4j storage.

    Members:
        APPROVED: Guardian accepted the proposed schema change. The change
            was applied to the graph.
        REJECTED: Guardian declined the proposed schema change. The proposal
            node remains in the graph with a rejection_reason property.
        CORRECTED: Guardian neither accepted nor rejected as-is, but
            provided a correction that produced a type split. A
            :class:`CorrectionEvent` accompanies every CORRECTED outcome.
        EXPIRED: The proposal was in the pending queue too long and was
            dismissed without a guardian verdict. Counted as neutral
            reinforcement (not negative) per Epic 5 design.
    """

    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    CORRECTED = "CORRECTED"
    EXPIRED = "EXPIRED"


class RejectionReasonCategory(StrEnum):
    """Structured reason category for a guardian rejection (D5-01, 7 values).

    These values encode *why* a proposal was rejected without storing raw
    guardian text. Raw guardian language is prohibited from behavioral
    history per CANON A.12 and D5-01 to prevent LLM training contamination.

    The system uses these categories to detect rejection patterns and adjust
    proposal strategy (T058 BehavioralContextProvider).

    Members:
        insufficient_evidence: The pattern has too few supporting instances
            to justify a new schema type.
        single_property_insufficient: A single differing property does not
            constitute a categorically distinct type.
        fits_existing_type: The proposed type is already adequately captured
            by an existing schema type.
        noise_not_category: The pattern is sensor noise or a one-off
            observation, not a genuine category.
        wait_for_more_observations: The guardian wants to defer the decision
            until more instances have accumulated.
        incorrect_naming: The proposed type name is wrong but the underlying
            pattern may be valid. A re-proposal with a corrected name is expected.
        unspecified: The guardian provided no classifiable reason, or the
            reason was ambiguous. Per CANON A.12, the LLM selects this
            value rather than inventing a more specific reason.
    """

    insufficient_evidence = "insufficient_evidence"
    single_property_insufficient = "single_property_insufficient"
    fits_existing_type = "fits_existing_type"
    noise_not_category = "noise_not_category"
    wait_for_more_observations = "wait_for_more_observations"
    incorrect_naming = "incorrect_naming"
    unspecified = "unspecified"


class GapState(StrEnum):
    """Lifecycle states for curiosity gaps (CANON A.3).

    A curiosity gap is an incomplete edge or poorly characterized node that
    the system has identified and potentially submitted as a question to the
    guardian. The state machine governs valid transitions; invalid transitions
    raise ``BehavioralStorageError`` (T057).

    Valid transitions::

        (start) -> DETECTED -> QUEUED -> ANSWERED -> RESOLVED
                             |              |
                        SELF_RESOLVED    EXPIRED
        Any state -> SUPERSEDED (a correction makes the gap moot)

    Members:
        DETECTED: The system has identified the gap in the graph.
        QUEUED: A question about the gap has been formatted and queued
            for the next guardian interaction cycle.
        SELF_RESOLVED: New sensor observations filled the gap without
            guardian intervention.
        ANSWERED: The guardian has provided a response to the question.
        RESOLVED: The gap has been fully resolved and the graph updated
            accordingly.
        EXPIRED: The gap remained unanswered for too long (e.g., guardian
            was absent) and was dismissed.
        SUPERSEDED: A type correction or schema change made this gap moot.
            Can be applied from any state.
    """

    DETECTED = "DETECTED"
    QUEUED = "QUEUED"
    SELF_RESOLVED = "SELF_RESOLVED"
    ANSWERED = "ANSWERED"
    RESOLVED = "RESOLVED"
    EXPIRED = "EXPIRED"
    SUPERSEDED = "SUPERSEDED"


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class ProposalOutcome(BaseModel):
    """Immutable record of a guardian verdict on a schema evolution proposal.

    Created by the outcome recorder (T055) after each guardian response is
    processed. One ``ProposalOutcome`` exists for every proposal that has
    received a verdict (APPROVED, REJECTED, CORRECTED) or has timed out
    (EXPIRED).

    This model is **frozen** (immutable). Outcomes are append-only records;
    they must not be modified after creation.

    The ``rejection_reason_category`` field is only meaningful when
    ``outcome`` is ``REJECTED``. For ``APPROVED``, ``CORRECTED``, and
    ``EXPIRED`` outcomes it is ``None`` and consumers must not read it.

    Attributes:
        outcome_id: Unique identifier for this outcome record.
        proposal_id: The ``node_id`` of the ``SchemaProposal`` node that
            received this verdict.
        outcome: The guardian's verdict (:class:`ProposalOutcomeValue`).
        rejection_reason_category: Structured reason for rejection. Only
            populated when ``outcome`` is ``REJECTED``. Defaults to ``None``
            for all other outcome values. Never contains raw guardian text
            (CANON A.12).
        proposal_type: Human-readable type label of the proposal, e.g.
            ``"type_creation"`` or ``"type_split"``. Used by
            ``BehavioralContextProvider`` for pattern grouping (T058).
        correlation_id: Traces this outcome to the originating observation
            session via structured logging.
        timestamp: UTC timestamp when the outcome was recorded. Defaults to
            ``datetime.now(UTC)`` at construction time.

    Example::

        approved = ProposalOutcome(
            outcome_id="out-001",
            proposal_id="prop-cup-001",
            outcome=ProposalOutcomeValue.APPROVED,
            proposal_type="type_creation",
            correlation_id=CorrelationId("corr-abc-123"),
        )
        assert approved.rejection_reason_category is None

        rejected = ProposalOutcome(
            outcome_id="out-002",
            proposal_id="prop-tumbler-001",
            outcome=ProposalOutcomeValue.REJECTED,
            rejection_reason_category=RejectionReasonCategory.insufficient_evidence,
            proposal_type="type_creation",
            correlation_id=CorrelationId("corr-abc-456"),
        )
        assert rejected.rejection_reason_category == RejectionReasonCategory.insufficient_evidence
    """

    model_config = ConfigDict(frozen=True)

    outcome_id: str
    proposal_id: str
    outcome: ProposalOutcomeValue
    rejection_reason_category: RejectionReasonCategory | None = None
    proposal_type: str
    correlation_id: CorrelationId
    timestamp: datetime = Field(default_factory=utc_now)


class CorrectionEvent(BaseModel):
    """Immutable record of a guardian-ordered type split (correction).

    Created by the outcome recorder (T055) when the guardian issues a
    correction that splits one schema type into two or more distinct types.
    The ``CORRECTED`` :class:`ProposalOutcome` for the original proposal
    always accompanies a ``CorrectionEvent``.

    **Pre-correction snapshot (D5-10).** The ``instance_ids_at_split``
    field captures the ``NodeId`` of every instance that was typed as
    ``original_type_id`` *before* the split is applied. This snapshot is
    recorded by the outcome recorder *before* the graph is mutated (T055:
    "Correction handler records instance_ids_at_split BEFORE split"). It
    enables the :class:`VerificationTracker` (T056a) to exclude pre-split
    instances from post-correction classification verification, ensuring
    that only new observations are used to verify whether the split is
    holding.

    This model is **frozen** (immutable). Corrections are append-only records.

    Attributes:
        correction_id: Unique identifier for this correction record. Also
            used as the verification window key in ``VerificationTracker``.
        original_type_id: The schema type node that was split. Must be a
            valid ``NodeId`` at SCHEMA level.
        new_type_ids: The two (or more) new schema type nodes produced by
            the split. Validated ``min_length=2``: a split that produces
            fewer than two types is not a split.
        split_reason: Human-readable description of why the split was made.
            Derived from structured graph data, not verbatim guardian
            language (CANON A.12).
        instance_ids_at_split: Pre-correction snapshot of all instance
            nodes that were typed as ``original_type_id`` at the moment
            the correction was processed (D5-10). These instances are
            excluded from post-correction verification observations.
        correlation_id: Traces this correction to the originating guardian
            interaction session.
        timestamp: UTC timestamp when the correction was recorded.
        verification_window_size: Number of post-correction observations
            required for the :class:`VerificationTracker` to render a
            verdict (D5-05). Default is 10.

    Example::

        correction = CorrectionEvent(
            correction_id="corr-split-001",
            original_type_id=NodeId("type-cup"),
            new_type_ids=[NodeId("type-mug"), NodeId("type-tumbler")],
            split_reason="Two visually distinct subtypes: handled vs. non-handled",
            instance_ids_at_split=[NodeId("inst-001"), NodeId("inst-002"), NodeId("inst-003")],
            correlation_id=CorrelationId("corr-abc-789"),
        )
        assert len(correction.new_type_ids) >= 2
        assert len(correction.instance_ids_at_split) == 3  # pre-split snapshot
    """

    model_config = ConfigDict(frozen=True)

    correction_id: str
    original_type_id: NodeId
    new_type_ids: list[NodeId] = Field(min_length=2)
    split_reason: str
    instance_ids_at_split: list[NodeId]
    correlation_id: CorrelationId
    timestamp: datetime = Field(default_factory=utc_now)
    verification_window_size: int = 10


class VerificationResult(BaseModel):
    """Immutable record of a single post-correction classification check.

    Created by the VerificationTracker (T056a) each time a new observation
    is classified against the types produced by a guardian correction. Each
    instance that arrives after a split is checked: was it classified into
    one of the new types (``correct=True``) or not (``correct=False``)?

    This record is the raw material from which :class:`VerificationCompleteEvent`
    computes the aggregate accuracy when the verification window closes.

    This model is **frozen** (immutable). Verification results are
    append-only records.

    Attributes:
        verification_id: Unique identifier for this individual check record.
        correction_id: The ``CorrectionEvent.correction_id`` this result
            belongs to. Links this check to its parent correction.
        observation_id: The ``NodeId`` of the instance node that was
            classified in this check.
        classified_type_id: The schema type the system assigned to the
            observation during this check.
        expected_type_id: The schema type the system predicted (e.g., the
            most probable of the new split types) before classification.
        correct: ``True`` if ``classified_type_id`` is one of the new types
            produced by the split; ``False`` otherwise.
        confidence_of_classification: The classifier's confidence score for
            ``classified_type_id``. Validated ``ge=0.0, le=1.0``.
        correlation_id: Traces this check to the originating observation
            session.
        timestamp: UTC timestamp when this check was recorded.

    Example::

        result = VerificationResult(
            verification_id="vr-001",
            correction_id="corr-split-001",
            observation_id=NodeId("inst-new-042"),
            classified_type_id=NodeId("type-mug"),
            expected_type_id=NodeId("type-mug"),
            correct=True,
            confidence_of_classification=0.91,
            correlation_id=CorrelationId("corr-session-007"),
        )
        assert result.correct is True
        assert 0.0 <= result.confidence_of_classification <= 1.0
    """

    model_config = ConfigDict(frozen=True)

    verification_id: str
    correction_id: str
    observation_id: NodeId
    classified_type_id: NodeId
    expected_type_id: NodeId
    correct: bool
    confidence_of_classification: float = Field(ge=0.0, le=1.0)
    correlation_id: CorrelationId
    timestamp: datetime = Field(default_factory=utc_now)


class GapLifecycleEvent(BaseModel):
    """Immutable record of a single curiosity gap state transition.

    Created by the gap manager (T057) each time a gap moves through the
    :class:`GapState` state machine. The full history of a gap's lifecycle
    can be reconstructed by sorting its ``GapLifecycleEvent`` records by
    ``timestamp``.

    This model is **frozen** (immutable). Lifecycle events are append-only
    records.

    Attributes:
        event_id: Unique identifier for this lifecycle event record.
        gap_id: The identifier of the curiosity gap node whose state changed.
        old_state: The :class:`GapState` the gap was in before this transition.
        new_state: The :class:`GapState` the gap is in after this transition.
        timestamp: UTC timestamp when the transition was recorded.
        resolution_data: Arbitrary key-value context about *why* or *how* the
            transition occurred (e.g., the guardian answer text digest, the
            sensor reading that triggered self-resolution). Defaults to an
            empty dict. Keys and values are application-defined; this field
            is not schema-validated beyond being a ``dict[str, Any]``.
        correlation_id: Traces this lifecycle event to the session or
            operation that triggered the state transition.

    Example::

        event = GapLifecycleEvent(
            event_id="gle-001",
            gap_id="gap-color-of-cup",
            old_state=GapState.QUEUED,
            new_state=GapState.ANSWERED,
            resolution_data={"answer_source": "guardian_session_42"},
            correlation_id=CorrelationId("corr-guardian-042"),
        )
        assert event.old_state == GapState.QUEUED
        assert event.new_state == GapState.ANSWERED
    """

    model_config = ConfigDict(frozen=True)

    event_id: str
    gap_id: str
    old_state: GapState
    new_state: GapState
    timestamp: datetime = Field(default_factory=utc_now)
    resolution_data: dict[str, Any] = Field(default_factory=dict)
    correlation_id: CorrelationId


class VerificationCompleteEvent(BaseModel):
    """Event emitted when a verification window closes or a check completes.

    Emitted by the VerificationTracker (T056a) in two situations:

    1. **Single check completion** — a single :class:`VerificationResult` has
       been recorded and the tracker wants to broadcast the intermediate
       state to subscribers.
    2. **Window closure** — the full verification window (defined by
       ``CorrectionEvent.verification_window_size``) has been exhausted and
       the tracker renders a final verdict.

    The ``outcome`` field signals which situation applies:

    - ``"VERIFIED"`` -- the window closed and accuracy was above threshold.
    - ``"FAILED"`` -- the window closed and accuracy was at or below threshold.
    - ``"TIMEOUT"`` -- the window expired before enough observations arrived
      (guardian went inactive, not enough new objects appeared in frame).

    This model is **frozen** (immutable). Events are emitted and consumed;
    they are never mutated.

    Attributes:
        verification_id: Unique identifier for this event. For window-closure
            events this is the same as the ``correction_id`` being finalized.
            For single-check events it matches the triggering
            :class:`VerificationResult`.
        correction_id: The ``CorrectionEvent.correction_id`` whose window
            this event reports on.
        outcome: One of ``"VERIFIED"``, ``"FAILED"``, or ``"TIMEOUT"``.
            No other values are valid.
        accuracy: The fraction of post-correction observations classified
            correctly into the new split types. Range ``[0.0, 1.0]``.
            For ``"TIMEOUT"`` events this reflects partial accuracy over
            the observations that *did* arrive.
        observations_checked: The number of post-correction observations
            that contributed to this accuracy calculation. Must be ``>= 0``.
        correlation_id: Traces this event to the session or operation that
            triggered the final check or window closure.
        timestamp: UTC timestamp when this event was emitted.

    Example::

        event = VerificationCompleteEvent(
            verification_id="corr-split-001",
            correction_id="corr-split-001",
            outcome="VERIFIED",
            accuracy=0.9,
            observations_checked=10,
            correlation_id=CorrelationId("corr-session-final"),
        )
        assert event.outcome == "VERIFIED"
        assert event.accuracy == 0.9
        assert event.observations_checked == 10
    """

    model_config = ConfigDict(frozen=True)

    verification_id: str
    correction_id: str
    outcome: str
    accuracy: float = Field(ge=0.0, le=1.0)
    observations_checked: int = Field(ge=0)
    correlation_id: CorrelationId
    timestamp: datetime = Field(default_factory=utc_now)


class GapLifecycleTransitionEvent(BaseModel):
    """Lightweight event emitted on every gap state transition.

    Emitted by the gap manager (T057) immediately after a gap transitions
    between :class:`GapState` values. Unlike :class:`GapLifecycleEvent`,
    which is a durable storage record with arbitrary ``resolution_data``,
    this event is the lightweight signal that subscribers (e.g., the
    session accumulator in T059) receive to react to gap transitions in
    real time.

    This model is **frozen** (immutable). Events are emitted and consumed;
    they are never mutated.

    Attributes:
        gap_id: The identifier of the curiosity gap node that transitioned.
        old_state: The :class:`GapState` before this transition.
        new_state: The :class:`GapState` after this transition.
        correlation_id: Traces this event to the operation that triggered
            the state transition.
        timestamp: UTC timestamp when this event was emitted.

    Example::

        event = GapLifecycleTransitionEvent(
            gap_id="gap-color-of-cup",
            old_state=GapState.DETECTED,
            new_state=GapState.QUEUED,
            correlation_id=CorrelationId("corr-gap-queue-001"),
        )
        assert event.old_state == GapState.DETECTED
        assert event.new_state == GapState.QUEUED
    """

    model_config = ConfigDict(frozen=True)

    gap_id: str
    old_state: GapState
    new_state: GapState
    correlation_id: CorrelationId
    timestamp: datetime = Field(default_factory=utc_now)


# ---------------------------------------------------------------------------
# Session summary and baseline types (Epic 5, T051c)
# ---------------------------------------------------------------------------


class SessionSummary(BaseModel):
    """Immutable aggregate of all counters and derived metrics for one session.

    Produced by the session accumulator (T059) at ``SessionEnded`` by reading
    all :class:`cobeing.layer4_reasoning.session.SessionAccumulator` counters
    and computing the derived ratio fields. Persisted to storage by Sentinel;
    consumed by the baseline computer (T060) and the behavioral context
    provider (T058).

    This model is **frozen** (immutable). Once a session ends its summary is
    a permanent, append-only historical record (CANON A.10).

    **Derived fields** (approval_ratio, prediction_accuracy, etc.) are
    computed by the caller before construction — this model stores the
    pre-computed values and enforces the ``[0.0, 1.0]`` range invariant.
    ``verification_accuracy`` is ``None`` when no verification events
    occurred during the session.

    Attributes:
        session_id: Unique identifier for the session this summary describes.
        session_number: Monotonically increasing session counter (ge=1).
        observations_ingested: Raw sensor observations processed.
        new_objects_discovered: Instance nodes created for the first time.
        types_active: Number of schema types with at least one active
            instance at session end.
        proposals_generated: Schema evolution proposals submitted to the
            guardian queue.
        proposals_approved: Proposals accepted by the guardian.
        proposals_rejected: Proposals declined by the guardian.
        proposals_corrected: Proposals that triggered a type split.
        corrections_applied: Type splits applied to the graph.
        questions_asked: Curiosity gap questions queued for the guardian.
        gaps_identified: New curiosity gaps detected in the graph.
        gaps_resolved: Gaps that reached RESOLVED or ANSWERED state.
        gaps_self_resolved: Gaps that reached SELF_RESOLVED state without
            guardian input.
        predictions_correct: Expectation predictions confirmed by observation.
        prediction_errors: Expectation predictions contradicted by observation.
        autonomous_demotions: Schema types autonomously demoted using
            INFERENCE provenance (R-4).
        verifications_passed: Post-correction verification windows that
            closed with VERIFIED outcome.
        verifications_failed: Post-correction verification windows that
            closed with FAILED or TIMEOUT outcome.
        approval_ratio: proposals_approved / proposals_generated, or 0.0
            if proposals_generated == 0. Range [0.0, 1.0].
        prediction_accuracy: predictions_correct / (predictions_correct +
            prediction_errors), or 0.0 if no predictions were made.
            Range [0.0, 1.0].
        verification_accuracy: verifications_passed / (verifications_passed +
            verifications_failed), or None if no verification windows closed
            this session. Range [0.0, 1.0] when not None.
        self_resolution_rate: gaps_self_resolved / gaps_identified, or 0.0
            if gaps_identified == 0. Range [0.0, 1.0].
        demotion_rate: autonomous_demotions / types_active, or 0.0 if
            types_active == 0. Range [0.0, 1.0].
        attractor_warnings: List of attractor warning codes emitted during
            this session (e.g., ``["SYCOPHANCY_DETECTED"]``). Empty list
            when no warnings were emitted.
        session_start: UTC timestamp when the session began.
        session_end: UTC timestamp when the session ended.
        cost_usd: Total Anthropic API cost for this session in US dollars.

    Example::

        from datetime import UTC, datetime

        summary = SessionSummary(
            session_id="sess-001",
            session_number=1,
            observations_ingested=42,
            new_objects_discovered=3,
            types_active=7,
            proposals_generated=4,
            proposals_approved=3,
            proposals_rejected=1,
            approval_ratio=0.75,
            prediction_accuracy=0.9,
            session_start=datetime(2026, 1, 1, 10, 0, tzinfo=UTC),
            session_end=datetime(2026, 1, 1, 11, 0, tzinfo=UTC),
        )
        assert summary.approval_ratio == 0.75
        assert summary.verification_accuracy is None  # no verifications this session
    """

    model_config = ConfigDict(frozen=True)

    session_id: str
    session_number: int = Field(ge=1)
    observations_ingested: int = Field(ge=0, default=0)
    new_objects_discovered: int = Field(ge=0, default=0)
    types_active: int = Field(ge=0, default=0)
    proposals_generated: int = Field(ge=0, default=0)
    proposals_approved: int = Field(ge=0, default=0)
    proposals_rejected: int = Field(ge=0, default=0)
    proposals_corrected: int = Field(ge=0, default=0)
    corrections_applied: int = Field(ge=0, default=0)
    questions_asked: int = Field(ge=0, default=0)
    gaps_identified: int = Field(ge=0, default=0)
    gaps_resolved: int = Field(ge=0, default=0)
    gaps_self_resolved: int = Field(ge=0, default=0)
    predictions_correct: int = Field(ge=0, default=0)
    prediction_errors: int = Field(ge=0, default=0)
    autonomous_demotions: int = Field(ge=0, default=0)
    verifications_passed: int = Field(ge=0, default=0)
    verifications_failed: int = Field(ge=0, default=0)
    approval_ratio: float = Field(ge=0.0, le=1.0, default=0.0)
    prediction_accuracy: float = Field(ge=0.0, le=1.0, default=0.0)
    verification_accuracy: float | None = Field(ge=0.0, le=1.0, default=None)
    self_resolution_rate: float = Field(ge=0.0, le=1.0, default=0.0)
    demotion_rate: float = Field(ge=0.0, le=1.0, default=0.0)
    attractor_warnings: list[str] = Field(default_factory=list)
    session_start: datetime
    session_end: datetime
    cost_usd: float = Field(ge=0.0, default=0.0)


class BaselineMetric(BaseModel):
    """Mean and variance for a single behavioral metric across a baseline window.

    Used as a component of :class:`BehavioralBaseline`. Each metric in the
    baseline stores the population mean and variance computed from the
    ``session_ids`` that contributed to that baseline.

    This model is **frozen** (immutable). Baseline metrics are computed once
    and stored as immutable records.

    Attributes:
        mean: Arithmetic mean of the metric across all baseline sessions.
        variance: Population variance of the metric across all baseline
            sessions. Validated ``ge=0.0`` — variance is never negative.

    Example::

        metric = BaselineMetric(mean=0.75, variance=0.02)
        assert metric.mean == 0.75
        assert metric.variance >= 0.0
    """

    model_config = ConfigDict(frozen=True)

    mean: float
    variance: float = Field(ge=0.0)


class BehavioralBaseline(BaseModel):
    """Immutable aggregate of per-metric behavioral statistics across sessions.

    Computed by the baseline computer (T060) after enough sessions have
    accumulated. A ``BehavioralBaseline`` captures what "normal" behavior
    looks like for this system so that the anomaly detector (T061) can
    identify significant deviations.

    The nine metric fields each contain a :class:`BaselineMetric` with the
    mean and variance of that metric across the ``session_ids`` window.

    This model is **frozen** (immutable). Baselines are append-only historical
    records (CANON A.10). When a new baseline is computed it creates a new
    record; it does not mutate the old one.

    Attributes:
        baseline_id: Unique identifier for this baseline record.
        session_ids: The session IDs used to compute this baseline.
            Validated ``min_length=1``: a baseline over zero sessions
            is undefined.
        computed_at: UTC timestamp when this baseline was computed.
        proposal_rate: Mean and variance of proposals_generated per session.
        approval_ratio: Mean and variance of the approval_ratio metric.
        prediction_accuracy: Mean and variance of the prediction_accuracy metric.
        verification_accuracy: Mean and variance of the verification_accuracy
            metric (sessions with None verification_accuracy contribute 0.0).
        self_resolution_rate: Mean and variance of the self_resolution_rate metric.
        demotion_rate: Mean and variance of the demotion_rate metric.
        question_rate: Mean and variance of questions_asked per session.
        novel_proposal_rate: Mean and variance of the fraction of proposals
            that created genuinely new schema types.
        gap_resolution_rate: Mean and variance of gaps_resolved / gaps_identified.

    Example::

        baseline = BehavioralBaseline(
            baseline_id="baseline-001",
            session_ids=["sess-001", "sess-002", "sess-003"],
            computed_at=datetime(2026, 1, 4, 12, 0, tzinfo=UTC),
            proposal_rate=BaselineMetric(mean=3.5, variance=0.25),
            approval_ratio=BaselineMetric(mean=0.78, variance=0.03),
            prediction_accuracy=BaselineMetric(mean=0.82, variance=0.04),
            verification_accuracy=BaselineMetric(mean=0.90, variance=0.02),
            self_resolution_rate=BaselineMetric(mean=0.40, variance=0.05),
            demotion_rate=BaselineMetric(mean=0.05, variance=0.01),
            question_rate=BaselineMetric(mean=2.0, variance=0.5),
            novel_proposal_rate=BaselineMetric(mean=0.60, variance=0.08),
            gap_resolution_rate=BaselineMetric(mean=0.70, variance=0.06),
        )
        assert len(baseline.session_ids) >= 1
    """

    model_config = ConfigDict(frozen=True)

    baseline_id: str
    session_ids: list[str] = Field(min_length=1)
    computed_at: datetime
    proposal_rate: BaselineMetric
    approval_ratio: BaselineMetric
    prediction_accuracy: BaselineMetric
    verification_accuracy: BaselineMetric
    self_resolution_rate: BaselineMetric
    demotion_rate: BaselineMetric
    question_rate: BaselineMetric
    novel_proposal_rate: BaselineMetric
    gap_resolution_rate: BaselineMetric


class BehavioralBaselineEstablishedEvent(BaseModel):
    """Event emitted when a new behavioral baseline has been computed.

    Emitted by the baseline computer (T060) immediately after a
    :class:`BehavioralBaseline` is persisted. Subscribers (e.g., the anomaly
    detector T061, the session summary producer T059) use this event to
    refresh their reference baseline.

    This model is **frozen** (immutable). Events are emitted and consumed;
    they are never mutated.

    Attributes:
        baseline_id: The ``BehavioralBaseline.baseline_id`` that was just
            established. Can be used to load the full baseline from storage.
        session_count: The number of sessions that contributed to this
            baseline. Validated ``ge=1``.
        correlation_id: Traces this event to the session or operation that
            triggered baseline computation.
        timestamp: UTC timestamp when this event was emitted.

    Example::

        event = BehavioralBaselineEstablishedEvent(
            baseline_id="baseline-001",
            session_count=10,
            correlation_id=CorrelationId("corr-baseline-compute-001"),
        )
        assert event.session_count >= 1
    """

    model_config = ConfigDict(frozen=True)

    baseline_id: str
    session_count: int = Field(ge=1)
    correlation_id: CorrelationId
    timestamp: datetime = Field(default_factory=utc_now)


class SessionSummaryProducedEvent(BaseModel):
    """Event emitted when a session summary has been assembled and persisted.

    Emitted by the session summary producer (T059) immediately after a
    :class:`SessionSummary` is written to storage. Subscribers use this event
    to trigger downstream processing — e.g., the baseline computer (T060)
    checks whether enough summaries have accumulated to compute a new baseline.

    This model is **frozen** (immutable). Events are emitted and consumed;
    they are never mutated.

    Attributes:
        session_id: The ``SessionSummary.session_id`` that was just produced.
            Can be used to load the full summary from storage.
        session_number: The ``SessionSummary.session_number`` for ordering
            and deduplication. Validated ``ge=1``.
        correlation_id: Traces this event to the session that just ended.
        timestamp: UTC timestamp when this event was emitted.

    Example::

        event = SessionSummaryProducedEvent(
            session_id="sess-001",
            session_number=1,
            correlation_id=CorrelationId("corr-session-001"),
        )
        assert event.session_number >= 1
    """

    model_config = ConfigDict(frozen=True)

    session_id: str
    session_number: int = Field(ge=1)
    correlation_id: CorrelationId
    timestamp: datetime = Field(default_factory=utc_now)


__all__ = [
    "BaselineMetric",
    "BehavioralBaseline",
    "BehavioralBaselineEstablishedEvent",
    "CorrectionEvent",
    "GapLifecycleEvent",
    "GapLifecycleTransitionEvent",
    "GapState",
    "ProposalOutcome",
    "ProposalOutcomeValue",
    "RejectionReasonCategory",
    "SessionSummary",
    "SessionSummaryProducedEvent",
    "VerificationCompleteEvent",
    "VerificationResult",
]

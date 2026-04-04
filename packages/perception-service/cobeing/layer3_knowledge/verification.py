"""Post-correction classification verification tracker (Epic 5, T056a).

After a guardian correction splits a schema type into two or more subtypes,
the system must verify that the split is *working* -- that new observations
(those that arrive after the split, not the instances that existed at split
time) are classified into the correct subtype.

This module provides:

- :class:`VerificationWindowClosed` -- event emitted when a window finishes.
- :func:`_cosine_similarity` -- vector cosine similarity, used for centroid
  nearest-neighbour classification.
- :class:`VerificationTracker` -- the core tracker that opens windows, checks
  observations, and emits :class:`VerificationWindowClosed` events.

**Window lifecycle:**

1. The outcome recorder (T055) calls ``open_window(correction)`` immediately
   after a guardian correction is applied.  The window accepts post-split
   observations until either the ``verification_window_size`` threshold is
   reached or 5 sessions have elapsed (timeout).
2. For every new observation, ``check_observation(...)`` is called.  It loops
   over all open windows, decides whether the observation is relevant (its
   label matches one of the new types), determines which new type is the
   *expected* type via nearest centroid, and records a
   :class:`VerificationResult`.
3. When the window accumulates ``verification_window_size`` results OR the
   session timeout fires, the tracker emits a
   :class:`VerificationWindowClosed` event and closes the window.

**Outcome thresholds (CANON A.8.4 / D5-05):**

- ``"VERIFIED"`` -- accuracy >= 0.8 AND both subtypes exercised (>= 2 results
  each).
- ``"FAILED"`` -- accuracy < 0.8, or fewer than 2 results per subtype.
- ``"TIMEOUT"`` -- 5 sessions elapsed before the window filled.

**Canon C3 exclusion:** Instances that existed at split time
(``CorrectionEvent.instance_ids_at_split``) are excluded from verification
so that the split's *existing* examples cannot inflate the accuracy.

**D-TS-15 INSUFFICIENT_DATA fallback:** When a type has fewer than 3 instance
embeddings, the centroid cannot be reliably computed and that type is skipped
for nearest-centroid selection.

**Confidence gate:** An observation with ``confidence < 0.75`` is treated as an
AMBIGUOUS classification and counts as incorrect.

Import constraints: this module imports from ``cobeing.shared`` and
``cobeing.layer3_knowledge``.  It does not import from any other layer.

Usage::

    from cobeing.shared.event_bus import EventBus
    from cobeing.layer3_knowledge.in_memory_persistence import InMemoryGraphPersistence
    from cobeing.layer3_knowledge.verification import VerificationTracker
    from cobeing.layer3_knowledge.behavioral_events import CorrectionEvent
    from cobeing.shared.types import CorrelationId, NodeId

    persistence = InMemoryGraphPersistence()
    behavioral = InMemoryGraphPersistence()
    bus = EventBus()

    tracker = VerificationTracker(
        persistence=persistence,
        behavioral_store=behavioral,
        event_bus=bus,
    )

    await tracker.open_window(correction)
    results = await tracker.check_observation(
        observation_id="obs-001",
        instance_node_id=NodeId("inst-new-042"),
        embedding=[0.1, 0.2, 0.3],
        classified_type_id=NodeId("type-mug"),
        confidence=0.91,
        label_raw="mug",
        correlation_id=CorrelationId("corr-session-007"),
    )
"""

from __future__ import annotations

import logging
import math
import uuid
from dataclasses import dataclass, field

from cobeing.layer3_knowledge.behavioral_events import (
    CorrectionEvent,
    VerificationResult,
)
from cobeing.layer3_knowledge.node_types import SchemaLevel
from cobeing.layer3_knowledge.protocols import BehavioralStore, GraphPersistence
from cobeing.layer3_knowledge.query_types import NodeFilter
from cobeing.shared.event_bus import Event, EventBus
from cobeing.shared.types import CorrelationId, NodeId

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Domain event
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VerificationWindowClosed(Event):
    """Event emitted when a verification window closes.

    Emitted by :class:`VerificationTracker` when:

    - The window has accumulated ``verification_window_size`` results and a
      verdict (``"VERIFIED"`` or ``"FAILED"``) has been rendered, OR
    - Five sessions have elapsed without filling the window (``"TIMEOUT"``).

    Subscribers (e.g., the session accumulator T059) use this event to count
    ``verifications_passed`` / ``verifications_failed`` in the session summary.

    Attributes:
        correction_id: The ``CorrectionEvent.correction_id`` whose window
            this event finalises.
        outcome: One of ``"VERIFIED"``, ``"FAILED"``, or ``"TIMEOUT"``.
        accuracy: Fraction of observations classified correctly. Range
            ``[0.0, 1.0]``.  For ``"TIMEOUT"`` events this reflects partial
            accuracy over the observations that *did* arrive.
        observations_checked: Number of post-correction observations that
            contributed to the accuracy calculation.
        correlation_id: Traces this event to the session or operation that
            triggered the closure.
    """

    correction_id: str = ""
    outcome: str = ""  # "VERIFIED", "FAILED", "TIMEOUT"
    accuracy: float = 0.0
    observations_checked: int = 0
    correlation_id: CorrelationId = field(
        default_factory=lambda: CorrelationId("")
    )


# ---------------------------------------------------------------------------
# Helper: cosine similarity
# ---------------------------------------------------------------------------


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two equal-length vectors.

    Returns the cosine of the angle between the two vectors: 1.0 for
    identical direction, 0.0 for orthogonal, -1.0 for opposite.  Returns
    0.0 if either vector has zero magnitude (avoids division by zero).

    Args:
        a: First vector.
        b: Second vector.  Must have the same length as ``a``.

    Returns:
        Cosine similarity in the range ``[-1.0, 1.0]``.
    """
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = math.sqrt(sum(x * x for x in a))
    mag_b = math.sqrt(sum(x * x for x in b))
    if mag_a == 0.0 or mag_b == 0.0:
        return 0.0
    return dot / (mag_a * mag_b)


# ---------------------------------------------------------------------------
# Internal helper: build VerificationWindowClosed event
# ---------------------------------------------------------------------------


def _make_closure_event(
    correction_id: str,
    outcome: str,
    accuracy: float,
    observations_checked: int,
    correlation_id: CorrelationId,
) -> VerificationWindowClosed:
    """Construct a :class:`VerificationWindowClosed` event.

    Args:
        correction_id: The correction whose window just closed.
        outcome: ``"VERIFIED"``, ``"FAILED"``, or ``"TIMEOUT"``.
        accuracy: Fraction of observations classified correctly.
        observations_checked: Number of results that contributed.
        correlation_id: Tracing ID for the triggering session.

    Returns:
        A frozen :class:`VerificationWindowClosed` dataclass ready for
        publishing to the event bus.
    """
    return VerificationWindowClosed(
        correction_id=correction_id,
        outcome=outcome,
        accuracy=accuracy,
        observations_checked=observations_checked,
        correlation_id=correlation_id,
    )


# ---------------------------------------------------------------------------
# VerificationTracker
# ---------------------------------------------------------------------------


class VerificationTracker:
    """Post-correction classification verification (Milestone 4 behavioral proof).

    After a guardian correction splits a type, this tracker monitors new
    observations to verify that the split is holding.  One *verification
    window* is maintained per open correction.

    **Responsibilities:**

    - Open a verification window per correction (idempotent).
    - For each new observation: decide relevance, determine expected type via
      nearest centroid, compare against the classified type, persist a
      :class:`VerificationResult`, and check whether the window should close.
    - Track session count per window and issue a ``"TIMEOUT"`` verdict after 5
      sessions without filling the window.
    - Emit a :class:`VerificationWindowClosed` event on every window closure
      so downstream subscribers can update session summaries.

    **Thread safety:** This class is not thread-safe.  It is designed for use
    within a single-threaded asyncio event loop.

    Args:
        persistence: Graph storage backend.  Used to look up type node labels
            and instance embeddings for centroid computation.
        behavioral_store: Behavioral data storage.  Used to persist
            :class:`VerificationResult` records and retrieve the aggregate
            results for a correction.
        event_bus: The application event bus.  Used to publish
            :class:`VerificationWindowClosed` events.

    Example::

        tracker = VerificationTracker(
            persistence=InMemoryGraphPersistence(),
            behavioral_store=InMemoryGraphPersistence(),
            event_bus=EventBus(),
        )
        await tracker.open_window(correction)
        results = await tracker.check_observation(
            observation_id="obs-001",
            instance_node_id=NodeId("inst-new-042"),
            embedding=[0.1, 0.2, 0.3],
            classified_type_id=NodeId("type-mug"),
            confidence=0.91,
            label_raw="mug",
            correlation_id=CorrelationId("corr-session-007"),
        )
    """

    # The minimum confidence required for a classification to be considered
    # unambiguous.  Below this threshold the observation is treated as
    # AMBIGUOUS and counted as incorrect regardless of the type assignment.
    _CONFIDENCE_THRESHOLD: float = 0.75

    # Number of sessions without window closure before a TIMEOUT is issued.
    _SESSION_TIMEOUT: int = 5

    def __init__(
        self,
        persistence: GraphPersistence,
        behavioral_store: BehavioralStore,
        event_bus: EventBus,
    ) -> None:
        self._persistence = persistence
        self._behavioral_store = behavioral_store
        self._event_bus = event_bus
        # correction_id -> CorrectionEvent for all currently open windows.
        self._open_windows: dict[str, CorrectionEvent] = {}
        # correction_id -> number of sessions seen while the window is open.
        self._session_count: dict[str, int] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def open_window(self, correction: CorrectionEvent) -> None:
        """Open a verification window for a correction.

        Idempotent: calling ``open_window`` for a correction that already has
        an open window is a silent no-op.  This prevents accidental double-
        counting when the same correction is submitted twice (e.g., on restart
        with an in-progress window already loaded from storage).

        Args:
            correction: The correction event that triggered the split.  The
                ``correction_id`` is used as the window key.
        """
        if correction.correction_id in self._open_windows:
            logger.debug(
                "verification_window_already_open correction_id=%s",
                correction.correction_id,
            )
            return

        self._open_windows[correction.correction_id] = correction
        self._session_count[correction.correction_id] = 0
        logger.info(
            "verification_window_opened correction_id=%s window_size=%d",
            correction.correction_id,
            correction.verification_window_size,
        )

    async def check_observation(
        self,
        observation_id: str,
        instance_node_id: NodeId,
        embedding: list[float],
        classified_type_id: NodeId | None,
        confidence: float,
        label_raw: str,
        correlation_id: CorrelationId,
    ) -> list[VerificationResult]:
        """Check a new observation against all open verification windows.

        For each open verification window, this method:

        1. Skips the observation if the instance was in
           ``instance_ids_at_split`` (Canon C3 exclusion).
        2. Checks whether the observation's ``label_raw`` matches any type
           in the split (relevance gate).
        3. Determines the expected type via nearest centroid
           (INSUFFICIENT_DATA → skip per D-TS-15).
        4. Compares the expected type against ``classified_type_id``.
           ``confidence < 0.75`` or ``classified_type_id is None`` counts
           as incorrect (AMBIGUOUS).
        5. Persists a :class:`VerificationResult`.
        6. Checks whether the window has reached ``verification_window_size``
           and, if so, emits a closure event.

        Args:
            observation_id: Identifier for this observation (used as the
                ``observation_id`` on the resulting :class:`VerificationResult`).
            instance_node_id: The node in the graph that represents this
                observation's instance.  Used for Canon C3 exclusion check.
            embedding: The observation's embedding vector.  Used for nearest-
                centroid classification.
            classified_type_id: The schema type that the system assigned to
                this observation.  ``None`` signals an AMBIGUOUS result.
            confidence: The classifier's confidence in ``classified_type_id``.
                Values below ``0.75`` are treated as AMBIGUOUS.
            label_raw: The raw YOLO label for this detection (e.g. ``"mug"``).
                Used to filter windows by relevance.
            correlation_id: Tracing ID for the current observation session.

        Returns:
            A list of :class:`VerificationResult` produced -- one per window
            where this observation was relevant.  Returns an empty list if no
            open windows matched.
        """
        results: list[VerificationResult] = []

        # Iterate over a snapshot of the keys so that _check_window_closure
        # can safely delete entries from _open_windows mid-loop.
        for corr_id in list(self._open_windows.keys()):
            correction = self._open_windows.get(corr_id)
            if correction is None:
                continue  # Closed by a previous iteration in this call.

            # Canon C3: skip instances that were part of the pre-split snapshot.
            if _instance_was_at_split(instance_node_id, correction):
                logger.debug(
                    "verification_skipped_pre_split_instance correction_id=%s instance=%s",
                    corr_id,
                    str(instance_node_id),
                )
                continue

            # Relevance gate: the observation's label must match a type in the
            # split.  If no type node carries this label, the observation is
            # not relevant to this window.
            relevant = await self._is_relevant_observation(correction, label_raw)
            if not relevant:
                continue

            # Determine the expected type by nearest centroid.
            # Returns None when INSUFFICIENT_DATA (fewer than 3 instances per
            # type, per D-TS-15).
            expected_type_id = await self._determine_expected_type(
                correction, embedding
            )
            if expected_type_id is None:
                logger.debug(
                    "verification_skipped_insufficient_data correction_id=%s",
                    corr_id,
                )
                continue

            # Correctness: the classified type must match the expected type AND
            # the confidence must be >= 0.75.  AMBIGUOUS (None) counts as wrong.
            is_correct = (
                classified_type_id is not None
                and str(classified_type_id) == str(expected_type_id)
                and confidence >= self._CONFIDENCE_THRESHOLD
            )

            # Use "unclassified" as the classified_type_id sentinel for AMBIGUOUS
            # observations so that the VerificationResult type constraint is met.
            effective_classified = (
                classified_type_id
                if classified_type_id is not None
                else NodeId("unclassified")
            )

            result = VerificationResult(
                verification_id=f"ver-{uuid.uuid4().hex[:12]}",
                correction_id=corr_id,
                observation_id=NodeId(observation_id),
                classified_type_id=effective_classified,
                expected_type_id=expected_type_id,
                correct=is_correct,
                confidence_of_classification=confidence,
                correlation_id=correlation_id,
            )

            await self._behavioral_store.save_verification_result(result)
            results.append(result)

            logger.debug(
                "verification_result_recorded correction_id=%s observation_id=%s correct=%s",
                corr_id,
                observation_id,
                is_correct,
            )

            # Check whether this result fills the window.
            await self._check_window_closure(corr_id, correlation_id)

        return results

    async def increment_session(self) -> None:
        """Increment the session counter for all open windows.

        Call this once at session end (``SessionEnded`` event handler).  When
        a window's session count reaches :attr:`_SESSION_TIMEOUT` (5), the
        window is closed with outcome ``"TIMEOUT"`` regardless of how many
        observations have been collected.

        The TIMEOUT outcome reflects that not enough new objects of the split
        types appeared in frame to fill the window -- the guardian may have
        been inactive, or the camera was not pointed at the relevant objects.
        """
        for corr_id in list(self._open_windows.keys()):
            self._session_count[corr_id] = self._session_count.get(corr_id, 0) + 1

            if self._session_count[corr_id] >= self._SESSION_TIMEOUT:
                await self._close_window_timeout(corr_id)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _is_relevant_observation(
        self, correction: CorrectionEvent, label_raw: str
    ) -> bool:
        """Return True if ``label_raw`` matches any type produced by the split.

        Checks the ``label_raw`` and ``type_name`` properties of each new
        schema type node.  Either match is sufficient for relevance.

        Args:
            correction: The open correction event.
            label_raw: The YOLO detection label to match.

        Returns:
            ``True`` if at least one new type carries this label, ``False``
            otherwise.
        """
        for type_id in correction.new_type_ids:
            node = await self._persistence.get_node(type_id)
            if node is None:
                continue
            node_label = node.properties.get("label_raw")
            node_type_name = node.properties.get("type_name")
            if node_label == label_raw or node_type_name == label_raw:
                return True
        return False

    async def _determine_expected_type(
        self,
        correction: CorrectionEvent,
        embedding: list[float],
    ) -> NodeId | None:
        """Determine the expected subtype by nearest centroid.

        For each new type produced by the split, attempts to find its centroid
        embedding.  The centroid is sourced from a ``PropertyExpectation`` if
        one exists and is active; otherwise it is computed as the mean of all
        instance embeddings for that type.

        If a type has fewer than 3 instances (D-TS-15 INSUFFICIENT_DATA
        threshold), it is skipped entirely.  If no type can supply a centroid,
        returns ``None``.

        Args:
            correction: The open correction event.
            embedding: The observation's embedding vector.

        Returns:
            The ``NodeId`` of the new type whose centroid is closest to
            ``embedding``, or ``None`` if no centroid could be computed for
            any type.
        """
        best_type_id: NodeId | None = None
        best_similarity: float = -2.0  # Below the minimum cosine value of -1.0

        for type_id in correction.new_type_ids:
            centroid = await self._get_type_centroid(type_id)
            if centroid is None:
                continue  # INSUFFICIENT_DATA for this type -- skip it.

            sim = _cosine_similarity(embedding, centroid)
            if sim > best_similarity:
                best_similarity = sim
                best_type_id = type_id

        return best_type_id

    async def _get_type_centroid(self, type_id: NodeId) -> list[float] | None:
        """Return the centroid embedding for a schema type.

        Tries the PropertyExpectation first.  Falls back to computing the mean
        of all instance embeddings.  Returns ``None`` when INSUFFICIENT_DATA
        (fewer than 3 instances with embeddings).

        Args:
            type_id: NodeId of the schema type to find a centroid for.

        Returns:
            A list of floats representing the centroid vector, or ``None`` if
            the data is insufficient.
        """
        # Prefer a pre-computed PropertyExpectation centroid if available.
        expectations = await self._persistence.get_property_expectations(type_id)
        embedding_expectations = [
            e
            for e in expectations
            if e.property_key == "embedding" and e.is_active
        ]
        if embedding_expectations:
            return embedding_expectations[0].mean_vector

        # Fallback: compute the centroid from all instance embeddings of this type.
        all_instances = await self._persistence.query_nodes(
            NodeFilter(schema_level=SchemaLevel.INSTANCE)
        )

        instance_embeddings: list[list[float]] = []
        for inst in all_instances:
            inst_type = await self._persistence.get_instance_type(inst.node_id)
            if inst_type is None or str(inst_type) != str(type_id):
                continue
            emb = inst.properties.get("embedding")
            if isinstance(emb, list) and len(emb) > 0:
                instance_embeddings.append(emb)

        # D-TS-15: fewer than 3 instances means INSUFFICIENT_DATA.
        if len(instance_embeddings) < 3:
            return None

        # Compute the arithmetic mean (centroid) across all instance embeddings.
        dim = len(instance_embeddings[0])
        centroid = [
            sum(e[d] for e in instance_embeddings) / len(instance_embeddings)
            for d in range(dim)
        ]
        return centroid

    async def _check_window_closure(
        self,
        correction_id: str,
        correlation_id: CorrelationId,
    ) -> None:
        """Close the window if it has accumulated enough results.

        Reads all results for this correction from the behavioral store.  If
        the count has reached ``verification_window_size``, renders a verdict
        and emits a :class:`VerificationWindowClosed` event.

        Verdict logic:

        - ``"VERIFIED"`` -- accuracy >= 0.8 AND every subtype has at least 2
          results among the window's expected_type_id distribution.
        - ``"FAILED"`` -- any other case.

        Args:
            correction_id: The window to check.
            correlation_id: Tracing ID for the triggering operation.
        """
        correction = self._open_windows.get(correction_id)
        if correction is None:
            return  # Already closed.

        all_results = await self._behavioral_store.get_verification_results_for_correction(
            correction_id
        )

        if len(all_results) < correction.verification_window_size:
            return  # Window not yet full.

        # Compute accuracy.
        correct_count = sum(1 for r in all_results if r.correct)
        accuracy = correct_count / len(all_results) if all_results else 0.0

        # Count results per expected subtype to verify both sides are exercised.
        type_counts: dict[str, int] = {}
        for r in all_results:
            tid = str(r.expected_type_id)
            type_counts[tid] = type_counts.get(tid, 0) + 1

        both_exercised = (
            len(type_counts) >= 2
            and all(c >= 2 for c in type_counts.values())
        )

        outcome = "VERIFIED" if (accuracy >= 0.8 and both_exercised) else "FAILED"

        await self._emit_and_close(
            correction_id=correction_id,
            outcome=outcome,
            accuracy=accuracy,
            observations_checked=len(all_results),
            correlation_id=correlation_id,
        )

    async def _close_window_timeout(self, correction_id: str) -> None:
        """Close the window with a TIMEOUT verdict.

        Called when a window has been open for :attr:`_SESSION_TIMEOUT`
        sessions without filling.  Computes partial accuracy over whatever
        results have been collected and emits a :class:`VerificationWindowClosed`
        event with ``outcome="TIMEOUT"``.

        Args:
            correction_id: The window to time out.
        """
        all_results = await self._behavioral_store.get_verification_results_for_correction(
            correction_id
        )
        correct_count = sum(1 for r in all_results if r.correct)
        accuracy = correct_count / len(all_results) if all_results else 0.0

        correlation_id = CorrelationId(f"timeout-{correction_id}")

        logger.info(
            "verification_window_timeout correction_id=%s partial_accuracy=%.3f observations=%d",
            correction_id,
            accuracy,
            len(all_results),
        )

        await self._emit_and_close(
            correction_id=correction_id,
            outcome="TIMEOUT",
            accuracy=accuracy,
            observations_checked=len(all_results),
            correlation_id=correlation_id,
        )

    async def _emit_and_close(
        self,
        correction_id: str,
        outcome: str,
        accuracy: float,
        observations_checked: int,
        correlation_id: CorrelationId,
    ) -> None:
        """Publish the closure event, then remove the window from open state.

        Args:
            correction_id: The window that is closing.
            outcome: ``"VERIFIED"``, ``"FAILED"``, or ``"TIMEOUT"``.
            accuracy: Final accuracy fraction.
            observations_checked: Number of results that contributed.
            correlation_id: Tracing ID.
        """
        event = _make_closure_event(
            correction_id=correction_id,
            outcome=outcome,
            accuracy=accuracy,
            observations_checked=observations_checked,
            correlation_id=correlation_id,
        )
        await self._event_bus.publish(event)

        logger.info(
            "verification_window_closed correction_id=%s outcome=%s accuracy=%.3f observations=%d",
            correction_id,
            outcome,
            accuracy,
            observations_checked,
        )

        # Remove the window so future observations are not checked against it.
        self._open_windows.pop(correction_id, None)
        self._session_count.pop(correction_id, None)


# ---------------------------------------------------------------------------
# Internal utility
# ---------------------------------------------------------------------------


def _instance_was_at_split(
    instance_node_id: NodeId,
    correction: CorrectionEvent,
) -> bool:
    """Return True if ``instance_node_id`` is in the pre-split snapshot.

    The pre-split snapshot (``correction.instance_ids_at_split``) records
    every instance that existed under the original type before the split
    was applied.  These instances must be excluded from post-correction
    verification (Canon C3) because they could have been retroactively
    re-classified and cannot serve as evidence that the split is working
    for *new* observations.

    Args:
        instance_node_id: The candidate instance to check.
        correction: The correction event containing the snapshot.

    Returns:
        ``True`` if the instance was in the pre-split snapshot.
    """
    return instance_node_id in correction.instance_ids_at_split


__all__ = [
    "VerificationTracker",
    "VerificationWindowClosed",
]

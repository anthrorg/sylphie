"""Three-layer error handling architecture for semantic queries (P1.8-E3/T014).

Implements Cortex's defense-in-depth error handling with three layers operating
at different timescales. Each layer catches errors the previous layer missed,
creating a comprehensive safety net that prevents hallucination and enforces
honest-ignorance responses over fabricated answers.

Architecture overview:

  Layer 1 -- Hard Stops (microseconds):
    Immediate termination. These are structural invariants that, if violated,
    make continued processing meaningless. A cycle in an IS_A traversal means
    the BFS is looping. A timeout means we have exceeded our latency budget.
    Ambiguity (multiple equally-ranked results with insufficient confidence
    spread) means we cannot give a definitive answer.

    Hard stops fire synchronously within the traversal loop. No async, no
    cross-component communication. The traversal raises a HardStopError
    and returns immediately with the appropriate TerminationReason.

  Layer 2 -- Circuit Breaker (30-second window):
    Pattern detection across queries. A single query failure is normal.
    Five failures in 30 seconds on the same error category means something
    structural is wrong. The circuit breaker opens for that category, and
    all subsequent queries in that category route directly to LLM_REQUIRED
    (honest fallback) until the breaker resets.

    The breaker operates at the SemanticQueryHandler level. It tracks error
    patterns across query invocations, not within a single query.

  Layer 3 -- FOK Check (pre-execution feasibility):
    Already implemented in fok_check.py (T011). The FOK probe runs before
    any expensive traversal, catching infeasible queries before they waste
    cycles. This layer is integrated here through the ErrorHandlingCoordinator
    which invokes FOK before dispatch.

Cascade detection (USED_FACT reverse index):
  When a semantic edge is corrected by the guardian, all inference traces that
  used that edge must be identified and invalidated. The InferenceTraceWriter
  (T001) creates USED_FACT edges for this purpose. This module provides
  ``cascade_invalidate`` which wraps the USED_FACT query and trace invalidation
  in a single coordinated operation.

Error blast radius tracking (node centrality):
  Rather than storing error counts on individual facts (which belong to the
  circuit breaker domain, not to facts), blast radius is tracked via node
  connectivity. When a node is involved in an error, its ``error_centrality``
  property is updated -- reflecting how many other facts could be affected
  if this node's information is wrong. This is stored on the node itself,
  not on individual edges or facts.

  Centrality computation: outgoing edge count + USED_FACT incoming count.
  Nodes with high centrality get flagged when errors occur near them.

Graceful degradation:
  The system produces honest limitation reports rather than hallucinating.
  When any error layer fires, the response explains what the system knows
  and what it does not, rather than fabricating an answer. This is enforced
  structurally: error paths return DegradedResponse objects that PT-11
  converts to honest language.

CANON compliance:
  A.2   -- LLM as tool. Error handling is deterministic (rules, not LLM).
  A.10  -- Bounded traversal. Hard stops enforce the bound.
  A.12  -- Grounding. Graceful degradation prevents ungrounded answers.
  A.19  -- Traces. Cascade invalidation maintains trace integrity.

Phase 1.8 (Comprehension Layer, P1.8-E3/T014).
"""

from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

import neo4j

from cobeing.layer3_knowledge.constants import MAX_TRAVERSAL_DEPTH
from cobeing.layer3_knowledge.exceptions import KnowledgeGraphError
from cobeing.layer3_knowledge.fok_check import (
    FOKAccuracyTracker,
    FOKProbeResult,
    fok_check,
)
from cobeing.layer3_knowledge.inference_trace import (
    AffectedTrace,
    TerminationReason,
    invalidate_traces_using_edge,
    query_traces_using_edge,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.shared.event_bus import Event, EventBus

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Hard stop error types (Layer 1)
# ---------------------------------------------------------------------------


class HardStopReason(StrEnum):
    """Why a traversal was immediately terminated.

    Each reason maps to a TerminationReason on the inference trace so that
    the trace record preserves the exact cause.
    """

    CYCLE_DETECTED = "cycle_detected"
    """A node was visited twice during BFS/DFS. The graph has a cycle in the
    traversal path, making continued exploration meaningless."""

    TIMEOUT = "traversal_timeout"
    """The traversal exceeded its latency budget. The query took longer than
    the configured maximum (default: 5 seconds for a single traversal)."""

    AMBIGUITY = "ambiguity_detected"
    """Multiple results with insufficient confidence spread. The system cannot
    determine which answer is correct. Rather than picking arbitrarily, it
    stops and reports the ambiguity."""

    WORKING_MEMORY_EXHAUSTED = "working_memory_exhausted"
    """The traversal frontier exceeded the working memory budget. Too many
    nodes were being tracked simultaneously."""


# Map hard stop reasons to TerminationReason for trace recording
_HARD_STOP_TO_TERMINATION: dict[HardStopReason, TerminationReason] = {
    HardStopReason.CYCLE_DETECTED: TerminationReason.CYCLE_DETECTED,
    HardStopReason.TIMEOUT: TerminationReason.TRAVERSAL_TIMEOUT,
    HardStopReason.AMBIGUITY: TerminationReason.CONFIDENCE_FLOOR,
    HardStopReason.WORKING_MEMORY_EXHAUSTED: TerminationReason.WORKING_MEMORY_EXHAUSTED,
}


class HardStopError(Exception):
    """Raised when a Layer 1 hard stop fires during traversal.

    This exception propagates up from the traversal loop to the query executor,
    which catches it and converts it to a DegradedResponse. It is never exposed
    to callers outside the semantic query subsystem.

    Attributes:
        reason: The specific hard stop that fired.
        detail: Human-readable context for logging.
        depth_reached: How deep the traversal got before the stop.
        visited_count: How many nodes were visited before the stop.
    """

    def __init__(
        self,
        reason: HardStopReason,
        detail: str = "",
        depth_reached: int = 0,
        visited_count: int = 0,
    ) -> None:
        self.reason = reason
        self.detail = detail
        self.depth_reached = depth_reached
        self.visited_count = visited_count
        super().__init__(f"Hard stop ({reason.value}): {detail}")

    @property
    def termination_reason(self) -> TerminationReason:
        """Map this hard stop to the corresponding TerminationReason."""
        return _HARD_STOP_TO_TERMINATION.get(
            self.reason, TerminationReason.CYCLE_DETECTED
        )


# ---------------------------------------------------------------------------
# Hard stop guards (Layer 1) -- inline checks for traversal loops
# ---------------------------------------------------------------------------

# Traversal timeout budget (seconds). Configurable per query type.
DEFAULT_TRAVERSAL_TIMEOUT_SECONDS: float = 5.0
"""Maximum wall-clock seconds for a single semantic traversal.

If the traversal exceeds this budget, a TIMEOUT hard stop fires. This is a
safety net, not a performance target. Normal traversals complete in <100ms.
The 5-second budget catches infinite loops and pathological graph shapes.
"""

# Working memory budget (max frontier nodes)
DEFAULT_WORKING_MEMORY_BUDGET: int = 200
"""Maximum number of nodes in the BFS frontier at any point.

If the frontier grows beyond this, the traversal is exploring a fan-out
explosion and should terminate. This prevents O(V) memory usage on hub
nodes like 'thing' or 'object' that accumulate many IS_A children.
"""

# Ambiguity spread threshold
AMBIGUITY_CONFIDENCE_SPREAD: float = 0.15
"""Minimum confidence spread between the top two results.

If the gap between the highest-confidence result and the second-highest
is less than this threshold, the results are ambiguous. The system cannot
confidently choose between them and reports the ambiguity rather than
guessing.
"""


@dataclass(frozen=True)
class TraversalGuard:
    """Configuration for Layer 1 hard stop guards.

    Passed to traversal functions so they can check guards inline without
    importing global constants. This makes guards testable and configurable
    per query type.

    Attributes:
        timeout_seconds: Maximum wall-clock time for the traversal.
        max_depth: Maximum traversal depth (hops).
        working_memory_budget: Maximum frontier size.
        ambiguity_spread: Minimum confidence spread between top results.
        start_time: Monotonic timestamp when traversal began. Set
            automatically if not provided.
    """

    timeout_seconds: float = DEFAULT_TRAVERSAL_TIMEOUT_SECONDS
    max_depth: int = MAX_TRAVERSAL_DEPTH
    working_memory_budget: int = DEFAULT_WORKING_MEMORY_BUDGET
    ambiguity_spread: float = AMBIGUITY_CONFIDENCE_SPREAD
    start_time: float = field(default_factory=time.monotonic)


def check_cycle(
    node_id: str,
    visited: set[str],
    depth: int,
) -> None:
    """Check if a node has already been visited (cycle detection).

    Call this at the start of each BFS/DFS iteration before processing
    the node. If the node is in the visited set, a cycle exists.

    Args:
        node_id: The node being visited.
        visited: Set of previously visited node IDs.
        depth: Current traversal depth (for error reporting).

    Raises:
        HardStopError: If node_id is in visited (CYCLE_DETECTED).
    """
    if node_id in visited:
        raise HardStopError(
            reason=HardStopReason.CYCLE_DETECTED,
            detail=f"Node '{node_id}' visited twice at depth {depth}",
            depth_reached=depth,
            visited_count=len(visited),
        )


def check_timeout(
    guard: TraversalGuard,
    depth: int,
    visited_count: int,
) -> None:
    """Check if the traversal has exceeded its time budget.

    Call this at the start of each BFS/DFS iteration. The cost of
    time.monotonic() is negligible (~50ns) compared to graph queries.

    Args:
        guard: The traversal guard configuration.
        depth: Current traversal depth (for error reporting).
        visited_count: Number of nodes visited so far.

    Raises:
        HardStopError: If elapsed time exceeds guard.timeout_seconds (TIMEOUT).
    """
    elapsed = time.monotonic() - guard.start_time
    if elapsed > guard.timeout_seconds:
        raise HardStopError(
            reason=HardStopReason.TIMEOUT,
            detail=(
                f"Traversal exceeded {guard.timeout_seconds}s budget "
                f"(elapsed={elapsed:.2f}s, depth={depth}, "
                f"visited={visited_count})"
            ),
            depth_reached=depth,
            visited_count=visited_count,
        )


def check_working_memory(
    frontier_size: int,
    guard: TraversalGuard,
    depth: int,
    visited_count: int,
) -> None:
    """Check if the BFS frontier exceeds the working memory budget.

    Call this after expanding the frontier in each BFS iteration.

    Args:
        frontier_size: Current number of nodes in the BFS frontier.
        guard: The traversal guard configuration.
        depth: Current traversal depth (for error reporting).
        visited_count: Number of nodes visited so far.

    Raises:
        HardStopError: If frontier_size exceeds guard.working_memory_budget.
    """
    if frontier_size > guard.working_memory_budget:
        raise HardStopError(
            reason=HardStopReason.WORKING_MEMORY_EXHAUSTED,
            detail=(
                f"BFS frontier ({frontier_size}) exceeded working memory "
                f"budget ({guard.working_memory_budget}) at depth {depth}"
            ),
            depth_reached=depth,
            visited_count=visited_count,
        )


def check_ambiguity(
    results: list[tuple[str, float]],
    guard: TraversalGuard,
    depth: int,
    visited_count: int,
) -> None:
    """Check if the top results are ambiguous (insufficient confidence spread).

    Call this after collecting candidate results, before selecting the winner.
    Only fires when there are 2+ results and the spread between the top two
    is below the threshold.

    Args:
        results: List of (node_id, confidence) tuples, sorted descending
            by confidence.
        guard: The traversal guard configuration.
        depth: Current traversal depth (for error reporting).
        visited_count: Number of nodes visited so far.

    Raises:
        HardStopError: If the confidence spread between top two results
            is below guard.ambiguity_spread (AMBIGUITY).
    """
    if len(results) < 2:
        return
    top_confidence = results[0][1]
    second_confidence = results[1][1]
    spread = top_confidence - second_confidence
    if spread < guard.ambiguity_spread:
        raise HardStopError(
            reason=HardStopReason.AMBIGUITY,
            detail=(
                f"Ambiguous results: top={results[0][0]} "
                f"(conf={top_confidence:.3f}), "
                f"second={results[1][0]} "
                f"(conf={second_confidence:.3f}), "
                f"spread={spread:.3f} < {guard.ambiguity_spread}"
            ),
            depth_reached=depth,
            visited_count=visited_count,
        )


# ---------------------------------------------------------------------------
# Circuit Breaker (Layer 2) -- pattern detection with 30s isolation
# ---------------------------------------------------------------------------

CIRCUIT_BREAKER_WINDOW_SECONDS: float = 30.0
"""Sliding window for error pattern detection.

The circuit breaker counts errors within this window. Errors older than
this are evicted from the counter. The window is per-category, not global.
"""

CIRCUIT_BREAKER_THRESHOLD: int = 5
"""Number of errors within the window that trips the breaker.

Five failures in 30 seconds on the same error category means the problem
is structural, not transient. The breaker opens and routes all queries
in that category to LLM_REQUIRED until the isolation period ends.
"""

CIRCUIT_BREAKER_ISOLATION_SECONDS: float = 30.0
"""How long the breaker stays open after tripping.

During isolation, all queries in the tripped category bypass semantic
traversal and route directly to LLM_REQUIRED with an honest limitation
report. After isolation expires, the breaker moves to HALF_OPEN and
allows one probe query.
"""


class BreakerState(StrEnum):
    """Circuit breaker state machine.

    Three states per Cortex domain specification (Section 3.6):
      CLOSED (normal) -> OPEN (tripped) -> HALF_OPEN (testing) -> CLOSED
    """

    CLOSED = "closed"
    """Normal operation. Errors are counted but queries pass through."""

    OPEN = "open"
    """Tripped. All queries in this category route to LLM_REQUIRED."""

    HALF_OPEN = "half_open"
    """Testing. One probe query is allowed. If it succeeds, return to
    CLOSED. If it fails, return to OPEN with the isolation timer reset."""


@dataclass
class ErrorRecord:
    """A single error occurrence for the circuit breaker window.

    Attributes:
        timestamp: Monotonic time when the error occurred.
        error_type: The HardStopReason or other error category.
        detail: Brief description for debugging.
    """

    timestamp: float
    error_type: str
    detail: str = ""


@dataclass
class CircuitBreakerCategory:
    """Circuit breaker state for one error category.

    Each category (e.g., "definition_query", "classification_query",
    "inference_query") has its own breaker. Failures in inference_query
    do not affect the definition_query breaker.

    Attributes:
        category: The error category name.
        state: Current breaker state.
        errors: Deque of recent error records within the sliding window.
        opened_at: Monotonic timestamp when the breaker opened (0.0 if CLOSED).
        half_open_probe_allowed: True if the next query should be a probe.
        total_trips: Lifetime count of breaker trips for metrics.
        total_errors: Lifetime count of errors for metrics.
    """

    category: str
    state: BreakerState = BreakerState.CLOSED
    errors: deque[ErrorRecord] = field(default_factory=deque)
    opened_at: float = 0.0
    half_open_probe_allowed: bool = False
    total_trips: int = 0
    total_errors: int = 0


class SemanticCircuitBreaker:
    """Circuit breaker for semantic query error patterns.

    Tracks errors per category with a sliding window. When the error count
    in a category exceeds the threshold within the window, the breaker opens
    for that category. During the open state, all queries route to
    LLM_REQUIRED. After the isolation period, the breaker enters HALF_OPEN
    and allows one probe query.

    This is session-scoped. A new session starts with all breakers CLOSED.

    Thread safety: This class is designed for single-threaded async use
    within the SemanticQueryHandler. No locking is required because all
    access is sequential within the asyncio event loop.

    Usage::

        breaker = SemanticCircuitBreaker()

        # Before dispatching a query:
        if breaker.should_bypass("inference_query"):
            # Route to LLM_REQUIRED with honest limitation
            return degraded_response(...)

        # After a query error:
        breaker.record_error("inference_query", error_type="cycle_detected")

        # After a successful query:
        breaker.record_success("inference_query")
    """

    def __init__(
        self,
        window_seconds: float = CIRCUIT_BREAKER_WINDOW_SECONDS,
        threshold: int = CIRCUIT_BREAKER_THRESHOLD,
        isolation_seconds: float = CIRCUIT_BREAKER_ISOLATION_SECONDS,
        event_bus: EventBus | None = None,
    ) -> None:
        self._window_seconds = window_seconds
        self._threshold = threshold
        self._isolation_seconds = isolation_seconds
        self._event_bus = event_bus
        self._categories: dict[str, CircuitBreakerCategory] = {}

    def _get_category(self, category: str) -> CircuitBreakerCategory:
        """Get or create a breaker category."""
        if category not in self._categories:
            self._categories[category] = CircuitBreakerCategory(category=category)
        return self._categories[category]

    def _evict_old_errors(self, cat: CircuitBreakerCategory) -> None:
        """Remove errors outside the sliding window."""
        now = time.monotonic()
        cutoff = now - self._window_seconds
        while cat.errors and cat.errors[0].timestamp < cutoff:
            cat.errors.popleft()

    def should_bypass(self, category: str) -> bool:
        """Check if queries in this category should bypass semantic traversal.

        Returns True when the breaker is OPEN (within isolation period) or
        when the breaker is HALF_OPEN and the probe has already been allowed.

        When the breaker is HALF_OPEN and a probe has not been allowed yet,
        returns False (letting one query through as a probe) and sets
        half_open_probe_allowed = False to block subsequent queries until
        the probe result arrives.

        Args:
            category: The query type category to check.

        Returns:
            True if the query should bypass traversal and route to LLM_REQUIRED.
        """
        cat = self._get_category(category)
        now = time.monotonic()

        if cat.state == BreakerState.CLOSED:
            return False

        if cat.state == BreakerState.OPEN:
            # Check if isolation period has expired
            if now - cat.opened_at >= self._isolation_seconds:
                # Transition to HALF_OPEN: allow one probe query
                cat.state = BreakerState.HALF_OPEN
                cat.half_open_probe_allowed = True
                _log.info(
                    "circuit_breaker: %s transitioning OPEN -> HALF_OPEN "
                    "(isolation expired after %.1fs)",
                    category,
                    now - cat.opened_at,
                )
                # Fall through to HALF_OPEN logic below
            else:
                return True  # Still in isolation

        if cat.state == BreakerState.HALF_OPEN:
            if cat.half_open_probe_allowed:
                # Allow the probe query through
                cat.half_open_probe_allowed = False
                _log.info(
                    "circuit_breaker: %s allowing probe query (HALF_OPEN)",
                    category,
                )
                return False
            # Probe already sent, waiting for result -- block further queries
            return True

        return False

    def record_error(
        self,
        category: str,
        error_type: str,
        detail: str = "",
    ) -> bool:
        """Record an error and check if the breaker should trip.

        Args:
            category: The query type category.
            error_type: The error classification (e.g., "cycle_detected").
            detail: Human-readable detail for debugging.

        Returns:
            True if the breaker tripped as a result of this error (just
            transitioned to OPEN). False otherwise.
        """
        cat = self._get_category(category)
        now = time.monotonic()

        cat.total_errors += 1

        # Record the error
        cat.errors.append(ErrorRecord(
            timestamp=now,
            error_type=error_type,
            detail=detail,
        ))

        # Evict old errors
        self._evict_old_errors(cat)

        # If in HALF_OPEN and probe failed, return to OPEN
        if cat.state == BreakerState.HALF_OPEN:
            cat.state = BreakerState.OPEN
            cat.opened_at = now
            cat.total_trips += 1
            _log.warning(
                "circuit_breaker: %s probe failed, returning to OPEN "
                "(error_type=%s total_trips=%d)",
                category,
                error_type,
                cat.total_trips,
            )
            return True

        # If in CLOSED and threshold exceeded, trip the breaker
        if cat.state == BreakerState.CLOSED and len(cat.errors) >= self._threshold:
            cat.state = BreakerState.OPEN
            cat.opened_at = now
            cat.total_trips += 1
            _log.warning(
                "circuit_breaker: %s tripped (%d errors in %.0fs window, "
                "threshold=%d, total_trips=%d)",
                category,
                len(cat.errors),
                self._window_seconds,
                self._threshold,
                cat.total_trips,
            )
            return True

        return False

    def record_success(self, category: str) -> None:
        """Record a successful query. Resets the breaker if HALF_OPEN.

        If the breaker is HALF_OPEN and a probe query succeeds, this
        transitions back to CLOSED. In CLOSED state, this is a no-op.

        Args:
            category: The query type category.
        """
        cat = self._get_category(category)

        if cat.state == BreakerState.HALF_OPEN:
            cat.state = BreakerState.CLOSED
            cat.errors.clear()
            _log.info(
                "circuit_breaker: %s probe succeeded, transitioning "
                "HALF_OPEN -> CLOSED",
                category,
            )

    def get_status(self, category: str) -> dict[str, Any]:
        """Get the current status of a breaker category.

        Args:
            category: The query type category.

        Returns:
            Dict with state, error_count, total_trips, total_errors.
        """
        cat = self._get_category(category)
        self._evict_old_errors(cat)
        return {
            "category": category,
            "state": cat.state.value,
            "error_count_in_window": len(cat.errors),
            "total_trips": cat.total_trips,
            "total_errors": cat.total_errors,
            "window_seconds": self._window_seconds,
            "threshold": self._threshold,
        }

    def get_all_statuses(self) -> list[dict[str, Any]]:
        """Get status for all tracked categories.

        Returns:
            List of status dicts, one per category.
        """
        return [self.get_status(cat) for cat in self._categories]

    def reset(self) -> None:
        """Reset all breaker categories to CLOSED. For session boundaries."""
        for cat in self._categories.values():
            cat.state = BreakerState.CLOSED
            cat.errors.clear()
            cat.opened_at = 0.0
            cat.half_open_probe_allowed = False
        _log.info("circuit_breaker: all categories reset to CLOSED")


# ---------------------------------------------------------------------------
# Degraded response (honest limitation reporting)
# ---------------------------------------------------------------------------


class DegradationReason(StrEnum):
    """Why the system is returning a degraded (honest limitation) response.

    Each reason maps to a specific natural language template that explains
    what happened without hallucinating.
    """

    CIRCUIT_BREAKER_OPEN = "circuit_breaker_open"
    """The circuit breaker for this query type is tripped."""

    FOK_INFEASIBLE = "fok_infeasible"
    """The FOK probe determined the query is infeasible."""

    HARD_STOP_CYCLE = "hard_stop_cycle"
    """A cycle was detected during traversal."""

    HARD_STOP_TIMEOUT = "hard_stop_timeout"
    """The traversal exceeded its time budget."""

    HARD_STOP_AMBIGUITY = "hard_stop_ambiguity"
    """Results were too ambiguous to select a confident answer."""

    HARD_STOP_MEMORY = "hard_stop_memory"
    """Working memory was exhausted during traversal."""

    CASCADE_INVALIDATION = "cascade_invalidation"
    """Inference traces were invalidated due to edge correction."""

    SEMANTIC_CONTRADICTION = "semantic_contradiction"
    """A semantic contradiction was detected."""

    UNKNOWN_ERROR = "unknown_error"
    """An unexpected error occurred."""


# Natural language templates for honest limitation reporting.
# PT-11 uses these when formatting degraded responses. The templates
# are deterministic -- no LLM involvement in generating them.
_DEGRADATION_TEMPLATES: dict[DegradationReason, str] = {
    DegradationReason.CIRCUIT_BREAKER_OPEN: (
        "I am having trouble answering this type of question right now. "
        "My semantic reasoning has encountered repeated errors and I have "
        "temporarily paused it to prevent giving you wrong information."
    ),
    DegradationReason.FOK_INFEASIBLE: (
        "I do not have enough information in my knowledge to answer this "
        "question. Could you teach me more about the concepts involved?"
    ),
    DegradationReason.HARD_STOP_CYCLE: (
        "I found a circular relationship in my knowledge while trying to "
        "answer this. I need help untangling it before I can reason about "
        "this topic correctly."
    ),
    DegradationReason.HARD_STOP_TIMEOUT: (
        "This question requires following a longer chain of reasoning than "
        "I can currently handle. I am still learning to think through "
        "complex relationships."
    ),
    DegradationReason.HARD_STOP_AMBIGUITY: (
        "I found multiple possible answers but I am not confident enough "
        "in any of them to give you a definitive response. Could you help "
        "me narrow it down?"
    ),
    DegradationReason.HARD_STOP_MEMORY: (
        "This question connects to too many concepts at once for me to "
        "reason through right now. I am still developing my ability to "
        "handle complex queries."
    ),
    DegradationReason.CASCADE_INVALIDATION: (
        "Some of my previous reasoning about this topic was based on "
        "information that has since been corrected. I need to re-examine "
        "what I know before I can answer confidently."
    ),
    DegradationReason.SEMANTIC_CONTRADICTION: (
        "I have conflicting information about this topic in my knowledge. "
        "I need your help to resolve the contradiction before I can "
        "reason about it clearly."
    ),
    DegradationReason.UNKNOWN_ERROR: (
        "I encountered an unexpected problem while trying to answer this. "
        "I would rather tell you honestly than guess."
    ),
}


@dataclass(frozen=True)
class DegradedResponse:
    """A response produced when error handling prevents normal query execution.

    This replaces a normal SemanticQueryResult when any error layer fires.
    PT-11 converts it to natural language using the honest limitation template.

    Attributes:
        degraded: Always True. Distinguishes this from a normal result.
        reason: Why the response is degraded.
        detail: Machine-readable detail (for logging and metrics).
        natural_language: Human-readable honest limitation message.
        query_type: The query type that was attempted.
        subject_node_id: The subject of the attempted query.
        target_node_id: The target of the attempted query (empty for definitions).
        fok_result: The FOK probe result, if a FOK check was performed.
        breaker_status: Circuit breaker status at time of degradation.
        hard_stop_reason: The specific hard stop reason, if applicable.
    """

    degraded: bool = True
    reason: DegradationReason = DegradationReason.UNKNOWN_ERROR
    detail: str = ""
    natural_language: str = ""
    query_type: str = ""
    subject_node_id: str = ""
    target_node_id: str = ""
    fok_result: FOKProbeResult | None = None
    breaker_status: dict[str, Any] = field(default_factory=dict)
    hard_stop_reason: HardStopReason | None = None


def build_degraded_response(
    reason: DegradationReason,
    detail: str = "",
    query_type: str = "",
    subject_node_id: str = "",
    target_node_id: str = "",
    fok_result: FOKProbeResult | None = None,
    breaker_status: dict[str, Any] | None = None,
    hard_stop_reason: HardStopReason | None = None,
) -> DegradedResponse:
    """Build a DegradedResponse with the appropriate natural language template.

    Args:
        reason: Why the response is degraded.
        detail: Machine-readable detail for logging.
        query_type: The query type that was attempted.
        subject_node_id: The subject node ID.
        target_node_id: The target node ID (empty for definitions).
        fok_result: FOK probe result, if applicable.
        breaker_status: Circuit breaker status dict, if applicable.
        hard_stop_reason: Specific hard stop reason, if applicable.

    Returns:
        A DegradedResponse with all fields populated.
    """
    template = _DEGRADATION_TEMPLATES.get(
        reason, _DEGRADATION_TEMPLATES[DegradationReason.UNKNOWN_ERROR]
    )
    return DegradedResponse(
        reason=reason,
        detail=detail,
        natural_language=template,
        query_type=query_type,
        subject_node_id=subject_node_id,
        target_node_id=target_node_id,
        fok_result=fok_result,
        breaker_status=breaker_status or {},
        hard_stop_reason=hard_stop_reason,
    )


# ---------------------------------------------------------------------------
# Cascade detection and invalidation (USED_FACT reverse index)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CascadeResult:
    """Result of cascade invalidation after a semantic edge correction.

    Attributes:
        edge_id: The corrected edge that triggered the cascade.
        affected_traces: List of traces that depended on the corrected edge.
        invalidated_count: Number of traces marked as SUPERSEDED.
        nodes_with_updated_centrality: Node IDs whose error_centrality changed.
    """

    edge_id: str
    affected_traces: list[AffectedTrace]
    invalidated_count: int
    nodes_with_updated_centrality: list[str] = field(default_factory=list)


async def cascade_invalidate(
    neo4j_session: neo4j.Session,
    persistence: GraphPersistence,
    edge_id: str,
    reason: str = "source_edge_corrected",
) -> CascadeResult:
    """Detect and invalidate inference traces affected by an edge correction.

    This is the coordinated operation that uses the USED_FACT reverse index:

    1. Query all traces that used the corrected edge (T001 query function).
    2. Invalidate those traces (mark as SUPERSEDED).
    3. Update error_centrality on nodes involved in the affected traces.

    Args:
        neo4j_session: Open Neo4j session.
        persistence: Graph persistence for node updates.
        edge_id: The edge_id of the corrected/retracted semantic edge.
        reason: Why the cascade is happening (for trace metadata).

    Returns:
        CascadeResult with full details of the cascade operation.
    """
    # Step 1: Find affected traces via USED_FACT reverse index
    try:
        affected_traces = query_traces_using_edge(
            neo4j_session, edge_id=edge_id
        )
    except KnowledgeGraphError:
        _log.warning(
            "cascade_invalidate: failed to query traces for edge %s",
            edge_id,
        )
        return CascadeResult(
            edge_id=edge_id,
            affected_traces=[],
            invalidated_count=0,
        )

    if not affected_traces:
        _log.debug(
            "cascade_invalidate: no traces use edge %s -- no cascade needed",
            edge_id,
        )
        return CascadeResult(
            edge_id=edge_id,
            affected_traces=[],
            invalidated_count=0,
        )

    # Step 2: Invalidate the affected traces
    try:
        invalidated_count = invalidate_traces_using_edge(
            neo4j_session, edge_id=edge_id, reason=reason
        )
    except KnowledgeGraphError:
        _log.warning(
            "cascade_invalidate: failed to invalidate traces for edge %s",
            edge_id,
        )
        invalidated_count = 0

    # Step 3: Update error centrality on nodes involved in affected traces
    nodes_updated: list[str] = []
    affected_node_ids: set[str] = set()
    for trace in affected_traces:
        affected_node_ids.add(trace.trace_node_id)

    for node_id in affected_node_ids:
        try:
            centrality = await _compute_error_centrality(
                neo4j_session, persistence, node_id
            )
            await _update_error_centrality(persistence, node_id, centrality)
            nodes_updated.append(node_id)
        except Exception as exc:
            _log.warning(
                "cascade_invalidate: failed to update centrality for %s: %s",
                node_id,
                exc,
            )

    _log.info(
        "cascade_invalidate: edge=%s affected=%d invalidated=%d "
        "centrality_updated=%d",
        edge_id,
        len(affected_traces),
        invalidated_count,
        len(nodes_updated),
    )

    return CascadeResult(
        edge_id=edge_id,
        affected_traces=affected_traces,
        invalidated_count=invalidated_count,
        nodes_with_updated_centrality=nodes_updated,
    )


# ---------------------------------------------------------------------------
# Error blast radius tracking (node centrality)
# ---------------------------------------------------------------------------

# Centrality thresholds for warning levels
LOW_CENTRALITY_THRESHOLD: int = 5
"""Nodes with centrality below this are low-risk. Errors on these nodes
affect few other facts."""

HIGH_CENTRALITY_THRESHOLD: int = 20
"""Nodes with centrality at or above this are high-risk. Errors on these
nodes could cascade widely through the graph. These nodes get extra
scrutiny during contradiction detection and should be flagged for guardian
attention when involved in errors."""


async def _compute_error_centrality(
    neo4j_session: neo4j.Session,
    persistence: GraphPersistence,
    node_id: str,
) -> int:
    """Compute error centrality for a node.

    Centrality = outgoing semantic edge count + incoming USED_FACT edge count.

    Outgoing edges measure how many facts this node participates in as a
    subject. USED_FACT incoming edges measure how many inference traces
    depended on edges from this node. Together they approximate the "blast
    radius" -- how many other knowledge artifacts could be affected if this
    node's information is wrong.

    Centrality is stored on the node, not on individual facts, because it
    is a property of the node's position in the graph, not of any specific
    edge.

    Args:
        neo4j_session: Open Neo4j session for Cypher queries.
        persistence: Graph persistence (not used currently, reserved for
            future non-Cypher backends).
        node_id: The node_id to compute centrality for.

    Returns:
        Integer centrality score. Always >= 0.
    """
    cypher = (
        "OPTIONAL MATCH (n {node_id: $node_id})-[out]->() "
        "WITH count(out) AS outgoing "
        "OPTIONAL MATCH (n {node_id: $node_id})<-[uf:USED_FACT]-() "
        "RETURN outgoing + count(uf) AS centrality"
    )
    try:
        def _read(tx: neo4j.ManagedTransaction) -> int:
            result = tx.run(cypher, node_id=node_id)
            record = result.single()
            if record is None:
                return 0
            return int(record["centrality"])

        return neo4j_session.execute_read(_read)
    except Exception as exc:
        _log.warning(
            "compute_error_centrality: failed for node %s: %s",
            node_id,
            exc,
        )
        return 0


async def _update_error_centrality(
    persistence: GraphPersistence,
    node_id: str,
    centrality: int,
) -> None:
    """Update the error_centrality property on a graph node.

    This property is read by the contradiction detector (semantic_contradiction.py)
    for severity classification: high-centrality nodes with contradictions get
    elevated to BETA or GAMMA severity.

    Args:
        persistence: Graph persistence backend.
        node_id: The node_id to update.
        centrality: The computed centrality value.
    """
    from cobeing.shared.types import NodeId  # noqa: PLC0415

    node = await persistence.get_node(NodeId(node_id))
    if node is None:
        return

    node.properties["error_centrality"] = centrality

    # Set centrality risk level for quick lookup
    if centrality >= HIGH_CENTRALITY_THRESHOLD:
        node.properties["centrality_risk"] = "high"
    elif centrality >= LOW_CENTRALITY_THRESHOLD:
        node.properties["centrality_risk"] = "medium"
    else:
        node.properties["centrality_risk"] = "low"

    await persistence.save_node(node)
    _log.debug(
        "error_centrality: node=%s centrality=%d risk=%s",
        node_id,
        centrality,
        node.properties["centrality_risk"],
    )


async def compute_and_update_centrality(
    neo4j_session: neo4j.Session,
    persistence: GraphPersistence,
    node_id: str,
) -> int:
    """Public interface: compute and persist error centrality for a node.

    Call this when a node is involved in an error or contradiction.

    Args:
        neo4j_session: Open Neo4j session.
        persistence: Graph persistence backend.
        node_id: The node_id to update.

    Returns:
        The computed centrality value.
    """
    centrality = await _compute_error_centrality(neo4j_session, persistence, node_id)
    await _update_error_centrality(persistence, node_id, centrality)
    return centrality


# ---------------------------------------------------------------------------
# Semantic edge correction with cascade (integrates contradiction + cascade)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EdgeCorrectionResult:
    """Result of correcting a semantic edge with full cascade handling.

    Attributes:
        edge_id: The corrected edge.
        cascade: The cascade invalidation result.
        contradiction_detected: Whether a contradiction was found during correction.
        centrality_updated: Nodes whose centrality was updated.
    """

    edge_id: str
    cascade: CascadeResult
    contradiction_detected: bool = False
    centrality_updated: list[str] = field(default_factory=list)


async def handle_edge_correction(
    neo4j_session: neo4j.Session,
    persistence: GraphPersistence,
    corrected_edge_id: str,
    source_node_id: str,
    target_node_id: str,
    reason: str = "guardian_correction",
) -> EdgeCorrectionResult:
    """Handle a semantic edge correction with cascade detection.

    When the guardian corrects a semantic edge (or contradiction detection
    fires), this function:

    1. Runs cascade invalidation on all traces that used the edge.
    2. Updates error centrality on the source and target nodes.

    This function does NOT perform the actual edge correction (that is done
    by the caller -- typically SemanticTeachingHandler). It handles only the
    cascade effects.

    Args:
        neo4j_session: Open Neo4j session.
        persistence: Graph persistence backend.
        corrected_edge_id: The edge_id being corrected.
        source_node_id: The source node of the corrected edge.
        target_node_id: The target node of the corrected edge.
        reason: Why the correction is happening.

    Returns:
        EdgeCorrectionResult with cascade details.
    """
    # Step 1: Cascade invalidation
    cascade = await cascade_invalidate(
        neo4j_session=neo4j_session,
        persistence=persistence,
        edge_id=corrected_edge_id,
        reason=reason,
    )

    # Step 2: Update centrality on involved nodes
    centrality_updated: list[str] = []
    for node_id in [source_node_id, target_node_id]:
        try:
            await compute_and_update_centrality(neo4j_session, persistence, node_id)
            centrality_updated.append(node_id)
        except Exception as exc:
            _log.warning(
                "handle_edge_correction: centrality update failed for %s: %s",
                node_id,
                exc,
            )

    return EdgeCorrectionResult(
        edge_id=corrected_edge_id,
        cascade=cascade,
        centrality_updated=centrality_updated,
    )


# ---------------------------------------------------------------------------
# Error event type (for circuit breaker notifications)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SemanticQueryErrorEvent(Event):
    """Emitted when a semantic query encounters an error.

    Published by the ErrorHandlingCoordinator when any error layer fires.
    Subscribers (metrics framework, guardian notification) use this for
    monitoring and alerting.

    Attributes:
        query_type: The query type that errored.
        error_layer: Which error layer caught the problem (1=hard_stop,
            2=circuit_breaker, 3=fok_check).
        error_type: The specific error classification.
        detail: Human-readable error detail.
        subject_node_id: The subject of the attempted query.
        target_node_id: The target (empty for definitions).
        session_id: Current session ID.
        breaker_tripped: True if this error tripped the circuit breaker.
    """

    query_type: str = ""
    error_layer: int = 0
    error_type: str = ""
    detail: str = ""
    subject_node_id: str = ""
    target_node_id: str = ""
    session_id: str = ""
    breaker_tripped: bool = False


# ---------------------------------------------------------------------------
# ErrorHandlingCoordinator -- the integration point
# ---------------------------------------------------------------------------


class ErrorHandlingCoordinator:
    """Coordinates all three error handling layers for semantic queries.

    This is the single integration point that the SemanticQueryHandler calls
    before and after query execution. It manages:

    - Pre-execution: Circuit breaker check + FOK feasibility probe
    - Post-execution: Error recording + cascade detection
    - Metrics: FOK accuracy tracking + breaker status

    The coordinator does NOT own the FOK implementation (that is in
    fok_check.py) or the circuit breaker state machine (that is
    SemanticCircuitBreaker above). It coordinates between them.

    Usage::

        coordinator = ErrorHandlingCoordinator(
            persistence=persistence,
            event_bus=event_bus,
        )

        # Pre-execution check (returns DegradedResponse if query should not run)
        degraded = await coordinator.pre_execution_check(
            neo4j_session=neo4j_session,
            query_type="inference_query",
            subject_node_id="ws:cat",
            target_node_id="ws:breathe_air",
        )
        if degraded is not None:
            return degraded  # Skip query, return honest limitation

        # Execute query (may raise HardStopError)
        try:
            result = await execute_query(...)
        except HardStopError as exc:
            degraded = coordinator.handle_hard_stop(exc, ...)
            return degraded

        # Post-execution: record success
        coordinator.record_success(query_type="inference_query")
    """

    def __init__(
        self,
        persistence: GraphPersistence,
        event_bus: EventBus | None = None,
        circuit_breaker: SemanticCircuitBreaker | None = None,
        fok_tracker: FOKAccuracyTracker | None = None,
    ) -> None:
        self._persistence = persistence
        self._event_bus = event_bus
        self._breaker = circuit_breaker or SemanticCircuitBreaker(event_bus=event_bus)
        self._fok_tracker = fok_tracker or FOKAccuracyTracker()

    @property
    def circuit_breaker(self) -> SemanticCircuitBreaker:
        """Access the circuit breaker for status queries."""
        return self._breaker

    @property
    def fok_tracker(self) -> FOKAccuracyTracker:
        """Access the FOK accuracy tracker for metrics."""
        return self._fok_tracker

    async def pre_execution_check(
        self,
        neo4j_session: neo4j.Session,
        query_type: str,
        subject_node_id: str,
        target_node_id: str = "",
        session_id: str = "",
    ) -> DegradedResponse | None:
        """Run pre-execution checks (Layer 2 + Layer 3).

        Checks in order:
        1. Circuit breaker (Layer 2): Is this query category tripped?
        2. FOK feasibility (Layer 3): Does the graph have enough structure?

        Returns a DegradedResponse if the query should not proceed.
        Returns None if the query should proceed normally.

        Layer 1 hard stops are not checked here -- they fire inline during
        traversal and are handled by handle_hard_stop().

        Args:
            neo4j_session: Open Neo4j session for FOK probes.
            query_type: The query type category.
            subject_node_id: The subject entity.
            target_node_id: The target entity (empty for definitions).
            session_id: Current session ID for event correlation.

        Returns:
            DegradedResponse if query should not proceed, None otherwise.
        """
        # Layer 2: Circuit breaker check
        if self._breaker.should_bypass(query_type):
            breaker_status = self._breaker.get_status(query_type)

            _log.info(
                "error_coordinator: circuit breaker OPEN for %s -- "
                "routing to honest limitation (subject=%s)",
                query_type,
                subject_node_id,
            )

            degraded = build_degraded_response(
                reason=DegradationReason.CIRCUIT_BREAKER_OPEN,
                detail=f"Circuit breaker open for {query_type}",
                query_type=query_type,
                subject_node_id=subject_node_id,
                target_node_id=target_node_id,
                breaker_status=breaker_status,
            )

            if self._event_bus is not None:
                await self._event_bus.publish(SemanticQueryErrorEvent(
                    query_type=query_type,
                    error_layer=2,
                    error_type="circuit_breaker_open",
                    detail=f"Circuit breaker open ({breaker_status.get('state', '')})",
                    subject_node_id=subject_node_id,
                    target_node_id=target_node_id,
                    session_id=session_id,
                    breaker_tripped=False,  # Already tripped earlier
                ))

            return degraded

        # Layer 3: FOK feasibility check
        # Map query_type to FOK-expected types
        fok_query_type = query_type.replace("_query", "")
        if fok_query_type not in ("definition", "classification", "inference"):
            fok_query_type = "definition"  # Safe fallback

        try:
            fok_result = await fok_check(
                neo4j_session=neo4j_session,
                persistence=self._persistence,
                query_type=fok_query_type,
                subject_node_id=subject_node_id,
                target_node_id=target_node_id,
            )
        except Exception as exc:
            # FOK check failure should not block the query -- fail open
            _log.warning(
                "error_coordinator: FOK check failed for %s/%s: %s -- "
                "proceeding without FOK guard",
                query_type,
                subject_node_id,
                exc,
            )
            return None

        if not fok_result.feasible:
            _log.info(
                "error_coordinator: FOK infeasible for %s/%s -- %s",
                query_type,
                subject_node_id,
                fok_result.reason,
            )

            degraded = build_degraded_response(
                reason=DegradationReason.FOK_INFEASIBLE,
                detail=fok_result.reason,
                query_type=query_type,
                subject_node_id=subject_node_id,
                target_node_id=target_node_id,
                fok_result=fok_result,
            )

            if self._event_bus is not None:
                await self._event_bus.publish(SemanticQueryErrorEvent(
                    query_type=query_type,
                    error_layer=3,
                    error_type="fok_infeasible",
                    detail=fok_result.reason,
                    subject_node_id=subject_node_id,
                    target_node_id=target_node_id,
                    session_id=session_id,
                ))

            return degraded

        return None

    def handle_hard_stop(
        self,
        error: HardStopError,
        query_type: str,
        subject_node_id: str,
        target_node_id: str = "",
        session_id: str = "",
    ) -> DegradedResponse:
        """Handle a Layer 1 hard stop error from a traversal.

        Converts the HardStopError to a DegradedResponse and records the
        error in the circuit breaker.

        Args:
            error: The HardStopError that was raised.
            query_type: The query type that errored.
            subject_node_id: The subject of the attempted query.
            target_node_id: The target (empty for definitions).
            session_id: Current session ID.

        Returns:
            DegradedResponse with honest limitation message.
        """
        # Map hard stop reason to degradation reason
        reason_map: dict[HardStopReason, DegradationReason] = {
            HardStopReason.CYCLE_DETECTED: DegradationReason.HARD_STOP_CYCLE,
            HardStopReason.TIMEOUT: DegradationReason.HARD_STOP_TIMEOUT,
            HardStopReason.AMBIGUITY: DegradationReason.HARD_STOP_AMBIGUITY,
            HardStopReason.WORKING_MEMORY_EXHAUSTED: DegradationReason.HARD_STOP_MEMORY,
        }

        degradation_reason = reason_map.get(
            error.reason, DegradationReason.UNKNOWN_ERROR
        )

        # Record in circuit breaker
        breaker_tripped = self._breaker.record_error(
            category=query_type,
            error_type=error.reason.value,
            detail=error.detail,
        )

        breaker_status = self._breaker.get_status(query_type)

        _log.warning(
            "error_coordinator: hard stop in %s -- reason=%s depth=%d "
            "visited=%d breaker_tripped=%s detail=%s",
            query_type,
            error.reason.value,
            error.depth_reached,
            error.visited_count,
            breaker_tripped,
            error.detail,
        )

        return build_degraded_response(
            reason=degradation_reason,
            detail=error.detail,
            query_type=query_type,
            subject_node_id=subject_node_id,
            target_node_id=target_node_id,
            breaker_status=breaker_status,
            hard_stop_reason=error.reason,
        )

    def record_success(self, query_type: str) -> None:
        """Record a successful query execution.

        Updates the circuit breaker (may close HALF_OPEN breakers).

        Args:
            query_type: The query type that succeeded.
        """
        self._breaker.record_success(query_type)

    def record_fok_outcome(
        self,
        fok_feasible: bool,
        query_produced_results: bool,
    ) -> None:
        """Record FOK prediction vs actual outcome for accuracy tracking.

        Args:
            fok_feasible: What FOK predicted.
            query_produced_results: Whether the query actually produced results.
        """
        self._fok_tracker.record_outcome(fok_feasible, query_produced_results)

    def session_reset(self) -> None:
        """Reset all error handling state for a new session.

        Clears circuit breaker errors (but preserves lifetime counters)
        and resets FOK accuracy tracking.
        """
        self._breaker.reset()
        self._fok_tracker.reset()
        _log.info("error_coordinator: session reset complete")

    def get_metrics(self) -> dict[str, Any]:
        """Get comprehensive error handling metrics.

        Returns a dict suitable for the T015 metrics framework, containing
        circuit breaker statuses and FOK accuracy summary.

        Returns:
            Dict with breaker_statuses and fok_accuracy keys.
        """
        return {
            "breaker_statuses": self._breaker.get_all_statuses(),
            "fok_accuracy": self._fok_tracker.summary(),
        }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    # Layer 1: Hard stops
    "HardStopReason",
    "HardStopError",
    "TraversalGuard",
    "check_cycle",
    "check_timeout",
    "check_working_memory",
    "check_ambiguity",
    "DEFAULT_TRAVERSAL_TIMEOUT_SECONDS",
    "DEFAULT_WORKING_MEMORY_BUDGET",
    "AMBIGUITY_CONFIDENCE_SPREAD",
    # Layer 2: Circuit breaker
    "BreakerState",
    "SemanticCircuitBreaker",
    "CircuitBreakerCategory",
    "ErrorRecord",
    "CIRCUIT_BREAKER_WINDOW_SECONDS",
    "CIRCUIT_BREAKER_THRESHOLD",
    "CIRCUIT_BREAKER_ISOLATION_SECONDS",
    # Layer 3: FOK check (re-exported integration)
    # (FOK itself lives in fok_check.py; integrated via ErrorHandlingCoordinator)
    # Degraded response
    "DegradationReason",
    "DegradedResponse",
    "build_degraded_response",
    # Cascade detection
    "CascadeResult",
    "cascade_invalidate",
    # Error blast radius
    "LOW_CENTRALITY_THRESHOLD",
    "HIGH_CENTRALITY_THRESHOLD",
    "compute_and_update_centrality",
    # Edge correction with cascade
    "EdgeCorrectionResult",
    "handle_edge_correction",
    # Events
    "SemanticQueryErrorEvent",
    # Coordinator
    "ErrorHandlingCoordinator",
]

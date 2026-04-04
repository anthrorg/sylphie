"""ScopeContextMechanics -- situated-to-categorical knowledge progression (P1.8-E2/T005).

Implements the Piagetian developmental mechanics for scope_context_count:
the progression from situated knowledge (count=1, context-bound) to
categorical knowledge (count>=threshold, generalizable across contexts).

Core responsibilities:

  1. increment_scope_count()
     Determines whether a re-assertion of an existing semantic edge occurs in
     a genuinely different ConversationContext, and if so, increments the edge
     scope_context_count. Same-session repetition does not increment -- only
     genuine contextual diversity counts.

  2. get_categorical_threshold()
     Reads the CATEGORICAL_KNOWLEDGE_THRESHOLD EvolutionRule node from the graph.
     Returns the configured threshold (default 3) below which a fact is situated
     and above which it is categorical. Guardian-tunable via the EvolutionRule node.

  3. compute_inference_hop_limit()
     Returns the maximum IS_A / PART_OF chain traversal depth allowed when
     reasoning about a fact, modulated by scope_context_count. Facts with low
     scope count get restricted hop limits (1 hop) to prevent shallow knowledge
     from propagating through long inference chains. Hop limit increases with
     scope_context_count: 1 at count=1, 2 at count=2, MAX at count>=threshold.
     When a homeostatic state is available, the hop limit is further modulated
     by arousal: high arousal expands limits, low arousal contracts them.

  4. filter_episodic_statement()
     Determines whether a guardian statement is episodic (specific past event)
     or semantic (general claim about the world). Episodic statements do not
     enter the assert_fact pipeline. This implements Tulving (1972) separation
     of semantic and episodic memory systems.

The CATEGORICAL_KNOWLEDGE_THRESHOLD EvolutionRule node:

  node_id: rule:categorical_knowledge_threshold
  node_type: EvolutionRule
  schema_level: META_SCHEMA
  properties:
    rule_name: CATEGORICAL_KNOWLEDGE_THRESHOLD
    current_value: 3
    description: Minimum scope_context_count for categorical knowledge
    tunable_by_guardian: True

Developmental grounding (Carey, 1978; Nelson, 1974; Barsalou, 2003):
  count=1: Situated knowledge -- confident in one context, hedged otherwise.
  count=2: Cross-context comparison begins. System notices the concept recurred.
  count>=3: Categorical knowledge -- reliable abstraction across contexts.

Phase 1.8 (P1.8-E2/T005). CANON A.1, A.18, A.20.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from cobeing.layer3_knowledge.node_types import KnowledgeEdge, KnowledgeNode, SchemaLevel
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import NodeFilter
from cobeing.layer3_knowledge.conversation_context_manager import (
    ConversationContextManager,
    ContextResolutionResult,
)
from cobeing.shared.event_bus import EventBus
from cobeing.shared.types import EdgeId, NodeId, CorrelationId

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CATEGORICAL_THRESHOLD_RULE_ID = "rule:categorical_knowledge_threshold"
_DEFAULT_CATEGORICAL_THRESHOLD: int = 3
_MAX_HOP_LIMIT: int = 5

# Episodic marker patterns -- phrases that signal a specific past event
# rather than a general semantic claim. Any statement beginning with these
# patterns is classified as episodic and filtered from assert_fact.
_EPISODIC_MARKERS: tuple[str, ...] = (
    "i saw", "i heard", "i noticed", "i found", "i observed",
    "yesterday", "today i", "this morning", "earlier today",
    "just now", "a moment ago", "last time",
    "the cat caught", "the dog ran",
)


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScopeIncrementResult:
    """Result of an increment_scope_count() call."""

    edge_id: str
    old_scope_context_count: int
    new_scope_context_count: int
    categorical_threshold: int
    is_now_categorical: bool
    context_changed: bool
    boundary_type: str
    skip_reason: str


@dataclass(frozen=True)
class EpisodicFilterResult:
    """Result of filter_episodic_statement()."""

    is_episodic: bool
    reason: str
    marker_matched: str


# ---------------------------------------------------------------------------
# Bootstrap helper: ensure CATEGORICAL_KNOWLEDGE_THRESHOLD rule exists
# ---------------------------------------------------------------------------


async def ensure_categorical_threshold_rule(persistence: GraphPersistence) -> None:
    """Ensure the CATEGORICAL_KNOWLEDGE_THRESHOLD EvolutionRule exists in the graph.

    Idempotent: if the node already exists, this is a no-op. Creates it
    with current_value=3 if absent. This rule is the guardian-tunable
    threshold for the situated-to-categorical knowledge transition.
    """
    from cobeing.layer3_knowledge.node_types import NodeStatus
    from cobeing.shared.provenance import Provenance, ProvenanceSource
    existing = await persistence.get_node(NodeId(CATEGORICAL_THRESHOLD_RULE_ID))
    if existing is not None:
        return

    rule_node = KnowledgeNode(
        node_id=NodeId(CATEGORICAL_THRESHOLD_RULE_ID),
        node_type="EvolutionRule",
        schema_level=SchemaLevel.META_SCHEMA,
        properties={
            "rule_name": "CATEGORICAL_KNOWLEDGE_THRESHOLD",
            "current_value": _DEFAULT_CATEGORICAL_THRESHOLD,
            "description": (
                "Minimum scope_context_count for a semantic fact to be classified "
                "as categorical knowledge. Facts below this threshold are situated "
                "(context-bound, hedged). At or above it they are categorical "
                "(generalizable across contexts). Default: 3 per Carey (1978). "
                "Tunable by guardian via graph edit."
            ),
            "tunable_by_guardian": True,
            "min_value": 2,
            "max_value": 10,
        },
        provenance=Provenance(source=ProvenanceSource.INFERENCE, source_id="scope-context-bootstrap", confidence=1.0),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )
    await persistence.save_node(rule_node)
    _log.info("ScopeContextMechanics: created CATEGORICAL_KNOWLEDGE_THRESHOLD rule (value=%d)", _DEFAULT_CATEGORICAL_THRESHOLD)


# ---------------------------------------------------------------------------
# ScopeContextMechanics
# ---------------------------------------------------------------------------


class ScopeContextMechanics:
    """Implement the Piagetian situated-to-categorical knowledge progression.

    This class is the central authority for scope_context_count semantics.
    It determines when a re-assertion of an existing semantic edge constitutes
    a genuinely new context (warranting count increment) vs. same-context
    repetition (which does not increment the count).

    Constructor injection for all dependencies.
    """

    def __init__(
        self,
        persistence: GraphPersistence,
        context_manager: ConversationContextManager,
        event_bus: EventBus | None = None,
    ) -> None:
        self._persistence = persistence
        self._context_manager = context_manager
        self._event_bus = event_bus

    async def increment_scope_count(
        self,
        edge_id: str,
        session_id: str,
        turn_id: str,
        correlation_id: str,
    ) -> ScopeIncrementResult:
        """Increment scope_context_count on a semantic edge if context changed.

        Reads the edge, resolves the active ConversationContext, and compares
        it against the context recorded on the edge. Increments the count only
        if the context has genuinely changed (session change, time gap, or
        topic shift).

        Same-session re-assertion returns a result with context_changed=False
        and the count unchanged. This is the key developmental invariant:
        scope_context_count measures contextual diversity, not utterance frequency.

        Args:
            edge_id: EdgeId of the semantic edge to update.
            session_id: Current conversation session identifier.
            turn_id: Current ConversationTurnNode ID.
            correlation_id: Trace ID for logging.

        Returns:
            ScopeIncrementResult with old/new count and categorical status.
        """
        edge = await self._persistence.get_edge(EdgeId(edge_id))
        if edge is None:
            _log.warning("ScopeContextMechanics: edge %r not found (corr=%s)", edge_id, correlation_id)
            return ScopeIncrementResult(
                edge_id=edge_id, old_scope_context_count=0, new_scope_context_count=0,
                categorical_threshold=await self.get_categorical_threshold(),
                is_now_categorical=False, context_changed=False,
                boundary_type="", skip_reason="edge_not_found",
            )

        old_count = edge.properties.get("scope_context_count", 1)
        edge_session = edge.properties.get("session_id", "")
        edge_ctx_id = edge.properties.get("conversation_context_id", "")

        # Resolve the active context for this assertion
        ctx_result: ContextResolutionResult = await self._context_manager.resolve_context_for_assertion(
            session_id=session_id,
            turn_id=turn_id,
            correlation_id=correlation_id,
        )

        # Determine if the context has genuinely changed
        # A new context (boundary detected) always means context changed.
        # Even if no boundary was detected, check session change as a fallback.
        context_changed = (
            ctx_result.is_new_context
            or (edge_session and edge_session != session_id)
            or (edge_ctx_id and edge_ctx_id != ctx_result.context_node_id)
        )

        # Same-session repetition guard:
        # If the edge was created in this same session AND no new context was
        # declared (boundary_type == none or initial), do not increment.
        # This prevents gaming via rapid same-session repetition.
        if not context_changed and edge_session == session_id:
            threshold = await self.get_categorical_threshold()
            _log.debug(
                "ScopeContextMechanics: same session %r -- no increment for edge %r (corr=%s)",
                session_id, edge_id, correlation_id,
            )
            return ScopeIncrementResult(
                edge_id=edge_id, old_scope_context_count=old_count,
                new_scope_context_count=old_count,
                categorical_threshold=threshold,
                is_now_categorical=old_count >= threshold,
                context_changed=False,
                boundary_type=ctx_result.boundary_type,
                skip_reason="same_session_repetition",
            )

        threshold = await self.get_categorical_threshold()

        if context_changed:
            new_count = old_count + 1
            edge.properties["scope_context_count"] = new_count
            edge.properties["last_context_session"] = session_id
            edge.properties["last_context_id"] = ctx_result.context_node_id
            await self._persistence.save_edge(edge)

            is_categorical = new_count >= threshold
            _log.info(
                "ScopeContextMechanics: scope incremented %d -> %d for edge %r (boundary=%s categorical=%s corr=%s)",
                old_count, new_count, edge_id, ctx_result.boundary_type, is_categorical, correlation_id,
            )

            await self._publish_scope_updated_event(
                edge=edge,
                old_count=old_count,
                new_count=new_count,
                threshold=threshold,
                is_categorical=is_categorical,
                boundary_type=ctx_result.boundary_type,
                session_id=session_id,
                correlation_id=correlation_id,
            )

            return ScopeIncrementResult(
                edge_id=edge_id, old_scope_context_count=old_count,
                new_scope_context_count=new_count,
                categorical_threshold=threshold,
                is_now_categorical=is_categorical,
                context_changed=True,
                boundary_type=ctx_result.boundary_type,
                skip_reason="",
            )

        # No context change and different session -- should not normally reach here
        return ScopeIncrementResult(
            edge_id=edge_id, old_scope_context_count=old_count,
            new_scope_context_count=old_count,
            categorical_threshold=threshold,
            is_now_categorical=old_count >= threshold,
            context_changed=False,
            boundary_type=ctx_result.boundary_type,
            skip_reason="no_context_change",
        )
    async def get_categorical_threshold(self) -> int:
        """Read the CATEGORICAL_KNOWLEDGE_THRESHOLD from the EvolutionRule graph node.

        Reads the current_value property of rule:categorical_knowledge_threshold.
        Falls back to _DEFAULT_CATEGORICAL_THRESHOLD (3) if the node is absent.
        This makes the threshold guardian-tunable without code changes."""
        rule_node = await self._persistence.get_node(NodeId(CATEGORICAL_THRESHOLD_RULE_ID))
        if rule_node is None:
            _log.debug("ScopeContextMechanics: CATEGORICAL_KNOWLEDGE_THRESHOLD rule missing -- using default %d", _DEFAULT_CATEGORICAL_THRESHOLD)
            return _DEFAULT_CATEGORICAL_THRESHOLD
        val = rule_node.properties.get("current_value", _DEFAULT_CATEGORICAL_THRESHOLD)
        try:
            return int(val)
        except (TypeError, ValueError):
            _log.warning("ScopeContextMechanics: current_value=%r invalid -- using default", val)
            return _DEFAULT_CATEGORICAL_THRESHOLD

    def compute_inference_hop_limit(
        self,
        scope_context_count: int,
        categorical_threshold: int,
        homeostatic_arousal: float | None = None,
    ) -> int:
        """Compute the maximum inference hop limit for a semantic edge.

        The hop limit controls how many IS_A or PART_OF chain hops are followed
        when reasoning about a fact. Facts with low scope_context_count get
        restricted hop limits to prevent shallow knowledge from propagating
        through long inference chains.

        Developmental basis (Piaget concrete operations):
          scope=1 (situated): 1 hop -- the fact is context-bound, inference
            from it should be minimal. A fact heard once is not a reliable
            basis for multi-step reasoning.
          scope=2 (emerging): 2 hops -- cross-context comparison has begun.
            Moderate inference allowed.
          scope>=threshold (categorical): MAX_HOP_LIMIT -- full inference.
            The fact is reliably generalizable and can support deep chaining.

        Homeostatic modulation (when homeostatic layer available):
          arousal > 0.7 (high): +1 hop (exploratory state)
          arousal < 0.3 (low): -1 hop (conservative state)
          arousal = None: no modulation

        Args:
            scope_context_count: Current count on the semantic edge.
            categorical_threshold: Threshold from CATEGORICAL_KNOWLEDGE_THRESHOLD rule.
            homeostatic_arousal: Current arousal level [0.0, 1.0] or None.

        Returns:
            Integer hop limit >= 1.
        """
        if scope_context_count >= categorical_threshold:
            base_limit = _MAX_HOP_LIMIT
        elif scope_context_count == 2:
            base_limit = 2
        else:
            base_limit = 1

        if homeostatic_arousal is not None:
            if homeostatic_arousal > 0.7:
                base_limit = min(_MAX_HOP_LIMIT, base_limit + 1)
            elif homeostatic_arousal < 0.3:
                base_limit = max(1, base_limit - 1)

        return base_limit
    def filter_episodic_statement(self, raw_text: str) -> EpisodicFilterResult:
        """Determine whether a guardian statement is episodic or semantic.

        Episodic statements describe specific past events and should not enter
        the assert_fact pipeline. Semantic statements make general claims about
        the world and are the target of assert_fact.

        Detection method: simple prefix matching against _EPISODIC_MARKERS.
        This is intentionally conservative -- false positives (classifying a
        semantic statement as episodic) are less harmful than false negatives
        (classifying an episodic statement as semantic and polluting the graph).

        Args:
            raw_text: The guardian utterance verbatim.

        Returns:
            EpisodicFilterResult with is_episodic flag and matched marker.
        """
        normalized = raw_text.strip().lower()
        for marker in _EPISODIC_MARKERS:
            if normalized.startswith(marker):
                return EpisodicFilterResult(
                    is_episodic=True,
                    reason="episodic_marker_matched",
                    marker_matched=marker,
                )
        return EpisodicFilterResult(is_episodic=False, reason="", marker_matched="")

    async def _publish_scope_updated_event(
        self,
        edge: KnowledgeEdge,
        old_count: int,
        new_count: int,
        threshold: int,
        is_categorical: bool,
        boundary_type: str,
        session_id: str,
        correlation_id: str,
    ) -> None:
        """Publish ScopeContextCountUpdatedEvent to the event bus."""
        if self._event_bus is None:
            return
        try:
            from cobeing.shared.event_types import ScopeContextCountUpdatedEvent
            event = ScopeContextCountUpdatedEvent(
                edge_id=str(edge.edge_id),
                source_node_id=str(edge.source_id),
                target_node_id=str(edge.target_id),
                edge_type=edge.edge_type,
                subject_lemma=edge.properties.get("subject_lemma", ""),
                object_lemma=edge.properties.get("object_lemma", ""),
                old_scope_context_count=old_count,
                new_scope_context_count=new_count,
                categorical_threshold=threshold,
                is_now_categorical=is_categorical,
                boundary_type=boundary_type,
                session_id=session_id,
                correlation_id=CorrelationId(correlation_id),
            )
            await self._event_bus.publish(event)
        except Exception as exc:
            _log.warning("ScopeContextMechanics: failed to publish ScopeContextCountUpdatedEvent: %s", exc)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    "ScopeContextMechanics",
    "ScopeIncrementResult",
    "EpisodicFilterResult",
    "CATEGORICAL_THRESHOLD_RULE_ID",
    "ensure_categorical_threshold_rule",
]

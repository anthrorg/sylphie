"""ConversationContextManager -- ConversationContext node lifecycle (P1.8-E2/T005).

Manages creation, retrieval, closure, and boundary detection for
ConversationContext INSTANCE nodes. Context boundaries declared when:
  1. Session change: new session_id from orchestration layer.
  2. Topic shift: Jaccard similarity < topic_shift_threshold (default 0.15).
  3. Time gap: > time_gap_minutes since last context update (default 30).

Primary entry: resolve_context_for_assertion() -- assert_fact Step 5.

Boundary labels: session_change, time_gap, topic_shift, initial, none.

Design: Conservative thresholds prevent scope_context_count inflation per
Piaget P1.8-E2 analysis section 1.

Phase 1.8 (P1.8-E2/T005). CANON A.1, A.18, A.20.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from cobeing.layer3_knowledge.language_types import CONVERSATION_TURN_NODE
from cobeing.layer3_knowledge.node_types import KnowledgeNode, NodeStatus, SchemaLevel
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import NodeFilter
from cobeing.layer3_knowledge.semantic_types import CONVERSATION_CONTEXT
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import NodeId

_log = logging.getLogger(__name__)

# Default thresholds -- overridable via EvolutionRule injection at construction
_DEFAULT_TIME_GAP_MINUTES: float = 30.0
_DEFAULT_TOPIC_SHIFT_THRESHOLD: float = 0.15
_TOPIC_COMPARISON_WINDOW: int = 5


@dataclass(frozen=True)
class ContextResolutionResult:
    """Result of resolving the active ConversationContext for an assertion."""

    context_node_id: str
    is_new_context: bool
    boundary_type: str
    prior_context_node_id: str

class ConversationContextManager:
    """Manage ConversationContext node lifecycle and boundary detection."""

    def __init__(
        self,
        persistence: GraphPersistence,
        time_gap_minutes: float = _DEFAULT_TIME_GAP_MINUTES,
        topic_shift_threshold: float = _DEFAULT_TOPIC_SHIFT_THRESHOLD,
    ) -> None:
        self._persistence = persistence
        self._time_gap_minutes = time_gap_minutes
        self._topic_shift_threshold = topic_shift_threshold

    async def resolve_context_for_assertion(
        self,
        session_id: str,
        turn_id: str,
        correlation_id: str,
    ) -> ContextResolutionResult:
        """Return the active ConversationContext node_id for an assertion."""
        active_ctx = await self._find_active_context(session_id)

        # Case 1: No prior active context
        if active_ctx is None:
            new_id = await self._create_context_node(session_id, turn_id, correlation_id)
            _log.info("CCM: initial context %r session=%r (corr=%s)", str(new_id), session_id, correlation_id)
            return ContextResolutionResult(
                context_node_id=str(new_id), is_new_context=True,
                boundary_type="initial", prior_context_node_id="",
            )

        # Case 2: Session change
        ctx_session = active_ctx.properties.get("session_id", "")
        if ctx_session and ctx_session != session_id:
            prior_id = str(active_ctx.node_id)
            await self._close_context_node(active_ctx, "session_change")
            new_id = await self._create_context_node(session_id, turn_id, correlation_id)
            _log.info("CCM: session_change closed=%r created=%r (corr=%s)", prior_id, str(new_id), correlation_id)
            return ContextResolutionResult(
                context_node_id=str(new_id), is_new_context=True,
                boundary_type="session_change", prior_context_node_id=prior_id,
            )

        # Case 3: Time gap
        if self._check_time_gap(active_ctx):
            prior_id = str(active_ctx.node_id)
            await self._close_context_node(active_ctx, "time_gap")
            new_id = await self._create_context_node(session_id, turn_id, correlation_id)
            _log.info("CCM: time_gap closed=%r created=%r (corr=%s)", prior_id, str(new_id), correlation_id)
            return ContextResolutionResult(
                context_node_id=str(new_id), is_new_context=True,
                boundary_type="time_gap", prior_context_node_id=prior_id,
            )

        # Case 4: Topic shift
        if await self._check_topic_shift(session_id, turn_id, correlation_id):
            prior_id = str(active_ctx.node_id)
            await self._close_context_node(active_ctx, "topic_shift")
            new_id = await self._create_context_node(session_id, turn_id, correlation_id)
            _log.info("CCM: topic_shift closed=%r created=%r (corr=%s)", prior_id, str(new_id), correlation_id)
            return ContextResolutionResult(
                context_node_id=str(new_id), is_new_context=True,
                boundary_type="topic_shift", prior_context_node_id=prior_id,
            )

        # Case 5: No boundary -- touch and return
        await self._touch_context_node(active_ctx)
        _log.debug("CCM: no boundary -- reusing %r (corr=%s)", str(active_ctx.node_id), correlation_id)
        return ContextResolutionResult(
            context_node_id=str(active_ctx.node_id), is_new_context=False,
            boundary_type="none", prior_context_node_id="",
        )
    async def _find_active_context(self, session_id: str) -> KnowledgeNode | None:
        all_ctxs = await self._persistence.query_nodes(NodeFilter(node_type=CONVERSATION_CONTEXT))
        active = [n for n in all_ctxs if n.properties.get("status", "ACTIVE") == "ACTIVE" and not n.properties.get("closed", False)]
        if not active:
            return None
        sess_ctxs = [n for n in active if n.properties.get("session_id", "") == session_id]
        if sess_ctxs:
            return max(sess_ctxs, key=lambda n: n.properties.get("created_at", ""))
        return max(active, key=lambda n: n.properties.get("created_at", ""))
    async def _create_context_node(self, session_id: str, turn_id: str, correlation_id: str) -> NodeId:
        now = datetime.now(UTC)
        node_id = NodeId(f"context:{session_id}:{uuid.uuid4().hex[:8]}")
        ctx = KnowledgeNode(
            node_id=node_id, node_type=CONVERSATION_CONTEXT, schema_level=SchemaLevel.INSTANCE,
            properties={
                "session_id": session_id, "first_turn_id": turn_id,
                "created_at": now.isoformat(), "updated_at": now.isoformat(),
                "closed_at": None, "status": "ACTIVE", "closed": False,
                "closure_reason": None, "mentioned_sense_ids": [], "turn_count": 0,
            },
            provenance=Provenance(source=ProvenanceSource.INFERENCE, source_id=session_id, confidence=1.0),
            confidence=1.0, status=NodeStatus.ACTIVE,
        )
        await self._persistence.save_node(ctx)
        return node_id
    async def _close_context_node(self, ctx: KnowledgeNode, reason: str) -> None:
        now = datetime.now(UTC)
        ctx.properties["status"] = "CLOSED"
        ctx.properties["closed"] = True
        ctx.properties["closed_at"] = now.isoformat()
        ctx.properties["closure_reason"] = reason
        await self._persistence.save_node(ctx)

    async def _touch_context_node(self, ctx: KnowledgeNode) -> None:
        now = datetime.now(UTC)
        ctx.properties["updated_at"] = now.isoformat()
        ctx.properties["turn_count"] = ctx.properties.get("turn_count", 0) + 1
        await self._persistence.save_node(ctx)

    def _check_time_gap(self, ctx: KnowledgeNode) -> bool:
        updated_at_str = ctx.properties.get("updated_at", "")
        if not updated_at_str:
            return False
        try:
            ua = datetime.fromisoformat(updated_at_str)
            if ua.tzinfo is None:
                ua = ua.replace(tzinfo=UTC)
        except (ValueError, TypeError):
            return False
        elapsed = (datetime.now(UTC) - ua).total_seconds() / 60.0
        return elapsed > self._time_gap_minutes
    async def _check_topic_shift(self, session_id: str, current_turn_id: str, correlation_id: str) -> bool:
        all_turns = await self._persistence.query_nodes(NodeFilter(node_type=CONVERSATION_TURN_NODE))
        sess_turns = [t for t in all_turns if t.properties.get("session_id", "") == session_id and str(t.node_id) != current_turn_id]
        if len(sess_turns) < 2 * _TOPIC_COMPARISON_WINDOW:
            return False
        try:
            sorted_t = sorted(sess_turns, key=lambda t: t.properties.get("sequence_number", 0))
        except TypeError:
            sorted_t = sorted(sess_turns, key=lambda t: str(t.node_id))
        recent = sorted_t[-_TOPIC_COMPARISON_WINDOW:]
        prior = sorted_t[-2 * _TOPIC_COMPARISON_WINDOW: -_TOPIC_COMPARISON_WINDOW]
        r_senses = _extract_senses(recent)
        p_senses = _extract_senses(prior)
        if not r_senses or not p_senses:
            return False
        inter = len(r_senses & p_senses)
        union = len(r_senses | p_senses)
        jaccard = inter / union if union > 0 else 1.0
        return jaccard < self._topic_shift_threshold


def _extract_senses(turns: list[KnowledgeNode]) -> set[str]:
    result: set[str] = set()
    for turn in turns:
        ids = turn.properties.get("mentioned_sense_ids", [])
        if isinstance(ids, list):
            result.update(str(s) for s in ids if s)
    return result


__all__ = ["ConversationContextManager", "ContextResolutionResult"]

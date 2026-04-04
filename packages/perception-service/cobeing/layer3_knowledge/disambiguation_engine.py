"""DisambiguationEngine -- lexical chain WSD over the PRECEDES/MENTIONS subgraph.

Implements word sense disambiguation (WSD) via lexical chains: when the
same spelling maps to multiple WordSenseNode entries (polysemy), the engine
walks the recent conversation history (PRECEDES chain) and accumulates
salience scores from MENTIONS edges to determine which sense is most
contextually relevant.

Algorithm:

1. Find all WordSenseNode entries whose ``spelling`` property matches
   the target word.
2. If 0 senses: escalate (unknown word).
3. If 1 sense: return immediately with full confidence.
4. If multiple senses: walk backwards along the PRECEDES chain from
   the current turn, gathering MENTIONS edges.  Score each candidate
   sense by recency-weighted salience accumulation.
5. If the top score >= 0.7: return ``"lexical_chain"`` strategy.
6. Otherwise: return ``"escalate"`` (ambiguity cannot be resolved
   from context alone).

Phase 1.7-E4 (P1.7-E4-T06). CANON A.18.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from cobeing.layer3_knowledge.language_types import (
    MENTIONS,
    PRECEDES,
    SAME_SPELLING,
    WORD_SENSE_NODE,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter
from cobeing.shared.types import NodeId

_logger = logging.getLogger(__name__)

# Maximum number of turns to walk backwards in the PRECEDES chain.
_MAX_CHAIN_HOPS = 10

# Minimum score for a sense to be selected without escalation.
_SELECTION_THRESHOLD = 0.7

# Recency decay factor per hop: score *= _DECAY ** hop_count.
_DECAY = 0.9


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DisambiguationResult:
    """Outcome of word sense disambiguation.

    Attributes:
        selected_sense_id: The NodeId of the chosen WordSenseNode,
            or ``None`` if disambiguation could not resolve the
            ambiguity (``strategy == "escalate"``).
        confidence: Confidence of the selection. 1.0 for single-sense
            words, the accumulated score for lexical-chain selections,
            or 0.0 when escalating.
        strategy: How the result was obtained. One of:
            ``"lexical_chain"`` -- resolved by recency-weighted context.
            ``"single_sense"`` -- only one sense exists; no ambiguity.
            ``"escalate"`` -- could not resolve; needs guardian help.
        candidate_senses: All candidate senses sorted by score
            descending. Each entry is ``(sense_node_id, score)``.
    """

    selected_sense_id: NodeId | None
    confidence: float
    strategy: str
    candidate_senses: list[tuple[NodeId, float]]


# ---------------------------------------------------------------------------
# DisambiguationEngine
# ---------------------------------------------------------------------------


class DisambiguationEngine:
    """Lexical-chain word sense disambiguation engine.

    Resolves polysemy by scoring candidate WordSenseNode entries
    against the recent conversation context.  The PRECEDES chain
    provides temporal ordering; MENTIONS edges provide salience
    signals; SAME_SPELLING edges link competing senses.

    Args:
        persistence: The graph persistence backend.
    """

    def __init__(self, persistence: GraphPersistence) -> None:
        self._persistence = persistence

    async def disambiguate(
        self,
        spelling: str,
        from_turn_id: NodeId,
    ) -> DisambiguationResult:
        """Disambiguate *spelling* given the conversation context at *from_turn_id*.

        Args:
            spelling: The surface spelling to disambiguate (e.g. ``"bank"``).
            from_turn_id: NodeId of the current ConversationTurnNode.
                The engine walks backwards along PRECEDES edges from
                this turn to gather context.

        Returns:
            A :class:`DisambiguationResult` with the selected sense (if
            any), confidence, strategy, and all candidate scores.
        """
        # Step 1: Find all WordSenseNodes matching spelling
        all_senses = await self._persistence.query_nodes(
            NodeFilter(node_type=WORD_SENSE_NODE)
        )
        matching_senses = [
            n for n in all_senses
            if n.properties.get("spelling") == spelling
        ]

        # Step 2: Zero senses -- escalate
        if not matching_senses:
            _logger.info(
                "disambiguation_no_senses spelling=%s", spelling
            )
            return DisambiguationResult(
                selected_sense_id=None,
                confidence=0.0,
                strategy="escalate",
                candidate_senses=[],
            )

        # Step 3: Single sense -- no ambiguity
        if len(matching_senses) == 1:
            sense_id = NodeId(matching_senses[0].node_id)
            _logger.info(
                "disambiguation_single_sense spelling=%s sense_id=%s",
                spelling,
                sense_id,
            )
            return DisambiguationResult(
                selected_sense_id=sense_id,
                confidence=1.0,
                strategy="single_sense",
                candidate_senses=[(sense_id, 1.0)],
            )

        # Step 4: Multiple senses -- lexical chain disambiguation
        sense_ids = {NodeId(n.node_id) for n in matching_senses}
        scores: dict[NodeId, float] = {sid: 0.0 for sid in sense_ids}

        # Also collect SAME_SPELLING-linked senses for indirect scoring
        same_spelling_map = await self._build_same_spelling_map(sense_ids)

        # Walk PRECEDES chain backwards from from_turn_id
        current_id = from_turn_id
        for hop in range(_MAX_CHAIN_HOPS):
            # Gather MENTIONS edges from current turn
            mentions_edges = await self._persistence.query_edges(
                EdgeFilter(
                    edge_type=MENTIONS,
                    source_node_id=current_id,
                )
            )

            for edge in mentions_edges:
                mentioned_id = NodeId(edge.target_id)
                salience = edge.properties.get("salience", 0.5)
                weighted = salience * (_DECAY ** hop)

                # Direct match: mentioned sense is one of our candidates
                if mentioned_id in scores:
                    scores[mentioned_id] += weighted

                # Indirect match: mentioned sense is SAME_SPELLING-linked
                # to one of our candidates
                for candidate_id, linked_ids in same_spelling_map.items():
                    if mentioned_id in linked_ids:
                        scores[candidate_id] += weighted * 0.5

            # Walk backwards: find PRECEDES edge where target == current_id
            precedes_edges = await self._persistence.query_edges(
                EdgeFilter(
                    edge_type=PRECEDES,
                    target_node_id=current_id,
                )
            )

            if not precedes_edges:
                # No earlier turn; chain ends
                break

            # Move to the previous turn (source of the PRECEDES edge)
            current_id = NodeId(precedes_edges[0].source_id)

        # Step 5: Sort candidates by score descending
        sorted_candidates = sorted(
            scores.items(), key=lambda item: item[1], reverse=True
        )

        max_score = sorted_candidates[0][1] if sorted_candidates else 0.0

        # Step 6: Threshold check
        if max_score >= _SELECTION_THRESHOLD:
            selected = sorted_candidates[0][0]
            _logger.info(
                "disambiguation_lexical_chain spelling=%s selected=%s "
                "score=%.3f candidates=%d",
                spelling,
                selected,
                max_score,
                len(sorted_candidates),
            )
            return DisambiguationResult(
                selected_sense_id=selected,
                confidence=max_score,
                strategy="lexical_chain",
                candidate_senses=sorted_candidates,
            )

        # Step 7: Below threshold -- escalate
        _logger.info(
            "disambiguation_escalate spelling=%s max_score=%.3f "
            "candidates=%d",
            spelling,
            max_score,
            len(sorted_candidates),
        )
        return DisambiguationResult(
            selected_sense_id=None,
            confidence=max_score,
            strategy="escalate",
            candidate_senses=sorted_candidates,
        )

    # ------------------------------------------------------------------
    # SAME_SPELLING map builder
    # ------------------------------------------------------------------

    async def _build_same_spelling_map(
        self,
        sense_ids: set[NodeId],
    ) -> dict[NodeId, set[NodeId]]:
        """Build a map from each candidate sense to its SAME_SPELLING-linked senses.

        For each candidate sense, queries outgoing and incoming
        SAME_SPELLING edges to find related senses.  These indirect
        connections allow context from a related sense to boost the
        score of a candidate.

        Args:
            sense_ids: Set of candidate WordSenseNode IDs.

        Returns:
            Dict mapping each candidate sense ID to a set of
            SAME_SPELLING-linked sense IDs (excluding itself).
        """
        result: dict[NodeId, set[NodeId]] = {sid: set() for sid in sense_ids}

        for sid in sense_ids:
            # Outgoing SAME_SPELLING edges
            out_edges = await self._persistence.query_edges(
                EdgeFilter(
                    edge_type=SAME_SPELLING,
                    source_node_id=sid,
                )
            )
            for edge in out_edges:
                linked = NodeId(edge.target_id)
                if linked != sid:
                    result[sid].add(linked)

            # Incoming SAME_SPELLING edges
            in_edges = await self._persistence.query_edges(
                EdgeFilter(
                    edge_type=SAME_SPELLING,
                    target_node_id=sid,
                )
            )
            for edge in in_edges:
                linked = NodeId(edge.source_id)
                if linked != sid:
                    result[sid].add(linked)

        return result


__all__ = [
    "DisambiguationEngine",
    "DisambiguationResult",
]

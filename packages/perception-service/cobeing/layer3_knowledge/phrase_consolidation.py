"""PhraseConsolidator -- the developmental gate for organic language acquisition.

This is where CB's language learning actually happens. The consolidation engine
evaluates heard phrases (PhraseNodes) during maintenance idle periods and
decides when CB has heard something enough to say it (CAN_PRODUCE promotion).

The consolidation cycle performs:
1. Query all PhraseNodes from graph
2. Recalculate confidence with per-type decay (d=0.03)
3. Increment encounter_count (one per consolidation cycle, spacing enforced)
4. Internal rehearsal: add 0.5 to rehearsal_credits; when >= 1.0, convert
   to encounter_count increment
5. Compute weighted readiness score (hard floor of 3 encounters)
6. If readiness >= 1.0: create CAN_PRODUCE edge from action:speak
7. Extract discriminative_context from HEARD_DURING edge patterns
8. Compute readiness metrics for guardian dashboard

CANON basis:
    A.17.3 -- Per-type ACT-R decay rates (PhraseNode d=0.03)
    A.24.3.2 -- Encoding strength from prediction error
    A.26.1 -- The Maintenance Gate
    A.26.2 -- PhraseNode properties
    A.26.3 -- Edge types (CAN_PRODUCE, HEARD_DURING)
    A.26.4 -- Spacing effect and reconsolidation lability
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from cobeing.layer3_knowledge.instance_confidence import (
    K,
    PHRASE_DECAY_RATE,
    hours_since,
)
from cobeing.layer3_knowledge.language_types import (
    CAN_PRODUCE,
    HEARD_DURING,
    IS_PART_OF,
    PHRASE_NODE,
    VARIANT_OF,
    WORD_NODE,
)
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

if TYPE_CHECKING:
    from cobeing.layer3_knowledge.protocols import GraphPersistence

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

INTERNAL_REHEARSAL_WEIGHT: float = 0.5
"""Rehearsal credits added per consolidation cycle. When >= 1.0, converts
to an encounter_count increment. CANON A.26.4."""

UNCONSOLIDATED_DECAY_FACTOR: float = 0.5
"""PhraseNodes that haven't been consolidated yet use half the decay rate
(0.015 instead of 0.03). Protects new phrases from decaying before the
consolidation engine gets to them."""

CROSS_SESSION_SPACING_BONUS: float = 1.5
"""Confidence increment multiplier for cross-session encounters. CANON A.26.4."""

SPEAK_ACTION_NODE_ID: str = "action:speak"
"""Node ID for the speak action. CAN_PRODUCE edges point FROM this node."""

# ---------------------------------------------------------------------------
# Phrase clustering constants
# ---------------------------------------------------------------------------

CLUSTER_OVERLAP_THRESHOLD: float = 0.6
"""Minimum word-set overlap ratio to consider two phrases as variants."""

# ---------------------------------------------------------------------------
# Word-level CAN_PRODUCE constants
# ---------------------------------------------------------------------------

WORD_MIN_PHRASE_COUNT: int = 3
"""Word must appear in at least this many distinct phrases to be promotable."""

WORD_MIN_TOTAL_ENCOUNTERS: int = 10
"""Sum of encounter_count across containing phrases must exceed this."""

WORD_INITIAL_PRODUCTION_CONFIDENCE: float = 0.0
"""Initial production_confidence for word-level CAN_PRODUCE edges.
Same as phrase CAN_PRODUCE -- starts at 0.0, novelty bonus handles first use."""

# Function words that should never be promoted to standalone speech.
_FUNCTION_WORDS: frozenset[str] = frozenset({
    "a", "an", "the", "is", "am", "are", "was", "were", "be", "been",
    "do", "does", "did", "have", "has", "had", "to", "of", "in", "on",
    "at", "for", "and", "or", "but", "not", "it", "that", "this",
    "with", "from", "by", "if", "so", "as", "no", "i",
})


# ---------------------------------------------------------------------------
# Report types
# ---------------------------------------------------------------------------


@dataclass
class PhraseReadiness:
    """Readiness metrics for a single PhraseNode."""

    phrase_id: str
    normalized_text: str
    encounter_count: int
    confidence: float
    readiness_score: float
    promoted: bool = False
    encounters_to_threshold: int = 0


@dataclass
class PhraseConsolidationReport:
    """Result of a consolidation cycle."""

    phrases_processed: int = 0
    promoted: int = 0
    pruned: int = 0
    rehearsed: int = 0
    encounter_incremented: int = 0
    clusters_created: int = 0
    variant_edges_created: int = 0
    words_promoted: int = 0
    readiness_metrics: list[PhraseReadiness] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# PhraseConsolidator
# ---------------------------------------------------------------------------


class PhraseConsolidator:
    """Evaluates PhraseNodes and promotes them to producible via CAN_PRODUCE.

    Args:
        graph: Graph persistence backend.
    """

    def __init__(self, graph: GraphPersistence) -> None:
        self._graph = graph

    async def count_phrase_nodes(self) -> int:
        """Count PhraseNodes in the graph. Used by maintenance for staging."""
        nodes = await self._graph.query_nodes(
            NodeFilter(node_type=PHRASE_NODE),
        )
        return len(nodes)

    async def run_consolidation(self) -> PhraseConsolidationReport:
        """Run one consolidation cycle over all PhraseNodes.

        Returns:
            Report summarizing what was processed, promoted, and pruned.
        """
        report = PhraseConsolidationReport()
        now = datetime.now(UTC)

        # Load promotion criteria from meta-schema rules
        criteria = await self._load_promotion_criteria()

        # Query all PhraseNodes
        phrase_nodes = await self._graph.query_nodes(
            NodeFilter(node_type=PHRASE_NODE),
        )

        for node in phrase_nodes:
            try:
                await self._process_phrase(node, criteria, now, report)
                report.phrases_processed += 1
            except Exception as exc:
                report.errors.append(
                    f"{node.node_id}: {exc}"
                )
                logger.warning(
                    "phrase_consolidation_error node_id=%s error=%s",
                    node.node_id,
                    exc,
                )

        # ------------------------------------------------------------------
        # Post-processing passes: clustering and word-level promotion
        # ------------------------------------------------------------------
        try:
            await self._cluster_phrase_variants(phrase_nodes, now, report)
        except Exception as exc:
            report.errors.append(f"clustering: {exc}")
            logger.warning("phrase_clustering_error error=%s", exc)

        try:
            await self._promote_words(phrase_nodes, now, report)
        except Exception as exc:
            report.errors.append(f"word_promotion: {exc}")
            logger.warning("word_promotion_error error=%s", exc)

        logger.info(
            "phrase_consolidation_complete processed=%d promoted=%d "
            "rehearsed=%d encounters_inc=%d clusters=%d variant_edges=%d "
            "words_promoted=%d",
            report.phrases_processed,
            report.promoted,
            report.rehearsed,
            report.encounter_incremented,
            report.clusters_created,
            report.variant_edges_created,
            report.words_promoted,
        )
        return report

    # ------------------------------------------------------------------
    # Internal processing
    # ------------------------------------------------------------------

    async def _process_phrase(
        self,
        node: KnowledgeNode,
        criteria: dict[str, Any],
        now: datetime,
        report: PhraseConsolidationReport,
    ) -> None:
        """Process a single PhraseNode: decay, rehearse, promote."""
        props = dict(node.properties)
        phrase_id = str(node.node_id)

        # -- Recalculate confidence with per-type decay --
        encounter_count = int(props.get("encounter_count", 0))
        last_heard = props.get("last_heard")
        consolidated = props.get("consolidated", False)

        hours_elapsed = hours_since(last_heard)
        decay_rate = PHRASE_DECAY_RATE
        if not consolidated:
            decay_rate = PHRASE_DECAY_RATE * UNCONSOLIDATED_DECAY_FACTOR

        base_confidence = float(props.get("confidence", 0.15))
        n = max(1, encounter_count)
        new_confidence = min(
            1.0,
            max(0.0, base_confidence + K * math.log(n) - decay_rate * math.log(hours_elapsed + 1)),
        )

        # -- Reconsolidation lability window --
        lability_window = float(criteria.get("lability_window_minutes", 10))
        lability_amplifier = float(criteria.get("lability_amplifier", 1.5))
        last_retrieved = props.get("last_retrieved")
        in_lability = False
        if last_retrieved:
            minutes_since_retrieval = hours_since(last_retrieved) * 60.0
            in_lability = minutes_since_retrieval <= lability_window

        # -- Spacing: increment encounter_count (once per consolidation) --
        # Only if the phrase has been heard since last consolidation
        # (last_heard > last_retrieved indicates new data)
        should_increment = False
        if not consolidated:
            # First consolidation: always count it
            should_increment = True
        elif last_heard and last_retrieved:
            # Only increment if heard more recently than last retrieval
            try:
                lh = datetime.fromisoformat(last_heard)
                lr = datetime.fromisoformat(last_retrieved)
                if lh.tzinfo is None:
                    lh = lh.replace(tzinfo=UTC)
                if lr.tzinfo is None:
                    lr = lr.replace(tzinfo=UTC)
                should_increment = lh > lr
            except (ValueError, TypeError):
                should_increment = False

        if should_increment:
            confidence_increment = 0.12  # K constant
            if in_lability:
                confidence_increment *= lability_amplifier
            # Check for cross-session spacing bonus
            session_bonus = await self._check_cross_session(phrase_id)
            if session_bonus:
                confidence_increment *= CROSS_SESSION_SPACING_BONUS

            encounter_count += 1
            new_confidence = min(1.0, new_confidence + confidence_increment)
            report.encounter_incremented += 1

        # -- Internal rehearsal: 0.5x credit per cycle --
        rehearsal_credits = float(props.get("rehearsal_credits", 0.0))
        rehearsal_credits += INTERNAL_REHEARSAL_WEIGHT
        report.rehearsed += 1

        # Convert rehearsal credits to encounters when >= 1.0
        if rehearsal_credits >= 1.0:
            encounter_count += 1
            rehearsal_credits -= 1.0
            report.encounter_incremented += 1

        # -- Compute weighted readiness score --
        hard_floor = int(criteria.get("hard_floor_encounters", 3))
        weights = criteria.get("weights", {})
        thresholds = criteria.get("thresholds", {})

        readiness = self._compute_readiness(
            encounter_count=encounter_count,
            confidence=new_confidence,
            weights=weights,
            thresholds=thresholds,
            hard_floor=hard_floor,
        )

        # Build readiness metric
        promotion_threshold = float(criteria.get("promotion_threshold", 1.0))
        min_encounters = int(thresholds.get("min_encounters", 5))
        encounters_needed = max(0, hard_floor - encounter_count)

        readiness_metric = PhraseReadiness(
            phrase_id=phrase_id,
            normalized_text=str(props.get("normalized_text", "")),
            encounter_count=encounter_count,
            confidence=new_confidence,
            readiness_score=readiness,
            encounters_to_threshold=encounters_needed,
        )

        # -- Check for promotion to CAN_PRODUCE --
        already_promoted = await self._has_can_produce(phrase_id)
        if not already_promoted and readiness >= promotion_threshold:
            await self._promote_phrase(phrase_id, node, encounter_count, new_confidence, now)
            readiness_metric.promoted = True
            report.promoted += 1

        report.readiness_metrics.append(readiness_metric)

        # -- Update PhraseNode properties --
        props["confidence"] = new_confidence
        props["encounter_count"] = encounter_count
        props["rehearsal_credits"] = rehearsal_credits
        props["consolidated"] = True
        props["last_retrieved"] = now.isoformat()

        updated = node.model_copy(
            update={
                "properties": props,
                "confidence": new_confidence,
            },
        )
        await self._graph.save_node(updated)

    def _compute_readiness(
        self,
        encounter_count: int,
        confidence: float,
        weights: dict[str, float],
        thresholds: dict[str, float],
        hard_floor: int,
    ) -> float:
        """Compute weighted readiness score with hard floor.

        Returns 0.0 if encounter_count < hard_floor, otherwise the
        weighted sum of normalized criteria scores.
        """
        if encounter_count < hard_floor:
            return 0.0

        w_enc = float(weights.get("encounters", 0.3))
        w_conf = float(weights.get("confidence", 0.3))
        w_var = float(weights.get("drive_variance", 0.2))
        w_ctx = float(weights.get("contextual_consistency", 0.2))

        min_encounters = float(thresholds.get("min_encounters", 5))
        min_confidence = float(thresholds.get("min_confidence", 0.40))
        max_drive_variance = float(thresholds.get("max_drive_variance", 0.5))
        min_contextual = float(thresholds.get("min_contextual_consistency", 0.3))

        enc_score = min(1.0, encounter_count / max(1, min_encounters))
        conf_score = min(1.0, confidence / max(0.01, min_confidence))

        # Drive variance and contextual consistency require HEARD_DURING
        # edge analysis. Use values that allow promotion when encounter +
        # confidence criteria are fully met. These will be computed from
        # edge data in later iterations when enough data is available.
        var_score = 1.0  # Default: don't block on unavailable data
        ctx_score = 1.0  # Default: don't block on unavailable data

        return (
            w_enc * enc_score
            + w_conf * conf_score
            + w_var * var_score
            + w_ctx * ctx_score
        )

    # ------------------------------------------------------------------
    # Promotion
    # ------------------------------------------------------------------

    async def _promote_phrase(
        self,
        phrase_id: str,
        node: KnowledgeNode,
        encounter_count: int,
        confidence: float,
        now: datetime,
    ) -> None:
        """Create a CAN_PRODUCE edge from action:speak to the PhraseNode."""
        # Extract discriminative context from HEARD_DURING edges
        disc_context = await self._extract_discriminative_context(phrase_id)

        edge = KnowledgeEdge(
            edge_id=EdgeId(f"edge:can_produce:{SPEAK_ACTION_NODE_ID}:{phrase_id}"),
            source_id=NodeId(SPEAK_ACTION_NODE_ID),
            target_id=NodeId(phrase_id),
            edge_type=CAN_PRODUCE,
            properties={
                "promoted_at": now.isoformat(),
                "promoted_by": "CONSOLIDATION",
                "encounter_count_at_promotion": encounter_count,
                "confidence_at_promotion": confidence,
                "production_confidence": 0.0,
                "production_count": 0,
                "last_produced": None,
                "discriminative_context": json.dumps(disc_context),
                "deprecated_at": None,
                "deprecated_reason": None,
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id="phrase_consolidator",
                confidence=1.0,
            ),
            confidence=1.0,
            valid_from=now,
            valid_to=None,
        )
        await self._graph.save_edge(edge)

        logger.info(
            "phrase_promoted node_id=%s encounters=%d confidence=%.3f "
            "text=%r",
            phrase_id,
            encounter_count,
            confidence,
            str(node.properties.get("normalized_text", ""))[:40],
        )

    async def _has_can_produce(self, phrase_id: str) -> bool:
        """Check if a CAN_PRODUCE edge already exists for this phrase."""
        edges = await self._graph.query_edges(
            EdgeFilter(
                edge_type=CAN_PRODUCE,
                target_node_id=NodeId(phrase_id),
            ),
        )
        for e in edges:
            if e.properties.get("deprecated_at") is None:
                return True
        return False

    async def _extract_discriminative_context(
        self,
        phrase_id: str,
    ) -> dict[str, Any]:
        """Extract contextual patterns from HEARD_DURING edges.

        Analyzes the drive snapshots across all encounters to determine
        the typical context in which this phrase is heard.
        """
        edges = await self._graph.query_edges(
            EdgeFilter(
                edge_type=HEARD_DURING,
                source_node_id=NodeId(phrase_id),
            ),
        )

        if not edges:
            return {
                "dominant_drive": None,
                "drive_profile": {},
                "guardian_present": True,
                "typical_session_position": "unknown",
                "co_occurring_phrases": [],
            }

        # Aggregate drive snapshots
        drive_sums: dict[str, float] = {}
        drive_counts = 0
        for edge in edges:
            snapshot_str = edge.properties.get("drive_snapshot")
            if not snapshot_str:
                continue
            try:
                snapshot = json.loads(snapshot_str) if isinstance(snapshot_str, str) else snapshot_str
                for axis, value in snapshot.items():
                    drive_sums[axis] = drive_sums.get(axis, 0.0) + float(value)
                drive_counts += 1
            except (json.JSONDecodeError, TypeError, ValueError):
                continue

        # Compute average drive profile
        drive_profile: dict[str, float] = {}
        dominant_drive: str | None = None
        max_avg = 0.0
        if drive_counts > 0:
            for axis, total in drive_sums.items():
                avg = total / drive_counts
                drive_profile[axis] = round(avg, 4)
                if avg > max_avg:
                    max_avg = avg
                    dominant_drive = axis

        return {
            "dominant_drive": dominant_drive,
            "drive_profile": drive_profile,
            "guardian_present": True,
            "typical_session_position": "unknown",
            "co_occurring_phrases": [],
        }

    async def _check_cross_session(self, phrase_id: str) -> bool:
        """Check if the phrase has been heard in multiple sessions."""
        edges = await self._graph.query_edges(
            EdgeFilter(
                edge_type=HEARD_DURING,
                source_node_id=NodeId(phrase_id),
            ),
        )
        sessions = {e.properties.get("session_id") for e in edges}
        return len(sessions) > 1

    # ------------------------------------------------------------------
    # Phrase clustering (Fix 1)
    # ------------------------------------------------------------------

    @staticmethod
    def _strip_punctuation(text: str) -> str:
        """Strip trailing/leading punctuation from each word for overlap."""
        return " ".join(
            w.strip(".,!?;:'\"()[]{}") for w in text.split()
        ).strip()

    @staticmethod
    def _word_overlap(text_a: str, text_b: str) -> float:
        """Compute Jaccard-style word-set overlap between two phrases."""
        words_a = set(text_a.split())
        words_b = set(text_b.split())
        if not words_a or not words_b:
            return 0.0
        intersection = words_a & words_b
        smaller = min(len(words_a), len(words_b))
        return len(intersection) / smaller

    async def _cluster_phrase_variants(
        self,
        phrase_nodes: list[KnowledgeNode],
        now: datetime,
        report: PhraseConsolidationReport,
    ) -> None:
        """Detect phrase clusters and create VARIANT_OF edges.

        Groups phrases by word overlap after punctuation stripping.
        Within each cluster, the phrase with the highest encounter_count
        is canonical; others get VARIANT_OF edges pointing to it.
        """
        # Build phrase data: (node_id, stripped_text, encounter_count)
        phrase_data: list[tuple[str, str, int]] = []
        for node in phrase_nodes:
            ntext = node.properties.get("normalized_text", "")
            if not ntext:
                continue
            stripped = self._strip_punctuation(ntext)
            enc = int(node.properties.get("encounter_count", 0))
            phrase_data.append((str(node.node_id), stripped, enc))

        if len(phrase_data) < 2:
            return

        # Check which VARIANT_OF edges already exist (avoid duplicates)
        existing_variant_edges: set[tuple[str, str]] = set()
        existing = await self._graph.query_edges(
            EdgeFilter(edge_type=VARIANT_OF),
        )
        for e in existing:
            existing_variant_edges.add((str(e.source_id), str(e.target_id)))

        # Build clusters using greedy single-linkage
        # Each phrase starts in its own cluster
        assigned: set[str] = set()
        clusters: list[list[tuple[str, str, int]]] = []

        for i, (pid_a, text_a, enc_a) in enumerate(phrase_data):
            if pid_a in assigned:
                continue
            cluster = [(pid_a, text_a, enc_a)]
            assigned.add(pid_a)

            for j in range(i + 1, len(phrase_data)):
                pid_b, text_b, enc_b = phrase_data[j]
                if pid_b in assigned:
                    continue
                # Check overlap against ANY member already in the cluster
                for _, member_text, _ in cluster:
                    overlap = self._word_overlap(member_text, text_b)
                    if overlap >= CLUSTER_OVERLAP_THRESHOLD:
                        cluster.append((pid_b, text_b, enc_b))
                        assigned.add(pid_b)
                        break

            if len(cluster) > 1:
                clusters.append(cluster)

        # Create VARIANT_OF edges within each cluster
        for cluster in clusters:
            # Canonical = highest encounter count
            cluster.sort(key=lambda x: x[2], reverse=True)
            canonical_id = cluster[0][0]
            canonical_text = cluster[0][1]
            # Stable cluster_id from canonical's node_id
            cluster_id = f"cluster:{canonical_id.replace('phrase:', '')}"

            report.clusters_created += 1

            for pid, text, _enc in cluster[1:]:
                if (pid, canonical_id) in existing_variant_edges:
                    continue  # Already linked

                overlap = self._word_overlap(text, canonical_text)
                edge = KnowledgeEdge(
                    edge_id=EdgeId(f"edge:variant_of:{pid}:{canonical_id}"),
                    source_id=NodeId(pid),
                    target_id=NodeId(canonical_id),
                    edge_type=VARIANT_OF,
                    properties={
                        "overlap_ratio": round(overlap, 3),
                        "cluster_id": cluster_id,
                        "clustered_at": now.isoformat(),
                    },
                    provenance=Provenance(
                        source=ProvenanceSource.INFERENCE,
                        source_id="phrase_consolidator",
                        confidence=1.0,
                    ),
                    confidence=1.0,
                    valid_from=now,
                    valid_to=None,
                )
                await self._graph.save_edge(edge)
                report.variant_edges_created += 1
                logger.info(
                    "variant_of_created source=%s target=%s overlap=%.2f "
                    "cluster=%s",
                    pid, canonical_id, overlap, cluster_id,
                )

    # ------------------------------------------------------------------
    # Word-level CAN_PRODUCE (Fix 2)
    # ------------------------------------------------------------------

    async def _promote_words(
        self,
        phrase_nodes: list[KnowledgeNode],
        now: datetime,
        report: PhraseConsolidationReport,
    ) -> None:
        """Promote high-frequency words to independently speakable.

        A word appearing in 3+ distinct phrases with 10+ total encounters
        gets a CAN_PRODUCE edge from action:speak, making it available
        as a standalone utterance.
        """
        # Collect all WordNodes from IS_PART_OF edges
        word_phrase_count: dict[str, set[str]] = {}  # word_id -> {phrase_ids}
        word_encounter_sum: dict[str, int] = {}       # word_id -> total encounters

        for node in phrase_nodes:
            phrase_id = str(node.node_id)
            enc = int(node.properties.get("encounter_count", 0))

            # Get IS_PART_OF edges incoming to this phrase (word -> phrase)
            edges = await self._graph.query_edges(
                EdgeFilter(
                    edge_type=IS_PART_OF,
                    target_node_id=NodeId(phrase_id),
                ),
            )
            for edge in edges:
                word_id = str(edge.source_id)
                if word_id not in word_phrase_count:
                    word_phrase_count[word_id] = set()
                    word_encounter_sum[word_id] = 0
                word_phrase_count[word_id].add(phrase_id)
                word_encounter_sum[word_id] += enc

        # Evaluate each word for promotion
        for word_id, phrase_ids in word_phrase_count.items():
            # Extract the word text from the node_id (word:{text})
            word_text = word_id.replace("word:", "", 1)

            # Skip function words
            if word_text.lower() in _FUNCTION_WORDS:
                continue

            # Check thresholds
            if len(phrase_ids) < WORD_MIN_PHRASE_COUNT:
                continue
            if word_encounter_sum[word_id] < WORD_MIN_TOTAL_ENCOUNTERS:
                continue

            # Check if CAN_PRODUCE already exists for this word
            existing = await self._graph.query_edges(
                EdgeFilter(
                    edge_type=CAN_PRODUCE,
                    target_node_id=NodeId(word_id),
                ),
            )
            if any(e.properties.get("deprecated_at") is None for e in existing):
                continue  # Already promoted

            # Create CAN_PRODUCE edge from action:speak to WordNode
            edge = KnowledgeEdge(
                edge_id=EdgeId(
                    f"edge:can_produce:{SPEAK_ACTION_NODE_ID}:{word_id}"
                ),
                source_id=NodeId(SPEAK_ACTION_NODE_ID),
                target_id=NodeId(word_id),
                edge_type=CAN_PRODUCE,
                properties={
                    "promoted_at": now.isoformat(),
                    "promoted_by": "WORD_CONSOLIDATION",
                    "phrase_count_at_promotion": len(phrase_ids),
                    "total_encounters_at_promotion": word_encounter_sum[word_id],
                    "production_confidence": WORD_INITIAL_PRODUCTION_CONFIDENCE,
                    "production_count": 0,
                    "last_produced": None,
                    "deprecated_at": None,
                    "deprecated_reason": None,
                },
                provenance=Provenance(
                    source=ProvenanceSource.INFERENCE,
                    source_id="phrase_consolidator:word_promotion",
                    confidence=1.0,
                ),
                confidence=1.0,
                valid_from=now,
                valid_to=None,
            )
            await self._graph.save_edge(edge)
            report.words_promoted += 1
            logger.info(
                "word_promoted word_id=%s text=%r phrase_count=%d "
                "total_encounters=%d",
                word_id, word_text, len(phrase_ids),
                word_encounter_sum[word_id],
            )

    # ------------------------------------------------------------------
    # Meta-schema rule loading
    # ------------------------------------------------------------------

    async def _load_promotion_criteria(self) -> dict[str, Any]:
        """Load promotion criteria from meta-schema rules.

        Falls back to sensible defaults if rules are not found.
        """
        defaults: dict[str, Any] = {
            "weights": {
                "encounters": 0.3,
                "confidence": 0.3,
                "drive_variance": 0.2,
                "contextual_consistency": 0.2,
            },
            "thresholds": {
                "min_encounters": 5,
                "min_confidence": 0.40,
                "max_drive_variance": 0.5,
                "min_contextual_consistency": 0.3,
            },
            "hard_floor_encounters": 3,
            "promotion_threshold": 1.0,
            "lability_window_minutes": 10,
            "lability_amplifier": 1.5,
        }

        try:
            # Try to load from graph
            promo_node = await self._graph.get_node(
                NodeId("rule:phrase_promotion_criteria"),
            )
            if promo_node is not None:
                props = promo_node.properties
                weights_str = props.get("weights")
                thresholds_str = props.get("thresholds")
                if weights_str:
                    defaults["weights"] = (
                        json.loads(weights_str)
                        if isinstance(weights_str, str)
                        else weights_str
                    )
                if thresholds_str:
                    defaults["thresholds"] = (
                        json.loads(thresholds_str)
                        if isinstance(thresholds_str, str)
                        else thresholds_str
                    )
                if "hard_floor_encounters" in props:
                    defaults["hard_floor_encounters"] = int(
                        props["hard_floor_encounters"]
                    )
                if "promotion_threshold" in props:
                    defaults["promotion_threshold"] = float(
                        props["promotion_threshold"]
                    )

            # Load lability parameters
            lability_node = await self._graph.get_node(
                NodeId("rule:lability_window_minutes"),
            )
            if lability_node is not None:
                defaults["lability_window_minutes"] = float(
                    lability_node.properties.get("current_value", 10)
                )

            amp_node = await self._graph.get_node(
                NodeId("rule:lability_amplifier"),
            )
            if amp_node is not None:
                defaults["lability_amplifier"] = float(
                    amp_node.properties.get("current_value", 1.5)
                )

        except Exception as exc:
            logger.warning(
                "phrase_consolidation_criteria_load_failed error=%s "
                "-- using defaults",
                exc,
            )

        return defaults


__all__ = [
    "PhraseConsolidator",
    "PhraseConsolidationReport",
    "PhraseReadiness",
    "INTERNAL_REHEARSAL_WEIGHT",
    "SPEAK_ACTION_NODE_ID",
]

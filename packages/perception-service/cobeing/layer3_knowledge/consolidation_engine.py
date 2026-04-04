"""Consolidation engine -- episodic reasoning to structural knowledge.

Consolidation is the cognitive process of converting episodic experiences
(ReasoningEpisode nodes from P1.8-E5) into long-term structural knowledge
proposals. This module processes recent reasoning episodes, identifies
patterns across them, and generates schema evolution proposals for guardian
review.

**CANON references:**

- A.5: Guardian approval required for all schema changes. Proposals generated
  here are suggestions only -- they are stored with status=PENDING and require
  explicit guardian review before any graph modification.
- A.19: ReasoningEpisode nodes are first-class artifacts. This engine reads
  them as input data, never modifies or deletes them.

**Temporal guards:**

Consolidation is computationally expensive and should not run continuously.
Three guards prevent excessive processing:

1. Minimum 30 minutes of runtime before first consolidation.
2. Minimum 5 minutes of idle time before triggering.
3. Maximum 3 consolidation runs per session.

**Pattern detection strategy:**

The engine uses frequency-based analysis, not ML. It counts repeated query
subjects, common failure patterns, confidence trends over time, and identifies
concepts referenced in reasoning but missing from the graph. This keeps the
implementation debuggable and the results explainable.

**No direct graph modification:**

The engine reads graph state and writes SchemaProposal nodes with
status=PENDING. It never creates types, edges, or modifies confidence
directly. All structural changes flow through the guardian approval pipeline
(``cobeing.layer3_knowledge.guardian_operations``).

Usage::

    from cobeing.layer3_knowledge.consolidation_engine import (
        ConsolidationEngine,
        ConsolidationAnalysis,
        ConsolidationReport,
        FailurePattern,
        ConfidenceTrend,
        SchemaProposal,
    )
    from cobeing.layer3_knowledge.protocols import GraphPersistence

    engine = ConsolidationEngine(persistence=graph)
    report = await engine.run_consolidation()
    for proposal in report.proposals:
        print(f"[{proposal.proposal_type}] {proposal.description}")
"""

from __future__ import annotations

import logging
import random
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from cobeing.layer3_knowledge.node_types import (
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.query_types import NodeFilter, TemporalWindow
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import NodeId

if TYPE_CHECKING:
    from cobeing.layer3_knowledge.protocols import GraphPersistence

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes for analysis results
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FailurePattern:
    """A recurring failure pattern detected across reasoning episodes.

    Attributes:
        query_type: The type of query that failed (e.g., "definition",
            "inference", "classification").
        subject: The concept or entity that the query targeted.
        failure_count: How many episodes exhibited this failure.
        common_termination_reason: The most frequent termination reason
            across the failing episodes (e.g., "no_evidence", "timeout",
            "low_confidence").
    """

    query_type: str
    subject: str
    failure_count: int
    common_termination_reason: str


@dataclass(frozen=True)
class ConfidenceTrend:
    """Confidence trend for a concept across reasoning episodes over time.

    Attributes:
        concept_id: The node ID of the concept being tracked.
        concept_name: Human-readable name of the concept.
        confidence_values: Confidence values ordered by time (oldest first).
        trend: Direction of the trend: "improving", "declining", or "stable".
    """

    concept_id: str
    concept_name: str
    confidence_values: list[float]
    trend: str  # "improving", "declining", "stable"


@dataclass(frozen=True)
class ConsolidationAnalysis:
    """Results of analyzing a set of reasoning episodes for patterns.

    Attributes:
        episodes_analyzed: Number of episodes included in this analysis.
        repeated_subjects: Map of concept/subject name to query count.
            Concepts queried multiple times across episodes are candidates
            for schema enrichment.
        failure_patterns: Recurring failure patterns detected across
            episodes. Each pattern represents a query type + subject
            combination that failed multiple times.
        confidence_trends: Confidence trends for concepts that appeared
            in multiple episodes. Declining trends suggest the system is
            struggling with a concept.
        knowledge_gaps: Concept IDs or names that were referenced in
            reasoning but do not exist as nodes in the graph. These are
            candidates for NEW_CONCEPT proposals.
    """

    episodes_analyzed: int
    repeated_subjects: dict[str, int] = field(default_factory=dict)
    failure_patterns: list[FailurePattern] = field(default_factory=list)
    confidence_trends: list[ConfidenceTrend] = field(default_factory=list)
    knowledge_gaps: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SchemaProposal:
    """A schema evolution proposal generated from consolidation analysis.

    Proposals are suggestions only. They are stored in the graph as
    SchemaProposal nodes with status=PENDING for guardian review (CANON A.5).

    Attributes:
        proposal_id: Unique identifier for this proposal.
        proposal_type: Category of the proposal. One of:
            - "NEW_CONCEPT": Suggest creating a new ConceptPrimitive.
            - "CONFIDENCE_ADJUSTMENT": Suggest adjusting confidence on
              frequently-confirmed edges.
            - "RELATIONSHIP_SUGGESTION": Suggest a new semantic edge
              based on inference patterns.
            - "PRACTICE_RECOMMENDATION": Suggest practice focus areas
              based on failure patterns.
        description: Human-readable description for the guardian to review.
        confidence: How confident the consolidation engine is in this
            proposal (0.0 to 1.0). Based on the strength of the evidence
            (frequency counts, trend clarity).
        evidence_episodes: List of episode node IDs that support this
            proposal.
        suggested_action: Structured data describing the proposed action.
            Contents depend on ``proposal_type``. For NEW_CONCEPT, this
            might include ``{"concept_name": "...", "domain": "..."}``
            For CONFIDENCE_ADJUSTMENT, ``{"node_id": "...", "new_confidence": 0.8}``.
    """

    proposal_id: str
    proposal_type: str
    description: str
    confidence: float
    evidence_episodes: list[str]
    suggested_action: dict[str, Any]


@dataclass(frozen=True)
class ConsolidationReport:
    """Report from a single consolidation run.

    Contains the full results of one consolidation cycle: how many episodes
    were sampled and analyzed, what proposals were generated, and a brief
    summary for the guardian.

    Attributes:
        consolidation_id: Unique identifier for this consolidation run.
        timestamp: ISO 8601 timestamp of when the run completed.
        episodes_sampled: Number of episodes retrieved from the graph.
        episodes_analyzed: Number of episodes that passed filtering and
            were included in the analysis.
        proposals_generated: Number of schema proposals produced.
        proposals: The list of schema proposals.
        analysis_summary: Brief human-readable summary of what was found,
            suitable for presentation to the guardian.
        duration_seconds: Wall-clock time for the full consolidation cycle.
    """

    consolidation_id: str
    timestamp: str
    episodes_sampled: int
    episodes_analyzed: int
    proposals_generated: int
    proposals: list[SchemaProposal]
    analysis_summary: str
    duration_seconds: float


# ---------------------------------------------------------------------------
# Thresholds for pattern detection
# ---------------------------------------------------------------------------

_MIN_REPEAT_COUNT = 2
"""Minimum number of times a subject must be queried to count as 'repeated'."""

_MIN_FAILURE_COUNT = 2
"""Minimum failures for a query type + subject to count as a failure pattern."""

_MIN_TREND_POINTS = 3
"""Minimum data points needed to compute a confidence trend."""

_TREND_THRESHOLD = 0.05
"""Change in confidence (first vs last) above which a trend is non-stable."""


class ConsolidationEngine:
    """Processes reasoning episodes to generate schema evolution proposals.

    Consolidation is the cognitive process of converting episodic experiences
    into long-term structural knowledge. This engine:

    1. Samples recent ReasoningEpisode nodes from the graph.
    2. Identifies patterns across episodes (repeated queries, common failures).
    3. Generates schema proposals (new types, new edges, confidence adjustments).
    4. Stores proposals as SchemaProposal nodes in the graph for guardian review.

    Temporal guards prevent excessive processing:

    - Minimum 30 minutes of runtime before first consolidation.
    - Minimum 5 minutes of idle time before triggering.
    - Maximum 3 consolidation runs per session.

    CANON A.5: Guardian approval required for all schema changes.
    CANON A.19: ReasoningEpisode nodes are first-class artifacts.

    Args:
        persistence: Graph storage backend satisfying the GraphPersistence
            protocol. Used to read episodes and write proposals.
    """

    def __init__(self, persistence: GraphPersistence) -> None:
        self._persistence = persistence
        self._consolidation_count: int = 0
        self._max_per_session: int = 3

        # Grounding maintenance engine -- proposes MEANS edges for
        # ungrounded words (conversation engine Phase 2).
        from cobeing.layer3_knowledge.grounding_maintenance import (  # noqa: PLC0415
            GroundingMaintenanceEngine,
        )
        self._grounding_engine = GroundingMaintenanceEngine()

    @property
    def consolidation_count(self) -> int:
        """Number of consolidation runs completed this session."""
        return self._consolidation_count

    @property
    def max_per_session(self) -> int:
        """Maximum consolidation runs allowed per session."""
        return self._max_per_session

    async def sample_recent_episodes(
        self,
        window_hours: int = 24,
        max_episodes: int = 20,
    ) -> list[KnowledgeNode]:
        """Sample recent ReasoningEpisode nodes from the graph.

        Retrieves ReasoningEpisode nodes created within the time window,
        then applies random sampling with priority weighting. Episodes with
        more reasoning steps (complex reasoning), lower conclusion confidence
        (uncertain conclusions), and different trigger types (diversity) are
        preferred.

        Args:
            window_hours: How far back to look for episodes, in hours.
                Defaults to 24 hours.
            max_episodes: Maximum number of episodes to return. If fewer
                episodes exist within the window, all are returned.
                Defaults to 20.

        Returns:
            A list of KnowledgeNode objects with node_type "ReasoningEpisode",
            sampled from the time window. May be empty if no episodes exist.
        """
        window_start = datetime.now(UTC) - timedelta(hours=window_hours)
        window = TemporalWindow(start=window_start)

        all_episodes = await self._persistence.query_nodes(
            NodeFilter(
                node_type="ReasoningEpisode",
                temporal_window=window,
            )
        )

        if not all_episodes:
            logger.info("consolidation_sample_empty", extra={
                "window_hours": window_hours,
            })
            return []

        if len(all_episodes) <= max_episodes:
            logger.info("consolidation_sample_all", extra={
                "episode_count": len(all_episodes),
                "window_hours": window_hours,
            })
            return all_episodes

        # Weight episodes for sampling priority:
        # - More steps = more complex reasoning = higher weight
        # - Lower confidence = more uncertain = higher weight
        # - Different trigger types add diversity
        weighted: list[tuple[KnowledgeNode, float]] = []
        for episode in all_episodes:
            props = episode.properties
            step_count = len(props.get("step_ids", []))
            conclusion_confidence = props.get("conclusion_confidence", 0.5)
            # Weight: prefer complex (many steps) and uncertain (low confidence)
            weight = (1.0 + step_count) * (1.0 + (1.0 - conclusion_confidence))
            weighted.append((episode, weight))

        # Weighted random sampling without replacement
        sampled: list[KnowledgeNode] = []
        remaining = list(weighted)
        for _ in range(min(max_episodes, len(remaining))):
            if not remaining:
                break
            total_weight = sum(w for _, w in remaining)
            if total_weight <= 0:
                # Fall back to uniform sampling
                idx = random.randint(0, len(remaining) - 1)
            else:
                r = random.uniform(0, total_weight)
                cumulative = 0.0
                idx = 0
                for i, (_, w) in enumerate(remaining):
                    cumulative += w
                    if cumulative >= r:
                        idx = i
                        break
            sampled.append(remaining[idx][0])
            remaining.pop(idx)

        logger.info("consolidation_sample_complete", extra={
            "total_available": len(all_episodes),
            "sampled": len(sampled),
            "window_hours": window_hours,
        })
        return sampled

    async def analyze_episodes(
        self,
        episodes: list[KnowledgeNode],
    ) -> ConsolidationAnalysis:
        """Analyze a set of episodes for recurring patterns.

        Examines the episodes for:

        - **Repeated query subjects**: Concepts queried multiple times across
          episodes, suggesting they are important but perhaps under-represented
          in the graph.
        - **Common failure patterns**: Query type + subject combinations that
          fail repeatedly, indicating knowledge gaps or structural issues.
        - **Confidence trends**: Whether the system is getting better or worse
          at reasoning about specific concepts over time.
        - **Knowledge gaps**: Concept IDs or names referenced in episode
          properties but absent from the graph as nodes.

        Args:
            episodes: List of ReasoningEpisode KnowledgeNode objects to
                analyze. Should come from :meth:`sample_recent_episodes`.

        Returns:
            A ConsolidationAnalysis containing the detected patterns.
        """
        if not episodes:
            return ConsolidationAnalysis(episodes_analyzed=0)

        # Collect subject query frequencies
        subject_counts: dict[str, int] = {}
        # Collect failure info: (query_type, subject) -> list of termination reasons
        failure_info: dict[tuple[str, str], list[str]] = {}
        # Collect confidence per concept: concept_id -> list of (timestamp, confidence)
        confidence_data: dict[str, list[tuple[datetime, float, str]]] = {}
        # Collect referenced concept IDs
        referenced_concepts: set[str] = set()

        for episode in episodes:
            props = episode.properties

            # Track queried subjects
            subject = props.get("subject", props.get("query_subject", ""))
            if subject:
                subject_counts[subject] = subject_counts.get(subject, 0) + 1

            # Track failures
            termination_reason = props.get("termination_reason", "")
            query_type = props.get("query_type", props.get("trigger_type", ""))
            is_failure = termination_reason in (
                "no_evidence",
                "timeout",
                "low_confidence",
                "max_depth_exceeded",
            )
            if is_failure and query_type and subject:
                key = (query_type, subject)
                if key not in failure_info:
                    failure_info[key] = []
                failure_info[key].append(termination_reason)

            # Track confidence per concept for trend analysis
            conclusion_confidence = props.get("conclusion_confidence")
            concept_id = props.get("concept_id", props.get("subject_node_id", ""))
            concept_name = subject or concept_id
            if (
                concept_id
                and conclusion_confidence is not None
                and isinstance(conclusion_confidence, (int, float))
            ):
                if concept_id not in confidence_data:
                    confidence_data[concept_id] = []
                confidence_data[concept_id].append(
                    (episode.created_at, float(conclusion_confidence), concept_name)
                )

            # Collect referenced concepts for gap detection
            for ref_key in (
                "referenced_concepts",
                "referenced_node_ids",
                "related_concepts",
            ):
                refs = props.get(ref_key, [])
                if isinstance(refs, list):
                    for ref in refs:
                        if isinstance(ref, str) and ref:
                            referenced_concepts.add(ref)

        # Build repeated subjects (only those queried >= _MIN_REPEAT_COUNT times)
        repeated_subjects = {
            subj: count
            for subj, count in subject_counts.items()
            if count >= _MIN_REPEAT_COUNT
        }

        # Build failure patterns
        failure_patterns: list[FailurePattern] = []
        for (q_type, subj), reasons in failure_info.items():
            if len(reasons) >= _MIN_FAILURE_COUNT:
                # Find the most common termination reason
                reason_counts: dict[str, int] = {}
                for r in reasons:
                    reason_counts[r] = reason_counts.get(r, 0) + 1
                most_common = max(reason_counts, key=reason_counts.get)  # type: ignore[arg-type]
                failure_patterns.append(
                    FailurePattern(
                        query_type=q_type,
                        subject=subj,
                        failure_count=len(reasons),
                        common_termination_reason=most_common,
                    )
                )

        # Build confidence trends
        confidence_trends: list[ConfidenceTrend] = []
        for concept_id, data_points in confidence_data.items():
            if len(data_points) < _MIN_TREND_POINTS:
                continue
            # Sort by timestamp
            data_points.sort(key=lambda x: x[0])
            values = [dp[1] for dp in data_points]
            concept_name = data_points[0][2]

            # Determine trend from first vs last value
            delta = values[-1] - values[0]
            if delta > _TREND_THRESHOLD:
                trend = "improving"
            elif delta < -_TREND_THRESHOLD:
                trend = "declining"
            else:
                trend = "stable"

            confidence_trends.append(
                ConfidenceTrend(
                    concept_id=concept_id,
                    concept_name=concept_name,
                    confidence_values=values,
                    trend=trend,
                )
            )

        # Identify knowledge gaps: referenced concepts that are not in the graph
        knowledge_gaps: list[str] = []
        for concept_ref in referenced_concepts:
            node = await self._persistence.get_node(NodeId(concept_ref))
            if node is None:
                knowledge_gaps.append(concept_ref)

        logger.info("consolidation_analysis_complete", extra={
            "episodes_analyzed": len(episodes),
            "repeated_subjects": len(repeated_subjects),
            "failure_patterns": len(failure_patterns),
            "confidence_trends": len(confidence_trends),
            "knowledge_gaps": len(knowledge_gaps),
        })

        return ConsolidationAnalysis(
            episodes_analyzed=len(episodes),
            repeated_subjects=repeated_subjects,
            failure_patterns=failure_patterns,
            confidence_trends=confidence_trends,
            knowledge_gaps=knowledge_gaps,
        )

    async def generate_proposals(
        self,
        analysis: ConsolidationAnalysis,
    ) -> list[SchemaProposal]:
        """Generate schema evolution proposals from analysis results.

        Translates the patterns detected in :meth:`analyze_episodes` into
        concrete, actionable proposals for the guardian. Each proposal type
        maps to a specific kind of evidence:

        - **NEW_CONCEPT**: Generated from knowledge gaps -- concepts
          referenced in reasoning but absent from the graph.
        - **CONFIDENCE_ADJUSTMENT**: Generated from confidence trends --
          concepts whose confidence is consistently improving or declining.
        - **RELATIONSHIP_SUGGESTION**: Generated from repeated subjects --
          concepts queried frequently enough to suggest they need richer
          connections in the graph.
        - **PRACTICE_RECOMMENDATION**: Generated from failure patterns --
          query types that fail repeatedly for specific subjects.

        Args:
            analysis: The ConsolidationAnalysis from :meth:`analyze_episodes`.

        Returns:
            A list of SchemaProposal objects. May be empty if no patterns
            are strong enough to warrant proposals.
        """
        proposals: list[SchemaProposal] = []

        # NEW_CONCEPT proposals from knowledge gaps
        for gap_concept in analysis.knowledge_gaps:
            proposal_id = f"consolidation-proposal-{uuid.uuid4().hex[:12]}"
            proposals.append(
                SchemaProposal(
                    proposal_id=proposal_id,
                    proposal_type="NEW_CONCEPT",
                    description=(
                        f"Concept '{gap_concept}' was referenced in reasoning "
                        f"episodes but does not exist in the knowledge graph. "
                        f"Consider creating a ConceptPrimitive node for it."
                    ),
                    confidence=0.4,
                    evidence_episodes=[],  # Gap detection is graph-wide
                    suggested_action={
                        "concept_name": gap_concept,
                        "action": "create_concept_primitive",
                    },
                )
            )

        # CONFIDENCE_ADJUSTMENT proposals from trends
        for trend in analysis.confidence_trends:
            if trend.trend == "stable":
                continue
            proposal_id = f"consolidation-proposal-{uuid.uuid4().hex[:12]}"
            if trend.trend == "improving":
                description = (
                    f"Confidence in concept '{trend.concept_name}' "
                    f"(ID: {trend.concept_id}) has been consistently improving "
                    f"across {len(trend.confidence_values)} reasoning episodes "
                    f"(from {trend.confidence_values[0]:.2f} to "
                    f"{trend.confidence_values[-1]:.2f}). Consider reinforcing "
                    f"this knowledge."
                )
                suggested_confidence = min(
                    1.0, trend.confidence_values[-1] + 0.05
                )
            else:
                description = (
                    f"Confidence in concept '{trend.concept_name}' "
                    f"(ID: {trend.concept_id}) has been declining across "
                    f"{len(trend.confidence_values)} reasoning episodes "
                    f"(from {trend.confidence_values[0]:.2f} to "
                    f"{trend.confidence_values[-1]:.2f}). This concept may "
                    f"need guardian clarification or restructuring."
                )
                suggested_confidence = trend.confidence_values[-1]

            proposals.append(
                SchemaProposal(
                    proposal_id=proposal_id,
                    proposal_type="CONFIDENCE_ADJUSTMENT",
                    description=description,
                    confidence=0.5,
                    evidence_episodes=[],
                    suggested_action={
                        "node_id": trend.concept_id,
                        "current_confidence": trend.confidence_values[-1],
                        "suggested_confidence": suggested_confidence,
                        "trend": trend.trend,
                        "data_points": len(trend.confidence_values),
                    },
                )
            )

        # RELATIONSHIP_SUGGESTION proposals from repeated subjects
        for subject, count in analysis.repeated_subjects.items():
            proposal_id = f"consolidation-proposal-{uuid.uuid4().hex[:12]}"
            # Higher confidence for more repetitions
            proposal_confidence = min(0.7, 0.3 + 0.1 * (count - _MIN_REPEAT_COUNT))
            proposals.append(
                SchemaProposal(
                    proposal_id=proposal_id,
                    proposal_type="RELATIONSHIP_SUGGESTION",
                    description=(
                        f"Subject '{subject}' was queried {count} times across "
                        f"reasoning episodes. This suggests it may need richer "
                        f"connections in the graph (additional semantic edges, "
                        f"related concepts, or sub-categorization)."
                    ),
                    confidence=proposal_confidence,
                    evidence_episodes=[],
                    suggested_action={
                        "subject": subject,
                        "query_count": count,
                        "action": "enrich_connections",
                    },
                )
            )

        # PRACTICE_RECOMMENDATION proposals from failure patterns
        for pattern in analysis.failure_patterns:
            proposal_id = f"consolidation-proposal-{uuid.uuid4().hex[:12]}"
            proposals.append(
                SchemaProposal(
                    proposal_id=proposal_id,
                    proposal_type="PRACTICE_RECOMMENDATION",
                    description=(
                        f"Query type '{pattern.query_type}' for subject "
                        f"'{pattern.subject}' has failed {pattern.failure_count} "
                        f"times (most common reason: "
                        f"'{pattern.common_termination_reason}'). This area "
                        f"needs practice or guardian teaching to improve."
                    ),
                    confidence=min(
                        0.8, 0.3 + 0.1 * pattern.failure_count
                    ),
                    evidence_episodes=[],
                    suggested_action={
                        "query_type": pattern.query_type,
                        "subject": pattern.subject,
                        "failure_count": pattern.failure_count,
                        "termination_reason": pattern.common_termination_reason,
                        "action": "practice_focus",
                    },
                )
            )

        logger.info("consolidation_proposals_generated", extra={
            "total_proposals": len(proposals),
            "new_concept": sum(
                1 for p in proposals if p.proposal_type == "NEW_CONCEPT"
            ),
            "confidence_adjustment": sum(
                1 for p in proposals if p.proposal_type == "CONFIDENCE_ADJUSTMENT"
            ),
            "relationship_suggestion": sum(
                1 for p in proposals if p.proposal_type == "RELATIONSHIP_SUGGESTION"
            ),
            "practice_recommendation": sum(
                1 for p in proposals if p.proposal_type == "PRACTICE_RECOMMENDATION"
            ),
        })

        return proposals

    async def _store_proposals(
        self,
        proposals: list[SchemaProposal],
        consolidation_id: str,
    ) -> None:
        """Store schema proposals as PENDING nodes in the knowledge graph.

        Each proposal becomes a KnowledgeNode with node_type "SchemaProposal"
        at SCHEMA level with status PENDING. The guardian reviews these via
        the normal schema proposal workflow.

        Args:
            proposals: Proposals to store.
            consolidation_id: ID of the consolidation run that produced them,
                stored in the node properties for traceability.
        """
        for proposal in proposals:
            node = KnowledgeNode(
                node_id=NodeId(proposal.proposal_id),
                node_type="SchemaProposal",
                schema_level=SchemaLevel.SCHEMA,
                properties={
                    "proposal_type": proposal.proposal_type,
                    "description": proposal.description,
                    "evidence_episodes": proposal.evidence_episodes,
                    "suggested_action": proposal.suggested_action,
                    "consolidation_id": consolidation_id,
                    "source": "consolidation_engine",
                },
                provenance=Provenance(
                    source=ProvenanceSource.INFERENCE,
                    source_id=f"consolidation-{consolidation_id}",
                    confidence=proposal.confidence,
                ),
                confidence=proposal.confidence,
                status=NodeStatus.PENDING,
            )
            await self._persistence.save_node(node)

        logger.info("consolidation_proposals_stored", extra={
            "consolidation_id": consolidation_id,
            "proposals_stored": len(proposals),
        })

    async def run_consolidation(self) -> ConsolidationReport:
        """Run a full consolidation cycle.

        Executes the complete consolidation pipeline:

        1. Check the per-session consolidation limit.
        2. Sample recent ReasoningEpisode nodes from the graph.
        3. Analyze episodes for recurring patterns.
        4. Generate schema evolution proposals from the analysis.
        5. Store proposals as PENDING SchemaProposal nodes in the graph.
        6. Increment the session consolidation counter.
        7. Return a report summarizing the results.

        Note: Temporal guards (minimum runtime, idle time) are enforced
        by :class:`~cobeing.orchestrator.consolidation_scheduler.ConsolidationScheduler`,
        not by this method. This method only enforces the per-session limit.

        Returns:
            A ConsolidationReport containing the full results of the
            consolidation cycle.

        Raises:
            RuntimeError: If the per-session consolidation limit has been
                reached.
        """
        if self._consolidation_count >= self._max_per_session:
            raise RuntimeError(
                f"Consolidation limit reached: {self._consolidation_count} "
                f"of {self._max_per_session} runs completed this session."
            )

        start_time = time.monotonic()
        consolidation_id = f"consolidation-{uuid.uuid4().hex[:12]}"

        logger.info("consolidation_started", extra={
            "consolidation_id": consolidation_id,
            "run_number": self._consolidation_count + 1,
            "max_per_session": self._max_per_session,
        })

        # Step 1: Sample episodes
        episodes = await self.sample_recent_episodes()

        # Step 2: Analyze patterns
        analysis = await self.analyze_episodes(episodes)

        # Step 3: Generate proposals
        proposals = await self.generate_proposals(analysis)

        # Step 4: Store proposals in graph
        if proposals:
            await self._store_proposals(proposals, consolidation_id)

        # Step 5: Run grounding maintenance (Phase 2 conversation engine)
        # Fire-and-forget: grounding failures don't block episode consolidation.
        try:
            grounding_report = await self._grounding_engine.run(self._persistence)
            if grounding_report.edges_committed > 0:
                logger.info(
                    "grounding_maintenance_edges_committed",
                    extra={
                        "consolidation_id": consolidation_id,
                        "failures_processed": grounding_report.failures_processed,
                        "unique_words": grounding_report.unique_words,
                        "edges_committed": grounding_report.edges_committed,
                    },
                )
        except Exception as exc:
            logger.warning(
                "grounding_maintenance_failed error=%s", exc
            )

        # Step 6: Increment counter
        self._consolidation_count += 1

        duration = time.monotonic() - start_time

        # Build human-readable summary
        summary_parts: list[str] = []
        if analysis.repeated_subjects:
            top_subjects = sorted(
                analysis.repeated_subjects.items(),
                key=lambda x: x[1],
                reverse=True,
            )[:3]
            subjects_str = ", ".join(
                f"'{s}' ({c}x)" for s, c in top_subjects
            )
            summary_parts.append(f"Frequently queried: {subjects_str}.")
        if analysis.failure_patterns:
            summary_parts.append(
                f"{len(analysis.failure_patterns)} recurring failure "
                f"pattern(s) detected."
            )
        if analysis.knowledge_gaps:
            summary_parts.append(
                f"{len(analysis.knowledge_gaps)} concept(s) referenced "
                f"but missing from graph."
            )
        declining = [t for t in analysis.confidence_trends if t.trend == "declining"]
        if declining:
            summary_parts.append(
                f"{len(declining)} concept(s) showing declining confidence."
            )
        if not summary_parts:
            summary_parts.append("No significant patterns detected.")

        analysis_summary = " ".join(summary_parts)

        report = ConsolidationReport(
            consolidation_id=consolidation_id,
            timestamp=datetime.now(UTC).isoformat(),
            episodes_sampled=len(episodes),
            episodes_analyzed=analysis.episodes_analyzed,
            proposals_generated=len(proposals),
            proposals=proposals,
            analysis_summary=analysis_summary,
            duration_seconds=round(duration, 3),
        )

        logger.info("consolidation_complete", extra={
            "consolidation_id": consolidation_id,
            "episodes_sampled": report.episodes_sampled,
            "episodes_analyzed": report.episodes_analyzed,
            "proposals_generated": report.proposals_generated,
            "duration_seconds": report.duration_seconds,
            "summary": analysis_summary,
        })

        return report


__all__ = [
    "ConfidenceTrend",
    "ConsolidationAnalysis",
    "ConsolidationEngine",
    "ConsolidationReport",
    "FailurePattern",
    "SchemaProposal",
]

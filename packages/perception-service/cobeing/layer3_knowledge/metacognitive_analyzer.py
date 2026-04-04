"""Meta-cognitive analytics for Co-Being performance tracking (P1.9-E4).

Analyzes the knowledge graph to identify performance patterns, strengths,
and weaknesses across three cognitive domains: mathematics, morphology,
and semantic reasoning. All analysis is read-only -- it queries existing
graph state (edges, nodes, confidence values) and produces reports. No
graph mutations, no LLM calls.

Three analysis domains:
  1. Mathematical performance: accuracy and confidence on COMPUTES_TO /
     DOES_NOT_COMPUTE_TO edges, grouped by operation type.
  2. Morphological performance: accuracy and confidence on TRANSFORMS_TO
     edges, grouped by transformation type.
  3. Semantic reasoning performance: success/failure patterns on
     SemanticInferenceTrace nodes, grouped by query type.

Performance data sources:
  - COMPUTES_TO edges: ``operation``, ``confidence``, ``encounter_count``,
    ``error_count``, ``guardian_confirmed`` properties.
  - DOES_NOT_COMPUTE_TO edges: negative knowledge from validation failures.
  - TRANSFORMS_TO edges: ``transform_type``, ``confidence``,
    ``encounter_count``, ``error_count``, ``is_regular`` properties.
  - SemanticInferenceTrace nodes: ``query_type``, ``confidence``,
    ``termination_reason``, ``depth_reached`` properties.

CANON A.19: Meta-cognition is procedural self-awareness. This module
provides the data substrate for that awareness -- it tells Co-Being
(and the guardian) what it is good at and where it struggles.

Usage::

    from cobeing.layer3_knowledge.metacognitive_analyzer import (
        MetacognitiveAnalyzer,
        CognitivePerformanceReport,
    )

    analyzer = MetacognitiveAnalyzer(persistence=graph)
    report = await analyzer.generate_full_report()

    print(report.summary)
    for weak in report.weak_areas:
        print(f"  {weak.domain}/{weak.operation}: {weak.accuracy:.0%}")

Phase 1.9 (P1.9-E4). CANON A.19 (procedural meta-cognition).
"""

from __future__ import annotations

import logging
import math
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime

from cobeing.layer3_knowledge.node_types import KnowledgeEdge
from cobeing.layer3_knowledge.procedure_types import COMPUTES_TO
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Edge type constants used in queries
# ---------------------------------------------------------------------------

_DOES_NOT_COMPUTE_TO = "DOES_NOT_COMPUTE_TO"
"""Negative knowledge edge from validation failures (P1.9-E1)."""

_TRANSFORMS_TO = "TRANSFORMS_TO"
"""Morphological transformation edge (Phase 1.7)."""

_SEMANTIC_INFERENCE_TRACE = "SemanticInferenceTrace"
"""Node type for semantic inference trace nodes (P1.8-E3)."""

# ---------------------------------------------------------------------------
# Thresholds
# ---------------------------------------------------------------------------

_WEAK_AREA_ACCURACY_THRESHOLD: float = 0.80
"""Accuracy below this value flags an operation as a weak area."""

_WEAK_AREA_MIN_ERRORS: int = 2
"""Minimum error count to flag an operation as a weak area (high_error_rate)."""

_CALIBRATION_TOLERANCE: float = 0.10
"""Maximum |predicted - actual| before an operation is flagged as miscalibrated."""

_SUGGESTED_PRACTICE_MULTIPLIER: int = 5
"""Suggest this many practice problems per error in a weak area."""


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OperationStats:
    """Performance statistics for a single operation or transformation type.

    Attributes:
        operation: The operation name (e.g., ``"add"``, ``"pluralize"``).
        domain: Which cognitive domain this belongs to. One of
            ``"math"``, ``"morphology"``, ``"reasoning"``.
        total_attempts: Total COMPUTES_TO / TRANSFORMS_TO edges for this
            operation (positive knowledge edges).
        correct_count: Edges with ``error_count == 0`` or
            ``guardian_confirmed == True``.
        error_count: Sum of ``error_count`` properties across all edges
            for this operation.
        accuracy: ``correct_count / total_attempts`` if total > 0, else 0.0.
        average_confidence: Mean confidence across all edges for this
            operation.
        confidence_trend: One of ``"improving"``, ``"declining"``, or
            ``"stable"``. Derived by comparing confidence of older vs.
            newer edges (split at the median creation time).
        negative_edges: Count of DOES_NOT_COMPUTE_TO edges for this
            operation (math domain only).
    """

    operation: str
    domain: str
    total_attempts: int
    correct_count: int
    error_count: int
    accuracy: float
    average_confidence: float
    confidence_trend: str
    negative_edges: int


@dataclass(frozen=True)
class DomainPerformanceReport:
    """Aggregate performance report for one cognitive domain.

    Attributes:
        domain: ``"math"``, ``"morphology"``, or ``"reasoning"``.
        overall_accuracy: Weighted accuracy across all operations.
        overall_confidence: Mean confidence across all edges in the domain.
        operations: Per-operation breakdown.
        strongest_operation: Operation with highest accuracy (empty string
            if no operations have data).
        weakest_operation: Operation with lowest accuracy (empty string
            if no operations have data).
        total_practice_attempts: Sum of ``total_attempts`` across all
            operations.
    """

    domain: str
    overall_accuracy: float
    overall_confidence: float
    operations: list[OperationStats]
    strongest_operation: str
    weakest_operation: str
    total_practice_attempts: int


@dataclass(frozen=True)
class WeakArea:
    """An identified area where performance is below acceptable thresholds.

    Attributes:
        domain: ``"math"``, ``"morphology"``, or ``"reasoning"``.
        operation: The specific operation that is underperforming.
        accuracy: Current accuracy for this operation.
        error_count: Total error count for this operation.
        suggested_practice_count: How many practice problems to recommend.
        reason: Why this was flagged. One of ``"low_accuracy"``,
            ``"declining_confidence"``, ``"high_error_rate"``.
    """

    domain: str
    operation: str
    accuracy: float
    error_count: int
    suggested_practice_count: int
    reason: str


@dataclass(frozen=True)
class CalibrationReport:
    """Comparison of predicted confidence vs. actual accuracy.

    Good calibration means the system's confidence in its answers aligns
    with how often those answers are actually correct. Overconfidence is
    more dangerous than underconfidence -- it means the system trusts
    wrong answers.

    Attributes:
        overall_calibration_error: Mean of |predicted - actual| across
            all operations with sufficient data.
        overconfident_operations: Operations where confidence >> accuracy.
        underconfident_operations: Operations where confidence << accuracy.
        well_calibrated_operations: Operations where |confidence - accuracy|
            < tolerance.
        recommendation: Brief text summary for the guardian.
    """

    overall_calibration_error: float
    overconfident_operations: list[str]
    underconfident_operations: list[str]
    well_calibrated_operations: list[str]
    recommendation: str


@dataclass(frozen=True)
class CognitivePerformanceReport:
    """Comprehensive meta-cognitive report combining all domains.

    This is the top-level report returned by ``generate_full_report()``.
    Suitable for guardian presentation or inner monologue consumption.

    Attributes:
        report_id: Unique identifier for this report instance.
        timestamp: ISO 8601 UTC timestamp of when this report was generated.
        math_report: Mathematical performance breakdown.
        morphology_report: Morphological performance breakdown.
        reasoning_report: Semantic reasoning performance breakdown, or
            ``None`` if no inference traces exist yet.
        weak_areas: All identified weak areas across domains.
        calibration: Confidence calibration analysis.
        summary: 2-3 sentence guardian-readable summary.
    """

    report_id: str
    timestamp: str
    math_report: DomainPerformanceReport
    morphology_report: DomainPerformanceReport
    reasoning_report: DomainPerformanceReport | None
    weak_areas: list[WeakArea]
    calibration: CalibrationReport
    summary: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _compute_accuracy(correct: int, total: int) -> float:
    """Compute accuracy as a ratio, returning 0.0 when total is zero.

    Args:
        correct: Number of correct outcomes.
        total: Total number of attempts.

    Returns:
        Accuracy as a float in [0.0, 1.0].
    """
    if total == 0:
        return 0.0
    return correct / total


def _determine_confidence_trend(edges: list[KnowledgeEdge]) -> str:
    """Determine whether confidence is improving, declining, or stable.

    Splits edges at the median creation time and compares mean confidence
    of the older half vs. the newer half.

    Args:
        edges: Edges to analyze. Must all be for the same operation.

    Returns:
        One of ``"improving"``, ``"declining"``, or ``"stable"``.
    """
    if len(edges) < 2:
        return "stable"

    sorted_edges = sorted(edges, key=lambda e: e.valid_from)
    midpoint = len(sorted_edges) // 2
    older = sorted_edges[:midpoint]
    newer = sorted_edges[midpoint:]

    older_avg = sum(e.confidence for e in older) / len(older)
    newer_avg = sum(e.confidence for e in newer) / len(newer)

    diff = newer_avg - older_avg
    if diff > 0.05:
        return "improving"
    if diff < -0.05:
        return "declining"
    return "stable"


def _build_operation_stats(
    operation: str,
    domain: str,
    edges: list[KnowledgeEdge],
    negative_count: int,
) -> OperationStats:
    """Build an OperationStats from a group of edges for one operation.

    Args:
        operation: Operation name.
        domain: Domain name (``"math"``, ``"morphology"``, ``"reasoning"``).
        edges: All positive-knowledge edges for this operation.
        negative_count: Count of DOES_NOT_COMPUTE_TO edges for this operation.

    Returns:
        Populated OperationStats dataclass.
    """
    total = len(edges)
    error_sum = sum(
        int(e.properties.get("error_count", 0)) for e in edges
    )
    confirmed_count = sum(
        1 for e in edges if e.properties.get("guardian_confirmed", False)
    )
    # An edge with zero errors is considered correct
    correct = sum(
        1 for e in edges if int(e.properties.get("error_count", 0)) == 0
    )
    accuracy = _compute_accuracy(correct, total)
    avg_conf = (
        sum(e.confidence for e in edges) / total if total > 0 else 0.0
    )
    trend = _determine_confidence_trend(edges)

    return OperationStats(
        operation=operation,
        domain=domain,
        total_attempts=total,
        correct_count=correct,
        error_count=error_sum,
        accuracy=accuracy,
        average_confidence=avg_conf,
        confidence_trend=trend,
        negative_edges=negative_count,
    )


def _build_domain_report(
    domain: str, stats_list: list[OperationStats]
) -> DomainPerformanceReport:
    """Build a DomainPerformanceReport from per-operation stats.

    Args:
        domain: Domain name.
        stats_list: Per-operation stats for this domain.

    Returns:
        Populated DomainPerformanceReport.
    """
    if not stats_list:
        return DomainPerformanceReport(
            domain=domain,
            overall_accuracy=0.0,
            overall_confidence=0.0,
            operations=[],
            strongest_operation="",
            weakest_operation="",
            total_practice_attempts=0,
        )

    total_attempts = sum(s.total_attempts for s in stats_list)
    total_correct = sum(s.correct_count for s in stats_list)
    overall_accuracy = _compute_accuracy(total_correct, total_attempts)

    # Weighted mean confidence (weighted by attempt count)
    if total_attempts > 0:
        overall_confidence = sum(
            s.average_confidence * s.total_attempts for s in stats_list
        ) / total_attempts
    else:
        overall_confidence = 0.0

    # Only consider operations with at least 1 attempt for strongest/weakest
    with_data = [s for s in stats_list if s.total_attempts > 0]
    if with_data:
        strongest = max(with_data, key=lambda s: s.accuracy)
        weakest = min(with_data, key=lambda s: s.accuracy)
        strongest_op = strongest.operation
        weakest_op = weakest.operation
    else:
        strongest_op = ""
        weakest_op = ""

    return DomainPerformanceReport(
        domain=domain,
        overall_accuracy=overall_accuracy,
        overall_confidence=overall_confidence,
        operations=stats_list,
        strongest_operation=strongest_op,
        weakest_operation=weakest_op,
        total_practice_attempts=total_attempts,
    )


# ---------------------------------------------------------------------------
# Analyzer
# ---------------------------------------------------------------------------


class MetacognitiveAnalyzer:
    """Tracks cognitive performance patterns and identifies strengths/weaknesses.

    Analyzes practice results, validation outcomes, and confidence trajectories
    to build a meta-cognitive picture of Co-Being's capabilities. Reports
    to the guardian on request.

    Three analysis domains:
      1. Mathematical performance (by operation type, operand range)
      2. Morphological performance (by transformation type, word class)
      3. Semantic reasoning performance (by query type, edge type traversed)

    All methods are read-only. They query existing graph state via the
    ``GraphPersistence`` protocol and produce report dataclasses. No graph
    mutations, no LLM calls.

    CANON A.19: Meta-cognition is procedural self-awareness.

    Args:
        persistence: Graph persistence backend satisfying the
            ``GraphPersistence`` protocol.
    """

    def __init__(self, persistence: GraphPersistence) -> None:
        self._persistence = persistence

    # ------------------------------------------------------------------
    # Math domain
    # ------------------------------------------------------------------

    async def analyze_math_performance(self) -> DomainPerformanceReport:
        """Analyze mathematical computation accuracy and trends.

        Queries COMPUTES_TO and DOES_NOT_COMPUTE_TO edges to build
        accuracy statistics per operation type. Each COMPUTES_TO edge
        carries an ``operation`` property identifying the math operation
        (e.g., ``"add"``, ``"subtract"``, ``"multiply"``).

        Returns:
            A DomainPerformanceReport with per-operation breakdowns
            for the math domain.
        """
        # Fetch all COMPUTES_TO edges
        computes_edges = await self._persistence.query_edges(
            EdgeFilter(edge_type=COMPUTES_TO)
        )

        # Fetch all DOES_NOT_COMPUTE_TO edges (negative knowledge)
        negative_edges = await self._persistence.query_edges(
            EdgeFilter(edge_type=_DOES_NOT_COMPUTE_TO)
        )

        # Group positive edges by operation
        by_operation: dict[str, list[KnowledgeEdge]] = defaultdict(list)
        for edge in computes_edges:
            op = edge.properties.get("operation", "unknown")
            by_operation[op].append(edge)

        # Count negative edges by operation
        negative_by_op: dict[str, int] = defaultdict(int)
        for edge in negative_edges:
            op = edge.properties.get("operation", "unknown")
            negative_by_op[op] += 1

        # Build per-operation stats
        all_ops = set(by_operation.keys()) | set(negative_by_op.keys())
        stats_list: list[OperationStats] = []
        for op in sorted(all_ops):
            stats = _build_operation_stats(
                operation=op,
                domain="math",
                edges=by_operation.get(op, []),
                negative_count=negative_by_op.get(op, 0),
            )
            stats_list.append(stats)

        return _build_domain_report("math", stats_list)

    # ------------------------------------------------------------------
    # Morphology domain
    # ------------------------------------------------------------------

    async def analyze_morphology_performance(self) -> DomainPerformanceReport:
        """Analyze morphological transformation accuracy and trends.

        Queries TRANSFORMS_TO edges and their confidence values. Each
        TRANSFORMS_TO edge carries a ``transform_type`` property (e.g.,
        ``"pluralize"``, ``"past_tense"``).

        Returns:
            A DomainPerformanceReport with per-transformation breakdowns
            for the morphology domain.
        """
        transforms_edges = await self._persistence.query_edges(
            EdgeFilter(edge_type=_TRANSFORMS_TO)
        )

        # Group by transform_type
        by_transform: dict[str, list[KnowledgeEdge]] = defaultdict(list)
        for edge in transforms_edges:
            transform = edge.properties.get("transform_type", "unknown")
            by_transform[transform].append(edge)

        stats_list: list[OperationStats] = []
        for transform in sorted(by_transform.keys()):
            stats = _build_operation_stats(
                operation=transform,
                domain="morphology",
                edges=by_transform[transform],
                negative_count=0,  # No negative edges for morphology
            )
            stats_list.append(stats)

        return _build_domain_report("morphology", stats_list)

    # ------------------------------------------------------------------
    # Reasoning domain
    # ------------------------------------------------------------------

    async def analyze_reasoning_performance(
        self,
    ) -> DomainPerformanceReport | None:
        """Analyze semantic reasoning performance.

        Queries SemanticInferenceTrace nodes for success/failure patterns.
        Groups traces by ``query_type`` (definition_query, classification_query,
        inference_query) and computes accuracy based on ``termination_reason``.

        A trace with ``termination_reason == "answer_found"`` is considered
        successful. All other termination reasons (``"no_path_found"``,
        ``"depth_limit_reached"``, ``"no_edges_found"``) are considered
        failures for accuracy calculation.

        Returns:
            A DomainPerformanceReport for the reasoning domain, or ``None``
            if no inference traces exist in the graph.
        """
        trace_nodes = await self._persistence.query_nodes(
            NodeFilter(node_type=_SEMANTIC_INFERENCE_TRACE)
        )

        if not trace_nodes:
            return None

        # Group by query_type
        by_query_type: dict[str, list[dict]] = defaultdict(list)
        for node in trace_nodes:
            query_type = node.properties.get("query_type", "unknown")
            by_query_type[query_type].append({
                "confidence": node.confidence,
                "termination_reason": node.properties.get(
                    "termination_reason", ""
                ),
                "created_at": node.created_at,
            })

        stats_list: list[OperationStats] = []
        for query_type in sorted(by_query_type.keys()):
            traces = by_query_type[query_type]
            total = len(traces)
            correct = sum(
                1
                for t in traces
                if t["termination_reason"] == "answer_found"
            )
            errors = total - correct
            accuracy = _compute_accuracy(correct, total)
            avg_conf = sum(t["confidence"] for t in traces) / total

            # Confidence trend: compare older half vs newer half
            sorted_traces = sorted(traces, key=lambda t: t["created_at"])
            if len(sorted_traces) >= 2:
                mid = len(sorted_traces) // 2
                older_avg = sum(
                    t["confidence"] for t in sorted_traces[:mid]
                ) / mid
                newer_avg = sum(
                    t["confidence"] for t in sorted_traces[mid:]
                ) / (len(sorted_traces) - mid)
                diff = newer_avg - older_avg
                if diff > 0.05:
                    trend = "improving"
                elif diff < -0.05:
                    trend = "declining"
                else:
                    trend = "stable"
            else:
                trend = "stable"

            stats_list.append(
                OperationStats(
                    operation=query_type,
                    domain="reasoning",
                    total_attempts=total,
                    correct_count=correct,
                    error_count=errors,
                    accuracy=accuracy,
                    average_confidence=avg_conf,
                    confidence_trend=trend,
                    negative_edges=0,
                )
            )

        return _build_domain_report("reasoning", stats_list)

    # ------------------------------------------------------------------
    # Weak areas
    # ------------------------------------------------------------------

    async def identify_weak_areas(self) -> list[WeakArea]:
        """Identify areas where performance is below threshold.

        A weak area is any operation/transformation where at least one of:
          - Accuracy < 80%
          - Confidence is declining
          - Error count > 2

        Returns:
            A list of WeakArea instances, sorted by accuracy ascending
            (worst first).
        """
        weak_areas: list[WeakArea] = []

        for report in await self._gather_domain_reports():
            if report is None:
                continue
            for op_stats in report.operations:
                if op_stats.total_attempts == 0:
                    continue

                reasons: list[str] = []
                if op_stats.accuracy < _WEAK_AREA_ACCURACY_THRESHOLD:
                    reasons.append("low_accuracy")
                if op_stats.confidence_trend == "declining":
                    reasons.append("declining_confidence")
                if op_stats.error_count > _WEAK_AREA_MIN_ERRORS:
                    reasons.append("high_error_rate")

                if reasons:
                    suggested = max(
                        _SUGGESTED_PRACTICE_MULTIPLIER,
                        op_stats.error_count * _SUGGESTED_PRACTICE_MULTIPLIER,
                    )
                    weak_areas.append(
                        WeakArea(
                            domain=op_stats.domain,
                            operation=op_stats.operation,
                            accuracy=op_stats.accuracy,
                            error_count=op_stats.error_count,
                            suggested_practice_count=suggested,
                            reason=reasons[0],  # Primary reason
                        )
                    )

        # Sort worst-first
        weak_areas.sort(key=lambda w: w.accuracy)
        return weak_areas

    # ------------------------------------------------------------------
    # Calibration
    # ------------------------------------------------------------------

    async def calibrate_confidence(self) -> CalibrationReport:
        """Compare predicted confidence with actual accuracy.

        For each operation type, compares:
          - Average confidence on edges (predicted competence)
          - Actual accuracy from edge error counts

        Good calibration: predicted ~= actual
        Overconfident: predicted >> actual (dangerous)
        Underconfident: predicted << actual (conservative)

        Returns:
            A CalibrationReport with per-operation calibration analysis.
        """
        overconfident: list[str] = []
        underconfident: list[str] = []
        well_calibrated: list[str] = []
        calibration_errors: list[float] = []

        for report in await self._gather_domain_reports():
            if report is None:
                continue
            for op_stats in report.operations:
                if op_stats.total_attempts < 2:
                    # Not enough data for meaningful calibration
                    continue

                predicted = op_stats.average_confidence
                actual = op_stats.accuracy
                error = abs(predicted - actual)
                calibration_errors.append(error)

                label = f"{op_stats.domain}/{op_stats.operation}"
                if predicted - actual > _CALIBRATION_TOLERANCE:
                    overconfident.append(label)
                elif actual - predicted > _CALIBRATION_TOLERANCE:
                    underconfident.append(label)
                else:
                    well_calibrated.append(label)

        overall_error = (
            sum(calibration_errors) / len(calibration_errors)
            if calibration_errors
            else 0.0
        )

        # Build recommendation
        if overconfident:
            recommendation = (
                f"Overconfident in {len(overconfident)} operation(s). "
                "Co-Being trusts answers that are often wrong. "
                "Additional practice with validation is recommended."
            )
        elif underconfident:
            recommendation = (
                f"Underconfident in {len(underconfident)} operation(s). "
                "Co-Being is better than it thinks. "
                "Continued practice should naturally improve confidence."
            )
        elif well_calibrated:
            recommendation = (
                "Confidence is well-calibrated across all operations. "
                "Co-Being's self-assessment aligns with actual performance."
            )
        else:
            recommendation = (
                "Not enough data to assess calibration. "
                "More practice is needed before calibration is meaningful."
            )

        return CalibrationReport(
            overall_calibration_error=overall_error,
            overconfident_operations=overconfident,
            underconfident_operations=underconfident,
            well_calibrated_operations=well_calibrated,
            recommendation=recommendation,
        )

    # ------------------------------------------------------------------
    # Full report
    # ------------------------------------------------------------------

    async def generate_full_report(self) -> CognitivePerformanceReport:
        """Generate comprehensive meta-cognitive report.

        Combines math, morphology, and reasoning analysis. Identifies weak
        areas and calibration issues. Suitable for guardian presentation.

        Returns:
            A CognitivePerformanceReport combining all domains, weak areas,
            and calibration analysis with a guardian-readable summary.
        """
        math_report = await self.analyze_math_performance()
        morphology_report = await self.analyze_morphology_performance()
        reasoning_report = await self.analyze_reasoning_performance()
        weak_areas = await self.identify_weak_areas()
        calibration = await self.calibrate_confidence()

        # Build summary
        summary_parts: list[str] = []

        total_attempts = (
            math_report.total_practice_attempts
            + morphology_report.total_practice_attempts
            + (reasoning_report.total_practice_attempts if reasoning_report else 0)
        )
        summary_parts.append(
            f"Analyzed {total_attempts} total attempts across "
            f"{len(math_report.operations)} math operations, "
            f"{len(morphology_report.operations)} morphological transformations"
            + (
                f", and {len(reasoning_report.operations)} reasoning query types"
                if reasoning_report
                else ""
            )
            + "."
        )

        if weak_areas:
            weak_names = [f"{w.domain}/{w.operation}" for w in weak_areas[:3]]
            summary_parts.append(
                f"Weak areas: {', '.join(weak_names)}."
            )
        else:
            summary_parts.append("No weak areas identified.")

        if calibration.overconfident_operations:
            summary_parts.append(
                f"Overconfident in {len(calibration.overconfident_operations)} "
                "area(s) -- practice with validation recommended."
            )

        summary = " ".join(summary_parts)

        return CognitivePerformanceReport(
            report_id=f"report:{uuid.uuid4()}",
            timestamp=datetime.now(UTC).isoformat(),
            math_report=math_report,
            morphology_report=morphology_report,
            reasoning_report=reasoning_report,
            weak_areas=weak_areas,
            calibration=calibration,
            summary=summary,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _gather_domain_reports(
        self,
    ) -> list[DomainPerformanceReport | None]:
        """Gather performance reports from all three domains.

        Returns:
            A list of domain reports. The reasoning report may be ``None``
            if no inference traces exist.
        """
        math_report = await self.analyze_math_performance()
        morphology_report = await self.analyze_morphology_performance()
        reasoning_report = await self.analyze_reasoning_performance()
        return [math_report, morphology_report, reasoning_report]


__all__ = [
    "CalibrationReport",
    "CognitivePerformanceReport",
    "DomainPerformanceReport",
    "MetacognitiveAnalyzer",
    "OperationStats",
    "WeakArea",
]

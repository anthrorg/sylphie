"""SemanticContradictionDetector -- conflict detection for semantic edges (Phase 1.8, P1.8-E2/T006).

Detects when a proposed semantic edge would conflict with an existing semantic
edge in the graph. This is a parallel class to
``cobeing.layer3_knowledge.contradiction_detector.ContradictionDetector``, which
operates on COMPUTES_TO edges in the procedural domain.

The two detectors are structurally distinct because the contradiction patterns
they handle are domain-specific:

  ContradictionDetector (procedural domain):
    Same (operation, operand_ids) -> two different result ValueNodes.
    The semantic meaning is: "the same computation produced two different answers."

  SemanticContradictionDetector (semantic domain):
    Two edges that are logically incompatible per the IS_A asymmetry axiom or
    the HAS_PROPERTY / LACKS_PROPERTY negation pairing.
    The semantic meaning is: "the graph contains mutually exclusive claims about
    the world."

These classes do NOT share a base class.
Per Forge analysis invariant 3: parallel classes with different problem domains.

Contradiction patterns handled:

  Pattern A -- IS_A cycle (asymmetry violation):
    The IS_A relationship must be asymmetric. If the graph contains
    IS_A(A, B), then asserting IS_A(B, A) would create a cycle.
    The asymmetry axiom is stored as a LogicalAxiom node
    (``axiom:IS_A:asymmetry``) installed by P1.8-E1.
    The detector consults these LogicalAxiom nodes at runtime so that future
    axiom additions automatically extend detection coverage.
    This check looks for a direct reverse edge (one hop). Transitive cycle
    detection (A -> B -> C -> A) is deferred to E3/E4.

  Pattern B -- CAUSES cycle (asymmetry violation):
    Same detection logic as IS_A, applied to CAUSES edges.
    CAUSES is also governed by an asymmetry axiom (``axiom:CAUSES:asymmetry``).

  Pattern C -- Property negation (direct negation conflict):
    HAS_PROPERTY(subject, X) and LACKS_PROPERTY(subject, X) cannot both be
    true for the same (subject, object) pair.
    Detecting HAS_PROPERTY vs. LACKS_PROPERTY is symmetric.

Conflict storage (bidirectional cross-linking):
  When a conflict is detected the existing edge is marked with:
    - has_conflict = True
    - conflict_type = <category_label>
    - contradiction_severity = <alpha|beta|gamma>
    - conflicting_proposed_edge_id = <proposed_edge_id>
    - confidence halved (multiplied by 0.5)
  The proposed edge is NOT written. However, a deterministic proposed edge ID
  is generated and stored on the existing edge so the cross-link is
  bidirectional. The full conflict context is recorded in the ArbitrationRequest
  INSTANCE node created by SemanticTeachingHandler Step 3.

  Contradiction detection blocks edge write -- no partial state is written.

Contradiction severity classification (Piaget equilibration theory):
  Per Piaget (1975), "The Equilibration of Cognitive Structures," cognitive
  conflicts are not all equivalent. Three severity levels:

  Alpha: Local correction. Affects only the two directly conflicting edges.
    Can be resolved by updating a single edge without cascading changes.
    Most contradictions fall here.

  Beta: Partial restructuring. The conflicting nodes are hub nodes with many
    dependent edges. The contradiction reveals a schema-level boundary problem.
    Handling: guardian arbitration + logged warning for meta-schema review.

  Gamma: Fundamental structural violation. Nodes have high connectivity;
    resolution requires systematic schema restructuring. Rare.
    Handling: guardian arbitration + explicit escalation log.

GUARDIAN trust:
  Per Piaget analysis (E2 decisions), guardian fallibility is accepted at this
  developmental stage. The detector records the conflict, halves confidence on
  the existing edge, and defers resolution to the guardian via ArbitrationRequest.

  Alpha-level corrections are handled locally. Beta/Gamma-level contradictions
  are logged for meta-schema evolution review.

LogicalAxiom node consultation:
  The detector reads LogicalAxiom META_SCHEMA nodes from the graph to determine
  which edge types are governed by write-time asymmetry axioms. This makes the
  detection extensible: future skill packages that add new asymmetry axioms
  automatically expand coverage without code changes.
  Fallback set _FALLBACK_ASYMMETRIC_EDGE_TYPES covers IS_A and CAUSES.

Phase 1.8 (Comprehension Layer, P1.8-E2/T006).
CANON A.1 (experience-first), A.18 (TAUGHT_PROCEDURE), A.20 (domain structure).
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import ClassVar

from cobeing.layer3_knowledge.node_types import KnowledgeEdge
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter
from cobeing.layer3_knowledge.semantic_types import (
    CAUSES,
    HAS_PROPERTY,
    IS_A,
    LACKS_PROPERTY,
    LOGICAL_AXIOM,
)
from cobeing.shared.event_bus import EventBus
from cobeing.shared.types import EdgeId, NodeId

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Severity classification thresholds
# ---------------------------------------------------------------------------

#: Number of outgoing semantic edges on a hub node that triggers Beta severity.
BETA_SEVERITY_EDGE_THRESHOLD: int = 5

#: Number of outgoing edges on a hub node that triggers Gamma severity.
GAMMA_SEVERITY_EDGE_THRESHOLD: int = 15


# ---------------------------------------------------------------------------
# Fallback asymmetric edge types (used when LogicalAxiom nodes are absent)
# ---------------------------------------------------------------------------

_FALLBACK_ASYMMETRIC_EDGE_TYPES: frozenset[str] = frozenset({IS_A, CAUSES})
"""Fallback set of asymmetric edge types.

Used when the LogicalAxiom graph nodes installed by the semantic-ontology skill
package (P1.8-E1) are absent -- for example during testing without a full
bootstrap, or when the detector is invoked before bootstrap completes.

This set matches the two write-time asymmetry axioms:
  - axiom:IS_A:asymmetry
  - axiom:CAUSES:asymmetry
"""


# ---------------------------------------------------------------------------
# Contradiction severity
# ---------------------------------------------------------------------------


class ContradictionSeverity(str, Enum):
    """Equilibration-theoretic severity classification for semantic contradictions.

    Grounded in Piaget (1975), "The Equilibration of Cognitive Structures."
    Distinguishes three levels of cognitive restructuring needed to resolve
    the contradiction, corresponding to the scope of schema changes required.

    Values
    ------
    ALPHA:
        Local correction. The conflict affects only the two directly
        contradicting edges. Resolution is a single edge update with no
        cascading schema changes required. The vast majority of guardian
        corrections fall here.

    BETA:
        Partial restructuring. The conflicting nodes are schema hubs with
        enough dependent edges that resolution may require reviewing and
        updating related facts. This signals a possible category boundary
        problem: a concept may be too broadly or narrowly defined.
        Logged for meta-schema evolution review.

    GAMMA:
        Fundamental structural violation. The nodes involved are highly
        connected, and resolving the contradiction would require systematic
        restructuring of the surrounding schema region. This is rare and
        maps to the Kuhnian paradigm-shift level of accommodation. Logged
        as an explicit escalation signal for meta-schema evolution tracking.
    """

    ALPHA = "alpha"
    BETA = "beta"
    GAMMA = "gamma"


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SemanticConflict:
    """Describes a detected semantic contradiction.

    Attributes:
        conflict_found: True if a contradiction was detected.
        conflict_type: Human-readable category label for the conflict.
            One of: "IS_A_cycle", "CAUSES_cycle",
            "HAS_PROPERTY_vs_LACKS_PROPERTY", or "{EDGE_TYPE}_cycle"
            for future asymmetric edge types.
            Empty string if no conflict was found.
        severity: Equilibration-theoretic severity level per Piaget (1975).
            ALPHA = local correction, BETA = partial restructuring,
            GAMMA = fundamental structural violation.
            Defaults to ALPHA when no conflict found (sentinel value).
        existing_edge_id: EdgeId of the edge that conflicts with the proposal.
            Empty string if no conflict was found.
        proposed_edge_id: Generated EdgeId for the proposed (not-yet-written)
            edge. Used for bidirectional cross-linking: the existing edge stores
            this ID in ``conflicting_proposed_edge_id``. The ArbitrationRequest
            node also records both IDs. Empty string if no conflict.
        existing_edge_confidence_before: The confidence on the existing edge
            BEFORE this method halved it (audit purposes). 0.0 if no conflict.
        natural_language_summary: Guardian-facing description of the conflict,
            including severity context for Beta/Gamma level conflicts.
            Phrased as a question for guardian resolution. Empty if no conflict.
    """

    conflict_found: bool
    conflict_type: str = field(default="")
    severity: ContradictionSeverity = field(default=ContradictionSeverity.ALPHA)
    existing_edge_id: str = field(default="")
    proposed_edge_id: str = field(default="")
    existing_edge_confidence_before: float = field(default=0.0)
    natural_language_summary: str = field(default="")


# ---------------------------------------------------------------------------
# SemanticContradictionDetector
# ---------------------------------------------------------------------------


class SemanticContradictionDetector:
    """Detect and record conflicts between semantic edges.

    This class is NOT a subclass of ContradictionDetector. It is a parallel
    class with domain-specific conflict patterns. The only shared behavior is
    the structural pattern of halving edge confidence on conflict, reimplemented
    here for the semantic domain.

    The detector consults LogicalAxiom META_SCHEMA nodes from the graph at
    runtime to discover which edge types are governed by write-time asymmetry
    axioms. This makes coverage extensible without code changes.

    Contradiction severity is classified per Piaget (1975) equilibration
    theory: Alpha (local correction), Beta (partial restructuring), Gamma
    (fundamental structural violation).

    Attributes:
        _persistence: The graph persistence backend.
        _event_bus: Optional event bus for SemanticContradictionEvent.
    """

    _ASYMMETRY_AXIOM_TYPE: ClassVar[str] = "asymmetry"
    _WRITE_TIME_ENFORCEMENT: ClassVar[str] = "write_time"

    def __init__(
        self,
        persistence: GraphPersistence,
        event_bus: EventBus | None = None,
    ) -> None:
        """Construct a SemanticContradictionDetector.

        Args:
            persistence: Graph persistence backend. Required.
            event_bus: Optional event bus. When provided, a
                SemanticContradictionEvent is published after each conflict.
        """
        self._persistence = persistence
        self._event_bus = event_bus

    async def check_and_record(
        self,
        subject_id: NodeId,
        object_id: NodeId,
        proposed_edge_type: str,
        subject_lemma: str,
        object_lemma: str,
        session_id: str,
        correlation_id: str,
    ) -> SemanticConflict:
        """Check for a semantic contradiction and record conflict state.

        Runs two checks in sequence. The first conflict found is returned.

        1. Asymmetry cycle check: IS_A, CAUSES, and any future asymmetric
           edge types from LogicalAxiom graph nodes.
        2. Property negation check: HAS_PROPERTY vs LACKS_PROPERTY.

        On conflict:
          - Existing edge confidence halved.
          - has_conflict, conflict_type, contradiction_severity, and
            conflicting_proposed_edge_id written to the existing edge.
          - SemanticContradictionEvent published (if event_bus set).
          - Severity classified (Alpha/Beta/Gamma) and returned.

        The proposed edge is NOT written. The caller (SemanticTeachingHandler)
        aborts the pipeline when conflict_found=True.
        No partial writes occur -- the graph remains consistent.

        Args:
            subject_id: NodeId of the subject WordSenseNode.
            object_id: NodeId of the object WordSenseNode.
            proposed_edge_type: The semantic edge type being proposed.
            subject_lemma: Human-readable lemma for subject.
            object_lemma: Human-readable lemma for object.
            session_id: Current session ID for tracing.
            correlation_id: Correlation ID for log tracing.

        Returns:
            SemanticConflict describing whether a conflict was found.
            Always returns a value -- never raises unless persistence raises.

        Raises:
            Any exception from GraphPersistence methods propagates.
        """
        # Load asymmetric edge types from LogicalAxiom nodes (extensible coverage)
        asymmetric_types = await self._load_asymmetric_edge_types_from_graph()

        # --- Pattern A/B: Asymmetry cycle check ---
        if proposed_edge_type in asymmetric_types:
            conflict = await self._check_asymmetry_cycle(
                subject_id=subject_id,
                object_id=object_id,
                proposed_edge_type=proposed_edge_type,
                subject_lemma=subject_lemma,
                object_lemma=object_lemma,
                session_id=session_id,
                correlation_id=correlation_id,
            )
            if conflict.conflict_found:
                return conflict

        # --- Pattern C: Property negation check ---
        if proposed_edge_type in (HAS_PROPERTY, LACKS_PROPERTY):
            conflict = await self._check_property_negation(
                subject_id=subject_id,
                object_id=object_id,
                proposed_edge_type=proposed_edge_type,
                subject_lemma=subject_lemma,
                object_lemma=object_lemma,
                session_id=session_id,
                correlation_id=correlation_id,
            )
            if conflict.conflict_found:
                return conflict

        return SemanticConflict(conflict_found=False)

    # ------------------------------------------------------------------
    # LogicalAxiom discovery
    # ------------------------------------------------------------------

    async def _load_asymmetric_edge_types_from_graph(self) -> frozenset[str]:
        """Read LogicalAxiom nodes to discover write-time asymmetry axioms.

        Queries for all LogicalAxiom META_SCHEMA nodes, filters to those with
        axiom_type == "asymmetry" and enforcement == "write_time", and returns
        the set of governed_edge_type values. This makes detection extensible:
        future skill packages add axioms; coverage expands automatically.

        Falls back to _FALLBACK_ASYMMETRIC_EDGE_TYPES when no write-time
        asymmetry axioms are present (e.g., bootstrap not yet run).

        Returns:
            frozenset of edge type strings. Always non-empty.
        """
        try:
            axiom_nodes = await self._persistence.query_nodes(
                NodeFilter(node_type=LOGICAL_AXIOM)
            )
            asymmetric_types: set[str] = set()
            for node in axiom_nodes:
                axiom_type = node.properties.get("axiom_type", "")
                enforcement = node.properties.get("enforcement", "")
                governed_edge_type = node.properties.get("governed_edge_type", "")
                if (
                    axiom_type == self._ASYMMETRY_AXIOM_TYPE
                    and enforcement == self._WRITE_TIME_ENFORCEMENT
                    and governed_edge_type
                ):
                    asymmetric_types.add(governed_edge_type)
            if asymmetric_types:
                return frozenset(asymmetric_types)
            _log.debug(
                "SemanticContradictionDetector: no write-time asymmetry axioms "
                "found -- using fallback set %s",
                sorted(_FALLBACK_ASYMMETRIC_EDGE_TYPES),
            )
            return _FALLBACK_ASYMMETRIC_EDGE_TYPES
        except Exception as exc:
            _log.warning(
                "SemanticContradictionDetector: failed to query LogicalAxiom "
                "nodes (%s) -- using fallback asymmetric type set",
                exc,
            )
            return _FALLBACK_ASYMMETRIC_EDGE_TYPES

    # ------------------------------------------------------------------
    # Severity classification
    # ------------------------------------------------------------------

    async def _classify_contradiction_severity(
        self,
        subject_id: NodeId,
        object_id: NodeId,
        conflict_type: str,
    ) -> ContradictionSeverity:
        """Classify contradiction severity per Piaget equilibration theory.

        Examines outgoing connectivity of subject and object nodes. High
        connectivity means more dependent facts that may need review when the
        contradiction is resolved.

        GAMMA if max outgoing edges >= GAMMA_SEVERITY_EDGE_THRESHOLD (15).
        BETA if max outgoing edges >= BETA_SEVERITY_EDGE_THRESHOLD (5).
        ALPHA otherwise (direct local correction, the common case).

        Beta and Gamma are logged for meta-schema evolution review per the
        Piaget E2 agent analysis (Section 7).

        Returns:
            ContradictionSeverity enum value. Defaults to ALPHA on failure.
        """
        try:
            subject_edges = await self._persistence.query_edges(
                EdgeFilter(source_node_id=str(subject_id))
            )
            object_edges = await self._persistence.query_edges(
                EdgeFilter(source_node_id=str(object_id))
            )
            max_connectivity = max(len(subject_edges), len(object_edges))
            if max_connectivity >= GAMMA_SEVERITY_EDGE_THRESHOLD:
                _log.warning(
                    "SemanticContradictionDetector: GAMMA severity "
                    "(conflict_type=%s, subject=%s edges=%d, object=%s edges=%d). "
                    "Fundamental restructuring may be required.",
                    conflict_type, subject_id, len(subject_edges),
                    object_id, len(object_edges),
                )
                return ContradictionSeverity.GAMMA
            if max_connectivity >= BETA_SEVERITY_EDGE_THRESHOLD:
                _log.warning(
                    "SemanticContradictionDetector: BETA severity "
                    "(conflict_type=%s, subject=%s edges=%d, object=%s edges=%d). "
                    "Partial restructuring may be required.",
                    conflict_type, subject_id, len(subject_edges),
                    object_id, len(object_edges),
                )
                return ContradictionSeverity.BETA
            return ContradictionSeverity.ALPHA
        except Exception as exc:
            _log.warning(
                "SemanticContradictionDetector: severity classification failed "
                "(%s) -- defaulting to ALPHA",
                exc,
            )
            return ContradictionSeverity.ALPHA

    # ------------------------------------------------------------------
    # Pattern A/B: Asymmetry cycle detection
    # ------------------------------------------------------------------

    async def _check_asymmetry_cycle(
        self,
        subject_id: NodeId,
        object_id: NodeId,
        proposed_edge_type: str,
        subject_lemma: str,
        object_lemma: str,
        session_id: str,
        correlation_id: str,
    ) -> SemanticConflict:
        """Check if proposed_edge_type(subject, object) creates a direct cycle.

        Queries for an existing active edge of proposed_edge_type in the
        reverse direction: (object)-[proposed_edge_type]->(subject).
        If such an edge exists, the proposed edge would create a direct one-hop
        cycle (A->B and B->A), violating the asymmetry axiom.

        Transitive cycle detection (A->B->C->A) is deferred to E3/E4.

        Args:
            subject_id, object_id: The proposed edge endpoints.
            proposed_edge_type: An edge type in the asymmetric types set.
            subject_lemma, object_lemma: For human-readable summaries.
            session_id, correlation_id: For tracing.

        Returns:
            SemanticConflict with conflict_found=True if a cycle would be
            created. SemanticConflict with conflict_found=False otherwise.
        """
        reverse_edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=proposed_edge_type,
                source_node_id=str(object_id),
                target_node_id=str(subject_id),
            )
        )
        active_reverse = [
            e for e in reverse_edges
            if not e.properties.get("deprecated", False)
            and e.properties.get("valid_to") is None
        ]
        if not active_reverse:
            return SemanticConflict(conflict_found=False)

        conflicting_edge = active_reverse[0]
        conflict_type = f"{proposed_edge_type}_cycle"

        proposed_edge_id = _generate_proposed_edge_id(
            subject_id=subject_id, object_id=object_id,
            edge_type=proposed_edge_type, correlation_id=correlation_id,
        )
        severity = await self._classify_contradiction_severity(
            subject_id=subject_id, object_id=object_id, conflict_type=conflict_type,
        )
        natural_language_summary = _build_cycle_summary(
            subject_lemma=subject_lemma, object_lemma=object_lemma,
            edge_type=proposed_edge_type, severity=severity,
        )

        _log.warning(
            "SemanticContradictionDetector: %s cycle detected "
            "subject='%s' object='%s' (existing=%s severity=%s corr=%s)",
            proposed_edge_type, subject_lemma, object_lemma,
            conflicting_edge.edge_id, severity.value, correlation_id,
        )

        updated_edge = await self._mark_conflict_on_existing_edge(
            edge=conflicting_edge, conflict_type=conflict_type,
            proposed_edge_id=proposed_edge_id, severity=severity,
            correlation_id=correlation_id,
        )

        if self._event_bus is not None:
            await self._publish_contradiction_event(
                subject_id=subject_id, object_id=object_id,
                subject_lemma=subject_lemma, object_lemma=object_lemma,
                proposed_edge_type=proposed_edge_type,
                existing_edge_id=str(conflicting_edge.edge_id),
                conflict_type=conflict_type,
                natural_language_summary=natural_language_summary,
                session_id=session_id, correlation_id=correlation_id,
            )

        return SemanticConflict(
            conflict_found=True,
            conflict_type=conflict_type,
            severity=severity,
            existing_edge_id=str(conflicting_edge.edge_id),
            proposed_edge_id=proposed_edge_id,
            existing_edge_confidence_before=updated_edge.confidence * 2.0,
            natural_language_summary=natural_language_summary,
        )

    # ------------------------------------------------------------------
    # Pattern C: Property negation detection
    # ------------------------------------------------------------------

    async def _check_property_negation(
        self,
        subject_id: NodeId,
        object_id: NodeId,
        proposed_edge_type: str,
        subject_lemma: str,
        object_lemma: str,
        session_id: str,
        correlation_id: str,
    ) -> SemanticConflict:
        """Check for a HAS_PROPERTY / LACKS_PROPERTY direct conflict.

        If proposing HAS_PROPERTY(subject, object), checks whether an active
        LACKS_PROPERTY(subject, object) edge already exists, and vice versa.

        Args:
            subject_id, object_id: The proposed edge endpoints.
            proposed_edge_type: HAS_PROPERTY or LACKS_PROPERTY.
            subject_lemma, object_lemma: For human-readable summaries.
            session_id, correlation_id: For tracing.

        Returns:
            SemanticConflict with conflict_found=True if the opposing
            property edge exists. SemanticConflict(conflict_found=False) otherwise.
        """
        inverse_type = (
            LACKS_PROPERTY if proposed_edge_type == HAS_PROPERTY else HAS_PROPERTY
        )
        opposing_edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=inverse_type,
                source_node_id=str(subject_id),
                target_node_id=str(object_id),
            )
        )
        active_opposing = [
            e for e in opposing_edges
            if not e.properties.get("deprecated", False)
            and e.properties.get("valid_to") is None
        ]
        if not active_opposing:
            return SemanticConflict(conflict_found=False)

        conflicting_edge = active_opposing[0]
        conflict_type = "HAS_PROPERTY_vs_LACKS_PROPERTY"

        proposed_edge_id = _generate_proposed_edge_id(
            subject_id=subject_id, object_id=object_id,
            edge_type=proposed_edge_type, correlation_id=correlation_id,
        )
        severity = await self._classify_contradiction_severity(
            subject_id=subject_id, object_id=object_id, conflict_type=conflict_type,
        )
        natural_language_summary = _build_property_negation_summary(
            subject_lemma=subject_lemma, object_lemma=object_lemma,
            proposed_edge_type=proposed_edge_type, inverse_type=inverse_type,
            severity=severity,
        )

        _log.warning(
            "SemanticContradictionDetector: property negation '%s'->'%s' "
            "(proposed=%s existing=%s edge=%s severity=%s corr=%s)",
            subject_lemma, object_lemma, proposed_edge_type,
            inverse_type, conflicting_edge.edge_id, severity.value, correlation_id,
        )

        updated_edge = await self._mark_conflict_on_existing_edge(
            edge=conflicting_edge, conflict_type=conflict_type,
            proposed_edge_id=proposed_edge_id, severity=severity,
            correlation_id=correlation_id,
        )

        if self._event_bus is not None:
            await self._publish_contradiction_event(
                subject_id=subject_id, object_id=object_id,
                subject_lemma=subject_lemma, object_lemma=object_lemma,
                proposed_edge_type=proposed_edge_type,
                existing_edge_id=str(conflicting_edge.edge_id),
                conflict_type=conflict_type,
                natural_language_summary=natural_language_summary,
                session_id=session_id, correlation_id=correlation_id,
            )

        return SemanticConflict(
            conflict_found=True,
            conflict_type=conflict_type,
            severity=severity,
            existing_edge_id=str(conflicting_edge.edge_id),
            proposed_edge_id=proposed_edge_id,
            existing_edge_confidence_before=updated_edge.confidence * 2.0,
            natural_language_summary=natural_language_summary,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _mark_conflict_on_existing_edge(
        self,
        edge: KnowledgeEdge,
        conflict_type: str,
        proposed_edge_id: str,
        severity: ContradictionSeverity,
        correlation_id: str,
    ) -> KnowledgeEdge:
        """Mark an existing edge as conflicted, halve its confidence, and cross-link.

        Modifies the edge in place (mutates properties and confidence), then
        saves it back to the persistence backend.

        Fields modified on the existing edge:
          - has_conflict: set to True
          - conflict_type: set to the conflict_type label
          - contradiction_severity: alpha, beta, or gamma
          - conflicting_proposed_edge_id: the generated proposed edge ID,
            completing the bidirectional cross-link. The ArbitrationRequest
            node (created by the handler) also records both IDs.
          - confidence: multiplied by 0.5 (halved)

        Args:
            edge: The KnowledgeEdge to mark. Mutated in place.
            conflict_type: Label for the conflict category.
            proposed_edge_id: ID of the proposed (not-yet-written) edge.
            severity: Equilibration-theoretic severity classification.
            correlation_id: For log tracing.

        Returns:
            The mutated edge after saving.

        Raises:
            Any exception from GraphPersistence.save_edge propagates.
        """
        original_confidence = edge.confidence
        edge.confidence = max(0.0, edge.confidence * 0.5)

        edge.properties["has_conflict"] = True
        edge.properties["conflict_type"] = conflict_type
        edge.properties["contradiction_severity"] = severity.value
        edge.properties["conflicting_proposed_edge_id"] = proposed_edge_id

        await self._persistence.save_edge(edge)

        _log.info(
            "SemanticContradictionDetector: marked edge '%s' as conflicted "
            "(type=%s severity=%s confidence: %.3f->%.3f proposed_edge=%s corr=%s)",
            edge.edge_id, conflict_type, severity.value,
            original_confidence, edge.confidence,
            proposed_edge_id, correlation_id,
        )
        return edge

    async def _publish_contradiction_event(
        self,
        subject_id: NodeId,
        object_id: NodeId,
        subject_lemma: str,
        object_lemma: str,
        proposed_edge_type: str,
        existing_edge_id: str,
        conflict_type: str,
        natural_language_summary: str,
        session_id: str,
        correlation_id: str,
    ) -> None:
        """Publish a SemanticContradictionEvent to the event bus.

        Failure to publish is non-fatal: an exception is caught and logged.
        The contradiction is already recorded in the graph -- event publication
        is a notification, not a write.

        The event is intended for same-turn guardian arbitration: the
        ConversationManager subscribes and surfaces the natural_language_summary
        to the guardian for resolution within the current conversation turn.
        """
        try:
            from cobeing.shared.event_types import SemanticContradictionEvent  # noqa: PLC0415
            from cobeing.shared.types import CorrelationId  # noqa: PLC0415

            event = SemanticContradictionEvent(
                subject_node_id=str(subject_id),
                object_node_id=str(object_id),
                subject_lemma=subject_lemma,
                object_lemma=object_lemma,
                proposed_edge_type=proposed_edge_type,
                existing_edge_id=existing_edge_id,
                conflict_type=conflict_type,
                natural_language_summary=natural_language_summary,
                session_id=session_id,
                correlation_id=CorrelationId(correlation_id),
            )
            await self._event_bus.publish(event)  # type: ignore[union-attr]
        except Exception as exc:
            _log.warning(
                "SemanticContradictionDetector: failed to publish "
                "SemanticContradictionEvent (correlation=%s): %s",
                correlation_id, exc,
            )


# ---------------------------------------------------------------------------
# Module-level helpers (pure functions, no graph access)
# ---------------------------------------------------------------------------


def _generate_proposed_edge_id(
    subject_id: NodeId,
    object_id: NodeId,
    edge_type: str,
    correlation_id: str,
) -> str:
    """Generate a unique ID for the proposed (not-yet-written) edge.

    The proposed edge is never written to the graph. Its ID is used only for
    bidirectional cross-linking: the existing edge stores this ID in
    conflicting_proposed_edge_id. The ArbitrationRequest node also records it.

    Format: proposed:{edge_type}:{subject_short}:{object_short}:{suffix}

    Args:
        subject_id, object_id: NodeId pair for the proposed edge endpoints.
        edge_type: The semantic edge type being proposed.
        correlation_id: Last 8 chars used as suffix; UUID4 if too short.

    Returns:
        String edge ID for the proposed edge.
    """
    suffix = correlation_id[-8:] if len(correlation_id) >= 8 else uuid.uuid4().hex[:8]
    subject_short = str(subject_id)[:24].replace(":", "_")
    object_short = str(object_id)[:24].replace(":", "_")
    return f"proposed:{edge_type}:{subject_short}:{object_short}:{suffix}"


def _build_cycle_summary(
    subject_lemma: str,
    object_lemma: str,
    edge_type: str,
    severity: ContradictionSeverity,
) -> str:
    """Build a guardian-facing natural language summary for a cycle contradiction.

    Includes severity context for Beta and Gamma contradictions.
    """
    severity_context = _severity_context_phrase(severity)
    return (
        f"I have conflicting information: you said "
        f"'{ subject_lemma} {edge_type} {object_lemma}', but the graph "
        f"already records '{object_lemma} {edge_type} {subject_lemma}'. "
        f"These two together would create a cycle, which the {edge_type} "
        f"asymmetry rule forbids. {severity_context}"
        f"Which direction is correct?"
    )


def _build_property_negation_summary(
    subject_lemma: str,
    object_lemma: str,
    proposed_edge_type: str,
    inverse_type: str,
    severity: ContradictionSeverity,
) -> str:
    """Build a guardian-facing natural language summary for a property negation conflict.

    Includes severity context for Beta and Gamma contradictions.
    """
    severity_context = _severity_context_phrase(severity)
    return (
        f"I have conflicting information: you said "
        f"'{ subject_lemma} {proposed_edge_type} {object_lemma}', but the graph "
        f"already records '{subject_lemma} {inverse_type} {object_lemma}'. "
        f"These two claims directly contradict each other. "
        f"{severity_context}"
        f"Which is correct?"
    )


def _severity_context_phrase(severity: ContradictionSeverity) -> str:
    """Return a brief severity-appropriate context phrase for guardian messages.

    Alpha contradictions need no extra context (simple local corrections).
    Beta and Gamma include a note about scope so the guardian understands
    why the system is flagging the issue more prominently.

    Returns:
        A brief string for embedding in natural language summaries.
        Empty string for ALPHA.
    """
    if severity == ContradictionSeverity.BETA:
        return (
            "This concept is connected to several other facts in my knowledge, "
            "so getting this right matters for related reasoning. "
        )
    if severity == ContradictionSeverity.GAMMA:
        return (
            "This concept is highly connected in my knowledge graph -- "
            "resolving this correctly is important because many other facts "
            "depend on it. "
        )
    return ""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    "ContradictionSeverity",
    "SemanticConflict",
    "SemanticContradictionDetector",
    "BETA_SEVERITY_EDGE_THRESHOLD",
    "GAMMA_SEVERITY_EDGE_THRESHOLD",
]

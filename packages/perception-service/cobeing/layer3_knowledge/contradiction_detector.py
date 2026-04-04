"""Contradiction detector for the Procedural Knowledge Graph (PKG-2.4).

Detects when the same (operation, operand_ids) computation produces two
different result ValueNodes. This occurs when a procedure execution yields
a value that conflicts with an existing COMPUTES_TO edge pointing to a
different result.

When a contradiction is found, the detector:

1. Creates a new conflict COMPUTES_TO edge for the second result.
2. Halves the confidence on both the existing and new edges.
3. Increments ``error_count`` on both edges.
4. Cross-links both edges via ``has_conflict`` and ``conflicting_edge_id``
   properties.
5. Emits a ``ContradictionDetectedEvent`` on the event bus (if available).

This is Layer 3 infrastructure. It never calls the LLM. Resolution of
contradictions (which result is correct?) is a guardian/Layer 4 concern.

Usage::

    from cobeing.layer3_knowledge.contradiction_detector import (
        ContradictionDetector,
        ContradictionResult,
    )

    detector = ContradictionDetector(graph=persistence, event_bus=bus)
    result = await detector.check_and_record(
        operation="add",
        operand_ids=[NodeId("value:integer:2"), NodeId("value:integer:3")],
        new_result_node_id=NodeId("value:integer:6"),  # wrong!
        new_result_value=6,
        existing_edge=existing_computes_to_edge,
        correlation_id="session-0042",
    )
    if result.contradiction_found:
        print(f"Conflict between edges: {result.conflicting_edge_ids}")

Phase 1.6 (PKG-2.4). CANON A.18 (TAUGHT_PROCEDURE provenance).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from cobeing.layer3_knowledge.node_types import KnowledgeEdge
from cobeing.layer3_knowledge.procedure_types import COMPUTES_TO
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.shared.event_bus import EventBus
from cobeing.shared.event_types import ContradictionDetectedEvent
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import CorrelationId, EdgeId, NodeId

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ContradictionResult:
    """Result of a contradiction check.

    Attributes:
        contradiction_found: True if the new result conflicts with an
            existing non-deprecated COMPUTES_TO edge pointing to a
            different target node.
        conflicting_edge_ids: EdgeId strings of both edges involved in
            the contradiction. Empty list if no contradiction was found.
    """

    contradiction_found: bool
    conflicting_edge_ids: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Initial confidence for new conflict edges
# ---------------------------------------------------------------------------

_CONFLICT_INITIAL_CONFIDENCE: float = 0.15
"""Initial confidence for a newly-created conflict COMPUTES_TO edge.

Matches BASE_PROCEDURAL from instance_confidence.py. Imported as a
literal to avoid a dependency cycle (instance_confidence -> ? -> here).
"""


# ---------------------------------------------------------------------------
# ContradictionDetector
# ---------------------------------------------------------------------------


class ContradictionDetector:
    """Detects and records contradictions between COMPUTES_TO edges.

    When the same (operation, operand_ids) pair produces a different result
    than an existing edge, this detector creates a conflict edge, halves
    confidence on both edges, and emits a ``ContradictionDetectedEvent``.

    Args:
        graph: The graph persistence backend for reading/writing edges.
        event_bus: Optional event bus for emitting contradiction events.
            When ``None``, events are accumulated in ``pending_events``
            for the caller to process. This allows the detector to work
            in contexts where no event bus is wired (e.g., unit tests,
            standalone scripts).

    Attributes:
        pending_events: List of ``ContradictionDetectedEvent`` instances
            that were created but could not be emitted because no event
            bus was provided. Callers should drain this list after each
            ``check_and_record`` call if they need to process events
            manually.
    """

    def __init__(
        self,
        graph: GraphPersistence,
        event_bus: EventBus | None = None,
    ) -> None:
        self._graph = graph
        self._event_bus = event_bus
        self.pending_events: list[ContradictionDetectedEvent] = []

    async def check_and_record(
        self,
        operation: str,
        operand_ids: list[NodeId],
        new_result_node_id: NodeId,
        new_result_value: Any,
        existing_edge: KnowledgeEdge | None,
        correlation_id: str = "",
    ) -> ContradictionResult:
        """Check for a contradiction and record it if found.

        Compares the new result against an existing COMPUTES_TO edge for
        the same (operation, operand_ids). If the existing edge points to
        a different target node, a contradiction is detected and recorded.

        Args:
            operation: The operation name (e.g., ``"add"``, ``"multiply"``).
            operand_ids: NodeId strings of the operands involved.
            new_result_node_id: NodeId of the newly-computed result ValueNode.
            new_result_value: The Python value of the new result.
            existing_edge: The existing COMPUTES_TO edge for this
                (operation, operand_ids), or ``None`` if no edge exists.
            correlation_id: For tracing through the system. Defaults to
                empty string.

        Returns:
            A ``ContradictionResult`` indicating whether a contradiction
            was found and which edge IDs are involved.
        """
        no_contradiction = ContradictionResult(
            contradiction_found=False, conflicting_edge_ids=[]
        )

        # Case 1: No existing edge -- no contradiction possible
        if existing_edge is None:
            return no_contradiction

        # Case 1b: Existing edge is deprecated -- no contradiction possible
        if existing_edge.properties.get("deprecated", False):
            return no_contradiction

        # Case 2: Same result -- no contradiction
        if existing_edge.target_id == new_result_node_id:
            return no_contradiction

        # Case 3: Contradiction detected -- different result for same inputs
        logger.warning(
            "Contradiction detected: operation=%s operands=%s "
            "existing_target=%s new_target=%s",
            operation,
            operand_ids,
            existing_edge.target_id,
            new_result_node_id,
        )

        # (a) Create a new conflict COMPUTES_TO edge
        operand_id_strs = [str(oid) for oid in operand_ids]
        first_operand_id = operand_id_strs[0] if operand_id_strs else ""
        conflict_edge_id = EdgeId(
            f"edge:computes_to:{first_operand_id}:{operation}"
            f":conflict:{new_result_node_id}"
        )

        conflict_edge = KnowledgeEdge(
            edge_id=conflict_edge_id,
            source_id=NodeId(first_operand_id) if first_operand_id else existing_edge.source_id,
            target_id=new_result_node_id,
            edge_type=COMPUTES_TO,
            properties={
                "operation": operation,
                "operand_ids": operand_id_strs,
                "confidence": _CONFLICT_INITIAL_CONFIDENCE,
                "encounter_count": 1,
                "first_computed": None,
                "last_accessed": None,
                "guardian_confirmed": False,
                "guardian_confirmed_at": None,
                "source_procedure_id": existing_edge.properties.get(
                    "source_procedure_id", ""
                ),
                "error_count": 0,
                "deprecated": False,
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id=correlation_id if correlation_id else "contradiction-detector",
                confidence=_CONFLICT_INITIAL_CONFIDENCE,
            ),
            confidence=_CONFLICT_INITIAL_CONFIDENCE,
        )

        existing_edge_id = str(existing_edge.edge_id)
        new_edge_id = str(conflict_edge_id)

        # (b) Halve confidence on both edges
        existing_confidence = existing_edge.properties.get(
            "confidence", existing_edge.confidence
        )
        existing_edge.properties["confidence"] = existing_confidence / 2
        existing_edge.confidence = existing_confidence / 2

        conflict_edge.properties["confidence"] = _CONFLICT_INITIAL_CONFIDENCE / 2
        conflict_edge.confidence = _CONFLICT_INITIAL_CONFIDENCE / 2

        # (c) Increment error_count on both edges
        existing_error_count = existing_edge.properties.get("error_count", 0)
        existing_edge.properties["error_count"] = existing_error_count + 1
        conflict_edge.properties["error_count"] = 1

        # (d) Cross-link both edges with conflict metadata
        existing_edge.properties["has_conflict"] = True
        existing_edge.properties["conflicting_edge_id"] = new_edge_id

        conflict_edge.properties["has_conflict"] = True
        conflict_edge.properties["conflicting_edge_id"] = existing_edge_id

        # (e) Save both edges
        await self._graph.save_edge(existing_edge)
        await self._graph.save_edge(conflict_edge)

        # (f) Look up the existing result value for the event
        existing_result_value: Any = None
        existing_result_node = await self._graph.get_node(existing_edge.target_id)
        if existing_result_node is not None:
            existing_result_value = existing_result_node.properties.get("value")

        # (g) Build and emit/store the event
        event = ContradictionDetectedEvent(
            operation=operation,
            operand_ids=operand_id_strs,
            result_a_node_id=str(existing_edge.target_id),
            result_b_node_id=str(new_result_node_id),
            result_a_value=existing_result_value,
            result_b_value=new_result_value,
            edge_id_a=existing_edge_id,
            edge_id_b=new_edge_id,
            correlation_id=CorrelationId(correlation_id),
        )

        if self._event_bus is not None:
            await self._event_bus.publish(event)
        else:
            self.pending_events.append(event)

        return ContradictionResult(
            contradiction_found=True,
            conflicting_edge_ids=[existing_edge_id, new_edge_id],
        )


__all__ = [
    "ContradictionDetector",
    "ContradictionResult",
]

"""Negative knowledge manager -- DOES_NOT_COMPUTE_TO edge lifecycle (P1.9-E1).

When Python validation detects that Co-Being made a computational error,
this manager creates a DOES_NOT_COMPUTE_TO edge recording the incorrect
result. This is "negative knowledge" -- explicit records of wrong answers
that prevent the same error from being repeated.

Edge format::

    ValueNode --DOES_NOT_COMPUTE_TO--> ValueNode

Properties on the edge:
    - operation: str -- the operation name (e.g., "add")
    - operand_ids: list[str] -- node IDs of all operands
    - incorrect_result: Any -- the wrong answer Co-Being computed
    - correct_result: Any -- the right answer from Python validation
    - discovered_at: str -- ISO timestamp of when the error was detected
    - discovery_source: str -- always "python_validation" for this module
    - reconsideration_age_hours: float -- how old the edge must be (in
      hours) before the system is allowed to re-attempt this computation.
      This creates exploration pressure: old errors might be worth
      retrying after the procedure has been corrected.

Design decision D005 from P1.9-E1: Negative knowledge stored as graph
edges (not a separate table) so they participate in graph queries, graph
visualization, and the standard provenance trail.

CANON A.1 compliance: DOES_NOT_COMPUTE_TO edges are INFERENCE provenance
(the system discovered the error through validation, not from guardian
input or sensor data).

Usage::

    from cobeing.layer3_knowledge.negative_knowledge_manager import (
        NegativeKnowledgeManager,
    )

    manager = NegativeKnowledgeManager(persistence=graph)

    # Record that CB incorrectly computed 3 + 5 = 9
    edge = await manager.record_error(
        operation="add",
        operand_node_ids=["value:integer:3", "value:integer:5"],
        incorrect_result_node_id="value:integer:9",
        correct_result_node_id="value:integer:8",
        validation_result=validation_result,
    )

    # Check if a proposed result is a known error
    is_known_error = await manager.check_known_error(
        operation="add",
        operand_node_ids=["value:integer:3", "value:integer:5"],
        proposed_result_node_id="value:integer:9",
    )
    assert is_known_error is True

Phase 1.9 (P1.9-E1). CANON A.1 (schema evolution scope), A.18 (provenance).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from cobeing.layer3_knowledge.node_types import KnowledgeEdge
from cobeing.layer3_knowledge.procedure_types import DOES_NOT_COMPUTE_TO
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter
from cobeing.layer3_knowledge.validation_executor import ValidationResult
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

_logger = logging.getLogger(__name__)

# Default reconsideration age: 168 hours (7 days).
# After this many hours, the system may re-attempt the computation
# to see if procedural corrections have fixed the error.
_DEFAULT_RECONSIDERATION_AGE_HOURS: float = 168.0


def _now_iso() -> str:
    """Return the current UTC time as an ISO 8601 string."""
    return datetime.now(UTC).isoformat()


class NegativeKnowledgeManager:
    """Manages negative computational knowledge -- explicit records of wrong answers.

    When Python validation detects Co-Being made a computational error,
    this manager creates a DOES_NOT_COMPUTE_TO edge recording the
    incorrect result. This prevents the same error from being repeated
    and provides a visible audit trail in the knowledge graph.

    The manager does not modify COMPUTES_TO edges or adjust confidence.
    Those responsibilities belong to the caller (typically the validation
    loop in the orchestrator). This class is single-responsibility:
    create, query, and count DOES_NOT_COMPUTE_TO edges.

    Args:
        persistence: The graph persistence backend.
        reconsideration_age_hours: How old (in hours) a negative knowledge
            edge must be before the system is allowed to re-attempt the
            computation. Defaults to 168 hours (7 days).
    """

    def __init__(
        self,
        persistence: GraphPersistence,
        reconsideration_age_hours: float = _DEFAULT_RECONSIDERATION_AGE_HOURS,
    ) -> None:
        self._persistence = persistence
        self._reconsideration_age_hours = reconsideration_age_hours

    async def record_error(
        self,
        operation: str,
        operand_node_ids: list[str],
        incorrect_result_node_id: str,
        correct_result_node_id: str,
        validation_result: ValidationResult,
    ) -> KnowledgeEdge:
        """Create a DOES_NOT_COMPUTE_TO edge for a detected error.

        The edge runs from the first operand's ValueNode to the incorrect
        result's ValueNode, mirroring the structure of COMPUTES_TO edges.
        This makes it queryable using the same edge-filter patterns.

        If a DOES_NOT_COMPUTE_TO edge already exists for this exact
        (operation, operand_ids, incorrect_result) combination, it is
        updated rather than duplicated. The ``encounter_count`` property
        is incremented to track how many times the same error has been
        made.

        Args:
            operation: The operation name (e.g., ``"add"``).
            operand_node_ids: Node IDs of all operands, in positional order.
            incorrect_result_node_id: Node ID of the wrong result ValueNode.
            correct_result_node_id: Node ID of the correct result ValueNode.
            validation_result: The ValidationResult from the validation
                executor, providing error description and validation source.

        Returns:
            The created or updated KnowledgeEdge.
        """
        # Check for existing edge to avoid duplicates
        existing = await self._find_existing_error(
            operation, operand_node_ids, incorrect_result_node_id
        )

        now_iso = _now_iso()

        if existing is not None:
            # Update encounter count on existing edge
            new_count = existing.properties.get("encounter_count", 1) + 1
            existing.properties["encounter_count"] = new_count
            existing.properties["last_encountered"] = now_iso
            await self._persistence.save_edge(existing)

            _logger.info(
                "negative_knowledge_updated operation=%s operands=%s "
                "incorrect=%s encounter_count=%d",
                operation,
                operand_node_ids,
                incorrect_result_node_id,
                new_count,
            )
            return existing

        # Create new DOES_NOT_COMPUTE_TO edge
        safe_op = operation.replace(":", "_")
        edge_id = EdgeId(
            f"edge:does_not_compute_to:{operand_node_ids[0]}:"
            f"{safe_op}:{incorrect_result_node_id}"
        )

        edge = KnowledgeEdge(
            edge_id=edge_id,
            source_id=NodeId(operand_node_ids[0]),
            target_id=NodeId(incorrect_result_node_id),
            edge_type=DOES_NOT_COMPUTE_TO,
            properties={
                "operation": operation,
                "operand_ids": operand_node_ids,
                "incorrect_result": validation_result.cb_result,
                "correct_result": validation_result.correct_result,
                "correct_result_node_id": correct_result_node_id,
                "discovered_at": now_iso,
                "last_encountered": now_iso,
                "discovery_source": "python_validation",
                "reconsideration_age_hours": self._reconsideration_age_hours,
                "encounter_count": 1,
                "error_description": validation_result.error_description,
                "validation_source": validation_result.validation_source,
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id="python-validation",
                confidence=1.0,
            ),
            confidence=1.0,
        )

        await self._persistence.save_edge(edge)

        _logger.info(
            "negative_knowledge_created operation=%s operands=%s "
            "incorrect=%s correct=%s edge_id=%s",
            operation,
            operand_node_ids,
            incorrect_result_node_id,
            correct_result_node_id,
            edge_id,
        )

        return edge

    async def check_known_error(
        self,
        operation: str,
        operand_node_ids: list[str],
        proposed_result_node_id: str,
    ) -> bool:
        """Check if a proposed computation result is a known error.

        Queries for a DOES_NOT_COMPUTE_TO edge matching this exact
        (operation, operand_ids, result) combination. If found, the
        proposed result is a known error and should not be used.

        Args:
            operation: The operation name (e.g., ``"add"``).
            operand_node_ids: Node IDs of all operands, in positional order.
            proposed_result_node_id: Node ID of the result to check.

        Returns:
            True if a DOES_NOT_COMPUTE_TO edge exists for this exact
            combination, meaning the result is a known error. False
            otherwise.
        """
        existing = await self._find_existing_error(
            operation, operand_node_ids, proposed_result_node_id
        )
        return existing is not None

    async def get_error_count(self, operation: str | None = None) -> int:
        """Count known errors, optionally filtered by operation.

        Args:
            operation: If provided, count only errors for this operation.
                If None, count all DOES_NOT_COMPUTE_TO edges.

        Returns:
            The number of DOES_NOT_COMPUTE_TO edges matching the filter.
        """
        edges = await self._persistence.query_edges(
            EdgeFilter(edge_type=DOES_NOT_COMPUTE_TO)
        )

        if operation is None:
            return len(edges)

        return sum(
            1
            for edge in edges
            if edge.properties.get("operation") == operation
        )

    async def get_errors_for_operation(
        self,
        operation: str,
        operand_node_ids: list[str] | None = None,
    ) -> list[KnowledgeEdge]:
        """Retrieve all known errors for an operation.

        Args:
            operation: The operation name to filter by.
            operand_node_ids: If provided, further filter to errors
                involving these specific operands.

        Returns:
            List of DOES_NOT_COMPUTE_TO edges matching the filter.
        """
        edges = await self._persistence.query_edges(
            EdgeFilter(edge_type=DOES_NOT_COMPUTE_TO)
        )

        results: list[KnowledgeEdge] = []
        for edge in edges:
            if edge.properties.get("operation") != operation:
                continue
            if operand_node_ids is not None:
                if edge.properties.get("operand_ids") != operand_node_ids:
                    continue
            results.append(edge)

        return results

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _find_existing_error(
        self,
        operation: str,
        operand_node_ids: list[str],
        incorrect_result_node_id: str,
    ) -> KnowledgeEdge | None:
        """Find an existing DOES_NOT_COMPUTE_TO edge for this exact error.

        Queries edges from the first operand node, then filters by
        operation, operand list, and target (incorrect result).

        Returns:
            The matching KnowledgeEdge, or None if not found.
        """
        if not operand_node_ids:
            return None

        edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=DOES_NOT_COMPUTE_TO,
                source_node_id=operand_node_ids[0],
            )
        )

        for edge in edges:
            if (
                edge.properties.get("operation") == operation
                and edge.properties.get("operand_ids") == operand_node_ids
                and str(edge.target_id) == incorrect_result_node_id
            ):
                return edge

        return None


__all__ = [
    "NegativeKnowledgeManager",
]

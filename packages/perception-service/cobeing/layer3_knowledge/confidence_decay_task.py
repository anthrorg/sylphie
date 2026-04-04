"""Background task for periodic COMPUTES_TO confidence decay (PKG-4.3).

This module provides a single async function that scans all active (non-
deprecated) COMPUTES_TO edges in the knowledge graph, recomputes their
confidence using the ACT-R decay formula from ``instance_confidence``, and
updates edges whose confidence has changed.

Edges whose confidence falls below the retrieval threshold are logged but
not deleted. Guardian-confirmed edges are never marked as pruning-eligible
-- they may have decayed but should not be silently discarded.

Usage::

    from cobeing.layer3_knowledge.confidence_decay_task import (
        DecayTaskResult,
        run_computes_to_decay,
    )

    result = await run_computes_to_decay(persistence)
    print(result.edges_scanned, result.edges_updated)

See Also:
    - ``cobeing.layer3_knowledge.instance_confidence`` -- the ACT-R confidence
      formula and threshold constants.
    - ``cobeing.layer3_knowledge.procedure_types`` -- the COMPUTES_TO constant.
    - ``cobeing.layer3_knowledge.confidence_decay`` -- the existing node-level
      decay module (separate concern: nodes vs. edges).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from cobeing.layer3_knowledge.instance_confidence import (
    BASE_GUARDIAN_CONFIRMED,
    BASE_PROCEDURAL,
    RETRIEVAL_THRESHOLD,
    calculate_confidence,
    hours_since,
)
from cobeing.layer3_knowledge.procedure_types import COMPUTES_TO
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter

_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DecayTaskResult:
    """Result of a single COMPUTES_TO confidence decay scan.

    Summarises what the decay pass did so callers can log or inspect the
    outcome without re-querying the graph.

    Attributes:
        edges_scanned: Total COMPUTES_TO edges examined (excluding
            deprecated edges which are skipped entirely).
        edges_updated: Edges whose recomputed confidence differed from
            the stored value and were written back to the graph.
        edges_below_threshold: Edges (not guardian-confirmed) whose
            confidence is now below the retrieval threshold (0.50).
            These edges will require procedural re-execution on next use.
        edges_marked_prunable: Edges where ``pruning_eligible`` was set
            to ``True`` because confidence < 0.05, encounter_count < 3,
            and guardian_confirmed is False.
    """

    edges_scanned: int
    edges_updated: int
    edges_below_threshold: int
    edges_marked_prunable: int


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def run_computes_to_decay(
    persistence: GraphPersistence,
    logger: logging.Logger | None = None,
) -> DecayTaskResult:
    """Recalculate confidence for all active, non-deprecated COMPUTES_TO edges.

    For each qualifying edge:

    1. Read ``encounter_count``, ``last_accessed``, ``guardian_confirmed``,
       and the stored ``confidence`` from ``edge.properties``.
    2. Recompute the effective confidence using ``calculate_confidence()``
       with ``base = 0.60`` if guardian-confirmed, else ``0.15``.
    3. If the new confidence differs from the stored value (beyond a small
       epsilon of 0.001 to avoid float churn), update the edge.
    4. If the new confidence is below ``RETRIEVAL_THRESHOLD`` (0.50) and the
       edge is not guardian-confirmed, count it as below-threshold.
    5. If the new confidence is below 0.05 AND ``encounter_count < 3`` AND
       the edge is not guardian-confirmed, set
       ``edge.properties["pruning_eligible"] = True``.

    Guardian-confirmed edges are never marked pruning-eligible. Their
    confidence may decay below threshold (requiring procedural re-execution)
    but they retain their confirmed status and are not candidates for removal.

    Args:
        persistence: The graph storage backend to read from and write to.
        logger: Optional logger instance. Falls back to the module-level
            logger if not provided.

    Returns:
        A ``DecayTaskResult`` with counts of scanned, updated,
        below-threshold, and pruning-eligible edges.
    """
    log = logger or _logger

    # Query all COMPUTES_TO edges from the graph.
    all_edges = await persistence.query_edges(
        EdgeFilter(edge_type=COMPUTES_TO)
    )

    edges_scanned = 0
    edges_updated = 0
    edges_below_threshold = 0
    edges_marked_prunable = 0

    for edge in all_edges:
        # Skip deprecated edges entirely.
        if edge.properties.get("deprecated", False):
            continue

        edges_scanned += 1

        # Read properties from the edge.
        encounter_count: int = edge.properties.get("encounter_count", 1)
        last_accessed: str | None = edge.properties.get("last_accessed")
        guardian_confirmed: bool = edge.properties.get("guardian_confirmed", False)
        stored_confidence: float = edge.properties.get("confidence", 0.0)

        # Compute hours since last access.
        h = hours_since(last_accessed)

        # Determine base confidence.
        base = BASE_GUARDIAN_CONFIRMED if guardian_confirmed else BASE_PROCEDURAL

        # Recompute effective confidence.
        new_confidence = calculate_confidence(
            base=base,
            encounter_count=encounter_count,
            hours_since_last_access=h,
            guardian_confirmed=guardian_confirmed,
        )

        # Check if confidence changed meaningfully (epsilon = 0.001).
        confidence_changed = abs(new_confidence - stored_confidence) > 0.001

        # Check below-threshold status (only for non-confirmed edges).
        if new_confidence < RETRIEVAL_THRESHOLD and not guardian_confirmed:
            edges_below_threshold += 1

        # Check pruning eligibility.
        newly_prunable = False
        if (
            new_confidence < 0.05
            and encounter_count < 3
            and not guardian_confirmed
        ):
            if not edge.properties.get("pruning_eligible", False):
                newly_prunable = True

        # Only write back if something actually changed.
        if confidence_changed or newly_prunable:
            edge.properties["confidence"] = new_confidence
            if newly_prunable:
                edge.properties["pruning_eligible"] = True
                edges_marked_prunable += 1
            # Also update the top-level edge confidence to stay in sync.
            edge.confidence = new_confidence
            await persistence.save_edge(edge)
            edges_updated += 1

    log.info(
        "computes_to_decay_complete "
        "edges_scanned=%d edges_updated=%d "
        "edges_below_threshold=%d edges_marked_prunable=%d",
        edges_scanned,
        edges_updated,
        edges_below_threshold,
        edges_marked_prunable,
    )

    return DecayTaskResult(
        edges_scanned=edges_scanned,
        edges_updated=edges_updated,
        edges_below_threshold=edges_below_threshold,
        edges_marked_prunable=edges_marked_prunable,
    )


__all__ = [
    "DecayTaskResult",
    "run_computes_to_decay",
]

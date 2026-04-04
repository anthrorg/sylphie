"""Confidence decay for the Co-Being knowledge graph.

This module implements the internal health management operation described in
CANON A.10: confidence decay on instance nodes over time.  Nodes that have
not been confirmed within a configurable window have their confidence reduced
by a multiplicative factor.  Nodes whose confidence drops below a minimum
threshold are closed (``valid_to`` is set) rather than deleted, preserving
the audit trail.

**Design decisions:**

- Only ``INSTANCE``-level nodes are decayed.  ``SCHEMA`` and ``META_SCHEMA``
  nodes represent structural knowledge that does not age out of relevance
  the way individual observations do.
- Only *active* nodes are considered.  Active means ``valid_to is None``.
  Nodes already closed (superseded by decay or by any other mechanism) are
  skipped entirely.
- The temporal floor uses ``last_confirmed`` when available; otherwise falls
  back to ``created_at``.  This prevents punishing a node for the gap
  between creation and first re-confirmation.
- Closure is recorded with ``closed_reason="decay"`` in ``properties`` so
  it can be distinguished from supersession-based closure.
- Nodes are mutated in-place and then re-saved via ``persistence.save_node``,
  which uses upsert semantics.

**Decay formula**::

    node.confidence *= decay_factor

Applied only when::

    hours_since_confirmed = (now - (node.last_confirmed or node.created_at)) / 3600
    hours_since_confirmed > max_age_hours

If the post-decay confidence falls below ``min_confidence``, the node is
closed::

    node.valid_to = now
    node.properties["closed_reason"] = "decay"

Usage::

    from cobeing.layer3_knowledge.confidence_decay import (
        DecayResult, run_confidence_decay,
    )
    from cobeing.layer3_knowledge.in_memory_persistence import (
        InMemoryGraphPersistence,
    )

    persistence = InMemoryGraphPersistence()
    # ... populate graph ...

    result = await run_confidence_decay(
        persistence=persistence,
        decay_factor=0.95,
        min_confidence=0.1,
        max_age_hours=24.0,
    )
    print(result.nodes_decayed)  # nodes whose confidence was reduced
    print(result.nodes_closed)   # nodes closed (below min_confidence)
    print(result.nodes_skipped)  # nodes recently confirmed (not decayed)
"""

from __future__ import annotations

from dataclasses import dataclass

from cobeing.layer3_knowledge.node_types import SchemaLevel
from cobeing.shared.time_utils import utc_now
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import NodeFilter


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DecayResult:
    """Result of a single confidence decay run.

    Summarises what the decay pass did to the graph so callers can log
    or inspect the outcome.

    Attributes:
        nodes_decayed: Number of nodes whose confidence was reduced but
            remained at or above ``min_confidence`` (still open).
        nodes_closed: Number of nodes whose post-decay confidence fell
            below ``min_confidence`` and were therefore closed by setting
            ``valid_to``.
        nodes_skipped: Number of active instance nodes that were *not*
            decayed because they were confirmed within ``max_age_hours``.
    """

    nodes_decayed: int
    nodes_closed: int
    nodes_skipped: int


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def run_confidence_decay(
    persistence: GraphPersistence,
    decay_factor: float,
    min_confidence: float,
    max_age_hours: float,
) -> DecayResult:
    """Apply confidence decay to all active instance nodes.

    Queries all active ``INSTANCE``-level nodes (``valid_to`` is ``None``),
    determines whether each has been confirmed recently enough to be exempt
    from decay, and applies the decay factor to those that have not.

    Nodes whose post-decay confidence falls below ``min_confidence`` are
    closed: their ``valid_to`` is set to the current time and their
    ``properties["closed_reason"]`` is set to ``"decay"``.

    This function is safe to call repeatedly.  Already-closed nodes (those
    with ``valid_to`` set) are not returned by the active-node query and
    are therefore never processed a second time.

    Args:
        persistence: The graph storage backend to read from and write to.
        decay_factor: Multiplicative factor applied to confidence.  Values
            below 1.0 reduce confidence (e.g. 0.95 reduces by 5 % each
            run).  Must be in the range (0.0, 1.0] for meaningful decay.
        min_confidence: Threshold below which a node is closed rather than
            merely decayed.  Must be in the range [0.0, 1.0].
        max_age_hours: Nodes confirmed within this many hours are exempted
            from decay.  A value of 24.0 means nodes confirmed in the last
            24 hours are skipped.

    Returns:
        A ``DecayResult`` with counts of decayed, closed, and skipped nodes.
    """
    now = utc_now()

    # Query only INSTANCE nodes whose valid_to is None (active).
    # NodeFilter has no direct "valid_to is None" criterion -- we filter
    # by schema_level and then skip nodes with a set valid_to in the loop.
    all_instance_nodes = await persistence.query_nodes(
        NodeFilter(schema_level=SchemaLevel.INSTANCE)
    )

    nodes_decayed = 0
    nodes_closed = 0
    nodes_skipped = 0

    for node in all_instance_nodes:
        # Only process currently-active nodes (valid_to is None).
        if node.valid_to is not None:
            continue

        # Determine the reference time for the age calculation.
        # Use last_confirmed when available; fall back to created_at.
        reference_time = node.last_confirmed if node.last_confirmed is not None else node.created_at

        hours_since_confirmed = (now - reference_time).total_seconds() / 3600.0

        if hours_since_confirmed <= max_age_hours:
            # Recently confirmed -- exempt from decay.
            nodes_skipped += 1
            continue

        # Apply the multiplicative decay.
        node.confidence = node.confidence * decay_factor

        if node.confidence < min_confidence:
            # Close the node.
            node.valid_to = now
            node.properties = {**node.properties, "closed_reason": "decay"}
            nodes_closed += 1
        else:
            nodes_decayed += 1

        await persistence.save_node(node)

    return DecayResult(
        nodes_decayed=nodes_decayed,
        nodes_closed=nodes_closed,
        nodes_skipped=nodes_skipped,
    )


__all__ = [
    "DecayResult",
    "run_confidence_decay",
]

"""Integrity validation and attractor early-warning system for the knowledge graph.

This module implements two distinct checks against the CANON A.8 known failure
modes and structural requirements (CANON A.11 provenance, CANON node_types):

1. :func:`validate_graph_integrity` -- structural correctness checks
   (provenance validity, temporal invariants, classification consistency).

2. :func:`check_attractor_warnings` -- early-warning detection for the four
   pathological attractor states described in CANON A.8.

**Integrity findings** are structural violations: facts that are definitively
wrong given the graph's own invariants.  Every finding has a ``severity``
("error" for clear violations, "warning" for anomalies that may be legitimate
in context), a ``check_name`` identifying which rule fired, the ``node_id``
of the offending node when applicable, and a plain-English ``message``.

**Attractor warnings** are system-health signals: early indicators that the
schema evolution process is entering a pathological trajectory.  They do not
identify broken nodes -- they identify pathological *patterns* across the whole
graph.  Every warning carries structured ``details`` so callers can inspect
the raw numbers that triggered it.

**Edge access:**

Neither function is guaranteed edge access via the base
:class:`~cobeing.layer3_knowledge.protocols.GraphPersistence` Protocol.  Both
use duck typing: if the persistence object exposes ``query_edges``, it is
called; otherwise edge-dependent checks fall back gracefully (reporting no
findings, not crashing).

Usage::

    from cobeing.layer3_knowledge import InMemoryGraphPersistence
    from cobeing.layer3_knowledge.integrity_validation import (
        validate_graph_integrity,
        check_attractor_warnings,
        IntegrityFinding,
        AttractorWarning,
    )

    persistence = InMemoryGraphPersistence()
    # ... populate the graph ...

    findings = await validate_graph_integrity(persistence)
    warnings = await check_attractor_warnings(persistence, session_count=25)

See Also:
    - ``cobeing.layer3_knowledge.protocols`` -- GraphPersistence Protocol
    - ``cobeing.layer3_knowledge.node_types`` -- KnowledgeNode, SchemaLevel
    - ``cobeing.layer3_knowledge.health_metrics`` -- get_health_metrics
    - ``cobeing.shared.provenance`` -- ProvenanceSource
    - CANON A.8 -- Known failure modes and early-warning criteria
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from cobeing.layer3_knowledge.node_types import KnowledgeEdge, KnowledgeNode, NodeStatus, SchemaLevel
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import NodeFilter
from cobeing.shared.provenance import ProvenanceSource
from cobeing.shared.types import NodeId


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IntegrityFinding:
    """A single structural integrity finding from ``validate_graph_integrity``.

    Integrity findings identify violations of the graph's own invariants --
    provenance rules, temporal constraints, and classification consistency.
    They are not warnings about trends; they are reports of definite problems
    with specific nodes.

    Attributes:
        severity: ``"error"`` for clear constraint violations that will cause
            downstream failures; ``"warning"`` for anomalies that are
            structurally allowed but likely unintentional.
        check_name: Short identifier for the rule that produced this finding.
            Examples: ``"provenance_valid"``, ``"temporal_invariant"``,
            ``"classification_consistency"``.
        node_id: The NodeId of the node that violated the constraint, or
            ``None`` for graph-level findings not tied to a specific node.
        message: Human-readable description of what is wrong and why it
            matters.
    """

    severity: str
    check_name: str
    node_id: NodeId | None
    message: str


@dataclass(frozen=True)
class AttractorWarning:
    """An early-warning signal from ``check_attractor_warnings``.

    Attractor warnings do not identify broken nodes.  They identify patterns
    across the whole graph that suggest the schema evolution process is
    drifting toward a known failure mode (CANON A.8).

    Attributes:
        warning_type: Which CANON A.8 attractor this warning corresponds to.
            One of: ``"ossification"``, ``"guardian_dependency"``,
            ``"hallucinated_structure"``.
        severity: ``"warning"`` for early-stage signals; ``"critical"`` for
            patterns that indicate the attractor has already set in.
        message: Human-readable description of the pattern detected and why
            it is concerning.
        details: Supporting numerical data that caused the warning to fire.
            Always non-empty -- callers can inspect the raw counts and
            thresholds that produced the warning.
    """

    warning_type: str
    severity: str
    message: str
    details: dict[str, Any]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _get_all_edges(persistence: Any) -> list[KnowledgeEdge]:
    """Return all edges in the graph using duck-typed ``query_edges``.

    Calls ``persistence.query_edges()`` (no arguments) if available.  Returns
    an empty list if the method is absent so callers degrade gracefully rather
    than raising AttributeError.

    Args:
        persistence: Any persistence object. Duck-typed access to
            ``query_edges``.

    Returns:
        All edges in the graph, or an empty list if not supported.
    """
    query_edges = getattr(persistence, "query_edges", None)
    if query_edges is None:
        return []
    return await query_edges()


# ---------------------------------------------------------------------------
# Integrity checks (internal, one function per check)
# ---------------------------------------------------------------------------


def _check_provenance_valid(node: KnowledgeNode) -> IntegrityFinding | None:
    """Check that a node's provenance source is a valid ProvenanceSource value.

    CANON A.11 specifies exactly four permitted provenance source categories.
    Any value outside this set is an integrity violation -- it means the node
    was created without going through the proper provenance machinery.

    Args:
        node: The node to validate.

    Returns:
        An ``IntegrityFinding`` at ``"error"`` severity if the provenance
        source is invalid, or ``None`` if the source is valid.
    """
    valid_sources = set(ProvenanceSource)
    if node.provenance.source not in valid_sources:
        return IntegrityFinding(
            severity="error",
            check_name="provenance_valid",
            node_id=node.node_id,
            message=(
                f"Node '{node.node_id}' has invalid provenance source "
                f"'{node.provenance.source}'. "
                f"Permitted values: {sorted(str(s) for s in valid_sources)}."
            ),
        )
    return None


def _check_temporal_invariant(node: KnowledgeNode) -> IntegrityFinding | None:
    """Check that valid_from <= valid_to when valid_to is set.

    A node whose valid_to precedes its valid_from represents an impossible
    temporal state: the node became invalid before it became valid.  This
    indicates a bug in the code that set these timestamps.

    Args:
        node: The node to validate.

    Returns:
        An ``IntegrityFinding`` at ``"error"`` severity if valid_to < valid_from,
        or ``None`` if the temporal invariant holds (including when valid_to is
        None, which is always valid).
    """
    if node.valid_to is not None and node.valid_to < node.valid_from:
        return IntegrityFinding(
            severity="error",
            check_name="temporal_invariant",
            node_id=node.node_id,
            message=(
                f"Node '{node.node_id}' has valid_to ({node.valid_to.isoformat()}) "
                f"before valid_from ({node.valid_from.isoformat()}). "
                "A node cannot become invalid before it became valid."
            ),
        )
    return None


async def _check_classification_consistency(
    node: KnowledgeNode,
    all_edges: list[KnowledgeEdge],
    all_nodes_by_id: dict[NodeId, KnowledgeNode],
) -> IntegrityFinding | None:
    """Check that no Instance node is the source of an INSTANCE_OF edge to a non-Schema target.

    The INSTANCE_OF edge is the classification edge: it runs from an Instance
    node to a Schema node.  If an Instance node's INSTANCE_OF edge points to
    a target that is not at SchemaLevel.SCHEMA, the type hierarchy is
    corrupted -- the instance is classified under something that is not a type.

    Only nodes at ``SchemaLevel.INSTANCE`` are checked (Instance nodes are the
    only valid sources of INSTANCE_OF edges in the standard graph model).

    Args:
        node: The node to check. Only Instance-level nodes with INSTANCE_OF
            outgoing edges are relevant; all others pass immediately.
        all_edges: All edges in the graph (for efficient filtering without
            repeated I/O).
        all_nodes_by_id: All nodes keyed by NodeId (for target lookup without
            repeated I/O).

    Returns:
        An ``IntegrityFinding`` at ``"error"`` severity if the node is an
        Instance that has an INSTANCE_OF edge to a non-Schema target, or
        ``None`` if the classification is consistent.
    """
    if node.schema_level != SchemaLevel.INSTANCE:
        # Only Instance nodes can have INSTANCE_OF edges as sources
        return None

    for edge in all_edges:
        if edge.source_id != node.node_id or edge.edge_type != "INSTANCE_OF":
            continue

        target = all_nodes_by_id.get(edge.target_id)
        if target is None:
            # Target node not found -- this is a dangling edge, but that is
            # not the check this function is responsible for.
            continue

        if target.schema_level != SchemaLevel.SCHEMA:
            return IntegrityFinding(
                severity="error",
                check_name="classification_consistency",
                node_id=node.node_id,
                message=(
                    f"Instance node '{node.node_id}' has an INSTANCE_OF edge "
                    f"(to '{edge.target_id}') that targets a node at schema level "
                    f"'{target.schema_level}', not '{SchemaLevel.SCHEMA}'. "
                    "INSTANCE_OF edges must point to Schema-level type nodes."
                ),
            )

    return None


# ---------------------------------------------------------------------------
# Attractor warning checks (internal, one function per attractor)
# ---------------------------------------------------------------------------


def _check_ossification(
    total_type_count: int,
    session_count: int,
) -> AttractorWarning | None:
    """Check for schema ossification: type count unchanged over many sessions.

    CANON A.8 ossification early warning: schema type count plateaus early,
    with new observations always classifying into existing types.

    For Phase 1 the check is simplified: if the total schema type count is 0
    (no types have ever formed) and the session count exceeds 20, the graph
    is ossified -- the schema evolution machinery has not fired after a
    substantial number of operational sessions.

    Args:
        total_type_count: Current number of Schema-level nodes.
        session_count: Number of ObservationSessions that have run since the
            graph was bootstrapped.

    Returns:
        An ``AttractorWarning`` with ``warning_type="ossification"`` if the
        condition fires, or ``None`` if the schema is evolving normally.
    """
    ossification_session_threshold = 20
    if total_type_count == 0 and session_count > ossification_session_threshold:
        return AttractorWarning(
            warning_type="ossification",
            severity="warning",
            message=(
                f"Schema ossification detected: no types have formed after "
                f"{session_count} sessions (threshold: >{ossification_session_threshold} "
                "sessions with zero types). The schema evolution machinery may not "
                "be firing. Check TYPE_CREATION_THRESHOLD configuration and that "
                "observations are accumulating."
            ),
            details={
                "total_type_count": total_type_count,
                "session_count": session_count,
                "ossification_session_threshold": ossification_session_threshold,
            },
        )
    return None


def _check_guardian_dependency(
    pending_count: int,
    applied_count: int,
) -> AttractorWarning | None:
    """Check for guardian dependency: system asking but not forming hypotheses.

    CANON A.8 guardian dependency early warning: system-initiated questions
    increase over time rather than decreasing; the pending-to-applied ratio
    grows as the system defers all uncertainty to the guardian instead of
    forming and testing its own hypotheses.

    The check fires when pending proposals outnumber applied (approved) schema
    types by more than 3:1.  A ratio of 4 pending to 1 applied triggers the
    warning.  When there are no applied types, any pending proposals fire the
    warning (the ratio is effectively infinite).

    Args:
        pending_count: Number of nodes currently in PENDING status.
        applied_count: Total number of ACTIVE SchemaType nodes (all-time
            applied proposals, not just those applied this session).

    Returns:
        An ``AttractorWarning`` with ``warning_type="guardian_dependency"`` if
        the ratio exceeds 3:1, or ``None`` if the ratio is acceptable.
    """
    dependency_ratio_threshold = 3.0

    if pending_count == 0:
        # No pending proposals means no dependency concern regardless of applied count.
        return None

    if applied_count == 0:
        # Any pending proposals with zero applied types means infinite ratio.
        ratio = float("inf")
        fires = True
    else:
        ratio = pending_count / applied_count
        fires = ratio > dependency_ratio_threshold

    if fires:
        return AttractorWarning(
            warning_type="guardian_dependency",
            severity="warning",
            message=(
                f"Guardian dependency detected: {pending_count} pending proposal(s) "
                f"against {applied_count} applied type(s) "
                f"(ratio {ratio:.2f}:1, threshold >{dependency_ratio_threshold}:1). "
                "The system may be accumulating proposals instead of forming autonomous "
                "hypotheses. Check schema evolution pipeline and meta-schema rule "
                "firing conditions."
            ),
            details={
                "pending_count": pending_count,
                "applied_count": applied_count,
                "ratio": ratio,
                "dependency_ratio_threshold": dependency_ratio_threshold,
            },
        )
    return None


def _check_hallucinated_structure(
    schema_nodes: list[KnowledgeNode],
    instance_counts_by_type: dict[NodeId, int],
) -> list[AttractorWarning]:
    """Check for hallucinated structure: schema types with too few instances.

    CANON A.8 hallucinated structure early warning: schema types grow faster
    than distinct environmental features; many types have few instances each.
    This suggests spurious patterns in limited data are creating meaningless
    schema types.

    A type with fewer than 2 instances is flagged.  A type with 0 instances
    is particularly concerning (the type was approved but no instances have
    been classified under it).

    Args:
        schema_nodes: All Schema-level nodes in the graph.
        instance_counts_by_type: Dict mapping each Schema-level NodeId to the
            number of Instance nodes connected to it via INSTANCE_OF edges.

    Returns:
        A list of ``AttractorWarning`` objects, one per offending Schema node.
        Empty if all schema types have adequate instance coverage.
    """
    hallucination_instance_threshold = 2
    warnings: list[AttractorWarning] = []

    for schema_node in schema_nodes:
        count = instance_counts_by_type.get(schema_node.node_id, 0)
        if count < hallucination_instance_threshold:
            warnings.append(
                AttractorWarning(
                    warning_type="hallucinated_structure",
                    severity="warning",
                    message=(
                        f"Schema type '{schema_node.node_id}' "
                        f"(node_type='{schema_node.node_type}') "
                        f"has only {count} instance(s) "
                        f"(threshold: >={hallucination_instance_threshold}). "
                        "Types with few instances may represent spurious patterns "
                        "from limited data. Consider whether this type reflects a "
                        "genuine environmental feature."
                    ),
                    details={
                        "schema_node_id": str(schema_node.node_id),
                        "schema_node_type": schema_node.node_type,
                        "instance_count": count,
                        "hallucination_instance_threshold": hallucination_instance_threshold,
                    },
                )
            )

    return warnings


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def validate_graph_integrity(
    persistence: GraphPersistence,
) -> list[IntegrityFinding]:
    """Check the knowledge graph for structural integrity violations.

    Runs three checks over every node in the graph:

    1. **provenance_valid** -- Every node must carry a provenance source that
       is one of the four CANON A.11 permitted categories: SENSOR, GUARDIAN,
       INFERENCE, GUARDIAN_APPROVED_INFERENCE.  Any other value is an error.

    2. **temporal_invariant** -- When ``valid_to`` is set, it must be greater
       than or equal to ``valid_from``.  A node cannot become invalid before
       it became valid.

    3. **classification_consistency** -- No Instance node may be the source
       of an INSTANCE_OF edge that targets a non-Schema node.  The type
       hierarchy requires that INSTANCE_OF edges always point upward to
       Schema-level types.

    All three checks are run on every node in a single pass.  Findings from
    all three are combined into the returned list.  An empty list means the
    graph has no detected structural violations.

    **Edge access:** The classification consistency check requires edge data.
    If the persistence backend does not support ``query_edges``, check 3 is
    skipped (no findings are produced for it, not a crash).

    Args:
        persistence: The graph storage backend to validate.  Must implement
            the ``GraphPersistence`` Protocol.  Optionally implements
            ``query_edges`` for the full three-check suite.

    Returns:
        A list of :class:`IntegrityFinding` objects describing each detected
        violation.  Empty if the graph passes all checks.
    """
    findings: list[IntegrityFinding] = []

    # Fetch all nodes and edges in single passes for efficiency.
    all_nodes = await persistence.query_nodes(NodeFilter())
    all_edges = await _get_all_edges(persistence)

    # Build a node lookup table for the classification consistency check.
    all_nodes_by_id: dict[NodeId, KnowledgeNode] = {
        node.node_id: node for node in all_nodes
    }

    for node in all_nodes:
        # Check 1: provenance source validity
        finding = _check_provenance_valid(node)
        if finding is not None:
            findings.append(finding)

        # Check 2: temporal invariant
        finding = _check_temporal_invariant(node)
        if finding is not None:
            findings.append(finding)

        # Check 3: classification consistency (edge-dependent)
        finding = await _check_classification_consistency(
            node, all_edges, all_nodes_by_id
        )
        if finding is not None:
            findings.append(finding)

    return findings


async def check_attractor_warnings(
    persistence: GraphPersistence,
    session_count: int,
) -> list[AttractorWarning]:
    """Check the knowledge graph for early-warning attractor signals (CANON A.8).

    Runs three attractor checks:

    1. **ossification** -- No schema types have formed after more than 20
       sessions.  Fires when ``total_type_count == 0`` and
       ``session_count > 20``.

    2. **guardian_dependency** -- More than 3 pending proposals per applied
       schema type.  The ``applied_count`` is the number of ACTIVE
       ``SchemaType`` nodes (those created via ``apply_schema_proposal``).
       The ``pending_count`` is the number of nodes currently in PENDING
       status.

    3. **hallucinated_structure** -- Any Schema-level node has fewer than 2
       Instance nodes connected to it via INSTANCE_OF edges.  Each offending
       type produces a separate warning.

    **Edge access:** The hallucinated structure check requires edge data to
    count instances per type.  If the persistence backend does not support
    ``query_edges``, check 3 is skipped (no warnings are produced for it).

    Args:
        persistence: The graph storage backend to query.  Must implement
            the ``GraphPersistence`` Protocol.  Optionally implements
            ``query_edges`` for the hallucinated structure check.
        session_count: The total number of ObservationSessions that have run
            since the graph was bootstrapped.  Used by the ossification check.

    Returns:
        A list of :class:`AttractorWarning` objects.  Empty if no attractor
        patterns are detected.
    """
    warnings: list[AttractorWarning] = []

    # Fetch all nodes and edges in single passes.
    all_nodes = await persistence.query_nodes(NodeFilter())
    all_edges = await _get_all_edges(persistence)

    # ---------------------------------------------------------------------------
    # Check 1: Ossification
    # ---------------------------------------------------------------------------
    total_type_count = sum(
        1 for node in all_nodes if node.schema_level == SchemaLevel.SCHEMA
    )
    ossification_warning = _check_ossification(total_type_count, session_count)
    if ossification_warning is not None:
        warnings.append(ossification_warning)

    # ---------------------------------------------------------------------------
    # Check 2: Guardian dependency
    # pending_count: nodes currently in PENDING status
    # applied_count: ACTIVE SchemaType nodes at SCHEMA level
    # ---------------------------------------------------------------------------
    pending_count = sum(1 for node in all_nodes if node.status == NodeStatus.PENDING)
    applied_count = sum(
        1
        for node in all_nodes
        if (
            node.schema_level == SchemaLevel.SCHEMA
            and node.node_type == "SchemaType"
            and node.status == NodeStatus.ACTIVE
        )
    )
    dependency_warning = _check_guardian_dependency(pending_count, applied_count)
    if dependency_warning is not None:
        warnings.append(dependency_warning)

    # ---------------------------------------------------------------------------
    # Check 3: Hallucinated structure
    # Count INSTANCE_OF edges pointing to each Schema-level node.
    # ---------------------------------------------------------------------------
    schema_nodes = [n for n in all_nodes if n.schema_level == SchemaLevel.SCHEMA]

    if all_edges:
        # Build instance count per schema node from INSTANCE_OF edges.
        instance_counts_by_type: dict[NodeId, int] = {}
        for edge in all_edges:
            if edge.edge_type == "INSTANCE_OF":
                target = edge.target_id
                instance_counts_by_type[target] = (
                    instance_counts_by_type.get(target, 0) + 1
                )

        hallucination_warnings = _check_hallucinated_structure(
            schema_nodes, instance_counts_by_type
        )
        warnings.extend(hallucination_warnings)
    elif schema_nodes:
        # No edges available but schema nodes exist -- each has 0 instance
        # connections, which is below the threshold of 2.
        hallucination_warnings = _check_hallucinated_structure(
            schema_nodes, {}
        )
        warnings.extend(hallucination_warnings)

    return warnings


__all__ = [
    "AttractorWarning",
    "IntegrityFinding",
    "check_attractor_warnings",
    "validate_graph_integrity",
]

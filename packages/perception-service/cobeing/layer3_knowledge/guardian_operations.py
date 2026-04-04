"""Guardian interaction and schema proposal workflow for the knowledge graph.

This module implements the guardian-facing write path: the channel through
which a human guardian provides direct statements, reviews system-generated
schema proposals, and approves or rejects type creation.

**Guardian Statement:**

A guardian statement is a direct human assertion about a node in the graph.
It is stored as a GuardianStatement Instance node connected to the target
node via a GUARDIAN_STATEMENT edge.  The provenance source is GUARDIAN --
the strongest epistemic category in the Co-Being model -- and the confidence
is 1.0.

**Schema Proposal Lifecycle:**

The system (via ``create_schema_proposal``) proposes new SchemaType nodes
when the meta-schema evolution rules fire. Proposals have:
- ``status = PENDING``
- provenance source = INFERENCE (system-generated)

The guardian reviews proposals and either:
- Approves via ``apply_schema_proposal``: the proposal becomes ACTIVE, a
  SchemaType node is created at SCHEMA level with GUARDIAN_APPROVED_INFERENCE
  provenance, and INSTANCE_OF edges are created from the evidence instances.
- Rejects via ``reject_schema_proposal``: the proposal becomes REJECTED and
  the reason is stored for future reference, preventing re-proposal of the
  same type.

**Duplicate Proposal Handling:**

If a second proposal for the same ``proposed_type_name`` arrives while an
earlier proposal is still PENDING, the earlier one is superseded (status set
to SUPERSEDED, valid_to recorded) before the new proposal is created. This
prevents the guardian from seeing stale proposals and ensures the most recent
evidence drives the decision.

Usage::

    from cobeing.layer3_knowledge.guardian_operations import (
        add_guardian_statement,
        create_schema_proposal,
        apply_schema_proposal,
        reject_schema_proposal,
        GuardianStatementResult,
        SchemaProposalResult,
        SchemaTypeResult,
    )
    from cobeing.layer3_knowledge.in_memory_persistence import (
        InMemoryGraphPersistence,
    )
    from cobeing.shared.types import NodeId

    persistence = InMemoryGraphPersistence()

    # Guardian makes a direct statement about an object
    result = await add_guardian_statement(
        persistence,
        node_id=NodeId("instance-mug-001"),
        statement="This is a blue ceramic mug.",
        guardian_id="guardian-jim",
    )

    # System proposes a new type
    proposal = await create_schema_proposal(
        persistence,
        proposed_type_name="Mug",
        triggering_rule_id="rule-TYPE_CREATION_THRESHOLD",
        evidence_node_ids=[NodeId("instance-001"), NodeId("instance-002")],
    )

    # Guardian approves it
    schema_type = await apply_schema_proposal(persistence, proposal.proposal_node_id)

See Also:
    - ``cobeing.layer3_knowledge.protocols`` -- GraphPersistence Protocol
    - ``cobeing.layer3_knowledge.node_types`` -- KnowledgeNode, KnowledgeEdge
    - ``cobeing.layer3_knowledge.read_queries`` -- get_pending_proposals
    - ``cobeing.shared.provenance`` -- Provenance, ProvenanceSource
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter
from cobeing.layer3_knowledge.read_queries import get_pending_proposals
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.time_utils import utc_now
from cobeing.shared.types import EdgeId, NodeId


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GuardianStatementResult:
    """Outcome of ``add_guardian_statement``.

    Attributes:
        statement_node_id: ID of the newly created GuardianStatement node.
        target_node_id: ID of the node that the statement refers to.
    """

    statement_node_id: NodeId
    target_node_id: NodeId


@dataclass(frozen=True)
class SchemaProposalResult:
    """Outcome of ``create_schema_proposal``.

    Attributes:
        proposal_node_id: ID of the newly created SchemaProposal node.
        superseded_proposal_id: ID of the earlier PENDING proposal for the
            same type name that was superseded, or ``None`` if there was no
            earlier pending proposal.
    """

    proposal_node_id: NodeId
    superseded_proposal_id: NodeId | None


@dataclass(frozen=True)
class SchemaTypeResult:
    """Outcome of ``apply_schema_proposal``.

    Attributes:
        type_node_id: ID of the newly created SchemaType node.
        instance_of_edge_ids: IDs of the INSTANCE_OF edges created from
            each evidence instance node to the new SchemaType node.
    """

    type_node_id: NodeId
    instance_of_edge_ids: list[EdgeId]


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _new_node_id(prefix: str) -> NodeId:
    """Generate a unique NodeId with the given prefix.

    Args:
        prefix: Short descriptor for the node role, included to aid debugging.

    Returns:
        A unique NodeId in the form ``"{prefix}-{hex12}"``.
    """
    return NodeId(f"{prefix}-{uuid.uuid4().hex[:12]}")


def _new_edge_id(prefix: str) -> EdgeId:
    """Generate a unique EdgeId with the given prefix.

    Args:
        prefix: Short descriptor for the edge role.

    Returns:
        A unique EdgeId in the form ``"edge-{prefix}-{hex12}"``.
    """
    return EdgeId(f"edge-{prefix}-{uuid.uuid4().hex[:12]}")


def _make_provenance(source: ProvenanceSource, source_id: str) -> Provenance:
    """Build a Provenance instance at confidence 1.0.

    Guardian and system-structural operations always carry full confidence.

    Args:
        source: Which ProvenanceSource category applies.
        source_id: Identifier of the specific source.

    Returns:
        A Provenance instance with confidence 1.0.
    """
    return Provenance(
        source=source,
        source_id=source_id,
        confidence=1.0,
    )


async def _find_pending_proposal_for_type(
    persistence: GraphPersistence,
    proposed_type_name: str,
) -> KnowledgeNode | None:
    """Find an existing PENDING proposal for the given type name, if any.

    Scans the full pending-proposal list for a node whose
    ``properties["proposed_type_name"]`` matches the requested name.

    Args:
        persistence: The graph storage backend to query.
        proposed_type_name: The type name to look for.

    Returns:
        The first matching PENDING proposal node, or ``None`` if none exists.
    """
    pending = await get_pending_proposals(persistence)
    for node in pending:
        if (
            node.node_type == "SchemaProposal"
            and node.properties.get("proposed_type_name") == proposed_type_name
        ):
            return node
    return None


async def _supersede_proposal(
    persistence: GraphPersistence,
    node: KnowledgeNode,
) -> None:
    """Supersede a proposal node by setting status and valid_to.

    Mutates the node in-place and saves it back to persistence.

    Args:
        persistence: The graph storage backend to write to.
        node: The node to supersede. Mutated in-place.
    """
    node.status = NodeStatus.SUPERSEDED
    node.valid_to = utc_now()
    await persistence.save_node(node)


async def _get_evidence_instance_ids(
    persistence: GraphPersistence,
    proposal_id: NodeId,
) -> list[NodeId]:
    """Return the NodeIds of all instance nodes linked to a proposal via EVIDENCE edges.

    Looks for edges of type ``"EVIDENCE"`` with ``target_id == proposal_id``
    and returns the corresponding source node IDs.

    ``query_edges`` is now part of the ``GraphPersistence`` Protocol (T303),
    so this function calls it directly using an ``EdgeFilter`` instead of
    the previous duck-typed approach.

    Args:
        persistence: The graph storage backend.
        proposal_id: The NodeId of the SchemaProposal node.

    Returns:
        List of NodeIds for the evidence instance nodes. Empty if no EVIDENCE
        edges target this proposal.
    """
    evidence_edges: list[KnowledgeEdge] = await persistence.query_edges(
        EdgeFilter(edge_type="EVIDENCE", target_node_id=str(proposal_id))
    )
    return [edge.source_id for edge in evidence_edges]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def add_guardian_statement(
    persistence: GraphPersistence,
    node_id: NodeId,
    statement: str,
    guardian_id: str,
) -> GuardianStatementResult:
    """Record a direct guardian statement about a node.

    Creates a ``GuardianStatement`` Instance node and links it to the
    target node via a ``GUARDIAN_STATEMENT`` edge.  Both the node and the
    edge carry ``GUARDIAN`` provenance at confidence 1.0 -- direct human
    input is treated as maximally authoritative.

    The statement text and guardian identifier are stored as properties on
    the GuardianStatement node.  No lookup or deduplication is performed:
    every call creates a distinct statement node so the full history of
    guardian input is preserved in the graph.

    Args:
        persistence: The graph storage backend to write into.
        node_id: The NodeId of the node this statement refers to.
        statement: The text of the guardian's statement.
        guardian_id: Identifier of the guardian who made this statement
            (e.g. a username or session ID).

    Returns:
        A ``GuardianStatementResult`` containing the ID of the new
        GuardianStatement node and the target node ID.
    """
    statement_node_id = _new_node_id("guardian-stmt")
    provenance = _make_provenance(
        ProvenanceSource.GUARDIAN,
        source_id=guardian_id,
    )

    statement_node = KnowledgeNode(
        node_id=statement_node_id,
        node_type="GuardianStatement",
        schema_level=SchemaLevel.INSTANCE,
        properties={
            "statement": statement,
            "guardian_id": guardian_id,
        },
        provenance=provenance,
        confidence=1.0,
    )
    await persistence.save_node(statement_node)

    edge_id = _new_edge_id("guardian-stmt")
    edge = KnowledgeEdge(
        edge_id=edge_id,
        source_id=statement_node_id,
        target_id=node_id,
        edge_type="GUARDIAN_STATEMENT",
        provenance=provenance,
        confidence=1.0,
    )
    await persistence.save_edge(edge)

    return GuardianStatementResult(
        statement_node_id=statement_node_id,
        target_node_id=node_id,
    )


async def create_schema_proposal(
    persistence: GraphPersistence,
    proposed_type_name: str,
    triggering_rule_id: str,
    evidence_node_ids: list[NodeId],
) -> SchemaProposalResult:
    """Create a schema evolution proposal for guardian review.

    The system calls this when meta-schema evolution rules fire and determine
    that a new SchemaType should be considered.  The proposal is stored as a
    ``SchemaProposal`` Schema-level node with ``status = PENDING`` and
    ``INFERENCE`` provenance.

    **Duplicate handling:** If a PENDING proposal for the same
    ``proposed_type_name`` already exists, it is superseded before the new
    proposal is written.  The superseded proposal's ID is returned in
    ``SchemaProposalResult.superseded_proposal_id`` so the caller can log or
    notify the guardian about the update.

    **Evidence edges:** An ``EVIDENCE`` edge is created from each instance in
    ``evidence_node_ids`` to the new proposal node.  These edges record which
    observations motivated the proposal.

    Args:
        persistence: The graph storage backend to write into.
        proposed_type_name: The human-readable name for the proposed type,
            e.g. ``"Mug"`` or ``"DrinkingVessel"``.
        triggering_rule_id: NodeId (as string) of the EvolutionRule meta-schema
            node whose threshold triggered this proposal.
        evidence_node_ids: NodeIds of the Instance nodes whose accumulated
            similarity evidence motivated this proposal.

    Returns:
        A ``SchemaProposalResult`` with the new proposal's NodeId and the ID
        of any superseded earlier proposal (``None`` if there was none).
    """
    # ------------------------------------------------------------------
    # Step 1: Supersede any existing PENDING proposal for this type name.
    # ------------------------------------------------------------------
    superseded_proposal_id: NodeId | None = None
    old_proposal = await _find_pending_proposal_for_type(
        persistence, proposed_type_name
    )
    if old_proposal is not None:
        superseded_proposal_id = old_proposal.node_id
        await _supersede_proposal(persistence, old_proposal)

    # ------------------------------------------------------------------
    # Step 2: Create the new SchemaProposal node.
    # ------------------------------------------------------------------
    proposal_id = _new_node_id("schema-proposal")
    provenance = _make_provenance(
        ProvenanceSource.INFERENCE,
        source_id=triggering_rule_id,
    )

    proposal_node = KnowledgeNode(
        node_id=proposal_id,
        node_type="SchemaProposal",
        schema_level=SchemaLevel.SCHEMA,
        properties={
            "proposed_type_name": proposed_type_name,
            "triggering_rule_id": triggering_rule_id,
        },
        provenance=provenance,
        confidence=1.0,
        status=NodeStatus.PENDING,
    )
    await persistence.save_node(proposal_node)

    # ------------------------------------------------------------------
    # Step 3: Create EVIDENCE edges from each evidence node to the proposal.
    # ------------------------------------------------------------------
    for inst_id in evidence_node_ids:
        evidence_edge = KnowledgeEdge(
            edge_id=_new_edge_id("evidence"),
            source_id=inst_id,
            target_id=proposal_id,
            edge_type="EVIDENCE",
            provenance=provenance,
            confidence=1.0,
        )
        await persistence.save_edge(evidence_edge)

    return SchemaProposalResult(
        proposal_node_id=proposal_id,
        superseded_proposal_id=superseded_proposal_id,
    )


async def apply_schema_proposal(
    persistence: GraphPersistence,
    proposal_id: NodeId,
) -> SchemaTypeResult:
    """Guardian approves a pending schema proposal, creating the new type.

    This is the approval path: the guardian has reviewed the proposal and
    agrees that the proposed type should be added to the schema.

    The operation performs three atomic writes:

    1. The proposal node's status is changed to ACTIVE (approved).
    2. A new ``SchemaType`` Schema-level node is created with
       ``GUARDIAN_APPROVED_INFERENCE`` provenance.  Its type name is taken
       from the proposal's ``proposed_type_name`` property.
    3. An ``INSTANCE_OF`` edge is created from each evidence instance node
       (identified by traversing the proposal's EVIDENCE edges) to the new
       SchemaType.

    Args:
        persistence: The graph storage backend to read from and write into.
        proposal_id: The NodeId of the SchemaProposal node to approve.

    Returns:
        A ``SchemaTypeResult`` with the new SchemaType's NodeId and the list
        of EdgeIds for the created INSTANCE_OF edges.

    Raises:
        NodeNotFoundError: If no node with ``proposal_id`` exists.
    """
    from cobeing.layer3_knowledge.exceptions import NodeNotFoundError

    # ------------------------------------------------------------------
    # Step 1: Load and activate the proposal.
    # ------------------------------------------------------------------
    proposal = await persistence.get_node(proposal_id)
    if proposal is None:
        raise NodeNotFoundError(
            f"SchemaProposal node not found: {proposal_id}"
        )

    proposal.status = NodeStatus.ACTIVE
    await persistence.save_node(proposal)

    # ------------------------------------------------------------------
    # Step 2: Create the SchemaType node.
    # ------------------------------------------------------------------
    proposed_type_name: str = proposal.properties.get("proposed_type_name", "")
    type_node_id = _new_node_id("schema-type")

    type_provenance = _make_provenance(
        ProvenanceSource.GUARDIAN_APPROVED_INFERENCE,
        source_id=str(proposal_id),
    )

    type_node = KnowledgeNode(
        node_id=type_node_id,
        node_type="SchemaType",
        schema_level=SchemaLevel.SCHEMA,
        properties={
            "type_name": proposed_type_name,
            "source_proposal_id": str(proposal_id),
        },
        provenance=type_provenance,
        confidence=1.0,
    )
    await persistence.save_node(type_node)

    # ------------------------------------------------------------------
    # Step 3: Create INSTANCE_OF edges from evidence instances to the type.
    # ------------------------------------------------------------------
    evidence_ids = await _get_evidence_instance_ids(persistence, proposal_id)

    instance_of_edge_ids: list[EdgeId] = []
    for inst_id in evidence_ids:
        edge_id = _new_edge_id("instance-of")
        edge = KnowledgeEdge(
            edge_id=edge_id,
            source_id=inst_id,
            target_id=type_node_id,
            edge_type="INSTANCE_OF",
            provenance=type_provenance,
            confidence=1.0,
        )
        await persistence.save_edge(edge)
        instance_of_edge_ids.append(edge_id)

    return SchemaTypeResult(
        type_node_id=type_node_id,
        instance_of_edge_ids=instance_of_edge_ids,
    )


async def reject_schema_proposal(
    persistence: GraphPersistence,
    proposal_id: NodeId,
    reason: str,
) -> None:
    """Guardian rejects a pending schema proposal.

    Sets the proposal node's status to ``REJECTED`` and stores the rejection
    reason as a property.  The node is preserved in the graph so the system
    can detect that this type name was already considered and rejected,
    preventing infinite re-proposal of the same type.

    Args:
        persistence: The graph storage backend to read from and write into.
        proposal_id: The NodeId of the SchemaProposal node to reject.
        reason: A human-readable explanation for the rejection. Stored as
            ``properties["rejection_reason"]`` on the proposal node.

    Raises:
        NodeNotFoundError: If no node with ``proposal_id`` exists.
    """
    from cobeing.layer3_knowledge.exceptions import NodeNotFoundError

    proposal = await persistence.get_node(proposal_id)
    if proposal is None:
        raise NodeNotFoundError(
            f"SchemaProposal node not found: {proposal_id}"
        )

    proposal.status = NodeStatus.REJECTED
    proposal.properties = {**proposal.properties, "rejection_reason": reason}
    await persistence.save_node(proposal)


__all__ = [
    "GuardianStatementResult",
    "SchemaProposalResult",
    "SchemaTypeResult",
    "add_guardian_statement",
    "apply_schema_proposal",
    "create_schema_proposal",
    "reject_schema_proposal",
]

"""Bootstrap sequence for the Co-Being knowledge graph.

This module implements the one-time (idempotent) bootstrap that transitions
an empty graph to its minimal operational state.  Bootstrap creates:

1. Four EvolutionRule META_SCHEMA nodes as processing infrastructure
   permitted under CANON A.2:

    a. TYPE_CREATION_THRESHOLD  -- controls when accumulated similarity
       evidence is sufficient to propose a new SchemaType.
    b. GUARDIAN_NAME_TRIGGERS_TYPE -- guardian naming of an unnamed entity
       immediately creates a SchemaType.
    c. PREDICTION_ERROR_DEMOTION -- governs autonomous PropertyExpectation
       confidence demotion when prediction errors accumulate.
    d. RETRIEVAL_THRESHOLD -- minimum COMPUTES_TO edge confidence for direct
       recall.  Below this threshold, procedure execution is triggered.
       Tunable by guardian without redeployment.

2. One CoBeing SCHEMA node representing Co-Being itself -- the anchor
   node that everything else connects to.  This is an entity type (SCHEMA
   level), not world knowledge (INSTANCE) or a processing rule (META_SCHEMA).

Most nodes use provenance source INFERENCE (CANON A.11 bootstrap provenance
clause).  The RETRIEVAL_THRESHOLD rule uses GUARDIAN_APPROVED_INFERENCE
because it is a tunable policy parameter, not a structural rule.

The EvolutionRule nodes encode *process rules*, not world knowledge, so they
are explicitly permitted under CANON A.2's experience-first boundary.  The
CoBeing self-node is a system-level entity type that must exist before any
experience can be connected to the system that had it.

After bootstrap the graph must contain:
    - Exactly 4 META_SCHEMA nodes (the EvolutionRules)
    - Exactly 1 SCHEMA node (the CoBeing self-node)
    - 0 INSTANCE nodes

If these post-conditions are not met, :class:`BootstrapError` is raised.

Usage::

    from cobeing.layer3_knowledge import InMemoryGraphPersistence
    from cobeing.layer3_knowledge.bootstrap import bootstrap_graph

    persistence = InMemoryGraphPersistence()
    result = await bootstrap_graph(persistence)
    # result.rules_created == 4, result.self_node_created == True
    # result.total_nodes == 5

    # Running again is safe (idempotent):
    result2 = await bootstrap_graph(persistence)
    # result2.rules_created == 0, result2.self_node_created == False
    # result2.total_nodes == 5
"""

from __future__ import annotations

from dataclasses import dataclass

from cobeing.layer3_knowledge.exceptions import BootstrapError
from cobeing.layer3_knowledge.node_types import KnowledgeNode, NodeStatus, SchemaLevel
from cobeing.layer3_knowledge.primitive_bootstrap import bootstrap_primitives
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import NodeId

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

COBEING_SELF_NODE_ID: NodeId = NodeId("cobeing-self")
"""The well-known node_id for the CoBeing self-identity node."""

# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BootstrapResult:
    """Outcome of a bootstrap_graph() call.

    Attributes:
        rules_created: Number of EvolutionRule nodes that did not exist
            before this call and were therefore created.
        rules_existing: Number of EvolutionRule nodes that already existed
            and were left untouched (idempotency count).
        total_rules: Total META_SCHEMA nodes present in the graph after
            the bootstrap call completes (created + existing).
        self_node_created: Whether the CoBeing self-identity node was
            created during this call.  False if it already existed
            (idempotency).
        total_nodes: Total number of bootstrap nodes (rules + self-node)
            present in the graph after bootstrap completes.
        primitives_created: Number of PrimitiveSymbolNode nodes created
            this call (conversation engine Phase 1).
        primitives_existing: Number of PrimitiveSymbolNode nodes that
            already existed (idempotency count).
    """

    rules_created: int
    rules_existing: int
    total_rules: int
    self_node_created: bool
    total_nodes: int
    primitives_created: int = 0
    primitives_existing: int = 0


# ---------------------------------------------------------------------------
# Bootstrap rule definitions
# ---------------------------------------------------------------------------

# Each rule is described as a plain dict so that the building logic remains
# in one place.  The dicts are consumed by _build_evolution_rule_node().
#
# Optional key "provenance_source" overrides the default INFERENCE provenance.
# If absent, INFERENCE is used (existing behavior for the original 3 rules).

_BOOTSTRAP_RULES: list[dict] = [
    {
        "node_id": "evolution-rule-type-creation-threshold",
        "properties": {
            "rule_name": "TYPE_CREATION_THRESHOLD",
            "threshold": 3,
            "description": (
                "Number of distinct observations of the same label before "
                "proposing a new SchemaType"
            ),
        },
    },
    {
        "node_id": "evolution-rule-guardian-name-triggers-type",
        "properties": {
            "rule_name": "GUARDIAN_NAME_TRIGGERS_TYPE",
            "trigger_action": "create_type",
            "description": (
                "When the guardian names an object, immediately create a "
                "SchemaType for it"
            ),
        },
    },
    {
        "node_id": "evolution-rule-prediction-error-demotion",
        "properties": {
            "rule_name": "PREDICTION_ERROR_DEMOTION",
            "rule_type": "PREDICTION_ERROR_DEMOTION",
            "demotion_threshold": 0.25,
            "min_instances_required": 5,
            "demotion_factor": 0.15,
            "min_confidence_floor": 0.10,
            "confirmation_alpha": 0.03,
            "confidence_ceiling": 0.95,
            "cooldown_observations": 3,
            "requires_notification": True,
            "autonomous_scope": "PROPERTY_EXPECTATION_DEMOTION_ONLY",
            "outlier_sigma_threshold": 2.0,
            "description": (
                "Governs autonomous PropertyExpectation confidence demotion "
                "when prediction errors accumulate. Fires when the ratio of "
                "error_count to instance_count exceeds demotion_threshold, "
                "provided at least min_instances_required observations exist. "
                "Multiplies confidence by (1 - demotion_factor), floored at "
                "min_confidence_floor. Guardian is notified post-hoc."
            ),
        },
    },
    {
        "node_id": "rule:retrieval_threshold",
        "provenance_source": "guardian_approved_inference",
        "properties": {
            "rule_name": "RETRIEVAL_THRESHOLD",
            "current_value": 0.50,
            "description": (
                "Minimum COMPUTES_TO edge confidence for direct recall. "
                "Below this threshold, procedure execution is triggered. "
                "Tunable by guardian without redeployment."
            ),
        },
    },
]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _build_bootstrap_provenance(
    source: ProvenanceSource = ProvenanceSource.INFERENCE,
) -> Provenance:
    """Return a bootstrap provenance instance.

    By default, bootstrap nodes use INFERENCE provenance with a source_id
    of "bootstrap" and confidence 1.0 (CANON A.11).  The optional *source*
    parameter allows individual rules to override the provenance source
    (e.g., GUARDIAN_APPROVED_INFERENCE for tunable policy parameters).

    Args:
        source: Provenance source category.  Defaults to INFERENCE.
    """
    return Provenance(
        source=source,
        source_id="bootstrap",
        confidence=1.0,
    )


def _build_evolution_rule_node(rule_def: dict) -> KnowledgeNode:
    """Construct a KnowledgeNode for a single bootstrap EvolutionRule.

    Args:
        rule_def: A dict with keys ``node_id`` (str) and ``properties``
            (dict).  Optionally includes ``provenance_source`` (str) to
            override the default INFERENCE provenance.  These come from
            the ``_BOOTSTRAP_RULES`` list above.

    Returns:
        A fully constructed KnowledgeNode at META_SCHEMA level.
    """
    # Determine provenance source: use override if present, else INFERENCE.
    provenance_source_str = rule_def.get("provenance_source")
    if provenance_source_str is not None:
        provenance_source = ProvenanceSource(provenance_source_str)
    else:
        provenance_source = ProvenanceSource.INFERENCE

    return KnowledgeNode(
        node_id=NodeId(rule_def["node_id"]),
        node_type="EvolutionRule",
        schema_level=SchemaLevel.META_SCHEMA,
        properties=dict(rule_def["properties"]),  # defensive copy
        provenance=_build_bootstrap_provenance(provenance_source),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _build_cobeing_self_node() -> KnowledgeNode:
    """Construct the CoBeing self-identity node.

    This is the anchor node representing Co-Being itself in the knowledge
    graph.  It lives at SCHEMA level because it is an entity type -- it
    defines what Co-Being *is* as a category, not a specific observation
    (INSTANCE) or a processing rule (META_SCHEMA).

    Everything Co-Being learns, observes, and reasons about ultimately
    connects back to this node as the system's self-representation.

    Returns:
        A fully constructed KnowledgeNode at SCHEMA level with node_id
        "cobeing-self" and node_type "CoBeing".
    """
    return KnowledgeNode(
        node_id=COBEING_SELF_NODE_ID,
        node_type="CoBeing",
        schema_level=SchemaLevel.SCHEMA,
        properties={
            "description": (
                "A young mind learning about the world through direct experience"
            ),
            "phase": "1.5",
            "version": "0.1.0",
        },
        provenance=_build_bootstrap_provenance(),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def bootstrap_graph(persistence: GraphPersistence) -> BootstrapResult:
    """Bootstrap an empty graph to operational state.

    Creates exactly 4 EvolutionRule nodes at META_SCHEMA level and 1
    CoBeing self-identity node at SCHEMA level:

    **EvolutionRule nodes (META_SCHEMA):**

    1. TYPE_CREATION_THRESHOLD -- threshold for creating new types
    2. GUARDIAN_NAME_TRIGGERS_TYPE -- guardian naming triggers type creation
    3. PREDICTION_ERROR_DEMOTION -- autonomous confidence demotion on
       accumulated prediction errors
    4. RETRIEVAL_THRESHOLD -- minimum COMPUTES_TO confidence for direct
       recall (tunable by guardian)

    **Self-identity node (SCHEMA):**

    5. CoBeing self-node ("cobeing-self") -- the anchor that everything
       else connects to

    Most nodes carry INFERENCE provenance with source_id="bootstrap" and
    confidence=1.0 (CANON A.11 bootstrap provenance clause).  The
    RETRIEVAL_THRESHOLD rule carries GUARDIAN_APPROVED_INFERENCE provenance
    because it is a tunable policy parameter.

    This function is idempotent.  Before creating each node it checks
    whether a node with that node_id already exists via
    ``persistence.get_node()``.  If it exists, it is counted toward the
    existing totals and not recreated.

    After all nodes have been created (or found to already exist), the
    function validates the graph post-conditions by checking that each
    expected node exists by its specific node_id.

    Args:
        persistence: The graph persistence backend to bootstrap.  Must
            implement the ``GraphPersistence`` Protocol.

    Returns:
        A :class:`BootstrapResult` with counts of newly-created nodes,
        already-existing nodes, and totals after bootstrap.

    Raises:
        BootstrapError: If any bootstrap node cannot be created, or if the
            post-bootstrap validation detects an unexpected graph state.
    """
    rules_created = 0
    rules_existing = 0

    # ------------------------------------------------------------------
    # Phase 1: EvolutionRule nodes (META_SCHEMA)
    # ------------------------------------------------------------------

    for rule_def in _BOOTSTRAP_RULES:
        node_id = NodeId(rule_def["node_id"])

        # Idempotency check: skip creation if the rule already exists.
        existing = await persistence.get_node(node_id)
        if existing is not None:
            rules_existing += 1
            continue

        node = _build_evolution_rule_node(rule_def)
        try:
            await persistence.save_node(node)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to save EvolutionRule node '{node_id}': {exc}"
            ) from exc

        rules_created += 1

    # ------------------------------------------------------------------
    # Phase 2: CoBeing self-identity node (SCHEMA)
    # ------------------------------------------------------------------

    self_node_created = False
    existing_self = await persistence.get_node(COBEING_SELF_NODE_ID)
    if existing_self is None:
        self_node = _build_cobeing_self_node()
        try:
            await persistence.save_node(self_node)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to save CoBeing self-node "
                f"'{COBEING_SELF_NODE_ID}': {exc}"
            ) from exc
        self_node_created = True

    # ------------------------------------------------------------------
    # Post-bootstrap validation
    # ------------------------------------------------------------------
    # Validate by specific node ID existence, not by schema-level counts.
    # Counting by level would fail once the procedural ontology bootstrap
    # adds ConceptPrimitive (SCHEMA) and additional META_SCHEMA nodes.

    for rule_def in _BOOTSTRAP_RULES:
        node_id = NodeId(rule_def["node_id"])
        if await persistence.get_node(node_id) is None:
            raise BootstrapError(
                f"Post-bootstrap validation failed: EvolutionRule node "
                f"'{node_id}' is missing from the graph."
            )

    if await persistence.get_node(COBEING_SELF_NODE_ID) is None:
        raise BootstrapError(
            f"Post-bootstrap validation failed: CoBeing self-node "
            f"'{COBEING_SELF_NODE_ID}' is missing from the graph."
        )

    # ------------------------------------------------------------------
    # Phase 3: PrimitiveSymbolNode seed (Conversation Engine Phase 1)
    # ------------------------------------------------------------------

    primitive_result = await bootstrap_primitives(persistence)

    total_rules = rules_created + rules_existing

    return BootstrapResult(
        rules_created=rules_created,
        rules_existing=rules_existing,
        total_rules=total_rules,
        self_node_created=self_node_created,
        total_nodes=total_rules + 1,
        primitives_created=primitive_result.created,
        primitives_existing=primitive_result.existing,
    )


async def get_evolution_rule_value(
    persistence: GraphPersistence,
    rule_name: str,
) -> float | None:
    """Read the current_value property of a named EvolutionRule node.

    Looks up the rule by matching ``rule_name`` against the
    ``_BOOTSTRAP_RULES`` definitions, retrieves the node from the graph,
    and returns its ``current_value`` property.

    Returns None (not an error) if the rule does not exist in the graph.
    Returns None if the rule exists but has no ``current_value`` property.

    Args:
        persistence: Graph persistence backend.
        rule_name: The rule_name property to look for
            (e.g., "RETRIEVAL_THRESHOLD").

    Returns:
        The current_value as float, or None if not found.
    """
    for rule_def in _BOOTSTRAP_RULES:
        if rule_def["properties"].get("rule_name") == rule_name:
            node = await persistence.get_node(NodeId(rule_def["node_id"]))
            if node is None:
                return None
            val = node.properties.get("current_value")
            return float(val) if val is not None else None
    return None


__all__ = [
    "BootstrapResult",
    "COBEING_SELF_NODE_ID",
    "bootstrap_graph",
    "get_evolution_rule_value",
]

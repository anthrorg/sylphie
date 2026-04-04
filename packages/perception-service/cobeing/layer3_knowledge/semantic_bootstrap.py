"""Semantic domain bootstrap for Co-Being (Phase 1.8, P1.8-E1/T003).

Implements the TAUGHT_PROCEDURE bootstrap for semantic vocabulary in four
dependency-ordered layers:

  Layer 0 -- Domain registration:
    - 1 DomainRegistration META_SCHEMA node (``domain:semantic``) declaring the
      SemanticDomain per CANON A.20.5(a).

  Layer 1 -- Semantic edge type vocabulary nodes (17 total):
    - 17 SemanticEdgeType SCHEMA nodes, one per semantic relationship type.
    - Covers: IS_A, HAS_PROPERTY, LACKS_PROPERTY, PART_OF, LOCATED_IN,
      USED_FOR, CAUSES, ENABLES, PREVENTS, REQUIRES, ACHIEVES, PRODUCES,
      CONSUMES, CONTRADICTS, SIMILAR_TO, OPPOSITE_OF, DENOTES.
    - Each node carries: name, display_name, description, is_symmetric,
      domain_constraint, range_constraint, vocabulary_usage_count=0,
      processing_tier, status=ACTIVE.

  Layer 2 -- Logical axiom nodes (4 total):
    - 4 LogicalAxiom META_SCHEMA nodes governing structural behaviour.
    - Covers: IS_A transitivity (query_time), IS_A asymmetry (write_time),
      CAUSES asymmetry (write_time), PART_OF transitivity (query_time).
    - Each node carries: axiom_type, governed_edge_type, description,
      enforcement, and axiom-specific optional fields.

  Layer 3 -- Structural infrastructure edge:
    - 1 DEPENDS_ON edge from ``domain:semantic`` to ``concept:integer``.
    - Documents the dependency of scope_context_count arithmetic on
      AbstractDomain's integer ConceptPrimitive.

Post-bootstrap: read-modify-write pass adds scope_context_count=0 to any
existing WordSenseNode nodes that do not already carry the property. This
prepares the language layer for E2's context tracking.

Guardian notification (CANON A.21.4): before any graph writes, the function
sends a notification to the supplied GuardianNotificationSink and blocks
until the sink confirms readiness. When notification_sink is None the
notification step is skipped entirely (test/offline mode).

All nodes carry TAUGHT_PROCEDURE provenance (CANON A.11 / A.18). This
function is idempotent: nodes that already exist are counted as existing and
not recreated.

Usage::

    from cobeing.layer3_knowledge.semantic_bootstrap import (
        bootstrap_semantic_ontology,
    )

    result = await bootstrap_semantic_ontology(persistence, notification_sink=sink)
    # result.edge_types_created, result.axioms_created, result.success
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from cobeing.layer3_knowledge.exceptions import BootstrapError
from cobeing.layer3_knowledge.scope_context_mechanics import ensure_categorical_threshold_rule
from cobeing.layer3_knowledge.language_types import DENOTES, WORD_SENSE_NODE
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import NodeFilter
from cobeing.layer3_knowledge.semantic_types import (
    DOMAIN_REGISTRATION,
    LOGICAL_AXIOM,
    SEMANTIC_EDGE_TYPE,
)
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Guardian notification Protocol (local — avoids circular imports)
# ---------------------------------------------------------------------------


class GuardianNotificationSink(Protocol):
    """Contract for delivering a notification to the guardian and receiving
    confirmation before semantic domain installation proceeds.

    Defined locally in this module rather than imported from the guardian
    package to prevent a circular import: the guardian layer imports from
    the knowledge layer; the knowledge layer must not import back.

    Any object with a ``notify_and_wait`` method satisfying this shape
    satisfies the Protocol without inheriting from it (structural subtyping).

    Example implementation at the composition root::

        class GuardianQueueNotificationSink:
            def __init__(self, queue: GuardianQueue) -> None:
                self._queue = queue

            async def notify_and_wait(self, message: str) -> None:
                await self._queue.enqueue_system_message(message)
                await self._queue.wait_for_guardian_acknowledgement()
    """

    async def notify_and_wait(self, message: str) -> None:
        """Send a notification message to the guardian and block until
        the guardian has acknowledged it.

        This is the A.21.4 blocking confirmation gate. The semantic domain
        bootstrap must not commit any graph writes until this coroutine
        returns.

        Args:
            message: Human-readable message explaining what the system is
                about to install. Presented to the guardian before any graph
                writes occur.

        Raises:
            Exception: Any exception signals that the guardian could not
                confirm. The bootstrap function treats any exception as a
                fatal error and re-raises wrapped in BootstrapError.
        """
        ...


# ---------------------------------------------------------------------------
# Guardian notification message (from semantic-ontology.yaml)
# ---------------------------------------------------------------------------

_GUARDIAN_MESSAGE = (
    "I'm ready to learn semantic relationships - things like is a, "
    "has the property, causes, etc."
)

# ---------------------------------------------------------------------------
# Provenance helper
# ---------------------------------------------------------------------------


def _taught() -> Provenance:
    """Return the canonical TAUGHT_PROCEDURE provenance for all bootstrap nodes."""
    return Provenance(
        source=ProvenanceSource.TAUGHT_PROCEDURE,
        source_id="semantic-ontology-bootstrap",
        confidence=1.0,
    )


# ===========================================================================
# Layer 0: Domain registration node
# ===========================================================================

_DOMAIN_REGISTRATION_DEF: dict = {
    "node_id": "domain:semantic",
    "node_type": DOMAIN_REGISTRATION,
    "schema_level": SchemaLevel.META_SCHEMA,
    "properties": {
        "domain_name": "SemanticDomain",
        "display_name": "Semantic Domain",
        "description": (
            "Declarative semantic knowledge domain. Stores taxonomic, causal, "
            "spatial, and functional relationships between concepts. Populated "
            "exclusively through guardian teaching and sensor observation per "
            "A.1. Zero semantic facts at bootstrap."
        ),
        "status": "ACTIVE",
        "install_timestamp": None,  # set at runtime below
        "minimum_edge_count_before_monitoring": 10,
        "domain_label_prefix": "semantic",
        "installed_by_skill": "semantic-ontology",
    },
}


async def _bootstrap_layer0(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 0: DomainRegistration META_SCHEMA node.

    Returns:
        dict with keys: domain_created, domain_existing.
    """
    counts: dict[str, int] = {"domain_created": 0, "domain_existing": 0}
    node_id = NodeId(_DOMAIN_REGISTRATION_DEF["node_id"])

    if await persistence.get_node(node_id) is not None:
        counts["domain_existing"] += 1
        return counts

    props = dict(_DOMAIN_REGISTRATION_DEF["properties"])
    props["install_timestamp"] = datetime.now(UTC).isoformat()

    node = KnowledgeNode(
        node_id=node_id,
        node_type=_DOMAIN_REGISTRATION_DEF["node_type"],
        schema_level=_DOMAIN_REGISTRATION_DEF["schema_level"],
        properties=props,
        provenance=_taught(),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )
    try:
        await persistence.save_node(node)
    except Exception as exc:
        raise BootstrapError(
            f"Failed to create DomainRegistration node 'domain:semantic': {exc}"
        ) from exc

    counts["domain_created"] += 1
    return counts


# ===========================================================================
# Layer 1: SemanticEdgeType vocabulary nodes (17 total)
# ===========================================================================

# Each entry maps directly to one SemanticEdgeType vocabulary node in
# semantic-ontology.yaml. Properties follow the YAML spec exactly.
# Optional properties (e.g. governed_by_axioms, property_type_enum,
# transitivity_policy, edge_constant_source, traversal_directions) are only
# included when present in the YAML.

_EDGE_TYPE_DEFS: list[dict] = [
    # --- Taxonomic and property types ---
    {
        "node_id": "semantic:edge_type:IS_A",
        "name": "IS_A",
        "display_name": "is a",
        "description": (
            "Taxonomic subsumption: the subject is an instance or subtype "
            "of the object category. Governed by IS_A transitivity (query "
            "time) and IS_A asymmetry (write time). Processed in anterior "
            "temporal lobe (Hodges et al., 1995). Property inheritance via "
            "IS_A chains is NOT assumed; it must be learned empirically."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "category",
        "processing_tier": "fast",
        "governed_by_axioms": ["axiom:IS_A:transitivity", "axiom:IS_A:asymmetry"],
    },
    {
        "node_id": "semantic:edge_type:HAS_PROPERTY",
        "name": "HAS_PROPERTY",
        "display_name": "has property",
        "description": (
            "Asserts that an entity possesses a property or attribute. "
            "The property_type subdivision [sensory, functional, categorical] "
            "is declared at the edge instance level (GUARDIAN provenance). "
            "Three biologically distinct streams per Luria/Binder et al. (2009)."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "property",
        "processing_tier": "fast",
        "property_type_enum": ["sensory", "functional", "categorical"],
    },
    {
        "node_id": "semantic:edge_type:LACKS_PROPERTY",
        "name": "LACKS_PROPERTY",
        "display_name": "lacks property",
        "description": (
            "Explicit negation: the subject definitively does not possess "
            "this property. Required by the Open World Assumption (A.1): "
            "absence in the graph means unknown, not false. LACKS_PROPERTY "
            "is the only way to record a confirmed negative assertion."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "property",
        "processing_tier": "moderate",
    },
    # --- Mereological and spatial types ---
    {
        "node_id": "semantic:edge_type:PART_OF",
        "name": "PART_OF",
        "display_name": "part of",
        "description": (
            "Mereological containment: the subject is a structural component "
            "of the object. Governed by PART_OF transitivity (query time, "
            "15% confidence degradation per hop). Both constituent edges must "
            "have scope_context_count >= 2 before transitivity is applied."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "entity",
        "processing_tier": "moderate",
        "governed_by_axioms": ["axiom:PART_OF:transitivity"],
    },
    {
        "node_id": "semantic:edge_type:LOCATED_IN",
        "name": "LOCATED_IN",
        "display_name": "located in",
        "description": (
            "Spatial containment: the subject is physically or functionally "
            "located within the object. Thematic relation processed in "
            "posterior middle temporal gyrus (Schwartz et al., 2011)."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "location",
        "processing_tier": "fast",
    },
    # --- Functional and purpose types ---
    {
        "node_id": "semantic:edge_type:USED_FOR",
        "name": "USED_FOR",
        "display_name": "used for",
        "description": (
            "Functional purpose: the subject serves the stated purpose or use. "
            "Thematic relation (co-occurrence based) processed in posterior "
            "middle temporal gyrus (Schwartz et al., 2011). Distinct from "
            "ACHIEVES -- USED_FOR is artifact-to-purpose, not action outcome."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "purpose",
        "processing_tier": "fast",
    },
    # --- Causal and conditional types ---
    {
        "node_id": "semantic:edge_type:CAUSES",
        "name": "CAUSES",
        "display_name": "causes",
        "description": (
            "Sufficient causation: the subject brings about the object. "
            "Governed by CAUSES asymmetry (write time). Transitivity is NOT "
            "applied automatically -- causal chains require deliberative inner "
            "monologue reasoning per Luria Section 3 (Sloman, 2005)."
        ),
        "is_symmetric": False,
        "domain_constraint": "event_or_entity",
        "range_constraint": "event_or_entity",
        "processing_tier": "deliberative",
        "transitivity_policy": "inner_monologue_only",
        "governed_by_axioms": ["axiom:CAUSES:asymmetry"],
    },
    {
        "node_id": "semantic:edge_type:ENABLES",
        "name": "ENABLES",
        "display_name": "enables",
        "description": (
            "Necessary but not sufficient condition: the subject makes the "
            "object possible without directly causing it. Weaker than CAUSES. "
            "Processed in causal reasoning network alongside CAUSES and "
            "PREVENTS (Barbey & Patterson, 2011)."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "entity",
        "processing_tier": "deliberative",
    },
    {
        "node_id": "semantic:edge_type:PREVENTS",
        "name": "PREVENTS",
        "display_name": "prevents",
        "description": (
            "Negative causal blocking: the subject makes the object impossible "
            "or significantly less likely. Semantic inverse of ENABLES within "
            "the causal schema network."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "entity",
        "processing_tier": "deliberative",
    },
    # --- Action-schema types ---
    {
        "node_id": "semantic:edge_type:REQUIRES",
        "name": "REQUIRES",
        "display_name": "requires",
        "description": (
            "Prerequisite relation: the subject cannot be achieved or executed "
            "without the object first being satisfied. Primary edge type for "
            "backward chaining in goal decomposition (E4). Distinct from "
            "ENABLES -- REQUIRES is a necessary precondition."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "entity",
        "processing_tier": "deliberative",
    },
    {
        "node_id": "semantic:edge_type:ACHIEVES",
        "name": "ACHIEVES",
        "display_name": "achieves",
        "description": (
            "Functional output of an action or process: the subject "
            "accomplishes the stated goal or outcome. Paired with REQUIRES "
            "for backward chaining in frontal-parietal action planning network."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "goal",
        "processing_tier": "deliberative",
    },
    {
        "node_id": "semantic:edge_type:PRODUCES",
        "name": "PRODUCES",
        "display_name": "produces",
        "description": (
            "Generative output: the subject generates, creates, or yields the "
            "object as output. Distinct from ACHIEVES (goal-directed) -- "
            "PRODUCES is about generative outputs of processes."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "entity",
        "processing_tier": "moderate",
    },
    {
        "node_id": "semantic:edge_type:CONSUMES",
        "name": "CONSUMES",
        "display_name": "consumes",
        "description": (
            "Resource consumption: the subject uses up or depletes the object "
            "in the course of its operation or existence. Semantic inverse of "
            "PRODUCES within resource-flow schemas."
        ),
        "is_symmetric": False,
        "domain_constraint": "entity",
        "range_constraint": "entity",
        "processing_tier": "moderate",
    },
    # --- Epistemic and semantic opposition types ---
    {
        "node_id": "semantic:edge_type:CONTRADICTS",
        "name": "CONTRADICTS",
        "display_name": "contradicts",
        "description": (
            "Semantic contradiction: the subject and object cannot both be "
            "true of the same entity at the same time. Symmetric. Activates "
            "anterior cingulate cortex for conflict detection (Botvinick "
            "et al., 2001). Distinct from OPPOSITE_OF."
        ),
        "is_symmetric": True,
        "domain_constraint": "assertion",
        "range_constraint": "assertion",
        "processing_tier": "deliberative",
    },
    {
        "node_id": "semantic:edge_type:SIMILAR_TO",
        "name": "SIMILAR_TO",
        "display_name": "similar to",
        "description": (
            "Analogical similarity: the subject shares significant properties "
            "or structural features with the object without being in an IS_A "
            "relationship. Symmetric. Processed in angular gyrus (Binder et "
            "al., 2009). Enables analogical reasoning at scale."
        ),
        "is_symmetric": True,
        "domain_constraint": "entity",
        "range_constraint": "entity",
        "processing_tier": "moderate",
    },
    {
        "node_id": "semantic:edge_type:OPPOSITE_OF",
        "name": "OPPOSITE_OF",
        "display_name": "opposite of",
        "description": (
            "Antonymy: the subject and object occupy opposite ends of a "
            "semantic dimension. Symmetric. Processed in angular gyrus "
            "alongside SIMILAR_TO (Binder et al., 2009). Distinct from "
            "CONTRADICTS (which applies to assertions, not concepts)."
        ),
        "is_symmetric": True,
        "domain_constraint": "entity",
        "range_constraint": "entity",
        "processing_tier": "moderate",
    },
    # --- Cross-domain bridge (DENOTES, constant from language_types) ---
    {
        "node_id": "semantic:edge_type:DENOTES",
        "name": DENOTES,  # uses the imported constant to stay in sync
        "display_name": "denotes",
        "description": (
            "Cross-domain bridge: a WordSenseNode in LanguageDomain refers to "
            "a concept node in SemanticDomain. Implements the angular gyrus "
            "convergence zone (Damasio, 1989; Binder & Desai, 2011): binding "
            "linguistic form to meaning. Edge type constant defined in "
            "language_types.DENOTES, not redefined here."
        ),
        "is_symmetric": False,
        "domain_constraint": "LanguageDomain",
        "range_constraint": "SemanticDomain",
        "processing_tier": "fast",
        "edge_constant_source": "language_types.DENOTES",
        "traversal_directions": ["forward", "reverse"],
    },
]


async def _bootstrap_layer1(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 1: SemanticEdgeType SCHEMA vocabulary nodes (17 total).

    Returns:
        dict with keys: edge_types_created, edge_types_existing.
    """
    counts: dict[str, int] = {
        "edge_types_created": 0,
        "edge_types_existing": 0,
    }

    for defn in _EDGE_TYPE_DEFS:
        node_id = NodeId(defn["node_id"])

        if await persistence.get_node(node_id) is not None:
            counts["edge_types_existing"] += 1
            continue

        # Build properties dict from the definition, including only keys that
        # are actually present. Optional keys (governed_by_axioms, etc.) are
        # only included when the defn has them.
        props: dict = {
            "name": defn["name"],
            "display_name": defn["display_name"],
            "description": defn["description"],
            "is_symmetric": defn["is_symmetric"],
            "domain_constraint": defn["domain_constraint"],
            "range_constraint": defn["range_constraint"],
            "vocabulary_usage_count": 0,
            "processing_tier": defn["processing_tier"],
            "status": "ACTIVE",
            "installed_by_skill": "semantic-ontology",
        }

        # Include optional properties when present in the definition.
        for optional_key in (
            "governed_by_axioms",
            "property_type_enum",
            "transitivity_policy",
            "edge_constant_source",
            "traversal_directions",
        ):
            if optional_key in defn:
                props[optional_key] = defn[optional_key]

        node = KnowledgeNode(
            node_id=node_id,
            node_type=SEMANTIC_EDGE_TYPE,
            schema_level=SchemaLevel.SCHEMA,
            properties=props,
            provenance=_taught(),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        try:
            await persistence.save_node(node)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to create SemanticEdgeType node '{node_id}': {exc}"
            ) from exc

        counts["edge_types_created"] += 1

    return counts


# ===========================================================================
# Layer 2: LogicalAxiom META_SCHEMA nodes (4 total)
# ===========================================================================

_AXIOM_DEFS: list[dict] = [
    {
        "node_id": "axiom:IS_A:transitivity",
        "axiom_type": "transitivity",
        "governed_edge_type": "IS_A",
        "description": (
            "If A IS_A B and B IS_A C, then A IS_A C. Enforced at query time: "
            "the query engine applies this rule during IS_A chain traversal, "
            "not by materialising inferred edges (which would violate A.1). "
            "Confidence degrades across hops (Rosch, 1975; Collins & Loftus, "
            "1975)."
        ),
        "enforcement": "query_time",
        "confidence_degradation_per_hop": 0.05,
        "scope_context_count_required": 1,
    },
    {
        "node_id": "axiom:IS_A:asymmetry",
        "axiom_type": "asymmetry",
        "governed_edge_type": "IS_A",
        "description": (
            "If A IS_A B, then B IS_NOT_A A. Enforced at write time: when "
            "assert_fact attempts to create IS_A(A, B) while IS_A(B, A) already "
            "exists, the contradiction detector fires before any write is "
            "committed. The direction of taxonomic subsumption is definitionally "
            "non-reversible."
        ),
        "enforcement": "write_time",
        "violation_action": "trigger_contradiction_detector",
    },
    {
        "node_id": "axiom:CAUSES:asymmetry",
        "axiom_type": "asymmetry",
        "governed_edge_type": "CAUSES",
        "description": (
            "If A CAUSES B, then B does not CAUSE A in the same causal chain. "
            "Enforced at write time: prevents circular causal graphs. CAUSES "
            "transitivity is NOT included here -- causal chains require "
            "deliberative inner monologue reasoning (Sloman, 2005). E5 inner "
            "monologue will handle causal chain reasoning when implemented."
        ),
        "enforcement": "write_time",
        "violation_action": "trigger_contradiction_detector",
        "transitivity": "not_applied_automatically",
    },
    {
        "node_id": "axiom:PART_OF:transitivity",
        "axiom_type": "transitivity",
        "governed_edge_type": "PART_OF",
        "description": (
            "If A PART_OF B and B PART_OF C, then A PART_OF C. Enforced at "
            "query time with 15% confidence degradation per hop (more aggressive "
            "than IS_A because biological PART_OF transitivity is context-"
            "dependent: Winston, Chaffin & Herrmann, 1987). Both constituent "
            "edges must reach scope_context_count >= 2 before the axiom is "
            "applied automatically."
        ),
        "enforcement": "query_time",
        "confidence_degradation_per_hop": 0.15,
        "scope_context_count_required": 2,
    },
]


async def _bootstrap_layer2(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 2: LogicalAxiom META_SCHEMA nodes (4 total).

    Returns:
        dict with keys: axioms_created, axioms_existing.
    """
    counts: dict[str, int] = {"axioms_created": 0, "axioms_existing": 0}

    for defn in _AXIOM_DEFS:
        node_id = NodeId(defn["node_id"])

        if await persistence.get_node(node_id) is not None:
            counts["axioms_existing"] += 1
            continue

        props: dict = {
            "axiom_type": defn["axiom_type"],
            "governed_edge_type": defn["governed_edge_type"],
            "description": defn["description"],
            "enforcement": defn["enforcement"],
            "status": "ACTIVE",
            "installed_by_skill": "semantic-ontology",
        }

        # Include optional properties when present in the definition.
        for optional_key in (
            "confidence_degradation_per_hop",
            "scope_context_count_required",
            "violation_action",
            "transitivity",
        ):
            if optional_key in defn:
                props[optional_key] = defn[optional_key]

        node = KnowledgeNode(
            node_id=node_id,
            node_type=LOGICAL_AXIOM,
            schema_level=SchemaLevel.META_SCHEMA,
            properties=props,
            provenance=_taught(),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        try:
            await persistence.save_node(node)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to create LogicalAxiom node '{node_id}': {exc}"
            ) from exc

        counts["axioms_created"] += 1

    return counts


# ===========================================================================
# Layer 3: Structural infrastructure edge
# ===========================================================================


async def _bootstrap_layer3(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 3: DEPENDS_ON structural edge domain:semantic -> concept:integer.

    This edge documents the dependency of SemanticDomain's scope_context_count
    arithmetic on AbstractDomain's integer ConceptPrimitive. It is only created
    when both endpoints exist (concept:integer is provided by the procedural
    ontology bootstrap which must run before this function).

    Returns:
        dict with keys: edges_created, edges_existing, edges_skipped.
    """
    counts: dict[str, int] = {
        "edges_created": 0,
        "edges_existing": 0,
        "edges_skipped": 0,
    }

    edge_id = EdgeId("dep:semantic:abstract:integer")

    # Check if the edge already exists by checking for it among edges from
    # the source node. We use get_edge directly since we know the edge_id.
    existing = await persistence.get_edge(edge_id)
    if existing is not None:
        counts["edges_existing"] += 1
        return counts

    # Guard: both endpoint nodes must exist before creating the edge.
    source_node = await persistence.get_node(NodeId("domain:semantic"))
    target_node = await persistence.get_node(NodeId("concept:integer"))

    if source_node is None or target_node is None:
        # Procedural bootstrap has not run yet or domain node was not created.
        # Log a warning and skip rather than failing hard -- the bootstrap
        # sequence is responsible for ordering, but we should not crash the
        # entire semantic bootstrap if only this structural edge is missing.
        missing = []
        if source_node is None:
            missing.append("domain:semantic")
        if target_node is None:
            missing.append("concept:integer")
        _log.warning(
            "semantic_bootstrap: skipping DEPENDS_ON edge because endpoint "
            "nodes are missing: %s",
            ", ".join(missing),
        )
        counts["edges_skipped"] += 1
        return counts

    edge = KnowledgeEdge(
        edge_id=edge_id,
        source_id=NodeId("domain:semantic"),
        target_id=NodeId("concept:integer"),
        edge_type="DEPENDS_ON",
        properties={
            "dependency_type": "scope_context_count_arithmetic",
            "description": (
                "SemanticDomain scope_context_count progression (situated=1, "
                "categorical>=3) requires integer comparison operations. "
                "Documents the structural dependency on AbstractDomain's "
                "integer ConceptPrimitive."
            ),
            "installed_by_skill": "semantic-ontology",
        },
        provenance=_taught(),
        confidence=1.0,
    )
    try:
        await persistence.save_edge(edge)
    except Exception as exc:
        raise BootstrapError(
            f"Failed to create DEPENDS_ON edge 'dep:semantic:abstract:integer': {exc}"
        ) from exc

    counts["edges_created"] += 1
    return counts


# ===========================================================================
# Post-bootstrap: add scope_context_count to existing WordSenseNodes
# ===========================================================================


async def _patch_word_sense_nodes(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Add scope_context_count=0 to any WordSenseNode that lacks the property.

    The scope_context_count property tracks how many distinct conversational
    contexts have referenced this word sense (E2 context tracking). It is
    initialised to 0 on new WordSenseNode nodes created by language_bootstrap.
    Existing nodes created before this property was defined need a
    read-modify-write pass to add it.

    This operation is idempotent: nodes that already have scope_context_count
    are not modified.

    Returns:
        dict with keys: nodes_patched, nodes_already_have_property.
    """
    counts: dict[str, int] = {
        "nodes_patched": 0,
        "nodes_already_have_property": 0,
    }

    word_sense_filter = NodeFilter(node_type=WORD_SENSE_NODE)
    word_sense_nodes = await persistence.query_nodes(word_sense_filter)

    for node in word_sense_nodes:
        if "scope_context_count" in node.properties:
            counts["nodes_already_have_property"] += 1
            continue

        # Read-modify-write: add the missing property.
        node.properties["scope_context_count"] = 0
        try:
            await persistence.save_node(node)
        except Exception as exc:
            # Non-fatal: log and continue. Failure to patch one WordSenseNode
            # should not abort the entire semantic bootstrap.
            _log.warning(
                "semantic_bootstrap: failed to patch scope_context_count on "
                "WordSenseNode '%s': %s",
                node.node_id,
                exc,
            )
            continue

        counts["nodes_patched"] += 1

    return counts


# ===========================================================================
# Result dataclass
# ===========================================================================


@dataclass(frozen=True)
class SemanticBootstrapResult:
    """Outcome of a ``bootstrap_semantic_ontology()`` call.

    Attributes:
        success: True when all layers completed without a fatal error.
        domain_created: DomainRegistration node created this call (0 or 1).
        domain_existing: DomainRegistration node already present (0 or 1).
        edge_types_created: SemanticEdgeType vocabulary nodes created.
        edge_types_existing: SemanticEdgeType vocabulary nodes already present.
        axioms_created: LogicalAxiom nodes created.
        axioms_existing: LogicalAxiom nodes already present.
        struct_edges_created: DEPENDS_ON structural edge created (0 or 1).
        struct_edges_existing: DEPENDS_ON structural edge already present (0 or 1).
        struct_edges_skipped: DEPENDS_ON edge skipped (endpoint nodes absent).
        word_sense_nodes_patched: WordSenseNode nodes that received
            scope_context_count=0 this call.
        word_sense_nodes_already_patched: WordSenseNode nodes that already
            carried the scope_context_count property.
        guardian_notified: True when the guardian notification was sent and
            confirmed before graph writes began. False when notification_sink
            was None (test/offline mode).
        total_nodes_created: Sum of domain + edge_types + axioms created.
    """

    success: bool
    domain_created: int
    domain_existing: int
    edge_types_created: int
    edge_types_existing: int
    axioms_created: int
    axioms_existing: int
    struct_edges_created: int
    struct_edges_existing: int
    struct_edges_skipped: int
    word_sense_nodes_patched: int
    word_sense_nodes_already_patched: int
    guardian_notified: bool

    @property
    def total_nodes_created(self) -> int:
        """Total number of new nodes written to the graph this call."""
        return self.domain_created + self.edge_types_created + self.axioms_created


# ===========================================================================
# Public entry point
# ===========================================================================


async def bootstrap_semantic_ontology(
    persistence: GraphPersistence,
    notification_sink: GuardianNotificationSink | None = None,
) -> SemanticBootstrapResult:
    """Bootstrap the complete semantic ontology (Layers 0-3 + WordSenseNode patch).

    Creates, in order:
      1. DomainRegistration META_SCHEMA node for SemanticDomain.
      2. 17 SemanticEdgeType SCHEMA vocabulary nodes.
      3. 4 LogicalAxiom META_SCHEMA nodes.
      4. DEPENDS_ON structural edge domain:semantic -> concept:integer.
      5. scope_context_count=0 patch on existing WordSenseNode nodes.

    CANON A.21.4 blocking guardian confirmation: if ``notification_sink`` is
    provided, the guardian is notified with the semantic domain readiness
    message and the function blocks until ``notify_and_wait`` returns. No
    graph writes occur before confirmation. If ``notification_sink`` is None,
    the notification step is skipped (suitable for tests and offline use).

    This function is idempotent. Nodes that already exist are counted in
    ``*_existing`` fields and not recreated.

    Args:
        persistence: The graph persistence backend to bootstrap.
        notification_sink: Optional guardian notification sink. When provided,
            the guardian is notified and must confirm before any graph writes
            begin. When None, the bootstrap proceeds without notification
            (test/offline mode).

    Returns:
        A :class:`SemanticBootstrapResult` with creation counts, existing
        counts, and a boolean indicating whether guardian notification was
        sent and confirmed.

    Raises:
        BootstrapError: If guardian notification fails, or if any node or
            edge cannot be saved.

    Example::

        result = await bootstrap_semantic_ontology(
            persistence=graph,
            notification_sink=guardian_queue_sink,
        )
        assert result.success
        assert result.edge_types_created == 17
        assert result.axioms_created == 4
        assert result.guardian_notified is True
    """
    _log.info("semantic_bootstrap: starting semantic ontology bootstrap")

    # ------------------------------------------------------------------
    # Step 1: Guardian notification (CANON A.21.4).
    # Block until the guardian confirms before any graph writes occur.
    # ------------------------------------------------------------------

    guardian_notified = False

    if notification_sink is not None:
        _log.info(
            "semantic_bootstrap: sending guardian notification and waiting "
            "for confirmation (A.21.4)"
        )
        try:
            await notification_sink.notify_and_wait(_GUARDIAN_MESSAGE)
            guardian_notified = True
            _log.info("semantic_bootstrap: guardian confirmation received")
        except asyncio.CancelledError:
            raise  # propagate cancellation -- do not swallow
        except Exception as exc:
            raise BootstrapError(
                f"Guardian notification failed during semantic ontology bootstrap: {exc}"
            ) from exc
    else:
        _log.debug(
            "semantic_bootstrap: notification_sink is None -- skipping "
            "guardian notification (offline/test mode)"
        )

    # ------------------------------------------------------------------
    # Step 2: Create graph nodes and edges in dependency order.
    # ------------------------------------------------------------------

    layer0 = await _bootstrap_layer0(persistence)
    layer1 = await _bootstrap_layer1(persistence)
    layer2 = await _bootstrap_layer2(persistence)
    layer3 = await _bootstrap_layer3(persistence)

    # ------------------------------------------------------------------
    # Step 3: Patch existing WordSenseNode nodes with scope_context_count.
    # ------------------------------------------------------------------

    patch_counts = await _patch_word_sense_nodes(persistence)

    # ------------------------------------------------------------------
    # Step 4: Ensure categorical knowledge threshold EvolutionRule node.
    # ------------------------------------------------------------------

    await ensure_categorical_threshold_rule(persistence)


    _log.info(
        "semantic_bootstrap: bootstrap complete -- "
        "edge_types_created=%d edge_types_existing=%d "
        "axioms_created=%d axioms_existing=%d "
        "word_sense_nodes_patched=%d",
        layer1["edge_types_created"],
        layer1["edge_types_existing"],
        layer2["axioms_created"],
        layer2["axioms_existing"],
        patch_counts["nodes_patched"],
    )

    return SemanticBootstrapResult(
        success=True,
        domain_created=layer0["domain_created"],
        domain_existing=layer0["domain_existing"],
        edge_types_created=layer1["edge_types_created"],
        edge_types_existing=layer1["edge_types_existing"],
        axioms_created=layer2["axioms_created"],
        axioms_existing=layer2["axioms_existing"],
        struct_edges_created=layer3["edges_created"],
        struct_edges_existing=layer3["edges_existing"],
        struct_edges_skipped=layer3["edges_skipped"],
        word_sense_nodes_patched=patch_counts["nodes_patched"],
        word_sense_nodes_already_patched=patch_counts["nodes_already_have_property"],
        guardian_notified=guardian_notified,
    )


__all__ = [
    "GuardianNotificationSink",
    "SemanticBootstrapResult",
    "bootstrap_semantic_ontology",
    "ensure_categorical_threshold_rule",
]

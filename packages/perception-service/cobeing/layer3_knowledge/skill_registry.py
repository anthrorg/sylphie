"""Skill package registry for Co-Being knowledge graph.

This module manages the SkillRegistry META_SCHEMA node that tracks all installed
skill packages in the Co-Being system. The SkillRegistry serves as the anchor
point for the skill package system, enabling:

1. Three-layer reset operations (anchor/skill/experience)
2. Package dependency tracking via SKILL_REQUIRES edges
3. Package metadata storage and versioning
4. Clean uninstall operations via installed_by_skill property

The SkillRegistry node is created at system startup in the same bootstrap phase
as other META_SCHEMA infrastructure nodes. It persists across all reset
operations and serves as the root of the skill package hierarchy.

Usage::

    from cobeing.layer3_knowledge.skill_registry import bootstrap_skill_registry

    persistence = InMemoryGraphPersistence()
    result = await bootstrap_skill_registry(persistence)
    # result.registry_created == True (or False if already existed)
"""

from __future__ import annotations

from dataclasses import dataclass

from cobeing.layer3_knowledge.exceptions import BootstrapError
from cobeing.layer3_knowledge.node_types import KnowledgeNode, NodeStatus, SchemaLevel
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import NodeId


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SKILL_REGISTRY_NODE_ID: NodeId = NodeId("registry:skills")
"""The well-known node_id for the SkillRegistry META_SCHEMA node."""


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SkillRegistryBootstrapResult:
    """Outcome of a bootstrap_skill_registry() call.

    Attributes:
        registry_created: Whether the SkillRegistry node was created during
            this call. False if it already existed (idempotency).
        registry_exists: Whether the SkillRegistry node exists after this
            call completes (should always be True for successful calls).
    """

    registry_created: bool
    registry_exists: bool


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _build_bootstrap_provenance() -> Provenance:
    """Return a bootstrap provenance instance for skill registry.

    Skill registry nodes use INFERENCE provenance with source_id "bootstrap"
    and confidence 1.0, following the same pattern as other META_SCHEMA
    infrastructure nodes.
    """
    return Provenance(
        source=ProvenanceSource.INFERENCE,
        source_id="bootstrap",
        confidence=1.0,
    )


def _build_skill_registry_node() -> KnowledgeNode:
    """Construct the SkillRegistry META_SCHEMA node.

    The SkillRegistry node serves as the anchor point for the skill package
    system. It tracks all installed packages and survives all reset operations
    as part of the system's anchor layer.

    Returns:
        A fully constructed KnowledgeNode at META_SCHEMA level with node_id
        "registry:skills" and node_type "SkillRegistry".
    """
    return KnowledgeNode(
        node_id=SKILL_REGISTRY_NODE_ID,
        node_type="SkillRegistry",
        schema_level=SchemaLevel.META_SCHEMA,
        properties={
            "registry_name": "Installed Skill Packages",
            "status": "ACTIVE",
            "description": (
                "Central registry for all installed skill packages in the "
                "Co-Being knowledge graph. Manages package metadata, "
                "dependencies, and installation state."
            ),
        },
        provenance=_build_bootstrap_provenance(),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def bootstrap_skill_registry(persistence: GraphPersistence) -> SkillRegistryBootstrapResult:
    """Bootstrap the skill package registry in the knowledge graph.

    Creates the SkillRegistry META_SCHEMA node that serves as the anchor point
    for the skill package system. This node tracks all installed packages and
    persists across all reset operations.

    This function is idempotent. If the SkillRegistry node already exists,
    it will not be recreated.

    Args:
        persistence: The graph persistence backend to bootstrap. Must
            implement the GraphPersistence Protocol.

    Returns:
        A SkillRegistryBootstrapResult indicating whether the node was
        created or already existed.

    Raises:
        BootstrapError: If the SkillRegistry node cannot be created or
            if post-bootstrap validation fails.
    """
    # Idempotency check: skip creation if the registry already exists.
    existing = await persistence.get_node(SKILL_REGISTRY_NODE_ID)
    if existing is not None:
        return SkillRegistryBootstrapResult(
            registry_created=False,
            registry_exists=True,
        )

    # Create the SkillRegistry node
    registry_node = _build_skill_registry_node()
    try:
        await persistence.save_node(registry_node)
    except Exception as exc:
        raise BootstrapError(
            f"Failed to save SkillRegistry node '{SKILL_REGISTRY_NODE_ID}': {exc}"
        ) from exc

    # Post-bootstrap validation
    if await persistence.get_node(SKILL_REGISTRY_NODE_ID) is None:
        raise BootstrapError(
            f"Post-bootstrap validation failed: SkillRegistry node "
            f"'{SKILL_REGISTRY_NODE_ID}' is missing from the graph."
        )

    return SkillRegistryBootstrapResult(
        registry_created=True,
        registry_exists=True,
    )


async def get_skill_registry(persistence: GraphPersistence) -> KnowledgeNode | None:
    """Retrieve the SkillRegistry node from the knowledge graph.

    Args:
        persistence: Graph persistence backend.

    Returns:
        The SkillRegistry KnowledgeNode, or None if it doesn't exist.
    """
    return await persistence.get_node(SKILL_REGISTRY_NODE_ID)


__all__ = [
    "SKILL_REGISTRY_NODE_ID",
    "SkillRegistryBootstrapResult",
    "bootstrap_skill_registry",
    "get_skill_registry",
]
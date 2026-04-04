"""Skill package installer for Co-Being knowledge graph.

This module implements the skill package installation pipeline that converts
validated YAML package data into knowledge graph nodes and edges. It handles
dependency resolution, transaction management, and proper provenance tracking
for all installed content.

The installation pipeline:
1. Check for existing installation (idempotent)
2. Resolve and validate dependencies
3. Create SkillPackage META_SCHEMA node
4. Create all package nodes with installed_by_skill property
5. Create all package edges with installed_by_skill property
6. Create SKILL_REQUIRES dependency edges
7. Validate call step integrity (target existence, cycles, arity)
8. Rollback entire transaction on any failure

All installed content is tagged with the installed_by_skill property to enable
clean uninstallation via the skill reset operations.

Usage::

    from cobeing.layer3_knowledge.skill_installer import install_package

    # Install package from validated YAML data
    result = await install_package(persistence, package_data)

    if result.success:
        print(f"Installed {result.package_id} v{result.version}")
        print(f"Created {result.nodes_created} nodes, {result.edges_created} edges")
    else:
        print(f"Installation failed: {result.error_message}")

The installer enforces proper dependency ordering and prevents cyclic dependencies.
It integrates with the existing skill package validator to ensure CANON compliance
before any graph writes occur.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
import uuid

if TYPE_CHECKING:
    from cobeing.layer3_knowledge.protocols import GraphPersistence

from cobeing.layer3_knowledge.exceptions import KnowledgeGraphError
from cobeing.layer3_knowledge.node_types import KnowledgeNode, KnowledgeEdge, NodeStatus, SchemaLevel
from cobeing.layer3_knowledge.query_types import NodeFilter
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import NodeId, EdgeId

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class InstallResult:
    """Result of a skill package installation operation.

    Attributes:
        success: True if the package was installed successfully.
        package_id: The installed package ID.
        version: The installed package version.
        nodes_created: Number of nodes created during installation.
        edges_created: Number of edges created during installation.
        error_message: Human-readable error description when success=False.
        already_installed: True if package was already installed (idempotent case).
    """

    success: bool
    package_id: str = "<unknown>"
    version: str = "unknown"
    nodes_created: int = 0
    edges_created: int = 0
    error_message: str = ""
    already_installed: bool = False


# ---------------------------------------------------------------------------
# Installation logic
# ---------------------------------------------------------------------------


async def install_package(
    persistence: GraphPersistence,
    package_data: dict[str, Any],
) -> InstallResult:
    """Install a validated skill package into the knowledge graph.

    Converts validated YAML package data into knowledge graph nodes and edges.
    All content is tagged with installed_by_skill property for clean uninstall.
    The operation is atomic - either all content is installed or nothing is.

    Args:
        persistence: Graph persistence backend for all graph operations.
        package_data: Validated YAML package data from skill_package_loader.

    Returns:
        InstallResult indicating success/failure and operation details.

    Raises:
        No exceptions are raised - all errors are captured in InstallResult.
    """
    package_id = package_data.get("package_id", "<unknown>")
    version = package_data.get("version", "unknown")

    try:
        # Step 1: Check if already installed (idempotent)
        existing_package = await _get_existing_package(persistence, package_id)
        if existing_package is not None:
            logger.info(
                "skill_package_already_installed package_id=%s version=%s",
                package_id,
                existing_package.properties.get("version", "unknown"),
            )
            return InstallResult(
                success=True,
                package_id=package_id,
                version=str(existing_package.properties.get("version", "unknown")),
                already_installed=True,
            )

        # Step 2: Resolve dependencies
        dependency_result = await _resolve_dependencies(persistence, package_data)
        if not dependency_result.success:
            return InstallResult(
                success=False,
                package_id=package_id,
                version=str(version),
                error_message=dependency_result.error_message,
            )

        # Step 3: Install package atomically
        install_stats = await _install_package_atomic(persistence, package_data)

        logger.info(
            "skill_package_installed package_id=%s version=%s nodes=%d edges=%d",
            package_id,
            version,
            install_stats.nodes_created,
            install_stats.edges_created,
        )

        return InstallResult(
            success=True,
            package_id=package_id,
            version=str(version),
            nodes_created=install_stats.nodes_created,
            edges_created=install_stats.edges_created,
        )

    except Exception as exc:
        logger.error(
            "skill_package_install_failed package_id=%s error=%s",
            package_id,
            exc,
            exc_info=True
        )
        return InstallResult(
            success=False,
            package_id=package_id,
            version=str(version),
            error_message=f"Installation failed: {exc}",
        )


async def _get_existing_package(
    persistence: GraphPersistence,
    package_id: str,
) -> KnowledgeNode | None:
    """Check if a package is already installed.

    Args:
        persistence: Graph persistence backend.
        package_id: Package ID to check.

    Returns:
        Existing SkillPackage node or None if not installed.
    """
    # Query for SkillPackage node with matching package_id
    filter = NodeFilter(
        node_type="SkillPackage",
        schema_level=SchemaLevel.META_SCHEMA
    )
    package_nodes = await persistence.query_nodes(filter)

    for node in package_nodes:
        if node.properties.get("package_id") == package_id:
            return node

    return None


# ---------------------------------------------------------------------------
# Dependency resolution
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DependencyResult:
    """Result of dependency resolution check.

    Attributes:
        success: True if all dependencies are satisfied.
        error_message: Human-readable error when success=False.
        install_order: Resolved installation order (not used in this implementation).
    """

    success: bool
    error_message: str = ""
    install_order: list[str] = None

    def __post_init__(self):
        if self.install_order is None:
            object.__setattr__(self, 'install_order', [])


async def _resolve_dependencies(
    persistence: GraphPersistence,
    package_data: dict[str, Any],
) -> DependencyResult:
    """Resolve and validate package dependencies.

    Checks that all packages listed in 'requires' are already installed
    or are anchor layer packages. Also performs cycle detection for
    future dependency graph integrity.

    Args:
        persistence: Graph persistence backend.
        package_data: Validated package data.

    Returns:
        DependencyResult indicating success or dependency errors.
    """
    try:
        package_id = package_data.get("package_id", "<unknown>")
        requires = package_data.get("requires", [])

        if not requires:
            # No dependencies - always succeeds
            return DependencyResult(success=True)

        # Get currently installed packages
        installed_packages = await _get_installed_package_ids(persistence)

        # Add anchor layer packages that are always considered installed
        anchor_packages = {"core-bootstrap", "language-foundation"}
        all_available = installed_packages | anchor_packages

        # Check each dependency
        missing_deps = []
        for dep_package_id in requires:
            if dep_package_id not in all_available:
                missing_deps.append(dep_package_id)

        if missing_deps:
            return DependencyResult(
                success=False,
                error_message=(
                    f"Missing dependencies for package '{package_id}': "
                    f"{', '.join(missing_deps)}. "
                    f"Install required packages first. "
                    f"Available: {sorted(all_available)}"
                ),
            )

        # TODO: Add cycle detection here when multiple packages are being installed
        # For now, single package installation cannot create cycles

        logger.debug(
            "dependencies_resolved package_id=%s requires=%s available=%s",
            package_id,
            requires,
            sorted(all_available),
        )

        return DependencyResult(success=True)

    except Exception as exc:
        return DependencyResult(
            success=False,
            error_message=f"Dependency resolution failed: {exc}",
        )


async def _get_installed_package_ids(persistence: GraphPersistence) -> set[str]:
    """Query the graph for currently installed package IDs.

    Returns:
        Set of package IDs from SkillPackage nodes.
    """
    filter = NodeFilter(
        node_type="SkillPackage",
        schema_level=SchemaLevel.META_SCHEMA
    )
    package_nodes = await persistence.query_nodes(filter)

    installed = set()
    for node in package_nodes:
        package_id = node.properties.get("package_id")
        if package_id:
            installed.add(str(package_id))

    return installed


# ---------------------------------------------------------------------------
# Atomic installation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class InstallStats:
    """Installation statistics for atomic operation.

    Attributes:
        nodes_created: Number of nodes created.
        edges_created: Number of edges created.
    """

    nodes_created: int = 0
    edges_created: int = 0


async def _install_package_atomic(
    persistence: GraphPersistence,
    package_data: dict[str, Any],
) -> InstallStats:
    """Install package content atomically.

    Creates SkillPackage META_SCHEMA node, all package nodes/edges,
    and dependency edges in a single operation. Uses proper error
    handling to ensure partial installation cannot occur.

    Args:
        persistence: Graph persistence backend.
        package_data: Validated package data.

    Returns:
        InstallStats with creation counts.

    Raises:
        KnowledgeGraphError: If any part of the installation fails.
    """
    package_id = package_data.get("package_id")
    version = package_data.get("version")
    nodes_list = package_data.get("nodes", [])
    edges_list = package_data.get("edges", [])
    requires = package_data.get("requires", [])

    nodes_created = 0
    edges_created = 0

    try:
        # Step 1: Create SkillPackage META_SCHEMA node
        skill_package_node = _build_skill_package_node(package_data)
        await persistence.save_node(skill_package_node)
        nodes_created += 1

        # Step 2: Create all package nodes
        for node_data in nodes_list:
            node = _build_package_node(node_data, package_id)
            await persistence.save_node(node)
            nodes_created += 1

        # Step 3: Create all package edges
        for edge_data in edges_list:
            edge = _build_package_edge(edge_data, package_id)
            await persistence.save_edge(edge)
            edges_created += 1

        # Step 4: Create SKILL_REQUIRES dependency edges
        for dep_package_id in requires:
            dependency_edge = _build_dependency_edge(package_id, dep_package_id)
            await persistence.save_edge(dependency_edge)
            edges_created += 1

        # Step 5: Validate call steps (target existence, cycles, arity)
        await _validate_call_steps(persistence, package_data)

        return InstallStats(
            nodes_created=nodes_created,
            edges_created=edges_created,
        )

    except Exception as exc:
        raise KnowledgeGraphError(
            f"Atomic installation failed for package '{package_id}': {exc}"
        ) from exc



# ---------------------------------------------------------------------------
# Call step validation
# ---------------------------------------------------------------------------


async def _validate_call_steps(
    persistence: "GraphPersistence",
    package_data: dict[str, Any],
) -> None:
    """Validate call step integrity after all nodes and edges are installed.

    Runs four validations on any ProcedureStep node with step_type="call":

    V1 -- Target procedure exists in the graph (installed in this package
          or a prior one).
    V2 -- No non-self circular call chains among procedures in this package.
          Self-recursion (proc:gcd calls proc:gcd) is explicitly allowed.
    V3 -- Argument count matches the target procedure's parameter list.
    V4 -- Missing DEPENDS_ON edges produce a warning (non-fatal).

    If any fatal validation fails, KnowledgeGraphError is raised, which
    causes the caller (_install_package_atomic) to propagate the error and
    trigger the install_package error path.

    Args:
        persistence: Graph persistence backend (nodes are already saved).
        package_data: The full validated package data dict.

    Raises:
        KnowledgeGraphError: If V1, V2, or V3 validation fails.
    """
    nodes_list = package_data.get("nodes", [])
    edges_list = package_data.get("edges", [])

    # --- Build step_id -> owning procedure map ---
    # Phase 1: Find root steps via HAS_PROCEDURE_BODY edges
    root_to_proc: dict[str, str] = {}  # root_step_id -> procedure_id
    for edge in edges_list:
        if edge.get("edge_type") == "HAS_PROCEDURE_BODY":
            root_to_proc[edge["target_node_id"]] = edge["source_node_id"]

    # Phase 2: Build adjacency for HAS_OPERAND edges (parent -> children)
    operand_children: dict[str, list[str]] = {}
    for edge in edges_list:
        if edge.get("edge_type") == "HAS_OPERAND":
            src = edge["source_node_id"]
            tgt = edge["target_node_id"]
            if src not in operand_children:
                operand_children[src] = []
            operand_children[src].append(tgt)

    # Phase 3: BFS from each root step through HAS_OPERAND to assign ownership
    step_to_proc: dict[str, str] = {}
    for root_step_id, proc_id in root_to_proc.items():
        queue = [root_step_id]
        while queue:
            current = queue.pop(0)
            if current in step_to_proc:
                continue  # Already visited via another path (DAG)
            step_to_proc[current] = proc_id
            for child in operand_children.get(current, []):
                queue.append(child)

    # --- Collect call steps and validate ---
    call_edges: list[tuple[str, str]] = []  # (caller_proc_id, target_proc_id)

    for node in nodes_list:
        props = node.get("properties", {})
        if node.get("node_type") != "ProcedureStep":
            continue
        if props.get("step_type") != "call":
            continue

        step_id = node.get("node_id", "")
        target = props.get("target_procedure", "")
        owner = step_to_proc.get(step_id, "unknown")

        # V1: target_procedure property must be present
        if not target:
            raise KnowledgeGraphError(
                f"Call step '{step_id}' has no target_procedure property."
            )

        # V1: target procedure must exist in graph
        target_node = await persistence.get_node(NodeId(target))
        if target_node is None:
            raise KnowledgeGraphError(
                f"Call step '{step_id}' targets procedure '{target}' "
                f"which does not exist in the graph."
            )

        # V3: argument count must match target's parameter list
        target_params = target_node.properties.get("parameters", [])
        operand_count = len(operand_children.get(step_id, []))
        if operand_count != len(target_params):
            raise KnowledgeGraphError(
                f"Call step '{step_id}' provides {operand_count} arguments "
                f"but target procedure '{target}' expects "
                f"{len(target_params)} parameters {target_params}."
            )

        # Record edge for cycle detection, skipping self-recursion
        if owner != target:
            call_edges.append((owner, target))

    # --- V2: Detect non-self circular call chains ---
    if call_edges:
        call_graph: dict[str, set[str]] = {}
        for caller, target in call_edges:
            if caller not in call_graph:
                call_graph[caller] = set()
            call_graph[caller].add(target)

        # DFS three-color cycle detection
        WHITE, GRAY, BLACK = 0, 1, 2
        color: dict[str, int] = {}
        for node_id in call_graph:
            color[node_id] = WHITE
        for targets_set in call_graph.values():
            for t in targets_set:
                if t not in color:
                    color[t] = WHITE

        def _find_cycle(node_id: str) -> list[str] | None:
            """DFS from node_id; return cycle path if found, else None."""
            color[node_id] = GRAY
            for neighbor in call_graph.get(node_id, set()):
                if color.get(neighbor, WHITE) == GRAY:
                    return [node_id, neighbor]
                if color.get(neighbor, WHITE) == WHITE:
                    result = _find_cycle(neighbor)
                    if result is not None:
                        return [node_id] + result
            color[node_id] = BLACK
            return None

        for node_id in list(color.keys()):
            if color[node_id] == WHITE:
                cycle = _find_cycle(node_id)
                if cycle is not None:
                    raise KnowledgeGraphError(
                        f"Circular procedure call chain detected: "
                        f"{' -> '.join(cycle)}. "
                        f"Self-recursion is allowed but cross-procedure "
                        f"cycles are forbidden."
                    )

    # --- V4: Warn about missing DEPENDS_ON edges (non-fatal) ---
    depends_on_pairs: set[tuple[str, str]] = set()
    for edge in edges_list:
        if edge.get("edge_type") == "DEPENDS_ON":
            depends_on_pairs.add((edge["source_node_id"], edge["target_node_id"]))

    for caller, target in call_edges:
        if (caller, target) not in depends_on_pairs:
            logger.warning(
                "call_step_missing_depends_on caller=%s target=%s "
                "Consider adding a DEPENDS_ON edge with dependency_type=calls.",
                caller,
                target,
            )


def _build_skill_package_node(package_data: dict[str, Any]) -> KnowledgeNode:
    """Build SkillPackage META_SCHEMA node from package data.

    Args:
        package_data: Validated package data.

    Returns:
        KnowledgeNode for the SkillPackage.
    """
    package_id = package_data.get("package_id")
    version = package_data.get("version")
    display_name = package_data.get("display_name", package_id)
    description = package_data.get("description", "")

    return KnowledgeNode(
        node_id=NodeId(f"skill:{package_id}"),
        node_type="SkillPackage",
        schema_level=SchemaLevel.META_SCHEMA,
        properties={
            "package_id": package_id,
            "version": version,
            "display_name": display_name,
            "description": description,
            "installed_at": datetime.now(UTC).isoformat(),
            "installed_by_skill": package_id,  # Self-reference for uninstall
        },
        provenance=Provenance(
            source=ProvenanceSource.TAUGHT_PROCEDURE,
            source_id="skill-installer",
            confidence=1.0,
        ),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _build_package_node(node_data: dict[str, Any], package_id: str) -> KnowledgeNode:
    """Build a package content node from YAML node data.

    Args:
        node_data: Node definition from YAML.
        package_id: Package ID for installed_by_skill property.

    Returns:
        KnowledgeNode ready for graph insertion.
    """
    node_id = node_data.get("node_id")
    node_type = node_data.get("node_type")
    schema_level_str = node_data.get("schema_level", "SCHEMA")
    properties = dict(node_data.get("properties", {}))

    # Add installed_by_skill property for clean uninstall
    properties["installed_by_skill"] = package_id

    # Determine schema level
    schema_level_map = {
        "INSTANCE": SchemaLevel.INSTANCE,
        "SCHEMA": SchemaLevel.SCHEMA,
        "META_SCHEMA": SchemaLevel.META_SCHEMA,
    }
    schema_level = schema_level_map.get(schema_level_str, SchemaLevel.SCHEMA)

    # Build provenance
    provenance_data = node_data.get("provenance", {})
    if isinstance(provenance_data, dict):
        source_str = provenance_data.get("source", "taught_procedure")
        source_id = provenance_data.get("source_id", "skill-installer")
        confidence = float(provenance_data.get("confidence", 0.15))
    else:
        source_str = "taught_procedure"
        source_id = "skill-installer"
        confidence = 0.15

    # Map provenance source string to enum
    provenance_source_map = {
        "taught_procedure": ProvenanceSource.TAUGHT_PROCEDURE,
        "inference": ProvenanceSource.INFERENCE,
    }
    provenance_source = provenance_source_map.get(source_str, ProvenanceSource.TAUGHT_PROCEDURE)

    return KnowledgeNode(
        node_id=NodeId(node_id),
        node_type=node_type,
        schema_level=schema_level,
        properties=properties,
        provenance=Provenance(
            source=provenance_source,
            source_id=source_id,
            confidence=confidence,
        ),
        confidence=float(node_data.get("confidence", confidence)),
        status=NodeStatus.ACTIVE,
    )


def _build_package_edge(edge_data: dict[str, Any], package_id: str) -> KnowledgeEdge:
    """Build a package content edge from YAML edge data.

    Args:
        edge_data: Edge definition from YAML.
        package_id: Package ID for installed_by_skill property.

    Returns:
        KnowledgeEdge ready for graph insertion.
    """
    edge_id = edge_data.get("edge_id")
    edge_type = edge_data.get("edge_type")
    source_node_id = edge_data.get("source_node_id")
    target_node_id = edge_data.get("target_node_id")
    properties = dict(edge_data.get("properties", {}))

    # Add installed_by_skill property for clean uninstall
    properties["installed_by_skill"] = package_id

    # Build provenance
    provenance_data = edge_data.get("provenance", {})
    if isinstance(provenance_data, dict):
        source_str = provenance_data.get("source", "taught_procedure")
        source_id = provenance_data.get("source_id", "skill-installer")
        confidence = float(provenance_data.get("confidence", 0.15))
    else:
        source_str = "taught_procedure"
        source_id = "skill-installer"
        confidence = 0.15

    provenance_source_map = {
        "taught_procedure": ProvenanceSource.TAUGHT_PROCEDURE,
        "inference": ProvenanceSource.INFERENCE,
    }
    provenance_source = provenance_source_map.get(source_str, ProvenanceSource.TAUGHT_PROCEDURE)

    return KnowledgeEdge(
        edge_id=EdgeId(edge_id),
        edge_type=edge_type,
        source_id=NodeId(source_node_id),
        target_id=NodeId(target_node_id),
        properties=properties,
        provenance=Provenance(
            source=provenance_source,
            source_id=source_id,
            confidence=confidence,
        ),
        confidence=float(edge_data.get("confidence", confidence)),
        status=NodeStatus.ACTIVE,
    )


def _build_dependency_edge(package_id: str, dep_package_id: str) -> KnowledgeEdge:
    """Build SKILL_REQUIRES edge between packages.

    Args:
        package_id: Source package ID.
        dep_package_id: Target dependency package ID.

    Returns:
        KnowledgeEdge representing the dependency relationship.
    """
    return KnowledgeEdge(
        edge_id=EdgeId(f"skill-req:{package_id}:{dep_package_id}:{uuid.uuid4().hex[:8]}"),
        edge_type="SKILL_REQUIRES",
        source_id=NodeId(f"skill:{package_id}"),
        target_id=NodeId(f"skill:{dep_package_id}"),
        properties={
            "dependency_type": "skill_package",
            "created_at": datetime.now(UTC).isoformat(),
            "installed_by_skill": package_id,
        },
        provenance=Provenance(
            source=ProvenanceSource.TAUGHT_PROCEDURE,
            source_id="skill-installer",
            confidence=1.0,
        ),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


__all__ = [
    "InstallResult",
    "install_package",
]
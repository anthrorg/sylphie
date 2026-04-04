"""YAML skill package loader and parser for Co-Being knowledge graph.

This module implements the YAML package loading pipeline that converts skill
package YAML files into validated Python dictionaries ready for graph installation.
It combines YAML parsing, schema validation, and error reporting into a cohesive
loading workflow.

The loading pipeline:
1. Load YAML file from filesystem or string content
2. Parse and validate YAML structure
3. Run CANON compliance validation using SkillPackageValidator
4. Return LoadResult with parsed data or comprehensive error information

The loader supports both file paths and direct YAML content strings, enabling
usage from CLI tools, web APIs, and testing scenarios.

Usage::

    from cobeing.layer3_knowledge.skill_package_loader import load_skill_package

    # Load from file
    result = await load_skill_package(
        package_source="skill-packages/arithmetic.yaml",
        persistence=graph_persistence,
        installed_packages={"core-bootstrap"}
    )

    if result.success:
        # result.package_data contains validated dict ready for installation
        await install_package(result.package_data)
    else:
        print(f"Load failed: {result.error_message}")

    # Load from YAML string
    yaml_content = '''
    package_id: test-package
    version: 1.0.0
    canon_provenance: TAUGHT_PROCEDURE
    nodes: []
    edges: []
    '''
    result = await load_skill_package(
        package_source=yaml_content,
        persistence=graph_persistence,
        is_content=True
    )

The loader integrates with the existing SkillPackageValidator to ensure all
CANON A.21.3 compliance checks are enforced before any graph operations.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from cobeing.layer3_knowledge.protocols import GraphPersistence

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LoadResult:
    """Result of a skill package loading operation.

    Attributes:
        success: True if the package was loaded and validated successfully.
        package_data: The parsed and validated YAML content as a Python dict.
            Only populated when success=True.
        package_id: The package_id from the YAML, or "<unknown>" if missing.
        version: The version from the YAML, or "unknown" if missing.
        error_message: Human-readable error description when success=False.
        validation_errors: List of CANON validation errors from SkillPackageValidator.
            Empty when success=True.
    """

    success: bool
    package_data: dict[str, Any] | None = None
    package_id: str = "<unknown>"
    version: str = "unknown"
    error_message: str = ""
    validation_errors: list[str] = None

    def __post_init__(self):
        if self.validation_errors is None:
            object.__setattr__(self, 'validation_errors', [])


# ---------------------------------------------------------------------------
# Schema definition
# ---------------------------------------------------------------------------


def _validate_yaml_structure(data: dict[str, Any]) -> list[str]:
    """Validate basic YAML structure before CANON validation.

    Performs structural checks that must pass before the SkillPackageValidator
    can run its CANON compliance checks. These are basic schema requirements
    like required top-level fields and correct data types.

    Args:
        data: Parsed YAML content as a Python dict.

    Returns:
        List of error strings. Empty list indicates valid structure.
    """
    errors: list[str] = []

    # Required top-level fields
    required_fields = ["package_id", "version", "canon_provenance"]
    for field in required_fields:
        if field not in data:
            errors.append(f"Missing required field: '{field}'")
        elif not isinstance(data[field], str):
            errors.append(f"Field '{field}' must be a string, got {type(data[field]).__name__}")

    # Optional but structured fields
    if "nodes" in data and not isinstance(data["nodes"], list):
        errors.append("Field 'nodes' must be a list of node definitions")

    if "edges" in data and not isinstance(data["edges"], list):
        errors.append("Field 'edges' must be a list of edge definitions")

    if "requires" in data and not isinstance(data["requires"], list):
        errors.append("Field 'requires' must be a list of package ID strings")

    if "cross_domain_bridges" in data and not isinstance(data["cross_domain_bridges"], list):
        errors.append("Field 'cross_domain_bridges' must be a list of bridge definitions")

    # Validate nodes structure if present
    if "nodes" in data and isinstance(data["nodes"], list):
        for i, node in enumerate(data["nodes"]):
            if not isinstance(node, dict):
                errors.append(f"nodes[{i}] must be a dictionary")
            else:
                if "node_id" not in node:
                    errors.append(f"nodes[{i}] missing required field 'node_id'")
                if "node_type" not in node:
                    errors.append(f"nodes[{i}] missing required field 'node_type'")

    # Validate edges structure if present
    if "edges" in data and isinstance(data["edges"], list):
        for i, edge in enumerate(data["edges"]):
            if not isinstance(edge, dict):
                errors.append(f"edges[{i}] must be a dictionary")
            else:
                required_edge_fields = ["edge_id", "edge_type", "source_node_id", "target_node_id"]
                for field in required_edge_fields:
                    if field not in edge:
                        errors.append(f"edges[{i}] missing required field '{field}'")

    return errors


# ---------------------------------------------------------------------------
# Main loader function
# ---------------------------------------------------------------------------


async def load_skill_package(
    package_source: str,
    persistence: GraphPersistence,
    *,
    installed_packages: set[str] | None = None,
    is_content: bool = False,
) -> LoadResult:
    """Load and validate a skill package from YAML file or content string.

    Performs the complete loading pipeline: YAML parsing, structural validation,
    and CANON compliance checking using SkillPackageValidator.

    Args:
        package_source: Path to YAML file or YAML content string.
        persistence: Graph persistence backend for dependency checking.
        installed_packages: Set of currently installed package IDs.
            If None, will be queried from the SkillRegistry in the graph.
        is_content: If True, package_source is treated as YAML content.
            If False (default), package_source is treated as a file path.

    Returns:
        LoadResult with success flag, package data, and error information.

    Raises:
        No exceptions are raised - all errors are captured in the LoadResult.
    """
    try:
        # Step 1: Load YAML content
        if is_content:
            yaml_content = package_source
            source_description = "YAML content"
        else:
            package_path = Path(package_source)
            if not package_path.exists():
                return LoadResult(
                    success=False,
                    error_message=f"Package file does not exist: {package_path}",
                )

            if package_path.suffix.lower() not in {'.yaml', '.yml'}:
                return LoadResult(
                    success=False,
                    error_message=f"Package file must have .yaml or .yml extension: {package_path}",
                )

            try:
                with open(package_path, 'r', encoding='utf-8') as f:
                    yaml_content = f.read()
                source_description = str(package_path)
            except Exception as exc:
                return LoadResult(
                    success=False,
                    error_message=f"Failed to read package file '{package_path}': {exc}",
                )

        # Step 2: Parse YAML
        try:
            import yaml
            package_data = yaml.safe_load(yaml_content)
        except yaml.YAMLError as exc:
            return LoadResult(
                success=False,
                error_message=f"Invalid YAML format in {source_description}: {exc}",
            )
        except Exception as exc:
            return LoadResult(
                success=False,
                error_message=f"Failed to parse YAML from {source_description}: {exc}",
            )

        if not isinstance(package_data, dict):
            return LoadResult(
                success=False,
                error_message=f"YAML root must be a dictionary, got {type(package_data).__name__}",
            )

        # Extract package metadata for result
        package_id = package_data.get("package_id", "<unknown>")
        version = package_data.get("version", "unknown")

        # Step 3: Basic structural validation
        structure_errors = _validate_yaml_structure(package_data)
        if structure_errors:
            return LoadResult(
                success=False,
                package_id=package_id,
                version=str(version),
                error_message=f"Invalid YAML structure: {'; '.join(structure_errors)}",
                validation_errors=structure_errors,
            )

        # Step 4: Query installed packages if not provided
        if installed_packages is None:
            try:
                installed_packages = await _get_installed_packages(persistence)
            except Exception as exc:
                logger.warning("Failed to query installed packages: %s", exc)
                installed_packages = set()

        # Step 5: CANON compliance validation
        try:
            from cobeing.layer3_knowledge.skill_package_validator import SkillPackageValidator

            validator = SkillPackageValidator()
            validation_result = validator.validate(
                package_data,
                installed_packages=installed_packages
            )

            if not validation_result.is_valid:
                return LoadResult(
                    success=False,
                    package_id=package_id,
                    version=str(version),
                    error_message=f"CANON validation failed: {validation_result.errors[0]}",
                    validation_errors=validation_result.errors,
                )

        except Exception as exc:
            return LoadResult(
                success=False,
                package_id=package_id,
                version=str(version),
                error_message=f"Validation system error: {exc}",
            )

        # Step 6: Success
        logger.info(
            "skill_package_loaded package_id=%s version=%s source=%s",
            package_id,
            version,
            source_description,
        )

        return LoadResult(
            success=True,
            package_data=package_data,
            package_id=package_id,
            version=str(version),
        )

    except Exception as exc:
        # Catch-all for unexpected errors
        logger.error("skill_package_load_failed source=%s error=%s", package_source, exc, exc_info=True)
        return LoadResult(
            success=False,
            error_message=f"Unexpected error during package loading: {exc}",
        )


async def _get_installed_packages(persistence: GraphPersistence) -> set[str]:
    """Query the graph for currently installed package IDs.

    Looks for SkillPackage META_SCHEMA nodes and extracts their package_id
    properties to build the set of installed packages.

    Args:
        persistence: Graph persistence backend.

    Returns:
        Set of installed package IDs from the SkillRegistry.

    Raises:
        Exception: If the query fails or graph is unreachable.
    """
    try:
        from cobeing.layer3_knowledge.node_types import SchemaLevel
        from cobeing.layer3_knowledge.query_types import NodeFilter

        # Query for all SkillPackage nodes
        filter = NodeFilter(
            node_type="SkillPackage",
            schema_level=SchemaLevel.META_SCHEMA
        )
        package_nodes = await persistence.query_nodes(filter)

        # Extract package IDs from node properties
        installed = set()
        for node in package_nodes:
            package_id = node.properties.get("package_id")
            if package_id:
                installed.add(str(package_id))

        logger.debug("queried_installed_packages count=%d packages=%s", len(installed), sorted(installed))
        return installed

    except Exception as exc:
        logger.error("failed_to_query_installed_packages error=%s", exc, exc_info=True)
        raise


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def validate_yaml_string(yaml_content: str) -> LoadResult:
    """Validate YAML content without graph persistence (for testing).

    Performs YAML parsing and structural validation but skips CANON compliance
    checks that require graph access. Useful for syntax checking and basic
    validation in testing scenarios.

    Args:
        yaml_content: YAML content as a string.

    Returns:
        LoadResult with success flag and validation results. CANON validation
        is skipped, so package_data should not be used for installation.
    """
    try:
        import yaml
        package_data = yaml.safe_load(yaml_content)
    except yaml.YAMLError as exc:
        return LoadResult(
            success=False,
            error_message=f"Invalid YAML format: {exc}",
        )

    if not isinstance(package_data, dict):
        return LoadResult(
            success=False,
            error_message=f"YAML root must be a dictionary, got {type(package_data).__name__}",
        )

    # Basic structural validation only
    structure_errors = _validate_yaml_structure(package_data)
    if structure_errors:
        return LoadResult(
            success=False,
            package_id=package_data.get("package_id", "<unknown>"),
            version=str(package_data.get("version", "unknown")),
            error_message=f"Invalid YAML structure: {'; '.join(structure_errors)}",
            validation_errors=structure_errors,
        )

    return LoadResult(
        success=True,
        package_data=package_data,
        package_id=package_data.get("package_id", "<unknown>"),
        version=str(package_data.get("version", "unknown")),
    )


__all__ = [
    "LoadResult",
    "load_skill_package",
    "validate_yaml_string",
]
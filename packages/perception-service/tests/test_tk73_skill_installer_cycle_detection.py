"""TK-73 acceptance tests: three-colour DFS cycle detection in skill_installer.

Verifies both acceptance criteria with no live graph or network dependency:

AC-1  Given A->B and B->A, when resolving A, then
      ValueError 'Circular dependency detected: A -> B -> A' is raised.

AC-2  Given A->B->C (no cycle) / a single package, when resolved, then
      success with no false positive.

The tests exercise both the pure helper (_check_dependency_cycle) and the
async integration path through _resolve_dependencies + InMemoryGraphPersistence.

Run with::

    cd packages/perception-service
    python -m pytest tests/test_tk73_skill_installer_cycle_detection.py -v
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from cobeing.layer3_knowledge.in_memory_persistence import InMemoryGraphPersistence
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.skill_installer import (
    _check_dependency_cycle,
    _resolve_dependencies,
    install_package,
)
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_PROV = Provenance(
    source=ProvenanceSource.TAUGHT_PROCEDURE,
    source_id="test",
    confidence=1.0,
)


def _run(coro: Any) -> Any:
    """Run a coroutine synchronously inside a fresh event loop."""
    return asyncio.run(coro)


def _skill_node(package_id: str) -> KnowledgeNode:
    """Build a minimal SkillPackage META_SCHEMA node."""
    return KnowledgeNode(
        node_id=NodeId(f"skill:{package_id}"),
        node_type="SkillPackage",
        schema_level=SchemaLevel.META_SCHEMA,
        properties={"package_id": package_id, "version": "1.0"},
        provenance=_PROV,
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _skill_requires_edge(src_id: str, tgt_id: str) -> KnowledgeEdge:
    """Build a SKILL_REQUIRES edge between two package node IDs."""
    return KnowledgeEdge(
        edge_id=EdgeId(f"edge:req:{src_id}:{tgt_id}"),
        edge_type="SKILL_REQUIRES",
        source_id=NodeId(f"skill:{src_id}"),
        target_id=NodeId(f"skill:{tgt_id}"),
        properties={},
        provenance=_PROV,
        confidence=1.0,
    )


def _package_data(
    package_id: str,
    requires: list[str] | None = None,
) -> dict[str, Any]:
    """Build minimal package_data suitable for install_package / _resolve_dependencies."""
    return {
        "package_id": package_id,
        "version": "1.0",
        "display_name": package_id,
        "description": "",
        "nodes": [],
        "edges": [],
        "requires": requires or [],
    }


async def _seed_package(graph: InMemoryGraphPersistence, package_id: str, requires: list[str]) -> None:
    """Seed an already-installed package and its SKILL_REQUIRES edges into the graph."""
    await graph.save_node(_skill_node(package_id))
    for dep in requires:
        await graph.save_edge(_skill_requires_edge(package_id, dep))


# ---------------------------------------------------------------------------
# Unit tests — pure cycle-detection helper
# ---------------------------------------------------------------------------


class TestCheckDependencyCyclePure:
    """Direct tests of _check_dependency_cycle (pure, synchronous)."""

    # AC-1: mutual dependency is a cycle
    def test_mutual_dependency_raises_value_error(self) -> None:
        """A->B, B->A: must raise ValueError with the full cycle path."""
        graph = {"A": ["B"], "B": ["A"]}
        with pytest.raises(ValueError) as exc_info:
            _check_dependency_cycle(graph, "A")
        msg = str(exc_info.value)
        assert "Circular dependency detected" in msg
        assert "A" in msg
        assert "B" in msg

    def test_mutual_dependency_message_format(self) -> None:
        """Exact message format: 'Circular dependency detected: A -> B -> A'."""
        graph = {"A": ["B"], "B": ["A"]}
        with pytest.raises(ValueError, match=r"Circular dependency detected: A -> B -> A"):
            _check_dependency_cycle(graph, "A")

    # AC-2: linear chain A->B->C has no cycle
    def test_linear_chain_no_false_positive(self) -> None:
        """A->B->C: no cycle, must return without raising."""
        graph = {"A": ["B"], "B": ["C"]}
        _check_dependency_cycle(graph, "A")  # must not raise

    # AC-2: single package with no dependencies
    def test_single_package_no_deps(self) -> None:
        """A with no outgoing edges: no cycle, must return without raising."""
        graph: dict[str, list[str]] = {"A": []}
        _check_dependency_cycle(graph, "A")  # must not raise

    # AC-2: package not yet in graph (no edges at all)
    def test_fresh_package_not_in_graph(self) -> None:
        """A not yet present as a key: no cycle, must return without raising."""
        graph: dict[str, list[str]] = {}
        _check_dependency_cycle(graph, "A")  # must not raise

    # Extra: longer cycle A->B->C->A
    def test_three_node_cycle_detected(self) -> None:
        """A->B->C->A: cycle must be detected regardless of length."""
        graph = {"A": ["B"], "B": ["C"], "C": ["A"]}
        with pytest.raises(ValueError, match="Circular dependency detected"):
            _check_dependency_cycle(graph, "A")

    # Extra: self-loop (unlikely in package deps, but should still be caught)
    def test_self_loop_is_detected(self) -> None:
        """A->A is a degenerate cycle and must be caught."""
        graph = {"A": ["A"]}
        with pytest.raises(ValueError, match="Circular dependency detected"):
            _check_dependency_cycle(graph, "A")


# ---------------------------------------------------------------------------
# Integration tests — async path through _resolve_dependencies
# ---------------------------------------------------------------------------


class TestResolveDependenciesIntegration:
    """Integration tests using InMemoryGraphPersistence.

    These tests verify the async resolution path that builds the graph from
    SKILL_REQUIRES edges and calls _check_dependency_cycle internally.
    """

    # AC-1: mutual dependency raises ValueError through async path
    def test_mutual_dep_raises_value_error_async(self) -> None:
        """A->B and B->A already in graph: resolving A raises ValueError."""

        async def _test() -> None:
            graph = InMemoryGraphPersistence()
            # Seed package B as already installed, with B->A edge.
            await _seed_package(graph, "B", requires=["A"])
            # Now attempt to resolve A, which requires B.
            package_a = _package_data("A", requires=["B"])
            with pytest.raises(ValueError, match="Circular dependency detected"):
                await _resolve_dependencies(graph, package_a)

        _run(_test())

    # AC-1: error message includes both package IDs
    def test_mutual_dep_message_contains_both_ids(self) -> None:
        """Error message must name both packages involved in the cycle."""

        async def _test() -> None:
            graph = InMemoryGraphPersistence()
            await _seed_package(graph, "B", requires=["A"])
            package_a = _package_data("A", requires=["B"])
            with pytest.raises(ValueError) as exc_info:
                await _resolve_dependencies(graph, package_a)
            msg = str(exc_info.value)
            assert "A" in msg
            assert "B" in msg

        _run(_test())

    # AC-2: linear chain succeeds
    def test_linear_chain_succeeds(self) -> None:
        """A->B->C, no cycle: _resolve_dependencies returns success."""

        async def _test() -> None:
            graph = InMemoryGraphPersistence()
            # Seed C and B as installed (B requires C, C requires nothing).
            await _seed_package(graph, "C", requires=[])
            await _seed_package(graph, "B", requires=["C"])
            # Resolve A, which requires B.
            package_a = _package_data("A", requires=["B"])
            result = await _resolve_dependencies(graph, package_a)
            assert result.success is True

        _run(_test())

    # AC-2: single package no deps
    def test_single_package_no_deps_succeeds(self) -> None:
        """A single package with no requires resolves successfully."""

        async def _test() -> None:
            graph = InMemoryGraphPersistence()
            package_a = _package_data("A", requires=[])
            result = await _resolve_dependencies(graph, package_a)
            assert result.success is True

        _run(_test())


# ---------------------------------------------------------------------------
# Integration via install_package (end-to-end)
# ---------------------------------------------------------------------------


class TestInstallPackageCycleEndToEnd:
    """Verify that install_package surfaces the cycle through InstallResult."""

    def test_cycle_captured_in_install_result(self) -> None:
        """Cycle causes InstallResult.success=False with the error in the message."""

        async def _test() -> None:
            graph = InMemoryGraphPersistence()
            await _seed_package(graph, "B", requires=["A"])
            package_a = _package_data("A", requires=["B"])
            result = await install_package(graph, package_a)
            assert result.success is False
            assert "Circular dependency detected" in result.error_message

        _run(_test())

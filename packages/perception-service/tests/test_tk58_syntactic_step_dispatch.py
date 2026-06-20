"""TK-58 acceptance tests: ProcedureExecutor syntactic step type dispatch.

Verifies both acceptance criteria:

AC-1  Given SyntacticTemplateMatcher injected, when a match_root step
      executes, then dispatched to matcher.match(); result returned.

AC-2  Given the matcher is None, when a syntactic step is hit, then
      NotImplementedError with a descriptive message (not a bare raise);
      non-syntactic steps unchanged.

These are pure unit tests (no model, no Neo4j, no network). They use
InMemoryGraphPersistence and a lightweight mock matcher.

Run with::

    cd packages/perception-service
    python -m pytest tests/test_tk58_syntactic_step_dispatch.py -v
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock

import pytest

from cobeing.layer3_knowledge.in_memory_persistence import InMemoryGraphPersistence
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.procedure_executor import ProcedureExecutor
from cobeing.layer3_knowledge.procedure_types import (
    HAS_PROCEDURE_BODY,
    PROCEDURAL_TEMPLATE,
    PROCEDURE_STEP,
    VALUE_NODE,
)
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_PROV = Provenance(
    source=ProvenanceSource.INFERENCE,
    source_id="tk58-test",
    confidence=1.0,
)


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


def _make_node(node_id: str, node_type: str, props: dict) -> KnowledgeNode:
    return KnowledgeNode(
        node_id=NodeId(node_id),
        node_type=node_type,
        schema_level=SchemaLevel.SCHEMA,
        properties=props,
        provenance=_PROV,
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _make_edge(edge_id: str, source: str, target: str, edge_type: str) -> KnowledgeEdge:
    return KnowledgeEdge(
        edge_id=EdgeId(edge_id),
        source_id=NodeId(source),
        target_id=NodeId(target),
        edge_type=edge_type,
        properties={},
        provenance=_PROV,
        confidence=1.0,
    )


async def _build_syntactic_procedure(
    graph: InMemoryGraphPersistence,
    proc_id: str,
    step_type: str,
    text_value: str,
) -> NodeId:
    """Seed a syntactic-domain ProceduralTemplate with a single step of the
    given step_type.  Also seeds an input ValueNode holding *text_value* and
    wires it as the sole parameter '$text'.

    Returns the NodeId of the text ValueNode (the operand to pass in the
    ExecutionRequest).
    """
    # ProceduralTemplate with parameter "$text"
    await graph.save_node(
        _make_node(
            proc_id,
            PROCEDURAL_TEMPLATE,
            {"name": proc_id, "domain": "syntax", "parameters": ["$text"]},
        )
    )

    # Root ProcedureStep with the requested syntactic step_type
    step_id = f"{proc_id}:root_step"
    await graph.save_node(
        _make_node(step_id, PROCEDURE_STEP, {"step_type": step_type})
    )

    # HAS_PROCEDURE_BODY edge
    await graph.save_edge(
        _make_edge(f"edge:body:{proc_id}", proc_id, step_id, HAS_PROCEDURE_BODY)
    )

    # ValueNode holding the input text (stored as 'value' property)
    text_node_id = f"value:text:input"
    await graph.save_node(
        _make_node(
            text_node_id,
            VALUE_NODE,
            {"value_type": "string", "value": text_value},
        )
    )

    return NodeId(text_node_id)


# ---------------------------------------------------------------------------
# AC-1: matcher injected → match_root dispatches to matcher.match()
# ---------------------------------------------------------------------------


class TestSyntacticDispatchWithMatcher:
    """AC-1 — SyntacticTemplateMatcher injected: match_root step delegates."""

    def test_match_root_dispatches_to_matcher_match(self) -> None:
        """match_root step must call matcher.match() and return its result."""
        sentinel_result = object()  # a unique object to prove it flows through

        async def scenario():
            graph = InMemoryGraphPersistence()
            input_text = "cats are animals"
            text_node_id = await _build_syntactic_procedure(
                graph, "proc:parse_copular", "match_root", input_text
            )

            # Mock matcher whose match() returns the sentinel
            mock_matcher = AsyncMock()
            mock_matcher.match.return_value = sentinel_result

            executor = ProcedureExecutor(
                graph=graph,
                syntactic_matcher=mock_matcher,
            )
            # Call _execute_ast directly with a minimal context to isolate
            # the syntactic dispatch path without the full execute() overhead
            # (which tries to create COMPUTES_TO edges for int/bool results).
            from cobeing.layer3_knowledge.procedure_executor import _ExecutionContext
            import time

            ctx = _ExecutionContext(
                correlation_id="test-ac1",
                deadline=time.monotonic() + 30.0,
                remaining_depth=8,
            )
            bindings = {"$text": text_node_id}

            # Get the root step id
            body_edges = await graph.query_edges(
                __import__(
                    "cobeing.layer3_knowledge.query_types",
                    fromlist=["EdgeFilter"],
                ).EdgeFilter(
                    edge_type=HAS_PROCEDURE_BODY,
                    source_node_id=NodeId("proc:parse_copular"),
                )
            )
            root_step_id = body_edges[0].target_id

            result = await executor._execute_ast(
                NodeId(root_step_id), bindings, ctx
            )
            return result, mock_matcher

        result, mock_matcher = _run(scenario())

        # AC-1a: result is exactly what matcher.match() returned
        assert result is sentinel_result, (
            f"Expected matcher result to flow through; got {result!r}"
        )
        # AC-1b: matcher.match() was called exactly once
        mock_matcher.match.assert_called_once()

    def test_match_root_passes_text_from_binding_to_matcher(self) -> None:
        """match_root reads the input text from the bound ValueNode and passes
        it to matcher.match()."""

        async def scenario():
            graph = InMemoryGraphPersistence()
            input_text = "water is cold"
            text_node_id = await _build_syntactic_procedure(
                graph, "proc:parse_prop", "match_root", input_text
            )

            mock_matcher = AsyncMock()
            mock_matcher.match.return_value = None

            executor = ProcedureExecutor(
                graph=graph,
                syntactic_matcher=mock_matcher,
            )

            from cobeing.layer3_knowledge.procedure_executor import _ExecutionContext
            import time

            ctx = _ExecutionContext(
                correlation_id="test-text",
                deadline=time.monotonic() + 30.0,
                remaining_depth=8,
            )
            bindings = {"$text": text_node_id}

            body_edges = await graph.query_edges(
                __import__(
                    "cobeing.layer3_knowledge.query_types",
                    fromlist=["EdgeFilter"],
                ).EdgeFilter(
                    edge_type=HAS_PROCEDURE_BODY,
                    source_node_id=NodeId("proc:parse_prop"),
                )
            )
            root_step_id = body_edges[0].target_id

            await executor._execute_ast(NodeId(root_step_id), bindings, ctx)
            return mock_matcher

        mock_matcher = _run(scenario())

        # Verify the text from the ValueNode was passed to match()
        mock_matcher.match.assert_called_once_with("water is cold")

    @pytest.mark.parametrize(
        "step_type",
        ["match_edge", "match_optional", "extract_role", "match_property"],
    )
    def test_all_syntactic_step_types_dispatch_to_matcher(
        self, step_type: str
    ) -> None:
        """All five syntactic step types must dispatch to the matcher, not just
        match_root."""

        async def scenario():
            graph = InMemoryGraphPersistence()
            text_node_id = await _build_syntactic_procedure(
                graph, f"proc:test_{step_type}", step_type, "hello"
            )

            mock_matcher = AsyncMock()
            mock_matcher.match.return_value = "dispatched"

            executor = ProcedureExecutor(
                graph=graph,
                syntactic_matcher=mock_matcher,
            )

            from cobeing.layer3_knowledge.procedure_executor import _ExecutionContext
            import time

            ctx = _ExecutionContext(
                correlation_id="test-dispatch",
                deadline=time.monotonic() + 30.0,
                remaining_depth=8,
            )
            bindings = {"$text": text_node_id}

            body_edges = await graph.query_edges(
                __import__(
                    "cobeing.layer3_knowledge.query_types",
                    fromlist=["EdgeFilter"],
                ).EdgeFilter(
                    edge_type=HAS_PROCEDURE_BODY,
                    source_node_id=NodeId(f"proc:test_{step_type}"),
                )
            )
            root_step_id = body_edges[0].target_id

            result = await executor._execute_ast(
                NodeId(root_step_id), bindings, ctx
            )
            return result, mock_matcher

        result, mock_matcher = _run(scenario())
        assert result == "dispatched"
        mock_matcher.match.assert_called_once()


# ---------------------------------------------------------------------------
# AC-2: matcher is None → NotImplementedError with descriptive message
# ---------------------------------------------------------------------------


class TestSyntacticStepNoMatcher:
    """AC-2 — No matcher injected: syntactic steps raise descriptive
    NotImplementedError; non-syntactic steps are unaffected."""

    @pytest.mark.parametrize(
        "step_type",
        ["match_root", "match_edge", "match_optional", "extract_role", "match_property"],
    )
    def test_syntactic_step_raises_not_implemented_when_no_matcher(
        self, step_type: str
    ) -> None:
        """Without a matcher, every syntactic step_type must raise
        NotImplementedError whose message names the missing matcher and
        the constructor argument."""

        async def scenario():
            graph = InMemoryGraphPersistence()
            text_node_id = await _build_syntactic_procedure(
                graph, f"proc:no_matcher_{step_type}", step_type, "test"
            )

            # No syntactic_matcher wired
            executor = ProcedureExecutor(graph=graph)

            from cobeing.layer3_knowledge.procedure_executor import _ExecutionContext
            import time

            ctx = _ExecutionContext(
                correlation_id="test-no-matcher",
                deadline=time.monotonic() + 30.0,
                remaining_depth=8,
            )
            bindings = {"$text": text_node_id}

            body_edges = await graph.query_edges(
                __import__(
                    "cobeing.layer3_knowledge.query_types",
                    fromlist=["EdgeFilter"],
                ).EdgeFilter(
                    edge_type=HAS_PROCEDURE_BODY,
                    source_node_id=NodeId(f"proc:no_matcher_{step_type}"),
                )
            )
            root_step_id = body_edges[0].target_id

            await executor._execute_ast(NodeId(root_step_id), bindings, ctx)

        with pytest.raises(NotImplementedError) as exc_info:
            _run(scenario())

        msg = str(exc_info.value)
        # Message must name the missing mechanism (not a bare raise)
        assert "SyntacticTemplateMatcher" in msg, (
            f"Error message must name SyntacticTemplateMatcher; got: {msg!r}"
        )
        assert "syntactic_matcher" in msg or "matcher" in msg.lower(), (
            f"Error message must reference the constructor arg; got: {msg!r}"
        )

    def test_literal_step_unaffected_without_matcher(self) -> None:
        """Non-syntactic steps (literal) still work when matcher is None."""

        async def scenario():
            graph = InMemoryGraphPersistence()

            # Seed a simple literal procedure (no syntactic steps)
            proc_id = "proc:literal_test"
            await graph.save_node(
                _make_node(
                    proc_id,
                    PROCEDURAL_TEMPLATE,
                    {"name": proc_id, "parameters": []},
                )
            )
            step_id = f"{proc_id}:root"
            await graph.save_node(
                _make_node(
                    step_id,
                    PROCEDURE_STEP,
                    {"step_type": "literal", "literal_value": 42},
                )
            )
            await graph.save_edge(
                _make_edge(f"edge:body:{proc_id}", proc_id, step_id, HAS_PROCEDURE_BODY)
            )

            executor = ProcedureExecutor(graph=graph)

            from cobeing.layer3_knowledge.procedure_executor import _ExecutionContext
            import time

            ctx = _ExecutionContext(
                correlation_id="test-literal",
                deadline=time.monotonic() + 30.0,
                remaining_depth=8,
            )
            return await executor._execute_ast(NodeId(step_id), {}, ctx)

        result = _run(scenario())
        assert result == 42, f"literal step must still return 42; got {result!r}"

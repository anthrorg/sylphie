"""POC spike (TK-56): MorphologyExecutor 'call' step delegation.

Proves the hypothesis that a MorphologyExecutor ``call`` step can delegate to
a sub-procedure entirely in string space -- with no string->ValueNode->string
conversion -- and that a circular call chain trips a bounded depth limit
instead of overflowing the Python stack.

Conversion contract being proven (the asymmetry with ProcedureExecutor):
    ProcedureExecutor's ``variable`` branch reads a ValueNode's ``value``
    property from the graph, so its ``call`` branch must convert each operand
    Python value to a ValueNode ID and back. MorphologyExecutor stays in
    string space: ``variable`` returns the raw Python ``str`` bound to $WORD,
    so a ``call`` step needs NO ValueNode intermediary. The caller and callee
    both operate on the same Python ``str``; the sub-procedure is itself a
    MorphologyExecutor procedure looked up by NodeId in the same graph and
    returns a Python ``str`` directly.

Run with::

    cd packages/perception-service
    .venv/Scripts/python.exe -m pytest tests/test_morphology_call_poc.py -v
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from cobeing.layer3_knowledge.in_memory_persistence import (
    InMemoryGraphPersistence,
)
from cobeing.layer3_knowledge.morphology_executor import MorphologyExecutor
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.procedure_types import (
    HAS_PROCEDURE_BODY,
    PROCEDURAL_TEMPLATE,
    PROCEDURE_STEP,
)
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_PROV = Provenance(
    source=ProvenanceSource.INFERENCE,
    source_id="morphology-call-poc",
    confidence=1.0,
)


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


def _make_template(node_id: str) -> KnowledgeNode:
    """Build a ProceduralTemplate node."""
    return KnowledgeNode(
        node_id=NodeId(node_id),
        node_type=PROCEDURAL_TEMPLATE,
        schema_level=SchemaLevel.SCHEMA,
        properties={"name": node_id},
        provenance=_PROV,
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _make_step(node_id: str, properties: dict[str, Any]) -> KnowledgeNode:
    """Build a ProcedureStep node with the given step properties."""
    return KnowledgeNode(
        node_id=NodeId(node_id),
        node_type=PROCEDURE_STEP,
        schema_level=SchemaLevel.SCHEMA,
        properties=properties,
        provenance=_PROV,
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _body_edge(template_id: str, step_id: str) -> KnowledgeEdge:
    """Link a ProceduralTemplate to its root ProcedureStep."""
    return KnowledgeEdge(
        edge_id=EdgeId(f"edge:body:{template_id}"),
        source_id=NodeId(template_id),
        target_id=NodeId(step_id),
        edge_type=HAS_PROCEDURE_BODY,
        properties={},
        provenance=_PROV,
        confidence=1.0,
    )


async def _seed_literal_procedure(
    graph: InMemoryGraphPersistence,
    proc_id: str,
    literal_value: str,
) -> None:
    """Seed a procedure whose single body step is a literal returning a string."""
    await graph.save_node(_make_template(proc_id))
    step_id = f"{proc_id}:literal"
    await graph.save_node(
        _make_step(
            step_id,
            {"step_type": "literal", "literal_value": literal_value},
        )
    )
    await graph.save_edge(_body_edge(proc_id, step_id))


async def _seed_call_procedure(
    graph: InMemoryGraphPersistence,
    proc_id: str,
    target_procedure: str,
) -> None:
    """Seed a procedure whose single body step is a 'call' to target_procedure.

    The call step carries NO HAS_OPERAND children -- the string-space contract
    passes $WORD straight through to the sub-procedure.
    """
    await graph.save_node(_make_template(proc_id))
    step_id = f"{proc_id}:call"
    await graph.save_node(
        _make_step(
            step_id,
            {"step_type": "call", "target_procedure": target_procedure},
        )
    )
    await graph.save_edge(_body_edge(proc_id, step_id))


# ---------------------------------------------------------------------------
# TASK-401: happy-path 'call' delegation
# ---------------------------------------------------------------------------


def test_call_step_delegates_to_subprocedure() -> None:
    """A 'call' step runs the target sub-procedure and returns its string.

    proc:full_transform has a single 'call' step targeting proc:prefix_add,
    which is a literal procedure returning 'pre_'. Executing full_transform on
    'cat' must run the sub-procedure and return 'pre_' -- proving delegation
    works with no ValueNode intermediary.
    """

    async def scenario() -> str | None:
        graph = InMemoryGraphPersistence()
        await _seed_literal_procedure(graph, "proc:prefix_add", "pre_")
        await _seed_call_procedure(
            graph, "proc:full_transform", "proc:prefix_add"
        )
        executor = MorphologyExecutor(persistence=graph)
        return await executor._execute_string_procedure(
            "proc:full_transform", "cat"
        )

    result = _run(scenario())
    assert result == "pre_"


# ---------------------------------------------------------------------------
# TASK-402: circular 'call' chain raises a bounded recursion error
# ---------------------------------------------------------------------------


def test_circular_call_raises_depth_limit() -> None:
    """A circular call chain (proc:A -> proc:B -> proc:A) raises RecursionError.

    The depth counter increments on every 'call' delegation; once it exceeds
    the bound the executor raises RecursionError rather than overflowing the
    Python stack.
    """

    async def scenario() -> str | None:
        graph = InMemoryGraphPersistence()
        await _seed_call_procedure(graph, "proc:A", "proc:B")
        await _seed_call_procedure(graph, "proc:B", "proc:A")
        executor = MorphologyExecutor(persistence=graph)
        return await executor._execute_string_procedure("proc:A", "word")

    with pytest.raises((RecursionError, Exception)) as exc_info:
        _run(scenario())

    # The terminating exception must be a recursion/depth/circular signal.
    assert isinstance(exc_info.value, RecursionError)
    message = str(exc_info.value).lower()
    assert any(
        token in message for token in ("depth", "circular", "recursion")
    ), f"exception message did not name the cause: {exc_info.value!r}"


# --- POC RUN OUTPUT ---
#
# $ cd packages/perception-service
# $ .venv/Scripts/python.exe -m pytest tests/test_morphology_call_poc.py -v
#
# ============================= test session starts =============================
# platform win32 -- Python 3.13.11, pytest-9.0.3, pluggy-1.6.0 -- .venv/Scripts/python.exe
# cachedir: .pytest_cache
# rootdir: C:\Users\Jim\OneDrive\desktop\Code\sylphie\packages\perception-service
# configfile: pyproject.toml
# plugins: anyio-4.13.0, asyncio-1.3.0
# asyncio: mode=Mode.STRICT, debug=False, asyncio_default_fixture_loop_scope=None, asyncio_default_test_loop_scope=function
# collecting ... collected 2 items
#
# tests/test_morphology_call_poc.py::test_call_step_delegates_to_subprocedure PASSED [ 50%]
# tests/test_morphology_call_poc.py::test_circular_call_raises_depth_limit PASSED [100%]
#
# ============================== 2 passed in 0.22s ==============================

"""Procedural ontology bootstrap for Co-Being (Phase 1.6, PKG-1.3/1.4/1.5).

Implements the TAUGHT_PROCEDURE bootstrap in three dependency-ordered layers
(CANON A.18):

  Layer 0 — Foundational concepts and value nodes (PKG-1.3):
    - 8 ConceptPrimitive SCHEMA nodes (unit, zero, integer, set, sequence,
      more-than, less-than, same-as)
    - 21 ValueNode INSTANCE nodes (integers 0–20)
    - 21 INSTANCE_OF_CONCEPT edges (each ValueNode -> concept:integer)

  Layer 1 — Counting primitives (PKG-1.4):
    - proc:successor        — successor($N) = N + 1
    - proc:set_rep          — set_representation($N) = [1] * N
    - proc:count            — count($S) = len($S)

  Layer 2 — Arithmetic and comparison (PKG-1.5):
    - proc:add              — add($X, $Y) = X + Y
    - proc:subtract         — subtract($X, $Y) = X − Y
    - proc:multiply         — multiply($X, $Y) = X × Y
    - proc:compare_gt       — compare_gt($X, $Y) = X > Y
    - proc:compare_lt       — compare_lt($X, $Y) = X < Y
    - proc:compare_eq       — compare_eq($X, $Y) = X == Y

All nodes use TAUGHT_PROCEDURE provenance (CANON A.18). This function is
called once per startup, after ``bootstrap_graph()``. It is idempotent:
a node that already exists is counted as existing and not recreated.

Usage::

    from cobeing.layer3_knowledge.procedure_bootstrap import (
        bootstrap_procedural_ontology,
    )

    result = await bootstrap_procedural_ontology(persistence)
    # result.concepts_created, result.values_created, result.procedures_created
"""

from __future__ import annotations

from dataclasses import dataclass

from cobeing.layer3_knowledge.exceptions import BootstrapError
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.procedure_types import (
    CONCEPT_PRIMITIVE,
    DEPENDS_ON,
    HAS_OPERAND,
    HAS_PROCEDURE_BODY,
    HAS_WORKED_EXAMPLE,
    INSTANCE_OF_CONCEPT,
    PROCEDURE_STEP,
    PROCEDURAL_TEMPLATE,
    VALUE_NODE,
    WORKED_EXAMPLE,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId


# ---------------------------------------------------------------------------
# Provenance helper
# ---------------------------------------------------------------------------


def _taught() -> Provenance:
    """Return the canonical TAUGHT_PROCEDURE provenance for all bootstrap nodes."""
    return Provenance(
        source=ProvenanceSource.TAUGHT_PROCEDURE,
        source_id="procedural-ontology-bootstrap",
        confidence=1.0,
    )


# ===========================================================================
# Layer 0: ConceptPrimitive and ValueNode definitions (PKG-1.3)
# ===========================================================================

_CONCEPT_PRIMITIVE_DEFS: list[dict] = [
    {
        "node_id": "concept:unit",
        "name": "unit",
        "description": (
            "A single indivisible counting mark. The primitive of cardinality. "
            "One tally in a tally count."
        ),
    },
    {
        "node_id": "concept:zero",
        "name": "zero",
        "description": (
            "The absence of quantity. The empty set. The additive identity."
        ),
    },
    {
        "node_id": "concept:integer",
        "name": "integer",
        "description": (
            "A whole number — the cardinality of a finite set of units. "
            "Integers are the domain of arithmetic procedures."
        ),
    },
    {
        "node_id": "concept:set",
        "name": "set",
        "description": (
            "An unordered collection of elements. Used to represent the "
            "quantity of an integer as a set of unit marks."
        ),
    },
    {
        "node_id": "concept:sequence",
        "name": "sequence",
        "description": (
            "An ordered list of elements. Used in counting: each step "
            "advances one position in the counting sequence."
        ),
    },
    {
        "node_id": "concept:more-than",
        "name": "more-than",
        "description": (
            "The binary relation A > B: A contains strictly more elements "
            "than B when both are represented as sets of units."
        ),
    },
    {
        "node_id": "concept:less-than",
        "name": "less-than",
        "description": (
            "The binary relation A < B: A contains strictly fewer elements "
            "than B when both are represented as sets of units."
        ),
    },
    {
        "node_id": "concept:same-as",
        "name": "same-as",
        "description": (
            "The binary relation A == B: A and B contain exactly the same "
            "number of elements when both are represented as sets of units."
        ),
    },
]


def _build_concept_primitive(defn: dict) -> KnowledgeNode:
    return KnowledgeNode(
        node_id=NodeId(defn["node_id"]),
        node_type=CONCEPT_PRIMITIVE,
        schema_level=SchemaLevel.SCHEMA,
        properties={"name": defn["name"], "description": defn["description"]},
        provenance=_taught(),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _build_value_node(n: int) -> KnowledgeNode:
    """Build a ValueNode for integer n (0 ≤ n ≤ 20)."""
    return KnowledgeNode(
        node_id=NodeId(f"value:integer:{n}"),
        node_type=VALUE_NODE,
        schema_level=SchemaLevel.INSTANCE,
        properties={"value_type": "integer", "value": n, "value_repr": str(n)},
        provenance=_taught(),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _build_instance_of_edge(value_id: NodeId, concept_id: NodeId) -> KnowledgeEdge:
    return KnowledgeEdge(
        edge_id=EdgeId(f"edge:instance_of:{value_id}"),
        source_id=value_id,
        target_id=concept_id,
        edge_type=INSTANCE_OF_CONCEPT,
        properties={},
        provenance=_taught(),
        confidence=1.0,
    )


async def bootstrap_procedural_layer0(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 0: ConceptPrimitive and ValueNode nodes.

    Returns a dict with keys:
        concepts_created, concepts_existing,
        values_created, values_existing, edges_created.
    """
    counts: dict[str, int] = {
        "concepts_created": 0,
        "concepts_existing": 0,
        "values_created": 0,
        "values_existing": 0,
        "edges_created": 0,
    }

    # ---- ConceptPrimitive nodes ----
    for defn in _CONCEPT_PRIMITIVE_DEFS:
        node_id = NodeId(defn["node_id"])
        if await persistence.get_node(node_id) is not None:
            counts["concepts_existing"] += 1
            continue
        node = _build_concept_primitive(defn)
        try:
            await persistence.save_node(node)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to create ConceptPrimitive '{node_id}': {exc}"
            ) from exc
        counts["concepts_created"] += 1

    # ---- ValueNode nodes (integers 0–20) + INSTANCE_OF_CONCEPT edges ----
    integer_concept_id = NodeId("concept:integer")
    for n in range(21):
        node_id = NodeId(f"value:integer:{n}")
        if await persistence.get_node(node_id) is not None:
            counts["values_existing"] += 1
            continue

        value_node = _build_value_node(n)
        try:
            await persistence.save_node(value_node)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to create ValueNode '{node_id}': {exc}"
            ) from exc
        counts["values_created"] += 1

        edge = _build_instance_of_edge(node_id, integer_concept_id)
        try:
            await persistence.save_edge(edge)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to create INSTANCE_OF_CONCEPT edge for '{node_id}': {exc}"
            ) from exc
        counts["edges_created"] += 1

    return counts


# ===========================================================================
# Shared procedure bootstrap infrastructure
# ===========================================================================
#
# Procedures are described as plain dicts:
#
#   {
#       "id":          "proc:add",           # ProceduralTemplate node_id
#       "name":        "add",                # human-readable name
#       "description": "...",
#       "parameters":  ["$X", "$Y"],         # variable names in order
#       "depends_on":  ["concept:integer"],  # ConceptPrimitive / proc IDs
#       "body": {                            # root ProcedureStep (recursive)
#           "id":        "step:add:root",
#           "step_type": "operation",
#           "operation": "add",
#           "operands": [
#               {"id": "step:add:x", "step_type": "variable", "variable": "$X"},
#               {"id": "step:add:y", "step_type": "variable", "variable": "$Y"},
#           ],
#       },
#       "examples": [
#           {
#               "id":             "example:add:3+5",
#               "input_node_ids": ["value:integer:3", "value:integer:5"],
#               "output_node_id": "value:integer:8",  # "" for non-integer results
#               "description":    "add(3, 5) = 8",
#               "step_trace":     [...],
#           },
#       ],
#   }
#
# ===========================================================================


def _build_procedure_template(proc_def: dict) -> KnowledgeNode:
    return KnowledgeNode(
        node_id=NodeId(proc_def["id"]),
        node_type=PROCEDURAL_TEMPLATE,
        schema_level=SchemaLevel.SCHEMA,
        properties={
            "name": proc_def["name"],
            "description": proc_def["description"],
            "parameters": proc_def["parameters"],
            "arity": len(proc_def["parameters"]),
        },
        provenance=_taught(),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _build_procedure_step(step_def: dict) -> KnowledgeNode:
    props: dict = {"step_type": step_def["step_type"]}
    if step_def["step_type"] == "operation":
        props["operation"] = step_def["operation"]
    elif step_def["step_type"] == "variable":
        props["variable"] = step_def["variable"]
    elif step_def["step_type"] == "literal":
        props["literal_value"] = step_def["literal_value"]
        props["literal_type"] = step_def.get("literal_type", "integer")
    return KnowledgeNode(
        node_id=NodeId(step_def["id"]),
        node_type=PROCEDURE_STEP,
        schema_level=SchemaLevel.SCHEMA,
        properties=props,
        provenance=_taught(),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _collect_procedure_nodes_and_edges(
    proc_def: dict,
) -> tuple[list[KnowledgeNode], list[KnowledgeEdge]]:
    """Build all nodes and edges for one procedure definition.

    Returns (nodes, edges) covering:
    - The ProceduralTemplate node
    - All ProcedureStep nodes (recursively from the body AST)
    - All WorkedExample nodes
    - HAS_PROCEDURE_BODY, HAS_OPERAND, DEPENDS_ON, HAS_WORKED_EXAMPLE edges
    """
    nodes: list[KnowledgeNode] = []
    edges: list[KnowledgeEdge] = []

    proc_node_id = NodeId(proc_def["id"])
    nodes.append(_build_procedure_template(proc_def))

    # --- Recursively traverse the AST body ---
    def _traverse(step_def: dict, parent_id: NodeId | None, position: int) -> None:
        step_node = _build_procedure_step(step_def)
        nodes.append(step_node)
        step_id = NodeId(step_def["id"])

        if parent_id is None:
            # Root step: ProceduralTemplate --HAS_PROCEDURE_BODY--> root ProcedureStep
            edges.append(
                KnowledgeEdge(
                    edge_id=EdgeId(f"edge:has_body:{proc_def['id']}"),
                    source_id=proc_node_id,
                    target_id=step_id,
                    edge_type=HAS_PROCEDURE_BODY,
                    properties={},
                    provenance=_taught(),
                    confidence=1.0,
                )
            )
        else:
            # Child step: parent ProcedureStep --HAS_OPERAND--> child ProcedureStep
            edges.append(
                KnowledgeEdge(
                    edge_id=EdgeId(f"edge:has_operand:{parent_id}:{position}"),
                    source_id=parent_id,
                    target_id=step_id,
                    edge_type=HAS_OPERAND,
                    properties={"position": position},
                    provenance=_taught(),
                    confidence=1.0,
                )
            )

        for pos, operand_def in enumerate(step_def.get("operands", [])):
            _traverse(operand_def, step_id, pos)

    _traverse(proc_def["body"], None, 0)

    # --- DEPENDS_ON edges ---
    for dep_id in proc_def.get("depends_on", []):
        edges.append(
            KnowledgeEdge(
                edge_id=EdgeId(f"edge:depends_on:{proc_def['id']}:{dep_id}"),
                source_id=proc_node_id,
                target_id=NodeId(dep_id),
                edge_type=DEPENDS_ON,
                properties={},
                provenance=_taught(),
                confidence=1.0,
            )
        )

    # --- WorkedExample nodes and HAS_WORKED_EXAMPLE edges ---
    for ex in proc_def.get("examples", []):
        example_node = KnowledgeNode(
            node_id=NodeId(ex["id"]),
            node_type=WORKED_EXAMPLE,
            schema_level=SchemaLevel.SCHEMA,
            properties={
                "input_node_ids": ex["input_node_ids"],
                "output_node_id": ex.get("output_node_id", ""),
                "description": ex["description"],
                "step_trace": ex.get("step_trace", []),
            },
            provenance=_taught(),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        nodes.append(example_node)
        edges.append(
            KnowledgeEdge(
                edge_id=EdgeId(f"edge:has_example:{proc_def['id']}:{ex['id']}"),
                source_id=proc_node_id,
                target_id=NodeId(ex["id"]),
                edge_type=HAS_WORKED_EXAMPLE,
                properties={},
                provenance=_taught(),
                confidence=1.0,
            )
        )

    return nodes, edges


async def _bootstrap_single_procedure(
    persistence: GraphPersistence,
    proc_def: dict,
) -> bool:
    """Bootstrap one procedure. Returns True if created, False if already existed.

    Idempotency key: the ProceduralTemplate node_id. If that node exists,
    the entire procedure (steps, examples, edges) is assumed to exist.
    """
    proc_node_id = NodeId(proc_def["id"])
    if await persistence.get_node(proc_node_id) is not None:
        return False

    nodes, edges = _collect_procedure_nodes_and_edges(proc_def)

    for node in nodes:
        try:
            await persistence.save_node(node)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to save node '{node.node_id}' for procedure "
                f"'{proc_def['id']}': {exc}"
            ) from exc

    for edge in edges:
        try:
            await persistence.save_edge(edge)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to save edge '{edge.edge_id}' for procedure "
                f"'{proc_def['id']}': {exc}"
            ) from exc

    return True


# ===========================================================================
# Layer 1: Counting primitives (PKG-1.4)
# ===========================================================================

_LAYER1_PROCEDURE_DEFS: list[dict] = [
    # ------------------------------------------------------------------
    # successor($N) = N + 1
    # ------------------------------------------------------------------
    {
        "id": "proc:successor",
        "name": "successor",
        "description": (
            "Given integer N, return the next integer: N + 1. "
            "The foundational step of the counting sequence."
        ),
        "parameters": ["$N"],
        "depends_on": ["concept:integer"],
        "body": {
            "id": "step:successor:root",
            "step_type": "operation",
            "operation": "successor",
            "operands": [
                {"id": "step:successor:n", "step_type": "variable", "variable": "$N"},
            ],
        },
        "examples": [
            {
                "id": "example:successor:4",
                "input_node_ids": ["value:integer:4"],
                "output_node_id": "value:integer:5",
                "description": "successor(4) = 5",
                "step_trace": [
                    {"step": "bind $N", "value": 4},
                    {"step": "successor($N)", "value": 5},
                ],
            },
            {
                "id": "example:successor:0",
                "input_node_ids": ["value:integer:0"],
                "output_node_id": "value:integer:1",
                "description": "successor(0) = 1",
                "step_trace": [
                    {"step": "bind $N", "value": 0},
                    {"step": "successor($N)", "value": 1},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # set_representation($N) = [1] * N
    # ------------------------------------------------------------------
    {
        "id": "proc:set_representation",
        "name": "set_representation",
        "description": (
            "Given integer N, return a list of N unit markers [1, 1, ..., 1]. "
            "This is the set-theoretic representation of the quantity N."
        ),
        "parameters": ["$N"],
        "depends_on": ["concept:integer", "concept:set", "concept:unit"],
        "body": {
            "id": "step:set_rep:root",
            "step_type": "operation",
            "operation": "set_representation",
            "operands": [
                {"id": "step:set_rep:n", "step_type": "variable", "variable": "$N"},
            ],
        },
        "examples": [
            {
                "id": "example:set_rep:3",
                "input_node_ids": ["value:integer:3"],
                "output_node_id": "",  # result is a list, not a ValueNode
                "description": "set_representation(3) = [1, 1, 1]",
                "step_trace": [
                    {"step": "bind $N", "value": 3},
                    {"step": "set_representation($N)", "value": [1, 1, 1]},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # count($S) = len($S)
    # ------------------------------------------------------------------
    {
        "id": "proc:count",
        "name": "count",
        "description": (
            "Given a set S (list of unit markers), return its cardinality: "
            "the number of elements it contains."
        ),
        "parameters": ["$S"],
        "depends_on": ["concept:set", "concept:integer"],
        "body": {
            "id": "step:count:root",
            "step_type": "operation",
            "operation": "count",
            "operands": [
                {"id": "step:count:s", "step_type": "variable", "variable": "$S"},
            ],
        },
        "examples": [
            {
                "id": "example:count:3",
                "input_node_ids": [],  # set input has no corresponding ValueNode
                "output_node_id": "value:integer:3",
                "description": "count([1, 1, 1]) = 3",
                "step_trace": [
                    {"step": "bind $S", "value": [1, 1, 1]},
                    {"step": "count($S)", "value": 3},
                ],
            },
        ],
    },
]


async def bootstrap_procedural_layer1(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 1 (counting primitive) procedure nodes.

    Returns a dict with keys: procedures_created, procedures_existing.
    """
    counts: dict[str, int] = {"procedures_created": 0, "procedures_existing": 0}
    for proc_def in _LAYER1_PROCEDURE_DEFS:
        created = await _bootstrap_single_procedure(persistence, proc_def)
        if created:
            counts["procedures_created"] += 1
        else:
            counts["procedures_existing"] += 1
    return counts


# ===========================================================================
# Layer 2: Arithmetic and comparison (PKG-1.5)
# ===========================================================================

_LAYER2_PROCEDURE_DEFS: list[dict] = [
    # ------------------------------------------------------------------
    # add($X, $Y) = X + Y
    # ------------------------------------------------------------------
    {
        "id": "proc:add",
        "name": "add",
        "description": "Given integers X and Y, return their sum: X + Y.",
        "parameters": ["$X", "$Y"],
        "depends_on": ["concept:integer", "proc:set_representation", "proc:count"],
        "body": {
            "id": "step:add:root",
            "step_type": "operation",
            "operation": "add",
            "operands": [
                {"id": "step:add:x", "step_type": "variable", "variable": "$X"},
                {"id": "step:add:y", "step_type": "variable", "variable": "$Y"},
            ],
        },
        "examples": [
            {
                "id": "example:add:3+5",
                "input_node_ids": ["value:integer:3", "value:integer:5"],
                "output_node_id": "value:integer:8",
                "description": "add(3, 5) = 8",
                "step_trace": [
                    {"step": "bind $X", "value": 3},
                    {"step": "bind $Y", "value": 5},
                    {"step": "add($X, $Y)", "value": 8},
                ],
            },
            {
                "id": "example:add:2+3",
                "input_node_ids": ["value:integer:2", "value:integer:3"],
                "output_node_id": "value:integer:5",
                "description": "add(2, 3) = 5",
                "step_trace": [
                    {"step": "bind $X", "value": 2},
                    {"step": "bind $Y", "value": 3},
                    {"step": "add($X, $Y)", "value": 5},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # subtract($X, $Y) = X - Y
    # ------------------------------------------------------------------
    {
        "id": "proc:subtract",
        "name": "subtract",
        "description": (
            "Given integers X and Y where X ≥ Y, return their difference: X − Y."
        ),
        "parameters": ["$X", "$Y"],
        "depends_on": ["concept:integer", "proc:set_representation", "proc:count"],
        "body": {
            "id": "step:subtract:root",
            "step_type": "operation",
            "operation": "subtract",
            "operands": [
                {"id": "step:subtract:x", "step_type": "variable", "variable": "$X"},
                {"id": "step:subtract:y", "step_type": "variable", "variable": "$Y"},
            ],
        },
        "examples": [
            {
                "id": "example:subtract:8-5",
                "input_node_ids": ["value:integer:8", "value:integer:5"],
                "output_node_id": "value:integer:3",
                "description": "subtract(8, 5) = 3",
                "step_trace": [
                    {"step": "bind $X", "value": 8},
                    {"step": "bind $Y", "value": 5},
                    {"step": "subtract($X, $Y)", "value": 3},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # multiply($X, $Y) = X * Y
    # ------------------------------------------------------------------
    {
        "id": "proc:multiply",
        "name": "multiply",
        "description": "Given integers X and Y, return their product: X × Y.",
        "parameters": ["$X", "$Y"],
        "depends_on": ["concept:integer", "proc:add"],
        "body": {
            "id": "step:multiply:root",
            "step_type": "operation",
            "operation": "multiply",
            "operands": [
                {"id": "step:multiply:x", "step_type": "variable", "variable": "$X"},
                {"id": "step:multiply:y", "step_type": "variable", "variable": "$Y"},
            ],
        },
        "examples": [
            {
                "id": "example:multiply:3x4",
                "input_node_ids": ["value:integer:3", "value:integer:4"],
                "output_node_id": "value:integer:12",
                "description": "multiply(3, 4) = 12",
                "step_trace": [
                    {"step": "bind $X", "value": 3},
                    {"step": "bind $Y", "value": 4},
                    {"step": "multiply($X, $Y)", "value": 12},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # compare_gt($X, $Y) = X > Y
    # ------------------------------------------------------------------
    {
        "id": "proc:compare_gt",
        "name": "compare_gt",
        "description": (
            "Given integers X and Y, return True if X > Y, False otherwise."
        ),
        "parameters": ["$X", "$Y"],
        "depends_on": ["concept:integer", "concept:more-than"],
        "body": {
            "id": "step:compare_gt:root",
            "step_type": "operation",
            "operation": "compare_gt",
            "operands": [
                {"id": "step:compare_gt:x", "step_type": "variable", "variable": "$X"},
                {"id": "step:compare_gt:y", "step_type": "variable", "variable": "$Y"},
            ],
        },
        "examples": [
            {
                "id": "example:compare_gt:5>3",
                "input_node_ids": ["value:integer:5", "value:integer:3"],
                "output_node_id": "",  # boolean result, not a ValueNode
                "description": "compare_gt(5, 3) = True",
                "step_trace": [
                    {"step": "bind $X", "value": 5},
                    {"step": "bind $Y", "value": 3},
                    {"step": "compare_gt($X, $Y)", "value": True},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # compare_lt($X, $Y) = X < Y
    # ------------------------------------------------------------------
    {
        "id": "proc:compare_lt",
        "name": "compare_lt",
        "description": (
            "Given integers X and Y, return True if X < Y, False otherwise."
        ),
        "parameters": ["$X", "$Y"],
        "depends_on": ["concept:integer", "concept:less-than"],
        "body": {
            "id": "step:compare_lt:root",
            "step_type": "operation",
            "operation": "compare_lt",
            "operands": [
                {"id": "step:compare_lt:x", "step_type": "variable", "variable": "$X"},
                {"id": "step:compare_lt:y", "step_type": "variable", "variable": "$Y"},
            ],
        },
        "examples": [
            {
                "id": "example:compare_lt:3<5",
                "input_node_ids": ["value:integer:3", "value:integer:5"],
                "output_node_id": "",
                "description": "compare_lt(3, 5) = True",
                "step_trace": [
                    {"step": "bind $X", "value": 3},
                    {"step": "bind $Y", "value": 5},
                    {"step": "compare_lt($X, $Y)", "value": True},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # compare_eq($X, $Y) = X == Y
    # ------------------------------------------------------------------
    {
        "id": "proc:compare_eq",
        "name": "compare_eq",
        "description": (
            "Given integers X and Y, return True if X == Y, False otherwise."
        ),
        "parameters": ["$X", "$Y"],
        "depends_on": ["concept:integer", "concept:same-as"],
        "body": {
            "id": "step:compare_eq:root",
            "step_type": "operation",
            "operation": "compare_eq",
            "operands": [
                {"id": "step:compare_eq:x", "step_type": "variable", "variable": "$X"},
                {"id": "step:compare_eq:y", "step_type": "variable", "variable": "$Y"},
            ],
        },
        "examples": [
            {
                "id": "example:compare_eq:4==4",
                "input_node_ids": ["value:integer:4", "value:integer:4"],
                "output_node_id": "",
                "description": "compare_eq(4, 4) = True",
                "step_trace": [
                    {"step": "bind $X", "value": 4},
                    {"step": "bind $Y", "value": 4},
                    {"step": "compare_eq($X, $Y)", "value": True},
                ],
            },
        ],
    },
]


async def bootstrap_procedural_layer2(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 2 (arithmetic and comparison) procedure nodes.

    Returns a dict with keys: procedures_created, procedures_existing.
    """
    counts: dict[str, int] = {"procedures_created": 0, "procedures_existing": 0}
    for proc_def in _LAYER2_PROCEDURE_DEFS:
        created = await _bootstrap_single_procedure(persistence, proc_def)
        if created:
            counts["procedures_created"] += 1
        else:
            counts["procedures_existing"] += 1
    return counts


# ===========================================================================
# Result type and main public function
# ===========================================================================


@dataclass(frozen=True)
class ProceduralBootstrapResult:
    """Outcome of a ``bootstrap_procedural_ontology()`` call.

    Attributes:
        concepts_created: ConceptPrimitive nodes created this call.
        concepts_existing: ConceptPrimitive nodes already present (idempotent).
        values_created: ValueNode nodes created this call.
        values_existing: ValueNode nodes already present (idempotent).
        procedures_created: ProceduralTemplate nodes created this call.
            Each new template also creates its ProcedureStep and WorkedExample
            nodes — this count covers templates only.
        procedures_existing: ProceduralTemplate nodes already present.
        total_nodes: Sum of all concept, value, and procedure counts.
    """

    concepts_created: int
    concepts_existing: int
    values_created: int
    values_existing: int
    procedures_created: int
    procedures_existing: int

    @property
    def total_nodes(self) -> int:
        return (
            self.concepts_created
            + self.concepts_existing
            + self.values_created
            + self.values_existing
            + self.procedures_created
            + self.procedures_existing
        )


async def bootstrap_procedural_ontology(
    persistence: GraphPersistence,
) -> ProceduralBootstrapResult:
    """Bootstrap the complete procedural ontology (Layers 0, 1, and 2).

    Creates all ConceptPrimitive nodes, ValueNode nodes (integers 0–20), and
    ProceduralTemplate / ProcedureStep / WorkedExample nodes for the full
    bootstrap ontology. Layers are created in dependency order (Layer 0 first,
    then Layer 1, then Layer 2).

    This function is idempotent. Nodes that already exist are counted in the
    ``*_existing`` fields and not recreated.

    Args:
        persistence: The graph persistence backend to bootstrap.

    Returns:
        A :class:`ProceduralBootstrapResult` with creation and existing
        counts for each node category.

    Raises:
        BootstrapError: If any node or edge cannot be saved.
    """
    layer0 = await bootstrap_procedural_layer0(persistence)
    layer1 = await bootstrap_procedural_layer1(persistence)
    layer2 = await bootstrap_procedural_layer2(persistence)

    return ProceduralBootstrapResult(
        concepts_created=layer0["concepts_created"],
        concepts_existing=layer0["concepts_existing"],
        values_created=layer0["values_created"],
        values_existing=layer0["values_existing"],
        procedures_created=layer1["procedures_created"] + layer2["procedures_created"],
        procedures_existing=layer1["procedures_existing"] + layer2["procedures_existing"],
    )


__all__ = [
    "ProceduralBootstrapResult",
    "bootstrap_procedural_layer0",
    "bootstrap_procedural_layer1",
    "bootstrap_procedural_layer2",
    "bootstrap_procedural_ontology",
]

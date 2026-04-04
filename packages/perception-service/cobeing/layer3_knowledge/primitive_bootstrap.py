"""Bootstrap the nine pre-linguistic primitive symbol nodes.

Seeds :PrimitiveSymbolNode nodes into the graph. These are the foundational
symbols that all symbolic reasoning is built on (conversation engine
architecture, docs/decisions/cobeing-foundational-architecture_3.md §1).

The nine primitives are:
    Self_Other, Entity, Relation, State, Time, Change, Cause, Valence, Means

They are distinct from ConceptPrimitive SCHEMA nodes (integer, set, etc.).
Primitives are pre-linguistic structural representations of how reality is
organized. Everything else in Sylphie's symbolic world is composable from
combinations of these.

This module is idempotent -- safe to call multiple times. Each call checks
for existing nodes before creating them.

Usage::

    from cobeing.layer3_knowledge.primitive_bootstrap import bootstrap_primitives

    result = await bootstrap_primitives(persistence)
    # result.created == 9  (first run)
    # result.created == 0  (subsequent runs)
"""

from __future__ import annotations

from dataclasses import dataclass

from cobeing.layer3_knowledge.protocols import GraphPersistence


# ---------------------------------------------------------------------------
# Primitive definitions (conversation engine architecture §1.1)
# ---------------------------------------------------------------------------

_PRIMITIVES: list[dict] = [
    {
        "node_id": "primitive:self_other",
        "name": "Self_Other",
        "description": (
            "The most fundamental distinction. There is me, and there is not-me. "
            "Every utterance requires knowing which side of this boundary something "
            "falls on. 'I' and 'you' are language that maps here, but the symbol "
            "exists before the words do."
        ),
    },
    {
        "node_id": "primitive:entity",
        "name": "Entity",
        "description": (
            "Something exists as a discrete thing. The ability to draw a boundary "
            "around something and recognize it as a unit distinct from other things. "
            "Before you can reason about a person, object, or concept, you need this."
        ),
    },
    {
        "node_id": "primitive:relation",
        "name": "Relation",
        "description": (
            "Things connect to other things. Not any specific relationship -- just "
            "the raw concept that entities are not isolated. This is what makes the "
            "graph possible in the first place."
        ),
    },
    {
        "node_id": "primitive:state",
        "name": "State",
        "description": (
            "Something has a condition right now. Not what the condition is "
            "specifically, just that entities have a 'how they are' that can differ "
            "from how they were."
        ),
    },
    {
        "node_id": "primitive:time",
        "name": "Time",
        "description": (
            "The dimension along which states exist. Enables the distinction between: "
            "this IS the case, this WAS the case, this MIGHT BE the case. Also "
            "provides decay and reinforcement for confidence -- a symbol mapping "
            "validated long ago and never again should lose confidence."
        ),
    },
    {
        "node_id": "primitive:change",
        "name": "Change",
        "description": (
            "States are not permanent. Represents the transition between states, "
            "while Time handles the when. Explicitly dependent on State and Time."
        ),
    },
    {
        "node_id": "primitive:cause",
        "name": "Cause",
        "description": (
            "Change is not random. Something produces something else. The primitive "
            "that eventually enables understanding of intent, consequence, and "
            "reasoning."
        ),
    },
    {
        "node_id": "primitive:valence",
        "name": "Valence",
        "description": (
            "Things have a toward-or-away quality. Not emotions -- just the most "
            "basic positive/negative polarity. Eventually enables understanding of "
            "preference, desire, avoidance, and goals."
        ),
    },
    {
        "node_id": "primitive:means",
        "name": "Means",
        "description": (
            "One thing stands for another thing. Distinct from Relation, which says "
            "'these two nodes are linked.' Means says 'this node represents or "
            "signifies that node in a different form.' This is the primitive that "
            "makes language comprehension possible -- language is entirely built on "
            "symbols that stand for things. The grounding process itself depends on "
            "this primitive: every time a word maps to a symbol, Means is in use."
        ),
    },
]


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PrimitiveBootstrapResult:
    """Outcome of a ``bootstrap_primitives()`` call.

    Attributes:
        created: Number of primitive nodes created this call.
        existing: Number of primitive nodes that already existed
            (idempotency count).
        total: Total primitives present in the graph after this call.
    """

    created: int
    existing: int
    total: int


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

#: Well-known node IDs for the nine primitives.
#: Use these constants when creating MEANS or BUILT_ON edges to primitives.
PRIMITIVE_NODE_IDS: list[str] = [p["node_id"] for p in _PRIMITIVES]


async def bootstrap_primitives(
    persistence: GraphPersistence,
) -> PrimitiveBootstrapResult:
    """Seed the nine PrimitiveSymbolNode nodes into the graph.

    Creates each of the nine primitive symbols if it does not already exist.
    Checks for each node before creating it (idempotent).

    The primitives are:
        - primitive:self_other  (Self_Other)
        - primitive:entity      (Entity)
        - primitive:relation    (Relation)
        - primitive:state       (State)
        - primitive:time        (Time)
        - primitive:change      (Change)
        - primitive:cause       (Cause)
        - primitive:valence     (Valence)
        - primitive:means       (Means)

    Args:
        persistence: The graph persistence backend. Must implement
            ``GraphPersistence`` including the primitive symbol methods
            added in Phase 1 of the conversation engine.

    Returns:
        A :class:`PrimitiveBootstrapResult` with counts of newly-created
        primitives, already-existing primitives, and total.
    """
    created = 0
    existing = 0

    for primitive in _PRIMITIVES:
        node_id = primitive["node_id"]

        existing_node = await persistence.get_primitive_symbol(node_id)
        if existing_node is not None:
            existing += 1
            continue

        await persistence.save_primitive_symbol(
            node_id=node_id,
            name=primitive["name"],
            description=primitive["description"],
        )
        created += 1

    return PrimitiveBootstrapResult(
        created=created,
        existing=existing,
        total=created + existing,
    )


__all__ = [
    "PRIMITIVE_NODE_IDS",
    "PrimitiveBootstrapResult",
    "bootstrap_primitives",
]

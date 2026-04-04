"""CANON A.5 narrow persistence-check interface.

This module implements the single, narrow read path that Layer 2 (Perception)
has into Layer 3 (Knowledge Graph). It answers one question: *has the system
seen this object before?*

The interface is intentionally narrow by design (CANON A.5). Layer 2 does
not have general read access to the knowledge graph. It may only invoke
``find_matching_object`` to determine whether a new observation corresponds
to an already-known instance node.

**Matching strategy:**

1. If the observation carries an embedding vector, use
   ``GraphPersistence.find_similar_nodes`` (cosine similarity, threshold=0.7).
   Similarity search is restricted to active Instance nodes -- any node with
   ``valid_to`` set (superseded) is filtered out before the result is returned.

2. Regardless of embedding presence, scan active Instance nodes for a
   ``label_raw`` property match against the observation's ``label_raw``.

3. Combine results with a clear preference order:
   - Embedding match wins over a pure label match.
   - If both match the same node, the embedding confidence is used.
   - If only a label match is found, confidence is fixed at 0.5 (weaker signal).
   - If neither matches, ``matched=False`` with ``confidence=0.0``.

4. Secondary matches (nodes above threshold but not the top result) are
   collected into ``alternatives``.

**Why 0.5 for label confidence?**

A ``label_raw`` match means two observations carry the same detector label
(e.g., both called "cup"). This is weak evidence of identity -- the scene
may contain two cups. Without an embedding to distinguish them, we record
a plausible match but signal its weakness via the 0.5 confidence floor.

**Active-node filtering:**

Only nodes with ``valid_to is None`` (still temporally valid) are candidates.
Superseded nodes represent stale knowledge and must not be matched as if they
were current objects.

Usage::

    from cobeing.layer3_knowledge.persistence_check import (
        find_matching_object,
        PersistenceResult,
    )
    from cobeing.layer3_knowledge.in_memory_persistence import InMemoryGraphPersistence

    persistence = InMemoryGraphPersistence()
    result = await find_matching_object(persistence, observation)

    if result.matched:
        print(f"Matched {result.candidate_node_id} via {result.match_type}")
    else:
        print("No match -- treat as new object")

See Also:
    - ``cobeing.layer3_knowledge.protocols`` -- GraphPersistence protocol
    - ``cobeing.layer3_knowledge.node_types`` -- KnowledgeNode, SchemaLevel
    - ``cobeing.shared.observation`` -- Observation
    - CANON A.5: Layer Communication Rules
"""

from __future__ import annotations

from dataclasses import dataclass, field

from cobeing.layer3_knowledge.node_types import SchemaLevel
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import NodeFilter
from cobeing.shared.observation import Observation
from cobeing.shared.types import NodeId

# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------

_EMBEDDING_THRESHOLD = 0.7
_LABEL_MATCH_CONFIDENCE = 0.5


@dataclass(frozen=True)
class PersistenceResult:
    """Result of a persistence check against the knowledge graph.

    Returned by ``find_matching_object`` to communicate whether a new
    observation corresponds to an already-known object, and how confident
    the match is.

    Attributes:
        matched: Whether any match was found. ``True`` means ``candidate_node_id``
            is set and ``confidence > 0``.
        candidate_node_id: The ``NodeId`` of the best-matching known object,
            or ``None`` if no match was found.
        confidence: Strength of the best match, on a 0.0 to 1.0 scale.
            Embedding matches carry the cosine similarity score (0.7 to 1.0).
            Label-only matches are fixed at 0.5. No match is 0.0.
        match_type: How the match was made: ``"embedding"`` for cosine
            similarity, ``"label"`` for label_raw string equality, or
            ``"none"`` when no match was found.
        alternatives: Other candidate node IDs that scored above the
            embedding threshold but were not selected as the best match.
            Empty when match_type is ``"label"`` or ``"none"``. Order is
            not guaranteed.
    """

    matched: bool
    candidate_node_id: NodeId | None
    confidence: float
    match_type: str
    alternatives: list[NodeId] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _no_match() -> PersistenceResult:
    """Return the canonical no-match result."""
    return PersistenceResult(
        matched=False,
        candidate_node_id=None,
        confidence=0.0,
        match_type="none",
        alternatives=[],
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def find_matching_object(
    persistence: GraphPersistence,
    observation: Observation,
) -> PersistenceResult:
    """The CANON A.5 narrow persistence-check interface.

    This is the ONLY way Layer 2 (Perception) reads from Layer 3. Given a
    new observation, determine whether a matching object already exists in
    the knowledge graph.

    Matching strategy:

    1. If the observation has an embedding, invoke ``find_similar_nodes``
       with threshold=0.7. Results are filtered to exclude superseded nodes
       (``valid_to is not None``).

    2. Query active Instance nodes and check for a ``label_raw`` match
       against ``observation.label_raw``.

    3. Combine results: embedding match wins over label match. If only a
       label match is found, confidence is fixed at 0.5. Secondary embedding
       matches populate ``alternatives``.

    Args:
        persistence: The graph storage backend to query. Only Instance nodes
            with ``valid_to is None`` (active) are considered as candidates.
        observation: The new observation from the perception pipeline.
            ``observation.embedding`` may be ``None`` -- embedding matching
            is skipped when it is absent.

    Returns:
        A ``PersistenceResult`` indicating whether a match was found, which
        node is the best candidate, the match confidence, and how the match
        was made. Always returns a concrete result (never raises for
        "no match" conditions).
    """
    # ------------------------------------------------------------------
    # Step 1: Embedding-based similarity search
    # ------------------------------------------------------------------
    embedding_candidate: NodeId | None = None
    embedding_confidence: float = 0.0
    embedding_alternatives: list[NodeId] = []

    if observation.embedding is not None:
        similar_pairs = await persistence.find_similar_nodes(
            embedding=observation.embedding,
            threshold=_EMBEDDING_THRESHOLD,
        )

        # Filter to active Instance nodes only (valid_to must be None).
        active_similar: list[tuple[NodeId, float]] = []
        for node, score in similar_pairs:
            if node.schema_level == SchemaLevel.INSTANCE and node.valid_to is None:
                active_similar.append((node.node_id, score))

        if active_similar:
            # Results are already sorted by descending score from find_similar_nodes.
            embedding_candidate, embedding_confidence = active_similar[0]
            embedding_alternatives = [nid for nid, _ in active_similar[1:]]

    # ------------------------------------------------------------------
    # Step 2: Label-based match among active Instance nodes
    # ------------------------------------------------------------------
    label_candidate: NodeId | None = None

    instance_filter = NodeFilter(
        node_type="ObjectInstance",
        schema_level=SchemaLevel.INSTANCE,
    )
    instance_nodes = await persistence.query_nodes(instance_filter)

    for node in instance_nodes:
        if node.valid_to is not None:
            # Superseded node -- skip.
            continue
        stored_label = node.properties.get("label_raw")
        if stored_label == observation.label_raw:
            label_candidate = node.node_id
            break  # First match suffices for label path.

    # ------------------------------------------------------------------
    # Step 3: Combine results, prefer embedding over label
    # ------------------------------------------------------------------
    if embedding_candidate is not None:
        return PersistenceResult(
            matched=True,
            candidate_node_id=embedding_candidate,
            confidence=embedding_confidence,
            match_type="embedding",
            alternatives=embedding_alternatives,
        )

    if label_candidate is not None:
        return PersistenceResult(
            matched=True,
            candidate_node_id=label_candidate,
            confidence=_LABEL_MATCH_CONFIDENCE,
            match_type="label",
            alternatives=[],
        )

    return _no_match()


__all__ = [
    "PersistenceResult",
    "find_matching_object",
]

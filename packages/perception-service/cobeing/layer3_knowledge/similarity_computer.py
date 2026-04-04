"""SIMILAR_TO edge computation for the Co-Being knowledge graph.

This module provides ``SimilarityComputer`` -- the component responsible for
computing pairwise cosine similarity between a newly ingested instance node
and all existing instance nodes that share the same ``label_raw``, then
creating bidirectional SIMILAR_TO edges for pairs whose similarity meets or
exceeds a configurable threshold.

**Role in the system:**

After Layer 2 ingests a new observation into the knowledge graph (Epic 2),
the similarity pipeline (Epic 4) runs: ``SimilarityComputer.compute_for_new_node``
is called with the new node's ID, its ``label_raw`` scope label, and its
embedding vector. The computer compares the embedding against all stored
instance-level embeddings within the same label scope, creates edges for
similar pairs, and returns a ``SimilarityComputedEvent`` summarising what was
written.

**Design decisions:**

- D4-01: Similarity score is pure cosine similarity of embeddings only.
  ``label_raw`` is a scope filter, not a feature in the score.
- Edges are bidirectional: both A→B and B→A are written atomically (two
  ``save_edge`` calls). Both directions share the same confidence value
  (the cosine similarity score).
- Edge IDs are deterministic (``similar-{source}-to-{target}``), so the
  upsert semantics of ``save_edge`` handle idempotency automatically.
- The similarity threshold is stored in a ``SimilarityComputationConfig``
  MetaSchema node. The computer creates this node on first use if absent,
  defaulting to 0.65. The threshold is cached in ``self._threshold`` after
  the first load to avoid repeated graph reads on every call.
- Provenance on SIMILAR_TO edges is ``INFERENCE`` -- the system computed
  these relationships from evidence; no human or sensor produced them
  directly (CANON A.11).

**Layer placement:**

This module is Layer 3 (Knowledge Graph). It reads and writes the graph
exclusively via the ``GraphPersistence`` protocol. It does not depend on
any outer layer.

Usage::

    from cobeing.layer3_knowledge import (
        InMemoryGraphPersistence, SimilarityComputer,
    )
    from cobeing.shared.types import CorrelationId, NodeId

    store = InMemoryGraphPersistence()
    computer = SimilarityComputer(persistence=store)

    event = await computer.compute_for_new_node(
        node_id=NodeId("inst-cup-001"),
        label_raw="cup",
        embedding=[0.9, 0.2, 0.0],
        correlation_id=CorrelationId("corr-abc-123"),
    )
    print(event.edges_created)  # number of new SIMILAR_TO edges written

See Also:
    - ``cobeing.layer3_knowledge.protocols`` -- GraphPersistence Protocol
    - ``cobeing.layer3_knowledge.similarity`` -- SimilarityComputedEvent, SimilarityResult
    - ``cobeing.layer3_knowledge.node_types`` -- KnowledgeNode, KnowledgeEdge, SchemaLevel
"""

from __future__ import annotations

import math
import uuid

from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.similarity import SimilarityComputedEvent, SimilarityResult
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import CorrelationId, EdgeId, NodeId

# ---------------------------------------------------------------------------
# Module-private constants
# ---------------------------------------------------------------------------

_CONFIG_NODE_TYPE: str = "SimilarityComputationConfig"
_DEFAULT_THRESHOLD: float = 0.65
_EMBEDDING_KEY: str = "embedding"
_SIMILAR_TO_EDGE_TYPE: str = "SIMILAR_TO"
_THRESHOLD_PROPERTY_KEY: str = "threshold"


# ---------------------------------------------------------------------------
# Module-private helpers
# ---------------------------------------------------------------------------


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute the cosine similarity between two equal-length vectors.

    Uses only the standard ``math`` module. Returns the cosine of the angle
    between the two vectors: 1.0 for identical direction, 0.0 for orthogonal,
    -1.0 for opposite direction.

    If either vector has zero magnitude (all zeros), returns 0.0 to avoid
    division by zero. A zero-length embedding is never considered similar to
    anything.

    This function is intentionally duplicated from
    ``cobeing.layer3_knowledge.in_memory_persistence`` rather than imported
    from it. Coupling a domain-layer computation module to a test-double
    implementation module would invert the dependency direction.

    Args:
        a: First vector. Must be the same length as ``b``.
        b: Second vector. Must be the same length as ``a``.

    Returns:
        Cosine similarity in the range ``[-1.0, 1.0]``. Returns 0.0 if
        either vector has zero magnitude.

    Raises:
        ValueError: If ``a`` and ``b`` have different lengths.
    """
    if len(a) != len(b):
        raise ValueError(
            f"Embedding length mismatch: {len(a)} vs {len(b)}. "
            "Cannot compute cosine similarity between vectors of different lengths."
        )

    dot_product = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))

    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0

    return dot_product / (norm_a * norm_b)


def _similar_edge_id(source: NodeId, target: NodeId) -> EdgeId:
    """Construct a deterministic edge ID for a directed SIMILAR_TO edge.

    The ID is deterministic so that repeated calls to ``save_edge`` with
    the same source/target pair result in an upsert rather than a duplicate.
    This is the primary idempotency mechanism for the similarity pipeline.

    Args:
        source: The node the edge originates from.
        target: The node the edge points to.

    Returns:
        An EdgeId of the form ``similar-{source}-to-{target}``.
    """
    return EdgeId(f"similar-{source}-to-{target}")


def _config_node_id() -> NodeId:
    """Construct the fixed NodeId for the SimilarityComputationConfig MetaSchema node.

    The config node uses a fixed, well-known ID so that the computer can
    fetch or create it without scanning the graph. The format matches the
    prefixed-UUID pattern used elsewhere in the codebase but is stable.

    Returns:
        A fixed NodeId for the SimilarityComputationConfig node.
    """
    return NodeId("meta-similarity-computation-config")


# ---------------------------------------------------------------------------
# SimilarityComputer
# ---------------------------------------------------------------------------


class SimilarityComputer:
    """Computes SIMILAR_TO edges between a new instance node and existing nodes.

    After each new instance node is ingested into the knowledge graph, this
    computer is invoked to compare it against all other instance-level nodes
    that share the same ``label_raw``. Pairs whose cosine similarity meets or
    exceeds the configured threshold receive bidirectional SIMILAR_TO edges.

    **Constructor injection:**

    The computer accepts a ``GraphPersistence`` at construction and uses it
    for all reads and writes. Tests inject ``InMemoryGraphPersistence``;
    production wires in the Neo4j adapter via the composition root.

    **Threshold configuration:**

    The similarity threshold is stored as a property on a MetaSchema node
    of type ``SimilarityComputationConfig``. On first call, the computer
    fetches (or creates) this node and caches the threshold value. Subsequent
    calls use the cached value. This means threshold changes require a
    process restart to take effect -- which is acceptable for Phase 1.

    **Idempotency:**

    Edge IDs are deterministic (``similar-{source}-to-{target}``). The
    ``save_edge`` upsert semantics mean that calling ``compute_for_new_node``
    twice for the same node produces the same edges and returns the same
    ``edges_created`` count only on the first call. The second call overwrites
    the existing edges with identical values -- the graph state is unchanged.
    If the caller needs to count *net-new* edges, it must track this externally.

    **Label scope:**

    ``label_raw`` is a strict equality filter applied before computing any
    scores. Nodes whose ``label_raw`` does not match are excluded entirely.
    The score itself is pure cosine similarity -- ``label_raw`` does not
    contribute to the numeric value (D4-01).

    Attributes:
        _persistence: The graph storage backend. Injected at construction.
        _threshold: Cached similarity threshold. ``None`` until first
            ``_ensure_config`` call.

    Example::

        store = InMemoryGraphPersistence()
        computer = SimilarityComputer(persistence=store)

        event = await computer.compute_for_new_node(
            node_id=NodeId("inst-001"),
            label_raw="cup",
            embedding=[0.9, 0.2, 0.0],
            correlation_id=CorrelationId("corr-xyz"),
        )
        assert event.edges_created >= 0
    """

    def __init__(self, persistence: GraphPersistence) -> None:
        """Initialise the computer with a graph persistence backend.

        Args:
            persistence: Any object satisfying the ``GraphPersistence`` Protocol.
                All graph reads and writes go through this object. Must not be
                ``None``.
        """
        self._persistence = persistence
        self._threshold: float | None = None  # lazy-loaded from config node

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _ensure_config(self) -> float:
        """Load or create the SimilarityComputationConfig MetaSchema node.

        On the first call, fetches the config node from the graph. If the
        node does not exist, it is created with the default threshold of
        ``_DEFAULT_THRESHOLD`` (0.65) and written to the graph. The resolved
        threshold is cached in ``self._threshold`` so subsequent calls return
        immediately without a graph read.

        The config node lives at ``SchemaLevel.META_SCHEMA`` because it
        governs how the schema evolves (similarity determines which instances
        are grouped into clusters, which in turn informs type proposals).

        Returns:
            The similarity threshold as a float in [0.0, 1.0].
        """
        if self._threshold is not None:
            return self._threshold

        config_id = _config_node_id()
        existing = await self._persistence.get_node(config_id)

        if existing is not None:
            raw = existing.properties.get(_THRESHOLD_PROPERTY_KEY, _DEFAULT_THRESHOLD)
            threshold = float(raw) if isinstance(raw, (int, float)) else _DEFAULT_THRESHOLD
        else:
            threshold = _DEFAULT_THRESHOLD
            config_node = KnowledgeNode(
                node_id=config_id,
                node_type=_CONFIG_NODE_TYPE,
                schema_level=SchemaLevel.META_SCHEMA,
                properties={_THRESHOLD_PROPERTY_KEY: threshold},
                provenance=Provenance(
                    source=ProvenanceSource.INFERENCE,
                    source_id="similarity-computer-bootstrap",
                    confidence=1.0,
                ),
                confidence=1.0,
                status=NodeStatus.ACTIVE,
            )
            await self._persistence.save_node(config_node)

        self._threshold = threshold
        return threshold

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def compute_for_new_node(
        self,
        node_id: NodeId,
        label_raw: str,
        embedding: list[float],
        correlation_id: CorrelationId,
    ) -> SimilarityComputedEvent:
        """Compute SIMILAR_TO edges for a newly ingested instance node.

        Compares ``embedding`` against all existing instance-level nodes
        whose ``properties["label_raw"]`` equals ``label_raw`` and whose
        ``properties["embedding"]`` is a stored list. For each candidate
        node above the similarity threshold, creates two directed edges:
        ``node_id -> candidate`` and ``candidate -> node_id`` (bidirectional).

        Both edges are written with:

        - ``edge_type``: ``"SIMILAR_TO"``
        - ``confidence``: the cosine similarity score of the pair
        - ``provenance.source``: ``INFERENCE``
        - Deterministic ``edge_id`` via ``_similar_edge_id`` (idempotent)

        No self-edge is created (candidate ``node_id == node_id`` is skipped).

        The ``label_raw`` argument is a scope filter only -- it is not
        incorporated into the similarity score (D4-01).

        Args:
            node_id: The NodeId of the newly ingested instance to compare.
            label_raw: The raw detection label (e.g., ``"cup"``) used to
                scope the search to nodes of the same detected category.
                Only nodes with a matching ``label_raw`` are considered.
            embedding: The embedding vector of the new node. Must be the
                same length as the embedding vectors stored on candidate nodes.
            correlation_id: Trace ID for structured logging. Propagated
                into the returned ``SimilarityComputedEvent``.

        Returns:
            A ``SimilarityComputedEvent`` recording:
            - ``observed_node_id``: the node that was processed.
            - ``edges_created``: number of directed SIMILAR_TO edges written
              in this call (0 if no candidates exceed the threshold). On a
              re-run for the same node, existing edges are overwritten with
              identical values -- ``edges_created`` still reflects the number
              of ``save_edge`` calls made, not the number of net-new edges.
            - ``label_raw``: the scope label passed in.
            - ``correlation_id``: the trace ID passed in.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
            ValueError: If ``embedding`` and a candidate's embedding have
                different lengths (indicates a schema inconsistency).
        """
        threshold = await self._ensure_config()

        candidates = await self._persistence.get_nodes_with_embedding(
            embedding_key=_EMBEDDING_KEY,
            schema_level=SchemaLevel.INSTANCE,
            label_raw=label_raw,
        )

        edges_created = 0

        for candidate in candidates:
            if candidate.node_id == node_id:
                # Never create a self-edge.
                continue

            candidate_embedding = candidate.properties.get(_EMBEDDING_KEY)
            if not isinstance(candidate_embedding, list):
                # Nodes without a valid list embedding are skipped.
                continue

            score = _cosine_similarity(embedding, candidate_embedding)

            # Clamp to [0.0, 1.0] to absorb floating-point overshoot,
            # matching the behaviour of SimilarityResult's validator.
            score = min(1.0, max(0.0, score))

            if score < threshold:
                continue

            # Build a SimilarityResult for the record (used internally to
            # validate the score before creating edges).
            _result = SimilarityResult(
                source_node_id=node_id,
                target_node_id=candidate.node_id,
                similarity_score=score,
                embedding_key=_EMBEDDING_KEY,
            )
            clamped_score = _result.similarity_score

            provenance = Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id=str(correlation_id),
                confidence=clamped_score,
            )

            # Forward edge: node_id -> candidate
            forward_edge = KnowledgeEdge(
                edge_id=_similar_edge_id(node_id, candidate.node_id),
                source_id=node_id,
                target_id=candidate.node_id,
                edge_type=_SIMILAR_TO_EDGE_TYPE,
                properties={},
                provenance=provenance,
                confidence=clamped_score,
            )
            await self._persistence.save_edge(forward_edge)
            edges_created += 1

            # Reverse edge: candidate -> node_id
            reverse_edge = KnowledgeEdge(
                edge_id=_similar_edge_id(candidate.node_id, node_id),
                source_id=candidate.node_id,
                target_id=node_id,
                edge_type=_SIMILAR_TO_EDGE_TYPE,
                properties={},
                provenance=provenance,
                confidence=clamped_score,
            )
            await self._persistence.save_edge(reverse_edge)
            edges_created += 1

        return SimilarityComputedEvent(
            observed_node_id=node_id,
            edges_created=edges_created,
            label_raw=label_raw,
            correlation_id=correlation_id,
        )


__all__ = ["SimilarityComputer"]

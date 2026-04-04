"""In-memory implementation of the GraphPersistence and BehavioralStore Protocols.

This module provides ``InMemoryGraphPersistence`` -- a complete, working
implementation of both the ``GraphPersistence`` and ``BehavioralStore``
Protocols backed by plain Python dicts and lists. It is the test double
used by all unit tests that need a persistence backend without a real
Neo4j instance.

**Why this exists:**

Every component that interacts with the knowledge graph accepts a
``GraphPersistence`` at its constructor (dependency injection). Unit tests
must be able to provide a real, functional backend without spinning up a
database. This class fills that role.

**What it does:**

- Stores nodes and edges in ``dict`` objects keyed by their IDs.
- Implements upsert semantics (save twice with the same ID replaces the first).
- Removes incident edges when a node is deleted.
- Filters nodes using ``NodeFilter`` with AND semantics.
- Filters edges using ``EdgeFilter`` with AND semantics (T303).
- Computes cosine similarity from scratch using the ``math`` module only.
- Respects half-open temporal windows ``[start, end)``.
- Stores PropertyExpectation records in a separate dict keyed by expectation_id.
- Tracks HAS_EXPECTATION edges in a set of (schema_type_id, expectation_id)
  pairs, avoiding duplication without mixing expectations into the node store.
- Builds SIMILAR_TO adjacency graphs via BFS to find connected components
  (SimilarityCluster) within a label group.
- Retrieves SchemaProposal nodes by ID (Epic 5, T052).
- Resolves the schema type of an instance node via INSTANCE_OF edge (Epic 5, T052).
- Stores all 6 behavioral data types in plain Python lists (Epic 5, T053).

**What it does NOT do:**

- Persist data across process restarts (it is in-memory).
- Enforce referential integrity (edges may reference non-existent nodes).
- Scale beyond a few thousand nodes/edges (not its purpose).

Usage::

    from cobeing.layer3_knowledge.in_memory_persistence import (
        InMemoryGraphPersistence,
    )
    from cobeing.layer3_knowledge.protocols import GraphPersistence, BehavioralStore

    store: GraphPersistence = InMemoryGraphPersistence()
    assert isinstance(store, GraphPersistence)
    assert isinstance(store, BehavioralStore)

    await store.save_node(my_node)
    retrieved = await store.get_node(my_node.node_id)

See Also:
    - ``cobeing.layer3_knowledge.protocols`` -- the GraphPersistence and BehavioralStore Protocols
    - ``cobeing.layer3_knowledge.node_types`` -- KnowledgeNode, KnowledgeEdge
    - ``cobeing.layer3_knowledge.query_types`` -- NodeFilter, EdgeFilter, TemporalWindow
    - ``cobeing.layer3_knowledge.expectation_types`` -- PropertyExpectation, SimilarityCluster
    - ``cobeing.layer3_knowledge.behavioral_events`` -- ProposalOutcome, CorrectionEvent, etc.
"""

from __future__ import annotations

import math
import uuid
from collections import defaultdict, deque
from typing import Any

from cobeing.layer3_knowledge.behavioral_events import (
    BehavioralBaseline,
    CorrectionEvent,
    GapLifecycleEvent,
    ProposalOutcome,
    SessionSummary,
    VerificationResult,
)
from cobeing.layer3_knowledge.expectation_types import PropertyExpectation, SimilarityCluster
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter, TemporalWindow
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.time_utils import utc_now
from cobeing.shared.types import EdgeId, NodeId


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute the cosine similarity between two equal-length vectors.

    Uses only the standard ``math`` module. Returns the cosine of the angle
    between the two vectors, which is 1.0 for identical direction, 0.0 for
    orthogonal, and -1.0 for opposite direction.

    If either vector has zero magnitude (all zeros), returns 0.0 to avoid
    division by zero. This matches the expected behavior when a node stores
    a zero-length embedding -- it should never be considered similar to
    anything.

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


def _new_node_id(prefix: str) -> NodeId:
    """Generate a unique NodeId with the given prefix."""
    return NodeId(f"{prefix}-{uuid.uuid4().hex[:12]}")


def _new_edge_id(prefix: str) -> EdgeId:
    """Generate a unique EdgeId with the given prefix."""
    return EdgeId(f"edge-{prefix}-{uuid.uuid4().hex[:12]}")


class InMemoryGraphPersistence:
    """In-memory implementation of the GraphPersistence and BehavioralStore Protocols.

    All data is stored in plain Python dicts and lists. This class is the test
    double for any component that depends on ``GraphPersistence`` or
    ``BehavioralStore``. It implements the full Protocol surface so that tests
    exercise real logic against real data structures.

    Instances are not thread-safe. All methods are async to satisfy the
    Protocol contract, but no I/O occurs -- the ``await`` yields control
    for one event loop tick then returns immediately.

    Attributes:
        _nodes: Dict mapping NodeId to KnowledgeNode. The single source
            of truth for all stored nodes.
        _edges: Dict mapping EdgeId to KnowledgeEdge. The single source
            of truth for all stored edges.
        _expectations: Dict mapping expectation_id (str) to
            PropertyExpectation. Separate from ``_nodes`` because
            PropertyExpectation is not a KnowledgeNode -- it is a
            domain aggregate that does not participate in node/edge queries.
        _has_expectation_edges: Set of (schema_type_id, expectation_id)
            pairs that record which HAS_EXPECTATION edges have been
            created. Used to enforce the "create once, no duplicates"
            constraint without adding edge records to ``_edges``.
        _proposal_outcomes: List of ProposalOutcome records (append-only).
        _correction_events: List of CorrectionEvent records (append-only).
        _verification_results: List of VerificationResult records (append-only).
        _gap_lifecycle_events: List of GapLifecycleEvent records (append-only).
        _session_summaries: List of SessionSummary records (append-only).
        _behavioral_baseline: The single active BehavioralBaseline, or None
            if no baseline has been computed yet.
        _closed: Whether ``close()`` has been called. After closing, the
            instance's dicts are empty and it behaves as a fresh store.
    """

    def __init__(self) -> None:
        self._nodes: dict[NodeId, KnowledgeNode] = {}
        self._edges: dict[EdgeId, KnowledgeEdge] = {}
        self._expectations: dict[str, PropertyExpectation] = {}
        self._has_expectation_edges: set[tuple[str, str]] = set()
        # BehavioralStore collections
        self._proposal_outcomes: list[ProposalOutcome] = []
        self._correction_events: list[CorrectionEvent] = []
        self._verification_results: list[VerificationResult] = []
        self._gap_lifecycle_events: list[GapLifecycleEvent] = []
        self._session_summaries: list[SessionSummary] = []
        self._behavioral_baseline: BehavioralBaseline | None = None
        self._primitive_symbols: dict[str, dict] = {}
        self._grounding_failures: dict[str, dict] = {}
        self._closed: bool = False

    # ------------------------------------------------------------------
    # Node CRUD
    # ------------------------------------------------------------------

    async def save_node(self, node: KnowledgeNode) -> None:
        """Persist a node. Overwrites any existing node with the same ID.

        Args:
            node: The node to store. If a node with ``node.node_id`` already
                exists, it is replaced entirely (upsert semantics).
        """
        self._nodes[node.node_id] = node

    async def get_node(self, node_id: NodeId) -> KnowledgeNode | None:
        """Retrieve a node by ID.

        Args:
            node_id: The identifier to look up.

        Returns:
            The node if it exists, or ``None`` if not found.
        """
        return self._nodes.get(node_id)

    async def delete_node(self, node_id: NodeId) -> bool:
        """Delete a node and all edges incident to it.

        Removes the node identified by ``node_id`` from the store. Also
        removes any edges where the node is the source or target, preventing
        dangling edge references.

        Args:
            node_id: The identifier of the node to delete.

        Returns:
            ``True`` if a node was found and deleted. ``False`` if no node
            with that ID existed (idempotent).
        """
        if node_id not in self._nodes:
            return False

        del self._nodes[node_id]

        # Remove all edges that reference this node (incoming or outgoing).
        incident_edge_ids = [
            edge_id
            for edge_id, edge in self._edges.items()
            if edge.source_id == node_id or edge.target_id == node_id
        ]
        for edge_id in incident_edge_ids:
            del self._edges[edge_id]

        return True

    # ------------------------------------------------------------------
    # Edge CRUD
    # ------------------------------------------------------------------

    async def save_edge(self, edge: KnowledgeEdge) -> None:
        """Persist an edge. Overwrites any existing edge with the same ID.

        Args:
            edge: The edge to store. If an edge with ``edge.edge_id`` already
                exists, it is replaced entirely (upsert semantics).
        """
        self._edges[edge.edge_id] = edge

    async def get_edge(self, edge_id: EdgeId) -> KnowledgeEdge | None:
        """Retrieve an edge by ID.

        Args:
            edge_id: The identifier to look up.

        Returns:
            The edge if it exists, or ``None`` if not found.
        """
        return self._edges.get(edge_id)

    async def delete_edge(self, edge_id: EdgeId) -> bool:
        """Delete an edge by ID.

        Does not affect the source or target nodes.

        Args:
            edge_id: The identifier of the edge to delete.

        Returns:
            ``True`` if an edge was found and deleted. ``False`` if no edge
            with that ID existed (idempotent).
        """
        if edge_id not in self._edges:
            return False

        del self._edges[edge_id]
        return True

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    async def query_nodes(self, filter: NodeFilter) -> list[KnowledgeNode]:
        """Return all nodes matching the given filter.

        All non-None filter fields are combined with AND semantics. A node
        must satisfy every criterion to appear in the result. An empty
        filter (all fields ``None``) returns all nodes.

        The ``temporal_window`` filter matches on ``valid_from`` using
        half-open interval ``[start, end)``.

        Args:
            filter: Structured filter controlling which nodes are returned.

        Returns:
            List of matching nodes. Order is insertion order (CPython dict
            ordering). May be empty if no nodes match.
        """
        results: list[KnowledgeNode] = []

        for node in self._nodes.values():
            if not self._node_matches_filter(node, filter):
                continue
            results.append(node)

        return results

    def _node_matches_filter(self, node: KnowledgeNode, filter: NodeFilter) -> bool:
        """Return True if ``node`` satisfies all criteria in ``filter``.

        Args:
            node: The node to test.
            filter: Filter criteria to apply. Each non-None field is checked.

        Returns:
            ``True`` if the node satisfies every non-None criterion.
            ``True`` unconditionally when all filter fields are ``None``.
        """
        if filter.node_type is not None and node.node_type != filter.node_type:
            return False

        if filter.schema_level is not None and node.schema_level != filter.schema_level:
            return False

        if filter.min_confidence is not None and node.confidence < filter.min_confidence:
            return False

        if filter.temporal_window is not None:
            window = filter.temporal_window
            if node.valid_from < window.start:
                return False
            if window.end is not None and node.valid_from >= window.end:
                return False

        return True

    async def find_similar_nodes(
        self,
        embedding: list[float],
        threshold: float = 0.8,
        limit: int = 10,
    ) -> list[tuple[KnowledgeNode, float]]:
        """Find nodes whose stored embeddings are similar to the query vector.

        Only nodes that have an ``"embedding"`` key in their ``properties``
        dict are considered. Similarity is measured by cosine similarity.
        Results are sorted by descending similarity score.

        Args:
            embedding: Query embedding vector.
            threshold: Minimum cosine similarity for inclusion (inclusive).
                Range 0.0 to 1.0. Default 0.8.
            limit: Maximum number of results to return.

        Returns:
            List of ``(node, similarity_score)`` tuples sorted by descending
            score. Each score is in the range ``[threshold, 1.0]``. Empty
            if no nodes have embeddings above the threshold.
        """
        candidates: list[tuple[KnowledgeNode, float]] = []

        for node in self._nodes.values():
            node_embedding = node.properties.get("embedding")
            if not isinstance(node_embedding, list):
                # Node has no embedding or embedding is not a list -- skip.
                continue

            # Guard against empty embedding lists.
            if len(node_embedding) == 0 or len(embedding) == 0:
                continue

            try:
                similarity = _cosine_similarity(embedding, node_embedding)
            except ValueError:
                # Dimension mismatch -- skip this node rather than crashing.
                continue

            if similarity >= threshold:
                candidates.append((node, similarity))

        # Sort by descending similarity score (highest first).
        candidates.sort(key=lambda pair: pair[1], reverse=True)

        return candidates[:limit]

    async def find_nodes_by_embedding(
        self,
        embedding: list[float],
        embedding_key: str = "embedding",
        min_similarity: float = 0.7,
        limit: int = 10,
        schema_level: SchemaLevel | None = None,
    ) -> list[tuple[KnowledgeNode, float]]:
        """Find nodes by direct embedding vector comparison.

        Unlike ``find_similar_nodes`` which always reads from the
        ``"embedding"`` property key, this method accepts an
        ``embedding_key`` parameter so callers can target alternative
        vector stores. An optional ``schema_level`` filter restricts the
        search to a single schema tier.

        Only nodes that have a non-empty list at
        ``node.properties[embedding_key]`` are candidates. Nodes without
        that key, or where the value is not a list, are silently skipped.

        Args:
            embedding: Query embedding vector.
            embedding_key: Key in ``node.properties`` where embeddings are
                stored. Defaults to ``"embedding"``.
            min_similarity: Minimum cosine similarity threshold (inclusive).
                Range 0.0 to 1.0. Default 0.7.
            limit: Maximum number of results to return.
            schema_level: Optional filter. When provided, only nodes at
                this schema tier are considered. When ``None``, all tiers
                are searched.

        Returns:
            List of ``(node, similarity_score)`` tuples sorted by descending
            score. Each score is in the range ``[min_similarity, 1.0]``.
            Empty if no nodes exceed the threshold.
        """
        candidates: list[tuple[KnowledgeNode, float]] = []

        for node in self._nodes.values():
            # Apply optional schema_level filter before touching embeddings.
            if schema_level is not None and node.schema_level != schema_level:
                continue

            node_embedding = node.properties.get(embedding_key)
            if not isinstance(node_embedding, list):
                # Node lacks the requested embedding key -- skip silently.
                continue

            # Guard against empty embedding lists.
            if len(node_embedding) == 0 or len(embedding) == 0:
                continue

            try:
                similarity = _cosine_similarity(embedding, node_embedding)
            except ValueError:
                # Dimension mismatch -- skip rather than crash.
                continue

            if similarity >= min_similarity:
                candidates.append((node, similarity))

        # Sort by descending similarity score (highest first).
        candidates.sort(key=lambda pair: pair[1], reverse=True)

        return candidates[:limit]

    async def get_nodes_in_temporal_window(
        self, window: TemporalWindow
    ) -> list[KnowledgeNode]:
        """Return nodes whose ``valid_from`` falls within the given window.

        Uses a half-open interval ``[window.start, window.end)``. If
        ``window.end`` is ``None``, all nodes with
        ``valid_from >= window.start`` are included.

        Args:
            window: The temporal range to query.

        Returns:
            List of matching nodes. May be empty.
        """
        results: list[KnowledgeNode] = []

        for node in self._nodes.values():
            if node.valid_from < window.start:
                continue
            if window.end is not None and node.valid_from >= window.end:
                continue
            results.append(node)

        return results

    # ------------------------------------------------------------------
    # Schema evolution
    # ------------------------------------------------------------------

    async def apply_type_split(
        self,
        original_type_id: NodeId,
        new_type_a_name: str,
        new_type_b_name: str,
        instances_for_a: list[NodeId],
        instances_for_b: list[NodeId],
        source_id: str,
    ) -> tuple[NodeId, NodeId]:
        """Split an existing SchemaType into two new types.

        Creates 2 new SchemaType nodes at SCHEMA level with INFERENCE
        provenance, migrates INSTANCE_OF edges from the original type to the
        appropriate new types, creates SPLIT_FROM edges linking the new types
        to the original, and marks the original type as SUPERSEDED.

        The operation sequence:
        1. Create SchemaType node A with INFERENCE provenance.
        2. Create SchemaType node B with INFERENCE provenance.
        3. For each instance in ``instances_for_a``: create INSTANCE_OF edge
           to type A, delete any existing INSTANCE_OF edge to original type.
        4. For each instance in ``instances_for_b``: create INSTANCE_OF edge
           to type B, delete any existing INSTANCE_OF edge to original type.
        5. Create SPLIT_FROM edge: type A -> original (INFERENCE, per D-TS-03).
        6. Create SPLIT_FROM edge: type B -> original (INFERENCE, per D-TS-03).
        7. Mark original type SUPERSEDED with valid_to set.

        Args:
            original_type_id: NodeId of the existing SchemaType to split.
            new_type_a_name: Name for the first new type.
            new_type_b_name: Name for the second new type.
            instances_for_a: NodeIds of instances to assign to type A.
            instances_for_b: NodeIds of instances to assign to type B.
            source_id: Identifier for provenance tracking on all created
                nodes and edges.

        Returns:
            Tuple of (new_type_a_id, new_type_b_id).
        """
        provenance = Provenance(
            source=ProvenanceSource.INFERENCE,
            source_id=source_id,
            confidence=1.0,
        )

        # ------------------------------------------------------------------
        # Step 1: Create new SchemaType node A.
        # ------------------------------------------------------------------
        new_type_a_id = _new_node_id("schema-type")
        type_a_node = KnowledgeNode(
            node_id=new_type_a_id,
            node_type="SchemaType",
            schema_level=SchemaLevel.SCHEMA,
            properties={
                "type_name": new_type_a_name,
                "original_type_id": str(original_type_id),
            },
            provenance=provenance,
            confidence=1.0,
        )
        await self.save_node(type_a_node)

        # ------------------------------------------------------------------
        # Step 2: Create new SchemaType node B.
        # ------------------------------------------------------------------
        new_type_b_id = _new_node_id("schema-type")
        type_b_node = KnowledgeNode(
            node_id=new_type_b_id,
            node_type="SchemaType",
            schema_level=SchemaLevel.SCHEMA,
            properties={
                "type_name": new_type_b_name,
                "original_type_id": str(original_type_id),
            },
            provenance=provenance,
            confidence=1.0,
        )
        await self.save_node(type_b_node)

        # ------------------------------------------------------------------
        # Step 3: Migrate instances_for_a: new INSTANCE_OF edge, delete old.
        # ------------------------------------------------------------------
        for inst_id in instances_for_a:
            # Create new INSTANCE_OF edge from instance to type A.
            new_edge = KnowledgeEdge(
                edge_id=_new_edge_id("instance-of"),
                source_id=inst_id,
                target_id=new_type_a_id,
                edge_type="INSTANCE_OF",
                provenance=provenance,
                confidence=1.0,
            )
            await self.save_edge(new_edge)

            # Delete old INSTANCE_OF edge from instance to original type.
            old_edge_ids = [
                eid
                for eid, e in self._edges.items()
                if (
                    e.edge_type == "INSTANCE_OF"
                    and e.source_id == inst_id
                    and e.target_id == original_type_id
                )
            ]
            for eid in old_edge_ids:
                del self._edges[eid]

        # ------------------------------------------------------------------
        # Step 4: Migrate instances_for_b: new INSTANCE_OF edge, delete old.
        # ------------------------------------------------------------------
        for inst_id in instances_for_b:
            # Create new INSTANCE_OF edge from instance to type B.
            new_edge = KnowledgeEdge(
                edge_id=_new_edge_id("instance-of"),
                source_id=inst_id,
                target_id=new_type_b_id,
                edge_type="INSTANCE_OF",
                provenance=provenance,
                confidence=1.0,
            )
            await self.save_edge(new_edge)

            # Delete old INSTANCE_OF edge from instance to original type.
            old_edge_ids = [
                eid
                for eid, e in self._edges.items()
                if (
                    e.edge_type == "INSTANCE_OF"
                    and e.source_id == inst_id
                    and e.target_id == original_type_id
                )
            ]
            for eid in old_edge_ids:
                del self._edges[eid]

        # ------------------------------------------------------------------
        # Step 5: Create SPLIT_FROM edge: type A -> original.
        # ------------------------------------------------------------------
        split_from_a = KnowledgeEdge(
            edge_id=_new_edge_id("split-from"),
            source_id=new_type_a_id,
            target_id=original_type_id,
            edge_type="SPLIT_FROM",
            provenance=provenance,
            confidence=1.0,
        )
        await self.save_edge(split_from_a)

        # ------------------------------------------------------------------
        # Step 6: Create SPLIT_FROM edge: type B -> original.
        # ------------------------------------------------------------------
        split_from_b = KnowledgeEdge(
            edge_id=_new_edge_id("split-from"),
            source_id=new_type_b_id,
            target_id=original_type_id,
            edge_type="SPLIT_FROM",
            provenance=provenance,
            confidence=1.0,
        )
        await self.save_edge(split_from_b)

        # ------------------------------------------------------------------
        # Step 7: Mark original type as SUPERSEDED with valid_to set.
        # ------------------------------------------------------------------
        original_node = self._nodes.get(original_type_id)
        if original_node is not None:
            original_node.status = NodeStatus.SUPERSEDED
            original_node.valid_to = utc_now()
            # save_node upserts in place (same dict key).
            await self.save_node(original_node)

        return (new_type_a_id, new_type_b_id)

    # ------------------------------------------------------------------
    # Expectation management (Epic 4, T043b)
    # ------------------------------------------------------------------

    async def get_property_expectations(
        self, schema_type_id: NodeId
    ) -> list[PropertyExpectation]:
        """Return all PropertyExpectation records for the given schema type.

        Scans ``_expectations`` for records whose ``schema_type_id`` matches
        the given node. Does not touch ``_nodes`` -- expectations are stored
        in their own dict.

        Args:
            schema_type_id: The NodeId of the SchemaType node to query.

        Returns:
            List of matching PropertyExpectation objects. Empty if none
            have been saved for this type.
        """
        return [
            exp
            for exp in self._expectations.values()
            if exp.schema_type_id == schema_type_id
        ]

    async def save_property_expectation(
        self, expectation: PropertyExpectation
    ) -> None:
        """Create or update a PropertyExpectation.

        Stores the expectation in ``_expectations`` keyed by
        ``expectation.expectation_id``. On first save, records the
        (schema_type_id, expectation_id) pair in ``_has_expectation_edges``
        to track that the HAS_EXPECTATION relationship has been established
        for this pair (D4-06 edge naming). Subsequent saves for the same
        expectation_id update the record without re-recording the edge.

        Args:
            expectation: The PropertyExpectation to store. The
                ``expectation_id`` field is used as the storage key.
        """
        is_new = expectation.expectation_id not in self._expectations
        self._expectations[expectation.expectation_id] = expectation

        if is_new:
            # Record that the HAS_EXPECTATION relationship from schema_type
            # to this expectation now exists. This is intentionally not a
            # KnowledgeEdge in _edges -- expectations are not KnowledgeNodes
            # and do not participate in general edge traversal.
            edge_key = (str(expectation.schema_type_id), expectation.expectation_id)
            self._has_expectation_edges.add(edge_key)

    async def get_nodes_with_embedding(
        self,
        embedding_key: str,
        schema_level: SchemaLevel,
        label_raw: str | None = None,
    ) -> list[KnowledgeNode]:
        """Return all nodes at ``schema_level`` that have ``embedding_key`` set.

        Scans ``_nodes`` for nodes at the specified schema level whose
        ``properties`` dict contains a list value at ``embedding_key``.
        Nodes where the value is not a list are excluded.

        If ``label_raw`` is provided, additionally filters to nodes where
        ``node.properties.get("label_raw") == label_raw``. This is a strict
        equality filter (D4-01: filter, not weight).

        Args:
            embedding_key: Property key to look for (e.g., ``"embedding"``).
            schema_level: Only nodes at this tier are considered.
            label_raw: Optional YOLO class label filter. When provided, only
                nodes whose ``label_raw`` property exactly matches are returned.

        Returns:
            List of qualifying nodes. May be empty.
        """
        results: list[KnowledgeNode] = []

        for node in self._nodes.values():
            if node.schema_level != schema_level:
                continue

            node_embedding = node.properties.get(embedding_key)
            if not isinstance(node_embedding, list):
                continue

            if label_raw is not None and node.properties.get("label_raw") != label_raw:
                continue

            results.append(node)

        return results

    async def get_similar_to_cluster(
        self,
        label_raw: str,
        min_similarity: float,
        min_cluster_size: int,
    ) -> list[SimilarityCluster]:
        """Find connected components in the SIMILAR_TO edge graph.

        Algorithm:
        1. Collect all INSTANCE-level nodes whose ``label_raw`` property
           matches the given string. These are the candidate members.
        2. Collect all SIMILAR_TO edges whose source and target are both in
           the candidate set and whose confidence >= ``min_similarity``.
        3. Build an undirected adjacency graph (both directions) from those
           edges.
        4. Find connected components via BFS.
        5. Discard components with fewer than ``min_cluster_size`` members.
        6. For each qualifying component:
           a. Compute ``mean_pairwise_similarity``: average confidence of all
              SIMILAR_TO edges between nodes within the component.
           b. Identify centroid: node with highest average SIMILAR_TO edge
              confidence to other members in its component.
           c. Collect ``session_ids`` from ``node.properties["session_id"]``.
           d. Compute ``label_raw_distribution`` from ``node.properties["label_raw"]``.
        7. Compute cross-cluster similarity:
           - For each cluster pair, compute the average SIMILAR_TO edge
             confidence between all node pairs crossing the two clusters.
           - ``mean_cross_similarity`` for cluster C is the average over all
             other qualifying clusters of their cross-cluster similarity to C.
           - If no other clusters exist, ``mean_cross_similarity = 0.0``.
        8. Compute ``contrast_ratio = mean_pairwise_similarity /
           mean_cross_similarity``, or ``float('inf')`` when
           ``mean_cross_similarity == 0.0``.

        Note on edge direction: SIMILAR_TO edges are stored as directed but
        represent symmetric relationships. Both (A->B) and (B->A) directions
        are used when building the adjacency graph. When computing mean
        pairwise similarity, each undirected pair is counted once using the
        maximum confidence found in either direction (directional duplicates
        are deduplicated by node-pair key).

        Args:
            label_raw: YOLO class label. Only INSTANCE-level nodes with
                this label are considered.
            min_similarity: Minimum SIMILAR_TO edge confidence to count as
                a connection. Edges below this threshold do not link nodes.
            min_cluster_size: Minimum component size to be returned.

        Returns:
            List of SimilarityCluster objects. May be empty.
        """
        # ------------------------------------------------------------------
        # Step 1: Collect candidate nodes (INSTANCE-level, matching label).
        # ------------------------------------------------------------------
        candidate_ids: set[NodeId] = {
            nid
            for nid, node in self._nodes.items()
            if (
                node.schema_level == SchemaLevel.INSTANCE
                and node.properties.get("label_raw") == label_raw
            )
        }

        if not candidate_ids:
            return []

        # ------------------------------------------------------------------
        # Step 2: Collect qualifying SIMILAR_TO edges within the candidate set.
        # For each undirected pair we keep the highest confidence found in
        # either direction.
        # ------------------------------------------------------------------
        # pair_key -> highest confidence seen
        pair_confidence: dict[tuple[NodeId, NodeId], float] = {}

        for edge in self._edges.values():
            if edge.edge_type != "SIMILAR_TO":
                continue
            if edge.source_id not in candidate_ids or edge.target_id not in candidate_ids:
                continue
            if edge.confidence < min_similarity:
                continue
            # Normalise to (smaller, larger) so each pair is stored once.
            a, b = edge.source_id, edge.target_id
            pair_key = (a, b) if a < b else (b, a)
            current = pair_confidence.get(pair_key, 0.0)
            if edge.confidence > current:
                pair_confidence[pair_key] = edge.confidence

        # ------------------------------------------------------------------
        # Step 3: Build undirected adjacency graph from qualifying edges.
        # ------------------------------------------------------------------
        adjacency: dict[NodeId, set[NodeId]] = defaultdict(set)
        for (a, b) in pair_confidence:
            adjacency[a].add(b)
            adjacency[b].add(a)

        # ------------------------------------------------------------------
        # Step 4: BFS to find connected components over ALL candidate nodes.
        # ------------------------------------------------------------------
        visited: set[NodeId] = set()
        raw_components: list[list[NodeId]] = []

        for start in candidate_ids:
            if start in visited:
                continue
            component: list[NodeId] = []
            queue: deque[NodeId] = deque([start])
            visited.add(start)
            while queue:
                current_id = queue.popleft()
                component.append(current_id)
                for neighbour in adjacency.get(current_id, set()):
                    if neighbour not in visited:
                        visited.add(neighbour)
                        queue.append(neighbour)
            raw_components.append(component)

        # ------------------------------------------------------------------
        # Step 5: Discard components below the size threshold.
        # ------------------------------------------------------------------
        qualifying: list[list[NodeId]] = [
            comp for comp in raw_components if len(comp) >= min_cluster_size
        ]

        if not qualifying:
            return []

        # ------------------------------------------------------------------
        # Step 6a: Compute mean_pairwise_similarity for each component.
        # Only edges within the component are counted.
        # ------------------------------------------------------------------
        def _mean_pairwise(members: list[NodeId]) -> float:
            member_set = set(members)
            within_confidences = [
                conf
                for (a, b), conf in pair_confidence.items()
                if a in member_set and b in member_set
            ]
            if not within_confidences:
                return 0.0
            return sum(within_confidences) / len(within_confidences)

        # ------------------------------------------------------------------
        # Step 6b: Identify centroid (node with highest avg within-cluster
        # SIMILAR_TO confidence to the other members).
        # ------------------------------------------------------------------
        def _find_centroid(members: list[NodeId]) -> NodeId:
            best_node = members[0]
            best_avg = -1.0
            for candidate in members:
                total = 0.0
                count = 0
                for other in members:
                    if other == candidate:
                        continue
                    a, b = candidate, other
                    pair_key = (a, b) if a < b else (b, a)
                    if pair_key in pair_confidence:
                        total += pair_confidence[pair_key]
                        count += 1
                avg = total / count if count > 0 else 0.0
                if avg > best_avg:
                    best_avg = avg
                    best_node = candidate
            return best_node

        # ------------------------------------------------------------------
        # Step 6c+d: Collect session_ids and label_raw_distribution.
        # ------------------------------------------------------------------
        def _collect_session_ids(members: list[NodeId]) -> list[str]:
            seen: set[str] = set()
            result: list[str] = []
            for nid in members:
                node = self._nodes.get(nid)
                if node is None:
                    continue
                sid = node.properties.get("session_id")
                if isinstance(sid, str) and sid not in seen:
                    seen.add(sid)
                    result.append(sid)
            return result

        def _label_distribution(members: list[NodeId]) -> dict[str, int]:
            counts: dict[str, int] = defaultdict(int)
            for nid in members:
                node = self._nodes.get(nid)
                if node is None:
                    continue
                lbl = node.properties.get("label_raw")
                if isinstance(lbl, str):
                    counts[lbl] += 1
            return dict(counts)

        # ------------------------------------------------------------------
        # Build intermediate cluster data (before contrast_ratio, which
        # requires all cluster centroids to exist first).
        # ------------------------------------------------------------------
        component_data: list[tuple[list[NodeId], NodeId, float]] = []
        for comp in qualifying:
            mean_pw = _mean_pairwise(comp)
            centroid = _find_centroid(comp)
            component_data.append((comp, centroid, mean_pw))

        # ------------------------------------------------------------------
        # Step 7: Compute cross-cluster similarity between each pair of
        # clusters. Cross-cluster similarity between cluster A and cluster B
        # is the average pair_confidence over all (node_in_A, node_in_B) pairs
        # that have a qualifying SIMILAR_TO edge between them.
        # ------------------------------------------------------------------
        n_clusters = len(component_data)

        def _cross_similarity(
            members_a: list[NodeId], members_b: list[NodeId]
        ) -> float:
            """Average SIMILAR_TO confidence between nodes in two distinct clusters."""
            set_a = set(members_a)
            set_b = set(members_b)
            cross_confidences = [
                conf
                for (a, b), conf in pair_confidence.items()
                if (a in set_a and b in set_b) or (a in set_b and b in set_a)
            ]
            if not cross_confidences:
                return 0.0
            return sum(cross_confidences) / len(cross_confidences)

        # For each cluster, compute its mean cross-cluster similarity to all
        # other qualifying clusters (average of pairwise cross-similarities).
        mean_cross_similarities: list[float] = []
        for i, (comp_i, _, _) in enumerate(component_data):
            if n_clusters == 1:
                mean_cross_similarities.append(0.0)
                continue
            cross_values = [
                _cross_similarity(comp_i, component_data[j][0])
                for j in range(n_clusters)
                if j != i
            ]
            mean_cross_similarities.append(
                sum(cross_values) / len(cross_values) if cross_values else 0.0
            )

        # ------------------------------------------------------------------
        # Step 8: Assemble SimilarityCluster objects.
        # ------------------------------------------------------------------
        clusters: list[SimilarityCluster] = []
        for idx, (comp, centroid, mean_pw) in enumerate(component_data):
            mean_cross = mean_cross_similarities[idx]
            contrast = (
                mean_pw / mean_cross if mean_cross > 0.0 else float("inf")
            )
            clusters.append(
                SimilarityCluster(
                    member_node_ids=[NodeId(nid) for nid in comp],
                    centroid_node_id=centroid,
                    mean_pairwise_similarity=mean_pw,
                    mean_cross_similarity=mean_cross,
                    contrast_ratio=contrast,
                    label_raw_distribution=_label_distribution(comp),
                    session_ids=_collect_session_ids(comp),
                )
            )

        return clusters

    # ------------------------------------------------------------------
    # Epic 5 queries (T052)
    # ------------------------------------------------------------------

    async def get_schema_proposal(self, proposal_id: NodeId) -> KnowledgeNode | None:
        """Retrieve a SchemaProposal node by its node_id.

        Looks up the node by ID and returns it only if it exists and its
        ``node_type`` is ``"SchemaProposal"``. Returns ``None`` for any
        other node type or for unknown IDs.

        Args:
            proposal_id: The NodeId of the SchemaProposal to retrieve.

        Returns:
            The SchemaProposal KnowledgeNode if found and correctly typed,
            or ``None`` if no node with that ID exists or it is not a
            SchemaProposal.
        """
        node = self._nodes.get(proposal_id)
        if node is None or node.node_type != "SchemaProposal":
            return None
        return node

    async def get_instance_type(self, instance_node_id: NodeId) -> NodeId | None:
        """Find the schema type that an instance node is typed as.

        Iterates ``_edges`` to find the first edge where ``source_id``
        matches ``instance_node_id`` and ``edge_type`` is ``"INSTANCE_OF"``.
        Returns the ``target_id`` of that edge, which is the NodeId of the
        schema type.

        Args:
            instance_node_id: The NodeId of an instance-level node.

        Returns:
            The NodeId of the schema type connected via INSTANCE_OF edge,
            or ``None`` if the instance has no INSTANCE_OF edge (untyped).
        """
        for edge in self._edges.values():
            if edge.source_id == instance_node_id and edge.edge_type == "INSTANCE_OF":
                return edge.target_id
        return None

    async def query_edges(
        self, filter: EdgeFilter | None = None
    ) -> list[KnowledgeEdge]:
        """Retrieve edges matching a structured filter.

        This is the ``GraphPersistence`` Protocol implementation. All filter
        criteria combine with AND semantics. When ``filter`` is ``None`` or
        all filter fields are ``None``, every edge is returned.

        Args:
            filter: Optional structured filter. When ``None``, all stored
                edges are returned. When provided, only edges satisfying
                every non-None field are included:

                - ``edge_type``: exact match on ``edge.edge_type``.
                - ``source_node_id``: exact match on ``str(edge.source_id)``.
                - ``target_node_id``: exact match on ``str(edge.target_id)``.
                - ``min_confidence``: ``edge.confidence >= min_confidence``.

        Returns:
            List of matching edges. Order is insertion order. May be empty.
        """
        if filter is None:
            return list(self._edges.values())

        results: list[KnowledgeEdge] = []
        for edge in self._edges.values():
            if not self._edge_matches_filter(edge, filter):
                continue
            results.append(edge)
        return results

    def _edge_matches_filter(self, edge: KnowledgeEdge, filter: EdgeFilter) -> bool:
        """Return True if ``edge`` satisfies every non-None criterion in ``filter``.

        Args:
            edge: The edge to evaluate.
            filter: Criteria to apply. Each non-None field is checked.

        Returns:
            ``True`` if all non-None filter criteria are met. ``True``
            unconditionally when all filter fields are ``None``.
        """
        if filter.edge_type is not None and edge.edge_type != filter.edge_type:
            return False

        if filter.source_node_id is not None and str(edge.source_id) != filter.source_node_id:
            return False

        if filter.target_node_id is not None and str(edge.target_id) != filter.target_node_id:
            return False

        if filter.min_confidence is not None and edge.confidence < filter.min_confidence:
            return False

        return True

    # ------------------------------------------------------------------
    # BehavioralStore -- Proposal outcomes (Epic 5, T053)
    # ------------------------------------------------------------------

    async def save_proposal_outcome(self, outcome: ProposalOutcome) -> None:
        """Persist a ProposalOutcome record. Upsert by outcome_id.

        If a record with the same ``outcome_id`` already exists in the list,
        it is replaced in-place. Because ``ProposalOutcome`` is frozen and
        outcomes are append-only in normal operation, this situation should
        not arise -- but upsert keeps the contract idempotent.

        Args:
            outcome: The ProposalOutcome to persist.
        """
        for i, existing in enumerate(self._proposal_outcomes):
            if existing.outcome_id == outcome.outcome_id:
                self._proposal_outcomes[i] = outcome
                return
        self._proposal_outcomes.append(outcome)

    async def get_recent_proposal_outcomes(
        self, limit: int = 20
    ) -> list[ProposalOutcome]:
        """Retrieve recent proposal outcomes ordered by timestamp descending.

        Sorts all stored outcomes by their ``timestamp`` field in descending
        order (most recent first) and returns the first ``limit`` records.

        Args:
            limit: Maximum number of outcomes to return. Defaults to 20.

        Returns:
            List of ``ProposalOutcome`` ordered by ``timestamp`` descending.
            May be shorter than ``limit`` if fewer records exist.
        """
        sorted_outcomes = sorted(
            self._proposal_outcomes,
            key=lambda o: o.timestamp,
            reverse=True,
        )
        return sorted_outcomes[:limit]

    # ------------------------------------------------------------------
    # BehavioralStore -- Correction events (Epic 5, T053)
    # ------------------------------------------------------------------

    async def save_correction_event(self, event: CorrectionEvent) -> None:
        """Persist a CorrectionEvent record. Upsert by correction_id.

        If a record with the same ``correction_id`` already exists, it is
        replaced in-place. Corrections are append-only in normal operation;
        upsert keeps the contract idempotent.

        Args:
            event: The CorrectionEvent to persist.
        """
        for i, existing in enumerate(self._correction_events):
            if existing.correction_id == event.correction_id:
                self._correction_events[i] = event
                return
        self._correction_events.append(event)

    async def get_open_correction_events(self) -> list[CorrectionEvent]:
        """Retrieve correction events that still need verification.

        A correction is "open" if the number of VerificationResult records
        whose ``correction_id`` matches it is strictly less than that
        correction's ``verification_window_size``. These are the corrections
        whose post-split classification accuracy has not yet been fully
        measured.

        Returns:
            List of ``CorrectionEvent`` that are still awaiting full
            verification. Order matches insertion order. May be empty if all
            corrections have been fully verified.
        """
        open_corrections: list[CorrectionEvent] = []
        for correction in self._correction_events:
            count = sum(
                1
                for vr in self._verification_results
                if vr.correction_id == correction.correction_id
            )
            if count < correction.verification_window_size:
                open_corrections.append(correction)
        return open_corrections

    # ------------------------------------------------------------------
    # BehavioralStore -- Verification results (Epic 5, T053)
    # ------------------------------------------------------------------

    async def save_verification_result(self, result: VerificationResult) -> None:
        """Persist a VerificationResult record. Upsert by verification_id.

        If a record with the same ``verification_id`` already exists, it is
        replaced in-place.

        Args:
            result: The VerificationResult to persist.
        """
        for i, existing in enumerate(self._verification_results):
            if existing.verification_id == result.verification_id:
                self._verification_results[i] = result
                return
        self._verification_results.append(result)

    async def get_verification_results_for_correction(
        self, correction_id: str
    ) -> list[VerificationResult]:
        """Retrieve all verification results for a given correction.

        Filters ``_verification_results`` to records whose ``correction_id``
        field matches the given value. Order is insertion order.

        Args:
            correction_id: The CorrectionEvent.correction_id to query.

        Returns:
            List of matching VerificationResult records. May be empty if no
            results exist for this correction yet.
        """
        return [
            vr
            for vr in self._verification_results
            if vr.correction_id == correction_id
        ]

    # ------------------------------------------------------------------
    # BehavioralStore -- Gap lifecycle events (Epic 5, T053)
    # ------------------------------------------------------------------

    async def save_gap_lifecycle_event(self, event: GapLifecycleEvent) -> None:
        """Persist a GapLifecycleEvent record. Upsert by event_id.

        If a record with the same ``event_id`` already exists, it is
        replaced in-place. Lifecycle events are append-only in normal
        operation; upsert keeps the contract idempotent.

        Args:
            event: The GapLifecycleEvent to persist.
        """
        for i, existing in enumerate(self._gap_lifecycle_events):
            if existing.event_id == event.event_id:
                self._gap_lifecycle_events[i] = event
                return
        self._gap_lifecycle_events.append(event)

    async def get_gap_lifecycle_history(
        self, gap_id: str
    ) -> list[GapLifecycleEvent]:
        """Retrieve all lifecycle events for a given gap, ordered by timestamp ascending.

        Filters ``_gap_lifecycle_events`` to records whose ``gap_id`` matches
        the given value, then sorts by ``timestamp`` ascending so the returned
        list forms a chronological audit trail from first detection to
        resolution or expiry.

        Args:
            gap_id: The gap identifier to query.

        Returns:
            List of GapLifecycleEvent ordered by ``timestamp`` ascending
            (oldest first). May be empty if no events have been saved for
            this gap.
        """
        matching = [e for e in self._gap_lifecycle_events if e.gap_id == gap_id]
        return sorted(matching, key=lambda e: e.timestamp)

    # ------------------------------------------------------------------
    # BehavioralStore -- Session summaries (Epic 5, T053)
    # ------------------------------------------------------------------

    async def save_session_summary(self, summary: SessionSummary) -> None:
        """Persist a SessionSummary record. Upsert by session_id.

        If a record with the same ``session_id`` already exists, it is
        replaced in-place. Session summaries are produced once per session;
        upsert handles the rare case of a retry after a transient write
        failure.

        Args:
            summary: The SessionSummary to persist.
        """
        for i, existing in enumerate(self._session_summaries):
            if existing.session_id == summary.session_id:
                self._session_summaries[i] = summary
                return
        self._session_summaries.append(summary)

    async def get_recent_session_summaries(
        self, limit: int = 10
    ) -> list[SessionSummary]:
        """Retrieve recent session summaries ordered by session_number descending.

        Sorts all stored summaries by their ``session_number`` field in
        descending order (most recent first) and returns the first ``limit``
        records.

        Args:
            limit: Maximum number of summaries to return. Defaults to 10.

        Returns:
            List of ``SessionSummary`` ordered by ``session_number`` descending.
            May be shorter than ``limit`` if fewer records exist.
        """
        sorted_summaries = sorted(
            self._session_summaries,
            key=lambda s: s.session_number,
            reverse=True,
        )
        return sorted_summaries[:limit]

    # ------------------------------------------------------------------
    # BehavioralStore -- Behavioral baselines (Epic 5, T053)
    # ------------------------------------------------------------------

    async def save_behavioral_baseline(
        self, baseline: BehavioralBaseline
    ) -> None:
        """Persist a BehavioralBaseline record. Replaces any existing baseline.

        There is at most one active baseline stored at any time. Saving a new
        baseline replaces the previous one entirely (idempotent replace
        semantics). The replaced baseline is not retained -- callers must not
        depend on historical baseline retention in this backend.

        Args:
            baseline: The BehavioralBaseline to persist.
        """
        self._behavioral_baseline = baseline

    async def get_behavioral_baseline(self) -> BehavioralBaseline | None:
        """Retrieve the current behavioral baseline, if one exists.

        Returns:
            The stored ``BehavioralBaseline``, or ``None`` if no baseline
            has been saved yet (system is still in the warm-up period before
            enough sessions have accumulated).
        """
        return self._behavioral_baseline

    # ------------------------------------------------------------------
    # Primitive symbol operations (Conversation Engine Phase 1)
    # ------------------------------------------------------------------

    async def save_primitive_symbol(
        self,
        node_id: str,
        name: str,
        description: str,
    ) -> None:
        """Persist a primitive symbol. Upsert semantics."""
        self._primitive_symbols[node_id] = {
            "node_id": node_id,
            "name": name,
            "description": description,
        }

    async def get_primitive_symbol(
        self,
        node_id: str,
    ) -> dict | None:
        """Retrieve a primitive symbol by node_id. Returns None if not found."""
        return self._primitive_symbols.get(node_id)

    async def get_all_primitive_symbols(self) -> list[dict]:
        """Retrieve all primitive symbol nodes."""
        return list(self._primitive_symbols.values())

    # ------------------------------------------------------------------
    # Grounding failure operations (Conversation Engine Phase 2)
    # ------------------------------------------------------------------

    async def save_grounding_failure(
        self,
        node_id: str,
        triggering_word: str,
        surrounding_words: list[str],
        primitive_activation_snapshot: dict,
        session_id: str,
        timestamp: str,
    ) -> None:
        """Persist a grounding failure record. Upsert semantics."""
        self._grounding_failures[node_id] = {
            "node_id": node_id,
            "triggering_word": triggering_word,
            "surrounding_words": list(surrounding_words),
            "primitive_activation_snapshot": dict(primitive_activation_snapshot),
            "session_id": session_id,
            "timestamp": timestamp,
            "processed": False,
        }

    async def get_unprocessed_grounding_failures(
        self,
        limit: int = 50,
    ) -> list[dict]:
        """Retrieve unprocessed grounding failure records."""
        results = [
            rec for rec in self._grounding_failures.values()
            if not rec.get("processed", False)
        ]
        return results[:limit]

    async def mark_grounding_failures_processed(
        self,
        node_ids: list[str],
    ) -> None:
        """Mark grounding failure records as processed."""
        for node_id in node_ids:
            if node_id in self._grounding_failures:
                self._grounding_failures[node_id]["processed"] = True

    # ------------------------------------------------------------------
    # Operations
    # ------------------------------------------------------------------

    async def health_check(self) -> bool:
        """Return True. In-memory storage is always available.

        Returns:
            Always ``True`` -- there is no external resource to fail.
        """
        return True

    async def close(self) -> None:
        """Clear all stored data and mark this instance as closed.

        After calling ``close()``, the instance's dicts and lists are empty.
        Calling ``close()`` again has no effect (idempotent).
        """
        self._nodes.clear()
        self._edges.clear()
        self._expectations.clear()
        self._has_expectation_edges.clear()
        self._proposal_outcomes.clear()
        self._correction_events.clear()
        self._verification_results.clear()
        self._gap_lifecycle_events.clear()
        self._session_summaries.clear()
        self._behavioral_baseline = None
        self._closed = True

    # ------------------------------------------------------------------
    # Convenience inspection (not part of the Protocol)
    # ------------------------------------------------------------------

    @property
    def node_count(self) -> int:
        """Number of nodes currently stored. Not part of the Protocol.

        Useful for test assertions without having to await query_nodes().
        """
        return len(self._nodes)

    @property
    def edge_count(self) -> int:
        """Number of edges currently stored. Not part of the Protocol.

        Useful for test assertions without having to iterate over edges.
        """
        return len(self._edges)

    @property
    def expectation_count(self) -> int:
        """Number of PropertyExpectation records stored. Not part of the Protocol.

        Useful for test assertions without awaiting get_property_expectations().
        """
        return len(self._expectations)

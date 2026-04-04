"""Persistence protocols for the Co-Being knowledge graph.

This module defines two Protocol classes:

- ``GraphPersistence`` -- the abstract interface that all graph storage
  backends must satisfy. Covers node/edge CRUD, queries, schema evolution,
  expectation management, and operations.

- ``BehavioralStore`` -- the abstract interface for behavioral data storage.
  Covers proposal outcomes, correction events, verification results, gap
  lifecycle events, session summaries, and behavioral baselines. Kept
  separate from ``GraphPersistence`` because behavioral data operates at a
  different abstraction level: it records what the system has *learned*
  from guardian interaction rather than what is currently *known* about the
  world.

Both Protocols are decorated with ``@runtime_checkable`` so that
implementors do not need to explicitly inherit (structural subtyping),
while still allowing ``isinstance()`` checks at the composition root for
dependency injection validation.

**Why Protocols and not ABCs?**

Neither Protocol has shared implementation logic. Different backends
(in-memory for tests, Neo4j for production, TimescaleDB for behavioral data)
share no code -- only shape. A Protocol expresses that contract without
forcing an inheritance relationship that carries no value.

**Layer placement:**

Both Protocols live in Layer 3 (Knowledge Graph) because they define what
the *domain* needs from persistence. The domain does not know about Neo4j,
SQL, or file systems. Concrete implementations live in the infrastructure
layer and are injected at the composition root.

This is the "port" in ports-and-adapters architecture. Sentinel implements
the "adapters" (CANON: persistence interfaces are Sentinel's domain;
Forge owns the contract, not the implementation).

Usage::

    from cobeing.layer3_knowledge.protocols import GraphPersistence, BehavioralStore

    # At the composition root:
    graph: GraphPersistence = Neo4jGraphPersistence(driver)
    behavioral: BehavioralStore = TimescaleBehavioralStore(pool)

    # Or for testing:
    graph: GraphPersistence = InMemoryGraphPersistence()

    # Runtime checks (useful during DI wiring):
    assert isinstance(graph, GraphPersistence)
    assert isinstance(behavioral, BehavioralStore)

See Also:
    - ``cobeing.layer3_knowledge.node_types`` -- KnowledgeNode, KnowledgeEdge
    - ``cobeing.layer3_knowledge.query_types`` -- NodeFilter, EdgeFilter, TemporalWindow
    - ``cobeing.layer3_knowledge.expectation_types`` -- PropertyExpectation, SimilarityCluster
    - ``cobeing.layer3_knowledge.behavioral_events`` -- ProposalOutcome, CorrectionEvent, etc.
    - ``cobeing.shared.types`` -- NodeId, EdgeId
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from cobeing.layer3_knowledge.behavioral_events import (
    BehavioralBaseline,
    CorrectionEvent,
    GapLifecycleEvent,
    ProposalOutcome,
    SessionSummary,
    VerificationResult,
)
from cobeing.layer3_knowledge.expectation_types import PropertyExpectation, SimilarityCluster
from cobeing.layer3_knowledge.node_types import KnowledgeEdge, KnowledgeNode, SchemaLevel
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter, TemporalWindow
from cobeing.shared.types import EdgeId, NodeId


@runtime_checkable
class GraphPersistence(Protocol):
    """Contract for knowledge graph storage backends.

    Every method is async. Implementations may be backed by Neo4j,
    an in-memory dict (for testing), or any other storage engine.
    The caller never knows or cares which.

    **Node CRUD** -- create, read, delete individual nodes.

    **Edge CRUD** -- create, read, delete individual edges.

    **Query** -- structured queries using ``NodeFilter`` and ``EdgeFilter``
    (no raw query strings cross the domain boundary).

    **Similarity search** -- find nodes by embedding vector similarity.
    This is the mechanism behind the CANON A.5 narrow persistence-check
    interface ("is this the same object I saw before?").

    **Temporal queries** -- retrieve nodes within a time window.

    **Schema evolution** -- apply structural schema changes atomically
    (e.g., type splits) that would be unsafe to decompose into individual
    node/edge writes.

    **Expectation management** -- store and retrieve PropertyExpectation
    records that track statistical summaries of how properties are
    distributed across instance nodes per schema type (Epic 4, T043b).

    **Similarity clustering** -- retrieve connected components in the
    SIMILAR_TO edge graph within a label group, with within-cluster and
    cross-cluster similarity statistics (Epic 4, T043b).

    **Epic 5 queries** -- targeted lookups needed by the behavioral
    learning loop: retrieve a SchemaProposal node by ID, and find the
    schema type that an instance node is typed as (T052).

    **Operations** -- health check and graceful shutdown.

    All methods that accept identifiers use the strongly-typed ``NodeId``
    and ``EdgeId`` newtypes from ``cobeing.shared.types``.
    """

    # ------------------------------------------------------------------
    # Node CRUD
    # ------------------------------------------------------------------

    async def save_node(self, node: KnowledgeNode) -> None:
        """Persist a knowledge graph node.

        If a node with the same ``node_id`` already exists, it is
        overwritten (upsert semantics). This supports the mutable-node
        pattern where confidence, status, and temporal fields change
        over the node's lifetime.

        Args:
            node: The node to persist. Must have all required fields
                populated (node_id, node_type, schema_level, provenance,
                confidence).

        Raises:
            KnowledgeGraphError: If the storage backend rejects the write
                (e.g., constraint violation, connection failure).
        """
        ...

    async def get_node(self, node_id: NodeId) -> KnowledgeNode | None:
        """Retrieve a single node by its unique identifier.

        Args:
            node_id: The identifier of the node to retrieve.

        Returns:
            The node if found, or ``None`` if no node with that ID exists.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    async def delete_node(self, node_id: NodeId) -> bool:
        """Remove a node from the graph.

        Implementations should also remove all edges incident to the
        deleted node (both incoming and outgoing) to prevent dangling
        edge references.

        Args:
            node_id: The identifier of the node to delete.

        Returns:
            ``True`` if a node was found and deleted, ``False`` if no
            node with that ID existed (idempotent).

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    # ------------------------------------------------------------------
    # Edge CRUD
    # ------------------------------------------------------------------

    async def save_edge(self, edge: KnowledgeEdge) -> None:
        """Persist a knowledge graph edge (directed relationship).

        If an edge with the same ``edge_id`` already exists, it is
        overwritten (upsert semantics). The referenced source and target
        nodes are not validated for existence at the protocol level --
        implementations may or may not enforce referential integrity.

        Args:
            edge: The edge to persist. Must have all required fields
                populated (edge_id, source_id, target_id, edge_type,
                provenance, confidence).

        Raises:
            KnowledgeGraphError: If the storage backend rejects the write.
        """
        ...

    async def get_edge(self, edge_id: EdgeId) -> KnowledgeEdge | None:
        """Retrieve a single edge by its unique identifier.

        Args:
            edge_id: The identifier of the edge to retrieve.

        Returns:
            The edge if found, or ``None`` if no edge with that ID exists.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    async def delete_edge(self, edge_id: EdgeId) -> bool:
        """Remove an edge from the graph.

        Does not affect the source or target nodes -- only the
        relationship is removed.

        Args:
            edge_id: The identifier of the edge to delete.

        Returns:
            ``True`` if an edge was found and deleted, ``False`` if no
            edge with that ID existed (idempotent).

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    async def query_nodes(self, filter: NodeFilter) -> list[KnowledgeNode]:
        """Retrieve nodes matching a structured filter.

        All filter criteria combine with AND semantics. An empty filter
        (all fields ``None``) returns all nodes.

        Args:
            filter: Structured filter specifying which nodes to return.
                Supports filtering by node_type, schema_level,
                min_confidence, and temporal_window.

        Returns:
            A list of nodes matching all specified criteria. May be empty
            if no nodes match. Order is implementation-defined.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    async def query_edges(
        self, filter: EdgeFilter | None = None
    ) -> list[KnowledgeEdge]:
        """Retrieve edges matching a structured filter.

        All filter criteria combine with AND semantics. When ``filter`` is
        ``None`` or all fields on the filter are ``None``, every edge in
        the graph is returned.

        This is the primary read path for edges. The graph snapshot REST
        endpoint (E3) uses this method to retrieve all edges alongside nodes
        so the browser UI can render the full graph.

        Args:
            filter: Optional structured filter controlling which edges are
                returned. Supports filtering by ``edge_type``,
                ``source_node_id``, ``target_node_id``, and
                ``min_confidence``. When ``None``, all edges are returned.

        Returns:
            A list of edges matching all specified criteria. May be empty
            if no edges match. Order is implementation-defined.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    async def find_similar_nodes(
        self,
        embedding: list[float],
        threshold: float = 0.8,
        limit: int = 10,
    ) -> list[tuple[KnowledgeNode, float]]:
        """Find nodes with embeddings similar to the given vector.

        This is the mechanism behind the CANON A.5 narrow
        persistence-check interface: "is this the same object I saw
        before?" Layer 2 (Perception) uses this to match new detections
        against known objects without having general read access to
        the knowledge graph.

        Similarity is measured by cosine similarity. Nodes without
        embeddings stored in their properties are excluded from results.

        Args:
            embedding: The query embedding vector. Length must match
                the embedding vectors stored on nodes.
            threshold: Minimum cosine similarity score (inclusive) for
                a node to be included in results. Range 0.0 to 1.0.
                Default 0.8 (high similarity required).
            limit: Maximum number of results to return. Results are
                sorted by descending similarity score, so the top
                ``limit`` matches are returned.

        Returns:
            A list of ``(node, similarity_score)`` tuples, sorted by
            descending similarity score. Each score is in the range
            ``[threshold, 1.0]``. May be empty if no nodes exceed
            the threshold.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    async def find_nodes_by_embedding(
        self,
        embedding: list[float],
        embedding_key: str = "embedding",
        min_similarity: float = 0.7,
        limit: int = 10,
        schema_level: SchemaLevel | None = None,
    ) -> list[tuple[KnowledgeNode, float]]:
        """Find nodes by direct embedding vector comparison.

        Unlike ``find_similar_nodes`` which always looks in the
        ``"embedding"`` property key, this method accepts an
        ``embedding_key`` parameter so callers can target alternative
        vector stores on nodes. It also accepts an optional
        ``schema_level`` filter to restrict the search to a single
        schema tier without a separate query step.

        Used by Layer 2 persistence check to match observations against
        known objects without writing temporary nodes. The caller supplies
        the raw embedding vector of a fresh detection; this method finds
        the best-matching stored nodes.

        Similarity is measured by cosine similarity. Nodes that do not
        have a list value at ``node.properties[embedding_key]`` are
        silently skipped.

        Args:
            embedding: Query embedding vector.
            embedding_key: Key in ``node.properties`` where embeddings
                are stored. Defaults to ``"embedding"``.
            min_similarity: Minimum cosine similarity threshold
                (inclusive). Range 0.0 to 1.0. Default 0.7.
            limit: Maximum number of results to return. Results are
                sorted by descending similarity score.
            schema_level: Optional filter. When provided, only nodes at
                this schema tier are considered. When ``None``, all tiers
                are searched.

        Returns:
            A list of ``(node, similarity_score)`` tuples sorted by
            descending similarity score. Each score is in the range
            ``[min_similarity, 1.0]``. May be empty if no nodes exceed
            the threshold.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    async def get_nodes_in_temporal_window(
        self, window: TemporalWindow
    ) -> list[KnowledgeNode]:
        """Retrieve all nodes whose ``valid_from`` falls within a time window.

        The window is half-open: ``[window.start, window.end)``. If
        ``window.end`` is ``None``, all nodes with
        ``valid_from >= window.start`` are included (open-ended window).

        Args:
            window: The temporal range to query. Contains ``start``
                (inclusive) and optional ``end`` (exclusive).

        Returns:
            A list of nodes whose ``valid_from`` falls within the window.
            May be empty. Order is implementation-defined.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

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

        Creates 2 new SchemaType nodes, migrates INSTANCE_OF edges from the
        original type to the appropriate new types, and creates SPLIT_FROM
        edges linking new types back to the original.

        The operation follows this sequence:
        1. Create new SchemaType node A at SCHEMA level with INFERENCE provenance.
        2. Create new SchemaType node B at SCHEMA level with INFERENCE provenance.
        3. For each instance in ``instances_for_a``: create a new INSTANCE_OF
           edge from the instance to type A, then delete the old INSTANCE_OF
           edge from the instance to the original type (if it exists).
        4. For each instance in ``instances_for_b``: create a new INSTANCE_OF
           edge from the instance to type B, then delete the old INSTANCE_OF
           edge from the instance to the original type (if it exists).
        5. Create a SPLIT_FROM edge from type A to the original type with
           INFERENCE provenance (D-TS-03).
        6. Create a SPLIT_FROM edge from type B to the original type with
           INFERENCE provenance (D-TS-03).
        7. Mark the original type as SUPERSEDED (set ``status`` and
           ``valid_to``).

        SPLIT_FROM edge provenance: INFERENCE per D-TS-03.

        Args:
            original_type_id: NodeId of the existing SchemaType to split.
            new_type_a_name: Name for the first new type.
            new_type_b_name: Name for the second new type.
            instances_for_a: NodeIds of instances that should be assigned
                to type A.
            instances_for_b: NodeIds of instances that should be assigned
                to type B.
            source_id: Source identifier for provenance tracking. Used as
                ``provenance.source_id`` on all created nodes and edges.

        Returns:
            Tuple of (new_type_a_id, new_type_b_id).

        Raises:
            KnowledgeGraphError: If the storage backend rejects a write
                or the original type cannot be found.
        """
        ...

    # ------------------------------------------------------------------
    # Expectation management (Epic 4, T043b)
    # ------------------------------------------------------------------

    async def get_property_expectations(
        self, schema_type_id: NodeId
    ) -> list[PropertyExpectation]:
        """Retrieve all PropertyExpectation records for a given schema type.

        Returns every expectation whose ``schema_type_id`` matches the
        given node. Each record corresponds to a distinct property key
        being tracked for that type (e.g., ``"embedding"``, ``"area_px"``).

        Args:
            schema_type_id: The NodeId of the SchemaType node whose
                expectations to retrieve. Must be a SCHEMA-level node.

        Returns:
            A list of ``PropertyExpectation`` objects for the given type.
            Returns an empty list if no expectations have been saved for
            this type yet. Order is implementation-defined.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    async def save_property_expectation(
        self, expectation: PropertyExpectation
    ) -> None:
        """Create or update a PropertyExpectation.

        If no expectation with ``expectation.expectation_id`` exists,
        this is a create. A HAS_EXPECTATION edge is also created from the
        schema type node (``expectation.schema_type_id``) to the
        expectation record, per decision D4-06 (edge naming convention).
        The HAS_EXPECTATION edge is created once and is not duplicated on
        subsequent saves for the same expectation_id.

        If an expectation with that ID already exists, it is replaced
        entirely (upsert semantics). The HAS_EXPECTATION edge is not
        duplicated -- it already exists from the initial create.

        Args:
            expectation: The expectation record to persist. Must have
                ``expectation_id``, ``schema_type_id``, and ``property_key``
                populated with non-empty values.

        Raises:
            KnowledgeGraphError: If the storage backend rejects the write.
        """
        ...

    async def get_nodes_with_embedding(
        self,
        embedding_key: str,
        schema_level: SchemaLevel,
        label_raw: str | None = None,
    ) -> list[KnowledgeNode]:
        """Retrieve all nodes that have a given embedding property key.

        Scans the graph for nodes at the specified schema level whose
        ``properties`` dict contains a list value at ``embedding_key``.
        Nodes without that key, or where the value is not a list, are
        excluded.

        An optional ``label_raw`` filter further restricts results to
        nodes whose ``node.properties["label_raw"]`` matches the given
        string. Per D4-01, this is a strict filter -- it does not weight
        results -- so only exact matches are included.

        Args:
            embedding_key: The property key to look for (e.g.,
                ``"embedding"``, ``"visual_embedding"``). Only nodes
                that have a list value at this key are returned.
            schema_level: Restrict results to this schema tier. Use
                ``SchemaLevel.INSTANCE`` to find instance-level nodes
                with stored embeddings.
            label_raw: Optional YOLO class label filter. When provided,
                only nodes where ``node.properties.get("label_raw")``
                equals this string are returned (D4-01: filter, not
                weight). When ``None``, no label filtering is applied.

        Returns:
            A list of nodes satisfying all criteria. May be empty.
            Order is implementation-defined.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    async def get_similar_to_cluster(
        self,
        label_raw: str,
        min_similarity: float,
        min_cluster_size: int,
    ) -> list[SimilarityCluster]:
        """Find connected components in the SIMILAR_TO edge graph within a label group.

        Performs a BFS/DFS over SIMILAR_TO edges connecting INSTANCE-level
        nodes that share ``label_raw`` to identify connected components.
        Each component is a candidate cluster. Components with fewer than
        ``min_cluster_size`` members are excluded from the results.

        For each qualifying cluster:

        - ``member_node_ids``: All node IDs in the component.
        - ``centroid_node_id``: The node with the highest average SIMILAR_TO
          edge confidence to other members in its cluster.
        - ``mean_pairwise_similarity``: Average confidence of all SIMILAR_TO
          edges between nodes within the cluster.
        - ``mean_cross_similarity``: Average SIMILAR_TO edge confidence from
          this cluster's centroid to the centroids of all other qualifying
          clusters. If there are no other clusters, this is 0.0.
        - ``contrast_ratio``: ``mean_pairwise_similarity / mean_cross_similarity``
          when ``mean_cross_similarity > 0``, else ``float('inf')``. Per D4-02,
          this measures how much more cohesive a cluster is internally than
          it is similar to neighboring clusters.
        - ``label_raw_distribution``: Count of each ``label_raw`` property
          value among cluster members. Indicates label homogeneity.
        - ``session_ids``: Unique session identifiers from all member nodes'
          ``properties["session_id"]``. Multiple session IDs indicate
          cross-session stability.

        SIMILAR_TO edge direction: edges are stored as directed (source ->
        target) but similarity is symmetric. Both directions are considered
        when building the adjacency graph.

        Args:
            label_raw: The YOLO class label to restrict the search to.
                Only INSTANCE-level nodes with ``properties["label_raw"]
                == label_raw`` are considered.
            min_similarity: Minimum SIMILAR_TO edge confidence (inclusive)
                for an edge to count as a connection in the adjacency graph.
                Edges below this threshold do not link nodes into the same
                component.
            min_cluster_size: Minimum number of nodes for a component to
                be returned as a cluster. Components smaller than this
                are discarded.

        Returns:
            A list of ``SimilarityCluster`` objects, one per qualifying
            connected component. May be empty if no components meet the
            size threshold. Order is implementation-defined.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    # ------------------------------------------------------------------
    # Epic 5 queries (T052)
    # ------------------------------------------------------------------

    async def get_schema_proposal(self, proposal_id: NodeId) -> KnowledgeNode | None:
        """Retrieve a SchemaProposal node by its node_id.

        Args:
            proposal_id: The NodeId of the SchemaProposal to retrieve.

        Returns:
            The SchemaProposal KnowledgeNode if found, or None if no
            node with that ID exists or it is not a SchemaProposal.

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    async def get_instance_type(self, instance_node_id: NodeId) -> NodeId | None:
        """Find the schema type that an instance node is typed as.

        Follows the INSTANCE_OF edge from the instance to its schema type.

        Args:
            instance_node_id: The NodeId of an instance-level node.

        Returns:
            The NodeId of the schema type connected via INSTANCE_OF edge,
            or None if the instance has no type assignment (untyped instance).

        Raises:
            KnowledgeGraphError: If the storage backend cannot be reached.
        """
        ...

    # ------------------------------------------------------------------
    # Operations
    # ------------------------------------------------------------------

    async def health_check(self) -> bool:
        """Check whether the storage backend is reachable and operational.

        This is a lightweight probe -- it should not perform expensive
        queries or writes. Suitable for use in readiness checks and
        monitoring.

        Returns:
            ``True`` if the backend is healthy and ready to accept
            operations, ``False`` otherwise.
        """
        ...

    async def close(self) -> None:
        """Release resources held by the persistence backend.

        After calling ``close()``, the instance should not be used for
        further operations. Implementations should close connection
        pools, file handles, and any other resources.

        This method is idempotent -- calling it multiple times has no
        additional effect beyond the first call.
        """
        ...

    # ------------------------------------------------------------------
    # Primitive symbol operations (Conversation Engine Phase 1)
    # ------------------------------------------------------------------

    async def save_primitive_symbol(
        self,
        node_id: str,
        name: str,
        description: str,
    ) -> None:
        """Persist a PrimitiveSymbolNode. Upsert semantics.

        PrimitiveSymbolNode is a distinct Neo4j label from the three-level
        schema (Instance/Schema/MetaSchema). The nine primitives are
        pre-linguistic structural representations, not domain concepts.

        Args:
            node_id: Unique identifier (e.g., ``"primitive:self_other"``).
            name: Human-readable name (e.g., ``"Self_Other"``).
            description: Description of what this primitive represents.
        """
        ...

    async def get_primitive_symbol(
        self,
        node_id: str,
    ) -> dict | None:
        """Retrieve a PrimitiveSymbolNode by node_id.

        Args:
            node_id: The identifier to look up.

        Returns:
            Dict with keys ``node_id``, ``name``, ``description``,
            or ``None`` if no primitive with that ID exists.
        """
        ...

    async def get_all_primitive_symbols(self) -> list[dict]:
        """Retrieve all PrimitiveSymbolNode nodes.

        Returns:
            List of dicts with keys ``node_id``, ``name``, ``description``.
            Empty list if no primitives have been seeded.
        """
        ...

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
        """Persist a GroundingFailureRecord node. Upsert semantics.

        Created when a word arrives during InputParser processing and has
        zero MEANS edges to primitive symbols. Accumulated records are
        consumed during maintenance to propose MEANS edges.

        Args:
            node_id: Unique identifier (``"grounding-failure:{word}:{ts_ms}"``).
            triggering_word: The word that had no MEANS edges.
            surrounding_words: Tokens within the same phrase (context window).
            primitive_activation_snapshot: Primitives active from OTHER words
                in the same phrase (context for what meaning is expected).
                Dict of ``{primitive_node_id: weight}`` floats.
            session_id: Current session ID for grouping failures.
            timestamp: ISO-format UTC timestamp of the failure.
        """
        ...

    async def get_unprocessed_grounding_failures(
        self,
        limit: int = 50,
    ) -> list[dict]:
        """Retrieve unprocessed GroundingFailureRecord nodes.

        Used by the grounding maintenance engine to find failures accumulated
        since the last maintenance run.

        Args:
            limit: Maximum number of records to return. Defaults to 50.

        Returns:
            List of failure record dicts. Each dict has keys:
            ``node_id``, ``triggering_word``, ``surrounding_words``,
            ``primitive_activation_snapshot``, ``session_id``, ``timestamp``.
            Empty list if all records are already processed.
        """
        ...

    async def mark_grounding_failures_processed(
        self,
        node_ids: list[str],
    ) -> None:
        """Mark GroundingFailureRecord nodes as processed.

        Called by the grounding maintenance engine after proposing MEANS
        edges for the accumulated failures. Processed records are not
        returned by ``get_unprocessed_grounding_failures`` in subsequent calls.

        Args:
            node_ids: List of GroundingFailureRecord node_ids to mark.
        """
        ...


@runtime_checkable
class BehavioralStore(Protocol):
    """Contract for behavioral data storage backends.

    Separate from ``GraphPersistence`` because behavioral data (proposal
    outcomes, corrections, verification results, gap lifecycle events,
    session summaries, baselines) operates at a different abstraction level
    than the core knowledge graph. The graph stores *what is known about the
    world*. The behavioral store records *what the system has learned from
    guardian interaction*.

    Every method is async. Implementations may be backed by TimescaleDB,
    PostgreSQL, an in-memory dict (for testing), or any other storage engine.

    **Proposal outcomes** -- record guardian verdicts (approved, rejected,
    corrected, expired) on schema evolution proposals (Epic 5, T055).

    **Correction events** -- record guardian-ordered type splits, including
    the pre-correction instance snapshot required for verification (D5-10).

    **Verification results** -- record individual post-correction
    classification checks (Epic 5, T056a).

    **Gap lifecycle events** -- record transitions through the curiosity gap
    state machine (Epic 5, T057).

    **Session summaries** -- record aggregate counters and derived metrics
    for each observation session (Epic 5, T059).

    **Behavioral baselines** -- record per-metric statistical summaries
    computed across multiple sessions, used by the anomaly detector (T061).

    This is the "port" in ports-and-adapters architecture for behavioral
    data. Sentinel implements the "adapter" (CANON: persistence interfaces
    are Sentinel's domain; Forge owns the contract).
    """

    # ------------------------------------------------------------------
    # Proposal outcomes
    # ------------------------------------------------------------------

    async def save_proposal_outcome(self, outcome: ProposalOutcome) -> None:
        """Persist a ProposalOutcome record.

        If a record with the same ``outcome.outcome_id`` already exists,
        it is replaced (upsert semantics). Because ``ProposalOutcome`` is
        frozen, this situation should not arise in normal operation --
        outcomes are append-only -- but upsert is specified to keep the
        contract simple and idempotent.

        Args:
            outcome: The proposal outcome to persist. Must have all
                required fields populated (outcome_id, proposal_id,
                outcome, proposal_type, correlation_id).
        """
        ...

    async def get_recent_proposal_outcomes(
        self, limit: int = 20
    ) -> list[ProposalOutcome]:
        """Retrieve recent proposal outcomes ordered by timestamp descending.

        Used by the behavioral context provider (T058) to assess recent
        guardian response patterns. Returns only the most recent ``limit``
        records so callers do not have to page through all history.

        Args:
            limit: Maximum number of outcomes to return. Defaults to 20.
                Must be a positive integer.

        Returns:
            List of ``ProposalOutcome`` ordered by ``timestamp`` descending
            (most recent first). May be shorter than ``limit`` if fewer
            records exist. May be empty if no outcomes have been saved.
        """
        ...

    # ------------------------------------------------------------------
    # Correction events
    # ------------------------------------------------------------------

    async def save_correction_event(self, event: CorrectionEvent) -> None:
        """Persist a CorrectionEvent record.

        If a record with the same ``event.correction_id`` already exists,
        it is replaced (upsert semantics). Like outcomes, corrections are
        append-only in normal operation; upsert keeps the contract
        idempotent.

        Args:
            event: The correction event to persist. Must have all
                required fields populated (correction_id,
                original_type_id, new_type_ids, split_reason,
                instance_ids_at_split, correlation_id).
        """
        ...

    async def get_open_correction_events(self) -> list[CorrectionEvent]:
        """Retrieve correction events that still need verification.

        A correction is "open" if the number of ``VerificationResult``
        records whose ``correction_id`` matches it is less than that
        correction's ``verification_window_size``. These are the
        corrections whose post-split classification accuracy has not yet
        been fully measured.

        Used by the verification tracker (T056a) on startup to resume
        in-progress verification windows that may have been interrupted.

        Returns:
            List of ``CorrectionEvent`` that are still awaiting full
            verification (fewer ``VerificationResult`` records than
            ``verification_window_size``). Order is
            implementation-defined. May be empty if all corrections
            have been fully verified.
        """
        ...

    # ------------------------------------------------------------------
    # Verification results
    # ------------------------------------------------------------------

    async def save_verification_result(self, result: VerificationResult) -> None:
        """Persist a VerificationResult record.

        If a record with the same ``result.verification_id`` already
        exists, it is replaced (upsert semantics).

        Args:
            result: The verification result to persist. Must have all
                required fields populated (verification_id,
                correction_id, observation_id, classified_type_id,
                expected_type_id, correct, confidence_of_classification,
                correlation_id).
        """
        ...

    async def get_verification_results_for_correction(
        self, correction_id: str
    ) -> list[VerificationResult]:
        """Retrieve all verification results for a given correction.

        Used by the verification tracker (T056a) to compute aggregate
        accuracy when a verification window closes, and to determine
        how many results have already been collected for an open
        correction.

        Args:
            correction_id: The ``CorrectionEvent.correction_id`` to
                query. Must match the ``correction_id`` field on
                ``VerificationResult`` records.

        Returns:
            List of ``VerificationResult`` for the given
            ``correction_id``. Order is implementation-defined. May
            be empty if no results exist for this correction yet.
        """
        ...

    # ------------------------------------------------------------------
    # Gap lifecycle events
    # ------------------------------------------------------------------

    async def save_gap_lifecycle_event(self, event: GapLifecycleEvent) -> None:
        """Persist a GapLifecycleEvent record.

        If a record with the same ``event.event_id`` already exists,
        it is replaced (upsert semantics). Lifecycle events are
        append-only in normal operation; upsert keeps the contract
        idempotent.

        Args:
            event: The gap lifecycle event to persist. Must have all
                required fields populated (event_id, gap_id, old_state,
                new_state, correlation_id).
        """
        ...

    async def get_gap_lifecycle_history(
        self, gap_id: str
    ) -> list[GapLifecycleEvent]:
        """Retrieve all lifecycle events for a given gap, ordered by timestamp.

        Used by the gap manager (T057) to reconstruct the full history
        of a gap's state machine transitions. The returned list, sorted
        ascending by ``timestamp``, forms a complete audit trail from
        first detection to resolution or expiry.

        Args:
            gap_id: The gap identifier to query. Must match the
                ``gap_id`` field on ``GapLifecycleEvent`` records.

        Returns:
            List of ``GapLifecycleEvent`` ordered by ``timestamp``
            ascending (oldest first). May be empty if no events have
            been saved for this gap.
        """
        ...

    # ------------------------------------------------------------------
    # Session summaries
    # ------------------------------------------------------------------

    async def save_session_summary(self, summary: SessionSummary) -> None:
        """Persist a SessionSummary record.

        If a record with the same ``summary.session_id`` already exists,
        it is replaced (upsert semantics). Session summaries are
        produced once per session by the session accumulator (T059);
        upsert handles the rare case of a retry after a transient write
        failure.

        Args:
            summary: The session summary to persist. Must have all
                required fields populated (session_id, session_number,
                session_start, session_end).
        """
        ...

    async def get_recent_session_summaries(
        self, limit: int = 10
    ) -> list[SessionSummary]:
        """Retrieve recent session summaries ordered by session_number descending.

        Used by the baseline computer (T060) to assemble the window of
        sessions over which a behavioral baseline should be computed.
        Returns the most recent ``limit`` summaries so the baseline
        computer always works from the latest data.

        Args:
            limit: Maximum number of summaries to return. Defaults to
                10. Must be a positive integer.

        Returns:
            List of ``SessionSummary`` ordered by ``session_number``
            descending (most recent first). May be shorter than
            ``limit`` if fewer records exist. May be empty if no
            summaries have been saved.
        """
        ...

    # ------------------------------------------------------------------
    # Behavioral baselines
    # ------------------------------------------------------------------

    async def save_behavioral_baseline(
        self, baseline: BehavioralBaseline
    ) -> None:
        """Persist a BehavioralBaseline record. Idempotent -- replaces existing.

        When a new baseline is computed by the baseline computer (T060),
        it replaces the previous one. There is at most one active
        baseline at any time, identified by the most recent
        ``computed_at`` timestamp. Implementations may choose to
        retain historical baselines for audit purposes, but callers
        should not depend on this behavior.

        Args:
            baseline: The behavioral baseline to persist. Must have
                all required fields populated (baseline_id,
                session_ids, computed_at, and all nine
                ``BaselineMetric`` fields).
        """
        ...

    async def get_behavioral_baseline(self) -> BehavioralBaseline | None:
        """Retrieve the current behavioral baseline, if one exists.

        Returns the single most recent baseline (by ``computed_at``).
        Used by the anomaly detector (T061) and the behavioral context
        provider (T058) to compare current session metrics against
        established norms.

        Returns:
            The ``BehavioralBaseline`` with the most recent
            ``computed_at`` timestamp, or ``None`` if no baseline has
            been computed yet (system is still in the warm-up period
            before enough sessions have accumulated).
        """
        ...


__all__ = [
    "BehavioralStore",
    "GraphPersistence",
]

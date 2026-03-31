/**
 * IGraphStore: Abstraction layer for isolated graph databases.
 *
 * This interface provides a clean, technology-agnostic contract for managing
 * isolated graph databases used by Self KG and Other KG services.
 *
 * The interface is designed to be backend-agnostic: the current production
 * implementation uses Grafeo, but SQLite + custom graph layer could be swapped
 * in without changing callers.
 *
 * Key design principles:
 * - Each IGraphStore instance represents one completely isolated graph database
 * - Graph-level operations (queryNodes, queryEdges, traverseFrom) return results
 * - All operations are asynchronous to permit both in-memory and file-based backends
 * - Nodes and edges carry provenance (required, never null) and ACT-R parameters
 * - The interface supports Cypher-equivalent query semantics but abstracts the actual query language
 */

/**
 * Represents a single node in the graph with labels, properties, and metadata.
 */
export interface GraphNode {
  /** Unique identifier within this graph store instance. */
  id: string;

  /** Array of labels (types) for this node. */
  labels: string[];

  /** Arbitrary properties stored on the node. */
  properties: Record<string, unknown>;

  /** Provenance of this node (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE). */
  provenance: string;

  /** ACT-R base confidence for this node. */
  actrBase: number;

  /** ACT-R retrieval count for this node. */
  actrCount: number;

  /** ACT-R decay rate for this node. */
  actrDecayRate: number;

  /** Timestamp of last retrieval (for ACT-R dynamics). */
  actrLastRetrievalAt: Date | null;

  /** Creation timestamp. */
  createdAt: Date;

  /** Last update timestamp. */
  updatedAt: Date;
}

/**
 * Represents a single edge (relationship) in the graph.
 */
export interface GraphEdge {
  /** Unique identifier within this graph store instance. */
  id: string;

  /** Source node ID. */
  sourceId: string;

  /** Target node ID. */
  targetId: string;

  /** Relationship type. */
  relationship: string;

  /** Arbitrary properties stored on the edge. */
  properties: Record<string, unknown>;

  /** Provenance of this edge (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE). */
  provenance: string;

  /** ACT-R base confidence for this edge. */
  actrBase: number;

  /** ACT-R retrieval count for this edge. */
  actrCount: number;

  /** ACT-R decay rate for this edge. */
  actrDecayRate: number;

  /** Timestamp of last retrieval (for ACT-R dynamics). */
  actrLastRetrievalAt: Date | null;

  /** Creation timestamp. */
  createdAt: Date;

  /** Last update timestamp. */
  updatedAt: Date;
}

/**
 * Request type for creating or updating a node.
 */
export interface CreateNodeRequest {
  /** Unique identifier for this node (client-supplied or generated). */
  id: string;

  /** Labels to assign to this node. */
  labels: string[];

  /** Initial properties for this node. */
  properties?: Record<string, unknown>;

  /** Provenance source (required). */
  provenance: string;

  /** Initial ACT-R parameters. */
  actrBase?: number;
  actrCount?: number;
  actrDecayRate?: number;
}

/**
 * Request type for creating or updating an edge.
 */
export interface CreateEdgeRequest {
  /** Unique identifier for this edge (client-supplied or generated). */
  id: string;

  /** Source node ID. */
  sourceId: string;

  /** Target node ID. */
  targetId: string;

  /** Relationship type. */
  relationship: string;

  /** Initial properties for this edge. */
  properties?: Record<string, unknown>;

  /** Provenance source (required). */
  provenance: string;

  /** Initial ACT-R parameters. */
  actrBase?: number;
  actrCount?: number;
  actrDecayRate?: number;
}

/**
 * Filter for node queries.
 */
export interface NodeFilter {
  /** Match nodes with any of these labels. */
  labels?: string[];

  /** Match nodes with all of these properties (key-value pairs). */
  properties?: Record<string, unknown>;

  /** Match nodes with this provenance. */
  provenance?: string;

  /** Minimum confidence threshold. */
  minConfidence?: number;

  /** Limit result count. */
  limit?: number;

  /** Offset for pagination. */
  offset?: number;
}

/**
 * Filter for edge queries.
 */
export interface EdgeFilter {
  /** Match edges with this relationship type. */
  relationship?: string;

  /** Match edges from this source node. */
  sourceId?: string;

  /** Match edges to this target node. */
  targetId?: string;

  /** Match edges with this provenance. */
  provenance?: string;

  /** Limit result count. */
  limit?: number;

  /** Offset for pagination. */
  offset?: number;
}

/**
 * Graph traversal context used by traverseFrom().
 */
export interface TraversalPath {
  /** The current node being visited. */
  node: GraphNode;

  /** The path from the root to this node (inclusive). */
  path: GraphNode[];

  /** The edges traversed to reach this node. */
  edges: GraphEdge[];

  /** Depth of this node (root = 0). */
  depth: number;
}

/**
 * IGraphStore: Main abstraction for graph database operations.
 *
 * Implementations must be thread-safe and support concurrent reads.
 */
export interface IGraphStore {
  // ---------------------------------------------------------------------------
  // Node operations
  // ---------------------------------------------------------------------------

  /**
   * Create a new node in the graph.
   *
   * @param request - Node creation parameters (must include provenance).
   * @returns The created node with all metadata populated.
   * @throws GraphStoreException if the node already exists or validation fails.
   */
  createNode(request: CreateNodeRequest): Promise<GraphNode>;

  /**
   * Retrieve a single node by ID.
   *
   * @param id - Node ID.
   * @returns The node, or null if not found.
   * @throws GraphStoreException if the read fails.
   */
  findNode(id: string): Promise<GraphNode | null>;

  /**
   * Query nodes by filter.
   *
   * @param filter - Query filter (labels, properties, provenance, etc.).
   * @returns Array of matching nodes, ordered by confidence descending.
   * @throws GraphStoreException if the query fails.
   */
  queryNodes(filter: NodeFilter): Promise<GraphNode[]>;

  /**
   * Update node properties and/or provenance.
   *
   * @param id - Node ID.
   * @param updates - Partial node updates (properties, provenance, ACT-R params).
   * @returns The updated node.
   * @throws GraphStoreException if the node doesn't exist or update fails.
   */
  updateNode(id: string, updates: Partial<CreateNodeRequest>): Promise<GraphNode>;

  /**
   * Delete a node by ID.
   *
   * Cascade behavior: deleting a node may optionally delete incident edges,
   * depending on implementation. Current Grafeo implementation leaves edges orphaned.
   *
   * @param id - Node ID.
   * @returns True if the node existed and was deleted; false if not found.
   * @throws GraphStoreException if the deletion fails.
   */
  deleteNode(id: string): Promise<boolean>;

  // ---------------------------------------------------------------------------
  // Edge operations
  // ---------------------------------------------------------------------------

  /**
   * Create a new edge between two nodes.
   *
   * @param request - Edge creation parameters (must include provenance).
   * @returns The created edge with all metadata populated.
   * @throws GraphStoreException if nodes don't exist, edge exists, or validation fails.
   */
  createEdge(request: CreateEdgeRequest): Promise<GraphEdge>;

  /**
   * Retrieve a single edge by ID.
   *
   * @param id - Edge ID.
   * @returns The edge, or null if not found.
   * @throws GraphStoreException if the read fails.
   */
  findEdge(id: string): Promise<GraphEdge | null>;

  /**
   * Query edges by filter.
   *
   * @param filter - Query filter (relationship type, source, target, provenance, etc.).
   * @returns Array of matching edges.
   * @throws GraphStoreException if the query fails.
   */
  queryEdges(filter: EdgeFilter): Promise<GraphEdge[]>;

  /**
   * Update edge properties and/or provenance.
   *
   * @param id - Edge ID.
   * @param updates - Partial edge updates (properties, provenance, ACT-R params).
   * @returns The updated edge.
   * @throws GraphStoreException if the edge doesn't exist or update fails.
   */
  updateEdge(id: string, updates: Partial<CreateEdgeRequest>): Promise<GraphEdge>;

  /**
   * Delete an edge by ID.
   *
   * @param id - Edge ID.
   * @returns True if the edge existed and was deleted; false if not found.
   * @throws GraphStoreException if the deletion fails.
   */
  deleteEdge(id: string): Promise<boolean>;

  // ---------------------------------------------------------------------------
  // Graph traversal
  // ---------------------------------------------------------------------------

  /**
   * Traverse the graph starting from a given node.
   *
   * Performs breadth-first traversal up to maxDepth, visiting each node and
   * collecting paths. Used by the Learning subsystem for graph analysis.
   *
   * @param nodeId - ID of the root node for traversal.
   * @param maxDepth - Maximum depth to traverse (0 = just the root node).
   * @returns Array of TraversalPath objects representing all visited nodes and paths.
   * @throws GraphStoreException if the traversal fails or root node doesn't exist.
   */
  traverseFrom(nodeId: string, maxDepth: number): Promise<TraversalPath[]>;

  // ---------------------------------------------------------------------------
  // Health and metadata
  // ---------------------------------------------------------------------------

  /**
   * Health check for the graph store.
   *
   * @returns True if the store is reachable and operational; false otherwise.
   */
  healthCheck(): Promise<boolean>;

  /**
   * Close the graph store and release resources.
   *
   * After close(), all subsequent operations will fail.
   */
  close(): Promise<void>;

  /**
   * Get the number of nodes in the graph.
   *
   * @returns Total node count.
   */
  nodeCount(): Promise<number>;

  /**
   * Get the number of edges in the graph.
   *
   * @returns Total edge count.
   */
  edgeCount(): Promise<number>;
}

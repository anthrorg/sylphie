/**
 * Graph serialization utilities for Web module.
 *
 * Converts Neo4j graph records and Grafeo KG data into frontend-friendly
 * JSON structures for visualization and inspection.
 *
 * CANON §Graph Visualization: The WKG is too large to transmit in full.
 * Serializers handle subgraph extraction, edge filtering, and confidence
 * normalization so the frontend can render and interact with the graph.
 *
 * Stub implementation — full wiring in Epic 9 T005.
 */

/**
 * GraphNodeSerialized — a node in the graph suitable for frontend visualization.
 *
 * Includes node metadata (id, label, type, confidence) but not the full
 * property dictionary — that's available on demand via a detail endpoint.
 */
export interface GraphNodeSerialized {
  /** Unique node ID (Neo4j internal or User KG entity ID). */
  id: string | number;

  /** Human-readable label for the node (entity name, concept title, etc.). */
  label: string;

  /** Node type (e.g., "entity", "event", "concept", "procedure"). */
  type: string;

  /** Confidence [0, 1] — how certain Sylphie is about this node. */
  confidence: number;

  /** Optional: creation timestamp in ISO 8601 format. */
  createdAt?: string;

  /** Optional: provenance source (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE). */
  provenance?: string;
}

/**
 * GraphEdgeSerialized — a directed relationship in the graph.
 *
 * Includes source, target, relationship type, and confidence.
 */
export interface GraphEdgeSerialized {
  /** Source node ID. */
  source: string | number;

  /** Target node ID. */
  target: string | number;

  /** Relationship type (e.g., "HAS_PROPERTY", "RELATED_TO", "CAUSED_BY"). */
  type: string;

  /** Confidence [0, 1] of this relationship. */
  confidence: number;

  /** Optional: creation timestamp in ISO 8601 format. */
  createdAt?: string;

  /** Optional: provenance source. */
  provenance?: string;
}

/**
 * GraphSubgraphSerialized — a subgraph ready for frontend visualization.
 *
 * Contains nodes and edges extracted from a Neo4j query result.
 */
export interface GraphSubgraphSerialized {
  /** Nodes in the subgraph. */
  nodes: GraphNodeSerialized[];

  /** Edges in the subgraph. */
  edges: GraphEdgeSerialized[];

  /** Metadata about the query. */
  metadata: {
    /** Timestamp when the query was executed. */
    queriedAt: string;

    /** Number of nodes returned. */
    nodeCount: number;

    /** Number of edges returned. */
    edgeCount: number;

    /** Whether the result was truncated (hit maxNodes or maxDepth). */
    isTruncated: boolean;

    /** Query depth (how many hops from root). */
    depth?: number;
  };
}

/**
 * SerializeGraphNode — stub for converting a Neo4j node to frontend format.
 *
 * In real implementation, would extract properties from Neo4j record
 * and normalize confidence values.
 *
 * @param _nodeRecord - Raw Neo4j node record
 * @returns Serialized node ready for frontend
 * @throws Error until Epic 9 T005
 */
export function serializeGraphNode(_nodeRecord: unknown): GraphNodeSerialized {
  throw new Error('Not implemented: serializeGraphNode — see Epic 9 T005');
}

/**
 * SerializeGraphEdge — stub for converting a Neo4j relationship to frontend format.
 *
 * In real implementation, would extract properties from Neo4j relationship
 * and normalize confidence values.
 *
 * @param _edgeRecord - Raw Neo4j relationship record
 * @returns Serialized edge ready for frontend
 * @throws Error until Epic 9 T005
 */
export function serializeGraphEdge(_edgeRecord: unknown): GraphEdgeSerialized {
  throw new Error('Not implemented: serializeGraphEdge — see Epic 9 T005');
}

/**
 * SerializeSubgraph — stub for converting full Neo4j subgraph to frontend format.
 *
 * In real implementation, would transform a Neo4j result set containing
 * nodes and relationships into a GraphSubgraphSerialized structure.
 *
 * @param _queryResult - Raw Neo4j query result (nodes and edges)
 * @returns Serialized subgraph ready for frontend
 * @throws Error until Epic 9 T005
 */
export function serializeSubgraph(_queryResult: unknown): GraphSubgraphSerialized {
  throw new Error('Not implemented: serializeSubgraph — see Epic 9 T005');
}

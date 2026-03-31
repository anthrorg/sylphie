/**
 * Knowledge graph DTOs for graph visualization and query endpoints.
 *
 * CANON §The World Knowledge Graph Is the Brain: The WKG is the system.
 * These DTOs serialize the graph state for visualization on the frontend
 * and for exploration via REST endpoints.
 *
 * All node/edge DTOs include provenance and confidence for transparency
 * about knowledge source and reliability.
 */

import type { SchemaLevel } from '../../shared/types/schema-level.types';

// ---------------------------------------------------------------------------
// Node and Edge DTOs
// ---------------------------------------------------------------------------

/**
 * GraphNodeDto — serialized WKG node for visualization and queries.
 *
 * Represents a node in the World Knowledge Graph with all essential
 * metadata for frontend rendering and inspection.
 *
 * CANON §Provenance Is Sacred: provenance is always included and never
 * stripped. The frontend can use this to colorize nodes or filter by source.
 */
export interface GraphNodeDto {
  /** Neo4j element ID (unique). */
  readonly id: string;

  /** Display label (typically the most important property value). */
  readonly label: string;

  /**
   * Node type / primary label.
   * Examples: 'Entity', 'Action', 'Procedure', 'Concept'
   */
  readonly type: string;

  /**
   * Structural level of this node in the three-level WKG hierarchy.
   *
   * - 'instance'    — Individual entity/concept/procedure/utterance nodes
   * - 'schema'      — Type and relationship-class definitions (SchemaType, SchemaRelType)
   * - 'meta_schema' — Rules governing schema evolution (MetaRule)
   *
   * Derived from Neo4j labels via schemaLevelFromLabels(). For legacy nodes
   * that predate this property, the controller infers it from labels at query time.
   *
   * The frontend uses this to filter and colorize nodes by level.
   */
  readonly schema_level: SchemaLevel;

  /**
   * Provenance source: where this knowledge came from.
   * One of: SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE, GUARDIAN_APPROVED_INFERENCE,
   *         TAUGHT_PROCEDURE, BEHAVIORAL_INFERENCE, SYSTEM_BOOTSTRAP
   */
  readonly provenance: string;

  /**
   * Confidence score in [0.0, 1.0] per CANON §Confidence Dynamics.
   * Higher confidence = more reliable knowledge.
   */
  readonly confidence: number;

  /** Domain-specific node properties (open-ended map). */
  readonly properties: Record<string, unknown>;
}

/**
 * GraphEdgeDto — serialized WKG edge for visualization and queries.
 *
 * Represents a directed edge in the World Knowledge Graph connecting
 * two nodes via a typed relationship.
 */
export interface GraphEdgeDto {
  /** Neo4j relationship element ID (unique). */
  readonly id: string;

  /** Element ID of the source (start) node. */
  readonly sourceId: string;

  /** Element ID of the target (end) node. */
  readonly targetId: string;

  /**
   * Neo4j relationship type string (UPPER_SNAKE_CASE by convention).
   * Examples: 'IS_A', 'CAN_PRODUCE', 'LOCATED_IN', 'TAUGHT_BY'
   */
  readonly relationship: string;

  /**
   * Provenance source: where this relationship came from.
   * Same values as GraphNodeDto.provenance.
   */
  readonly provenance: string;

  /**
   * Confidence score in [0.0, 1.0] per CANON §Confidence Dynamics.
   */
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Query Responses
// ---------------------------------------------------------------------------

/**
 * GraphSnapshotResponse — paginated graph structure snapshot.
 *
 * Returned by GET /api/graph?nodeId={id}&depth={n}&offset={o}&limit={l}.
 * Provides a neighborhood view of the WKG centered on a node or
 * a general snapshot when nodeId is omitted.
 *
 * CANON §Architecture: Graph queries enforce maxDepth (default 3, max 10)
 * and maxNodes (default 200, max 10000) to prevent runaway complexity.
 * When results exceed limits, pagination is used (offset/limit).
 */
export interface GraphSnapshotResponse {
  /** All nodes in the result set. */
  readonly nodes: readonly GraphNodeDto[];

  /** All edges in the result set. */
  readonly edges: readonly GraphEdgeDto[];

  /** Total count of matching nodes (across all pages). */
  readonly totalNodes: number;

  /** Total count of matching edges (across all pages). */
  readonly totalEdges: number;

  /** Pagination offset applied to this result. */
  readonly offset: number;

  /** Pagination limit applied to this result. */
  readonly limit: number;
}

/**
 * GraphStatsResponse — aggregate statistics about the WKG.
 *
 * Returned by GET /api/graph/stats. Provides a high-level overview
 * of graph structure and composition.
 *
 * provenanceDistribution and typeDistribution are open-ended maps
 * keyed by provenance source and node type respectively.
 */
export interface GraphStatsResponse {
  /** Total count of all nodes in the WKG. */
  readonly nodeCount: number;

  /** Total count of all edges in the WKG. */
  readonly edgeCount: number;

  /**
   * Distribution of nodes/edges by provenance source.
   * Keys are provenance sources (e.g., 'SENSOR', 'GUARDIAN', 'LLM_GENERATED').
   * Values are counts.
   */
  readonly provenanceDistribution: Record<string, number>;

  /**
   * Distribution of nodes by type.
   * Keys are node types (e.g., 'Entity', 'Action', 'Concept').
   * Values are counts.
   */
  readonly typeDistribution: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Query Parameters
// ---------------------------------------------------------------------------

/**
 * GraphQueryParams — parameters for graph neighborhood queries.
 *
 * Used in GET /api/graph endpoint query string parsing.
 * All fields are optional; each has sensible defaults.
 *
 * CANON §Graph Query Limits (enforced):
 * - maxDepth defaults to 3, enforces max 10
 * - maxNodes defaults to 200, enforces max 10000
 *
 * When results exceed maxNodes, pagination (offset/limit) is applied.
 */
export interface GraphQueryParams {
  /**
   * Node ID to center the query on (optional).
   * When provided, returns neighbors of this node up to the specified depth.
   * When omitted, returns a general snapshot or root nodes.
   */
  readonly nodeId?: string;

  /**
   * Traversal depth for neighborhood queries (optional, default 3).
   *
   * Limits the BFS distance from the anchor node.
   * - depth=1: immediate neighbors only
   * - depth=3: neighbors, their neighbors, and their neighbors (default)
   * - depth >= 10: clamped to 10 per CANON limits
   *
   * @jsDoc maxDepth = 10 (enforced at query time)
   */
  readonly depth?: number;

  /**
   * Maximum nodes to return in a single response (optional, default 200).
   *
   * When the neighborhood exceeds this count, pagination is applied.
   * - maxNodes=200: default, suitable for most dashboards
   * - maxNodes=10000: maximum allowed per CANON limits
   *
   * @jsDoc maxNodes = 10000 (enforced at query time)
   */
  readonly maxNodes?: number;

  /**
   * Pagination offset (optional, default 0).
   * Used with limit to page through large result sets.
   */
  readonly offset?: number;

  /**
   * Pagination limit (optional, default maxNodes).
   * Number of items to return in this page.
   */
  readonly limit?: number;
}

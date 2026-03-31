/**
 * GrafeoStore: Grafeo-backed implementation of IGraphStore.
 *
 * This implementation wraps @grafeo-db/js and provides a clean abstraction layer
 * for Self KG and Other KG services. The interface allows for easy swapping of
 * backends (e.g., to SQLite) without changing the service layer.
 *
 * Key design:
 * - Each GrafeoStore instance wraps a single GrafeoDB instance
 * - Nodes and edges are stored with full provenance and ACT-R metadata
 * - Queries use Cypher (via executeCypher) for maximum compatibility
 * - IDs are managed as strings; GrafeoDB numeric IDs are wrapped internally
 * - Timestamps are stored as ISO 8601 strings in properties for persistence
 */

import { GrafeoDB } from '@grafeo-db/js';
import {
  IGraphStore,
  GraphNode,
  GraphEdge,
  CreateNodeRequest,
  CreateEdgeRequest,
  NodeFilter,
  EdgeFilter,
  TraversalPath,
} from './graph-store.interface';

/**
 * GraphStoreException: Thrown on graph store errors.
 */
export class GraphStoreException extends Error {
  constructor(
    message: string,
    public readonly code: string = 'GRAPH_STORE_ERROR',
  ) {
    super(message);
    Object.setPrototypeOf(this, GraphStoreException.prototype);
  }
}

/**
 * GrafeoStore: Grafeo-backed IGraphStore implementation.
 */
export class GrafeoStore implements IGraphStore {
  private readonly db: GrafeoDB;
  private readonly nodeIdMap: Map<string, number> = new Map(); // string ID -> numeric ID
  private readonly numericIdMap: Map<number, string> = new Map(); // numeric ID -> string ID
  private nextNodeId: number = 0;
  private nextEdgeId: number = 0;

  constructor(db: GrafeoDB) {
    this.db = db;
  }

  /**
   * Factory: Create a new in-memory GrafeoStore.
   */
  static createInMemory(): GrafeoStore {
    const db = GrafeoDB.create();
    return new GrafeoStore(db);
  }

  /**
   * Factory: Create a new file-backed GrafeoStore.
   */
  static createPersistent(filePath: string): GrafeoStore {
    const db = GrafeoDB.create(filePath);
    return new GrafeoStore(db);
  }

  /**
   * Factory: Open an existing file-backed GrafeoStore.
   */
  static openPersistent(filePath: string): GrafeoStore {
    const db = GrafeoDB.open(filePath);
    return new GrafeoStore(db);
  }

  /**
   * Convert numeric GrafeoDB node ID to string ID.
   */
  private toStringId(numericId: number): string {
    const cached = this.numericIdMap.get(numericId);
    if (cached) return cached;

    const stringId = `node_${numericId}`;
    this.numericIdMap.set(numericId, stringId);
    return stringId;
  }

  /**
   * Convert string ID to numeric GrafeoDB node ID (or allocate new one).
   */
  private toNumericId(stringId: string): number {
    const cached = this.nodeIdMap.get(stringId);
    if (cached !== undefined) return cached;

    // Grafeo assigns numeric IDs automatically, but for our mapping we need to track them
    // When creating a node, we'll use this counter to help with mapping
    const numericId = this.nextNodeId++;
    this.nodeIdMap.set(stringId, numericId);
    this.numericIdMap.set(numericId, stringId);
    return numericId;
  }

  /**
   * Wrap a GrafeoDB node into GraphNode.
   */
  private wrapNode(grafeNode: any): GraphNode {
    const props = grafeNode.properties();
    return {
      id: this.toStringId(grafeNode.id),
      labels: grafeNode.labels,
      properties: props,
      provenance: props['provenance'] || 'UNKNOWN',
      actrBase: props['actr_base'] ?? 0.35,
      actrCount: props['actr_count'] ?? 0,
      actrDecayRate: props['actr_decay_rate'] ?? 0.5,
      actrLastRetrievalAt: props['actr_last_retrieval_at']
        ? new Date(props['actr_last_retrieval_at'])
        : null,
      createdAt: new Date(props['created_at'] || new Date()),
      updatedAt: new Date(props['updated_at'] || new Date()),
    };
  }

  /**
   * Wrap a GrafeoDB edge into GraphEdge.
   *
   * Handles two formats:
   * - JsEdge objects from db.getEdge() and db.createEdge() (has .properties() method)
   * - Plain objects from Cypher queries (has _id, _source, _target, _type fields)
   */
  private wrapEdge(grafeEdge: any): GraphEdge {
    // Determine if this is a JsEdge or a plain object from Cypher
    const isJsEdge = typeof grafeEdge.properties === 'function';

    const edgeData = isJsEdge
      ? {
          id: grafeEdge.id,
          sourceId: grafeEdge.sourceId,
          targetId: grafeEdge.targetId,
          relationship: grafeEdge.edgeType,
          props: grafeEdge.properties(),
        }
      : {
          id: grafeEdge._id,
          sourceId: grafeEdge._source,
          targetId: grafeEdge._target,
          relationship: grafeEdge._type,
          props: (() => {
            const { _id, _source, _target, _type, ...rest } = grafeEdge;
            return rest;
          })(),
        };

    const createdAtValue = edgeData.props['created_at'];
    const updatedAtValue = edgeData.props['updated_at'];
    const lastRetrievalValue = edgeData.props['actr_last_retrieval_at'];

    return {
      id: `edge_${edgeData.id}`,
      sourceId: this.toStringId(edgeData.sourceId),
      targetId: this.toStringId(edgeData.targetId),
      relationship: edgeData.relationship,
      properties: edgeData.props,
      provenance: (edgeData.props['provenance'] as string) || 'UNKNOWN',
      actrBase: (edgeData.props['actr_base'] as number) ?? 0.35,
      actrCount: (edgeData.props['actr_count'] as number) ?? 0,
      actrDecayRate: (edgeData.props['actr_decay_rate'] as number) ?? 0.5,
      actrLastRetrievalAt: lastRetrievalValue
        ? new Date(lastRetrievalValue as string | number)
        : null,
      createdAt: createdAtValue
        ? new Date(createdAtValue as string | number)
        : new Date(),
      updatedAt: updatedAtValue
        ? new Date(updatedAtValue as string | number)
        : new Date(),
    };
  }

  /**
   * Prepare node properties for storage (serialize metadata).
   */
  private prepareNodeProperties(
    request: CreateNodeRequest,
  ): Record<string, unknown> {
    const now = new Date().toISOString();
    return {
      id: request.id,
      provenance: request.provenance,
      actr_base: request.actrBase ?? 0.35,
      actr_count: request.actrCount ?? 0,
      actr_decay_rate: request.actrDecayRate ?? 0.5,
      actr_last_retrieval_at: null,
      created_at: now,
      updated_at: now,
      ...(request.properties || {}),
    };
  }

  /**
   * Prepare edge properties for storage (serialize metadata).
   */
  private prepareEdgeProperties(
    request: CreateEdgeRequest,
  ): Record<string, unknown> {
    return {
      id: request.id,
      provenance: request.provenance,
      actr_base: request.actrBase ?? 0.35,
      actr_count: request.actrCount ?? 0,
      actr_decay_rate: request.actrDecayRate ?? 0.5,
      actr_last_retrieval_at: null,
      ...(request.properties || {}),
    };
  }

  // ---------------------------------------------------------------------------
  // IGraphStore implementation
  // ---------------------------------------------------------------------------

  async createNode(request: CreateNodeRequest): Promise<GraphNode> {
    try {
      const props = this.prepareNodeProperties(request);
      const grafeNode = this.db.createNode(request.labels, props);

      // Map the numeric ID
      this.nodeIdMap.set(request.id, grafeNode.id);
      this.numericIdMap.set(grafeNode.id, request.id);

      return this.wrapNode(grafeNode);
    } catch (error) {
      throw new GraphStoreException(
        `Failed to create node: ${String(error)}`,
        'CREATE_NODE_FAILED',
      );
    }
  }

  async findNode(id: string): Promise<GraphNode | null> {
    try {
      const numericId = this.nodeIdMap.get(id);
      if (numericId === undefined) return null;

      const grafeNode = this.db.getNode(numericId);
      return grafeNode ? this.wrapNode(grafeNode) : null;
    } catch (error) {
      throw new GraphStoreException(
        `Failed to find node: ${String(error)}`,
        'FIND_NODE_FAILED',
      );
    }
  }

  async queryNodes(filter: NodeFilter): Promise<GraphNode[]> {
    try {
      // Build Cypher query dynamically
      let query = 'MATCH (n';

      // Add label filter if provided
      if (filter.labels && filter.labels.length > 0) {
        const labelExprs = filter.labels.map((l) => `:${l}`).join('|');
        query += labelExprs;
      }

      query += ')';

      // Add property and provenance filters in WHERE clause
      const conditions: string[] = [];
      if (filter.provenance) {
        conditions.push(`n.provenance = '${filter.provenance}'`);
      }
      if (filter.minConfidence !== undefined) {
        conditions.push(
          `(n.actr_base + 0.12 * log(n.actr_count) - 0.5 * log(n.actr_count + 1)) >= ${filter.minConfidence}`,
        );
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      query += ' RETURN n ORDER BY n.actr_base DESC';

      if (filter.limit) {
        query += ` LIMIT ${filter.limit}`;
      }
      if (filter.offset) {
        query += ` SKIP ${filter.offset}`;
      }

      const result = await this.db.executeCypher(query);
      const nodes: GraphNode[] = [];

      for (let i = 0; i < result.length; i++) {
        const row = result.get(i) as any;
        if (row.n) {
          nodes.push(this.wrapNode(row.n));
        }
      }

      return nodes;
    } catch (error) {
      throw new GraphStoreException(
        `Failed to query nodes: ${String(error)}`,
        'QUERY_NODES_FAILED',
      );
    }
  }

  async updateNode(
    id: string,
    updates: Partial<CreateNodeRequest>,
  ): Promise<GraphNode> {
    try {
      const numericId = this.nodeIdMap.get(id);
      if (numericId === undefined) {
        throw new GraphStoreException(`Node not found: ${id}`, 'NODE_NOT_FOUND');
      }

      const grafeNode = this.db.getNode(numericId);
      if (!grafeNode) {
        throw new GraphStoreException(`Node not found: ${id}`, 'NODE_NOT_FOUND');
      }

      // Update provenance if provided
      if (updates.provenance) {
        this.db.setNodeProperty(numericId, 'provenance', updates.provenance);
      }

      // Update ACT-R parameters if provided
      if (updates.actrBase !== undefined) {
        this.db.setNodeProperty(numericId, 'actr_base', updates.actrBase);
      }
      if (updates.actrCount !== undefined) {
        this.db.setNodeProperty(numericId, 'actr_count', updates.actrCount);
      }
      if (updates.actrDecayRate !== undefined) {
        this.db.setNodeProperty(numericId, 'actr_decay_rate', updates.actrDecayRate);
      }

      // Update other properties
      if (updates.properties) {
        Object.entries(updates.properties).forEach(([key, value]) => {
          this.db.setNodeProperty(numericId, key, value);
        });
      }

      // Update timestamp
      this.db.setNodeProperty(numericId, 'updated_at', new Date().toISOString());

      const updatedNode = this.db.getNode(numericId);
      if (!updatedNode) {
        throw new GraphStoreException(
          `Node disappeared after update: ${id}`,
          'NODE_LOST_AFTER_UPDATE',
        );
      }

      return this.wrapNode(updatedNode);
    } catch (error) {
      if (error instanceof GraphStoreException) throw error;
      throw new GraphStoreException(
        `Failed to update node: ${String(error)}`,
        'UPDATE_NODE_FAILED',
      );
    }
  }

  async deleteNode(id: string): Promise<boolean> {
    try {
      const numericId = this.nodeIdMap.get(id);
      if (numericId === undefined) return false;

      const deleted = this.db.deleteNode(numericId);
      if (deleted) {
        this.nodeIdMap.delete(id);
        this.numericIdMap.delete(numericId);
      }
      return deleted;
    } catch (error) {
      throw new GraphStoreException(
        `Failed to delete node: ${String(error)}`,
        'DELETE_NODE_FAILED',
      );
    }
  }

  async createEdge(request: CreateEdgeRequest): Promise<GraphEdge> {
    try {
      const sourceNumericId = this.nodeIdMap.get(request.sourceId);
      const targetNumericId = this.nodeIdMap.get(request.targetId);

      if (sourceNumericId === undefined || targetNumericId === undefined) {
        throw new GraphStoreException(
          `Source or target node not found`,
          'NODE_NOT_FOUND',
        );
      }

      const props = this.prepareEdgeProperties(request);
      const grafeEdge = this.db.createEdge(
        sourceNumericId,
        targetNumericId,
        request.relationship,
        props,
      );

      return this.wrapEdge(grafeEdge);
    } catch (error) {
      if (error instanceof GraphStoreException) throw error;
      throw new GraphStoreException(
        `Failed to create edge: ${String(error)}`,
        'CREATE_EDGE_FAILED',
      );
    }
  }

  async findEdge(id: string): Promise<GraphEdge | null> {
    try {
      // Edge IDs are formatted as "edge_<numeric>"
      const match = id.match(/^edge_(\d+)$/);
      if (!match) return null;

      const numericId = parseInt(match[1], 10);
      const grafeEdge = this.db.getEdge(numericId);
      return grafeEdge ? this.wrapEdge(grafeEdge) : null;
    } catch (error) {
      throw new GraphStoreException(
        `Failed to find edge: ${String(error)}`,
        'FIND_EDGE_FAILED',
      );
    }
  }

  async queryEdges(filter: EdgeFilter): Promise<GraphEdge[]> {
    try {
      let query = 'MATCH (s)-[r';

      if (filter.relationship) {
        query += `:${filter.relationship}`;
      }

      query += ']->(t)';

      const conditions: string[] = [];

      if (filter.sourceId) {
        const sourceNumericId = this.nodeIdMap.get(filter.sourceId);
        if (sourceNumericId !== undefined) {
          conditions.push(`id(s) = ${sourceNumericId}`);
        }
      }

      if (filter.targetId) {
        const targetNumericId = this.nodeIdMap.get(filter.targetId);
        if (targetNumericId !== undefined) {
          conditions.push(`id(t) = ${targetNumericId}`);
        }
      }

      if (filter.provenance) {
        conditions.push(`r.provenance = '${filter.provenance}'`);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      query += ' RETURN r, s, t';

      if (filter.limit) {
        query += ` LIMIT ${filter.limit}`;
      }
      if (filter.offset) {
        query += ` SKIP ${filter.offset}`;
      }

      const result = await this.db.executeCypher(query);
      const edges: GraphEdge[] = [];

      for (let i = 0; i < result.length; i++) {
        const row = result.get(i) as any;
        if (row.r) {
          edges.push(this.wrapEdge(row.r));
        }
      }

      return edges;
    } catch (error) {
      throw new GraphStoreException(
        `Failed to query edges: ${String(error)}`,
        'QUERY_EDGES_FAILED',
      );
    }
  }

  async updateEdge(
    id: string,
    updates: Partial<CreateEdgeRequest>,
  ): Promise<GraphEdge> {
    try {
      const match = id.match(/^edge_(\d+)$/);
      if (!match) {
        throw new GraphStoreException(`Invalid edge ID: ${id}`, 'INVALID_EDGE_ID');
      }

      const numericId = parseInt(match[1], 10);
      const grafeEdge = this.db.getEdge(numericId);
      if (!grafeEdge) {
        throw new GraphStoreException(`Edge not found: ${id}`, 'EDGE_NOT_FOUND');
      }

      // Update provenance if provided
      if (updates.provenance) {
        this.db.setEdgeProperty(numericId, 'provenance', updates.provenance);
      }

      // Update ACT-R parameters if provided
      if (updates.actrBase !== undefined) {
        this.db.setEdgeProperty(numericId, 'actr_base', updates.actrBase);
      }
      if (updates.actrCount !== undefined) {
        this.db.setEdgeProperty(numericId, 'actr_count', updates.actrCount);
      }
      if (updates.actrDecayRate !== undefined) {
        this.db.setEdgeProperty(numericId, 'actr_decay_rate', updates.actrDecayRate);
      }

      // Update other properties
      if (updates.properties) {
        Object.entries(updates.properties).forEach(([key, value]) => {
          this.db.setEdgeProperty(numericId, key, value);
        });
      }

      const updatedEdge = this.db.getEdge(numericId);
      if (!updatedEdge) {
        throw new GraphStoreException(
          `Edge disappeared after update: ${id}`,
          'EDGE_LOST_AFTER_UPDATE',
        );
      }

      return this.wrapEdge(updatedEdge);
    } catch (error) {
      if (error instanceof GraphStoreException) throw error;
      throw new GraphStoreException(
        `Failed to update edge: ${String(error)}`,
        'UPDATE_EDGE_FAILED',
      );
    }
  }

  async deleteEdge(id: string): Promise<boolean> {
    try {
      const match = id.match(/^edge_(\d+)$/);
      if (!match) return false;

      const numericId = parseInt(match[1], 10);
      return this.db.deleteEdge(numericId);
    } catch (error) {
      throw new GraphStoreException(
        `Failed to delete edge: ${String(error)}`,
        'DELETE_EDGE_FAILED',
      );
    }
  }

  async traverseFrom(nodeId: string, maxDepth: number): Promise<TraversalPath[]> {
    try {
      const numericId = this.nodeIdMap.get(nodeId);
      if (numericId === undefined) {
        throw new GraphStoreException(`Node not found: ${nodeId}`, 'NODE_NOT_FOUND');
      }

      const paths: TraversalPath[] = [];
      const visited = new Set<number>();
      const queue: {
        numericId: number;
        depth: number;
        path: GraphNode[];
        edges: GraphEdge[];
      }[] = [{ numericId, depth: 0, path: [], edges: [] }];

      while (queue.length > 0) {
        const { numericId: currentId, depth, path: currentPath, edges: currentEdges } =
          queue.shift()!;

        if (visited.has(currentId)) continue;
        visited.add(currentId);

        const node = this.db.getNode(currentId);
        if (!node) continue;

        const wrappedNode = this.wrapNode(node);
        const fullPath = [...currentPath, wrappedNode];

        paths.push({
          node: wrappedNode,
          path: fullPath,
          edges: currentEdges,
          depth,
        });

        // Continue traversal if not at max depth
        if (depth < maxDepth) {
          // Query all edges from this node using simpler Cypher
          const edgesQuery = 'MATCH (n)-[r]->(m) RETURN r';
          const result = await this.db.executeCypher(edgesQuery);

          for (let i = 0; i < result.length; i++) {
            const row = result.get(i) as any;
            const edgeData = row.r;
            if (edgeData) {
              // Check if this edge originates from our current node
              const sourceId = edgeData._source ?? edgeData.sourceId;
              if (sourceId === currentId) {
                const targetId = edgeData._target ?? edgeData.targetId;
                const wrappedEdge = this.wrapEdge(edgeData);
                queue.push({
                  numericId: targetId,
                  depth: depth + 1,
                  path: fullPath,
                  edges: [...currentEdges, wrappedEdge],
                });
              }
            }
          }
        }
      }

      return paths;
    } catch (error) {
      if (error instanceof GraphStoreException) throw error;
      throw new GraphStoreException(
        `Failed to traverse graph: ${String(error)}`,
        'TRAVERSAL_FAILED',
      );
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const count = this.db.nodeCount();
      return count >= 0; // If we can get count, we're healthy
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      this.db.close();
      this.nodeIdMap.clear();
      this.numericIdMap.clear();
    } catch (error) {
      throw new GraphStoreException(
        `Failed to close graph store: ${String(error)}`,
        'CLOSE_FAILED',
      );
    }
  }

  async nodeCount(): Promise<number> {
    try {
      return this.db.nodeCount();
    } catch (error) {
      throw new GraphStoreException(
        `Failed to get node count: ${String(error)}`,
        'NODE_COUNT_FAILED',
      );
    }
  }

  async edgeCount(): Promise<number> {
    try {
      return this.db.edgeCount();
    } catch (error) {
      throw new GraphStoreException(
        `Failed to get edge count: ${String(error)}`,
        'EDGE_COUNT_FAILED',
      );
    }
  }
}

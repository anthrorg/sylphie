import {
  Controller,
  Get,
  Query,
  Inject,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { WebConfig } from '../web.config';
import type {
  GraphNodeDto,
  GraphEdgeDto,
  GraphSnapshotResponse,
  GraphStatsResponse,
  GraphQueryParams,
} from '../dtos/graph.dto';
import { computeConfidence } from '../../shared/types/confidence.types';
import {
  schemaLevelFromLabels,
  type SchemaLevel,
} from '../../shared/types/schema-level.types';

/**
 * GraphController — REST API for World Knowledge Graph visualization and exploration.
 *
 * Exposes read-only endpoints for querying the WKG. Consumes IWkgService
 * for all graph operations.
 *
 * CANON §Module boundary: This controller is the HTTP surface for the WKG.
 * It does not bypass KnowledgeModule; it consumes the IWkgService interface.
 *
 * CANON §Provenance Is Sacred: All node and edge responses include provenance
 * and confidence. These are never stripped.
 */
@Controller('api/graph')
export class GraphController {
  private graphMaxDepth: number = 3;
  private graphMaxNodes: number = 200;
  private graphQueryTimeoutMs: number = 5000;

  constructor(
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
    @Inject(EVENTS_SERVICE) private readonly eventService: IEventService,
    private readonly configService: ConfigService,
  ) {
    const webConfig = this.configService.get<WebConfig>('web');
    if (webConfig?.graphVisualization) {
      this.graphMaxDepth = webConfig.graphVisualization.maxDepth;
      this.graphMaxNodes = webConfig.graphVisualization.maxNodes;
      this.graphQueryTimeoutMs = webConfig.graphVisualization.queryTimeoutMs;
    }
  }

  /**
   * GET /api/graph/snapshot?offset=0&limit=50
   *
   * Retrieve a paginated snapshot of WKG nodes and edges.
   * When nodeId is provided, returns neighbors of that node up to specified depth.
   * When nodeId is omitted, returns a general snapshot of the graph.
   *
   * Query parameters:
   * - nodeId (optional): Center node for neighborhood query
   * - depth (optional, default 3): Traversal depth for neighborhood queries
   * - maxNodes (optional, default 200): Maximum nodes in result
   * - offset (optional, default 0): Pagination offset
   * - limit (optional, default 50): Pagination limit
   *
   * Returns GraphSnapshotResponse with paginated nodes and edges.
   */
  @Get('snapshot')
  async getSnapshot(
    @Query('nodeId') nodeId?: string,
    @Query('depth') depthStr?: string,
    @Query('maxNodes') maxNodesStr?: string,
    @Query('offset') offsetStr?: string,
    @Query('limit') limitStr?: string,
  ): Promise<GraphSnapshotResponse> {
    try {
      // Parse and validate query parameters
      const depth = Math.min(
        10,
        Math.max(1, parseInt(depthStr ?? '3', 10) || 3),
      );
      const maxNodes = Math.min(
        10000,
        Math.max(1, parseInt(maxNodesStr ?? '200', 10) || 200),
      );
      const offset = Math.max(0, parseInt(offsetStr ?? '0', 10) || 0);
      const limit = Math.min(
        500,
        Math.max(1, parseInt(limitStr ?? '50', 10) || 50),
      );

      // Query the graph
      const result = nodeId
        ? await this.queryNodeSubgraph(nodeId, depth, maxNodes)
        : await this.queryGeneralSnapshot(maxNodes);

      // Convert to DTOs
      const nodeCount = result.nodes.length;
      const edgeCount = result.edges.length;

      const allNodeDtos = result.nodes.map(
        (node): GraphNodeDto => ({
          id: node.id,
          label: this.extractLabel(node),
          type: node.labels[0] ?? 'Unknown',
          schema_level: this.resolveSchemaLevel(node),
          provenance: node.provenance,
          confidence: computeConfidence(node.actrParams),
          properties: node.properties ?? {},
        }),
      );

      const allEdgeDtos = result.edges.map(
        (edge): GraphEdgeDto => ({
          id: edge.id,
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          relationship: edge.relationship,
          provenance: edge.provenance,
          confidence: computeConfidence(edge.actrParams),
        }),
      );

      // Apply pagination to nodes
      const pageNodeDtos = allNodeDtos.slice(offset, offset + limit);

      // Return response
      const response: GraphSnapshotResponse = {
        nodes: pageNodeDtos,
        edges: allEdgeDtos,
        totalNodes: nodeCount,
        totalEdges: edgeCount,
        offset,
        limit,
      };

      // Record event
      await this.recordGraphQueryEvent('GRAPH_QUERY_EXECUTED', nodeId, depth);

      return response;
    } catch (error) {
      console.error('GraphController.getSnapshot failed:', error);
      throw new InternalServerErrorException('Failed to query graph snapshot');
    }
  }

  /**
   * GET /api/graph/stats
   *
   * Retrieve aggregate statistics about the WKG.
   * Includes node/edge counts, provenance distribution, and type distribution.
   *
   * Returns GraphStatsResponse with counts and distributions.
   */
  @Get('stats')
  async getGraphStats(): Promise<GraphStatsResponse> {
    try {
      const stats = await this.wkgService.queryGraphStats();

      // Build provenance distribution
      const provenanceDistribution: Record<string, number> = {};
      for (const [key, count] of Object.entries(stats.byProvenance)) {
        provenanceDistribution[key] = count;
      }

      // Build type distribution by counting labels
      const typeDistribution: Record<string, number> = {};
      // We don't have a direct type count from stats, so we infer from the level breakdown
      // For now, return empty type distribution and note that this could be enhanced
      // in a future iteration if the IWkgService provides label-level statistics
      for (const [level, count] of Object.entries(stats.byLevel)) {
        typeDistribution[`${level}_Node`] = count;
      }

      const response: GraphStatsResponse = {
        nodeCount: stats.totalNodes,
        edgeCount: stats.totalEdges,
        provenanceDistribution,
        typeDistribution,
      };

      // Record event
      await this.recordGraphQueryEvent('METRICS_QUERY_EXECUTED', undefined, 0);

      return response;
    } catch (error) {
      console.error('GraphController.getGraphStats failed:', error);
      throw new InternalServerErrorException('Failed to query graph stats');
    }
  }

  /**
   * GET /api/graph/subgraph?nodeId={id}&depth={n}&maxNodes={m}
   *
   * Retrieve a neighborhood subgraph centered on a specific node.
   *
   * Query parameters:
   * - nodeId (required): The node ID to center on
   * - depth (optional, default 3): Maximum traversal depth
   * - maxNodes (optional, default 200): Maximum nodes to return
   *
   * Returns GraphSnapshotResponse with the subgraph.
   */
  @Get('subgraph')
  async getSubgraph(
    @Query('nodeId') nodeId?: string,
    @Query('depth') depthStr?: string,
    @Query('maxNodes') maxNodesStr?: string,
  ): Promise<GraphSnapshotResponse> {
    if (!nodeId) {
      throw new BadRequestException('nodeId query parameter is required');
    }

    try {
      // Parse and validate parameters
      const depth = Math.min(
        10,
        Math.max(1, parseInt(depthStr ?? '3', 10) || 3),
      );
      const maxNodes = Math.min(
        10000,
        Math.max(1, parseInt(maxNodesStr ?? '200', 10) || 200),
      );

      // Query with timeout
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => {
            reject(new Error('Graph query timeout'));
          },
          this.graphQueryTimeoutMs,
        );
      });

      const result = Promise.race([
        this.queryNodeSubgraph(nodeId, depth, maxNodes),
        timeoutPromise,
      ]);

      const graph = await result;

      // Convert to DTOs
      const nodeCount = graph.nodes.length;
      const edgeCount = graph.edges.length;

      const nodeDtos = graph.nodes.map(
        (node): GraphNodeDto => ({
          id: node.id,
          label: this.extractLabel(node),
          type: node.labels[0] ?? 'Unknown',
          schema_level: this.resolveSchemaLevel(node),
          provenance: node.provenance,
          confidence: computeConfidence(node.actrParams),
          properties: node.properties ?? {},
        }),
      );

      const edgeDtos = graph.edges.map(
        (edge): GraphEdgeDto => ({
          id: edge.id,
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          relationship: edge.relationship,
          provenance: edge.provenance,
          confidence: computeConfidence(edge.actrParams),
        }),
      );

      const response: GraphSnapshotResponse = {
        nodes: nodeDtos,
        edges: edgeDtos,
        totalNodes: nodeCount,
        totalEdges: edgeCount,
        offset: 0,
        limit: nodeDtos.length,
      };

      // Record event
      await this.recordGraphQueryEvent('GRAPH_QUERY_EXECUTED', nodeId, depth);

      return response;
    } catch (error) {
      console.error('GraphController.getSubgraph failed:', error);
      throw new InternalServerErrorException('Failed to query subgraph');
    }
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private async queryNodeSubgraph(nodeId: string, depth: number, maxNodes: number) {
    return this.wkgService.queryContext(nodeId, depth);
  }

  private async queryGeneralSnapshot(maxNodes: number) {
    return this.wkgService.querySubgraph({}, maxNodes);
  }

  private extractLabel(node: any): string {
    // Try to extract a human-readable label from properties
    if (node.properties?.name) {
      return String(node.properties.name);
    }
    if (node.properties?.label) {
      return String(node.properties.label);
    }
    if (node.properties?.title) {
      return String(node.properties.title);
    }
    return node.labels?.[0] ?? 'Unknown';
  }

  /**
   * Resolve the schema_level for a KnowledgeNode.
   *
   * Prefers the `schema_level` property already stored on the node (set by
   * WkgService.upsertNode since E11-T002). Falls back to deriving the level
   * from the node's labels for any legacy node that predates the property.
   *
   * The cast is safe because schemaLevelFromLabels always returns a valid
   * SchemaLevel, and any stored string that was written by upsertNode is
   * also a valid SchemaLevel value.
   */
  private resolveSchemaLevel(node: any): SchemaLevel {
    const stored = node.properties?.schema_level as string | undefined;
    if (stored === 'instance' || stored === 'schema' || stored === 'meta_schema') {
      return stored;
    }
    return schemaLevelFromLabels(node.labels ?? []);
  }

  private async recordGraphQueryEvent(
    eventType: 'GRAPH_QUERY_EXECUTED' | 'METRICS_QUERY_EXECUTED',
    nodeId: string | undefined,
    depth: number,
  ): Promise<void> {
    try {
      await this.eventService.record({
        type: eventType,
        subsystem: 'WEB',
        sessionId: 'graph-query-session',
        driveSnapshot: {
          pressureVector: {
            systemHealth: 0.2,
            moralValence: 0.2,
            integrity: 0.2,
            cognitiveAwareness: 0.2,
            guilt: 0.0,
            curiosity: 0.5,
            boredom: 0.4,
            anxiety: 0.1,
            satisfaction: 0.0,
            sadness: 0.0,
            informationIntegrity: 0.3,
            social: 0.2,
          },
          timestamp: new Date(),
          tickNumber: 0,
          driveDeltas: {
            systemHealth: 0.0,
            moralValence: 0.0,
            integrity: 0.0,
            cognitiveAwareness: 0.0,
            guilt: 0.0,
            curiosity: 0.0,
            boredom: 0.0,
            anxiety: 0.0,
            satisfaction: 0.0,
            sadness: 0.0,
            informationIntegrity: 0.0,
            social: 0.0,
          },
          ruleMatchResult: {
            ruleId: null,
            eventType,
            matched: false,
          },
          totalPressure: 2.3,
          sessionId: 'graph-query-session',
        },
        schemaVersion: 1,
      });
    } catch (error) {
      console.error(`Failed to record ${eventType} event:`, error);
      // Don't throw — logging events are optional
    }
  }
}

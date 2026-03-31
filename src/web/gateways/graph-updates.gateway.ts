import {
  WebSocketGateway,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subscription } from 'rxjs';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IConnectionManagerService } from '../interfaces/web.interfaces';
import { CONNECTION_MANAGER } from '../web.tokens';
import type { WebConfig } from '../web.config';
import type {
  GraphUpdateFrame,
  GraphUpdateEventType,
  GraphUpdatePayload,
} from '../interfaces/websocket.interfaces';
import type { SylphieEvent, EventType } from '../../shared/types/event.types';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import { computeConfidence } from '../../shared/types/confidence.types';
import {
  schemaLevelFromLabels,
  type SchemaLevel,
} from '../../shared/types/schema-level.types';
import type { GraphNodeDto, GraphEdgeDto } from '../dtos/graph.dto';
import { getWireProtocol } from '../interfaces/wire-protocol';
import type { WireProtocol } from '../interfaces/wire-protocol';
import { adaptGraphUpdate, adaptGraphSnapshot } from '../adapters/graph.adapter';

/**
 * GraphUpdatesGateway — Real-time WKG change notifications.
 *
 * WebSocket gateway for streaming World Knowledge Graph mutations to connected
 * Cytoscape.js dashboard clients. Monitors for ENTITY_EXTRACTED, EDGE_REFINED,
 * and CONTRADICTION_DETECTED events and broadcasts them as GraphUpdateFrames.
 *
 * Dual-protocol support:
 * - 'sylphie-native' (default): emits GraphUpdateFrame (camelCase DTOs).
 * - 'cobeing-v1': emits CoBeing_GraphDelta (snake_case). On connect, a full
 *   graph snapshot is sent first so the client can render the current WKG
 *   state before incremental deltas begin arriving.
 *
 * Protocol is negotiated at connection time via the `?protocol=` query param
 * and is immutable for the lifetime of the connection.
 *
 * Channel: 'graph'
 * Path: '/ws/graph'
 */
@WebSocketGateway({ path: '/ws/graph' })
export class GraphUpdatesGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(GraphUpdatesGateway.name);

  /**
   * Per-client subscriptions to event polling.
   * Map<client, Subscription>
   */
  private readonly clientSubscriptions = new Map<unknown, Subscription>();

  /**
   * Per-client protocol preference.
   * Populated at connection time from the `?protocol=` query param.
   * Cleaned up on disconnect.
   */
  private readonly clientProtocols = new Map<unknown, WireProtocol>();

  /**
   * Polling interval for graph events in milliseconds.
   * Defaults to 5000ms (5 seconds) for low-frequency updates.
   */
  private readonly graphEventPollingIntervalMs: number;

  /**
   * Maximum nodes to fetch for the initial cobeing-v1 snapshot.
   * Bounded to avoid overwhelming the client on first connect.
   */
  private static readonly SNAPSHOT_MAX_NODES = 500;

  constructor(
    @Inject(EVENTS_SERVICE)
    private readonly eventService: IEventService,
    @Inject(CONNECTION_MANAGER)
    private readonly connectionManager: IConnectionManagerService,
    @Inject(WKG_SERVICE)
    private readonly wkgService: IWkgService,
    private readonly configService: ConfigService,
  ) {
    const webConfig = this.configService.get<WebConfig>('web');
    // Use telemetry batch interval as a baseline; graph events are lower frequency
    this.graphEventPollingIntervalMs =
      (webConfig?.telemetry.batchIntervalMs ?? 500) * 2;

    this.logger.debug(
      `Initialized GraphUpdatesGateway with polling interval ${this.graphEventPollingIntervalMs}ms`,
    );
  }

  /**
   * Handle a new WebSocket client connection.
   *
   * Negotiates the wire protocol from the connection URL, registers the client
   * with ConnectionManager on the 'graph' channel, and starts polling for graph
   * update events.
   *
   * For cobeing-v1 clients, an initial full graph snapshot is sent immediately
   * after registration so the client can render the current WKG state before
   * incremental deltas arrive.
   *
   * @param client - The connected WebSocket client
   */
  handleConnection(client: unknown, req?: unknown): void {
    const protocol = getWireProtocol(req ?? client);
    this.clientProtocols.set(client, protocol);

    this.logger.debug(`Client connected to graph updates gateway (protocol: ${protocol})`);

    // Register with connection manager
    this.connectionManager.register(client, 'graph');

    // For cobeing-v1 clients, send the initial snapshot asynchronously.
    // We do not await this — connection handling is synchronous in NestJS
    // gateways. Any failure is logged and swallowed; the client can still
    // receive incremental deltas even if the snapshot fails.
    if (protocol === 'cobeing-v1') {
      this.sendInitialSnapshotToClient(client).catch((error: unknown) => {
        this.logger.warn(
          `Failed to send initial snapshot to cobeing-v1 client: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }

    // Start polling for graph events
    const subscription = this.startGraphEventPolling(client);
    this.clientSubscriptions.set(client, subscription);

    this.logger.debug(
      `Graph client registered (total: ${this.connectionManager.getConnectionCount('graph')})`,
    );
  }

  /**
   * Handle a client disconnection.
   *
   * Unsubscribes from event polling, removes the protocol preference record,
   * and unregisters from ConnectionManager.
   *
   * @param client - The disconnected WebSocket client
   */
  handleDisconnect(client: unknown): void {
    this.logger.debug('Client disconnecting from graph updates gateway');

    // Unsubscribe and clean up polling
    const subscription = this.clientSubscriptions.get(client);
    if (subscription) {
      subscription.unsubscribe();
      this.clientSubscriptions.delete(client);
    }

    // Remove protocol preference
    this.clientProtocols.delete(client);

    // Unregister from connection manager
    this.connectionManager.unregister(client, 'graph');

    this.logger.debug(
      `Graph client unregistered (total: ${this.connectionManager.getConnectionCount('graph')})`,
    );
  }

  /**
   * Handle a graph subscription request from a connected client.
   *
   * Currently a no-op placeholder. Future implementation may support
   * client-side subscription preferences (e.g., node filter, subgraph scope).
   *
   * @param _payload - Client subscription parameters
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(@MessageBody() _payload: unknown): void {
    this.logger.debug('Client subscribed to graph updates');
  }

  // =========================================================================
  // Private methods
  // =========================================================================

  /**
   * Fetch the current WKG state and send it as a CoBeing_GraphDelta snapshot
   * to a newly connected cobeing-v1 client.
   *
   * Queries wkgService.querySubgraph to get nodes and edges up to
   * SNAPSHOT_MAX_NODES. Converts them to GraphNodeDto/GraphEdgeDto shapes
   * using the same mapping logic as GraphController, then runs them through
   * adaptGraphSnapshot() to produce the co-being wire format.
   *
   * @param client - The cobeing-v1 client to send the snapshot to.
   */
  private async sendInitialSnapshotToClient(client: unknown): Promise<void> {
    const result = await this.wkgService.querySubgraph(
      {},
      GraphUpdatesGateway.SNAPSHOT_MAX_NODES,
    );

    const nodeDtos: GraphNodeDto[] = result.nodes.map((node) => ({
      id: node.id,
      label: this.extractLabel(node),
      type: node.labels[0] ?? 'Unknown',
      schema_level: this.resolveSchemaLevel(node),
      provenance: node.provenance,
      confidence: computeConfidence(node.actrParams),
      properties: node.properties ?? {},
    }));

    const edgeDtos: GraphEdgeDto[] = result.edges.map((edge) => ({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relationship: edge.relationship,
      provenance: edge.provenance,
      confidence: computeConfidence(edge.actrParams),
    }));

    const snapshotDelta = adaptGraphSnapshot(nodeDtos, edgeDtos);

    await this.connectionManager.sendToClient(client, snapshotDelta);

    this.logger.debug(
      `Sent initial snapshot to cobeing-v1 client: ${nodeDtos.length} nodes, ${edgeDtos.length} edges`,
    );
  }

  /**
   * Start polling for graph update events.
   *
   * Queries TimescaleDB every graphEventPollingIntervalMs for graph-related
   * events and broadcasts them to the client. Applies protocol-appropriate
   * serialisation on each frame before sending.
   *
   * @param client - The connected client to poll and broadcast to.
   * @returns A Subscription whose unsubscribe() cancels the interval.
   */
  private startGraphEventPolling(client: unknown): Subscription {
    const pollingInterval = setInterval(() => {
      this.pollAndBroadcastGraphEvents(client);
    }, this.graphEventPollingIntervalMs);

    return new Subscription(() => {
      clearInterval(pollingInterval);
    });
  }

  /**
   * Poll for graph events and broadcast to client using the client's protocol.
   *
   * Queries TimescaleDB for recent graph-related events and sends them as:
   * - sylphie-native: GraphUpdateFrame (unchanged internal format)
   * - cobeing-v1: CoBeing_GraphDelta via adaptGraphUpdate(); null returns are skipped
   *
   * @param client - The connected client to poll for.
   */
  private async pollAndBroadcastGraphEvents(client: unknown): Promise<void> {
    try {
      const now = new Date();
      const startTime = new Date(now.getTime() - this.graphEventPollingIntervalMs);

      const graphEventTypes: EventType[] = [
        'ENTITY_EXTRACTED',
        'EDGE_REFINED',
        'CONTRADICTION_DETECTED',
      ];

      const events = await this.eventService.query({
        types: graphEventTypes,
        startTime,
        endTime: now,
        limit: 100,
      });

      const protocol = this.clientProtocols.get(client) ?? 'sylphie-native';

      for (const event of events) {
        const frame = this.eventToGraphFrame(event);
        if (!frame) {
          continue;
        }

        if (protocol === 'cobeing-v1') {
          const delta = adaptGraphUpdate(frame);
          if (delta === null) {
            // Frame carries no node/edge payload — skip rather than emitting
            // an empty delta to the co-being client.
            continue;
          }
          this.connectionManager.sendToClient(client, delta).catch((error: unknown) => {
            this.logger.warn(
              `Failed to send cobeing delta to client: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        } else {
          this.connectionManager.sendToClient(client, frame).catch((error: unknown) => {
            this.logger.warn(
              `Failed to send graph update frame to client: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        `Error polling graph events: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Convert a TimescaleDB event to a GraphUpdateFrame.
   *
   * Maps event types to graph update events.
   * Returns null if the event is not relevant to graph visualization.
   */
  private eventToGraphFrame(event: SylphieEvent): GraphUpdateFrame | null {
    const eventType = event.type;

    let updateEventType: GraphUpdateEventType | null = null;

    switch (eventType) {
      case 'ENTITY_EXTRACTED':
        updateEventType = 'node-created';
        break;

      case 'EDGE_REFINED':
        updateEventType = 'edge-updated';
        break;

      case 'CONTRADICTION_DETECTED':
        updateEventType = 'confidence-changed';
        break;

      default:
        return null;
    }

    if (!updateEventType) {
      return null;
    }

    // Create a minimal payload — in a full implementation, we would
    // extract node/edge data from the event's specific structure.
    // For now, just signal the graph has changed.
    const payload: GraphUpdatePayload = {};

    const frame: GraphUpdateFrame = {
      type: 'graph-update',
      event: updateEventType,
      payload,
      timestamp: event.timestamp.getTime(),
    };

    return frame;
  }

  // =========================================================================
  // Helpers shared with GraphController pattern
  // =========================================================================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractLabel(node: any): string {
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
   * Prefers the `schema_level` property stored on the node (set by
   * WkgService.upsertNode since E11-T002). Falls back to deriving the level
   * from the node's labels for any legacy node that predates the property.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolveSchemaLevel(node: any): SchemaLevel {
    const stored = node.properties?.schema_level as string | undefined;
    if (stored === 'instance' || stored === 'schema' || stored === 'meta_schema') {
      return stored;
    }
    return schemaLevelFromLabels(node.labels ?? []);
  }
}

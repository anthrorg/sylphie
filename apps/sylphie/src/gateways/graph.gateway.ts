import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { WkgQueryService } from '../services/wkg-query.service';

@WebSocketGateway({ path: '/ws/graph' })
export class GraphGateway implements OnGatewayConnection {
  private readonly logger = new Logger(GraphGateway.name);
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly wkg: WkgQueryService) {}

  async handleConnection(client: WebSocket) {
    this.clients.add(client);
    this.logger.log(`Graph client connected (${this.clients.size} total)`);

    client.on('close', () => {
      this.clients.delete(client);
      this.logger.log(`Graph client disconnected (${this.clients.size} total)`);
    });

    try {
      const snapshot = await this.wkg.getSnapshot();
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'snapshot', snapshot }));
      }
    } catch (err) {
      this.logger.error('Failed to send initial snapshot', (err as Error).stack);
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({ type: 'snapshot', snapshot: { nodes: [], edges: [] } }),
        );
      }
    }
  }

  /** Broadcast a delta to all connected graph clients. */
  broadcast(message: Record<string, unknown>) {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}

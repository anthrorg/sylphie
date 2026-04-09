import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { verboseFor } from '@sylphie/shared';
import { WkgQueryService } from '../services/wkg-query.service';

const vlog = verboseFor('Knowledge');

@WebSocketGateway({ path: '/ws/graph' })
export class GraphGateway implements OnGatewayConnection {
  private readonly logger = new Logger(GraphGateway.name);
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly wkg: WkgQueryService) {}

  async handleConnection(client: WebSocket) {
    this.clients.add(client);
    this.logger.log(`Graph client connected (${this.clients.size} total)`);
    vlog('graph client connected', { totalClients: this.clients.size });

    client.on('close', () => {
      this.clients.delete(client);
      this.logger.log(`Graph client disconnected (${this.clients.size} total)`);
      vlog('graph client disconnected', { totalClients: this.clients.size });
    });

    try {
      const snapshot = await this.wkg.getSnapshot();
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'snapshot', snapshot }));
        vlog('graph snapshot sent to client', { nodes: snapshot.nodes.length, edges: snapshot.edges.length });
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
    let sent = 0;
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sent++;
      }
    }
    vlog('graph update broadcast', { type: message['type'], clientCount: sent });
  }
}

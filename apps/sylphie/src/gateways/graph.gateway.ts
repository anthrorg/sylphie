import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';

@WebSocketGateway({ path: '/ws/graph' })
export class GraphGateway implements OnGatewayConnection {
  private readonly logger = new Logger(GraphGateway.name);

  handleConnection(client: WebSocket) {
    this.logger.log('Graph client connected');
    client.send(
      JSON.stringify({
        type: 'snapshot',
        snapshot: { nodes: [], edges: [] },
      }),
    );
  }
}

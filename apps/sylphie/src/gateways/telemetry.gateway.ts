import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';

/**
 * Telemetry gateway — streams backend logs and events to the frontend.
 *
 * Connected clients receive JSON messages with type 'system_log':
 *   { type: 'system_log', text: string, timestamp: string, level: 'info' | 'warn' | 'error' }
 *
 * Other services inject this gateway and call sendLog() to push entries
 * to the frontend System Logs panel.
 */
@WebSocketGateway({ path: '/ws/telemetry' })
export class TelemetryGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(TelemetryGateway.name);
  private readonly clients = new Set<WebSocket>();

  handleConnection(client: WebSocket) {
    this.clients.add(client);
    this.logger.log('Telemetry client connected');
  }

  handleDisconnect(client: WebSocket) {
    this.clients.delete(client);
  }

  /** Send a log entry to all connected frontend clients */
  sendLog(level: 'info' | 'warn' | 'error', text: string) {
    const payload = JSON.stringify({
      type: 'system_log',
      text,
      timestamp: new Date().toISOString(),
      level,
    });

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /** Broadcast any telemetry message to all connected clients */
  broadcast(message: unknown) {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}

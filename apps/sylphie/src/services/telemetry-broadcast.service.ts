import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

/**
 * Manages telemetry WebSocket clients and broadcasts messages to the frontend.
 *
 * Extracted from TelemetryGateway so services can push telemetry without
 * depending on the gateway (presentation) layer.
 */
@Injectable()
export class TelemetryBroadcastService {
  private readonly clients = new Set<WebSocket>();

  addClient(client: WebSocket) {
    this.clients.add(client);
  }

  removeClient(client: WebSocket) {
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

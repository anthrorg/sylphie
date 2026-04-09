import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { WebSocket } from 'ws';
import { SUPERVISOR_SERVICE } from '@sylphie/supervisor';
import type { ISupervisorService } from '@sylphie/supervisor';
import { verboseFor } from '@sylphie/shared';

const vlog = verboseFor('Supervisor');

/**
 * Manages supervisor WebSocket clients and broadcasts verdicts to the frontend.
 *
 * Extracted from SupervisorGateway so the verdict$ subscription can begin at
 * module init without depending on whether any WS clients are connected.
 * Mirrors TelemetryBroadcastService exactly.
 */
@Injectable()
export class SupervisorBroadcastService implements OnModuleInit {
  private readonly clients = new Set<WebSocket>();

  constructor(
    @Inject(SUPERVISOR_SERVICE)
    private readonly supervisorService: ISupervisorService,
  ) {}

  onModuleInit(): void {
    this.supervisorService.verdict$.subscribe((verdict) => {
      this.broadcast({ type: 'supervisor_verdict', verdict });
    });
  }

  addClient(client: WebSocket): void {
    this.clients.add(client);
  }

  removeClient(client: WebSocket): void {
    this.clients.delete(client);
  }

  /** Broadcast any supervisor message to all connected clients. */
  broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    let sent = 0;
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sent++;
      }
    }
    const msgType = (message as Record<string, unknown>)?.['type'];
    vlog('supervisor broadcast', { type: msgType, clientCount: sent });
  }
}

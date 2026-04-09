import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { SupervisorBroadcastService } from '../services/supervisor-broadcast.service';

/**
 * Supervisor gateway — registers WebSocket clients with the broadcast service.
 *
 * All actual broadcasting is handled by SupervisorBroadcastService so that
 * services can push verdicts without depending on the gateway layer.
 * Mirrors TelemetryGateway exactly.
 */
@WebSocketGateway({ path: '/ws/supervisor' })
export class SupervisorGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(SupervisorGateway.name);

  constructor(private readonly broadcast: SupervisorBroadcastService) {}

  handleConnection(client: WebSocket): void {
    this.broadcast.addClient(client);
    this.logger.log('Supervisor client connected');
  }

  handleDisconnect(client: WebSocket): void {
    this.broadcast.removeClient(client);
  }
}

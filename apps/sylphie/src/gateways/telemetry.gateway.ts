import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { TelemetryBroadcastService } from '../services/telemetry-broadcast.service';

/**
 * Telemetry gateway — registers WebSocket clients with the broadcast service.
 *
 * All actual broadcasting is handled by TelemetryBroadcastService so that
 * services can push telemetry without depending on the gateway layer.
 */
@WebSocketGateway({ path: '/ws/telemetry' })
export class TelemetryGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(TelemetryGateway.name);

  constructor(private readonly broadcast: TelemetryBroadcastService) {}

  handleConnection(client: WebSocket) {
    this.broadcast.addClient(client);
    this.logger.log('Telemetry client connected');
  }

  handleDisconnect(client: WebSocket) {
    this.broadcast.removeClient(client);
  }
}

import { WebSocketGateway, OnGatewayConnection } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';

@WebSocketGateway({ path: '/ws/webrtc' })
export class WebRTCGateway implements OnGatewayConnection {
  private readonly logger = new Logger(WebRTCGateway.name);

  handleConnection(_client: WebSocket) {
    this.logger.log('WebRTC signaling client connected');
    // Accepts connections — ICE/SDP signaling handled when implemented
  }
}

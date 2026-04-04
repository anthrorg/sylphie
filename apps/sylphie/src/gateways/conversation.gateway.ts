import {
  WebSocketGateway,
  SubscribeMessage,
  OnGatewayConnection,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { TickSamplerService } from '@sylphie/decision-making';

@WebSocketGateway({ path: '/ws/conversation' })
export class ConversationGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ConversationGateway.name);

  constructor(private readonly tickSampler: TickSamplerService) {}

  handleConnection(client: WebSocket) {
    this.logger.log('Conversation client connected');
    client.send(
      JSON.stringify({ type: 'system_status', is_thinking: false }),
    );
  }

  @SubscribeMessage('message')
  handleMessage(
    @MessageBody() data: { text: string; type: string },
    @ConnectedSocket() client: WebSocket,
  ) {
    this.logger.log(`Text input: "${data.text}"`);

    client.send(JSON.stringify({ type: 'input_ack' }));

    // Feed text into the sensory pipeline for encoding
    this.tickSampler.updateText(data.text);

    // TODO: Route through executor engine, produce real response
    client.send(
      JSON.stringify({
        type: 'cb_speech',
        text: '',
        turn_id: `stub-${Date.now()}`,
      }),
    );
  }
}

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
import { TtsService } from '../services/tts.service';

@WebSocketGateway({ path: '/ws/conversation' })
export class ConversationGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ConversationGateway.name);

  constructor(
    private readonly tickSampler: TickSamplerService,
    private readonly tts: TtsService,
  ) {}

  handleConnection(client: WebSocket) {
    this.logger.log('Conversation client connected');
    client.send(
      JSON.stringify({ type: 'system_status', is_thinking: false }),
    );
  }

  @SubscribeMessage('message')
  async handleMessage(
    @MessageBody() data: { text: string; type: string },
    @ConnectedSocket() client: WebSocket,
  ) {
    this.logger.log(`Text input: "${data.text}"`);

    client.send(JSON.stringify({ type: 'input_ack' }));

    // Feed text into the sensory pipeline for encoding
    this.tickSampler.updateText(data.text);

    // TODO: Route through executor engine, produce real response
    const responseText = '';
    const turnId = `stub-${Date.now()}`;

    // Synthesise TTS audio for the response if available
    let audioBase64: string | undefined;
    const audioFormat = 'audio/mpeg';

    if (responseText && this.tts.available) {
      const audioBuffer = await this.tts.synthesize(responseText);
      if (audioBuffer) {
        audioBase64 = audioBuffer.toString('base64');
      }
    }

    const response: Record<string, unknown> = {
      type: 'cb_speech',
      text: responseText,
      turn_id: turnId,
    };

    if (audioBase64) {
      response.audioBase64 = audioBase64;
      response.audioFormat = audioFormat;
    }

    client.send(JSON.stringify(response));
  }
}

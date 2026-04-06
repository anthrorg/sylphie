/**
 * ConversationGateway — Thin WebSocket transport layer.
 *
 * Per the architecture diagram, this gateway is the I/O boundary between the
 * frontend and the Communication subsystem. It does NOT contain business logic.
 *
 * Input path:
 *   WebSocket message → CommunicationService.parseInput() → TickSampler.updateText()
 *
 * Output path:
 *   CommunicationService.delivery$ → broadcast to WebSocket clients
 *
 * The gateway manages WebSocket client connections, thinking indicators,
 * and guardian feedback forwarding.
 */

import {
  WebSocketGateway,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, OnModuleInit } from '@nestjs/common';
import { WebSocket } from 'ws';
import { TickSamplerService } from '@sylphie/decision-making';
import { CommunicationService } from '../services/communication.service';
import { ConversationHistoryService } from '../services/conversation-history.service';
import { PersonModelService } from '../services/person-model.service';

@WebSocketGateway({ path: '/ws/conversation' })
export class ConversationGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  private readonly logger = new Logger(ConversationGateway.name);

  /** All connected WebSocket clients. */
  private readonly clients = new Set<WebSocket>();

  constructor(
    private readonly tickSampler: TickSamplerService,
    private readonly communication: CommunicationService,
    private readonly conversationHistory: ConversationHistoryService,
    private readonly personModel: PersonModelService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onModuleInit(): void {
    // Subscribe to Communication's delivery stream.
    // When the executor completes a cycle and Communication assembles the
    // response, it arrives here for WebSocket delivery.
    this.communication.delivery$.subscribe({
      next: (delivery) => {
        // Clear thinking indicator
        this.broadcast({ type: 'thinking_indicator', is_thinking: false });

        // Send the response to all connected clients
        this.broadcast(delivery);
      },
      error: (err) => {
        this.logger.error(`delivery$ stream error: ${err}`);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Connection Management
  // ---------------------------------------------------------------------------

  handleConnection(client: WebSocket): void {
    this.clients.add(client);
    this.logger.log(`Conversation client connected (${this.clients.size} total)`);
    client.send(JSON.stringify({ type: 'system_status', is_thinking: false }));
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
    this.logger.log(`Conversation client disconnected (${this.clients.size} total)`);
  }

  // ---------------------------------------------------------------------------
  // Input Handling
  // ---------------------------------------------------------------------------

  @SubscribeMessage('message')
  handleMessage(
    @MessageBody() data: { text: string; type: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    this.logger.log(`Text input: "${data.text}"`);

    // Acknowledge receipt immediately
    client.send(JSON.stringify({ type: 'input_ack' }));

    // Show thinking indicator while the executor processes
    this.broadcast({ type: 'thinking_indicator', is_thinking: true });

    // Communication subsystem parses the input (logs INPUT_RECEIVED + INPUT_PARSED)
    const sessionId = 'session-' + Date.now(); // TODO: proper session management
    this.communication.parseInput(data.text, sessionId);

    // Feed text into the sensory pipeline for encoding + executor tick
    this.tickSampler.updateText(data.text);

    // Push conversation history and person model into the sensory pipeline
    // so the LLM handler can read them from frame.raw
    this.tickSampler.update(
      'conversation_history',
      [...this.conversationHistory.getHistory()],
    );
    this.tickSampler.update(
      'person_model',
      this.personModel.getActivePersonModel(),
    );
  }

  // ---------------------------------------------------------------------------
  // Guardian Feedback
  // ---------------------------------------------------------------------------

  @SubscribeMessage('guardian_feedback')
  handleGuardianFeedback(
    @MessageBody() data: { turnId: string; feedbackType: 'confirmation' | 'correction' },
  ): void {
    this.logger.log(`Guardian feedback: ${data.feedbackType} for turn ${data.turnId}`);
    void this.communication.reportGuardianFeedback(data.turnId, data.feedbackType);
  }

  // ---------------------------------------------------------------------------
  // Broadcast Helper
  // ---------------------------------------------------------------------------

  /** Send a JSON message to all connected clients. */
  private broadcast(payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}

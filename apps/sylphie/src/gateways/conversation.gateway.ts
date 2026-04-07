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
 * guardian feedback forwarding, and user identity extraction from JWT tokens.
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
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import * as jwt from 'jsonwebtoken';
import { TickSamplerService } from '@sylphie/decision-making';
import { CommunicationService } from '../services/communication.service';
import { ConversationHistoryService } from '../services/conversation-history.service';
import { PersonModelService } from '../services/person-model.service';

/** Authenticated user identity extracted from JWT. */
interface ConnectedUser {
  userId: string;
  username: string;
}

@WebSocketGateway({ path: '/ws/conversation' })
export class ConversationGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  private readonly logger = new Logger(ConversationGateway.name);

  /** All connected WebSocket clients. */
  private readonly clients = new Set<WebSocket>();

  /** Map from WebSocket client to authenticated user identity. */
  private readonly clientUsers = new Map<WebSocket, ConnectedUser>();

  constructor(
    private readonly tickSampler: TickSamplerService,
    private readonly communication: CommunicationService,
    private readonly conversationHistory: ConversationHistoryService,
    private readonly personModel: PersonModelService,
    private readonly configService: ConfigService,
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

  handleConnection(client: WebSocket, ...args: any[]): void {
    this.clients.add(client);

    // Extract user identity from JWT token in query params
    const user = this.extractUserFromConnection(args);
    if (user) {
      this.clientUsers.set(client, user);
      this.logger.log(
        `Conversation client connected: ${user.username} (${user.userId}) ` +
        `(${this.clients.size} total)`,
      );

      // Ensure OKG Person anchor node exists for this user
      void this.personModel.ensurePersonNode(user.userId, user.username, true);
      this.personModel.setActivePerson(user.userId);
    } else {
      this.logger.log(`Conversation client connected (${this.clients.size} total)`);
    }

    client.send(JSON.stringify({ type: 'system_status', is_thinking: false }));
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
    this.clientUsers.delete(client);
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

    // Resolve user identity for this client
    const user = this.clientUsers.get(client);
    const userId = user?.userId ?? 'guardian';
    const sessionId = `session-${userId}-${Date.now()}`;

    // Set active person so the person model is included in LLM context
    this.personModel.setActivePerson(userId);

    // Check for trigger phrases — these short-circuit the normal pipeline
    // and produce an immediate response (e.g., "Who am I?" → OKG lookup).
    void this.communication.handleTriggerPhrase(data.text, sessionId, userId)
      .then((handled) => {
        if (handled) {
          this.logger.log(`Trigger phrase handled: "${data.text}"`);
          return;
        }

        // Normal pipeline: parse input, feed into sensory pipeline
        this.communication.parseInput(data.text, sessionId, userId);

        this.tickSampler.updateText(data.text);

        this.tickSampler.update(
          'conversation_history',
          [...this.conversationHistory.getHistory()],
        );
        this.tickSampler.update(
          'person_model',
          this.personModel.getActivePersonModel(),
        );
        this.tickSampler.update(
          'speaker_name',
          user?.username ?? 'someone',
        );
      });
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

  // ---------------------------------------------------------------------------
  // JWT Extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract user identity from the WebSocket connection's query params.
   * The frontend includes `?token=<JWT>` when opening the connection.
   */
  private extractUserFromConnection(args: any[]): ConnectedUser | null {
    try {
      // NestJS ws adapter passes the IncomingMessage as args[0]
      const request = args[0];
      if (!request?.url) return null;

      const url = new URL(request.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token) return null;

      const secret = this.configService.get<string>('JWT_SECRET');
      if (!secret) return null;

      const payload = jwt.verify(token, secret) as { sub: string; username: string };
      return { userId: payload.sub, username: payload.username };
    } catch {
      return null; // Invalid or missing token — proceed as anonymous
    }
  }
}

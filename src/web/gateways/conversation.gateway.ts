import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ICommunicationService } from '../../communication/interfaces/communication.interfaces';
import { COMMUNICATION_SERVICE } from '../../communication/communication.tokens';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { IConnectionManagerService } from '../interfaces/web.interfaces';
import { CONNECTION_MANAGER } from '../web.tokens';
import type { GuardianInput } from '../../communication/interfaces/communication.interfaces';
import { DRIVE_INDEX_ORDER } from '../../shared/types/drive.types';

/**
 * ConversationGateway — Real-time bidirectional conversation.
 *
 * Uses raw `client.on('message')` instead of NestJS @SubscribeMessage
 * because the frontend sends plain JSON, not the { event, data } envelope
 * that NestJS WS decorators expect.
 *
 * Wire format matches co-being's contract:
 *   Inbound:  { type: 'user_message', text: '...' }
 *   Outbound: { type: 'cb_speech' | 'system_status' | 'response', text: '...', timestamp: '...' }
 *
 * Path: '/ws/conversation'
 */
@WebSocketGateway({ path: '/ws/conversation' })
export class ConversationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ConversationGateway.name);

  /** Current session ID — only one conversation client at a time. */
  private currentSessionId = '';

  constructor(
    @Inject(COMMUNICATION_SERVICE)
    private readonly communicationService: ICommunicationService,
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
    @Inject(CONNECTION_MANAGER)
    private readonly connectionManager: IConnectionManagerService,
  ) {
    this.logger.debug('Initialized ConversationGateway');
  }

  getCurrentSessionId(): string {
    return this.currentSessionId;
  }

  handleConnection(client: any): void {
    this.connectionManager.register(client, 'conversation');

    const sessionId = randomUUID();
    this.currentSessionId = sessionId;
    this.logger.log(`ws_conversation_connected session_id=${sessionId}`);

    // Send connect message in co-being format
    this.sendToClient(client, {
      type: 'system_status',
      text: 'Connected to Sylphie conversation channel',
      timestamp: new Date().toISOString(),
    });

    // Listen for raw messages (NOT @SubscribeMessage — frontend sends plain JSON)
    client.on('message', (rawData: Buffer | string) => {
      const data = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
      void this.handleRawMessage(client, data);
    });
  }

  handleDisconnect(client: any): void {
    this.logger.log('ws_conversation_disconnected');
    this.connectionManager.unregister(client, 'conversation');
  }

  /**
   * Handle an incoming WebSocket message.
   * Matches co-being's inbound contract:
   *   { type: 'user_message', text: '...' }
   *   { type: 'phrase_word_rating', phrase_node_id: '...', word: '...', ... }
   */
  private async handleRawMessage(client: any, data: string): Promise<void> {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;

      if (parsed['type'] === 'phrase_word_rating') {
        // TODO: Wire to WKG edge confidence adjustment
        this.logger.debug(`phrase_word_rating received (not yet wired)`);
        return;
      }

      // Accept both co-being format { type: 'user_message', text: '...' }
      // and NestJS envelope format { event: 'message', data: { text: '...' } }
      let text: string | undefined;
      if (parsed['type'] === 'user_message' && parsed['text']) {
        text = parsed['text'] as string;
      } else if (parsed['event'] === 'message' && parsed['data']) {
        const innerData = parsed['data'] as Record<string, unknown>;
        text = innerData['text'] as string | undefined;
      }

      if (text) {
        this.logger.log(`ws_conversation_input text="${text.slice(0, 50)}"`);

        // Send thinking indicator
        this.sendToClient(client, {
          type: 'system_status',
          text: 'thinking',
          is_thinking: true,
          timestamp: new Date().toISOString(),
        });

        try {
          // Route through CommunicationService
          const guardianInput: GuardianInput = {
            text,
            sessionId: this.currentSessionId,
            timestamp: new Date(),
          };

          const result =
            await this.communicationService.handleGuardianInput(guardianInput);

          // Generate response
          const driveState = this.driveStateReader.getCurrentState();
          const primaryDrive = DRIVE_INDEX_ORDER.reduce(
            (best, name) =>
              driveState.pressureVector[name] > driveState.pressureVector[best]
                ? name
                : best,
            DRIVE_INDEX_ORDER[0],
          );

          const actionIntent = {
            actionType: 'RESPOND_TO_GUARDIAN',
            content: text,
            motivatingDrive: primaryDrive,
            driveSnapshot: driveState,
          };

          const generated =
            await this.communicationService.generateResponse(actionIntent);

          // Send response in co-being format
          this.sendToClient(client, {
            type: 'cb_speech',
            text: generated.text,
            action: 'respond_to_guardian',
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          this.logger.error(
            `Error handling message: ${error instanceof Error ? error.message : String(error)}`,
          );
          this.sendToClient(client, {
            type: 'system_status',
            text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            timestamp: new Date().toISOString(),
          });
        } finally {
          // Clear thinking indicator
          this.sendToClient(client, {
            type: 'system_status',
            text: '',
            is_thinking: false,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch {
      this.logger.warn('ws_conversation_invalid_json');
    }
  }

  /**
   * Send a flat JSON message to a client. Matches co-being wire format.
   */
  private sendToClient(client: any, message: Record<string, unknown>): void {
    try {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify(message));
      }
    } catch (error) {
      this.logger.warn(
        `Failed to send to client: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

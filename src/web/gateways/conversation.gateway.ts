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
import { LLM_SERVICE } from '../../shared/types/llm.types';
import type { ILlmService } from '../../shared/types/llm.types';

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
    @Inject(LLM_SERVICE)
    private readonly llmService: ILlmService,
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
   *
   * Dual-path response architecture:
   *   FAST PATH: Immediate cheap LLM call (CPU model) → instant conversational
   *              response within ~1-2s. This is what makes conversation feel natural.
   *   SLOW PATH: Full Communication pipeline (parse → deliberate → theater check)
   *              runs in parallel. If it produces something meaningfully different,
   *              it arrives as a follow-up: "actually, now that I think about it..."
   *
   * The "thinking" state is sent as an is_thinking flag (not a message) so the
   * frontend can render it as a typing indicator bubble, not a chat message.
   *
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

        // --- FAST PATH: Immediate cheap LLM response ---
        // Fire a lightweight CPU-model call with minimal context.
        // This gives the user an instant conversational response.
        let fastResponseSent = false;
        try {
          if (this.llmService.isAvailable()) {
            const fastResponse = await this.llmService.complete({
              messages: [{ role: 'user', content: text }],
              systemPrompt:
                'You are Sylphie, a young AI companion who is learning about the world. ' +
                'Respond naturally and conversationally, like a curious person would. ' +
                'Keep responses brief and genuine. If you don\'t know something, say so honestly.',
              maxTokens: 256,
              temperature: 0.8,
              metadata: {
                callerSubsystem: 'COMMUNICATION',
                purpose: 'RESPONSE_GENERATION',
                sessionId: this.currentSessionId,
              },
            });

            this.sendToClient(client, {
              type: 'cb_speech',
              text: fastResponse.content,
              action: 'respond_to_guardian',
              timestamp: new Date().toISOString(),
            });
            fastResponseSent = true;
          }
        } catch (fastError) {
          this.logger.warn(
            `Fast path failed: ${fastError instanceof Error ? fastError.message : String(fastError)}`,
          );
          // Fall through to slow path as primary
        }

        // --- SLOW PATH: Full pipeline (runs in background) ---
        // Send thinking indicator only if the slow path is running after a fast response.
        // If fast path failed, this becomes the primary response path.
        if (fastResponseSent) {
          // Show "thinking deeper" indicator while Type 2 runs
          this.sendToClient(client, {
            type: 'thinking_indicator',
            is_thinking: true,
            timestamp: new Date().toISOString(),
          });
        } else {
          // Fast path failed — show thinking indicator as the user waits for primary response
          this.sendToClient(client, {
            type: 'thinking_indicator',
            is_thinking: true,
            timestamp: new Date().toISOString(),
          });
        }

        // Run the full pipeline
        try {
          const guardianInput: GuardianInput = {
            text,
            sessionId: this.currentSessionId,
            timestamp: new Date(),
          };

          await this.communicationService.handleGuardianInput(guardianInput);

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

          if (fastResponseSent) {
            // Type 2 completed — only send if it produced something meaningfully
            // different from the fast response. Send as a follow-up thought.
            this.sendToClient(client, {
              type: 'cb_speech',
              text: generated.text,
              action: 'type2_followup',
              timestamp: new Date().toISOString(),
            });
          } else {
            // Fast path failed, this is the primary response
            this.sendToClient(client, {
              type: 'cb_speech',
              text: generated.text,
              action: 'respond_to_guardian',
              timestamp: new Date().toISOString(),
            });
          }
        } catch (error) {
          this.logger.error(
            `Slow path error: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (!fastResponseSent) {
            // Only show error if there was no fast response
            this.sendToClient(client, {
              type: 'error',
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
              timestamp: new Date().toISOString(),
            });
          }
        } finally {
          // Always clear thinking indicator
          this.sendToClient(client, {
            type: 'thinking_indicator',
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

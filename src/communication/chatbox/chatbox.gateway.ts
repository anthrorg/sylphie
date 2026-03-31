/**
 * ChatboxGateway — WebSocket gateway for real-time chat communication.
 *
 * Provides a WebSocket endpoint for guardian input and Sylphie response delivery.
 * Handles real-time bidirectional communication: receives typed input from the
 * guardian and sends responses back via WebSocket.
 *
 * This gateway is the web surface layer for the Communication subsystem. It does not
 * make decisions — it only routes input to CommunicationService and delivers output
 * to the connected client.
 *
 * CANON §Subsystem 2 (Communication): Communication is responsible for input parsing,
 * response generation, and output delivery. This gateway is the delivery mechanism.
 *
 * WebSocket events:
 *   'guardian_message' → parse input → emit event for pipeline (wired in T012)
 *   'sylphie_response' → broadcast generated response
 *   'sylphie_initiated' → broadcast Sylphie-initiated comment
 *   'typing_indicator' → show when processing (Type 2)
 *   'connection_status' → health updates
 *
 * Design note: This gateway does NOT directly call CommunicationService to avoid
 * circular dependencies. Instead, it manages WebSocket connections, message routing,
 * thread tracking, and emits internal events that will be wired to the communication
 * pipeline in the facade (T012). The actual request/response cycle is decoupled via
 * the emit pattern: the gateway emits "process_message" internally, and listens for
 * "send_response" from external components.
 */

import { EventEmitter } from 'events';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ConversationThread, ConversationMessage } from '../interfaces/communication.interfaces';

// Use any for socket.io types if not available; will be properly typed at runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Socket = any;

/**
 * Internal event emitted by the gateway when a message should be processed.
 * Listeners (wired in facade) will call CommunicationService.handleGuardianInput()
 * and emit back a response via gateway.broadcastResponse().
 */
export interface InternalMessageRequest {
  readonly clientId: string;
  readonly threadId: string;
  readonly text: string;
  readonly timestamp: Date;
}

/**
 * Internal event for responses ready to broadcast.
 * Emitted by external handlers and listened to by the gateway.
 */
export interface InternalResponsePayload {
  readonly clientId: string;
  readonly threadId: string;
  readonly text: string;
  readonly speaker: 'sylphie' | 'guardian';
  readonly timestamp: Date;
  readonly isTypingIndicator?: boolean;
}

@WebSocketGateway({
  path: '/ws/chat',
})
export class ChatboxGateway extends EventEmitter implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatboxGateway.name);

  @WebSocketServer()
  server: Server;

  constructor() {
    super();
  }

  /**
   * In-memory store of connected clients and their associated metadata.
   * Maps clientId (socket.id equivalent) to connection info.
   */
  private connectedClients = new Map<
    string,
    {
      socket: Socket;
      connectedAt: Date;
      lastActivity: Date;
      personId: string; // e.g. 'Person_Jim'
    }
  >();

  /**
   * In-memory store of conversation threads.
   * Maps threadId to ConversationThread.
   * For now, threads live only in memory; persistence will be added in Learning subsystem.
   */
  private conversationThreads = new Map<string, ConversationThread>();

  /**
   * Map of threadId → set of clientIds participating in that thread.
   * Enables broadcasting to all clients in a conversation.
   */
  private threadParticipants = new Map<string, Set<string>>();

  /**
   * Called when a client connects to the WebSocket.
   *
   * Initializes connection tracking, assigns a thread ID if not provided,
   * and sends a connection_status event to the client.
   */
  handleConnection(client: Socket): void {
    const clientId = client.id;
    const threadId = client.handshake.query.threadId
      ? String(client.handshake.query.threadId)
      : randomUUID();

    // Register the client
    this.connectedClients.set(clientId, {
      socket: client,
      connectedAt: new Date(),
      lastActivity: new Date(),
      personId: 'Person_Jim', // Default; can be overridden via auth in later epics
    });

    // Add to thread participants
    if (!this.threadParticipants.has(threadId)) {
      this.threadParticipants.set(threadId, new Set());
    }
    this.threadParticipants.get(threadId)!.add(clientId);

    // Create or resume thread
    if (!this.conversationThreads.has(threadId)) {
      this.conversationThreads.set(threadId, {
        threadId,
        personId: 'Person_Jim',
        messages: [],
        topics: [],
        startedAt: new Date(),
        lastMessageAt: new Date(),
      });
    }

    this.logger.log(
      `Client ${clientId} connected to thread ${threadId}`,
    );

    // Send connection confirmation
    client.emit('connection_status', {
      status: 'connected',
      clientId,
      threadId,
      timestamp: new Date(),
    });
  }

  /**
   * Called when a client disconnects from the WebSocket.
   *
   * Cleans up connection tracking. Thread data is preserved for resume.
   */
  handleDisconnect(client: Socket): void {
    const clientId = client.id;
    const clientInfo = this.connectedClients.get(clientId);

    if (!clientInfo) {
      return;
    }

    // Find and remove from thread participants
    for (const [threadId, participants] of this.threadParticipants) {
      if (participants.has(clientId)) {
        participants.delete(clientId);

        // If no more participants in this thread, optionally archive it
        // For now, we keep threads alive for resume capability
        if (participants.size === 0) {
          this.logger.log(
            `Thread ${threadId} has no more active participants`,
          );
        }
      }
    }

    this.connectedClients.delete(clientId);
    this.logger.log(`Client ${clientId} disconnected`);
  }

  /**
   * Handle a message from the guardian.
   *
   * Receives typed text input, adds it to the conversation thread,
   * and emits an internal event for the pipeline to process.
   *
   * WebSocket event: 'guardian_message'
   * Payload: { threadId, text }
   *
   * The gateway does NOT call CommunicationService directly. Instead, it:
   * 1. Validates the message
   * 2. Adds it to the thread history
   * 3. Broadcasts a typing indicator to all thread participants
   * 4. Emits an internal 'process_message' event
   * 5. Waits for a 'send_response' event from external handlers
   */
  @SubscribeMessage('guardian_message')
  async handleMessage(
    client: Socket,
    payload: { threadId: string; text: string },
  ): Promise<void> {
    const clientId = client.id;
    const { threadId, text } = payload;

    // Validate
    if (!threadId || !text || text.trim().length === 0) {
      client.emit('error', {
        code: 'INVALID_MESSAGE',
        message: 'Message must include threadId and non-empty text',
      });
      return;
    }

    // Lookup thread
    const thread = this.conversationThreads.get(threadId);
    if (!thread) {
      client.emit('error', {
        code: 'THREAD_NOT_FOUND',
        message: `Thread ${threadId} not found`,
      });
      return;
    }

    const clientInfo = this.connectedClients.get(clientId);
    if (!clientInfo) {
      client.emit('error', {
        code: 'CLIENT_NOT_REGISTERED',
        message: 'Client not registered',
      });
      return;
    }

    const timestamp = new Date();

    // Add guardian message to thread
    const guardianMsg: ConversationMessage = {
      speaker: 'guardian',
      content: text,
      timestamp,
    };

    // Update thread (mutate messages array)
    const updatedMessages = [...thread.messages, guardianMsg];
    this.conversationThreads.set(threadId, {
      ...thread,
      messages: updatedMessages,
      lastMessageAt: timestamp,
    });

    // Update client's last activity
    clientInfo.lastActivity = timestamp;

    // Broadcast the guardian message to all participants
    this.broadcastToThread(threadId, 'guardian_message_received', {
      threadId,
      clientId,
      text,
      timestamp,
    });

    // Emit typing indicator while processing
    this.broadcastToThread(threadId, 'typing_indicator', {
      speaker: 'sylphie',
      isTyping: true,
      timestamp,
    });

    // Emit internal event for the pipeline to process
    // The facade (T012) will listen for this and call CommunicationService
    this.emit('internal:process_message', {
      clientId,
      threadId,
      text,
      timestamp,
    } as InternalMessageRequest);
  }

  /**
   * Broadcast a response from Sylphie to all clients in the thread.
   *
   * Called by the Communication pipeline (via facade in T012) after
   * CommunicationService.generateResponse() completes.
   *
   * Adds the response to the conversation thread and broadcasts to all participants.
   *
   * @param threadId - The conversation thread ID
   * @param text - The generated response text
   * @param timestamp - Wall-clock time of response
   */
  broadcastResponse(
    threadId: string,
    text: string,
    timestamp: Date = new Date(),
  ): void {
    const thread = this.conversationThreads.get(threadId);
    if (!thread) {
      this.logger.warn(`Cannot broadcast response: thread ${threadId} not found`);
      return;
    }

    // Add Sylphie message to thread
    const sylphieMsg: ConversationMessage = {
      speaker: 'sylphie',
      content: text,
      timestamp,
    };

    const updatedMessages = [...thread.messages, sylphieMsg];
    this.conversationThreads.set(threadId, {
      ...thread,
      messages: updatedMessages,
      lastMessageAt: timestamp,
    });

    // Clear typing indicator
    this.broadcastToThread(threadId, 'typing_indicator', {
      speaker: 'sylphie',
      isTyping: false,
      timestamp,
    });

    // Broadcast the response
    this.broadcastToThread(threadId, 'sylphie_response', {
      threadId,
      text,
      timestamp,
    });
  }

  /**
   * Broadcast a Sylphie-initiated comment to all clients in the thread.
   *
   * Called by the Drive Engine or Planning subsystem when an unprompted
   * comment should be made (Curiosity, Social, Boredom pressure).
   *
   * @param threadId - The conversation thread ID
   * @param text - The comment text
   * @param motivatingDrive - The drive that motivated the comment
   * @param timestamp - Wall-clock time of comment
   */
  broadcastInitiatedComment(
    threadId: string,
    text: string,
    motivatingDrive: string,
    timestamp: Date = new Date(),
  ): void {
    const thread = this.conversationThreads.get(threadId);
    if (!thread) {
      this.logger.warn(
        `Cannot broadcast initiated comment: thread ${threadId} not found`,
      );
      return;
    }

    // Add Sylphie message to thread
    const sylphieMsg: ConversationMessage = {
      speaker: 'sylphie',
      content: text,
      timestamp,
    };

    const updatedMessages = [...thread.messages, sylphieMsg];
    this.conversationThreads.set(threadId, {
      ...thread,
      messages: updatedMessages,
      lastMessageAt: timestamp,
    });

    // Broadcast the initiated comment
    this.broadcastToThread(threadId, 'sylphie_initiated', {
      threadId,
      text,
      motivatingDrive,
      timestamp,
    });
  }

  /**
   * Broadcast a message to all connected clients in a specific thread.
   *
   * @param threadId - The thread ID
   * @param event - The WebSocket event name
   * @param payload - The event payload
   */
  private broadcastToThread(
    threadId: string,
    event: string,
    payload: unknown,
  ): void {
    const participants = this.threadParticipants.get(threadId);
    if (!participants || participants.size === 0) {
      return;
    }

    for (const clientId of participants) {
      const clientInfo = this.connectedClients.get(clientId);
      if (clientInfo) {
        clientInfo.socket.emit(event, payload);
      }
    }
  }

  /**
   * Get the current conversation thread for a given thread ID.
   *
   * Returns null if the thread does not exist.
   *
   * @param threadId - The thread ID
   * @returns The ConversationThread or null
   */
  getThread(threadId: string): ConversationThread | null {
    return this.conversationThreads.get(threadId) ?? null;
  }

  /**
   * Get all threads currently in memory.
   *
   * Used for debugging and monitoring; not part of normal gateway operations.
   *
   * @returns Map of threadId → ConversationThread
   */
  getAllThreads(): Map<string, ConversationThread> {
    return new Map(this.conversationThreads);
  }

  /**
   * Get connection info for a specific client.
   *
   * Returns null if the client is not connected.
   *
   * @param clientId - The client ID (socket.id)
   * @returns Connection info or null
   */
  getClientInfo(clientId: string) {
    return this.connectedClients.get(clientId) ?? null;
  }

  /**
   * Get all connected clients.
   *
   * @returns Map of clientId → connection info
   */
  getAllClients() {
    return new Map(this.connectedClients);
  }

  /**
   * Update conversation thread topics.
   *
   * Called by the Learning subsystem to track what topics have been
   * discussed in this thread.
   *
   * @param threadId - The thread ID
   * @param topics - New topics to add/update
   */
  updateThreadTopics(threadId: string, topics: readonly string[]): void {
    const thread = this.conversationThreads.get(threadId);
    if (thread) {
      this.conversationThreads.set(threadId, {
        ...thread,
        topics: Array.from(new Set([...thread.topics, ...topics])),
      });
    }
  }
}

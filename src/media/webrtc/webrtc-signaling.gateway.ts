import {
  WebSocketGateway,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { WEBRTC_SIGNALING_SERVICE } from '../media.tokens';
import type { IWebRtcSignalingService, SignalingMessage } from '../interfaces/media.interfaces';

// ---------------------------------------------------------------------------
// Raw ws client shape
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the raw ws WebSocket client injected by WsAdapter.
 * We keep this local to the gateway — it is not part of the public contract.
 */
interface WsClient {
  readonly readyState: number;
  send(data: string): void;
}

/** WebSocket.OPEN constant — avoids importing the ws package for one value. */
const WS_OPEN = 1;

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/**
 * WebRtcSignalingGateway — WebRTC signaling channel at /ws/media.
 *
 * Acts as a rendezvous point for browser peers negotiating a WebRTC peer
 * connection. The gateway receives offer/answer/ICE-candidate messages from
 * one peer, stores them via WebRtcSignalingService, and relays them to all
 * other clients subscribed to the same session.
 *
 * Protocol (client -> server):
 *   'offer'         { sessionId?, payload: RTCSessionDescriptionInit }
 *   'answer'        { sessionId: string, payload: RTCSessionDescriptionInit }
 *   'ice-candidate' { sessionId: string, payload: RTCIceCandidateInit }
 *   'session-end'   { sessionId: string }
 *
 * Protocol (server -> client):
 *   { type: 'offer' | 'answer' | 'ice-candidate' | 'session-end', sessionId, payload }
 *   { type: 'session-created', sessionId }
 *   { type: 'error', message }
 *
 * Path: /ws/media
 * Adapter: WsAdapter (raw ws). Namespace NOT used — WsAdapter does not support it.
 *
 * CANON §Module boundary: This gateway is the only entry point into MediaModule.
 * It does not import from WebModule, DriveEngineModule, or any subsystem module.
 */
@WebSocketGateway({ path: '/ws/media' })
export class WebRtcSignalingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(WebRtcSignalingGateway.name);

  /**
   * Map from WebSocket client -> sessionId.
   * Used to clean up the session when a client disconnects unexpectedly.
   */
  private readonly clientSessions = new Map<unknown, string>();

  /**
   * Map from sessionId -> Set of subscribed clients.
   * Used to broadcast signals to all peers in the same session.
   */
  private readonly sessionClients = new Map<string, Set<unknown>>();

  constructor(
    @Inject(WEBRTC_SIGNALING_SERVICE)
    private readonly signalingService: IWebRtcSignalingService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Handle a new WebSocket client connection.
   *
   * Logs the connection. Session creation is deferred until the client sends
   * an 'offer' message — connections without an offer carry no session state.
   *
   * @param client - The connected raw ws client.
   */
  handleConnection(client: unknown): void {
    this.logger.debug('Media client connected');
  }

  /**
   * Handle a client disconnection.
   *
   * If the disconnecting client was the offerer in an active session, that
   * session is ended and all remaining peers in the session receive a
   * 'session-end' signal.
   *
   * @param client - The disconnected raw ws client.
   */
  handleDisconnect(client: unknown): void {
    const sessionId = this.clientSessions.get(client);

    if (sessionId !== undefined) {
      this.logger.debug(
        `Media client disconnected, ending session: ${sessionId}`,
      );

      // Notify remaining peers before tearing down
      this.broadcastToSession(sessionId, client, {
        type: 'session-end',
        sessionId,
        payload: null,
      });

      this.signalingService.endSession(sessionId);
      this.teardownSessionRouting(sessionId);
    } else {
      this.logger.debug('Media client disconnected (no active session)');
    }
  }

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle an SDP offer from peer A.
   *
   * Creates a new session, stores the offer, and responds to the sender with
   * the newly-created sessionId so subsequent messages can reference it.
   *
   * @param payload - { payload: RTCSessionDescriptionInit }
   * @param client - The WebSocket client sending the offer (peer A).
   */
  @SubscribeMessage('offer')
  handleOffer(
    @MessageBody() payload: unknown,
    @ConnectedSocket() client: unknown,
  ): void {
    if (!this.isValidMessage(payload)) {
      this.sendError(client, 'offer requires a payload field');
      return;
    }

    const message = payload as Record<string, unknown>;
    const offerPayload = message['payload'];

    const clientId = this.getClientId(client);
    const sessionId = this.signalingService.handleOffer(clientId, offerPayload);

    // Register client-session routing
    this.clientSessions.set(client, sessionId);
    this.addClientToSession(sessionId, client);

    // Acknowledge: send sessionId back so peer A can include it in subsequent messages
    this.sendToClient(client, {
      type: 'session-created',
      sessionId,
      payload: null,
    });

    this.logger.debug(`Offer received, session created: ${sessionId}`);
  }

  /**
   * Handle an SDP answer from peer B.
   *
   * Stores the answer and relays it to all other clients in the session
   * (primarily peer A, the offerer).
   *
   * @param payload - { sessionId: string, payload: RTCSessionDescriptionInit }
   * @param client - The WebSocket client sending the answer (peer B).
   */
  @SubscribeMessage('answer')
  handleAnswer(
    @MessageBody() payload: unknown,
    @ConnectedSocket() client: unknown,
  ): void {
    if (!this.isSessionMessage(payload)) {
      this.sendError(client, 'answer requires sessionId and payload fields');
      return;
    }

    const message = payload as Record<string, unknown>;
    const sessionId = message['sessionId'] as string;
    const answerPayload = message['payload'];

    // Add peer B to the session routing table so they receive future signals
    this.clientSessions.set(client, sessionId);
    this.addClientToSession(sessionId, client);

    this.signalingService.handleAnswer(sessionId, answerPayload);

    // Relay the answer to all other peers in the session (peer A)
    this.broadcastToSession(sessionId, client, {
      type: 'answer',
      sessionId,
      payload: answerPayload,
    });

    this.logger.debug(`Answer received for session: ${sessionId}`);
  }

  /**
   * Handle a trickle ICE candidate from either peer.
   *
   * Stores the candidate and relays it to all other clients in the session.
   *
   * @param payload - { sessionId: string, payload: RTCIceCandidateInit }
   * @param client - The WebSocket client sending the candidate.
   */
  @SubscribeMessage('ice-candidate')
  handleIceCandidate(
    @MessageBody() payload: unknown,
    @ConnectedSocket() client: unknown,
  ): void {
    if (!this.isSessionMessage(payload)) {
      this.sendError(client, 'ice-candidate requires sessionId and payload fields');
      return;
    }

    const message = payload as Record<string, unknown>;
    const sessionId = message['sessionId'] as string;
    const candidatePayload = message['payload'];

    this.signalingService.handleIceCandidate(sessionId, candidatePayload);

    // Relay to the other peer(s) in the session
    this.broadcastToSession(sessionId, client, {
      type: 'ice-candidate',
      sessionId,
      payload: candidatePayload,
    });

    this.logger.debug(`ICE candidate received for session: ${sessionId}`);
  }

  /**
   * Handle an explicit session teardown initiated by a peer.
   *
   * Notifies all remaining peers of the end signal, ends the session in the
   * service, and cleans up routing state.
   *
   * @param payload - { sessionId: string }
   * @param client - The WebSocket client ending the session.
   */
  @SubscribeMessage('session-end')
  handleSessionEnd(
    @MessageBody() payload: unknown,
    @ConnectedSocket() client: unknown,
  ): void {
    if (!this.isSessionIdMessage(payload)) {
      this.sendError(client, 'session-end requires a sessionId field');
      return;
    }

    const message = payload as Record<string, unknown>;
    const sessionId = message['sessionId'] as string;

    // Notify all other peers before tearing down
    this.broadcastToSession(sessionId, client, {
      type: 'session-end',
      sessionId,
      payload: null,
    });

    this.signalingService.endSession(sessionId);
    this.teardownSessionRouting(sessionId);

    this.logger.debug(`Session ended by client: ${sessionId}`);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Send a JSON-serialized message to a single client.
   *
   * Checks readyState before sending so a closed connection does not throw.
   *
   * @private
   */
  private sendToClient(client: unknown, message: SignalingMessage | Record<string, unknown>): void {
    const ws = client as WsClient;
    try {
      if (ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify(message));
      }
    } catch (error) {
      this.logger.warn(
        `Failed to send to media client: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Broadcast a signaling message to all clients in a session except the sender.
   *
   * @private
   */
  private broadcastToSession(
    sessionId: string,
    senderClient: unknown,
    message: SignalingMessage | Record<string, unknown>,
  ): void {
    const clients = this.sessionClients.get(sessionId);
    if (clients === undefined) {
      return;
    }

    for (const client of clients) {
      if (client !== senderClient) {
        this.sendToClient(client, message);
      }
    }
  }

  /**
   * Add a client to a session's routing set.
   *
   * Creates the session entry if it does not yet exist.
   *
   * @private
   */
  private addClientToSession(sessionId: string, client: unknown): void {
    if (!this.sessionClients.has(sessionId)) {
      this.sessionClients.set(sessionId, new Set());
    }
    // Non-null assertion safe: we just created the entry above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.sessionClients.get(sessionId)!.add(client);
  }

  /**
   * Remove all routing state for a session.
   *
   * Clears clientSessions entries for all peers that were in this session,
   * then removes the sessionClients entry.
   *
   * @private
   */
  private teardownSessionRouting(sessionId: string): void {
    const clients = this.sessionClients.get(sessionId);
    if (clients !== undefined) {
      for (const client of clients) {
        this.clientSessions.delete(client);
      }
      this.sessionClients.delete(sessionId);
    }
  }

  /**
   * Derive a stable string identifier for a WebSocket client.
   *
   * The raw ws client does not have a built-in string ID. We use the object
   * reference as a Map key internally, but need a string for the signaling
   * service. Stringifying the reference is consistent within one process
   * lifetime — which is all we need for session correlation.
   *
   * @private
   */
  private getClientId(client: unknown): string {
    // Use a WeakMap-backed counter pattern would be cleaner, but a simple
    // sequential counter stored in a Map is sufficient here.
    let id = this.clientIdMap.get(client);
    if (id === undefined) {
      id = `ws-client-${this.nextClientIdCounter++}`;
      this.clientIdMap.set(client, id);
    }
    return id;
  }

  /**
   * Counter for generating sequential client IDs.
   * Monotonically increasing; never reused within a process lifetime.
   */
  private nextClientIdCounter = 1;

  /**
   * Map from client object -> string ID.
   * Populated lazily in getClientId(). Uses the object reference as key.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly clientIdMap = new Map<unknown, string>();

  // ---------------------------------------------------------------------------
  // Payload validation helpers
  // ---------------------------------------------------------------------------

  /**
   * Check that a payload is a non-null object with a 'payload' field.
   * Used to validate offer messages.
   *
   * @private
   */
  private isValidMessage(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      'payload' in (value as object)
    );
  }

  /**
   * Check that a payload has both 'sessionId' (string) and 'payload' fields.
   * Used to validate answer and ice-candidate messages.
   *
   * @private
   */
  private isSessionMessage(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const obj = value as Record<string, unknown>;
    return typeof obj['sessionId'] === 'string' && 'payload' in obj;
  }

  /**
   * Check that a payload has a 'sessionId' string field.
   * Used to validate session-end messages.
   *
   * @private
   */
  private isSessionIdMessage(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const obj = value as Record<string, unknown>;
    return typeof obj['sessionId'] === 'string';
  }

  /**
   * Send an error message to a client.
   *
   * @private
   */
  private sendError(client: unknown, message: string): void {
    this.logger.warn(`Media gateway error: ${message}`);
    this.sendToClient(client, { type: 'error', message });
  }
}

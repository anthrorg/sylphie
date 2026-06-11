/**
 * ConversationGateway — Thin WebSocket transport layer.
 *
 * Per the architecture diagram, this gateway is the I/O boundary between the
 * frontend and the Communication subsystem. It does NOT contain business logic.
 *
 * Input path (WS4 Ticket 2):
 *   WebSocket message → CommunicationService.intakeTurn() → CycleGuard queue
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
import { verboseFor } from '@sylphie/shared';
import { CommunicationService } from '../services/communication.service';
import { PersonModelService } from '../services/person-model.service';

const vlog = verboseFor('Communication');

/** Authenticated user identity extracted from JWT. */
interface ConnectedUser {
  userId: string;
  username: string;
  /**
   * Whether this user holds guardian status (WS4 Ticket 3).
   * Populated from the verified JWT `isGuardian` claim.
   * Defaults to false for non-guardian authenticated users.
   * Tokenless connections default to true (legacy guardian default — Ticket 4
   * will flip tokenless connections to isGuardian=false).
   */
  isGuardian: boolean;
}

/**
 * WS4 Ticket 4 — Routing decision table for delivery payloads.
 *
 * TARGETED  — originator present + socket alive: send to that one socket only.
 * USER_FALLBACK — originator present, socketId stale or absent: look up the
 *               user's current socket by userId; send if found, log-drop if not.
 * BROADCAST — no originator (self-initiated tick / ambient utterance): broadcast
 *             to all connected sockets. Self-tick emissions are ambient — no one
 *             "asked" for them, so all connected observers see them.
 */
type DeliveryRoute = 'TARGETED' | 'USER_FALLBACK' | 'BROADCAST';

@WebSocketGateway({ path: '/ws/conversation' })
export class ConversationGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  private readonly logger = new Logger(ConversationGateway.name);

  /** All connected WebSocket clients. */
  private readonly clients = new Set<WebSocket>();

  /** Map from WebSocket client to authenticated user identity. */
  private readonly clientUsers = new Map<WebSocket, ConnectedUser>();

  /**
   * WS4 Ticket 3: stable socket IDs for each connection.
   * Assigned at handleConnection; used for targeted delivery (Ticket 4) and
   * threaded onto InboundTurn.socketId for future routing.
   */
  private readonly clientSocketIds = new Map<WebSocket, string>();

  /**
   * WS4 Ticket 4: reverse map from socketId → WebSocket client.
   * Populated in handleConnection, removed in handleDisconnect.
   * Used for O(1) targeted delivery by socketId.
   */
  private readonly socketIdToClient = new Map<string, WebSocket>();

  /**
   * WS4 Ticket 4: map from userId → current WebSocket client.
   * Used as the userId fallback when the originator's socketId is stale
   * (the user reconnected between turn intake and delivery).
   * One entry per userId — the most-recently-connected socket for that user.
   */
  private readonly userIdToClient = new Map<string, WebSocket>();

  /** Monotonic counter for connection IDs. */
  private socketIdCounter = 0;

  constructor(
    private readonly communication: CommunicationService,
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
        // WS4 Ticket 4: clear thinking indicator — this is a global state event,
        // broadcast to all so every observer's UI reflects that Sylphie stopped thinking.
        this.broadcast({ type: 'thinking_indicator', is_thinking: false });

        // WS4 Ticket 4: TARGETED DELIVERY.
        // cb_speech is a turn-scoped event — route it to the originator's socket only.
        // Self-tick emissions (no originator) are ambient utterances → broadcast.
        // See routing decision table in DeliveryRoute type above.
        this.routeDelivery(delivery);
      },
      error: (err) => {
        this.logger.error(`delivery$ stream error: ${err}`);
      },
    });

    // WS4 Ticket 6: subscribe to queue-position updates from CycleGuard.
    // When a turn enqueues behind others, or when the queue drains, each waiting
    // speaker's socket gets an honest `queue_position` message with their current
    // 1-based position. Positions are recomputed per drain — never promised to be
    // stable (guardian preemption can shift them).
    this.communication.queuePositionUpdates$.subscribe({
      next: (snapshot) => {
        for (const entry of snapshot.positions) {
          const msg = JSON.stringify({
            type: 'queue_position',
            position: entry.position,
            turnId: entry.turnId,
          });
          this.sendToSocket(entry.socketId, entry.userId, msg);
        }
      },
      error: (err) => {
        this.logger.error(`queuePositionUpdates$ stream error: ${err}`);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // WS4 Ticket 4 — Targeted Delivery
  // ---------------------------------------------------------------------------

  /**
   * Route a delivery payload to the correct socket(s).
   *
   * Routing decision table:
   *
   *   TARGETED      — originator.socketId present AND socket alive in
   *                   socketIdToClient → send to that one socket only.
   *
   *   USER_FALLBACK — originator present but socketId absent or stale
   *                   (user reconnected between intake and delivery) →
   *                   look up userId in userIdToClient; send if found;
   *                   log-drop if the user has disconnected entirely.
   *                   CANON theater prohibition: a dropped delivery is
   *                   logged, never faked as delivered.
   *
   *   BROADCAST     — no originator (self-initiated tick / ambient
   *                   utterance) → send to every connected socket.
   *                   Self-tick emissions are ambient; all observers
   *                   should see them. This preserves today's behavior
   *                   for drive-pressure cycles.
   *
   * @param delivery - The DeliveryPayload from CommunicationService.
   */
  routeDelivery(delivery: unknown): void {
    const originator = (delivery as any).originator as
      | { socketId?: string; userId?: string }
      | undefined;

    if (!originator) {
      // No originator → self-initiated tick or trigger-phrase bypass without
      // an in-flight turn. Broadcast: these are ambient Sylphie utterances.
      this.broadcast(delivery);
      vlog('delivery broadcast (no originator — ambient/self-tick)', {
        turnId: (delivery as any).turnId,
        clients: this.clients.size,
      });
      return;
    }

    const { socketId, userId } = originator;

    // Try TARGETED delivery first: socketId → live socket.
    if (socketId) {
      const target = this.socketIdToClient.get(socketId);
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify(delivery));
        vlog('delivery TARGETED (socketId hit)', {
          turnId: (delivery as any).turnId,
          socketId,
          userId: userId ?? null,
        });
        return;
      }
      // Socket is gone — fall through to userId lookup.
      vlog('delivery socketId stale, trying userId fallback', {
        turnId: (delivery as any).turnId,
        socketId,
        userId: userId ?? null,
      });
    }

    // USER_FALLBACK: userId → current socket for that user.
    if (userId) {
      const target = this.userIdToClient.get(userId);
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify(delivery));
        vlog('delivery USER_FALLBACK (userId hit)', {
          turnId: (delivery as any).turnId,
          userId,
        });
        return;
      }
      // User has disconnected entirely — log and drop.
      // CANON theater prohibition: a dropped delivery must be logged,
      // never faked as delivered.
      this.logger.warn(
        `[Ticket 4] Delivery dropped — originator disconnected: ` +
        `userId=${userId ?? 'unknown'} socketId=${socketId ?? 'none'} ` +
        `turnId=${(delivery as any).turnId ?? 'unknown'}`,
      );
      vlog('delivery DROPPED (originator disconnected)', {
        turnId: (delivery as any).turnId,
        userId,
        socketId: socketId ?? null,
      });
      return;
    }

    // Originator present but no socketId or userId — should not happen in
    // well-formed turns; fall back to broadcast with a warning.
    this.logger.warn(
      `[Ticket 4] Delivery originator has no socketId or userId — falling back to broadcast. ` +
      `turnId=${(delivery as any).turnId ?? 'unknown'}`,
    );
    this.broadcast(delivery);
  }

  // ---------------------------------------------------------------------------
  // Connection Management
  // ---------------------------------------------------------------------------

  handleConnection(client: WebSocket, ...args: any[]): void {
    // Extract user identity from JWT token in query params
    const user = this.extractUserFromConnection(args);

    // Evict stale connections from the same user. React StrictMode double-mounts
    // effects in dev, and page navigations can open new sockets before the old
    // one's onclose fires — causing duplicate delivery. One user = one socket.
    if (user) {
      for (const existing of this.clients) {
        const existingUser = this.clientUsers.get(existing);
        if (existingUser?.userId === user.userId && existing !== client) {
          this.clients.delete(existing);
          this.clientUsers.delete(existing);
          try { existing.close(1012, 'replaced'); } catch { /* already closing */ }
          vlog('evicted stale connection', { userId: user.userId });
        }
      }
    }

    // Assign a stable socket ID for this connection (Ticket 3).
    const socketId = `sock-${++this.socketIdCounter}`;
    this.clientSocketIds.set(client, socketId);
    // WS4 Ticket 4: populate reverse maps for targeted delivery.
    this.socketIdToClient.set(socketId, client);
    this.clients.add(client);

    if (user) {
      this.clientUsers.set(client, user);
      // WS4 Ticket 4: track the current socket for this userId (newest wins).
      this.userIdToClient.set(user.userId, client);
      this.logger.log(
        `Conversation client connected: ${user.username} (${user.userId}) ` +
        `(${this.clients.size} total)`,
      );
      vlog('client connected', { userId: user.userId, username: user.username, socketId, totalClients: this.clients.size });

      // Ensure OKG Person anchor node exists for this user.
      // WS4 Ticket 3: pass the real isGuardian flag from the JWT (previously
      // hardcoded to true). WS4 Ticket 7: tokenless connections resolve to the
      // guest identity (isGuardian=false) — guardian status requires a signed JWT.
      void this.personModel.ensurePersonNode(user.userId, user.username, user.isGuardian);
      // WS4 Ticket 4: DO NOT call setActivePerson here. The per-connection
      // setActivePerson was the first half of the active-person thrash (Part B.4).
      // Per-turn speaker context is now bound at intakeTurn() time from the
      // InboundTurn's userId — no global mutable slot needed.
      // setActivePerson() remains only as an idle/self-tick fallback.
    } else {
      this.logger.log(`Conversation client connected (${this.clients.size} total)`);
      vlog('client connected (anonymous)', { totalClients: this.clients.size });
    }

    client.send(JSON.stringify({ type: 'system_status', is_thinking: false }));
  }

  handleDisconnect(client: WebSocket): void {
    const user = this.clientUsers.get(client);
    const socketId = this.clientSocketIds.get(client);

    this.clients.delete(client);
    this.clientUsers.delete(client);
    this.clientSocketIds.delete(client);

    // WS4 Ticket 4: clean up reverse maps.
    if (socketId) {
      this.socketIdToClient.delete(socketId);
    }
    if (user) {
      // Only remove the userId entry if it still points to THIS client
      // (a reconnect may have already replaced it with a newer socket).
      if (this.userIdToClient.get(user.userId) === client) {
        this.userIdToClient.delete(user.userId);
      }
    }

    this.logger.log(`Conversation client disconnected (${this.clients.size} total)`);
    vlog('client disconnected', { userId: user?.userId ?? 'anonymous', socketId: socketId ?? null, totalClients: this.clients.size });
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
    const preview = data.text.substring(0, 80);
    const user = this.clientUsers.get(client);
    // WS4 Ticket 7 — atomic flip: tokenless connections are now 'guest', not 'guardian'.
    // Anonymous (no-token / invalid-token) users become a named non-guardian guest
    // per build-plan §7.2.2. Guardian status is only reachable via a signed JWT with
    // isGuardian:true. This lands atomically with the gate JWT minting (gate.ts).
    const userId = user?.userId ?? 'guest';
    const username = user?.username ?? 'guest';
    const isGuardian = user?.isGuardian ?? false;
    vlog('message received', { userId, isGuardian, textPreview: preview, textLength: data.text.length });

    // Acknowledge receipt immediately
    client.send(JSON.stringify({ type: 'input_ack' }));

    // WS4 Ticket 6: scope the thinking_indicator to the originating socket only.
    // Only this speaker's turn is now in-flight (or about to be enqueued); the
    // indicator is personal feedback, not a broadcast "Sylphie is thinking" to
    // everyone. Self-tick and ambient thinking (no originator) continue to
    // broadcast (see onModuleInit delivery$ handler). The "done" indicator
    // (is_thinking: false) stays broadcast so all observer UIs clear the spinner.
    client.send(JSON.stringify({ type: 'thinking_indicator', is_thinking: true }));
    vlog('thinking indicator sent (scoped to originator socket)', { is_thinking: true, userId });

    const sessionId = `session-${userId}-${Date.now()}`;

    // WS4 Ticket 4: DO NOT call setActivePerson here. This was the second half
    // of the active-person thrash (B.4): two concurrent messages would clobber
    // the global activePersonId slot, causing one turn's cycle to run against
    // the other speaker's person model. Per-turn speaker context is now bound
    // at intakeTurn() → runCycleForTurn() from the InboundTurn's userId field.

    // Check for trigger phrases — these short-circuit the normal pipeline
    // and produce an immediate response (e.g., "Who am I?" → OKG lookup).
    // WS4 Ticket 6: pass socketId and isGuardian so handleWhoAmI can attach
    // a proper TurnOriginator and route the reply to the asker only.
    const socketIdForTrigger = this.clientSocketIds.get(client);
    void this.communication.handleTriggerPhrase(data.text, sessionId, userId, socketIdForTrigger, isGuardian)
      .then((handled) => {
        if (handled) {
          this.logger.log(`Trigger phrase handled: "${data.text}"`);
          vlog('trigger phrase handled', { text: data.text });
          return;
        }

        vlog('trigger phrase check: not a trigger, routing to normal pipeline', { userId });

        // WS4 Ticket 2 — IntakeTurn path.
        //
        // intakeTurn() replaces the previous pattern of:
        //   communication.parseInput() + tickSampler.updateText() + tickSampler.update(...)
        //
        // It mints a stable turnId at this boundary, runs parseInput (entity extraction,
        // fast-fact writes, history), updates all context slots (history, speaker,
        // person model), then enqueues an InboundTurn with the text attached onto the
        // CycleGuard queue — so each burst turn carries ITS OWN text and the cycle runner
        // injects it at drain time rather than sampling the shared global slot.
        //
        // The turnId returned is the same id that will appear on the CycleResponse,
        // making guardian feedback and log correlation possible.
        // WS4 Ticket 3: pass isGuardian and socketId through to intakeTurn so
        // identity is threaded onto the InboundTurn and CycleResponse originator.
        const socketId = this.clientSocketIds.get(client);
        const turnId = this.communication.intakeTurn(data.text, sessionId, userId, username, isGuardian, socketId);
        vlog('turn enqueued via intakeTurn', { turnId, userId, isGuardian, socketId });
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

  /**
   * WS4 Ticket 6 — Send a pre-serialized message to a specific socket.
   *
   * Tries socketId first (exact targeted delivery), falls back to userId lookup
   * (reconnect tolerance). If neither resolves, the notification is silently
   * dropped (the turn will complete normally; the UX feedback is just missing).
   *
   * This is used only for informational notifications (queue_position). If the
   * recipient is not reachable, there is no need to log a warning — a missed
   * position update is not a correctness failure.
   *
   * @param socketId - WebSocket connection ID from the InboundTurn.
   * @param userId   - Speaker's userId fallback.
   * @param message  - Pre-serialized JSON string to send.
   */
  private sendToSocket(socketId: string | undefined, userId: string | undefined, message: string): void {
    // Try targeted delivery by socketId first.
    if (socketId) {
      const target = this.socketIdToClient.get(socketId);
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(message);
        return;
      }
    }
    // Fall back to userId → current socket.
    if (userId) {
      const target = this.userIdToClient.get(userId);
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(message);
      }
    }
    // No socket found — drop silently. Position update is informational only.
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

      // WS4 Ticket 3: read isGuardian from the JWT payload.
      // The login endpoint (auth.controller.ts:76-79) includes isGuardian in the
      // signed JWT from the User.isGuardian DB column. Previously this was dropped;
      // now it's threaded through to ConnectedUser and all downstream consumers.
      // Default to false: a token that omits the claim is non-guardian.
      const payload = jwt.verify(token, secret) as { sub: string; username: string; isGuardian?: boolean };
      return { userId: payload.sub, username: payload.username, isGuardian: payload.isGuardian ?? false };
    } catch {
      return null; // Invalid or missing token — proceed as anonymous
    }
  }
}

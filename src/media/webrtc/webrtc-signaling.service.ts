import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  IWebRtcSignalingService,
  SignalingMessage,
} from '../interfaces/media.interfaces';

// ---------------------------------------------------------------------------
// Internal session representation
// ---------------------------------------------------------------------------

/**
 * A single in-memory WebRTC signaling session.
 *
 * The session stores the SDP offer, the SDP answer (once received), and a
 * FIFO queue of ICE candidates from both peers. Sessions expire after
 * SESSION_TTL_MS milliseconds of inactivity.
 */
interface SignalingSession {
  /** Opaque session identifier (UUID). */
  readonly sessionId: string;
  /** clientId of the peer who sent the offer (peer A). */
  readonly offererClientId: string;
  /** The raw SDP offer payload from peer A. */
  readonly offer: unknown;
  /**
   * The SDP answer payload from peer B, or null if not yet received.
   * Set by handleAnswer().
   */
  answer: unknown | null;
  /**
   * FIFO queue of signaling messages (answers + ICE candidates) pending
   * retrieval by the gateway. Cleared on each getPendingSignals() call.
   */
  pendingSignals: SignalingMessage[];
  /** Epoch-ms timestamp of the last activity on this session. */
  lastActivityAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sessions inactive longer than this are eligible for cleanup. */
const SESSION_TTL_MS = 60_000;

/** Interval at which the cleanup timer fires. */
const CLEANUP_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * WebRtcSignalingService — in-memory WebRTC session coordinator.
 *
 * Implements IWebRtcSignalingService. Stores signaling state (offers, answers,
 * ICE candidates) per session so that two browser peers can complete the
 * WebRTC handshake through the NestJS gateway acting as a signaling channel.
 *
 * Sessions expire after 60 seconds without activity. A cleanup timer runs
 * every 30 seconds to evict stale sessions and bound memory usage.
 *
 * CANON §Architecture: This service is entirely in-memory and intentionally
 * carries no provenance, no WKG writes, and no TimescaleDB events. Media
 * sessions are transient by design.
 */
@Injectable()
export class WebRtcSignalingService
  implements IWebRtcSignalingService, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WebRtcSignalingService.name);

  /**
   * Active sessions keyed by sessionId.
   * Only sessions whose lastActivityAt is within SESSION_TTL_MS are valid.
   */
  private readonly sessions = new Map<string, SignalingSession>();

  /**
   * Reverse index: offerer clientId -> sessionId.
   * Allows fast lookup when a client disconnects so we can clean up its session.
   */
  private readonly clientToSession = new Map<string, string>();

  /** NodeJS interval handle for the periodic stale-session cleanup. */
  private cleanupInterval: NodeJS.Timeout | null = null;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the periodic cleanup timer after the module is initialized.
   * Using OnModuleInit prevents side-effects in the constructor.
   */
  onModuleInit(): void {
    this.cleanupInterval = setInterval(() => {
      this.evictStaleSessions();
    }, CLEANUP_INTERVAL_MS);

    this.logger.log(
      `WebRTC signaling service started. ` +
        `Session TTL: ${SESSION_TTL_MS}ms, cleanup interval: ${CLEANUP_INTERVAL_MS}ms`,
    );
  }

  /**
   * Stop the cleanup timer and discard all sessions on module teardown.
   */
  onModuleDestroy(): void {
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const count = this.sessions.size;
    this.sessions.clear();
    this.clientToSession.clear();

    if (count > 0) {
      this.logger.log(
        `WebRTC signaling service stopped. Discarded ${count} active session(s).`,
      );
    } else {
      this.logger.log('WebRTC signaling service stopped.');
    }
  }

  // ---------------------------------------------------------------------------
  // IWebRtcSignalingService
  // ---------------------------------------------------------------------------

  /**
   * Record an SDP offer from peer A and create a new session.
   *
   * If the client already owns an active session, that session is silently
   * ended before creating the new one to prevent unbounded session growth
   * across reconnects.
   *
   * @param clientId - Opaque WebSocket client identifier for peer A.
   * @param offer - The RTCSessionDescriptionInit payload from the browser.
   * @returns The new sessionId (UUID v4).
   */
  handleOffer(clientId: string, offer: unknown): string {
    // End any existing session owned by this client before creating a new one.
    const existingSessionId = this.clientToSession.get(clientId);
    if (existingSessionId !== undefined) {
      this.logger.debug(
        `Client ${clientId} already has session ${existingSessionId}; ending it before creating new session.`,
      );
      this.endSession(existingSessionId);
    }

    const sessionId = randomUUID();
    const now = Date.now();

    const session: SignalingSession = {
      sessionId,
      offererClientId: clientId,
      offer,
      answer: null,
      pendingSignals: [],
      lastActivityAt: now,
    };

    this.sessions.set(sessionId, session);
    this.clientToSession.set(clientId, sessionId);

    this.logger.debug(
      `Session created: ${sessionId} (offerer: ${clientId}). Active sessions: ${this.sessions.size}`,
    );

    return sessionId;
  }

  /**
   * Record an SDP answer for an existing session and enqueue it as a pending
   * signal so peer A can retrieve it via getPendingSignals().
   *
   * @param sessionId - The session created when the offer was recorded.
   * @param answer - RTCSessionDescriptionInit from peer B.
   */
  handleAnswer(sessionId: string, answer: unknown): void {
    const session = this.getActiveSession(sessionId);
    if (session === null) {
      this.logger.warn(
        `handleAnswer: session not found or expired: ${sessionId}`,
      );
      return;
    }

    session.answer = answer;
    session.lastActivityAt = Date.now();

    session.pendingSignals.push({
      type: 'answer',
      sessionId,
      payload: answer,
    });

    this.logger.debug(`Answer recorded for session: ${sessionId}`);
  }

  /**
   * Append a trickle ICE candidate to the pending queue for a session.
   *
   * @param sessionId - The active session ID.
   * @param candidate - RTCIceCandidateInit from either peer.
   */
  handleIceCandidate(sessionId: string, candidate: unknown): void {
    const session = this.getActiveSession(sessionId);
    if (session === null) {
      this.logger.warn(
        `handleIceCandidate: session not found or expired: ${sessionId}`,
      );
      return;
    }

    session.lastActivityAt = Date.now();

    session.pendingSignals.push({
      type: 'ice-candidate',
      sessionId,
      payload: candidate,
    });

    this.logger.debug(
      `ICE candidate queued for session: ${sessionId} (queue depth: ${session.pendingSignals.length})`,
    );
  }

  /**
   * Terminate a session and discard all pending signals.
   *
   * Idempotent: calling endSession on an unknown or already-ended session
   * is a no-op.
   *
   * @param sessionId - The session to terminate.
   */
  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }

    this.sessions.delete(sessionId);
    this.clientToSession.delete(session.offererClientId);

    this.logger.debug(
      `Session ended: ${sessionId}. Active sessions: ${this.sessions.size}`,
    );
  }

  /**
   * Retrieve and drain the pending signals queue for a session.
   *
   * Returns all signals accumulated since the last call. The queue is cleared
   * on retrieval — each signal is delivered exactly once.
   *
   * Returns an empty array for unknown or expired sessions without throwing,
   * so callers do not need to guard against unknown session IDs on disconnect.
   *
   * @param sessionId - The active session ID.
   * @returns Pending SignalingMessages in arrival order.
   */
  getPendingSignals(sessionId: string): SignalingMessage[] {
    const session = this.getActiveSession(sessionId);
    if (session === null) {
      return [];
    }

    const signals = session.pendingSignals.slice();
    session.pendingSignals = [];
    return signals;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Look up a session by ID, checking that it has not exceeded its TTL.
   *
   * Returns null (instead of throwing) so callers decide how to handle a
   * missing session without a try/catch overhead on every hot-path call.
   *
   * @private
   */
  private getActiveSession(sessionId: string): SignalingSession | null {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return null;
    }

    const ageMs = Date.now() - session.lastActivityAt;
    if (ageMs > SESSION_TTL_MS) {
      // Expired — evict lazily on access
      this.sessions.delete(sessionId);
      this.clientToSession.delete(session.offererClientId);
      this.logger.debug(
        `Lazy eviction of expired session: ${sessionId} (age: ${ageMs}ms)`,
      );
      return null;
    }

    return session;
  }

  /**
   * Scan all sessions and evict any whose last activity is older than SESSION_TTL_MS.
   *
   * Called by the periodic setInterval. Does not throw — any individual eviction
   * error is caught and logged so the timer survives a bad entry.
   *
   * @private
   */
  private evictStaleSessions(): void {
    const now = Date.now();
    let evictedCount = 0;

    for (const [sessionId, session] of this.sessions) {
      const ageMs = now - session.lastActivityAt;
      if (ageMs > SESSION_TTL_MS) {
        this.sessions.delete(sessionId);
        this.clientToSession.delete(session.offererClientId);
        evictedCount++;
      }
    }

    if (evictedCount > 0) {
      this.logger.debug(
        `Evicted ${evictedCount} stale session(s). Active sessions: ${this.sessions.size}`,
      );
    }
  }
}

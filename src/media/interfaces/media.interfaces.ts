/**
 * Interface contracts for MediaModule.
 *
 * Defines the WebRTC signaling protocol and the service contract that the
 * gateway and any future consumers depend on. Implementations are injected
 * via WEBRTC_SIGNALING_SERVICE — never imported directly.
 */

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all WebRTC signaling message types.
 *
 * - offer: SDP offer from the initiating peer.
 * - answer: SDP answer from the responding peer.
 * - ice-candidate: Trickle ICE candidate from either peer.
 * - session-end: Explicit teardown initiated by either peer.
 */
export type SignalType = 'offer' | 'answer' | 'ice-candidate' | 'session-end';

/**
 * A single signaling message exchanged between browser peers via the gateway.
 *
 * The payload is typed as unknown because the shape varies by SignalType:
 *   - offer/answer: RTCSessionDescriptionInit  ({ type, sdp })
 *   - ice-candidate: RTCIceCandidateInit        ({ candidate, sdpMid, sdpMLineIndex })
 *   - session-end:   null or undefined
 *
 * The gateway validates and narrows payload before forwarding to the service.
 */
export interface SignalingMessage {
  /** Discriminant identifying the message role in the signaling handshake. */
  readonly type: SignalType;
  /** Opaque session identifier. Created by the service on the first offer. */
  readonly sessionId: string;
  /** RTCSessionDescriptionInit, RTCIceCandidateInit, or null/undefined. */
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

/**
 * IWebRtcSignalingService — in-memory WebRTC session coordinator.
 *
 * The service stores pending signaling messages per session and provides a
 * simple rendezvous: when peer A sends an offer, peer B can retrieve it via
 * getPendingSignals(). The gateway is responsible for routing the signal to
 * the correct peer (broadcast or targeted send).
 *
 * Sessions expire after 60 seconds of inactivity. Cleanup runs every 30s.
 *
 * CANON §Architecture: The service does not touch Neo4j, TimescaleDB, or the
 * Drive Engine. Media sessions are transient and carry no knowledge provenance.
 */
export interface IWebRtcSignalingService {
  /**
   * Record an SDP offer from a browser peer and create a new session.
   *
   * If the clientId already owns an active session, the existing session is
   * ended and a fresh one is created. This prevents session accumulation on
   * reconnect without cleanup.
   *
   * @param clientId - Opaque identifier for the WebSocket client (peer A).
   * @param offer - RTCSessionDescriptionInit from the browser (unknown at
   *                this boundary; the gateway validated the shape before here).
   * @returns The newly-created sessionId (UUID).
   * @throws {MediaSignalingException} if the offer cannot be stored.
   */
  handleOffer(clientId: string, offer: unknown): string;

  /**
   * Record an SDP answer for an existing session.
   *
   * Stores the answer against the sessionId and updates the session's last
   * activity timestamp, resetting the 60-second expiry window.
   *
   * @param sessionId - The session ID created when the offer was recorded.
   * @param answer - RTCSessionDescriptionInit from the browser (peer B).
   * @throws {MediaSessionNotFoundError} if sessionId is unknown or expired.
   */
  handleAnswer(sessionId: string, answer: unknown): void;

  /**
   * Append a trickle ICE candidate to the pending signals queue for a session.
   *
   * Updates the session's last activity timestamp.
   *
   * @param sessionId - The active session ID.
   * @param candidate - RTCIceCandidateInit from either peer.
   * @throws {MediaSessionNotFoundError} if sessionId is unknown or expired.
   */
  handleIceCandidate(sessionId: string, candidate: unknown): void;

  /**
   * Terminate a session and discard all pending signals.
   *
   * Idempotent: calling endSession on an already-ended or unknown session
   * is a no-op (does not throw).
   *
   * @param sessionId - The session to terminate.
   */
  endSession(sessionId: string): void;

  /**
   * Retrieve and drain the pending signals queue for a session.
   *
   * Returns all signals accumulated since the last call (or since session
   * creation). The queue is cleared after retrieval — each signal is delivered
   * exactly once.
   *
   * @param sessionId - The active session ID.
   * @returns Array of pending SignalingMessages in arrival order.
   *          Returns an empty array if the session is unknown or has no pending signals.
   */
  getPendingSignals(sessionId: string): SignalingMessage[];
}

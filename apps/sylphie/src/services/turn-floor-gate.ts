/**
 * TurnFloorGate — turn-floor arbitration and barge-in protection (TK-99).
 *
 * CANON enforcement:
 *   - Theater Prohibition (Std-1): AMBIENT_NONE cycles produce zero deliveries
 *     (the cycle text is an idle artifact, not a real drive-mediated utterance).
 *   - USER_REPLY is ALWAYS delivered — the guardian asked; the response must
 *     come back. The floor never suppresses a genuine user-turn response.
 *   - Gate keys on emissionIntent exclusively (DEC-26/DEC-27: never on
 *     originator-absence; the originator field is identity, not intent).
 *
 * Four acceptance criteria from TK-99:
 *
 *   AC0: one-per-turn cap + minimum inter-utterance interval.
 *        Under a runaway condition (many cycles/sec), at most ONE non-USER_REPLY
 *        delivery is allowed per turn window, and none within MIN_UTTERANCE_GAP_MS
 *        of the previous delivery.
 *
 *   AC1: barge-in — when the user is mid-typing (holds the floor), a
 *        self-initiated cycle that wants to speak is suppressed.
 *
 *   AC2: interrupt-mid-utterance — if Sylphie is delivering a self-initiated
 *        utterance and a real user turn arrives, cancel the in-flight delivery.
 *
 *   AC3: DELIBERATE_GREET passes through the floor as the one-per-turn
 *        contribution. The floor gates RATE and BARGE-IN, never ORIGIN.
 *
 * This class is pure (no NestJS DI, no I/O). CommunicationService owns it
 * as a field and calls admit() before emitting each DeliveryPayload.
 */

import type { EmissionIntent } from '@sylphie/shared';

/** Minimum gap between consecutive non-USER_REPLY deliveries (milliseconds). */
export const MIN_UTTERANCE_GAP_MS = 1_500;

/**
 * How long after the last user input we consider the user to still hold the
 * floor (barge-in suppression window).
 */
export const FLOOR_HOLD_WINDOW_MS = 5_000;

/** Result returned by TurnFloorGate.admit(). */
export interface AdmitResult {
  /**
   * Whether the delivery should proceed.
   * false = suppress this delivery (AMBIENT_NONE, barge-in, or rate-limited).
   */
  readonly allow: boolean;

  /**
   * Human-readable reason for the decision (useful for vlog/audit).
   */
  readonly reason: string;

  /**
   * Whether an in-flight self-initiated delivery was cancelled to admit this
   * USER_REPLY (AC2 interrupt-mid-utterance).
   */
  readonly interruptedInFlight: boolean;
}

/**
 * Tracks an in-flight self-initiated delivery that can be cancelled if a real
 * user turn arrives before the delivery completes.
 */
export interface InFlightDelivery {
  /** The turnId of the in-flight self-initiated delivery. */
  readonly turnId: string;
  /** The emissionIntent of the in-flight delivery. */
  readonly intent: EmissionIntent;
  /**
   * A cancellation callback registered by the caller.
   * Invoked when AC2 interrupt-mid-utterance fires.
   */
  readonly cancel: () => void;
}

// ---------------------------------------------------------------------------
// TurnFloorGate
// ---------------------------------------------------------------------------

export class TurnFloorGate {
  /**
   * Wall-clock time of the last non-USER_REPLY delivery (for rate-limiting).
   * 0 means no prior delivery.
   */
  private lastSelfInitiatedDeliveryAt = 0;

  /**
   * Wall-clock time of the last inbound user message (for barge-in detection).
   * 0 means no user input yet.
   */
  private lastUserInputAt = 0;

  /**
   * In-flight self-initiated delivery (DELIBERATE_GREET / SALIENT_OBSERVATION),
   * if any. Cleared when the delivery completes or is cancelled.
   */
  private inFlight: InFlightDelivery | null = null;

  /**
   * Clock abstraction — injected so unit tests can control time without
   * relying on real wall-clock calls.
   */
  private readonly now: () => number;

  constructor(clockFn?: () => number) {
    this.now = clockFn ?? (() => Date.now());
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Record that the user sent a message.
   *
   * Called by CommunicationService.intakeTurn() on every inbound turn.
   * This is the signal that drives:
   *   - AC1: barge-in suppression (user holds the floor)
   *   - AC2: interrupt-mid-utterance (cancel any in-flight self-initiated delivery)
   *
   * Returns true if an in-flight self-initiated delivery was cancelled (AC2).
   */
  recordUserInput(): boolean {
    this.lastUserInputAt = this.now();

    if (this.inFlight) {
      this.inFlight.cancel();
      this.inFlight = null;
      return true; // interrupted
    }

    return false;
  }

  /**
   * Register a self-initiated delivery as in-flight so it can be cancelled
   * by a subsequent user turn (AC2).
   *
   * Call this BEFORE emitting the DeliveryPayload for a DELIBERATE_GREET or
   * SALIENT_OBSERVATION. Call clearInFlight() when the delivery is complete
   * (or when admit() denies it).
   *
   * Only one in-flight delivery is tracked at a time. Registering a second one
   * implicitly completes the first (the second delivery won the floor).
   */
  registerInFlight(delivery: InFlightDelivery): void {
    // If there was already a prior in-flight that was not cancelled, complete it.
    this.inFlight = delivery;
  }

  /**
   * Clear the in-flight registration (call after delivery completes normally).
   * No-op if no delivery is in flight or if the id does not match the current.
   */
  clearInFlight(turnId: string): void {
    if (this.inFlight?.turnId === turnId) {
      this.inFlight = null;
    }
  }

  /**
   * Decide whether to admit a pending delivery.
   *
   * Rules applied in order (first match wins):
   *
   *  1. AMBIENT_NONE → always deny (zero deliveries; this is an idle artifact).
   *  2. USER_REPLY   → always admit, cancel any in-flight self-initiated delivery.
   *  3. Barge-in (AC1): user input arrived within FLOOR_HOLD_WINDOW_MS → deny.
   *  4. Rate-limit (AC0): last self-initiated delivery was within
   *     MIN_UTTERANCE_GAP_MS → deny.
   *  5. Otherwise admit; update lastSelfInitiatedDeliveryAt.
   *
   * Does NOT register the delivery as in-flight — that is the caller's job via
   * registerInFlight() for deliveries that should be cancellable (AC2).
   *
   * @param intent   The emissionIntent of the pending CycleResponse.
   * @param turnId   The turnId (used only for logging context).
   */
  admit(intent: EmissionIntent, turnId: string): AdmitResult {
    const ts = this.now();

    // ── Rule 1: AMBIENT_NONE is always suppressed ────────────────────────────
    if (intent === 'AMBIENT_NONE') {
      return {
        allow: false,
        reason: 'AMBIENT_NONE suppressed (idle artifact, no salient content)',
        interruptedInFlight: false,
      };
    }

    // ── Rule 2: USER_REPLY is always admitted ────────────────────────────────
    // Cancel any in-flight self-initiated delivery (AC2).
    if (intent === 'USER_REPLY') {
      let interrupted = false;
      if (this.inFlight) {
        this.inFlight.cancel();
        const cancelledTurnId = this.inFlight.turnId;
        this.inFlight = null;
        interrupted = true;
        void cancelledTurnId; // turnId logged by caller via interruptedInFlight
      }
      return {
        allow: true,
        reason: 'USER_REPLY always admitted',
        interruptedInFlight: interrupted,
      };
    }

    // ── Rule 3: Barge-in suppression (AC1) ───────────────────────────────────
    // User input within FLOOR_HOLD_WINDOW_MS means the user holds the floor.
    if (this.lastUserInputAt > 0 && ts - this.lastUserInputAt < FLOOR_HOLD_WINDOW_MS) {
      return {
        allow: false,
        reason: `Barge-in suppressed: user holds floor (last input ${ts - this.lastUserInputAt}ms ago, window=${FLOOR_HOLD_WINDOW_MS}ms)`,
        interruptedInFlight: false,
      };
    }

    // ── Rule 4: Rate-limit (AC0) ──────────────────────────────────────────────
    // Minimum gap between consecutive self-initiated deliveries.
    if (
      this.lastSelfInitiatedDeliveryAt > 0 &&
      ts - this.lastSelfInitiatedDeliveryAt < MIN_UTTERANCE_GAP_MS
    ) {
      return {
        allow: false,
        reason: `Rate-limited: last self-initiated delivery ${ts - this.lastSelfInitiatedDeliveryAt}ms ago (min=${MIN_UTTERANCE_GAP_MS}ms)`,
        interruptedInFlight: false,
      };
    }

    // ── Rule 5: Admit ─────────────────────────────────────────────────────────
    this.lastSelfInitiatedDeliveryAt = ts;
    return {
      allow: true,
      reason: `${intent} admitted (floor clear, rate-limit clear)`,
      interruptedInFlight: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Inspection helpers (for tests and vlog)
  // ---------------------------------------------------------------------------

  /** Wall-clock time of the last user input. 0 if none recorded yet. */
  get lastUserInputTimestamp(): number {
    return this.lastUserInputAt;
  }

  /** Wall-clock time of the last self-initiated delivery. 0 if none yet. */
  get lastSelfInitiatedDeliveryTimestamp(): number {
    return this.lastSelfInitiatedDeliveryAt;
  }

  /** Whether there is an in-flight self-initiated delivery. */
  get hasInFlight(): boolean {
    return this.inFlight !== null;
  }
}

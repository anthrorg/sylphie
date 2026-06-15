/**
 * SidecarCircuitBreaker — protects the cognition-sidecar control path.
 *
 * The cognition sidecar (Python FastAPI, COGNITION_HOST) is an optional
 * accelerator: when it is healthy the decision loop uses its tensor cycle /
 * control endpoints, and when it is not the loop falls back to the LLM-only
 * path. Without a circuit breaker, every call to a down/slow sidecar pays the
 * full timeout (50ms inference, up to 5s for control calls) before failing —
 * and a sidecar that is hard-down but still TCP-accepting can stall the loop
 * repeatedly. The breaker makes repeated failures fail *fast* and probes for
 * recovery on a fixed cadence rather than on every call.
 *
 * State machine (mirrors drive-engine's SelfEvaluationCircuitBreaker):
 *   CLOSED    — normal operation; calls allowed; failures increment a counter.
 *   OPEN      — too many consecutive failures; calls short-circuit (fail fast)
 *               until the cooldown elapses.
 *   HALF_OPEN — cooldown elapsed; a single probe call is allowed. Success
 *               closes the circuit; failure re-opens it immediately (a relapse
 *               does not get a fresh run at the full failure threshold).
 *
 * This class holds no I/O — the caller wraps each sidecar call with
 * canAttempt() / recordSuccess() / recordFailure(). That keeps it trivially
 * unit-testable without a live sidecar.
 */

/** Circuit breaker lifecycle state. */
export enum SidecarBreakerState {
  /** Normal operation — calls allowed. */
  CLOSED = 'closed',
  /** Tripped — calls short-circuit until cooldown elapses. */
  OPEN = 'open',
  /** Cooldown elapsed — one probe call allowed. */
  HALF_OPEN = 'half_open',
}

export interface SidecarBreakerOptions {
  /** Consecutive failures in CLOSED that trip the breaker. Default 5. */
  failureThreshold?: number;
  /** Cooldown (ms) the breaker stays OPEN before a probe. Default 30_000. */
  cooldownMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export class SidecarCircuitBreaker {
  private state: SidecarBreakerState = SidecarBreakerState.CLOSED;
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: SidecarBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Whether a call should be attempted now.
   *
   * - CLOSED: always true.
   * - OPEN: false until the cooldown elapses, at which point it transitions to
   *   HALF_OPEN and returns true to allow exactly one probe.
   * - HALF_OPEN: true (the probe is in flight; a second concurrent caller also
   *   sees true, which is acceptable — the first result to land decides).
   *
   * This method has the side effect of the OPEN→HALF_OPEN transition, matching
   * the drive-engine reference breaker's isOpen() semantics.
   */
  canAttempt(): boolean {
    if (this.state === SidecarBreakerState.CLOSED) return true;

    if (this.state === SidecarBreakerState.OPEN) {
      if (this.openedAt !== null && this.now() - this.openedAt >= this.cooldownMs) {
        this.state = SidecarBreakerState.HALF_OPEN;
        return true; // allow a single probe
      }
      return false; // still cooling down — fail fast
    }

    // HALF_OPEN — allow the probe.
    return true;
  }

  /** Record a successful sidecar call. Closes the circuit and clears failures. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state !== SidecarBreakerState.CLOSED) {
      this.state = SidecarBreakerState.CLOSED;
      this.openedAt = null;
    }
  }

  /**
   * Record a failed sidecar call (timeout, connection refused, non-2xx).
   *
   * In HALF_OPEN a single failure re-trips immediately. In CLOSED the failure
   * threshold governs.
   */
  recordFailure(): void {
    if (this.state === SidecarBreakerState.HALF_OPEN) {
      this.trip();
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.trip();
    }
  }

  /** Current state (diagnostics / tests). */
  getState(): SidecarBreakerState {
    return this.state;
  }

  /** Consecutive failure count (diagnostics / tests). */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /** Force-reset to CLOSED (tests / manual recovery). */
  reset(): void {
    this.state = SidecarBreakerState.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  private trip(): void {
    this.state = SidecarBreakerState.OPEN;
    this.openedAt = this.now();
  }
}

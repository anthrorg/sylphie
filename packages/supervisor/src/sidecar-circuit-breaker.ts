/**
 * Circuit breaker for the supervisor's sidecar control client.
 *
 * The SidecarControlService POSTs interventions (reinforce / correct /
 * boost_salience / freeze / rollback) to the Python cognition-service. If the
 * sidecar is down, slow, or rejecting, an unprotected client retries every call
 * and stacks up 10s timeouts — turning a transient sidecar outage into a flood
 * of blocking I/O on the supervisor's async path.
 *
 * This breaker fails fast when the sidecar has been failing: after
 * SIDECAR_BREAKER_FAILURE_THRESHOLD consecutive failures it OPENs and short-
 * circuits calls (no network I/O, surfaced as a skip) for
 * SIDECAR_BREAKER_RESET_MS. It then HALF_OPENs to let a single probe through;
 * a successful probe CLOSEs the circuit, a failed probe re-trips it.
 *
 * Pattern mirrors drive-engine's SelfEvaluationCircuitBreaker, replicated
 * locally rather than imported across packages (per build directive).
 */

/** Consecutive sidecar failures before the breaker trips OPEN. */
export const SIDECAR_BREAKER_FAILURE_THRESHOLD = 5;

/** How long the breaker stays OPEN before allowing a HALF_OPEN probe (ms). */
export const SIDECAR_BREAKER_RESET_MS = 30_000;

/**
 * Circuit breaker state.
 */
export enum SidecarBreakerState {
  /** Normal operation — calls pass through. */
  CLOSED = 'closed',

  /** Tripped — calls are short-circuited (fail-fast). */
  OPEN = 'open',

  /** Probing — a single call is allowed to test recovery. */
  HALF_OPEN = 'half_open',
}

/**
 * Failure-count circuit breaker around the sidecar HTTP client.
 */
export class SidecarCircuitBreaker {
  private state: SidecarBreakerState = SidecarBreakerState.CLOSED;
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly failureThreshold: number = SIDECAR_BREAKER_FAILURE_THRESHOLD,
    private readonly resetMs: number = SIDECAR_BREAKER_RESET_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Whether a call may proceed right now.
   *
   * CLOSED → always allowed.
   * OPEN   → blocked until resetMs elapses, then transitions to HALF_OPEN and
   *          allows ONE probe.
   * HALF_OPEN → allowed (the probe in flight).
   */
  public allowRequest(): boolean {
    if (this.state === SidecarBreakerState.CLOSED) return true;

    if (this.state === SidecarBreakerState.OPEN) {
      if (this.openedAt !== null && this.now() - this.openedAt >= this.resetMs) {
        this.state = SidecarBreakerState.HALF_OPEN;
        return true; // allow a single probe
      }
      return false; // still open — fail fast
    }

    // HALF_OPEN: allow the probe through.
    return true;
  }

  /**
   * Record a successful sidecar call.
   * Closes the circuit (from HALF_OPEN) and resets the failure counter.
   */
  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state !== SidecarBreakerState.CLOSED) {
      this.state = SidecarBreakerState.CLOSED;
      this.openedAt = null;
    }
  }

  /**
   * Record a failed sidecar call (network error, timeout, non-2xx).
   *
   * In HALF_OPEN a single failed probe re-trips immediately (a relapse does not
   * get a fresh run at the full threshold). In CLOSED the threshold counter
   * governs.
   */
  public recordFailure(): void {
    this.consecutiveFailures++;

    if (this.state === SidecarBreakerState.HALF_OPEN) {
      this.trip();
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.trip();
    }
  }

  /** Current state, for diagnostics / logging. */
  public getState(): SidecarBreakerState {
    return this.state;
  }

  /** Current consecutive-failure count, for diagnostics. */
  public getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /** Force back to CLOSED (testing / manual recovery). */
  public reset(): void {
    this.state = SidecarBreakerState.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  private trip(): void {
    this.state = SidecarBreakerState.OPEN;
    this.openedAt = this.now();
  }
}

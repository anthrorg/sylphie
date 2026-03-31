/**
 * Circuit breaker to prevent self-evaluation rumination loops.
 *
 * If self-assessment returns negative results for N consecutive evaluations,
 * the circuit breaker trips and pauses self-evaluation for a duration.
 * This prevents the system from getting stuck in a negative feedback loop
 * where low self-assessment leads to drive adjustment, which affects
 * behavior, which leads to low self-assessment again.
 *
 * CANON §E4-T008: Prevent depressive attractor states via circuit breaker.
 */

import {
  CIRCUIT_BREAKER_NEGATIVE_THRESHOLD,
  CIRCUIT_BREAKER_PAUSE_DURATION_MS,
} from '../constants/self-evaluation';

/**
 * Represents the state of the circuit breaker.
 */
export enum CircuitBreakerState {
  /** Normal operation, accepting evaluations */
  CLOSED = 'closed',

  /** Paused, not accepting evaluations */
  OPEN = 'open',

  /** Transitioning from OPEN to CLOSED */
  HALF_OPEN = 'half_open',
}

/**
 * Tracks negative assessment sequences and manages pause state.
 */
export class SelfEvaluationCircuitBreaker {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private consecutiveNegatives: number = 0;
  private pauseStartedAt: number | null = null;

  /**
   * Check if the circuit is open (paused).
   *
   * @returns true if self-evaluation should be skipped
   */
  public isOpen(): boolean {
    if (this.state === CircuitBreakerState.CLOSED) {
      return false;
    }

    if (this.state === CircuitBreakerState.OPEN) {
      // Check if pause duration has elapsed
      if (this.pauseStartedAt && Date.now() - this.pauseStartedAt >= CIRCUIT_BREAKER_PAUSE_DURATION_MS) {
        // Pause duration expired, transition to half-open (allow one evaluation)
        this.state = CircuitBreakerState.HALF_OPEN;
        this.consecutiveNegatives = 0;
        if (typeof process !== 'undefined' && process.stderr) {
          process.stderr.write(`[SelfEvalCircuitBreaker] Pause expired, transitioning to HALF_OPEN\n`);
        }
        return false; // Allow evaluation
      }
      return true; // Still paused
    }

    // HALF_OPEN: allow evaluations, will close on success or reopen on failure
    return false;
  }

  /**
   * Record a negative assessment.
   * If threshold is reached, trip the circuit breaker.
   */
  public recordNegativeAssessment(): void {
    this.consecutiveNegatives++;

    if (this.consecutiveNegatives >= CIRCUIT_BREAKER_NEGATIVE_THRESHOLD) {
      this.tripCircuit();
    }
  }

  /**
   * Record a positive assessment.
   * Resets the negative counter and closes the circuit if in HALF_OPEN.
   */
  public recordPositiveAssessment(): void {
    this.consecutiveNegatives = 0;

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.state = CircuitBreakerState.CLOSED;
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(
          `[SelfEvalCircuitBreaker] Positive assessment in HALF_OPEN, closing circuit\n`,
        );
      }
    }
  }

  /**
   * Get the current state for diagnostics.
   */
  public getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Get the current negative count.
   */
  public getConsecutiveNegatives(): number {
    return this.consecutiveNegatives;
  }

  /**
   * Trip the circuit breaker.
   * Sets state to OPEN and starts pause timer.
   */
  private tripCircuit(): void {
    if (this.state !== CircuitBreakerState.OPEN) {
      this.state = CircuitBreakerState.OPEN;
      this.pauseStartedAt = Date.now();
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(
          `[SelfEvalCircuitBreaker] Circuit breaker TRIPPED after ${this.consecutiveNegatives} consecutive negatives. Pausing self-evaluation for ${CIRCUIT_BREAKER_PAUSE_DURATION_MS}ms\n`,
        );
      }
    }
  }

  /**
   * Reset the circuit breaker (for testing or forced recovery).
   */
  public reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.consecutiveNegatives = 0;
    this.pauseStartedAt = null;
  }
}

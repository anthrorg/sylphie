/**
 * Recovery Mechanism for Drive Engine child process crashes.
 *
 * Implements automatic restart with exponential backoff:
 *   - Exponential backoff: 1s, 2s, 4s, 8s, max 60s
 *   - Max retry count: 3 before safe mode alert
 *   - In-flight message queue persistence across restarts
 *
 * CANON §Known Attractor States: Runaway recovery loops are prevented by
 * the max retry limit and exponential backoff ceiling.
 */

import { Logger } from '@nestjs/common';
import { WsChannelService } from './ws-channel.service';
import { HealthMonitor, HealthReport } from './health-monitor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Recovery options.
 */
export interface RecoveryOptions {
  /** Initial retry delay in milliseconds (default: 1000). */
  initialDelayMs?: number;

  /** Maximum retry delay in milliseconds (default: 60000). */
  maxDelayMs?: number;

  /** Maximum number of retries before safe mode (default: 3). */
  maxRetries?: number;

  /** Backoff multiplier (default: 2). */
  backoffMultiplier?: number;

  /**
   * Jitter fraction applied to each backoff delay (default: 0.25).
   * The actual delay is the computed backoff multiplied by a random factor
   * in [1 - jitterFraction, 1 + jitterFraction], spreading reconnect attempts
   * across instances to avoid a thundering herd. Set to 0 to disable.
   */
  jitterFraction?: number;

  /**
   * Optional provider for the count of pending (in-flight) outbound messages,
   * surfaced via getState().pendingMessageCount. When omitted, the count
   * reports 0. Lets an owner (e.g. the outcome reporter) supply real
   * visibility without RecoveryMechanism taking a hard queue dependency.
   */
  pendingMessageProvider?: () => number;
}

/**
 * Recovery state.
 */
export interface RecoveryState {
  /** Current retry attempt. */
  attemptCount: number;

  /** Maximum allowed retries. */
  maxRetries: number;

  /** Current retry delay in milliseconds. */
  currentDelayMs: number;

  /** Whether safe mode has been entered. */
  inSafeModeAlert: boolean;

  /** Timestamp of the last restart. */
  lastRestartAt: Date | null;

  /** Messages pending send (in-flight). */
  pendingMessageCount: number;
}

// ---------------------------------------------------------------------------
// Recovery Mechanism
// ---------------------------------------------------------------------------

export class RecoveryMechanism {
  private readonly logger = new Logger(RecoveryMechanism.name);

  private attemptCount = 0;
  private currentDelayMs: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetries: number;
  private readonly backoffMultiplier: number;
  private readonly jitterFraction: number;
  private readonly pendingMessageProvider?: () => number;
  private inSafeModeAlert = false;
  private lastRestartAt: Date | null = null;

  constructor(
    private wsChannel: WsChannelService,
    private healthMonitor: HealthMonitor,
    private wsUrl: string,
    options?: RecoveryOptions,
  ) {
    this.initialDelayMs = options?.initialDelayMs ?? 1000;
    this.maxDelayMs = options?.maxDelayMs ?? 60000;
    this.maxRetries = options?.maxRetries ?? 3;
    this.backoffMultiplier = options?.backoffMultiplier ?? 2;
    this.jitterFraction = options?.jitterFraction ?? 0.25;
    this.pendingMessageProvider = options?.pendingMessageProvider;
    this.currentDelayMs = this.initialDelayMs;
  }

  /**
   * Attempt to recover from a child process crash.
   *
   * Checks health and initiates restart with exponential backoff if needed.
   * If max retries are exceeded, enters safe mode alert.
   *
   * @returns true if recovery is in progress or successful, false if safe mode
   */
  async attemptRecovery(): Promise<boolean> {
    const healthReport = this.healthMonitor.getHealthReport();

    if (healthReport.healthy) {
      this.logger.log('Child process is healthy, no recovery needed');
      this.reset();
      return true;
    }

    if (this.inSafeModeAlert) {
      this.logger.error(
        'Safe mode alert: max retries exceeded, manual intervention required',
      );
      return false;
    }

    // Iterative retry loop. Replaces the previous recursive self-call in the
    // catch block, which risked stack growth if maxRetries were ever raised or
    // the depth guard regressed. Each failed reconnect grows the backoff and
    // loops; only an exhausted retry budget exits to safe mode.
    while (this.attemptCount < this.maxRetries) {
      this.attemptCount++;

      // Apply jitter to the *current* backoff so concurrent instances don't
      // all reconnect on the same tick (thundering herd).
      const waitMs = this.applyJitter(this.currentDelayMs);
      this.logger.warn(
        `Recovery attempt ${this.attemptCount}/${this.maxRetries} in ${waitMs}ms`,
      );

      // Wait before retrying.
      await this.delay(waitMs);

      try {
        // Close the old connection and reconnect.
        await this.wsChannel.close(2000);
        this.wsChannel.connect(this.wsUrl);
        // Guard: older/mocked channels may not implement this counter.
        if (typeof this.wsChannel.incrementReconnectCount === 'function') {
          this.wsChannel.incrementReconnectCount();
        }

        this.lastRestartAt = new Date();
        this.advanceBackoff();

        this.logger.log(
          `Process restarted successfully (attempt ${this.attemptCount})`,
        );
        return true;
      } catch (error) {
        this.logger.error(
          `Recovery attempt ${this.attemptCount} failed: ${error instanceof Error ? error.message : String(error)}`,
        );

        // Grow the backoff for the next loop iteration.
        this.advanceBackoff();
        // Continue looping until the retry budget is exhausted.
      }
    }

    // Retry budget exhausted without a successful reconnect.
    this.logger.error(
      `Max retry limit (${this.maxRetries}) exceeded, entering safe mode alert`,
    );
    this.inSafeModeAlert = true;
    return false;
  }

  /**
   * Reset recovery state after successful operation.
   *
   * Clears retry counters and resets the backoff delay.
   */
  reset(): void {
    this.attemptCount = 0;
    this.currentDelayMs = this.initialDelayMs;
    this.inSafeModeAlert = false;
    this.logger.log('Recovery state reset');
  }

  /**
   * Get the current recovery state.
   *
   * @returns RecoveryState object
   */
  getState(): RecoveryState {
    return {
      attemptCount: this.attemptCount,
      maxRetries: this.maxRetries,
      currentDelayMs: this.currentDelayMs,
      inSafeModeAlert: this.inSafeModeAlert,
      lastRestartAt: this.lastRestartAt,
      pendingMessageCount: this.pendingMessageProvider
        ? this.pendingMessageProvider()
        : 0,
    };
  }

  /**
   * Check if the system is in safe mode alert.
   *
   * @returns true if max retries have been exceeded
   */
  isSafeModeAlert(): boolean {
    return this.inSafeModeAlert;
  }

  // ---------------------------------------------------------------------------
  // Private: Utilities
  // ---------------------------------------------------------------------------

  /**
   * Grow the backoff delay by the multiplier, capped at maxDelayMs.
   */
  private advanceBackoff(): void {
    this.currentDelayMs = Math.min(
      this.currentDelayMs * this.backoffMultiplier,
      this.maxDelayMs,
    );
  }

  /**
   * Apply randomized jitter to a delay, returning a value in
   * [delay * (1 - jitterFraction), delay * (1 + jitterFraction)] clamped to
   * a non-negative integer. Spreads reconnection attempts across instances.
   *
   * @param delayMs - Base delay in milliseconds
   */
  private applyJitter(delayMs: number): number {
    if (this.jitterFraction <= 0) {
      return delayMs;
    }
    // Random factor in [1 - f, 1 + f].
    const factor = 1 + (Math.random() * 2 - 1) * this.jitterFraction;
    return Math.max(0, Math.round(delayMs * factor));
  }

  /**
   * Sleep for the specified duration.
   *
   * @param ms - Milliseconds to sleep
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

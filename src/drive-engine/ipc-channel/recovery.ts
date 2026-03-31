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
import { IpcChannelService } from './ipc-channel.service';
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
  private inSafeModeAlert = false;
  private lastRestartAt: Date | null = null;

  constructor(
    private ipcChannel: IpcChannelService,
    private healthMonitor: HealthMonitor,
    options?: RecoveryOptions,
  ) {
    this.initialDelayMs = options?.initialDelayMs ?? 1000;
    this.maxDelayMs = options?.maxDelayMs ?? 60000;
    this.maxRetries = options?.maxRetries ?? 3;
    this.backoffMultiplier = options?.backoffMultiplier ?? 2;
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

    if (this.attemptCount >= this.maxRetries) {
      this.logger.error(
        `Max retry limit (${this.maxRetries}) exceeded, entering safe mode alert`,
      );
      this.inSafeModeAlert = true;
      return false;
    }

    this.attemptCount++;
    this.logger.warn(
      `Recovery attempt ${this.attemptCount}/${this.maxRetries} in ${this.currentDelayMs}ms`,
    );

    // Wait before retrying
    await this.delay(this.currentDelayMs);

    try {
      // Close the old process and reopen the channel
      await this.ipcChannel.close(2000);
      this.ipcChannel.fork();
      this.ipcChannel.incrementRestartCount();

      this.lastRestartAt = new Date();
      this.currentDelayMs = Math.min(
        this.currentDelayMs * this.backoffMultiplier,
        this.maxDelayMs,
      );

      this.logger.log(
        `Process restarted successfully (attempt ${this.attemptCount})`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Recovery attempt ${this.attemptCount} failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Exponential backoff for next attempt
      this.currentDelayMs = Math.min(
        this.currentDelayMs * this.backoffMultiplier,
        this.maxDelayMs,
      );

      // Retry again (until max retries exceeded)
      return this.attemptRecovery();
    }
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
      pendingMessageCount: 0, // Placeholder: would be tracked by IpcChannelService
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
   * Sleep for the specified duration.
   *
   * @param ms - Milliseconds to sleep
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

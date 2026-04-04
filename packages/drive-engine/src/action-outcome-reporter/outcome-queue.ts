/**
 * FIFO queue for asynchronous delivery of action outcomes and metrics to the Drive Engine process.
 *
 * CANON §Drive Isolation: The Drive Engine process communication is one-way from
 * the main process. OutcomeQueue buffers ACTION_OUTCOME and SOFTWARE_METRICS messages,
 * flushes them asynchronously (setImmediate), and handles retries if the child
 * process is temporarily unavailable.
 *
 * Max queue size: 1000 messages (configurable)
 * Max retries: 3 per message with exponential backoff
 * If queue exceeds max, oldest messages are dropped (with logging)
 */

import { Logger } from '@nestjs/common';
import {
  DriveIPCMessage,
  DriveIPCMessageType,
  ActionOutcomePayload,
  SoftwareMetricsPayload,
} from '@sylphie/shared';

/**
 * Pending message in the outcome queue.
 */
interface QueuedMessage {
  message: DriveIPCMessage<ActionOutcomePayload | SoftwareMetricsPayload>;
  retries: number;
  enqueuedAt: Date;
}

/**
 * Configuration for OutcomeQueue.
 */
export interface OutcomeQueueConfig {
  /**
   * Maximum queue size before dropping oldest messages.
   * Default: 1000
   */
  maxQueueSize?: number;

  /**
   * Maximum number of retry attempts per message.
   * Default: 3
   */
  maxRetries?: number;

  /**
   * Base delay for exponential backoff in milliseconds.
   * Default: 10ms
   */
  baseRetryDelayMs?: number;
}

/**
 * FIFO queue for action outcome and software metrics delivery to the Drive Engine.
 *
 * Features:
 *   - Fire-and-forget async delivery via setImmediate()
 *   - Accumulates messages if child is temporarily unavailable
 *   - Exponential backoff retry (up to maxRetries)
 *   - Drops oldest messages if queue exceeds maxQueueSize
 *   - All operations are synchronous (no Promises) for minimal latency
 */
export class OutcomeQueue {
  private readonly logger = new Logger(OutcomeQueue.name);

  private queue: QueuedMessage[] = [];
  private flushPending = false;

  private readonly maxQueueSize: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;

  constructor(
    private isSendFn: (message: DriveIPCMessage<any>) => boolean,
    config: OutcomeQueueConfig = {},
  ) {
    this.maxQueueSize = config.maxQueueSize ?? 1000;
    this.maxRetries = config.maxRetries ?? 3;
    this.baseRetryDelayMs = config.baseRetryDelayMs ?? 10;
  }

  /**
   * Enqueue an action outcome message for delivery.
   *
   * @param actionOutcome - The outcome payload
   */
  enqueueOutcome(actionOutcome: ActionOutcomePayload): void {
    const message: DriveIPCMessage<ActionOutcomePayload> = {
      type: DriveIPCMessageType.ACTION_OUTCOME,
      payload: actionOutcome,
      timestamp: new Date(),
    };

    this.enqueue(message);
  }

  /**
   * Enqueue a software metrics message for delivery.
   *
   * @param metricsPayload - The metrics payload
   */
  enqueueMetrics(metricsPayload: SoftwareMetricsPayload): void {
    const message: DriveIPCMessage<SoftwareMetricsPayload> = {
      type: DriveIPCMessageType.SOFTWARE_METRICS,
      payload: metricsPayload,
      timestamp: new Date(),
    };

    this.enqueue(message);
  }

  /**
   * Get the current queue size (for testing/monitoring).
   *
   * @returns Number of messages currently queued
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Drain all pending messages immediately.
   * Used for graceful shutdown.
   */
  drainSync(): void {
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      if (!queued) {
        break;
      }

      try {
        this.isSendFn(queued.message);
      } catch (error) {
        this.logger.warn(
          `Failed to drain message during shutdown: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Enqueue a message and schedule async flush.
   *
   * @param message - The IPC message to queue
   */
  private enqueue(
    message: DriveIPCMessage<ActionOutcomePayload | SoftwareMetricsPayload>,
  ): void {
    // Check queue size and drop oldest if necessary
    if (this.queue.length >= this.maxQueueSize) {
      const dropped = this.queue.shift();
      this.logger.warn(
        `Outcome queue exceeded max size (${this.maxQueueSize}), dropping oldest message: ${dropped?.message.type}`,
      );
    }

    this.queue.push({
      message,
      retries: 0,
      enqueuedAt: new Date(),
    });

    this.scheduleFlush();
  }

  /**
   * Schedule an async flush of the queue via setImmediate.
   * Prevents duplicate flush operations.
   */
  private scheduleFlush(): void {
    if (this.flushPending) {
      return;
    }

    this.flushPending = true;
    setImmediate(() => {
      this.flushPending = false;
      this.flush();
    });
  }

  /**
   * Flush queued messages to the child process.
   *
   * Sends messages until the child is unavailable or queue is empty.
   * On failure, messages are re-queued for retry (up to maxRetries).
   */
  private flush(): void {
    while (this.queue.length > 0) {
      const queued = this.queue[0]; // Peek, don't shift yet

      try {
        // Attempt send
        const sent = this.isSendFn(queued.message);

        if (sent) {
          // Success: remove from queue
          this.queue.shift();
        } else {
          // Child process not available: stop flushing and wait for next flush cycle
          break;
        }
      } catch (error) {
        // Send failed: increment retries and check if we should retry
        queued.retries++;

        if (queued.retries >= this.maxRetries) {
          // Max retries exceeded: drop the message
          const dropped = this.queue.shift();
          this.logger.error(
            `Message dropped after ${this.maxRetries} retries (type: ${dropped?.message.type}): ${error instanceof Error ? error.message : String(error)}`,
          );
        } else {
          // Schedule retry with exponential backoff
          const backoffMs =
            this.baseRetryDelayMs * Math.pow(2, queued.retries - 1);
          setTimeout(() => {
            this.scheduleFlush();
          }, backoffMs);
          break;
        }
      }
    }
  }
}

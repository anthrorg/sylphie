/**
 * IPC Channel Service for Drive Engine process communication.
 *
 * Manages the child_process.fork() lifecycle and bidirectional IPC messaging
 * with the Drive Engine child process. Includes:
 *   - Process spawning and stdio configuration
 *   - FIFO message send queue for main → child
 *   - Message handler dispatch for child → main
 *   - Lifecycle tracking (spawn time, restart count)
 *   - Error handling for malformed messages
 *
 * CANON §Drive Isolation: One-way communication boundary. The main process
 * sends action outcomes and metrics; the child process sends drive snapshots
 * and opportunities. No bidirectional RPC pattern.
 */

import { Injectable, Logger } from '@nestjs/common';
import { fork, ChildProcess } from 'child_process';
import { join } from 'path';
import path from 'path';
import {
  DriveIPCMessage,
  DriveIPCMessageType,
} from '@sylphie/shared';
import {
  validateOutboundMessage,
  safeValidateMessage,
} from './ipc-message-validator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Handler for inbound IPC messages from the child process.
 *
 * @param message - The validated IPC message from the child
 */
export type MessageHandler = (message: DriveIPCMessage<any>) => void;

/**
 * Registered handlers for specific message types.
 */
interface MessageHandlers {
  [DriveIPCMessageType.DRIVE_SNAPSHOT]?: MessageHandler;
  [DriveIPCMessageType.OPPORTUNITY_CREATED]?: MessageHandler;
  [DriveIPCMessageType.DRIVE_EVENT]?: MessageHandler;
  [DriveIPCMessageType.HEALTH_STATUS]?: MessageHandler;
}

/**
 * Outbound message pending send.
 */
interface PendingMessage {
  message: DriveIPCMessage<any>;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// IPC Channel Service
// ---------------------------------------------------------------------------

@Injectable()
export class IpcChannelService {
  private readonly logger = new Logger(IpcChannelService.name);

  private childProcess: ChildProcess | null = null;
  private messageHandlers: MessageHandlers = {};
  private sendQueue: PendingMessage[] = [];
  private isProcessing = false;

  // Lifecycle tracking
  private spawnTime: number | null = null;
  private restartCount = 0;
  private lastHealthCheckTime: number | null = null;
  private lastTick: number | null = null;

  /**
   * Spawn the Drive Engine child process and attach IPC handlers.
   *
   * Fork configuration:
   *   - stdio: ['inherit', 'inherit', 'inherit', 'ipc'] — inherit std streams, IPC on fd 3
   *   - cwd: project root for relative module resolution
   *
   * Attaches handlers for:
   *   - 'message': incoming IPC messages from child
   *   - 'error': fatal process errors
   *   - 'exit': process exit/crash detection
   *
   * @throws {Error} If the fork fails or child entry point is not found
   */
  fork(): void {
    if (this.childProcess) {
      throw new Error('IPC channel already open (process already forked)');
    }

    // Resolve the child process entry point
    const childEntryPoint = join(__dirname, '../drive-process/main.js');

    try {
      this.logger.log(`Forking Drive Engine child process: ${childEntryPoint}`);

      this.childProcess = fork(childEntryPoint, [], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        cwd: process.cwd(),
      });

      this.spawnTime = Date.now();
      this.lastHealthCheckTime = Date.now();
      this.lastTick = Date.now();

      // Attach IPC message handler
      this.childProcess.on('message', (message) => {
        this.onChildMessage(message);
      });

      // Attach error handler
      this.childProcess.on('error', (error) => {
        this.logger.error(`Child process error: ${error.message}`, error.stack);
      });

      // Attach exit handler
      this.childProcess.on('exit', (code, signal) => {
        this.logger.warn(
          `Child process exited (code: ${code}, signal: ${signal})`,
        );
        this.childProcess = null;
      });

      this.logger.log(
        `Drive Engine child process spawned (PID: ${this.childProcess.pid})`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to fork Drive Engine child: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Register a handler for a specific inbound message type.
   *
   * @param messageType - The DriveIPCMessageType to handle
   * @param handler - The handler function to call when this message arrives
   */
  onMessage(messageType: DriveIPCMessageType, handler: MessageHandler): void {
    (this.messageHandlers as any)[messageType] = handler;
    this.logger.debug(`Registered handler for message type: ${messageType}`);
  }

  /**
   * Send an IPC message to the child process.
   *
   * Messages are enqueued in a FIFO send queue and processed asynchronously.
   * If the child process is not running, the message is queued for delivery
   * on the next restart.
   *
   * @param message - The IPC message to send
   */
  send(message: DriveIPCMessage<any>): void {
    this.sendQueue.push({
      message,
      timestamp: Date.now(),
    });

    if (!this.isProcessing) {
      this.processSendQueue();
    }
  }

  /**
   * Gracefully close the IPC channel and terminate the child process.
   *
   * Sends SIGTERM and waits for graceful exit. If the process does not exit
   * within the grace period, it is force-killed with SIGKILL.
   *
   * @param graceMs - Grace period in milliseconds (default: 5000)
   * @throws {Error} If the process cannot be terminated
   */
  async close(graceMs = 5000): Promise<void> {
    if (!this.childProcess) {
      this.logger.debug('IPC channel already closed (no active process)');
      return;
    }

    const pid = this.childProcess.pid;
    this.logger.log(`Closing IPC channel (PID: ${pid})`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.logger.warn(`Graceful shutdown timeout, force-killing PID: ${pid}`);
        if (this.childProcess?.kill('SIGKILL')) {
          this.logger.log(`Force-killed PID: ${pid}`);
        }
        resolve();
      }, graceMs);

      this.childProcess!.once('exit', () => {
        clearTimeout(timeout);
        this.childProcess = null;
        this.logger.log('Child process exited gracefully');
        resolve();
      });

      // Send graceful shutdown signal
      this.childProcess!.kill('SIGTERM');
    });
  }

  /**
   * Check whether the child process is running and responsive.
   *
   * A process is considered healthy if:
   *   - It is currently running (childProcess is not null)
   *   - Last health check response was within the heartbeat window
   *   - Last tick was recent (within heartbeat window)
   *
   * @returns true if the process is healthy, false otherwise
   */
  isHealthy(heartbeatMs = 5000): boolean {
    if (!this.childProcess) {
      return false;
    }

    const now = Date.now();

    if (!this.lastHealthCheckTime || !this.lastTick) {
      return false;
    }

    const timeSinceHealthCheck = now - this.lastHealthCheckTime;
    const timeSinceTick = now - this.lastTick;

    return timeSinceHealthCheck < heartbeatMs && timeSinceTick < heartbeatMs;
  }

  /**
   * Get process lifecycle information.
   *
   * @returns Object with spawn time, uptime, restart count, PID
   */
  getProcessInfo(): {
    spawned: boolean;
    pid: number | null;
    uptime: number | null;
    restartCount: number;
  } {
    return {
      spawned: this.childProcess !== null,
      pid: this.childProcess?.pid ?? null,
      uptime: this.spawnTime ? Date.now() - this.spawnTime : null,
      restartCount: this.restartCount,
    };
  }

  /**
   * Increment the restart counter.
   * Called by the Recovery Mechanism when the process is restarted.
   */
  incrementRestartCount(): void {
    this.restartCount++;
  }

  // ---------------------------------------------------------------------------
  // Private: Message Processing
  // ---------------------------------------------------------------------------

  /**
   * Handle incoming messages from the child process.
   *
   * @param message - Raw data received from child via IPC
   */
  private onChildMessage(message: unknown): void {
    // Validate the message at the boundary
    const validation = safeValidateMessage(message, 'outbound');

    if (!validation.success) {
      this.logger.error(
        `Malformed IPC message from child: ${validation.error}`,
      );
      return;
    }

    const validatedMessage = validation.data as DriveIPCMessage<any>;

    // Update health metrics based on message type
    if (validatedMessage.type === DriveIPCMessageType.DRIVE_SNAPSHOT) {
      this.lastTick = Date.now();
    }

    if (validatedMessage.type === DriveIPCMessageType.HEALTH_STATUS) {
      this.lastHealthCheckTime = Date.now();
    }

    // Dispatch to registered handler
    const handler = (this.messageHandlers as any)[validatedMessage.type];
    if (handler) {
      try {
        handler(validatedMessage);
      } catch (error) {
        this.logger.error(
          `Error in message handler for ${validatedMessage.type}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Process the FIFO send queue.
   *
   * Sends pending messages to the child process. If the child is not running,
   * messages remain queued for the next restart.
   */
  private processSendQueue(): void {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    while (this.sendQueue.length > 0 && this.childProcess) {
      const pending = this.sendQueue.shift();
      if (!pending) {
        break;
      }

      try {
        this.childProcess.send(pending.message);
        // Successful send — message is no longer in queue
      } catch (error) {
        // Re-queue the message and stop processing
        this.sendQueue.unshift(pending);
        this.logger.error(
          `Failed to send IPC message: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }

    this.isProcessing = false;

    // If there are still messages queued and the child crashed, we'll
    // re-queue them on the next restart (handled by Recovery Mechanism)
  }
}

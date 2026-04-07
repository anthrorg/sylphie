/**
 * WebSocket Channel Service for Drive Engine communication.
 *
 * Replaces IpcChannelService — connects to the standalone Drive Engine
 * server over WebSocket instead of managing a child_process.fork().
 *
 * Same API shape as IpcChannelService:
 *   - connect(url): opens WebSocket connection (replaces fork())
 *   - send(message): serialize + send (with queue for disconnected state)
 *   - onMessage(type, handler): register typed handler
 *   - close(graceMs): graceful disconnect
 *   - isHealthy(heartbeatMs): readyState + timing check
 *
 * CANON §Drive Isolation: The main app communicates with the drive engine
 * exclusively through this WebSocket channel. It has no access to drive
 * rules, process memory, or internal state — only the wire protocol.
 */

import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import {
  DriveIPCMessage,
  DriveIPCMessageType,
} from '@sylphie/shared';
import { safeValidateMessage } from './ipc-message-validator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageHandler = (message: DriveIPCMessage<any>) => void;

interface MessageHandlers {
  [DriveIPCMessageType.DRIVE_SNAPSHOT]?: MessageHandler;
  [DriveIPCMessageType.OPPORTUNITY_CREATED]?: MessageHandler;
  [DriveIPCMessageType.DRIVE_EVENT]?: MessageHandler;
  [DriveIPCMessageType.HEALTH_STATUS]?: MessageHandler;
}

interface PendingMessage {
  message: DriveIPCMessage<any>;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// WebSocket Channel Service
// ---------------------------------------------------------------------------

/**
 * Maximum rate for logging validation errors (one per this many ms).
 * Prevents a misbehaving drive engine from flooding the event loop
 * with error logs and starving every other subsystem.
 */
const VALIDATION_ERROR_LOG_INTERVAL_MS = 5_000;

@Injectable()
export class WsChannelService {
  private readonly logger = new Logger(WsChannelService.name);

  private ws: WebSocket | null = null;
  private url: string = '';
  private messageHandlers: MessageHandlers = {};
  private sendQueue: PendingMessage[] = [];
  private isProcessing = false;

  // Lifecycle tracking
  private connectTime: number | null = null;
  private reconnectCount = 0;
  private lastMessageTime: number | null = null;

  // Rate-limited validation error logging
  private lastValidationErrorLogAt = 0;
  private suppressedValidationErrors = 0;

  /**
   * Connect to the Drive Engine WebSocket server.
   *
   * @param url - WebSocket URL (e.g., ws://localhost:3001)
   */
  connect(url: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      throw new Error('WebSocket channel already connected');
    }

    this.url = url;
    this.logger.log(`Connecting to Drive Engine at ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.connectTime = Date.now();
      this.lastMessageTime = Date.now();
      this.logger.log(`Connected to Drive Engine at ${url}`);
      this.flushSendQueue();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      this.onServerMessage(data);
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(
        `Drive Engine connection closed (code: ${code}, reason: ${reason?.toString() || 'none'})`,
      );
      this.ws = null;
    });

    this.ws.on('error', (error) => {
      this.logger.error(`Drive Engine connection error: ${error.message}`);
    });
  }

  /**
   * Register a handler for a specific inbound message type.
   */
  onMessage(messageType: DriveIPCMessageType, handler: MessageHandler): void {
    (this.messageHandlers as any)[messageType] = handler;
    this.logger.debug(`Registered handler for message type: ${messageType}`);
  }

  /**
   * Send a message to the Drive Engine server.
   * Messages are queued if the connection is not open.
   */
  send(message: DriveIPCMessage<any>): void {
    this.sendQueue.push({
      message,
      timestamp: Date.now(),
    });

    if (!this.isProcessing) {
      this.flushSendQueue();
    }
  }

  /**
   * Gracefully close the WebSocket connection.
   *
   * @param graceMs - Grace period before force-closing (default: 5000)
   */
  async close(graceMs = 5000): Promise<void> {
    if (!this.ws) {
      this.logger.debug('WebSocket channel already closed');
      return;
    }

    this.logger.log('Closing Drive Engine connection');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.warn('Graceful close timeout, force-terminating');
        if (this.ws) {
          this.ws.terminate();
          this.ws = null;
        }
        resolve();
      }, graceMs);

      this.ws!.once('close', () => {
        clearTimeout(timeout);
        this.ws = null;
        this.logger.log('Drive Engine connection closed gracefully');
        resolve();
      });

      this.ws!.close(1000, 'shutdown');
    });
  }

  /**
   * Check whether the connection is healthy.
   *
   * Healthy = WebSocket is open AND we received a message recently.
   */
  isHealthy(heartbeatMs = 5000): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (!this.lastMessageTime) {
      return false;
    }

    return (Date.now() - this.lastMessageTime) < heartbeatMs;
  }

  /**
   * Get connection lifecycle information.
   */
  getConnectionInfo(): {
    connected: boolean;
    url: string;
    uptime: number | null;
    reconnectCount: number;
  } {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      url: this.url,
      uptime: this.connectTime ? Date.now() - this.connectTime : null,
      reconnectCount: this.reconnectCount,
    };
  }

  /**
   * Increment the reconnect counter.
   * Called by RecoveryMechanism after a reconnect.
   */
  incrementReconnectCount(): void {
    this.reconnectCount++;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private onServerMessage(data: WebSocket.RawData): void {
    this.lastMessageTime = Date.now();

    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      this.logger.error('Failed to parse message from Drive Engine');
      return;
    }

    const validation = safeValidateMessage(raw, 'outbound');

    if (!validation.success) {
      const now = Date.now();
      if (now - this.lastValidationErrorLogAt >= VALIDATION_ERROR_LOG_INTERVAL_MS) {
        const suppressed = this.suppressedValidationErrors;
        this.logger.error(
          `Invalid message from Drive Engine: ${validation.error}` +
            (suppressed > 0 ? ` (${suppressed} similar errors suppressed)` : ''),
        );
        this.lastValidationErrorLogAt = now;
        this.suppressedValidationErrors = 0;
      } else {
        this.suppressedValidationErrors++;
      }
      return;
    }

    const msg = validation.data as DriveIPCMessage<any>;
    const handler = (this.messageHandlers as any)[msg.type];
    if (handler) {
      try {
        handler(msg);
      } catch (error) {
        this.logger.error(
          `Error in handler for ${msg.type}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private flushSendQueue(): void {
    if (this.isProcessing) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.isProcessing = true;

    while (this.sendQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const pending = this.sendQueue.shift();
      if (!pending) break;

      try {
        this.ws.send(JSON.stringify(pending.message));
      } catch (error) {
        this.sendQueue.unshift(pending);
        this.logger.error(
          `Failed to send message: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }

    this.isProcessing = false;
  }
}

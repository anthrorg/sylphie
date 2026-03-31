/**
 * ConnectionManagerService — WebSocket client lifecycle management.
 *
 * Tracks active WebSocket connections organized by named channels.
 * Provides broadcast, unicast, and metrics operations.
 *
 * Supports both Socket.io and raw ws package clients. Client metadata
 * (connected time, last pong time) enables stale connection detection.
 *
 * CANON §Architecture: WebSocket is the primary real-time transport for:
 * - Telemetry events (drive state snapshots)
 * - Graph updates (node/edge creation and confidence changes)
 * - Conversation messages (bidirectional)
 * - Health check results
 *
 * Heartbeat mechanism:
 * - Starts on module init, runs every wsHeartbeatIntervalMs
 * - Pings all connected clients across all channels
 * - Detects and removes stale connections (no pong response within timeout)
 * - Cleans up empty channels automatically
 *
 * Channel naming convention:
 * - 'telemetry' — TelemetryGateway clients
 * - 'graph' — GraphUpdatesGateway clients
 * - 'conversation:{sessionId}' — ConversationGateway clients per session
 */

import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IConnectionManagerService } from '../interfaces/web.interfaces';
import type { WebConfig } from '../web.config';

// WebSocket client type — abstracted over Socket.io or ws implementation.
// Must support .send(data), .emit(event, data), or ws-style send.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebSocketClient = any;

/**
 * Client metadata tracked per connection.
 * Used for heartbeat monitoring and stale detection.
 */
interface ClientMetadata {
  readonly client: WebSocketClient;
  readonly connectedAt: Date;
  lastPongAt: Date;
}

@Injectable()
export class ConnectionManagerService
  implements IConnectionManagerService, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ConnectionManagerService.name);

  /**
   * Internal map of channels to client metadata sets.
   * Structure: Map<channelName, Set<ClientMetadata>>
   */
  private readonly channels = new Map<string, Set<ClientMetadata>>();

  /**
   * Heartbeat interval ID for cleanup.
   */
  private heartbeatIntervalId: NodeJS.Timeout | null = null;

  /**
   * Heartbeat interval in milliseconds (from config).
   */
  private readonly heartbeatIntervalMs: number;

  /**
   * Timeout for waiting for pong responses (1/2 of heartbeat interval).
   */
  private readonly pongTimeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    const webConfig = this.configService.get<WebConfig>('web');
    this.heartbeatIntervalMs = webConfig?.websocket.heartbeatIntervalMs ?? 30000;
    this.pongTimeoutMs = Math.floor(this.heartbeatIntervalMs / 2);

    this.logger.debug(
      `Initialized with heartbeat interval: ${this.heartbeatIntervalMs}ms, pong timeout: ${this.pongTimeoutMs}ms`,
    );
  }

  /**
   * Start the heartbeat interval on module init.
   *
   * The heartbeat runs periodically to detect stale connections.
   * All clients receive a ping; those that don't respond within pongTimeoutMs
   * are removed automatically.
   */
  onModuleInit(): void {
    this.startHeartbeat();
  }

  /**
   * Register a WebSocket client on a named channel.
   *
   * Called when a client connects. The channel name typically identifies
   * a logical broadcast group (e.g., "telemetry", "graph", "conversation").
   *
   * Initializes client metadata (connected time, last pong).
   *
   * @param client - The WebSocket connection to register.
   * @param channel - The broadcast channel to join.
   */
  register(client: WebSocketClient, channel: string): void {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }

    const clientSet = this.channels.get(channel);
    if (clientSet) {
      const metadata: ClientMetadata = {
        client,
        connectedAt: new Date(),
        lastPongAt: new Date(),
      };

      // Register pong handler for heartbeat
      this.registerPongHandler(client);

      clientSet.add(metadata);
      this.logger.debug(
        `Client registered on channel "${channel}" (${clientSet.size} total)`,
      );
    }
  }

  /**
   * Unregister a WebSocket client from a named channel.
   *
   * Called when a client disconnects or explicitly leaves a channel.
   * Safe to call multiple times on the same client/channel pair.
   *
   * @param client - The WebSocket connection to unregister.
   * @param channel - The broadcast channel to leave.
   */
  unregister(client: WebSocketClient, channel: string): void {
    const clientSet = this.channels.get(channel);
    if (clientSet) {
      // Find and remove metadata for this client
      let foundMetadata: ClientMetadata | null = null;
      for (const metadata of clientSet) {
        if (metadata.client === client) {
          foundMetadata = metadata;
          break;
        }
      }

      if (foundMetadata) {
        clientSet.delete(foundMetadata);

        // Clean up empty channel
        if (clientSet.size === 0) {
          this.channels.delete(channel);
          this.logger.debug(`Channel "${channel}" removed (no clients)`);
        } else {
          this.logger.debug(
            `Client unregistered from channel "${channel}" (${clientSet.size} remaining)`,
          );
        }
      }
    }
  }

  /**
   * Broadcast a message to all clients subscribed to a channel.
   *
   * Serializes the message to JSON and sends to all connected clients
   * on the given channel. Handles client disconnections gracefully
   * (removes clients that fail to send).
   *
   * @param channel - The broadcast channel.
   * @param message - Object to be JSON-serialized and sent.
   */
  broadcast(channel: string, message: unknown): void {
    const clientSet = this.channels.get(channel);
    if (!clientSet || clientSet.size === 0) {
      this.logger.debug(`broadcast("${channel}"): no clients subscribed`);
      return;
    }

    const jsonMessage = JSON.stringify(message);
    const failedClients: ClientMetadata[] = [];

    for (const metadata of clientSet) {
      if (!this.sendRaw(metadata.client, jsonMessage)) {
        failedClients.push(metadata);
      }
    }

    // Clean up failed clients
    for (const metadata of failedClients) {
      this.unregister(metadata.client, channel);
    }
  }

  /**
   * Send a message to a specific client with optional timeout.
   *
   * Used for request-response patterns (e.g., requesting a health check
   * or querying for specific data). The promise resolves when the message
   * is sent or rejects on timeout.
   *
   * @param client - The target WebSocket connection.
   * @param message - Object to be JSON-serialized and sent.
   * @param timeoutMs - Optional timeout in milliseconds (default: 5000).
   * @returns Promise that resolves when send completes or rejects on timeout/error.
   */
  async sendToClient(
    client: WebSocketClient,
    message: unknown,
    timeoutMs: number = 5000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new Error(`sendToClient timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const jsonMessage = JSON.stringify(message);
        const success = this.sendRaw(client, jsonMessage);

        clearTimeout(timeoutHandle);

        if (success) {
          resolve();
        } else {
          reject(new Error('Failed to send message to client (closed connection)'));
        }
      } catch (error) {
        clearTimeout(timeoutHandle);
        reject(error);
      }
    });
  }

  /**
   * Get the total number of connected clients.
   *
   * When channel is omitted, returns all clients across all channels.
   * When channel is provided, returns only clients on that channel.
   *
   * @param channel - Optional channel name to filter by.
   * @returns Count of connected clients.
   */
  getConnectionCount(channel?: string): number {
    if (channel) {
      return this.channels.get(channel)?.size ?? 0;
    }

    let total = 0;
    for (const clientSet of this.channels.values()) {
      total += clientSet.size;
    }

    return total;
  }

  /**
   * Get all active channel names.
   *
   * Returns a snapshot of channel names that currently have at least
   * one connected client.
   *
   * @returns Array of active channel names.
   */
  getChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Cleanup on module destroy.
   *
   * Stops the heartbeat interval, closes all WebSocket connections,
   * and clears all channel registrations.
   */
  onModuleDestroy(): void {
    this.stopHeartbeat();

    const totalClients = this.getConnectionCount();
    this.logger.log(
      `Cleaning up ${this.channels.size} active channels and ${totalClients} clients`,
    );

    // Close all WebSocket connections
    for (const clientSet of this.channels.values()) {
      for (const metadata of clientSet) {
        this.closeConnection(metadata.client);
      }
    }

    this.channels.clear();
  }

  /**
   * Start the heartbeat interval.
   *
   * Runs periodically to ping all connected clients and detect stale connections.
   * Clients that don't respond to ping within pongTimeoutMs are removed.
   *
   * @private
   */
  private startHeartbeat(): void {
    if (this.heartbeatIntervalId !== null) {
      this.logger.warn('Heartbeat already running');
      return;
    }

    this.logger.log(`Starting heartbeat with ${this.heartbeatIntervalMs}ms interval`);

    this.heartbeatIntervalId = setInterval(() => {
      this.performHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop the heartbeat interval.
   *
   * @private
   */
  private stopHeartbeat(): void {
    if (this.heartbeatIntervalId !== null) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
      this.logger.log('Heartbeat stopped');
    }
  }

  /**
   * Perform a single heartbeat cycle.
   *
   * Pings all connected clients and removes those that haven't ponged
   * within the timeout window.
   *
   * @private
   */
  private performHeartbeat(): void {
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - this.pongTimeoutMs);

    for (const [channel, clientSet] of this.channels.entries()) {
      const staleClients: ClientMetadata[] = [];

      for (const metadata of clientSet) {
        // Check if client is stale (hasn't ponged recently)
        if (metadata.lastPongAt < staleThreshold) {
          staleClients.push(metadata);
        } else {
          // Send ping to active clients
          this.sendPing(metadata.client);
        }
      }

      // Remove stale clients
      for (const metadata of staleClients) {
        this.logger.warn(
          `Removing stale client from channel "${channel}" (no pong for ${this.pongTimeoutMs}ms)`,
        );
        this.unregister(metadata.client, channel);
      }
    }
  }

  /**
   * Register the pong handler for a client.
   *
   * When a client is registered, we attach a handler for incoming pong messages
   * to update the lastPongAt timestamp. This enables stale detection.
   *
   * @private
   */
  private registerPongHandler(client: WebSocketClient): void {
    try {
      // Try Socket.io style (.on)
      if (typeof client.on === 'function') {
        client.on('pong', () => {
          // Update lastPongAt in all channels where this client is registered
          for (const clientSet of this.channels.values()) {
            for (const metadata of clientSet) {
              if (metadata.client === client) {
                metadata.lastPongAt = new Date();
              }
            }
          }
        });
      }
      // Try raw ws style (.onmessage and check for pong)
      else if (typeof client.on === 'function') {
        client.on('message', (data: unknown) => {
          if (typeof data === 'string' && data === 'pong') {
            for (const clientSet of this.channels.values()) {
              for (const metadata of clientSet) {
                if (metadata.client === client) {
                  metadata.lastPongAt = new Date();
                }
              }
            }
          }
        });
      }
    } catch (error) {
      this.logger.warn(`Failed to register pong handler: ${error}`);
    }
  }

  /**
   * Send a ping message to a client.
   *
   * Supports both Socket.io style (.emit) and raw ws style (.send).
   *
   * @private
   */
  private sendPing(client: WebSocketClient): boolean {
    try {
      // Try Socket.io style
      if (typeof client.emit === 'function') {
        client.emit('ping');
        return true;
      }

      // Try raw ws style (.send)
      if (typeof client.send === 'function') {
        const isOpen = client.readyState === 1; // WebSocket.OPEN = 1
        if (isOpen) {
          client.send('ping');
          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.debug(`Failed to send ping: ${error}`);
      return false;
    }
  }

  /**
   * Send raw string data to a client.
   *
   * Supports both Socket.io style (.emit) and raw ws style (.send).
   * Returns true if send succeeded, false if the client is closed.
   *
   * @private
   */
  private sendRaw(client: WebSocketClient, data: string): boolean {
    try {
      // Try Socket.io style first
      if (typeof client.emit === 'function') {
        client.emit('message', data);
        return true;
      }

      // Try raw ws style
      if (typeof client.send === 'function') {
        const isOpen = client.readyState === 1; // WebSocket.OPEN = 1
        if (isOpen) {
          client.send(data);
          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.debug(`Failed to send data: ${error}`);
      return false;
    }
  }

  /**
   * Close a WebSocket connection gracefully.
   *
   * Supports both Socket.io style (.disconnect) and raw ws style (.close).
   *
   * @private
   */
  private closeConnection(client: WebSocketClient): void {
    try {
      // Try Socket.io style
      if (typeof client.disconnect === 'function') {
        client.disconnect();
      }
      // Try raw ws style
      else if (typeof client.close === 'function') {
        client.close();
      }
    } catch (error) {
      this.logger.debug(`Failed to close connection: ${error}`);
    }
  }
}

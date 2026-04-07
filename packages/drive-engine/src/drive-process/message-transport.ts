/**
 * Transport abstraction for DriveEngine communication.
 *
 * Decouples the DriveEngine tick loop from the transport mechanism.
 * Implementations:
 *   - IpcTransport: process.send / process.on('message') (fork-based, legacy)
 *   - WebSocketServerTransport: ws.send / ws.on('message') (standalone server)
 *
 * CANON §Drive Isolation: The transport boundary enforces one-way communication.
 * The DriveEngine sends snapshots/events out and receives outcomes/metrics in.
 * It never knows how messages are delivered — only that they are.
 */

import type { DriveIPCMessage } from '@sylphie/shared';

/**
 * Message transport interface for the DriveEngine.
 *
 * Any transport that can send and receive DriveIPCMessage envelopes
 * can host the DriveEngine. The engine does not know whether messages
 * travel over IPC, WebSocket, TCP, or carrier pigeon.
 */
export interface IMessageTransport {
  /**
   * Send a message to the connected peer (main app).
   * Fire-and-forget — the transport handles buffering/retry.
   */
  send(message: DriveIPCMessage<any>): void;

  /**
   * Register a handler for incoming messages from the peer.
   * Only one handler is supported — subsequent calls replace the previous.
   */
  onMessage(handler: (msg: DriveIPCMessage<unknown>) => void): void;
}

/**
 * IPC transport: wraps process.send / process.on('message').
 *
 * Used when the DriveEngine runs as a child_process.fork() child.
 * Kept as a fallback for testing or gradual migration.
 */
export class IpcTransport implements IMessageTransport {
  send(message: DriveIPCMessage<any>): void {
    if (typeof process !== 'undefined' && process.send) {
      process.send(message);
    }
  }

  onMessage(handler: (msg: DriveIPCMessage<unknown>) => void): void {
    if (typeof process !== 'undefined' && process.on) {
      process.on('message', (raw: unknown) => {
        handler(raw as DriveIPCMessage<unknown>);
      });
    }
  }
}

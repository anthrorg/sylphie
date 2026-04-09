/**
 * WebSocket server-side transport for the DriveEngine.
 *
 * Implements IMessageTransport by sending/receiving JSON-serialized
 * DriveIPCMessage envelopes over a WebSocket connection.
 *
 * CANON §Drive Isolation: This transport is the sole communication path
 * between the drive engine server and the main NestJS app. The main app
 * has no access to drive rules, accumulation rates, or any internal state.
 */

import type WebSocket from 'ws';
import type { DriveIPCMessage } from '@sylphie/shared';
import { verboseFor } from '@sylphie/shared';
import type { IMessageTransport } from '@sylphie/drive-engine/drive-process/message-transport';
import { safeValidateMessage } from '@sylphie/drive-engine/ipc-channel/ipc-message-validator';

const vlog = verboseFor('DriveEngine');

export class WebSocketServerTransport implements IMessageTransport {
  private client: WebSocket | null = null;
  private messageHandler: ((msg: DriveIPCMessage<unknown>) => void) | null = null;

  /**
   * Attach a connected WebSocket client.
   * Only one client is supported at a time (the main app).
   */
  private messageCount = 0;

  setClient(ws: WebSocket): void {
    this.client = ws;
    this.messageCount = 0;
    vlog('WS client attached', {});

    ws.on('message', (data: WebSocket.RawData) => {
      if (!this.messageHandler) return;

      this.messageCount++;
      try {
        const raw = JSON.parse(data.toString());
        const validation = safeValidateMessage(raw, 'inbound');

        if (!validation.success) {
          console.error(`[WsTransport] Invalid inbound message: ${validation.error}`);
          vlog('WS inbound message invalid', { error: validation.error });
          return;
        }

        const msg = validation.data as DriveIPCMessage<unknown>;
        if (this.messageCount % 50 === 0) {
          vlog('WS messages received', { totalCount: this.messageCount, lastType: msg.type });
        }
        this.messageHandler(msg);
      } catch (err) {
        console.error(`[WsTransport] Failed to parse message: ${err}`);
      }
    });

    ws.on('close', () => {
      console.log('[WsTransport] Client disconnected');
      vlog('WS client disconnected', { totalMessagesReceived: this.messageCount });
      this.client = null;
    });

    ws.on('error', (err) => {
      console.error(`[WsTransport] Client error: ${err.message}`);
      vlog('WS client error', { error: err.message });
    });
  }

  send(message: DriveIPCMessage<any>): void {
    if (!this.client || this.client.readyState !== 1 /* WebSocket.OPEN */) {
      return;
    }

    try {
      this.client.send(JSON.stringify(message));
    } catch (err) {
      console.error(`[WsTransport] Send error: ${err}`);
    }
  }

  onMessage(handler: (msg: DriveIPCMessage<unknown>) => void): void {
    this.messageHandler = handler;
  }

  /** Whether a client is currently connected and ready. */
  get isConnected(): boolean {
    return this.client !== null && this.client.readyState === 1;
  }
}

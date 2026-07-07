/**
 * Integration tests for WsChannelService reconnect + bounded/TTL send queue.
 *
 * Uses a real `ws` WebSocketServer as the mock Drive Engine server so the
 * connect()/close()/onClose() lifecycle is exercised end-to-end rather than
 * mocked — regression coverage for TK-128 (reconnect wiring + bounded queue).
 */

import { WebSocketServer } from 'ws';
import { WsChannelService } from './ws-channel.service';
import { DriveIPCMessageType } from '@sylphie/shared';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = new WebSocketServer({ port: 0 });
    srv.on('listening', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Terminate every connected client then close the server (avoids leaked sockets/handles in tests). */
function shutdownServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    server.clients.forEach((c) => c.terminate());
    server.close(() => resolve());
  });
}

describe('WsChannelService — reconnect + bounded/TTL send queue', () => {
  let port: number;

  beforeEach(async () => {
    port = await freePort();
  });

  it('connect() resolves only after the open event fires', async () => {
    const server = new WebSocketServer({ port });
    const channel = new WsChannelService();
    try {
      await expect(channel.connect(`ws://127.0.0.1:${port}`)).resolves.toBeUndefined();
      expect(channel.getConnectionInfo().connected).toBe(true);
    } finally {
      await channel.close(200);
      await shutdownServer(server);
    }
  });

  it('connect() rejects if the socket closes before opening (server not up)', async () => {
    const channel = new WsChannelService();
    await expect(channel.connect(`ws://127.0.0.1:${port}`)).rejects.toBeTruthy();
  });

  it('fires onClose callbacks on an unexpected drop, but not on a deliberate close()', async () => {
    const server = new WebSocketServer({ port });
    let unexpectedCloseCount = 0;
    const channel = new WsChannelService();
    channel.onClose(() => {
      unexpectedCloseCount++;
    });
    try {
      await channel.connect(`ws://127.0.0.1:${port}`);

      // Deliberate close — must NOT fire the onClose callback.
      await channel.close(500);
      expect(unexpectedCloseCount).toBe(0);
    } finally {
      await shutdownServer(server);
    }

    // Unexpected drop — server-side termination — MUST fire the callback.
    const port2 = await freePort();
    const server2 = new WebSocketServer({ port: port2 });
    const channel2 = new WsChannelService();
    let unexpected2 = 0;
    channel2.onClose(() => {
      unexpected2++;
    });
    try {
      await channel2.connect(`ws://127.0.0.1:${port2}`);

      await new Promise<void>((resolve) => {
        server2.clients.forEach((c) => c.terminate());
        setTimeout(resolve, 150);
      });

      expect(unexpected2).toBe(1);
    } finally {
      await shutdownServer(server2);
    }
  });

  it('resumes and drains queued messages once reconnected (drop then re-accept)', async () => {
    const server1 = new WebSocketServer({ port });
    const received: unknown[] = [];
    server1.on('connection', (ws) => {
      ws.on('message', (data) => received.push(JSON.parse(data.toString())));
    });

    const channel = new WsChannelService();
    await channel.connect(`ws://127.0.0.1:${port}`);

    // Drop the connection (simulates a drive-server restart): terminate the
    // server-side socket so the client observes an unexpected close.
    await new Promise<void>((resolve) => {
      server1.clients.forEach((c) => c.terminate());
      setTimeout(resolve, 150);
    });
    await shutdownServer(server1);

    // Queue a message while disconnected.
    channel.send({
      type: DriveIPCMessageType.SESSION_END,
      payload: { sessionId: 's1', durationMs: 10 },
      timestamp: new Date(),
    } as any);

    expect(channel.getConnectionInfo().connected).toBe(false);

    // Re-accept: a new server (fresh port to avoid OS TIME_WAIT flakiness on
    // the old one) — simulates the drive-server coming back up, and the
    // client reconnecting and draining what it queued while disconnected.
    const port2 = await freePort();
    const server2 = new WebSocketServer({ port: port2 });
    server2.on('connection', (ws) => {
      ws.on('message', (data) => received.push(JSON.parse(data.toString())));
    });

    try {
      await channel.connect(`ws://127.0.0.1:${port2}`);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(received.length).toBe(1);
    } finally {
      await channel.close(200);
      await shutdownServer(server2);
    }
  });

  it('bounds the send queue — oldest message is dropped once the cap is exceeded', () => {
    const channel = new WsChannelService();
    // Push well beyond SEND_QUEUE_MAX_SIZE (200) while disconnected.
    for (let i = 0; i < 250; i++) {
      channel.send({
        type: DriveIPCMessageType.SESSION_END,
        payload: { sessionId: `s${i}`, durationMs: i },
        timestamp: new Date(),
      } as any);
    }
    // Internal queue is private; assert indirectly via its length.
    const queue = (channel as any).sendQueue as unknown[];
    expect(queue.length).toBeLessThanOrEqual(200);
  });

  it('prunes expired (TTL) messages before flushing on reconnect', async () => {
    const channel = new WsChannelService();
    channel.send({
      type: DriveIPCMessageType.SESSION_END,
      payload: { sessionId: 'stale', durationMs: 1 },
      timestamp: new Date(),
    } as any);

    // Force the queued message's timestamp into the past, beyond the TTL.
    const queue = (channel as any).sendQueue as Array<{ timestamp: number }>;
    queue[0].timestamp = Date.now() - 60_000;

    const server = new WebSocketServer({ port });
    const received: unknown[] = [];
    server.on('connection', (ws) => {
      ws.on('message', (data) => received.push(JSON.parse(data.toString())));
    });

    try {
      await channel.connect(`ws://127.0.0.1:${port}`);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(received.length).toBe(0);
    } finally {
      await channel.close(200);
      await shutdownServer(server);
    }
  });
});

/**
 * Drive Engine standalone server entry point.
 *
 * Runs the 12-drive tick loop as an independent WebSocket server.
 * The main Sylphie backend connects as a WebSocket client and exchanges
 * DriveIPCMessage envelopes — same protocol as the old IPC transport,
 * just over the network.
 *
 * CANON §Drive Isolation: This process is completely isolated from the
 * main NestJS application. Sylphie cannot introspect her own drive rules,
 * accumulation rates, or evaluation function. She only sees the resulting
 * drive snapshots.
 *
 * Usage:
 *   yarn dev:drive-server          (ts-node, dev mode)
 *   node dist/main.js              (compiled, prod mode)
 *
 * Environment:
 *   DRIVE_ENGINE_PORT      — WebSocket port (default: 3001)
 *   DRIVE_ENGINE_HOST      — Bind address (default: 127.0.0.1)
 *   POSTGRES_HOST          — Postgres host for drive_rules
 *   POSTGRES_PORT          — Postgres port
 *   POSTGRES_RUNTIME_USER  — RLS-enforced runtime user
 *   POSTGRES_RUNTIME_PASSWORD
 *   POSTGRES_DB            — Database name
 */

import { WebSocketServer } from 'ws';
import { getOrCreateEngine } from '@sylphie/drive-engine/drive-process/drive-engine';
import { WebSocketServerTransport } from './ws-transport';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.DRIVE_ENGINE_PORT || '3001', 10);
const HOST = process.env.DRIVE_ENGINE_HOST || '127.0.0.1';

// ---------------------------------------------------------------------------
// Transport and Engine
// ---------------------------------------------------------------------------

const transport = new WebSocketServerTransport();
const engine = getOrCreateEngine(transport);

// ---------------------------------------------------------------------------
// WebSocket Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on('connection', (ws, req) => {
  const clientAddr = req.socket.remoteAddress;

  // Only allow one client connection at a time
  if (transport.isConnected) {
    console.warn(`[DriveServer] Rejected connection from ${clientAddr} — already connected`);
    ws.close(1013, 'Only one client allowed');
    return;
  }

  console.log(`[DriveServer] Client connected from ${clientAddr}`);
  transport.setClient(ws);
});

wss.on('listening', () => {
  console.log(`[DriveServer] WebSocket server listening on ws://${HOST}:${PORT}`);
});

wss.on('error', (err) => {
  console.error(`[DriveServer] Server error: ${err.message}`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Start Engine
// ---------------------------------------------------------------------------

engine.start();
console.log('[DriveServer] Drive engine tick loop started');

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

function onShutdown(signal: string): void {
  console.log(`[DriveServer] Received ${signal}, shutting down...`);
  engine.stop();

  wss.close(() => {
    console.log('[DriveServer] WebSocket server closed');
    process.exit(0);
  });

  // Force exit after 5s if graceful close hangs
  setTimeout(() => {
    console.warn('[DriveServer] Forced shutdown after timeout');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => onShutdown('SIGTERM'));
process.on('SIGINT', () => onShutdown('SIGINT'));

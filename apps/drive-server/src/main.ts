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
import { Pool } from 'pg';
import { getOrCreateEngine } from '@sylphie/drive-engine/drive-process/drive-engine';
import { TimescaleWriter } from '@sylphie/drive-engine/drive-process/timescale-writer';
import { verboseFor } from '@sylphie/shared';
import { WebSocketServerTransport } from './ws-transport';

const vlog = verboseFor('DriveEngine');

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
// TimescaleDB persistence for drive state
// ---------------------------------------------------------------------------

const tsWriter = new TimescaleWriter({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'sylphie',
  user: process.env.POSTGRES_RUNTIME_USER || process.env.POSTGRES_USER || 'sylphie',
  password: process.env.POSTGRES_RUNTIME_PASSWORD || process.env.POSTGRES_PASSWORD || 'sylphie',
  maxConnections: 2,
});

// ---------------------------------------------------------------------------
// Startup — restore state, then wait for first client before ticking
// ---------------------------------------------------------------------------

let engineStarted = false;

async function initPersistence(): Promise<void> {
  try {
    await tsWriter.init();
    await tsWriter.ensureCheckpointTable();
    engine.setTimescaleWriter(tsWriter);

    const restored = await engine.restoreState();
    if (restored) {
      console.log('[DriveServer] Drive state restored from checkpoint');
    } else {
      console.log('[DriveServer] No checkpoint found — cold start');
    }
  } catch (err) {
    console.warn(`[DriveServer] TimescaleDB init failed — cold start without persistence: ${err}`);
  }

  // Initialize rule engine with its own PostgreSQL pool.
  // Uses the same database as TimescaleDB but a separate pool for isolation.
  try {
    const rulePool = new Pool({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'sylphie',
      user: process.env.POSTGRES_RUNTIME_USER || process.env.POSTGRES_USER || 'sylphie',
      password: process.env.POSTGRES_RUNTIME_PASSWORD || process.env.POSTGRES_PASSWORD || 'sylphie',
      max: 2,
    });
    await engine.initializeRuleEngine(rulePool);
    console.log('[DriveServer] Rule engine initialized with PostgreSQL');
  } catch (err) {
    console.warn(`[DriveServer] Rule engine init failed — using default affects only: ${err}`);
  }
}

function startEngineIfNeeded(): void {
  if (engineStarted) return;
  engineStarted = true;
  engine.start();
  console.log('[DriveServer] Drive engine tick loop started (client connected)');
  vlog('drive engine tick loop started (synced with client)', {});
}

// Initialize persistence, then open the WS server
initPersistence().then(() => {
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
    vlog('WS client connected', { clientAddr });
    transport.setClient(ws);

    // Start the tick loop on first client connection — cogs in a wheel.
    // The drive engine and backend start ticking in sync.
    startEngineIfNeeded();
  });

  wss.on('listening', () => {
    console.log(`[DriveServer] WebSocket server listening on ws://${HOST}:${PORT}`);
    vlog('drive server ready, waiting for client', { host: HOST, port: PORT });
  });

  wss.on('error', (err) => {
    console.error(`[DriveServer] Server error: ${err.message}`);
    process.exit(1);
  });

  // -------------------------------------------------------------------------
  // Graceful Shutdown
  // -------------------------------------------------------------------------

  async function onShutdown(signal: string): Promise<void> {
    console.log(`[DriveServer] Received ${signal}, shutting down...`);

    // Save drive state before stopping — this is the critical persistence step
    await engine.stop();
    console.log('[DriveServer] Drive state saved');

    await tsWriter.close();

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

  process.on('SIGTERM', () => { onShutdown('SIGTERM').catch(console.error); });
  process.on('SIGINT', () => { onShutdown('SIGINT').catch(console.error); });
}).catch((err) => {
  console.error(`[DriveServer] Fatal startup error: ${err}`);
  process.exit(1);
});

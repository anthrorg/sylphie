# app-drive-server — Architecture Reference

> Living document. Last updated: 2026-06-13. Auto-generated from full-file reads (one agent per file); verify before trusting any single line.

**2 files** mapped.

## File-by-file

### `apps/drive-server/src/`

#### main.ts
*service* — Drive engine standalone WebSocket server entry point for isolated 12-drive tick loop execution.

Main entry point for the drive-server process, which implements CANON §Drive Isolation by running the 12-drive tick loop in a separate process from the main NestJS backend. Sets up a WebSocket server (default 3001) that accepts a single client connection (the main Sylphie backend). On startup, initializes TimescaleDB persistence via TimescaleWriter and a PostgreSQL rule-engine pool (both with maxConnections:2, RLS-enforced via POSTGRES_RUNTIME_USER). Restores drive state from checkpoint if available. Engine tick loop starts only after first client connects (lazy start via startEngineIfNeeded). On SIGTERM/SIGINT, performs graceful shutdown: stops engine (saves drive state), closes TimescaleWriter, closes WebSocket server, with 5s timeout to force-exit if cleanup hangs. All configuration loaded from env vars (DRIVE_ENGINE_PORT, DRIVE_ENGINE_HOST, POSTGRES_* credentials). Uses WebSocketServerTransport to wrap the ws.WebSocket API.

- **Key constants:** `PORT=process.env.DRIVE_ENGINE_PORT\|\|3001`, `HOST=process.env.DRIVE_ENGINE_HOST\|\|127.0.0.1`, `maxConnections=2 (TimescaleWriter)`, `maxConnections=2 (rule engine Pool)`, `POSTGRES_HOST=localhost`, `POSTGRES_PORT=5432`, `POSTGRES_DB=sylphie`, `POSTGRES_RUNTIME_USER/POSTGRES_USER=sylphie`, `POSTGRES_RUNTIME_PASSWORD/POSTGRES_PASSWORD=sylphie`, `close timeout=5000ms`
- **Deps:** `@sylphie/drive-engine/drive-process/drive-engine (getOrCreateEngine)`, `@sylphie/drive-engine/drive-process/timescale-writer (TimescaleWriter)`, `@sylphie/shared (verboseFor)`, `./ws-transport (WebSocketServerTransport)`, `ws (WebSocketServer)`, `pg (Pool)`
- **Gotchas:** Rejects multiple client connections with code 1013 (only one client allowed at a time); graceful shutdown has 5s timeout to force-exit if cleanup stalls; rule-engine pool init failure falls back to default affects only (non-fatal); TimescaleDB init failure allows cold start without persistence (non-fatal); engine.restoreState() may fail but server continues (logs warning, proceeds); connection-string credentials loaded from env with hardcoded fallbacks (localhost/sylphie).

#### ws-transport.ts
*service* — WebSocket server-side transport for DriveEngine IPC between drive-server and main NestJS app.

Implements IMessageTransport interface. WebSocketServerTransport class manages a single WebSocket client connection (the main app). Core methods: setClient() attaches a WS client and wires up message/close/error handlers; onMessage() registers the inbound handler; send() transmits DriveIPCMessage envelopes to the client if connected (readyState===1). All inbound messages validated via safeValidateMessage() before dispatch; invalid/malformed messages logged and dropped. Telemetry: messageCount incremented per inbound, logged every 50 messages. CANON §Drive Isolation: sole communication path between drive engine and main app; main app has no direct access to drive rules, accumulation rates, or internal state.

- **Exports:** `WebSocketServerTransport`
- **Key constants:** `readyState 1 (WebSocket.OPEN)`, `telemetry log interval 50 messages`
- **Deps:** `ws`, `@sylphie/shared (DriveIPCMessage, verboseFor)`, `@sylphie/drive-engine/drive-process/message-transport (IMessageTransport)`, `@sylphie/drive-engine/ipc-channel/ipc-message-validator (safeValidateMessage)`

## Risks / stubs / TODOs

- `apps/drive-server/src/main.ts` — Rejects multiple client connections with code 1013 (only one client allowed at a time); graceful shutdown has 5s timeout to force-exit if cleanup stalls; rule-engine pool init failure falls back to default affects only (non-fatal); TimescaleDB init failure allows cold start without persistence (non-fatal); engine.restoreState() may fail but server continues (logs warning, proceeds); connection-string credentials loaded from env with hardcoded fallbacks (localhost/sylphie).

## Change log
- 2026-06-13 — Initial auto-generated map (2 files read in full).

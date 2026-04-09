/**
 * Drive Engine child process entry point.
 *
 * This is the standalone executable that gets forked by child_process.fork()
 * from the main NestJS process. It runs its own event loop and communicates
 * with the parent process via IPC.
 *
 * Responsibilities:
 *   - Instantiate and start the DriveEngine tick loop
 *   - DriveEngine handles IPC message routing internally (setupIPCHandlers)
 *   - Graceful shutdown on SIGTERM/SIGINT
 *
 * CANON §Drive Isolation: This process is completely isolated from the main
 * NestJS application. It is NOT a NestJS module. It is a standalone Node.js
 * process with its own message loop.
 */

import { verboseFor } from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');

import { getOrCreateEngine } from './drive-engine';
import { IpcTransport } from './message-transport';

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

vlog('child process starting', { pid: process.pid, nodeVersion: process.version });

console.log(
  `[DriveEngine] Child process started (PID: ${process.pid}, node ${process.version})`,
);

const transport = new IpcTransport();
vlog('IPC transport created');

const engine = getOrCreateEngine(transport);
vlog('engine instance created');

engine.start();

vlog('tick loop started');
console.log('[DriveEngine] Tick loop started');

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

function onShutdown(signal: string): void {
  vlog('shutdown signal received', { signal });
  console.log(`[DriveEngine] Received ${signal}, shutting down gracefully`);
  engine.stop();
  process.exit(0);
}

process.on('SIGTERM', () => onShutdown('SIGTERM'));
process.on('SIGINT', () => onShutdown('SIGINT'));

process.on('exit', () => {
  console.log('[DriveEngine] Child process exiting');
});

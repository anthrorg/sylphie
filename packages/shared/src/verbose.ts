/**
 * Lightweight verbose logging utility for tracing system behavior,
 * decision-making, and performance across all Sylphie subsystems.
 *
 * Usage:
 *   import { verbose } from '@sylphie/shared';
 *   verbose('DriveEngine', 'curiosity score computed', { score: 0.73, trigger: 'novel-entity' });
 *
 * Controlled by env:
 *   VERBOSE=1                  — enable all subsystems
 *   VERBOSE=DriveEngine,Cortex — enable only listed subsystems (comma-separated)
 *   VERBOSE= (empty/unset)    — disabled (default)
 *
 * Output goes to stderr so it never contaminates stdout pipes.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Configuration ──────────────────────────────────────────────

let enabled = false;
let allowedSubsystems: Set<string> | 'all' = new Set();
let logStream: fs.WriteStream | null = null;

function configure() {
  const raw = (process.env.VERBOSE ?? '').trim();
  if (!raw || raw === '0' || raw === 'false') {
    enabled = false;
    return;
  }
  enabled = true;
  if (raw === '1' || raw === 'true' || raw === '*') {
    allowedSubsystems = 'all';
  } else {
    allowedSubsystems = new Set(raw.split(',').map((s) => s.trim()));
  }

  // Open a persistent write stream for the verbose log file
  try {
    const logDir = path.resolve(process.cwd(), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logStream = fs.createWriteStream(path.join(logDir, 'verbose.log'), {
      flags: 'a',
    });
  } catch {
    // If we can't open the file, verbose still works to stderr
    logStream = null;
  }
}

// Run once on import; re-runs if someone calls reconfigure()
configure();

// ── Public API ─────────────────────────────────────────────────

/**
 * Log a verbose trace message.
 *
 * @param subsystem  e.g. 'DriveEngine', 'Cortex', 'Learning', 'Perception'
 * @param message    human-readable description of what happened
 * @param data       optional structured payload (objects, numbers, etc.)
 */
export function verbose(
  subsystem: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!enabled) return;
  if (allowedSubsystems !== 'all' && !allowedSubsystems.has(subsystem)) return;

  const ts = new Date().toISOString();
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  const line = `${ts} VERBOSE [${subsystem}] ${message}${dataStr}`;

  process.stderr.write(line + '\n');

  if (logStream) {
    logStream.write(line + '\n');
  }
}

/**
 * Create a scoped verbose logger for a specific subsystem.
 * Avoids repeating the subsystem name on every call.
 *
 *   const log = verboseFor('DriveEngine');
 *   log('curiosity score computed', { score: 0.73 });
 */
export function verboseFor(
  subsystem: string,
): (message: string, data?: Record<string, unknown>) => void {
  return (message, data) => verbose(subsystem, message, data);
}

/**
 * Check whether verbose logging is currently active
 * (useful for guarding expensive data serialization).
 */
export function isVerbose(subsystem?: string): boolean {
  if (!enabled) return false;
  if (!subsystem) return true;
  return allowedSubsystems === 'all' || allowedSubsystems.has(subsystem);
}

/**
 * Re-read VERBOSE env var at runtime (e.g. after dotenv loads late).
 */
export function reconfigureVerbose(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
  configure();
}

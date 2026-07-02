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
 *
 * On-disk sink: per-process (logs/verbose.<pid>.log), size-bounded via
 * VERBOSE_MAX_BYTES (default 50MB) with rotation to .1..N (VERBOSE_KEEP,
 * default 3). Stale per-pid files older than VERBOSE_PRUNE_DAYS (default
 * 7) are best-effort pruned at configure() time.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Configuration ──────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_KEEP = 3;
const DEFAULT_PRUNE_DAYS = 7;

let enabled = false;
let allowedSubsystems: Set<string> | 'all' = new Set();
let logStream: fs.WriteStream | null = null;
let logDir = '';
let logBaseName = '';
let bytesWritten = 0;
let maxBytes = DEFAULT_MAX_BYTES;
let keepSegments = DEFAULT_KEEP;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function openStream(): void {
  logStream = fs.createWriteStream(path.join(logDir, logBaseName), {
    flags: 'a',
  });
  // A logging sink must never crash the host process on a filesystem
  // hiccup (e.g. the log dir disappearing out from under it).
  logStream.on('error', () => {
    logStream = null;
  });
}

function pruneStaleFiles(): void {
  try {
    const currentPid = process.pid;
    const cutoffMs = Date.now() - envInt('VERBOSE_PRUNE_DAYS', DEFAULT_PRUNE_DAYS) * 24 * 60 * 60 * 1000;
    const entries = fs.readdirSync(logDir);
    const pattern = /^verbose\.(\d+)\.log(?:\.(\d+))?$/;
    for (const entry of entries) {
      const match = pattern.exec(entry);
      if (!match) continue;
      const filePid = Number(match[1]);
      if (filePid === currentPid) continue;
      try {
        const stat = fs.statSync(path.join(logDir, entry));
        if (stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(path.join(logDir, entry));
        }
      } catch {
        // best-effort; skip files we can't stat/unlink
      }
    }
  } catch {
    // best-effort; never throw into the hot path
  }
}

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

  maxBytes = envInt('VERBOSE_MAX_BYTES', DEFAULT_MAX_BYTES);
  keepSegments = envInt('VERBOSE_KEEP', DEFAULT_KEEP);

  // Open a persistent write stream for the per-process verbose log file
  try {
    logDir = path.resolve(process.cwd(), 'logs');
    logBaseName = `verbose.${process.pid}.log`;
    fs.mkdirSync(logDir, { recursive: true });

    try {
      bytesWritten = fs.statSync(path.join(logDir, logBaseName)).size;
    } catch {
      bytesWritten = 0;
    }

    pruneStaleFiles();

    openStream();
  } catch {
    // If we can't open the file, verbose still works to stderr
    logStream = null;
  }
}

// Run once on import; re-runs if someone calls reconfigure()
configure();

// ── Rotation ───────────────────────────────────────────────────

function rotate(): void {
  const oldStream = logStream;
  logStream = null;
  if (oldStream) {
    oldStream.end();
  }

  // Synchronously shift rotated segments down the chain before
  // reopening a stream, so the new stream's async open can't race
  // the renames.
  try {
    const overflowPath = path.join(logDir, `${logBaseName}.${keepSegments}`);
    if (fs.existsSync(overflowPath)) {
      fs.unlinkSync(overflowPath);
    }
    for (let n = keepSegments - 1; n >= 1; n--) {
      const src = path.join(logDir, `${logBaseName}.${n}`);
      const dest = path.join(logDir, `${logBaseName}.${n + 1}`);
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
      }
    }
    const current = path.join(logDir, logBaseName);
    if (fs.existsSync(current)) {
      fs.renameSync(current, path.join(logDir, `${logBaseName}.1`));
    }
  } catch {
    // best-effort; fall through and reopen regardless
  }

  bytesWritten = 0;
  try {
    openStream();
  } catch {
    logStream = null;
  }
}

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
    const lineBytes = Buffer.byteLength(line + '\n');
    if (bytesWritten + lineBytes > maxBytes) {
      rotate();
    }
    if (logStream) {
      logStream.write(line + '\n');
      bytesWritten += lineBytes;
    }
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

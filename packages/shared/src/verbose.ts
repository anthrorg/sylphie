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
// No persistent file handle: every write is a synchronous fs.appendFileSync,
// so rotate()'s rename can never race a pending async flush.
let sinkActive = false;
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

      // Skip a still-running sibling's file even if stale by mtime.
      // process.kill(pid, 0) sends no signal; throws ESRCH only if dead.
      try {
        process.kill(filePid, 0);
        continue; // alive — skip
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') continue; // not confirmed dead — skip
      }

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

  // Set up the per-process verbose log file. No file handle is kept open —
  // each write is a synchronous fs.appendFileSync (see verbose() below).
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

    sinkActive = true;
  } catch {
    // If we can't set up the log dir, verbose still works to stderr
    sinkActive = false;
  }
}

// Run once on import; re-runs if someone calls reconfigure()
configure();

// ── Rotation ───────────────────────────────────────────────────

/** Shift current -> .1 -> .2 ... -> N, pruning past the keep count. */
function rotate(): void {
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
    // best-effort; the next append recreates the current file regardless
  }

  bytesWritten = 0;
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

  if (!sinkActive) return;

  const lineBytes = Buffer.byteLength(line + '\n');
  if (bytesWritten + lineBytes > maxBytes) {
    rotate();
  }

  try {
    fs.appendFileSync(path.join(logDir, logBaseName), line + '\n');
    bytesWritten += lineBytes;
  } catch {
    // A logging sink must never crash the host process on a filesystem
    // hiccup (e.g. the log dir disappearing out from under it). Degrade
    // to stderr-only for the rest of this process's lifetime.
    sinkActive = false;
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
  sinkActive = false;
  configure();
}

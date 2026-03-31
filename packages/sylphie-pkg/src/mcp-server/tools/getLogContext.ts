/**
 * getLogContext.ts -- Search actual log files on disk for matching entries.
 *
 * Reads log files from the sylphie logs/ directory and searches for lines
 * matching the provided filters (query text, service name, severity level,
 * and time window). Returns the last 20 matching lines with file and context.
 *
 * Log format (NestJS winston): `YYYY-MM-DD HH:mm:ss [service] level: message`
 *
 * Target response size: 500-2,000 tokens.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const LOGS_DIR = 'C:/Users/Jim/OneDrive/Desktop/Code/sylphie/logs';
const MAX_RESULTS = 20;

export interface GetLogContextInput {
  query?: string;
  service?: string;
  severity?: string;
  since?: string; // ISO date string. Defaults to 7 days ago.
}

interface LogMatch {
  filePath: string;
  lineNumber: number;
  line: string;
}

/**
 * Handle the getLogContext tool call.
 *
 * Reads log files from the logs/ directory on disk. All filters are optional
 * and additive. With no filters, returns the last 20 log lines across all files.
 *
 * @param input - Tool input with optional query, service, severity, and since filters.
 * @returns Formatted log output suitable for LLM consumption.
 */
export async function handleGetLogContext(input: GetLogContextInput): Promise<string> {
  const { query, service, severity } = input;
  const since = input.since ?? defaultSince();

  // Check logs directory exists
  if (!fs.existsSync(LOGS_DIR)) {
    return (
      `No logs directory found at ${LOGS_DIR}.\n\n` +
      `Log files would be written there by the NestJS winston logger when the ` +
      `Sylphie backend is running. Start the backend with \`npm run start:dev\` ` +
      `to generate logs.`
    );
  }

  // Collect all .log files, sorted oldest-first so we scan chronologically
  // and collect the last N matches naturally
  let logFiles: string[];
  try {
    logFiles = fs
      .readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith('.log'))
      .sort() // lexicographic sort on YYYY-MM-DD filenames = chronological
      .map((f) => path.join(LOGS_DIR, f));
  } catch (err) {
    return `Failed to read logs directory at ${LOGS_DIR}: ${String(err)}`;
  }

  if (logFiles.length === 0) {
    return (
      `Logs directory exists at ${LOGS_DIR} but contains no .log files.\n\n` +
      `Expected files named like \`combined-YYYY-MM-DD.log\` or \`error-YYYY-MM-DD.log\`.`
    );
  }

  // Build filter predicates
  const queryRe = query ? new RegExp(escapeRegex(query), 'i') : null;
  const serviceRe = service ? new RegExp(escapeRegex(service), 'i') : null;
  const severityRe = severity ? new RegExp(`\\b${escapeRegex(severity)}\\b`, 'i') : null;
  const sincePrefix = since; // YYYY-MM-DD, compare against line start

  // Scan all files, collecting matches in order
  // We keep all matches and slice the last MAX_RESULTS at the end so we
  // return the most recent lines when results exceed the limit.
  const allMatches: LogMatch[] = [];

  for (const filePath of logFiles) {
    // Skip files that are clearly older than `since` based on filename date.
    // Filename may contain a date segment like 2026-03-15 — extract it.
    const fileBasename = path.basename(filePath);
    const fileDateMatch = fileBasename.match(/(\d{4}-\d{2}-\d{2})/);
    if (fileDateMatch) {
      const fileDate = fileDateMatch[1];
      if (fileDate < sincePrefix) {
        continue;
      }
    }

    const fileMatches = await searchFile(
      filePath,
      queryRe,
      serviceRe,
      severityRe,
      sincePrefix
    );
    allMatches.push(...fileMatches);
  }

  if (allMatches.length === 0) {
    const filterDesc = buildFilterDescription(query, service, severity, since);
    const fileList = logFiles.map((f) => `  ${path.basename(f)}`).join('\n');
    return (
      `No log lines found${filterDesc ? ` matching ${filterDesc}` : ''}.\n\n` +
      `Searched ${logFiles.length} file(s) in ${LOGS_DIR}:\n${fileList}`
    );
  }

  // Take only the last MAX_RESULTS matches (most recent)
  const results = allMatches.slice(-MAX_RESULTS);

  // Format output
  const lines: string[] = [];
  const filterDesc = buildFilterDescription(query, service, severity, since);
  lines.push(`LOG CONTEXT${filterDesc ? `: ${filterDesc}` : ''}`);
  lines.push('='.repeat(60));
  lines.push(
    `${results.length} line(s) shown` +
      (allMatches.length > MAX_RESULTS
        ? ` (${allMatches.length} total matches — showing last ${MAX_RESULTS})`
        : '') +
      '\n'
  );

  let lastFile = '';
  for (const match of results) {
    const relPath = path.relative(
      'C:/Users/Jim/OneDrive/Desktop/Code/sylphie',
      match.filePath
    );
    if (match.filePath !== lastFile) {
      lines.push(`--- ${relPath} ---`);
      lastFile = match.filePath;
    }
    lines.push(`  L${match.lineNumber}: ${match.line}`);
  }

  lines.push('');
  lines.push(`Log files scanned: ${logFiles.length} file(s) in ${LOGS_DIR}`);

  return lines.join('\n');
}

/**
 * Read a single log file line by line and collect matching lines.
 *
 * @param filePath - Absolute path to the log file.
 * @param queryRe - Optional regex to match against the full line.
 * @param serviceRe - Optional regex to match against the service token.
 * @param severityRe - Optional regex to match against the severity token.
 * @param sincePrefix - YYYY-MM-DD string; lines with an earlier date are skipped.
 * @returns Array of matching LogMatch records in file order.
 */
async function searchFile(
  filePath: string,
  queryRe: RegExp | null,
  serviceRe: RegExp | null,
  severityRe: RegExp | null,
  sincePrefix: string
): Promise<LogMatch[]> {
  const matches: LogMatch[] = [];

  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  } catch {
    return matches;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;

    if (!line.trim()) continue;

    // Date filter: NestJS winston lines start with YYYY-MM-DD HH:mm:ss
    // If the line starts with a parseable date earlier than sincePrefix, skip it.
    if (line.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(line)) {
      if (line.slice(0, 10) < sincePrefix) {
        continue;
      }
    }

    // Service filter: look for [service] bracket token in the line
    if (serviceRe) {
      const serviceToken = extractServiceToken(line);
      if (!serviceToken || !serviceRe.test(serviceToken)) {
        continue;
      }
    }

    // Severity filter: look for the level word after the service bracket
    if (severityRe) {
      const sev = extractSeverity(line);
      if (!sev || !severityRe.test(sev)) {
        continue;
      }
    }

    // Query filter: search the full line
    if (queryRe && !queryRe.test(line)) {
      continue;
    }

    matches.push({ filePath, lineNumber, line });
  }

  return matches;
}

/**
 * Extract the [service] token from a NestJS winston log line.
 *
 * Format: `2026-03-22 14:01:23 [ServiceName] level: message`
 *
 * @param line - A single log line.
 * @returns The service name without brackets, or null if not found.
 */
function extractServiceToken(line: string): string | null {
  const match = line.match(/\[([^\]]+)\]/);
  return match ? match[1] : null;
}

/**
 * Extract the severity level from a NestJS winston log line.
 *
 * Format: `2026-03-22 14:01:23 [ServiceName] level: message`
 * The level appears after the closing bracket, before the colon.
 *
 * @param line - A single log line.
 * @returns The severity string (e.g. "error", "warn", "info"), or null if not found.
 */
function extractSeverity(line: string): string | null {
  // Match the word immediately after ] and before :
  const match = line.match(/\]\s+(\w+):/);
  return match ? match[1] : null;
}

function buildFilterDescription(
  query: string | undefined,
  service: string | undefined,
  severity: string | undefined,
  since: string
): string {
  const parts: string[] = [];
  if (query) parts.push(`query="${query}"`);
  if (service) parts.push(`service="${service}"`);
  if (severity) parts.push(`severity="${severity}"`);
  parts.push(`since ${since}`);
  return parts.join(', ');
}

function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

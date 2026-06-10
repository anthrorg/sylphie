/**
 * cassette.ts — HTTP cassette harness for the Provability Gate.
 *
 * The gate must answer "is it working?" deterministically. The one source of
 * nondeterminism in a Sylphie run is the outbound LLM HTTP call (Ollama at
 * OLLAMA_HOST, and DeepSeek when configured). This cassette intercepts *only*
 * that outbound boundary — every internal NestJS service still runs live. This
 * is the critical distinction from the mock-divergence incident: we mock the
 * transport to a single external dependency, never an internal seam.
 *
 * How it works:
 *   - The cassette starts a small HTTP server (Node `http`, no nock needed).
 *   - The operator points the backend's OLLAMA_HOST at this server's URL
 *     (see GATE.md). All `ollama` client traffic (/api/chat, /api/embeddings,
 *     /api/embed, /api/tags, ...) lands here.
 *
 * Modes (GATE_MODE env var):
 *   record  — proxy each request live to the real upstream, save the response
 *             keyed by sha256(method + path + model + normalizedPrompt) to
 *             cassette.json, and replay it back to the caller.
 *   replay  — (default) serve recorded responses from cassette.json.
 *             A request whose hash is NOT on the tape is a HARD FAILURE: we
 *             return 599 and record the miss. We never silently fall through
 *             to live Ollama in replay mode.
 *   lesion  — every request throws a connection-style error (the server
 *             destroys the socket). This simulates the LLM being unplugged so
 *             the gate can verify the system degrades to Type 1 reflexes.
 *
 * The cassette server is process-local to the gate runner. Because the backend
 * is a separate process, the operator must set OLLAMA_HOST to this server
 * BEFORE starting the backend (the URL is fixed and printed on start).
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Config (no hardcoded ports — env with defaults)
// ---------------------------------------------------------------------------

export type GateMode = 'record' | 'replay' | 'lesion' | 'update-baseline';

/**
 * Resolve the gate mode. Reads, in priority order:
 *   1. a `--mode=<x>` CLI flag (cross-platform; used by the package.json scripts)
 *   2. the GATE_MODE env var (POSIX-style `GATE_MODE=record yarn gate`)
 * 'update-baseline' behaves like replay for HTTP purposes.
 */
export function resolveGateMode(): GateMode {
  const flag = process.argv.find((a) => a.startsWith('--mode='));
  const raw = (flag ? flag.slice('--mode='.length) : process.env.GATE_MODE || 'replay').toLowerCase();
  if (raw === 'record' || raw === 'lesion' || raw === 'update-baseline') return raw;
  return 'replay';
}

/** Port the cassette server listens on. The backend's OLLAMA_HOST must match. */
export const CASSETTE_PORT = parseInt(process.env.GATE_CASSETTE_PORT || '11500', 10);

/** Upstream real Ollama, used only in record mode. */
const UPSTREAM = process.env.GATE_OLLAMA_UPSTREAM || 'http://localhost:11434';

/** Where the tape lives. Repo-root-relative via process.cwd(), never __dirname. */
const CASSETTE_FILE = path.resolve(process.cwd(), 'test', 'gate', 'cassette.json');

/** The URL the backend should use for OLLAMA_HOST while the gate runs. */
export const CASSETTE_URL = `http://localhost:${CASSETTE_PORT}`;

/**
 * Backend base URL. The lesion/heal control routes (POST /api/llm/lesion,
 * POST /api/llm/heal) live on the backend, so the cassette must reach it to
 * flip the LLM availability flag in addition to severing the socket.
 */
const BACKEND_PORT = process.env.APP_PORT || process.env.PORT || '3000';
const BACKEND_BASE = `http://localhost:${BACKEND_PORT}`;

// ---------------------------------------------------------------------------
// Tape format
// ---------------------------------------------------------------------------

interface TapeEntry {
  /** Human-readable hint about what produced this entry (model, purpose). */
  readonly hint: string;
  /** HTTP status code to replay. */
  readonly status: number;
  /** Response content-type. */
  readonly contentType: string;
  /** Response body, verbatim. */
  readonly body: string;
}

type Tape = Record<string, TapeEntry>;

// ---------------------------------------------------------------------------
// Request hashing
// ---------------------------------------------------------------------------

/**
 * Normalize a request body into a stable hash key. For Ollama chat/embeddings,
 * the body carries `model` plus either `messages` or `prompt`/`input`. We hash
 * model + the normalized prompt text so semantically-identical requests collide
 * (and replay) regardless of incidental ordering of options like temperature.
 *
 * Normalization collapses whitespace and lowercases, so trivial formatting
 * drift between runs does not cause a cassette miss.
 */
function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractKeyMaterial(method: string, urlPath: string, body: string): string {
  let model = '';
  let promptText = body; // fallback: hash the whole body

  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      model = typeof parsed.model === 'string' ? parsed.model : '';

      if (Array.isArray(parsed.messages)) {
        // Chat: concatenate role+content across the message array.
        promptText = parsed.messages
          .map((m: { role?: string; content?: string }) => `${m.role ?? ''}:${m.content ?? ''}`)
          .join('\n');
      } else if (typeof parsed.prompt === 'string') {
        promptText = parsed.prompt;
      } else if (typeof parsed.input === 'string') {
        promptText = parsed.input;
      } else if (Array.isArray(parsed.input)) {
        promptText = parsed.input.join('\n');
      }
    }
  } catch {
    // Non-JSON body (e.g. GET /api/tags) — hash method+path+raw body.
  }

  return `${method} ${urlPath}\n${model}\n${normalizePrompt(promptText)}`;
}

export function hashRequest(method: string, urlPath: string, body: string): string {
  return createHash('sha256').update(extractKeyMaterial(method, urlPath, body)).digest('hex');
}

// ---------------------------------------------------------------------------
// Tape persistence
// ---------------------------------------------------------------------------

function loadTape(): Tape {
  try {
    const raw = fs.readFileSync(CASSETTE_FILE, 'utf-8');
    return JSON.parse(raw) as Tape;
  } catch {
    return {};
  }
}

function saveTape(tape: Tape): void {
  fs.mkdirSync(path.dirname(CASSETTE_FILE), { recursive: true });
  fs.writeFileSync(CASSETTE_FILE, JSON.stringify(tape, null, 2), 'utf-8');
}

export function cassetteExists(): boolean {
  return fs.existsSync(CASSETTE_FILE);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Forward a captured request to the real upstream Ollama (record mode only). */
function forwardUpstream(
  method: string,
  urlPath: string,
  headers: http.IncomingHttpHeaders,
  body: string,
): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const upstream = new URL(urlPath, UPSTREAM);
    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      // Drop hop-by-hop and host headers; the upstream sets its own.
      if (['host', 'connection', 'content-length'].includes(k.toLowerCase())) continue;
      if (typeof v === 'string') fwdHeaders[k] = v;
    }
    if (body) fwdHeaders['content-length'] = Buffer.byteLength(body).toString();

    const proxyReq = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || 80,
        path: upstream.pathname + upstream.search,
        method,
        headers: fwdHeaders,
      },
      (proxyRes) => {
        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(c));
        proxyRes.on('end', () =>
          resolve({
            status: proxyRes.statusCode ?? 502,
            contentType: (proxyRes.headers['content-type'] as string) ?? 'application/json',
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    proxyReq.on('error', reject);
    // The `ollama` client posts stream:false, so a single non-streamed JSON
    // response comes back. Long generations can take a while — be patient.
    proxyReq.setTimeout(120_000, () => proxyReq.destroy(new Error('upstream timeout')));
    if (body) proxyReq.write(body);
    proxyReq.end();
  });
}

// ---------------------------------------------------------------------------
// Cassette controller
// ---------------------------------------------------------------------------

export interface CassetteStats {
  hits: number;
  misses: number;
  recorded: number;
  lesionRejections: number;
  /** Hashes that missed the tape, with their hint, for diagnostics. */
  missDetails: Array<{ hash: string; hint: string }>;
}

export class Cassette {
  private server: http.Server | null = null;
  private mode: GateMode;
  /** Live mode can be flipped to 'lesion' at runtime (post-corpus) by the gate. */
  private live: 'normal' | 'lesion';
  private tape: Tape;
  readonly stats: CassetteStats = {
    hits: 0,
    misses: 0,
    recorded: 0,
    lesionRejections: 0,
    missDetails: [],
  };

  constructor(mode: GateMode = resolveGateMode()) {
    this.mode = mode;
    // Even in lesion mode the cassette starts in 'normal' (replay): the corpus
    // phase must run with the LLM available so taught content exists and the
    // turns answer. The gate flips to 'lesion' via lesionNow() AFTER the corpus,
    // immediately before the probe set. Starting lesioned here would sever the
    // LLM during the corpus and hang every turn (the original bug this fixes).
    this.live = 'normal';
    this.tape = loadTape();
  }

  /**
   * Flip the cassette into lesion mode at runtime AND tell the backend the LLM
   * is unavailable. The gate uses this to "unplug" the LLM AFTER the corpus has
   * run, so taught content already exists.
   *
   * Two-part lesion (defense in depth):
   *   1. Cassette socket sever — any LLM call that DOES go out gets ECONNRESET.
   *   2. POST /api/llm/lesion — sets isAvailable()=false so deliberation takes
   *      its INTENDED no-LLM SHRUG path instead of throwing mid-call. Part (2)
   *      is what makes degradation graceful; part (1) alone produces a crash.
   *
   * The backend call is best-effort-but-reported: if it fails, we log loudly so
   * a gate run can't silently fall back to the socket-only (crash) behavior and
   * score a false pass.
   */
  async lesionNow(): Promise<void> {
    this.live = 'lesion';
    await this.setBackendLesion(true);
  }

  /**
   * Restore normal replay/record behavior AND heal the backend LLM
   * (POST /api/llm/heal), leaving the running stack in a clean state.
   */
  async healNow(): Promise<void> {
    // Restore replay regardless of mode — healing means the LLM is back, so the
    // cassette must serve recorded responses again, not keep severing the socket.
    this.live = 'normal';
    await this.setBackendLesion(false);
  }

  /** Toggle the backend LLM availability flag via its control route. */
  private async setBackendLesion(lesion: boolean): Promise<void> {
    const route = lesion ? '/api/llm/lesion' : '/api/llm/heal';
    try {
      const res = await fetch(`${BACKEND_BASE}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        console.error(
          `  [cassette] WARNING: ${route} returned HTTP ${res.status}. ` +
            `Backend LLM availability flag may NOT be set — the lesion would then ` +
            `be socket-only, which CRASHES instead of degrading. Gate scoring may be unsound.`,
        );
        return;
      }
      const body = (await res.json().catch(() => null)) as { available?: boolean } | null;
      console.log(
        `  [cassette] ${route} OK — backend LLM available=${body?.available ?? '?'}.`,
      );
    } catch (err) {
      console.error(
        `  [cassette] WARNING: failed to POST ${route} (${err instanceof Error ? err.message : err}). ` +
          `Backend LLM flag NOT toggled — lesion is socket-only and degradation will be a CRASH, ` +
          `not a graceful SHRUG. Treat any green Lesion scorecard with suspicion.`,
      );
    }
  }

  isLesioned(): boolean {
    return this.live === 'lesion';
  }

  start(): Promise<void> {
    // In replay-style modes, a missing tape is a hard, loud failure.
    if ((this.mode === 'replay' || this.mode === 'update-baseline') && !cassetteExists()) {
      throw new Error(
        `Cassette tape not found at ${CASSETTE_FILE}.\n` +
          `Replay mode requires a recorded tape. Record one first:\n` +
          `  yarn gate:record   (with the system + real Ollama running)`,
      );
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          // Surface unexpected handler errors as a 500 rather than hanging.
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        });
      });
      this.server.on('error', reject);
      this.server.listen(CASSETTE_PORT, () => resolve());
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const urlPath = req.url ?? '/';
    const body = await readBody(req);

    // Lesion: simulate the LLM being unreachable by killing the socket.
    if (this.live === 'lesion') {
      this.stats.lesionRejections++;
      req.socket.destroy(); // ECONNRESET on the client side — like Ollama being down.
      return;
    }

    const hash = hashRequest(method, urlPath, body);
    const hint = this.makeHint(method, urlPath, body);

    if (this.mode === 'record') {
      // Proxy live, save, and replay the captured response.
      try {
        const upstream = await forwardUpstream(method, urlPath, req.headers, body);
        this.tape[hash] = {
          hint,
          status: upstream.status,
          contentType: upstream.contentType,
          body: upstream.body,
        };
        saveTape(this.tape);
        this.stats.recorded++;
        res.writeHead(upstream.status, { 'content-type': upstream.contentType });
        res.end(upstream.body);
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `record-mode upstream failed: ${String(err)}` }));
      }
      return;
    }

    // Replay / update-baseline: serve from tape, miss = hard fail.
    const entry = this.tape[hash];
    if (!entry) {
      this.stats.misses++;
      this.stats.missDetails.push({ hash, hint });
      // 599 is a non-standard "tape miss" signal. The ollama client surfaces it
      // as a non-2xx, which the LLM service treats as a failure (correct: an
      // un-recorded request must not silently pass through to live Ollama).
      res.writeHead(599, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'CASSETTE_MISS',
          message: `No recorded response for this request. Re-record with yarn gate:record.`,
          hint,
          hash,
        }),
      );
      return;
    }

    this.stats.hits++;
    res.writeHead(entry.status, { 'content-type': entry.contentType });
    res.end(entry.body);
  }

  /** Build a short human hint (model + truncated prompt) for diagnostics. */
  private makeHint(method: string, urlPath: string, body: string): string {
    try {
      const parsed = JSON.parse(body);
      const model = parsed?.model ?? '?';
      let text = '';
      if (Array.isArray(parsed?.messages)) {
        const last = parsed.messages[parsed.messages.length - 1];
        text = String(last?.content ?? '');
      } else if (typeof parsed?.prompt === 'string') {
        text = parsed.prompt;
      } else if (typeof parsed?.input === 'string') {
        text = parsed.input;
      }
      const snippet = text.replace(/\s+/g, ' ').slice(0, 80);
      return `${method} ${urlPath} model=${model} "${snippet}"`;
    } catch {
      return `${method} ${urlPath}`;
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const srv = this.server;
      if (!srv) return resolve();
      this.server = null;
      // Drop keep-alive sockets FIRST, then close. Closing without this leaves
      // idle keep-alive connections holding the listener open, which both stalls
      // process exit and (if another server rebinds the port in-process) yields
      // connection resets on the next listener. Order matters here.
      srv.closeAllConnections?.();
      srv.close(() => resolve());
    });
  }
}

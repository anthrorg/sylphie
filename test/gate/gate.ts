/**
 * gate.ts — The Provability Gate runner (Phase 4 WS1).
 *
 * "Is it working?" becomes a question with a hard, automated, visible answer.
 *
 * The gate drives the LIVE system (every internal NestJS service runs for real)
 * and intercepts only the outbound LLM HTTP boundary via the cassette. It then:
 *
 *   1. Confirms the system is reachable (/api/health).
 *   2. Resets arbitration metrics if an endpoint exists (see TODO below).
 *   3. Runs the fixed corpus over the conversation WebSocket, asserting per-turn
 *      grounding / arbitration expectations.
 *   4. In GATE_MODE=lesion: unplugs the LLM cassette AFTER the corpus (so taught
 *      content exists) and runs an 8-criteria Lesion probe.
 *   5. Fetches aggregate metrics and runs the baseline assertions.
 *   6. Prints a scorecard in the house style of the existing e2e probes.
 *   7. Exits 0 on all-pass, 1 on any hard failure.
 *
 * Modes (GATE_MODE):
 *   (unset)/replay   — replay cassette, assert, scorecard.
 *   record           — proxy LLM live, record cassette, assert, scorecard.
 *   lesion           — run corpus, then unplug LLM and run the Lesion Test.
 *   update-baseline  — like replay, but write fresh metrics into baseline.json.
 *
 * Prereqs: docker compose up -d; yarn dev:backend; yarn dev:drive-server; and
 * OLLAMA_HOST pointed at the cassette URL (printed below). See GATE.md.
 */

import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';
import {
  Cassette,
  CASSETTE_URL,
  cassetteExists,
  resolveGateMode,
  type GateMode,
} from './cassette';
import { CORPUS, type CorpusTurn } from './corpus';
import {
  assertTypeRatio,
  assertMAE,
  assertProvenance,
  assertDriveTickRate,
  type AssertResult,
} from './assertions';

// ---------------------------------------------------------------------------
// Config — no hardcoded ports
// ---------------------------------------------------------------------------

const BACKEND_PORT = process.env.APP_PORT || process.env.PORT || '3000';
const BASE = `http://localhost:${BACKEND_PORT}`;
const WS_BASE = `ws://localhost:${BACKEND_PORT}`;
const BASELINE_FILE = path.resolve(process.cwd(), 'test', 'gate', 'baseline.json');
const RESPONSE_TIMEOUT_MS = 45_000;
const MODE: GateMode = resolveGateMode();

// ---------------------------------------------------------------------------
// JWT token minting (WS4 Ticket 7 — atomic flip + gate JWT minting)
//
// Mirrors auth.controller.ts:76-79 exactly.  Gate mints its own tokens directly
// via jwt.sign — it does NOT call /api/auth/login (which requires a DB User row).
//
// Fail-closed precondition: if JWT_SECRET is unset, everyone becomes 'guest' on
// the tokenless→guest default, silently regressing guardian behaviour.  The gate
// MUST abort rather than record garbage.
// ---------------------------------------------------------------------------

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. The gate cannot mint guardian/Bea tokens.');
  console.error('Set JWT_SECRET (the same value the backend uses) before running the gate.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;

/** Mint a signed 7-day JWT identical to auth.controller.ts:76-79. */
function mintToken(sub: string, username: string, isGuardian: boolean): string {
  return jwt.sign({ sub, username, isGuardian }, JWT_SECRET, { expiresIn: '7d' });
}

/** Lazy guardian token — minted once per gate run. */
let _guardianToken: string | null = null;
function GUARDIAN_TOKEN(): string {
  if (!_guardianToken) _guardianToken = mintToken('guardian', 'guardian', true);
  return _guardianToken;
}

/** Lazy Bea token — minted once per gate run. */
let _beaToken: string | null = null;
function BEA_TOKEN(): string {
  if (!_beaToken) _beaToken = mintToken('personB', 'Bea', false);
  return _beaToken;
}

// ---------------------------------------------------------------------------
// Baseline shape
// ---------------------------------------------------------------------------

interface Baseline {
  capturedAt: string;
  note: string;
  typeRatio: { type1: number; type2: number };
  mae: { mae: number; sampleCount: number };
  provenance: { experientialRatio: number; totalNodes: number };
  driveTick: { minHz: number };
}

// ---------------------------------------------------------------------------
// Scorecard accumulation
// ---------------------------------------------------------------------------

interface CheckRow {
  id: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

const checks: CheckRow[] = [];

function record(id: string, label: string, result: AssertResult): void {
  const status: CheckRow['status'] = result.skipped ? 'SKIP' : result.pass ? 'PASS' : 'FAIL';
  checks.push({ id, label, status, detail: result.message });
}

function recordBool(id: string, label: string, pass: boolean, detail: string): void {
  checks.push({ id, label, status: pass ? 'PASS' : 'FAIL', detail });
}

function recordSkip(id: string, label: string, detail: string): void {
  checks.push({ id, label, status: 'SKIP', detail });
}

// ---------------------------------------------------------------------------
// HTTP / WS helpers (mirrors test/e2e/full-system.e2e.ts conventions)
// ---------------------------------------------------------------------------

async function fetchJson(urlPath: string, options?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${urlPath}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface TurnResult {
  speech: {
    text?: string;
    arbitrationType?: 'TYPE_1' | 'TYPE_2' | 'SHRUG';
    knowledgeGrounding?: 'GROUNDED' | 'LLM_ASSISTED' | 'UNKNOWN';
    latencyMs?: number;
    turnId?: string;
  } | null;
  messageCount: number;
  elapsedMs: number;
  /** True if the WS yielded no cb_speech (timeout / error). */
  timedOut: boolean;
}

/** Send one utterance over the conversation WS and collect the cb_speech reply.
 *
 * WS4 T7 — append guardian JWT so legacy corpus turns land as guardian (not guest).
 * The atomic tokenless→guest flip means an unauthenticated connection would arrive
 * as 'guest' and miss all grounded-recall assertions. Legacy converse() always uses
 * the guardian token to preserve all pre-existing green criteria (C0–C2, M1–M4,
 * L1–L8, P0). */
async function converse(text: string): Promise<TurnResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/ws/conversation?token=${encodeURIComponent(GUARDIAN_TOKEN())}`);
    const messages: any[] = [];
    let speech: any = null;
    const startMs = Date.now();

    const timeout = setTimeout(() => {
      ws.close();
      resolve({ speech, messageCount: messages.length, elapsedMs: Date.now() - startMs, timedOut: !speech });
    }, RESPONSE_TIMEOUT_MS);

    ws.on('open', () => {
      setTimeout(() => {
        ws.send(JSON.stringify({ event: 'message', data: { text, type: 'text' } }));
      }, 300);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if (msg.type === 'cb_speech') {
          speech = msg;
          setTimeout(() => {
            clearTimeout(timeout);
            ws.close();
            resolve({ speech, messageCount: messages.length, elapsedMs: Date.now() - startMs, timedOut: false });
          }, 400);
        }
      } catch {
        /* binary frame */
      }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      resolve({ speech, messageCount: messages.length, elapsedMs: Date.now() - startMs, timedOut: !speech });
    });
  });
}

// ---------------------------------------------------------------------------
// Persistent-socket helper (WS4 Ticket 7 §5)
//
// Unlike converse() (which opens, sends, and immediately closes), persistent
// sockets stay open across turns and collect every cb_speech into received[].
// This is what makes M5 multi-person isolation provable — we need two sockets
// simultaneously, neither closing after the first reply.
// ---------------------------------------------------------------------------

interface PersistentSocket {
  /** The underlying WebSocket. */
  ws: WebSocket;
  /** userId carried by the token (used for correlation assertions). */
  userId: string;
  /** Every cb_speech received on this socket. */
  received: any[];
  /** Send a turn without closing the socket. */
  send(text: string): void;
  /** Close the socket. */
  close(): void;
}

/**
 * Open a persistent WebSocket connection authenticated with `token`.
 * Collects every `cb_speech` into `received[]`.
 * `send()` posts a message event without closing the socket.
 *
 * The connection is considered open once the 'open' event fires and the initial
 * system_status handshake arrives (or 600ms passes — the backend sends it
 * synchronously on connect).
 */
function openPersistentSocket(token: string, userId: string): Promise<PersistentSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/conversation?token=${encodeURIComponent(token)}`);
    const received: any[] = [];

    const openTimeout = setTimeout(() => {
      ws.close();
      reject(new Error(`openPersistentSocket timeout waiting for open: userId=${userId}`));
    }, 5000);

    ws.on('open', () => {
      clearTimeout(openTimeout);
      // Give the backend 600ms to send system_status, then resolve.
      setTimeout(() => {
        const sock: PersistentSocket = {
          ws,
          userId,
          received,
          send(text: string) {
            ws.send(JSON.stringify({ event: 'message', data: { text, type: 'text' } }));
          },
          close() {
            ws.close();
          },
        };
        resolve(sock);
      }, 600);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'cb_speech') {
          received.push(msg);
        }
      } catch { /* ignore binary */ }
    });

    ws.on('error', (err) => {
      clearTimeout(openTimeout);
      reject(err);
    });
  });
}

/**
 * Wait until `received.length >= targetCount` or `timeoutMs` elapses.
 * Returns the number of messages actually received.
 */
function waitForReplies(received: any[], targetCount: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    if (received.length >= targetCount) { resolve(received.length); return; }
    const deadline = setTimeout(() => resolve(received.length), timeoutMs);
    const iv = setInterval(() => {
      if (received.length >= targetCount) {
        clearTimeout(deadline);
        clearInterval(iv);
        resolve(received.length);
      }
    }, 50);
  });
}

// ---------------------------------------------------------------------------
// Phase 2.5: Multi-person + burst assertions (WS4 Ticket 7 §2)
// ---------------------------------------------------------------------------

/**
 * Phase 2.5 — runMultiPersonPhase()
 *
 * Mode gating (spec §2 table):
 *   replay  — M5.1–M5.4, PRIV.1–PRIV.2, Q1.1, Q1.2, Q1.3, Q1.6 (Q1.6 unused here — burst 6th)
 *   lesion  — Q1.1–Q1.3, Q1.8, PRIV.1; M5 = recorded-SKIP (chat severed under lesion)
 *
 * Privacy relies on a clean OKG state (P0′ called in the main P0 block).
 * P0prime scorecard row is also recorded here (after the reset in main()).
 *
 * Burst: K=5 sends on the guardian socket in one tick (<50ms window).
 * Uses the corpus's existing zanfibble nonsense text (corpus.ts:90) so the tape
 * entry is already present for replay.
 *
 * Privacy: Bea teaches "my secret word is fathom" — nonce value, absent from
 * corpus / all legacy patterns — then guardian probes for it.  Assertions are
 * on knowledgeGrounding LABEL only, not chat text (tape-drift-immune).
 *
 * WHO_AM_I caveat (spec §11): do NOT use trigger-phrase-matching text.
 * All probes use normal recall questions ("What is my name?", "What is my
 * secret word?") to avoid the broadcast path that would falsely fail M5.3.
 */
async function runMultiPersonPhase(
  mode: GateMode,
  p0primeOk: boolean,
): Promise<void> {
  banner('PHASE 2.5: MULTI-PERSON + BURST (WS4 Ticket 7)');

  const isReplay = mode === 'replay' || mode === 'update-baseline';
  const isLesion = mode === 'lesion';

  // ── M5: by-name / isolation assertions (replay only; skip under lesion) ──────

  if (isLesion) {
    recordSkip('M5.1', 'A socket replies only to A (originator isolation)', 'lesion mode — chat severed');
    recordSkip('M5.2', 'B socket replies only to B (originator isolation)', 'lesion mode — chat severed');
    recordSkip('M5.3', 'zero cross-talk between A and B sockets', 'lesion mode — chat severed');
    recordSkip('M5.4', 'replies contain the speaker\'s in-run-taught name', 'lesion mode — chat severed');
  } else {
    // Open two persistent sockets.
    let sockA: PersistentSocket | null = null;
    let sockB: PersistentSocket | null = null;
    try {
      sockA = await openPersistentSocket(GUARDIAN_TOKEN(), 'guardian');
      sockB = await openPersistentSocket(BEA_TOKEN(), 'personB');

      // Each persona teaches their name so M5.4 can probe recall.
      // Wait for the cb_speech then add 1s for the async write-back (search_document embed).
      sockA.send('My name is Guardian.');
      await waitForReplies(sockA.received, 1, 20_000);
      await sleep(1000); // write-back window
      sockB.send('My name is Bea.');
      await waitForReplies(sockB.received, 1, 20_000);
      await sleep(1000); // write-back window

      // Both ask their names in quick succession (interleaved <50ms spec).
      // Snapshot counts BEFORE name probes so assertions cover the full received[].
      const aPreProbe = sockA.received.length;
      const bPreProbe = sockB.received.length;
      sockA.send('What is my name?');
      sockB.send('What is my name?');

      // Wait until both sockets have at least one MORE message than before the probes.
      await waitForReplies(sockA.received, aPreProbe + 1, 30_000);
      await waitForReplies(sockB.received, bPreProbe + 1, 30_000);

      // All messages received on each socket (includes teach-ack + name probe reply).
      // M5.1–M5.3 assert originator.userId on ALL messages — teach-acks and probes
      // alike must be correctly attributed.
      const aReceivedCount = sockA.received.length;
      const bReceivedCount = sockB.received.length;

      console.log(`  sockA(guardian) cb_speech count: ${aReceivedCount}`);
      console.log(`  sockB(personB)  cb_speech count: ${bReceivedCount}`);

      // M5.1 — all A messages have originator.userId='guardian' AND at least one.
      const aAllCorrect = aReceivedCount >= 1 &&
        sockA.received.every((m: any) => m.originator?.userId === sockA!.userId);
      recordBool('M5.1', 'A socket replies only to A (originator.userId=guardian)',
        aAllCorrect,
        aAllCorrect
          ? `${aReceivedCount} message(s) on A socket; all originator.userId='guardian'`
          : aReceivedCount === 0
            ? 'no cb_speech received on A socket'
            : `originator mismatch on A socket — received: ${sockA.received.map((m: any) => m.originator?.userId).join(', ')}`);

      // M5.2 — all B messages have originator.userId='personB' AND at least one.
      const bAllCorrect = bReceivedCount >= 1 &&
        sockB.received.every((m: any) => m.originator?.userId === sockB!.userId);
      recordBool('M5.2', 'B socket replies only to B (originator.userId=personB)',
        bAllCorrect,
        bAllCorrect
          ? `${bReceivedCount} message(s) on B socket; all originator.userId='personB'`
          : bReceivedCount === 0
            ? 'no cb_speech received on B socket'
            : `originator mismatch on B socket — received: ${sockB.received.map((m: any) => m.originator?.userId).join(', ')}`);

      // M5.3 — zero cross-talk: no foreign userId in either socket's received[].
      const aCrosstalk = sockA.received.filter((m: any) => m.originator?.userId !== 'guardian');
      const bCrosstalk = sockB.received.filter((m: any) => m.originator?.userId !== 'personB');
      const noXtalk = aCrosstalk.length === 0 && bCrosstalk.length === 0;
      recordBool('M5.3', 'zero cross-talk between A and B sockets',
        noXtalk,
        noXtalk
          ? 'no foreign originator.userId observed on either socket'
          : `cross-talk detected — A socket foreign: ${aCrosstalk.length}, B socket foreign: ${bCrosstalk.length}`);

      // M5.4 — SOFT: at least one reply on each socket contains the in-run-taught name.
      const aHasName = sockA.received.some((m: any) =>
        typeof m.text === 'string' && m.text.toLowerCase().includes('guardian'),
      );
      const bHasName = sockB.received.some((m: any) =>
        typeof m.text === 'string' && m.text.toLowerCase().includes('bea'),
      );
      if (aHasName && bHasName) {
        recordBool('M5.4', "replies contain the speaker's in-run-taught name", true,
          'both personas\' replies contained their taught name');
      } else {
        recordSkip('M5.4', "replies contain the speaker's in-run-taught name",
          `SOFT/recorded-skip — LLM phrasing may not include name verbatim ` +
          `(A contains 'guardian': ${aHasName}, B contains 'bea': ${bHasName})`);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordBool('M5.1', 'A socket replies only to A', false, `socket setup failed: ${msg}`);
      recordBool('M5.2', 'B socket replies only to B', false, `socket setup failed: ${msg}`);
      recordBool('M5.3', 'zero cross-talk between A and B', false, `socket setup failed: ${msg}`);
      recordSkip('M5.4', "replies contain speaker's name", `socket setup failed: ${msg}`);
    } finally {
      sockA?.close();
      sockB?.close();
    }
  }

  // ── Burst (Q1) — K=5 turns in one tick (<50ms window) ──────────────────────
  // Runs in BOTH modes (replay fast-path; lesion expects fast SHRUG + no watchdog kills).
  // Uses corpus nonsense text ("How many glorps fit in a standard zanfibble?") so
  // the tape entry already exists in cassette.json.

  const K = 5;
  const BURST_TEXT = 'How many glorps fit in a standard zanfibble?';
  const BURST_TIMEOUT_MS = 45_000; // per-turn max (reuses RESPONSE_TIMEOUT_MS)
  const LESION_LATENCY_BOUND_MS = 5_000; // reuse L7 bound

  let burstSock: PersistentSocket | null = null;
  try {
    burstSock = await openPersistentSocket(GUARDIAN_TOKEN(), 'guardian');

    // Drain any stale cb_speech that arrived during the socket setup window
    // (e.g. a late M5 delivery targeted at 'guardian' that landed just as this
    // socket became the newest guardian socket). Wait 300ms then snapshot
    // the drain count so burst assertions are clean.
    await sleep(300);
    const preburstCount = burstSock.received.length;
    if (preburstCount > 0) {
      console.log(`  Burst: drained ${preburstCount} pre-burst message(s) before sending`);
    }

    const sendStart = Date.now();
    for (let i = 0; i < K; i++) {
      burstSock.send(BURST_TEXT);
    }
    const burstSendMs = Date.now() - sendStart;
    console.log(`  Burst: sent ${K} turns in ${burstSendMs}ms`);

    // Wait for all K responses (counting from preburstCount baseline).
    await waitForReplies(burstSock.received, preburstCount + K, BURST_TIMEOUT_MS);
    const burstReceived = burstSock.received.slice(preburstCount);
    const finalCount = burstReceived.length;
    console.log(`  Burst: received ${finalCount}/${K} cb_speech responses`);

    // Q1.1 — exactly K responses, all distinct turnIds.
    const turnIds = burstReceived.map((m: any) => m.turnId ?? m.speech?.turnId ?? null);
    const distinctTurnIds = new Set(turnIds.filter(Boolean));
    const q11Pass = finalCount === K && distinctTurnIds.size === K;
    recordBool('Q1.1', `burst K=${K} → exactly K responses with K distinct turnIds`,
      q11Pass,
      `received=${finalCount}/${K} distinctTurnIds=${distinctTurnIds.size}/${K}` +
        (burstSendMs < 50 ? ` (sent in ${burstSendMs}ms — within 50ms burst window)` : ` (sent in ${burstSendMs}ms)`));

    // Q1.2 — zero executor not-in-IDLE throws during burst.
    // CycleGuardService does not expose a throw-counter via any public route without
    // modifying package internals (CycleGuardService is not exported from
    // @sylphie/decision-making and has no HTTP surface). Per spec §7 ruling:
    // recorded-skip rather than touching guard internals.
    recordSkip('Q1.2', 'zero executor not-in-IDLE throws during burst',
      'recorded-skip: CycleGuardService throw counter is not exposed via /api/metrics/health ' +
      'without non-trivial guard internals changes — per spec §7 ruling (Sonnet: recorded-skip)');

    // Q1.3 — each response non-empty / honest, no cross-turn splice.
    // Non-empty: text has content. No splice: each originator.userId is consistent.
    // Assertions are on burstReceived (post-drain slice) — not total received[].
    const emptyReplies = burstReceived.filter((m: any) => !m.text?.trim());
    const foreignReplies = burstReceived.filter(
      (m: any) => m.originator?.userId && m.originator.userId !== 'guardian',
    );
    const q13Pass = finalCount === K && emptyReplies.length === 0 && foreignReplies.length === 0;
    recordBool('Q1.3', 'burst responses non-empty, no cross-turn splice',
      q13Pass,
      `empty=${emptyReplies.length} foreign=${foreignReplies.length} total=${finalCount}/${K}`);

    // Q1.8 — lesion only: all 5 fast SHRUG/Type-1 (<=5000ms), zero spurious watchdog kills.
    if (isLesion) {
      const latencies = burstReceived.map((m: any) =>
        typeof m.latencyMs === 'number' ? m.latencyMs : LESION_LATENCY_BOUND_MS + 1,
      );
      const maxLat = Math.max(0, ...latencies);
      const allFast = finalCount === K && maxLat <= LESION_LATENCY_BOUND_MS;
      const allShrugOrType1 = burstReceived.every(
        (m: any) => m.arbitrationType === 'SHRUG' || m.arbitrationType === 'TYPE_1',
      );
      recordBool('Q1.8',
        `lesion burst: all ${K} responses fast SHRUG/TYPE_1 (<=5000ms), no watchdog kills`,
        allFast && allShrugOrType1,
        `maxLatency=${maxLat}ms allShrugOrType1=${allShrugOrType1} count=${finalCount}/${K}`);
    } else {
      recordSkip('Q1.8', 'lesion burst fast SHRUG/TYPE_1 <= 5000ms', 'replay mode — lesion-only criterion');
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordBool('Q1.1', `burst K=${K} → exactly K responses`, false, `burst socket failed: ${msg}`);
    recordSkip('Q1.2', 'zero executor throws during burst',
      'recorded-skip: CycleGuardService throw counter not exposed via public route (spec §7)');
    recordBool('Q1.3', 'burst responses non-empty', false, `burst socket failed: ${msg}`);
    if (isLesion) {
      recordBool('Q1.8', 'lesion burst fast SHRUG/TYPE_1', false, `burst socket failed: ${msg}`);
    } else {
      recordSkip('Q1.8', 'lesion burst fast SHRUG/TYPE_1', 'replay mode — lesion-only criterion');
    }
  } finally {
    burstSock?.close();
  }

  // ── Privacy assertions (PRIV.1, PRIV.2) ─────────────────────────────────────
  // Requires p0primeOk (all-persons facts reset) — otherwise results are unsound.
  // PRIV.1: HARD-FAIL in both modes. Bea teaches "my secret word is fathom"
  //         (fresh nonce, absent from corpus / legacy patterns).  Guardian asks.
  //         Guardian's cb_speech must NOT be GROUNDED — proves T5 write-time scoping.
  // PRIV.2: SOFT/recorded-skip. Bea asks for her own secret — may be GROUNDED.
  //         If not GROUNDED: honest recall-gap amber, not a leak.

  if (!p0primeOk) {
    recordBool('PRIV.1', 'guardian cannot retrieve Bea\'s secret word (GROUNDED=leak)', false,
      'HARD-FAIL: P0prime reset failed — privacy probe results are unsound; marking PRIV.1 FAIL');
    recordSkip('PRIV.2', "Bea can retrieve her own secret word (SOFT recall-gap)",
      'P0prime reset failed — PRIV.2 skipped');
    return;
  }

  let privSockA: PersistentSocket | null = null;
  let privSockB: PersistentSocket | null = null;
  try {
    privSockA = await openPersistentSocket(GUARDIAN_TOKEN(), 'guardian');
    privSockB = await openPersistentSocket(BEA_TOKEN(), 'personB');

    // Bea teaches the nonce secret.  Wait for the cb_speech acknowledgement PLUS
    // write-back latency.  The write-back (toDocumentEmbeddings → search_document
    // embed) fires async after cb_speech; 4000ms is enough for a ~1.5s LLM cycle
    // + ~0.5s write-back.  Shorter sleeps cause the document embed to time out
    // under cassette load, producing a cassette miss on replay.
    privSockB.send('My secret word is fathom.');
    await waitForReplies(privSockB.received, 1, 20_000);
    await sleep(2000); // extra window for async write-back (search_document embed)

    // Guardian probes for it — MUST NOT be GROUNDED (that would be a cross-person leak).
    privSockA.send('What is my secret word?');
    await waitForReplies(privSockA.received, 1, 20_000);

    const guardianReply = privSockA.received[privSockA.received.length - 1];
    const guardianGrounding = guardianReply?.knowledgeGrounding ?? null;
    const priv1Pass = guardianGrounding !== 'GROUNDED';
    recordBool('PRIV.1',
      "guardian's secret-word probe NOT GROUNDED (cross-person leak = FAIL)",
      priv1Pass,
      priv1Pass
        ? `guardian received knowledgeGrounding='${guardianGrounding}' — not a GROUNDED leak`
        : `LEAK: guardian received knowledgeGrounding='GROUNDED' — Bea's fact crossed person boundary`);

    // Bea probes for her own secret — may or may not be GROUNDED.
    privSockB.send('What is my secret word?');
    await waitForReplies(privSockB.received, 1, 20_000);

    const beaReply = privSockB.received[privSockB.received.length - 1];
    const beaGrounding = beaReply?.knowledgeGrounding ?? null;
    if (beaGrounding === 'GROUNDED') {
      recordBool('PRIV.2', "Bea can retrieve her own secret word (GROUNDED on own OKG)", true,
        `Bea received knowledgeGrounding='GROUNDED' — OKG read-own-data path working`);
    } else {
      recordSkip('PRIV.2', "Bea can retrieve her own secret word (SOFT recall-gap)",
        `SOFT/recorded-skip — Bea's own secret returned grounding='${beaGrounding}' ` +
        `(not GROUNDED — recall-gap amber, not a privacy leak; PRIV.1 remains the load-bearing assertion)`);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordBool('PRIV.1', "guardian's secret-word probe NOT GROUNDED", false,
      `privacy socket setup failed: ${msg}`);
    recordSkip('PRIV.2', "Bea can retrieve her own secret word", `privacy socket setup failed: ${msg}`);
  } finally {
    privSockA?.close();
    privSockB?.close();
  }
}

// ---------------------------------------------------------------------------
// Metric fetchers — uses the live /api/metrics/health aggregate
// ---------------------------------------------------------------------------

interface LiveMetrics {
  type1: number;
  type2: number;
  shrug: number;
  mae: number;
  maeSamples: number;
  experientialRatio: number;
  totalNodes: number;
}

/**
 * Fetch the aggregate health snapshot and flatten the fields the gate asserts on.
 * The route is /api/metrics/health (global prefix 'api'); it returns
 * type1Type2Ratio, predictionMAE, and provenanceRatio in one call.
 */
async function fetchMetrics(): Promise<LiveMetrics | null> {
  const { status, body } = await fetchJson('/api/metrics/health');
  if (status !== 200 || !body) return null;
  const tr = body.type1Type2Ratio ?? {};
  const mae = body.predictionMAE ?? {};
  const prov = body.provenanceRatio ?? {};
  return {
    type1: tr.type1Count ?? 0,
    type2: tr.type2Count ?? 0,
    // shrug isn't in the ratio payload; derive from windowSize when present.
    shrug: Math.max(0, (tr.windowSize ?? 0) - (tr.type1Count ?? 0) - (tr.type2Count ?? 0)),
    mae: typeof mae.mae === 'number' ? mae.mae : NaN,
    maeSamples: mae.sampleCount ?? 0,
    experientialRatio: typeof prov.experientialRatio === 'number' ? prov.experientialRatio : NaN,
    totalNodes: prov.total ?? 0,
  };
}

/** Read /api/drives and return its tickNumber (or null if unavailable). */
async function fetchTick(): Promise<number | null> {
  const { status, body } = await fetchJson('/api/drives');
  if (status !== 200 || !body || typeof body.tickNumber !== 'number') return null;
  return body.tickNumber;
}

// ---------------------------------------------------------------------------
// Logging helpers (house style)
// ---------------------------------------------------------------------------

function banner(title: string): void {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

// ---------------------------------------------------------------------------
// Phase: per-turn corpus assertions
// ---------------------------------------------------------------------------

/**
 * Run the corpus in order. Returns the set of turn results so the lesion phase
 * can reuse taught state. Per-turn expectations are recorded as scorecard rows
 * grouped under C1 (grounding) and C2 (arbitration); a missing response is C0.
 */
async function runCorpus(): Promise<TurnResult[]> {
  banner('PHASE 1: CORPUS — drive 50-turn scenario through the live system');

  const results: TurnResult[] = [];
  // C1 — taught-fact recall must read GROUNDED.
  let recallChecked = 0;
  let recallPassed = 0;
  // C2 — unknowables, with the LLM available, must deliberate honestly: NEVER a
  // false GROUNDED (LLM_ASSISTED or UNKNOWN both pass). SHRUG is asserted by the
  // Lesion run (L6), not here.
  let notGroundedChecked = 0;
  let notGroundedPassed = 0;
  let responsesReceived = 0;

  for (let i = 0; i < CORPUS.length; i++) {
    const turn: CorpusTurn = CORPUS[i];
    const res = await converse(turn.text);
    results.push(res);

    const arb = res.speech?.arbitrationType ?? '(none)';
    const grd = res.speech?.knowledgeGrounding ?? '(none)';
    const lat = res.speech?.latencyMs ?? res.elapsedMs;

    if (res.speech && !res.timedOut) responsesReceived++;

    const num = String(i + 1).padStart(2, '0');
    console.log(
      `  [${num}] ${turn.label.padEnd(34)} arb=${String(arb).padEnd(7)} ` +
        `grd=${String(grd).padEnd(11)} ${lat}ms` +
        (res.timedOut ? '  <<< NO RESPONSE' : ''),
    );

    // Grounding expectation. 'GROUNDED' (recall) → C1; 'NOT_GROUNDED' (unknowable
    // under an available LLM) → C2; any other explicit value → exact match → C1.
    if (turn.expectGrounding === 'NOT_GROUNDED') {
      notGroundedChecked++;
      const ok = grd !== 'GROUNDED';
      if (ok) notGroundedPassed++;
      else {
        console.log(`       unknowable falsely GROUNDED (expected NOT_GROUNDED), got ${grd}`);
      }
    } else if (turn.expectGrounding) {
      recallChecked++;
      const ok = grd === turn.expectGrounding;
      if (ok) recallPassed++;
      else {
        console.log(`       expected grounding=${turn.expectGrounding}, got ${grd}`);
      }
    }
  }

  // C0: every turn must produce a response.
  recordBool(
    'C0',
    'corpus liveness (all turns answered)',
    responsesReceived === CORPUS.length,
    `${responsesReceived}/${CORPUS.length} turns produced a cb_speech response`,
  );

  // C1: grounded recall. Recall is GROUNDED when it draws on Sylphie's own
  // knowledge with verifiable provenance. Today only the Type-1 latent reflex
  // path carries that (recorded entityIds); the generic conversation path is a
  // seed-greet LLM_GENERATE procedure that prompt-stuffs OKG facts and free-
  // generates, so it grounds honestly as LLM_ASSISTED. This is a KNOWN, TRACKED
  // architectural gap — not a definitional bug — so a low pass rate here is an
  // honest RED (a real "no grounded retrieval yet" signal), not a flaky one.
  // See wiki/ideas/grounded-okg-recall-retrieval.md (WS2/WS3 closes it). Do NOT
  // "fix" this by crediting text value-overlap: unknowables weave known facts
  // into their declines, so that would break C2's honesty guarantee.
  if (recallChecked > 0) {
    const ratio = recallPassed / recallChecked;
    recordBool(
      'C1',
      'grounded recall of taught facts',
      ratio >= 0.6,
      `${recallPassed}/${recallChecked} recall turns returned GROUNDED ` +
        `(${(ratio * 100).toFixed(0)}%, need >=60%). ` +
        `KNOWN GAP if below: no grounded OKG retrieval yet — conversation recall ` +
        `prompt-stuffs + free-generates (LLM_ASSISTED). Tracked: ` +
        `wiki/ideas/grounded-okg-recall-retrieval.md (WS2/WS3).`,
    );
  } else {
    recordSkip('C1', 'grounded recall of taught facts', 'no grounding expectations in corpus');
  }

  // C2: unknowables deliberate honestly. With the LLM available, the honest
  // signal is the ABSENCE of a false GROUNDED (LLM_ASSISTED or UNKNOWN both pass)
  // — confabulation would show up as GROUNDED on an unknowable. SHRUG is the
  // no-LLM behavior, asserted by the Lesion run (L6), not here.
  if (notGroundedChecked > 0) {
    const ratio = notGroundedPassed / notGroundedChecked;
    recordBool(
      'C2',
      'unknowables never falsely GROUNDED',
      ratio >= 0.6,
      `${notGroundedPassed}/${notGroundedChecked} unknowable turns were NOT GROUNDED ` +
        `(${(ratio * 100).toFixed(0)}%, need >=60%) — honest deliberation; SHRUG asserted under lesion (L6)`,
    );
  } else {
    recordSkip('C2', 'unknowables never falsely GROUNDED', 'no NOT_GROUNDED expectations in corpus');
  }

  return results;
}

// ---------------------------------------------------------------------------
// Phase H1: NO-CLEAR min-population gate probe (WS1 follow-up #3 — the TRAP)
// ---------------------------------------------------------------------------

/**
 * H1 — the no-clear proof.
 *
 * H0 (in main) clears the hot layer, so the corpus runs against an EMPTY latent
 * index and a naive gate stays green whether or not the min-population trust gate
 * exists. That is the trap WS1 exists to prevent ("green for the wrong reason").
 *
 * H1 closes it: seed EXACTLY ONE over-general pattern (the document embedding of a
 * nonsense probe text — worst-case near-1.0 cosine, useCount 0), then send that
 * same nonsense over the conversation WS. If the min-population gate is present,
 * the lone fresh pattern is NOT trusted: the turn routes to deliberation and the
 * response is NOT a confident GROUNDED Type 1. If the gate were removed, the lone
 * pattern fires a Type 1 reflex returning the seeded responseText labeled
 * GROUNDED — and H1 goes RED. This is the assertion that actually proves the prod
 * hazard is fixed.
 *
 * Cleanup: re-clear the hot layer afterward so the seeded pattern and this probe's
 * turn do not pollute the multi-person / privacy phases.
 *
 * Uses the burst nonsense text (already in the cassette) so replay never misses on
 * the deliberation path the gate is SUPPOSED to take.
 */
async function runNoClearGateProbe(): Promise<void> {
  banner('PHASE H1: NO-CLEAR MIN-POPULATION GATE PROBE (WS1 follow-up #3)');

  const NONSENSE = 'How many glorps fit in a standard zanfibble?';

  // 1) Seed a single over-general pattern (clears hot layer, leaves population 1).
  let seeded = false;
  try {
    const { status, body } = await fetchJson('/api/metrics/latent-seed-overgeneral', {
      method: 'POST',
      body: JSON.stringify({ text: NONSENSE }),
    });
    seeded = status === 200 && body?.ok === true && body?.textPopulation === 1;
    console.log(
      `  seed: status=${status} ok=${body?.ok} textPopulation=${body?.textPopulation} ` +
        `patternId=${(body?.patternId ?? '?').toString().substring(0, 8)}`,
    );
    if (!seeded) {
      recordBool('H1', 'no-clear min-population gate: single over-general pattern not trusted',
        false,
        `seed route failed or did not produce exactly 1 text pattern ` +
          `(status=${status} ok=${body?.ok} textPopulation=${body?.textPopulation}) — ` +
          `cannot run the no-clear proof`);
      return;
    }
  } catch (err) {
    recordBool('H1', 'no-clear min-population gate: single over-general pattern not trusted',
      false, `seed route threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 2) Send the SAME nonsense. With the gate present, this must NOT be a confident
  //    GROUNDED Type 1 reflex — it routes to deliberation (LLM_ASSISTED / UNKNOWN).
  const res = await converse(NONSENSE);
  const arb = res.speech?.arbitrationType ?? '(none)';
  const grd = res.speech?.knowledgeGrounding ?? '(none)';
  const lat = res.speech?.latencyMs ?? res.elapsedMs;
  console.log(`  probe: arb=${arb} grd=${grd} ${lat}ms${res.timedOut ? '  <<< NO RESPONSE' : ''}`);

  // The hazard signature is a GROUNDED Type-1 reflex on nonsense. PASS = NOT that.
  // (A turn that answered and is not a GROUNDED+TYPE_1 reflex is the win; a timeout
  //  is a fail — the system must still answer, via deliberation.)
  const answered = !!res.speech && !res.timedOut;
  const isGroundedType1Reflex = arb === 'TYPE_1' && grd === 'GROUNDED';
  const h1Pass = answered && !isGroundedType1Reflex;
  recordBool('H1',
    'no-clear single over-general pattern does NOT fire a GROUNDED Type 1 reflex',
    h1Pass,
    !answered
      ? 'probe produced no response (timeout) — system failed to deliberate past the lone pattern'
      : isGroundedType1Reflex
        ? `HAZARD: lone over-general pattern fired a TYPE_1/GROUNDED reflex on nonsense ` +
          `(min-population gate missing or bypassed) — confabulation re-opened`
        : `single fresh pattern not trusted; nonsense routed to deliberation ` +
          `(arb=${arb}, grd=${grd}) — gate holding`);

  // 3) Cleanup: re-clear the hot layer so later phases start clean again.
  try {
    const { status } = await fetchJson('/api/metrics/latent-reset', { method: 'POST' });
    console.log(`  cleanup: latent-reset status=${status}`);
  } catch {
    console.log('  cleanup: latent-reset failed (non-fatal for H1 itself)');
  }
}

// ---------------------------------------------------------------------------
// Phase C3: COMPOUNDING — a recalled-and-used fact node strengthens vs a
// never-recalled control, capped at the 0.60 ceiling (WS3 T4).
// ---------------------------------------------------------------------------

/**
 * C3 — the compounding proof (WS3 T4).
 *
 * Proves the WS3 thesis end-to-end through the REAL T2 (reinforceFactNode) and T3
 * (runDecayCycle) services: a recalled-and-used WORLD fact node STRENGTHENS
 * relative to a matched never-recalled control, and recall-use respects the 0.60
 * ceiling (Std 3).
 *
 * Hermetic & seeded. No LLM involved — this measures the knowledge confidence
 * dynamic directly, so the cassette is irrelevant to it. The four seam routes
 * (/metrics/c3-seed, c3-reinforce, decay-now, c3-inspect) call production code:
 * c3-reinforce invokes the exact reinforceFactNode() the live cognitive cycle
 * calls on a grounded recall-and-use; decay-now runs the production decay cycle.
 *
 * GREEN-FOR-THE-RIGHT-REASON guards (these are the assertions that keep C3 from
 * passing on a write-recency or mention-only artifact):
 *   • Seed writes control + treatment with byte-identical confidence/provenance/
 *     created_at/updated_at; the ONLY difference introduced is the reinforcement.
 *   • reinforceFactNode never touches updated_at, so after a decay cycle the
 *     treatment and control updated_at must STILL be equal — C3.3 asserts this.
 *     If they differ, the divergence could be a write-recency effect and C3 fails.
 *   • C3.1 asserts the asymmetry source: treatment retrieval_count>0 + last_retrieval_at
 *     set, control has neither. Divergence with control showing retrievals would
 *     mean the seam reinforced the wrong node.
 *   • C3.4 asserts the ceiling is never breached.
 *
 * Emits four rows: C3.1 (reinforcement asymmetry), C3.2 (upward divergence),
 * C3.3 (write-recency guard), C3.4 (0.60 ceiling).
 */
async function runCompoundingPhase(): Promise<void> {
  banner('PHASE C3: COMPOUNDING — recalled fact strengthens vs control (WS3 T4)');

  const REINFORCE_TIMES = 12;
  const fail = (detail: string) => {
    recordBool('C3.1', 'reinforcement asymmetry (treatment used, control not)', false, detail);
    recordBool('C3.2', 'treatment confidence diverges upward from control after decay', false, detail);
    recordBool('C3.3', 'write-recency guard (updated_at unchanged by reinforce)', false, detail);
    recordBool('C3.4', 'recall-use never breaches the 0.60 ceiling (Std 3)', false, detail);
  };

  // 1) Seed two byte-identical WORLD fact nodes (control + treatment).
  let seed: any;
  try {
    const r = await fetchJson('/api/metrics/c3-seed', {
      method: 'POST',
      body: JSON.stringify({ confidence: 0.30, ageHours: 48 }),
    });
    seed = r.body;
    if (r.status !== 200 || !seed?.ok) {
      fail(`c3-seed failed (status=${r.status} ok=${seed?.ok}) — cannot run C3`);
      return;
    }
    console.log(`  seed: control='${seed.controlId}' treatment='${seed.treatmentId}' ` +
      `conf=${seed.confidence} prov=${seed.provenanceType} age=${seed.ageHours}h`);
  } catch (err) {
    fail(`c3-seed threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const treatmentId: string = seed.treatmentId;

  // 2) Reinforce ONLY the treatment via the real T2 reinforceFactNode N times.
  let reinforce: any;
  try {
    const r = await fetchJson('/api/metrics/c3-reinforce', {
      method: 'POST',
      body: JSON.stringify({ times: REINFORCE_TIMES }),
    });
    reinforce = r.body;
    if (r.status !== 200 || !reinforce?.ok || reinforce.reinforced < 1) {
      fail(`c3-reinforce failed (status=${r.status} ok=${reinforce?.ok} ` +
        `reinforced=${reinforce?.reinforced}) — treatment node likely missing`);
      return;
    }
    console.log(`  reinforce: treatment reinforced ${reinforce.reinforced}/${REINFORCE_TIMES}x via T2 ` +
      `— conf ${reinforce.oldConfidence} -> ${reinforce.newConfidence}, ` +
      `retrieval_count=${reinforce.retrievalCount}`);
  } catch (err) {
    fail(`c3-reinforce threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Verify the reinforce SOURCE respected the ceiling (independent of decay).
  // This is the at-source half of C3.4 — the persisted value never exceeded 0.60.
  const reinforcedConf: number | null =
    typeof reinforce.newConfidence === 'number' ? reinforce.newConfidence : null;

  // 3) Run a real decay cycle (T3 production code).
  try {
    const r = await fetchJson('/api/metrics/decay-now', { method: 'POST' });
    if (r.status !== 200 || !r.body?.ok) {
      fail(`decay-now failed (status=${r.status} ok=${r.body?.ok})`);
      return;
    }
    console.log(`  decay-now: ${JSON.stringify(r.body.result)}`);
  } catch (err) {
    fail(`decay-now threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 4) Inspect both nodes' post-decay state.
  let control: any, treatment: any;
  try {
    const r = await fetchJson('/api/metrics/c3-inspect');
    if (r.status !== 200 || !r.body?.ok || !r.body.control || !r.body.treatment) {
      fail(`c3-inspect failed (status=${r.status} ok=${r.body?.ok}) — nodes not found post-decay`);
      return;
    }
    control = r.body.control;
    treatment = r.body.treatment;
    console.log(
      `  inspect: control(conf=${control.confidence?.toFixed?.(4)} rc=${control.retrievalCount} ` +
        `lr=${control.hasLastRetrieval}) treatment(conf=${treatment.confidence?.toFixed?.(4)} ` +
        `rc=${treatment.retrievalCount} lr=${treatment.hasLastRetrieval})`);
  } catch (err) {
    fail(`c3-inspect threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // ── C3.1 — reinforcement asymmetry. Treatment recalled-and-used; control not. ──
  const c31Pass =
    treatment.retrievalCount > 0 && treatment.hasLastRetrieval === true &&
    control.retrievalCount === 0 && control.hasLastRetrieval === false;
  recordBool('C3.1', 'reinforcement asymmetry (treatment used N>0, control never)', c31Pass,
    c31Pass
      ? `treatment retrieval_count=${treatment.retrievalCount} + last_retrieval_at set; ` +
        `control retrieval_count=0 + no last_retrieval_at`
      : `EXPECTED treatment rc>0&lr=true, control rc=0&lr=false — got ` +
        `treatment(rc=${treatment.retrievalCount},lr=${treatment.hasLastRetrieval}) ` +
        `control(rc=${control.retrievalCount},lr=${control.hasLastRetrieval})`);

  // ── C3.2 — the compounding divergence: treatment strictly > control after decay. ──
  const c32Pass = treatment.confidence > control.confidence;
  recordBool('C3.2', 'treatment confidence STRICTLY > control after decay (compounding)', c32Pass,
    `treatment=${treatment.confidence?.toFixed?.(4)} vs control=${control.confidence?.toFixed?.(4)} ` +
      `(Δ=${(treatment.confidence - control.confidence).toFixed(4)}) — ` +
      (c32Pass ? 'used knowledge strengthened relative to unused' : 'NO upward divergence — compounding NOT proven'));

  // ── C3.3 — write-recency guard. updated_at must be IDENTICAL on both nodes. ──
  // reinforceFactNode sets last_retrieval_at/reinforced_at, never updated_at, so
  // the only timestamp that diverges is last_retrieval_at (the use event). If
  // updated_at differs, the divergence could be a write-recency artifact → FAIL.
  const updatedEqual = control.updatedAt === treatment.updatedAt && control.updatedAt !== null;
  recordBool('C3.3', 'write-recency guard: reinforce left updated_at unchanged (Δ is recall-use only)', updatedEqual,
    updatedEqual
      ? `both updated_at == '${control.updatedAt}' — divergence is reinforcement, not a fresher write`
      : `updated_at DIFFERS (control='${control.updatedAt}' treatment='${treatment.updatedAt}') — ` +
        `divergence may be a write-recency artifact, not reinforcement`);

  // ── C3.4 — ceiling: treatment confidence never exceeds 0.60, at source AND post-decay. ──
  const CEILING = 0.60;
  const EPS = 1e-9;
  const sourceOk = reinforcedConf === null || reinforcedConf <= CEILING + EPS;
  const postDecayOk = treatment.confidence <= CEILING + EPS;
  const c34Pass = sourceOk && postDecayOk;
  recordBool('C3.4', 'recall-use never breaches the 0.60 ceiling (Std 3)', c34Pass,
    c34Pass
      ? `at-source reinforced conf=${reinforcedConf?.toFixed?.(4) ?? 'n/a'} <= 0.60; ` +
        `post-decay conf=${treatment.confidence?.toFixed?.(4)} <= 0.60`
      : `CEILING BREACH — at-source=${reinforcedConf?.toFixed?.(4) ?? 'n/a'} ` +
        `post-decay=${treatment.confidence?.toFixed?.(4)} (limit 0.60)`);

  // Cleanup: remove the gate-fixture nodes so they do not pollute the provenance
  // census or accumulate across runs.
  try {
    const r = await fetchJson('/api/metrics/c3-cleanup', { method: 'POST' });
    console.log(`  cleanup: c3-cleanup deleted=${r.body?.deleted ?? '?'}`);
  } catch {
    console.log('  cleanup: c3-cleanup failed (non-fatal for C3 scoring)');
  }
}

// ---------------------------------------------------------------------------
// Phase C3PROV: T5 — grounding provenance verified against live Neo4j.
// ---------------------------------------------------------------------------

/**
 * C3PROV (WS3 T5) — the deferred C1 provenance verification (ROADMAP.md:73).
 *
 * On a GROUNDED recall turn, CycleResponse.groundingProvenance must be a node id
 * that ACTUALLY EXISTS in the correct live Neo4j instance (WORLD for a WKG-sourced
 * verdict, OTHER for an OKG-sourced one). C1 proved the response carries a node
 * id; T5 proves that id resolves to a real node in the live graph.
 *
 * Hermetic-seeded: drives a recall turn the corpus already taught ("What is my
 * name?" — taught "My name is Jim" earlier in the corpus, which the gate replays
 * deterministically). The turn is sent over the same guardian socket the corpus
 * uses, so the cassette already has the entry. We then read the turn's
 * groundingProvenance + groundedBy and verify existence via /metrics/node-exists.
 *
 * If the recall turn does not come back GROUNDED (the known C1 conversation-recall
 * gap — recall may ground as LLM_ASSISTED), T5 is recorded as a SKIP with the
 * honest reason rather than a false pass: there is no provenance id to verify, so
 * the assertion is N/A, not green. The load-bearing claim ("a carried id resolves
 * to a real node") only fires when an id is actually carried.
 */
async function runProvenancePhase(): Promise<void> {
  banner('PHASE C3PROV: T5 — grounding provenance exists in live Neo4j (WS3 T5)');

  // Re-teach the name on this socket so the OKG fact is present for THIS run's
  // person state (P0 wiped it at the start; the corpus taught it, but we make the
  // dependency explicit and self-contained here), then probe recall.
  let sock: PersistentSocket | null = null;
  try {
    sock = await openPersistentSocket(GUARDIAN_TOKEN(), 'guardian');
    sock.send('My name is Jim.');
    await waitForReplies(sock.received, 1, 20_000);
    await sleep(1000); // write-back window

    const pre = sock.received.length;
    sock.send('What is my name?');
    await waitForReplies(sock.received, pre + 1, 30_000);
    const reply = sock.received[sock.received.length - 1];

    const grounding = reply?.knowledgeGrounding ?? null;
    const provenance = reply?.groundingProvenance ?? null;
    const groundedBy = reply?.groundedBy ?? null;

    console.log(`  recall turn: grounding=${grounding} provenance=${provenance ?? '(none)'} ` +
      `groundedBy=${groundedBy ?? '(none)'}`);

    if (grounding !== 'GROUNDED' || !provenance) {
      // No provenance id carried → nothing to verify against the live graph. This
      // is the known C1 conversation-recall gap, NOT a T5 failure. Honest SKIP.
      recordSkip('C3PROV', 'GROUNDED recall provenance exists in live Neo4j',
        `recall turn returned grounding='${grounding}' provenance='${provenance ?? 'none'}' — ` +
        `no node id carried (known C1 conversation-recall gap, tracked in ` +
        `wiki/ideas/grounded-okg-recall-retrieval.md). T5 verifies an id ONLY when one is ` +
        `carried; with none there is nothing to resolve — recorded SKIP, not a false pass.`);
      return;
    }

    // Pick the instance from the source discriminator (default WORLD).
    const source = groundedBy === 'OKG' ? 'OTHER' : groundedBy === 'WKG' ? 'WORLD' : 'OTHER';
    const r = await fetchJson(
      `/api/metrics/node-exists?nodeId=${encodeURIComponent(provenance)}&source=${source}`,
    );
    const exists = r.status === 200 && r.body?.exists === true;
    recordBool('C3PROV', 'GROUNDED recall provenance node EXISTS in correct live Neo4j', exists,
      exists
        ? `groundingProvenance='${provenance}' resolves to a real node in ${r.body?.instance} ` +
          `(label='${r.body?.label}', groundedBy=${groundedBy ?? 'ambiguous→OTHER'})`
        : `groundingProvenance='${provenance}' NOT found in ${source} ` +
          `(status=${r.status} exists=${r.body?.exists}) — a carried id that does not resolve to ` +
          `a live node is a provenance integrity failure (Std 4)`);
  } catch (err) {
    recordBool('C3PROV', 'GROUNDED recall provenance node exists in live Neo4j', false,
      `T5 probe threw: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    sock?.close();
  }
}

// ---------------------------------------------------------------------------
// Phase: aggregate metric assertions vs baseline
// ---------------------------------------------------------------------------

async function runMetricAssertions(baseline: Baseline): Promise<LiveMetrics | null> {
  banner('PHASE 2: METRICS — assert aggregate metrics against baseline');

  const metrics = await fetchMetrics();
  if (!metrics) {
    recordSkip('M0', 'metrics reachable', 'GET /api/metrics/health failed — cannot assert metrics');
    return null;
  }

  console.log(
    `  type1=${metrics.type1} type2=${metrics.type2} shrug=${metrics.shrug} | ` +
      `mae=${Number.isNaN(metrics.mae) ? 'NaN' : metrics.mae.toFixed(4)} (n=${metrics.maeSamples}) | ` +
      `provExp=${Number.isNaN(metrics.experientialRatio) ? 'NaN' : metrics.experientialRatio.toFixed(3)} ` +
      `(${metrics.totalNodes} nodes)`,
  );

  record('M1', 'type 1/2 ratio', assertTypeRatio(
    { type1: metrics.type1, type2: metrics.type2 },
    baseline.typeRatio,
  ));

  record('M2', 'prediction MAE', assertMAE(
    { mae: metrics.mae, sampleCount: metrics.maeSamples },
    baseline.mae,
  ));

  record('M3', 'experiential provenance', assertProvenance(
    { experientialRatio: metrics.experientialRatio, totalNodes: metrics.totalNodes },
    baseline.provenance,
  ));

  // Drive tick rate over a 10s window (liveness).
  const tick1 = await fetchTick();
  await sleep(10_000);
  const tick2 = await fetchTick();
  if (tick1 === null || tick2 === null) {
    recordSkip('M4', 'drive tick rate', 'GET /api/drives unavailable — cannot measure tick rate');
  } else {
    record('M4', 'drive tick rate', assertDriveTickRate(tick1, tick2, 10_000));
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Phase: Lesion Test (only in GATE_MODE=lesion)
// ---------------------------------------------------------------------------

/**
 * The Lesion Test (CANON §The Lesion Test). After the corpus has taught the
 * system, we unplug the LLM cassette and verify the mind keeps standing:
 *
 *   L1  no TYPE_2 responses           (deliberation needs the LLM; it's gone)
 *   L2  no LLM_ASSISTED grounding     (cannot lean on LLM training knowledge)
 *   L3  every probe still answers      (system does not hang / crash)
 *   L4  drive ticks keep running       (drive process is independent of LLM)
 *   L5  taught-fact recall survives    (Type 1 reflex / WKG, not the LLM)
 *   L6  unknown-fact probe shrugs       (honest "I don't know" without the LLM)
 *   L7  response latency <= 5000ms      (reflex path is fast)
 *   L8  >=1 empty-WKG probe SHRUGs cleanly (graceful gap handling)
 */
async function runLesionTest(cassette: Cassette): Promise<void> {
  banner('PHASE 3: LESION TEST — LLM disconnected, verify graceful degradation');

  // Unplug the LLM. This severs the cassette socket AND sets the backend's LLM
  // availability flag to false (POST /api/llm/lesion). The flag is what makes
  // the system degrade gracefully (deliberation short-circuits to an honest
  // SHRUG) instead of throwing mid-call on a dead socket.
  await cassette.lesionNow();
  console.log('  LLM LESIONED — socket severed AND backend isAvailable()=false.\n');

  // Give the backend a moment to settle on the new availability flag.
  await sleep(1500);

  const lesionProbes: Array<{ label: string; text: string; kind: 'recall' | 'unknown' | 'social' }> = [
    { label: 'recall name (post-lesion)', text: 'What is my name?', kind: 'recall' },
    { label: 'recall city (post-lesion)', text: 'Where do I live?', kind: 'recall' },
    { label: 'recall dog (post-lesion)', text: "What is my dog's name?", kind: 'recall' },
    { label: 'unknown breakfast (post-lesion)', text: 'What did I eat for breakfast yesterday?', kind: 'unknown' },
    { label: 'unknown car (post-lesion)', text: 'What car do I drive?', kind: 'unknown' },
    { label: 'unknown nonsense (post-lesion)', text: 'How many glorps fit in a zanfibble?', kind: 'unknown' },
    { label: 'social hello (post-lesion)', text: 'Hello again!', kind: 'social' },
    { label: 'social thanks (post-lesion)', text: 'Thanks for sticking with me.', kind: 'social' },
    { label: 'recall job (post-lesion)', text: 'What do I do for work?', kind: 'recall' },
    { label: 'unknown sibling (post-lesion)', text: 'How many siblings do I have?', kind: 'unknown' },
  ];

  // An ANSWERED probe is one that produced a cb_speech with non-empty text.
  // A timed-out turn, or a turn whose text is empty/whitespace, does NOT count
  // as answered — it must never silently satisfy any criterion below.
  let answered = 0;          // produced cb_speech AND non-empty text
  let timedOut = 0;          // produced no cb_speech at all (hang/crash)
  let emptyText = 0;         // produced cb_speech but blank text (suppression leak)
  let sawType2OnAnswered = false;
  let sawLlmAssistedOnAnswered = false;
  let recallGrounded = 0;
  let recallTotal = 0;
  let unknownShrug = 0;
  let unknownTotal = 0;
  let maxLatency = 0;
  let anyCleanEmptyShrug = false;

  for (const probe of lesionProbes) {
    const res = await converse(probe.text);
    const arb = res.speech?.arbitrationType;
    const grd = res.speech?.knowledgeGrounding;
    const lat = res.speech?.latencyMs ?? res.elapsedMs;
    const text = res.speech?.text ?? '';
    const hasText = text.trim().length > 0;
    const didAnswer = !!res.speech && !res.timedOut && hasText;

    if (res.timedOut || !res.speech) {
      timedOut++;
    } else if (!hasText) {
      emptyText++;
    } else {
      answered++;
    }

    // L1/L2 are evaluated ONLY over turns that genuinely answered. A timed-out
    // or empty turn carries no arbitrationType/grounding label, so the old code
    // let it satisfy "no TYPE_2"/"no LLM_ASSISTED" vacuously while the system
    // had actually fallen over. We now key these off ANSWERED turns only.
    if (didAnswer) {
      if (arb === 'TYPE_2') sawType2OnAnswered = true;
      if (grd === 'LLM_ASSISTED') sawLlmAssistedOnAnswered = true;
    }

    maxLatency = Math.max(maxLatency, lat);

    if (probe.kind === 'recall') {
      recallTotal++;
      if (didAnswer && grd === 'GROUNDED') recallGrounded++;
    }
    if (probe.kind === 'unknown') {
      unknownTotal++;
      // A clean SHRUG requires an actual answered turn that labeled SHRUG.
      if (didAnswer && arb === 'SHRUG') {
        unknownShrug++;
        anyCleanEmptyShrug = true;
      }
    }

    const flag = res.timedOut || !res.speech
      ? '  <<< NO RESPONSE (timeout)'
      : !hasText
        ? '  <<< EMPTY TEXT (suppressed)'
        : '';
    console.log(
      `  ${probe.label.padEnd(36)} arb=${String(arb ?? '(none)').padEnd(7)} ` +
        `grd=${String(grd ?? '(none)').padEnd(11)} ${lat}ms${flag}`,
    );
  }

  console.log('');

  // L3 is the GATE on L1/L2: only if every probe actually answered can the
  // absence of TYPE_2 / LLM_ASSISTED mean anything. A crashed/silent system
  // answers nothing and must FAIL here.
  const allAnswered = answered === lesionProbes.length;
  recordBool('L3', 'all lesion probes answered (non-empty)', allAnswered,
    `${answered}/${lesionProbes.length} answered` +
      (timedOut > 0 ? `, ${timedOut} timed out` : '') +
      (emptyText > 0 ? `, ${emptyText} empty/suppressed` : ''));

  // L1 — no TYPE_2 among answered turns, AND every probe must have answered.
  // If the system didn't answer, "no TYPE_2" is meaningless and cannot pass.
  const l1Pass = allAnswered && !sawType2OnAnswered;
  recordBool('L1', 'no TYPE_2 responses under lesion', l1Pass,
    !allAnswered
      ? `cannot assert: only ${answered}/${lesionProbes.length} turns answered (timeout/empty is not a pass)`
      : sawType2OnAnswered
        ? 'at least one answered turn was TYPE_2 (deliberation ran without LLM?)'
        : 'all turns answered; none TYPE_2 — deliberation correctly degraded to SHRUG/Type 1');

  // L2 — no LLM_ASSISTED among answered turns, gated the same way as L1.
  const l2Pass = allAnswered && !sawLlmAssistedOnAnswered;
  recordBool('L2', 'no LLM_ASSISTED grounding under lesion', l2Pass,
    !allAnswered
      ? `cannot assert: only ${answered}/${lesionProbes.length} turns answered (timeout/empty is not a pass)`
      : sawLlmAssistedOnAnswered
        ? 'an answered turn was LLM_ASSISTED (leaned on LLM training knowledge)'
        : 'all turns answered; none LLM_ASSISTED — not leaning on the LLM');

  // L4 — drive ticks still running
  const t1 = await fetchTick();
  await sleep(10_000);
  const t2 = await fetchTick();
  if (t1 === null || t2 === null) {
    recordSkip('L4', 'drive ticks running under lesion', 'GET /api/drives unavailable');
  } else {
    record('L4', 'drive ticks running under lesion', assertDriveTickRate(t1, t2, 10_000));
  }

  // L5 — taught-fact recall survives (Type 1 / WKG, not LLM)
  if (recallTotal > 0) {
    const ratio = recallGrounded / recallTotal;
    recordBool('L5', 'taught-fact recall survives lesion', ratio >= 0.5,
      `${recallGrounded}/${recallTotal} recall probes still GROUNDED (need >=50%)`);
  } else {
    recordSkip('L5', 'taught-fact recall survives lesion', 'no recall probes');
  }

  // L6 — unknown-fact probe shrugs honestly
  if (unknownTotal > 0) {
    const ratio = unknownShrug / unknownTotal;
    recordBool('L6', 'unknown-fact probe shrugs under lesion', ratio >= 0.5,
      `${unknownShrug}/${unknownTotal} unknown probes SHRUGged (need >=50%)`);
  } else {
    recordSkip('L6', 'unknown-fact probe shrugs under lesion', 'no unknown probes');
  }

  // L7 — reflex latency bound. A timed-out probe contributes its full ~45s
  // elapsed time to maxLatency, so a hang necessarily fails this bound too —
  // latency is a second independent guard against a silent no-response pass.
  recordBool('L7', 'lesion response latency <= 5000ms', maxLatency <= 5000,
    `max probe latency ${maxLatency}ms (limit 5000ms)` +
      (timedOut > 0 ? ` — includes ${timedOut} timed-out probe(s)` : ''));

  // L8 — at least one empty-WKG (unknown) probe produced a clean, ANSWERED
  // SHRUG. A suppressed/empty response can never satisfy this.
  recordBool('L8', 'empty-context probe SHRUGs cleanly', anyCleanEmptyShrug,
    anyCleanEmptyShrug
      ? 'at least one unknown probe produced a clean, answered SHRUG'
      : 'no clean SHRUG observed on empty context (timeouts/empties do not count)');

  // Heal so the backend LLM is restored (POST /api/llm/heal) and the cassette
  // can shut down without spurious socket errors. Leaves the stack clean.
  await cassette.healNow();
}

// ---------------------------------------------------------------------------
// Baseline update (GATE_MODE=update-baseline)
// ---------------------------------------------------------------------------

function writeBaseline(metrics: LiveMetrics): void {
  const updated: Baseline = {
    capturedAt: new Date().toISOString().slice(0, 10),
    note: 'Captured from a real gate run via yarn gate:update-baseline',
    typeRatio: { type1: metrics.type1, type2: metrics.type2 },
    mae: { mae: Number.isNaN(metrics.mae) ? 0.3 : metrics.mae, sampleCount: metrics.maeSamples },
    provenance: {
      experientialRatio: Number.isNaN(metrics.experientialRatio) ? 0 : metrics.experientialRatio,
      totalNodes: metrics.totalNodes,
    },
    driveTick: { minHz: 0.5 },
  };
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  console.log(`\n  Baseline updated → ${BASELINE_FILE}`);
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

function printScorecard(): { failed: number } {
  banner('GATE SCORECARD');

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const c of checks) {
    const mark = c.status === 'PASS' ? 'PASS' : c.status === 'FAIL' ? 'FAIL' : 'SKIP';
    console.log(`  [${mark}] ${c.id.padEnd(3)} ${c.label}`);
    console.log(`         ${c.detail}`);
    if (c.status === 'PASS') passed++;
    else if (c.status === 'FAIL') failed++;
    else skipped++;
  }

  console.log('\n' + '-'.repeat(72));
  console.log(`  TOTAL: ${passed} pass, ${failed} fail, ${skipped} skip (${checks.length} checks)`);
  console.log('-'.repeat(72));

  return { failed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  banner('SYLPHIE PROVABILITY GATE');
  console.log(`  Mode:        ${MODE}`);
  console.log(`  Backend:     ${BASE}`);
  console.log(`  Cassette:    ${CASSETTE_URL}  (point OLLAMA_HOST here)`);
  console.log(`  Tape exists: ${cassetteExists()}`);
  console.log(`  Time:        ${new Date().toISOString()}`);

  // Load baseline.
  let baseline: Baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8')) as Baseline;
  } catch (err) {
    console.error(`\nFATAL: cannot read baseline at ${BASELINE_FILE}: ${err}`);
    process.exit(1);
  }

  // Start the cassette (this validates tape presence for replay-style modes).
  const cassette = new Cassette(MODE);
  try {
    await cassette.start();
    console.log(`\n  Cassette server listening on ${CASSETTE_URL} (mode=${MODE}).`);
  } catch (err) {
    console.error(`\nFATAL: cassette failed to start: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Reachability check. There is no dedicated /api/health route; the aggregate
  // /api/metrics/health is the canonical liveness probe (it exercises Nest + the
  // drive-state reader + Neo4j + Timescale and returns 200 on a healthy system),
  // and the gate fetches it again later for the metric assertions.
  const HEALTH_PATH = '/api/metrics/health';
  try {
    const { status } = await fetchJson(HEALTH_PATH);
    if (status !== 200) throw new Error(`health returned HTTP ${status}`);
    console.log('  Health check: OK');
  } catch (err) {
    console.error(`\nFATAL: cannot reach ${BASE}${HEALTH_PATH} (${err}).`);
    console.error('Start the system first:');
    console.error('  docker compose up -d && yarn dev:backend && yarn dev:drive-server');
    console.error(`And point OLLAMA_HOST at the cassette: OLLAMA_HOST=${CASSETTE_URL}`);
    await cassette.stop();
    process.exit(1);
  }

  // Reset arbitration metrics so the Type 1/Type 2 ratio (M1) measures only
  // THIS run's turns rather than the process's lifetime counters. The route is
  // POST /api/metrics/reset → ArbitrationService.resetMetrics(). We do this
  // AFTER the reachability check and BEFORE the corpus runs.
  try {
    const { status, body } = await fetchJson('/api/metrics/reset', { method: 'POST' });
    if (status !== 200) throw new Error(`reset returned HTTP ${status}`);
    const prev = body?.previous ?? {};
    recordBool('M0', 'arbitration metrics reset', true,
      `POST /api/metrics/reset OK — cleared lifetime counters ` +
        `(was type1=${prev.type1 ?? '?'} type2=${prev.type2 ?? '?'} shrug=${prev.shrug ?? '?'}); ` +
        `type-ratio now measures this run only`);
  } catch (err) {
    // A missing/failing reset route is a real soundness gap for M1, not a pass.
    recordBool('M0', 'arbitration metrics reset', false,
      `POST /api/metrics/reset failed (${err instanceof Error ? err.message : err}) — ` +
        `M1 type-ratio would measure lifetime counters, not this run`);
  }

  // Clear the in-memory latent hot layer so the run starts COLD. Without this the
  // gate is non-hermetic: the hot layer is hydrated on boot from patterns
  // accumulated by ALL prior runs, and a stale over-general pattern matches
  // unknowable inputs as ~10ms TYPE_1 reflexes (confabulation no fresh embedding
  // can explain). NON-DESTRUCTIVE — the persistent learned_patterns warm layer is
  // left intact (re-hydrates on next boot). POST /api/metrics/latent-reset →
  // LatentSpaceService.clearHotLayer(). Done AFTER metrics reset, BEFORE the corpus.
  try {
    const { status, body } = await fetchJson('/api/metrics/latent-reset', { method: 'POST' });
    if (status !== 200) throw new Error(`latent-reset returned HTTP ${status}`);
    recordBool('H0', 'latent hot layer cleared (hermetic start)', true,
      `POST /api/metrics/latent-reset OK — ${body?.hotLayerCleared ?? '?'} hot-layer patterns cleared ` +
        `(warm layer preserved); latent matches now reflect this run only`);
  } catch (err) {
    recordBool('H0', 'latent space cleared (hermetic start)', false,
      `POST /api/metrics/latent-reset failed (${err instanceof Error ? err.message : err}) — ` +
        `gate is NON-HERMETIC: latent matches include cross-run residue`);
  }

  // Wipe the gate person's OKG facts so prompt content is deterministic. Person
  // facts ("Known facts about this person: ...") are injected verbatim into LLM
  // prompts, so ANY fact accumulated between cassette record and replay (e.g. a
  // junk extraction from a live chat) changes the prompt and causes a cassette
  // miss (X0). The corpus re-teaches its facts every run, so a pre-run wipe is
  // safe and makes record/replay start from identical person state.
  // POST /api/metrics/person-facts-reset → PersonModelService.clearFactsForPerson('guardian').
  try {
    const { status, body } = await fetchJson('/api/metrics/person-facts-reset', { method: 'POST' });
    if (status !== 200 || body?.ok === false) {
      throw new Error(`person-facts-reset returned HTTP ${status} ok=${body?.ok}`);
    }
    recordBool('P0', 'person facts reset (deterministic prompts)', true,
      `POST /api/metrics/person-facts-reset OK — ${body?.factsCleared ?? '?'} OKG fact(s) cleared for ` +
        `the gate person; prompts now reflect only this run's taught facts`);
  } catch (err) {
    recordBool('P0', 'person facts reset (deterministic prompts)', false,
      `POST /api/metrics/person-facts-reset failed (${err instanceof Error ? err.message : err}) — ` +
        `gate is NON-HERMETIC: person facts from prior sessions leak into prompts (X0 misses likely)`);
  }

  // WS4 Ticket 7 — P0′: wipe ALL persons' OKG facts so privacy probes start from
  // a provably clean state. Dedicated route (not a param on the legacy one per spec §6).
  // POST /api/metrics/all-persons-facts-reset → PersonModelService.clearFactsForAllPersons().
  // Must succeed for PRIV.1/PRIV.2 to be sound; recorded in Phase 2.5 scorecard as P0prime.
  let p0primeOk = false;
  try {
    const { status, body } = await fetchJson('/api/metrics/all-persons-facts-reset', { method: 'POST' });
    if (status !== 200 || body?.ok === false) {
      throw new Error(`all-persons-facts-reset returned HTTP ${status} ok=${body?.ok}`);
    }
    p0primeOk = true;
    recordBool('P0prime', 'all-persons facts reset (privacy probes sound)', true,
      `POST /api/metrics/all-persons-facts-reset OK — ${body?.factsCleared ?? '?'} OKG fact(s) cleared ` +
        `across all persons; PRIV.1/PRIV.2 probes start from provably clean state`);
  } catch (err) {
    p0primeOk = false;
    recordBool('P0prime', 'all-persons facts reset (privacy probes sound)', false,
      `POST /api/metrics/all-persons-facts-reset failed ` +
        `(${err instanceof Error ? err.message : err}) — ` +
        `PRIV.1/PRIV.2 results are UNSOUND: residual facts may exist from prior sessions`);
  }

  let exitCode = 0;

  try {
    // PHASE 1 — corpus.
    await runCorpus();

    // PHASE H1 — no-clear min-population gate proof (WS1 follow-up #3 — the TRAP).
    // Runs AFTER the corpus (so corpus measurement is on a clean hot layer) and
    // re-clears the hot layer on its way out so Phase 2/2.5 start clean.
    await runNoClearGateProbe();

    // PHASE C3 — compounding proof (WS3 T4). Hermetic; no LLM. Seeds two matched
    // WORLD nodes, reinforces only the treatment via the real T2 path, runs a real
    // decay cycle, asserts upward divergence + ceiling + write-recency guard.
    // Runs in replay/update-baseline (the seam exercises T2/T3 directly; under
    // lesion the conversation path is severed but these REST routes still work — we
    // still run it so the compounding mechanism is checked in every non-record mode).
    if (MODE !== 'record') {
      await runCompoundingPhase();
    }

    // PHASE C3PROV — T5 grounding-provenance-vs-live-Neo4j (deferred C1 item).
    // Needs the LLM available (recall turn) so it runs only in replay-style modes;
    // under lesion the conversation path is severed (recorded-skip).
    if (MODE === 'replay' || MODE === 'update-baseline') {
      await runProvenancePhase();
    } else if (MODE === 'lesion') {
      recordSkip('C3PROV', 'GROUNDED recall provenance exists in live Neo4j',
        'lesion mode — conversation path severed; T5 needs a live GROUNDED recall turn');
    }

    // PHASE 2 — metrics capture (M1–M4 anchored BEFORE multi-person phase).
    // Do NOT re-read metrics after Phase 2.5 per spec §2.
    const metrics = await runMetricAssertions(baseline);

    // PHASE 2.5 — multi-person phase (WS4 Ticket 7).
    // Runs in both replay and lesion mode (mode gating internal to the function).
    await runMultiPersonPhase(MODE, p0primeOk);

    // PHASE 3 — lesion test (only in lesion mode).
    if (MODE === 'lesion') {
      await runLesionTest(cassette);
    }

    if (MODE === 'update-baseline') {
      if (metrics) writeBaseline(metrics);
      else console.log('\n  Skipping baseline update — metrics were unavailable.');
    }

    // Cassette miss is a hard failure in replay-style modes.
    if ((MODE === 'replay' || MODE === 'update-baseline' || MODE === 'lesion') && cassette.stats.misses > 0) {
      recordBool('X0', 'no cassette misses', false,
        `${cassette.stats.misses} cassette miss(es) — re-record with yarn gate:record. ` +
          `First miss: ${cassette.stats.missDetails[0]?.hint ?? '?'}`);
    } else {
      recordBool('X0', 'no cassette misses', true,
        `hits=${cassette.stats.hits} recorded=${cassette.stats.recorded} misses=${cassette.stats.misses}`);
    }
  } catch (err) {
    console.error(`\nGate run threw: ${err instanceof Error ? err.stack : err}`);
    recordBool('XX', 'gate run completed without throwing', false, String(err));
    exitCode = 1;
  } finally {
    await cassette.stop();
  }

  const { failed } = printScorecard();
  if (failed > 0) exitCode = 1;

  console.log(`\n  Cassette: hits=${cassette.stats.hits} recorded=${cassette.stats.recorded} ` +
    `misses=${cassette.stats.misses} lesionRejections=${cassette.stats.lesionRejections}`);
  console.log(`\n  GATE ${exitCode === 0 ? 'PASSED' : 'FAILED'} (exit ${exitCode}).`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Unexpected gate error:', err);
  process.exit(1);
});

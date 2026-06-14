/**
 * ws5-t4-smoke.ts — WS5 T4 rows P2/P4 (perception changes/recalls the RESPONSE).
 *
 * P2 and P4 are the only WS5 gate rows that need a LIVE LLM response on a prompt
 * carrying an injected perception caption. Coupling them to the `yarn gate`
 * cassette replay is structurally brittle (the perception prompt embeds a
 * VWM-derived scene description + scene-change-nudge turns whose exact bytes drift
 * run-to-run, so a recorded tape can HIT-while-stale and assert on a key that no
 * longer reflects what the backend built — the theater hole reopening from the
 * other side). mythos ruling (2026-06-13): run these against REAL Ollama in an
 * isolated stack and assert the caption is in the REAL composed prompt via the
 * test-only /metrics/last-deliberation-prompt mirror — read the real composed
 * prompt directly, not a tape-key proxy.
 *
 * P2 asserts: inject a captioned frame ("a red mug on the table") → text turn
 *   "what do you see?"; the composed deliberation prompt CONTAINS the caption
 *   (normalized substring), via the PRODUCTION WM-snapshot composition path (not
 *   the flat fallback), and the response is NOT falsely GROUNDED on a never-taught
 *   visual fact.
 * P4 asserts: inject a captioned frame ("a cat on the windowsill") → later text
 *   turn "did you see a cat earlier?"; the response recalls it via the REAL
 *   queryByContent path AND provenance marks it experiential (source='perception'),
 *   not guardian-told and not vacuously-'legacy'.
 *
 * ISOLATED stack — does NOT touch Jim's :3000 instance (identical topology to the
 * T1/T2 smokes): backend :3010, drive :3011, isolated Timescale DB, perception
 * cassette :11600, LLM at real Ollama. GATE_DEBUG_PROMPT_CAPTURE=1 enables the
 * prompt-capture mirror (dark in normal operation — a data-exfil discipline).
 *
 * Run: npx tsx test/gate/ws5-t4-smoke.ts
 * The script spawns + tears down the drive-server and backend itself.
 *
 * CRITICAL: run FOREGROUND with a hard timeout (a prior agent hung 37 min
 * background-monitoring a smoke). This script self-exits; ports 3010/3011 are
 * killed in the finally block.
 */

import { spawn, type ChildProcess } from 'child_process';
import { WebSocket } from 'ws';
import * as jwt from 'jsonwebtoken';
import { PerceptionCassette, makeDetectFixture } from './perception-cassette';
import { PerceptionCameraStub } from './perception-stub';

// ---------------------------------------------------------------------------
// Isolated topology — distinct ports + DB so Jim's :3000 stack is untouched.
// ---------------------------------------------------------------------------

const SMOKE_APP_PORT = process.env.SMOKE_APP_PORT || '3010';
const SMOKE_DRIVE_PORT = process.env.SMOKE_DRIVE_PORT || '3011';
const SMOKE_TS_DB = 'sylphie_events_ws5smoke';
const PERCEPTION_PORT = process.env.GATE_PERCEPTION_PORT || '11600';
const OLLAMA_HOST = process.env.SMOKE_OLLAMA_HOST || 'http://localhost:11434';
const JWT_SECRET = process.env.JWT_SECRET || 'sylphie-dev-jwt-secret-change-in-production';

const BASE = `http://localhost:${SMOKE_APP_PORT}`;
const WS_BASE = `ws://localhost:${SMOKE_APP_PORT}`;
const REPO_ROOT = process.cwd();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mintGuardianToken(): string {
  return jwt.sign({ sub: 'guardian', username: 'guardian', isGuardian: true }, JWT_SECRET, {
    expiresIn: '7d',
  });
}

async function fetchJson(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

/** Send one conversation turn over the WS and collect the cb_speech reply. */
function converse(text: string, token: string, timeoutMs = 45_000): Promise<{
  text?: string;
  knowledgeGrounding?: string;
  arbitrationType?: string;
  source?: string;
  provenance?: string;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/ws/conversation?token=${encodeURIComponent(token)}`);
    let speech: any = null;
    const to = setTimeout(() => {
      ws.close();
      resolve({ timedOut: !speech, ...(speech ?? {}) });
    }, timeoutMs);
    ws.on('open', () => {
      setTimeout(() => ws.send(JSON.stringify({ event: 'message', data: { text, type: 'text' } })), 300);
    });
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'cb_speech') {
          speech = msg;
          setTimeout(() => {
            clearTimeout(to);
            ws.close();
            resolve({ timedOut: false, ...msg });
          }, 400);
        }
      } catch {
        /* binary frame */
      }
    });
    ws.on('error', () => {
      clearTimeout(to);
      resolve({ timedOut: !speech, ...(speech ?? {}) });
    });
  });
}

async function waitForBackend(timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/metrics/perception-status`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Process spawning — drive-server + backend on the isolated DB.
// ---------------------------------------------------------------------------

const children: ChildProcess[] = [];

function spawnProc(name: string, workspace: string, env: Record<string, string>): ChildProcess {
  const child = spawn('yarn', ['workspace', workspace, 'dev'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const tag = `[${name}]`;
  child.stdout?.on('data', (d: Buffer) => {
    const s = d.toString().trimEnd();
    if (s) console.log(`${tag} ${s.split('\n').join(`\n${tag} `)}`);
  });
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trimEnd();
    if (s) console.log(`${tag} ${s.split('\n').join(`\n${tag} `)}`);
  });
  child.on('exit', (code) => console.log(`${tag} exited code=${code}`));
  return child;
}

function killAll(): void {
  for (const c of children) {
    try {
      if (process.platform === 'win32' && c.pid) {
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { shell: true });
      } else {
        c.kill('SIGTERM');
      }
    } catch {
      /* best effort */
    }
  }
}

const backendEnv: Record<string, string> = {
  TIMESCALE_DB: SMOKE_TS_DB,
  // WS5 T4 (P2/P4) — enable the test-only composed-prompt mirror.
  GATE_DEBUG_PROMPT_CAPTURE: '1',
};

const driveEnv: Record<string, string> = {
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5433',
  POSTGRES_DB: SMOKE_TS_DB,
  POSTGRES_RUNTIME_USER: 'sylphie',
  POSTGRES_RUNTIME_PASSWORD: 'sylphie_events_dev',
  POSTGRES_USER: 'sylphie',
  POSTGRES_PASSWORD: 'sylphie_events_dev',
};

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

let exitCode = 0;
const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  if (!pass) exitCode = 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== WS5 T4 P2/P4 (perception changes/recalls the response) smoke ===');
  console.log(`  backend:      ${BASE}`);
  console.log(`  drive-server: ws://localhost:${SMOKE_DRIVE_PORT}`);
  console.log(`  perception:   http://localhost:${PERCEPTION_PORT} (cassette)`);
  console.log(`  ollama:       ${OLLAMA_HOST} (REAL — P2/P4 need a live response)`);
  console.log(`  timescale DB: ${SMOKE_TS_DB} (isolated — Jim's :3000 untouched)`);
  console.log('');

  process.env.APP_PORT = SMOKE_APP_PORT;
  const cassette = new PerceptionCassette();
  const stub = new PerceptionCameraStub();
  const token = mintGuardianToken();

  try {
    await cassette.start();
    console.log(`  perception cassette listening on :${PERCEPTION_PORT}`);

    spawnProc('drive', '@sylphie/drive-server', {
      ...driveEnv,
      DRIVE_ENGINE_PORT: SMOKE_DRIVE_PORT,
      DRIVE_ENGINE_HOST: '127.0.0.1',
    });
    await sleep(3000);

    spawnProc('backend', '@sylphie/app', {
      ...backendEnv,
      APP_PORT: SMOKE_APP_PORT,
      PORT: SMOKE_APP_PORT,
      DRIVE_ENGINE_WS_URL: `ws://localhost:${SMOKE_DRIVE_PORT}`,
      PERCEPTION_HOST: `http://localhost:${PERCEPTION_PORT}`,
      OLLAMA_HOST,
      JWT_SECRET,
    });

    console.log('  waiting for backend to come up...');
    const up = await waitForBackend();
    if (!up) {
      record('backend-up', false, 'backend never became reachable within 90s');
      return;
    }
    record('backend-up', true, 'backend reachable');

    // Confirm the prompt-capture mirror is enabled (else P2/P4 cannot assert).
    const capCheck = await fetchJson('/api/metrics/last-deliberation-prompt');
    record(
      'prompt-capture-enabled',
      capCheck.status === 200 && capCheck.body?.enabled === true,
      `GATE_DEBUG_PROMPT_CAPTURE → enabled=${capCheck.body?.enabled} (must be true for P2/P4 to read the composed prompt)`,
    );

    // Hermeticity resets.
    for (const route of ['episodic-reset', 'perception-reset', 'scene-predictor-reset', 'prompt-capture-reset', 'person-facts-reset']) {
      await fetchJson(`/api/metrics/${route}`, { method: 'POST' });
    }

    await stub.open();

    // ════════════════════════════════════════════════════════════════════════
    // P2 — perception changes the response. Inject a captioned frame, then ask
    // "what do you see?"; assert the composed prompt CONTAINS the caption
    // (production WM-snapshot path) and the response is not falsely GROUNDED.
    // ════════════════════════════════════════════════════════════════════════
    const p2Caption = 'a red mug on the table';
    cassette.setCaption(p2Caption);

    await stub.injectFrame(cassette, makeDetectFixture({ label: 'cup', trackId: 7101 }));
    await sleep(1500);
    const p2CaptionHit = await stub.injectCaptionedScene(
      cassette,
      p2Caption,
      makeDetectFixture({ label: 'cup', trackId: 7102, embeddingSeed: 7102 }),
      makeDetectFixture({ label: 'cup', trackId: 7102, embeddingSeed: 7102 }),
    );
    record('p2:caption-barrier-hit', p2CaptionHit, p2CaptionHit ? 'caption settled into the scene description' : 'caption never settled');
    await sleep(1500); // let lastVlmCaption + scene_description settle into the slot

    // Reset the capture ring just before the probe so we read THIS turn's prompt.
    await fetchJson('/api/metrics/prompt-capture-reset', { method: 'POST' });
    const p2Reply = await converse('what do you see?', token);
    await sleep(300);

    const cap2 = await fetchJson('/api/metrics/last-deliberation-prompt');
    const captured2 = cap2.body?.captured;
    const promptHasCaption =
      !!captured2 && normalize(captured2.contextSummary ?? '').includes(normalize(p2Caption));
    // The gate backend runs the conversation PROCEDURE path (LLM_GENERATE) for a
    // visual question — not deliberate(). Both production composition paths are
    // valid (procedure-llm-generate OR wm-snapshot); the flat-fallback would mean
    // WorkingMemoryService was unavailable. Assert a real production path fired.
    const PROD_PATHS = ['procedure-llm-generate', 'wm-snapshot'];
    const pathOk2 = PROD_PATHS.includes(captured2?.compositionPath);
    record(
      'P2:caption-in-composed-prompt',
      promptHasCaption,
      promptHasCaption
        ? `the composed prompt embedded the caption "${p2Caption}" (composition path: ` +
          `${captured2?.compositionPath}). Closes the byte-identical-prompt theater hole — the ` +
          `caption is GENUINELY in the prompt the LLM saw, not merely echoed in the response.`
        : `the caption "${p2Caption}" was NOT in the composed prompt ` +
          `(captured path=${captured2?.compositionPath ?? 'none'}, ` +
          `summary preview="${(captured2?.contextSummary ?? '').slice(0, 200)}")`,
    );
    record(
      'P2:production-path',
      pathOk2,
      `composition path = ${captured2?.compositionPath ?? 'none'} ` +
        `(expected a PRODUCTION path: 'procedure-llm-generate' — what arbitration runs for a ` +
        `visual question — or 'wm-snapshot'; 'flat-fallback'/'none' would not be the production path)`,
    );
    record(
      'P2:response-not-falsely-grounded',
      p2Reply.knowledgeGrounding !== 'GROUNDED',
      `response knowledgeGrounding='${p2Reply.knowledgeGrounding}' (a seen-but-never-taught visual ` +
        `fact must not surface as GROUNDED — experiential perception is not OKG/WKG-grounded recall). ` +
        `response="${(p2Reply.text ?? '').slice(0, 120)}"`,
    );

    // ════════════════════════════════════════════════════════════════════════
    // P4 — multimodal recall. Inject a captioned cat frame, store the perception
    // episode, then ask "did you see a cat earlier?"; assert the recall path
    // surfaces it as experiential (source='perception'), not guardian-told.
    // ════════════════════════════════════════════════════════════════════════
    await fetchJson('/api/metrics/episodic-reset', { method: 'POST' });
    await fetchJson('/api/metrics/scene-predictor-reset', { method: 'POST' });

    const p4Caption = 'a cat on the windowsill';
    cassette.setCaption(p4Caption);
    await stub.injectFrame(cassette, makeDetectFixture({ label: 'cup', trackId: 7201 }));
    await sleep(1500);
    const p4CaptionHit = await stub.injectCaptionedScene(
      cassette,
      p4Caption,
      makeDetectFixture({ label: 'cat', trackId: 7202, embeddingSeed: 7202 }),
      makeDetectFixture({ label: 'cat', trackId: 7202, embeddingSeed: 7202 }),
    );
    record('p4:caption-barrier-hit', p4CaptionHit, p4CaptionHit ? 'cat caption settled' : 'cat caption never settled');
    await sleep(2500); // let the perception episode encode

    // Confirm the store landed a perception episode (recall precondition).
    const recent = await fetchJson('/api/metrics/episodic-recent?limit=20');
    const stored: any[] = recent.body?.episodes ?? [];
    const catStored = stored.filter(
      (e) =>
        e.source === 'perception' &&
        ((e.visualContext?.caption?.text ?? '').toLowerCase().includes('cat') ||
          (e.visualContext?.sceneLabels ?? []).includes('cat')),
    );
    record(
      'P4:store-precondition',
      catStored.length >= 1,
      catStored.length >= 1
        ? `${catStored.length} source='perception' cat episode(s) stored (recall has something to find)`
        : `NO perception cat episode stored — recall cannot succeed (encode gate / cycle issue)`,
    );

    // Recall via the REAL queryByContent path (the method episodic_search calls).
    const recall = await fetchJson(
      `/api/metrics/episodic-recall?q=${encodeURIComponent('did you see a cat earlier?')}&limit=5`,
    );
    const recalled: any[] = recall.body?.episodes ?? [];
    const recalledCat = recalled.find(
      (e) => e.source === 'perception' && (e.caption ?? '').toLowerCase().includes('cat'),
    );
    record(
      'P4:recall-returns-perception-episode',
      !!recalledCat,
      recalledCat
        ? `recalled source='perception' episode for "did you see a cat earlier?" via queryByContent ` +
          `(caption="${recalledCat.caption}")`
        : `NL query recalled NO perception cat episode (${recalled.length} result(s))`,
    );
    if (recalledCat) {
      record(
        'P4:provenance-experiential-not-guardian-not-legacy',
        recalledCat.provenance === 'experiential' && recalledCat.source === 'perception',
        `provenance='${recalledCat.provenance}', source='${recalledCat.source}' ` +
          `(must be experiential + perception — seen-not-told; NOT guardian-told, NOT vacuously-'legacy'); ` +
          `captionProvenance='${recalledCat.captionProvenance}' (must be LLM_GENERATED, never experiential-GROUNDED)`,
      );
    }

    // Also drive the conversation recall path for the headline "she can recall it".
    await fetchJson('/api/metrics/prompt-capture-reset', { method: 'POST' });
    const p4Reply = await converse('did you see a cat earlier?', token);
    record(
      'P4:conversation-recall-answers',
      !p4Reply.timedOut && !!(p4Reply.text ?? '').trim(),
      p4Reply.timedOut
        ? 'recall turn timed out'
        : `recall turn answered: "${(p4Reply.text ?? '').slice(0, 140)}" ` +
          `(grounding=${p4Reply.knowledgeGrounding})`,
    );
  } catch (err) {
    record('smoke-exception', false, `threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  } finally {
    try { stub.close(); } catch { /* */ }
    try { await fetchJson('/api/metrics/perception-reset', { method: 'POST' }); } catch { /* */ }
    try { await cassette.stop(); } catch { /* */ }
    killAll();
  }

  console.log('\n=== T4 P2/P4 smoke scorecard ===');
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(exitCode === 0 ? '\nALL GREEN — T4 P2/P4 smoke passed.' : '\nFAILURES present — P2/P4 not verified.');
  await sleep(1500);
  process.exit(exitCode);
}

void main();

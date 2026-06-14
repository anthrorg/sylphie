/**
 * ws5-t2-smoke.ts — WS5 T2 multimodal episodic RECALL forcing smoke.
 *
 * Builds directly on the T1.0 forcing smoke (ws5-t1-smoke.ts): T1 proved a
 * salient captioned frame stores a `source='perception'` episode carrying
 * visualContext.caption (LLM_GENERATED) + sceneLabels (SENSOR). T2 proves that
 * episode is now RECALLABLE BY CONTENT — "did you see a mug earlier?" — through
 * the REAL queryByContent path the `episodic_search` tool calls, with honest
 * per-episode provenance.
 *
 * What this asserts that T1 did not:
 *   - the NL query reaches queryByContent un-fingerprinted and matches the
 *     visual episode on CONTENT tokens (caption + sceneLabels + inputSummary),
 *     NOT the SHA fingerprint (which an NL query can never match);
 *   - the recalled episode surfaces source='perception' → provenance
 *     'experiential' (seen-not-told), while its caption surfaces tagged
 *     LLM_GENERATED — NEVER experiential-GROUNDED (CANON Std 1, Theater
 *     Prohibition);
 *   - a wrong-noun query ("did you see a dog earlier?") does NOT recall the mug
 *     episode (the content threshold actually discriminates — not vacuously green).
 *
 * ISOLATED stack — does NOT touch Jim's :3000 instance (identical topology to
 * the T1 smoke): backend :3010, drive :3011, isolated Timescale DB, perception
 * cassette :11600, LLM at real Ollama. Synthetic WORLD nodes self-clean via
 * perception-reset. Reuses the fixed LAZY-port stub (APP_PORT set BEFORE
 * constructing the stub).
 *
 * Run: npx tsx test/gate/ws5-t2-smoke.ts
 * The script spawns + tears down the drive-server and backend itself.
 *
 * CRITICAL: run FOREGROUND with a hard timeout (a prior agent hung 37 min
 * background-monitoring a smoke). This script self-exits; ports 3010/3011 are
 * killed in the finally block.
 */

import { spawn, type ChildProcess } from 'child_process';
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

const BASE = `http://localhost:${SMOKE_APP_PORT}`;
const REPO_ROOT = process.cwd();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
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

function spawnProc(
  name: string,
  workspace: string,
  env: Record<string, string>,
): ChildProcess {
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

// Only the Timescale events DB is isolated (so episodic-reset/perception-reset
// TRUNCATEs hit the smoke DB, never Jim's). Same rationale as the T1 smoke.
const backendEnv: Record<string, string> = {
  TIMESCALE_DB: SMOKE_TS_DB,
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

function sumPressure(drivesBody: any): number {
  if (!drivesBody) return 0;
  const pv = drivesBody.pressureVector ?? drivesBody.drives ?? drivesBody;
  if (Array.isArray(pv)) return pv.reduce((s: number, v: any) => s + (typeof v === 'number' ? v : (v?.pressure ?? v?.value ?? 0)), 0);
  if (typeof pv === 'object') {
    return Object.values(pv).reduce((s: number, v: any) => s + (typeof v === 'number' ? v : (v?.pressure ?? v?.value ?? 0)), 0);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== WS5 T2 multimodal RECALL forcing smoke ===');
  console.log(`  backend:      ${BASE}`);
  console.log(`  drive-server: ws://localhost:${SMOKE_DRIVE_PORT}`);
  console.log(`  perception:   http://localhost:${PERCEPTION_PORT} (cassette)`);
  console.log(`  ollama:       ${OLLAMA_HOST}`);
  console.log(`  timescale DB: ${SMOKE_TS_DB} (isolated — Jim's :3000 untouched)`);
  console.log('');

  // Set APP_PORT BEFORE constructing the stub (lazy-port stub reads it at call
  // time; this is the belt-and-suspenders ordering — never regress it).
  process.env.APP_PORT = SMOKE_APP_PORT;
  const cassette = new PerceptionCassette();
  const stub = new PerceptionCameraStub();

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
    });

    console.log('  waiting for backend to come up...');
    const up = await waitForBackend();
    if (!up) {
      record('backend-up', false, 'backend never became reachable within 90s');
      return;
    }
    record('backend-up', true, 'backend reachable');

    // Hermeticity resets (episodic + perception + scene predictor).
    for (const route of ['episodic-reset', 'perception-reset', 'scene-predictor-reset']) {
      const { status } = await fetchJson(`/api/metrics/${route}`, { method: 'POST' });
      record(`reset:${route}`, status === 200, `status=${status}`);
    }

    // Confirm drive-cold BEFORE injecting — any encode is provably the salience
    // term (T1.0), not residual drive pressure.
    const drivesBefore = await fetchJson('/api/drives');
    const totalBefore = drivesBefore.body?.totalPressure ?? sumPressure(drivesBefore.body);
    record(
      'drive-cold-pre-inject',
      totalBefore < 4.0,
      `totalPressure=${totalBefore.toFixed(3)} (< IDLE_PRESSURE_THRESHOLD 4.0 required)`,
    );

    // --- STORE: inject a captioned salient frame → source='perception' episode ---
    await stub.open();

    const caption = 'a red mug on the windowsill';
    cassette.setCaption(caption);

    // Prime frame (baseline object) so OBJECT_APPEARED fires deterministically on
    // the novel frame (T1-smoke pattern).
    await stub.injectFrame(cassette, makeDetectFixture({ label: 'cup', trackId: 401 }));
    await sleep(1500);

    // Caption-settle barrier + novel object: stores the captioned perception episode.
    const captionHit = await stub.injectCaptionedScene(
      cassette,
      caption,
      makeDetectFixture({ label: 'bottle', trackId: 402, embeddingSeed: 999 }),
      makeDetectFixture({ label: 'bottle', trackId: 402, embeddingSeed: 999 }),
    );
    record('caption-barrier-hit', captionHit, captionHit ? 'caption endpoint hit during settle' : 'caption never hit');

    await sleep(2500); // let the nudged cycle + episodic encode land

    // Confirm the store actually landed a perception episode (precondition for recall).
    const recent = await fetchJson('/api/metrics/episodic-recent?limit=20');
    const storedEps: any[] = recent.body?.episodes ?? [];
    const perceptionStored = storedEps.filter((e) => e.source === 'perception');
    record(
      'store:perception-episode',
      perceptionStored.length >= 1,
      perceptionStored.length >= 1
        ? `${perceptionStored.length} source='perception' episode(s) stored (recall precondition met)`
        : `NO perception episode stored — recall has nothing to find (T1.0 not satisfied in this run)`,
    );
    if (perceptionStored.length >= 1) {
      console.log(
        `    stored: caption="${perceptionStored[0].visualContext?.caption?.text ?? '∅'}" ` +
          `labels=${JSON.stringify(perceptionStored[0].visualContext?.sceneLabels ?? [])}`,
      );
    }

    // --- RECALL: drive queryByContent with an NL query ("did you see a mug earlier?") ---
    // This hits the IDENTICAL method the episodic_search tool calls, with the live
    // drive snapshot as the query mood.
    const posQuery = 'did you see a mug earlier?';
    const posRecall = await fetchJson(
      `/api/metrics/episodic-recall?q=${encodeURIComponent(posQuery)}&limit=5`,
    );
    const recalled: any[] = posRecall.body?.episodes ?? [];
    console.log(`  recall("${posQuery}") returned ${recalled.length} episode(s):`);
    for (const ep of recalled) {
      console.log(
        `    - source=${ep.source} provenance=${ep.provenance} ` +
          `caption="${ep.caption ?? '∅'}" captionProvenance=${ep.captionProvenance ?? 'n/a'} ` +
          `labels=${JSON.stringify(ep.sceneLabels ?? [])}`,
      );
    }

    const recalledPerception = recalled.find((e) => e.source === 'perception');

    // Assertion 1 — the visual episode is RECALLED by content.
    record(
      'recall:visual-episode-returned',
      !!recalledPerception,
      recalledPerception
        ? `recalled a source='perception' episode for an NL query (content match worked)`
        : `NL query recalled NO perception episode — queryByContent did not match on content`,
    );

    if (recalledPerception) {
      // Assertion 2 — per-episode provenance is EXPERIENTIAL (seen-not-told).
      record(
        'recall:provenance-experiential',
        recalledPerception.provenance === 'experiential',
        `provenance='${recalledPerception.provenance}' (expected 'experiential' for source='perception')`,
      );

      // Assertion 3 — the caption surfaces tagged LLM_GENERATED, NEVER
      // experiential-GROUNDED (CANON Std 1, Theater Prohibition).
      const capProv = recalledPerception.captionProvenance;
      const captionPresent = typeof recalledPerception.caption === 'string' && recalledPerception.caption.length > 0;
      record(
        'recall:caption-LLM_GENERATED-not-grounded',
        captionPresent && capProv === 'LLM_GENERATED',
        captionPresent
          ? `caption="${recalledPerception.caption}" tagged captionProvenance='${capProv}' ` +
            `(must be LLM_GENERATED, never experiential-GROUNDED)`
          : `recalled perception episode had no caption to tag`,
      );

      // Assertion 3b — the episode-level provenance is NOT 'GROUNDED' and the
      // caption tier is distinct from the episode tier (no laundering).
      record(
        'recall:no-provenance-laundering',
        recalledPerception.provenance !== 'GROUNDED' && capProv !== 'experiential',
        `episode provenance='${recalledPerception.provenance}', caption tier='${capProv}' — ` +
          `caption tier must NOT be the experiential episode tier`,
      );
    }

    // Assertion 4 — DISCRIMINATION: a wrong-noun query must NOT recall the mug.
    const negQuery = 'did you see a dog earlier?';
    const negRecall = await fetchJson(
      `/api/metrics/episodic-recall?q=${encodeURIComponent(negQuery)}&limit=5`,
    );
    const negEpisodes: any[] = negRecall.body?.episodes ?? [];
    const negMatchedMug = negEpisodes.some(
      (e) => e.source === 'perception' && (e.caption ?? '').toLowerCase().includes('mug'),
    );
    record(
      'recall:discriminates-wrong-noun',
      !negMatchedMug,
      negMatchedMug
        ? `WRONG: "${negQuery}" recalled the mug episode — content threshold is vacuous`
        : `"${negQuery}" did NOT recall the mug episode (${negEpisodes.length} result(s)) — threshold discriminates`,
    );

    // Assertion 5 — rumination breaker is inspectable + cold (no spurious trip
    // from a handful of distinct-content recalls).
    const rum = await fetchJson('/api/metrics/rumination-state');
    const rumBody = rum.body ?? {};
    record(
      'recall:rumination-state-inspectable',
      rum.status === 200 && typeof rumBody.tripCount === 'number',
      `rumination-state: tripCount=${rumBody.tripCount} suppressRemaining=${rumBody.suppressRemaining} ` +
        `window=${rumBody.windowSize} congruent=${rumBody.congruentInWindow} distinct=${rumBody.distinctInWindow}`,
    );
  } catch (err) {
    record('smoke-exception', false, `threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  } finally {
    try { stub.close(); } catch { /* */ }
    try { await fetchJson('/api/metrics/perception-reset', { method: 'POST' }); } catch { /* */ }
    try { await cassette.stop(); } catch { /* */ }
    killAll();
  }

  console.log('\n=== T2 recall smoke scorecard ===');
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(exitCode === 0 ? '\nALL GREEN — T2 recall forcing smoke passed.' : '\nFAILURES present — T2 recall not verified.');
  await sleep(1500);
  process.exit(exitCode);
}

void main();

/**
 * ws5-t1-smoke.ts — WS5 T1.0 drive-cold forcing smoke (opus-agent build verify).
 *
 * THE FORCING TEST for T1.0: prove that a salient-but-CALM novel visual frame, on
 * a DRIVE-COLD backend (no conversation, all drives 0.0), is now stored as a
 * `source='perception'` episode carrying the injected caption/sceneLabels — which
 * it could NOT be before T1.0, because:
 *   (1) the encode-attention gate read drive-derived attention only, so a calm
 *       frame failed the 0.15 gate (fixed: attention = max(drives, saliencyTerm)),
 *   (2) a perception frame on a cold backend never even ran a cognitive cycle (the
 *       self-tick is pressure-gated at 4.0 and `scene` is not event-driven) — fixed
 *       by the gateway-side scene-change cycle nudge (mythos ruling, option (b)).
 *
 * This is a SEPARATE, ISOLATED stack — it does NOT touch Jim's :3000 instance:
 *   - fresh backend on APP_PORT (default 3010), fresh drive-server on 3011,
 *   - both pointed at an ISOLATED Timescale DB (sylphie_events_ws5smoke) so the
 *     episodic-reset / perception-reset TRUNCATEs never hit Jim's tables,
 *   - perception cassette on 11600 (PERCEPTION_HOST), LLM at real Ollama (11434).
 * The WORLD Neo4j is shared, but synthetic nodes are `synthetic:true`-scoped and
 * self-clean via perception-reset (T0.8) — Jim's real WORLD facts are untouched.
 *
 * Run: npx tsx test/gate/ws5-t1-smoke.ts
 * The script spawns + tears down the drive-server and backend itself.
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
  // Use yarn workspace dev scripts (ts-node) — never bare tsc. Inherit env +
  // the isolation overrides. stdout/stderr are tagged so the smoke log is legible.
  const child = spawn(
    'yarn',
    ['workspace', workspace, 'dev'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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
      // On Windows, kill the process tree.
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

// BACKEND isolation: ONLY the Timescale events DB is isolated (so episodic-reset
// and perception-reset TRUNCATEs hit the smoke DB, never Jim's). The backend's
// POSTGRES_* (sylphie_system — users, person model, guardian rules, WKG
// bootstrap) and Neo4j stay at the REAL stores: those tables/users live there,
// and the WORLD synthetic nodes are synthetic:true-scoped + self-clean.
const backendEnv: Record<string, string> = {
  TIMESCALE_DB: SMOKE_TS_DB,
};

// DRIVE-SERVER isolation: its POSTGRES_* (drive_state_checkpoint + rules) → the
// smoke Timescale DB on :5433 so it cold-starts with NO checkpoint (drive-cold)
// and never overwrites Jim's checkpoint. Rules absent → default affects (flat),
// which is the honest drive-cold condition the forcing test needs.
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
// Main
// ---------------------------------------------------------------------------

let exitCode = 0;
const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  if (!pass) exitCode = 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

async function main(): Promise<void> {
  console.log('=== WS5 T1.0 drive-cold forcing smoke ===');
  console.log(`  backend:      ${BASE}`);
  console.log(`  drive-server: ws://localhost:${SMOKE_DRIVE_PORT}`);
  console.log(`  perception:   http://localhost:${PERCEPTION_PORT} (cassette)`);
  console.log(`  ollama:       ${OLLAMA_HOST}`);
  console.log(`  timescale DB: ${SMOKE_TS_DB} (isolated — Jim's :3000 untouched)`);
  console.log('');

  // Set APP_PORT BEFORE constructing the stub so that any env-reads inside
  // stub module-level code or constructors see the correct isolated port.
  // (perception-stub.ts defers its port lookup to call time, but this order
  // is the defensive belt-and-suspenders: smoke-port is always set first.)
  process.env.APP_PORT = SMOKE_APP_PORT;
  const cassette = new PerceptionCassette();
  const stub = new PerceptionCameraStub();

  try {
    // 1. Perception cassette up.
    await cassette.start();
    console.log(`  perception cassette listening on :${PERCEPTION_PORT}`);

    // 2. Drive-server (isolated, cold) then backend (isolated).
    spawnProc('drive', '@sylphie/drive-server', {
      ...driveEnv,
      DRIVE_ENGINE_PORT: SMOKE_DRIVE_PORT,
      DRIVE_ENGINE_HOST: '127.0.0.1',
    });
    await sleep(3000); // let the drive-server bind before the backend connects

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

    // 3. Hermeticity resets (episodic + perception + scene predictor).
    for (const route of ['episodic-reset', 'perception-reset', 'scene-predictor-reset']) {
      const { status } = await fetchJson(`/api/metrics/${route}`, { method: 'POST' });
      record(`reset:${route}`, status === 200, `status=${status}`);
    }

    // 4. Confirm drive-cold BEFORE injecting — so any encode is provably the
    //    salience term, not residual drive pressure.
    const drivesBefore = await fetchJson('/api/drives');
    const totalBefore = drivesBefore.body?.totalPressure ?? sumPressure(drivesBefore.body);
    record(
      'drive-cold-pre-inject',
      totalBefore < 4.0,
      `totalPressure=${totalBefore.toFixed(3)} (< IDLE_PRESSURE_THRESHOLD 4.0 required)`,
    );

    // 5. Open the inbound camera socket.
    await stub.open();

    // 6. Inject a salient scene-CHANGE sequence (mythos T0-smoke redesign):
    //    prime frame establishes baseline (cold-start surprise 0, predictor
    //    seeds trackId 301), then a NOVEL confirmed object (trackId 302) fires
    //    OBJECT_APPEARED → hasSceneChange → cycle nudge → totalSurprise=1.0 →
    //    saliencyTerm=1.0 → encode gate (0.15) clears → source='perception'
    //    episode stored, WITH a caption settled in via the caption barrier.
    const caption = 'a red mug on the windowsill';
    cassette.setCaption(caption);

    // Prime frame (baseline object). Spaced past MIN_FRAME_INTERVAL_MS by the stub.
    await stub.injectFrame(cassette, makeDetectFixture({ label: 'cup', trackId: 301 }));
    // Let the first frame's scene-compare settle (establish predictedScene) before
    // novelty, so OBJECT_APPEARED fires deterministically on the novel frame.
    await sleep(1500);

    // Caption-settle barrier + novel object: arm-frame introduces trackId 302
    // (a NEW object → OBJECT_APPEARED), awaits the caption hit, then a second
    // frame carries lastVlmCaption into the composed scene description.
    const captionHit = await stub.injectCaptionedScene(
      cassette,
      caption,
      makeDetectFixture({ label: 'bottle', trackId: 302, embeddingSeed: 999 }),
      makeDetectFixture({ label: 'bottle', trackId: 302, embeddingSeed: 999 }),
    );
    record('caption-barrier-hit', captionHit, captionHit ? 'caption endpoint hit during settle' : 'caption never hit');

    // Give the nudged cycle + episodic encode time to land.
    await sleep(2500);

    // 7. Confirm drives STILL cold after injection (salience-only admission).
    const drivesAfter = await fetchJson('/api/drives');
    const totalAfter = drivesAfter.body?.totalPressure ?? sumPressure(drivesAfter.body);
    console.log(`  drive totalPressure after inject: ${totalAfter.toFixed(3)}`);

    // 8. Read the episode ring and assert a perception episode landed.
    const recent = await fetchJson('/api/metrics/episodic-recent?limit=20');
    const episodes: any[] = recent.body?.episodes ?? [];
    console.log(`  episodic-recent returned ${episodes.length} episode(s):`);
    for (const ep of episodes) {
      console.log(
        `    - source=${ep.source} action=${ep.actionTaken} ` +
          `caption=${ep.visualContext?.caption?.text ?? '∅'} ` +
          `labels=${JSON.stringify(ep.visualContext?.sceneLabels ?? [])} ` +
          `speakerIsGuardian=${ep.speakerIsGuardian ?? 'absent'}`,
      );
    }

    const perceptionEps = episodes.filter((e) => e.source === 'perception');
    record(
      'perception-episode-stored',
      perceptionEps.length >= 1,
      perceptionEps.length >= 1
        ? `${perceptionEps.length} source='perception' episode(s) stored`
        : `NO source='perception' episode — T1.0 NOT done (cycle never ran or gate never cleared)`,
    );

    if (perceptionEps.length >= 1) {
      const withCaption = perceptionEps.find(
        (e) => (e.visualContext?.caption?.text ?? '').includes('mug') ||
               (e.visualContext?.sceneLabels ?? []).some((l: string) => l === 'bottle' || l === 'cup'),
      );
      record(
        'perception-episode-has-visualContext',
        !!withCaption,
        withCaption
          ? `visualContext present: caption="${withCaption.visualContext?.caption?.text ?? '∅'}", ` +
            `labels=${JSON.stringify(withCaption.visualContext?.sceneLabels ?? [])}, ` +
            `caption.provenanceSource=${withCaption.visualContext?.caption?.provenanceSource ?? 'n/a'}`
          : 'perception episode present but missing injected caption/sceneLabels',
      );

      // T0.9: a synthetic/exogenous seen-fact must NEVER be guardian-told.
      const anyGuardian = perceptionEps.some((e) => e.speakerIsGuardian === true);
      record(
        't0.9-no-guardian-stamp',
        !anyGuardian,
        anyGuardian
          ? 'a perception episode set speakerIsGuardian=true (T0.9 VIOLATION)'
          : 'no perception episode is guardian-stamped (speakerIsGuardian structurally absent)',
      );
    }
  } catch (err) {
    record('smoke-exception', false, `threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  } finally {
    try { stub.close(); } catch { /* */ }
    // Final synthetic-node cleanup on the shared WORLD instance.
    try { await fetchJson('/api/metrics/perception-reset', { method: 'POST' }); } catch { /* */ }
    try { await cassette.stop(); } catch { /* */ }
    killAll();
  }

  console.log('\n=== T1.0 smoke scorecard ===');
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(exitCode === 0 ? '\nALL GREEN — T1.0 forcing smoke passed.' : '\nFAILURES present — T1.0 not verified.');
  // Give child-kill a beat, then exit.
  await sleep(1500);
  process.exit(exitCode);
}

function sumPressure(drivesBody: any): number {
  // /api/drives shape: tolerate a few likely shapes (pressureVector map or array).
  if (!drivesBody) return 0;
  const pv = drivesBody.pressureVector ?? drivesBody.drives ?? drivesBody;
  if (Array.isArray(pv)) return pv.reduce((s: number, v: any) => s + (typeof v === 'number' ? v : (v?.pressure ?? v?.value ?? 0)), 0);
  if (typeof pv === 'object') {
    return Object.values(pv).reduce((s: number, v: any) => s + (typeof v === 'number' ? v : (v?.pressure ?? v?.value ?? 0)), 0);
  }
  return 0;
}

void main();

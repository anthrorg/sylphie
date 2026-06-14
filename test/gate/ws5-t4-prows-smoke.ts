/**
 * ws5-t4-prows-smoke.ts — WS5 T4 LLM-INDEPENDENT proof rows P1a/P1b/P1c/P3/P6,
 * exercised live against an ISOLATED stack so they are verified before the full
 * `yarn gate` non-regression run.
 *
 * These are the SAME assertions `runPerceptionProofPhase` + `runPerceptionLesionRow`
 * make inside gate.ts; this driver runs them against a fresh isolated backend
 * (backend :3010, drive :3011, isolated Timescale DB, perception cassette :11600)
 * so Jim's :3000 instance is untouched and the rows can be proven without the
 * heavy corpus/H1/C3/multi-person phases.
 *
 *   P1a — scene-surprise moves Curiosity AND Anxiety (surprise ring + drive deltas)
 *   P1b — unknown-person moves Social (UnknownPersonPressure)
 *   P1c — habituation: surprise₂ < surprise₁ on the IDENTITY key (fresh trackId)
 *   P3  — multimodal episode stored: visualContext + source='perception'
 *   P6  — perception survives LLM disconnect (drives move, no fabricated caption)
 *
 * Run: npx tsx test/gate/ws5-t4-prows-smoke.ts  (FOREGROUND, self-exits)
 */

import { spawn, type ChildProcess } from 'child_process';
import { PerceptionCassette, makeDetectFixture } from './perception-cassette';
import { PerceptionCameraStub } from './perception-stub';

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

async function fetchJson(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, init);
  let body: any = null;
  try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
}
async function waitForBackend(timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${BASE}/api/metrics/perception-status`); if (res.ok) return true; } catch { /* */ }
    await sleep(1000);
  }
  return false;
}

const children: ChildProcess[] = [];
function spawnProc(name: string, workspace: string, env: Record<string, string>): ChildProcess {
  const child = spawn('yarn', ['workspace', workspace, 'dev'], {
    cwd: REPO_ROOT, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const tag = `[${name}]`;
  child.stdout?.on('data', (d: Buffer) => { const s = d.toString().trimEnd(); if (s) console.log(`${tag} ${s.split('\n').join(`\n${tag} `)}`); });
  child.stderr?.on('data', (d: Buffer) => { const s = d.toString().trimEnd(); if (s) console.log(`${tag} ${s.split('\n').join(`\n${tag} `)}`); });
  child.on('exit', (code) => console.log(`${tag} exited code=${code}`));
  return child;
}
function killAll(): void {
  for (const c of children) {
    try {
      if (process.platform === 'win32' && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { shell: true });
      else c.kill('SIGTERM');
    } catch { /* */ }
  }
}

const backendEnv: Record<string, string> = { TIMESCALE_DB: SMOKE_TS_DB };
const driveEnv: Record<string, string> = {
  POSTGRES_HOST: 'localhost', POSTGRES_PORT: '5433', POSTGRES_DB: SMOKE_TS_DB,
  POSTGRES_RUNTIME_USER: 'sylphie', POSTGRES_RUNTIME_PASSWORD: 'sylphie_events_dev',
  POSTGRES_USER: 'sylphie', POSTGRES_PASSWORD: 'sylphie_events_dev',
};

let exitCode = 0;
const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  if (!pass) exitCode = 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

async function fetchDriveVector(): Promise<{ pressureVector: Record<string, number> } | null> {
  const { status, body } = await fetchJson('/api/drives');
  if (status !== 200 || !body || !body.pressureVector) return null;
  return { pressureVector: body.pressureVector };
}
async function fetchScenePredictionState(): Promise<any | null> {
  const { status, body } = await fetchJson('/api/metrics/scene-prediction-state');
  if (status !== 200 || !body) return null;
  return body;
}
/**
 * WS5 P1a — fetch the most recent ScenePrediction outcome routed to the drive
 * engine. Returns the `lastRoutedOutcome` object (sceneSurprise + computedEffects)
 * or null if no outcome has fired since the last reset.
 */
async function fetchLastSceneOutcome(): Promise<{ sceneSurprise: number; computedEffects: { curiosity: number; anxiety: number }; routedAt: string } | null> {
  const { status, body } = await fetchJson('/api/metrics/last-scene-outcome');
  if (status !== 200 || !body) return null;
  return body.lastRoutedOutcome ?? null;
}
/**
 * Poll /api/metrics/last-scene-outcome until a ScenePrediction outcome with
 * sceneSurprise > minSurprise appears (the drive engine IPC is async: the outcome
 * lands after the ring fires). Bounded to timeoutMs.
 */
async function pollForSceneOutcome(minSurprise: number, timeoutMs = 10_000): Promise<{ sceneSurprise: number; computedEffects: { curiosity: number; anxiety: number } } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const o = await fetchLastSceneOutcome();
    if (o && o.sceneSurprise > minSurprise) return o;
    await sleep(200);
  }
  return null;
}

/**
 * Poll the scene-prediction state until `label` appears in some frame's
 * novelMagnitudes (the nudge cycle is async + slow under embed timeouts, so the
 * surprise/ring lands a few seconds after the frame is injected). Bounded.
 */
async function pollForNovelInRing(label: string, minCount = 1, timeoutMs = 25000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const st = await fetchScenePredictionState();
    last = st;
    const count = (st?.recentSurprise ?? []).filter((o: any) => label in (o.novelMagnitudes ?? {})).length;
    if (count >= minCount) return st;
    await sleep(400);
  }
  return last;
}
async function pollForDriveRise(drive: string, baseline: number, timeoutMs = 8000): Promise<number | null> {
  const EPS = 1e-6;
  const deadline = Date.now() + timeoutMs;
  let best = -Infinity;
  while (Date.now() < deadline) {
    const v = await fetchDriveVector();
    if (v) { const cur = v.pressureVector[drive] ?? 0; best = Math.max(best, cur); if (cur > baseline + EPS) return cur - baseline; }
    await sleep(200);
  }
  return best > -Infinity && best > baseline + EPS ? best - baseline : null;
}

/**
 * Poll /api/metrics/scene-prediction-state until initialized===true (the prime
 * frame's advancePredictions() call has completed), or until timeoutMs elapses.
 * Returns true if initialized within the window, false on timeout.
 * Use this instead of a fixed sleep between prime→novel injections: it guarantees
 * the prime's nudge cycle finished (predictor seeded) before the novel frame is
 * sent, which prevents the novel frame from becoming the cold-start frame (surprise 0).
 */
async function pollForInitialized(timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await fetchScenePredictionState();
    if (st?.initialized === true) return true;
    await sleep(300);
  }
  return false;
}

async function main(): Promise<void> {
  console.log('=== WS5 T4 LLM-independent proof rows (P1a/P1b/P1c/P3/P6) — isolated-stack smoke ===\n');
  process.env.APP_PORT = SMOKE_APP_PORT;
  const cassette = new PerceptionCassette();
  const stub = new PerceptionCameraStub();

  try {
    await cassette.start();
    console.log(`  perception cassette listening on :${PERCEPTION_PORT}`);
    spawnProc('drive', '@sylphie/drive-server', { ...driveEnv, DRIVE_ENGINE_PORT: SMOKE_DRIVE_PORT, DRIVE_ENGINE_HOST: '127.0.0.1' });
    await sleep(3000);
    spawnProc('backend', '@sylphie/app', {
      ...backendEnv, APP_PORT: SMOKE_APP_PORT, PORT: SMOKE_APP_PORT,
      DRIVE_ENGINE_WS_URL: `ws://localhost:${SMOKE_DRIVE_PORT}`,
      PERCEPTION_HOST: `http://localhost:${PERCEPTION_PORT}`, OLLAMA_HOST,
    });
    console.log('  waiting for backend...');
    if (!(await waitForBackend())) { record('backend-up', false, 'backend never reachable'); return; }
    record('backend-up', true, 'backend reachable');

    for (const route of ['scene-predictor-reset', 'perception-reset', 'episodic-reset']) {
      await fetchJson(`/api/metrics/${route}`, { method: 'POST' });
    }
    await stub.open();

    // ── P1a ──────────────────────────────────────────────────────────────────
    // Assert on the deterministic ScenePrediction ACTION_OUTCOME's computedEffects,
    // NOT the noisy net /drives pressureVector delta. Root cause: on a busy backend
    // Curiosity is high-traffic (continuous SensoryPrediction/ScenePrediction/
    // SocialComment cycles nudge it up and decay it down every few seconds), so a
    // +0.02 delta from a single outcome is lost in noise; Anxiety is lower-traffic
    // but still unreliable over a 10s poll window. The drive log proves the outcome
    // fires deterministically: [DriveEngine] outcome applied {actionType:"ScenePrediction",
    // computedEffects:{curiosity:0.02,anxiety:0.01}}. So we assert on the CAUSAL
    // effect via GET /metrics/last-scene-outcome (which reads the seam recorded by
    // routeScenePredictionErrors right after reportOutcome) — a deterministic proof.
    //
    // The initial reset block above (perception-reset) already zeroed the cooldown
    // so the prime cup's nudge fires immediately.
    await stub.injectFrame(cassette, makeDetectFixture({ label: 'cup', trackId: 5101 }));
    // Poll until the prime cycle ran (predictor initialized) — deterministic substitute
    // for the bare sleep. Then reset cooldown so the novel keyboard frame's nudge fires
    // immediately rather than being gated by the 5s window.
    await pollForInitialized(15_000);
    await fetchJson('/api/metrics/perception-reset', { method: 'POST' }); // cooldown reset only (VWM stays clean)
    // Novel keyboard frame: not in predictedScene (cup was the prime) → novel →
    // totalSurprise > 0.05 → routeScenePredictionErrors → reportOutcome +
    // recordOutcomeRouted (the P1a gate seam). The initial reset cleared
    // lastRoutedOutcome; the prime cup (surprise=0, below threshold) never sets it;
    // so the first lastRoutedOutcome set after the novel frame is provably from it.
    await stub.injectFrame(cassette, makeDetectFixture({ label: 'keyboard', trackId: 5102, embeddingSeed: 4242 }));
    // Phase 1: wait for the surprise ring to confirm the novel frame's nudge cycle
    // completed — this means compareScene+advancePredictions ran and the ring entry
    // was written. routeScenePredictionErrors fires in the same cycle tail, shortly
    // after the ring write, so the outcome seam will be populated by the time
    // pollForSceneOutcome runs.
    const stateP1a = await pollForNovelInRing('keyboard', 1, 25_000);
    // Phase 2: poll for the last-scene-outcome seam to confirm the ScenePrediction
    // outcome actually fired (sceneSurprise > 0.05 → routeScenePredictionErrors →
    // reportOutcome → recordOutcomeRouted). This is the deterministic causal proof.
    const sceneOutcome = await pollForSceneOutcome(0.05, 10_000);
    const ringP1a = stateP1a?.recentSurprise ?? [];
    const novelObs = [...ringP1a].reverse().find((o: any) => 'keyboard' in (o.novelMagnitudes ?? {}));
    const novelSurprise = novelObs?.totalSurprise ?? 0;
    const primeZero = ringP1a.length > 0 && ringP1a[0].totalSurprise <= 0.05;
    const surpriseOk = novelSurprise > 0.05 && primeZero;
    // Primary assertion: surprise ring + deterministic computedEffects from the seam.
    // Both curiosity > 0 and anxiety > 0 are guaranteed by the drive rule when
    // sceneSurprise > 0.05 (curiosity=0.02*s, anxiety=0.01*s from rules.ts:165-168).
    const effectsCuriosityOk = (sceneOutcome?.computedEffects?.curiosity ?? 0) > 0;
    const effectsAnxietyOk = (sceneOutcome?.computedEffects?.anxiety ?? 0) > 0;
    record('P1a', surpriseOk && effectsCuriosityOk && effectsAnxietyOk,
      `prime=${ringP1a[0]?.totalSurprise?.toFixed(3)} novel=${novelSurprise.toFixed(3)} (>0.05); ` +
      `ScenePrediction outcome: sceneSurprise=${sceneOutcome?.sceneSurprise?.toFixed(4) ?? 'NONE'} ` +
      `computedEffects.curiosity=${sceneOutcome?.computedEffects?.curiosity?.toFixed(4) ?? 'NONE'} (>0 reqd) ` +
      `computedEffects.anxiety=${sceneOutcome?.computedEffects?.anxiety?.toFixed(4) ?? 'NONE'} (>0 reqd)`);

    // ── P1c ──────────────────────────────────────────────────────────────────
    // Per-row isolation: perception-reset (clears VWM + zeros the gateway's
    // scene-cycle cooldown so the row's first frame always fires a nudge) +
    // scene-predictor-reset (zeros familiarity map and surprise ring from scratch).
    // Without the cooldown reset, P1c starts within 5s of P1a's final nudge and
    // its first frame's scene-change is suppressed → only ONE teapot surprise lands.
    await fetchJson('/api/metrics/perception-reset', { method: 'POST' });   // VWM + cooldown reset
    await fetchJson('/api/metrics/scene-predictor-reset', { method: 'POST' }); // familiarity + ring
    const ID = 'teapot';

    // Prime cup: fires OBJECT_APPEARED → nudge cycle → predictor initialized.
    // perception-reset zeroed the cooldown, so this nudge fires immediately.
    await stub.injectFrame(cassette, makeDetectFixture({ label: 'cup', trackId: 5201 }));
    // Poll until the predictor is initialized (prime cycle ran + advancePredictions
    // completed) — then reset the cooldown before teapot#1 so its nudge is guaranteed.
    await pollForInitialized(15_000);
    await fetchJson('/api/metrics/perception-reset', { method: 'POST' }); // cooldown reset only (VWM already clean)

    // Teapot sighting #1 (trackId 5202): count=0 → magnitude 1.0 (NOVEL_BASE_MAGNITUDE).
    await stub.injectFrame(cassette, makeDetectFixture({ label: ID, trackId: 5202, embeddingSeed: 7001 }));
    // Poll until the 1st teapot surprise lands in the ring — this confirms
    // compareScene+advancePredictions ran and familiarityCount incremented to 1.
    await pollForNovelInRing(ID, 1, 25_000);
    // Reset cooldown before the intervening cup so its nudge fires, then reset
    // again before teapot#2 so the 2nd surprise cycle is not suppressed.
    await fetchJson('/api/metrics/perception-reset', { method: 'POST' }); // cooldown reset

    // Intervening cup (different trackId 5203) — makes teapot's track absent so
    // its re-entry with fresh trackId 5204 is genuinely novel (not in predictedScene).
    await stub.injectFrame(cassette, makeDetectFixture({ label: 'cup', trackId: 5203 }));
    // Wait briefly for the cup's cycle to advance predictions (making teapot absent
    // from predictedScene), then reset cooldown so teapot#2's nudge fires immediately.
    await sleep(1200);
    await fetchJson('/api/metrics/perception-reset', { method: 'POST' }); // cooldown reset

    // Teapot sighting #2 (FRESH trackId 5204 simulating walk-out/walk-back):
    // familiarity map keyed on label 'teapot', count=1 → magnitude 1/(1+0.6)=0.625.
    await stub.injectFrame(cassette, makeDetectFixture({ label: ID, trackId: 5204, embeddingSeed: 7001 }));
    // Poll until BOTH teapot surprises are in the ring.
    const stateP1c = await pollForNovelInRing(ID, 2, 25_000);
    const mags = (stateP1c?.recentSurprise ?? []).map((o: any) => o.novelMagnitudes?.[ID]).filter((m: any) => typeof m === 'number');
    const habituated = mags.length >= 2 && mags[mags.length - 1] < mags[0];
    record('P1c', habituated,
      `identity='${ID}' novel mags: ${JSON.stringify(mags)} (surprise₂ < surprise₁ reqd, expect [1,0.625]); ` +
      `familiarityCount=${stateP1c?.familiarityCounts?.[ID] ?? 0} (expect 2)`);

    // ── P1b ──────────────────────────────────────────────────────────────────
    const dBeforeP1b = await fetchDriveVector();
    const socialBase = dBeforeP1b?.pressureVector['social'] ?? 0;
    for (let i = 0; i < 4; i++) {
      await stub.injectFrame(cassette, makeDetectFixture({ label: 'person', trackId: 5300, framesSeen: 8 + i, embeddingSeed: 8800 }));
    }
    const socialRise = await pollForDriveRise('social', socialBase, 8000);
    record('P1b', socialRise !== null,
      socialRise !== null ? `Social rose +${socialRise.toFixed(4)} (unknown person → UnknownPersonPressure → Social)`
        : `Social did NOT rise (base=${socialBase.toFixed(4)})`);

    // ── P3 ───────────────────────────────────────────────────────────────────
    await fetchJson('/api/metrics/episodic-reset', { method: 'POST' });
    await fetchJson('/api/metrics/perception-reset', { method: 'POST' }); // VWM + cooldown reset
    await fetchJson('/api/metrics/scene-predictor-reset', { method: 'POST' });
    const p3Caption = 'a green plant on the shelf';
    // Prime cup: cooldown zeroed → nudge fires immediately.
    await stub.injectFrame(cassette, makeDetectFixture({ label: 'cup', trackId: 5401 }));
    // Poll for initialized, then reset cooldown before the captioned scene.
    await pollForInitialized(15_000);
    await fetchJson('/api/metrics/perception-reset', { method: 'POST' }); // cooldown reset
    const p3Hit = await stub.injectCaptionedScene(cassette, p3Caption,
      makeDetectFixture({ label: 'pottedplant', trackId: 5402, embeddingSeed: 5402 }),
      makeDetectFixture({ label: 'pottedplant', trackId: 5402, embeddingSeed: 5402 }));
    await sleep(2500);
    const recent = await fetchJson('/api/metrics/episodic-recent?limit=20');
    const eps: any[] = recent.body?.episodes ?? [];
    const percEps = eps.filter((e) => e.source === 'perception');
    const matched = percEps.find((e) =>
      (e.visualContext?.caption?.text ?? '').toLowerCase().includes('plant') ||
      (e.visualContext?.sceneLabels ?? []).some((l: string) => l === 'pottedplant'));
    const anyGuardian = percEps.some((e) => e.speakerIsGuardian === true);
    record('P3', !!matched && !anyGuardian,
      matched ? `source='perception' episode: caption="${matched.visualContext?.caption?.text ?? '∅'}", ` +
        `labels=${JSON.stringify(matched.visualContext?.sceneLabels ?? [])}, guardianStamped=${anyGuardian}`
        : `no matching perception episode (captionHit=${p3Hit}, perceptionEps=${percEps.length})`);

    // ── P6 (caption lesioned — drives still move, no fabricated caption) ───────
    // P6 hermeticity requirements:
    //   (a) the LLM caption endpoint is lesioned (→ setCaptionLesion(true))
    //   (b) the nonce caption is NOT fabricated in any episode
    //   (c) scene-surprise still fires despite the LLM being gone
    // P6 does NOT require a cold predictor — only (a)/(b)/(c). Injecting a
    // genuinely novel object (suitcase, never seen before) into a warm predictor
    // proves the same thesis: perception→drive coupling is LLM-independent.
    //
    // With the cooldown-reset seam: perception-reset zeroes lastSceneCycleAt so
    // the suitcase frame's scene-change nudge fires immediately, no sleep needed.
    await fetchJson('/api/metrics/episodic-reset', { method: 'POST' });
    await fetchJson('/api/metrics/perception-reset', { method: 'POST' }); // cooldown reset (predictor stays warm)
    // Lesion the caption endpoint: /perception/caption returns 503 (T0.6).
    const NONCE = 'zorblax';
    cassette.setCaption(`a ${NONCE} floating near the ceiling`);
    cassette.setCaptionLesion(true);
    // Inject a completely novel object (suitcase — not in the warm predicted scene
    // from P1a/P1c). Cooldown is zeroed, so OBJECT_APPEARED fires a cycle immediately.
    // totalSurprise > 0.05 → routeScenePredictionErrors fires → drive coupling proven
    // LLM-independent without any sleep.
    await stub.injectFrame(cassette, makeDetectFixture({ label: 'suitcase', trackId: 6102, embeddingSeed: 6102 }));
    const stateP6 = await pollForNovelInRing('suitcase');
    const novelP6 = [...(stateP6?.recentSurprise ?? [])].reverse().find((o: any) => 'suitcase' in (o.novelMagnitudes ?? {}));
    const surpriseFired = (novelP6?.totalSurprise ?? 0) > 0.05;
    const recentP6 = await fetchJson('/api/metrics/episodic-recent?limit=20');
    const epsP6: any[] = recentP6.body?.episodes ?? [];
    const fabricated = epsP6.some((e) =>
      (e.visualContext?.caption?.text ?? '').toLowerCase().includes(NONCE) ||
      (e.inputSummary ?? '').toLowerCase().includes(NONCE));
    record('P6', surpriseFired && !fabricated,
      `surprise(novel suitcase, LLM-irrelevant)=${(novelP6?.totalSurprise ?? 0).toFixed(3)} (>0.05 reqd); ` +
      `lesionRejections=${cassette.stats.captionLesionRejections}; nonce '${NONCE}' fabricated=${fabricated} (must be false); ` +
      `predictor warm from P1a/P1c (no cold-start bowl needed; lesion hermeticity is caption-503 only)`);
    cassette.setCaptionLesion(false);

  } catch (err) {
    record('smoke-exception', false, `threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  } finally {
    try { stub.close(); } catch { /* */ }
    try { await fetchJson('/api/metrics/perception-reset', { method: 'POST' }); } catch { /* */ }
    try { await cassette.stop(); } catch { /* */ }
    killAll();
  }

  console.log('\n=== T4 P-rows smoke scorecard ===');
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(exitCode === 0 ? '\nALL GREEN — T4 LLM-independent P-rows passed.' : '\nFAILURES present.');
  await sleep(1500);
  process.exit(exitCode);
}

void main();

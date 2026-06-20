/**
 * accept-C.e2e.ts — ACC.C acceptance test (TK-29).
 *
 * Proves end-to-end that a scene/presence change with NO text/audio fires a
 * SYSTEM_TRIGGER cognitive cycle, the cycle retrieves a prior scene (P1.5
 * recall returns >=1 candidate), the drive engine receives a ScenePrediction
 * event with sceneSurprise ∈ [0,1], and no relief (negative drive delta)
 * appears on ScenePrediction rows.  Also verifies cooldown suppression and
 * per-identity habituation.
 *
 * Depends on:
 *   - ACC.0 (vision-preflight.e2e.ts) passing: sidecar UP, M0 satisfied.
 *   - Full NestJS backend running (localhost:3000).
 *   - Drive server running (localhost:3001).
 *   - test/fixtures/vision/mug_640x480.jpg + book_640x480.jpg present.
 *
 * Three acceptance criteria (AC1 / AC2 / AC3):
 *
 *   AC1: A scene/presence frame with no text/audio posted until
 *        confirmed+sceneNudge → logs show SYSTEM_TRIGGER (not
 *        VISUAL_INPUT/MULTIMODAL); episodic recall returns >=1 prior candidate.
 *
 *   AC2: drive_events after the cycle (action_type ScenePrediction) →
 *        >=1 row with sceneSurprise ∈ [0,1]; ZERO rows with relief>0.
 *        Verified via GET /metrics/last-scene-outcome and
 *        GET /metrics/scene-prediction-state.
 *
 *   AC3: A second scene change within the gateway cooldown window is suppressed
 *        (no second SYSTEM_TRIGGER within 5 s); the same static scene posted
 *        20× produces no further SYSTEM_TRIGGER cycles after the first
 *        (per-identity familiarity habituation, ScenePredictionService).
 *
 * Run:
 *   npx tsx test/e2e/vision/accept-C.e2e.ts
 *
 * Environment:
 *   BACKEND_HOST     defaults to http://localhost:3000
 *   PERCEPTION_HOST  defaults to http://localhost:8430
 *   WS_HOST          defaults to ws://localhost:3000
 *   LOG_FILE         defaults to logs/verbose.log (relative to process.cwd())
 *
 * Exit codes:
 *   0  — all three ACs passed
 *   1  — one or more ACs failed (message names which)
 */

import * as fs from 'fs';
import * as path from 'path';
// Use Node.js built-in WebSocket (Node >= 22, v24 in use here) so this test
// has zero external dependencies and runs from any working directory.
// No import needed — WebSocket is a global in Node 22+.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BACKEND    = process.env.BACKEND_HOST    ?? 'http://localhost:3000';
const PERCEPTION = process.env.PERCEPTION_HOST ?? 'http://localhost:8430';
const WS_BASE    = process.env.WS_HOST         ?? 'ws://localhost:3000';
const LOG_FILE   = path.resolve(
  process.env.LOG_FILE ?? path.join(process.cwd(), 'logs', 'verbose.log'),
);

/**
 * Gateway cooldown constant — must mirror SCENE_CYCLE_COOLDOWN_MS in
 * perception.gateway.ts.  Held here as a documentary copy so a change to
 * the gateway value is visible and conscious.
 */
const SCENE_CYCLE_COOLDOWN_MS = 5_000;

/** Time for the full pipeline to settle after a frame is injected. */
const PIPELINE_SETTLE_MS = 3_000;

/** How long to poll the log before declaring a failure. */
const POLL_TIMEOUT_MS  = 20_000;
const POLL_INTERVAL_MS = 300;

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(process.cwd(), 'test', 'fixtures', 'vision');
const MUG_JPEG    = path.join(FIXTURE_DIR, 'mug_640x480.jpg');
const BOOK_JPEG   = path.join(FIXTURE_DIR, 'book_640x480.jpg');

// ---------------------------------------------------------------------------
// Types for metrics API responses
// ---------------------------------------------------------------------------

interface RoutedOutcome {
  sceneSurprise: number;
  computedEffects: { curiosity: number; anxiety: number };
  routedAt: string;
}

interface LastSceneOutcomeResponse {
  lastRoutedOutcome: RoutedOutcome | null;
}

interface SurpriseObservation {
  seq: number;
  totalSurprise: number;
  novelMagnitudes: Record<string, number>;
  at: string;
}

interface ScenePredictionStateResponse {
  initialized: boolean;
  familiarityCounts: Record<string, number>;
  recentSurprise: SurpriseObservation[];
  lastRoutedOutcome: RoutedOutcome | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function api(
  method: 'GET' | 'POST',
  urlPath: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BACKEND}/api${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON response */ }
  return { status: res.status, body };
}

function getLogOffset(): number {
  try { return fs.statSync(LOG_FILE).size; } catch { return 0; }
}

/** Read verbose.log bytes starting at `offset`. */
function readLogSince(offset: number): string {
  try {
    const fd   = fs.openSync(LOG_FILE, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) { fs.closeSync(fd); return ''; }
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * Poll the log for a pattern (string or RegExp) starting from `sinceOffset`.
 * Returns the matched text on the first hit, or null after `timeoutMs`.
 */
async function pollLog(
  needle: string | RegExp,
  sinceOffset: number,
  timeoutMs: number = POLL_TIMEOUT_MS,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = readLogSince(sinceOffset);
    if (typeof needle === 'string') {
      if (text.includes(needle)) return needle;
    } else {
      const m = needle.exec(text);
      if (m) return m[0];
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Send a JPEG binary to the perception WebSocket gateway.
 *
 * Uses the built-in Node.js global WebSocket (Node >= 22).  The gateway's
 * `handleConnection` handler reads each WS `message` as a Buffer, passes it
 * to /perception/detect on the sidecar, and — if confirmed tracked objects
 * appear — fires nudgeSceneChange().  We close the socket 2 s after sending
 * so the gateway call to /perception/detect can complete.
 */
async function sendFrameToGateway(jpegPath: string): Promise<void> {
  const data = fs.readFileSync(jpegPath);
  return new Promise<void>((resolve) => {
    // globalThis.WebSocket is available in Node >= 22 without any import.
    const ws = new (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket(
      `${WS_BASE}/ws/perception`,
    );
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      ws.send(data);
      // 2 s is generous: /perception/detect round-trip is typically <200 ms.
      setTimeout(() => { ws.close(); resolve(); }, 2_000);
    });
    // Network error (backend not up) — fail gracefully; prerequisites will catch it.
    ws.addEventListener('error', () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function resetState(): Promise<void> {
  await api('POST', '/metrics/scene-predictor-reset');
  await api('POST', '/metrics/perception-reset');  // also zeros gateway cooldown
  await api('POST', '/metrics/episodic-reset');
}

async function checkPrerequisites(): Promise<void> {
  // Backend health
  const { status } = await api('GET', '/metrics/health');
  if (status !== 200) {
    throw new Error(`Backend unreachable at ${BACKEND} (HTTP ${status}).`);
  }

  // Perception sidecar M0 (mirrors vision-preflight.e2e.ts)
  const sRes = await fetch(`${PERCEPTION}/perception/status`).catch(() => null);
  if (!sRes?.ok) {
    throw new Error(`Perception sidecar unreachable at ${PERCEPTION}.`);
  }
  const sBody = await sRes.json() as {
    model_loaded?: boolean;
    face_model_loaded?: boolean;
    embedding_init_failed?: boolean;
  };
  if (!sBody.model_loaded)          throw new Error('M0 FAIL: model_loaded=false');
  if (!sBody.face_model_loaded)     throw new Error('M0 FAIL: face_model_loaded=false');
  if (sBody.embedding_init_failed)  throw new Error('M0 FAIL: embedding_init_failed=true');

  // Fixtures
  if (!fs.existsSync(MUG_JPEG))  throw new Error(`Fixture missing: ${MUG_JPEG}`);
  if (!fs.existsSync(BOOK_JPEG)) throw new Error(`Fixture missing: ${BOOK_JPEG}`);
}

// ---------------------------------------------------------------------------
// AC1 — SYSTEM_TRIGGER cycle + P1.5 recall
// ---------------------------------------------------------------------------

/**
 * Sequence:
 *   1. Reset all state to cold (predictor, cooldown, episodic ring).
 *   2. Prime episodic ring: send book frame twice so at least one episode
 *      is recorded with the book-frame context fingerprint.
 *      First send = cold-start cycle (no surprise, but episode IS encoded).
 *      Second send = may fire a SYSTEM_TRIGGER for the same scene; either
 *      way the episodic ring now holds a book-fingerprint episode.
 *   3. Wait for the gateway cooldown to expire.
 *   4. Reset predictor + cooldown for the real AC1 cycle.
 *   5. Capture log offset.
 *   6. Send mug frame (prime cold-start: predictor initialises; a mug
 *      episode is recorded; surprise=0 on this frame since predictor is cold).
 *   7. Expire cooldown so the next scene-change nudge can fire.
 *   8. Send book frame again — same fixture → same FUSED EMBEDDING → same
 *      context fingerprint → Jaccard match against the episode from step 2
 *      yields similarEpisodes>=1.  Also: book appears where mug was →
 *      OBJECT_APPEARED → sceneNudge → SYSTEM_TRIGGER cycle.
 *   9. Poll log for `"category":"SYSTEM_TRIGGER"`.
 *  10. Poll log for `"similarEpisodes":<n>` with n>=1 (P1.5 recall hit).
 *
 * Why book twice in step 2 rather than mug?  The SYSTEM_TRIGGER cycle in
 * step 8 is fired by the book frame, so its context fingerprint is derived
 * from the book embedding.  To get a Jaccard hit (threshold 0.70) the ring
 * must already contain an episode with an identical or near-identical
 * fingerprint.  The same JPEG produces a deterministic embedding →
 * deterministic hash → Jaccard=1.0 against the prior book episode.
 */
async function runAC1(): Promise<{ logOffset: number }> {
  console.log('\n--- AC1: SYSTEM_TRIGGER cycle + P1.5 recall ---');

  // Step 1: cold reset.
  await resetState();
  console.log('  [1] State reset (predictor + perception cooldown + episodic ring).');

  // Step 2: prime the episodic ring with a book cycle.
  //         The book JPEG produces a deterministic fused embedding → deterministic
  //         context fingerprint.  A later book cycle will Jaccard-match this episode
  //         (same fingerprint → similarity 1.0 > 0.70 threshold → recall hit).
  console.log('  [2] Priming episodic ring: book × 2 (to seed a book-fingerprint episode) ...');
  await sendFrameToGateway(BOOK_JPEG);
  await sleep(PIPELINE_SETTLE_MS);
  await sendFrameToGateway(BOOK_JPEG);
  await sleep(PIPELINE_SETTLE_MS);

  // Step 3: wait for the gateway cooldown to expire before resetting.
  console.log(`  [3] Waiting ${SCENE_CYCLE_COOLDOWN_MS + 500} ms for gateway cooldown ...`);
  await sleep(SCENE_CYCLE_COOLDOWN_MS + 500);

  // Step 4: reset predictor + cooldown for the real AC1 cycle.
  await api('POST', '/metrics/scene-predictor-reset');
  await api('POST', '/metrics/perception-reset');
  console.log('  [4] Predictor + cooldown reset for AC1 cycle.');

  // Step 5: capture log offset before the cycle we are measuring.
  const logOffset = getLogOffset();

  // Step 6: cold-start prime — mug frame sets up the predictor with a "mug
  //         is expected next frame" prediction.  The mug episode is also
  //         encoded but its fingerprint differs from the book's.
  console.log('  [5] Sending mug frame (cold-start prime for predictor) ...');
  await sendFrameToGateway(MUG_JPEG);
  await sleep(PIPELINE_SETTLE_MS);

  // Step 7: expire cooldown so the novel-object nudge can fire.
  await sleep(SCENE_CYCLE_COOLDOWN_MS + 200);

  // Step 8: book frame:
  //   • Novel vs. "expected mug" → OBJECT_APPEARED → sceneNudge → SYSTEM_TRIGGER.
  //   • Book fingerprint matches the episode seeded in step 2 → similarEpisodes>=1.
  console.log('  [6] Sending book frame (novel object → sceneNudge → SYSTEM_TRIGGER + recall) ...');
  await sendFrameToGateway(BOOK_JPEG);

  // Step 9: poll for SYSTEM_TRIGGER.
  console.log('  [7] Polling verbose.log for SYSTEM_TRIGGER ...');
  const stHit = await pollLog(/"category":"SYSTEM_TRIGGER"/, logOffset);
  if (!stHit) {
    throw new Error(
      `AC1 FAIL: no SYSTEM_TRIGGER in verbose.log within ${POLL_TIMEOUT_MS} ms.\n` +
      'Possible causes:\n' +
      '  - The book fixture produced no confirmed tracked object (check YOLO confidence\n' +
      '    threshold; set COBEING_PERCEPTION_DETECTION__CONFIDENCE_THRESHOLD=0.10).\n' +
      '  - nudgeSceneChange() was not called (scene event detector saw no OBJECT_APPEARED).\n' +
      '  - categorizeFrame does not branch on frame.raw[\'system_trigger\'] (TK-21 not merged?).',
    );
  }

  // Guard: VISUAL_INPUT / MULTIMODAL_INPUT must not appear BEFORE the
  // SYSTEM_TRIGGER line in the new log block — that would mean the book cycle
  // was mis-classified.
  const newLog = readLogSince(logOffset);
  const stIdx  = newLog.indexOf('"category":"SYSTEM_TRIGGER"');
  const viIdx  = newLog.indexOf('"category":"VISUAL_INPUT"');
  const mmIdx  = newLog.indexOf('"category":"MULTIMODAL_INPUT"');
  const firstBadIdx = Math.min(
    viIdx >= 0 ? viIdx : Infinity,
    mmIdx >= 0 ? mmIdx : Infinity,
  );
  if (firstBadIdx !== Infinity && firstBadIdx < stIdx) {
    throw new Error(
      'AC1 FAIL: VISUAL_INPUT or MULTIMODAL_INPUT appeared BEFORE SYSTEM_TRIGGER ' +
      'in the new log block — the book-frame cycle was not classified as a scene nudge.',
    );
  }

  console.log('  [AC1a] SYSTEM_TRIGGER confirmed in log. ✓');

  // Step 10: P1.5 recall.
  //   ProcessInputService.processInput calls queryByFingerprint() and logs the
  //   result as: VERBOSE [Cortex] episodic memory query {"similarEpisodes":<n>}
  //   We wait for a line with n>=1 (any digit 1–9 followed by optional digits).
  console.log('  [8] Polling for P1.5 episodic recall hit (similarEpisodes >= 1) ...');
  const recallHit = await pollLog(/"similarEpisodes":([1-9]\d*)/, logOffset);
  if (!recallHit) {
    throw new Error(
      `AC1 FAIL: no P1.5 recall hit (similarEpisodes >= 1) in verbose.log within ${POLL_TIMEOUT_MS} ms.\n` +
      'Possible causes:\n' +
      '  - Episodic ring is empty (priming cycle in step 2 did not record an episode;\n' +
      '    check that the book fixture produced a SYSTEM_TRIGGER cycle in the priming phase).\n' +
      '  - Context fingerprint mismatch (book fixture not deterministic across two runs;\n' +
      '    check that YOLO detections are stable and the embedding is not stochastic).\n' +
      '  - Jaccard threshold too strict (CONTEXT_SIMILARITY_THRESHOLD=0.70 in\n' +
      '    episodic-memory.service.ts) — may require exact same fingerprint.\n' +
      '  - VERBOSE logging is not enabled (set VERBOSE=1 in .env so [Cortex] vlogs appear).',
    );
  }

  console.log('  [AC1b] P1.5 recall >=1 candidate confirmed in log. ✓');
  return { logOffset };
}

// ---------------------------------------------------------------------------
// AC2 — drive signal: sceneSurprise ∈ [0,1], no relief
// ---------------------------------------------------------------------------

/**
 * GET /metrics/last-scene-outcome — the most recent ScenePrediction outcome
 * routed to the drive engine.  Asserts:
 *   a. lastRoutedOutcome is non-null (outcome fired).
 *   b. sceneSurprise ∈ [0, 1].
 *   c. computedEffects.curiosity >= 0 and anxiety >= 0 (PRESSURE, not relief).
 *
 * Also checks the recentSurprise ring via
 * GET /metrics/scene-prediction-state for >= 1 row with totalSurprise ∈ [0,1].
 *
 * "No relief" means: the ScenePrediction rule table (rules.ts) maps
 * sceneSurprise as PRESSURE-scaled curiosity + anxiety.  No DRIVE_RELIEF
 * contingency fires for ScenePrediction outcomes (Std-6 / AD-0004).
 * The computedEffects fields are 0.02*s and 0.01*s — both non-negative for
 * any s ∈ [0,1].
 */
async function runAC2(): Promise<void> {
  console.log('\n--- AC2: drive signal — sceneSurprise ∈ [0,1], no relief ---');

  // Give the drive engine a moment to apply the outcome asynchronously.
  await sleep(1_000);

  const { status, body } = await api('GET', '/metrics/last-scene-outcome');
  if (status !== 200) {
    throw new Error(`AC2 FAIL: GET /metrics/last-scene-outcome returned HTTP ${status}.`);
  }

  const resp    = body as LastSceneOutcomeResponse;
  const outcome = resp?.lastRoutedOutcome;

  if (!outcome) {
    throw new Error(
      'AC2 FAIL: lastRoutedOutcome is null — no ScenePrediction was routed to the drive engine.\n' +
      `The totalSurprise threshold (>=0.05 in routeScenePredictionErrors) may not have been met.\n` +
      'Check that the book fixture produced confirmed tracked objects; raise\n' +
      'COBEING_PERCEPTION_DETECTION__CONFIDENCE_THRESHOLD if needed.',
    );
  }

  // (a) sceneSurprise ∈ [0, 1].
  const s = outcome.sceneSurprise;
  if (typeof s !== 'number' || s < 0 || s > 1) {
    throw new Error(
      `AC2 FAIL: sceneSurprise=${JSON.stringify(s)} is not a number in [0,1].`,
    );
  }
  console.log(`  [AC2a] sceneSurprise=${s.toFixed(4)} ∈ [0,1]. ✓`);

  // (b) No relief: computed effects are non-negative.
  //     Relief would be a NEGATIVE delta on the drive — impossible with
  //     curiosity=0.02*s and anxiety=0.01*s for s∈[0,1], but we assert
  //     explicitly so any future regression is caught here.
  const { curiosity, anxiety } = outcome.computedEffects;
  if (typeof curiosity !== 'number' || curiosity < 0) {
    throw new Error(
      `AC2 FAIL: computedEffects.curiosity=${curiosity} is negative — ` +
      'ScenePrediction is applying relief, violating CANON Std-6.',
    );
  }
  if (typeof anxiety !== 'number' || anxiety < 0) {
    throw new Error(
      `AC2 FAIL: computedEffects.anxiety=${anxiety} is negative — ` +
      'ScenePrediction is applying relief, violating CANON Std-6.',
    );
  }
  console.log(
    `  [AC2b] No relief — computedEffects curiosity=${curiosity.toFixed(4)} ` +
    `anxiety=${anxiety.toFixed(4)} (both >= 0). ✓`,
  );

  // (c) recentSurprise ring has >= 1 entry with totalSurprise ∈ [0,1].
  const { body: stateBody } = await api('GET', '/metrics/scene-prediction-state');
  const state    = stateBody as ScenePredictionStateResponse;
  const ringRows = (state?.recentSurprise ?? []).filter(
    (r) => typeof r.totalSurprise === 'number' && r.totalSurprise >= 0 && r.totalSurprise <= 1,
  );
  if (ringRows.length === 0) {
    throw new Error(
      'AC2 FAIL: recentSurprise ring has no entry with totalSurprise ∈ [0,1]. ' +
      'The ScenePrediction compare path may not have fired.',
    );
  }
  console.log(
    `  [AC2c] recentSurprise ring: ${ringRows.length} valid row(s) with totalSurprise ∈ [0,1]. ✓`,
  );
}

// ---------------------------------------------------------------------------
// AC3 — cooldown suppression + habituation
// ---------------------------------------------------------------------------

/**
 * Part A — cooldown suppression:
 *   Send a scene-change frame immediately after AC1 (cooldown just fired).
 *   The gateway's lastSceneCycleAt is set to ~now, so nudgeSceneChange()
 *   must NOT enqueue a new turn within the 5 s window.
 *   Wait 2 s and confirm no new SYSTEM_TRIGGER appears in the log.
 *
 * Part B — per-identity habituation for a static scene:
 *   Reset predictor + cooldown.
 *   Send mug once (cold-start prime).  Expire cooldown.
 *   Reset cooldown and send mug 20× consecutively, resetting the cooldown
 *   before each send so the gateway gate is open every time.
 *   After the first real nudge, the scene predictor marks the mug as
 *   "expected" in predictedScene → subsequent frames produce surprise 0 →
 *   routeScenePredictionErrors returns early (threshold 0.05) → no
 *   SYSTEM_TRIGGER fires.
 *   If the tracker assigns a fresh trackId on re-entry (walk-back case),
 *   the familiarityCounts attenuation reduces surprise below 0.05 after a
 *   few cycles.
 *   Assert: zero SYSTEM_TRIGGER log lines in the 20-frame window.
 */
async function runAC3(ac1LogOffset: number): Promise<void> {
  console.log('\n--- AC3: cooldown suppression + habituation ---');

  // --- Part A: cooldown suppression ---
  // After AC1 the gateway cooldown is live.  Send a frame that would
  // otherwise generate a scene change (mug where book was).
  console.log('  Part A: send novel frame within cooldown window ...');
  const logOffsetA = getLogOffset();
  await sendFrameToGateway(MUG_JPEG);
  await sleep(2_000);  // well under SCENE_CYCLE_COOLDOWN_MS

  const newLogA = readLogSince(logOffsetA);
  if (newLogA.includes('"category":"SYSTEM_TRIGGER"')) {
    throw new Error(
      'AC3 FAIL (Part A): SYSTEM_TRIGGER fired within the cooldown window.\n' +
      `Expected the gateway to suppress re-fires within ${SCENE_CYCLE_COOLDOWN_MS} ms.`,
    );
  }
  console.log(`  [AC3a] Cooldown suppression: no SYSTEM_TRIGGER within ${SCENE_CYCLE_COOLDOWN_MS} ms. ✓`);

  // --- Part B: static-scene habituation ---
  console.log('  Part B: static mug × 20 with cooldown reset between sends ...');

  await resetState();
  console.log('  [hab] State reset for habituation sub-test.');

  // Prime cold start: one mug frame (predictor initialises, surprise=0).
  await sendFrameToGateway(MUG_JPEG);
  await sleep(PIPELINE_SETTLE_MS);

  // Expire cooldown so subsequent sends could fire a nudge.
  await sleep(SCENE_CYCLE_COOLDOWN_MS + 200);

  // Trigger the FIRST real mug SYSTEM_TRIGGER: reset cooldown then send.
  await api('POST', '/metrics/perception-reset');
  await sendFrameToGateway(MUG_JPEG);
  await sleep(PIPELINE_SETTLE_MS);

  // From this point on, predictedScene contains the mug.  Any further mug
  // frame has surprise 0 (expected object) and will NOT fire a routed outcome
  // → no SYSTEM_TRIGGER cycle.
  const logOffsetB = getLogOffset();
  console.log('  [hab] Sending mug × 20 with cooldown reset each time ...');
  for (let i = 0; i < 20; i++) {
    // Zero the cooldown so the gateway would nudge if the predictor fired.
    await api('POST', '/metrics/perception-reset');
    await sendFrameToGateway(MUG_JPEG);
    await sleep(500);
  }
  // Allow any late cycles to complete.
  await sleep(PIPELINE_SETTLE_MS);

  const newLogB   = readLogSince(logOffsetB);
  const stMatches = (newLogB.match(/"category":"SYSTEM_TRIGGER"/g) ?? []).length;
  if (stMatches > 0) {
    throw new Error(
      `AC3 FAIL (Part B): ${stMatches} SYSTEM_TRIGGER cycle(s) fired for the static ` +
      'mug scene after the first cycle.\n' +
      'Expected: surprise=0 (mug is predicted) → routeScenePredictionErrors threshold ' +
      'not met → no drive signal → no cycle enqueued.\n' +
      'Check ScenePredictionService.compareScene and the 0.05 routing threshold.',
    );
  }
  console.log('  [AC3b] Habituation: no SYSTEM_TRIGGER after first mug cycle (20 static frames). ✓');

  // Informational: check familiarity counts (the attenuation path).
  const { body: stateBody } = await api('GET', '/metrics/scene-prediction-state');
  const state  = stateBody as ScenePredictionStateResponse;
  const counts = state?.familiarityCounts ?? {};
  const maxCnt = Math.max(0, ...Object.values(counts).filter(v => typeof v === 'number'));
  if (maxCnt >= 1) {
    console.log(
      `  [AC3c] Per-identity familiarity count max=${maxCnt} — attenuation path active. ✓`,
    );
  } else {
    // count=0 means the mug was always "expected" (surprise=0 via prediction,
    // not via attenuation). Both paths satisfy habituation; log as info.
    console.log(
      '  [AC3c] Familiarity count=0 — mug was expected on all 20 frames (prediction path). ✓',
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== ACC.C: surprise → SYSTEM_TRIGGER cycle + recall + drive signal ===');
  console.log(`  backend:    ${BACKEND}`);
  console.log(`  perception: ${PERCEPTION}`);
  console.log(`  ws:         ${WS_BASE}`);
  console.log(`  log file:   ${LOG_FILE}`);
  console.log('');

  try {
    await checkPrerequisites();
    console.log('Prerequisites: backend UP, sidecar UP, M0 satisfied, fixtures present. ✓\n');
  } catch (err) {
    console.error(`PREREQUISITES FAILED — ${(err as Error).message}`);
    console.error('');
    console.error('Fix before running ACC.C:');
    console.error('  yarn dev:backend       (NestJS backend on :3000)');
    console.error('  yarn dev:drive-server  (drive engine on :3001)');
    console.error('  docker compose up -d   (perception sidecar on :8430)');
    console.error('  npx tsx test/e2e/vision/vision-preflight.e2e.ts  (M0 check)');
    process.exit(1);
  }

  const failures: string[] = [];
  let ac1LogOffset = 0;

  try {
    const result = await runAC1();
    ac1LogOffset = result.logOffset;
    console.log('AC1 PASSED. ✓');
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`\n${msg}\n`);
    failures.push(`AC1: ${msg}`);
  }

  try {
    await runAC2();
    console.log('AC2 PASSED. ✓');
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`\n${msg}\n`);
    failures.push(`AC2: ${msg}`);
  }

  try {
    await runAC3(ac1LogOffset);
    console.log('AC3 PASSED. ✓');
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`\n${msg}\n`);
    failures.push(`AC3: ${msg}`);
  }

  console.log('');
  if (failures.length === 0) {
    console.log('=== ACC.C PASSED — all 3 acceptance criteria satisfied. ===');
    process.exit(0);
  } else {
    console.error(`=== ACC.C FAILED — ${failures.length} criterion/criteria failed: ===`);
    for (const f of failures) {
      console.error(`  [FAIL] ${f}`);
    }
    process.exit(1);
  }
}

void main();

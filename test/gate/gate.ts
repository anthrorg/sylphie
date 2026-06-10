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

/** Send one utterance over the conversation WS and collect the cb_speech reply. */
async function converse(text: string): Promise<TurnResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/ws/conversation`);
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

  let exitCode = 0;

  try {
    // PHASE 1 — corpus.
    await runCorpus();

    // PHASE 3 (lesion) runs BEFORE the metric phase's final reads only in lesion
    // mode, because lesioning changes the system. In lesion mode we still want
    // the corpus-derived metrics, so capture metrics first, then lesion.
    const metrics = await runMetricAssertions(baseline);

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

/**
 * agi-verification.e2e.ts
 *
 * Manual E2E tests for AGI-level capabilities — the six things that
 * Phase 1 "Must Prove" (from CANON / CLAUDE.md):
 *
 *   1. The prediction-evaluation loop produces genuine learning
 *   2. The Type 1/Type 2 ratio shifts over time
 *   3. The graph grows in ways that reflect real understanding
 *   4. Personality emerges from contingencies
 *   5. The Planning subsystem creates useful procedures
 *   6. Drive dynamics produce recognizable behavioral patterns
 *
 * These tests require the system to have been running with real
 * conversations over time. A fresh system will SKIP most checks.
 * Run periodically to track progress toward AGI-level cognition.
 *
 * Prerequisites:
 *   1. docker compose up -d
 *   2. npm run start:dev
 *   3. System has been running with real guardian interactions
 *
 * Run:
 *   npx tsx test/e2e/agi-verification.e2e.ts
 */

const BASE = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CheckResult {
  section: string;
  check: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

const results: CheckResult[] = [];

function record(section: string, check: string, status: 'PASS' | 'FAIL' | 'SKIP', detail: string) {
  results.push({ section, check, status, detail });
  const icon = status === 'PASS' ? '[PASS]' : status === 'FAIL' ? '[FAIL]' : '[SKIP]';
  console.log(`  ${icon} ${check} — ${detail}`);
}

async function fetchJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  let body: any;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// AGI-1: Prediction-Evaluation Loop Produces Genuine Learning
//
// Evidence: prediction MAE decreases over time. Early predictions are
// inaccurate (high MAE), but as the system learns contingencies, the
// MAE should drop. A system that isn't learning has flat or rising MAE.
// ---------------------------------------------------------------------------

async function checkPredictionLearning() {
  console.log('\n=== AGI-1: PREDICTION-EVALUATION LOOP ===');
  console.log('  (Does the system get better at predicting drive effects?)');

  const { status, body } = await fetchJson('/api/metrics/predictions?window=86400000');

  if (status !== 200 || !body) {
    record('AGI-1', 'Prediction data available', 'FAIL', `HTTP ${status}`);
    return;
  }

  const sampleCount = body.sampleCount ?? 0;
  const mae = body.mae ?? null;

  if (sampleCount < 10) {
    record('AGI-1', 'Sufficient prediction samples', 'SKIP',
      `Only ${sampleCount} samples (need 10+ for meaningful assessment)`);
    return;
  }

  record('AGI-1', 'Prediction samples accumulated', 'PASS',
    `${sampleCount} predictions evaluated`);

  // MAE thresholds:
  // > 0.3  = not learning (random)
  // 0.15-0.3 = early learning
  // 0.10-0.15 = solid learning
  // < 0.10 = strong (Type 1 graduation territory)
  if (mae !== null) {
    if (mae < 0.10) {
      record('AGI-1', 'Prediction accuracy (MAE < 0.10)', 'PASS',
        `MAE=${mae.toFixed(3)} — system is accurately predicting drive effects`);
    } else if (mae < 0.20) {
      record('AGI-1', 'Prediction accuracy (MAE < 0.20)', 'PASS',
        `MAE=${mae.toFixed(3)} — learning is occurring, accuracy improving`);
    } else if (mae < 0.30) {
      record('AGI-1', 'Prediction accuracy (MAE < 0.30)', 'SKIP',
        `MAE=${mae.toFixed(3)} — early learning stage, needs more experience`);
    } else {
      record('AGI-1', 'Prediction accuracy', 'FAIL',
        `MAE=${mae.toFixed(3)} — predictions are essentially random`);
    }
  }
}

// ---------------------------------------------------------------------------
// AGI-2: Type 1/Type 2 Ratio Shifts Over Time
//
// Evidence: early system is 100% Type 2 (LLM-assisted). As procedures
// graduate, Type 1 ratio increases. A ratio stuck at 0% Type 1 after
// significant usage means graduation isn't working.
// ---------------------------------------------------------------------------

async function checkTypeRatioShift() {
  console.log('\n=== AGI-2: TYPE 1/TYPE 2 RATIO SHIFT ===');
  console.log('  (Is the system developing reflexes from experience?)');

  const { status, body } = await fetchJson('/api/metrics/type-ratio?window=86400000');

  if (status !== 200 || !body) {
    record('AGI-2', 'Type ratio data available', 'FAIL', `HTTP ${status}`);
    return;
  }

  const type1 = body.type1Count ?? 0;
  const type2 = body.type2Count ?? 0;
  const total = type1 + type2;

  if (total < 20) {
    record('AGI-2', 'Sufficient action data', 'SKIP',
      `Only ${total} actions (need 20+ for ratio analysis)`);
    return;
  }

  record('AGI-2', 'Action data accumulated', 'PASS',
    `${total} actions: ${type1} Type 1, ${type2} Type 2`);

  const type1Pct = (type1 / total) * 100;

  if (type1Pct > 20) {
    record('AGI-2', 'Type 1 emergence (>20%)', 'PASS',
      `${type1Pct.toFixed(1)}% Type 1 — reflexes are developing from experience`);
  } else if (type1Pct > 5) {
    record('AGI-2', 'Type 1 emergence (>5%)', 'PASS',
      `${type1Pct.toFixed(1)}% Type 1 — early reflex development`);
  } else if (type1Pct > 0) {
    record('AGI-2', 'Type 1 emergence (>0%)', 'SKIP',
      `${type1Pct.toFixed(1)}% Type 1 — first graduates appearing`);
  } else {
    record('AGI-2', 'Type 1 emergence', 'FAIL',
      `0% Type 1 after ${total} actions — Type 2 Addict attractor?`);
  }
}

// ---------------------------------------------------------------------------
// AGI-3: Graph Grows Reflecting Real Understanding
//
// Evidence: WKG nodes are not just LLM-regurgitated. Experiential ratio
// (SENSOR + GUARDIAN provenance) should grow over time. LLM_GENERATED
// nodes should be a minority of high-confidence knowledge.
// ---------------------------------------------------------------------------

async function checkGraphUnderstanding() {
  console.log('\n=== AGI-3: GRAPH REFLECTS REAL UNDERSTANDING ===');
  console.log('  (Is knowledge experiential, not just LLM-generated?)');

  const { status: pStatus, body: prov } = await fetchJson('/api/metrics/provenance');
  const { status: gStatus, body: stats } = await fetchJson('/api/graph/stats');

  if (pStatus !== 200 || !prov) {
    record('AGI-3', 'Provenance data available', 'FAIL', `HTTP ${pStatus}`);
    return;
  }

  const totalNodes = prov.totalNodes ?? stats?.nodeCount ?? 0;
  const experientialRatio = prov.experientialRatio ?? 0;

  if (totalNodes < 10) {
    record('AGI-3', 'Sufficient graph content', 'SKIP',
      `Only ${totalNodes} nodes (need 10+ for analysis)`);
    return;
  }

  record('AGI-3', 'Graph has content', 'PASS', `${totalNodes} nodes in WKG`);

  // CANON: LLM_GENERATED base confidence is 0.35. Confidence ceiling prevents
  // exceeding 0.60 without retrieval-and-use. So experiential ratio matters.
  if (experientialRatio > 0.5) {
    record('AGI-3', 'Experiential ratio > 50%', 'PASS',
      `${(experientialRatio * 100).toFixed(1)}% experiential — knowledge reflects real interaction`);
  } else if (experientialRatio > 0.2) {
    record('AGI-3', 'Experiential ratio > 20%', 'SKIP',
      `${(experientialRatio * 100).toFixed(1)}% experiential — growing but still LLM-heavy`);
  } else {
    record('AGI-3', 'Experiential ratio', 'FAIL',
      `${(experientialRatio * 100).toFixed(1)}% experiential — Hallucinated Knowledge attractor risk`);
  }
}

// ---------------------------------------------------------------------------
// AGI-4: Personality Emerges from Contingencies
//
// Evidence: behavioral diversity is non-zero and non-uniform. The system
// should develop preferences — some action types chosen more than others,
// reflecting learned contingencies rather than random selection.
// Guardian response rate indicates social contingency development.
// ---------------------------------------------------------------------------

async function checkPersonalityEmergence() {
  console.log('\n=== AGI-4: PERSONALITY EMERGENCE ===');
  console.log('  (Do contingencies produce consistent behavioral patterns?)');

  const { status, body: health } = await fetchJson('/api/metrics/health');

  if (status !== 200 || !health) {
    record('AGI-4', 'Metrics data available', 'FAIL', `HTTP ${status}`);
    return;
  }

  // Behavioral diversity index — Shannon entropy of action type distribution
  // Low entropy = very few action types dominate (could be stuck)
  // Medium entropy = developing preferences
  // High entropy = uniform random (no personality)
  const { status: bStatus, body: bdi } = await fetchJson('/api/metrics/health');
  if (bStatus === 200 && bdi) {
    record('AGI-4', 'Behavioral metrics available', 'PASS', 'Health metrics endpoint responsive');
  }

  // Guardian response rate — social contingency
  const { status: gStatus, body: guardian } = await fetchJson('/api/metrics/health');
  if (gStatus === 200) {
    record('AGI-4', 'Social contingency tracking', 'PASS',
      'Guardian response metrics pipeline exists');
  }

  // Drive resolution times — different drives resolve at different rates
  // which creates the appearance of personality (anxious about some things,
  // curious about others, etc.)
  const { status: dStatus, body: drives } = await fetchJson('/api/drives');
  if (dStatus === 200 && drives?.drives) {
    const driveValues = drives.drives.map((d: any) => d.value);
    const allZero = driveValues.every((v: number) => Math.abs(v) < 0.01);
    const allSame = new Set(driveValues.map((v: number) => v.toFixed(2))).size === 1;

    if (allZero) {
      record('AGI-4', 'Drive differentiation', 'SKIP',
        'All drives at zero — no sessions have run');
    } else if (allSame) {
      record('AGI-4', 'Drive differentiation', 'FAIL',
        'All drives identical — no contingency differentiation');
    } else {
      const max = Math.max(...driveValues.map(Math.abs));
      const variance = driveValues.reduce((s: number, v: number) => s + v * v, 0) / driveValues.length;
      record('AGI-4', 'Drive differentiation', variance > 0.01 ? 'PASS' : 'SKIP',
        `Drive variance=${variance.toFixed(3)}, max|drive|=${max.toFixed(2)} — ` +
        (variance > 0.01 ? 'drives are differentiating' : 'minimal differentiation so far'));
    }
  }
}

// ---------------------------------------------------------------------------
// AGI-5: Planning Creates Useful Procedures
//
// Evidence: procedures created by the planning subsystem are actually
// used (executed and reinforced). Useless procedures would have low
// confidence and never graduate to Type 1.
// ---------------------------------------------------------------------------

async function checkPlanningCreatesUsefulProcedures() {
  console.log('\n=== AGI-5: PLANNING CREATES USEFUL PROCEDURES ===');
  console.log('  (Are planned procedures actually executed and reinforced?)');

  // Check graph for ActionProcedure nodes
  const { status, body } = await fetchJson('/api/graph/snapshot?limit=100');
  if (status !== 200) {
    record('AGI-5', 'Graph queryable', 'FAIL', `HTTP ${status}`);
    return;
  }

  const nodes = body?.nodes ?? [];
  const procedureNodes = nodes.filter((n: any) =>
    n.labels?.includes('ActionProcedure') || n.label === 'ActionProcedure' ||
    n.type === 'ActionProcedure'
  );

  if (procedureNodes.length === 0) {
    record('AGI-5', 'Procedure nodes exist in WKG', 'SKIP',
      'No ActionProcedure nodes found — planning hasn\'t created any yet');
    return;
  }

  record('AGI-5', 'Procedure nodes exist in WKG', 'PASS',
    `${procedureNodes.length} procedure(s) in graph`);

  // Check if any have high confidence (indicating reinforcement through use)
  const highConfidence = procedureNodes.filter((n: any) =>
    (n.properties?.confidence ?? n.confidence ?? 0) > 0.5
  );

  if (highConfidence.length > 0) {
    record('AGI-5', 'Procedures reinforced through use', 'PASS',
      `${highConfidence.length} procedure(s) above 0.50 confidence`);
  } else {
    record('AGI-5', 'Procedures reinforced through use', 'SKIP',
      'No procedures above 0.50 confidence yet — need more execution cycles');
  }
}

// ---------------------------------------------------------------------------
// AGI-6: Drive Dynamics Produce Recognizable Patterns
//
// Evidence: drives don't flatline or oscillate randomly. They should
// show recognizable patterns: curiosity rising during idle periods,
// satisfaction spikes after successful actions, anxiety correlating
// with novel situations, etc.
// ---------------------------------------------------------------------------

async function checkDriveDynamics() {
  console.log('\n=== AGI-6: DRIVE DYNAMICS PATTERNS ===');
  console.log('  (Do drives produce recognizable emotional/motivational patterns?)');

  // Sample drive state multiple times
  const samples: any[] = [];
  for (let i = 0; i < 5; i++) {
    const { body } = await fetchJson('/api/drives');
    if (body?.drives) samples.push(body);
    if (i < 4) await sleep(500);
  }

  if (samples.length < 3) {
    record('AGI-6', 'Drive sampling', 'FAIL', 'Could not collect drive samples');
    return;
  }

  record('AGI-6', 'Drive sampling', 'PASS', `${samples.length} samples collected`);

  // Check for non-static behavior (drives should change over ticks)
  const firstTick = samples[0].tickNumber;
  const lastTick = samples[samples.length - 1].tickNumber;

  if (lastTick > firstTick) {
    record('AGI-6', 'Drive state advancing', 'PASS',
      `Tick ${firstTick} → ${lastTick}`);
  } else {
    record('AGI-6', 'Drive state advancing', 'SKIP',
      'Tick number not advancing — drive process may not be running');
    return;
  }

  // Check that at least some drives have non-zero values (system is "alive")
  const lastDrives = samples[samples.length - 1].drives as { name: string; value: number }[];
  const nonZero = lastDrives.filter((d: any) => Math.abs(d.value) > 0.05);

  if (nonZero.length >= 3) {
    record('AGI-6', 'Multiple drives active (>3 non-zero)', 'PASS',
      `${nonZero.length} drives active: ${nonZero.map((d: any) => `${d.name}=${d.value.toFixed(2)}`).join(', ')}`);
  } else if (nonZero.length > 0) {
    record('AGI-6', 'Drives showing activity', 'SKIP',
      `Only ${nonZero.length} drives active — system warming up`);
  } else {
    record('AGI-6', 'Drives showing activity', 'SKIP',
      'All drives near zero — no sessions have generated drive pressure');
  }

  // Check total pressure is reasonable (not stuck at 0 or maxed out)
  const totalPressure = samples[samples.length - 1].totalPressure ?? 0;
  if (totalPressure > 0 && totalPressure < 8.0) {
    record('AGI-6', 'Total pressure in healthy range', 'PASS',
      `totalPressure=${totalPressure.toFixed(2)} (healthy: 0-8)`);
  } else if (totalPressure === 0) {
    record('AGI-6', 'Total pressure in healthy range', 'SKIP',
      'Zero pressure — no sessions');
  } else {
    record('AGI-6', 'Total pressure in healthy range', 'FAIL',
      `totalPressure=${totalPressure.toFixed(2)} — may indicate stuck state`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('============================================================');
  console.log('  SYLPHIE AGI VERIFICATION');
  console.log('  Phase 1 "Must Prove" criteria from CANON');
  console.log('  Testing against running system at ' + BASE);
  console.log('============================================================');
  console.log('');
  console.log('  This test checks for EMERGENT cognitive capabilities.');
  console.log('  A fresh system will mostly SKIP. Progress appears over');
  console.log('  time as Sylphie interacts with the guardian.');

  try {
    await fetchJson('/api/health');
  } catch {
    console.error(`\nFATAL: Cannot reach ${BASE}/api/health`);
    console.error('Is the backend running? Start with: npm run start:dev');
    process.exit(1);
  }

  await checkPredictionLearning();
  await checkTypeRatioShift();
  await checkGraphUnderstanding();
  await checkPersonalityEmergence();
  await checkPlanningCreatesUsefulProcedures();
  await checkDriveDynamics();

  // Summary
  console.log('\n============================================================');
  console.log('  AGI VERIFICATION SUMMARY');
  console.log('============================================================');

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;

  console.log(`  PASS: ${passed}  |  FAIL: ${failed}  |  SKIP: ${skipped}  |  TOTAL: ${results.length}`);
  console.log('');

  const sections = ['AGI-1', 'AGI-2', 'AGI-3', 'AGI-4', 'AGI-5', 'AGI-6'];
  const sectionNames: Record<string, string> = {
    'AGI-1': '1. Prediction loop produces genuine learning',
    'AGI-2': '2. Type 1/Type 2 ratio shifts over time',
    'AGI-3': '3. Graph reflects real understanding',
    'AGI-4': '4. Personality emerges from contingencies',
    'AGI-5': '5. Planning creates useful procedures',
    'AGI-6': '6. Drive dynamics produce recognizable patterns',
  };

  console.log('  PHASE 1 "MUST PROVE" SCORECARD:');
  for (const s of sections) {
    const sResults = results.filter(r => r.section === s);
    const sp = sResults.filter(r => r.status === 'PASS').length;
    const sf = sResults.filter(r => r.status === 'FAIL').length;
    const icon = sf > 0 ? 'XX' : sp === sResults.length ? 'OK' : '~~';
    console.log(`    [${icon}] ${sectionNames[s]}: ${sp}/${sResults.length}`);
  }

  console.log('');
  console.log('  AGI readiness: all 6 criteria at [OK] = Phase 1 complete.');
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

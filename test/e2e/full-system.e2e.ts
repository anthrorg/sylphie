/**
 * full-system.e2e.ts — Manual QA session for Claude to run and analyze.
 *
 * This is NOT a typical pass/fail test. It's a diagnostic probe that:
 *   1. Exercises every subsystem with real interactions
 *   2. Captures the verbose log after each phase
 *   3. Dumps everything to stdout for the operator (Claude) to analyze
 *
 * The operator reads the output + logs/verbose.log and reports:
 *   - What actually happened inside each subsystem
 *   - Silent failures, broken pipelines, false positives
 *   - Whether decisions made sense given the inputs
 *   - Performance bottlenecks
 *
 * Prerequisites:
 *   1. docker compose up -d
 *   2. yarn dev:backend         (NestJS backend on :3000)
 *   3. yarn dev:drive-server    (Drive engine on :3001)
 *   4. Ollama running with configured models
 *   5. VERBOSE=1 in .env
 *
 * Run:
 *   npx tsx test/e2e/full-system.e2e.ts
 *
 * Then hand logs/verbose.log to Claude for deep analysis.
 */

import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'http://localhost:3000';
const WS_BASE = 'ws://localhost:3000';
const VERBOSE_LOG = path.resolve(process.cwd(), 'logs', 'verbose.log');
const RESPONSE_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson(urlPath: string, options?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${urlPath}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  let body: any;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Get the current size of verbose.log so we can read only new lines later. */
function getLogOffset(): number {
  try {
    return fs.statSync(VERBOSE_LOG).size;
  } catch {
    return 0;
  }
}

/** Read new verbose.log lines since the given byte offset. */
function readNewLogs(sinceOffset: number): string {
  try {
    const fd = fs.openSync(VERBOSE_LOG, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= sinceOffset) { fs.closeSync(fd); return ''; }
    const buf = Buffer.alloc(size - sinceOffset);
    fs.readSync(fd, buf, 0, buf.length, sinceOffset);
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '[verbose.log not available]';
  }
}

/** Send a message via WebSocket and collect all responses. */
async function converse(text: string): Promise<{
  responses: any[];
  speech: any | null;
  elapsedMs: number;
}> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/ws/conversation`);
    const messages: any[] = [];
    let speech: any = null;
    const startMs = Date.now();

    const timeout = setTimeout(() => {
      ws.close();
      resolve({ responses: messages, speech, elapsedMs: Date.now() - startMs });
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
            resolve({ responses: messages, speech, elapsedMs: Date.now() - startMs });
          }, 500);
        }
      } catch { /* binary */ }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      resolve({ responses: messages, speech: null, elapsedMs: Date.now() - startMs });
    });
  });
}

// ---------------------------------------------------------------------------
// Phase runners — each exercises a subsystem and dumps raw data
// ---------------------------------------------------------------------------

async function phaseInfra() {
  console.log('\n' + '='.repeat(72));
  console.log('PHASE 0: INFRASTRUCTURE HEALTH');
  console.log('='.repeat(72));

  const { status, body } = await fetchJson('/api/health');
  console.log(`\nHealth endpoint: HTTP ${status}`);
  console.log('Databases:');
  for (const db of body?.databases ?? []) {
    console.log(`  ${db.database}: ${db.status} (${db.latencyMs}ms)${db.error ? ' ERROR: ' + db.error : ''}`);
  }

  const { status: dStatus, body: drives } = await fetchJson('/api/drives');
  console.log(`\nDrive state: HTTP ${dStatus}`);
  if (drives?.drives) {
    console.log(`  Tick: ${drives.tickNumber}, Total Pressure: ${drives.totalPressure?.toFixed(4)}`);
    console.log('  Drives:');
    for (const d of drives.drives) {
      console.log(`    ${d.name.padEnd(22)} = ${d.value?.toFixed(6) ?? 'null'}`);
    }
  }

  const { status: pStatus, body: pressure } = await fetchJson('/api/pressure');
  console.log(`\nDrive server connection: HTTP ${pStatus}`);
  if (pressure) console.log(`  Connected: ${pressure.is_connected}, Stale: ${pressure.is_stale}`);

  const { status: vStatus, body: voice } = await fetchJson('/api/voice/status');
  console.log(`\nVoice status: HTTP ${vStatus}`);
  if (voice) console.log(`  ${JSON.stringify(voice)}`);
}

async function phaseConversation() {
  console.log('\n' + '='.repeat(72));
  console.log('PHASE 1: CONVERSATION — Send messages, observe full pipeline');
  console.log('='.repeat(72));

  const exchanges = [
    { label: 'Simple greeting', text: 'Hello!' },
    { label: 'Teach a fact', text: 'My favorite color is blue and I have a dog named Max.' },
    { label: 'Ask about taught fact', text: 'What is my favorite color?' },
    { label: 'Unknowable question', text: 'What did I eat for breakfast yesterday?' },
    { label: 'Nonsense input', text: 'How many glorps fit in a standard zanfibble?' },
    { label: 'Self-awareness', text: 'How are you feeling right now?' },
    { label: 'Complex reasoning', text: 'If you could learn one new thing today, what would it be and why?' },
    { label: 'Who am I trigger', text: 'Who am I?' },
  ];

  for (const { label, text } of exchanges) {
    const logOffset = getLogOffset();
    console.log(`\n--- ${label} ---`);
    console.log(`>> Sending: "${text}"`);

    const result = await converse(text);

    console.log(`<< Elapsed: ${result.elapsedMs}ms`);
    console.log(`<< Messages received: ${result.responses.length}`);

    if (result.speech) {
      console.log(`<< Speech response:`);
      console.log(`   Text: "${result.speech.text}"`);
      console.log(`   Arbitration: ${result.speech.arbitrationType}`);
      console.log(`   Latency: ${result.speech.latencyMs}ms`);
      console.log(`   Grounding: ${result.speech.knowledgeGrounding}`);
      console.log(`   Has audio: ${!!result.speech.audioBase64}`);
      console.log(`   Turn ID: ${result.speech.turnId}`);
    } else {
      console.log(`<< NO SPEECH RESPONSE (timeout or error)`);
    }

    // Dump other message types
    for (const msg of result.responses) {
      if (msg.type !== 'cb_speech') {
        console.log(`<< [${msg.type}] ${JSON.stringify(msg).substring(0, 200)}`);
      }
    }

    // Dump verbose log lines generated during this exchange
    const newLogs = readNewLogs(logOffset);
    if (newLogs.trim()) {
      const lines = newLogs.trim().split('\n');
      console.log(`\n   VERBOSE LOG (${lines.length} lines):`);
      for (const line of lines) {
        console.log(`   | ${line}`);
      }
    } else {
      console.log(`\n   VERBOSE LOG: (no new entries)`);
    }
  }
}

async function phaseMemory() {
  console.log('\n' + '='.repeat(72));
  console.log('PHASE 2: MEMORY — Check graph state after conversations');
  console.log('='.repeat(72));

  // WKG snapshot
  const { status: wkgStatus, body: wkg } = await fetchJson('/api/graph/snapshot');
  console.log(`\nWKG Snapshot: HTTP ${wkgStatus}`);
  if (wkg) {
    console.log(`  Nodes: ${wkg.nodes?.length ?? 0}`);
    console.log(`  Edges: ${wkg.edges?.length ?? 0}`);
    if (wkg.nodes?.length > 0) {
      const labels = new Set<string>();
      for (const n of wkg.nodes) {
        for (const l of n.labels ?? [n.label]) { if (l) labels.add(l); }
      }
      console.log(`  Node types: ${[...labels].join(', ')}`);
      // Print first 10 nodes
      console.log('  Sample nodes:');
      for (const n of wkg.nodes.slice(0, 10)) {
        const props = n.properties ?? n;
        console.log(`    [${(n.labels ?? [n.label]).join(',')}] ${JSON.stringify(props).substring(0, 150)}`);
      }
    }
  }

  // OKG (person model)
  const { status: okgStatus, body: okg } = await fetchJson('/api/graph/okg');
  console.log(`\nOKG (Person Models): HTTP ${okgStatus}`);
  if (okg) {
    console.log(`  Nodes: ${okg.nodes?.length ?? 0}`);
    console.log(`  Edges: ${okg.edges?.length ?? 0}`);
    if (okg.nodes?.length > 0) {
      console.log('  All OKG nodes:');
      for (const n of okg.nodes) {
        console.log(`    ${JSON.stringify(n.properties ?? n).substring(0, 200)}`);
      }
    }
  }

  // SKG (self model)
  const { status: skgStatus, body: skg } = await fetchJson('/api/graph/skg');
  console.log(`\nSKG (Self Model): HTTP ${skgStatus}`);
  if (skg) {
    console.log(`  Nodes: ${skg.nodes?.length ?? 0}, Edges: ${skg.edges?.length ?? 0}`);
  }

  // Graph counts
  for (const inst of ['world', 'self', 'other']) {
    const { status: s, body: c } = await fetchJson(`/api/graph/${inst}/count`);
    if (s === 200 && c) {
      console.log(`  ${inst.toUpperCase()} count: nodes=${c.nodeCount ?? c.nodes ?? '?'}, edges=${c.edgeCount ?? c.edges ?? '?'}`);
    }
  }
}

async function phaseDrives() {
  console.log('\n' + '='.repeat(72));
  console.log('PHASE 3: DRIVE ENGINE — Tick rate, drive dynamics, pressure');
  console.log('='.repeat(72));

  const logOffset = getLogOffset();

  // Sample drives 5 times over 5 seconds
  const samples: any[] = [];
  for (let i = 0; i < 5; i++) {
    const { body } = await fetchJson('/api/drives');
    if (body) samples.push(body);
    if (i < 4) await sleep(1000);
  }

  console.log(`\nCollected ${samples.length} drive samples over 5s:`);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    console.log(`  Sample ${i}: tick=${s.tickNumber}, pressure=${s.totalPressure?.toFixed(4)}`);
  }

  if (samples.length >= 2) {
    const tickDelta = samples[samples.length - 1].tickNumber - samples[0].tickNumber;
    const elapsed = 5;
    console.log(`  Tick rate: ${(tickDelta / elapsed).toFixed(1)} Hz (${tickDelta} ticks in ${elapsed}s)`);
  }

  // Drive deltas
  if (samples.length >= 2) {
    const first = samples[0].drives ?? [];
    const last = samples[samples.length - 1].drives ?? [];
    console.log('\n  Drive movement over sample window:');
    for (let i = 0; i < first.length; i++) {
      const delta = (last[i]?.value ?? 0) - (first[i]?.value ?? 0);
      const arrow = delta > 0.001 ? 'UP' : delta < -0.001 ? 'DOWN' : '---';
      console.log(`    ${first[i].name.padEnd(22)} ${first[i].value?.toFixed(6)} -> ${last[i].value?.toFixed(6)}  ${arrow} (${delta >= 0 ? '+' : ''}${delta.toFixed(6)})`);
    }
  }

  const newLogs = readNewLogs(logOffset);
  if (newLogs.trim()) {
    const lines = newLogs.trim().split('\n').filter(l => l.includes('[DriveEngine]'));
    console.log(`\n  DRIVE VERBOSE LOG (${lines.length} DriveEngine lines):`);
    for (const line of lines.slice(0, 30)) {
      console.log(`  | ${line}`);
    }
    if (lines.length > 30) console.log(`  | ... (${lines.length - 30} more lines)`);
  }
}

async function phaseLearning() {
  console.log('\n' + '='.repeat(72));
  console.log('PHASE 6: LEARNING — Wait for consolidation cycle, measure WKG growth');
  console.log('='.repeat(72));

  // Baseline
  const { body: before } = await fetchJson('/api/graph/snapshot');
  const nodesBefore = before?.nodes?.length ?? 0;
  const edgesBefore = before?.edges?.length ?? 0;
  console.log(`\nBaseline: ${nodesBefore} nodes, ${edgesBefore} edges`);

  const logOffset = getLogOffset();

  // Wait for consolidation cycle (60s interval + buffer)
  console.log('Waiting 70s for learning consolidation cycle...');
  await sleep(70_000);

  const { body: after } = await fetchJson('/api/graph/snapshot');
  const nodesAfter = after?.nodes?.length ?? 0;
  const edgesAfter = after?.edges?.length ?? 0;
  console.log(`After: ${nodesAfter} nodes, ${edgesAfter} edges`);
  console.log(`Delta: +${nodesAfter - nodesBefore} nodes, +${edgesAfter - edgesBefore} edges`);

  // Dump learning-related verbose lines
  const newLogs = readNewLogs(logOffset);
  if (newLogs.trim()) {
    const lines = newLogs.trim().split('\n').filter(l =>
      l.includes('[Learning]') || l.includes('[Planning]') || l.includes('[Knowledge]'),
    );
    console.log(`\n  LEARNING/PLANNING VERBOSE LOG (${lines.length} lines):`);
    for (const line of lines) {
      console.log(`  | ${line}`);
    }
  } else {
    console.log('\n  No learning verbose log entries during wait period.');
  }
}

async function phaseGuardianFeedback() {
  console.log('\n' + '='.repeat(72));
  console.log('PHASE 4: GUARDIAN FEEDBACK — Send confirmation, observe drive effects');
  console.log('='.repeat(72));

  // First get a response we can give feedback on
  const logOffset = getLogOffset();
  const result = await converse('Tell me something you find interesting.');

  if (!result.speech?.turnId) {
    console.log('No speech response to give feedback on. Skipping.');
    return;
  }

  console.log(`Got response with turnId: ${result.speech.turnId}`);
  console.log(`Response: "${result.speech.text?.substring(0, 100)}..."`);

  // Capture drive state before feedback
  const { body: drivesBefore } = await fetchJson('/api/drives');

  // Send guardian confirmation
  const feedbackOffset = getLogOffset();
  const ws = new WebSocket(`${WS_BASE}/ws/conversation`);
  await new Promise<void>((resolve) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({
        event: 'guardian_feedback',
        data: { turnId: result.speech.turnId, feedbackType: 'confirmation' },
      }));
      console.log(`Sent guardian confirmation for turnId=${result.speech.turnId}`);
      setTimeout(() => { ws.close(); resolve(); }, 2000);
    });
    ws.on('error', () => resolve());
  });

  // Capture drive state after feedback
  await sleep(1000);
  const { body: drivesAfter } = await fetchJson('/api/drives');

  if (drivesBefore?.drives && drivesAfter?.drives) {
    console.log('\nDrive changes after guardian confirmation:');
    for (let i = 0; i < drivesBefore.drives.length; i++) {
      const before = drivesBefore.drives[i]?.value ?? 0;
      const afterVal = drivesAfter.drives[i]?.value ?? 0;
      const delta = afterVal - before;
      if (Math.abs(delta) > 0.0001) {
        console.log(`  ${drivesBefore.drives[i].name.padEnd(22)} ${before.toFixed(6)} -> ${afterVal.toFixed(6)} (${delta >= 0 ? '+' : ''}${delta.toFixed(6)})`);
      }
    }
  }

  const feedbackLogs = readNewLogs(feedbackOffset);
  if (feedbackLogs.trim()) {
    const lines = feedbackLogs.trim().split('\n');
    console.log(`\n  FEEDBACK VERBOSE LOG (${lines.length} lines):`);
    for (const line of lines) {
      console.log(`  | ${line}`);
    }
  }
}

async function phaseManualInteraction() {
  console.log('\n' + '='.repeat(72));
  console.log('PHASE 6: MANUAL INTERACTION — Voice & Video (30s window)');
  console.log('='.repeat(72));
  console.log('\nThis phase captures perception and voice pipeline activity.');
  console.log('During the next 30 seconds:');
  console.log('  - Speak into your mic (tests STT + audio gateway)');
  console.log('  - Wave at / move in front of the camera (tests perception pipeline)');
  console.log('  - Or just sit there and we will see what the system detects\n');

  const logOffset = getLogOffset();

  // Wait 30 seconds for manual interaction
  for (let i = 30; i > 0; i--) {
    process.stdout.write(`\r  ${i}s remaining...  `);
    await sleep(1000);
  }
  process.stdout.write('\r  Done!              \n');

  const newLogs = readNewLogs(logOffset);
  if (newLogs.trim()) {
    const lines = newLogs.trim().split('\n');

    const perceptionLines = lines.filter(l => l.includes('[Perception]'));
    const voiceLines = lines.filter(l => l.includes('[Voice]'));
    const otherLines = lines.filter(l => !l.includes('[Perception]') && !l.includes('[Voice]'));

    console.log(`\n  PERCEPTION LOG (${perceptionLines.length} lines):`);
    for (const line of perceptionLines.slice(0, 40)) {
      console.log(`  | ${line}`);
    }
    if (perceptionLines.length > 40) console.log(`  | ... (${perceptionLines.length - 40} more)`);

    console.log(`\n  VOICE LOG (${voiceLines.length} lines):`);
    for (const line of voiceLines.slice(0, 20)) {
      console.log(`  | ${line}`);
    }
    if (voiceLines.length > 20) console.log(`  | ... (${voiceLines.length - 20} more)`);

    if (otherLines.length > 0) {
      console.log(`\n  OTHER SUBSYSTEMS during window (${otherLines.length} lines):`);
      for (const line of otherLines.slice(0, 20)) {
        console.log(`  | ${line}`);
      }
      if (otherLines.length > 20) console.log(`  | ... (${otherLines.length - 20} more)`);
    }
  } else {
    console.log('\n  No verbose log entries during manual interaction window.');
    console.log('  (Camera/mic may not be connected, or perception service not running)');
  }
}

async function phaseFullLogDump() {
  console.log('\n' + '='.repeat(72));
  console.log('PHASE 7: FULL VERBOSE LOG SUMMARY');
  console.log('='.repeat(72));

  try {
    const fullLog = fs.readFileSync(VERBOSE_LOG, 'utf-8');
    const lines = fullLog.trim().split('\n');
    console.log(`\nTotal verbose log lines: ${lines.length}`);

    // Count by subsystem
    const subsystemCounts: Record<string, number> = {};
    for (const line of lines) {
      const match = line.match(/\[(\w+)\]/);
      if (match) {
        subsystemCounts[match[1]] = (subsystemCounts[match[1]] ?? 0) + 1;
      }
    }

    console.log('\nLines per subsystem:');
    const sorted = Object.entries(subsystemCounts).sort((a, b) => b[1] - a[1]);
    for (const [sub, count] of sorted) {
      console.log(`  ${sub.padEnd(20)} ${count}`);
    }

    // Look for errors/warnings in verbose log
    const errorLines = lines.filter(l =>
      l.toLowerCase().includes('error') || l.toLowerCase().includes('fail'),
    );
    if (errorLines.length > 0) {
      console.log(`\nERROR/FAILURE lines found (${errorLines.length}):`);
      for (const line of errorLines) {
        console.log(`  ! ${line}`);
      }
    } else {
      console.log('\nNo error/failure lines in verbose log.');
    }

    // Show first and last 5 lines for timeline
    console.log('\nFirst 5 log lines (session start):');
    for (const line of lines.slice(0, 5)) {
      console.log(`  ${line}`);
    }
    console.log('\nLast 5 log lines (session end):');
    for (const line of lines.slice(-5)) {
      console.log(`  ${line}`);
    }

    console.log(`\nFull log available at: ${VERBOSE_LOG}`);
    console.log(`Log file size: ${(fs.statSync(VERBOSE_LOG).size / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.log(`Could not read verbose log: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(72));
  console.log('SYLPHIE FULL SYSTEM DIAGNOSTIC');
  console.log(`Target: ${BASE}`);
  console.log(`Verbose log: ${VERBOSE_LOG}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('='.repeat(72));

  // Clear verbose log for a clean session
  try {
    fs.writeFileSync(VERBOSE_LOG, '', 'utf-8');
    console.log('Cleared verbose.log for clean session.');
  } catch {
    console.log('Could not clear verbose.log (may not exist yet — will be created).');
  }

  // Reachability check
  try {
    await fetchJson('/api/health');
  } catch {
    console.error(`\nFATAL: Cannot reach ${BASE}/api/health`);
    console.error('Start the system first:');
    console.error('  docker compose up -d && yarn dev:backend && yarn dev:drive-server');
    process.exit(1);
  }

  const startMs = Date.now();

  await phaseInfra();            // 0: DB health, drives, voice
  await phaseConversation();     // 1: 8 messages with verbose trace per message
  await phaseMemory();           // 2: Graph state after conversations
  await phaseDrives();           // 3: Tick rate, drive dynamics
  await phaseGuardianFeedback(); // 4: Confirmation → drive effect
  await phaseManualInteraction();// 5: 30s window for voice/video (Jim does this)
  await phaseLearning();         // 6: Wait 70s for consolidation cycle
  await phaseFullLogDump();      // 7: Full log summary + error scan

  const totalMs = Date.now() - startMs;
  console.log('\n' + '='.repeat(72));
  console.log(`DIAGNOSTIC COMPLETE — ${(totalMs / 1000).toFixed(1)}s total`);
  console.log('Hand this output + logs/verbose.log to Claude for analysis.');
  console.log('='.repeat(72));
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

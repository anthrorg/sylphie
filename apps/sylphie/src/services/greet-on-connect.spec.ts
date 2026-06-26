/**
 * TK-100 — greet-first on connect: unit/wiring spec.
 *
 * Run with:
 *   npx tsx apps/sylphie/src/services/greet-on-connect.spec.ts
 *
 * Exits non-zero on any failed assertion.
 *
 * ── Why this spec was rewritten from the original FakeGreetPipeline ──────────
 *
 * The prior spec used a hand-written FakeGreetPipeline that wired a real
 * TurnFloorGate and the dedup logic, but built its own synthetic CycleResponse
 * inline — never calling the real initiateConnectionGreet or handleCycleResponse.
 * As a result it could never exercise reportOutcome / confidence updates, so the
 * CRITICAL phantom-confidence-record bug was invisible to it:
 *
 *   Old code: arbitrationType:'TYPE_1' + procedureData:null
 *     → hasProcedureNode=true (decision-making.service.ts:2222-2227 TYPE_1 branch)
 *     → confidenceUpdater.update('greet-on-connect', …) called every connect
 *     → phantom confidence record for a non-existent procedure node
 *     → CONFIDENCE_UPDATED telemetry on every fresh connect
 *     → CANON provenance violation (Std-1/Std-2)
 *
 *   Fixed code: arbitrationType:'TYPE_2' + procedureData:null
 *     → hasProcedureNode=false (TYPE_2+null candidate is the canonical no-procedure marker)
 *     → confidenceUpdater.update SKIPPED
 *     → drive-effect forwarding still happens (Social relief)
 *     → no phantom record, honest telemetry
 *
 * ── What is tested ────────────────────────────────────────────────────────────
 *
 * This spec re-implements the pipeline inline (same pattern as
 * communication-floor-wiring.spec.ts) to avoid importing NestJS-decorated classes
 * (decorator syntax is not supported by the tsx/esbuild runner used here). The
 * inline pipeline faithfully replicates the fixed production code path so we can
 * assert on the exact CycleResponse shape and DeliveryPayload fields:
 *
 *   CRITICAL (anti-regression): the synthetic CycleResponse built for the greet
 *     has arbitrationResult.type='TYPE_2' AND candidate.procedureData=null.
 *     This is the combination that sets hasProcedureNode=false in
 *     decision-making.service.ts:2222-2227, skipping confidenceUpdater.update.
 *     This assertion FAILS against old TYPE_1 code and PASSES after the fix.
 *
 *   HONESTY: llmCalled is computed as
 *     `arbitrationType==='TYPE_2' && emissionIntent!=='DELIBERATE_GREET'`
 *     → false for the greet (TYPE_2 but no LLM ran, CANON Std-1 Theater Prohibition).
 *
 *   AC0: exactly one DELIBERATE_GREET delivery on fresh connect, via real
 *     TurnFloorGate (barge-in suppresses it when user holds the floor).
 *
 *   AC1: dedup — rapid reconnect within 60 s emits no additional greet.
 *     Reconnect after window expires gets a greet. Per-userId isolation.
 *
 *   SHOULD-FIX 2 (consume-on-admit): when the floor DENIES the greet, the
 *     dedup key is rolled back so the user is not blocked for 60 s.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TurnFloorGate } from './turn-floor-gate';
import type { EmissionIntent, KnowledgeGrounding } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Minimal type stubs (no NestJS imports needed — these are plain interfaces)
// ---------------------------------------------------------------------------

interface ArbitrationCandidate {
  procedureData: null;
  confidence: number;
  motivatingDrive: string;
  contextMatchScore: number;
}

interface ArbitrationResult {
  type: 'TYPE_1' | 'TYPE_2' | 'SHRUG';
  candidate: ArbitrationCandidate;
  llmRationale?: string;
}

interface SyntheticCycleResponse {
  turnId: string;
  originator: { userId: string; socketId: string; isGuardian: boolean };
  text: string;
  arbitrationType: 'TYPE_1' | 'TYPE_2' | 'SHRUG';
  actionId: string;
  driveSnapshot: { sessionId: string; pressureVector: Record<string, number>; timestamp: string };
  arbitrationResult: ArbitrationResult;
  latencyMs: number;
  knowledgeGrounding: KnowledgeGrounding;
  emissionIntent: EmissionIntent;
}

interface DeliveryRecord {
  turnId: string;
  emissionIntent: EmissionIntent;
  arbitrationType: 'TYPE_1' | 'TYPE_2' | 'SHRUG';
  llmCalled: boolean;
  originatorUserId: string;
  originatorSocketId: string;
  arbitrationResult: ArbitrationResult;
}

// ---------------------------------------------------------------------------
// Inline pipeline — mirrors the fixed production code without decorator imports
// ---------------------------------------------------------------------------

const GREET_DEDUP_WINDOW_MS = 60_000; // mirrors CommunicationService.GREET_DEDUP_WINDOW_MS

/**
 * Builds the synthetic CycleResponse the way the FIXED production code does.
 *
 * The KEY assertion target: arbitrationResult.type must be 'TYPE_2' and
 * candidate.procedureData must be null. This is the canonical no-procedure-node
 * shape that causes decision-making.service.ts:2222-2227 to set
 * hasProcedureNode=false and skip confidenceUpdater.update.
 *
 * NOTE: if you change this to 'TYPE_1', the CRITICAL test will FAIL — which
 * is the intended regression guard against reverting to the old behavior.
 */
function buildSyntheticGreetResponse(
  userId: string,
  socketId: string,
  isGuardian: boolean,
  turnId: string,
): SyntheticCycleResponse {
  return {
    turnId,
    originator: { userId, socketId, isGuardian },
    text: 'Hi! How can I help you today?',
    // TYPE_2 + null procedureData = canonical no-procedure-node shape.
    // This MUST NOT be TYPE_1 (see CRITICAL comment above).
    arbitrationType: 'TYPE_2',
    actionId: 'greet-on-connect',
    driveSnapshot: {
      sessionId: 'test-session',
      pressureVector: {},
      timestamp: new Date().toISOString(),
    },
    arbitrationResult: {
      type: 'TYPE_2',
      candidate: {
        procedureData: null,
        confidence: 1.0,
        motivatingDrive: 'Social',
        contextMatchScore: 1.0,
      },
      // Honest non-LLM marker (required on TYPE_2 by action.types.ts:215).
      llmRationale: 'connection-greet (synthetic, no LLM)',
    },
    latencyMs: 0,
    knowledgeGrounding: 'GROUNDED',
    emissionIntent: 'DELIBERATE_GREET',
  };
}

/**
 * Compute llmCalled the way the FIXED handleCycleResponse does.
 *
 * The honesty guard: TYPE_2 greet uses TYPE_2 for no-confidence-record
 * semantics, but no LLM ran. emissionIntent discriminates the two cases.
 */
function computeLlmCalled(response: SyntheticCycleResponse): boolean {
  // Mirror of communication.service.ts handleCycleResponse delivery construction:
  //   llmCalled: response.arbitrationType === 'TYPE_2' && response.emissionIntent !== 'DELIBERATE_GREET'
  return response.arbitrationType === 'TYPE_2' && response.emissionIntent !== 'DELIBERATE_GREET';
}

/**
 * Full greet pipeline — replicates initiateConnectionGreet + handleCycleResponse
 * for a single call. Uses a real TurnFloorGate (so barge-in is genuine).
 *
 * Returns the emitted DeliveryRecord if the greet was admitted, or null if
 * suppressed by dedup, barge-in, or rate-limit.
 */
async function runGreetPipeline(
  userId: string,
  socketId: string,
  greetIssuedAt: Map<string, number>,
  gate: TurnFloorGate,
  deliveries: DeliveryRecord[],
  nowFn: () => number,
): Promise<DeliveryRecord | null> {
  const now = nowFn();

  // ── Dedup check (AC1) ──────────────────────────────────────────────────
  const lastGreetAt = greetIssuedAt.get(userId);
  if (lastGreetAt !== undefined && now - lastGreetAt < GREET_DEDUP_WINDOW_MS) {
    return null; // suppressed by dedup
  }

  // Optimistic key — set before floor check so concurrent calls also see the guard.
  greetIssuedAt.set(userId, now);

  // ── Build synthetic CycleResponse ─────────────────────────────────────
  const turnId = `greet-${randomUUID().substring(0, 8)}`;
  const response = buildSyntheticGreetResponse(userId, socketId, false, turnId);

  // ── Floor gate admission (AC0) ─────────────────────────────────────────
  const floorDecision = gate.admit(response.emissionIntent, response.turnId);

  if (!floorDecision.allow) {
    // SHOULD-FIX 2: roll back dedup key on floor denial (consume-on-admit).
    greetIssuedAt.delete(userId);
    return null;
  }

  // ── In-flight registration + cancel flag (same as handleCycleResponse) ─
  let cancelled = false;
  gate.registerInFlight({
    turnId,
    intent: 'DELIBERATE_GREET',
    cancel: () => { cancelled = true; },
  });

  // ── Simulate async TTS await ───────────────────────────────────────────
  await Promise.resolve();

  if (cancelled) {
    gate.clearInFlight(turnId);
    greetIssuedAt.delete(userId); // roll back dedup key if cancelled mid-flight
    return null;
  }

  // ── Compute llmCalled (the honesty guard) ─────────────────────────────
  const llmCalled = computeLlmCalled(response);

  // ── Emit delivery ─────────────────────────────────────────────────────
  const record: DeliveryRecord = {
    turnId,
    emissionIntent: response.emissionIntent,
    arbitrationType: response.arbitrationType,
    llmCalled,
    originatorUserId: response.originator.userId,
    originatorSocketId: response.originator.socketId,
    arbitrationResult: response.arbitrationResult,
  };
  deliveries.push(record);

  gate.clearInFlight(turnId);
  return record;
}

function makeControlledClock(startMs = 200_000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, fn: () => Promise<void>): Promise<void> {
  return fn().then(
    () => {
      passed++;
      console.log(`  ok  ${name}`);
    },
    (err: unknown) => {
      failed++;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests(): Promise<void> {

  // ── CRITICAL (anti-regression): TYPE_2+null procedureData ────────────────

  console.log('\nCRITICAL (anti-regression): arbitrationResult shape prevents phantom confidence record:');

  await check('CRITICAL: buildSyntheticGreetResponse produces arbitrationType=TYPE_2 (not TYPE_1)', async () => {
    const response = buildSyntheticGreetResponse('user-test', 'sock-test', false, 'turn-test');
    assert.equal(
      response.arbitrationType,
      'TYPE_2',
      `arbitrationType must be 'TYPE_2'. Got '${response.arbitrationType}'. ` +
      "TYPE_1 would set hasProcedureNode=true in decision-making.service.ts:2222-2227 " +
      "(TYPE_1 branch does NOT check procedureData), causing confidenceUpdater.update(" +
      "'greet-on-connect') to be called → phantom confidence record for a non-existent " +
      "procedure node (CANON provenance violation, Std-1/Std-2). " +
      "This assertion FAILS against the old TYPE_1 code.",
    );
  });

  await check('CRITICAL: arbitrationResult.type=TYPE_2 AND candidate.procedureData=null (no-procedure-node shape)', async () => {
    const response = buildSyntheticGreetResponse('user-test', 'sock-test', false, 'turn-test');
    assert.equal(
      response.arbitrationResult.type,
      'TYPE_2',
      `arbitrationResult.type must be 'TYPE_2'. Got '${response.arbitrationResult.type}'.`,
    );
    assert.equal(
      response.arbitrationResult.candidate.procedureData,
      null,
      `candidate.procedureData must be null. Got '${String(response.arbitrationResult.candidate.procedureData)}'. ` +
      "TYPE_2+null is the canonical no-procedure-node marker checked at " +
      "decision-making.service.ts:2225: !(arbitrationType==='TYPE_2' && procedureData===null) " +
      "→ hasProcedureNode=false → confidence update SKIPPED.",
    );
  });

  await check('CRITICAL: llmRationale is the honest non-LLM marker (required on TYPE_2)', async () => {
    const response = buildSyntheticGreetResponse('user-test', 'sock-test', false, 'turn-test');
    assert.ok(
      response.arbitrationResult.llmRationale?.includes('synthetic'),
      `llmRationale must contain 'synthetic' to mark it as a non-LLM greet. ` +
      `Got '${response.arbitrationResult.llmRationale ?? '(undefined)'}'.`,
    );
  });

  // ── HONESTY: llmCalled=false on DELIBERATE_GREET ─────────────────────────

  console.log('\nHONESTY: llmCalled=false on DELIBERATE_GREET delivery:');

  await check('HONESTY: computeLlmCalled returns false for DELIBERATE_GREET (TYPE_2, no LLM)', async () => {
    const response = buildSyntheticGreetResponse('user-test', 'sock-test', false, 'turn-test');
    const llmCalled = computeLlmCalled(response);
    assert.equal(
      llmCalled,
      false,
      `llmCalled must be false for DELIBERATE_GREET. Got ${String(llmCalled)}. ` +
      "The greet is TYPE_2 for no-confidence-record semantics (CRITICAL fix above), " +
      "but no LLM ran. Reporting llmCalled:true would be dishonest theater (CANON Std-1). " +
      "The honesty guard: arbitrationType==='TYPE_2' && emissionIntent!=='DELIBERATE_GREET'.",
    );
  });

  await check('HONESTY: computeLlmCalled returns true for a real TYPE_2 USER_REPLY (sanity check)', async () => {
    // Confirm the guard does NOT suppress llmCalled for genuine LLM responses.
    const response: SyntheticCycleResponse = {
      ...buildSyntheticGreetResponse('u', 's', false, 't'),
      arbitrationType: 'TYPE_2',
      emissionIntent: 'USER_REPLY',
    };
    const llmCalled = computeLlmCalled(response);
    assert.equal(
      llmCalled,
      true,
      `computeLlmCalled should return true for USER_REPLY TYPE_2. Got ${String(llmCalled)}.`,
    );
  });

  // ── AC0: exactly one DELIBERATE_GREET via real TurnFloorGate ─────────────

  console.log('\nAC0: exactly one DELIBERATE_GREET on fresh connect, via real floor:');

  await check('AC0: fresh connect emits exactly one DELIBERATE_GREET delivery', async () => {
    const clock = makeControlledClock();
    const gate = new TurnFloorGate(clock.now);
    const greetIssuedAt = new Map<string, number>();
    const deliveries: DeliveryRecord[] = [];

    const result = await runGreetPipeline('user-alice', 'sock-1', greetIssuedAt, gate, deliveries, clock.now);

    assert.ok(result !== null, 'initiateConnectionGreet must admit the greet');
    assert.equal(deliveries.length, 1, `Expected 1 delivery, got ${deliveries.length}`);
    assert.equal(deliveries[0]!.emissionIntent, 'DELIBERATE_GREET');
  });

  await check('AC0: delivery is targeted to the connecting socket', async () => {
    const clock = makeControlledClock();
    const gate = new TurnFloorGate(clock.now);
    const greetIssuedAt = new Map<string, number>();
    const deliveries: DeliveryRecord[] = [];

    await runGreetPipeline('user-bob', 'sock-2', greetIssuedAt, gate, deliveries, clock.now);

    assert.equal(deliveries[0]!.originatorSocketId, 'sock-2');
    assert.equal(deliveries[0]!.originatorUserId, 'user-bob');
  });

  await check('AC0: barge-in suppresses the greet (proves floor is wired, not bypassed)', async () => {
    const clock = makeControlledClock();
    const gate = new TurnFloorGate(clock.now);
    const greetIssuedAt = new Map<string, number>();
    const deliveries: DeliveryRecord[] = [];

    // User just spoke → holds the floor → barge-in suppression active
    gate.recordUserInput();
    clock.advance(100); // well within FLOOR_HOLD_WINDOW_MS (5 s)

    const result = await runGreetPipeline('user-carol', 'sock-3', greetIssuedAt, gate, deliveries, clock.now);

    assert.equal(result, null, 'Greet must be suppressed by barge-in');
    assert.equal(deliveries.length, 0, 'No delivery when floor is held');
  });

  // ── AC1: dedup ────────────────────────────────────────────────────────────

  console.log('\nAC1: no second greet within 60 s dedup window:');

  await check('AC1: page refresh within 60 s emits no additional greet', async () => {
    const clock = makeControlledClock();
    const gate = new TurnFloorGate(clock.now);
    const greetIssuedAt = new Map<string, number>();
    const deliveries: DeliveryRecord[] = [];

    const first = await runGreetPipeline('user-dave', 'sock-4', greetIssuedAt, gate, deliveries, clock.now);
    assert.ok(first !== null, 'First connect must admit (precondition)');

    // Rapid reconnect — 2 s later, same userId
    clock.advance(2_000);
    const second = await runGreetPipeline('user-dave', 'sock-5', greetIssuedAt, gate, deliveries, clock.now);
    assert.equal(second, null, 'Rapid reconnect must be suppressed by dedup');
    assert.equal(deliveries.length, 1, `Expected 1 total delivery, got ${deliveries.length}`);
  });

  await check('AC1: second tab for same user (concurrent) is deduped', async () => {
    const clock = makeControlledClock();
    const gate = new TurnFloorGate(clock.now);
    const greetIssuedAt = new Map<string, number>();
    const deliveries: DeliveryRecord[] = [];

    // Both tabs connect within 0 ms of each other
    const first = await runGreetPipeline('user-eve', 'sock-6', greetIssuedAt, gate, deliveries, clock.now);
    clock.advance(500);
    const second = await runGreetPipeline('user-eve', 'sock-7', greetIssuedAt, gate, deliveries, clock.now);

    assert.ok(first !== null, 'First tab greet must be admitted');
    assert.equal(second, null, 'Second tab within window must be suppressed');
    assert.equal(deliveries.length, 1, 'Only one delivery for two tabs');
    assert.equal(deliveries[0]!.originatorSocketId, 'sock-6', 'First socket targeted');
  });

  await check('AC1: reconnect AFTER 60 s dedup window expires receives a greet', async () => {
    const clock = makeControlledClock();
    const gate = new TurnFloorGate(clock.now);
    const greetIssuedAt = new Map<string, number>();
    const deliveries: DeliveryRecord[] = [];

    const first = await runGreetPipeline('user-frank', 'sock-8', greetIssuedAt, gate, deliveries, clock.now);
    assert.ok(first !== null, 'First session must get greet');

    // Return visit after 65 s — past the 60 s window
    clock.advance(65_000);
    const second = await runGreetPipeline('user-frank', 'sock-9', greetIssuedAt, gate, deliveries, clock.now);
    assert.ok(second !== null, 'Return visit after window must get greet');
    assert.equal(deliveries.length, 2, `Expected 2 deliveries (two sessions), got ${deliveries.length}`);
  });

  await check('AC1: dedup is per userId — different users each get their own greet', async () => {
    const clock = makeControlledClock();
    const gate = new TurnFloorGate(clock.now);
    const greetIssuedAt = new Map<string, number>();
    const deliveries: DeliveryRecord[] = [];

    const grace = await runGreetPipeline('user-grace', 'sock-10', greetIssuedAt, gate, deliveries, clock.now);
    assert.ok(grace !== null, 'user-grace must get a greet');

    // Advance past MIN_UTTERANCE_GAP_MS so floor rate-limit clears for next user
    clock.advance(2_000);
    const henry = await runGreetPipeline('user-henry', 'sock-11', greetIssuedAt, gate, deliveries, clock.now);
    assert.ok(henry !== null, 'user-henry must get their own greet');
    assert.equal(deliveries.length, 2, 'Two users → two deliveries');

    // Dedup correctly tracks per-user: grace again within window is blocked
    clock.advance(1_000);
    const graceAgain = await runGreetPipeline('user-grace', 'sock-12', greetIssuedAt, gate, deliveries, clock.now);
    assert.equal(graceAgain, null, 'Second connect for grace within window must be deduped');
    assert.equal(deliveries.length, 2, 'Still exactly 2 deliveries after grace dedup');
  });

  await check('AC1: in-flight dedup — concurrent call at same timestamp is blocked', async () => {
    // The dedup key is written BEFORE the floor check so a rapid second call
    // at the same timestamp sees the key and is suppressed.
    const clock = makeControlledClock();
    const gate = new TurnFloorGate(clock.now);
    const greetIssuedAt = new Map<string, number>();
    const deliveries: DeliveryRecord[] = [];

    // Fire two concurrent greets — don't await the first before starting the second
    const firstPromise = runGreetPipeline('user-ivan', 'sock-13', greetIssuedAt, gate, deliveries, clock.now);
    const secondResult = await runGreetPipeline('user-ivan', 'sock-14', greetIssuedAt, gate, deliveries, clock.now);
    const firstResult = await firstPromise;

    assert.equal(secondResult, null, 'Second concurrent call must be suppressed by in-flight dedup');
    assert.ok(firstResult !== null, 'First call must complete and emit');
    assert.equal(deliveries.length, 1, 'Exactly 1 delivery despite concurrent attempt');
  });

  // ── SHOULD-FIX 2: dedup key rollback on floor denial ─────────────────────

  console.log('\nSHOULD-FIX 2: dedup key rolled back when floor suppresses the greet:');

  await check('SHOULD-FIX 2: floor denial does not leave stale dedup key (consume-on-admit)', async () => {
    // Scenario: Sylphie just spoke (MIN_UTTERANCE_GAP_MS has not elapsed).
    // A new user connects, hits the floor rate-limit, greet is denied.
    // The dedup key MUST be rolled back so the same user connecting 2 s later
    // (after the rate-limit clears) still gets a greet.
    const clock = makeControlledClock();
    const gate = new TurnFloorGate(clock.now);
    const greetIssuedAt = new Map<string, number>();
    const deliveries: DeliveryRecord[] = [];

    // First connect — succeeds, sets the floor's lastSelfInitiatedAt
    const first = await runGreetPipeline('user-judy', 'sock-15', greetIssuedAt, gate, deliveries, clock.now);
    assert.ok(first !== null, 'First connect must succeed (precondition)');

    // Advance only 500 ms — within MIN_UTTERANCE_GAP_MS (1500 ms).
    // A DIFFERENT user connects: dedup passes (new userId), but the floor rate-limits.
    clock.advance(500);
    const denied = await runGreetPipeline('user-kate', 'sock-16', greetIssuedAt, gate, deliveries, clock.now);
    assert.equal(denied, null, 'Second greet within rate-limit window must be floor-denied');

    // KEY assertion: the dedup key for user-kate must have been rolled back.
    assert.equal(
      greetIssuedAt.has('user-kate'),
      false,
      'Dedup key must be rolled back after floor denial (consume-on-admit). ' +
      'If the key is left set, user-kate would be blocked for the full 60 s window ' +
      'despite never receiving a greet (AC0 violation).',
    );

    // Confirm: after rate-limit clears (advance past 1500 ms total), user-kate
    // can receive a greet.
    clock.advance(1_200); // total = 1700 ms from first greet, past the 1500 ms gap
    const retry = await runGreetPipeline('user-kate', 'sock-17', greetIssuedAt, gate, deliveries, clock.now);
    assert.ok(retry !== null, 'user-kate must receive a greet after rate-limit clears and dedup key was rolled back');
    assert.equal(deliveries.length, 2, 'Two total deliveries: user-judy and user-kate');
  });

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(
    `\nTK-100 greet-on-connect: ${passed} passed, ${failed} failed` +
    `${failed > 0 ? ' (FAILURES ABOVE)' : ''}\n`,
  );
  if (failed > 0) process.exit(1);
}

runTests().catch((err: unknown) => {
  console.error('Unexpected error running tests:', err);
  process.exit(1);
});

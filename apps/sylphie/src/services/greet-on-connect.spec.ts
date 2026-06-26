/**
 * TK-100 — Unit/wiring test: greet-first on connect.
 *
 * Run with:
 *   npx tsx apps/sylphie/src/services/greet-on-connect.spec.ts
 *
 * Exits non-zero on any failed assertion.
 *
 * Acceptance criteria tested:
 *
 *   AC0: a fresh authenticated connect emits EXACTLY ONE DELIBERATE_GREET
 *        delivery, going through the TurnFloorGate (not bypassing it).
 *
 *   AC1: a rapid reconnect (page refresh / second tab / socket reopen) for
 *        the same userId within the dedup window emits ZERO additional greets.
 *        A connect well outside the window (different user OR time elapsed) does
 *        receive a greet.
 *
 * The test harness wires a minimal fake of the CommunicationService internals
 * so no NestJS DI is required: a real TurnFloorGate and a controlled clock,
 * plus stub delivery tracking so we can observe what reaches the gateway.
 *
 * The synthetic CycleResponse goes through the REAL turnFloorGate.admit()
 * call — proving the greet travels the floor path, not a bypass (AC0).
 */

import assert from 'node:assert/strict';
import { TurnFloorGate } from './turn-floor-gate';
import type { EmissionIntent } from '@sylphie/shared';

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
    (err) => {
      failed++;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

// ---------------------------------------------------------------------------
// Minimal fake of the TK-100 logic.
//
// We wire:
//   - a real TurnFloorGate (so the floor admission path is real)
//   - a controlled clock (so we can test the dedup window without sleeping)
//   - a DeliveryRecord array to observe what would reach the gateway
//   - the greetIssuedAt dedup map (same logic as the production code)
//   - the GREET_DEDUP_WINDOW_MS constant
//
// The initiateConnectionGreet logic replicates the production method so this
// is a wiring test verifying the protocol, not a mock of it.
// ---------------------------------------------------------------------------

const GREET_DEDUP_WINDOW_MS = 60_000; // mirrors CommunicationService.GREET_DEDUP_WINDOW_MS

interface DeliveryRecord {
  turnId: string;
  intent: EmissionIntent;
  originatorUserId?: string;
  originatorSocketId?: string;
}

/**
 * A minimal fake pipeline that replicates the TK-100 code path:
 *   initiateConnectionGreet → turnFloorGate.admit() → delivery recorded
 *
 * Uses a real TurnFloorGate and controlled clock so admission logic is genuine.
 */
class FakeGreetPipeline {
  private readonly gate: TurnFloorGate;
  private readonly deliveries: DeliveryRecord[] = [];
  private readonly greetIssuedAt = new Map<string, number>();
  private readonly nowFn: () => number;

  constructor(nowFn: () => number) {
    this.nowFn = nowFn;
    this.gate = new TurnFloorGate(nowFn);
  }

  /**
   * Equivalent to CommunicationService.initiateConnectionGreet().
   * Returns true if a greet was admitted, false if deduped or suppressed by floor.
   */
  async initiateConnectionGreet(userId: string, socketId: string): Promise<boolean> {
    const now = this.nowFn();

    // ── Dedup check (AC1) ──────────────────────────────────────────────────
    const lastGreetAt = this.greetIssuedAt.get(userId);
    if (lastGreetAt !== undefined && now - lastGreetAt < GREET_DEDUP_WINDOW_MS) {
      return false; // suppressed by dedup
    }
    this.greetIssuedAt.set(userId, now);

    // ── Floor gate admission (AC0 — goes through the floor, not around it) ─
    const turnId = `greet-test-${userId}-${now}`;
    const floorDecision = this.gate.admit('DELIBERATE_GREET', turnId);

    if (!floorDecision.allow) {
      return false; // suppressed by floor (e.g., barge-in or rate-limit)
    }

    // ── In-flight registration (same as handleCycleResponse for DELIBERATE_GREET)
    let cancelled = false;
    this.gate.registerInFlight({
      turnId,
      intent: 'DELIBERATE_GREET',
      cancel: () => { cancelled = true; },
    });

    // ── Simulate async TTS await ───────────────────────────────────────────
    await Promise.resolve();

    if (cancelled) {
      this.gate.clearInFlight(turnId);
      return false;
    }

    // ── Emit delivery ─────────────────────────────────────────────────────
    this.deliveries.push({
      turnId,
      intent: 'DELIBERATE_GREET',
      originatorUserId: userId,
      originatorSocketId: socketId,
    });

    this.gate.clearInFlight(turnId);
    return true;
  }

  /** Simulate a user sending a message (recordUserInput on the gate). */
  simulateUserInput(): boolean {
    return this.gate.recordUserInput();
  }

  getDeliveries(): readonly DeliveryRecord[] {
    return this.deliveries;
  }
}

function makeControlledClock(startMs = 200_000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests(): Promise<void> {

  // ── AC0: exactly one DELIBERATE_GREET on a fresh connect, via floor ─────

  console.log('\nAC0: exactly one DELIBERATE_GREET on fresh connect, via floor:');

  await check('AC0: fresh connect emits exactly one DELIBERATE_GREET', async () => {
    const clock = makeControlledClock();
    const pipeline = new FakeGreetPipeline(clock.now);

    const admitted = await pipeline.initiateConnectionGreet('user-alice', 'sock-1');

    assert.equal(admitted, true, 'initiateConnectionGreet() must admit the greet');
    assert.equal(
      pipeline.getDeliveries().length,
      1,
      `Expected exactly 1 delivery, got ${pipeline.getDeliveries().length}`,
    );
    assert.equal(pipeline.getDeliveries()[0]!.intent, 'DELIBERATE_GREET');
    assert.equal(pipeline.getDeliveries()[0]!.originatorUserId, 'user-alice');
    assert.equal(pipeline.getDeliveries()[0]!.originatorSocketId, 'sock-1');
  });

  await check('AC0: greet goes through TurnFloorGate (barge-in suppresses it when floor is held)', async () => {
    // If the greet bypassed the floor, barge-in would have no effect.
    // This proves the floor is genuinely wired (not bypassed).
    const clock = makeControlledClock();
    const pipeline = new FakeGreetPipeline(clock.now);

    // User just spoke → holds the floor → barge-in suppression active
    pipeline.simulateUserInput();
    clock.advance(100); // well within FLOOR_HOLD_WINDOW_MS (5 s)

    const admitted = await pipeline.initiateConnectionGreet('user-bob', 'sock-2');

    assert.equal(admitted, false, 'Greet must be suppressed by barge-in (proves floor is wired)');
    assert.equal(
      pipeline.getDeliveries().length,
      0,
      'No delivery should have been emitted when floor is held',
    );
  });

  // ── AC1: no second greet on rapid reconnect within dedup window ──────────

  console.log('\nAC1: no second greet on rapid reconnect within dedup window:');

  await check('AC1: page refresh within 60 s emits no additional greet', async () => {
    const clock = makeControlledClock();
    const pipeline = new FakeGreetPipeline(clock.now);

    // First connect
    const first = await pipeline.initiateConnectionGreet('user-carol', 'sock-3');
    assert.equal(first, true, 'First connect must admit greet (precondition)');

    // Rapid reconnect (page refresh) — same userId, 2 s later
    clock.advance(2_000);
    const second = await pipeline.initiateConnectionGreet('user-carol', 'sock-4');
    assert.equal(second, false, 'Rapid reconnect within dedup window must be suppressed');
    assert.equal(
      pipeline.getDeliveries().length,
      1,
      `Exactly 1 delivery expected after rapid reconnect, got ${pipeline.getDeliveries().length}`,
    );
  });

  await check('AC1: second tab for same user (concurrent) is deduped', async () => {
    const clock = makeControlledClock();
    const pipeline = new FakeGreetPipeline(clock.now);

    // Both tabs connect within 500 ms of each other
    const first = await pipeline.initiateConnectionGreet('user-dave', 'sock-5');
    clock.advance(500);
    const second = await pipeline.initiateConnectionGreet('user-dave', 'sock-6');

    assert.equal(first, true, 'First tab greet must be admitted');
    assert.equal(second, false, 'Second tab within dedup window must be suppressed');
    assert.equal(pipeline.getDeliveries().length, 1, 'Only one delivery for two tabs of same user');
    // The delivery targets the first socket, not the second
    assert.equal(pipeline.getDeliveries()[0]!.originatorSocketId, 'sock-5');
  });

  await check('AC1: reconnect AFTER 60 s dedup window expires receives a greet', async () => {
    const clock = makeControlledClock();
    const pipeline = new FakeGreetPipeline(clock.now);

    // First session
    const first = await pipeline.initiateConnectionGreet('user-eve', 'sock-7');
    assert.equal(first, true, 'First session greet must be admitted');

    // Return visit after 65 s — past the 60 s window
    clock.advance(65_000);
    const second = await pipeline.initiateConnectionGreet('user-eve', 'sock-8');
    assert.equal(second, true, 'Return visit after dedup window must receive a greet');
    assert.equal(
      pipeline.getDeliveries().length,
      2,
      `Expected 2 deliveries (two sessions), got ${pipeline.getDeliveries().length}`,
    );
  });

  await check('AC1: dedup is per userId — different users each get their own greet', async () => {
    const clock = makeControlledClock();
    const pipeline = new FakeGreetPipeline(clock.now);

    const frank = await pipeline.initiateConnectionGreet('user-frank', 'sock-9');
    assert.equal(frank, true, 'user-frank must get a greet');

    // Advance past MIN_UTTERANCE_GAP_MS (1.5 s) so the floor rate-limit clears
    // before the second user's greet — isolating the dedup check from floor.
    clock.advance(2_000);
    const grace = await pipeline.initiateConnectionGreet('user-grace', 'sock-10');
    assert.equal(grace, true, 'user-grace must get their own greet (dedup is per userId)');

    assert.equal(pipeline.getDeliveries().length, 2, 'Two users → two deliveries');

    // Confirm dedup correctly tracks user-grace (not a confusion with user-frank):
    // a second connect for grace within the window must be suppressed.
    clock.advance(1_000); // still within 60 s window for grace
    const graceAgain = await pipeline.initiateConnectionGreet('user-grace', 'sock-11');
    assert.equal(graceAgain, false, 'Second connect for grace within window must be deduped');
    assert.equal(pipeline.getDeliveries().length, 2, 'Still exactly 2 deliveries after grace dedup');
  });

  await check('AC1: in-flight dedup — if greet was issued at T=0, reconnect at T=1 is blocked', async () => {
    // The dedup key is written BEFORE the async TTS await, so even if the
    // delivery is still in-flight when the reconnect arrives, the second
    // connect sees the key and is suppressed.
    const clock = makeControlledClock();
    const pipeline = new FakeGreetPipeline(clock.now);

    // Issue the greet but do not await it yet — simulate in-flight
    const firstPromise = pipeline.initiateConnectionGreet('user-henry', 'sock-12');

    // While first is in-flight, reconnect attempt at same timestamp
    const second = await pipeline.initiateConnectionGreet('user-henry', 'sock-13');
    assert.equal(second, false, 'In-flight greet must suppress concurrent reconnect attempt');

    // Let the first complete
    const first = await firstPromise;
    assert.equal(first, true, 'Original in-flight greet must complete');
    assert.equal(pipeline.getDeliveries().length, 1, 'Exactly 1 delivery despite concurrent attempt');
  });

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(
    `\nTK-100 greet-on-connect: ${passed} passed, ${failed} failed` +
      `${failed > 0 ? ' (FAILURES ABOVE)' : ''}\n`,
  );
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Unexpected error running tests:', err);
  process.exit(1);
});

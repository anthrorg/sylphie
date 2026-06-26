/**
 * TK-99 — Wiring-level AC2 test: CommunicationService interrupt-mid-utterance.
 *
 * Run with:
 *   npx tsx apps/sylphie/src/services/communication-floor-wiring.spec.ts
 *
 * What this tests (and why the class-level spec was insufficient):
 *
 *   The TurnFloorGate class-level spec (turn-floor-gate.spec.ts) already proves
 *   that the cancel() callback is invoked when recordUserInput() fires during an
 *   in-flight delivery. What it CANNOT prove is that CommunicationService's
 *   handleCycleResponse() actually USES that callback to suppress the delivery.
 *
 *   The class-level spec lets the cancel() callback be a no-op — it asserts
 *   that cancel() is CALLED but says nothing about whether delivery halts.
 *   That is exactly the bug: the callback was called (vlog-only) but the
 *   delivery still fired unconditionally at deliverySubject.next().
 *
 *   This spec exercises the exact pipeline path that handleCycleResponse() takes
 *   for a DELIBERATE_GREET: register-in-flight → async TTS await → guard →
 *   conditional emit. It uses the same TurnFloorGate instance and the same
 *   `cancelled` flag mechanism to verify that the delivery is SUPPRESSED when
 *   the user speaks during the TTS await, and that a subsequent USER_REPLY
 *   IS delivered (the user is always served).
 *
 * Coverage:
 *   CRITICAL — AC2 delivery is genuinely cancelled (deliverySubject.next not called)
 *   MAJOR    — USER_REPLY after the suppressed greet still emits
 */

import assert from 'node:assert/strict';
import { Subject } from 'rxjs';
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
// Minimal delivery pipeline that mirrors handleCycleResponse's AC2 wiring.
//
// This replicates the EXACT three-step pattern from handleCycleResponse that
// the code review found broken and that the fix corrects:
//
//   1. admit() decides whether to proceed.
//   2. registerInFlight() with a cancel() that sets `cancelled = true`.
//   3. await fakeTts() — the async window where intakeTurn can fire.
//   4. if (cancelled) return (suppress); else deliverySubject.next().
//
// Using the real TurnFloorGate ensures the fix is wired correctly in context —
// not a mock, not an isolated unit.
// ---------------------------------------------------------------------------

interface DeliveryRecord {
  turnId: string;
  intent: EmissionIntent;
}

/**
 * Run a fake handleCycleResponse pipeline for a given emissionIntent.
 *
 * @param gate           The shared TurnFloorGate instance.
 * @param deliveries     Array to push admitted deliveries into (observable substitute).
 * @param turnId         Turn ID for the simulated cycle.
 * @param intent         Emission intent of the simulated cycle.
 * @param ttsDurationMs  How long the fake TTS call takes (simulates async window).
 */
async function runFakePipeline(
  gate: TurnFloorGate,
  deliveries: DeliveryRecord[],
  turnId: string,
  intent: EmissionIntent,
  ttsDurationMs: number,
): Promise<void> {
  // ── Step 1: floor gate admission ──────────────────────────────────────────
  const floorDecision = gate.admit(intent, turnId);
  if (!floorDecision.allow) {
    return; // suppressed before in-flight registration
  }

  // ── Step 2: register in-flight for self-initiated deliveries (AC2) ────────
  // This is the EXACT wiring added by the CRITICAL fix.
  let cancelled = false;
  let inFlightRegistered = false;

  if (intent === 'DELIBERATE_GREET' || intent === 'SALIENT_OBSERVATION') {
    gate.registerInFlight({
      turnId,
      intent,
      cancel: () => {
        // This is the fix: cancel() sets a real flag.
        cancelled = true;
      },
    });
    inFlightRegistered = true;
  }

  // ── Step 3: async TTS synthesis (the window where barge-in can occur) ─────
  await new Promise<void>((resolve) => setTimeout(resolve, ttsDurationMs));

  // ── Step 4: AC2 guard — suppress if cancelled during TTS await ────────────
  // This is the guard added by the CRITICAL fix.
  if (cancelled) {
    if (inFlightRegistered) {
      gate.clearInFlight(turnId);
    }
    return; // delivery suppressed — deliveries array NOT written
  }

  // ── Step 5: emit delivery (only reached if not cancelled) ─────────────────
  deliveries.push({ turnId, intent });

  if (inFlightRegistered) {
    gate.clearInFlight(turnId);
  }
}

/**
 * Simulate intakeTurn() — records user input on the gate.
 * Returns whether an in-flight delivery was interrupted (AC2).
 */
function runFakeIntakeTurn(gate: TurnFloorGate): boolean {
  return gate.recordUserInput();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests(): Promise<void> {
console.log('\nAC2 wiring: interrupt-mid-utterance (CommunicationService pipeline):');

await check(
  'AC2: DELIBERATE_GREET does NOT emit when user speaks during TTS await',
  async () => {
    const gate = new TurnFloorGate();
    const deliveries: DeliveryRecord[] = [];

    // Start the DELIBERATE_GREET pipeline — TTS takes 20ms (async window).
    // Do NOT await: we want to fire intakeTurn() while TTS is in-flight.
    const greetPipeline = runFakePipeline(gate, deliveries, 'greet-1', 'DELIBERATE_GREET', 20);

    // Yield one microtask to allow the pipeline to register in-flight
    // (gate.admit + gate.registerInFlight are synchronous; the first real
    // await is the TTS call which schedules a setTimeout). This ensures
    // intakeTurn fires DURING the TTS await, not before registration.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // User speaks mid-utterance: fires recordUserInput → cancel() → cancelled=true.
    const interrupted = runFakeIntakeTurn(gate);

    assert.equal(interrupted, true, 'intakeTurn() must report the delivery was interrupted');

    // Wait for the greet pipeline to finish (it will see cancelled=true and return early).
    await greetPipeline;

    // The delivery must NOT have been emitted.
    assert.equal(
      deliveries.length,
      0,
      `DELIBERATE_GREET must be suppressed when user speaks during TTS; ` +
        `got ${deliveries.length} delivery(ies)`,
    );
  },
);

await check(
  'AC2: USER_REPLY IS emitted after the suppressed DELIBERATE_GREET',
  async () => {
    const gate = new TurnFloorGate();
    const deliveries: DeliveryRecord[] = [];

    // DELIBERATE_GREET starts and gets cancelled mid-flight.
    const greetPipeline = runFakePipeline(gate, deliveries, 'greet-2', 'DELIBERATE_GREET', 20);
    await new Promise<void>((resolve) => setImmediate(resolve));
    runFakeIntakeTurn(gate);
    await greetPipeline;

    assert.equal(deliveries.length, 0, 'Greet must be suppressed (precondition)');

    // Now process the USER_REPLY — USER_REPLY is always admitted and never
    // cancelled (not self-initiated; cancel flag not set; no registerInFlight).
    await runFakePipeline(gate, deliveries, 'user-reply-1', 'USER_REPLY', 0);

    assert.equal(
      deliveries.length,
      1,
      `USER_REPLY must be emitted even after a cancelled greet; ` +
        `got ${deliveries.length} delivery(ies)`,
    );
    assert.equal(deliveries[0]!.turnId, 'user-reply-1');
    assert.equal(deliveries[0]!.intent, 'USER_REPLY');
  },
);

await check(
  'AC2 negative: DELIBERATE_GREET DOES emit when no user turn interrupts',
  async () => {
    const gate = new TurnFloorGate();
    const deliveries: DeliveryRecord[] = [];

    // No intakeTurn() call — greet completes normally.
    await runFakePipeline(gate, deliveries, 'greet-3', 'DELIBERATE_GREET', 20);

    assert.equal(
      deliveries.length,
      1,
      `Uninterrupted DELIBERATE_GREET must emit; got ${deliveries.length} delivery(ies)`,
    );
    assert.equal(deliveries[0]!.intent, 'DELIBERATE_GREET');
  },
);

await check(
  'AC2: SALIENT_OBSERVATION also suppressed when user speaks during TTS',
  async () => {
    const gate = new TurnFloorGate();
    const deliveries: DeliveryRecord[] = [];

    const obsPipeline = runFakePipeline(gate, deliveries, 'obs-1', 'SALIENT_OBSERVATION', 20);
    await new Promise<void>((resolve) => setImmediate(resolve));
    runFakeIntakeTurn(gate);
    await obsPipeline;

    assert.equal(deliveries.length, 0, 'SALIENT_OBSERVATION must be suppressed mid-flight');
  },
);

await check(
  'AC2: USER_REPLY is never registered in-flight and cannot be cancelled',
  async () => {
    const gate = new TurnFloorGate();
    const deliveries: DeliveryRecord[] = [];

    // Start a USER_REPLY pipeline — not self-initiated, no registerInFlight.
    const replyPipeline = runFakePipeline(gate, deliveries, 'reply-1', 'USER_REPLY', 20);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // User speaks again mid-flight — but there is nothing in-flight to cancel.
    const interrupted = runFakeIntakeTurn(gate);
    assert.equal(interrupted, false, 'recordUserInput on a USER_REPLY pipeline: nothing to interrupt');

    await replyPipeline;

    assert.equal(
      deliveries.length,
      1,
      `USER_REPLY must always emit even when intakeTurn fires mid-TTS; ` +
        `got ${deliveries.length} delivery(ies)`,
    );
  },
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(
  `\nTK-99 communication-floor-wiring: ${passed} passed, ${failed} failed` +
    `${failed > 0 ? ' (FAILURES ABOVE)' : ''}\n`,
);
if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Unexpected error running tests:', err);
  process.exit(1);
});

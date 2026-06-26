/**
 * TK-99 — Unit tests for TurnFloorGate (turn-floor / barge-in gate).
 *
 * Run with:
 *   npx tsx apps/sylphie/src/services/turn-floor-gate.spec.ts
 *
 * Exits non-zero on any failed assertion.
 *
 * Acceptance criteria:
 *
 *   AC0: one-per-turn cap + minimum inter-utterance interval.
 *        A self-initiated cycle within MIN_UTTERANCE_GAP_MS of the previous
 *        one is denied. The first is admitted; subsequent ones are rate-limited.
 *
 *   AC1: barge-in — when the user is mid-typing (holds the floor), a
 *        self-initiated cycle is suppressed, not delivered over the user.
 *
 *   AC2: interrupt-mid-utterance — if Sylphie is delivering a self-initiated
 *        utterance and a real user turn arrives, the in-flight delivery is
 *        cancelled and the user turn is admitted.
 *
 *   AC3: DELIBERATE_GREET passes through the floor as the one-per-turn
 *        contribution. Origin is never the gating criterion.
 *
 *   USER_REPLY is ALWAYS served (gate never suppresses a genuine reply).
 *   AMBIENT_NONE produces zero deliveries.
 */

import assert from 'node:assert/strict';
import {
  TurnFloorGate,
  MIN_UTTERANCE_GAP_MS,
  FLOOR_HOLD_WINDOW_MS,
} from './turn-floor-gate';
import type { EmissionIntent } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// Controlled clock: starts at a fixed epoch and can be advanced manually.
function makeControlledClock(startMs = 100_000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
  };
}

// ---------------------------------------------------------------------------
// AMBIENT_NONE — always suppressed
// ---------------------------------------------------------------------------

console.log('\nAMBIENT_NONE suppression:');

check('AMBIENT_NONE is always denied (no prior state)', () => {
  const gate = new TurnFloorGate();
  const result = gate.admit('AMBIENT_NONE', 'turn-1');
  assert.equal(result.allow, false);
  assert.ok(result.reason.includes('AMBIENT_NONE'));
});

check('AMBIENT_NONE is denied even after a long silence', () => {
  const clock = makeControlledClock();
  const gate = new TurnFloorGate(clock.now);
  clock.advance(60_000); // 60 seconds with no activity
  const result = gate.admit('AMBIENT_NONE', 'turn-1');
  assert.equal(result.allow, false);
});

check('AMBIENT_NONE is denied even when no user input has ever arrived', () => {
  const gate = new TurnFloorGate();
  // Simulate a burst of AMBIENT_NONE cycles
  for (let i = 0; i < 10; i++) {
    const result = gate.admit('AMBIENT_NONE', `turn-${i}`);
    assert.equal(result.allow, false, `AMBIENT_NONE turn-${i} should be denied`);
  }
});

// ---------------------------------------------------------------------------
// USER_REPLY — always served
// ---------------------------------------------------------------------------

console.log('\nUSER_REPLY always served:');

check('USER_REPLY is always admitted (fresh gate)', () => {
  const gate = new TurnFloorGate();
  const result = gate.admit('USER_REPLY', 'turn-1');
  assert.equal(result.allow, true);
  assert.ok(result.reason.includes('USER_REPLY'));
});

check('USER_REPLY is admitted even when user just spoke (no barge-in for own reply)', () => {
  const clock = makeControlledClock();
  const gate = new TurnFloorGate(clock.now);
  // User spoke 100ms ago — floor is held
  gate.recordUserInput();
  clock.advance(100);
  // But the reply for THAT user turn must still get through
  const result = gate.admit('USER_REPLY', 'turn-reply');
  assert.equal(result.allow, true);
  assert.equal(result.interruptedInFlight, false);
});

check('USER_REPLY is admitted even immediately after another USER_REPLY (back-to-back)', () => {
  const clock = makeControlledClock();
  const gate = new TurnFloorGate(clock.now);
  const r1 = gate.admit('USER_REPLY', 'turn-1');
  assert.equal(r1.allow, true);
  // Immediately — no time passes
  const r2 = gate.admit('USER_REPLY', 'turn-2');
  assert.equal(r2.allow, true);
});

check('USER_REPLY is admitted even when AMBIENT_NONE was just suppressed', () => {
  const gate = new TurnFloorGate();
  gate.admit('AMBIENT_NONE', 'ambient-1');
  gate.admit('AMBIENT_NONE', 'ambient-2');
  const reply = gate.admit('USER_REPLY', 'turn-1');
  assert.equal(reply.allow, true);
});

// ---------------------------------------------------------------------------
// AC0 — one-per-turn cap / minimum inter-utterance interval
// ---------------------------------------------------------------------------

console.log('\nAC0: one-per-turn cap + rate-limiting:');

check('AC0: first SALIENT_OBSERVATION after silence is admitted', () => {
  const clock = makeControlledClock(200_000); // well past any window
  const gate = new TurnFloorGate(clock.now);
  const result = gate.admit('SALIENT_OBSERVATION', 'turn-1');
  assert.equal(result.allow, true);
});

check('AC0: second SALIENT_OBSERVATION within MIN_UTTERANCE_GAP_MS is denied', () => {
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);
  const r1 = gate.admit('SALIENT_OBSERVATION', 'turn-1');
  assert.equal(r1.allow, true);
  // Advance by less than the minimum gap
  clock.advance(MIN_UTTERANCE_GAP_MS - 1);
  const r2 = gate.admit('SALIENT_OBSERVATION', 'turn-2');
  assert.equal(r2.allow, false);
  assert.ok(r2.reason.includes('Rate-limited'), `Expected rate-limit reason, got: "${r2.reason}"`);
});

check('AC0: SALIENT_OBSERVATION admitted after MIN_UTTERANCE_GAP_MS elapses', () => {
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);
  gate.admit('SALIENT_OBSERVATION', 'turn-1');
  clock.advance(MIN_UTTERANCE_GAP_MS); // exactly at boundary
  const r2 = gate.admit('SALIENT_OBSERVATION', 'turn-2');
  assert.equal(r2.allow, true);
});

check('AC0: runaway (6 cycles fast) → only first is admitted', () => {
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);
  let admittedCount = 0;
  for (let i = 0; i < 6; i++) {
    clock.advance(50); // 50ms between cycles — well within rate-limit window
    const r = gate.admit('SALIENT_OBSERVATION', `turn-${i}`);
    if (r.allow) admittedCount++;
  }
  assert.equal(admittedCount, 1, `Expected exactly 1 admitted out of 6 fast cycles, got ${admittedCount}`);
});

check('AC0: USER_REPLY does NOT advance the rate-limit clock (self-initiated clock is separate)', () => {
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);
  // Three USER_REPLY deliveries
  gate.admit('USER_REPLY', 'user-1');
  gate.admit('USER_REPLY', 'user-2');
  gate.admit('USER_REPLY', 'user-3');
  // Now a SALIENT_OBSERVATION — no prior self-initiated delivery, so admitted
  const r = gate.admit('SALIENT_OBSERVATION', 'self-1');
  assert.equal(r.allow, true, 'First self-initiated after USER_REPLYs should be admitted');
});

// ---------------------------------------------------------------------------
// AC1 — barge-in suppression
// ---------------------------------------------------------------------------

console.log('\nAC1: barge-in suppression:');

check('AC1: self-initiated suppressed when user just spoke (within FLOOR_HOLD_WINDOW_MS)', () => {
  const clock = makeControlledClock();
  const gate = new TurnFloorGate(clock.now);
  gate.recordUserInput(); // user speaks
  clock.advance(FLOOR_HOLD_WINDOW_MS - 1); // still within window
  const result = gate.admit('DELIBERATE_GREET', 'greet-1');
  assert.equal(result.allow, false);
  assert.ok(result.reason.includes('Barge-in'), `Expected barge-in reason, got: "${result.reason}"`);
});

check('AC1: self-initiated admitted after FLOOR_HOLD_WINDOW_MS elapses', () => {
  const clock = makeControlledClock();
  const gate = new TurnFloorGate(clock.now);
  gate.recordUserInput();
  clock.advance(FLOOR_HOLD_WINDOW_MS); // exactly at boundary
  const result = gate.admit('DELIBERATE_GREET', 'greet-1');
  assert.equal(result.allow, true);
});

check('AC1: SALIENT_OBSERVATION also suppressed by barge-in', () => {
  const clock = makeControlledClock();
  const gate = new TurnFloorGate(clock.now);
  gate.recordUserInput();
  clock.advance(100); // well within window
  const result = gate.admit('SALIENT_OBSERVATION', 'obs-1');
  assert.equal(result.allow, false);
});

check('AC1: USER_REPLY is NOT affected by barge-in (own reply must come back)', () => {
  const clock = makeControlledClock();
  const gate = new TurnFloorGate(clock.now);
  gate.recordUserInput();
  clock.advance(10); // immediately
  const result = gate.admit('USER_REPLY', 'reply-1');
  assert.equal(result.allow, true, 'USER_REPLY must pass even when user holds floor');
});

// ---------------------------------------------------------------------------
// AC2 — interrupt-mid-utterance
// ---------------------------------------------------------------------------

console.log('\nAC2: interrupt-mid-utterance:');

check('AC2: USER_REPLY cancels in-flight self-initiated delivery', () => {
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);

  let cancelCalled = false;
  gate.registerInFlight({
    turnId: 'self-1',
    intent: 'DELIBERATE_GREET',
    cancel: () => { cancelCalled = true; },
  });
  assert.equal(gate.hasInFlight, true);

  // User sends a message — should interrupt in-flight
  const interrupted = gate.recordUserInput();
  assert.equal(interrupted, true, 'recordUserInput() should return true when it interrupts');
  assert.equal(cancelCalled, true, 'cancel() callback must be invoked on interrupt');
  assert.equal(gate.hasInFlight, false, 'in-flight slot must be cleared after interrupt');
});

check('AC2: admit(USER_REPLY) cancels in-flight via admit path (interruptedInFlight=true)', () => {
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);

  let cancelCalled = false;
  gate.registerInFlight({
    turnId: 'self-1',
    intent: 'DELIBERATE_GREET',
    cancel: () => { cancelCalled = true; },
  });

  const result = gate.admit('USER_REPLY', 'user-reply-1');
  assert.equal(result.allow, true);
  assert.equal(result.interruptedInFlight, true);
  assert.equal(cancelCalled, true);
  assert.equal(gate.hasInFlight, false);
});

check('AC2: recordUserInput returns false when nothing is in-flight', () => {
  const gate = new TurnFloorGate();
  const interrupted = gate.recordUserInput();
  assert.equal(interrupted, false);
});

check('AC2: clearInFlight removes registration after normal delivery', () => {
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);

  gate.registerInFlight({
    turnId: 'self-1',
    intent: 'SALIENT_OBSERVATION',
    cancel: () => {},
  });
  assert.equal(gate.hasInFlight, true);
  gate.clearInFlight('self-1');
  assert.equal(gate.hasInFlight, false, 'in-flight must be cleared after normal delivery');
});

check('AC2: clearInFlight is a no-op for wrong turnId', () => {
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);
  gate.registerInFlight({
    turnId: 'self-1',
    intent: 'DELIBERATE_GREET',
    cancel: () => {},
  });
  gate.clearInFlight('wrong-id'); // does not match
  assert.equal(gate.hasInFlight, true, 'in-flight should remain if turnId does not match');
});

// ---------------------------------------------------------------------------
// AC3 — DELIBERATE_GREET passes through the floor (origin never the criterion)
// ---------------------------------------------------------------------------

console.log('\nAC3: DELIBERATE_GREET passes through:');

check('AC3: DELIBERATE_GREET admitted when floor is clear', () => {
  const clock = makeControlledClock(200_000); // no recent user input
  const gate = new TurnFloorGate(clock.now);
  const result = gate.admit('DELIBERATE_GREET', 'greet-1');
  assert.equal(result.allow, true);
  assert.ok(result.reason.includes('DELIBERATE_GREET'));
});

check('AC3: DELIBERATE_GREET counts as one-per-turn (rate-limits subsequent self-initiated)', () => {
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);
  const r1 = gate.admit('DELIBERATE_GREET', 'greet-1');
  assert.equal(r1.allow, true);
  clock.advance(100); // still within rate-limit window
  // A subsequent SALIENT_OBSERVATION should now be rate-limited
  const r2 = gate.admit('SALIENT_OBSERVATION', 'obs-1');
  assert.equal(r2.allow, false, 'SALIENT_OBSERVATION after DELIBERATE_GREET should be rate-limited');
});

check('AC3: DELIBERATE_GREET is NOT suppressed by "no originator" logic (gate keys on intent)', () => {
  // Per DEC-26/DEC-27: the gate must never suppress based on originator-absence.
  // DELIBERATE_GREET has no originator but must pass through.
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);
  // Verify: the gate only cares about intent, not about originator.
  // We don't even pass an originator here — the gate API doesn't accept one.
  const result = gate.admit('DELIBERATE_GREET', 'greet-no-originator');
  assert.equal(result.allow, true, 'DELIBERATE_GREET must pass regardless of originator absence');
});

check('AC3: DELIBERATE_GREET is suppressed by barge-in (floor holds, origin not the reason)', () => {
  // The floor gates RATE and BARGE-IN — even DELIBERATE_GREET respects barge-in.
  const clock = makeControlledClock();
  const gate = new TurnFloorGate(clock.now);
  gate.recordUserInput(); // user holds floor
  clock.advance(100);
  const result = gate.admit('DELIBERATE_GREET', 'greet-barge-in');
  assert.equal(result.allow, false, 'DELIBERATE_GREET must respect barge-in (floor beats greet)');
  assert.ok(result.reason.includes('Barge-in'), `Expected barge-in reason, got: "${result.reason}"`);
});

// ---------------------------------------------------------------------------
// Integration: combined scenario — user reply after ambient burst
// ---------------------------------------------------------------------------

console.log('\nIntegration scenarios:');

check('Integration: ambient burst then user turn — reply arrives clean (AC0+AC3)', () => {
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);

  // 6 AMBIENT_NONE cycles (runaway condition)
  for (let i = 0; i < 6; i++) {
    clock.advance(50);
    const r = gate.admit('AMBIENT_NONE', `ambient-${i}`);
    assert.equal(r.allow, false, `AMBIENT_NONE burst: turn ${i} should be suppressed`);
  }

  // User sends a message; their reply must arrive unconditionally
  gate.recordUserInput();
  clock.advance(10);
  const reply = gate.admit('USER_REPLY', 'reply-1');
  assert.equal(reply.allow, true, 'USER_REPLY after ambient burst must be admitted');
});

check('Integration: self-initiated, then user interrupts, then user turn replied (AC2)', () => {
  const clock = makeControlledClock(200_000);
  const gate = new TurnFloorGate(clock.now);

  // Sylphie's DELIBERATE_GREET is in-flight
  let greetCancelled = false;
  const r = gate.admit('DELIBERATE_GREET', 'greet-1');
  assert.equal(r.allow, true);
  gate.registerInFlight({
    turnId: 'greet-1',
    intent: 'DELIBERATE_GREET',
    cancel: () => { greetCancelled = true; },
  });

  // User sends message — interrupts greet
  const interrupted = gate.recordUserInput();
  assert.equal(interrupted, true);
  assert.equal(greetCancelled, true, 'Greet delivery must be cancelled');

  // User reply must now be admitted
  clock.advance(10);
  const reply = gate.admit('USER_REPLY', 'reply-1');
  assert.equal(reply.allow, true);
  assert.equal(reply.interruptedInFlight, false, 'The in-flight was already cleared by recordUserInput');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nTK-99 turn-floor-gate: ${passed} passed, ${failed} failed${failed > 0 ? ' (FAILURES ABOVE)' : ''}\n`);
if (failed > 0) process.exit(1);

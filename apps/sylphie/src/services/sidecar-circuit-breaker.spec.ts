/**
 * Self-running assertions for SidecarCircuitBreaker (Phase 4 Wave 2 cluster 3b,
 * `sidecar-control-circuit-breaker`).
 *
 * apps/sylphie has no jest harness, so this follows the house pattern used by
 * graph-compute-3a.spec.ts / theater-affect-scorer.spec.ts: run directly with
 * `npx tsx`, exits non-zero on the first failed assertion.
 *
 *   npx tsx apps/sylphie/src/services/sidecar-circuit-breaker.spec.ts
 */

import assert from 'node:assert';
import {
  SidecarCircuitBreaker,
  SidecarBreakerState,
} from './sidecar-circuit-breaker';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${name}`);
}

// A controllable clock so we can fast-forward the cooldown deterministically.
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

check('starts CLOSED and allows attempts', () => {
  const cb = new SidecarCircuitBreaker();
  assert.equal(cb.getState(), SidecarBreakerState.CLOSED);
  assert.equal(cb.canAttempt(), true);
});

check('failures below threshold keep it CLOSED', () => {
  const cb = new SidecarCircuitBreaker({ failureThreshold: 3 });
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.getState(), SidecarBreakerState.CLOSED);
  assert.equal(cb.canAttempt(), true);
});

check('trips to OPEN at the failure threshold and fails fast', () => {
  const cb = new SidecarCircuitBreaker({ failureThreshold: 3 });
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.getState(), SidecarBreakerState.OPEN);
  assert.equal(cb.canAttempt(), false, 'OPEN must short-circuit');
});

check('a success in CLOSED clears the failure counter', () => {
  const cb = new SidecarCircuitBreaker({ failureThreshold: 3 });
  cb.recordFailure();
  cb.recordFailure();
  cb.recordSuccess();
  assert.equal(cb.getConsecutiveFailures(), 0);
  cb.recordFailure();
  cb.recordFailure();
  // Counter was reset, so two more failures should NOT trip a threshold-3 breaker.
  assert.equal(cb.getState(), SidecarBreakerState.CLOSED);
});

check('OPEN → HALF_OPEN after cooldown elapses', () => {
  const clk = fakeClock();
  const cb = new SidecarCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 1000,
    now: clk.now,
  });
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.getState(), SidecarBreakerState.OPEN);

  // Before cooldown: still fails fast, stays OPEN.
  clk.advance(999);
  assert.equal(cb.canAttempt(), false);
  assert.equal(cb.getState(), SidecarBreakerState.OPEN);

  // After cooldown: one probe allowed, transitions to HALF_OPEN.
  clk.advance(1);
  assert.equal(cb.canAttempt(), true);
  assert.equal(cb.getState(), SidecarBreakerState.HALF_OPEN);
});

check('HALF_OPEN probe success CLOSES the circuit', () => {
  const clk = fakeClock();
  const cb = new SidecarCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 1000,
    now: clk.now,
  });
  cb.recordFailure();
  cb.recordFailure();
  clk.advance(1000);
  cb.canAttempt(); // → HALF_OPEN
  cb.recordSuccess();
  assert.equal(cb.getState(), SidecarBreakerState.CLOSED);
  assert.equal(cb.canAttempt(), true);
});

check('HALF_OPEN probe failure re-OPENS immediately (relapse, no fresh threshold)', () => {
  const clk = fakeClock();
  const cb = new SidecarCircuitBreaker({
    failureThreshold: 5,
    cooldownMs: 1000,
    now: clk.now,
  });
  for (let i = 0; i < 5; i++) cb.recordFailure();
  assert.equal(cb.getState(), SidecarBreakerState.OPEN);
  clk.advance(1000);
  cb.canAttempt(); // → HALF_OPEN
  cb.recordFailure(); // single probe failure
  assert.equal(
    cb.getState(),
    SidecarBreakerState.OPEN,
    'one HALF_OPEN failure must re-trip, not require the full threshold again',
  );
  assert.equal(cb.canAttempt(), false, 're-opened breaker resets the cooldown');
});

check('reset() forces CLOSED', () => {
  const cb = new SidecarCircuitBreaker({ failureThreshold: 1 });
  cb.recordFailure();
  assert.equal(cb.getState(), SidecarBreakerState.OPEN);
  cb.reset();
  assert.equal(cb.getState(), SidecarBreakerState.CLOSED);
  assert.equal(cb.getConsecutiveFailures(), 0);
});

check('full cycle: trip → cooldown → probe → recover', () => {
  const clk = fakeClock();
  const cb = new SidecarCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 500,
    now: clk.now,
  });
  // Healthy.
  cb.recordSuccess();
  assert.equal(cb.canAttempt(), true);
  // Sidecar dies.
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.canAttempt(), false);
  // Cooldown.
  clk.advance(500);
  assert.equal(cb.canAttempt(), true);
  assert.equal(cb.getState(), SidecarBreakerState.HALF_OPEN);
  // Sidecar back up.
  cb.recordSuccess();
  assert.equal(cb.getState(), SidecarBreakerState.CLOSED);
});

// eslint-disable-next-line no-console
console.log(`\nSidecarCircuitBreaker: ${passed} checks passed`);

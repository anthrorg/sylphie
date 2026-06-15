/**
 * Unit tests for SidecarCircuitBreaker — CLOSED / OPEN / HALF_OPEN transitions.
 *
 * Run via: npx tsx packages/supervisor/src/sidecar-circuit-breaker.spec.ts
 *
 * Covers:
 *   1. CLOSED allows requests; below-threshold failures stay CLOSED
 *   2. Reaching the failure threshold trips OPEN and fails fast
 *   3. A success resets the consecutive-failure counter while CLOSED
 *   4. After resetMs an OPEN breaker allows one HALF_OPEN probe
 *   5. A failed HALF_OPEN probe re-trips OPEN immediately
 *   6. A successful HALF_OPEN probe CLOSEs the breaker
 */

import assert from 'node:assert/strict';
import {
  SidecarCircuitBreaker,
  SidecarBreakerState,
} from './sidecar-circuit-breaker.js';

let passed = 0;
function ok(label: string): void {
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ok - ${label}`);
}

// A controllable clock so the OPEN→HALF_OPEN timing is deterministic.
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

// 1. CLOSED allows; below-threshold failures stay CLOSED.
{
  const cb = new SidecarCircuitBreaker(3, 30_000);
  assert.equal(cb.getState(), SidecarBreakerState.CLOSED);
  assert.equal(cb.allowRequest(), true);
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.getState(), SidecarBreakerState.CLOSED);
  assert.equal(cb.allowRequest(), true);
  ok('CLOSED allows requests; below-threshold failures stay CLOSED');
}

// 2. Threshold trips OPEN and fails fast.
{
  const cb = new SidecarCircuitBreaker(3, 30_000);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.getState(), SidecarBreakerState.OPEN);
  assert.equal(cb.allowRequest(), false, 'OPEN must fail fast');
  ok('threshold trips OPEN and fails fast');
}

// 3. Success resets the counter while CLOSED.
{
  const cb = new SidecarCircuitBreaker(3, 30_000);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordSuccess();
  assert.equal(cb.getConsecutiveFailures(), 0);
  // Two more failures should NOT trip (counter was reset).
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.getState(), SidecarBreakerState.CLOSED);
  ok('success resets consecutive-failure counter while CLOSED');
}

// 4. After resetMs OPEN allows one HALF_OPEN probe.
{
  const clock = makeClock();
  const cb = new SidecarCircuitBreaker(2, 30_000, clock.now);
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.getState(), SidecarBreakerState.OPEN);
  assert.equal(cb.allowRequest(), false, 'still OPEN before reset window');

  clock.advance(30_000);
  assert.equal(cb.allowRequest(), true, 'reset window elapsed → probe allowed');
  assert.equal(cb.getState(), SidecarBreakerState.HALF_OPEN);
  ok('OPEN transitions to HALF_OPEN after resetMs and allows a probe');
}

// 5. Failed HALF_OPEN probe re-trips OPEN immediately.
{
  const clock = makeClock();
  const cb = new SidecarCircuitBreaker(2, 30_000, clock.now);
  cb.recordFailure();
  cb.recordFailure();
  clock.advance(30_000);
  cb.allowRequest(); // → HALF_OPEN
  cb.recordFailure(); // probe fails
  assert.equal(cb.getState(), SidecarBreakerState.OPEN);
  assert.equal(cb.allowRequest(), false, 'relapse re-opens, no fresh threshold run');
  ok('failed HALF_OPEN probe re-trips OPEN immediately');
}

// 6. Successful HALF_OPEN probe CLOSEs the breaker.
{
  const clock = makeClock();
  const cb = new SidecarCircuitBreaker(2, 30_000, clock.now);
  cb.recordFailure();
  cb.recordFailure();
  clock.advance(30_000);
  cb.allowRequest(); // → HALF_OPEN
  cb.recordSuccess(); // probe succeeds
  assert.equal(cb.getState(), SidecarBreakerState.CLOSED);
  assert.equal(cb.allowRequest(), true);
  ok('successful HALF_OPEN probe closes the breaker');
}

// eslint-disable-next-line no-console
console.log(`\nSidecarCircuitBreaker: ${passed} assertions passed`);

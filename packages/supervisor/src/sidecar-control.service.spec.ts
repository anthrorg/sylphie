/**
 * Unit tests for SidecarControlService — corrected payload contract + breaker.
 *
 * Run via: npx tsx packages/supervisor/src/sidecar-control.service.spec.ts
 *
 * Covers:
 *   1. reinforce sends { actionId, inputVector, strengthFactor } (NOT the old
 *      { type, cycle_id, weight, reason } shape)
 *   2. reinforce/correct are SKIPPED (not POSTed) when inputVector is absent —
 *      no fabricated/zeroed vector, no guaranteed 422
 *   3. correct sends { actionId, inputVector, correctCategory }
 *   4. boost_salience POSTs { category, multiplier } and works WITHOUT a vector
 *      (and includes inputVector when a seed is present)
 *   5. the breaker opens after repeated sidecar failures and then fails fast
 */

import assert from 'node:assert/strict';
import { SidecarControlService } from './sidecar-control.service.js';
import { SidecarBreakerState } from './sidecar-circuit-breaker.js';
import type { SupervisorIntervention } from './interfaces/supervisor.types.js';

let passed = 0;
function ok(label: string): void {
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ok - ${label}`);
}

// Minimal ConfigService stub.
const config = { get: (_k: string, d: string) => d } as any;

interface Captured {
  url: string;
  body: any;
}

/** Install a fake fetch that captures calls and returns a scripted result. */
function installFetch(
  result: { ok: boolean; status?: number; json?: any } | (() => never),
): Captured[] {
  const calls: Captured[] = [];
  (globalThis as any).fetch = async (url: string, opts: any) => {
    calls.push({
      url,
      body: opts?.body ? JSON.parse(opts.body) : undefined,
    });
    if (typeof result === 'function') result();
    return {
      ok: result.ok,
      status: result.status ?? (result.ok ? 200 : 500),
      statusText: result.ok ? 'OK' : 'ERR',
      json: async () => result.json ?? { accepted: result.ok },
    };
  };
  return calls;
}

function intervention(
  over: Partial<SupervisorIntervention>,
): SupervisorIntervention {
  return {
    type: 'reinforce',
    source: 'supervisor',
    timestamp: new Date(),
    cycleId: 'cycle-1',
    ...over,
  };
}

async function run(): Promise<void> {
// 1. reinforce with a vector → correct shape.
{
  const calls = installFetch({ ok: true, json: { accepted: true } });
  const svc = new SidecarControlService(config);
  const vec = Array.from({ length: 1561 }, () => 0.1);
  const res = await svc.executeIntervention(
    intervention({
      type: 'reinforce',
      inputVector: vec,
      correctionData: { type: 'reinforce', targetAction: 'wave', reason: 'good' },
    }),
  );
  assert.equal(res.accepted, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/cognition\/control\/reinforce$/);
  // New contract — exact keys, no legacy keys.
  assert.deepEqual(Object.keys(calls[0].body).sort(), [
    'actionId',
    'inputVector',
    'strengthFactor',
  ]);
  assert.equal(calls[0].body.actionId, 'wave');
  assert.equal(calls[0].body.inputVector.length, 1561);
  // The REAL vector is forwarded verbatim — not zeroed/fabricated. This is the
  // loop-close assertion: a populated inputVector reaches the sidecar untouched.
  assert.deepEqual(calls[0].body.inputVector, vec, 'real inputVector forwarded byte-for-byte');
  assert.ok(
    calls[0].body.inputVector.some((v: number) => v !== 0),
    'a real (non-zero) vector is sent, not a fabricated zero vector',
  );
  assert.equal(typeof calls[0].body.strengthFactor, 'number');
  assert.equal(calls[0].body.type, undefined, 'legacy `type` must be gone');
  assert.equal(calls[0].body.cycle_id, undefined, 'legacy `cycle_id` must be gone');
  ok('reinforce sends the REAL { actionId, inputVector, strengthFactor } (not the skip path)');
}

// 2. reinforce WITHOUT a vector → skipped, no POST, honest error.
{
  const calls = installFetch({ ok: true });
  const svc = new SidecarControlService(config);
  const res = await svc.executeIntervention(
    intervention({
      type: 'reinforce',
      correctionData: { type: 'reinforce', targetAction: 'wave', reason: 'r' },
    }),
  );
  assert.equal(res.accepted, false);
  assert.match(res.error ?? '', /inputVector unavailable/);
  assert.equal(calls.length, 0, 'must NOT POST a fabricated/zeroed vector');
  ok('reinforce without inputVector is skipped (no fabricated vector, no POST)');
}

// 3. correct with a vector → correct shape.
{
  const calls = installFetch({ ok: true, json: { accepted: true } });
  const svc = new SidecarControlService(config);
  const vec = Array.from({ length: 1561 }, () => 0.0);
  const res = await svc.executeIntervention(
    intervention({
      type: 'correct',
      inputVector: vec,
      correctionData: {
        type: 'correct',
        targetAction: 'wrong_action',
        correctAction: 'right_action',
        reason: 'fix',
      },
    }),
  );
  assert.equal(res.accepted, true);
  assert.match(calls[0].url, /\/cognition\/control\/correct$/);
  assert.deepEqual(Object.keys(calls[0].body).sort(), [
    'actionId',
    'correctCategory',
    'inputVector',
  ]);
  assert.equal(calls[0].body.actionId, 'wrong_action');
  assert.equal(calls[0].body.correctCategory, 'right_action');
  assert.equal(calls[0].body.inputVector.length, 1561);
  ok('correct sends { actionId, inputVector, correctCategory }');
}

// 4a. boost_salience WITHOUT a vector → still POSTs (vector is optional sidecar-side).
{
  const calls = installFetch({ ok: true, json: { accepted: true } });
  const svc = new SidecarControlService(config);
  const res = await svc.executeIntervention(
    intervention({
      type: 'boost_salience',
      correctionData: { type: 'boost_salience', targetAction: 'rare', reason: 'b' },
    }),
  );
  assert.equal(res.accepted, true);
  assert.match(calls[0].url, /\/cognition\/control\/boost_salience$/);
  assert.equal(calls[0].body.category, 'rare');
  assert.equal(typeof calls[0].body.multiplier, 'number');
  assert.equal(
    calls[0].body.inputVector,
    undefined,
    'no seed → inputVector omitted, not zeroed',
  );
  ok('boost_salience POSTs { category, multiplier } without a vector');
}

// 4b. boost_salience WITH a seed vector → forwards it.
{
  const calls = installFetch({ ok: true, json: { accepted: true } });
  const svc = new SidecarControlService(config);
  const seed = Array.from({ length: 1561 }, () => 0.2);
  await svc.executeIntervention(
    intervention({
      type: 'boost_salience',
      inputVector: seed,
      correctionData: { type: 'boost_salience', targetAction: 'rare', reason: 'b' },
    }),
  );
  assert.equal(calls[0].body.inputVector.length, 1561);
  ok('boost_salience forwards a seed inputVector when present');
}

// 5. breaker opens after repeated failures, then fails fast.
{
  const svc = new SidecarControlService(config);
  // fetch rejects (network error) every time.
  installFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  const iv = intervention({
    type: 'boost_salience',
    correctionData: { type: 'boost_salience', targetAction: 'x', reason: 'r' },
  });

  let lastError = '';
  for (let i = 0; i < 5; i++) {
    const r = await svc.executeIntervention(iv);
    lastError = r.error ?? '';
  }
  assert.equal(svc.getBreakerState(), SidecarBreakerState.OPEN);

  // Next call should short-circuit (the inner post() returns the OPEN skip,
  // which executeIntervention passes straight through — accepted:false).
  const calls = installFetch(() => {
    throw new Error('should not be reached while OPEN');
  });
  const r = await svc.executeIntervention(iv);
  assert.equal(r.accepted, false);
  assert.match(r.error ?? '', /circuit breaker OPEN/);
  assert.equal(calls.length, 0, 'OPEN breaker must not hit the network');
  void lastError;
  ok('breaker opens after repeated failures and then fails fast');
}
}

run()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`\nSidecarControlService: ${passed} assertions passed`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });

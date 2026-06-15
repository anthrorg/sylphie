/**
 * Self-running assertions for the SELF_ASSESSMENT push core (Ticket 1 producer).
 *
 * apps/sylphie has no jest harness, so this follows the house pattern used by
 * theater-affect-scorer.spec.ts and graph-compute-3a.spec.ts: run with tsx.
 *
 *   npx tsx apps/sylphie/src/services/self-assessment-push.spec.ts
 *
 * We test the decorator-free PushCoalescer (the core of
 * SelfAssessmentPusherService). The NestJS service is a thin timer/DI shell
 * around it; keeping the tested unit decorator-free lets esbuild/tsx transform
 * it without experimentalDecorators.
 *
 * Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert';
import type { SelfAssessmentPayload } from '@sylphie/shared';
import { PushCoalescer } from './self-assessment-push.core';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

function emptyPayload(): SelfAssessmentPayload {
  return {
    assessedAt: new Date(),
    capabilities: [],
    drivePatterns: [],
    predictionAccuracy: [],
    provenance: 'INFERENCE',
  };
}

console.log('self-assessment-push (PushCoalescer):');

async function main() {
  // 1 — the (empty) payload is pushed verbatim; emptiness never gates the push.
  await check('pushes the empty payload verbatim', async () => {
    const payload = emptyPayload();
    const pushed: SelfAssessmentPayload[] = [];
    const c = new PushCoalescer();
    const ran = await c.run(async () => payload, (p) => pushed.push(p));
    assert.strictEqual(ran, true, 'run should report it executed');
    assert.strictEqual(pushed.length, 1, 'exactly one push');
    assert.strictEqual(pushed[0], payload, 'pushed payload is the verbatim compute result');
    assert.strictEqual(pushed[0].capabilities.length, 0, 'empty arrays are still pushed');
  });

  // 2 — coalescing: a run started while another is in flight is skipped.
  await check('overlapping run is coalesced (≤1 in flight)', async () => {
    let resolveFirst!: (p: SelfAssessmentPayload) => void;
    let computeCalls = 0;
    let coalesced = 0;
    const pushed: SelfAssessmentPayload[] = [];
    const c = new PushCoalescer();

    const compute = () => {
      computeCalls++;
      return new Promise<SelfAssessmentPayload>((res) => {
        resolveFirst = res;
      });
    };
    const push = (p: SelfAssessmentPayload) => pushed.push(p);
    const observer = { onCoalesced: () => coalesced++ };

    const p1 = c.run(compute, push, observer); // starts, hangs
    const ran2 = await c.run(compute, push, observer); // coalesced

    assert.strictEqual(ran2, false, 'second overlapping run returns false');
    assert.strictEqual(coalesced, 1, 'onCoalesced fired exactly once');
    assert.strictEqual(computeCalls, 1, 'no second compute started while busy');
    assert.strictEqual(pushed.length, 0, 'nothing pushed while first still pending');
    assert.strictEqual(c.busy, true, 'still busy until the first resolves');

    resolveFirst(emptyPayload());
    await p1;
    assert.strictEqual(pushed.length, 1, 'first run pushes once after resolving');
    assert.strictEqual(c.busy, false, 'guard cleared after completion');

    // Guard cleared → a fresh run computes + pushes again.
    await c.run(async () => emptyPayload(), push, observer);
    assert.strictEqual(pushed.length, 2, 'next run pushes after guard clears');
    assert.strictEqual(computeCalls, 1, 'fresh run used the non-hanging compute');
  });

  // 3 — a compute failure is swallowed (cadence survives) and clears the guard.
  await check('compute failure is swallowed and clears the guard', async () => {
    const pushed: SelfAssessmentPayload[] = [];
    let errors = 0;
    const c = new PushCoalescer();

    const ran = await c.run(
      async () => {
        throw new Error('SELF read boom');
      },
      (p) => pushed.push(p),
      { onError: () => errors++ },
    );

    assert.strictEqual(ran, true, 'run executed (and caught the error)');
    assert.strictEqual(errors, 1, 'onError fired');
    assert.strictEqual(pushed.length, 0, 'nothing pushed on failure');
    assert.strictEqual(c.busy, false, 'guard released after failure');

    // The coalescer is reusable after a failure.
    await c.run(async () => emptyPayload(), (p) => pushed.push(p));
    assert.strictEqual(pushed.length, 1, 'subsequent run works after a failure');
  });

  console.log(`\nself-assessment-push: ${passed} checks passed.`);
}

void main();

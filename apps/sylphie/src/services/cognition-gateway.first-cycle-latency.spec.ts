/**
 * Self-running assertions for CognitionGatewayService's first-cycle latency
 * measurement (TK-119 AC3, pipeline item 20260702-002).
 *
 * apps/sylphie has no jest harness, so this follows the house pattern:
 * run directly with `npx tsx`.
 *
 *   npx tsx apps/sylphie/src/services/cognition-gateway.first-cycle-latency.spec.ts
 *
 * Exits non-zero on the first failed assertion.
 *
 * Note: the "under threshold" / "logs only once" checks call the private
 * checkFirstCycleLatency() directly with a SMALL elapsed value so the
 * file-write branch never fires against the real pipeline/inbox/. The
 * file-write branch itself is tested in isolation via the exported pure
 * fileFirstCycleLatencyFollowUp(), pointed at a scratch temp directory.
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CognitionGatewayService,
  fileFirstCycleLatencyFollowUp,
} from './cognition-gateway.service';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${name}`);
}

const fakeConfig = { get: (_key: string, def?: unknown) => def } as never;

function main(): void {
  // --- fileFirstCycleLatencyFollowUp: pure function, scratch dir only ---
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-latency-test-'));
  try {
    check('files a markdown follow-up documenting the measured latency', () => {
      const filePath = fileFirstCycleLatencyFollowUp(87.34, scratchDir);
      assert.ok(fs.existsSync(filePath));
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.includes('87.34ms'));
      assert.ok(content.includes('50ms'));
      assert.ok(content.includes('TK-119'));
    });

    check('creates the inbox dir if it does not exist yet', () => {
      const nestedDir = path.join(scratchDir, 'nested', 'inbox');
      assert.ok(!fs.existsSync(nestedDir));
      const filePath = fileFirstCycleLatencyFollowUp(60, nestedDir);
      assert.ok(fs.existsSync(filePath));
    });
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  // --- checkFirstCycleLatency: only-once gating, no real file I/O ---
  const gateway = new CognitionGatewayService(fakeConfig) as unknown as {
    checkFirstCycleLatency: (elapsedMs: number) => void;
    firstCycleLatencyChecked: boolean;
  };

  check('firstCycleLatencyChecked flips true after the first cycle', () => {
    assert.strictEqual(gateway.firstCycleLatencyChecked, false);
    gateway.checkFirstCycleLatency(5); // well under 50ms — no file-write branch taken
    assert.strictEqual(gateway.firstCycleLatencyChecked, true);
  });

  check('subsequent calls are no-ops (measured/logged once per process)', () => {
    // Flip the flag manually to prove a second call can't un-set it or throw.
    gateway.checkFirstCycleLatency(5);
    gateway.checkFirstCycleLatency(999); // even "over threshold" — should be ignored, already checked
    assert.strictEqual(gateway.firstCycleLatencyChecked, true);
  });

  // eslint-disable-next-line no-console
  console.log(`\nCognitionGatewayService first-cycle latency: ${passed} checks passed`);
}

main();

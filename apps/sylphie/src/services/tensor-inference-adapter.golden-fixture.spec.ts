/**
 * Golden-fixture generator for TK-119 (pipeline item 20260702-002, TS<->pydantic
 * drive_history contract test).
 *
 * Drives the REAL production path — TensorInferenceAdapter.infer() ->
 * CognitionGatewayService.runCycle()'s payload assembly (fetch mocked, no
 * network) — to capture an authentic /cognition/cycle request body, then
 * writes it as a golden fixture JSON file that a pytest harness loads and
 * validates against schemas.py's CognitionCycleRequest.model_validate().
 * A hand-derived flat-120 regression fixture (the OLD, buggy `.flat()`
 * shape) is written alongside it, to prove the schema still catches a
 * regression back to the flattened array.
 *
 * apps/sylphie has no jest harness, so this follows the house pattern:
 * run directly with `npx tsx` from the repo root (fixtures are written
 * relative to process.cwd(), never __dirname).
 *
 *   npx tsx apps/sylphie/src/services/tensor-inference-adapter.golden-fixture.spec.ts
 *
 * Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DriveName, DRIVE_INDEX_ORDER, type PressureVector, type PressureDelta, type DriveSnapshot } from '@sylphie/shared';
import type { SensoryFrame } from '@sylphie/shared';
import { TensorInferenceAdapter } from './tensor-inference-adapter.service';
import { CognitionGatewayService } from './cognition-gateway.service';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${name}`);
}

function pv(fill: number): PressureVector {
  const out: Partial<Record<DriveName, number>> = {};
  for (const name of DRIVE_INDEX_ORDER) out[name] = fill;
  return out as PressureVector;
}

function pd(fill: number): PressureDelta {
  const out: Partial<Record<DriveName, number>> = {};
  for (const name of DRIVE_INDEX_ORDER) out[name] = fill;
  return out as PressureDelta;
}

function snapshot(fill: number): DriveSnapshot {
  return {
    pressureVector: pv(fill),
    driveDeltas: pd(fill * 0.01),
    totalPressure: fill * DRIVE_INDEX_ORDER.length,
  } as DriveSnapshot;
}

function frame(seed: number): SensoryFrame {
  return {
    timestamp: Date.now(),
    fused_embedding: new Array(768).fill(0).map((_, i) => Math.sin(seed + i) * 0.01),
    modality_embeddings: {},
    active_modalities: ['text'],
    raw: {},
  };
}

/** Minimal fake ConfigService — only .get() is used by the gateway constructor. */
const fakeConfig = { get: (_key: string, def?: unknown) => def } as never;

async function main() {
  const gateway = new CognitionGatewayService(fakeConfig);
  // Bypass onModuleInit()'s real health-check network call — this test only
  // exercises runCycle()'s payload assembly, which is gated on `available`.
  (gateway as unknown as { available: boolean }).available = true;

  let capturedBody: string | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = init?.body as string;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        global_prior: { action_bias: new Array(32).fill(0), urgency: 0.1, novelty_score: 0.1 },
        panel_opinions: [],
        convergence: null,
        inference_ms: 2.5,
      }),
    } as unknown as Response;
  }) as typeof fetch;

  try {
    const adapter = new TensorInferenceAdapter(gateway);
    // Fill the rolling drive-history buffer to capacity with distinct values.
    for (let i = 1; i <= 10; i++) {
      await adapter.infer(frame(i), snapshot(i * 0.05));
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.ok(capturedBody, 'gateway.runCycle() never reached fetch() — payload not captured');
  const golden = JSON.parse(capturedBody as string) as Record<string, unknown>;

  check('golden fixture drive_history is nested 10x12, never flattened', () => {
    const dh = golden.drive_history as unknown[];
    assert.ok(Array.isArray(dh));
    assert.strictEqual(dh.length, 10);
    for (const row of dh) {
      assert.ok(Array.isArray(row));
      assert.strictEqual((row as unknown[]).length, 12);
    }
  });

  check('golden fixture has the required core fields at the right dims', () => {
    assert.strictEqual((golden.fused_embedding as unknown[]).length, 768);
    assert.strictEqual((golden.drive_vector as unknown[]).length, 12);
    assert.strictEqual((golden.drive_deltas as unknown[]).length, 12);
    assert.strictEqual((golden.episodic_context as unknown[]).length, 768);
  });

  const fixturesDir = path.join(process.cwd(), 'packages', 'cognition-service', 'tests', 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });

  const goldenPath = path.join(fixturesDir, 'cycle-request.golden.json');
  fs.writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + '\n', 'utf-8');

  // Old, buggy shape: drive_history flattened to a single 120-float array
  // (what getDriveHistoryFlattened().flat() used to emit). Everything else
  // about the payload is left identical so this fixture isolates the one
  // regression the schema must still catch.
  const flatRegression = {
    ...golden,
    drive_history: (golden.drive_history as number[][]).flat(),
  };
  const flatPath = path.join(fixturesDir, 'cycle-request.flat-regression.json');
  fs.writeFileSync(flatPath, JSON.stringify(flatRegression, null, 2) + '\n', 'utf-8');

  check('flat-regression fixture is a single 120-length array (the old bug)', () => {
    assert.ok(Array.isArray(flatRegression.drive_history));
    assert.strictEqual(flatRegression.drive_history.length, 120);
    assert.ok((flatRegression.drive_history as unknown[]).every((v) => typeof v === 'number'));
  });

  // eslint-disable-next-line no-console
  console.log(`\nWrote golden fixture:        ${goldenPath}`);
  // eslint-disable-next-line no-console
  console.log(`Wrote flat-regression fixture: ${flatPath}`);
  // eslint-disable-next-line no-console
  console.log(`\nGolden fixture generator: ${passed} checks passed`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

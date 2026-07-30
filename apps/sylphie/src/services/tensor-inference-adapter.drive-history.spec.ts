/**
 * Self-running assertions for TensorInferenceAdapter's drive_history contract
 * fix (TK-119, pipeline item 20260702-002).
 *
 * Regression target: the adapter used to emit a flattened 120-float array
 * (`getDriveHistoryFlattened().flat()`), which 422s against
 * packages/cognition-service/schemas.py's `drive_history: list[list[float]]
 * | None`. This asserts the adapter now emits nested `number[][]`
 * (10 timesteps x 12 drives) all the way through to the gateway payload.
 *
 * apps/sylphie has no jest harness, so this follows the house pattern:
 * run directly with `npx tsx`.
 *
 *   npx tsx apps/sylphie/src/services/tensor-inference-adapter.drive-history.spec.ts
 *
 * Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert';
import { DriveName, DRIVE_INDEX_ORDER, type PressureVector, type PressureDelta, type DriveSnapshot } from '@sylphie/shared';
import type { SensoryFrame } from '@sylphie/shared';
import { TensorInferenceAdapter } from './tensor-inference-adapter.service';
import type { CognitionGatewayService } from './cognition-gateway.service';

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
    driveDeltas: pd(0),
    totalPressure: fill * DRIVE_INDEX_ORDER.length,
  } as DriveSnapshot;
}

function frame(): SensoryFrame {
  return {
    timestamp: Date.now(),
    fused_embedding: new Array(768).fill(0),
    modality_embeddings: {},
    active_modalities: [],
    raw: {},
  };
}

/** Minimal fake gateway that captures the panelContext it's called with. */
function fakeGateway(): { gateway: CognitionGatewayService; lastPanelContext: () => unknown } {
  let captured: unknown = null;
  const gateway = {
    isAvailable: () => true,
    runCycle: async (
      _f: SensoryFrame,
      _d: DriveSnapshot,
      _e?: number[],
      panelContext?: unknown,
    ) => {
      captured = panelContext;
      return {
        global_prior: { action_bias: new Array(32).fill(0), urgency: 0, novelty_score: 0 },
        panel_opinions: [],
        convergence: null,
        inference_ms: 1,
      };
    },
    fetchBootstrapStatus: async () => null,
    submitTrainingSample: () => {},
  } as unknown as CognitionGatewayService;
  return { gateway, lastPanelContext: () => captured };
}

async function main() {
  const { gateway, lastPanelContext } = fakeGateway();
  const adapter = new TensorInferenceAdapter(gateway);

  // Cold start: no snapshots recorded yet, but infer() itself records one.
  await adapter.infer(frame(), snapshot(0.1));
  const firstCtx = lastPanelContext() as { driveHistory: number[][] };
  check('driveHistory is nested number[][], not flat', () => {
    assert.ok(Array.isArray(firstCtx.driveHistory));
    assert.strictEqual(firstCtx.driveHistory.length, 10);
    for (const row of firstCtx.driveHistory) {
      assert.ok(Array.isArray(row), 'each timestep must be an array (nested), never a flat number');
      assert.strictEqual(row.length, 12);
    }
  });

  check('cold-start rows are zero-padded (only the just-recorded snapshot is real)', () => {
    // 9 padding rows of zeros, then the just-recorded 0.1-filled row.
    for (let i = 0; i < 9; i++) {
      assert.deepStrictEqual(firstCtx.driveHistory[i], new Array(12).fill(0));
    }
    assert.deepStrictEqual(firstCtx.driveHistory[9], new Array(12).fill(0.1));
  });

  // Fill the buffer past its capacity (10) with distinct, identifiable values.
  for (let i = 0; i < 15; i++) {
    await adapter.infer(frame(), snapshot(i + 1));
  }
  const fullCtx = lastPanelContext() as { driveHistory: number[][] };

  check('buffer caps at DRIVE_HISTORY_SIZE (10) and rolls, no padding once full', () => {
    assert.strictEqual(fullCtx.driveHistory.length, 10);
    // After 16 total infer() calls (1 + 15), the last 10 fills were 6..15.
    const expectedFills = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    for (let i = 0; i < 10; i++) {
      assert.deepStrictEqual(fullCtx.driveHistory[i], new Array(12).fill(expectedFills[i]));
    }
  });

  check('no row is ever a bare number (the historical flat-array bug)', () => {
    for (const row of fullCtx.driveHistory) {
      assert.strictEqual(typeof row, 'object');
      assert.ok(Array.isArray(row));
    }
  });

  // eslint-disable-next-line no-console
  console.log(`\nTensorInferenceAdapter drive_history contract: ${passed} checks passed`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

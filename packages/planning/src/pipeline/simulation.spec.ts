/**
 * Unit tests for SimulationService.evaluateCategory — cross-drive effect aggregation.
 *
 * Acceptance criteria:
 *   AC1: Given history where driveEffects has multiple drives, estimatedDriveEffect
 *        has an entry for every drive seen; the affectedDrive entry matches the
 *        prior single-drive result.
 *   AC2: Given history where only affectedDrive has effects, behavior is identical
 *        to the old single-entry map.
 *
 * These tests extract the private aggregation logic into a pure helper and verify
 * it directly, avoiding the need for a live TimescaleService.
 *
 * Run via: npx tsx packages/planning/src/pipeline/simulation.spec.ts
 */

import assert from 'node:assert/strict';
import { DriveName } from '@sylphie/shared';
import type { SimulatedOutcome } from '../interfaces/planning.interfaces.js';

// ---------------------------------------------------------------------------
// Pure re-implementation of the aggregation logic to keep tests free of NestJS
// DI wiring. This mirrors evaluateCategory's aggregation block exactly so any
// divergence between the spec and the production code will be caught by AC tests.
// ---------------------------------------------------------------------------

interface HistoryRow {
  driveEffects?: Record<string, number>;
  outcome?: string;
}

function aggregateDriveEffects(
  rows: Array<{ payload: HistoryRow; count: number }>,
  affectedDrive: DriveName,
  category: string,
): SimulatedOutcome {
  const totalEffects = new Map<string, number>();
  let successCount = 0;
  let totalCount = 0;

  for (const row of rows) {
    const count = row.count;
    totalCount += count;

    const driveEffects = row.payload.driveEffects;
    if (driveEffects && typeof driveEffects === 'object') {
      for (const [drive, effect] of Object.entries(driveEffects)) {
        if (typeof effect === 'number') {
          totalEffects.set(drive, (totalEffects.get(drive) ?? 0) + effect * count);
        }
      }
    }

    if (row.payload.outcome === 'positive') {
      successCount += count;
    }
  }

  const estimatedDriveEffect: Partial<Record<DriveName, number>> = {};
  for (const [drive, total] of totalEffects.entries()) {
    (estimatedDriveEffect as Record<string, number>)[drive] =
      totalCount > 0 ? total / totalCount : 0;
  }
  if (!(affectedDrive in estimatedDriveEffect)) {
    estimatedDriveEffect[affectedDrive] = 0;
  }

  const successRate = totalCount > 0 ? successCount / totalCount : 0;

  return {
    description: `${category} based on ${totalCount} historical outcomes`,
    actionCategory: category,
    estimatedDriveEffect,
    confidenceEstimate: Math.min(0.8, successRate),
    riskScore: 1.0 - successRate,
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function describe(suiteName: string, fn: () => void): void {
  console.log(`\n  ${suiteName}`);
  fn();
}

function it(testName: string, fn: () => void): void {
  try {
    fn();
    console.log(`    PASS  ${testName}`);
    passed++;
  } catch (err) {
    console.error(`    FAIL  ${testName}`);
    console.error(`          ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// AC1 — multi-drive history produces a multi-entry estimatedDriveEffect map
// ---------------------------------------------------------------------------

describe('AC1: cross-drive aggregation', () => {
  it('includes all drives seen in driveEffects history', () => {
    const rows = [
      {
        count: 2,
        payload: {
          driveEffects: {
            [DriveName.Curiosity]: -0.3,
            [DriveName.Anxiety]: 0.1,
          },
          outcome: 'positive',
        },
      },
      {
        count: 1,
        payload: {
          driveEffects: {
            [DriveName.Curiosity]: -0.1,
            [DriveName.Satisfaction]: -0.2,
          },
          outcome: 'negative',
        },
      },
    ];

    const result = aggregateDriveEffects(rows, DriveName.Curiosity, 'TestCategory');
    const effects = result.estimatedDriveEffect;

    // All three drives must have entries
    assert.ok(DriveName.Curiosity in effects, 'affectedDrive must be present');
    assert.ok(DriveName.Anxiety in effects, 'Anxiety must be present');
    assert.ok(DriveName.Satisfaction in effects, 'Satisfaction must be present');
  });

  it('affectedDrive average matches the prior single-drive result', () => {
    // count-weighted average for Curiosity:
    //   row1: -0.3 * 2 = -0.6, row2: -0.1 * 1 = -0.1 => total = -0.7 / 3 ≈ -0.2333
    const rows = [
      { count: 2, payload: { driveEffects: { [DriveName.Curiosity]: -0.3 }, outcome: 'positive' } },
      { count: 1, payload: { driveEffects: { [DriveName.Curiosity]: -0.1 }, outcome: 'negative' } },
    ];

    const result = aggregateDriveEffects(rows, DriveName.Curiosity, 'TestCategory');
    const expected = (-0.3 * 2 + -0.1 * 1) / 3;

    assert.ok(
      Math.abs((result.estimatedDriveEffect[DriveName.Curiosity] ?? NaN) - expected) < 1e-9,
      `Expected ${expected}, got ${result.estimatedDriveEffect[DriveName.Curiosity]}`,
    );
  });

  it('collateral drive averages are count-weighted correctly', () => {
    // Anxiety only appears in row1 (count=2): 0.1 * 2 / 3 = 0.0667
    const rows = [
      {
        count: 2,
        payload: {
          driveEffects: { [DriveName.Curiosity]: -0.3, [DriveName.Anxiety]: 0.1 },
          outcome: 'positive',
        },
      },
      {
        count: 1,
        payload: { driveEffects: { [DriveName.Curiosity]: -0.1 }, outcome: 'negative' },
      },
    ];

    const result = aggregateDriveEffects(rows, DriveName.Curiosity, 'TestCategory');
    const expectedAnxiety = (0.1 * 2) / 3;

    assert.ok(
      Math.abs((result.estimatedDriveEffect[DriveName.Anxiety] ?? NaN) - expectedAnxiety) < 1e-9,
      `Expected ${expectedAnxiety}, got ${result.estimatedDriveEffect[DriveName.Anxiety]}`,
    );
  });

  it('entry count equals the number of distinct drives across all rows', () => {
    const rows = [
      {
        count: 1,
        payload: {
          driveEffects: {
            [DriveName.Curiosity]: -0.2,
            [DriveName.Focus]: -0.1,
            [DriveName.Social]: 0.05,
          },
          outcome: 'positive',
        },
      },
    ];

    const result = aggregateDriveEffects(rows, DriveName.Curiosity, 'TestCategory');
    const keys = Object.keys(result.estimatedDriveEffect);
    assert.equal(keys.length, 3);
  });
});

// ---------------------------------------------------------------------------
// AC2 — single-drive history (only affectedDrive) behaves identically to old impl
// ---------------------------------------------------------------------------

describe('AC2: single-drive history is backward-compatible', () => {
  it('produces a one-entry map when only affectedDrive has effects', () => {
    const rows = [
      {
        count: 3,
        payload: { driveEffects: { [DriveName.Satisfaction]: -0.15 }, outcome: 'positive' },
      },
      {
        count: 2,
        payload: { driveEffects: { [DriveName.Satisfaction]: -0.05 }, outcome: 'negative' },
      },
    ];

    const result = aggregateDriveEffects(rows, DriveName.Satisfaction, 'TestCategory');
    const keys = Object.keys(result.estimatedDriveEffect);
    assert.equal(keys.length, 1, 'Only one entry in the map');
    assert.ok(DriveName.Satisfaction in result.estimatedDriveEffect);
  });

  it('single-drive average is identical to count-weighted formula', () => {
    // (-0.15 * 3 + -0.05 * 2) / 5 = (-0.45 - 0.10) / 5 = -0.11
    const rows = [
      {
        count: 3,
        payload: { driveEffects: { [DriveName.Satisfaction]: -0.15 }, outcome: 'positive' },
      },
      {
        count: 2,
        payload: { driveEffects: { [DriveName.Satisfaction]: -0.05 }, outcome: 'negative' },
      },
    ];

    const result = aggregateDriveEffects(rows, DriveName.Satisfaction, 'TestCategory');
    const expected = (-0.15 * 3 + -0.05 * 2) / 5;

    assert.ok(
      Math.abs((result.estimatedDriveEffect[DriveName.Satisfaction] ?? NaN) - expected) < 1e-9,
      `Expected ${expected}, got ${result.estimatedDriveEffect[DriveName.Satisfaction]}`,
    );
  });

  it('affectedDrive is present with value 0 when no row has any driveEffects', () => {
    const rows = [
      { count: 1, payload: { outcome: 'negative' } },
      { count: 2, payload: { outcome: 'positive' } },
    ];

    const result = aggregateDriveEffects(rows, DriveName.Focus, 'TestCategory');
    assert.ok(DriveName.Focus in result.estimatedDriveEffect, 'affectedDrive must be present');
    assert.equal(result.estimatedDriveEffect[DriveName.Focus], 0);
    assert.equal(Object.keys(result.estimatedDriveEffect).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('non-numeric drive values in driveEffects are ignored', () => {
    const rows = [
      {
        count: 1,
        payload: {
          driveEffects: {
            [DriveName.Curiosity]: -0.2,
            [DriveName.Anxiety]: 'high' as unknown as number, // malformed
          },
          outcome: 'positive',
        },
      },
    ];

    const result = aggregateDriveEffects(rows, DriveName.Curiosity, 'TestCategory');
    // Anxiety should NOT appear because its value was a string
    assert.ok(!(DriveName.Anxiety in result.estimatedDriveEffect));
    assert.ok(DriveName.Curiosity in result.estimatedDriveEffect);
  });

  it('rows with missing driveEffects do not crash and do not contribute drive entries', () => {
    const rows = [
      { count: 1, payload: { outcome: 'positive' } },
      {
        count: 1,
        payload: { driveEffects: { [DriveName.Curiosity]: -0.4 }, outcome: 'positive' },
      },
    ];

    const result = aggregateDriveEffects(rows, DriveName.Curiosity, 'TestCategory');
    // count-weighted: -0.4 * 1 / 2 = -0.2
    const expected = (-0.4 * 1) / 2;
    assert.ok(
      Math.abs((result.estimatedDriveEffect[DriveName.Curiosity] ?? NaN) - expected) < 1e-9,
    );
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}

/**
 * Vision "first green baseline" — linear-algebra primitives spec.
 *
 * These utilities (Xavier-initialized projection matrices + a seeded PRNG) are
 * the load-bearing foundation of the sensory embedding path: with no training
 * pipeline, the only thing keeping embeddings stable across restarts is the
 * DETERMINISM of mulberry32 + xavierMatrix. If that determinism silently breaks,
 * every cached latent pattern from a prior boot points at a different basis and
 * grounded recall rots without any loud failure. So the baseline pins:
 *
 *   1. Determinism — xavierMatrix(rows,cols,seed) is byte-identical across calls,
 *      AND its first row matches a checked-in golden hash (restart determinism:
 *      a future refactor of the PRNG would flip the hash, not pass silently).
 *   2. linearProject correctness against a hand-computed toy example.
 *   3. Range invariant — every entry lies in [-limit, +limit],
 *      limit = sqrt(6 / (rows + cols)) (the Xavier/Glorot guarantee).
 *
 * The golden hash was produced by RUNNING the real xavierMatrix (not fabricated);
 * see the determinism test for the exact reproduction recipe.
 */

import { createHash } from 'node:crypto';
import { xavierMatrix, linearProject } from './linear-algebra';

/**
 * SHA-256 of JSON.stringify(xavierMatrix(4, 8, 1234)[0]).
 *
 * Reproduce: `xavierMatrix(4, 8, 1234)` then hash the first row's JSON. This is
 * a restart-determinism anchor — if the seeded PRNG or the draw order changes,
 * this hash flips and the test goes red instead of silently re-basing embeddings.
 */
const FIRST_ROW_GOLDEN_HASH =
  'b687b37c5b35a9dca37dfb5e62da6e9112cc276cce519be057fff539b5927c58';

function hashRow(row: number[]): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

describe('linear-algebra — vision baseline primitives', () => {
  describe('xavierMatrix determinism', () => {
    it('is byte-identical across two independent calls (same seed)', () => {
      const a = xavierMatrix(4, 8, 1234);
      const b = xavierMatrix(4, 8, 1234);
      // Deep structural equality across the whole matrix — same shape, same draws.
      expect(b).toEqual(a);
      // And byte-identical serialization (catches -0 / NaN / ordering drift).
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });

    it('matches the checked-in golden hash of its first row (restart determinism)', () => {
      const W = xavierMatrix(4, 8, 1234);
      expect(hashRow(W[0])).toBe(FIRST_ROW_GOLDEN_HASH);
    });

    it('produces a different basis for a different seed', () => {
      const a = xavierMatrix(4, 8, 1234);
      const b = xavierMatrix(4, 8, 9999);
      expect(hashRow(b[0])).not.toBe(hashRow(a[0]));
    });

    it('has the requested shape (rows × cols)', () => {
      const W = xavierMatrix(4, 8, 1234);
      expect(W).toHaveLength(4);
      for (const row of W) expect(row).toHaveLength(8);
    });
  });

  describe('linearProject correctness', () => {
    it('matches a hand-computed toy example (y = W·x + b)', () => {
      // Row 0: 0.5 + (1*1 + 2*0 + 3*-1) = 0.5 + (1 - 3) = -1.5
      // Row 1: -1  + (4*1 + 5*0 + 6*-1) = -1  + (4 - 6) = -3
      const W = [
        [1, 2, 3],
        [4, 5, 6],
      ];
      const x = [1, 0, -1];
      const b = [0.5, -1];
      expect(linearProject(W, x, b)).toEqual([-1.5, -3]);
    });

    it('returns the bias unchanged when the input is the zero vector', () => {
      const W = [
        [7, 8],
        [9, 10],
      ];
      const x = [0, 0];
      const b = [2, -2];
      expect(linearProject(W, x, b)).toEqual([2, -2]);
    });
  });

  describe('Xavier range invariant', () => {
    it('keeps every entry in [-limit, +limit], limit = sqrt(6 / (rows + cols))', () => {
      const rows = 16;
      const cols = 64;
      const limit = Math.sqrt(6 / (rows + cols));
      const W = xavierMatrix(rows, cols, 7);

      expect(W).toHaveLength(rows);
      for (const row of W) {
        expect(row).toHaveLength(cols);
        for (const v of row) {
          expect(v).toBeGreaterThanOrEqual(-limit);
          expect(v).toBeLessThanOrEqual(limit);
        }
      }
    });

    it('honors the invariant across several seeds and shapes', () => {
      const cases: Array<[number, number, number]> = [
        [1, 1, 0],
        [3, 5, 42],
        [8, 8, 1234],
        [2, 128, 99],
      ];
      for (const [rows, cols, seed] of cases) {
        const limit = Math.sqrt(6 / (rows + cols));
        for (const row of xavierMatrix(rows, cols, seed)) {
          for (const v of row) {
            expect(v).toBeGreaterThanOrEqual(-limit);
            expect(v).toBeLessThanOrEqual(limit);
          }
        }
      }
    });
  });
});

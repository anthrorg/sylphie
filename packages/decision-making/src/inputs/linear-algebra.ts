/**
 * Lightweight linear algebra utilities for the sensory pipeline.
 *
 * Provides Xavier-initialized weight matrices and matrix-vector projection.
 * Uses a deterministic seeded PRNG (mulberry32) so embeddings are stable
 * across restarts without a training pipeline.
 */

/**
 * Mulberry32 — fast 32-bit seeded PRNG.
 * Returns a function that produces uniform floats in [0, 1).
 */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Xavier/Glorot uniform initialization.
 *
 * Draws values from U(-limit, +limit) where limit = sqrt(6 / (fanIn + fanOut)).
 * This keeps signal variance stable across layers.
 *
 * @param rows  Output dimension (fanOut)
 * @param cols  Input dimension (fanIn)
 * @param seed  Deterministic seed for reproducibility
 * @returns     rows × cols weight matrix
 */
export function xavierMatrix(
  rows: number,
  cols: number,
  seed = 42,
): number[][] {
  const rng = mulberry32(seed);
  const limit = Math.sqrt(6 / (rows + cols));
  const W: number[][] = new Array(rows);
  for (let r = 0; r < rows; r++) {
    W[r] = new Array(cols);
    for (let c = 0; c < cols; c++) {
      W[r][c] = rng() * 2 * limit - limit;
    }
  }
  return W;
}

/**
 * Linear projection: y = W * x + b
 *
 * @param W  Weight matrix [outDim × inDim]
 * @param x  Input vector  [inDim]
 * @param b  Bias vector   [outDim]
 * @returns  Output vector [outDim]
 */
export function linearProject(
  W: number[][],
  x: number[],
  b: number[],
): number[] {
  const outDim = W.length;
  const y = new Array(outDim);
  for (let r = 0; r < outDim; r++) {
    let sum = b[r];
    const row = W[r];
    for (let c = 0; c < row.length; c++) {
      sum += row[c] * x[c];
    }
    y[r] = sum;
  }
  return y;
}

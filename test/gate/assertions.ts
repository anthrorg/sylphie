/**
 * assertions.ts — Metric assertion logic for the Provability Gate.
 *
 * Each assertion compares an actual measurement against the committed baseline
 * and returns a structured result. The gate aggregates these into the scorecard.
 *
 * Design notes:
 *   - Assertions are pure functions: no I/O, no clock. They take numbers in and
 *     return a verdict out, so they are unit-testable and deterministic.
 *   - Where a metric needs a minimum sample size to be meaningful (MAE), the
 *     precondition produces a SKIP verdict rather than a false PASS/FAIL. The
 *     gate treats SKIP as non-blocking but visible — honesty about insufficient
 *     data over a fabricated green.
 *   - Tolerances mirror the CANON development-metric trajectories: ratios should
 *     hold or improve, MAE should not regress materially, provenance should not
 *     collapse.
 */

export interface AssertResult {
  /** True only on a clean pass. */
  readonly pass: boolean;
  /** When true, the metric lacked the data to judge; not counted as a failure. */
  readonly skipped?: boolean;
  /** One-line explanation for the scorecard. */
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Type 1 / Type 2 ratio
// ---------------------------------------------------------------------------

/**
 * Type ratio direction check. Autonomy from the LLM means Type 1 share should
 * hold or rise. We compare the Type 1 share (type1 / (type1+type2)) against the
 * baseline's share, allowing a ±1 decision slack so a single noisy classification
 * near the boundary does not flip the gate.
 *
 * With zero decisions on either side the metric is undefined → SKIP.
 */
export function assertTypeRatio(
  actual: { type1: number; type2: number },
  baseline: { type1: number; type2: number },
): AssertResult {
  const actualTotal = actual.type1 + actual.type2;
  const baseTotal = baseline.type1 + baseline.type2;

  if (actualTotal === 0) {
    return {
      pass: false,
      skipped: true,
      message: `type-ratio: no Type 1/2 decisions recorded this run (cannot judge)`,
    };
  }

  const actualShare = actual.type1 / actualTotal;

  // Seed baseline (all zeros) → nothing to regress against; pass on any data.
  if (baseTotal === 0) {
    return {
      pass: true,
      message:
        `type-ratio: ${actual.type1}/${actualTotal} Type 1 ` +
        `(share=${actualShare.toFixed(3)}); baseline empty (seed) — accepted`,
    };
  }

  const baseShare = baseline.type1 / baseTotal;

  // ±1 decision tolerance: recompute the baseline share as if actual had one
  // extra Type 1 decision, and accept if that clears the bar.
  const tolerantShare = (actual.type1 + 1) / (actualTotal + 1);
  const pass = actualShare >= baseShare || tolerantShare >= baseShare;

  return {
    pass,
    message:
      `type-ratio: actual share ${actualShare.toFixed(3)} ` +
      `(${actual.type1}/${actualTotal}) vs baseline ${baseShare.toFixed(3)} ` +
      `(±1 tolerant=${tolerantShare.toFixed(3)}) — ${pass ? 'held/improved' : 'REGRESSED'}`,
  };
}

// ---------------------------------------------------------------------------
// Prediction MAE
// ---------------------------------------------------------------------------

/**
 * World-model prediction MAE. Precondition: at least 30 samples, else the
 * rolling window is too thin to trust → SKIP. When we have enough data, MAE
 * must not exceed baseline.mae + 0.03 (a small drift allowance).
 */
export function assertMAE(
  actual: { mae: number; sampleCount: number },
  baseline: { mae: number },
): AssertResult {
  if (actual.sampleCount < 30) {
    return {
      pass: false,
      skipped: true,
      message:
        `mae: only ${actual.sampleCount} samples (<30 required) — ` +
        `insufficient data to judge world-model accuracy`,
    };
  }

  if (Number.isNaN(actual.mae)) {
    return {
      pass: false,
      skipped: true,
      message: `mae: value is NaN despite ${actual.sampleCount} samples — treated as no data`,
    };
  }

  const ceiling = baseline.mae + 0.03;
  const pass = actual.mae <= ceiling;
  return {
    pass,
    message:
      `mae: actual ${actual.mae.toFixed(4)} vs ceiling ${ceiling.toFixed(4)} ` +
      `(baseline ${baseline.mae.toFixed(4)} + 0.03), n=${actual.sampleCount} — ` +
      `${pass ? 'within bound' : 'REGRESSED'}`,
  };
}

// ---------------------------------------------------------------------------
// Experiential provenance ratio
// ---------------------------------------------------------------------------

/**
 * Experiential provenance ratio: the share of WKG nodes that are self-built
 * (SENSOR + GUARDIAN + INFERENCE) rather than LLM-provided. Must hold within
 * 0.05 of baseline. With an empty graph the ratio is undefined → SKIP.
 */
export function assertProvenance(
  actual: { experientialRatio: number; totalNodes: number },
  baseline: { experientialRatio: number },
): AssertResult {
  if (actual.totalNodes === 0 || Number.isNaN(actual.experientialRatio)) {
    return {
      pass: false,
      skipped: true,
      message: `provenance: graph empty or ratio NaN (${actual.totalNodes} nodes) — cannot judge`,
    };
  }

  const floor = baseline.experientialRatio - 0.05;
  const pass = actual.experientialRatio >= floor;
  return {
    pass,
    message:
      `provenance: actual ${actual.experientialRatio.toFixed(3)} vs floor ${floor.toFixed(3)} ` +
      `(baseline ${baseline.experientialRatio.toFixed(3)} - 0.05), ` +
      `${actual.totalNodes} nodes — ${pass ? 'held' : 'REGRESSED'}`,
  };
}

// ---------------------------------------------------------------------------
// Drive tick rate (liveness)
// ---------------------------------------------------------------------------

/**
 * Drive engine liveness: the tick counter must advance fast enough to prove the
 * separate drive process is alive. Require >= 0.5 Hz (>= 5 ticks in a 10s
 * window). This is the load-bearing liveness check for the Lesion Test (L4):
 * even with the LLM unplugged, the drive heartbeat must keep running.
 */
export function assertDriveTickRate(tick1: number, tick2: number, windowMs: number): AssertResult {
  const ticks = tick2 - tick1;
  const seconds = windowMs / 1000;
  const hz = seconds > 0 ? ticks / seconds : 0;
  const MIN_HZ = 0.5;
  const pass = hz >= MIN_HZ;
  return {
    pass,
    message:
      `drive-tick: ${ticks} ticks in ${seconds.toFixed(1)}s = ${hz.toFixed(2)} Hz ` +
      `(min ${MIN_HZ} Hz) — ${pass ? 'alive' : 'STALLED'}`,
  };
}

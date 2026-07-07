/**
 * Tick-drift-compensating delay computation — TK-135.
 *
 * Extracted to a pure function so the drift-compensation math is directly
 * unit-testable (DriveEngine.scheduleTick() is private and driven by
 * setTimeout, which makes the arithmetic itself hard to exercise in
 * isolation).
 *
 * Previous bug: `delay = clamp(delay + MAX_TICK_DRIFT_MS, 0, INTERVAL)`.
 * Adding MAX_TICK_DRIFT_MS to the already-drift-compensated delay before
 * clamping at the INTERVAL ceiling erased the compensation for any drift
 * within +/-MAX_TICK_DRIFT_MS of zero — the ceiling clamp forced
 * `delay === INTERVAL` every tick regardless of measured drift, so a small
 * per-tick lag never got corrected and slowly compounded. The fix clamps
 * the drift-compensated delay to a bounded catch-up window
 * [INTERVAL - MAX_TICK_DRIFT_MS, INTERVAL] instead of adding the bound in.
 */

/**
 * Compute the next tick's setTimeout delay given how far the current tick
 * drifted from its scheduled time.
 *
 * @param drift - `now - nextTickScheduledAt` (positive = tick fired late)
 * @param intervalMs - Target tick interval (DRIVE_ENGINE_TICK_INTERVAL_MS)
 * @param maxDriftMs - Maximum single-step catch-up/slowdown bound (MAX_TICK_DRIFT_MS)
 * @returns The delay to pass to setTimeout for the next tick
 */
export function computeNextTickDelay(
  drift: number,
  intervalMs: number,
  maxDriftMs: number,
): number {
  const uncompensated = intervalMs - drift;
  const minDelay = Math.max(0, intervalMs - maxDriftMs);
  const maxDelay = intervalMs;
  return Math.max(minDelay, Math.min(uncompensated, maxDelay));
}

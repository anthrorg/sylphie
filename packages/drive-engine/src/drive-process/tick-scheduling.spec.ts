/**
 * Unit tests for computeNextTickDelay() — TK-135 (tick-drift accumulator math).
 *
 * Previously `delay = clamp(delay + MAX_TICK_DRIFT_MS, 0, INTERVAL)` forced
 * delay === INTERVAL for any drift within +/-MAX_TICK_DRIFT_MS of zero,
 * silently erasing drift compensation — the expected tick interval never
 * matched the actual one under sustained small drift.
 */

import { computeNextTickDelay } from './tick-scheduling';

const INTERVAL = 1000;
const MAX_DRIFT = 100;

describe('computeNextTickDelay', () => {
  it('returns the full interval when there is no drift', () => {
    expect(computeNextTickDelay(0, INTERVAL, MAX_DRIFT)).toBe(1000);
  });

  it('compensates for a small positive drift (tick fired late) instead of ignoring it', () => {
    // Previously: 1000 - 50 = 950; +100 = 1050; clamp to 1000 -> compensation erased.
    // Fixed: compensation is preserved (950), within the bounded window.
    expect(computeNextTickDelay(50, INTERVAL, MAX_DRIFT)).toBe(950);
  });

  it('bounds the catch-up so a large drift does not fire the next tick almost immediately', () => {
    // drift of 500ms: uncompensated delay would be 500, but is bounded to
    // [INTERVAL - MAX_DRIFT, INTERVAL] = [900, 1000].
    expect(computeNextTickDelay(500, INTERVAL, MAX_DRIFT)).toBe(900);
  });

  it('bounds a negative drift (tick fired early) so it does not overshoot the interval', () => {
    // drift of -50 (clock skew or an early fire): uncompensated = 1050, clamped to 1000.
    expect(computeNextTickDelay(-50, INTERVAL, MAX_DRIFT)).toBe(1000);
  });

  it('over many ticks, the average actual interval matches the target under sustained small drift', () => {
    // Simulate a loop where each tick reports the SAME small positive drift
    // (e.g. the event loop is consistently 30ms late) and verify the
    // computed delay compensates every time rather than degenerating to a
    // constant INTERVAL (which would let the drift compound forever).
    const drift = 30;
    const delay = computeNextTickDelay(drift, INTERVAL, MAX_DRIFT);
    expect(delay).toBe(INTERVAL - drift);
    expect(delay).not.toBe(INTERVAL);
  });
});

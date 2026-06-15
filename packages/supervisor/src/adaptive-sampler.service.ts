/**
 * AdaptiveSamplerService — computes the supervisor's effective sampling
 * interval per cycle, replacing the old fixed `cycleCount % sampleRate` gate.
 *
 * Motivation: a fixed 1-in-N rate is wrong in both directions. When the day's
 * budget is nearly spent, 1-in-10 keeps burning money; when the system is
 * behaving novelly (lots of Type-2 / SHRUG, or a sudden shift in the
 * arbitration mix), 1-in-10 misses the moments most worth supervising.
 *
 * The effective interval is derived deterministically from three signals:
 *
 *   1. Budget pressure  — fraction of the daily budget already spent. As spend
 *      approaches the ceiling the interval STRETCHES (sample less) so the
 *      supervisor glides to a stop instead of slamming into the budget gate.
 *   2. Novelty          — recent share of TYPE_2 + SHRUG arbitrations. Novel /
 *      uncertain cognition is the highest-value thing to supervise, so novelty
 *      SHRINKS the interval (sample more).
 *   3. Load             — observed cycles-per-second. Under heavy load the
 *      interval stretches modestly to protect the budget and the sidecar.
 *
 * The result is clamped to [adaptiveMinRate, adaptiveMaxRate] and rounded to an
 * integer, so it is always deterministic and bounded. The sampler holds no
 * unbounded state (fixed-size rolling window only).
 */

import { Injectable } from '@nestjs/common';
import type { SamplingPolicy } from './interfaces/supervisor.types';

/** Inputs the sampler needs each cycle, supplied by the caller. */
export interface SamplerInputs {
  /** Fraction of today's budget already spent, in [0, 1]. */
  budgetUsedFraction: number;
  /** This cycle's arbitration path. */
  arbitrationType: 'TYPE_1' | 'TYPE_2' | 'SHRUG';
  /** Wall-clock ms of this cycle's arrival (for load estimation). */
  nowMs: number;
}

const NOVELTY_WINDOW = 20;

@Injectable()
export class AdaptiveSamplerService {
  /** Rolling window of recent arbitration types for the novelty signal. */
  private readonly recentArbitration: ('TYPE_1' | 'TYPE_2' | 'SHRUG')[] = [];

  /** Timestamps (ms) of recent cycles for the load signal. */
  private readonly recentCycleTimes: number[] = [];

  private lastEffectiveRate = 0;

  /**
   * Update rolling signals and return the effective sampling interval for the
   * current cycle, bounded by the policy. Pure function of (policy, inputs,
   * internal rolling window) — deterministic for a given history.
   */
  nextEffectiveRate(policy: SamplingPolicy, inputs: SamplerInputs): number {
    // --- update rolling windows (bounded) ---
    this.recentArbitration.push(inputs.arbitrationType);
    if (this.recentArbitration.length > NOVELTY_WINDOW) {
      this.recentArbitration.shift();
    }

    this.recentCycleTimes.push(inputs.nowMs);
    if (this.recentCycleTimes.length > NOVELTY_WINDOW) {
      this.recentCycleTimes.shift();
    }

    if (!policy.adaptive) {
      this.lastEffectiveRate = policy.sampleRate;
      return policy.sampleRate;
    }

    const base = policy.sampleRate;

    // --- signal 1: budget pressure (stretch as we approach the ceiling) ---
    // 0 spent → ×1.0 ; fully spent → ×maxRate-ward. Quadratic so the stretch
    // is gentle early and sharp near the ceiling.
    const budgetFrac = clamp01(inputs.budgetUsedFraction);
    const budgetMultiplier = 1 + 3 * budgetFrac * budgetFrac; // [1, 4]

    // --- signal 2: novelty (shrink interval when cognition is novel) ---
    const noveltyShare = this.noveltyShare(); // [0, 1]
    // High novelty → divide interval by up to 2 (sample twice as often).
    const noveltyDivisor = 1 + noveltyShare; // [1, 2]

    // --- signal 3: load (stretch modestly under heavy cycle throughput) ---
    const cps = this.cyclesPerSecond();
    // At <=1 cps no stretch; ramps to ×1.5 by ~10 cps, capped.
    const loadMultiplier = 1 + Math.min(0.5, Math.max(0, (cps - 1) / 18));

    let effective = (base * budgetMultiplier * loadMultiplier) / noveltyDivisor;

    effective = Math.round(effective);
    effective = Math.max(policy.adaptiveMinRate, Math.min(policy.adaptiveMaxRate, effective));

    this.lastEffectiveRate = effective;
    return effective;
  }

  /** Last computed effective rate (for status reporting). */
  getLastEffectiveRate(): number {
    return this.lastEffectiveRate;
  }

  // ---------------------------------------------------------------------------

  /** Fraction of the recent window that was TYPE_2 or SHRUG. */
  private noveltyShare(): number {
    if (this.recentArbitration.length === 0) return 0;
    const novel = this.recentArbitration.filter(
      (a) => a === 'TYPE_2' || a === 'SHRUG',
    ).length;
    return novel / this.recentArbitration.length;
  }

  /** Estimate cycles-per-second from the rolling timestamp window. */
  private cyclesPerSecond(): number {
    if (this.recentCycleTimes.length < 2) return 0;
    const first = this.recentCycleTimes[0];
    const last = this.recentCycleTimes[this.recentCycleTimes.length - 1];
    const spanMs = last - first;
    if (spanMs <= 0) return 0;
    return ((this.recentCycleTimes.length - 1) * 1000) / spanMs;
  }
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

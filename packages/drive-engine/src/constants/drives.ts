/**
 * Drive Engine constants and configuration values.
 *
 * CANON §Subsystem 4 (Drive Engine): Core computation parameters for the 12-drive
 * motivational system. All constants are immutable and validated at module startup.
 *
 * Accumulation rates define how quickly each drive builds pressure (toward 1.0).
 * Decay rates define how quickly satisfied drives fade (toward 0.0).
 */

import { DriveName } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Tick Configuration
// ---------------------------------------------------------------------------

/**
 * Drive Engine tick interval in milliseconds.
 * Target: 1Hz (1000ms per tick).
 *
 * 1Hz is appropriate for a motivational system where drives change over
 * minutes, not milliseconds. Produces readable logs, intuitive rate
 * values (per-second), and minimal CPU overhead.
 *
 * CANON §A.1: "Compute base drive updates (accumulation, decay)"
 */
export const DRIVE_ENGINE_TICK_INTERVAL_MS = 1000;

/**
 * Maximum allowed drift for tick timing compensation.
 * If a tick runs late, the next tick adjusts to compensate.
 * Prevents long-term clock skew from accumulating.
 */
export const MAX_TICK_DRIFT_MS = 100;

// ---------------------------------------------------------------------------
// Per-Drive Accumulation Rates (pressure buildup)
// ---------------------------------------------------------------------------

/**
 * Accumulation rate per tick for each drive.
 *
 * Positive values: drive increases toward 1.0 (pressure builds).
 * Zero: drive only changes via events or cross-modulation.
 * Values are added each tick to the drive's current value.
 *
 * CANON §A.14: Core and complement accumulation schedule.
 */
export const DRIVE_ACCUMULATION_RATES: Readonly<Record<DriveName, number>> = {
  // Core drives: always accumulating (fundamental needs)
  // Rates are per-tick at 1Hz (1 tick = 1 second).
  // Tuned for Phase 1.5: no relief actions yet, so rates are slow enough
  // that drives don't all max out within a single session (~30-60 min).
  [DriveName.SystemHealth]: 0.0009,    // ~15 min to fill from 0.2
  [DriveName.MoralValence]: 0.0006,    // ~22 min to fill from 0.2
  [DriveName.Integrity]: 0.0006,       // ~22 min to fill from 0.2
  [DriveName.CognitiveAwareness]: 0.0006, // ~22 min to fill from 0.2

  // Complement drives: mixed accumulation and decay
  [DriveName.Guilt]: 0.0, // Event-only, no base accumulation
  [DriveName.Curiosity]: 0.0012,       // ~10 min to fill from 0.3
  [DriveName.Boredom]: 0.0015,         // ~7 min to fill from 0.4
  [DriveName.Anxiety]: 0.0003,         // ~44 min to fill from 0.2
  [DriveName.Satisfaction]: 0.0, // Decays, see decay rates
  [DriveName.Sadness]: 0.0, // Decays, see decay rates
  [DriveName.Focus]: 0.0, // Event-only, no base accumulation — pressure comes from prediction failures
  [DriveName.Social]: 0.0009,          // ~9 min to fill from 0.5
} as const;

// ---------------------------------------------------------------------------
// Per-Drive Decay Rates (relief / satiation)
// ---------------------------------------------------------------------------

/**
 * Decay rate per tick for each drive.
 *
 * Negative values: drive decreases toward 0.0 (satisfied need fades).
 * Zero: drive does not decay naturally (only changes via events).
 *
 * Satisfaction and Sadness are the primary decay drives — they represent
 * relief from recent positive/negative experiences and naturally fade as
 * Sylphie's emotional memory of the event decays.
 */
export const DRIVE_DECAY_RATES: Readonly<Record<DriveName, number>> = {
  [DriveName.SystemHealth]: 0.0,
  [DriveName.MoralValence]: 0.0,
  [DriveName.Integrity]: 0.0,
  [DriveName.CognitiveAwareness]: 0.0,

  [DriveName.Guilt]: 0.0, // Event-only
  [DriveName.Curiosity]: 0.0,
  [DriveName.Boredom]: 0.0,
  [DriveName.Anxiety]: 0.0,
  [DriveName.Satisfaction]: -0.0009, // relief fades over ~18 min
  [DriveName.Sadness]: -0.0006,     // sadness fades over ~28 min
  [DriveName.Focus]: -0.0006,       // focus recovers over ~28 min
  [DriveName.Social]: 0.0,
} as const;

// ---------------------------------------------------------------------------
// Cross-Modulation Thresholds and Coefficients
// ---------------------------------------------------------------------------

/**
 * Threshold above which anxiety suppresses curiosity.
 * When anxiety > this value, curiosity is reduced by cross-modulation.
 *
 * CANON §A.15: "High anxiety (>0.7) reduces curiosity"
 */
export const ANXIETY_CURIOSITY_SUPPRESSION_THRESHOLD = 0.7;

/**
 * Multiplier applied when high anxiety suppresses curiosity.
 * curiosity *= (1 - coefficient * anxiety)
 *
 * At anxiety = 1.0: curiosity *= 0.99 per tick → ~37% reduction over 60s.
 * Mild suppression — anxiety makes exploration less appealing, not impossible.
 */
export const ANXIETY_CURIOSITY_SUPPRESSION_COEFFICIENT = 0.03;

/**
 * Threshold above which satisfaction reduces boredom.
 *
 * CANON §A.15: "High satisfaction reduces boredom"
 */
export const SATISFACTION_BOREDOM_SUPPRESSION_THRESHOLD = 0.6;

/**
 * Multiplier applied when high satisfaction reduces boredom.
 * boredom *= (1 - coefficient * satisfaction)
 *
 * At satisfaction = 1.0: boredom *= 0.99 per tick → ~37% reduction over 60s.
 */
export const SATISFACTION_BOREDOM_SUPPRESSION_COEFFICIENT = 0.03;

/**
 * Threshold above which high anxiety increases integrity pressure.
 *
 * CANON §A.15: "High anxiety (>0.7) increases integrity pressure"
 */
export const ANXIETY_INTEGRITY_AMPLIFICATION_THRESHOLD = 0.7;

/**
 * Additive effect when high anxiety amplifies integrity.
 * integrity += coefficient * anxiety
 *
 * At anxiety = 1.0: +0.0004/s (2x base integrity rate).
 * Anxiety doubles integrity pressure, not dominates it.
 */
export const ANXIETY_INTEGRITY_AMPLIFICATION_COEFFICIENT = 0.0012;

/**
 * Threshold above which high systemHealth pressure amplifies anxiety.
 * High pressure = something is wrong with the system = anxiety rises.
 */
export const SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_THRESHOLD = 0.7;

/**
 * Additive effect when high systemHealth pressure amplifies anxiety.
 * anxiety += coefficient * (systemHealth - threshold)
 *
 * At systemHealth = 1.0 (gap = 0.3): +0.0009/s (~3x base anxiety rate).
 */
export const SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_COEFFICIENT = 0.003;

/**
 * Threshold above which high boredom increases curiosity.
 *
 * CANON §A.15: "High boredom (>0.6) increases curiosity"
 */
export const BOREDOM_CURIOSITY_AMPLIFICATION_THRESHOLD = 0.6;

/**
 * Additive effect when high boredom increases curiosity.
 * curiosity += coefficient * (boredom - threshold)
 *
 * At boredom = 1.0 (gap = 0.4): +0.0004/s (1x base curiosity rate).
 * Being bored doubles curiosity buildup.
 */
export const BOREDOM_CURIOSITY_AMPLIFICATION_COEFFICIENT = 0.003;

/**
 * Threshold above which high guilt reduces satisfaction.
 *
 * CANON §A.15: "High guilt reduces satisfaction"
 */
export const GUILT_SATISFACTION_SUPPRESSION_THRESHOLD = 0.4;

/**
 * Multiplier applied when high guilt reduces satisfaction.
 * satisfaction *= (1 - coefficient * guilt)
 *
 * At guilt = 1.0: satisfaction *= 0.99 per tick → ~37% reduction over 60s.
 */
export const GUILT_SATISFACTION_SUPPRESSION_COEFFICIENT = 0.03;

// ---------------------------------------------------------------------------
// Process Health
// ---------------------------------------------------------------------------

/**
 * Maximum memory footprint for the Drive Engine process in MB.
 * If exceeded, the process logs a health warning and may request restart.
 *
 * ACCEPTANCE CRITERIA: <10MB.
 */
export const DRIVE_PROCESS_MAX_MEMORY_MB = 10;

/**
 * Maximum outcome queue length before warning.
 * If the queue grows beyond this, ticks are being generated faster than
 * outcomes are being drained — likely a performance issue upstream.
 */
export const MAX_OUTCOME_QUEUE_LENGTH = 1000;

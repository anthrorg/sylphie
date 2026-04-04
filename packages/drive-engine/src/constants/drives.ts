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
 * Target: 100Hz (10ms per tick).
 * Used for drift-compensated setTimeout scheduling.
 *
 * CANON §A.1: "Compute base drive updates (accumulation, decay)"
 */
export const DRIVE_ENGINE_TICK_INTERVAL_MS = 10;

/**
 * Maximum allowed drift for tick timing compensation.
 * If a tick runs late, the next tick adjusts to compensate.
 * Prevents long-term clock skew from accumulating.
 */
export const MAX_TICK_DRIFT_MS = 5;

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
  [DriveName.SystemHealth]: 0.003,
  [DriveName.MoralValence]: 0.002,
  [DriveName.Integrity]: 0.002,
  [DriveName.CognitiveAwareness]: 0.002,

  // Complement drives: mixed accumulation and decay
  [DriveName.Guilt]: 0.0, // Event-only, no base accumulation
  [DriveName.Curiosity]: 0.004,
  [DriveName.Boredom]: 0.005,
  [DriveName.Anxiety]: 0.001,
  [DriveName.Satisfaction]: 0.0, // Decays, see decay rates
  [DriveName.Sadness]: 0.0, // Decays, see decay rates
  [DriveName.Focus]: 0.0, // Event-only, no base accumulation — pressure comes from prediction failures
  [DriveName.Social]: 0.003,
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
  [DriveName.Satisfaction]: -0.003, // Decays toward 0.0 (relief fades)
  [DriveName.Sadness]: -0.002, // Decays toward 0.0 (sadness fades)
  [DriveName.Focus]: -0.002, // Focus decays naturally — prediction confidence recovers over time
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
 * curiosity *= (1 - ANXIETY_CURIOSITY_SUPPRESSION_COEFFICIENT * anxiety)
 *
 * At anxiety = 1.0, curiosity gets multiplied by (1 - 0.4) = 0.6.
 */
export const ANXIETY_CURIOSITY_SUPPRESSION_COEFFICIENT = 0.4;

/**
 * Threshold above which satisfaction reduces boredom.
 *
 * CANON §A.15: "High satisfaction reduces boredom"
 */
export const SATISFACTION_BOREDOM_SUPPRESSION_THRESHOLD = 0.6;

/**
 * Multiplier applied when high satisfaction reduces boredom.
 * boredom *= (1 - SATISFACTION_BOREDOM_SUPPRESSION_COEFFICIENT * satisfaction)
 */
export const SATISFACTION_BOREDOM_SUPPRESSION_COEFFICIENT = 0.3;

/**
 * Threshold above which high anxiety increases integrity pressure.
 *
 * CANON §A.15: "High anxiety (>0.7) increases integrity pressure"
 */
export const ANXIETY_INTEGRITY_AMPLIFICATION_THRESHOLD = 0.7;

/**
 * Multiplier applied when high anxiety amplifies integrity.
 * integrity += ANXIETY_INTEGRITY_AMPLIFICATION_COEFFICIENT * anxiety
 */
export const ANXIETY_INTEGRITY_AMPLIFICATION_COEFFICIENT = 0.2;

/**
 * Threshold below which low systemHealth amplifies anxiety.
 *
 * CANON §A.15: "Low systemHealth amplifies anxiety"
 */
export const SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_THRESHOLD = 0.3;

/**
 * Multiplier applied when low systemHealth amplifies anxiety.
 * anxiety += SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_COEFFICIENT * (threshold - systemHealth)
 */
export const SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_COEFFICIENT = 0.5;

/**
 * Threshold above which high boredom increases curiosity.
 *
 * CANON §A.15: "High boredom (>0.6) increases curiosity"
 */
export const BOREDOM_CURIOSITY_AMPLIFICATION_THRESHOLD = 0.6;

/**
 * Multiplier applied when high boredom increases curiosity.
 * curiosity += BOREDOM_CURIOSITY_AMPLIFICATION_COEFFICIENT * (boredom - threshold)
 */
export const BOREDOM_CURIOSITY_AMPLIFICATION_COEFFICIENT = 0.3;

/**
 * Threshold above which high guilt reduces satisfaction.
 *
 * CANON §A.15: "High guilt reduces satisfaction"
 */
export const GUILT_SATISFACTION_SUPPRESSION_THRESHOLD = 0.4;

/**
 * Multiplier applied when high guilt reduces satisfaction.
 * satisfaction *= (1 - GUILT_SATISFACTION_SUPPRESSION_COEFFICIENT * guilt)
 */
export const GUILT_SATISFACTION_SUPPRESSION_COEFFICIENT = 0.5;

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

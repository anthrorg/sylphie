/**
 * Self-evaluation configuration constants.
 *
 * Controls the slower timescale at which the Drive Engine reads KG(Self)
 * to adjust drive baselines and prevent identity lock-in.
 *
 * CANON §E4-T008: Self-evaluation runs every N ticks to prevent rumination.
 */

import { DriveName } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Self-Evaluation Cadence
// ---------------------------------------------------------------------------

/**
 * Interval at which self-evaluation executes.
 * Runs every N ticks. At 1Hz, 10 ticks = 10 seconds.
 *
 * Slower timescale prevents constant re-assessment and allows drive
 * state to stabilize between evaluations.
 */
export const SELF_EVALUATION_INTERVAL_TICKS = 10;

// ---------------------------------------------------------------------------
// Circuit Breaker Configuration
// ---------------------------------------------------------------------------

/**
 * Number of consecutive negative self-assessments before circuit breaker trips.
 * When exceeded, self-evaluation pauses to prevent rumination loops.
 */
export const CIRCUIT_BREAKER_NEGATIVE_THRESHOLD = 5;

/**
 * Pause duration in milliseconds when circuit breaker trips.
 * After this period, self-evaluation re-enables.
 */
export const CIRCUIT_BREAKER_PAUSE_DURATION_MS = 5000;

// ---------------------------------------------------------------------------
// Baseline Adjustment Rates
// ---------------------------------------------------------------------------

/**
 * Amount to reduce a drive baseline when self-assessed capability is low.
 * Applied once per self-evaluation when capability < LOW_CAPABILITY_THRESHOLD.
 */
export const BASELINE_REDUCTION_RATE = 0.05;

/**
 * Amount to gradually restore a drive baseline toward default.
 * Applied every self-evaluation cycle to prevent permanent depression.
 */
export const BASELINE_RECOVERY_RATE = 0.01;

/**
 * Capability threshold below which baseline reduction is applied.
 * If successRate < this value, the drive baseline is reduced.
 */
export const LOW_CAPABILITY_THRESHOLD = 0.3;

/**
 * Capability threshold above which baseline is maintained at default.
 * If successRate >= this value, no adjustment needed.
 */
export const HIGH_CAPABILITY_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Capability-to-Drive Mapping
// ---------------------------------------------------------------------------

/**
 * Map from KG(Self) capability names to drives they influence.
 * When a capability is queried and found in this map, the corresponding
 * drive baseline is adjusted based on successRate.
 */
export const CAPABILITY_TO_DRIVE_MAP: Readonly<Record<string, DriveName>> = {
  social_interaction: DriveName.Social,
  knowledge_retrieval: DriveName.CognitiveAwareness,
  prediction_accuracy: DriveName.Integrity,
  error_correction: DriveName.MoralValence,
} as const;

// ---------------------------------------------------------------------------
// KG(Self) Query Timeouts
// ---------------------------------------------------------------------------

/**
 * Maximum time to wait for a KG(Self) query to complete.
 * If exceeded, the evaluation is skipped (doesn't block tick loop).
 */
export const SELF_KG_QUERY_TIMEOUT_MS = 500;

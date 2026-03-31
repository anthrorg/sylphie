/**
 * Constants for opportunity detection and classification.
 *
 * CANON §E4-T010: Opportunity detection runs in the Drive Engine to identify
 * patterns requiring Planning intervention. Opportunities are classified by type,
 * scored by priority, decay over time, and emitted to Planning via IPC.
 */

/**
 * Classification thresholds for opportunity patterns.
 */

/**
 * RECURRING pattern: A prediction type fails more than this many times
 * in the last 10 predictions.
 */
export const RECURRING_FAILURE_THRESHOLD = 3;

/**
 * HIGH_IMPACT classification: Pattern has MAE > this threshold
 * OR totalPressure > this threshold at time of failure.
 */
export const HIGH_IMPACT_MAE_THRESHOLD = 0.40;
export const HIGH_IMPACT_PRESSURE_THRESHOLD = 0.8;

/**
 * LOW_PRIORITY classification: Single failure, low magnitude, low pressure.
 * These are internal detections, rarely emitted.
 */
export const LOW_PRIORITY_THRESHOLD = 0.20;

/**
 * Cold-start dampening: Opportunities detected in early sessions are
 * dampened to prevent false positives when the system has insufficient data.
 *
 * Formula: priority *= min(1.0, sessionNumber / COLD_START_SESSION_COUNT)
 */
export const COLD_START_SESSION_COUNT = 10;

/**
 * Opportunity decay thresholds.
 *
 * When the underlying prediction improves (MAE < DECAY_MAE_THRESHOLD),
 * the opportunity priority decays.
 */
export const DECAY_MAE_THRESHOLD = 0.10;
export const DECAY_PRIORITY_REDUCTION = 0.5; // Multiply priority by 0.5

/**
 * Remove opportunity entirely when the underlying prediction has been
 * consistently accurate (MAE < DECAY_MAE_THRESHOLD) for this many
 * consecutive predictions.
 */
export const DECAY_REMOVAL_CONSECUTIVE_THRESHOLD = 100;

/**
 * Opportunity queue management.
 */

/**
 * Maximum number of active opportunities in the queue.
 * When exceeded, lowest-priority items are removed.
 */
export const MAX_QUEUE_SIZE = 50;

/**
 * Emission rate limiting.
 * The queue emits top opportunities every EMISSION_INTERVAL_TICKS.
 * At most EMISSION_MAX_PER_CYCLE opportunities are emitted per cycle.
 */
export const EMISSION_INTERVAL_TICKS = 100; // ~1 second at 100Hz
export const EMISSION_MAX_PER_CYCLE = 5;

/**
 * Decay check interval.
 * The decay circuit runs every DECAY_CHECK_INTERVAL_TICKS to update
 * opportunity priorities based on prediction improvement.
 */
export const DECAY_CHECK_INTERVAL_TICKS = 100; // ~1 second at 100Hz

/**
 * De-duplication: When an opportunity for the same predictionType
 * already exists, update priority instead of creating a duplicate.
 * This prevents queue spam from the same pattern.
 */
export const DEDUPLICATION_ENABLED = true;

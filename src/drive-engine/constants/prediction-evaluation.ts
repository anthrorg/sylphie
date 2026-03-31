/**
 * Constants for prediction accuracy evaluation.
 *
 * CANON §E4-T009: Prediction evaluator computes MAE (Mean Absolute Error) per
 * prediction type over a rolling window of last 10 predictions. Used for
 * Type 1 graduation logic and opportunity detection when prediction accuracy
 * degrades.
 */

/**
 * Number of predictions to accumulate before computing MAE.
 * MAE is computed and cached every time this threshold is reached or every
 * CACHE_TTL_MS whichever comes first.
 */
export const MAE_WINDOW_SIZE = 10;

/**
 * MAE classification thresholds.
 *
 * - ACCURATE: MAE < 0.10 — prediction model is reliable
 * - MODERATE: MAE 0.10–0.20 — model performance degrading
 * - POOR:     MAE >= 0.20 — model unreliable, triggers opportunity detection
 */
export const MAE_ACCURATE_THRESHOLD = 0.10;
export const MAE_MODERATE_THRESHOLD = 0.20;

/**
 * Type 1 graduation criteria.
 *
 * A behavior can graduate from Type 2 (LLM-deliberative) to Type 1 (graph
 * reflex) only when:
 * - confidence > 0.80 (sufficient experience with the behavior)
 * - MAE < 0.10 (predictions about its outcomes are reliable)
 *
 * CANON §Type 1/Type 2 Discipline: Without reliable prediction accuracy,
 * Type 1 graduation is a mistake (the reflex will fail unpredictably).
 */
export const GRADUATION_CONFIDENCE_THRESHOLD = 0.80;
export const GRADUATION_MAE_THRESHOLD = 0.10;

/**
 * Type 1 demotion threshold.
 *
 * A previously graduated Type 1 behavior is demoted back to Type 2 if its
 * prediction accuracy degrades beyond this threshold, indicating the model
 * has shifted or the environment has changed.
 */
export const DEMOTION_MAE_THRESHOLD = 0.15;

/**
 * Cache TTL for MAE computations in milliseconds.
 *
 * Even if fewer than MAE_WINDOW_SIZE predictions have accumulated, the cached
 * MAE will be updated every CACHE_TTL_MS to ensure the system doesn't make
 * decisions based on stale data.
 */
export const CACHE_TTL_MS = 60000; // 60 seconds

/**
 * Opportunity severity classification based on MAE magnitude.
 *
 * When MAE > POOR_MAE_THRESHOLD (0.20), an opportunity is signaled to Planning.
 * The severity is determined by how far above the threshold it is:
 *
 * - LOW:    MAE 0.20–0.30 — mild prediction degradation, low urgency
 * - MEDIUM: MAE 0.30–0.40 — significant errors, should be addressed
 * - HIGH:   MAE >= 0.40  — severe failures, urgent planning needed
 *
 * OpportunitySE signals are only emitted for MEDIUM or HIGH severity
 * (IPC message OPPORTUNITY_CREATED).
 */
export const OPPORTUNITY_SEVERITY_LOW_THRESHOLD = 0.30;
export const OPPORTUNITY_SEVERITY_MEDIUM_THRESHOLD = 0.40;

/**
 * Minimum sample count for valid MAE computation.
 *
 * If fewer than this many predictions have been recorded for a type,
 * the MAE is marked as "insufficient data" and not used for graduation
 * or demotion decisions.
 */
export const MIN_SAMPLE_COUNT = 1; // Allow graduated decisions with partial data if needed

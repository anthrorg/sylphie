/**
 * Opportunity signal generation from prediction accuracy data.
 *
 * CANON §Subsystem 5 (Planning): The Drive Engine detects patterns worth
 * addressing through Planning. One such pattern is recurring prediction
 * failures: when a behavior's predictions consistently miss (MAE > 0.20),
 * it signals an opportunity for Planning to research and improve.
 *
 * Opportunity signals are emitted via IPC as OPPORTUNITY_CREATED messages
 * only when severity is MEDIUM or HIGH (MAE >= 0.30).
 */

import { verboseFor } from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');

import { MAE_MODERATE_THRESHOLD } from '../constants/prediction-evaluation';

/**
 * Opportunity signal for prediction failures.
 * Sent to Planning subsystem via IPC for opportunity intake.
 */
export interface PredictionOpportunitySignal {
  /** Unique identifier for this signal. */
  readonly id: string;

  /** The type of opportunity. */
  readonly type: 'PREDICTION_FAILURE_PATTERN';

  /** The prediction type that is failing (action category). */
  readonly predictionType: string;

  /** Current MAE for this prediction type. */
  readonly mae: number;

  /** Number of predictions in the current window that were inaccurate. */
  readonly recentFailures: number;

  /** Severity: 'low' | 'medium' | 'high' */
  readonly severity: 'low' | 'medium' | 'high';

  /** Timestamp when the signal was created. */
  readonly createdAt: Date;

  /** Suggested context fingerprint for Planning to use. */
  readonly contextFingerprint: string;
}

/**
 * Generate an opportunity signal for a prediction type with poor accuracy.
 *
 * Called by the Drive Engine when prediction accuracy is poor (MAE > 0.20).
 * Computes severity based on MAE magnitude and counts recent failures in
 * the window.
 *
 * @param predictionType - The action category with poor predictions
 * @param mae - Current MAE for this type
 * @param recentPredictions - Array of recent prediction records with accuracies
 * @returns Opportunity signal object, or null if severity is LOW
 */
export function generatePredictionOpportunitySignal(
  predictionType: string,
  mae: number,
  recentPredictions: Array<{ absoluteError: number }>,
): PredictionOpportunitySignal | null {
  // Only generate signals for POOR predictions
  if (mae < MAE_MODERATE_THRESHOLD) {
    return null;
  }

  // Count recent failures (error > 0.20 threshold)
  const recentFailures = recentPredictions.filter(
    (p) => p.absoluteError > MAE_MODERATE_THRESHOLD,
  ).length;

  // Determine severity
  let severity: 'low' | 'medium' | 'high';
  if (mae < 0.30) {
    severity = 'low';
  } else if (mae < 0.40) {
    severity = 'medium';
  } else {
    severity = 'high';
  }

  // Generate context fingerprint for Planning
  const contextFingerprint = `prediction_failure_${predictionType}_mae_${mae.toFixed(2)}`;

  // Generate signal
  const signal: PredictionOpportunitySignal = {
    id: generateId(),
    type: 'PREDICTION_FAILURE_PATTERN',
    predictionType,
    mae,
    recentFailures,
    severity,
    createdAt: new Date(),
    contextFingerprint,
  };

  vlog('opportunity signal generated', {
    id: signal.id,
    predictionType,
    mae: +mae.toFixed(4),
    severity,
    recentFailures,
  });

  return signal;
}

/**
 * Check if an opportunity signal should be emitted via IPC.
 *
 * Signals are only emitted for MEDIUM or HIGH severity. LOW severity
 * signals are logged but not propagated to Planning to avoid spamming
 * the opportunity queue with low-priority patterns.
 *
 * @param signal - The opportunity signal to check
 * @returns true if the signal should be emitted via IPC
 */
export function shouldEmitOpportunitySignal(signal: PredictionOpportunitySignal): boolean {
  const shouldEmit = signal.severity === 'medium' || signal.severity === 'high';
  vlog('opportunity signal emit decision', {
    id: signal.id,
    severity: signal.severity,
    shouldEmit,
  });
  return shouldEmit;
}

/**
 * Generate a unique ID for an opportunity signal.
 * Uses a simple timestamp-based approach suitable for in-process IDs.
 */
function generateId(): string {
  return `opp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

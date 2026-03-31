/**
 * Priority scoring for opportunities.
 *
 * CANON §E4-T010: Priority determines how urgently Planning should address
 * an opportunity. Formula: priority = log(frequency + 1) * magnitude
 *
 * With cold-start dampening for sessions 1-10 and guardian asymmetry.
 */

import {
  COLD_START_SESSION_COUNT,
} from '../constants/opportunity-detection';
import type { Opportunity } from './opportunity';

/**
 * Compute priority for an opportunity.
 *
 * Formula:
 *   base_priority = log(frequency + 1) * magnitude
 *
 * Then apply modifiers:
 *   - Cold-start dampening: multiply by (sessionNumber / 10) for sessions 1-10
 *   - Guardian asymmetry: if guardianTriggered, multiply by 2.0
 *
 * @param frequency - How many times has this prediction failed?
 * @param magnitude - The MAE value [0.0, 1.0]
 * @param sessionNumber - Current session number (1-indexed)
 * @param guardianTriggered - Was this triggered by guardian correction?
 * @returns Computed priority score
 */
export function computePriority(
  frequency: number,
  magnitude: number,
  sessionNumber: number,
  guardianTriggered: boolean,
): number {
  // Base priority: log(frequency + 1) * magnitude
  // The log reduces influence of repeated failures while still respecting magnitude
  const basePriority = Math.log(frequency + 1) * magnitude;

  // Cold-start dampening (sessions 1-10)
  let priority = basePriority;
  const coldStartFactor = Math.min(1.0, sessionNumber / COLD_START_SESSION_COUNT);
  priority *= coldStartFactor;

  // Guardian asymmetry: 2x if triggered by guardian correction
  if (guardianTriggered) {
    priority *= 2.0;
  }

  return priority;
}

/**
 * Update priority for an existing opportunity.
 *
 * Called when a new failure signal arrives for a prediction type
 * that already has an active opportunity.
 *
 * @param opportunity - The existing opportunity to update
 * @param newFailureCount - Updated failure count
 * @param newMae - Updated MAE
 * @param sessionNumber - Current session number
 * @param guardianTriggered - Was this update triggered by guardian?
 */
export function updateOpportunityPriority(
  opportunity: Opportunity,
  newFailureCount: number,
  newMae: number,
  sessionNumber: number,
  guardianTriggered: boolean,
): void {
  const newPriority = computePriority(
    newFailureCount,
    newMae,
    sessionNumber,
    guardianTriggered,
  );

  opportunity.priority = newPriority;
  opportunity.failureCount = newFailureCount;
  opportunity.mae = newMae;
  opportunity.guardianTriggered = guardianTriggered || opportunity.guardianTriggered;
  opportunity.updatedAt = new Date();
}

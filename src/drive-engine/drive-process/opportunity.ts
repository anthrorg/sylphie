/**
 * Core opportunity data structure.
 *
 * An Opportunity represents a pattern detected by the Drive Engine
 * that merits Planning intervention. Opportunities accumulate over time
 * with priority scoring, classification, and decay.
 */

/**
 * Classification of an opportunity by origin type.
 */
export type OpportunityClassification = 'RECURRING' | 'HIGH_IMPACT' | 'LOW_PRIORITY';

/**
 * A detected opportunity in the Drive Engine.
 */
export interface Opportunity {
  /** Unique identifier (UUID-like). */
  id: string;

  /** The prediction type that failed (action category). */
  predictionType: string;

  /** Classification: RECURRING, HIGH_IMPACT, or LOW_PRIORITY. */
  classification: OpportunityClassification;

  /** Current MAE for the failing prediction type. */
  mae: number;

  /** Number of times this prediction type has failed (in window). */
  failureCount: number;

  /** Current priority score. Decays over time. */
  priority: number;

  /** Session number when this opportunity was first detected. */
  sessionNumber: number;

  /** Total drive pressure at time of detection. */
  totalPressure: number;

  /** Whether this opportunity was triggered by guardian correction. */
  guardianTriggered: boolean;

  /** Timestamp when first detected. */
  createdAt: Date;

  /** Timestamp when last updated. */
  updatedAt: Date;

  /** Number of consecutive predictions with MAE < 0.10 for decay tracking. */
  consecutiveGoodPredictions: number;

  /**
   * Context fingerprint for Planning deduplication.
   * Format: "prediction_failure_{predictionType}_mae_{mae.toFixed(2)}"
   */
  contextFingerprint: string;
}

/**
 * Create a new Opportunity from detection parameters.
 */
export function createOpportunity(
  predictionType: string,
  classification: OpportunityClassification,
  mae: number,
  failureCount: number,
  sessionNumber: number,
  totalPressure: number,
  guardianTriggered: boolean,
): Opportunity {
  const now = new Date();
  return {
    id: generateOpportunityId(),
    predictionType,
    classification,
    mae,
    failureCount,
    priority: 0, // Will be computed by priority scorer
    sessionNumber,
    totalPressure,
    guardianTriggered,
    createdAt: now,
    updatedAt: now,
    consecutiveGoodPredictions: 0,
    contextFingerprint: `prediction_failure_${predictionType}_mae_${mae.toFixed(2)}`,
  };
}

/**
 * Generate a unique ID for an opportunity.
 */
function generateOpportunityId(): string {
  return `opp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Opportunity detector: pattern classification and registry.
 *
 * CANON §E4-T010: Receives opportunity signals from PredictionEvaluator,
 * classifies patterns (RECURRING, HIGH_IMPACT, LOW_PRIORITY), and maintains
 * a registry of active opportunities. De-duplicates identical patterns to
 * prevent queue spam.
 */

import type { PredictionEvaluator } from './prediction-evaluator';
import type { PredictionOpportunitySignal } from './opportunity-signal';
import {
  RECURRING_FAILURE_THRESHOLD,
  HIGH_IMPACT_MAE_THRESHOLD,
  HIGH_IMPACT_PRESSURE_THRESHOLD,
  DEDUPLICATION_ENABLED,
} from '../constants/opportunity-detection';
import { createOpportunity, type Opportunity, type OpportunityClassification } from './opportunity';
import { computePriority } from './opportunity-priority';

/**
 * OpportunityDetector: Classifies opportunity signals and maintains registry.
 */
export class OpportunityDetector {
  /** Registry: predictionType -> Opportunity */
  private registry: Map<string, Opportunity> = new Map();

  /** Current session number (1-indexed). */
  private sessionNumber: number = 1;

  /** Current total drive pressure (updated each tick). */
  private totalPressure: number = 0;

  constructor() {}

  /**
   * Update session number (called at session start).
   */
  public setSessionNumber(sessionNumber: number): void {
    this.sessionNumber = sessionNumber;
  }

  /**
   * Update total pressure (called each tick).
   *
   * @param pressure - Sum of all positive drives
   */
  public setTotalPressure(pressure: number): void {
    this.totalPressure = pressure;
  }

  /**
   * Process an opportunity signal and update registry.
   *
   * Classifies the signal based on:
   *   - RECURRING: prediction type fails >3 times in last 10 predictions
   *   - HIGH_IMPACT: MAE > 0.40 OR totalPressure > 0.8
   *   - LOW_PRIORITY: single failure, low magnitude, low pressure
   *
   * If an opportunity for the same predictionType already exists,
   * updates priority instead of creating a duplicate.
   *
   * @param signal - PredictionOpportunitySignal from evaluator
   * @param evaluator - PredictionEvaluator for failure count lookup
   * @returns New Opportunity or null if LOW_PRIORITY and no existing entry
   */
  public processSignal(
    signal: PredictionOpportunitySignal,
    evaluator: PredictionEvaluator,
  ): Opportunity | null {
    // Get failure count for this prediction type
    const maeResult = evaluator.getMAE(signal.predictionType);
    const failureCount = maeResult.sampleCount; // Count of predictions in window

    // Classify the opportunity
    const classification = this.classifyOpportunity(
      failureCount,
      signal.mae,
      this.totalPressure,
    );

    // De-duplication: check if opportunity already exists for this prediction type
    const existing = this.registry.get(signal.predictionType);
    if (existing && DEDUPLICATION_ENABLED) {
      // Update priority instead of creating new
      const newPriority = computePriority(
        failureCount,
        signal.mae,
        this.sessionNumber,
        false, // guardianTriggered - would come from signal if available
      );
      existing.priority = newPriority;
      existing.failureCount = failureCount;
      existing.mae = signal.mae;
      existing.classification = classification;
      existing.updatedAt = new Date();
      return existing;
    }

    // Create new opportunity
    const opportunity = createOpportunity(
      signal.predictionType,
      classification,
      signal.mae,
      failureCount,
      this.sessionNumber,
      this.totalPressure,
      false, // guardianTriggered - would be extracted from signal
    );

    // Compute priority
    const priority = computePriority(
      failureCount,
      signal.mae,
      this.sessionNumber,
      false, // guardianTriggered
    );
    opportunity.priority = priority;

    // Store in registry
    this.registry.set(signal.predictionType, opportunity);

    return opportunity;
  }

  /**
   * Get all active opportunities.
   */
  public getActiveOpportunities(): Opportunity[] {
    return Array.from(this.registry.values());
  }

  /**
   * Remove an opportunity from the registry by ID.
   *
   * @param id - Opportunity ID
   */
  public removeOpportunity(id: string): void {
    for (const [key, opp] of this.registry.entries()) {
      if (opp.id === id) {
        this.registry.delete(key);
        return;
      }
    }
  }

  /**
   * Remove opportunity by predictionType (used in decay).
   *
   * @param predictionType - The action type to remove
   */
  public removeByPredictionType(predictionType: string): void {
    this.registry.delete(predictionType);
  }

  /**
   * Get opportunity by predictionType.
   *
   * @param predictionType - The action type to look up
   * @returns Opportunity or undefined
   */
  public getByPredictionType(predictionType: string): Opportunity | undefined {
    return this.registry.get(predictionType);
  }

  /**
   * Classify an opportunity based on failure pattern.
   *
   * RECURRING: failure count >= RECURRING_FAILURE_THRESHOLD (3)
   * HIGH_IMPACT: MAE > 0.40 OR totalPressure > 0.8
   * LOW_PRIORITY: otherwise
   *
   * @param failureCount - Number of failures in window
   * @param mae - Current MAE
   * @param totalPressure - Current total drive pressure
   * @returns Classification
   */
  private classifyOpportunity(
    failureCount: number,
    mae: number,
    totalPressure: number,
  ): OpportunityClassification {
    const isRecurring = failureCount >= RECURRING_FAILURE_THRESHOLD;
    const isHighImpact =
      mae > HIGH_IMPACT_MAE_THRESHOLD || totalPressure > HIGH_IMPACT_PRESSURE_THRESHOLD;

    if (isRecurring) {
      return 'RECURRING';
    }

    if (isHighImpact) {
      return 'HIGH_IMPACT';
    }

    return 'LOW_PRIORITY';
  }
}

/**
 * Global singleton instance for the Drive Engine process.
 */
let detector: OpportunityDetector | null = null;

/**
 * Get or create the global detector instance.
 */
export function getOrCreateOpportunityDetector(): OpportunityDetector {
  if (!detector) {
    detector = new OpportunityDetector();
  }
  return detector;
}

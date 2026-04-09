/**
 * Prediction accuracy evaluator for the Drive Engine.
 *
 * CANON §E4-T009: Tracks prediction outcomes in-memory and computes MAE
 * (Mean Absolute Error) per prediction type over a rolling window of 10
 * predictions. Used by the Drive Engine to:
 *
 * 1. Evaluate graduation criteria: confidence > 0.80 AND MAE < 0.10
 * 2. Detect demotion: MAE > 0.15 (accuracy degradation)
 * 3. Generate opportunity signals: MAE > 0.20 (opportunity for planning)
 *
 * Predictions arrive via IPC as part of ACTION_OUTCOME with a predictionId.
 * The outcome's success/failure maps to prediction accuracy (absoluteError).
 */

import { verboseFor } from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');

import {
  MAE_WINDOW_SIZE,
  MAE_ACCURATE_THRESHOLD,
  MAE_MODERATE_THRESHOLD,
  GRADUATION_CONFIDENCE_THRESHOLD,
  GRADUATION_MAE_THRESHOLD,
  DEMOTION_MAE_THRESHOLD,
  CACHE_TTL_MS,
  OPPORTUNITY_SEVERITY_LOW_THRESHOLD,
  OPPORTUNITY_SEVERITY_MEDIUM_THRESHOLD,
  MIN_SAMPLE_COUNT,
} from '../constants/prediction-evaluation';

/**
 * Represents a single recorded prediction outcome.
 */
interface PredictionRecord {
  predictionId: string;
  actionType: string;
  predictedValue: number;
  actualValue: number;
  absoluteError: number;
  recordedAt: number; // timestamp in ms
}

/**
 * Cached MAE result for a prediction type.
 */
interface MAECache {
  mae: number;
  sampleCount: number;
  classification: 'ACCURATE' | 'MODERATE' | 'POOR' | 'INSUFFICIENT_DATA';
  computedAt: number;
}

/**
 * PredictionEvaluator: Tracks prediction accuracy and computes MAE per type.
 */
export class PredictionEvaluator {
  // Storage: prediction ID -> record
  private predictions: Map<string, PredictionRecord> = new Map();

  // Storage: action type -> rolling window of most recent predictions
  private predictionsByType: Map<string, PredictionRecord[]> = new Map();

  // Cache: action type -> MAE cache
  private maeCache: Map<string, MAECache> = new Map();

  constructor() {}

  /**
   * Record a prediction outcome.
   *
   * Called by the Drive Engine when an ACTION_OUTCOME arrives with a
   * predictionId. This stores the outcome and may trigger MAE recomputation
   * if the window is full.
   *
   * @param predictionId - UUID of the prediction being evaluated
   * @param actionType - The action category (e.g., "ask_question")
   * @param predictedValue - The predicted outcome value [0.0, 1.0]
   * @param actualValue - The observed outcome value [0.0, 1.0]
   */
  public recordPrediction(
    predictionId: string,
    actionType: string,
    predictedValue: number,
    actualValue: number,
  ): void {
    // Compute absolute error
    const absoluteError = Math.abs(predictedValue - actualValue);

    // Create record
    const record: PredictionRecord = {
      predictionId,
      actionType,
      predictedValue,
      actualValue,
      absoluteError,
      recordedAt: Date.now(),
    };

    vlog('prediction recorded', {
      predictionId,
      actionType,
      predicted: +predictedValue.toFixed(4),
      actual: +actualValue.toFixed(4),
      absoluteError: +absoluteError.toFixed(4),
    });

    // Store globally
    this.predictions.set(predictionId, record);

    // Get or create rolling window for this type
    if (!this.predictionsByType.has(actionType)) {
      this.predictionsByType.set(actionType, []);
    }

    const window = this.predictionsByType.get(actionType)!;
    window.push(record);

    // Keep window size at MAE_WINDOW_SIZE by dropping oldest
    if (window.length > MAE_WINDOW_SIZE) {
      window.shift();
    }

    // Invalidate cache when window fills or refreshes
    if (window.length >= MAE_WINDOW_SIZE) {
      this.invalidateCache(actionType);
    }
  }

  /**
   * Get the MAE for a prediction type.
   *
   * Computes MAE over the rolling window of last 10 predictions (or fewer if
   * not enough data). Returns cached value if valid and within TTL.
   *
   * @param actionType - The action category to compute MAE for
   * @returns MAE result with classification and sample count
   */
  public getMAE(actionType: string): {
    mae: number;
    classification: 'ACCURATE' | 'MODERATE' | 'POOR' | 'INSUFFICIENT_DATA';
    sampleCount: number;
  } {
    const now = Date.now();

    // Check cache validity
    const cached = this.maeCache.get(actionType);
    if (cached && now - cached.computedAt < CACHE_TTL_MS) {
      return {
        mae: cached.mae,
        classification: cached.classification,
        sampleCount: cached.sampleCount,
      };
    }

    // Get or create window for this type
    const window = this.predictionsByType.get(actionType) || [];
    const sampleCount = window.length;

    // Insufficient data
    if (sampleCount < MIN_SAMPLE_COUNT) {
      const result = {
        mae: 0,
        classification: 'INSUFFICIENT_DATA' as const,
        sampleCount: 0,
      };

      this.maeCache.set(actionType, {
        mae: 0,
        sampleCount: 0,
        classification: 'INSUFFICIENT_DATA',
        computedAt: now,
      });

      return result;
    }

    // Compute MAE
    const sumError = window.reduce((sum, pred) => sum + pred.absoluteError, 0);
    const mae = sumError / sampleCount;

    // Classify
    let classification: 'ACCURATE' | 'MODERATE' | 'POOR' | 'INSUFFICIENT_DATA';
    if (mae < MAE_ACCURATE_THRESHOLD) {
      classification = 'ACCURATE';
    } else if (mae < MAE_MODERATE_THRESHOLD) {
      classification = 'MODERATE';
    } else {
      classification = 'POOR';
    }

    vlog('MAE computed', {
      actionType,
      mae: +mae.toFixed(4),
      classification,
      sampleCount,
    });

    // Cache result
    this.maeCache.set(actionType, {
      mae,
      sampleCount,
      classification,
      computedAt: now,
    });

    return {
      mae,
      classification,
      sampleCount,
    };
  }

  /**
   * Get all action types with candidates for Type 1 graduation.
   *
   * Returns action types where MAE is low enough for graduation consideration.
   * The caller (Decision Making) will check confidence separately.
   *
   * @returns Array of graduation candidates with MAE and sample count
   */
  public getGraduationCandidates(): Array<{
    actionType: string;
    confidence: number; // This will be populated by Decision Making, not us
    mae: number;
    sampleCount: number;
  }> {
    const candidates = [];

    for (const actionType of this.predictionsByType.keys()) {
      const maeResult = this.getMAE(actionType);

      // Only include if MAE is low enough
      if (maeResult.mae < GRADUATION_MAE_THRESHOLD && maeResult.sampleCount >= MIN_SAMPLE_COUNT) {
        candidates.push({
          actionType,
          confidence: 0, // To be filled in by caller
          mae: maeResult.mae,
          sampleCount: maeResult.sampleCount,
        });
      }
    }

    return candidates;
  }

  /**
   * Get opportunity severity for a prediction type.
   *
   * When MAE > POOR_THRESHOLD (0.20), returns the severity for opportunity
   * signal generation. Returns null if MAE is good.
   *
   * @param actionType - The action category
   * @returns Severity ('low'|'medium'|'high') or null if MAE < POOR_THRESHOLD
   */
  public getOpportunitySeverity(
    actionType: string,
  ): 'low' | 'medium' | 'high' | null {
    const maeResult = this.getMAE(actionType);

    // Good accuracy, no opportunity
    if (maeResult.mae < MAE_MODERATE_THRESHOLD) {
      return null;
    }

    // Classify severity by MAE magnitude
    let severity: 'low' | 'medium' | 'high';
    if (maeResult.mae < OPPORTUNITY_SEVERITY_LOW_THRESHOLD) {
      severity = 'low';
    } else if (maeResult.mae < OPPORTUNITY_SEVERITY_MEDIUM_THRESHOLD) {
      severity = 'medium';
    } else {
      severity = 'high';
    }

    vlog('opportunity severity assessed', {
      actionType,
      mae: +maeResult.mae.toFixed(4),
      severity,
    });

    return severity;
  }

  /**
   * Clear all recorded predictions and cached results.
   * Used for testing and session resets.
   */
  public clear(): void {
    this.predictions.clear();
    this.predictionsByType.clear();
    this.maeCache.clear();
  }

  /**
   * Invalidate cache for a specific action type.
   * Called when new predictions arrive for the type.
   */
  private invalidateCache(actionType: string): void {
    this.maeCache.delete(actionType);
  }

  /**
   * Get debugging info about all tracked types.
   */
  public getDebugInfo(): {
    totalPredictions: number;
    typesCounted: number;
    typeDetails: Array<{
      actionType: string;
      windowSize: number;
      mae: number;
      classification: string;
    }>;
  } {
    const typeDetails = [];

    for (const [actionType, window] of this.predictionsByType.entries()) {
      const maeResult = this.getMAE(actionType);
      typeDetails.push({
        actionType,
        windowSize: window.length,
        mae: maeResult.mae,
        classification: maeResult.classification,
      });
    }

    return {
      totalPredictions: this.predictions.size,
      typesCounted: this.predictionsByType.size,
      typeDetails,
    };
  }
}

/**
 * Global singleton instance for the Drive Engine process.
 */
let evaluator: PredictionEvaluator | null = null;

/**
 * Get or create the global evaluator instance.
 */
export function getOrCreatePredictionEvaluator(): PredictionEvaluator {
  if (!evaluator) {
    evaluator = new PredictionEvaluator();
  }
  return evaluator;
}

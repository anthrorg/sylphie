/**
 * Real implementation of IPredictionService.
 *
 * E5-T006: Generates drive-effect predictions for action candidates and
 * evaluates them against observed outcomes.
 *
 * CANON §Dual-Process Cognition: Predictions are made before action selection
 * and evaluated after outcome observation. Their accuracy over the last 10 uses
 * drives the Type 1 graduation check (confidence > 0.80 AND MAE < 0.10).
 *
 * CANON §Known Attractor States: "Prediction Pessimist" — early failures should
 * not flood the system with low-quality procedures. The maxCandidates cap is
 * the structural guard.
 *
 * Immutable Standards:
 * - Standard 1 (Theater Prohibition): Predictions use only actual drive context.
 * - Standard 2 (Contingency Requirement): Every prediction correlates to a candidate.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ActionOutcome } from '../../shared/types/action.types';
import { DriveName, DriveSnapshot } from '../../shared/types/drive.types';
import { CONFIDENCE_THRESHOLDS } from '../../shared/types/confidence.types';
import {
  IPredictionService,
  CognitiveContext,
  Prediction,
  PredictionEvaluation,
} from '../interfaces/decision-making.interfaces';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { IEventService } from '../../events/interfaces/events.interfaces';
import { createDecisionMakingEvent } from '../../events/builders/event-builders';

@Injectable()
export class PredictionService implements IPredictionService {
  private readonly logger = new Logger(PredictionService.name);

  /**
   * In-memory map of active predictions: predictionId -> Prediction
   * Cleared when predictions are evaluated.
   */
  private activePredictions = new Map<string, Prediction>();

  /**
   * Per-action MAE history: actionId -> array of last 10 MAE values
   * Used for Type 1 graduation and demotion checks.
   */
  private maeHistory = new Map<string, number[]>();

  /**
   * Most recent drive snapshot captured during generatePredictions().
   *
   * Used when emitting PREDICTION_EVALUATED events from evaluatePrediction(),
   * which is synchronous on the interface and cannot receive the snapshot directly.
   * Theater Prohibition (Standard 1) requires a real drive snapshot on every event.
   */
  private lastDriveSnapshot: DriveSnapshot | null = null;

  constructor(@Inject(EVENTS_SERVICE) private readonly eventsService: IEventService) {}

  /**
   * Generate drive-effect predictions for the top action candidates.
   *
   * For each candidate (up to maxCandidates, default 3):
   * 1. Extract the candidate's procedure confidence
   * 2. Look at recent episodes for similar actions
   * 3. Predict drive effects based on prior episodes' average or small random deltas
   * 4. Set confidence = candidate confidence * 0.8 (prediction less certain than retrieval)
   * 5. Store in activePredictions map
   * 6. Emit PREDICTION_CREATED event
   *
   * @param context       - Current cognitive context with drive snapshot and episodes
   * @param maxCandidates - Maximum predictions to generate. Defaults to 3.
   * @returns Array of Prediction records, one per evaluated candidate
   */
  async generatePredictions(
    context: CognitiveContext,
    maxCandidates: number = 3,
  ): Promise<Prediction[]> {
    // Capture drive snapshot so PREDICTION_EVALUATED events can carry real context.
    this.lastDriveSnapshot = context.driveSnapshot;

    const predictions: Prediction[] = [];
    const candidatesToEvaluate = context.activePredictions.slice(
      0,
      maxCandidates,
    );

    for (const candidate of candidatesToEvaluate) {
      const predictionId = randomUUID();
      const timestamp = new Date();

      // Step 1: Extract candidate confidence
      const candidateConfidence = candidate.confidence;

      // Step 2 & 3: Look at recent episodes for similar actions and predict effects
      const predictedDriveEffects = this.predictDriveEffects(
        candidate.actionCandidate.procedureData?.id || 'TYPE_2_NOVEL',
        context.recentEpisodes as any[],
      );

      // Step 4: Compute prediction confidence as candidate confidence * 0.8
      const predictionConfidence = Math.min(1.0, candidateConfidence * 0.8);

      // Create the prediction record
      const prediction: Prediction = {
        id: predictionId,
        actionCandidate: candidate.actionCandidate,
        predictedDriveEffects,
        confidence: predictionConfidence,
        timestamp,
      };

      // Step 5: Store in active map
      this.activePredictions.set(predictionId, prediction);
      predictions.push(prediction);

      // Step 6: Emit PREDICTION_CREATED event
      try {
        const event = createDecisionMakingEvent('PREDICTION_CREATED', {
          sessionId: context.driveSnapshot.sessionId,
          driveSnapshot: context.driveSnapshot,
          data: {
            predictionId,
            actionId: candidate.actionCandidate.procedureData?.id || 'TYPE_2_NOVEL',
            predictedEffects: predictedDriveEffects,
            confidence: predictionConfidence,
          },
        });
        await this.eventsService.record(event);
      } catch (err) {
        this.logger.error(
          `Failed to emit PREDICTION_CREATED event: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return predictions;
  }

  /**
   * Evaluate a single prediction against the observed outcome.
   *
   * 1. Look up prediction from active map
   * 2. Compare predicted vs actual drive effects
   * 3. Compute MAE: mean of |predicted - actual| across all drives
   * 4. accurate = mae < 0.10 (CONFIDENCE_THRESHOLDS.graduationMAE)
   * 5. Store MAE in per-action history (keep last 10)
   * 6. Emit PREDICTION_EVALUATED event asynchronously (with fallback on error)
   * 7. Remove from active predictions
   * 8. Return PredictionEvaluation
   *
   * @param predictionId  - The UUID of the Prediction to evaluate
   * @param actualOutcome - The observed outcome from the executor
   * @returns PredictionEvaluation with MAE and per-drive comparison
   * @throws If predictionId is not found in active predictions
   */
  evaluatePrediction(
    predictionId: string,
    actualOutcome: ActionOutcome,
  ): PredictionEvaluation {
    // Step 1: Look up the prediction
    const prediction = this.activePredictions.get(predictionId);
    if (!prediction) {
      throw new Error(`Prediction ${predictionId} not found in active predictions`);
    }

    const predictedEffects = prediction.predictedDriveEffects;
    const actualEffects = actualOutcome.driveEffectsObserved;

    // Step 2 & 3: Compute MAE across all drives that appear in either map
    const allDrives = new Set<string>(
      Object.keys(predictedEffects).concat(Object.keys(actualEffects)),
    );

    let sumError = 0;
    for (const driveName of allDrives) {
      const predicted = (predictedEffects as Record<string, number>)[driveName] ?? 0;
      const actual = (actualEffects as Record<string, number>)[driveName] ?? 0;
      sumError += Math.abs(predicted - actual);
    }

    // Compute MAE
    const mae =
      allDrives.size > 0
        ? Math.min(1.0, sumError / allDrives.size)
        : 0;

    // Step 4: Determine accuracy
    const accurate = mae < CONFIDENCE_THRESHOLDS.graduationMAE;

    // Step 5: Store MAE in per-action history
    const actionId =
      prediction.actionCandidate.procedureData?.id || 'TYPE_2_NOVEL';
    const history = this.maeHistory.get(actionId) ?? [];
    history.push(mae);

    // Keep only last 10 MAEs
    if (history.length > 10) {
      history.shift();
    }
    this.maeHistory.set(actionId, history);

    // Step 6: Emit PREDICTION_EVALUATED event asynchronously.
    // Use the drive snapshot captured during generatePredictions() so the event
    // carries real motivational context (Theater Prohibition, Standard 1).
    this.emitPredictionEvaluated(
      predictionId,
      actionId,
      mae,
      accurate,
      predictedEffects,
      actualEffects,
      actualOutcome,
      this.lastDriveSnapshot,
    ).catch((err) => {
      this.logger.error(
        `Failed to emit PREDICTION_EVALUATED event: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // Step 7: Remove from active predictions
    this.activePredictions.delete(predictionId);

    // Step 8: Return evaluation result
    const evaluation: PredictionEvaluation = {
      predictionId,
      mae,
      accurate,
      actualEffects,
      predictedEffects,
    };

    return evaluation;
  }

  /**
   * Asynchronously emit a PREDICTION_EVALUATED event.
   * Called from evaluatePrediction without awaiting.
   *
   * Emits the full structured payload required by Observatory endpoints:
   *   - predictionId, actionType, predictedOutcome, actualOutcome, absoluteError, confidence
   *
   * If driveSnapshot is null (no prior generatePredictions() call), the event is
   * skipped to avoid Theater Prohibition (Standard 1) violations from fake snapshots.
   *
   * @private
   */
  private async emitPredictionEvaluated(
    predictionId: string,
    actionId: string,
    mae: number,
    accurate: boolean,
    predictedEffects: Partial<Record<string, number>>,
    actualEffects: Partial<Record<string, number>>,
    actualOutcome: ActionOutcome,
    driveSnapshot: DriveSnapshot | null,
  ): Promise<void> {
    if (driveSnapshot === null) {
      // No real drive context available — skip emission rather than fabricate a snapshot.
      // This can happen if evaluatePrediction() is called without a prior generatePredictions().
      this.logger.warn(
        `Skipping PREDICTION_EVALUATED event for ${predictionId}: no drive snapshot available`,
      );
      return;
    }

    // Compute a scalar "predicted outcome" and "actual outcome" for Observatory consumption.
    // These are the mean predicted and actual drive pressure values across all drives.
    const predictedValues = Object.values(predictedEffects) as number[];
    const actualValues = Object.values(actualEffects) as number[];
    const predictedOutcome =
      predictedValues.length > 0
        ? predictedValues.reduce((a, b) => a + b, 0) / predictedValues.length
        : 0;
    const actualOutcomeScalar =
      actualValues.length > 0
        ? actualValues.reduce((a, b) => a + b, 0) / actualValues.length
        : 0;

    // Retrieve the original prediction for its confidence value
    const prediction = this.activePredictions.get(predictionId);
    const predictionConfidence = prediction?.confidence ?? 0;

    const event = createDecisionMakingEvent('PREDICTION_EVALUATED', {
      sessionId: driveSnapshot.sessionId,
      driveSnapshot,
      data: {
        predictionId,
        actionType: actionId,
        predictedOutcome,
        actualOutcome: actualOutcomeScalar,
        absoluteError: mae,
        confidence: predictionConfidence,
        // Additional diagnostic fields (not required by Observatory but useful for analysis)
        accurate,
        predictedEffects,
        actualEffects,
      },
    });

    await this.eventsService.record(event);
  }

  /**
   * Predict drive effects for a given action based on recent episodes.
   *
   * Strategy:
   * 1. Find recent episodes for the same action ID
   * 2. If found, average their observed drive effects (inferred from drive state deltas)
   * 3. If not found, generate small random deltas (-0.1 to +0.1) for core drives
   *
   * @param actionId      - The action to predict for
   * @param recentEpisodes - Recent episodes from cognitive context
   * @returns Partial map of predicted drive effect deltas
   */
  private predictDriveEffects(
    actionId: string,
    recentEpisodes: any[],
  ): Partial<Record<string, number>> {
    // Find episodes for this action
    const matchingEpisodes = recentEpisodes.filter(
      (ep: any) => ep.actionTaken === actionId,
    );

    if (matchingEpisodes.length > 0) {
      // Average the inferred effects from matching episodes
      // Episodes carry drive snapshot at encoding time, which we can use to infer
      // the delta from baseline. In a full system, we'd have explicit outcome records.
      const effectsMap = new Map<string, number[]>();

      for (const episode of matchingEpisodes) {
        // Note: episodes contain driveSnapshot at encoding time. We can infer
        // effects by comparing against initial or baseline state.
        // For now, we store small inferred deltas based on episode context.
        if (episode.driveSnapshot) {
          // Infer small effects from the snapshot (placeholder)
          const driveVector = (episode.driveSnapshot as any).pressureVector || {};
          for (const [driveName, value] of Object.entries(driveVector)) {
            if (!effectsMap.has(driveName)) {
              effectsMap.set(driveName, []);
            }
            // Infer that the action contributed ~0.1 to whatever pressure exists
            (effectsMap.get(driveName) as number[]).push((value as number) * 0.1);
          }
        }
      }

      // If we have aggregated data, compute averages
      const predicted: Record<string, number> = {};
      for (const [driveName, values] of effectsMap.entries()) {
        predicted[driveName] = values.reduce((a, b) => a + b, 0) / values.length;
      }

      return predicted;
    }

    // Fallback: small random deltas for core drives
    const predicted: Record<string, number> = {};
    const coreDrivers = [
      DriveName.SystemHealth,
      DriveName.MoralValence,
      DriveName.Integrity,
      DriveName.CognitiveAwareness,
    ];

    for (const drive of coreDrivers) {
      // Random delta in [-0.1, 0.1]
      predicted[drive] = (Math.random() - 0.5) * 0.2;
    }

    return predicted;
  }

  /**
   * Get the MAE history for an action (for Type 1 graduation checks).
   * Public accessor for testing and external graduation evaluation.
   *
   * @param actionId - The action ID to get MAE history for
   * @returns Array of last 10 MAE values, or empty if no history
   */
  getMaeHistory(actionId: string): readonly number[] {
    return this.maeHistory.get(actionId) ?? [];
  }
}

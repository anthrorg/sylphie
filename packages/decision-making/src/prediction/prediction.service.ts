/**
 * PredictionService — Drive-effect prediction and evaluation.
 *
 * CANON §Dual-Process Cognition: Predictions are generated BEFORE action
 * selection (PREDICTING executor state) and evaluated AFTER outcome observation
 * (OBSERVING state). The MAE over the last 10 uses drives Type 1 graduation
 * (confidence > 0.80 AND MAE < 0.10) and demotion (MAE > 0.15).
 *
 * Generation: for each of the top maxCandidates (default 3) candidates embedded
 * in CognitiveContext.activePredictions, a new Prediction is created with
 * confidence = candidate.confidence * 0.8. Drive effects are estimated by
 * averaging effects from recent historical episodes (matched by actionTaken),
 * or by random deltas in [-0.1, 0.1] for core drives when no history exists.
 *
 * Evaluation: MAE = mean(|predicted - actual|) across the union of drive keys
 * present in either the prediction or the actual outcome. accurate = mae < 0.10.
 *
 * Per-action MAE history: the last 10 MAE values per actionId are maintained
 * in memory. getMaeHistory() provides read access for the Type 1 tracker.
 *
 * DriveSnapshot at evaluation time: stored alongside each prediction at
 * creation time. This avoids fabricating a zero-snapshot and decouples the
 * evaluation path from the executor's cycle snapshot.
 *
 * Adapted from sylphie-old:
 * - Prediction type imported from @sylphie/shared (not locally defined).
 * - CognitiveContext.activePredictions contains Prediction objects whose
 *   actionCandidate fields are the candidates to generate fresh predictions for.
 * - Event logging via DECISION_EVENT_LOGGER.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  DRIVE_INDEX_ORDER,
  CORE_DRIVES,
  type CognitiveContext,
  type Prediction,
  type PredictionEvaluation,
  type ActionCandidate,
  type ActionOutcome,
  type DriveSnapshot,
  verboseFor,
} from '@sylphie/shared';

const vlog = verboseFor('Cortex');
import type {
  IPredictionService,
  IDecisionEventLogger,
} from '../interfaces/decision-making.interfaces';
import { DECISION_EVENT_LOGGER } from '../decision-making.tokens';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of MAE values to retain per action in the rolling window. */
const MAE_HISTORY_MAX = 10;

/** Prediction confidence discount relative to candidate confidence. */
const PREDICTION_CONFIDENCE_DISCOUNT = 0.8;

/** MAE threshold below which a prediction is considered accurate. */
const ACCURATE_MAE_THRESHOLD = 0.10;

/** Bound for random drive-effect deltas when no historical data is available. */
const RANDOM_DELTA_BOUND = 0.1;

// ---------------------------------------------------------------------------
// Internal record type to store a prediction alongside its generation context
// ---------------------------------------------------------------------------

/** A Prediction plus the drive snapshot captured at generation time. */
interface StoredPrediction {
  readonly prediction: Prediction;
  readonly driveSnapshot: DriveSnapshot;
}

// ---------------------------------------------------------------------------
// PredictionService
// ---------------------------------------------------------------------------

@Injectable()
export class PredictionService implements IPredictionService {
  private readonly logger = new Logger(PredictionService.name);

  /**
   * Active predictions indexed by prediction UUID, stored with their
   * generation-time drive snapshot so evaluation can log correctly without
   * requiring the caller to pass the snapshot again.
   */
  private readonly activePredictions = new Map<string, StoredPrediction>();

  /**
   * Per-action rolling MAE history. Key = WKG procedure node ID (actionId).
   * Value = last MAE_HISTORY_MAX MAE values in insertion order.
   */
  private readonly maeHistory = new Map<string, number[]>();

  constructor(
    @Optional()
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,
  ) {}

  // ---------------------------------------------------------------------------
  // IPredictionService — generatePredictions
  // ---------------------------------------------------------------------------

  /**
   * Generate drive-effect predictions for the top action candidates.
   *
   * For each of the top maxCandidates candidates, a new Prediction is created with:
   *   - confidence = candidate.confidence * PREDICTION_CONFIDENCE_DISCOUNT
   *   - predictedDriveEffects = average of historical episode drive pressures
   *     for that action, or random core-drive deltas if no history matches.
   *
   * Each generated prediction is stored in activePredictions (alongside the
   * generation-time DriveSnapshot) and a PREDICTION_CREATED event is emitted.
   *
   * @param inputCandidates - Action candidates to generate predictions for.
   * @param context         - Current cognitive context with drive snapshot and episodes.
   * @param maxCandidates   - Maximum predictions to generate. Defaults to 3.
   * @returns Array of generated Prediction records.
   */
  async generatePredictions(
    inputCandidates: readonly ActionCandidate[],
    context: CognitiveContext,
    maxCandidates = 3,
  ): Promise<Prediction[]> {
    const candidates = inputCandidates.slice(0, maxCandidates);

    if (candidates.length === 0) {
      this.logger.debug('generatePredictions: no candidates provided, skipping');
      return [];
    }

    const generated: Prediction[] = [];

    for (const candidate of candidates) {
      const driveEffects = predictDriveEffects(candidate, context);
      const confidence = candidate.confidence * PREDICTION_CONFIDENCE_DISCOUNT;

      const prediction: Prediction = {
        id: randomUUID(),
        actionCandidate: candidate,
        predictedDriveEffects: driveEffects,
        confidence,
        timestamp: new Date(),
      };

      this.activePredictions.set(prediction.id, {
        prediction,
        driveSnapshot: context.driveSnapshot,
      });
      generated.push(prediction);

      vlog('prediction generated', {
        predictionId: prediction.id.substring(0, 8),
        actionId: candidate.procedureData?.id ?? 'novel',
        actionName: candidate.procedureData?.name ?? 'novel',
        confidence: +confidence.toFixed(3),
        driveEffectKeys: Object.keys(driveEffects),
      });

      this.emitPredictionCreated(prediction, context.driveSnapshot);
    }

    this.logger.debug(`Generated ${generated.length} prediction(s)`);
    return generated;
  }

  // ---------------------------------------------------------------------------
  // IPredictionService — evaluatePrediction
  // ---------------------------------------------------------------------------

  /**
   * Evaluate a single prediction against the observed outcome.
   *
   * MAE computation: the union of drive keys from predictedDriveEffects and
   * actualDriveEffects is used. Missing values are treated as 0 (no change
   * predicted/observed for that drive).
   *
   * accurate = mae < ACCURATE_MAE_THRESHOLD (0.10)
   *
   * The MAE is appended to the per-action rolling history (last 10 values).
   * The action ID is taken from the candidate's procedureData, falling back
   * to a synthetic key (`novel-<predictionId>`) for novel Type 2 responses.
   *
   * A PREDICTION_EVALUATED event is emitted using the DriveSnapshot stored at
   * generation time — no external snapshot parameter needed.
   *
   * The prediction is removed from activePredictions after evaluation.
   *
   * @param predictionId  - UUID of the Prediction to evaluate.
   * @param actualOutcome - Observed outcome from the executor.
   * @returns PredictionEvaluation with MAE and per-drive comparison.
   * @throws Error if predictionId is not found in activePredictions.
   */
  evaluatePrediction(predictionId: string, actualOutcome: ActionOutcome): PredictionEvaluation {
    const stored = this.activePredictions.get(predictionId);
    if (!stored) {
      throw new Error(
        `PredictionService.evaluatePrediction: prediction ${predictionId} not found in active store`,
      );
    }

    const { prediction, driveSnapshot } = stored;
    const predicted = prediction.predictedDriveEffects;
    const actual: Partial<Record<string, number>> = actualOutcome.driveEffectsObserved as Partial<
      Record<string, number>
    >;

    // Union of all drive keys.
    const allKeys = new Set<string>([...Object.keys(predicted), ...Object.keys(actual)]);

    let totalError = 0;
    let keyCount = 0;

    for (const key of allKeys) {
      const predictedVal = predicted[key] ?? 0;
      const actualVal = actual[key] ?? 0;
      totalError += Math.abs(predictedVal - actualVal);
      keyCount++;
    }

    const mae = keyCount > 0 ? totalError / keyCount : 0;
    const accurate = mae < ACCURATE_MAE_THRESHOLD;

    // Update per-action MAE history.
    const actionId =
      prediction.actionCandidate.procedureData?.id ?? `novel-${predictionId}`;
    this.appendMae(actionId, mae);

    const evaluation: PredictionEvaluation = {
      predictionId,
      mae,
      accurate,
      actualEffects: actual,
      predictedEffects: predicted,
    };

    this.emitPredictionEvaluated(evaluation, driveSnapshot);

    // Remove from active store once evaluated.
    this.activePredictions.delete(predictionId);

    vlog('prediction evaluated', {
      predictionId: predictionId.substring(0, 8),
      actionId,
      mae: +mae.toFixed(4),
      accurate,
      keyCount,
    });

    this.logger.debug(
      `Prediction ${predictionId} evaluated: MAE=${mae.toFixed(4)}, accurate=${accurate}`,
    );

    return evaluation;
  }

  // ---------------------------------------------------------------------------
  // Public accessor — getMaeHistory
  // ---------------------------------------------------------------------------

  /**
   * Return the rolling MAE history for a given action ID.
   *
   * Used by Type1TrackerService and ConfidenceUpdaterService to access
   * accuracy trends without coupling to the prediction store internals.
   *
   * @param actionId - WKG procedure node ID.
   * @returns Read-only array of the last MAE_HISTORY_MAX MAE values. Empty if none.
   */
  getMaeHistory(actionId: string): readonly number[] {
    return this.maeHistory.get(actionId) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Private — MAE history management
  // ---------------------------------------------------------------------------

  /**
   * Append a MAE value to the per-action rolling history.
   * Trims to the last MAE_HISTORY_MAX entries.
   */
  private appendMae(actionId: string, mae: number): void {
    const history = this.maeHistory.get(actionId) ?? [];
    history.push(mae);
    if (history.length > MAE_HISTORY_MAX) {
      history.splice(0, history.length - MAE_HISTORY_MAX);
    }
    this.maeHistory.set(actionId, history);
  }

  // ---------------------------------------------------------------------------
  // Private — event emission
  // ---------------------------------------------------------------------------

  /** Emit PREDICTION_CREATED for a newly generated prediction. */
  private emitPredictionCreated(prediction: Prediction, driveSnapshot: DriveSnapshot): void {
    if (!this.eventLogger) return;

    try {
      this.eventLogger.log(
        'PREDICTION_CREATED',
        {
          predictionId: prediction.id,
          actionId: prediction.actionCandidate.procedureData?.id ?? null,
          confidence: prediction.confidence,
          predictedDriveEffects: prediction.predictedDriveEffects,
        },
        driveSnapshot,
        driveSnapshot.sessionId,
      );
    } catch (err) {
      this.logger.warn(`Failed to emit PREDICTION_CREATED event: ${err}`);
    }
  }

  /** Emit PREDICTION_EVALUATED after a prediction is compared to observed outcome. */
  private emitPredictionEvaluated(
    evaluation: PredictionEvaluation,
    driveSnapshot: DriveSnapshot,
  ): void {
    if (!this.eventLogger) return;

    try {
      this.eventLogger.log(
        'PREDICTION_EVALUATED',
        {
          predictionId: evaluation.predictionId,
          mae: evaluation.mae,
          accurate: evaluation.accurate,
          predictedEffects: evaluation.predictedEffects,
          actualEffects: evaluation.actualEffects,
        },
        driveSnapshot,
        driveSnapshot.sessionId,
      );
    } catch (err) {
      this.logger.warn(`Failed to emit PREDICTION_EVALUATED event: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure utility functions (not injectable — no state)
// ---------------------------------------------------------------------------

/**
 * Estimate the drive effects for a candidate action.
 *
 * Strategy:
 *   1. Filter recent episodes where actionTaken matches the candidate's
 *      procedure ID or name. If found, average the pressureVector values
 *      across those episodes as a directional proxy.
 *   2. If no historical episodes match, generate small random deltas in
 *      [-RANDOM_DELTA_BOUND, RANDOM_DELTA_BOUND] for core drives only.
 *
 * Returns a partial record — only drives expected to change are included.
 */
function predictDriveEffects(
  candidate: ActionCandidate,
  context: CognitiveContext,
): Partial<Record<string, number>> {
  const procedureId = candidate.procedureData?.id;
  const procedureName = candidate.procedureData?.name;

  const matchingEpisodes = context.recentEpisodes.filter(
    (ep) =>
      (procedureId !== undefined && ep.actionTaken === procedureId) ||
      (procedureName !== undefined && ep.actionTaken === procedureName),
  );

  if (matchingEpisodes.length > 0) {
    const effects: Partial<Record<string, number>> = {};

    for (const drive of DRIVE_INDEX_ORDER) {
      let sum = 0;
      for (const ep of matchingEpisodes) {
        sum += ep.driveSnapshot.pressureVector[drive];
      }
      const avg = sum / matchingEpisodes.length;
      // Only include drives with a non-trivial average to keep the map sparse.
      if (Math.abs(avg) > 0.01) {
        effects[drive] = avg;
      }
    }

    return effects;
  }

  // No matching history — random core-drive deltas.
  const effects: Partial<Record<string, number>> = {};
  for (const drive of CORE_DRIVES) {
    effects[drive as string] = (Math.random() * 2 - 1) * RANDOM_DELTA_BOUND;
  }
  return effects;
}

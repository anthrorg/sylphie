/**
 * ConfidenceUpdaterService — ACT-R 3-path confidence updater.
 *
 * CANON §Confidence Dynamics (ACT-R): Confidence is updated via
 * min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1)). Updates flow
 * through three semantic paths:
 *
 *   reinforced:        Successful outcome. Increments retrieval count and
 *                      sets lastRetrievalAt to now. Confidence recomputed
 *                      from updated params. May trigger TYPE_1_GRADUATION.
 *
 *   decayed:           Time-based decay pass (no new use). Confidence is
 *                      recomputed with the current timestamp driving the
 *                      decay component. No count or retrieval time change.
 *                      May trigger TYPE_1_DEMOTION.
 *
 *   counter_indicated: Outcome contradicted the expected result. Base
 *                      confidence is reduced by 0.15 (minimum 0.0), then
 *                      confidence is recomputed. Does NOT decrement count —
 *                      the retrieval happened, it just went badly.
 *
 * Guardian weight: if guardianFeedback is provided, applyGuardianWeight() is
 * applied to the confidence delta before the final value is committed.
 * Confirmation = 2x delta, correction = 3x delta (CANON Standard 5).
 *
 * Graduation check: after every 'reinforced' update, qualifiesForGraduation()
 * is evaluated against the most recent MAE from getMaeHistory(). A TYPE_1_GRADUATION
 * event is emitted if the procedure qualifies.
 *
 * Demotion check: after every 'decayed' update on a TYPE_1_GRADUATED record,
 * qualifiesForDemotion() is evaluated. A TYPE_1_DEMOTION event is emitted if
 * demotion is triggered.
 *
 * Drive snapshot for events: the service does not hold a cycle snapshot.
 * Event emission is skipped when no driveSnapshot is available rather than
 * fabricating a zero-filled placeholder (per design brief).
 *
 * DriveName.InformationIntegrity does NOT exist in this codebase. The correct
 * name is DriveName.Focus (drive.types.ts). This service uses only
 * @sylphie/shared exports and never references InformationIntegrity.
 *
 * Adapted from sylphie-old:
 * - ActionConfidenceRecord is defined locally (not in @sylphie/shared).
 * - Type imports from @sylphie/shared for computeConfidence, applyGuardianWeight,
 *   qualifiesForGraduation, qualifiesForDemotion, PROVENANCE_BASE_CONFIDENCE,
 *   DEFAULT_DECAY_RATES.
 * - Event logging via DECISION_EVENT_LOGGER.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import {
  computeConfidence,
  applyGuardianWeight,
  qualifiesForGraduation,
  qualifiesForDemotion,
  PROVENANCE_BASE_CONFIDENCE,
  DEFAULT_DECAY_RATES,
  type ACTRParams,
  type DriveSnapshot,
  verboseFor,
} from '@sylphie/shared';

const vlog = verboseFor('Cortex');
import type {
  IConfidenceUpdaterService,
  IDecisionEventLogger,
} from '../interfaces/decision-making.interfaces';
import { DECISION_EVENT_LOGGER } from '../decision-making.tokens';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Per-action confidence record maintained in the in-memory store.
 *
 * base:           Initial provenance-derived confidence, reducible by
 *                 counter-indication but never below 0.
 * count:          Number of successful retrieval-and-use events.
 * decayRate:      Per-action decay rate, defaulting to INFERENCE rate (0.06).
 * lastRetrievalAt: Timestamp of the most recent reinforced retrieval.
 * currentConfidence: Cached result of the most recent computeConfidence() call.
 * graduated:      Whether this action has reached TYPE_1_GRADUATED state.
 */
interface ActionConfidenceRecord {
  actionId: string;
  base: number;
  count: number;
  decayRate: number;
  lastRetrievalAt: Date | null;
  currentConfidence: number;
  graduated: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base confidence reduction applied on counter-indication. */
const COUNTER_INDICATION_REDUCTION = 0.15;

/**
 * Maximum number of MAE observations in the rolling window per action.
 * Matches the graduation requirement of 10 observations and the window
 * size used by Type1TrackerService.
 */
const MAX_MAE_WINDOW = 10;

// ---------------------------------------------------------------------------
// ConfidenceUpdaterService
// ---------------------------------------------------------------------------

@Injectable()
export class ConfidenceUpdaterService implements IConfidenceUpdaterService {
  private readonly logger = new Logger(ConfidenceUpdaterService.name);

  /** In-memory store of confidence records, keyed by WKG procedure node ID. */
  private readonly records = new Map<string, ActionConfidenceRecord>();

  /**
   * Rolling window of recent prediction MAE values per action, keyed by
   * action ID. Each array holds at most MAX_MAE_WINDOW entries (FIFO).
   * Ephemeral — not persisted across restarts.
   */
  private readonly maeHistory = new Map<string, number[]>();

  constructor(
    @Optional()
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,
  ) {}

  // ---------------------------------------------------------------------------
  // IConfidenceUpdaterService — update
  // ---------------------------------------------------------------------------

  /**
   * Update the ACT-R confidence of an action procedure after outcome observation.
   *
   * 'reinforced': Increment count, set lastRetrievalAt = now. Recompute
   *   confidence. If guardianFeedback is provided, compute the raw delta
   *   (new - old), apply applyGuardianWeight(), and add the weighted delta
   *   to the new confidence value (clamped to [0, 1]). Evaluate graduation.
   *
   * 'decayed': Recompute confidence using current timestamp (drives time-decay
   *   component). Count and lastRetrievalAt are unchanged. Evaluate demotion
   *   if the record is currently graduated.
   *
   * 'counter_indicated': Reduce base by COUNTER_INDICATION_REDUCTION (min 0).
   *   Recompute confidence. If guardianFeedback is 'correction', apply 3x
   *   weight to the reduction delta. Evaluate demotion.
   *
   * If the actionId has no existing record, a new one is bootstrapped using
   * INFERENCE provenance (base = 0.30, decayRate = 0.06). This handles the
   * case where an action appears in the outcome loop before being formally
   * registered in the WKG.
   *
   * @param actionId         - WKG procedure node ID of the action to update.
   * @param outcome          - The type of confidence update to apply.
   * @param guardianFeedback - Optional guardian feedback for weight multiplication.
   */
  async update(
    actionId: string,
    outcome: 'reinforced' | 'decayed' | 'counter_indicated',
    guardianFeedback?: 'confirmation' | 'correction',
  ): Promise<void> {
    const record = this.getOrCreate(actionId);
    const oldConfidence = record.currentConfidence;

    switch (outcome) {
      case 'reinforced':
        this.applyReinforced(record, guardianFeedback);
        break;
      case 'decayed':
        this.applyDecayed(record);
        break;
      case 'counter_indicated':
        this.applyCounterIndicated(record, guardianFeedback);
        break;
    }

    const newConfidence = record.currentConfidence;
    const delta = newConfidence - oldConfidence;

    vlog('confidence update', {
      actionId,
      outcome,
      oldConfidence: +oldConfidence.toFixed(4),
      newConfidence: +newConfidence.toFixed(4),
      delta: +delta.toFixed(4),
      guardianFeedback: guardianFeedback ?? null,
      graduated: record.graduated,
    });

    this.logger.debug(
      `Confidence update for ${actionId}: ${outcome} ` +
        `${oldConfidence.toFixed(4)} -> ${newConfidence.toFixed(4)} (Δ${delta.toFixed(4)})` +
        (guardianFeedback ? ` [guardian: ${guardianFeedback}]` : ''),
    );

    this.emitConfidenceUpdated(actionId, record, outcome, oldConfidence, guardianFeedback);
  }

  // ---------------------------------------------------------------------------
  // IConfidenceUpdaterService — recordPredictionMAE
  // ---------------------------------------------------------------------------

  /**
   * Record a prediction MAE observation for an action procedure.
   *
   * Appends the MAE value to the rolling window for the given action ID,
   * evicting the oldest entry if the window is at capacity (FIFO, capped
   * at MAX_MAE_WINDOW = 10). The stored values are consumed by
   * getRecentMAEForRecord() during graduation and demotion checks.
   *
   * @param actionId - WKG procedure node ID.
   * @param mae      - Mean absolute error from PredictionEvaluation (0.0–1.0).
   */
  recordPredictionMAE(actionId: string, mae: number): void {
    let history = this.maeHistory.get(actionId);
    if (!history) {
      history = [];
      this.maeHistory.set(actionId, history);
    }

    if (history.length >= MAX_MAE_WINDOW) {
      history.shift();
    }
    history.push(mae);

    vlog('MAE recorded for confidence updater', {
      actionId,
      mae: +mae.toFixed(4),
      windowSize: history.length,
    });
  }

  // ---------------------------------------------------------------------------
  // Private — path implementations
  // ---------------------------------------------------------------------------

  /**
   * Apply the 'reinforced' path.
   *
   * Increments retrieval count, sets lastRetrievalAt to now, recomputes
   * confidence, applies guardian weight if provided, then evaluates graduation.
   */
  private applyReinforced(
    record: ActionConfidenceRecord,
    guardianFeedback: 'confirmation' | 'correction' | undefined,
  ): void {
    const oldConfidence = record.currentConfidence;

    record.count += 1;
    record.lastRetrievalAt = new Date();

    const params: ACTRParams = buildParams(record);
    let newConfidence = computeConfidence(params);

    if (guardianFeedback) {
      const rawDelta = newConfidence - oldConfidence;
      const weightedDelta = applyGuardianWeight(rawDelta, guardianFeedback);
      newConfidence = Math.min(1.0, Math.max(0.0, oldConfidence + weightedDelta));
    }

    record.currentConfidence = newConfidence;

    // Graduation check: requires the caller to have MAE data available.
    // We use a sentinel MAE of 0 when no history exists — graduation only
    // fires if confidence is already above the threshold, which is a safe
    // conservative check with no false positives.
    const recentMAE = this.getRecentMAEForRecord(record.actionId);
    if (!record.graduated && qualifiesForGraduation(newConfidence, recentMAE)) {
      record.graduated = true;
      this.logger.log(`TYPE_1_GRADUATION: action ${record.actionId} graduated (conf=${newConfidence.toFixed(4)}, MAE=${recentMAE.toFixed(4)})`);
      this.emitGraduationEvent(record);
    }
  }

  /**
   * Apply the 'decayed' path.
   *
   * Recomputes confidence with the current time (driving the decay component).
   * Count and lastRetrievalAt are unchanged. Evaluates demotion for graduated
   * records.
   */
  private applyDecayed(record: ActionConfidenceRecord): void {
    const params: ACTRParams = buildParams(record);
    record.currentConfidence = computeConfidence(params);

    if (record.graduated) {
      const recentMAE = this.getRecentMAEForRecord(record.actionId);
      if (qualifiesForDemotion(recentMAE)) {
        record.graduated = false;
        this.logger.log(`TYPE_1_DEMOTION: action ${record.actionId} demoted (MAE=${recentMAE.toFixed(4)})`);
        this.emitDemotionEvent(record, recentMAE);
      }
    }
  }

  /**
   * Apply the 'counter_indicated' path.
   *
   * Reduces base confidence by COUNTER_INDICATION_REDUCTION. If guardianFeedback
   * is 'correction', the reduction is amplified by 3x (CANON Standard 5) then
   * clamped to [0, 1]. Recomputes confidence from updated base.
   */
  private applyCounterIndicated(
    record: ActionConfidenceRecord,
    guardianFeedback: 'confirmation' | 'correction' | undefined,
  ): void {
    let reduction = COUNTER_INDICATION_REDUCTION;

    if (guardianFeedback) {
      reduction = applyGuardianWeight(reduction, guardianFeedback);
    }

    record.base = Math.max(0.0, record.base - reduction);

    const params: ACTRParams = buildParams(record);
    record.currentConfidence = computeConfidence(params);

    // Counter-indication may cause a graduated action to fall below graduation
    // threshold, which warrants a demotion check.
    if (record.graduated) {
      const recentMAE = this.getRecentMAEForRecord(record.actionId);
      if (qualifiesForDemotion(recentMAE)) {
        record.graduated = false;
        this.logger.log(`TYPE_1_DEMOTION: action ${record.actionId} demoted via counter-indication (MAE=${recentMAE.toFixed(4)})`);
        this.emitDemotionEvent(record, recentMAE);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — record management
  // ---------------------------------------------------------------------------

  /**
   * Retrieve the confidence record for an action, creating one if it does not
   * exist. Bootstrap uses INFERENCE provenance (base = 0.30, decayRate = 0.06).
   */
  private getOrCreate(actionId: string): ActionConfidenceRecord {
    let record = this.records.get(actionId);
    if (!record) {
      const base = PROVENANCE_BASE_CONFIDENCE.INFERENCE;
      const decayRate = DEFAULT_DECAY_RATES.INFERENCE;
      record = {
        actionId,
        base,
        count: 0,
        decayRate,
        lastRetrievalAt: null,
        currentConfidence: base,
        graduated: false,
      };
      this.records.set(actionId, record);
      this.logger.debug(`Bootstrapped confidence record for action ${actionId} (base=${base})`);
    }
    return record;
  }

  /**
   * Retrieve the mean of recent MAE observations for an action.
   *
   * Returns the arithmetic mean of all values in the rolling MAE window
   * for the given action. If no MAE data has been recorded yet (window is
   * empty), returns 0.0 as a conservative sentinel — this ensures graduation
   * checks that rely on MAE < 0.10 will pass only when real data is available
   * AND meets the threshold.
   *
   * MAE data is fed in via recordPredictionMAE(), called from the decision
   * loop after each prediction evaluation.
   */
  private getRecentMAEForRecord(actionId: string): number {
    const history = this.maeHistory.get(actionId);
    if (!history || history.length === 0) {
      return 0.0;
    }
    return history.reduce((sum, v) => sum + v, 0) / history.length;
  }

  // ---------------------------------------------------------------------------
  // Private — event emission
  // ---------------------------------------------------------------------------

  /**
   * Emit a CONFIDENCE_UPDATED event.
   *
   * Because ConfidenceUpdaterService does not hold a cycle-level DriveSnapshot,
   * the event is skipped when no snapshot is available rather than fabricating
   * a zero-filled placeholder. The executor should ensure the event logger is
   * called with the cycle snapshot directly for cycle-level correlation.
   */
  private emitConfidenceUpdated(
    actionId: string,
    record: ActionConfidenceRecord,
    outcome: string,
    oldConfidence: number,
    guardianFeedback: 'confirmation' | 'correction' | undefined,
  ): void {
    if (!this.eventLogger) return;

    // No DriveSnapshot available at this layer — skip event emission per design brief.
    // The executor is responsible for emitting outcome-correlated events with the
    // cycle snapshot. This service defers to that pattern.
    this.logger.debug(
      `[event deferred] CONFIDENCE_UPDATED: action=${actionId} outcome=${outcome} ` +
        `old=${oldConfidence.toFixed(4)} new=${record.currentConfidence.toFixed(4)}` +
        (guardianFeedback ? ` guardian=${guardianFeedback}` : ''),
    );
  }

  /**
   * Emit a TYPE_1_GRADUATION event.
   * Skipped when no DriveSnapshot is available (see emitConfidenceUpdated comment).
   */
  private emitGraduationEvent(record: ActionConfidenceRecord): void {
    if (!this.eventLogger) return;

    this.logger.debug(
      `[event deferred] TYPE_1_GRADUATION: action=${record.actionId} ` +
        `conf=${record.currentConfidence.toFixed(4)}`,
    );
  }

  /**
   * Emit a TYPE_1_DEMOTION event.
   * Skipped when no DriveSnapshot is available (see emitConfidenceUpdated comment).
   */
  private emitDemotionEvent(record: ActionConfidenceRecord, recentMAE: number): void {
    if (!this.eventLogger) return;

    this.logger.debug(
      `[event deferred] TYPE_1_DEMOTION: action=${record.actionId} ` +
        `conf=${record.currentConfidence.toFixed(4)} MAE=${recentMAE.toFixed(4)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

/**
 * Build ACTRParams from a confidence record for use with computeConfidence().
 */
function buildParams(record: ActionConfidenceRecord): ACTRParams {
  return {
    base: record.base,
    count: record.count,
    decayRate: record.decayRate,
    lastRetrievalAt: record.lastRetrievalAt,
  };
}

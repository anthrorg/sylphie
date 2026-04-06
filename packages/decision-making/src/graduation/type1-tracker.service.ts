/**
 * Type1TrackerService — Graduation state machine for action procedures.
 *
 * CANON §Dual-Process Cognition: Actions do not begin as Type 1 reflexes —
 * they earn that status through demonstrated confidence and prediction
 * accuracy over their last 10 uses. This service manages the full lifecycle:
 *
 *   UNCLASSIFIED → TYPE_2_ONLY → TYPE_1_CANDIDATE → TYPE_1_GRADUATED
 *                                                        ↓ (demotion)
 *                                         TYPE_2_ONLY ← TYPE_1_DEMOTED
 *
 * Graduation conditions (CANON §Confidence Dynamics):
 *   - confidence > 0.80 (CONFIDENCE_THRESHOLDS.graduation)
 *   - rolling MAE < 0.10 over last 10 observations
 *
 * Demotion condition:
 *   - rolling MAE > 0.15 (CONFIDENCE_THRESHOLDS.demotionMAE)
 *
 * The MAE window is capped at 10 entries. Older observations are evicted
 * FIFO as new ones arrive.
 *
 * GraduationRecords are stored in-process in a Map keyed by procedureId.
 * The map grows without bound for this lifetime — AttractorMonitorService
 * is responsible for alerting if the procedure population grows pathologically.
 *
 * CANON Immutable Standard 6 (No Self-Modification): qualifiesForGraduation()
 * and qualifiesForDemotion() are pure functions imported from @sylphie/shared.
 * This service does not contain the evaluation logic — it applies it.
 *
 * Injection token: TYPE_1_TRACKER_SERVICE (decision-making.tokens.ts)
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import {
  qualifiesForGraduation,
  qualifiesForDemotion,
  type GraduationRecord,
  type GraduationState,
  type DriveSnapshot,
} from '@sylphie/shared';
import type { IType1TrackerService, IDecisionEventLogger } from '../interfaces/decision-making.interfaces';
import { DECISION_EVENT_LOGGER } from '../decision-making.tokens';

// ---------------------------------------------------------------------------
// Internal mutable record
// ---------------------------------------------------------------------------

/**
 * Internal mutable counterpart to the immutable GraduationRecord.
 *
 * The public interface returns GraduationRecord (immutable); internally we
 * work with this mutable structure and snapshot it on every read.
 */
interface MutableRecord {
  procedureId: string;
  state: GraduationState;
  /** Rolling MAE window, capped at MAX_MAE_WINDOW entries (FIFO). */
  maeHistory: number[];
  recentMAE: number;
  lastUpdatedAt: Date;
  graduatedAt: Date | null;
  demotedAt: Date | null;
}

/** Maximum number of MAE observations in the rolling window. */
const MAX_MAE_WINDOW = 10;

// ---------------------------------------------------------------------------
// Type1TrackerService
// ---------------------------------------------------------------------------

@Injectable()
export class Type1TrackerService implements IType1TrackerService {
  private readonly logger = new Logger(Type1TrackerService.name);

  /** In-process store of all graduation records, keyed by procedureId. */
  private readonly records = new Map<string, MutableRecord>();

  constructor(
    @Optional()
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,
  ) {}

  /**
   * Get the graduation record for a procedure, creating one if it does not exist.
   *
   * New records begin in UNCLASSIFIED state with zero MAE history. This ensures
   * every candidate can be checked without a precondition.
   *
   * @param procedureId - The WKG procedure node ID.
   * @returns Immutable snapshot of the current GraduationRecord.
   */
  getRecord(procedureId: string): GraduationRecord {
    return this.toImmutable(this.getOrCreate(procedureId));
  }

  /**
   * Record a new MAE observation and evaluate graduation/demotion transitions.
   *
   * Appends the MAE to the rolling window (evicting the oldest if over 10).
   * Recomputes the mean over the full window. Then applies state transitions:
   *   - From TYPE_2_ONLY or TYPE_1_CANDIDATE: if qualifiesForGraduation() → TYPE_1_GRADUATED
   *   - From TYPE_1_GRADUATED: if qualifiesForDemotion() → TYPE_1_DEMOTED
   *   - From TYPE_1_DEMOTED: transition to TYPE_2_ONLY (reset demotion)
   *
   * Emits TYPE_1_GRADUATION or TYPE_1_DEMOTION events through the logger when
   * a transition occurs.
   *
   * Note: This method does not need a DriveSnapshot for its core logic. The
   * snapshot is accepted for event-logging correlation only. Callers that have
   * no snapshot available may pass null — the event will be skipped.
   *
   * @param procedureId - The WKG procedure node ID.
   * @param mae         - The MAE from the latest PredictionEvaluation (0.0–1.0).
   * @param confidence  - The current ACT-R confidence of the procedure (0.0–1.0).
   */
  recordObservation(procedureId: string, mae: number, confidence: number): void {
    const record = this.getOrCreate(procedureId);

    // Append to rolling window, evict oldest if at capacity.
    if (record.maeHistory.length >= MAX_MAE_WINDOW) {
      record.maeHistory.shift();
    }
    record.maeHistory.push(mae);

    // Recompute mean over the full (now updated) window.
    record.recentMAE =
      record.maeHistory.reduce((sum, v) => sum + v, 0) / record.maeHistory.length;

    record.lastUpdatedAt = new Date();

    // Evaluate state transitions.
    this.evaluateTransitions(record, confidence);
  }

  /**
   * Check whether a procedure is currently in the TYPE_1_GRADUATED state.
   *
   * @param procedureId - The WKG procedure node ID.
   * @returns True if the procedure is TYPE_1_GRADUATED; false otherwise.
   */
  isGraduated(procedureId: string): boolean {
    const record = this.records.get(procedureId);
    return record?.state === 'TYPE_1_GRADUATED';
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Return the existing mutable record or create a fresh UNCLASSIFIED one.
   */
  private getOrCreate(procedureId: string): MutableRecord {
    const existing = this.records.get(procedureId);
    if (existing !== undefined) {
      return existing;
    }

    const fresh: MutableRecord = {
      procedureId,
      state: 'UNCLASSIFIED',
      maeHistory: [],
      recentMAE: 0,
      lastUpdatedAt: new Date(),
      graduatedAt: null,
      demotedAt: null,
    };

    this.records.set(procedureId, fresh);
    return fresh;
  }

  /**
   * Evaluate and apply state transitions after an MAE observation.
   *
   * Transitions are evaluated in the following priority order:
   *   1. If currently TYPE_1_GRADUATED and qualifies for demotion → TYPE_1_DEMOTED
   *   2. If currently TYPE_1_DEMOTED → TYPE_2_ONLY (complete the demotion cycle)
   *   3. If currently TYPE_2_ONLY or TYPE_1_CANDIDATE and qualifies for graduation → TYPE_1_GRADUATED
   *   4. If currently UNCLASSIFIED → advance to TYPE_2_ONLY (first observation)
   */
  private evaluateTransitions(record: MutableRecord, confidence: number): void {
    const previousState = record.state;

    switch (record.state) {
      case 'UNCLASSIFIED':
        // First observation: move out of unclassified.
        record.state = 'TYPE_2_ONLY';
        this.logger.debug(
          `Type1Tracker: ${record.procedureId} UNCLASSIFIED → TYPE_2_ONLY (first observation)`,
        );
        break;

      case 'TYPE_2_ONLY':
      case 'TYPE_1_CANDIDATE':
        if (qualifiesForGraduation(confidence, record.recentMAE)) {
          record.state = 'TYPE_1_GRADUATED';
          record.graduatedAt = new Date();
          this.logger.log(
            `Type1Tracker: ${record.procedureId} ${previousState} → TYPE_1_GRADUATED ` +
              `(confidence=${confidence.toFixed(3)}, MAE=${record.recentMAE.toFixed(4)})`,
          );
          this.emitGraduationEvent(record);
        }
        break;

      case 'TYPE_1_GRADUATED':
        if (qualifiesForDemotion(record.recentMAE)) {
          record.state = 'TYPE_1_DEMOTED';
          record.demotedAt = new Date();
          this.logger.warn(
            `Type1Tracker: ${record.procedureId} TYPE_1_GRADUATED → TYPE_1_DEMOTED ` +
              `(MAE=${record.recentMAE.toFixed(4)} exceeds demotionMAE threshold)`,
          );
          this.emitDemotionEvent(record);
        }
        break;

      case 'TYPE_1_DEMOTED':
        // Complete the demotion cycle — back to TYPE_2_ONLY for re-evaluation.
        record.state = 'TYPE_2_ONLY';
        this.logger.debug(
          `Type1Tracker: ${record.procedureId} TYPE_1_DEMOTED → TYPE_2_ONLY (demotion cycle complete)`,
        );
        break;
    }
  }

  /**
   * Emit a TYPE_1_GRADUATION event to the decision event logger.
   * Uses a placeholder drive snapshot since we do not have one at this point.
   */
  private emitGraduationEvent(record: MutableRecord): void {
    if (!this.eventLogger) {
      return;
    }

    try {
      // We emit without a live DriveSnapshot — use a structural placeholder
      // rather than blocking the caller for a snapshot retrieval.
      // The event carries all relevant graduation data in the payload.
      this.eventLogger.log(
        'TYPE_1_GRADUATION',
        {
          procedureId: record.procedureId,
          recentMAE: record.recentMAE,
          maeHistoryLength: record.maeHistory.length,
          graduatedAt: record.graduatedAt?.toISOString(),
        },
        // Drive snapshot not available here; pass a sentinel to satisfy the interface.
        // The logger's session-level correlation handles the gap.
        buildPlaceholderSnapshot(),
        'type1-tracker',
      );
    } catch (err) {
      this.logger.warn(`Failed to emit TYPE_1_GRADUATION event: ${err}`);
    }
  }

  /**
   * Emit a TYPE_1_DEMOTION event to the decision event logger.
   */
  private emitDemotionEvent(record: MutableRecord): void {
    if (!this.eventLogger) {
      return;
    }

    try {
      this.eventLogger.log(
        'TYPE_1_DEMOTION',
        {
          procedureId: record.procedureId,
          recentMAE: record.recentMAE,
          maeHistoryLength: record.maeHistory.length,
          demotedAt: record.demotedAt?.toISOString(),
        },
        buildPlaceholderSnapshot(),
        'type1-tracker',
      );
    } catch (err) {
      this.logger.warn(`Failed to emit TYPE_1_DEMOTION event: ${err}`);
    }
  }

  /**
   * Convert a mutable internal record to the immutable GraduationRecord shape.
   */
  private toImmutable(record: MutableRecord): GraduationRecord {
    return {
      procedureId: record.procedureId,
      state: record.state,
      recentMAE: record.recentMAE,
      maeHistoryLength: record.maeHistory.length,
      lastUpdatedAt: record.lastUpdatedAt,
      graduatedAt: record.graduatedAt,
      demotedAt: record.demotedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Placeholder snapshot utility
// ---------------------------------------------------------------------------

/**
 * Build a minimal structural placeholder DriveSnapshot for event emission
 * contexts where no live snapshot is available (e.g., background tracker
 * transitions that occur outside the active decision cycle).
 *
 * All values are zero / neutral; this is never used for drive-pressure
 * computation — only for satisfying the IDecisionEventLogger.log() signature.
 */
function buildPlaceholderSnapshot(): DriveSnapshot {
  const zero = 0 as number;

  return {
    pressureVector: {
      systemHealth: zero,
      moralValence: zero,
      integrity: zero,
      cognitiveAwareness: zero,
      guilt: zero,
      curiosity: zero,
      boredom: zero,
      anxiety: zero,
      satisfaction: zero,
      sadness: zero,
      focus: zero,
      social: zero,
    },
    timestamp: new Date(),
    tickNumber: -1,
    driveDeltas: {
      systemHealth: zero,
      moralValence: zero,
      integrity: zero,
      cognitiveAwareness: zero,
      guilt: zero,
      curiosity: zero,
      boredom: zero,
      anxiety: zero,
      satisfaction: zero,
      sadness: zero,
      focus: zero,
      social: zero,
    },
    ruleMatchResult: { ruleId: null, eventType: 'TYPE1_TRACKER_EVENT', matched: false },
    totalPressure: zero,
    sessionId: 'type1-tracker',
  };
}

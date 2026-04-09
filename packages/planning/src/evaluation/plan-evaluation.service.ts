/**
 * PlanEvaluationService -- Post-execution evaluation of Planning-created procedures.
 *
 * CANON SS Subsystem 5 (Planning): After a Planning-created procedure (provenance
 * INFERENCE or TAUGHT_PROCEDURE) executes, this service logs the outcome for
 * traceability and tracks per-procedure failure history.
 *
 * Confidence updates are owned by Decision Making's ConfidenceUpdaterService.
 * This service is responsible for:
 *   1. Logging PLAN_EVALUATION or PLAN_FAILURE events to TimescaleDB.
 *   2. Maintaining a per-procedure rolling MAE window (last 10 uses).
 *   3. Flagging procedures that exceed the failure threshold so the Drive Engine
 *      can detect them as candidates for removal via future Opportunities.
 *
 * Failure threshold: MAE > 0.15 is a "failure" per CANON ACT-R dynamics.
 * After FAILURE_STREAK_THRESHOLD consecutive failures the procedure is flagged
 * with a PLAN_FAILURE event carrying a 'persistent_failure' reason. This signal
 * is visible to any subsystem monitoring the event backbone.
 *
 * The MAE history window is bounded to MAE_WINDOW_SIZE to prevent unbounded growth.
 * State is in-memory only -- on restart all procedures start with a clean slate.
 * This is intentional: persistent failure tracking belongs in TimescaleDB queries,
 * which are the ground truth. The in-memory window is for low-latency same-session
 * streak detection only.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { verboseFor } from '@sylphie/shared';
import type {
  IPlanEvaluationService,
  PlanOutcomeData,
  IPlanningEventLogger,
} from '../interfaces/planning.interfaces';
import { PLANNING_EVENT_LOGGER } from '../planning.tokens';

const vlog = verboseFor('Planning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * MAE threshold above which an execution is classified as a failure.
 * Mirrors the CANON ACT-R demotion threshold.
 */
const FAILURE_MAE_THRESHOLD = 0.15;

/**
 * Number of recent MAE values to retain per procedure in the rolling window.
 */
const MAE_WINDOW_SIZE = 10;

/**
 * Number of consecutive failures (MAE > threshold) in the window that triggers
 * a persistent-failure PLAN_FAILURE event.
 */
const FAILURE_STREAK_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class PlanEvaluationService implements IPlanEvaluationService {
  private readonly logger = new Logger(PlanEvaluationService.name);

  /**
   * Rolling MAE window per procedure, keyed by procedureId.
   * Bounded to MAE_WINDOW_SIZE entries.
   */
  private readonly maeWindows = new Map<string, number[]>();

  constructor(
    @Inject(PLANNING_EVENT_LOGGER)
    private readonly eventLogger: IPlanningEventLogger,
  ) {}

  async evaluateOutcome(procedureId: string, outcome: PlanOutcomeData): Promise<void> {
    const mae = outcome.mae ?? (outcome.predictionAccurate ? 0.05 : 0.20);
    const isFailed = !outcome.executionSuccessful || mae > FAILURE_MAE_THRESHOLD;

    // Maintain rolling MAE window.
    const window = this.maeWindows.get(procedureId) ?? [];
    window.push(mae);
    if (window.length > MAE_WINDOW_SIZE) {
      window.splice(0, window.length - MAE_WINDOW_SIZE);
    }
    this.maeWindows.set(procedureId, window);

    const avgMae = window.reduce((sum, v) => sum + v, 0) / window.length;
    const consecutiveFailures = this.countConsecutiveFailures(window);

    vlog('plan evaluation', {
      procedureId,
      mae: +mae.toFixed(4),
      avgMae: +avgMae.toFixed(4),
      executionSuccessful: outcome.executionSuccessful,
      predictionAccurate: outcome.predictionAccurate,
      consecutiveFailures,
      windowSize: window.length,
    });

    if (!isFailed) {
      this.eventLogger.log('PLAN_EVALUATION', {
        procedureId,
        executionSuccessful: true,
        predictionAccurate: outcome.predictionAccurate,
        mae,
        avgMae,
        consecutiveFailures,
        windowSize: window.length,
        driveEffectsObserved: outcome.driveEffectsObserved,
      });

      this.logger.debug(
        `Plan evaluation: ${procedureId} succeeded ` +
          `(mae=${mae.toFixed(4)}, avgMae=${avgMae.toFixed(4)}, ` +
          `window=${window.length})`,
      );
    } else {
      const isPersistentFailure = consecutiveFailures >= FAILURE_STREAK_THRESHOLD;

      vlog('plan evaluation — failed', {
        procedureId,
        mae: +mae.toFixed(4),
        avgMae: +avgMae.toFixed(4),
        consecutiveFailures,
        isPersistentFailure,
      });

      this.eventLogger.log('PLAN_FAILURE', {
        procedureId,
        executionSuccessful: outcome.executionSuccessful,
        predictionAccurate: outcome.predictionAccurate,
        mae,
        avgMae,
        consecutiveFailures,
        windowSize: window.length,
        driveEffectsObserved: outcome.driveEffectsObserved,
        reason: isPersistentFailure ? 'persistent_failure' : 'single_failure',
      });

      if (isPersistentFailure) {
        this.logger.warn(
          `Plan persistent failure: ${procedureId} has ${consecutiveFailures} consecutive ` +
            `failures (mae=${mae.toFixed(4)}, avgMae=${avgMae.toFixed(4)}). ` +
            `Procedure should be reviewed or removed.`,
        );
      } else {
        this.logger.debug(
          `Plan failure: ${procedureId} ` +
            `(mae=${mae.toFixed(4)}, avgMae=${avgMae.toFixed(4)}, ` +
            `consecutive=${consecutiveFailures})`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Count the number of consecutive failures at the end of the window.
   * A failure is a MAE value above FAILURE_MAE_THRESHOLD.
   */
  private countConsecutiveFailures(window: number[]): number {
    let count = 0;
    for (let i = window.length - 1; i >= 0; i--) {
      if ((window[i] ?? 0) > FAILURE_MAE_THRESHOLD) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
}

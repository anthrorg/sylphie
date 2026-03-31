/**
 * Type 1 Graduation & Demotion Tracker.
 *
 * CANON §Dual-Process Cognition: Behaviors graduate from Type 2 (LLM-assisted)
 * to Type 1 (graph reflex) through successful repetition, tracked by this service.
 *
 * State machine: UNCLASSIFIED → TYPE_2_ONLY → TYPE_1_CANDIDATE → TYPE_1_GRADUATED
 * Plus: TYPE_1_DEMOTED (demotion path for graduated behaviors).
 *
 * Graduation requires:
 *   - confidence > 0.80
 *   - avg MAE (last 10) < 0.10
 *
 * Demotion triggers when:
 *   - avg MAE (last 10 or last 3 for graduated) > 0.15
 *   - For graduated actions only (not candidates)
 *
 * This service maintains in-memory state and emits TYPE_1_GRADUATION and
 * TYPE_1_DEMOTION events to TimescaleDB for durability and cross-system visibility.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { IEventService } from '../../events/interfaces/events.interfaces';
import { createDecisionMakingEvent } from '../../events/builders/event-builders';
import {
  qualifiesForGraduation,
  qualifiesForDemotion,
  type CONFIDENCE_THRESHOLDS,
} from '../../shared/types/confidence.types';
import type { DriveSnapshot } from '../../shared/types/drive.types';

/**
 * Type 1 state machine states.
 *
 * UNCLASSIFIED:      No uses yet. Initial state.
 * TYPE_2_ONLY:       Has been used via Type 2 path, but never graduated.
 * TYPE_1_CANDIDATE:  Approaching graduation (confidence > 0.80 but MAE not yet < 0.10).
 * TYPE_1_GRADUATED:  Qualified and transitioned to graph reflex (Type 1 path).
 * TYPE_1_DEMOTED:    Was graduated, but MAE degraded > 0.15; reverted to Type 2.
 */
export type Type1State = 'UNCLASSIFIED' | 'TYPE_2_ONLY' | 'TYPE_1_CANDIDATE' | 'TYPE_1_GRADUATED' | 'TYPE_1_DEMOTED';

/**
 * Record of a state transition event.
 *
 * Tracks why and when an action changed state, for audit trail and diagnosis.
 */
export interface StateTransition {
  readonly from: Type1State;
  readonly to: Type1State;
  readonly reason: string;
  readonly timestamp: Date;
}

/**
 * Complete state record for a single action.
 *
 * Tracks current state, confidence and MAE history, and all transitions.
 */
export interface ActionTypeState {
  readonly actionId: string;
  readonly state: Type1State;
  readonly confidence: number;
  readonly recentMAEs: readonly number[];
  readonly transitionHistory: readonly StateTransition[];
}

/**
 * Aggregate metrics across all tracked actions.
 *
 * Used for system health monitoring and behavioral diversity tracking.
 */
export interface Type1Metrics {
  /** Total number of actions being tracked. */
  readonly totalActions: number;

  /** Count of actions in each state. */
  readonly byState: Record<Type1State, number>;

  /**
   * Graduation rate: (TYPE_1_GRADUATED count) / (total actions).
   * Indicates how many behaviors have successfully graduated to reflexes.
   */
  readonly graduationRate: number;

  /**
   * Demotion rate: (TYPE_1_DEMOTED count) / (TYPE_1_GRADUATED + TYPE_1_DEMOTED).
   * Indicates stability of graduated actions.
   */
  readonly demotionRate: number;

  /** Timestamp when metrics were computed. */
  readonly computedAt: Date;
}

/**
 * Service interface for Type 1 / Type 2 lifecycle tracking.
 *
 * Maintains the state machine and evaluates graduation/demotion conditions.
 * Emits events for system visibility and learning.
 */
export interface IType1TrackerService {
  /**
   * Get current state of an action.
   *
   * Returns UNCLASSIFIED if the action has never been recorded.
   *
   * @param actionId - WKG procedure node ID
   * @returns Current Type1State
   */
  getState(actionId: string): Type1State;

  /**
   * Record a use of an action and evaluate state transitions.
   *
   * Called when an action is used (executed and evaluated). Updates confidence
   * and MAE history, evaluates graduation/demotion thresholds, and transitions
   * state if needed.
   *
   * @param actionId - WKG procedure node ID
   * @param confidence - Current ACT-R confidence of the action
   * @param mae - Prediction error for this use
   * @param sessionId - Session ID for event correlation
   * @param driveSnapshot - Current drive state for event logging
   * @returns Promise resolving when state is updated and events logged
   */
  recordUse(
    actionId: string,
    confidence: number,
    mae: number,
    sessionId: string,
    driveSnapshot: DriveSnapshot,
  ): Promise<void>;

  /**
   * Evaluate whether an action should graduate or demote right now.
   *
   * Checks graduation and demotion conditions and returns the appropriate
   * target state. Does NOT transition — use recordUse for full state update.
   * Used by arbitration for Type 1 / Type 2 decision-making.
   *
   * @param actionId - WKG procedure node ID
   * @returns Target Type1State based on current conditions
   */
  evaluateGraduation(actionId: string): Type1State;

  /**
   * Get current aggregate metrics.
   *
   * Computes statistics across all tracked actions for system health monitoring.
   *
   * @returns Type1Metrics snapshot
   */
  getMetrics(): Type1Metrics;
}

/**
 * Internal record: complete state for a single action.
 * Used by the service; not exposed in the public interface.
 */
interface ActionRecord {
  actionId: string;
  state: Type1State;
  confidence: number;
  recentMAEs: number[];  // Maintains up to 10 most recent
  transitionHistory: StateTransition[];
}

@Injectable()
export class Type1TrackerService implements IType1TrackerService {
  private readonly logger = new Logger('Type1TrackerService');

  /**
   * In-memory store of action state records.
   * Key: actionId, Value: ActionRecord
   */
  private readonly store = new Map<string, ActionRecord>();

  /** Maximum number of recent MAEs to maintain. */
  private readonly maxRecentMAEs = 10;

  constructor(
    @Inject(EVENTS_SERVICE) private readonly events: IEventService,
  ) {}

  /**
   * Get current state of an action.
   *
   * Returns UNCLASSIFIED for unknown actions (never recorded).
   */
  getState(actionId: string): Type1State {
    const record = this.store.get(actionId);
    return record?.state ?? 'UNCLASSIFIED';
  }

  /**
   * Record a use: update state, evaluate transitions, emit events.
   *
   * State machine logic:
   * - First use: UNCLASSIFIED → TYPE_2_ONLY
   * - When confidence > 0.80 AND avg MAE < 0.10: → TYPE_1_CANDIDATE (if not already graduated)
   * - When graduated and avg MAE > 0.15: → TYPE_1_DEMOTED
   */
  async recordUse(
    actionId: string,
    confidence: number,
    mae: number,
    sessionId: string,
    driveSnapshot: DriveSnapshot,
  ): Promise<void> {
    let record = this.store.get(actionId);

    // Step 1: Create record if needed (first use)
    if (!record) {
      record = {
        actionId,
        state: 'UNCLASSIFIED',
        confidence,
        recentMAEs: [mae],
        transitionHistory: [],
      };
      this.store.set(actionId, record);

      // First use: UNCLASSIFIED → TYPE_2_ONLY
      const transition: StateTransition = {
        from: 'UNCLASSIFIED',
        to: 'TYPE_2_ONLY',
        reason: 'First use via Type 2 path',
        timestamp: new Date(),
      };
      record.state = 'TYPE_2_ONLY';
      record.transitionHistory.push(transition);
      this.logger.debug(`${actionId}: ${transition.from} → ${transition.to}`);
    } else {
      // Update confidence and MAE history
      record.confidence = confidence;
      record.recentMAEs.push(mae);
      if (record.recentMAEs.length > this.maxRecentMAEs) {
        record.recentMAEs.splice(0, record.recentMAEs.length - this.maxRecentMAEs);
      }
    }

    // Step 2: Evaluate graduation/demotion conditions
    const previousState = record.state;
    const avgMAE = record.recentMAEs.length > 0
      ? record.recentMAEs.reduce((a, b) => a + b, 0) / record.recentMAEs.length
      : 1.0;

    // Check demotion first (applies to graduated actions)
    if (record.state === 'TYPE_1_GRADUATED' && qualifiesForDemotion(avgMAE)) {
      const transition: StateTransition = {
        from: record.state,
        to: 'TYPE_1_DEMOTED',
        reason: `Avg MAE degraded to ${avgMAE.toFixed(3)} (threshold: 0.15)`,
        timestamp: new Date(),
      };
      record.state = 'TYPE_1_DEMOTED';
      record.transitionHistory.push(transition);
      this.logger.debug(`${actionId}: ${transition.from} → ${transition.to} — ${transition.reason}`);

      await this.logDemotionEvent(actionId, sessionId, driveSnapshot, transition);
    }

    // Check graduation (applies to TYPE_2_ONLY and TYPE_1_DEMOTED)
    if ((record.state === 'TYPE_2_ONLY' || record.state === 'TYPE_1_DEMOTED') &&
        qualifiesForGraduation(confidence, avgMAE)) {
      // Intermediate: TYPE_2_ONLY → TYPE_1_CANDIDATE
      if (record.state === 'TYPE_2_ONLY') {
        const candidateTransition: StateTransition = {
          from: 'TYPE_2_ONLY',
          to: 'TYPE_1_CANDIDATE',
          reason: `Confidence ${confidence.toFixed(3)} > 0.80, monitoring MAE`,
          timestamp: new Date(),
        };
        record.state = 'TYPE_1_CANDIDATE';
        record.transitionHistory.push(candidateTransition);
        this.logger.debug(
          `${actionId}: ${candidateTransition.from} → ${candidateTransition.to}`,
        );
      }

      // TYPE_1_CANDIDATE → TYPE_1_GRADUATED or TYPE_1_DEMOTED → TYPE_1_GRADUATED
      if (record.state === 'TYPE_1_CANDIDATE' || record.state === 'TYPE_1_DEMOTED') {
        const graduationTransition: StateTransition = {
          from: record.state,
          to: 'TYPE_1_GRADUATED',
          reason: `Confidence ${confidence.toFixed(3)} > 0.80 AND avg MAE ${avgMAE.toFixed(3)} < 0.10 (last 10 uses)`,
          timestamp: new Date(),
        };
        record.state = 'TYPE_1_GRADUATED';
        record.transitionHistory.push(graduationTransition);
        this.logger.debug(
          `${actionId}: ${graduationTransition.from} → ${graduationTransition.to}`,
        );

        await this.logGraduationEvent(actionId, sessionId, driveSnapshot, graduationTransition);
      }
    }

    // Step 3: Log the use (for audit)
    this.logger.debug(
      `Recorded use: ${actionId} state=${record.state} confidence=${confidence.toFixed(3)} avgMAE=${avgMAE.toFixed(3)}`,
    );
  }

  /**
   * Evaluate whether an action qualifies for graduation right now.
   *
   * Returns the appropriate target state based on current conditions.
   * Used by arbitration to decide whether to use Type 1 path.
   */
  evaluateGraduation(actionId: string): Type1State {
    const record = this.store.get(actionId);
    if (!record) {
      return 'UNCLASSIFIED';
    }

    const avgMAE = record.recentMAEs.length > 0
      ? record.recentMAEs.reduce((a, b) => a + b, 0) / record.recentMAEs.length
      : 1.0;

    // If graduated, check for demotion
    if (record.state === 'TYPE_1_GRADUATED' && qualifiesForDemotion(avgMAE)) {
      return 'TYPE_1_DEMOTED';
    }

    // Check graduation
    if ((record.state === 'TYPE_2_ONLY' || record.state === 'TYPE_1_DEMOTED') &&
        qualifiesForGraduation(record.confidence, avgMAE)) {
      return 'TYPE_1_GRADUATED';
    }

    return record.state;
  }

  /**
   * Get aggregate metrics across all tracked actions.
   */
  getMetrics(): Type1Metrics {
    const states: Record<Type1State, number> = {
      UNCLASSIFIED: 0,
      TYPE_2_ONLY: 0,
      TYPE_1_CANDIDATE: 0,
      TYPE_1_GRADUATED: 0,
      TYPE_1_DEMOTED: 0,
    };

    // Count states
    for (const record of this.store.values()) {
      states[record.state] += 1;
    }

    const totalActions = this.store.size;
    const graduatedCount = states.TYPE_1_GRADUATED;
    const demotedCount = states.TYPE_1_DEMOTED;

    // Graduation rate: how many have reached TYPE_1_GRADUATED
    const graduationRate = totalActions > 0 ? graduatedCount / totalActions : 0;

    // Demotion rate: of those that graduated, how many have demoted
    const denominatorDemotion = graduatedCount + demotedCount;
    const demotionRate = denominatorDemotion > 0 ? demotedCount / denominatorDemotion : 0;

    return {
      totalActions,
      byState: states,
      graduationRate: Math.min(1.0, Math.max(0.0, graduationRate)),
      demotionRate: Math.min(1.0, Math.max(0.0, demotionRate)),
      computedAt: new Date(),
    };
  }

  /**
   * Log graduation event to TimescaleDB.
   *
   * Emits TYPE_1_GRADUATION with full provenance.
   */
  private async logGraduationEvent(
    actionId: string,
    sessionId: string,
    driveSnapshot: DriveSnapshot,
    transition: StateTransition,
  ): Promise<void> {
    try {
      const event = (createDecisionMakingEvent as any)('TYPE_1_GRADUATION', {
        sessionId,
        driveSnapshot,
      });

      await this.events.record(event);
      this.logger.debug(
        `Logged TYPE_1_GRADUATION for ${actionId}: ${transition.reason}`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to log graduation event for ${actionId}: ${(err as Error).message}`,
        err,
      );
      throw err;
    }
  }

  /**
   * Log demotion event to TimescaleDB.
   *
   * Emits TYPE_1_DEMOTION with full provenance.
   */
  private async logDemotionEvent(
    actionId: string,
    sessionId: string,
    driveSnapshot: DriveSnapshot,
    transition: StateTransition,
  ): Promise<void> {
    try {
      const event = (createDecisionMakingEvent as any)('TYPE_1_DEMOTION', {
        sessionId,
        driveSnapshot,
      });

      await this.events.record(event);
      this.logger.debug(
        `Logged TYPE_1_DEMOTION for ${actionId}: ${transition.reason}`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to log demotion event for ${actionId}: ${(err as Error).message}`,
        err,
      );
      throw err;
    }
  }
}

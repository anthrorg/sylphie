/**
 * Shrug Imperative Enforcement (CANON Immutable Standard 4).
 *
 * CANON Standard 4 (Shrug Imperative): When nothing is above threshold,
 * signal incomprehension. No random low-confidence actions.
 *
 * Enforces that Sylphie explicitly signals incomprehension (shrug) rather
 * than selecting a random low-confidence action when all candidates fall
 * below the dynamic action threshold. Prevents superstitious behavior.
 *
 * This service:
 * 1. Detects when all candidates are below threshold
 * 2. Creates properly-provenance'd SHRUG actions
 * 3. Logs shrug events to TimescaleDB
 * 4. Tracks shrug frequency metrics
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { IEventService } from '../../events/interfaces/events.interfaces';
import { createDecisionMakingEvent } from '../../events/builders/event-builders';
import type { ActionCandidate } from '../../shared/types/action.types';
import type { DriveSnapshot } from '../../shared/types/drive.types';

/**
 * A shrug action: explicit incomprehension signal.
 *
 * Represents Sylphie's decision to signal that she has no confident
 * action candidate, rather than selecting a low-confidence action
 * at random. Theater-compliant expression of genuine uncertainty.
 */
export interface ShrugAction {
  /** Always 'SHRUG' — discriminates from other action types. */
  readonly type: 'SHRUG';

  /**
   * Human-readable explanation of why no candidate was selected.
   * Example: "No Type 1 candidates above threshold (max: 0.43).
   * Type 2 invoked but returned content below theater threshold."
   */
  readonly reason: string;

  /** Confidences of the candidates that were considered. */
  readonly candidateConfidences: readonly number[];

  /** The threshold that candidates failed to exceed. */
  readonly threshold: number;

  /** Wall-clock timestamp when the shrug was created. */
  readonly timestamp: Date;
}

/**
 * Metrics tracking shrug frequency and decision stats.
 *
 * Used to understand when and how often Sylphie signals incomprehension,
 * for diagnostic purposes and behavior validation.
 */
export interface ShrugMetrics {
  /** Total number of shrug decisions made. */
  readonly totalShrugs: number;

  /** Total number of decision cycles (including shrugs). */
  readonly totalDecisions: number;

  /** Ratio of shrugs to total decisions, in [0.0, 1.0]. */
  readonly shrugRate: number;

  /**
   * Average confidence of candidates that resulted in shrugs.
   * Lower values indicate more universal lack of confidence.
   */
  readonly avgShrugCandidateConfidence: number;

  /** Timestamp when metrics were computed. */
  readonly computedAt: Date;
}

/**
 * Service interface for shrug imperative enforcement.
 *
 * CANON Standard 4 requires this as a separate concern: detecting
 * universal candidate insufficiency and signaling incomprehension.
 */
export interface IShruggableActionService {
  /**
   * Determine whether a shrug action should be selected.
   *
   * Returns true if and only if ALL candidates have confidence strictly
   * less than the threshold. If any candidate meets or exceeds threshold,
   * returns false (arbitration should proceed normally).
   *
   * @param candidates - Candidates assembled for arbitration
   * @param threshold - The dynamic action threshold
   * @returns true if all candidates are below threshold; false otherwise
   */
  shouldShrug(candidates: readonly ActionCandidate[], threshold: number): boolean;

  /**
   * Create a properly-formed shrug action.
   *
   * Assembles a ShrugAction with the provided reason, extracts candidate
   * confidences, and records metadata for logging.
   *
   * @param candidates - Candidates that were considered
   * @param threshold - The threshold they failed to meet
   * @param reason - Human-readable explanation
   * @returns A complete ShrugAction
   */
  createShrugAction(
    candidates: readonly ActionCandidate[],
    threshold: number,
    reason: string,
  ): ShrugAction;

  /**
   * Log a shrug event to TimescaleDB.
   *
   * Records the SHRUG_SELECTED event with full provenance for later
   * analysis. Includes candidate confidences, threshold, and reason.
   *
   * @param shrugAction - The shrug action to log
   * @param sessionId - Session ID for correlation
   * @param driveSnapshot - Current drive state
   * @returns Promise resolving when event is recorded
   */
  logShrugEvent(
    shrugAction: ShrugAction,
    sessionId: string,
    driveSnapshot: DriveSnapshot,
  ): Promise<void>;

  /**
   * Get current shrug frequency metrics.
   *
   * Computes aggregate statistics about how often shrugs occur relative
   * to total decisions.
   *
   * @returns Current shrug metrics
   */
  getMetrics(): ShrugMetrics;
}

@Injectable()
export class ShruggableActionService implements IShruggableActionService {
  private readonly logger = new Logger('ShruggableActionService');

  /**
   * In-memory tracking of shrug decisions.
   * Accumulates over the session for metrics computation.
   */
  private shrugHistory: ShrugAction[] = [];

  /** Total decision cycles (Type 1, Type 2, or SHRUG). */
  private totalDecisions = 0;

  constructor(
    @Inject(EVENTS_SERVICE) private readonly events: IEventService,
  ) {}

  /**
   * Determine whether all candidates are below threshold.
   *
   * Shrug if and only if ALL candidates have confidence < threshold.
   * If any candidate meets or exceeds threshold, normal arbitration proceeds.
   */
  shouldShrug(candidates: readonly ActionCandidate[], threshold: number): boolean {
    if (candidates.length === 0) {
      return true;
    }

    // Return true only if ALL candidates are strictly below threshold
    return candidates.every((candidate) => candidate.confidence < threshold);
  }

  /**
   * Create a shrug action with metadata.
   *
   * Extracts candidate confidences and assembles a properly-provenance'd
   * ShrugAction for event logging.
   */
  createShrugAction(
    candidates: readonly ActionCandidate[],
    threshold: number,
    reason: string,
  ): ShrugAction {
    const candidateConfidences = candidates.map((c) => c.confidence);

    return {
      type: 'SHRUG',
      reason,
      candidateConfidences,
      threshold,
      timestamp: new Date(),
    };
  }

  /**
   * Log shrug event to TimescaleDB.
   *
   * Records SHRUG_SELECTED event with full provenance for diagnosis.
   * Accumulates in shrugHistory for metrics computation.
   */
  async logShrugEvent(
    shrugAction: ShrugAction,
    sessionId: string,
    driveSnapshot: DriveSnapshot,
  ): Promise<void> {
    this.shrugHistory.push(shrugAction);
    this.totalDecisions += 1;

    try {
      const event = (createDecisionMakingEvent as any)('SHRUG_SELECTED', {
        sessionId,
        driveSnapshot,
      });

      await this.events.record(event);

      this.logger.debug(
        `Logged SHRUG_SELECTED event for session ${sessionId}: "${shrugAction.reason}"`,
      );
    } catch (err) {
      this.logger.error(`Failed to log shrug event: ${(err as Error).message}`, err);
      throw err;
    }
  }

  /**
   * Compute current shrug metrics.
   *
   * Returns aggregated statistics about shrug frequency and candidate
   * confidence patterns.
   */
  getMetrics(): ShrugMetrics {
    const totalShrugs = this.shrugHistory.length;
    const shrugRate = this.totalDecisions > 0 ? totalShrugs / this.totalDecisions : 0;

    // Compute average candidate confidence across all shrugs
    let avgConfidence = 0;
    if (totalShrugs > 0) {
      const allConfidences = this.shrugHistory.flatMap((s) => s.candidateConfidences);
      if (allConfidences.length > 0) {
        avgConfidence = allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length;
      }
    }

    return {
      totalShrugs,
      totalDecisions: this.totalDecisions,
      shrugRate: Math.min(1.0, Math.max(0.0, shrugRate)),
      avgShrugCandidateConfidence: avgConfidence,
      computedAt: new Date(),
    };
  }
}

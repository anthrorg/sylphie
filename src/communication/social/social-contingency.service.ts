/**
 * SocialContingencyService — tracks social drive contingencies for Sylphie-initiated comments.
 *
 * CANON §Behavioral Contingency Structure: "Social comment quality — Guardian response
 * within 30s = extra reinforcement."
 *
 * This service implements the core tracking mechanism:
 * 1. Records when Sylphie initiates a spontaneous comment (SOCIAL_COMMENT_INITIATED event).
 * 2. Detects when a guardian message arrives within 30 seconds of the comment.
 * 3. Emits SOCIAL_CONTINGENCY_MET event and reports to Drive Engine via
 *    IActionOutcomeReporter for automatic reinforcement (Social -0.15, Satisfaction +0.10).
 *
 * CANON Immutable Standard 2 (Contingency Requirement): Every positive reinforcement
 * must trace to a specific behavior. The contingency is only detected for SYLPHIE-INITIATED
 * comments, not for responses to guardian input.
 *
 * Implementation notes:
 * - Uses in-memory Map<utteranceId, timestamp> for pending comments (no persistence needed).
 * - 30-second window with 35-second safety tolerance for clock skew.
 * - Periodic cleanup every 60s prevents memory leak from expired entries.
 * - Cleanup on module destroy (OnModuleDestroy) for graceful shutdown.
 */

import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';

import { EVENTS_SERVICE } from '../../events';
import type { IEventService, EventBuildOptions } from '../../events';

import { ACTION_OUTCOME_REPORTER } from '../../drive-engine';
import type { IActionOutcomeReporter } from '../../drive-engine';

import type { DriveSnapshot, DriveName } from '../../shared/types/drive.types';
import { DriveName as DriveNameEnum } from '../../shared/types/drive.types';
import type { SylphieEvent } from '../../shared/types/event.types';

// ---------------------------------------------------------------------------
// Social Contingency Result Type
// ---------------------------------------------------------------------------

/**
 * Result of checking for a guardian response to a Sylphie-initiated comment.
 *
 * All timestamps are wall-clock (Date). latencyMs is computed from initiatedAt
 * and respondedAt; contingencyMet is true when latencyMs <= 30000ms.
 */
export interface SocialContingencyResult {
  /** The ID of the Sylphie-initiated utterance/comment. */
  readonly utteranceId: string;

  /** Wall-clock time when Sylphie initiated the comment. */
  readonly initiatedAt: Date;

  /** Wall-clock time when the guardian's response message was received. */
  readonly respondedAt: Date;

  /** Latency in milliseconds from initiation to guardian response. */
  readonly latencyMs: number;

  /** True if latencyMs <= 30000ms (within the 30-second window). */
  readonly contingencyMet: boolean;
}

// ---------------------------------------------------------------------------
// Pending Utterance Tracking
// ---------------------------------------------------------------------------

/**
 * Internal tracking record for a Sylphie-initiated utterance awaiting response.
 */
interface PendingUtterance {
  utteranceId: string;
  initiatedAt: Date;
}

// ---------------------------------------------------------------------------
// SocialContingencyService
// ---------------------------------------------------------------------------

@Injectable()
export class SocialContingencyService implements OnModuleDestroy {
  /**
   * In-memory map of pending utterances keyed by utteranceId.
   * Used for quick lookup when a guardian message arrives.
   * Expired entries are cleaned up periodically and on shutdown.
   */
  private readonly pendingUtterances = new Map<string, PendingUtterance>();

  /**
   * Cleanup interval ID. Cleared on module destroy to prevent memory leaks.
   */
  private cleanupIntervalId?: NodeJS.Timeout;

  /**
   * Window for guardian response in milliseconds.
   * CANON: 30 seconds.
   */
  private readonly RESPONSE_WINDOW_MS = 30_000;

  /**
   * Safety tolerance for clock skew in milliseconds.
   * Allows up to 5 seconds of grace period.
   */
  private readonly TOLERANCE_MS = 5_000;

  /**
   * Cleanup interval in milliseconds.
   * Expired entries are purged every 60 seconds.
   */
  private readonly CLEANUP_INTERVAL_MS = 60_000;

  constructor(
    @Inject(EVENTS_SERVICE) private readonly eventService: IEventService,
    @Inject(ACTION_OUTCOME_REPORTER)
    private readonly outcomeReporter: IActionOutcomeReporter,
  ) {
    // Start cleanup interval on construction
    this.startCleanupInterval();
  }

  /**
   * Register a Sylphie-initiated comment.
   *
   * Called when Communication service emits a SOCIAL_COMMENT_INITIATED event.
   * Records the utteranceId and timestamp for later matching against guardian responses.
   *
   * CANON Immutable Standard 2: Only SYLPHIE-INITIATED comments are tracked.
   * Responses to guardian input should not trigger contingency detection.
   *
   * @param utteranceId - Unique ID for this comment (typically from SOCIAL_COMMENT_INITIATED event)
   * @param timestamp - Wall-clock time when the comment was initiated
   */
  trackSylphieInitiated(utteranceId: string, timestamp: Date): void {
    this.pendingUtterances.set(utteranceId, {
      utteranceId,
      initiatedAt: timestamp,
    });
  }

  /**
   * Check if a guardian message constitutes a response to a pending Sylphie comment.
   *
   * Called after guardian input is received and parsed. If a pending utterance exists
   * whose initiation timestamp is within the response window (30s + tolerance), then:
   * 1. Emits SOCIAL_CONTINGENCY_MET event to TimescaleDB with latency measurements
   * 2. Reports positive outcome to Drive Engine for reinforcement
   * 3. Removes the utterance from pending tracking
   * 4. Returns the contingency result
   *
   * If no pending utterance matches or the window has expired, returns null.
   *
   * CANON Spec: "Guardian response within 30s = extra reinforcement
   * (Social -0.15 + Satisfaction +0.10)."
   *
   * @param guardianMessageTimestamp - Wall-clock time of the guardian message
   * @param sessionId - Session ID for event correlation
   * @param driveSnapshot - Current drive state at response time
   * @param matchedUtteranceId - Optional: if known, which utterance this responds to.
   *                             If not provided, checks all pending utterances in LIFO order.
   * @returns Contingency result if a match was found; null otherwise
   */
  checkGuardianResponse(
    guardianMessageTimestamp: Date,
    sessionId: string,
    driveSnapshot: DriveSnapshot,
    matchedUtteranceId?: string,
  ): SocialContingencyResult | null {
    // If a specific utterance is provided, check only that one
    if (matchedUtteranceId) {
      const pending = this.pendingUtterances.get(matchedUtteranceId);
      if (pending) {
        const result = this.evaluateContingency(pending, guardianMessageTimestamp);
        if (result) {
          this.emitAndReportContingency(
            result,
            sessionId,
            driveSnapshot,
            matchedUtteranceId,
          );
          this.pendingUtterances.delete(matchedUtteranceId);
          return result;
        }
      }
      return null;
    }

    // Otherwise, check all pending utterances in LIFO order
    // (most recent first, using Array.from to get insertion order)
    const pending = Array.from(this.pendingUtterances.values()).reverse();
    for (const utterance of pending) {
      const result = this.evaluateContingency(utterance, guardianMessageTimestamp);
      if (result) {
        this.emitAndReportContingency(
          result,
          sessionId,
          driveSnapshot,
          utterance.utteranceId,
        );
        this.pendingUtterances.delete(utterance.utteranceId);
        return result;
      }
    }

    return null;
  }

  /**
   * Evaluate whether a pending utterance's response window has been satisfied.
   *
   * Returns a SocialContingencyResult if:
   *   1. The utterance initiated timestamp is within the response window
   *      (30s + 5s tolerance = 35s total)
   *   2. The guardian message timestamp is after initiation
   *
   * Returns null if the window has expired or the timestamps are invalid.
   *
   * @param pending - The pending utterance record
   * @param guardianTimestamp - Wall-clock time of the guardian message
   * @returns SocialContingencyResult if contingency met; null otherwise
   */
  private evaluateContingency(
    pending: PendingUtterance,
    guardianTimestamp: Date,
  ): SocialContingencyResult | null {
    const latencyMs = guardianTimestamp.getTime() - pending.initiatedAt.getTime();

    // Guardian message must arrive after initiation
    if (latencyMs < 0) {
      return null;
    }

    // Check if within response window (30s + tolerance)
    const maxLatencyMs = this.RESPONSE_WINDOW_MS + this.TOLERANCE_MS;
    if (latencyMs > maxLatencyMs) {
      return null;
    }

    return {
      utteranceId: pending.utteranceId,
      initiatedAt: pending.initiatedAt,
      respondedAt: guardianTimestamp,
      latencyMs,
      contingencyMet: latencyMs <= this.RESPONSE_WINDOW_MS,
    };
  }

  /**
   * Emit SOCIAL_CONTINGENCY_MET event and report positive outcome to Drive Engine.
   *
   * CANON Immutable Standard 2 (Contingency Requirement): The positive reinforcement
   * is attributed to the specific utteranceId that triggered the contingency.
   *
   * @param result - The contingency evaluation result
   * @param sessionId - Session ID for event correlation
   * @param driveSnapshot - Current drive state
   * @param utteranceId - The ID of the Sylphie comment that was responded to
   */
  private emitAndReportContingency(
    result: SocialContingencyResult,
    sessionId: string,
    driveSnapshot: DriveSnapshot,
    utteranceId: string,
  ): void {
    // Emit event to TimescaleDB
    const event: Omit<SylphieEvent, 'id'> = {
      type: 'SOCIAL_CONTINGENCY_MET',
      timestamp: new Date(),
      subsystem: 'COMMUNICATION',
      sessionId,
      driveSnapshot,
      schemaVersion: 1,
      data: {
        utteranceId,
        latencyMs: result.latencyMs,
        initiatedAt: result.initiatedAt.toISOString(),
        respondedAt: result.respondedAt.toISOString(),
      },
    } as any; // Cast to any to bypass TypeScript's strictness on the data field

    this.eventService
      .record(event)
      .catch((err: unknown) => {
        console.error('Failed to emit SOCIAL_CONTINGENCY_MET event:', err);
      });

    // Report positive outcome to Drive Engine for reinforcement
    // CANON: Social -0.15 + Satisfaction +0.10
    this.outcomeReporter.reportOutcome({
      actionId: utteranceId,
      actionType: 'SOCIAL_COMMENT_INITIATED',
      success: true,
      driveEffects: {
        [DriveNameEnum.Social]: -0.15,
        [DriveNameEnum.Satisfaction]: 0.1,
      },
      feedbackSource: 'GUARDIAN',
      theaterCheck: {
        expressionType: 'none',
        correspondingDrive: null,
        driveValue: null,
        isTheatrical: false,
      },
    });
  }

  /**
   * Start the periodic cleanup interval.
   *
   * Removes all pending utterances whose initiation timestamp is older than
   * (now - 35 seconds). Runs every 60 seconds.
   *
   * Called in constructor; cleared in onModuleDestroy.
   */
  private startCleanupInterval(): void {
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupExpiredEntries();
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Remove expired entries from the pending utterances map.
   *
   * An entry is expired if its initiatedAt timestamp is older than
   * (now - 35 seconds). This prevents the map from growing unbounded.
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();
    const maxAgeMsAllowed = this.RESPONSE_WINDOW_MS + this.TOLERANCE_MS;

    const expired: string[] = [];
    for (const [utteranceId, pending] of this.pendingUtterances.entries()) {
      const ageMs = now - pending.initiatedAt.getTime();
      if (ageMs > maxAgeMsAllowed) {
        expired.push(utteranceId);
      }
    }

    for (const utteranceId of expired) {
      this.pendingUtterances.delete(utteranceId);
    }
  }

  /**
   * NestJS lifecycle hook: cleanup on module destroy.
   *
   * Clears the cleanup interval timer to prevent memory leaks and
   * orphaned timers from preventing process shutdown.
   */
  onModuleDestroy(): void {
    if (this.cleanupIntervalId !== undefined) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
  }
}

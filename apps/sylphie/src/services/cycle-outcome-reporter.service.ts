/**
 * CycleOutcomeReporterService — Theater check + reinforcement outcome reporter.
 *
 * Extracted from CommunicationService (TK-35 / EP7-E) to separate the
 * CANON-compliance audit path from the delivery hot-path.
 *
 * Owns two formerly-private methods:
 *   - checkTheaterProhibition  — lexical tone vs. drive-state audit (CANON Std-1)
 *   - reportBasicOutcome       — closes the reinforcement loop after delivery
 *
 * The theater check GATES the outcome report: a theatrical response sets
 * theaterValidated=false so the drive engine applies zero reinforcement
 * (Sylphie is not rewarded for expressing affect she does not feel).
 *
 * CANON Standard 1 (Theater Prohibition): the audit is deterministic — no LLM
 * calls, no external network. Delivery is NEVER blocked; this is an honesty
 * audit, not a content filter.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  TimescaleService,
  DriveName,
  DRIVE_INDEX_ORDER,
  type CycleResponse,
  type DriveSnapshot,
} from '@sylphie/shared';
import {
  DECISION_MAKING_SERVICE,
  type IDecisionMakingService,
} from '@sylphie/decision-making';
import {
  DRIVE_STATE_READER,
  type IDriveStateReader,
} from '@sylphie/drive-engine';
import {
  scoreAffect,
  classifyMismatch,
  type TextTheaterVerdict,
} from './theater-affect-scorer';

@Injectable()
export class CycleOutcomeReporterService {
  private readonly logger = new Logger(CycleOutcomeReporterService.name);

  constructor(
    @Inject(DECISION_MAKING_SERVICE)
    private readonly decisionMaking: IDecisionMakingService,

    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,

    private readonly timescale: TimescaleService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Validate that the response text's tonal affect correlates with actual
   * drive state, then report the basic reinforcement outcome.
   *
   * Always call this after delivery — it is the single entry point so
   * the theater verdict is guaranteed to thread into the outcome report.
   *
   * @returns the theater verdict (for logging / tests).
   */
  async checkAndReport(response: CycleResponse): Promise<TextTheaterVerdict> {
    const verdict = this.checkTheaterProhibition(response);
    await this.reportBasicOutcome(response, verdict);
    return verdict;
  }

  // ---------------------------------------------------------------------------
  // Theater Prohibition (CANON Standard 1)
  // ---------------------------------------------------------------------------

  /**
   * Validate that the response text's tonal affect correlates with actual
   * drive state (CANON Standard 1 — Theater Prohibition).
   *
   * Uses a deterministic lexical scorer (theater-affect-scorer.ts) — no LLM
   * calls, no external dependencies. Catches gross tonal mismatches: effusive
   * cheerfulness while Anxiety/Guilt/Sadness are elevated, or performed distress
   * while Satisfaction is high and Anxiety is low.
   *
   * On violation: writes a THEATER_PROHIBITED audit event to TimescaleDB and
   * returns isTheatrical=true so the caller zeros reinforcement. Delivery is NOT
   * blocked — the response still reaches the guardian (this is an honesty audit,
   * not a content filter).
   */
  checkTheaterProhibition(response: CycleResponse): TextTheaterVerdict {
    const affectScore = scoreAffect(response.text ?? '');

    if (!response.text) {
      // SHRUG — no text, no tone, not theatrical.
      return {
        isTheatrical: false,
        violationClass: null,
        offendingDrive: null,
        offendingDriveValue: null,
        reason: 'No response text (SHRUG) — not theatrical',
        affectScore,
      };
    }

    const verdict = classifyMismatch(affectScore, response.driveSnapshot.pressureVector);

    if (verdict.isTheatrical) {
      this.logger.warn(
        `[Theater Prohibition] VIOLATION — turn=${response.turnId}, ` +
          `class=${verdict.violationClass}, drive=${verdict.offendingDrive}, ` +
          `driveValue=${verdict.offendingDriveValue?.toFixed(2)}, reason="${verdict.reason}"`,
      );

      // Audit trail (CANON Standard 1). Fire-and-forget — never block delivery
      // on the DB write.
      this.logEvent(
        'THEATER_PROHIBITED',
        response.driveSnapshot.sessionId,
        {
          turnId: response.turnId,
          actionId: response.actionId,
          violationClass: verdict.violationClass,
          offendingDrive: verdict.offendingDrive,
          offendingDriveValue: verdict.offendingDriveValue,
          affectValence: affectScore.valence,
          affectMagnitude: affectScore.magnitude,
          markerCount: affectScore.markerCount,
          verdictReason: verdict.reason,
          responseTextSnippet: response.text.substring(0, 100),
          auditOnly: true,
        },
        // CANON Std-2: correlate this violation row with the action that
        // produced the theatrical response, using the same `action:<id>`
        // convention the drive engine uses for its DRIVE_EVENT rows.
        response.actionId ? `action:${response.actionId}` : null,
      );
    } else {
      this.logger.debug(
        `[Theater Prohibition] OK — turn=${response.turnId}, ` +
          `valence=${affectScore.valence.toFixed(2)}, magnitude=${affectScore.magnitude.toFixed(2)}`,
      );
    }

    return verdict;
  }

  // ---------------------------------------------------------------------------
  // Outcome Reporting
  // ---------------------------------------------------------------------------

  /**
   * Report a basic outcome after response delivery.
   *
   * This closes the reinforcement loop for the current cycle without waiting
   * for explicit guardian feedback. If guardian feedback arrives later via
   * CommunicationService.reportGuardianFeedback(), it will update the
   * confidence again.
   *
   * @param theaterVerdict  Result of checkTheaterProhibition — gates whether
   *                        the drive engine applies real vs. zero reinforcement.
   */
  async reportBasicOutcome(
    response: CycleResponse,
    theaterVerdict: TextTheaterVerdict,
  ): Promise<void> {
    // All responses that produced text should report outcomes to the drive
    // engine so that communicating relieves drives (Social, Boredom, etc.).
    // SHRUG and novel TYPE_2 responses lack a procedure node, so the
    // decision-making service will skip confidence updates for them — but
    // it must still forward drive effects to the Drive Engine.

    try {
      const postSnapshot = this.driveStateReader.getCurrentState();

      // Compute observed drive effects as the delta between pre-execution
      // and post-execution pressure vectors. Without this, predictions are
      // always compared against an empty object and MAE drifts upward.
      const observed: Partial<Record<DriveName, number>> = {};
      if (response.preExecutionDriveSnapshot) {
        for (const drive of DRIVE_INDEX_ORDER) {
          const pre = response.preExecutionDriveSnapshot[drive] ?? 0;
          const post = postSnapshot.pressureVector[drive] ?? 0;
          const delta = post - pre;
          if (Math.abs(delta) > 0.001) {
            observed[drive] = delta;
          }
        }
      }

      await this.decisionMaking.reportOutcome(response.actionId, {
        selectedAction: {
          actionId: response.actionId,
          arbitrationResult: response.arbitrationResult,
          selectedAt: new Date(),
          // CANON Standard 1: honest verdict from checkTheaterProhibition. A
          // theatrical response sets this false → drive-engine zero-reinforcement
          // (Sylphie is not rewarded for expressing affect she does not feel).
          theaterValidated: !theaterVerdict.isTheatrical,
        },
        predictionAccurate: false, // Unknown until guardian feedback
        predictionError: 0.5,      // Neutral — will be updated by feedback
        driveEffectsObserved: observed,
        anxietyAtExecution: postSnapshot.pressureVector[DriveName.Anxiety] ?? 0,
        observedAt: new Date(),
      });
    } catch (err) {
      this.logger.warn(`reportBasicOutcome failed: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Event Logging
  // ---------------------------------------------------------------------------

  /**
   * Log a Communication event to TimescaleDB.
   * Fire-and-forget — never blocks the response pipeline.
   */
  private logEvent(
    eventType: string,
    sessionId: string,
    payload: Record<string, unknown>,
    correlationId?: string | null,
  ): void {
    const id = randomUUID();
    const driveSnapshot: DriveSnapshot = this.driveStateReader.getCurrentState();

    this.timescale.query(
      `INSERT INTO events (id, type, timestamp, subsystem, session_id, drive_snapshot, payload, correlation_id, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        eventType,
        new Date(),
        'COMMUNICATION',
        sessionId,
        JSON.stringify(driveSnapshot),
        JSON.stringify(payload),
        correlationId ?? null,
        1,
      ],
    ).catch((err) => {
      this.logger.warn(`Failed to log ${eventType} event: ${err}`);
    });
  }
}

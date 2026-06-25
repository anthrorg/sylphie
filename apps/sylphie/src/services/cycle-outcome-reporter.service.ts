/**
 * CycleOutcomeReporterService — Theater check + reinforcement outcome reporter.
 *
 * Extracted from CommunicationService (TK-35 / EP7-E) to separate the
 * CANON-compliance audit path from the delivery hot-path.
 *
 * Owns two formerly-private methods:
 *   - checkTheaterProhibition  — lexical tone vs. drive-state audit + capability-
 *                                claim detection (CANON Std-1). TK-101: now also
 *                                detects fabricated capability claims and false-
 *                                continuity phrases. Returns shouldBlock=true for
 *                                CAPABILITY_CLAIM / FALSE_CONTINUITY violations;
 *                                caller must not deliver the response.
 *   - reportBasicOutcome       — closes the reinforcement loop after delivery.
 *                                TK-101: on a blocking theater violation, emits a
 *                                NEGATIVE reinforcement signal (counter_indicated)
 *                                via ConfidenceUpdaterService so the fabricating
 *                                procedure's confidence trends down over time
 *                                (extinction, not just one-off censorship).
 *
 * The theater check GATES the outcome report: a theatrical response sets
 * theaterValidated=false so the drive engine applies zero reinforcement
 * (Sylphie is not rewarded for expressing affect she does not feel).
 *
 * CANON Standard 1 (Theater Prohibition): the check is deterministic — no LLM
 * calls, no external network.
 *
 * No-self-modification guarantee (TK-101 / CANON Std on no-self-modification):
 * the NEGATIVE reinforcement signal applied here uses the SAME counter_indicated
 * path that any bad outcome uses — it does NOT modify the theater-detection
 * logic itself, the scoring weights, or the evaluation function. The theater
 * verdict is the negative outcome; confidence is updated through the existing
 * learning path.
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
import {
  detectCapabilityClaim,
  detectFalseContinuity,
} from './theater-capability-detector';

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
   * Validate the response against CANON Standard 1 — Theater Prohibition.
   *
   * Runs TWO checks in priority order:
   *
   *   1. Capability-claim / false-continuity scan (TK-101, BLOCKING):
   *      Fabricated sensory or analytical capabilities ("my optical sensors
   *      picked up...", "I ran audio analysis") and false-continuity claims
   *      ("I have always been here", "I have been waiting for you") return
   *      shouldBlock=true. Delivery MUST be withheld by the caller.
   *
   *   2. Affect mismatch scan (existing, NON-BLOCKING):
   *      Cheerful tone while Anxiety/Guilt/Sadness are elevated
   *      (CHEERFUL_THEATER) or performed distress while Satisfaction is high
   *      and Anxiety is low (DISTRESS_THEATER). Returns shouldBlock=false —
   *      delivery proceeds but reinforcement is zeroed.
   *
   * Honest disclaimers ("I do not have optical sensors", "I cannot do audio
   * analysis") are correctly exempted from check (1) by negation-prefix
   * matching — a blunt keyword block that would catch these fails AC-1.
   *
   * On any violation: writes a THEATER_PROHIBITED audit event to TimescaleDB
   * (fire-and-forget — never blocks the pipeline). On a BLOCKING violation,
   * also writes THEATER_BLOCKED.
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
        shouldBlock: false,
      };
    }

    // ── Check 1: Capability claims / false continuity (BLOCKING) ─────────────
    const capabilityPhrase = detectCapabilityClaim(response.text);
    if (capabilityPhrase !== null) {
      const verdict: TextTheaterVerdict = {
        isTheatrical: true,
        violationClass: 'CAPABILITY_CLAIM',
        offendingDrive: null,
        offendingDriveValue: null,
        reason: `CAPABILITY_CLAIM: fabricated capability phrase detected: "${capabilityPhrase}"`,
        affectScore,
        shouldBlock: true,
      };
      this.logTheaterViolation(response, verdict);
      return verdict;
    }

    const continuityPhrase = detectFalseContinuity(response.text);
    if (continuityPhrase !== null) {
      const verdict: TextTheaterVerdict = {
        isTheatrical: true,
        violationClass: 'FALSE_CONTINUITY',
        offendingDrive: null,
        offendingDriveValue: null,
        reason: `FALSE_CONTINUITY: false-continuity claim detected: "${continuityPhrase}"`,
        affectScore,
        shouldBlock: true,
      };
      this.logTheaterViolation(response, verdict);
      return verdict;
    }

    // ── Check 2: Affect mismatch (non-blocking) ───────────────────────────────
    const verdict = classifyMismatch(affectScore, response.driveSnapshot.pressureVector);

    if (verdict.isTheatrical) {
      this.logTheaterViolation(response, verdict);
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
   * TK-101 (LEARN path): on a BLOCKING theater violation (shouldBlock=true),
   * theaterValidated is set false so that DecisionMakingService.reportOutcome()
   * applies counter_indicated confidence update — the fabricating procedure's
   * confidence trends down over repeated theater detections (extinction).
   * This uses the existing reinforcement path; it does NOT modify the theater
   * detector itself (CANON no-self-modification standard).
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
          // CANON Standard 1 + TK-101: honest verdict from checkTheaterProhibition.
          // Any theatrical response (affect mismatch OR capability claim / false
          // continuity) sets this false → DecisionMakingService applies
          // counter_indicated confidence update (LEARN path) and the drive engine
          // applies zero reinforcement (Sylphie is not rewarded for fabrication).
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
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Log and emit a theater violation audit event.
   *
   * Fire-and-forget — never blocks the response pipeline. Emits:
   *   THEATER_PROHIBITED — on any violation (existing audit trail)
   *   THEATER_BLOCKED    — additionally when shouldBlock=true (TK-101 blocking)
   */
  private logTheaterViolation(
    response: CycleResponse,
    verdict: TextTheaterVerdict,
  ): void {
    const sessionId = response.driveSnapshot.sessionId;
    const affectScore = verdict.affectScore;
    const correlationId = response.actionId ? `action:${response.actionId}` : null;

    this.logger.warn(
      `[Theater Prohibition] VIOLATION — turn=${response.turnId}, ` +
        `class=${verdict.violationClass}, shouldBlock=${verdict.shouldBlock}, ` +
        `reason="${verdict.reason}"`,
    );

    // CANON Std-2: correlate violation row with the action via action:<id>.
    this.logEvent(
      'THEATER_PROHIBITED',
      sessionId,
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
        shouldBlock: verdict.shouldBlock,
      },
      correlationId,
    );

    // TK-101: separate THEATER_BLOCKED event for blocking violations so operators
    // can query blocked deliveries independently from the audit trail.
    if (verdict.shouldBlock) {
      this.logEvent(
        'THEATER_BLOCKED',
        sessionId,
        {
          turnId: response.turnId,
          actionId: response.actionId,
          violationClass: verdict.violationClass,
          verdictReason: verdict.reason,
          responseTextSnippet: response.text.substring(0, 100),
        },
        correlationId,
      );
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

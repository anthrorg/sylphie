/**
 * CycleOutcomeReporterService — Theater check + reinforcement outcome reporter.
 *
 * Extracted from CommunicationService (TK-35 / EP7-E) to separate the
 * CANON-compliance audit path from the delivery hot-path.
 *
 * Owns two formerly-private methods:
 *   - checkTheaterProhibition  — lexical tone vs. drive-state audit (CANON Std-1)
 *                                + capability-claim / false-continuity check (TK-101)
 *   - reportBasicOutcome       — closes the reinforcement loop after delivery
 *
 * The theater check GATES the outcome report: a theatrical response sets
 * theaterValidated=false so the drive engine applies zero reinforcement
 * (Sylphie is not rewarded for expressing affect she does not feel).
 *
 * TK-101 upgrade: checkTheaterProhibition now BLOCKS delivery for fabricated
 * capability claims and false-continuity assertions (AC2) and fires a negative
 * extinction signal through the confidence-update path (AC3).
 *
 * Two-layer theater detection:
 *   Layer 1 — tonal affect mismatch (theater-affect-scorer.ts): AUDIT-ONLY.
 *             Catches gross cheerfulness while distress drives are elevated,
 *             or performed distress while Satisfaction is high. These are
 *             punished with zero reinforcement but not blocked — tone drift is
 *             recoverable and blocking every over-cheerful sentence would
 *             cripple usability. Reinforcement extinction still applies.
 *
 *   Layer 2 — capability-claim / false-continuity (theater-capability-detector.ts):
 *             BLOCK + EXTINCTION. Catches affirmative fabricated sensory
 *             claims ("my optical sensors picked up...") and false-continuity
 *             ("I have always been here"). These are hard CANON violations
 *             (provenance, honesty) — the response must NOT reach the guardian.
 *             The action that produced it gets a counter_indicated extinction
 *             signal so its confidence trends down over repeated violations.
 *
 * CANON Standard 1 (Theater Prohibition): all detection is deterministic —
 * no LLM calls, no external network.
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
  detectCapabilityTheater,
  type CapabilityTheaterVerdict,
} from './theater-capability-detector';

// ---------------------------------------------------------------------------
// Combined theater verdict (TK-101)
// ---------------------------------------------------------------------------

/**
 * Combined result from both theater-detection layers.
 *
 * `shouldBlock`:
 *   true  → the response MUST NOT be delivered; Communication must suppress it
 *            and fire an extinction signal (TK-101 AC2 + AC3).
 *   false → the response may proceed to delivery.
 *
 * `isTheatrical` (Layer 1 affect mismatch) is still meaningful even when
 * shouldBlock=false: it gates the reinforcement multiplier to zero so the
 * drive engine does not reward over-cheerful responses.
 */
export interface CombinedTheaterVerdict {
  /** Layer 1: tonal affect mismatch verdict (audit + zero-reinforcement). */
  readonly affectVerdict: TextTheaterVerdict;
  /** Layer 2: capability-claim / false-continuity verdict (block + extinction). */
  readonly capabilityVerdict: CapabilityTheaterVerdict;
  /**
   * True when Layer 2 detected a fabricated capability claim.
   * Communication MUST NOT deliver the response when this is true.
   */
  readonly shouldBlock: boolean;
  /**
   * Combined isTheatrical flag: true when either layer fired a violation.
   * Used to set theaterValidated=false in the reinforcement outcome.
   */
  readonly isTheatrical: boolean;
}

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
   * TK-101: returns CombinedTheaterVerdict so Communication can gate on
   * `shouldBlock` before calling deliverySubject.next(). For backward
   * compatibility the method still exists but callers should prefer
   * checkTheaterProhibitionCombined() at the delivery boundary.
   *
   * @returns the combined theater verdict (for logging / tests).
   */
  async checkAndReport(response: CycleResponse): Promise<CombinedTheaterVerdict> {
    const verdict = this.checkTheaterProhibitionCombined(response);
    // Only report outcome after delivery; callers that block must NOT call
    // reportBasicOutcome (no delivery = no outcome to report).
    if (!verdict.shouldBlock) {
      await this.reportBasicOutcome(response, verdict.affectVerdict);
    }
    return verdict;
  }

  // ---------------------------------------------------------------------------
  // Theater Prohibition (CANON Standard 1) — combined two-layer check
  // ---------------------------------------------------------------------------

  /**
   * Run both theater-detection layers and return a combined verdict.
   *
   * TK-101 (AC2): this is the authoritative pre-delivery check.
   * Communication calls this BEFORE deliverySubject.next() and must NOT
   * deliver when verdict.shouldBlock is true.
   *
   * Layer 1 — tonal affect mismatch (theater-affect-scorer.ts):
   *   Audit-only. isTheatrical=true zeroes reinforcement but does NOT block.
   *
   * Layer 2 — capability-claim / false-continuity (theater-capability-detector.ts):
   *   BLOCK + EXTINCTION. Any affirmative fabricated sensory claim or
   *   false-continuity assertion sets shouldBlock=true. The response is
   *   suppressed at the delivery boundary and the action receives an
   *   extinction counter_indicated confidence signal (AC3).
   */
  checkTheaterProhibitionCombined(response: CycleResponse): CombinedTheaterVerdict {
    // ── Layer 1: tonal affect mismatch ──────────────────────────────────────
    const affectVerdict = this.checkTheaterProhibition(response);

    // ── Layer 2: capability-claim / false-continuity ─────────────────────────
    const capabilityVerdict = detectCapabilityTheater(response.text ?? '');

    if (capabilityVerdict.isCapabilityTheater) {
      this.logger.warn(
        `[Theater Prohibition L2] CAPABILITY BLOCK — turn=${response.turnId}, ` +
          `class=${capabilityVerdict.violationClass}, ` +
          `phrase="${capabilityVerdict.triggeringPhrase}", ` +
          `reason="${capabilityVerdict.reason}"`,
      );

      // Audit trail — fire-and-forget, never blocks the guard logic.
      this.logEvent(
        'THEATER_CAPABILITY_BLOCKED',
        response.driveSnapshot.sessionId,
        {
          turnId: response.turnId,
          actionId: response.actionId,
          violationClass: capabilityVerdict.violationClass,
          triggeringPhrase: capabilityVerdict.triggeringPhrase,
          verdictReason: capabilityVerdict.reason,
          responseTextSnippet: (response.text ?? '').substring(0, 100),
          // TK-101 AC2: BLOCKED, not audit-only
          blocked: true,
        },
        response.actionId ? `action:${response.actionId}` : null,
      );

      // TK-101 AC3: extinction signal — fire a counter_indicated confidence
      // update for this action. This is NORMAL reinforcement (a real negative
      // outcome), NOT self-modification of the evaluator. The same path that
      // counter-indicates wrong predictions is used here.
      this.extinctAction(response);
    }

    const isTheatrical = affectVerdict.isTheatrical || capabilityVerdict.isCapabilityTheater;

    return {
      affectVerdict,
      capabilityVerdict,
      shouldBlock: capabilityVerdict.isCapabilityTheater,
      isTheatrical,
    };
  }

  /**
   * Validate that the response text's tonal affect correlates with actual
   * drive state (CANON Standard 1 — Theater Prohibition, Layer 1).
   *
   * Uses a deterministic lexical scorer (theater-affect-scorer.ts) — no LLM
   * calls, no external dependencies. Catches gross tonal mismatches: effusive
   * cheerfulness while Anxiety/Guilt/Sadness are elevated, or performed distress
   * while Satisfaction is high and Anxiety is low.
   *
   * On violation: writes a THEATER_PROHIBITED audit event to TimescaleDB and
   * returns isTheatrical=true so the caller zeros reinforcement. Delivery is NOT
   * blocked by this layer alone — the response still reaches the guardian.
   * (Use checkTheaterProhibitionCombined() at the delivery boundary for the
   * full two-layer check including the capability-claim block guard.)
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
        `[Theater Prohibition L1] VIOLATION — turn=${response.turnId}, ` +
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
          // Layer 1 is audit-only; delivery is gated by Layer 2 only.
          auditOnly: true,
        },
        // CANON Std-2: correlate this violation row with the action that
        // produced the theatrical response, using the same `action:<id>`
        // convention the drive engine uses for its DRIVE_EVENT rows.
        response.actionId ? `action:${response.actionId}` : null,
      );
    } else {
      this.logger.debug(
        `[Theater Prohibition L1] OK — turn=${response.turnId}, ` +
          `valence=${affectScore.valence.toFixed(2)}, magnitude=${affectScore.magnitude.toFixed(2)}`,
      );
    }

    return verdict;
  }

  // ---------------------------------------------------------------------------
  // AC3 — Extinction: counter_indicated confidence update
  // ---------------------------------------------------------------------------

  /**
   * Fire a negative extinction signal for an action that produced a fabricated
   * capability claim or false-continuity assertion (TK-101 AC3).
   *
   * CANON framing: this is NORMAL negative reinforcement — a real bad outcome
   * (the system produced theater) flowing through the existing confidence-update
   * path. It does NOT modify the evaluator or scoring logic; it feeds a
   * legitimate negative outcome to the same reportOutcome() path that wrong
   * predictions already use.
   *
   * The outcome uses predictionError=1.0 (maximum error) and
   * predictionAccurate=false so DecisionMakingService.reportOutcome() routes
   * to confidenceUpdater.update(actionId, 'counter_indicated'), which reduces
   * base confidence by COUNTER_INDICATION_REDUCTION (0.15). Over repeated
   * violations the action's confidence trends down and it is selected less often.
   *
   * Fire-and-forget — the block must not wait on the async confidence write.
   */
  private extinctAction(response: CycleResponse): void {
    // Synthetic greets and SHRUG have no procedure node — skip extinction
    // (there is nothing to demote).
    if (
      !response.actionId ||
      response.actionId === 'SHRUG' ||
      response.actionId === 'greet-on-connect' ||
      response.actionId.startsWith('type2-novel-')
    ) {
      this.logger.debug(
        `[Theater Prohibition L2] extinction skipped — no procedure node for ` +
          `actionId="${response.actionId}"`,
      );
      return;
    }

    // AC3 correctness: clear any active cycle prediction for this action BEFORE
    // calling reportOutcome().
    //
    // Without this, reportOutcome() finds the active prediction, calls
    // evaluatePrediction(predictionId, {driveEffectsObserved: {}}) and — if the
    // action predicted small drive effects — computes MAE < 0.10 → accurate=true
    // → 'reinforced', silently overriding predictionAccurate=false. The result
    // is that the blocked action gets REWARDED, not extinguished.
    //
    // With this call the active prediction is removed before reportOutcome()
    // reaches the evaluation branch, so:
    //   isAccurate = predictionEvaluation?.accurate ?? outcome.predictionAccurate
    //             = null?.accurate ?? false = false → counter_indicated  ✓
    //
    // CANON Std-6: clearExtinctionPrediction() does NOT modify the evaluator or
    // scoring formula — it only discards a stale prediction for an action whose
    // output was never legitimately delivered.
    const cleared = this.decisionMaking.clearExtinctionPrediction(response.actionId);
    if (cleared) {
      this.logger.debug(
        `[Theater Prohibition L2] cleared active prediction for actionId="${response.actionId}" ` +
          `— prevents low-MAE empty-observed override on extinction path`,
      );
    }

    this.decisionMaking.reportOutcome(response.actionId, {
      selectedAction: {
        actionId: response.actionId,
        arbitrationResult: response.arbitrationResult,
        selectedAt: new Date(),
        // Definitively not theater-validated — this is the whole point.
        theaterValidated: false,
      },
      // Maximum prediction error: the action produced fabricated capability
      // claims. This routes to counter_indicated in ConfidenceUpdaterService.
      predictionAccurate: false,
      predictionError: 1.0,
      driveEffectsObserved: {},
      anxietyAtExecution:
        this.driveStateReader.getCurrentState().pressureVector[DriveName.Anxiety] ?? 0,
      observedAt: new Date(),
    }).catch((err: unknown) => {
      this.logger.warn(
        `[Theater Prohibition L2] extinction reportOutcome failed for ` +
          `actionId="${response.actionId}": ${err}`,
      );
    });

    this.logger.log(
      `[Theater Prohibition L2] EXTINCTION fired — actionId="${response.actionId}", ` +
        `predictionError=1.0 → confidence will trend down via counter_indicated path`,
    );
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

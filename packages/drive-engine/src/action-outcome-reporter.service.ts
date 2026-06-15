/**
 * Real implementation of IActionOutcomeReporter.
 *
 * Converts action outcomes and software metrics to IPC message format and
 * enqueues them for asynchronous delivery to the Drive Engine child process.
 *
 * Both methods are void (fire-and-forget). Messages are queued via OutcomeQueue
 * and flushed asynchronously (setImmediate). The Drive Engine applies outcomes
 * on the next tick.
 *
 * CANON §Drive Isolation: This service is the sole write path to the child
 * process input. It does not modify drive state, rules, or the evaluation
 * function — it only sends observational data (outcomes, metrics).
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  IActionOutcomeReporter,
  SoftwareMetrics,
} from './interfaces/drive-engine.interfaces';
import {
  ActionOutcomePayload,
  SoftwareMetricsPayload,
  SelfAssessmentPayload,
  DriveIPCMessageType,
  INITIAL_DRIVE_STATE,
  verboseFor,
  estimateLlmCostUsd,
  resolveLlmPricingFromEnv,
  type LlmPricingRates,
} from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');
import { DriveName } from '@sylphie/shared';
import { ProvenanceSource } from '@sylphie/shared';
import { WsChannelService } from './ipc-channel/ws-channel.service';
import { OutcomeQueue } from './action-outcome-reporter/outcome-queue';
import { DriveReaderService } from './drive-reader.service';

@Injectable()
export class ActionOutcomeReporterService implements IActionOutcomeReporter {
  private readonly logger = new Logger(ActionOutcomeReporterService.name);
  private outcomeQueue: OutcomeQueue;

  /**
   * LLM pricing rates resolved once from the environment (same env vars as the
   * Supervisor's CostTrackerService: DEEPSEEK_INPUT/OUTPUT_PRICE_PER_M). Used to
   * convert per-window token counts into a USD cost estimate for the
   * SoftwareMetricsPayload the Cognitive Effort drive consumes.
   */
  private readonly pricingRates: LlmPricingRates;

  constructor(
    private wsChannel: WsChannelService,
    private driveReader: DriveReaderService,
  ) {
    // Resolve LLM pricing once at construction. If the operator hasn't set the
    // pricing env vars we fall back to documented DeepSeek defaults — but we
    // log it loudly here so a fallback rate is never mistaken for configured
    // pricing (CANON theater prohibition — no silent defaults).
    this.pricingRates = resolveLlmPricingFromEnv();
    if (this.pricingRates.usedDefault) {
      this.logger.warn(
        'LLM pricing env vars (DEEPSEEK_INPUT_PRICE_PER_M / ' +
          'DEEPSEEK_OUTPUT_PRICE_PER_M) not fully configured — using documented ' +
          `DeepSeek defaults ($${this.pricingRates.inputPricePerM}/M in, ` +
          `$${this.pricingRates.outputPricePerM}/M out) for cost estimation.`,
      );
    } else {
      this.logger.log(
        `LLM cost estimation rates: $${this.pricingRates.inputPricePerM}/M in, ` +
          `$${this.pricingRates.outputPricePerM}/M out (operator-configured).`,
      );
    }

    // Initialize the queue with a send function that dispatches via WebSocket
    this.outcomeQueue = new OutcomeQueue(
      (message) => {
        try {
          this.wsChannel.send(message);
          return true;
        } catch (error) {
          this.logger.warn(
            `Send failed (will retry): ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      },
      {
        maxQueueSize: 1000,
        maxRetries: 3,
        baseRetryDelayMs: 10,
      },
    );
  }

  /**
   * Report an action outcome for drive evaluation via IPC.
   *
   * Converts the outcome parameters to ActionOutcomePayload format and enqueues
   * for delivery to the Drive Engine. The Theater Prohibition check data is
   * included so the Drive Engine can apply zero-reinforcement if isTheatrical
   * is true.
   *
   * @param outcome - Outcome payload. actionId is required (CANON Standard 2).
   */
  reportOutcome(outcome: {
    readonly actionId: string;
    readonly correlationId?: string;
    readonly actionType: string;
    readonly success: boolean;
    readonly metadata?: ActionOutcomePayload['metadata'];
    readonly feedbackSource: ProvenanceSource;
    readonly theaterCheck: {
      readonly expressionType: 'pressure' | 'relief' | 'none';
      readonly correspondingDrive: DriveName | null;
      readonly driveValue: number | null;
      readonly isTheatrical: boolean;
    };
    readonly predictionData?: {
      readonly predictionId: string;
      readonly predictedValue: number;
      readonly actualValue: number;
    };
    readonly informationGainMetrics?: {
      readonly newNodes: number;
      readonly confidenceDeltas: number;
      readonly resolvedErrors: number;
      readonly source: 'WKG_DIFF' | 'UNVERIFIED';
    };
    readonly socialCommentTimestamp?: number;
  }): void {
    // Map success boolean to outcome enum
    const outcomeValue = outcome.success ? 'positive' : 'negative';

    // Map ProvenanceSource to IPC feedbackSource format
    const feedbackSource = this.mapProvenanceToFeedbackSource(
      outcome.feedbackSource,
    );

    // Build the theater check payload
    const driveValueAtExpression = outcome.theaterCheck.driveValue ?? 0;

    const driveForTheater =
      outcome.theaterCheck.correspondingDrive ?? DriveName.SystemHealth;

    // Construct the ActionOutcomePayload
    const payload: ActionOutcomePayload = {
      actionId: outcome.actionId,
      // CANON Std-2: propagate the ORIGIN correlation id verbatim when the
      // caller minted one at the action origin. Omitted → the Drive Engine
      // derives a deterministic `action:<actionId>` at ingestion (no loss).
      correlationId: outcome.correlationId,
      actionType: outcome.actionType,
      outcome: outcomeValue,
      metadata: outcome.metadata,
      feedbackSource,
      theaterCheck: {
        expressionType: outcome.theaterCheck.expressionType,
        driveValueAtExpression,
        drive: driveForTheater,
        isTheatrical: outcome.theaterCheck.isTheatrical,
      },
      anxietyAtExecution: this.driveReader.getCurrentState().pressureVector[DriveName.Anxiety] ?? 0,
      predictionData: outcome.predictionData,
      // Curiosity information-gain (§A.14). Threaded verbatim from the caller's
      // WkgDiffService result — never synthesized here. Omitted (undefined) for
      // non-WKG actions, in which case the drive grants zero curiosity relief.
      informationGainMetrics: outcome.informationGainMetrics,
      socialCommentTimestamp: outcome.socialCommentTimestamp,
    };

    vlog('outcome reported', {
      actionId: outcome.actionId,
      actionType: outcome.actionType,
      success: outcome.success,
      feedbackSource: feedbackSource,
      metadata: outcome.metadata,
      hasPredictionData: !!outcome.predictionData,
      infoGainSource: outcome.informationGainMetrics?.source,
    });

    // Enqueue for async delivery
    this.outcomeQueue.enqueueOutcome(payload);
  }

  /**
   * Report software metrics for Type 2 cognitive effort cost pressure.
   *
   * Converts SoftwareMetrics to SoftwareMetricsPayload format and enqueues for
   * delivery to the Drive Engine. cognitiveEffortPressure is load-bearing — it
   * creates the drive pressure that incentivizes Type 1 graduation.
   *
   * @param metrics - LLM usage metrics.
   */
  reportMetrics(metrics: SoftwareMetrics): void {
    const now = new Date();

    // --- Real cost: token count × configured model pricing -------------------
    // Prefer the caller's prompt/completion split (priced at different rates).
    // When the caller can't split tokens, price the whole tokenCount at the
    // input rate — a documented approximation, never a silent $0.
    const hasTokenSplit =
      metrics.promptTokens !== undefined || metrics.completionTokens !== undefined;
    const inputTokens = hasTokenSplit
      ? metrics.promptTokens ?? 0
      : metrics.tokenCount;
    const outputTokens = hasTokenSplit ? metrics.completionTokens ?? 0 : 0;
    const estimatedCostUsd = estimateLlmCostUsd(
      inputTokens,
      outputTokens,
      this.pricingRates,
    );

    // --- Real window boundaries: thread from the caller ----------------------
    // windowStartAt is the time the caller began accumulating LLM usage. If the
    // caller did not supply it we fall back to `now`, but flag it loudly: a
    // start==end window makes temporal analysis impossible, so a missing window
    // is a wiring gap, not an acceptable default.
    const windowEndAt = metrics.windowEndAt ?? now;
    let windowStartAt = metrics.windowStartAt;
    if (windowStartAt === undefined) {
      windowStartAt = windowEndAt;
      this.logger.warn(
        'SoftwareMetrics.windowStartAt not supplied by caller — falling back to ' +
          'flush time (windowStartAt == windowEndAt). Temporal LLM-usage analysis ' +
          'is degraded until the caller threads the real measurement window.',
      );
    }

    // Construct the SoftwareMetricsPayload
    const payload: SoftwareMetricsPayload = {
      llmCallCount: metrics.llmCallCount,
      llmLatencyMs: metrics.llmLatencyMs,
      cognitiveEffortPressure: metrics.cognitiveEffortPressure,
      tokenCount: metrics.tokenCount,
      estimatedCostUsd,
      windowStartAt,
      windowEndAt,
    };

    vlog('metrics reported', {
      llmCallCount: metrics.llmCallCount,
      llmLatencyMs: metrics.llmLatencyMs,
      cognitiveEffortPressure: metrics.cognitiveEffortPressure,
      tokenCount: metrics.tokenCount,
      estimatedCostUsd,
      windowMs: windowEndAt.getTime() - windowStartAt.getTime(),
    });

    // Enqueue for async delivery
    this.outcomeQueue.enqueueMetrics(payload);
  }

  /**
   * Reset the Drive Engine's in-memory state to INITIAL_DRIVE_STATE.
   *
   * Sends a SESSION_START message with a fresh session and cold-start drive
   * values. The Drive Engine creates a new DriveStateManager, zeroing all
   * accumulated pressure and relief.
   */
  resetDriveState(): void {
    const now = new Date();
    const sessionId = `reset-${now.toISOString()}`;

    this.wsChannel.send({
      type: DriveIPCMessageType.SESSION_START,
      payload: {
        sessionId,
        initialDriveState: {
          pressureVector: { ...INITIAL_DRIVE_STATE },
          timestamp: now,
          tickNumber: 0,
          driveDeltas: Object.fromEntries(
            Object.keys(INITIAL_DRIVE_STATE).map((k) => [k, 0]),
          ) as any,
          ruleMatchResult: { ruleId: null, eventType: 'SESSION_START', matched: false },
          totalPressure: 0,
          sessionId,
        },
      },
      timestamp: now,
    });

    this.logger.warn(`Drive state reset to INITIAL_DRIVE_STATE (session: ${sessionId})`);
  }

  /**
   * Push a KG(Self) self-assessment snapshot to the Drive Engine.
   *
   * Phase 4 Wave 2 cluster 3a — Ticket 1 (event-judge model). Sent directly
   * over the WebSocket channel, NOT through the OutcomeQueue: the queue only
   * carries ACTION_OUTCOME / SOFTWARE_METRICS, and a self-assessment is neither
   * (it has no actionId, no theaterCheck, no reinforcement). The drive caches
   * it on receipt (CachedSelfKgReader.ingest) and reads it on its own
   * self-evaluation cadence.
   *
   * An empty payload (empty arrays) is valid and is still sent — the drive's
   * reader flips ready on the first push and self-heals neutrally thereafter.
   *
   * Fire-and-forget. WsChannelService.send() queues internally when the socket
   * is not yet open, so a push before the channel connects is not lost.
   */
  pushSelfAssessment(payload: SelfAssessmentPayload): void {
    this.wsChannel.send({
      type: DriveIPCMessageType.SELF_ASSESSMENT,
      payload,
      timestamp: new Date(),
    });

    vlog('self-assessment pushed', {
      assessedAt: payload.assessedAt,
      capabilities: payload.capabilities.length,
      drivePatterns: payload.drivePatterns.length,
      predictionAccuracy: payload.predictionAccuracy.length,
      provenance: payload.provenance,
    });
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Map ProvenanceSource to the IPC feedback source format.
   *
   * CANON Standard 5 (Guardian Asymmetry): Guardian feedback gets 2x confirmation
   * or 3x correction weight. This mapping is the bridge between the local provenance
   * types and the IPC format.
   *
   * @param provenance - The source of the feedback
   * @returns The IPC feedbackSource enum value
   */
  private mapProvenanceToFeedbackSource(
    provenance: ProvenanceSource,
  ): 'guardian_confirmation' | 'guardian_correction' | 'algorithmic' {
    switch (provenance) {
      case 'GUARDIAN':
      case 'TAUGHT_PROCEDURE':
      case 'GUARDIAN_APPROVED_INFERENCE':
        // Guardian feedback is treated as confirmation by default
        // (correction would need explicit indication in outcome context)
        return 'guardian_confirmation';

      case 'SENSOR':
      case 'LLM_GENERATED':
      case 'INFERENCE':
      case 'BEHAVIORAL_INFERENCE':
      case 'SYSTEM_BOOTSTRAP':
        // All non-guardian sources are algorithmic
        return 'algorithmic';

      default:
        // Fallback for any unexpected value
        return 'algorithmic';
    }
  }
}

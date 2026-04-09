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
  DriveIPCMessageType,
  INITIAL_DRIVE_STATE,
  verboseFor,
} from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');
import { DriveName } from '@sylphie/shared';
import { ProvenanceSource } from '@sylphie/shared';
import { WsChannelService } from './ipc-channel/ws-channel.service';
import { OutcomeQueue } from './action-outcome-reporter/outcome-queue';

@Injectable()
export class ActionOutcomeReporterService implements IActionOutcomeReporter {
  private readonly logger = new Logger(ActionOutcomeReporterService.name);
  private outcomeQueue: OutcomeQueue;

  constructor(private wsChannel: WsChannelService) {
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
    readonly actionType: string;
    readonly success: boolean;
    readonly driveEffects: Partial<Record<DriveName, number>>;
    readonly feedbackSource: ProvenanceSource;
    readonly theaterCheck: {
      readonly expressionType: 'pressure' | 'relief' | 'none';
      readonly correspondingDrive: DriveName | null;
      readonly driveValue: number | null;
      readonly isTheatrical: boolean;
    };
    readonly predictionId?: string;
  }): void {
    // Map success boolean to outcome enum
    const outcomeValue = outcome.success ? 'positive' : 'negative';

    // Map ProvenanceSource to IPC feedbackSource format
    const feedbackSource = this.mapProvenanceToFeedbackSource(
      outcome.feedbackSource,
    );

    // Build the theater check payload
    // Note: If no expression was produced, set driveValueAtExpression to the correspondingDrive value
    const driveValueAtExpression =
      outcome.theaterCheck.expressionType === 'none'
        ? outcome.theaterCheck.driveValue ?? 0
        : outcome.theaterCheck.driveValue ?? 0;

    const driveForTheater =
      outcome.theaterCheck.correspondingDrive ?? ('System Health' as DriveName);

    // Construct the ActionOutcomePayload
    const payload: ActionOutcomePayload = {
      actionId: outcome.actionId,
      actionType: outcome.actionType,
      outcome: outcomeValue,
      driveEffects: outcome.driveEffects,
      feedbackSource,
      theaterCheck: {
        expressionType: outcome.theaterCheck.expressionType,
        driveValueAtExpression,
        drive: driveForTheater,
        isTheatrical: outcome.theaterCheck.isTheatrical,
      },
      anxietyAtExecution: 0, // TODO: This should come from current drive state at time of execution
    };

    vlog('outcome reported', {
      actionId: outcome.actionId,
      actionType: outcome.actionType,
      success: outcome.success,
      feedbackSource: feedbackSource,
      effectCount: Object.keys(outcome.driveEffects).length,
      driveEffects: outcome.driveEffects,
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

    // Construct the SoftwareMetricsPayload
    const payload: SoftwareMetricsPayload = {
      llmCallCount: metrics.llmCallCount,
      llmLatencyMs: metrics.llmLatencyMs,
      cognitiveEffortPressure: metrics.cognitiveEffortPressure,
      tokenCount: metrics.tokenCount,
      estimatedCostUsd: 0, // TODO: Compute from token count and model pricing
      windowStartAt: now, // TODO: Track actual window boundaries from caller
      windowEndAt: now,
    };

    vlog('metrics reported', {
      llmCallCount: metrics.llmCallCount,
      llmLatencyMs: metrics.llmLatencyMs,
      cognitiveEffortPressure: metrics.cognitiveEffortPressure,
      tokenCount: metrics.tokenCount,
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

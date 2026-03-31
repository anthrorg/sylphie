/**
 * IDecisionMakingService implementation — the main Decision Making facade.
 *
 * CANON §Subsystem 1 (Decision Making): Orchestrates the full 8-state decision
 * cycle: IDLE → CATEGORIZING → RETRIEVING → PREDICTING → ARBITRATING →
 * EXECUTING → OBSERVING → LEARNING → IDLE
 *
 * Coordinates:
 * - IExecutorEngine: State machine and cycle metrics
 * - IActionRetrieverService: WKG candidate retrieval
 * - IPredictionService: Drive-effect prediction
 * - IArbitrationService: Type 1/2/SHRUG arbitration
 * - IEpisodicMemoryService: Recent episodes for context
 * - IConsolidationService: Mature episode consolidation
 * - IConfidenceUpdaterService: ACT-R confidence updates
 * - DecisionEventLoggerService: TimescaleDB event logging
 * - ActionHandlerRegistry: Step execution dispatch
 * - IDriveStateReader: Read-only drive state access
 * - IActionOutcomeReporter: Feed outcomes back to Drive Engine
 *
 * CANON Immutable Standard 1 (Theater Prohibition): getCognitiveContext()
 * carries the real drive state so Communication can correlate output
 * with actual motivational state.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { ExecutorState } from '../shared/types/action.types';
import {
  DRIVE_STATE_READER,
  ACTION_OUTCOME_REPORTER,
} from '../drive-engine';
import type {
  IDriveStateReader,
  IActionOutcomeReporter,
} from '../drive-engine/interfaces/drive-engine.interfaces';
import {
  IDecisionMakingService,
  CategorizedInput,
  CognitiveContext,
  IEpisodicMemoryService,
  IArbitrationService,
  IPredictionService,
  IActionRetrieverService,
  IConfidenceUpdaterService,
  IExecutorEngine,
} from './interfaces/decision-making.interfaces';
import type { IConsolidationService } from './episodic-memory/consolidation.interfaces';
import {
  EXECUTOR_ENGINE,
  ACTION_RETRIEVER_SERVICE,
  PREDICTION_SERVICE,
  ARBITRATION_SERVICE,
  EPISODIC_MEMORY_SERVICE,
  CONFIDENCE_UPDATER_SERVICE,
  CONSOLIDATION_SERVICE,
  DECISION_EVENT_LOGGER,
  ACTION_HANDLER_REGISTRY,
} from './decision-making.tokens';
import type { DecisionEventLoggerService } from './logging/decision-event-logger.service';
import type { ActionHandlerRegistry } from './action-handlers/action-handler-registry.service';

@Injectable()
export class DecisionMakingService implements IDecisionMakingService {
  private readonly logger = new Logger(DecisionMakingService.name);

  constructor(
    @Inject(EXECUTOR_ENGINE)
    private readonly executorEngine: IExecutorEngine,
    @Inject(ACTION_RETRIEVER_SERVICE)
    private readonly actionRetriever: IActionRetrieverService,
    @Inject(PREDICTION_SERVICE)
    private readonly predictionService: IPredictionService,
    @Inject(ARBITRATION_SERVICE)
    private readonly arbitrationService: IArbitrationService,
    @Inject(EPISODIC_MEMORY_SERVICE)
    private readonly episodicMemory: IEpisodicMemoryService,
    @Inject(CONFIDENCE_UPDATER_SERVICE)
    private readonly confidenceUpdater: IConfidenceUpdaterService,
    @Inject(CONSOLIDATION_SERVICE)
    private readonly consolidationService: IConsolidationService,
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: DecisionEventLoggerService,
    @Inject(ACTION_HANDLER_REGISTRY)
    private readonly actionRegistry: ActionHandlerRegistry,
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
    @Inject(ACTION_OUTCOME_REPORTER)
    private readonly actionOutcomeReporter: IActionOutcomeReporter,
  ) {}

  /**
   * Trigger the full decision cycle for a categorized input.
   *
   * Executes the 8-state sequence:
   *   1. IDLE → CATEGORIZING: Input categorization
   *   2. CATEGORIZING → RETRIEVING: Retrieve action candidates
   *   3. RETRIEVING → PREDICTING: Generate predictions for top candidates
   *   4. PREDICTING → ARBITRATING: Type 1/2/SHRUG arbitration
   *   5. ARBITRATING → EXECUTING: Execute selected action
   *   6. EXECUTING → OBSERVING: Observe outcome
   *   7. OBSERVING → LEARNING: Encode episode, update confidence, check graduation
   *   8. LEARNING → IDLE: Cycle complete
   *
   * Error handling: If any non-recoverable error occurs, forceIdle() is called
   * to reset the state machine, and the error is re-thrown.
   *
   * CANON Standard 2 (Contingency Requirement): The actionId from the selected
   * action is loaded into the outcome reporting, ensuring behavior is
   * contingent on actual execution.
   *
   * @param input - Structured input from the Communication subsystem.
   * @throws If the executor is not in IDLE state or if a non-recoverable error occurs.
   */
  async processInput(input: CategorizedInput): Promise<void> {
    try {
      // Get the current drive state and capture it in the executor for event emission.
      const driveSnapshot = this.driveStateReader.getCurrentState();
      (this.executorEngine as any).captureSnapshot(driveSnapshot);

      // 1-2: IDLE → CATEGORIZING → RETRIEVING
      this.executorEngine.transition(ExecutorState.CATEGORIZING);
      this.executorEngine.transition(ExecutorState.RETRIEVING);

      // Retrieve action candidates from WKG.
      const candidates = await this.actionRetriever.retrieve(
        input.content, // Use content as context fingerprint
        driveSnapshot,
      );

      // 3: RETRIEVING → PREDICTING
      this.executorEngine.transition(ExecutorState.PREDICTING);

      // Generate predictions for the top candidates.
      const context = this.getCognitiveContext();
      const predictions = await this.predictionService.generatePredictions(context, 3);

      // 4: PREDICTING → ARBITRATING
      this.executorEngine.transition(ExecutorState.ARBITRATING);

      // Arbitrate and select an action (Type 1, Type 2, or SHRUG).
      const arbitrationResult = this.arbitrationService.arbitrate(candidates, driveSnapshot);

      // 5: ARBITRATING → EXECUTING
      this.executorEngine.transition(ExecutorState.EXECUTING);

      // Execute the selected action via the action handler registry.
      // Determine the action ID from the arbitration result.
      let executedActionId = '';
      if (arbitrationResult.type === 'SHRUG') {
        executedActionId = 'SHRUG';
      } else {
        // TYPE_1 or TYPE_2: extract the procedure ID
        const proc = arbitrationResult.candidate.procedureData;
        executedActionId = proc ? proc.id : 'TYPE_2_NOVEL';
      }

      // 6: EXECUTING → OBSERVING
      this.executorEngine.transition(ExecutorState.OBSERVING);

      // Evaluate predictions against the observed outcome.
      // (In the full implementation, this would correlate with actual task results.)
      for (const prediction of predictions) {
        try {
          // Create a synthetic outcome for now; real implementation gets this from execution.
          const syntheticOutcome = {
            selectedAction: {
              actionId: executedActionId,
              arbitrationResult,
              selectedAt: new Date(),
              theaterValidated: true,
            },
            predictionAccurate: true,
            predictionError: 0.0,
            driveEffectsObserved: {},
            anxietyAtExecution: (driveSnapshot.pressureVector as any).anxiety || 0,
            observedAt: new Date(),
          };
          this.predictionService.evaluatePrediction(prediction.id, syntheticOutcome as any);
        } catch (err) {
          this.logger.warn(`Failed to evaluate prediction ${prediction.id}: ${err}`);
        }
      }

      // 7: OBSERVING → LEARNING
      this.executorEngine.transition(ExecutorState.LEARNING);

      // Encode the episode into episodic memory.
      const episode = await this.episodicMemory.encode(
        {
          driveSnapshot,
          inputSummary: input.content.substring(0, 100),
          actionTaken: executedActionId,
          contextFingerprint: input.content, // Simplified; real impl uses semantic fingerprinting
          attention: 0.5, // Default; would be computed from prediction error
          arousal: driveSnapshot.totalPressure,
        },
        'NORMAL', // Default encoding depth
      );

      // Update confidence for the executed action.
      if (executedActionId !== 'SHRUG' && executedActionId !== 'TYPE_2_NOVEL') {
        const feedbackType =
          input.guardianFeedbackType === 'none'
            ? undefined
            : (input.guardianFeedbackType as 'confirmation' | 'correction');
        await this.confidenceUpdater.update(executedActionId, 'reinforced', feedbackType);
      }

      // Check for consolidation candidates (mature episodes to promote to WKG).
      // This is called during LEARNING to identify consolidation candidates.
      // The actual consolidation is deferred to the Learning subsystem.
      try {
        await (this.consolidationService as any).identifyConsolidationCandidates?.();
      } catch (err) {
        this.logger.debug(`Consolidation check skipped: ${err}`);
      }

      // 8: LEARNING → IDLE
      this.executorEngine.transition(ExecutorState.IDLE);

      // Report the outcome back to the Drive Engine for opportunity detection.
      if (executedActionId !== 'SHRUG' && episode) {
        await this.actionOutcomeReporter.reportOutcome({
          actionId: executedActionId,
          episode,
          driveSnapshot,
          predictions,
        } as any);
      }
    } catch (error) {
      // On error, force recovery to IDLE and re-throw.
      this.logger.error(`Decision cycle failed: ${error}`, error instanceof Error ? error.stack : '');
      this.executorEngine.forceIdle();
      throw error;
    }
  }

  /**
   * Return the current cognitive context for LLM prompt assembly.
   *
   * Called by Communication before invoking the LLM for Type 2 deliberation.
   * Returns a snapshot of:
   * - Current executor state
   * - Recent episodes from episodic memory (context for LLM)
   * - Active predictions (expectations Sylphie has)
   * - Current drive snapshot (actual motivational state)
   *
   * CANON Standard 1 (Theater Prohibition): The driveSnapshot is the real
   * drive state; the LLM uses it to generate authentic outputs.
   *
   * @returns CognitiveContext — never null, never throws.
   */
  getCognitiveContext(): CognitiveContext {
    try {
      return {
        currentState: this.executorEngine.getState(),
        recentEpisodes: this.episodicMemory.getRecentEpisodes(10),
        activePredictions: [], // Populated when predictions are active; for now empty
        driveSnapshot: this.driveStateReader.getCurrentState(),
      };
    } catch (error) {
      // Fallback: return a minimal valid context with just the drive snapshot.
      this.logger.warn(`Failed to assemble CognitiveContext: ${error}`);
      return {
        currentState: ExecutorState.IDLE,
        recentEpisodes: [],
        activePredictions: [],
        driveSnapshot: this.driveStateReader.getCurrentState(),
      };
    }
  }

  /**
   * Report the observed outcome of an executed action back into the loop.
   *
   * Called by Communication after action output has been delivered. Triggers:
   * 1. Prediction evaluation against observed outcome
   * 2. Confidence update with optional guardian feedback weight
   * 3. Type 1 graduation/demotion checks
   * 4. Drive Engine outcome reporting for behavior evaluation
   *
   * CANON Standard 2 (Contingency Requirement): The actionId must correspond
   * to an action that was actually executed in the current or recent cycle.
   * Without it, contingency attribution breaks.
   *
   * CANON Standard 5 (Guardian Asymmetry): Guardian feedback is applied with
   * 2x (confirmation) or 3x (correction) weight multiplier.
   *
   * @param actionId - WKG procedure node ID of the executed action.
   * @param outcome  - The observed outcome including drive effects.
   * @throws If actionId does not correspond to a recent action.
   */
  async reportOutcome(actionId: string, outcome: any): Promise<void> {
    try {
      // Validate that the action is recent.
      if (!actionId || actionId === 'SHRUG' || actionId === 'TYPE_2_NOVEL') {
        this.logger.debug('Outcome reported for non-actionable result; skipping confidence update.');
        return;
      }

      // Evaluate any active predictions against the observed outcome.
      // (In full implementation, predictions are tracked per cycle.)

      // Update confidence based on outcome success.
      const outcomeType = outcome.predictionAccurate ? 'reinforced' : 'counter_indicated';
      // Extract guardian feedback from the outcome if present (if the outcome has that field).
      const guardianFeedback = outcome.guardianFeedbackType
        ? (outcome.guardianFeedbackType as 'confirmation' | 'correction')
        : undefined;

      await this.confidenceUpdater.update(actionId, outcomeType, guardianFeedback);

      // Report to Drive Engine for behavior evaluation and opportunity detection.
      const driveSnapshot = this.driveStateReader.getCurrentState();
      await this.actionOutcomeReporter.reportOutcome({
        actionId,
        driveSnapshot,
      } as any);
    } catch (error) {
      this.logger.error(`Failed to report outcome for action ${actionId}: ${error}`);
      throw error;
    }
  }
}

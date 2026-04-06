/**
 * DecisionMakingService — Main orchestrator for the cognitive decision loop.
 *
 * CANON §Subsystem 1 (Decision Making): This is the sole public facade for the
 * Decision Making module. It orchestrates the full 8-state executor cycle:
 *   IDLE -> CATEGORIZING -> RETRIEVING -> PREDICTING -> ARBITRATING ->
 *   EXECUTING -> OBSERVING -> LEARNING -> IDLE
 *
 * All other decision-making services are internal implementation details.
 * Communication and other subsystems interact only through IDecisionMakingService.
 *
 * CANON §Drive Isolation: Drive state is consumed read-only via IDriveStateReader.
 * Outcome reporting is fire-and-forget via IActionOutcomeReporter. Neither path
 * modifies the Drive Engine's evaluation function.
 *
 * CANON Standard 1 (Theater Prohibition): getCognitiveContext() returns the real
 * DriveSnapshot as ground truth. The LLM receives what Sylphie actually feels.
 *
 * CANON Standard 4 (Shrug Imperative): When arbitration returns SHRUG, the gap
 * types are accumulated in recentGapTypes for Communication to consume. The
 * action registry is not invoked on a SHRUG result.
 *
 * Injection token: DECISION_MAKING_SERVICE (decision-making.tokens.ts)
 */

import { Injectable, Inject, Logger, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import { ExecutorState, DriveName, type DriveSnapshot, type SensoryFrame, type ActionOutcome, type CognitiveContext, type ActionCandidate, type Episode, type Prediction, type GapType, type CycleResponse, type ArbitrationResult } from '@sylphie/shared';
import { DRIVE_STATE_READER, ACTION_OUTCOME_REPORTER, type IDriveStateReader, type IActionOutcomeReporter } from '@sylphie/drive-engine';
import type {
  IDecisionMakingService,
  IExecutorEngine,
  IArbitrationService,
  IPredictionService,
  IEpisodicMemoryService,
  IConfidenceUpdaterService,
  IConsolidationService,
  IDecisionEventLogger,
  IActionRetrieverService,
} from './interfaces/decision-making.interfaces';
import {
  EXECUTOR_ENGINE,
  ACTION_RETRIEVER_SERVICE,
  PREDICTION_SERVICE,
  ARBITRATION_SERVICE,
  EPISODIC_MEMORY_SERVICE,
  CONFIDENCE_UPDATER_SERVICE,
  CONSOLIDATION_SERVICE,
  DECISION_EVENT_LOGGER,
  PROCESS_INPUT_SERVICE,
  ACTION_HANDLER_REGISTRY,
  ATTRACTOR_MONITOR_SERVICE,
} from './decision-making.tokens';
import { ProcessInputService } from './process-input/process-input.service';
import { ActionHandlerRegistryService, type ActionCycleContext } from './action-handlers/action-handler-registry.service';
import { AttractorMonitorService } from './monitoring/attractor-monitor.service';
import { TickSamplerService } from './inputs/sampling/tick-sampler';
import { SensoryStreamLoggerService } from './logging/sensory-stream-logger.service';
import { LatentSpaceService } from './latent-space/latent-space.service';
import { WkgContextService } from './wkg/wkg-context.service';
import { DeliberationService, type DeliberationResult } from './deliberation/deliberation.service';

@Injectable()
export class DecisionMakingService implements IDecisionMakingService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DecisionMakingService.name);

  /** Subject for emitting CycleResponse at the end of each decision cycle. */
  private readonly responseSubject = new Subject<CycleResponse>();

  /** Observable stream of cycle responses. Communication subscribes to this. */
  get response$(): Observable<CycleResponse> {
    return this.responseSubject.asObservable();
  }

  /**
   * Gap types accumulated from SHRUG arbitration results across recent cycles.
   *
   * Populated every time arbitration returns SHRUG and a shrugDetail is present.
   * Consumed by getCognitiveContext() to populate CognitiveContext.recentGapTypes.
   * Capped at 20 entries to prevent unbounded growth.
   */
  private readonly recentGapTypes: GapType[] = [];

  /** Maximum number of gap type entries to retain in the rolling accumulator. */
  private readonly RECENT_GAP_TYPES_CAP = 20;

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

    @Optional()
    @Inject(CONSOLIDATION_SERVICE)
    private readonly consolidationService: IConsolidationService | null,

    @Optional()
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,

    @Inject(PROCESS_INPUT_SERVICE)
    private readonly processInputService: ProcessInputService,

    @Inject(ACTION_HANDLER_REGISTRY)
    private readonly actionHandlerRegistry: ActionHandlerRegistryService,

    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,

    @Optional()
    @Inject(ACTION_OUTCOME_REPORTER)
    private readonly actionOutcomeReporter: IActionOutcomeReporter | null,

    @Inject(ATTRACTOR_MONITOR_SERVICE)
    private readonly attractorMonitor: AttractorMonitorService,

    private readonly tickSampler: TickSamplerService,

    private readonly streamLogger: SensoryStreamLoggerService,

    private readonly latentSpace: LatentSpaceService,
    private readonly wkgContext: WkgContextService,
    private readonly deliberation: DeliberationService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle Hooks
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    this.logger.log('DecisionMakingService initializing — starting tick loop.');
    this.startTickLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopTickLoop();
    this.logger.log('DecisionMakingService destroyed — tick loop stopped.');
  }

  // ---------------------------------------------------------------------------
  // Tick Engine: Timer + Event-Driven
  // ---------------------------------------------------------------------------

  /** Handle for the background timer tick. null when not running. */
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  /** Whether a tick cycle is currently in-flight (prevents overlapping). */
  private tickInFlight = false;

  /** Default background timer interval in milliseconds. */
  private static readonly DEFAULT_TICK_MS = 200;

  /**
   * Minimum total drive pressure required to trigger a self-initiated cycle.
   * Initial drive state has total pressure ~2.4, so this must be above that
   * to prevent rapid self-initiated ticks at startup before any real input.
   * Self-initiated cycles should only fire when pressure has genuinely built
   * up beyond baseline (e.g., boredom accumulating over time).
   */
  private static readonly IDLE_PRESSURE_THRESHOLD = 4.0;

  /**
   * Minimum interval between self-initiated ticks in milliseconds.
   * Even when pressure exceeds the threshold, self-initiated ticks are
   * rate-limited to prevent log spam. Event-driven ticks (from real input)
   * are NOT rate-limited.
   */
  private static readonly SELF_INITIATE_COOLDOWN_MS = 10_000;

  /** Timestamp of the last self-initiated tick. */
  private lastSelfInitiatedAt = 0;

  /**
   * Start the tick engine.
   *
   * Two trigger paths:
   *
   * 1. **Timer ticks** (background, every intervalMs): Check whether drive
   *    pressure alone warrants a self-initiated cycle. This is how Sylphie
   *    acts without external input — boredom, curiosity, social drive build
   *    up and eventually trigger action.
   *
   * 2. **Event ticks** (immediate, via `nudge()`): Called by the TickSampler
   *    when event-driven input arrives (text, audio). Bypasses the timer
   *    wait and runs the cycle immediately. This eliminates the up-to-200ms
   *    latency that would otherwise be perceptible on reactive input.
   *
   * Both paths funnel through the same `onTick()` method with the same
   * non-overlapping guard. If a cycle is in-flight when either trigger fires,
   * the trigger is ignored — the in-flight cycle will see the new data on
   * its next iteration.
   *
   * @param intervalMs - Background timer interval in ms. Defaults to 200ms (5Hz).
   */
  startTickLoop(intervalMs: number = DecisionMakingService.DEFAULT_TICK_MS): void {
    if (this.tickInterval !== null) {
      this.logger.warn('Tick loop already running; ignoring duplicate start.');
      return;
    }

    this.logger.log(
      `Starting tick engine: timer=${intervalMs}ms, event-driven=immediate`,
    );

    // Background timer for self-initiated cycles.
    this.tickInterval = setInterval(() => {
      void this.onTick(false);
    }, intervalMs);

    // Subscribe to event-driven input notifications from the TickSampler.
    // When new event-driven data arrives (text, audio), nudge immediately.
    this.tickSampler.onNewInput(() => {
      void this.onTick(true);
    });
  }

  /**
   * Stop the tick engine.
   * Safe to call even if not running.
   */
  stopTickLoop(): void {
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      this.logger.log('Tick engine stopped.');
    }
  }

  /**
   * Single tick — shared by both timer and event-driven paths.
   *
   * @param eventDriven - true if triggered by input arrival, false if by timer.
   */
  private async onTick(eventDriven: boolean): Promise<void> {
    // Non-overlapping guard.
    if (this.tickInFlight) {
      return;
    }

    if (this.executorEngine.getState() !== ExecutorState.IDLE) {
      return;
    }

    // Timer ticks: only run if there's new input OR drive pressure is high enough.
    if (!eventDriven) {
      if (this.tickSampler.hasNewInput()) {
        // New input arrived between timer ticks — process it.
      } else {
        const snapshot = this.driveStateReader.getCurrentState();
        if (snapshot.totalPressure < DecisionMakingService.IDLE_PRESSURE_THRESHOLD) {
          return; // Low pressure, no input — nothing to do.
        }
        // Rate-limit self-initiated ticks to prevent log spam.
        const now = Date.now();
        if (now - this.lastSelfInitiatedAt < DecisionMakingService.SELF_INITIATE_COOLDOWN_MS) {
          return;
        }
        this.lastSelfInitiatedAt = now;
        this.logger.debug(
          `Self-initiated tick: pressure=${snapshot.totalPressure.toFixed(3)}`,
        );
      }
    }

    this.tickInFlight = true;
    try {
      const frame = await this.tickSampler.sample();

      // Persist the encoded frame to the sensory_ticks hypertable.
      // Fire-and-forget — never blocks the decision cycle.
      const snapshot = this.driveStateReader.getCurrentState();
      this.streamLogger.logFrame(frame, snapshot, snapshot.sessionId);

      await this.processInput(frame);
    } catch (err) {
      this.logger.error(`Tick cycle failed: ${err}`);
    } finally {
      this.tickInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // IDecisionMakingService — processInput
  // ---------------------------------------------------------------------------

  /**
   * Trigger the full 8-state decision cycle for a sensory frame.
   *
   * The cycle runs synchronously from CATEGORIZING through LEARNING before
   * returning. Each executor state transition is explicit and ordered; illegal
   * transitions throw, so mid-cycle state corruption is not silent.
   *
   * On any unrecoverable error the executor is force-reset to IDLE and the
   * error is re-thrown. The caller (typically a gateway or tick loop) is
   * responsible for deciding whether to retry or surface the failure.
   *
   * CANON §Subsystem 1: Full sequence enforcement.
   * CANON Standard 4 (Shrug Imperative): SHRUG results do not invoke the
   * action handler registry — gap types are accumulated for Communication.
   *
   * @param frame - Fused sensory frame from the multimodal pipeline.
   * @throws If the executor is not in IDLE state at call time, or if a
   *         non-recoverable error occurs during the cycle.
   */
  async processInput(frame: SensoryFrame): Promise<void> {
    const cycleStartTime = Date.now();

    // --- Pre-cycle guard ---
    const priorState = this.executorEngine.getState();
    if (priorState !== ExecutorState.IDLE) {
      throw new Error(
        `DecisionMakingService.processInput called while executor is in ${priorState}. ` +
          'Only one cycle may be active at a time.',
      );
    }

    try {
      // ── Step 1: Capture drive state for this cycle ─────────────────────────
      const driveSnapshot: DriveSnapshot = this.driveStateReader.getCurrentState();
      this.executorEngine.captureSnapshot(driveSnapshot);

      // ── Step 2: IDLE -> CATEGORIZING ───────────────────────────────────────
      this.executorEngine.transition(ExecutorState.CATEGORIZING);

      // ProcessInputService handles CATEGORIZING and RETRIEVING in one call:
      // it categorizes the frame, generates the context fingerprint, and
      // retrieves WKG candidates. The executor transitions to RETRIEVING here
      // to reflect that candidate retrieval is underway inside processInput.
      const processInputResult = await this.processInputService.processInput(
        frame,
        driveSnapshot,
      );

      // ── Step 3: CATEGORIZING -> RETRIEVING ────────────────────────────────
      this.executorEngine.transition(ExecutorState.RETRIEVING);

      const { candidates: wkgCandidates, contextFingerprint, inputSummary, dominantDrive } =
        processInputResult;

      // Check the latent space FIRST — if we find a high-similarity match,
      // inject it as a Type 1 candidate with high confidence. This is how
      // learned patterns from Type 2 deliberation become instant reflexes.
      let candidates = [...wkgCandidates];
      const latentMatch = this.latentSpace.search(frame.fused_embedding);

      if (latentMatch) {
        this.logger.debug(
          `Latent space HIT: similarity=${latentMatch.similarity.toFixed(3)}, ` +
            `pattern=${latentMatch.pattern.id.substring(0, 8)}, ` +
            `uses=${latentMatch.pattern.useCount}`,
        );

        // Construct a Type 1 candidate from the latent space pattern.
        // It has high confidence because it's a learned, validated pattern.
        // Always construct procedureData for latent candidates — the latent
        // space pattern IS the procedure. Use the pattern ID as the proc ID.
        const latentCandidate: ActionCandidate = {
          procedureData: {
            id: latentMatch.pattern.procedureId || latentMatch.pattern.id,
            name: `latent-${latentMatch.pattern.id.substring(0, 8)}`,
            category: 'LearnedPattern',
            triggerContext: contextFingerprint,
            actionSequence: [{
              index: 0,
              stepType: 'LLM_GENERATE',
              params: { instruction: latentMatch.pattern.responseText },
            }],
            provenance: 'BEHAVIORAL_INFERENCE' as any,
            confidence: latentMatch.similarity,
          },
          confidence: latentMatch.similarity, // High similarity → high confidence → Type 1 wins arbitration
          motivatingDrive: dominantDrive,
          contextMatchScore: latentMatch.similarity,
        };

        // Insert at the front — highest priority
        candidates.unshift(latentCandidate);

        // Record the use for frequency tracking
        this.latentSpace.recordUse(latentMatch.pattern.id);
      } else {
        this.logger.debug('Latent space MISS — proceeding to normal arbitration.');
      }

      // ── Step 4: RETRIEVING -> PREDICTING ──────────────────────────────────
      this.executorEngine.transition(ExecutorState.PREDICTING);

      // Build CognitiveContext for prediction generation.
      const contextForPrediction: CognitiveContext = {
        currentState: ExecutorState.PREDICTING,
        recentEpisodes: this.episodicMemory.getRecentEpisodes(10),
        activePredictions: [],
        driveSnapshot,
        recentGapTypes: [...this.recentGapTypes],
        dynamicThreshold: 0.50,
      };

      // Pass retrieved candidates directly to prediction service.
      // Per architecture diagram: Make Prediction reads Episodic Memory + WKG
      // to predict drive effects for each candidate BEFORE arbitration.
      const predictions: Prediction[] = await this.predictionService.generatePredictions(
        candidates,
        contextForPrediction,
        3,
      );

      // ── Step 5: PREDICTING -> ARBITRATING ─────────────────────────────────
      this.executorEngine.transition(ExecutorState.ARBITRATING);

      const arbitrationResult = await this.arbitrationService.arbitrate(
        candidates,
        driveSnapshot,
      );

      // Accumulate SHRUG gap types for getCognitiveContext().
      if (arbitrationResult.type === 'SHRUG' && arbitrationResult.shrugDetail) {
        for (const gapType of arbitrationResult.shrugDetail.gapTypes) {
          this.recentGapTypes.push(gapType);
        }
        // Cap to avoid unbounded growth.
        if (this.recentGapTypes.length > this.RECENT_GAP_TYPES_CAP) {
          this.recentGapTypes.splice(
            0,
            this.recentGapTypes.length - this.RECENT_GAP_TYPES_CAP,
          );
        }
      }

      // ── Step 6: ARBITRATING -> EXECUTING ──────────────────────────────────
      this.executorEngine.transition(ExecutorState.EXECUTING);

      // Build cycle context from the fused sensory stream for action handlers.
      const cycleContext: ActionCycleContext = {
        frame,
        cognitiveContext: contextForPrediction,
        inputSummary: processInputResult.inputSummary,
      };

      // Dispatch action steps. SHRUG results bypass the action handler registry —
      // there is nothing to execute. TYPE_1 and TYPE_2 dispatch their step sequences.
      const executionResults: Array<Record<string, unknown> | null> = [];

      if (arbitrationResult.type !== 'SHRUG') {
        const { candidate } = arbitrationResult;
        const procedureData = candidate.procedureData;

        // Fast path: if this candidate came from the latent space, use the
        // cached response directly. No LLM call needed — this is Type 1.
        if (latentMatch && procedureData?.name?.startsWith('latent-')) {
          this.logger.debug(
            `Type 1 reflex from latent space — returning cached response (no LLM).`,
          );
          executionResults.push({
            content: latentMatch.pattern.responseText,
            model: 'latent-space-type1',
            latencyMs: 0,
          });
        } else if (procedureData !== null) {
          for (const step of procedureData.actionSequence) {
            const result = await this.actionHandlerRegistry.execute(step, cycleContext);
            executionResults.push(result);
          }
        } else {
          // Type 2 novel response — no procedure node. Run the full
          // deliberation pipeline: monologue → candidates → selection →
          // debate (conditional) → arbiter → commit.
          this.logger.debug('Type 2 novel: running deliberation pipeline');
          const deliberationResult = await this.deliberation.deliberate(frame, contextForPrediction);
          executionResults.push({
            content: deliberationResult.responseText,
            tokensUsed: deliberationResult.totalTokens,
            latencyMs: deliberationResult.totalLatencyMs,
            model: 'deliberation-pipeline',
            deliberationTrace: deliberationResult.trace,
            confidence: deliberationResult.confidence,
          });
        }
      } else {
        // SHRUG — no candidate exceeded threshold. However, if there's actual
        // text input in this frame, fall back to a Type 2 novel LLM response.
        // Without this, Sylphie is permanently mute until the WKG has learned
        // procedures. The SHRUG is still recorded for gap type tracking above.
        const rawText = frame.raw['text'] as string | undefined;

        // Fast path: if latent space already matched, use the pattern directly.
        // No deliberation needed — this IS Type 1 reflexive response.
        if (latentMatch && latentMatch.pattern.responseText) {
          this.logger.debug(
            `SHRUG bypassed — using latent space response (similarity=${latentMatch.similarity.toFixed(3)})`,
          );
          executionResults.push({
            content: latentMatch.pattern.responseText,
            model: 'latent-space-type1',
            latencyMs: 0,
          });
        } else if (rawText && rawText.length > 0) {
          // No latent match — run the full deliberation pipeline.
          this.logger.debug('SHRUG with text input — running deliberation pipeline.');
          const deliberationResult = await this.deliberation.deliberate(frame, contextForPrediction);
          executionResults.push({
            content: deliberationResult.responseText,
            tokensUsed: deliberationResult.totalTokens,
            latencyMs: deliberationResult.totalLatencyMs,
            model: 'deliberation-pipeline',
            deliberationTrace: deliberationResult.trace,
            confidence: deliberationResult.confidence,
          });
        } else {
          this.logger.debug(
            `SHRUG result — no text input, skipping action dispatch. Reason: ${arbitrationResult.reason}`,
          );
        }
      }

      // ── Step 7: EXECUTING -> OBSERVING ────────────────────────────────────
      this.executorEngine.transition(ExecutorState.OBSERVING);

      // Evaluate any generated predictions against the (minimal) observed outcome.
      // In this initial orchestration the outcome is synthesized from execution
      // results rather than from a real guardian response; reportOutcome() below
      // handles the real post-response evaluation.
      for (const prediction of predictions) {
        try {
          const actionId =
            prediction.actionCandidate.procedureData?.id ?? 'unknown';
          // Construct a minimal ActionOutcome for prediction evaluation.
          // Drive effects will be updated via reportOutcome() once the real
          // outcome is observed (e.g., guardian response received).
          const minimalOutcome: ActionOutcome = {
            selectedAction: {
              actionId,
              arbitrationResult,
              selectedAt: new Date(),
              theaterValidated: true,
            },
            predictionAccurate: false,
            predictionError: 1.0,
            driveEffectsObserved: {},
            anxietyAtExecution: driveSnapshot.pressureVector[DriveName.Anxiety] ?? 0,
            observedAt: new Date(),
          };
          this.predictionService.evaluatePrediction(prediction.id, minimalOutcome);
        } catch (err) {
          this.logger.warn(`Failed to evaluate prediction ${prediction.id}: ${err}`);
        }
      }

      // ── Step 8: OBSERVING -> LEARNING ─────────────────────────────────────
      this.executorEngine.transition(ExecutorState.LEARNING);

      // Encode episode for all non-SHRUG results. SHRUG cycles still encode
      // (they carry diagnostic value) but at SHALLOW depth to conserve buffer
      // capacity.
      const attention = computeAttention(driveSnapshot);
      const arousal = computeArousal(driveSnapshot);
      const encodingDepth = arbitrationResult.type === 'SHRUG' ? 'SHALLOW' : 'NORMAL';

      const actionId =
        arbitrationResult.type !== 'SHRUG'
          ? (arbitrationResult.candidate.procedureData?.id ??
              `type2-novel-${Date.now()}`)
          : 'SHRUG';

      await this.episodicMemory.encode(
        {
          driveSnapshot,
          inputSummary,
          actionTaken: actionId,
          contextFingerprint,
          attention,
          arousal,
        },
        encodingDepth,
      );

      // Confidence update for non-SHRUG, non-novel-type2 actions.
      if (
        arbitrationResult.type !== 'SHRUG' &&
        arbitrationResult.candidate.procedureData !== null
      ) {
        const procedureId = arbitrationResult.candidate.procedureData.id;
        try {
          await this.confidenceUpdater.update(procedureId, 'reinforced');
        } catch (err) {
          this.logger.warn(`Confidence update failed for ${procedureId}: ${err}`);
        }
      }

      // Optional consolidation check — runs if the service is wired.
      if (this.consolidationService) {
        const candidates = this.consolidationService.findConsolidationCandidates();
        if (candidates.length > 0) {
          this.logger.debug(
            `${candidates.length} consolidation candidate(s) found. Running cycle.`,
          );
          try {
            await this.consolidationService.runConsolidationCycle();
          } catch (err) {
            this.logger.warn(`Consolidation cycle failed: ${err}`);
          }
        }
      }

      // Run attractor state detectors once per cycle.
      try {
        this.attractorMonitor.runDetectors();
      } catch (err) {
        this.logger.warn(`Attractor monitor failed: ${err}`);
      }

      // ── Step 9: LEARNING -> IDLE ───────────────────────────────────────────
      this.executorEngine.transition(ExecutorState.IDLE);

      // ── Emit CycleResponse for Communication subsystem ────────────────────
      // Extract LLM-generated text from execution results.
      let responseText = '';
      let responseModel: string | undefined;
      let responseTokens: { prompt: number; completion: number } | undefined;

      for (const result of executionResults) {
        if (result && typeof result['content'] === 'string') {
          responseText = result['content'] as string;
          responseModel = result['model'] as string | undefined;
          responseTokens = result['tokensUsed'] as { prompt: number; completion: number } | undefined;
          break;
        }
      }

      const cycleLatencyMs = Date.now() - cycleStartTime;

      this.responseSubject.next({
        turnId: randomUUID(),
        text: responseText,
        arbitrationType: arbitrationResult.type,
        actionId,
        driveSnapshot,
        arbitrationResult,
        latencyMs: cycleLatencyMs,
        model: responseModel,
        tokensUsed: responseTokens,
      });

      // ── Latent space + WKG write-back ────────────────────────────────────
      // If this cycle produced a response (Type 2 or SHRUG-with-LLM-fallback),
      // write the pattern to the latent space so Type 1 catches it next time.
      // Also write entities and procedures to the WKG for knowledge grounding.
      if (responseText.length > 0 && !latentMatch) {
        // Only write if this was NOT already a latent space hit (avoid duplication)
        try {
          // Get WKG context for the entities involved
          const wkgCtx = await this.wkgContext.getContextForFrame(frame);
          const entityIds = wkgCtx.entities.map((e) => e.nodeId);

          // Write to latent space (hot + warm layers)
          const patternId = await this.latentSpace.write({
            stimulusEmbedding: frame.fused_embedding,
            responseText,
            procedureId: actionId !== 'SHRUG' ? actionId : undefined,
            confidence: arbitrationResult.type === 'SHRUG' ? 0.4 : 0.6,
            deliberationSummary: `${arbitrationResult.type} response to: ${inputSummary}`,
            entityIds,
            sessionId: driveSnapshot.sessionId,
          });

          // Write ActionProcedure to WKG (creates a durable learned behavior)
          const procedureId = await this.wkgContext.writeActionProcedure({
            name: `learned-${patternId.substring(0, 8)}`,
            category: 'LearnedResponse',
            triggerContext: inputSummary,
            responseText,
            actionSequence: [{
              index: 0,
              stepType: 'LLM_GENERATE',
              params: { instruction: responseText },
            }],
            provenance: 'INFERENCE',
            confidence: arbitrationResult.type === 'SHRUG' ? 0.4 : 0.6,
            entityIds,
            motivatingDrive: dominantDrive,
          });

          this.logger.debug(
            `Write-back: latent=${patternId.substring(0, 8)}, ` +
              `wkg_proc=${procedureId?.substring(0, 8) ?? 'none'}, ` +
              `entities=${entityIds.length}`,
          );
        } catch (err) {
          this.logger.warn(`Write-back failed: ${err}`);
        }
      }

      this.logger.debug(
        `Decision cycle complete (${cycleLatencyMs}ms). Arbitration: ${arbitrationResult.type}. ` +
          `Action: ${actionId}. Response: ${responseText.length} chars.` +
          `${latentMatch ? ` [Type 1 from latent space]` : ''}`,
      );
    } catch (err) {
      // Force recovery to IDLE and propagate.
      this.logger.error(
        `Decision cycle failed: ${err}. Forcing executor reset to IDLE.`,
      );
      this.executorEngine.forceIdle();
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // IDecisionMakingService — getCognitiveContext
  // ---------------------------------------------------------------------------

  /**
   * Return the current cognitive context for LLM prompt assembly.
   *
   * This method is synchronous — all source data is in-memory. It never queries
   * the WKG or TimescaleDB.
   *
   * CANON Standard 1 (Theater Prohibition): driveSnapshot is the real ground truth
   * from IDriveStateReader.getCurrentState(). The LLM receives what Sylphie
   * actually feels, not a theatrical mask.
   *
   * @returns CognitiveContext — never null, never throws.
   */
  getCognitiveContext(): CognitiveContext {
    return {
      currentState: this.executorEngine.getState(),
      recentEpisodes: this.episodicMemory.getRecentEpisodes(10),
      activePredictions: [],
      driveSnapshot: this.driveStateReader.getCurrentState(),
      recentGapTypes: [...this.recentGapTypes],
      dynamicThreshold: 0.50,
    };
  }

  // ---------------------------------------------------------------------------
  // IDecisionMakingService — reportOutcome
  // ---------------------------------------------------------------------------

  /**
   * Report the observed outcome of an executed action back into the loop.
   *
   * Called by Communication after an action's output has been delivered and
   * any guardian response collected. Updates confidence based on the real
   * outcome. SHRUG and TYPE_2_NOVEL outcomes are skipped — there is no
   * procedure node to update confidence on.
   *
   * The outcome is also forwarded to the Drive Engine via IActionOutcomeReporter
   * (if wired) for drive evaluation and theater prohibition checking.
   *
   * CANON Standard 2 (Contingency Requirement): actionId must be the WKG
   * procedure node ID of the action that was executed. Without it, contingency
   * attribution is impossible.
   *
   * @param actionId - WKG procedure node ID of the executed action.
   * @param outcome  - The full observed outcome including drive effects.
   */
  async reportOutcome(actionId: string, outcome: ActionOutcome): Promise<void> {
    const arbitrationType = outcome.selectedAction.arbitrationResult.type;

    // SHRUG and novel TYPE_2 actions have no procedure node — skip confidence update.
    if (
      arbitrationType === 'SHRUG' ||
      (arbitrationType === 'TYPE_2' &&
        outcome.selectedAction.arbitrationResult.candidate.procedureData === null)
    ) {
      this.logger.debug(
        `reportOutcome skipped for ${arbitrationType} action (no procedure node to update).`,
      );
      return;
    }

    // Determine outcome type for confidence updater.
    const confidenceOutcome: 'reinforced' | 'counter_indicated' = outcome.predictionAccurate
      ? 'reinforced'
      : 'counter_indicated';

    try {
      await this.confidenceUpdater.update(actionId, confidenceOutcome);
    } catch (err) {
      this.logger.warn(`reportOutcome confidence update failed for ${actionId}: ${err}`);
    }

    // Forward outcome to Drive Engine for drive evaluation (fire-and-forget).
    if (this.actionOutcomeReporter) {
      try {
        this.actionOutcomeReporter.reportOutcome({
          actionId,
          actionType: outcome.selectedAction.arbitrationResult.type,
          success: outcome.predictionAccurate,
          driveEffects: outcome.driveEffectsObserved,
          feedbackSource: 'INFERENCE',
          theaterCheck: {
            expressionType: 'none',
            correspondingDrive: null,
            driveValue: null,
            isTheatrical: !outcome.selectedAction.theaterValidated,
          },
        });
      } catch (err) {
        this.logger.warn(`reportOutcome drive engine forwarding failed: ${err}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (not injectable)
// ---------------------------------------------------------------------------

/**
 * Compute a proxy attention value from the current drive snapshot.
 *
 * Attention is approximated as the clamped average of CognitiveAwareness and
 * Focus drives, both of which reflect cognitive engagement level. A higher
 * combined pressure signals more salient input worth encoding.
 *
 * Result is clamped to [0.0, 1.0].
 */
function computeAttention(driveSnapshot: DriveSnapshot): number {
  const cognitiveAwareness = driveSnapshot.pressureVector[DriveName.CognitiveAwareness] ?? 0;
  const focus = driveSnapshot.pressureVector[DriveName.Focus] ?? 0;
  const raw = (cognitiveAwareness + focus) / 2;
  return Math.min(1.0, Math.max(0.0, raw));
}

/**
 * Compute a proxy arousal value from the current drive snapshot.
 *
 * Arousal is approximated as the clamped average of Anxiety and Curiosity,
 * which together reflect heightened motivational activation. High arousal
 * indicates the system is in a state worth committing to episodic memory.
 *
 * Result is clamped to [0.0, 1.0].
 */
function computeArousal(driveSnapshot: DriveSnapshot): number {
  const anxiety = driveSnapshot.pressureVector[DriveName.Anxiety] ?? 0;
  const curiosity = driveSnapshot.pressureVector[DriveName.Curiosity] ?? 0;
  const raw = (anxiety + curiosity) / 2;
  return Math.min(1.0, Math.max(0.0, raw));
}

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
import { ExecutorState, DriveName, EMBEDDING_VERSION, LLM_SERVICE, type ILlmService, type DriveSnapshot, type SensoryFrame, type ActionOutcome, type CognitiveContext, type ActionCandidate, type Episode, type Prediction, type PredictionEvaluation, type GapType, type CycleResponse, type ArbitrationResult, type KnowledgeGrounding, type TurnOriginator, computeInformationGain, type InformationGainResult, verboseFor } from '@sylphie/shared';
import { CycleGuardService } from './concurrency/cycle-guard.service';
import type { InboundTurn } from './concurrency/inbound-turn';

const vlog = verboseFor('Cortex');
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
  ITensorInferenceService,
  TensorInferenceResult,
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
  TENSOR_INFERENCE_SERVICE,
  MOOD_BLEED_MONITOR_SERVICE,
} from './decision-making.tokens';
import { MoodBleedMonitorService } from './monitoring/mood-bleed-monitor.service';
import { ProcessInputService } from './process-input/process-input.service';
import { ActionHandlerRegistryService, type ActionCycleContext } from './action-handlers/action-handler-registry.service';
import { AttractorMonitorService } from './monitoring/attractor-monitor.service';
import { TickSamplerService } from './inputs/sampling/tick-sampler';
import { SensoryStreamLoggerService } from './logging/sensory-stream-logger.service';
import { LatentSpaceService, applyPersonScopeDemotion, type MultiModalLatentMatch, type LearnedPattern } from './latent-space/latent-space.service';
import { WkgContextService } from './wkg/wkg-context.service';
import { DeliberationService, type DeliberationResult, inferGrounding, isIgnoranceResponse, applyOkgRecallGrounding, discriminateGroundedBy } from './deliberation/deliberation.service';
import { retrieveRecallGrounding, applyRecallGroundingFromRetrieval, resolveRecallKey, type RecallRetrieval, type RecallKeyEncoder } from './deliberation/recall-retrieval';
import { recallKeyForQuestion } from './deliberation/deliberation.service';
import { ModalityRegistryService } from './inputs/registry/modality-registry.service';
import { isDocumentEncoder } from './inputs/encoders/text.encoder';
import { SensoryPredictionService } from './prediction/sensory-prediction.service';
import { ScenePredictionService, type ScenePredictionResult } from './prediction/scene-prediction.service';
import type { SceneSnapshot, EpisodeSource, VisualContext } from '@sylphie/shared';

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
   * WS4 Ticket 3 — atomic turn context (replaces the bare currentQueueTurnId).
   *
   * Carries the turnId AND originator atomically so a zombie cycle cannot emit
   * the successor turn's originator (same epoch-fence-ordered discipline as the
   * zombie guard). Set by runCycleForTurn() before calling processInput();
   * cleared in the finally block after the cycle completes.
   *
   * Self-initiated ticks have no originator and leave this null;
   * processInput() generates a fresh randomUUID() for the turnId and
   * omits the originator on the emitted CycleResponse.
   *
   * CANON Theater Prohibition: one CycleResponse per admitted turn, carrying
   * the intake turnId and originator so Communication can correlate guardian
   * feedback and (Ticket 4) route targeted delivery correctly.
   */
  private currentTurnContext: { turnId: string; originator: TurnOriginator } | null = null;

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

  /**
   * Maps actionId → latent pattern IDs written during that cycle's write-back.
   *
   * Populated when latent space patterns are written (confidence=0.3).
   * Consumed by reportOutcome() to update pattern confidence based on real
   * outcome data. Capped at 100 entries to prevent unbounded growth.
   */
  private readonly pendingLatentPatterns = new Map<string, string[]>();

  /** Maximum entries in pendingLatentPatterns before LRU eviction. */
  private readonly MAX_PENDING_LATENT = 100;

  /**
   * Maps cycle actionId → the WKG-diff information-gain metric computed during
   * that cycle's WKG write-back (Phase 4 Wave 2 cluster 3a — Ticket 2, §A.14).
   *
   * Populated when the "Latent space + WKG write-back" block creates an
   * ActionProcedure node stamped with last_action_id and a before/after diff is
   * computed for it (via the SHARED computeInformationGain honesty gate).
   * Consumed by reportOutcome() to forward informationGainMetrics to the Drive
   * Engine so a real knowledge gain earns honest curiosity relief. UNVERIFIED
   * results are stored too (drive grants zero relief) — never fabricated.
   * Shares the same LRU cap as pendingLatentPatterns.
   */
  private readonly pendingInfoGain = new Map<string, InformationGainResult>();

  /**
   * Maps cycle actionId → the ORIGIN correlation id minted at the action origin
   * (CANON Standard 2 — provenance). Captured at cycle end (anchored to the
   * inbound turnId when present, else deterministic `action:<actionId>`) and
   * consumed by reportOutcome() so the SAME id ties the inbound action event to
   * the drive event(s) it causes — instead of the Drive Engine deriving it after
   * the fact. Shares the LRU cap with the other pending maps.
   */
  private readonly pendingCorrelationId = new Map<string, string>();

  /**
   * Maps cycle actionId → the proactive-social context for a GENUINELY
   * UNPROMPTED comment (self-model social_interaction capability, Std-1).
   *
   * Populated ONLY when a cycle (a) was a self-initiated tick — no
   * currentTurnContext AND no frame turn_id, i.e. no inbound guardian turn —
   * AND (b) produced a real (non-degraded) communicative response that was
   * actually emitted. Consumed by reportOutcome() to emit a single
   * SOCIAL_COMMENT_INITIATED event whose 24-hour guardian-reply success rate
   * the SelfModelWriterService reads for the social_interaction :Capability.
   *
   * The denominator MUST be proactive bids only: socialCommentTimestamp (the
   * drive-side contingency) fires on EVERY reply, so gating success on "any
   * reply answered in 30s" would measure conversation continuity, not whether
   * Sylphie's UNPROMPTED social bids land. Reactive replies (originator
   * present) never enter this map. Shares the LRU cap with the other pending maps.
   */
  private readonly pendingProactiveSocial = new Map<
    string,
    { turnId: string; sessionId: string; initiatedAt: number }
  >();

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

    @Optional()
    @Inject(TENSOR_INFERENCE_SERVICE)
    private readonly tensorInference: ITensorInferenceService | null,

    // Injected read-only to probe availability for the pre-cycle embedding gate
    // (CANON §The Lesion Test). Never used to call the LLM from here — only
    // isAvailable() is consulted, to decide whether the network-bound text embed
    // should be skipped this tick. Optional so the loop degrades if unwired.
    @Optional()
    @Inject(LLM_SERVICE)
    private readonly llm: ILlmService | null,

    @Inject(ATTRACTOR_MONITOR_SERVICE)
    private readonly attractorMonitor: AttractorMonitorService,

    // WS4 Ticket 8: Mood-bleed monitor — tick-driven hostile-interlocutor detector.
    // Optional so the loop degrades gracefully if the service is unavailable.
    @Optional()
    @Inject(MOOD_BLEED_MONITOR_SERVICE)
    private readonly moodBleedMonitor: MoodBleedMonitorService | null,

    private readonly tickSampler: TickSamplerService,

    private readonly streamLogger: SensoryStreamLoggerService,

    private readonly latentSpace: LatentSpaceService,
    private readonly wkgContext: WkgContextService,
    private readonly deliberation: DeliberationService,
    private readonly sensoryPrediction: SensoryPredictionService,
    private readonly scenePrediction: ScenePredictionService,

    // Used at write-back to re-embed stored text patterns as nomic DOCUMENTS
    // (`search_document:`), the asymmetric counterpart to the per-turn QUERY
    // embedding the fusion layer produces. See the write-back block.
    private readonly modalityRegistry: ModalityRegistryService,

    // WS4 Ticket 1: Concurrency guard — queue, mutex, watchdog, epoch fence.
    // Extracted into a focused service; DecisionMakingService wires the seams.
    private readonly cycleGuard: CycleGuardService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle Hooks
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    this.logger.log('DecisionMakingService initializing — starting tick loop.');

    // WS4 Ticket 1: Register cycle runner and SHRUG emitter with the CycleGuard.
    // The cycle runner wraps the processInput seam (acquiring tickInFlight
    // at :376, releasing in the finally at :406 — managed by CycleGuard for
    // queue-admitted turns). The SHRUG emitter delivers watchdog/degraded
    // honest SHRUGs via the existing degraded-SHRUG plumbing.
    this.cycleGuard.register(
      // Cycle runner — called by CycleGuard for each admitted turn.
      // Returns true on success (for circuit breaker accounting).
      async (turn: InboundTurn, myEpoch: number): Promise<boolean> => {
        return this.runCycleForTurn(turn, myEpoch);
      },
      // SHRUG emitter — delivers watchdog/degraded SHRUG with epoch guard.
      (turnId: string, message: string, epoch: number): void => {
        this.emitWatchdogShrug(turnId, message, epoch);
      },
      this.executorEngine,
      // Pre-fix (WS4 T3 pre-fix): isExternallyBusy — tells drainNext() when a
      // self-tick is in flight so it doesn't start a concurrent queue cycle.
      // Spec invariant I1/N4: exactly one cycle at a time regardless of trigger source.
      () => this.selfTickInFlight,
    );

    this.startTickLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopTickLoop();
    this.cycleGuard.destroy();
    this.logger.log('DecisionMakingService destroyed — tick loop stopped.');
  }

  // ---------------------------------------------------------------------------
  // WS4 Ticket 1 — CycleGuard integration seams
  // ---------------------------------------------------------------------------

  /**
   * Run a full decision cycle for a queue-admitted InboundTurn.
   *
   * Called by CycleGuard as the `cycleRunner` callback. CycleGuard has already:
   *  - Acquired the mutex (tickInFlight = true)
   *  - Captured the epoch (myEpoch)
   *  - Armed the watchdog
   *
   * This method samples the sensory frame and delegates to processInput(),
   * passing the epoch for zombie fencing.
   *
   * Returns true on successful completion (for circuit breaker accounting).
   */
  private async runCycleForTurn(turn: InboundTurn, myEpoch: number): Promise<boolean> {
    try {
      // WS4 Ticket 2 — per-turn text injection.
      //
      // Inject this turn's text into the tick-sampler BEFORE sampling.
      // We use injectSyntheticText() (not updateText()) so the injection does NOT
      // fire the onNewInput callback — that would re-enqueue a new turn and create
      // a recursive storm. injectSyntheticText() writes latestValues['text'] silently.
      //
      // This is the fix for the text-smear defect: without this, all burst turns
      // share the single global text slot and sample() reads whichever text was
      // last written by updateText() (second writer wins). With this, each cycle
      // samples its own turn's text regardless of how many other turns arrived
      // since intake.
      //
      // If the turn has no text (empty string — self-tick synthetic or probe),
      // skip injection so the existing slot (if any) is used.
      if (turn.text) {
        this.tickSampler.injectSyntheticText(turn.text);
      }

      // WS4 Ticket 3 — atomic turn context (turnId + originator).
      //
      // Store the intake turnId and originator so processInput() can emit both
      // on responseSubject.next. The originator derives from the InboundTurn's
      // identity fields (populated from the gateway JWT in Ticket 3).
      // Cleared in the finally block below.
      //
      // WS5 T1.0 / T0.9: a sceneNudge turn has NO human speaker — it is an
      // exogenous scene-change cycle trigger. Leave currentTurnContext null
      // (exactly as a self-tick does), so the resulting visual episode has
      // speakerId/speakerIsGuardian STRUCTURALLY ABSENT — a seen-fact never
      // masquerades as guardian-told.
      this.currentTurnContext = turn.sceneNudge
        ? null
        : {
            turnId: turn.turnId,
            originator: {
              userId: turn.userId ?? 'guardian',
              socketId: turn.socketId,
              isGuardian: turn.isGuardian,
            },
          };

      const frame = await this.tickSampler.sample();

      // P4.2 (TK-21): stamp a sceneNudge frame as a system trigger BEFORE
      // processInput so categorizeFrame returns SYSTEM_TRIGGER (not VISUAL_INPUT)
      // — a vision-triggered cycle has no human text/audio and must route
      // deliberation + P1.5 recall distinctly from a co-present visual frame.
      // Stamped here (not at enqueue) because the frame is only sampled now.
      if (turn.sceneNudge) {
        (frame.raw as Record<string, unknown>)['system_trigger'] = true;
      }

      // WS5 T4/P2 — stamp the in-flight turnId onto the frame so BOTH composition
      // paths (the LLM_GENERATE procedure handler AND deliberate()) can key the
      // test-only prompt-capture mirror by turn, enabling the gate's turn-correlated
      // read. Originator-less cycles (sceneNudge / self-tick) carry no turnId, so
      // this is left unset for them. Debug telemetry only — not a cognitive input.
      if (this.currentTurnContext?.turnId) {
        (frame.raw as Record<string, unknown>)['turn_id'] = this.currentTurnContext.turnId;
      }

      const rawText = frame.raw['text'] as string | undefined;
      vlog('queue cycle sampled frame', {
        turnId: turn.turnId,
        modalities: frame.active_modalities,
        textContent: rawText ? rawText.substring(0, 120) : null,
        epoch: myEpoch,
      });

      const snapshot = this.driveStateReader.getCurrentState();
      this.streamLogger.logFrame(frame, snapshot, snapshot.sessionId);

      // WS4 Ticket 8: Notify mood-bleed monitor of cycle start.
      // Exception-isolated: a monitor failure must never break a cycle.
      // WS5 T1.0: a sceneNudge turn has no originator (currentTurnContext null) —
      // there is no human speaker to monitor for mood-bleed, so skip cleanly
      // rather than deref a null originator.
      if (this.currentTurnContext !== null) {
        try {
          this.moodBleedMonitor?.onCycleStart(this.currentTurnContext.originator, snapshot);
        } catch (monitorErr) {
          this.logger.warn(`MoodBleedMonitor.onCycleStart failed: ${monitorErr}`);
        }
      }

      await this.processInput(frame, myEpoch);
      return true;
    } catch (err) {
      this.logger.error(`Queue cycle failed for turn ${turn.turnId}: ${err}`);
      // processInput already calls forceIdle() on error and re-throws.
      // Re-catch here so CycleGuard's finally always runs.
      return false;
    } finally {
      // WS4 Ticket 8: Notify mood-bleed monitor of cycle end (before context clear).
      // Exception-isolated: a monitor failure must never prevent context cleanup.
      try {
        this.moodBleedMonitor?.onCycleEnd();
      } catch (monitorErr) {
        this.logger.warn(`MoodBleedMonitor.onCycleEnd failed: ${monitorErr}`);
      }
      // Always clear so a subsequent self-tick doesn't pick up a stale context.
      this.currentTurnContext = null;
    }
  }

  /**
   * Emit a watchdog or degraded-mode SHRUG for a specific turnId.
   *
   * Called by CycleGuard's watchdog handler and degraded-mode drain.
   * The epoch is the NEW epoch (post-increment) so the emit passes
   * the isEpochCurrent check if this is called from the watchdog recovery.
   *
   * Reuses the degraded-SHRUG plumbing (spec §3.4 step 4, :1098–:1119).
   */
  private emitWatchdogShrug(turnId: string, message: string, _epoch: number): void {
    // Emit a CycleResponse with the SHRUG arbitration type and the watchdog message.
    // Use the current drive state as context. This mirrors the degraded-SHRUG path
    // at :1098–:1119 for LLM-unavailability — same honest label, same path.
    try {
      const driveSnapshot = this.driveStateReader.getCurrentState();
      const shrugArbitrationResult: ArbitrationResult = {
        type: 'SHRUG',
        reason: message,
        shrugDetail: {
          gapTypes: ['LOW_CONFIDENCE'],
          candidateConfidences: [],
          threshold: 0.5,
          reason: message,
        },
      };

      this.responseSubject.next({
        turnId,
        text: message,
        arbitrationType: 'SHRUG',
        actionId: 'WATCHDOG_SHRUG',
        driveSnapshot,
        arbitrationResult: shrugArbitrationResult,
        latencyMs: 0,
        model: undefined,
        tokensUsed: undefined,
        knowledgeGrounding: 'UNKNOWN',
        groundingProvenance: undefined,
        preExecutionDriveSnapshot: driveSnapshot.pressureVector,
        latentPatternIds: undefined,
        inputCategory: 'question',
      });
    } catch (err) {
      this.logger.warn(`emitWatchdogShrug failed for turn ${turnId}: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // IDecisionMakingService — enqueueTurn (WS4 Ticket 2)
  // ---------------------------------------------------------------------------

  /**
   * Enqueue an inbound turn from the Communication boundary.
   *
   * Called by CommunicationService.intakeTurn() after it has:
   *  - Minted the turnId (at the gateway boundary)
   *  - Run parseInput (entity extraction, fast-fact writes, history accumulation)
   *  - Updated all tickSampler context slots (conversation_history, person_model, etc.)
   *
   * The turn carries its own text so runCycleForTurn() can inject it into the
   * tick-sampler slot immediately before sample() — preventing the text-smear
   * defect where burst turns clobber each other's text in the shared global slot.
   *
   * CANON Theater Prohibition: every enqueued turn receives exactly one honest
   * outcome (the CycleGuard's back-pressure and watchdog machinery ensures this).
   */
  enqueueTurn(turn: InboundTurn): void {
    this.cycleGuard.enqueue(turn);
  }

  // ---------------------------------------------------------------------------
  // Tick Engine: Timer + Event-Driven
  // ---------------------------------------------------------------------------

  /** Handle for the background timer tick. null when not running. */
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Whether a tick cycle is currently in-flight (prevents overlapping).
   *
   * WS4 Ticket 1: for queue-admitted turns, CycleGuard manages this flag.
   * For self-initiated ticks (timer path), onTick manages it directly.
   * The self-tick check reads from CycleGuard to avoid split-brain: both
   * the queue path and self-tick path must see the same mutex state.
   *
   * @deprecated Direct field reads from onTick() use cycleGuard instead.
   *   Kept as a local flag only for the self-tick path (set at :426, reset at :406).
   */
  private selfTickInFlight = false;

  /** Default background timer interval in milliseconds. */
  private static readonly DEFAULT_TICK_MS = 200;

  /**
   * Minimum total drive pressure required to trigger a self-initiated cycle.
   * Initial drive state has total pressure 0.0 (all drives start at zero).
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
    // WS4 Ticket 1: route event-driven inputs through the CycleGuard queue
    // instead of directly calling onTick(). This replaces the silent drop at
    // :290 with an ordered, bounded FIFO queue. Self-initiated 200ms ticks still
    // call onTick(false) directly — they have no originator and bypass the queue
    // per spec §5 N4.
    this.tickSampler.onNewInput(() => {
      // NOTE (WS4 Ticket 2): this callback is now a safety net for non-text
      // event-driven modalities (currently none — only 'text' is event-driven).
      // Normal chat text no longer reaches here: it is enqueued by
      // CommunicationService.intakeTurn() via enqueueTurn(), which carries the
      // per-turn text on the InboundTurn. If a future modality is event-driven,
      // this callback should be updated to carry appropriate per-turn data.
      //
      // For now, if this fires, use the tickSampler's current text slot (if any)
      // as a fallback so legacy behavior is preserved.
      const turn: InboundTurn = {
        turnId: randomUUID(),
        isGuardian: false,
        receivedAt: Date.now(),
        enqueuedAt: Date.now(),
        text: '', // No per-turn text — this path is a fallback for future modalities
      };
      this.cycleGuard.enqueue(turn);
    });

    // WS5 T1.0 — scene-change cycle nudge. A confirmed-object scene change
    // (decided + deduped at the perception gateway) enqueues an originator-less,
    // non-guardian, empty-text turn so a cognitive cycle RUNS on the frame
    // carrying that scene. Without this, a salient-but-CALM visual frame on a
    // drive-cold backend never reaches the cycle: the self-tick is gated at
    // IDLE_PRESSURE_THRESHOLD (4.0) and `scene` is deliberately NOT a globally
    // event-driven modality (that would fire a cycle per frame ~15fps). The
    // sceneNudge turn drains exactly like a self-tick (scene read from the slot
    // via sample()), carries NO originator (currentTurnContext stays null →
    // speakerIsGuardian structurally absent, T0.9), and writes NOTHING to drives
    // (the trigger keys on an exogenous scene change; no perception→drive→
    // perception loop is closed — ashby/finding-I).
    this.tickSampler.onSceneChange(() => {
      const turn: InboundTurn = {
        turnId: randomUUID(),
        isGuardian: false, // exogenous scene change — never guardian-prioritized
        receivedAt: Date.now(),
        enqueuedAt: Date.now(),
        text: '', // no human text — the scene rides the tick-sampler slot
        sceneNudge: true, // T0.9: runCycleForTurn leaves currentTurnContext null
      };
      this.cycleGuard.enqueue(turn);
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
   * Single tick — used for self-initiated (timer) ticks only.
   *
   * WS4 Ticket 1: event-driven ticks no longer call this method. They are
   * intercepted by the tickSampler.onNewInput callback, which routes to
   * CycleGuard.enqueue(). Self-initiated (timer) ticks remain on this path
   * per spec §5 N4 — they bypass the inbound queue (no originator).
   *
   * @param eventDriven - always false in the current call path (kept for compat).
   */
  private async onTick(eventDriven: boolean): Promise<void> {
    // Non-overlapping guard. CycleGuard manages tickInFlight for queue-admitted
    // turns; for self-ticks we read the combined flag (CycleGuard OR selfTickInFlight)
    // to stay out of the way of both queue cycles and other self-ticks.
    const isAnyTickInFlight = this.selfTickInFlight || this.cycleGuard.getQueueStats().tickInFlight;
    if (isAnyTickInFlight) {
      vlog('tick skipped (in-flight guard)', { eventDriven });
      return;
    }

    if (this.executorEngine.getState() !== ExecutorState.IDLE) {
      vlog('tick skipped (executor not IDLE)', { state: this.executorEngine.getState(), eventDriven });
      return;
    }

    // ── Tensor training on EVERY tick ────────────────────────────────────
    // Every moment is training data. Even when the decision loop filters
    // this tick out (low pressure, no input), the tensor model needs to
    // learn: "in this state, the correct action is NO_ACTION." Without
    // this, the model only sees conversation turns and never learns when
    // to stay quiet.
    if (this.tensorInference?.isAvailable()) {
      try {
        const frame = await this.tickSampler.peek();
        const snapshot = this.driveStateReader.getCurrentState();
        this.tensorInference.submitTraining(
          frame,
          snapshot,
          'NO_ACTION',
          'IDLE',
        );
      } catch {
        // Silent — tensor training is never critical path
      }
    }

    // Timer ticks: only run if there's new input OR drive pressure is high enough.
    // WS4 Ticket 1: if there's new input it was already handled by CycleGuard
    // (the onNewInput callback enqueued it). A self-tick must NOT re-process
    // already-queued input or it would run a second cycle for the same text.
    if (!eventDriven) {
      if (this.tickSampler.hasNewInput()) {
        // Input is already queued in CycleGuard — skip the self-tick.
        vlog('self-tick skipped (input already queued by CycleGuard)', {});
        return;
      } else {
        const snapshot = this.driveStateReader.getCurrentState();
        if (snapshot.totalPressure < DecisionMakingService.IDLE_PRESSURE_THRESHOLD) {
          return; // Low pressure, no input — nothing to do.
        }
        // Suppress self-initiated ticks within 30s of last user input.
        // The user may still be thinking; avoid generating unprompted responses.
        const now = Date.now();
        const msSinceLastInput = now - this.tickSampler.getLastInputTimestamp();
        if (msSinceLastInput < 30_000) {
          return;
        }
        // Rate-limit self-initiated ticks to prevent log spam.
        if (now - this.lastSelfInitiatedAt < DecisionMakingService.SELF_INITIATE_COOLDOWN_MS) {
          return;
        }
        this.lastSelfInitiatedAt = now;

        // ── Autonomous boredom research ─────────────────────────────────
        // When boredom is high and there's no user input, pick a low-confidence
        // entity from the WKG and inject a synthetic research request. This
        // gives Sylphie something to do — she autonomously learns about topics
        // she knows little about, relieving boredom and curiosity.
        const boredom = snapshot.pressureVector[DriveName.Boredom] ?? 0;
        const curiosity = snapshot.pressureVector[DriveName.Curiosity] ?? 0;
        if (boredom > 0.6 || curiosity > 0.7) {
          const researchTarget = await this.pickResearchTarget();
          if (researchTarget) {
            vlog('autonomous research triggered', {
              boredom: +boredom.toFixed(3),
              curiosity: +curiosity.toFixed(3),
              target: researchTarget,
            });
            this.logger.log(
              `Autonomous research: boredom=${boredom.toFixed(2)}, curiosity=${curiosity.toFixed(2)} → researching "${researchTarget}"`,
            );
            // Inject synthetic text that will trigger the RESEARCH_ENTITY procedure
            // via the deliberation pipeline's COMMAND intent detection.
            this.tickSampler.injectSyntheticText(
              `I want to learn about ${researchTarget}`,
            );
          }
        }

        vlog('self-initiated tick', { pressure: +snapshot.totalPressure.toFixed(3), msSinceLastInput, boredom: +boredom.toFixed(3) });
        this.logger.debug(
          `Self-initiated tick: pressure=${snapshot.totalPressure.toFixed(3)}`,
        );
      }
    }

    // Self-initiated tick: acquire the local selfTickInFlight mutex.
    // This does NOT touch CycleGuard's tickInFlight — they are independent
    // but both are checked by the in-flight guard above.
    this.selfTickInFlight = true;
    try {
      // ── Sensory frame sampling ──────────────────────────────────────────────
      // The text encoder has its own timeout guard (DEFAULT_EMBED_TIMEOUT_MS =
      // 3000ms) and catches all failures gracefully — ECONNRESET (e.g. dead
      // Ollama or cassette lesion for chat-only) returns immediately with a zero
      // vector, and a truly hung endpoint is cut off by the timer. There is no
      // need to skip embedding here based on LLM chat availability; the encoder
      // degrades on its own. Keeping the embed path active under lesion is also
      // required for CANON §The Lesion Test: Type 1 latent-space reflexes must
      // survive LLM removal, which requires real embeddings.
      const frame = await this.tickSampler.sample();

      const rawText = frame.raw['text'] as string | undefined;
      vlog('tick sampled frame', {
        eventDriven,
        modalities: frame.active_modalities,
        textContent: rawText ? rawText.substring(0, 120) : null,
        embeddingNorm: +Math.sqrt(frame.fused_embedding.reduce((s, v) => s + v * v, 0)).toFixed(4),
      });

      // Persist the encoded frame to the sensory_ticks hypertable.
      // Fire-and-forget — never blocks the decision cycle.
      const snapshot = this.driveStateReader.getCurrentState();
      this.streamLogger.logFrame(frame, snapshot, snapshot.sessionId);

      // WS4 Ticket 8: Notify mood-bleed monitor of self-tick cycle start.
      // originator=null excludes self-ticks from speaker ledgers and baseline.
      // Exception-isolated: a monitor failure must never break a self-tick.
      try {
        this.moodBleedMonitor?.onCycleStart(null, snapshot);
      } catch (monitorErr) {
        this.logger.warn(`MoodBleedMonitor.onCycleStart (self-tick) failed: ${monitorErr}`);
      }

      // Self-ticks pass no epoch — they bypass CycleGuard and are never zombied.
      await this.processInput(frame);
    } catch (err) {
      this.logger.error(`Tick cycle failed: ${err}`);
    } finally {
      // WS4 Ticket 8: Notify mood-bleed monitor of cycle end.
      // Exception-isolated: monitor failure must not prevent reset of selfTickInFlight.
      try {
        this.moodBleedMonitor?.onCycleEnd();
      } catch (monitorErr) {
        this.logger.warn(`MoodBleedMonitor.onCycleEnd (self-tick) failed: ${monitorErr}`);
      }
      this.selfTickInFlight = false;
      // Pre-fix (WS4 T3 pre-fix): notify CycleGuard that the self-tick is done
      // so any turns queued during this self-tick can resume draining.
      // Without this, a queue turn arriving mid-self-tick would be held by
      // drainNext()'s isExternallyBusy check and never re-triggered.
      this.cycleGuard.notifyExternalComplete();
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
   * WS4 Ticket 1 (epoch parameter): when called from a queue-admitted cycle,
   * `cycleEpoch` carries the epoch snapshot so the :1058–:1377 tail can fence
   * against zombie double-emit. Self-initiated ticks pass undefined — they bypass
   * the queue and are never zombied by the watchdog.
   *
   * @param frame - Fused sensory frame from the multimodal pipeline.
   * @param cycleEpoch - (WS4 T1) Epoch snapshot for zombie fencing; undefined = self-tick.
   * @throws If the executor is not in IDLE state at call time, or if a
   *         non-recoverable error occurs during the cycle.
   */
  async processInput(frame: SensoryFrame, cycleEpoch?: number): Promise<void> {
    const cycleStartTime = Date.now();
    // Capture myEpoch from parameter (queue turns) or from guard (self-ticks).
    // Self-ticks pass undefined; they are not managed by CycleGuard and are
    // never zombied, so fencing is a no-op for them.
    const myEpoch = cycleEpoch;

    // --- Pre-cycle guard ---
    const priorState = this.executorEngine.getState();
    if (priorState !== ExecutorState.IDLE) {
      throw new Error(
        `DecisionMakingService.processInput called while executor is in ${priorState}. ` +
          'Only one cycle may be active at a time.',
      );
    }

    try {
      // Prune stale predictions from prior cycles whose non-selected candidates
      // were never evaluated via reportOutcome(). 60s is generous — cycles
      // typically complete in <5s.
      this.predictionService.pruneStale(60_000);

      // ── Step 1: Capture drive state for this cycle ─────────────────────────
      const driveSnapshot: DriveSnapshot = this.driveStateReader.getCurrentState();
      this.executorEngine.captureSnapshot(driveSnapshot);
      vlog('cycle start', {
        totalPressure: +driveSnapshot.totalPressure.toFixed(3),
        tickNumber: driveSnapshot.tickNumber,
      });

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

      vlog('processInput result', {
        category: processInputResult.inputCategory,
        wkgCandidates: wkgCandidates.length,
        entities: processInputResult.entities.slice(0, 10),
        dominantDrive,
        fingerprint: contextFingerprint.substring(0, 16),
      });

      // ── WS3 Ticket T1: pre-arbitration grounded recall retrieval ──────────
      // Resolve the WKG/OKG fact node that grounds this turn ONCE, BEFORE the
      // procedure-vs-deliberate arbitration, so BOTH paths observe the SAME
      // provenance-carrying node. This replaces the post-hoc per-site regex
      // re-derivation (applyOkgRecallGrounding at 3 call sites) with a single
      // retrieval whose node id is recorded AT RETRIEVAL TIME. Single-hop only.
      //
      // Cheap guard inside computeRecallRetrieval(): a non-recall question exits
      // before any Neo4j round-trip. T2 will reinforce recallRetrieval.factNodeId;
      // T3 will decay unused nodes — both depend on this node id being surfaced.
      const recallRetrieval = await this.computeRecallRetrieval(frame);
      if (recallRetrieval) {
        vlog('pre-arbitration recall retrieval HIT', {
          key: recallRetrieval.recallKey,
          source: recallRetrieval.source,
          nodeId: recallRetrieval.factNodeId,
          confidence: recallRetrieval.confidence,
        });
      }

      // ── knowledge_retrieval metric gate — pre-arbitration intent ───────────
      // The self-model knowledge_retrieval :Capability gates its denominator on
      // RESPONSE_GENERATED rows where payload.intent='QUESTION' (turns where
      // retrieval was actually DEMANDED). The deliberate() path threads
      // monologueParsed.intent, but the procedure-handler and latent-reflex
      // branches deliberately skip the LLM monologue, so they had NO intent in
      // scope and persisted intent=NULL — making the QUESTION gate match 0 rows
      // and leaving the capability inert in production (~100% of turns resolve via
      // those two branches).
      //
      // recallKeyForQuestion() is the SAME deterministic, pre-arbitration recall
      // classifier the cycle already runs for grounding (it backs computeRecall-
      // Retrieval above and runs for EVERY cycle, no LLM). A non-null key means the
      // input is a recall QUESTION ("what is my name / where do I live / ...") —
      // exactly the "retrieval demanded" turns the metric counts, INCLUDING the
      // tried-and-failed (UNKNOWN) ones where no node grounded (so we key off the
      // question classifier, NOT recallRetrieval!==null, which would drop those).
      //
      // CANON Std-1: we REUSE this already-computed classification; we never call
      // the LLM, never recompute the monologue, and never default to 'QUESTION'.
      // When the input is not a recall question, cycleRecallIntent stays undefined
      // → the branch leaves result.intent unset → it persists as null → correctly
      // EXCLUDED from the QUESTION-gated denominator (honest, not fabricated).
      const cycleInputText = (frame.raw['text'] as string | undefined) ?? '';
      const cycleRecallIntent: 'QUESTION' | undefined =
        recallKeyForQuestion(cycleInputText) ? 'QUESTION' : undefined;

      // Check per-modality latent spaces FIRST — if we find a high-similarity
      // match on any modality, inject it as a Type 1 candidate. Each modality's
      // embedding is searched independently so text changes aren't drowned out
      // by stable video/audio.
      let candidates = [...wkgCandidates];

      // Compute sensory prediction errors (per-modality surprise signals).
      const sensoryErrors = this.sensoryPrediction.computeErrors(frame.modality_embeddings);

      // ── WS5 T1.0: compute scene prediction errors ONCE, EARLY ─────────────
      // The defect this fixes: the 0.15 encode gate reads input.attention, which
      // was drive-derived ONLY (computeAttention). Scene surprise used to be
      // computed LATER in the cycle (routeScenePredictionErrors, ~:1864) — AFTER
      // the encode call (~:1426). So a salient-but-CALM novel frame failed the
      // encode gate structurally: frame N's surprise never reached frame N's
      // encode. We now compare the scene here (PURE — no prediction mutation),
      // cache the result + totalSurprise, and reuse it for BOTH the
      // encode-attention saliency term (an additional OR admission path, NOT an
      // AND) AND the drive router below — which consumes the cached value rather
      // than recomputing. Predictions are advanced EXACTLY ONCE per frame, at the
      // routing site (advancePredictions), so they never double-advance.
      //
      // ashby (load-bearing): this saliency term feeds the ATTENTION channel
      // ONLY. It must NOT also raise Curiosity/Anxiety — those already get scene
      // surprise via routeScenePredictionErrors. Feeding it to drives too would
      // RELOCATE the perception→drive→perception loop through the attention edge,
      // not break it.
      const sceneSnapshot = frame.raw['scene'] as SceneSnapshot | undefined;
      const sceneComparison: ScenePredictionResult | null = sceneSnapshot
        ? this.scenePrediction.compareScene(sceneSnapshot)
        : null;
      const cachedSceneSurprise = sceneComparison?.totalSurprise ?? 0;

      // WS5 T4/P1c: ADVANCE the predictor (familiarity-count bookkeeping + surprise
      // inspection-ring write) HERE, immediately after the pure compare — NOT later
      // at the drive-routing site. Rationale: the cycle has a zombie/epoch fence
      // (~:1944) before the routing site; a superseded cycle returns early and
      // would SKIP the advance, so a frame whose compare ran (and logged surprise)
      // would never increment familiarity or record the ring — defeating P1c
      // habituation across queued nudge cycles (the count would stay 1 forever).
      // The advance is cheap, deterministic, and reflects "this frame was
      // perceived," which is true regardless of whether the downstream ACTION got
      // superseded. The drive routing stays epoch-gated below (a zombie must not
      // write drives), but the predictor's own state/observation must not be lost.
      // This is still EXACTLY ONCE per frame (one compare → one advance here).
      if (sceneSnapshot && sceneComparison) {
        this.scenePrediction.advancePredictions(sceneSnapshot, sceneComparison);
      }

      const multiModalMatch = this.latentSpace.searchMultiModal(frame.modality_embeddings);
      // Extract the best single-modality match for downstream compatibility.
      const latentMatch = multiModalMatch?.bestMatch ?? null;

      if (multiModalMatch) {
        vlog('latent space HIT', {
          bestModality: multiModalMatch.bestMatch.modality,
          similarity: +multiModalMatch.bestMatch.similarity.toFixed(3),
          composite: +multiModalMatch.compositeSimilarity.toFixed(3),
          patternId: multiModalMatch.bestMatch.pattern.id.substring(0, 8),
          matchModalities: multiModalMatch.matches.map(m => m.modality),
          responsePreview: multiModalMatch.bestMatch.pattern.responseText.substring(0, 80),
        });
        this.logger.debug(
          `Latent space HIT [${multiModalMatch.bestMatch.modality}]: ` +
            `similarity=${multiModalMatch.bestMatch.similarity.toFixed(3)}, ` +
            `composite=${multiModalMatch.compositeSimilarity.toFixed(3)}, ` +
            `pattern=${multiModalMatch.bestMatch.pattern.id.substring(0, 8)}, ` +
            `modalities=${multiModalMatch.matches.map(m => m.modality).join(',')}`,
        );

        const bestPattern = multiModalMatch.bestMatch.pattern;
        const latentCandidate: ActionCandidate = {
          procedureData: {
            id: bestPattern.procedureId || bestPattern.id,
            name: `latent-${bestPattern.id.substring(0, 8)}`,
            category: 'LearnedPattern',
            triggerContext: contextFingerprint,
            actionSequence: [{
              index: 0,
              stepType: 'LLM_GENERATE',
              params: { instruction: bestPattern.responseText },
            }],
            provenance: 'BEHAVIORAL_INFERENCE' as any,
            confidence: multiModalMatch.compositeSimilarity,
          },
          confidence: multiModalMatch.compositeSimilarity,
          motivatingDrive: dominantDrive,
          contextMatchScore: multiModalMatch.compositeSimilarity,
        };

        candidates.unshift(latentCandidate);
        this.latentSpace.recordUse(bestPattern.id);
      } else {
        vlog('latent space MISS', { hotLayerSize: this.latentSpace.hotLayerSize });
        this.logger.debug('Latent space MISS (all modalities) — proceeding to normal arbitration.');
      }

      // ── Step 3.5: Tensor Inference ────────────────────────────────────────
      // Call the cognition sidecar with the real SensoryFrame. The 50ms timeout
      // in the gateway ensures this never blocks the loop. Returns null if
      // sidecar is unavailable or times out — graceful degradation to LLM-only.
      //
      // Panel context: assemble domain-specific slices for the 4 panel models.
      // Drive history is maintained by the adapter; the other 3 are built here
      // where the data sources are available.
      let tensorResult: TensorInferenceResult | null = null;
      if (this.tensorInference) {
        try {
          // Latent match scores (Decision Panel) — top 5 similarities, padded
          const latentScores = multiModalMatch
            ? multiModalMatch.matches
                .map((m) => m.similarity)
                .sort((a, b) => b - a)
                .slice(0, 5)
            : [];
          const latentMatchScores = [
            ...latentScores,
            ...new Array(Math.max(0, 5 - latentScores.length)).fill(0),
          ];

          // MAE values + novelty indicators (Learning Panel) — 10 MAE + 4 flags
          const recentMAE = this.attractorMonitor.getRecentMAEValues(10);
          const paddedMAE = [
            ...new Array(Math.max(0, 10 - recentMAE.length)).fill(0),
            ...recentMAE,
          ];
          // Novelty indicators from attractor detector states
          const detectorResults = await this.attractorMonitor.runDetectors();
          const detectorNames = new Set(
            detectorResults.filter((d) => d.triggered).map((d) => d.name),
          );
          const noveltyIndicators = [
            recentMAE.length >= 2
              ? recentMAE.slice(-3).reduce((s, v) => s + v, 0) / 3 -
                recentMAE.slice(0, 3).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(3, recentMAE.length))
              : 0, // MAE trend
            detectorNames.has('PREDICTION_PESSIMIST') ? 1.0 : 0.0,
            detectorNames.has('PLANNING_RUNAWAY') ? 1.0 : 0.0,
            detectorNames.has('DEPRESSIVE_ATTRACTOR') ? 1.0 : 0.0,
          ];
          const recentMaeValues = [...paddedMAE, ...noveltyIndicators];

          tensorResult = await this.tensorInference.infer(
            frame,
            driveSnapshot,
            undefined, // episodicContext
            {
              latentMatchScores,
              recentMaeValues,
              // driveHistory is maintained by the adapter internally
              // opportunityFeatures requires drive engine exposure — omitted for now
            },
          );
        } catch (err) {
          this.logger.warn(`Tensor inference failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // ── Step 3.6: Tensor → Candidate Injection ───────────────────────────
      if (tensorResult) {
        vlog('tensor inference result', {
          mode: tensorResult.bootstrapMode,
          consensus: tensorResult.consensus,
          divergence: +tensorResult.divergenceScore.toFixed(3),
          topCategory: tensorResult.tensorTopCategory,
          urgency: +tensorResult.urgency.toFixed(3),
          novelty: +tensorResult.noveltyScore.toFixed(3),
          inferenceMs: +tensorResult.inferenceMs.toFixed(1),
        });

        // In partial/full mode, inject tensor-derived candidate for graduated categories
        if (
          tensorResult.tensorTopCategory &&
          tensorResult.shouldUseTensor(tensorResult.tensorTopCategory)
        ) {
          const tensorCandidate = this.buildTensorCandidate(
            tensorResult,
            contextFingerprint,
            dominantDrive,
          );
          if (tensorCandidate) {
            candidates.unshift(tensorCandidate);
            vlog('tensor candidate injected', {
              category: tensorResult.tensorTopCategory,
              confidence: +tensorCandidate.confidence.toFixed(3),
              mode: tensorResult.bootstrapMode,
            });
          }
        }

        // Panel divergence → force Type 2 deliberation.
        // If panels disagree, cap all candidate confidences below the graduation
        // threshold (0.80) so ArbitrationService routes to TYPE_2.
        if (!tensorResult.consensus && tensorResult.divergenceScore > 0.3) {
          vlog('tensor divergence — escalating to Type 2', {
            divergence: +tensorResult.divergenceScore.toFixed(3),
          });
          candidates = candidates.map((c) => ({
            ...c,
            confidence: Math.min(c.confidence, 0.79),
          }));
        }
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

      vlog('arbitration complete', {
        type: arbitrationResult.type,
        candidateCount: candidates.length,
        predictionCount: predictions.length,
        ...(arbitrationResult.type !== 'SHRUG' && arbitrationResult.candidate
          ? {
              candidateName: arbitrationResult.candidate.procedureData?.name,
              candidateConfidence: +arbitrationResult.candidate.confidence.toFixed(3),
            }
          : {}),
        ...(arbitrationResult.type === 'SHRUG' && arbitrationResult.shrugDetail
          ? { gapTypes: arbitrationResult.shrugDetail.gapTypes, reason: arbitrationResult.reason }
          : {}),
      });

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
        // WS5 T4/P2 — carry the in-flight turnId so the LLM_GENERATE handler can
        // key the test-only prompt-capture mirror by turn (turn-correlated read).
        // Null for originator-less cycles (self-tick / scene-nudge).
        turnId: this.currentTurnContext?.turnId ?? null,
      };

      // Dispatch action steps. SHRUG results bypass the action handler registry —
      // there is nothing to execute. TYPE_1 and TYPE_2 dispatch their step sequences.
      const executionResults: Array<Record<string, unknown> | null> = [];

      // Set in the SHRUG branch below: true when arbitration SHRUG'd because of
      // genuine incomprehension (MISSING_CONTEXT / CONTRADICTION, not merely
      // LOW_CONFIDENCE). When true, any deliberation response is delivered (so
      // Sylphie isn't mute) but is NEVER written back as a learned reflex —
      // CANON Standard 4 (Shrug Imperative). See the SHRUG branch for rationale.
      let isGenuineIncomprehensionShrug = false;

      if (arbitrationResult.type !== 'SHRUG') {
        const { candidate } = arbitrationResult;
        const procedureData = candidate.procedureData;

        // Fast path: emit the cached latent response directly (Type 1, no LLM)
        // ONLY when arbitration actually GRADUATED the latent candidate to
        // TYPE_1 and the candidate it chose IS that latent candidate.
        //
        // The latent candidate is unshifted onto `candidates` BEFORE arbitration
        // (see ~:531); previously this fast path fired off the raw `latentMatch`
        // regardless of what arbitration decided, so the CONTEXT_MATCH_FLOOR the
        // candidate carries was never actually enforced and a low-confidence /
        // SHRUG'd match still emitted its reflex. Gating on
        // `arbitrationResult.type === 'TYPE_1'` AND candidate identity (the
        // chosen candidate's procedureData.name is the `latent-…` name minted at
        // injection) makes arbitration the sole authority over Type 1 dispatch.
        const arbitrationChoseLatent =
          arbitrationResult.type === 'TYPE_1' &&
          procedureData?.name?.startsWith('latent-') === true;

        // Guard: only use latent match if responseText is non-empty.
        if (arbitrationChoseLatent && latentMatch && latentMatch.pattern.responseText.trim().length > 0) {
          vlog('executing Type 1 latent reflex', {
            patternId: latentMatch.pattern.id.substring(0, 8),
            similarity: +latentMatch.similarity.toFixed(3),
            responsePreview: latentMatch.pattern.responseText.substring(0, 100),
          });
          this.logger.debug(
            `Type 1 reflex from latent space — returning cached response (no LLM).`,
          );
          // Base grounding from the pattern's stored provenance. LLM_ASSISTED is
          // mapped to UNKNOWN here (not at write time) because this is a pure
          // reflex replay — the LLM is not involved, so claiming it was
          // LLM_ASSISTED would be inaccurate (L2: no LLM_ASSISTED under lesion).
          let latentBaseGrounding = groundingForCachedPattern(latentMatch.pattern);

          // ── WS4 Ticket 5 (§3.2) — replay-time person-scope demotion ────────
          // INVARIANT: a pattern whose GROUNDED claim is backed by person A's
          // private OKG must NOT replay GROUNDED to person B. World/WKG-grounded
          // patterns (groundingPersonId === null) may replay GROUNDED to anyone.
          //
          // We demote (GROUNDED → UNKNOWN), we do NOT suppress: the cached reflex
          // still fires this turn (theater prohibition / no behavior cliff) — we
          // only strip the BORROWED grounding. Crucially this runs BEFORE
          // applyOkgRecallGrounding below, so if person B genuinely has the same
          // fact in B's OWN OKG, the re-ground re-GROUNDs it honestly off B's facts
          // and the demotion has cost nothing. The demotion only removes A's
          // grounding that B was never entitled to hear.
          const currentPersonId =
            (frame.raw['person_model'] as { personId?: string } | null | undefined)?.personId ?? null;
          const patternGpid = latentMatch.pattern.groundingPersonId; // null = world-scoped
          const scopeResult = applyPersonScopeDemotion(
            latentBaseGrounding,
            patternGpid,
            currentPersonId,
          );
          latentBaseGrounding = scopeResult.grounding;
          if (scopeResult.demoted) {
            this.logger.warn(
              `LATENT_PERSON_SCOPE_DEMOTION: pattern ${latentMatch.pattern.id.substring(0, 8)} ` +
                `grounded for person ${patternGpid} but replayed to ${currentPersonId ?? 'unknown'} — ` +
                `demoted GROUNDED→UNKNOWN (reflex still fires).`,
            );
          }

          // Type-1 fact-recall attribution: the stored pattern may carry
          // LLM_ASSISTED/UNKNOWN from when it was first written (e.g. the OKG
          // hadn't ingested the teach yet, or a later corpus run matched a social
          // pattern rather than the actual fact turn). A genuine recall hit is
          // upgraded to GROUNDED even if the stored grounding was conservative.
          //
          // WS3 Ticket T1: prefer the cycle's PRE-ARBITRATION recall retrieval so
          // the latent reflex carries the SAME once-resolved node id as the
          // procedure/deliberate paths. Falls back to the legacy post-hoc helper
          // when the turn isn't a resolvable recall (transitional — that helper
          // only upgrades via OKG recall, now owned by the pre-arbitration step).
          const latentPersonModel = frame.raw['person_model'] as
            { personId?: string; knownFacts?: string[] } | null | undefined;
          const latentInputText = (frame.raw['text'] as string | undefined) ?? inputSummary;
          let latentGrounding: KnowledgeGrounding;
          let latentProvenance: string | null;
          if (recallRetrieval) {
            const applied = applyRecallGroundingFromRetrieval(
              recallRetrieval, latentMatch.pattern.responseText, latentBaseGrounding,
            );
            latentGrounding = applied.grounding;
            latentProvenance = applied.provenance;
          } else {
            const legacy = applyOkgRecallGrounding(
              latentPersonModel?.personId,
              latentInputText,
              latentMatch.pattern.responseText,
              latentPersonModel?.knownFacts,
              latentBaseGrounding,
            );
            latentGrounding = legacy.grounding;
            latentProvenance = legacy.provenance;
          }

          executionResults.push({
            content: latentMatch.pattern.responseText,
            model: 'latent-space-type1',
            latencyMs: 0,
            // Grounding: stored provenance, upgraded by OKG recall attribution if
            // the current session's facts can verify it. LLM_ASSISTED is mapped to
            // UNKNOWN by groundingForCachedPattern (reflex replay has no LLM).
            knowledgeGrounding: latentGrounding,
            groundingProvenance: latentProvenance ?? undefined,
            // knowledge_retrieval metric gate: stamp the pre-arbitration recall
            // QUESTION classification (CANON Std-1 — reused, never recomputed; the
            // latent reflex runs no LLM monologue). Undefined for non-recall input
            // → persists as null → excluded from the QUESTION-gated denominator.
            intent: cycleRecallIntent,
          });
        } else if (arbitrationChoseLatent && latentMatch) {
          // Latent match found but responseText is empty — fall through to deliberation.
          this.logger.warn(
            `Latent match ${latentMatch.pattern.id.substring(0, 8)} has empty responseText — falling through to Type 2.`,
          );
          const deliberationResult = await this.deliberation.deliberate(frame, contextForPrediction, recallRetrieval);
          executionResults.push({
            content: deliberationResult.responseText,
            tokensUsed: deliberationResult.totalTokens,
            latencyMs: deliberationResult.totalLatencyMs,
            model: 'deliberation-pipeline',
            deliberationTrace: deliberationResult.trace,
            confidence: deliberationResult.confidence,
            knowledgeGrounding: deliberationResult.knowledgeGrounding,
            intent: deliberationResult.intent,
            groundingProvenance: deliberationResult.groundingProvenance ?? null,
            groundedBy: deliberationResult.groundedBy ?? null,
            degradedNoLlm: deliberationResult.degradedNoLlm,
          });
        } else if (procedureData !== null && (this.llm === null || this.llm.isAvailable())) {
          // Guard: skip procedure execution when the LLM is unavailable.
          // Procedure steps (e.g. LLM_GENERATE, RESEARCH_ENTITY) require the LLM.
          // When the LLM is down they return null → empty responseText → no
          // cb_speech → 45-second gate timeout (CANON §The Lesion Test).
          // Falling through to the deliberation branch below lets deliberate()
          // detect the unavailability and emit an honest degraded-SHRUG instead.
          for (const step of procedureData.actionSequence) {
            const result = await this.actionHandlerRegistry.execute(step, cycleContext);
            // CANON Standard 1: the procedure-handler path (e.g. LLM_GENERATE)
            // produces a fresh LLM response with NO knowledgeGrounding key, so
            // without this it would fall to the unconditional GROUNDED default.
            // A procedure-handler response is LLM-produced, not WKG-fact-backed —
            // honest grounding is LLM_ASSISTED (or UNKNOWN if it admits ignorance),
            // unless OKG recall provenance confirms the response surfaced a taught fact.
            if (result && typeof result['content'] === 'string' && result['knowledgeGrounding'] === undefined) {
              const procedureResponseText = result['content'] as string;
              const baseGrounding = groundingForCachedResponse(procedureResponseText);
              const procedurePersonModel = frame.raw['person_model'] as
                { personId?: string; knownFacts?: string[] } | null | undefined;
              const procedureRawText = (frame.raw['text'] as string | undefined) ?? inputSummary;

              // ── WS3 Ticket T1 — apply the PRE-ARBITRATION recall retrieval ──
              // This is THE structural close of the seed-greet bypass that forced
              // C1's post-hoc regex: the procedure path now consumes the SAME
              // node id the cycle resolved before arbitration (recallRetrieval),
              // instead of independently re-running recallKeyForQuestion over the
              // free-generated prose. The honesty guard (value must surface) lives
              // in applyRecallGroundingFromRetrieval, so C2 stays honest.
              let procedureGrounding: KnowledgeGrounding;
              let procedureProvenance: string | null;
              let procedureGroundedBy: 'OKG' | 'WKG' | null;
              if (recallRetrieval) {
                const applied = applyRecallGroundingFromRetrieval(
                  recallRetrieval, procedureResponseText, baseGrounding,
                );
                procedureGrounding = applied.grounding;
                procedureProvenance = applied.provenance;
                procedureGroundedBy = applied.groundedBy;
              } else {
                // TRANSITIONAL FALLBACK (WS3 T1): non-recall procedure turns (and
                // any recall the pre-arbitration step could not resolve) still use
                // the legacy post-hoc helper. This path no longer carries recall
                // provenance forward — it only ever reaches GROUNDED via OKG-recall,
                // which the pre-arbitration step now owns — so in practice this is a
                // no-op LLM_ASSISTED/UNKNOWN floor for non-recall procedure output.
                const legacy = applyOkgRecallGrounding(
                  procedurePersonModel?.personId,
                  procedureRawText,
                  procedureResponseText,
                  procedurePersonModel?.knownFacts,
                  baseGrounding,
                );
                procedureGrounding = legacy.grounding;
                procedureProvenance = legacy.provenance;
                // Empty WKG context here → discriminateGroundedBy can only return
                // 'OKG' or null; a GROUNDED via legacy OKG recall is person-scoped.
                procedureGroundedBy = discriminateGroundedBy(
                  procedureGrounding,
                  { entities: [], facts: [], relationships: [], procedures: [], summary: '' },
                  procedureResponseText,
                  procedurePersonModel?.knownFacts,
                  procedureProvenance,
                );
              }
              result['knowledgeGrounding'] = procedureGrounding;
              if (procedureProvenance) result['groundingProvenance'] = procedureProvenance;
              result['groundedBy'] = procedureGroundedBy;
              // knowledge_retrieval metric gate: stamp the pre-arbitration recall
              // QUESTION classification (CANON Std-1 — reused, never recomputed;
              // the procedure handler runs no LLM monologue). Only set when the
              // input is a recall question; otherwise left unset → persists as null
              // → correctly excluded from the QUESTION-gated denominator.
              if (cycleRecallIntent) result['intent'] = cycleRecallIntent;
            }
            executionResults.push(result);
          }
        } else {
          // Type 2 novel response — no procedure node. Run the full
          // deliberation pipeline: monologue → candidates → selection →
          // debate (conditional) → arbiter → commit.
          vlog('executing Type 2 deliberation (novel)', { inputSummary: inputSummary.substring(0, 80) });
          this.logger.debug('Type 2 novel: running deliberation pipeline');
          const deliberationResult = await this.deliberation.deliberate(frame, contextForPrediction, recallRetrieval);

          // ── Action dispatch: if the LLM detected a COMMAND and requested
          // an action (e.g. RESEARCH_ENTITY), dispatch it to the handler
          // registry. The verbal response is used as the response text.
          if (deliberationResult.actionRequest) {
            const { actionRequest } = deliberationResult;
            vlog('dispatching action request from deliberation', {
              stepType: actionRequest.stepType,
              target: actionRequest.target,
            });
            this.logger.log(
              `Action request: ${actionRequest.stepType} on "${actionRequest.target}"`,
            );

            const actionStep = {
              index: 0,
              stepType: actionRequest.stepType,
              params: { entity: actionRequest.target, query: actionRequest.target },
            };
            const actionResult = await this.actionHandlerRegistry.execute(actionStep, cycleContext);

            executionResults.push({
              content: actionRequest.verbalResponse,
              tokensUsed: deliberationResult.totalTokens,
              latencyMs: deliberationResult.totalLatencyMs,
              model: 'deliberation-pipeline+action',
              deliberationTrace: deliberationResult.trace,
              confidence: deliberationResult.confidence,
              knowledgeGrounding: deliberationResult.knowledgeGrounding,
              intent: deliberationResult.intent,
              groundingProvenance: deliberationResult.groundingProvenance ?? null,
              groundedBy: deliberationResult.groundedBy ?? null,
              actionResult,
            });
          } else {
            executionResults.push({
              content: deliberationResult.responseText,
              tokensUsed: deliberationResult.totalTokens,
              latencyMs: deliberationResult.totalLatencyMs,
              model: 'deliberation-pipeline',
              deliberationTrace: deliberationResult.trace,
              confidence: deliberationResult.confidence,
              knowledgeGrounding: deliberationResult.knowledgeGrounding,
              intent: deliberationResult.intent,
              groundingProvenance: deliberationResult.groundingProvenance ?? null,
              groundedBy: deliberationResult.groundedBy ?? null,
              degradedNoLlm: deliberationResult.degradedNoLlm,
            });
          }
        }
      } else {
        // SHRUG — arbitration found no actionable reflex. There are TWO kinds:
        //
        //   1. "Route to Type 2 because Type 1 wasn't confident"
        //      (gapTypes includes LOW_CONFIDENCE): candidates existed but were
        //      below threshold. Deliberation is legitimately allowed to reason a
        //      fresh response — Sylphie is not permanently mute. The pipeline
        //      grounds its own output honestly (inferGrounding → UNKNOWN if it
        //      ends up admitting ignorance).
        //
        //   2. "Genuine incomprehension — nothing matches"
        //      (MISSING_CONTEXT or CONTRADICTION, and NOT LOW_CONFIDENCE): the
        //      input is novel/contradictory with no contextual foothold. We may
        //      still let deliberation attempt a response so Sylphie isn't mute,
        //      BUT this is the Shrug Imperative's domain — the emitted
        //      arbitrationType stays SHRUG (honest), and we must NOT write the
        //      result back to the latent space / WKG as a learned reflex. Caching
        //      a guessed answer to genuinely-incomprehensible input is exactly
        //      the confabulation the Provability Gate must not bake in.
        //
        // CANON Standard 4 (Shrug Imperative) + Standard 1 (Theater Prohibition).
        const rawText = frame.raw['text'] as string | undefined;
        const shrugGapTypes = arbitrationResult.shrugDetail?.gapTypes ?? [];
        isGenuineIncomprehensionShrug =
          !shrugGapTypes.includes('LOW_CONFIDENCE') &&
          (shrugGapTypes.includes('MISSING_CONTEXT') ||
            shrugGapTypes.includes('CONTRADICTION'));

        // CANON Standard 4 (Shrug Imperative): a SHRUG MUST NOT be bypassed by a
        // cached latent reflex. Previously this branch re-emitted the raw
        // `latentMatch` response here even though arbitration SHRUG'd —
        // overriding the honest "I don't have a confident answer" with a
        // confabulated one. That fast path is DELETED. When arbitration SHRUGs,
        // the only paths are: deliberate a fresh, honestly-grounded response (so
        // Sylphie isn't mute), or — with no text to reason about — stay silent.
        // The latent candidate, if any, was already offered to arbitration as a
        // candidate; arbitration's decision to SHRUG is final.
        if (rawText && rawText.length > 0) {
          // Run the full deliberation pipeline.
          this.logger.debug('SHRUG with text input — running deliberation pipeline.');
          const deliberationResult = await this.deliberation.deliberate(frame, contextForPrediction, recallRetrieval);

          // Handle action requests from SHRUG+deliberation path too.
          if (deliberationResult.actionRequest) {
            const { actionRequest } = deliberationResult;
            this.logger.log(`SHRUG action request: ${actionRequest.stepType} on "${actionRequest.target}"`);
            const actionStep = {
              index: 0,
              stepType: actionRequest.stepType,
              params: { entity: actionRequest.target, query: actionRequest.target },
            };
            const actionResult = await this.actionHandlerRegistry.execute(actionStep, cycleContext);
            executionResults.push({
              content: actionRequest.verbalResponse,
              tokensUsed: deliberationResult.totalTokens,
              latencyMs: deliberationResult.totalLatencyMs,
              model: 'deliberation-pipeline+action',
              deliberationTrace: deliberationResult.trace,
              knowledgeGrounding: deliberationResult.knowledgeGrounding,
              intent: deliberationResult.intent,
              groundingProvenance: deliberationResult.groundingProvenance ?? null,
              groundedBy: deliberationResult.groundedBy ?? null,
              confidence: deliberationResult.confidence,
              actionResult,
            });
          } else {
            executionResults.push({
              content: deliberationResult.responseText,
              tokensUsed: deliberationResult.totalTokens,
              latencyMs: deliberationResult.totalLatencyMs,
              model: 'deliberation-pipeline',
              deliberationTrace: deliberationResult.trace,
              knowledgeGrounding: deliberationResult.knowledgeGrounding,
              intent: deliberationResult.intent,
              groundingProvenance: deliberationResult.groundingProvenance ?? null,
              groundedBy: deliberationResult.groundedBy ?? null,
              confidence: deliberationResult.confidence,
              degradedNoLlm: deliberationResult.degradedNoLlm,
            });
          }
        } else {
          this.logger.debug(
            `SHRUG result — no text input, skipping action dispatch. Reason: ${arbitrationResult.reason}`,
          );
        }
      }

      // ── Step 7: EXECUTING -> OBSERVING ────────────────────────────────────
      this.executorEngine.transition(ExecutorState.OBSERVING);

      // Prediction evaluation is deferred to reportOutcome(), which is called
      // by Communication after the response is delivered and real drive effects
      // are observed. Evaluating here with empty driveEffectsObserved would
      // produce meaningless MAE values.
      //
      // Stale predictions for non-selected candidates are cleaned up by
      // pruneStale() at the start of each cycle.

      // Record the arbitration result in the attractor monitor so the
      // TYPE_2_ADDICT detector has data to work with.
      const arbitrationLabel: 'type1' | 'type2' | 'shrug' =
        arbitrationResult.type === 'TYPE_1' ? 'type1'
        : arbitrationResult.type === 'TYPE_2' ? 'type2'
        : 'shrug';
      this.attractorMonitor.recordArbitration(arbitrationLabel);

      // ── Step 8: OBSERVING -> LEARNING ─────────────────────────────────────
      this.executorEngine.transition(ExecutorState.LEARNING);

      // Encode episode for all non-SHRUG results. SHRUG cycles still encode
      // (they carry diagnostic value) but at SHALLOW depth to conserve buffer
      // capacity.
      //
      // WS5 T1.0: the encode-attention term now admits a salient-but-calm visual
      // frame. `attention` is the MAX of the drive-derived computeAttention AND
      // the scene-saliency term (the phasic surprise cached early this cycle,
      // floored at 0.05). The encode gate (episodic-memory.service:185) is an OR
      // over attention/arousal, so this is an ADDITIONAL admission path, not a
      // new AND. saliencyTerm feeds the attention channel ONLY — it never touches
      // arousal (which stays a drive-derived ageWeight/consolidation weight) and
      // never feeds Curiosity/Anxiety (ashby — else the perception→drive loop
      // re-forms through the attention edge).
      const driveAttention = computeAttention(driveSnapshot);
      const attention = Math.max(driveAttention, saliencyTerm(cachedSceneSurprise));
      const arousal = computeArousal(driveSnapshot);
      const encodingDepth = arbitrationResult.type === 'SHRUG' ? 'SHALLOW' : 'NORMAL';

      const actionId =
        arbitrationResult.type !== 'SHRUG'
          ? (arbitrationResult.candidate.procedureData?.id ??
              `type2-novel-${Date.now()}`)
          : 'SHRUG';

      // WS5 T1.1/T1.2/T1.3 — modality discriminant + visual content.
      // `source` is REQUIRED (CANON Std 1): a conversation turn (real text
      // content in the frame) is 'conversation'; a vision-dominant frame is
      // 'perception'. We never default-stamp an unknown — the deserialization
      // shim handles pre-T1 rows with the 'legacy' sentinel. visualContext is
      // populated only when there is visual content to carry, each sub-field with
      // its own provenance tier (caption=LLM_GENERATED, sceneLabels=SENSOR,
      // personIds=INFERENCE).
      const visualContext = buildVisualContext(frame, sceneSnapshot);
      const episodeSource: EpisodeSource = deriveEpisodeSource(frame, visualContext);

      // WS4 Ticket 3 — speaker attribution on episodic memory.
      // currentTurnContext carries the speaker identity from the in-flight InboundTurn.
      // Self-initiated ticks have no currentTurnContext; speakerId/speakerIsGuardian
      // are omitted so episodes correctly reflect no human speaker. T0.9: a
      // synthetic perception frame has no currentTurnContext, so speakerIsGuardian
      // is structurally absent — a seen-fact never masquerades as guardian-told.
      await this.episodicMemory.encode(
        {
          source: episodeSource,
          ...(visualContext !== null ? { visualContext } : {}),
          driveSnapshot,
          inputSummary,
          actionTaken: actionId,
          contextFingerprint,
          // P1 #0+#3 — stamp the embedding/fingerprint scheme version that
          // produced `contextFingerprint` (generateFingerprint bakes the same
          // EMBEDDING_VERSION into the hash preimage). First-class provenance.
          embeddingVersion: EMBEDDING_VERSION,
          attention,
          arousal,
          ...(this.currentTurnContext !== null ? {
            speakerId: this.currentTurnContext.originator.userId,
            speakerIsGuardian: this.currentTurnContext.originator.isGuardian,
          } : {}),
        },
        encodingDepth,
      );

      // NOTE: Confidence updates are intentionally NOT performed here in the
      // LEARNING phase. They are deferred to reportOutcome(), which is called by
      // Communication after response delivery when real outcome data (guardian
      // feedback, drive deltas) is available. Updating here would cause double
      // reinforcement — every action would get an unconditional confidence boost
      // in addition to the outcome-based update in reportOutcome().

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
      // CANON Standard 1 (Theater Prohibition): the default grounding is NOT
      // GROUNDED. A response is GROUNDED only when it is backed by real WKG
      // entity/fact hits — which is asserted by the path that produced it
      // (deliberation via inferGrounding, latent/procedure via
      // groundingForCachedResponse). An unlabeled reflex must never be reported
      // as GROUNDED, since that would fabricate provenance the system never
      // verified. LLM_ASSISTED is the honest, conservative floor.
      let responseGrounding: KnowledgeGrounding = 'LLM_ASSISTED';
      let responseGroundingProvenance: string | null = null;
      // WS4 Ticket 5 (§3.1) — which source produced a GROUNDED verdict, threaded
      // from the deliberation/procedure path that produced this turn's response.
      // Authoritative input to the write-time person-scoper below.
      let responseGroundedBy: 'OKG' | 'WKG' | null = null;
      let responseDegradedNoLlm = false;
      // Deliberation intent for this turn (knowledge_retrieval metric gate).
      // Undefined for procedure/latent reflex paths that never classify intent —
      // those turns are correctly excluded from the QUESTION-gated metric rather
      // than fabricating an intent (CANON Std-1).
      let responseIntent: string | undefined;

      for (const result of executionResults) {
        if (result && typeof result['content'] === 'string') {
          responseText = result['content'] as string;
          responseModel = result['model'] as string | undefined;
          responseTokens = result['tokensUsed'] as { prompt: number; completion: number } | undefined;
          // Extract knowledge grounding from deliberation results
          if (result['knowledgeGrounding']) {
            responseGrounding = result['knowledgeGrounding'] as KnowledgeGrounding;
          }
          // Thread deliberation intent (copied, never recomputed) for the
          // knowledge_retrieval self-model metric. Only the deliberation paths
          // set this key; procedure/latent results leave it undefined.
          if (typeof result['intent'] === 'string') {
            responseIntent = result['intent'];
          }
          // Thread OKG provenance reference (Standard 1: GROUNDED must carry the node id).
          if (typeof result['groundingProvenance'] === 'string') {
            responseGroundingProvenance = result['groundingProvenance'];
          }
          // WS4 Ticket 5 (§3.1): thread the GROUNDED source discriminator. Only a
          // string value 'OKG'/'WKG' overrides; an absent/null key leaves it null
          // (ambiguous → person-scoped at the write site below).
          if (result['groundedBy'] === 'OKG' || result['groundedBy'] === 'WKG') {
            responseGroundedBy = result['groundedBy'];
          } else if (result['groundedBy'] === null) {
            responseGroundedBy = null;
          }
          // Did deliberation degrade because the LLM was unavailable? If so this
          // turn is an honest no-LLM SHRUG, not the TYPE_2 arbitration chose.
          if (result['degradedNoLlm'] === true) {
            responseDegradedNoLlm = true;
          }
          break;
        }
      }

      // CANON §The Lesion Test: when deliberation could not run because the LLM
      // was unavailable, the cycle's *delivered* behavior is a SHRUG regardless
      // of what arbitration selected (it had no way to know the LLM would be
      // gone at deliberation time). Override the emitted arbitrationType so the
      // CycleResponse honestly reports a SHRUG and never a phantom TYPE_2.
      const emittedArbitrationType: CycleResponse['arbitrationType'] =
        responseDegradedNoLlm ? 'SHRUG' : arbitrationResult.type;

      // Keep arbitrationType and arbitrationResult consistent. When degraded,
      // emit a SHRUG result so reportOutcome() and any consumer reading
      // arbitrationResult.type agree with the emitted SHRUG label. If arbitration
      // already SHRUG'd, preserve its original shrugDetail; otherwise (it chose
      // TYPE_2) synthesize a LOW_CONFIDENCE detail — a candidate existed but the
      // path that would have raised its confidence, deliberation, was gone.
      const degradedReason =
        'LLM unavailable — deliberation could not run; degraded to honest SHRUG.';
      const emittedArbitrationResult: ArbitrationResult = !responseDegradedNoLlm
        ? arbitrationResult
        : arbitrationResult.type === 'SHRUG'
          ? arbitrationResult
          : {
              type: 'SHRUG',
              reason: degradedReason,
              shrugDetail: {
                gapTypes: ['LOW_CONFIDENCE'],
                candidateConfidences: [arbitrationResult.candidate.confidence],
                threshold: 0.5,
                reason: degradedReason,
              },
            };

      const cycleLatencyMs = Date.now() - cycleStartTime;

      // ── Latent space + WKG write-back ────────────────────────────────────
      // If this cycle produced a response (Type 2 or SHRUG-with-LLM-fallback),
      // write per-modality patterns to the latent space so Type 1 catches it
      // next time on the relevant modality stream. Also write to WKG.
      //
      // Patterns are written at LOW initial confidence (0.3) because we don't
      // yet know if the response was good. reportOutcome() updates confidence
      // later based on real outcome data (guardian feedback, drive deltas).
      //
      // A degraded no-LLM SHRUG is NEVER written back: it is a transient
      // unavailability artifact, not a learned response. Caching it would teach
      // Sylphie to reflexively shrug on these inputs once the LLM returns —
      // exactly the regression the Lesion Test must not bake in.
      //
      // A genuine-incomprehension SHRUG (MISSING_CONTEXT / CONTRADICTION) is
      // likewise NEVER written back: the input had no contextual foothold, so
      // any response deliberation produced is a guess. Caching it as a Type 1
      // reflex would re-introduce confabulation — CANON Standard 4 (Shrug
      // Imperative). Sylphie still SPEAKS the response this turn (not mute), but
      // does not LEARN it as a graduated reflex.
      let latentPatternIds: string[] = [];

      if (
        responseText.length > 0 &&
        !multiModalMatch &&
        !responseDegradedNoLlm &&
        !isGenuineIncomprehensionShrug
      ) {
        // Only write if this was NOT already a latent space hit (avoid duplication)
        try {
          const wkgCtx = await this.wkgContext.getContextForFrame(frame);
          const entityIds = wkgCtx.entities.map((e) => e.nodeId);

          // ── WS4 Ticket 5 (§3.1) — write-time person-scoping ────────────────
          // Decide whether a GROUNDED claim this pattern would replay is
          // world-knowledge (anyone may hear it) or backed by THIS speaker's
          // private OKG (only they may hear it grounded).
          //
          // DISCRIMINATE BY VERDICT SOURCE, NOT AMBIENT CONTEXT (mythos's fix).
          // The grounding verdict is produced by a PRIORITY-ORDERED cascade
          // (deliberation.service.ts) where OKG person-fact recall WINS over
          // topical-WKG backing. A verdict can therefore be GROUNDED-because-of-OKG
          // while the WKG context independently contains an UNRELATED topical
          // entity (e.g. a stray capitalized word matched as an :Entity). The old
          // predicate re-derived backing from that ambient WKG context — so the
          // mere PRESENCE of any topical entity flipped an OKG person-fact to
          // world-scope and leaked it cross-person (mythos live-verified: the
          // "Your name is Jim" trio stored grounding_person_id=NULL because an
          // unrelated "Remind" entity was in context).
          //
          // The fix threads `responseGroundedBy` ('OKG' | 'WKG' | null) from the
          // exact point the cascade decided which rule fired. We world-scope ONLY
          // when the source was provably 'WKG'. Every other case — 'OKG', or a
          // null/ambiguous/mixed source on a GROUNDED verdict — person-scopes to
          // the current speaker.
          //
          // CONSERVATIVE-WHEN-AMBIGUOUS RULE (§3.1): ambiguity → person-scope,
          // NEVER world-scope. The asymmetry is intentional: a false person-scope
          // costs at most one re-deliberation when person B later asks the same
          // world fact; a false world-scope LEAKS a person fact across the privacy
          // wall. We pay the cheap error, never the expensive one.
          const currentSpeakerId =
            (frame.raw['person_model'] as { personId?: string } | null | undefined)?.personId ?? null;
          let groundingPersonId: string | null = null;
          if (responseGrounding === 'GROUNDED') {
            // World-scope (null) ONLY for a provably-WKG-sourced verdict. OKG and
            // any ambiguous/unknown source → person-scope to the current speaker.
            groundingPersonId = responseGroundedBy === 'WKG' ? null : currentSpeakerId;
            if (groundingPersonId !== null) {
              this.logger.debug(
                `Latent write-time person-scope: pattern GROUNDED via ` +
                  `${responseGroundedBy ?? 'ambiguous'} source — scoping to speaker ${groundingPersonId}.`,
              );
            }
          }

          // nomic asymmetry: the per-turn frame embeddings are QUERIES
          // (`search_query:`), but a stored pattern is a DOCUMENT
          // (`search_document:`). Re-embed the text STIMULUS as a document so a
          // future `search_query:` input retrieves it from the correct sub-space.
          // Non-text modalities (audio/video) carry no prefix asymmetry — keep
          // their fused query embeddings unchanged.
          const storageEmbeddings = await this.toDocumentEmbeddings(frame);

          // Write per-modality patterns (text, audio, video — not drives/faces)
          latentPatternIds = await this.latentSpace.writeMultiModal(
            storageEmbeddings,
            responseText,
            {
              procedureId: actionId !== 'SHRUG' ? actionId : undefined,
              confidence: 0.3,
              deliberationSummary: `${arbitrationResult.type} response to: ${inputSummary}`,
              entityIds,
              sessionId: driveSnapshot.sessionId,
              // Persist the response grounding at write time so the Type 1 reflex
              // path can replay it honestly via groundingForCachedPattern(), instead
              // of inferring it from entityIds which may include non-fact base-context
              // nodes (Drive/CoBeing) that don't constitute provenance evidence.
              knowledgeGrounding: responseGrounding,
              // WS4 Ticket 5 (§3.1) — whose OKG backs a GROUNDED replay. null =
              // world-scoped (proven WKG-backed); non-null = scoped to this speaker.
              groundingPersonId,
            },
          );
          const primaryPatternId = latentPatternIds[0] ?? randomUUID();

          // §A.14 (Ticket 2): this write-back CREATES a new ActionProcedure node
          // in the WORLD graph — a real knowledge gain that should earn honest
          // curiosity relief. Stamp the new node with a stable attribution marker
          // (newProcMarker) and diff a before/after WKG snapshot against THAT
          // marker via the SHARED computeInformationGain honesty gate. The diff
          // is keyed by the cycle actionId so reportOutcome() (called later by
          // Communication with the same actionId) forwards informationGainMetrics
          // to the Drive Engine. If the snapshot can't be captured or the change
          // can't be cleanly attributed, the shared gate returns UNVERIFIED →
          // zero relief (honest-red), never a fabricated number.
          const newProcMarker = `wkg-proc-write:${actionId}:${primaryPatternId.substring(0, 8)}`;
          const beforeSnapshot = await this.wkgContext.captureWkgSnapshot();

          // Write ActionProcedure to WKG (also at low initial confidence)
          const procedureId = await this.wkgContext.writeActionProcedure({
            name: `learned-${primaryPatternId.substring(0, 8)}`,
            category: 'LearnedResponse',
            triggerContext: inputSummary,
            responseText,
            actionSequence: [{
              index: 0,
              stepType: 'LLM_GENERATE',
              params: { instruction: responseText },
            }],
            provenance: 'INFERENCE',
            confidence: 0.3,
            entityIds,
            motivatingDrive: dominantDrive,
            // Attribution marker for the WKG-diff honesty gate.
            lastActionId: newProcMarker,
          });

          // Diff the snapshot pair and attribute to THIS write's marker. A dedup
          // hit (procedureId is an existing node, no new marker landed) → no
          // node carries newProcMarker → the gate returns UNVERIFIED (honest:
          // no NEW knowledge was created this cycle).
          try {
            const afterSnapshot = await this.wkgContext.captureWkgSnapshot();
            const gain = computeInformationGain(beforeSnapshot, afterSnapshot, newProcMarker);
            if (myEpoch === undefined || this.cycleGuard.isEpochCurrent(myEpoch)) {
              this.pendingInfoGain.set(actionId, gain);
              if (this.pendingInfoGain.size > this.MAX_PENDING_LATENT) {
                const oldest = this.pendingInfoGain.keys().next().value;
                if (oldest !== undefined) this.pendingInfoGain.delete(oldest);
              }
            }
            vlog('write-back info-gain', {
              actionId,
              source: gain.source,
              newNodes: gain.newNodes,
              confidenceDeltas: +gain.confidenceDeltas.toFixed(4),
              resolvedErrors: gain.resolvedErrors,
            });
          } catch (diffErr) {
            this.logger.warn(`Write-back info-gain diff failed: ${diffErr}`);
          }

          this.logger.debug(
            `Write-back: ${latentPatternIds.length} modality patterns (confidence=0.3), ` +
              `wkg_proc=${procedureId?.substring(0, 8) ?? 'none'}, ` +
              `entities=${entityIds.length}`,
          );
        } catch (err) {
          this.logger.warn(`Write-back failed: ${err}`);
        }
      }

      // Track latent pattern IDs for outcome-based confidence updates.
      // reportOutcome() will look these up to adjust pattern confidence
      // based on real results (guardian feedback, drive deltas).
      //
      // WS4 Ticket 1 — epoch fence (spec §3.6): a watchdog-killed cycle whose
      // promise resolves late must NOT mutate pendingLatentPatterns. Check epoch
      // before the write. This is fence site :1222 from the spec.
      if (latentPatternIds.length > 0 && (myEpoch === undefined || this.cycleGuard.isEpochCurrent(myEpoch))) {
        this.pendingLatentPatterns.set(actionId, latentPatternIds);
        // LRU eviction: remove oldest entries when cap is exceeded.
        if (this.pendingLatentPatterns.size > this.MAX_PENDING_LATENT) {
          const oldest = this.pendingLatentPatterns.keys().next().value;
          if (oldest !== undefined) {
            this.pendingLatentPatterns.delete(oldest);
          }
        }
      }

      // CANON Std-2 (Ticket: correlationId origin) — capture the ORIGIN
      // correlation id for this action so reportOutcome() can propagate it to
      // the Drive Engine. The inbound turnId (minted at the gateway boundary) is
      // the natural anchor that ties the inbound action event to the drive
      // event(s) it later causes; when there is no turn (self-tick / perception
      // frame) we fall back to a deterministic `action:<actionId>`. Epoch-fenced
      // like the pending maps above. The drive-side resolveCorrelationId() keeps
      // the derive path as the fallback when origin supplies none.
      if (actionId !== 'SHRUG' && (myEpoch === undefined || this.cycleGuard.isEpochCurrent(myEpoch))) {
        const originTurnId =
          this.currentTurnContext?.turnId ??
          (frame.raw['turn_id'] as string | undefined);
        const correlationId = originTurnId ? `turn:${originTurnId}` : `action:${actionId}`;
        this.pendingCorrelationId.set(actionId, correlationId);
        if (this.pendingCorrelationId.size > this.MAX_PENDING_LATENT) {
          const oldest = this.pendingCorrelationId.keys().next().value;
          if (oldest !== undefined) this.pendingCorrelationId.delete(oldest);
        }
      }

      // Only emit a CycleResponse if there is actual text to deliver.
      // Empty responses cause the frontend to show "Sylphie speaks" with no content.
      const emittedActionId = responseDegradedNoLlm ? 'SHRUG' : actionId;

      // WS4 Ticket 1 — epoch fence (spec §3.6, CRITICAL): the most important fence.
      // A watchdog-killed cycle that resolves late (e.g. Ollama eventually responds at
      // T+28s) MUST NOT emit a second CycleResponse. The watchdog already:
      //   (a) incremented cycleEpoch (step 3 of recovery), and
      //   (b) emitted an honest SHRUG for this turn (step 4).
      // A second emit would produce two contradictory responses for the same turnId
      // — a CANON Theater Prohibition violation. Abort silently if epoch is stale.
      // This is fence site :1248 from the spec.
      if (myEpoch !== undefined && !this.cycleGuard.isEpochCurrent(myEpoch)) {
        this.logger.warn(
          `Zombie cycle detected (epoch ${myEpoch} vs current ${this.cycleGuard.cycleEpoch}) — ` +
          `aborting CycleResponse emit. Watchdog already handled this turn.`,
        );
        return;
      }

      if (responseText.trim().length > 0) {
        vlog('emitting CycleResponse', {
          arbitrationType: emittedArbitrationType,
          degradedNoLlm: responseDegradedNoLlm,
          actionId: emittedActionId,
          responseLength: responseText.length,
          responsePreview: responseText.substring(0, 100),
          model: responseModel,
          latencyMs: cycleLatencyMs,
          knowledgeGrounding: responseGrounding,
          ...(responseTokens ? { tokens: responseTokens } : {}),
        });
        // WS4 Ticket 3 — use the atomic turn context (turnId + originator).
        // currentTurnContext carries both atomically so a zombie cannot emit
        // the successor's originator. Self-initiated ticks have no context and
        // generate a fresh UUID; originator is absent.
        const emitTurnId = this.currentTurnContext?.turnId ?? randomUUID();
        const emitOriginator = this.currentTurnContext?.originator;

        // ── Self-model: capture a GENUINELY PROACTIVE social bid ───────────────
        // social_interaction (Std-1) denominator = self-initiated comments only.
        // Proactive ⟺ this cycle had NO inbound guardian turn: no
        // currentTurnContext (so emitOriginator is undefined) AND no frame
        // turn_id (perception/self-tick frames carry none). A degraded SHRUG
        // (LLM unavailable) is not a real communicative bid, so it is excluded.
        // We are inside the `responseText.trim().length > 0` real-emit block and
        // past both epoch fences, so this fires at most once per emitted turn and
        // never for a zombie. Consumed by reportOutcome() to emit
        // SOCIAL_COMMENT_INITIATED. session_id MUST be non-null (the writer's
        // self-join keys on it) — driveSnapshot.sessionId is always a real string.
        const isProactiveSocialBid =
          emitOriginator === undefined &&
          (frame.raw['turn_id'] as string | undefined) == null &&
          !responseDegradedNoLlm &&
          emittedActionId !== 'SHRUG';
        if (isProactiveSocialBid) {
          this.pendingProactiveSocial.set(actionId, {
            turnId: emitTurnId,
            sessionId: driveSnapshot.sessionId,
            initiatedAt: Date.now(),
          });
          if (this.pendingProactiveSocial.size > this.MAX_PENDING_LATENT) {
            const oldest = this.pendingProactiveSocial.keys().next().value;
            if (oldest !== undefined) this.pendingProactiveSocial.delete(oldest);
          }
        }

        this.responseSubject.next({
          turnId: emitTurnId,
          ...(emitOriginator !== undefined ? { originator: emitOriginator } : {}),
          text: responseText,
          arbitrationType: emittedArbitrationType,
          actionId: emittedActionId,
          driveSnapshot,
          arbitrationResult: emittedArbitrationResult,
          latencyMs: cycleLatencyMs,
          // No model produced a degraded SHRUG — the LLM was unavailable.
          model: responseDegradedNoLlm ? undefined : responseModel,
          tokensUsed: responseDegradedNoLlm ? undefined : responseTokens,
          knowledgeGrounding: responseGrounding,
          groundingProvenance: responseGroundingProvenance ?? undefined,
          // WS3 T5: thread the GROUNDED source ('OKG'|'WKG') so a consumer can
          // verify groundingProvenance against the correct live Neo4j instance.
          groundedBy: responseGroundedBy ?? undefined,
          // Deliberation intent — persisted on RESPONSE_GENERATED so the
          // knowledge_retrieval metric can gate its denominator on QUESTION turns.
          ...(responseIntent !== undefined ? { intent: responseIntent } : {}),
          preExecutionDriveSnapshot: driveSnapshot.pressureVector,
          latentPatternIds: latentPatternIds.length > 0 ? latentPatternIds : undefined,
          // Tensor metadata — populated when sidecar was available this cycle
          ...(tensorResult ? {
            tensorTopCategory: tensorResult.tensorTopCategory ?? undefined,
            tensorUrgency: tensorResult.urgency,
            tensorConsensus: tensorResult.consensus,
            bootstrapMode: tensorResult.bootstrapMode,
            // The exact 1561-dim assembled vector for this cycle — copied (never
            // reconstructed) from the sidecar so it stays byte-identical to what
            // the sidecar's _split_input_vector() expects. Lets the supervisor
            // thread it into reinforce/correct. Omitted when the sidecar did not
            // surface one (older build / non-tensor path) so reinforce/correct
            // skip honestly rather than firing on a fabricated vector.
            ...(tensorResult.globalInputVector
              ? { globalInputVector: tensorResult.globalInputVector }
              : {}),
          } : {}),
          inputCategory: processInputResult.inputCategory,
        });
      } else {
        this.logger.debug(
          `Decision cycle produced empty responseText — suppressing CycleResponse emission.`,
        );
      }

      // ── WS3 Ticket T2 — knowledge use→reinforce edge (compounding) ─────────
      // A successful grounded recall-and-USE event reinforces the fact node that
      // grounded the delivered answer (ACT-R, capped at the 0.60 ceiling). This
      // is the compounding mechanism: today fact nodes only ever decay or bump on
      // re-extraction; here a recalled-and-used fact gets its retrieval count and
      // last-retrieval timestamp advanced and its confidence recomputed.
      //
      // The "use" event is precisely: the cycle's grounding verdict is GROUNDED
      // AND it carries a real provenance node id (the fact actually SURFACED in
      // the delivered response — the honesty guard in applyRecallGroundingFromRetrieval
      // already enforced surfacing before setting GROUNDED+provenance). A retrieval
      // that did not surface (paraphrased away) carries null provenance and is NOT
      // reinforced — that is a different count (T3/T4 distinguish them).
      //
      // IDEMPOTENT PER TURN: this fires at most once, after the single emit, on
      // the single resolved grounding node id. Both epoch fences are already past,
      // so a zombie/late cycle cannot reinforce. We only reinforce the node the
      // cycle resolved at retrieval time (recallRetrieval.factNodeId) AND that the
      // delivered verdict actually grounded on (responseGroundingProvenance) — when
      // those disagree we do nothing (a different/ambient node grounded it, not the
      // pre-resolved recall fact; we never reinforce a node we didn't recall-and-use).
      //
      // Std 3 ceiling + never-demote are enforced inside reinforceFactNode().
      if (
        responseGrounding === 'GROUNDED' &&
        typeof responseGroundingProvenance === 'string' &&
        responseGroundingProvenance.length > 0 &&
        recallRetrieval !== null &&
        recallRetrieval.factNodeId === responseGroundingProvenance
      ) {
        // Source: prefer the verdict's discriminator (WS4-T5), fall back to the
        // pre-arbitration retrieval's source. Both agree for a recall-grounded turn.
        const reinforceSource = responseGroundedBy ?? recallRetrieval.source;
        try {
          const result = await this.wkgContext.reinforceFactNode(
            responseGroundingProvenance,
            reinforceSource,
          );
          if (result) {
            this.logger.debug(
              `WS3-T2 reinforced ${reinforceSource} fact "${responseGroundingProvenance}": ` +
                `conf ${result.oldConfidence.toFixed(4)} -> ${result.newConfidence.toFixed(4)}, ` +
                `retrieval_count=${result.retrievalCount}`,
            );
          }
        } catch (err) {
          // Reinforcement is a best-effort compounding bump; never let it break
          // a cycle that already delivered its response.
          this.logger.warn(`WS3-T2 fact reinforcement failed: ${err}`);
        }
      }

      // ── Tensor training with real frame data ──────────────────────────────
      if (this.tensorInference && this.tensorInference.isAvailable()) {
        // Derive the action category from the REAL arbitration result, not the
        // degraded-SHRUG override: the tensor learns to predict arbitration from
        // frame+drives, and a transient LLM outage must not teach it to SHRUG on
        // otherwise-deliberable inputs.
        let trainCategory = 'SHRUG';
        if (arbitrationResult.type !== 'SHRUG') {
          trainCategory = arbitrationResult.candidate.procedureData?.category
            ?? 'ConversationalResponse';
        }
        this.tensorInference.submitTraining(
          frame,
          driveSnapshot,
          trainCategory,
          arbitrationResult.type,
          tensorResult?.tensorTopCategory,
        );
      }

      // WS4 Ticket 1 — epoch fence for tail reportOutcome calls (spec §3.6).
      // If this cycle was killed by the watchdog and the promise resolved late,
      // the epoch check above (before responseSubject.next) already returned.
      // This fence covers the rare case where both routeSensoryPredictionErrors
      // and the reportOutcome calls happen AFTER the emit check. Belt-and-suspenders.
      if (myEpoch !== undefined && !this.cycleGuard.isEpochCurrent(myEpoch)) {
        return; // Zombie — tail work aborted.
      }

      // ── Route sensory prediction errors to drives ─────────────────────────
      this.routeSensoryPredictionErrors(sensoryErrors, driveSnapshot);

      // ── Route scene-level prediction errors (per-object) to drives ──────
      // WS5 T1.0: consume the comparison cached EARLY this cycle (sceneComparison
      // computed at :832 before encode), NOT a recompute. Then advance the
      // predictor EXACTLY ONCE so predictions don't double-advance (which would
      // corrupt the next frame's surprise). The old code called
      // computeSceneErrors here, which both compared AND advanced — calling it a
      // second time (after the early compare) would advance twice.
      if (sceneSnapshot && sceneComparison) {
        // WS5 T1.0: route scene surprise to drives (Curiosity/Anxiety). This stays
        // epoch-gated (a zombie cycle must not write drives). The predictor advance
        // + familiarity/ring bookkeeping already happened EARLY this cycle (right
        // after the compare, ~:873) so it survives a late zombie — see note there.
        this.routeScenePredictionErrors(sceneComparison, driveSnapshot);
      }

      // CANON Std-2 (correlationId origin): anchor these tick-scoped pressure
      // emits to the inbound frame's turn when present, so the drive event they
      // raise traces to the same origin. No turn (perception-only frame) → the
      // deterministic `action:<id>` form (identical to the drive-side derive).
      const frameTurnId = frame.raw['turn_id'] as string | undefined;

      // ── Sustained curiosity for undiscovered visual objects ──────────────
      const undiscoveredCount = frame.raw['undiscovered_count'] as number | undefined;
      if (undiscoveredCount && undiscoveredCount > 0 && this.actionOutcomeReporter) {
        try {
          this.actionOutcomeReporter.reportOutcome({
            actionId: 'undiscovered-objects',
            correlationId: frameTurnId ? `turn:${frameTurnId}` : 'action:undiscovered-objects',
            actionType: 'UndiscoveredObjectPressure',
            success: false,
            metadata: {
              undiscoveredObjectCount: undiscoveredCount,
            },
            feedbackSource: 'INFERENCE',
            theaterCheck: {
              expressionType: 'none',
              correspondingDrive: null,
              driveValue: null,
              isTheatrical: false,
            },
          });
        } catch (err) {
          this.logger.warn(`Undiscovered object pressure routing failed: ${err}`);
        }
      }

      // ── Social pressure for unknown persons in view ─────────────────────
      const unknownPersonCount = frame.raw['unknown_person_count'] as number | undefined;
      if (unknownPersonCount && unknownPersonCount > 0 && this.actionOutcomeReporter) {
        try {
          this.actionOutcomeReporter.reportOutcome({
            actionId: 'unknown-persons',
            correlationId: frameTurnId ? `turn:${frameTurnId}` : 'action:unknown-persons',
            actionType: 'UnknownPersonPressure',
            success: false,
            metadata: {
              unknownPersonCount: unknownPersonCount,
            },
            feedbackSource: 'INFERENCE',
            theaterCheck: {
              expressionType: 'none',
              correspondingDrive: null,
              driveValue: null,
              isTheatrical: false,
            },
          });
        } catch (err) {
          this.logger.warn(`Unknown person pressure routing failed: ${err}`);
        }
      }

      vlog('cycle complete', {
        latencyMs: cycleLatencyMs,
        arbitrationType: arbitrationResult.type,
        actionId,
        responseChars: responseText.length,
        isType1Latent: !!latentMatch,
        model: responseModel,
      });

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

    // Whether this action has a procedure node (needed for confidence updates
    // and prediction evaluation, but NOT required for drive engine forwarding).
    const hasProcedureNode =
      arbitrationType !== 'SHRUG' &&
      !(
        arbitrationType === 'TYPE_2' &&
        outcome.selectedAction.arbitrationResult.candidate.procedureData === null
      );

    // ── Confidence updates & prediction evaluation (procedure-backed only) ──
    let predictionEvaluation: PredictionEvaluation | null = null;
    let isAccurate = outcome.predictionAccurate;

    if (hasProcedureNode) {
      // Evaluate prediction with real observed outcome.
      const predictionId = this.predictionService.getActivePredictionIdForAction(actionId);
      if (predictionId) {
        try {
          predictionEvaluation = this.predictionService.evaluatePrediction(predictionId, outcome);

          this.attractorMonitor.recordPrediction(
            predictionEvaluation.mae,
            predictionEvaluation.accurate,
          );

          vlog('prediction evaluated via reportOutcome', {
            predictionId: predictionId.substring(0, 8),
            actionId,
            mae: +predictionEvaluation.mae.toFixed(4),
            accurate: predictionEvaluation.accurate,
          });
        } catch (err) {
          this.logger.warn(`reportOutcome prediction evaluation failed for ${predictionId}: ${err}`);
        }
      }

      isAccurate = predictionEvaluation?.accurate ?? outcome.predictionAccurate;
      const confidenceOutcome: 'reinforced' | 'counter_indicated' = isAccurate
        ? 'reinforced'
        : 'counter_indicated';

      if (predictionEvaluation) {
        this.confidenceUpdater.recordPredictionMAE(actionId, predictionEvaluation.mae);
      }

      try {
        await this.confidenceUpdater.update(actionId, confidenceOutcome);
      } catch (err) {
        this.logger.warn(`reportOutcome confidence update failed for ${actionId}: ${err}`);
      }
    } else {
      this.logger.debug(
        `reportOutcome: skipping confidence update for ${arbitrationType} (no procedure node).`,
      );
    }

    // ── Forward to Drive Engine (ALL outcomes, including SHRUG) ─────────────
    // The drive engine needs to see every communication outcome so that
    // behavioral contingencies (social comment quality, satisfaction habituation,
    // etc.) can fire and relieve drives.
    if (this.actionOutcomeReporter) {
      // Extract procedure metadata for actionType.
      // SHRUG arbitration results don't carry a candidate, so we need to
      // narrow the union before accessing it.
      const arbResult = outcome.selectedAction.arbitrationResult;
      const procedureData =
        arbResult.type !== 'SHRUG' ? arbResult.candidate.procedureData : null;

      // Use the procedure's category for actionType when available.
      // Falls back to 'ConversationalResponse' for SHRUG/novel TYPE_2
      // so the rule engine and contingencies can match meaningfully.
      let actionType = 'ConversationalResponse';
      if (arbitrationType === 'TYPE_1') {
        actionType = procedureData?.category ?? 'ConversationalResponse';
      } else if (arbitrationType === 'TYPE_2' && procedureData) {
        actionType = procedureData.category;
      }

      // §A.14 (Ticket 2): forward the WKG-diff information-gain computed during
      // this action's write-back, if any. Consumed once (delete) so a stale
      // metric never re-attaches to a later outcome. Absent → omitted → the
      // drive grants zero curiosity relief (honest-red).
      const infoGain = this.pendingInfoGain.get(actionId);
      if (infoGain) this.pendingInfoGain.delete(actionId);

      try {
        this.actionOutcomeReporter.reportOutcome({
          actionId,
          // CANON Std-2 (Ticket: correlationId origin) — mint a correlationId at
          // the ACTION ORIGIN (this producer) and propagate it so the SAME id
          // ties this inbound action event to the drive event(s) it causes,
          // instead of the drive deriving `action:<id>` after the fact. The
          // drive-side derive remains the fallback when origin supplies none.
          correlationId: this.resolveOutcomeCorrelationId(actionId),
          actionType,
          success: isAccurate,
          feedbackSource: 'INFERENCE',
          theaterCheck: {
            expressionType: 'none',
            correspondingDrive: null,
            driveValue: null,
            isTheatrical: !outcome.selectedAction.theaterValidated,
          },
          predictionData: predictionEvaluation
            ? {
                predictionId: predictionEvaluation.predictionId,
                predictedValue: 0, // ideal MAE target
                actualValue: predictionEvaluation.mae, // real MAE
              }
            : undefined,
          informationGainMetrics: infoGain,
          // Set socialCommentTimestamp so the social comment quality
          // contingency fires, recording this as a Sylphie-initiated
          // comment and providing Social relief + Satisfaction bonus
          // when the guardian responds within 30 seconds.
          socialCommentTimestamp: Date.now(),
        });
      } catch (err) {
        this.logger.warn(`reportOutcome drive engine forwarding failed: ${err}`);
      }
    }

    // ── Self-model: emit SOCIAL_COMMENT_INITIATED for proactive bids ────────
    // ADDITIVE telemetry only — does NOT touch socialCommentTimestamp or any
    // drive-side behavior above. Fires at most once per actionId, ONLY for a
    // cycle that processInput() recorded as a genuinely proactive (self-tick,
    // no-originator) real communicative response. Reactive replies never have a
    // pendingProactiveSocial entry, so they are excluded from the
    // social_interaction success-rate denominator (Std-1). The writer's 24h
    // self-join keys on session_id, so we emit the captured non-null sessionId.
    const proactive = this.pendingProactiveSocial.get(actionId);
    if (proactive) {
      this.pendingProactiveSocial.delete(actionId);
      if (this.eventLogger) {
        try {
          this.eventLogger.log(
            'SOCIAL_COMMENT_INITIATED',
            {
              actionId,
              turnId: proactive.turnId,
              sessionId: proactive.sessionId,
              initiatedAt: proactive.initiatedAt,
            },
            this.driveStateReader.getCurrentState(),
            proactive.sessionId,
            this.resolveOutcomeCorrelationId(actionId),
          );
          vlog('SOCIAL_COMMENT_INITIATED emitted (proactive social bid)', {
            actionId,
            turnId: proactive.turnId,
            sessionId: proactive.sessionId,
          });
        } catch (err) {
          this.logger.warn(`SOCIAL_COMMENT_INITIATED emit failed for ${actionId}: ${err}`);
        }
      }
    }

    // ── Update latent space pattern confidence based on real outcome ────────
    // Patterns were written at speculative 0.3 confidence. Now that we have
    // real outcome data, adjust: boost on success, reduce on failure.
    if (hasProcedureNode) {
      const confidenceOutcome = isAccurate ? 'reinforced' : 'counter_indicated';
      const pendingPatterns = this.pendingLatentPatterns.get(actionId);
      if (pendingPatterns && pendingPatterns.length > 0) {
        const newConfidence = isAccurate ? 0.5 : 0.15;
        for (const patternId of pendingPatterns) {
          this.latentSpace.updateConfidence(patternId, newConfidence);
        }
        this.pendingLatentPatterns.delete(actionId);

        vlog('latent confidence updated via reportOutcome', {
          actionId,
          patternCount: pendingPatterns.length,
          outcome: confidenceOutcome,
          newConfidence,
        });
      }
    }
  }

  /**
   * Resolve the ORIGIN correlation id to propagate with an action outcome
   * (CANON Standard 2 — provenance origin one-hop).
   *
   * Returns the id captured at the action origin (cycle end) for this actionId,
   * consuming it once. When none was captured (e.g. a SHRUG, or an outcome
   * reported for an action this instance never produced), returns the
   * deterministic `action:<actionId>` — the SAME value the Drive Engine's
   * resolveCorrelationId() would otherwise derive, so the trace is identical and
   * never lost. The origin is authoritative; the drive-side derive is the
   * fallback.
   */
  private resolveOutcomeCorrelationId(actionId: string): string {
    const origin = this.pendingCorrelationId.get(actionId);
    if (origin) {
      this.pendingCorrelationId.delete(actionId);
      return origin;
    }
    return `action:${actionId}`;
  }

  // ---------------------------------------------------------------------------
  // Sensory prediction error → drive routing
  // ---------------------------------------------------------------------------

  /** Sensory prediction error thresholds and scaling factors. */
  private static readonly SENSORY_TEXT_THRESHOLD = 0.1;
  private static readonly SENSORY_AUDIO_THRESHOLD = 0.1;
  private static readonly SENSORY_VIDEO_THRESHOLD = 0.2;

  // ---------------------------------------------------------------------------
  // Tensor Candidate Construction
  // ---------------------------------------------------------------------------

  /**
   * Build an ActionCandidate from tensor inference results.
   *
   * The tensor's action_bias softmax gives a probability per category.
   * The argmax category becomes the candidate's category; the argmax
   * probability becomes its confidence score.
   *
   * In partial mode, confidence is capped below 0.80 (forces Type 2).
   * In full mode, confidence can exceed 0.80 (allows Type 1 reflex).
   */
  /**
   * Count of pattern write-backs that had to DROP their text modality because a
   * `search_document:`-prefixed document embedding could not be produced. Metered
   * (not silent) so the degradation is observable — a rising count means the text
   * encoder's document path is failing and learned patterns are losing their text
   * reflex. WS1 follow-up #3.
   */
  private documentWriteBackDegradations = 0;

  /** Read the degradation counter (diagnostic; no reset, monotonic per process). */
  getDocumentWriteBackDegradations(): number {
    return this.documentWriteBackDegradations;
  }

  /**
   * Produce the per-modality embeddings to STORE for a learned pattern.
   *
   * The frame's text embedding was produced by the fusion layer as a nomic
   * QUERY (`search_query:`). A stored pattern must live in the DOCUMENT
   * sub-space (`search_document:`) so a future query retrieves it correctly, so
   * we re-embed the raw text stimulus via the text encoder's document method.
   *
   * WS1 follow-up #3 — PROVENANCE-CORRECT FALLBACK (Standard 1).
   * If the text encoder, the raw text, or the document re-embed is unavailable,
   * we DROP the text modality from the write-back rather than store the QUERY
   * embedding mislabeled as a document. Storing a `search_query:`-space vector in
   * the document sub-space is a silent provenance lie: it sits in `learned_patterns`
   * indistinguishable from a correctly-prefixed document, and a future
   * `search_query:` lookup matches it against the WRONG sub-space — exactly the
   * mislabel this hardening pass exists to kill. Dropping the text key means the
   * pattern simply has no text reflex (the other modalities still persist), the
   * conversation path still answers via deliberation, and the degradation is
   * METERED + logged loudly instead of faked. Non-text modalities carry no nomic
   * query/document asymmetry and pass through unchanged.
   */
  private async toDocumentEmbeddings(
    frame: SensoryFrame,
  ): Promise<Record<string, number[]>> {
    const result: Record<string, number[]> = { ...frame.modality_embeddings };

    const rawText = frame.raw['text'];
    const textEncoder = this.modalityRegistry.get('text');
    const haveText = typeof rawText === 'string' && rawText.trim().length > 0;

    if (haveText && isDocumentEncoder(textEncoder)) {
      try {
        result['text'] = await textEncoder.encodeDocument(rawText as string);
      } catch (err) {
        // Re-embed FAILED. Do NOT store the query embedding (provenance lie).
        delete result['text'];
        this.documentWriteBackDegradations++;
        this.logger.warn(
          `Document re-embed for write-back FAILED — DROPPING text modality from this ` +
            `pattern (NOT storing the mislabeled query embedding; would violate Standard 1). ` +
            `Pattern persists without a text reflex. Degradations this process: ` +
            `${this.documentWriteBackDegradations}. Cause: ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
    } else if (haveText) {
      // We HAVE text but no document-capable encoder: the frame's text embedding
      // is a query-space vector. Storing it would mislabel the sub-space, so drop
      // it and meter, same as the failure path above.
      delete result['text'];
      this.documentWriteBackDegradations++;
      this.logger.warn(
        `No document-capable text encoder available for write-back — DROPPING text ` +
          `modality (NOT storing the query embedding; would violate Standard 1). ` +
          `Degradations this process: ${this.documentWriteBackDegradations}.`,
      );
    }

    return result;
  }

  private buildTensorCandidate(
    tensorResult: TensorInferenceResult,
    contextFingerprint: string,
    dominantDrive: DriveName,
  ): ActionCandidate | null {
    const topCategory = tensorResult.tensorTopCategory;
    if (!topCategory) return null;

    // Argmax probability from the action_bias softmax
    const maxProb = Math.max(...tensorResult.actionBias);
    if (maxProb < 0.30) return null; // Tensor too uncertain

    // Confidence gating by bootstrap mode
    const isFullMode = tensorResult.bootstrapMode === 'full';
    const mappedConfidence = isFullMode
      ? Math.min(0.95, maxProb)       // Allow Type 1 in full mode
      : Math.min(0.79, maxProb);      // Force Type 2 in partial mode

    return {
      procedureData: {
        id: `tensor-${topCategory}-${Date.now()}`,
        name: `tensor-${topCategory}`,
        category: topCategory,
        triggerContext: contextFingerprint,
        actionSequence: [{
          index: 0,
          stepType: 'LLM_GENERATE',
          params: {
            instruction: `Respond as ${topCategory} (tensor-guided)`,
            tensorUrgency: tensorResult.urgency,
            tensorNovelty: tensorResult.noveltyScore,
          },
        }],
        provenance: 'INFERENCE' as any,
        confidence: mappedConfidence,
      },
      confidence: mappedConfidence,
      motivatingDrive: dominantDrive,
      contextMatchScore: maxProb,
    };
  }

  /**
   * Route per-modality sensory prediction errors to drives.
   *
   * Text changes → curiosity (novel information to process).
   * Audio changes → curiosity + focus (unexpected sound demands attention).
   * Video changes → anxiety + focus (environment shifted).
   */
  private routeSensoryPredictionErrors(
    errors: Record<string, number>,
    snapshot: DriveSnapshot,
  ): void {
    const totalError = Object.values(errors).reduce((sum, e) => sum + e, 0);
    if (totalError < 0.05) return; // negligible

    if (this.actionOutcomeReporter) {
      try {
        this.actionOutcomeReporter.reportOutcome({
          actionId: 'sensory-prediction',
          actionType: 'SensoryPrediction',
          success: totalError < 0.3,
          metadata: { sensoryPredictionError: totalError },
          feedbackSource: 'INFERENCE',
          theaterCheck: {
            expressionType: 'none',
            correspondingDrive: null,
            driveValue: null,
            isTheatrical: false,
          },
        });
      } catch (err) {
        this.logger.warn(`Sensory prediction error routing failed: ${err}`);
      }
    }
  }

  /**
   * Route per-object scene prediction errors to drives.
   *
   * Novel person → curiosity + social.
   * Person left → mild anxiety.
   * Unknown face → curiosity + focus.
   * Known face identified → social (slight).
   * General scene instability → curiosity.
   *
   * WS5 T1.0: takes the ALREADY-COMPUTED comparison (cached early this cycle),
   * NOT a snapshot to recompute. The caller advances predictions exactly once
   * after this returns. This is the only place scene surprise reaches drives
   * (Curiosity/Anxiety) — the encode-attention saliency term (T1.0) deliberately
   * does NOT, so the perception→drive loop is broken, not relocated (ashby).
   */
  private routeScenePredictionErrors(
    result: ScenePredictionResult,
    _snapshot: DriveSnapshot,
  ): void {
    if (result.totalSurprise < 0.05) return;

    if (this.actionOutcomeReporter) {
      try {
        this.actionOutcomeReporter.reportOutcome({
          actionId: 'scene-prediction',
          actionType: 'ScenePrediction',
          success: result.totalSurprise < 0.2,
          metadata: { sceneSurprise: result.totalSurprise },
          feedbackSource: 'INFERENCE',
          theaterCheck: {
            expressionType: 'none',
            correspondingDrive: null,
            driveValue: null,
            isTheatrical: false,
          },
        });
        // WS5 P1a gate seam: record the routed outcome so the gate can assert on
        // the CAUSAL drive effect (computedEffects.curiosity>0, anxiety>0) without
        // polling the noisy net drive-vector delta. Called AFTER reportOutcome so
        // the seam reflects what was actually sent, not a speculative pre-call.
        this.scenePrediction.recordOutcomeRouted(result.totalSurprise);
      } catch (err) {
        this.logger.warn(`Scene prediction error routing failed: ${err}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Autonomous research target selection
  // ---------------------------------------------------------------------------

  /**
   * Pick a low-confidence Entity from the WKG that would benefit from research.
   *
   * Strategy: query entities with few relationships and moderate confidence
   * (enough to exist but not well-understood). Picks randomly from the top
   * candidates to avoid always researching the same thing.
   *
   * Returns null if no suitable target is found.
   */
  // ---------------------------------------------------------------------------
  // WS3 Ticket T1 — pre-arbitration grounded recall retrieval
  // ---------------------------------------------------------------------------

  /**
   * Resolve the grounding fact node id for a recall question ONCE, before
   * arbitration. Single-hop, provenance-carrying. Returns null for non-recall
   * input (cheap exit, no DB hit) and for recall input with no taught OKG fact
   * and no topical WKG entity (honest NOT_GROUNDED by construction).
   *
   * OKG self-fact recall is resolved purely from the frame's knownFacts (no DB
   * round-trip). The WKG single-hop fallback is only consulted when the OKG
   * misses AND the question is a recall — and it reuses getContextForFrame's
   * one fulltext hop, not a second traversal.
   *
   * CANON Std 4: the node id is real (deterministic attr-id for OKG; matched
   * node_id for WKG); never fabricated. Std 3: confidence is surfaced, not lifted.
   */
  private async computeRecallRetrieval(frame: SensoryFrame): Promise<RecallRetrieval | null> {
    const inputText = (frame.raw['text'] as string | undefined) ?? '';
    if (!inputText.trim()) return null;

    const personModel = frame.raw['person_model'] as
      { personId?: string; knownFacts?: string[] } | null | undefined;
    const personId = personModel?.personId ?? null;
    const knownFacts = personModel?.knownFacts;

    // ── WS3 C8 — semantic recall-key resolution (regex FIRST, embed fallback) ──
    // resolveRecallKey tries recallKeyForQuestion first (preserving C1 exactly,
    // and short-circuiting before any embed on a regex hit), and only on a regex
    // MISS embeds the question and cosine-matches it against the canonical forms
    // of the keys THIS person taught. Fail-closed: a null/zero-vector encoder
    // skips the semantic pass entirely → behavior == regex-only (never regresses
    // C1). A non-recall, non-paraphrase turn resolves to null → cheap exit below.
    const encoder = this.recallKeyEncoder();
    const resolvedKey = await resolveRecallKey(inputText, knownFacts, encoder);
    // Not a recall question (regex miss + no semantic match) → no provenance, no DB.
    if (!resolvedKey) return null;

    // Try OKG first (pure, no DB). If it grounds, we never touch Neo4j.
    const okgFirst = retrieveRecallGrounding(personId, inputText, knownFacts, {
      entities: [], facts: [], relationships: [], procedures: [], summary: '',
    }, resolvedKey);
    if (okgFirst) return okgFirst;

    // OKG missed on a recall question — consult the single-hop WKG context.
    try {
      const wkg = await this.wkgContext.getContextForFrame(frame);
      return retrieveRecallGrounding(personId, inputText, knownFacts, wkg, resolvedKey);
    } catch (err) {
      this.logger.warn(`computeRecallRetrieval WKG lookup failed: ${err}`);
      return null;
    }
  }

  /**
   * WS3 C8 — adapt the registered text encoder to the pure resolver's seam.
   *
   * Returns a RecallKeyEncoder bound to the registered 'text' modality encoder,
   * honoring nomic's MANDATORY query/document asymmetry: the live QUESTION is a
   * `search_query:` (encoder.encode) and each canonical key form is a
   * `search_document:` (encoder.encodeDocument). Returns null when no text
   * encoder is registered or it cannot produce documents — the resolver then
   * fail-closes to regex-only (no semantic pass, C1 preserved).
   */
  private recallKeyEncoder(): RecallKeyEncoder | null {
    const enc = this.modalityRegistry.get('text');
    if (!enc || !isDocumentEncoder(enc)) return null;
    return {
      encodeQuery: (t: string) => enc.encode(t),
      encodeDocument: (t: string) => enc.encodeDocument(t),
    };
  }

  private async pickResearchTarget(): Promise<string | null> {
    try {
      const entities = await this.wkgContext.queryEntities('*');
      if (entities.length === 0) return null;

      // Prefer entities with lower confidence (less well-known).
      // Filter out very generic labels and structural nodes.
      const candidates = entities
        .filter((e) =>
          e.nodeType === 'Entity' &&
          e.label.length > 2 &&
          e.confidence < 0.60,
        )
        .sort((a, b) => a.confidence - b.confidence)
        .slice(0, 10);

      if (candidates.length === 0) return null;

      // Pick randomly from top candidates.
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      return pick.label;
    } catch (err) {
      this.logger.warn(`pickResearchTarget failed: ${err}`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (not injectable)
// ---------------------------------------------------------------------------

/**
 * WS5 T1.0 — phasic scene-saliency term feeding the ENCODE-ATTENTION channel.
 *
 * Maps the cached scene `totalSurprise` to an attention contribution so a
 * salient-but-CALM novel frame can clear the 0.15 encode gate (it could not
 * before T1.0 — surprise was computed after encode). This is the one new
 * admission path; the encode gate is an OR, so it never blocks a frame that the
 * drive-derived attention would have admitted.
 *
 * Wording (luria): "floored at 0.05, with familiarity decay from P1c." The 0.05
 * floor prevents a fully-familiar scene (surprise 0) from contributing NEGATIVE
 * attention — it contributes nothing, never subtracts. The familiarity DECAY
 * itself (the term diminishing on re-exposure) is the P1c/T4 predictor mechanism
 * and is NOT built here; for T1 the term is the phasic surprise as-is, floored.
 * A threshold is NOT habituation — habituation arrives with P1c.
 *
 * The term is `surprise` clamped to [0.05, 1.0] when there is any surprise, and
 * exactly 0 when there is no scene at all (so a pure-conversation frame gets no
 * spurious visual attention floor). Feeds attention ONLY — never arousal, never
 * Curiosity/Anxiety (ashby).
 */
function saliencyTerm(cachedSceneSurprise: number): number {
  if (cachedSceneSurprise <= 0) return 0;
  return Math.min(1.0, Math.max(0.05, cachedSceneSurprise));
}

/**
 * WS5 T1.2 — build the per-sub-field-provenance VisualContext for an episode, or
 * null when the frame carries no visual content (a pure-conversation turn).
 *
 * Sub-field provenance tiers are kept distinct and machine-readable:
 *   - caption     → LLM_GENERATED (the VLM scene_description), carries its OWN
 *                   required typed provenanceSource so a recalled caption can
 *                   never surface as experiential-GROUNDED.
 *   - sceneLabels → SENSOR (confirmed-track object labels).
 *   - personIds   → INFERENCE (face→identity match), carries an explicit typed tag.
 */
function buildVisualContext(
  frame: SensoryFrame,
  sceneSnapshot: SceneSnapshot | undefined,
): VisualContext | null {
  const caption = frame.raw['scene_description'] as string | undefined;
  const faces = frame.raw['faces'] as unknown[] | undefined;

  const sceneLabels: string[] = [];
  const personIds: string[] = [];
  if (sceneSnapshot) {
    for (const obj of sceneSnapshot.objects) {
      if (obj.state !== 'confirmed') continue;
      sceneLabels.push(obj.label);
      if (obj.personId) personIds.push(obj.personId);
    }
  }

  const hasCaption = typeof caption === 'string' && caption.trim().length > 0;
  const hasLabels = sceneLabels.length > 0;
  const hasPersons = personIds.length > 0;
  const faceCount = Array.isArray(faces) ? faces.length : undefined;

  // Nothing visual to carry → not a perception episode; return null so the
  // episode stays a pure text episode with no visualContext key.
  if (!hasCaption && !hasLabels && !hasPersons && !faceCount) return null;

  const vc: {
    caption?: { text: string; provenanceSource: 'LLM_GENERATED' };
    sceneLabels?: string[];
    personIds?: { ids: string[]; provenanceSource: 'INFERENCE' };
    faceCount?: number;
  } = {};
  if (hasCaption) vc.caption = { text: caption!.trim(), provenanceSource: 'LLM_GENERATED' };
  if (hasLabels) vc.sceneLabels = [...new Set(sceneLabels)];
  if (hasPersons) vc.personIds = { ids: [...new Set(personIds)], provenanceSource: 'INFERENCE' };
  if (faceCount !== undefined && faceCount > 0) vc.faceCount = faceCount;
  return vc;
}

/**
 * WS5 T1.1/T1.3 — derive the REQUIRED `source` discriminant for an episode.
 *
 * A frame with real text content is a 'conversation' turn. A frame with no text
 * but visual content (caption / scene objects / faces, as captured in
 * visualContext) is 'perception'. We never default-stamp an unknown to
 * 'conversation' — a frame with neither text nor visual content (e.g. a
 * drive-only self-tick) is also 'conversation' as the conservative non-visual
 * default, since it is NOT a seen-not-told visual episode and must not satisfy
 * P4's `source === 'perception'` assertion. The 'legacy' sentinel is reserved
 * for the deserialization shim only (pre-T1 checkpoint rows), never set here.
 */
function deriveEpisodeSource(
  frame: SensoryFrame,
  visualContext: VisualContext | null,
): EpisodeSource {
  const text = frame.raw['text'] as string | undefined;
  const hasText = typeof text === 'string' && text.trim().length > 0;
  if (hasText) return 'conversation';
  if (visualContext !== null) return 'perception';
  return 'conversation';
}

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

/**
 * Honest knowledge grounding for a procedure-handler LLM_GENERATE reflex that
 * carries NO provenance tag of its own.
 *
 * CANON Standard 1 (Theater Prohibition): a fresh LLM_GENERATE response is not
 * backed by a WKG fact lookup, so it can never honestly be GROUNDED. We reuse
 * inferGrounding with an empty WKG context: UNKNOWN when the text admits
 * ignorance ("I don't know"), otherwise LLM_ASSISTED — the correct floor for an
 * LLM-produced reflex with no recorded provenance.
 */
function groundingForCachedResponse(responseText: string): KnowledgeGrounding {
  return inferGrounding(
    { entities: [], facts: [], relationships: [], procedures: [], summary: '' },
    responseText,
  );
}

/**
 * Honest knowledge grounding for a latent-space (Type 1) cache hit, derived
 * from the matched pattern's recorded provenance.
 *
 * GROUNDED is replayed as GROUNDED (provenance is real: OKG/WKG backed the
 * response when it was first written; the pattern is a cached echo of that).
 *
 * LLM_ASSISTED is mapped to UNKNOWN, not replayed:
 *   A Type 1 reflex replay does NOT involve the LLM. Claiming LLM_ASSISTED
 *   would be inaccurate (L2: no LLM_ASSISTED under lesion). UNKNOWN is the
 *   honest conservative floor for "I have a cached response but no verified
 *   fact backing for this replay." The caller (latent cache path in processInput)
 *   then applies applyOkgRecallGrounding to upgrade to GROUNDED when the
 *   current session's OKG facts do confirm the response value.
 *
 * Stored knowledgeGrounding (primary path, Bug A + B fix): patterns written
 * after this field was added carry the honest grounding from the original
 * deliberation, avoiding the Drive/CoBeing entityIds heuristic that falsely
 * inflated grounding for any input with no proper nouns.
 *
 * Legacy fallback: patterns without knowledgeGrounding (warm-layer rows from
 * before this field existed) fall back to the entityIds heuristic, with the
 * same LLM_ASSISTED→UNKNOWN mapping applied.
 *
 * Ignorance admission in the responseText always overrides to UNKNOWN
 * (CANON Standard 1: what the response says is the ground truth).
 */
function groundingForCachedPattern(pattern: LearnedPattern): KnowledgeGrounding {
  if (isIgnoranceResponse(pattern.responseText)) {
    return 'UNKNOWN';
  }

  // Primary path: use the grounding stored at write time.
  if (pattern.knowledgeGrounding !== null) {
    // LLM_ASSISTED → UNKNOWN: a cached reflex replay does not involve the LLM.
    return pattern.knowledgeGrounding === 'LLM_ASSISTED' ? 'UNKNOWN' : pattern.knowledgeGrounding;
  }

  // Legacy fallback: infer from entityIds (may include Drive/CoBeing noise).
  // LLM_ASSISTED → UNKNOWN mapping applies here too.
  if (pattern.entityIds.length === 0) return 'UNKNOWN';
  return 'GROUNDED'; // non-empty entityIds = some WKG backing (legacy behavior)
}

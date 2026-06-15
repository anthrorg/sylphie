/**
 * Core drive computation engine — runs in isolated child process.
 *
 * CANON §Subsystem 4 (Drive Engine): The 12-drive tick loop executes here,
 * 100Hz (10ms per tick). All computation is deterministic and isolated from
 * the main NestJS process. Communication is one-way IPC:
 *   - Main → Engine: ACTION_OUTCOME, SOFTWARE_METRICS, SESSION_START/END
 *   - Engine → Main: DRIVE_SNAPSHOT, OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS
 *
 * The tick loop:
 * 1. Drain outcome queue (ACTION_OUTCOME, PREDICTION_RESULT)
 * 2. Compute base drive updates (accumulation, decay)
 * 3. Apply outcomes (driveEffects from action results)
 * 4. Apply cross-modulation (drive-to-drive effects)
 * 5. Clamp all drives to [-10.0, 1.0]
 * 6. Compute totalPressure (sum of positive drives)
 * 7. Publish DRIVE_SNAPSHOT via IPC
 * 8. Schedule next tick with drift compensation
 */

import {
  DriveSnapshot,
  DriveName,
  DRIVE_INDEX_ORDER,
  computeTotalPressure,
  INITIAL_DRIVE_STATE,
  verboseFor,
  type PressureVector,
} from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');
import {
  DriveIPCMessage,
  DriveIPCMessageType,
  ActionOutcomePayload,
  SoftwareMetricsPayload,
  SessionStartPayload,
  SelfAssessmentPayload,
  DriveSnapshotPayload,
  DriveEventPayload,
  TheaterProhibitedPayload,
  OpportunityCreatedPayload,
} from '@sylphie/shared';
import { DriveStateManager } from './drive-state';
import { getDriveUpdateRates, validateRates } from './accumulation';
import { clampAllDrives } from './clamping';
import { applyCrossModulation } from './cross-modulation';
import { RuleEngine } from './rule-engine';
import { getOrCreateSelfEvaluator, SelfEvaluator } from './self-evaluation';
import {
  getOrCreateContingencyCoordinator,
  ContingencyCoordinator,
} from './behavioral-contingencies/contingency-coordinator';
import {
  DRIVE_ENGINE_TICK_INTERVAL_MS,
  MAX_TICK_DRIFT_MS,
  DRIVE_PROCESS_MAX_MEMORY_MB,
  MAX_OUTCOME_QUEUE_LENGTH,
} from '../constants/drives';
import {
  BATCH_SIZE,
  BATCH_TIMEOUT_MS,
  MAX_QUEUE_SIZE,
  DRIVE_TICK_SAMPLE_INTERVAL,
  HEALTH_STATUS_INTERVAL_TICKS,
  TICK_RATE_SAMPLE_WINDOW_TICKS,
  TICK_RATE_DRIFT_WARN_RATIO,
} from '../constants/events';
import { EventEmitter, type IEventEmitter } from './event-emitter';
import { TimescaleWriter } from './timescale-writer';
import {
  detectTheater,
  PRESSURE_THRESHOLD,
  RELIEF_THRESHOLD,
  type TheaterVerdict,
} from './theater-prohibition';
import { logTheaterProhibition } from './reinforcement-blocking';
import { getDefaultAffect } from './default-affect';
import { getOrCreatePredictionEvaluator, PredictionEvaluator } from './prediction-evaluator';
import {
  generatePredictionOpportunitySignal,
  shouldEmitOpportunitySignal,
} from './opportunity-signal';
import { checkGraduation, checkDemotion } from './graduation-criteria';
import { getOrCreateOpportunityDetector, OpportunityDetector } from './opportunity-detector';
import { OpportunityQueue } from './opportunity-queue';
import { getOrCreatePlanningPublisher, PlanningPublisher } from './planning-publisher';
import { applyDecay } from './opportunity-decay';
import {
  EMISSION_INTERVAL_TICKS,
  EMISSION_MAX_PER_CYCLE,
  DECAY_CHECK_INTERVAL_TICKS,
} from '../constants/opportunity-detection';
import type { IMessageTransport } from './message-transport';
import { getOrCreateSelfKgReader, CachedSelfKgReader } from './database-clients';

/**
 * Outcome queue entry: holds IPC messages pending processing.
 */
interface QueuedOutcome {
  payload: ActionOutcomePayload | SoftwareMetricsPayload;
  timestamp: Date;
  /**
   * Correlation id resolved at the ingestion boundary (CANON Standard 2 —
   * end-to-end provenance). Carried alongside the payload so every drive event
   * emitted in response to this outcome can be traced back to the originating
   * action / inbound event. Null for non-action payloads (SOFTWARE_METRICS).
   */
  correlationId: string | null;
}

/**
 * Resolve a correlation id for an inbound payload at the ingestion boundary
 * (CANON Standard 2 — Contingency Requirement: every reinforcement event must
 * be auditable to a specific originating behavior).
 *
 * Resolution order:
 *   1. If the main process propagated `correlationId`, use it verbatim. This
 *      ties the drive event to the upstream inbound event end-to-end.
 *   2. Else, derive a DETERMINISTIC id from `actionId` (`action:<actionId>`).
 *      Deterministic (not random) so the same action always maps to the same
 *      correlation id — the trace stays reconstructable from event logs alone.
 *   3. SOFTWARE_METRICS and other non-action payloads have no specific
 *      originating action → null (honest: no fabricated contingency trace).
 */
export function resolveCorrelationId(
  payload: ActionOutcomePayload | SoftwareMetricsPayload,
): string | null {
  if ('actionType' in payload) {
    const actionPayload = payload as ActionOutcomePayload;
    if (actionPayload.correlationId && actionPayload.correlationId.length > 0) {
      return actionPayload.correlationId;
    }
    return `action:${actionPayload.actionId}`;
  }
  return null;
}

/**
 * DriveEngine: Main computation class for the 12-drive system.
 *
 * Runs in isolation in a Node.js child process. The main NestJS process
 * spawns this and communicates via IPC only.
 */
export class DriveEngine {
  private readonly transport: IMessageTransport;
  private stateManager: DriveStateManager;
  private ruleEngine: RuleEngine;
  private selfEvaluator: SelfEvaluator;
  private contingencyCoordinator: ContingencyCoordinator;
  private predictionEvaluator: PredictionEvaluator;
  private opportunityDetector: OpportunityDetector;
  private opportunityQueue: OpportunityQueue;
  private planningPublisher: PlanningPublisher;
  private eventEmitter: IEventEmitter | null = null;
  private timescaleWriter: TimescaleWriter | null = null;
  private tickNumber: number = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private nextTickScheduledAt: number = Date.now();
  private outcomeQueue: QueuedOutcome[] = [];
  private sessionId: string = '';
  private isRunning: boolean = false;
  private sessionNumber: number = 1;

  // Metrics tracking for health checks
  private lastHealthCheckAt: number = Date.now();
  private lastTickCompletedAt: number = Date.now();
  private lastPublishedSnapshot: DriveSnapshot | null = null;

  // Event emission tracking
  private nextTickSampleAt: number = DRIVE_TICK_SAMPLE_INTERVAL;
  private nextHealthCheckAt: number = HEALTH_STATUS_INTERVAL_TICKS;
  private nextEmissionAt: number = EMISSION_INTERVAL_TICKS;
  private nextDecayCheckAt: number = DECAY_CHECK_INTERVAL_TICKS;

  // Tick-rate drift observability: wall-clock and tick anchors for the current
  // measurement window. Compared every TICK_RATE_SAMPLE_WINDOW_TICKS to surface
  // silent drift (e.g. target 1Hz but the loop is actually firing at 0.5Hz).
  private tickRateWindowStartMs: number = Date.now();
  private tickRateWindowStartTick: number = 0;

  /** Auto-save checkpoint interval in ticks (60s at 1Hz). */
  private static readonly AUTO_SAVE_INTERVAL = 60;
  private nextAutoSaveAt: number = DriveEngine.AUTO_SAVE_INTERVAL;

  constructor(transport: IMessageTransport) {
    this.transport = transport;

    // Validate rates at startup
    const validation = validateRates();
    if (!validation.valid) {
      throw new Error(`Drive rate validation failed: ${validation.errors.join('; ')}`);
    }

    this.stateManager = new DriveStateManager();
    this.ruleEngine = new RuleEngine();
    this.selfEvaluator = getOrCreateSelfEvaluator();
    this.contingencyCoordinator = getOrCreateContingencyCoordinator();
    this.predictionEvaluator = getOrCreatePredictionEvaluator();
    this.opportunityDetector = getOrCreateOpportunityDetector();
    this.opportunityQueue = new OpportunityQueue();
    this.planningPublisher = getOrCreatePlanningPublisher(transport);
    this.setupTransportHandlers();
  }

  /**
   * Initialize the rule engine with a PostgreSQL connection.
   *
   * Called once at startup before start() is called. This loads the initial
   * rule set from the database and sets up periodic reloads.
   *
   * @param pool - A pg Pool instance for database access
   * @throws Error if rule loading fails
   */
  public async initializeRuleEngine(pool: any): Promise<void> {
    await this.ruleEngine.initialize(pool);
  }

  /**
   * Attach a TimescaleWriter for state persistence.
   * Must be called before start() to enable save/restore.
   */
  public setTimescaleWriter(writer: TimescaleWriter): void {
    this.timescaleWriter = writer;
  }

  /**
   * Restore drive state from TimescaleDB checkpoint.
   *
   * Called once at startup before start(). If a checkpoint exists, the
   * pressure vector and tick number are restored so the drive engine
   * resumes from where it left off instead of cold-starting from zeros.
   *
   * Returns true if state was restored, false if cold-starting.
   */
  public async restoreState(): Promise<boolean> {
    if (!this.timescaleWriter) return false;

    const checkpoint = await this.timescaleWriter.loadState();
    if (!checkpoint) {
      vlog('no checkpoint found — cold start from zeros');
      return false;
    }

    // Restore pressure vector into the state manager
    const restoredVector = checkpoint.pressureVector as Record<DriveName, number>;
    this.stateManager = new DriveStateManager(restoredVector);
    this.tickNumber = checkpoint.tickNumber;

    vlog('drive state restored from checkpoint', {
      tickNumber: this.tickNumber,
      totalPressure: +computeTotalPressure(restoredVector).toFixed(4),
    });
    return true;
  }

  /**
   * Start the drive engine tick loop.
   * Called from the parent process once the child is initialized.
   *
   * If restoreState() was called first, resumes from the restored tick
   * number. Otherwise cold-starts from tick 0.
   */
  public start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    if (this.tickNumber === 0) {
      // Only reset session if truly cold-starting (not restored)
      this.sessionId = '';
    }
    this.nextTickScheduledAt = Date.now();
    // Anchor the tick-rate drift window to loop start so the first sample
    // measures real running time, not time-since-construction.
    this.tickRateWindowStartMs = Date.now();
    this.tickRateWindowStartTick = this.tickNumber;
    vlog('tick loop started', { tickNumber: this.tickNumber, restored: this.tickNumber > 0 });
    this.scheduleTick();
  }

  /**
   * Stop the drive engine gracefully.
   * Saves the current drive state to TimescaleDB before stopping.
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    // Persist drive state for next startup
    if (this.timescaleWriter) {
      const frozen = this.stateManager.freezeCurrent();
      await this.timescaleWriter.saveState(
        frozen as unknown as Record<string, number>,
        this.tickNumber,
      );
      vlog('drive state saved on shutdown', { tickNumber: this.tickNumber });
    }

    this.ruleEngine.shutdown();
  }

  /**
   * Setup transport message handlers.
   * Messages arrive from the main NestJS process via the configured transport.
   */
  private setupTransportHandlers(): void {
    this.transport.onMessage((msg: DriveIPCMessage<unknown>) => {
      try {
        this.handleIPCMessage(msg);
      } catch (err) {
        console.error(`[DriveEngine] Error processing message: ${err}`);
      }
    });
  }

  /**
   * Handle an IPC message from the main process.
   */
  private handleIPCMessage(msg: DriveIPCMessage<unknown>): void {
    switch (msg.type) {
      case DriveIPCMessageType.ACTION_OUTCOME:
        this.queueOutcome(msg.payload as ActionOutcomePayload);
        break;

      case DriveIPCMessageType.SOFTWARE_METRICS:
        this.queueOutcome(msg.payload as SoftwareMetricsPayload);
        break;

      case DriveIPCMessageType.SESSION_START:
        this.handleSessionStart(msg.payload as SessionStartPayload);
        break;

      case DriveIPCMessageType.SESSION_END:
        this.handleSessionEnd();
        break;

      case DriveIPCMessageType.SELF_ASSESSMENT:
        this.handleSelfAssessment(msg.payload as SelfAssessmentPayload);
        break;

      default:
        // Ignore unknown message types
        break;
    }
  }

  /**
   * Handle SELF_ASSESSMENT: cache the pushed KG(Self) snapshot.
   *
   * Event-judge model (CANON §Drive Isolation): MAIN computes the assessment
   * and pushes it; the drive caches it on receipt and consumes it on its own
   * 10-tick self-evaluation cadence (decoupled, non-blocking). There is NO
   * drive→main read path. The Std-3 confidence ceiling and provenance-based
   * reduction suppression are applied inside the reader's mapping.
   *
   * Only the CachedSelfKgReader supports ingest(); tests may inject a
   * FallbackSelfKgReader, in which case the push is a no-op (the reader has no
   * cache to fill) — that degrades to today's safe neutral, not a crash.
   */
  private handleSelfAssessment(payload: SelfAssessmentPayload): void {
    const reader = getOrCreateSelfKgReader();
    if (reader instanceof CachedSelfKgReader) {
      reader.ingest(payload);
      vlog('self-assessment cached', {
        provenance: payload.provenance,
        capabilities: payload.capabilities.length,
        drivePatterns: payload.drivePatterns.length,
        predictionAccuracy: payload.predictionAccuracy.length,
      });
    }
  }

  /**
   * Queue an outcome (action or metrics) for processing on the next tick.
   */
  private queueOutcome(
    payload: ActionOutcomePayload | SoftwareMetricsPayload,
  ): void {
    this.outcomeQueue.push({
      payload,
      timestamp: new Date(),
      correlationId: resolveCorrelationId(payload),
    });

    // Warn if queue gets too long (performance issue)
    if (this.outcomeQueue.length > MAX_OUTCOME_QUEUE_LENGTH) {
      console.warn(
        `[DriveEngine] Outcome queue exceeded ${MAX_OUTCOME_QUEUE_LENGTH} items: ${this.outcomeQueue.length}`,
      );
    }
  }

  /**
   * Handle SESSION_START: initialize drive state for a new session.
   */
  private handleSessionStart(payload: SessionStartPayload): void {
    this.sessionId = payload.sessionId;
    this.sessionNumber++;
    this.opportunityDetector.setSessionNumber(this.sessionNumber);
    this.stateManager = new DriveStateManager(payload.initialDriveState.pressureVector);
    vlog('session started', { sessionId: this.sessionId, sessionNumber: this.sessionNumber });
  }

  /**
   * Handle SESSION_END: publish final snapshot and clean up.
   */
  private handleSessionEnd(): void {
    // The main process will receive the final snapshot on the next regular tick.
    // No special action needed here.
  }

  /**
   * Schedule the next tick with drift compensation.
   *
   * Instead of setInterval, we use setTimeout and track the delta
   * to compensate for drift. This keeps the tick loop synchronized.
   */
  private scheduleTick(): void {
    if (!this.isRunning) {
      return;
    }

    const now = Date.now();
    const drift = now - this.nextTickScheduledAt;
    let delay = DRIVE_ENGINE_TICK_INTERVAL_MS - drift;

    // Clamp delay to stay within bounds
    delay = Math.max(0, Math.min(delay + MAX_TICK_DRIFT_MS, DRIVE_ENGINE_TICK_INTERVAL_MS));

    this.tickTimer = setTimeout(() => {
      this.tick();
      this.scheduleTick();
    }, delay);
  }

  /**
   * Execute one tick of the drive computation.
   *
   * Sequence:
   * 1. Drain outcome queue
   * 2. Apply base accumulation/decay
   * 3. Apply outcomes
   * 4. Apply cross-modulation
   * 5. Clamp
   * 6. Compute totalPressure
   * 7. Publish DRIVE_SNAPSHOT
   * 8. Advance tick counter
   */
  private tick(): void {
    const tickStartMs = Date.now();
    this.nextTickScheduledAt = tickStartMs + DRIVE_ENGINE_TICK_INTERVAL_MS;

    try {
      // 1. Drain outcome queue
      const outcomesToProcess = this.outcomeQueue.splice(0, this.outcomeQueue.length);

      // 2. Apply self-evaluation (non-blocking, fires every N ticks)
      // CANON §E4-T008: Runs every 10 ticks (~100ms) to adjust drive baselines
      if (this.selfEvaluator.shouldEvaluate(this.tickNumber)) {
        // Fire the evaluation asynchronously (does not block tick loop)
        this.selfEvaluator.evaluate(this.tickNumber).catch((err) => {
          console.error(`[DriveEngine] Self-evaluation error: ${err}`);
        });
      }

      // 3. Apply base accumulation/decay rates
      const rates = getDriveUpdateRates();
      this.stateManager.applyRates(rates);

      // 4. Apply outcomes (action effects, metrics)
      for (const queued of outcomesToProcess) {
        this.applyOutcome(queued.payload, queued.correlationId);
      }

      // 5. Apply cross-modulation (drive-to-drive effects)
      const currentState = this.stateManager.getCurrentMutable() as Record<DriveName, number>;
      applyCrossModulation(currentState);

      // 6. Clamp all drives (on the actual state, not a copy)
      clampAllDrives(currentState);

      // 7. Compute totalPressure
      const frozen = this.stateManager.freezeCurrent();
      const totalPressure = computeTotalPressure(frozen);

      // Update opportunity detector with current totalPressure
      this.opportunityDetector.setTotalPressure(totalPressure);

      // Log every 100th tick to avoid flooding
      if (this.tickNumber % 100 === 0) {
        vlog('tick checkpoint', {
          tick: this.tickNumber,
          totalPressure: +totalPressure.toFixed(4),
          outcomesProcessed: outcomesToProcess.length,
          queueDepth: this.outcomeQueue.length,
        });
      }

      // 8. Create and publish snapshot
      const deltas = this.stateManager.computeDeltas();
      const snapshot: DriveSnapshot = {
        pressureVector: frozen,
        timestamp: new Date(tickStartMs),
        tickNumber: this.tickNumber,
        driveDeltas: deltas,
        ruleMatchResult: {
          ruleId: null,
          eventType: 'DRIVE_TICK',
          matched: false,
        },
        totalPressure,
        sessionId: this.sessionId,
      };

      this.publishSnapshot(snapshot);
      this.lastPublishedSnapshot = snapshot;

      // 9. E4-T010: Decay check (every 100 ticks ~1 second)
      if (this.tickNumber >= this.nextDecayCheckAt) {
        const activeOpportunities = this.opportunityDetector.getActiveOpportunities();
        const decayedOpportunities = applyDecay(activeOpportunities, this.predictionEvaluator);

        // Remove opportunities that were decayed out
        for (const opp of activeOpportunities) {
          if (!decayedOpportunities.find(d => d.id === opp.id)) {
            this.opportunityDetector.removeOpportunity(opp.id);
          }
        }

        // Update queue with decayed opportunities
        this.opportunityQueue.replaceAll(decayedOpportunities);

        this.nextDecayCheckAt = this.tickNumber + DECAY_CHECK_INTERVAL_TICKS;
      }

      // 10. E4-T010: Emit top opportunities (every 100 ticks ~1 second)
      if (this.tickNumber >= this.nextEmissionAt) {
        const topOpportunities = this.opportunityQueue.getTop(EMISSION_MAX_PER_CYCLE);
        if (topOpportunities.length > 0) {
          this.planningPublisher.publishOpportunities(topOpportunities);
        }
        this.nextEmissionAt = this.tickNumber + EMISSION_INTERVAL_TICKS;
      }

      // 11. Auto-save checkpoint every 60s so state survives hard kills.
      // On Windows, Ctrl+C often kills the process group without delivering
      // SIGINT/SIGTERM, so the graceful shutdown handler never fires.
      // Periodic saves ensure at most 60s of state is lost.
      if (this.tickNumber >= this.nextAutoSaveAt && this.timescaleWriter) {
        this.nextAutoSaveAt = this.tickNumber + DriveEngine.AUTO_SAVE_INTERVAL;
        // Fire-and-forget — don't block the tick loop
        this.timescaleWriter.saveState(
          frozen as unknown as Record<string, number>,
          this.tickNumber,
        ).catch((err) => {
          console.error(`[DriveEngine] Auto-save failed: ${err}`);
        });
      }

      // 12. Advance state for next tick
      this.stateManager.advanceTick();
      this.tickNumber++;
      this.lastTickCompletedAt = Date.now();

      // 13. Tick-rate drift observability (sampled, not per-tick).
      // Compare the ACTUAL tick rate over the last window against the TARGET.
      // Surfaces silent drift without spamming the log. Read-only: this does
      // NOT alter scheduling — it only makes drift visible.
      this.sampleTickRate();
    } catch (err) {
      console.error(`[DriveEngine] Tick error: ${err}`);
    }
  }

  /**
   * Measure the actual vs target tick rate over the current sample window and
   * log it (CANON §observability — silent tick drift must be visible).
   *
   * Every TICK_RATE_SAMPLE_WINDOW_TICKS the engine computes how many ticks
   * actually elapsed per second of wall-clock time and compares it to the
   * target (1000 / DRIVE_ENGINE_TICK_INTERVAL_MS Hz). A drift ratio outside
   * ±TICK_RATE_DRIFT_WARN_RATIO is logged as a WARN; otherwise it is a routine
   * debug sample. This NEVER changes tick behavior — scheduleTick() already
   * self-corrects; this method only observes.
   */
  private sampleTickRate(): void {
    const ticksThisWindow = this.tickNumber - this.tickRateWindowStartTick;
    if (ticksThisWindow < TICK_RATE_SAMPLE_WINDOW_TICKS) {
      return;
    }

    const now = Date.now();
    const elapsedMs = now - this.tickRateWindowStartMs;
    const targetHz = 1000 / DRIVE_ENGINE_TICK_INTERVAL_MS;
    // Guard against a zero/negative window (clock skew) before dividing.
    const measuredHz = elapsedMs > 0 ? (ticksThisWindow * 1000) / elapsedMs : targetHz;
    const driftRatio = targetHz > 0 ? measuredHz / targetHz : 1;

    const sample = {
      measuredHz: +measuredHz.toFixed(3),
      targetHz: +targetHz.toFixed(3),
      driftRatio: +driftRatio.toFixed(3),
      ticks: ticksThisWindow,
      elapsedMs,
      tick: this.tickNumber,
    };

    if (Math.abs(driftRatio - 1) > TICK_RATE_DRIFT_WARN_RATIO) {
      console.warn(
        `[DriveEngine] TICK RATE DRIFT: measured ${sample.measuredHz}Hz vs ` +
          `target ${sample.targetHz}Hz (ratio ${sample.driftRatio}) over ` +
          `${sample.ticks} ticks / ${sample.elapsedMs}ms`,
      );
    } else {
      vlog('tick rate sample', sample);
    }

    // Anchor the next window at the current tick / wall-clock.
    this.tickRateWindowStartTick = this.tickNumber;
    this.tickRateWindowStartMs = now;
  }

  /**
   * Apply a single outcome (action result or metrics) to drive state.
   *
   * For ACTION_OUTCOME: performs Theater Prohibition check to ensure
   * emotional expressions correlate with drive state. If theatrical,
   * reinforcement is blocked. Also records prediction data for MAE
   * computation and opportunity detection (E4-T009).
   */
  private applyOutcome(
    payload: ActionOutcomePayload | SoftwareMetricsPayload,
    correlationId: string | null = null,
  ): void {
    if ('actionType' in payload) {
      // ACTION_OUTCOME — signal-based processing
      // The main process sends WHAT HAPPENED (actionType, outcome, metadata).
      // The drive engine decides WHAT IT MEANS using its internal rules.
      const actionPayload = payload as ActionOutcomePayload;

      // E4-T009: Record prediction outcome if present
      if (actionPayload.predictionData) {
        const { predictionId, predictedValue, actualValue } = actionPayload.predictionData;
        this.predictionEvaluator.recordPrediction(
          predictionId,
          actionPayload.actionType,
          predictedValue,
          actualValue,
        );

        // E4-T010: Check for poor prediction accuracy and process via detector
        const severity = this.predictionEvaluator.getOpportunitySeverity(actionPayload.actionType);
        if (severity && severity !== 'low') {
          const window = this.predictionEvaluator.getMAE(actionPayload.actionType);
          const signal = generatePredictionOpportunitySignal(
            actionPayload.actionType,
            window.mae,
            [],
          );

          if (signal && shouldEmitOpportunitySignal(signal)) {
            const opportunity = this.opportunityDetector.processSignal(
              signal,
              this.predictionEvaluator,
            );
            if (opportunity) {
              this.opportunityQueue.add(opportunity);
            }
          }
        }
      }

      // CANON Standard 1: Theater Prohibition enforcement
      const currentState = this.stateManager.getCurrent() as Record<DriveName, number>;
      const verdict = detectTheater(actionPayload.theaterCheck, currentState);

      if (verdict.isTheatrical) {
        // Expression is theatrical: zero reinforcement
        const logMsg = logTheaterProhibition(actionPayload, verdict, {});
        console.error(`[DriveEngine] ${logMsg}`);
        this.emitTheaterProhibitedEvent(actionPayload, verdict, correlationId);
        return;
      }

      // ── Compute effects from rules (or default affects) ──────────────
      // The drive engine owns all effect computation. No pre-computed
      // driveEffects come from the main process.
      //
      // 1. Try rule engine (PostgreSQL rules matched by actionType + drive state)
      // 2. If no rules match → use default affects (hardcoded per action category)
      // 3. If defaults used → flag actionType for rule debate (guardian review)
      const ruleResult = this.ruleEngine.matchAndApply(
        actionPayload.actionType,
        currentState as PressureVector,
      );

      let computedEffects: Partial<Record<DriveName, number>>;
      let usedDefault = false;

      if (ruleResult.matchedRuleIds.length > 0) {
        // Rules matched — use rule-computed effects
        computedEffects = ruleResult.driveEffects;
      } else {
        // No rules matched — use default affects from action category
        computedEffects = getDefaultAffect(actionPayload);
        usedDefault = true;

        // Flag for rule debate (async, non-blocking)
        if (Object.keys(computedEffects).length > 0) {
          const dsl = Object.entries(computedEffects)
            .map(([drive, delta]) => `${drive} += ${delta}`)
            .join('; ');
          this.ruleEngine.proposeRuleForDebate(actionPayload.actionType, dsl).catch(() => {});
        }
      }

      vlog('outcome applied', {
        actionType: actionPayload.actionType,
        theater: false,
        feedbackSource: actionPayload.feedbackSource,
        effectCount: Object.keys(computedEffects).length,
        source: usedDefault ? 'default-affect' : 'rule-engine',
        computedEffects,
      });

      // Apply guardian weighting (2x confirmation, 3x correction)
      const weighted = this.applyGuardianWeighting(
        computedEffects,
        actionPayload.feedbackSource,
      );
      this.stateManager.applyOutcomeEffects(weighted);

      // Emit DRIVE_EVENT audit records for each affected drive (CANON §Drive
      // Isolation: emit over IPC; the PARENT persists to TimescaleDB). Each
      // event carries the correlation id so the relief/rule application is
      // auditable end-to-end back to the originating action (Standard 2).
      // A matched Postgres rule id (if any) is attached for provenance; a
      // default-affect application has no rule id.
      const appliedRuleId =
        !usedDefault && ruleResult.matchedRuleIds.length > 0
          ? ruleResult.matchedRuleIds[0]
          : null;
      for (const [drive, delta] of Object.entries(weighted)) {
        if (delta === 0) continue;
        this.publishDriveEvent(
          delta < 0 ? 'DRIVE_RELIEF' : 'DRIVE_RULE_APPLIED',
          drive as DriveName,
          delta,
          appliedRuleId,
          correlationId,
        );
      }

      // Apply behavioral contingencies (CANON §A.14)
      const contingencyDeltas = this.contingencyCoordinator.applyContingencies(
        actionPayload,
        currentState,
      );
      this.stateManager.applyOutcomeEffects(contingencyDeltas);

      // Emit DRIVE_EVENT audit records for contingency-driven deltas too, so
      // CANON §A.14 contingencies (guilt repair, curiosity gain, etc.) are
      // equally auditable with the same correlation id.
      for (const [drive, delta] of Object.entries(contingencyDeltas)) {
        if (delta === 0) continue;
        this.publishDriveEvent(
          delta < 0 ? 'DRIVE_RELIEF' : 'DRIVE_RULE_APPLIED',
          drive as DriveName,
          delta,
          null,
          correlationId,
        );
      }
    } else if ('cognitiveEffortPressure' in payload) {
      // SOFTWARE_METRICS
      const metricsPayload = payload as SoftwareMetricsPayload;
      this.stateManager.applyDelta(
        DriveName.CognitiveAwareness,
        metricsPayload.cognitiveEffortPressure,
      );
    }
  }

  /**
   * Apply guardian weighting to drive effects.
   *
   * CANON Standard 5 (Guardian Asymmetry):
   * - guardian_confirmation: 2x weight
   * - guardian_correction: 3x weight
   * - algorithmic: 1x weight (baseline)
   */
  private applyGuardianWeighting(
    effects: Partial<Record<DriveName, number>>,
    feedbackSource: string,
  ): Partial<Record<DriveName, number>> {
    let multiplier = 1.0;

    if (feedbackSource === 'guardian_confirmation') {
      multiplier = 2.0;
    } else if (feedbackSource === 'guardian_correction') {
      multiplier = 3.0;
    }

    if (multiplier === 1.0) {
      return effects;
    }

    const weighted: Partial<Record<DriveName, number>> = {};
    for (const [drive, value] of Object.entries(effects)) {
      weighted[drive as DriveName] = value * multiplier;
    }
    return weighted;
  }

  /**
   * Publish a drive snapshot to the main process via transport.
   */
  private publishSnapshot(snapshot: DriveSnapshot): void {
    const message: DriveIPCMessage<DriveSnapshotPayload> = {
      type: DriveIPCMessageType.DRIVE_SNAPSHOT,
      payload: { snapshot },
      timestamp: new Date(),
    };

    this.transport.send(message);
  }

  /**
   * Publish a drive event (for specific events like relief).
   */
  private publishDriveEvent(
    eventType: 'DRIVE_RELIEF' | 'DRIVE_RULE_APPLIED',
    drive: DriveName,
    delta: number,
    ruleId: string | null = null,
    correlationId: string | null = null,
  ): void {
    if (!this.lastPublishedSnapshot) {
      return;
    }

    const message: DriveIPCMessage<DriveEventPayload> = {
      type: DriveIPCMessageType.DRIVE_EVENT,
      payload: {
        driveEventType: eventType,
        drive,
        delta,
        ruleId,
        correlationId,
        snapshot: this.lastPublishedSnapshot,
      },
      timestamp: new Date(),
    };

    this.transport.send(message);
  }

  /**
   * Emit a THEATER_PROHIBITED event (CANON Standard 1 enforcement).
   *
   * Called when an emotional expression does not correlate with drive state.
   * Logs the event for debugging and records it in the event stream.
   */
  private emitTheaterProhibitedEvent(
    outcome: ActionOutcomePayload,
    verdict: TheaterVerdict,
    correlationId: string | null = null,
  ): void {
    // A theatrical verdict is, by construction, a 'pressure' or 'relief'
    // expression that failed its directional drive check — 'none' can never be
    // theatrical (detectTheater returns isTheatrical=false for 'none'). Guard
    // defensively so the audit payload's type stays honest.
    if (verdict.expressionType === 'none') {
      return;
    }

    if (!this.lastPublishedSnapshot) {
      // No snapshot yet (pre-first-tick). The stderr log already recorded the
      // prohibition; we simply can't attach drive state to the audit event.
      return;
    }

    const expectedThreshold =
      verdict.expressionType === 'pressure' ? PRESSURE_THRESHOLD : RELIEF_THRESHOLD;

    // CANON §Drive Isolation: emit over IPC; the PARENT persists to TimescaleDB.
    // The drive engine never writes the DB directly.
    //
    // CANON Standard 1 GUARDRAIL: this is the AUDIT TRAIL ONLY. The zero-
    // reinforcement decision was already taken at the call site (the early
    // `return` after this call); nothing downstream of this event may convert it
    // into any positive reinforcement contingency.
    const message: DriveIPCMessage<TheaterProhibitedPayload> = {
      type: DriveIPCMessageType.THEATER_PROHIBITED,
      payload: {
        actionId: outcome.actionId,
        correlationId,
        actionType: outcome.actionType,
        offendingExpressionType: verdict.expressionType,
        drive: verdict.drive,
        expectedThreshold,
        actualDriveValue: verdict.driveValue,
        verdictReason: verdict.reason,
        snapshot: this.lastPublishedSnapshot,
      },
      timestamp: new Date(),
    };

    this.transport.send(message);
  }

  /**
   * Publish an opportunity signal via IPC (E4-T009: prediction failures).
   *
   * Called when prediction accuracy degrades (MAE > 0.20) and severity is
   * MEDIUM or HIGH. The Planning subsystem receives this and adds it to the
   * opportunity queue for further investigation.
   */
  private publishOpportunityCreated(signal: {
    id: string;
    type: string;
    predictionType: string;
    mae: number;
    severity: 'low' | 'medium' | 'high';
    contextFingerprint: string;
  }): void {
    // Map severity to opportunity priority
    let priority: 'HIGH' | 'MEDIUM' | 'LOW';
    if (signal.severity === 'high') {
      priority = 'HIGH';
    } else {
      priority = 'MEDIUM';
    }

    const message: DriveIPCMessage<OpportunityCreatedPayload> = {
      type: DriveIPCMessageType.OPPORTUNITY_CREATED,
      payload: {
        id: signal.id,
        contextFingerprint: signal.contextFingerprint,
        classification: 'PREDICTION_FAILURE_PATTERN',
        priority,
        sourceEventId: '',
        affectedDrive: 'cognitiveAwareness' as any,
      },
      timestamp: new Date(),
    };

    this.transport.send(message);
  }

  /**
   * Get health status for parent process health checks.
   */
  public getHealthStatus(): {
    healthy: boolean;
    currentTick: number;
    msSinceLastTick: number;
    memoryMb: number;
    diagnosticMessage: string | null;
  } {
    const now = Date.now();
    const msSinceLastTick = now - this.lastTickCompletedAt;
    const memMB = process.memoryUsage().heapUsed / 1024 / 1024;

    let healthy = true;
    let diagnosticMessage: string | null = null;

    // Check if ticks are stalled (haven't completed in >5 seconds at 1Hz tick rate)
    if (msSinceLastTick > 5000) {
      healthy = false;
      diagnosticMessage = `Last tick was ${msSinceLastTick}ms ago (timeout: 5000ms)`;
    }

    // Check memory footprint
    if (memMB > DRIVE_PROCESS_MAX_MEMORY_MB) {
      healthy = false;
      if (diagnosticMessage) {
        diagnosticMessage += `; `;
      } else {
        diagnosticMessage = '';
      }
      diagnosticMessage += `Heap usage ${memMB.toFixed(2)}MB exceeds limit ${DRIVE_PROCESS_MAX_MEMORY_MB}MB`;
    }

    return {
      healthy,
      currentTick: this.tickNumber,
      msSinceLastTick,
      memoryMb: memMB,
      diagnosticMessage,
    };
  }
}

/**
 * Global singleton instance (when running as a spawned process or standalone server).
 */
let engine: DriveEngine | null = null;

/**
 * Get or create the global engine instance.
 *
 * @param transport - Message transport for communication with the main app.
 *                    Required on first call; ignored on subsequent calls.
 */
export function getOrCreateEngine(transport: IMessageTransport): DriveEngine {
  if (!engine) {
    engine = new DriveEngine(transport);
  }
  return engine;
}

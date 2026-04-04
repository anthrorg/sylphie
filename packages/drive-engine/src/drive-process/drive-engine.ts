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
} from '@sylphie/shared';
import {
  DriveIPCMessage,
  DriveIPCMessageType,
  ActionOutcomePayload,
  SoftwareMetricsPayload,
  SessionStartPayload,
  DriveSnapshotPayload,
  DriveEventPayload,
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
} from '../constants/events';
import { EventEmitter, type IEventEmitter } from './event-emitter';
import { TimescaleWriter } from './timescale-writer';
import { detectTheater, type TheaterVerdict } from './theater-prohibition';
import { filterEffectsForTheater, logTheaterProhibition } from './reinforcement-blocking';
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

/**
 * Outcome queue entry: holds IPC messages pending processing.
 */
interface QueuedOutcome {
  payload: ActionOutcomePayload | SoftwareMetricsPayload;
  timestamp: Date;
}

/**
 * DriveEngine: Main computation class for the 12-drive system.
 *
 * Runs in isolation in a Node.js child process. The main NestJS process
 * spawns this and communicates via IPC only.
 */
export class DriveEngine {
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

  constructor() {
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
    this.planningPublisher = getOrCreatePlanningPublisher();
    this.setupIPCHandlers();
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
   * Start the drive engine tick loop.
   * Called from the parent process once the child is initialized.
   */
  public start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.sessionId = '';
    this.tickNumber = 0;
    this.nextTickScheduledAt = Date.now();
    this.scheduleTick();
  }

  /**
   * Stop the drive engine gracefully.
   * Called when the parent process is shutting down.
   */
  public stop(): void {
    this.isRunning = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    this.ruleEngine.shutdown();
  }

  /**
   * Setup IPC message handlers.
   * Messages arrive from the main NestJS process.
   */
  private setupIPCHandlers(): void {
    if (typeof process === 'undefined' || !process.on) {
      return; // Not in Node.js child process context
    }

    process.on('message', (msg: DriveIPCMessage<unknown>) => {
      try {
        this.handleIPCMessage(msg);
      } catch (err) {
        // Log and skip malformed messages
        if (process.stderr) {
          process.stderr.write(
            `[DriveEngine] Error processing IPC message: ${err}\n`,
          );
        }
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

      default:
        // Ignore unknown message types
        break;
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
    });

    // Warn if queue gets too long (performance issue)
    if (this.outcomeQueue.length > MAX_OUTCOME_QUEUE_LENGTH) {
      if (process.stderr) {
        process.stderr.write(
          `[DriveEngine] Outcome queue exceeded ${MAX_OUTCOME_QUEUE_LENGTH} items: ${this.outcomeQueue.length}\n`,
        );
      }
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
          if (process.stderr) {
            process.stderr.write(`[DriveEngine] Self-evaluation error: ${err}\n`);
          }
        });
      }

      // 3. Apply base accumulation/decay rates
      const rates = getDriveUpdateRates();
      this.stateManager.applyRates(rates);

      // 4. Apply outcomes (action effects, metrics)
      for (const queued of outcomesToProcess) {
        this.applyOutcome(queued.payload);
      }

      // 5. Apply cross-modulation (drive-to-drive effects)
      const currentState = this.stateManager.getCurrent() as Record<DriveName, number>;
      applyCrossModulation(currentState);

      // 6. Clamp all drives
      clampAllDrives(currentState);

      // 7. Compute totalPressure
      const frozen = this.stateManager.freezeCurrent();
      const totalPressure = computeTotalPressure(frozen);

      // Update opportunity detector with current totalPressure
      this.opportunityDetector.setTotalPressure(totalPressure);

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

      // 11. Advance state for next tick
      this.stateManager.advanceTick();
      this.tickNumber++;
      this.lastTickCompletedAt = Date.now();
    } catch (err) {
      if (process.stderr) {
        process.stderr.write(`[DriveEngine] Tick error: ${err}\n`);
      }
    }
  }

  /**
   * Apply a single outcome (action result or metrics) to drive state.
   *
   * For ACTION_OUTCOME: performs Theater Prohibition check to ensure
   * emotional expressions correlate with drive state. If theatrical,
   * reinforcement is blocked. Also records prediction data for MAE
   * computation and opportunity detection (E4-T009).
   */
  private applyOutcome(payload: ActionOutcomePayload | SoftwareMetricsPayload): void {
    if ('driveEffects' in payload) {
      // ACTION_OUTCOME
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
          // Generate opportunity signal for MEDIUM/HIGH severity
          const window = this.predictionEvaluator.getMAE(actionPayload.actionType);
          const signal = generatePredictionOpportunitySignal(
            actionPayload.actionType,
            window.mae,
            [], // Note: we could pass recent predictions here for recentFailures count
          );

          if (signal && shouldEmitOpportunitySignal(signal)) {
            // Process signal through detector (classification, priority scoring, de-duplication)
            const opportunity = this.opportunityDetector.processSignal(
              signal,
              this.predictionEvaluator,
            );

            if (opportunity) {
              // Add to priority queue
              this.opportunityQueue.add(opportunity);
            }
          }
        }
      }

      // CANON Standard 1: Theater Prohibition enforcement
      // Get current drive state for post-flight verification
      const currentState = this.stateManager.getCurrent() as Record<DriveName, number>;
      const verdict = detectTheater(actionPayload.theaterCheck, currentState);

      // Filter effects based on theater verdict
      const filterResult = filterEffectsForTheater(actionPayload, verdict);

      if (filterResult.shouldApplyEffects) {
        // Expression is authentic: apply normal contingencies
        const weighted = this.applyGuardianWeighting(
          filterResult.filteredEffects,
          actionPayload.feedbackSource,
        );
        this.stateManager.applyOutcomeEffects(weighted);

        // Apply behavioral contingencies (CANON §A.14)
        // These fire on every outcome and adjust drives based on specific behavioral patterns
        const contingencyDeltas = this.contingencyCoordinator.applyContingencies(
          actionPayload,
          currentState,
        );
        this.stateManager.applyOutcomeEffects(contingencyDeltas);
      } else {
        // Expression is theatrical: zero reinforcement
        // Log the prohibition event for debugging
        const logMsg = logTheaterProhibition(actionPayload, verdict, filterResult.blockedEffects);
        if (process.stderr) {
          process.stderr.write(`[DriveEngine] ${logMsg}\n`);
        }
        // Emit THEATER_PROHIBITED event via event emitter if available
        this.emitTheaterProhibitedEvent(actionPayload, verdict);
      }
    } else if ('cognitiveEffortPressure' in payload) {
      // SOFTWARE_METRICS
      const metricsPayload = payload as SoftwareMetricsPayload;
      // Apply cognitive effort pressure to CognitiveAwareness
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
   * Publish a drive snapshot via IPC to the main process.
   */
  private publishSnapshot(snapshot: DriveSnapshot): void {
    if (typeof process === 'undefined' || !process.send) {
      return; // Not in child process context
    }

    const message: DriveIPCMessage<DriveSnapshotPayload> = {
      type: DriveIPCMessageType.DRIVE_SNAPSHOT,
      payload: { snapshot },
      timestamp: new Date(),
    };

    process.send(message);
  }

  /**
   * Publish a drive event via IPC (for specific events like relief).
   */
  private publishDriveEvent(
    eventType: 'DRIVE_RELIEF' | 'DRIVE_RULE_APPLIED',
    drive: DriveName,
    delta: number,
    ruleId: string | null = null,
  ): void {
    if (!this.lastPublishedSnapshot) {
      return;
    }

    if (typeof process === 'undefined' || !process.send) {
      return;
    }

    const message: DriveIPCMessage<DriveEventPayload> = {
      type: DriveIPCMessageType.DRIVE_EVENT,
      payload: {
        driveEventType: eventType,
        drive,
        delta,
        ruleId,
        snapshot: this.lastPublishedSnapshot,
      },
      timestamp: new Date(),
    };

    process.send(message);
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
  ): void {
    // Event is logged to stderr above. Could also emit via event emitter
    // or TimescaleDB if those systems are available.
    // For now, the stderr log provides visibility into theater prohibitions.
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
    if (typeof process === 'undefined' || !process.send) {
      return; // Not in child process context
    }

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
        sourceEventId: '', // Will be populated by the event emitter
        affectedDrive: 'cognitiveAwareness' as any, // Prediction failures affect cognitive awareness
      },
      timestamp: new Date(),
    };

    process.send(message);
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

    // Check if ticks are stalled (haven't completed in >1 second)
    if (msSinceLastTick > 1000) {
      healthy = false;
      diagnosticMessage = `Last tick was ${msSinceLastTick}ms ago (timeout: 1000ms)`;
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
 * Global singleton instance (when running as a spawned process).
 * The parent process will import and call start() on this instance.
 */
let engine: DriveEngine | null = null;

/**
 * Get or create the global engine instance.
 */
export function getOrCreateEngine(): DriveEngine {
  if (!engine) {
    engine = new DriveEngine();
  }
  return engine;
}

/**
 * Entry point for the spawned child process.
 * This runs automatically when the file is executed directly.
 */
if (require.main === module || (typeof process !== 'undefined' && process.argv[1]?.includes('drive-engine'))) {
  const engine = getOrCreateEngine();
  engine.start();

  // Health check responder
  if (typeof process !== 'undefined' && process.on) {
    process.on('message', (msg: DriveIPCMessage<unknown>) => {
      // Handle health check via a signal (parent will use process signals for health checks)
      // This is a fallback; primary health checking is done via HEALTH_STATUS periodic publication
    });
  }
}

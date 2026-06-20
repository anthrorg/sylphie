/**
 * LearningService — Maintenance cycle orchestrator for the Learning subsystem.
 *
 * CANON §Subsystem 3 (Learning): Converts raw experience (TimescaleDB events)
 * into durable knowledge (WKG entities and edges) through a 7-step pipeline
 * executed in discrete, bounded maintenance cycles.
 *
 * Cycle trigger: CognitiveAwareness drive pressure is the primary trigger.
 * When pressure exceeds COGNITIVE_AWARENESS_PRESSURE_THRESHOLD the service calls
 * forceCycle() immediately. The setInterval timer is a safety floor that fires
 * when no pressure event has been received for CYCLE_INTERVAL_MS.
 *
 * Overlap guard: cycleInFlight prevents concurrent cycles. If a cycle is still
 * running when the timer or a pressure event fires, the new tick is dropped silently.
 *
 * Per-cycle limit: MAX_EVENTS_PER_CYCLE = 5. CANON §Subsystem 3 is explicit:
 * "Max 5 learnable events per cycle." This is a cognitive constraint, not a
 * performance optimization.
 *
 * Pipeline steps (sequential per event):
 *   Step 2: UpdateWkgService.fetchUnlearnedEvents()
 *   Step 3: UpsertEntitiesService.upsertEntities()
 *   Step 4: ExtractEdgesService.extractEdges()
 *   Step 5: ConversationEntryService.createEntry()
 *   Step 6: CanProduceEdgesService.createEdges()
 *   Step 7: RefineEdgesService.refineEdges() [LLM-assisted, skipped if unavailable]
 *   Cleanup: UpdateWkgService.markAsLearned()
 *
 * Events emitted (via LearningEventLoggerService):
 *   CONSOLIDATION_CYCLE_STARTED  — before processing begins
 *   CONSOLIDATION_CYCLE_COMPLETED — after all events are processed
 *   ENTITY_EXTRACTED             — for each entity upserted
 *   EDGE_REFINED                 — for each edge the LLM refines
 */

import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import type {
  ILearningService,
  MaintenanceCycleResult,
  ReflectionResult,
  SynthesisCycleResult,
  DecayCycleResult,
  SelfModelCycleResult,
  IUpdateWkgService,
  IUpsertEntitiesService,
  IExtractTypedEdgesService,
  IExtractEdgesService,
  IConversationEntryService,
  ICanProduceEdgesService,
  IRefineEdgesService,
  IDetectContradictionsService,
  IConfidenceDecayService,
  IConversationReflectionService,
  ICrossSessionSynthesisService,
  ISelfModelWriterService,
  ILearningEventLogger,
  UnlearnedEvent,
  RegroundResult,
} from './interfaces/learning.interfaces';
import {
  UPDATE_WKG_SERVICE,
  UPSERT_ENTITIES_SERVICE,
  EXTRACT_TYPED_EDGES_SERVICE,
  EXTRACT_EDGES_SERVICE,
  CONVERSATION_ENTRY_SERVICE,
  CAN_PRODUCE_EDGES_SERVICE,
  REFINE_EDGES_SERVICE,
  DETECT_CONTRADICTIONS_SERVICE,
  CONFIDENCE_DECAY_SERVICE,
  CONVERSATION_REFLECTION_SERVICE,
  CROSS_SESSION_SYNTHESIS_SERVICE,
  SELF_MODEL_WRITER_SERVICE,
  LEARNING_EVENT_LOGGER,
} from './learning.tokens';
import { verboseFor, DriveName } from '@sylphie/shared';
import type { Subscription } from 'rxjs';
import { DRIVE_STATE_READER, type IDriveStateReader } from '@sylphie/drive-engine';

const vlog = verboseFor('Learning');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum events processed per cycle (CANON §Subsystem 3 cognitive constraint). */
const MAX_EVENTS_PER_CYCLE = 5;

/** Interval between automatic maintenance cycles in milliseconds. */
const CYCLE_INTERVAL_MS = 60_000;

/** Interval between reflection cycles in milliseconds. */
const REFLECTION_INTERVAL_MS = 300_000; // 5 minutes

/** Interval between cross-session synthesis cycles in milliseconds. */
const SYNTHESIS_INTERVAL_MS = 1_800_000; // 30 minutes

/** Interval between confidence decay + pruning cycles in milliseconds. */
const DECAY_INTERVAL_MS = 600_000; // 10 minutes

/** Interval between self-model write cycles in milliseconds. */
const SELF_MODEL_INTERVAL_MS = 600_000; // 10 minutes

/**
 * CognitiveAwareness pressure threshold above which a learning cycle is
 * triggered immediately (timer demoted to safety floor).
 * Value in [0.0, 1.0]; drive clamped to DRIVE_RANGE.max = 1.0.
 */
const COGNITIVE_AWARENESS_PRESSURE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// LearningService
// ---------------------------------------------------------------------------

@Injectable()
export class LearningService implements ILearningService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LearningService.name);

  /** Guard against overlapping maintenance cycles. */
  private cycleInFlight = false;

  /** Guard against overlapping reflection cycles. */
  private reflectionInFlight = false;

  /** Guard against overlapping synthesis cycles. */
  private synthesisInFlight = false;

  /** Guard against overlapping decay cycles. */
  private decayInFlight = false;

  /** Guard against overlapping self-model write cycles. */
  private selfModelInFlight = false;

  /** RxJS subscription to drive snapshots for pressure-triggered cycles. */
  private driveSubscription: Subscription | null = null;

  /** Timer handle for the automatic maintenance cycle. */
  private cycleTimer: ReturnType<typeof setInterval> | null = null;

  /** Timer handle for the automatic reflection cycle. */
  private reflectionTimer: ReturnType<typeof setInterval> | null = null;

  /** Timer handle for the automatic cross-session synthesis cycle. */
  private synthesisTimer: ReturnType<typeof setInterval> | null = null;

  /** Timer handle for the automatic confidence decay cycle. */
  private decayTimer: ReturnType<typeof setInterval> | null = null;

  /** Timer handle for the automatic self-model write cycle. */
  private selfModelTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(UPDATE_WKG_SERVICE)
    private readonly updateWkg: IUpdateWkgService,

    @Inject(UPSERT_ENTITIES_SERVICE)
    private readonly upsertEntities: IUpsertEntitiesService,

    @Inject(EXTRACT_TYPED_EDGES_SERVICE)
    private readonly extractTypedEdges: IExtractTypedEdgesService,

    @Inject(EXTRACT_EDGES_SERVICE)
    private readonly extractEdges: IExtractEdgesService,

    @Inject(CONVERSATION_ENTRY_SERVICE)
    private readonly conversationEntry: IConversationEntryService,

    @Inject(CAN_PRODUCE_EDGES_SERVICE)
    private readonly canProduceEdges: ICanProduceEdgesService,

    @Inject(REFINE_EDGES_SERVICE)
    private readonly refineEdges: IRefineEdgesService,

    @Inject(DETECT_CONTRADICTIONS_SERVICE)
    private readonly detectContradictions: IDetectContradictionsService,

    @Inject(CONFIDENCE_DECAY_SERVICE)
    private readonly confidenceDecay: IConfidenceDecayService,

    @Inject(CONVERSATION_REFLECTION_SERVICE)
    private readonly conversationReflection: IConversationReflectionService,

    @Inject(CROSS_SESSION_SYNTHESIS_SERVICE)
    private readonly crossSessionSynthesis: ICrossSessionSynthesisService,

    @Inject(SELF_MODEL_WRITER_SERVICE)
    private readonly selfModelWriter: ISelfModelWriterService,

    @Inject(LEARNING_EVENT_LOGGER)
    private readonly eventLogger: ILearningEventLogger,

    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    // Ensure tracking tables exist before starting timers.
    await this.conversationReflection.ensureSchema();
    await this.crossSessionSynthesis.ensureSchema();

    this.cycleTimer = setInterval(() => {
      this.runMaintenanceCycle().catch((err: unknown) => {
        this.logger.error(
          `Maintenance cycle threw an unhandled error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, CYCLE_INTERVAL_MS);

    this.reflectionTimer = setInterval(() => {
      this.runReflectionCycle().catch((err: unknown) => {
        this.logger.error(
          `Reflection cycle threw an unhandled error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, REFLECTION_INTERVAL_MS);

    this.synthesisTimer = setInterval(() => {
      this.runSynthesisCycle().catch((err: unknown) => {
        this.logger.error(
          `Synthesis cycle threw an unhandled error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, SYNTHESIS_INTERVAL_MS);

    this.decayTimer = setInterval(() => {
      this.runDecayCycle().catch((err: unknown) => {
        this.logger.error(
          `Decay cycle threw an unhandled error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, DECAY_INTERVAL_MS);

    this.selfModelTimer = setInterval(() => {
      this.runSelfModelCycle().catch((err: unknown) => {
        this.logger.error(
          `Self-model cycle threw an unhandled error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, SELF_MODEL_INTERVAL_MS);

    // Subscribe to drive snapshots; trigger forceCycle() when CognitiveAwareness
    // pressure exceeds the threshold. The cycleInFlight guard inside
    // runMaintenanceCycle() silently drops the call when a cycle is already running.
    this.driveSubscription = this.driveStateReader.driveState$.subscribe(
      (snapshot) => {
        const cogPressure = snapshot.pressureVector[DriveName.CognitiveAwareness];
        if (cogPressure > COGNITIVE_AWARENESS_PRESSURE_THRESHOLD) {
          this.forceCycle().catch((err: unknown) => {
            this.logger.error(
              `Pressure-triggered cycle threw an unhandled error: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
      },
    );

    this.logger.log(
      `Learning subsystem started — maintenance cycle every ${CYCLE_INTERVAL_MS / 1000}s, ` +
        `reflection cycle every ${REFLECTION_INTERVAL_MS / 1000}s, ` +
        `synthesis cycle every ${SYNTHESIS_INTERVAL_MS / 1000}s, ` +
        `decay cycle every ${DECAY_INTERVAL_MS / 1000}s, ` +
        `self-model cycle every ${SELF_MODEL_INTERVAL_MS / 1000}s`,
    );
  }

  onModuleDestroy(): void {
    if (this.cycleTimer !== null) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
    if (this.reflectionTimer !== null) {
      clearInterval(this.reflectionTimer);
      this.reflectionTimer = null;
    }
    if (this.synthesisTimer !== null) {
      clearInterval(this.synthesisTimer);
      this.synthesisTimer = null;
    }
    if (this.decayTimer !== null) {
      clearInterval(this.decayTimer);
      this.decayTimer = null;
    }
    if (this.selfModelTimer !== null) {
      clearInterval(this.selfModelTimer);
      this.selfModelTimer = null;
    }
    if (this.driveSubscription !== null) {
      this.driveSubscription.unsubscribe();
      this.driveSubscription = null;
    }
    this.logger.log('Learning subsystem stopped');
  }

  // ---------------------------------------------------------------------------
  // ILearningService
  // ---------------------------------------------------------------------------

  async runMaintenanceCycle(): Promise<MaintenanceCycleResult> {
    // Overlap guard.
    if (this.cycleInFlight) {
      this.logger.debug('Cycle already in flight — skipping this tick');
      return noop();
    }

    this.cycleInFlight = true;
    const cycleStart = Date.now();

    try {
      return await this.executeCycle();
    } finally {
      this.cycleInFlight = false;
    }
  }

  async forceCycle(): Promise<MaintenanceCycleResult> {
    // Delegates to runMaintenanceCycle() which already has the overlap guard.
    // The cycle runs immediately rather than waiting for the next timer tick.
    vlog('pressure-triggered cycle requested');
    return this.runMaintenanceCycle();
  }

  async runReflectionCycle(): Promise<ReflectionResult> {
    if (this.reflectionInFlight) {
      this.logger.debug('Reflection cycle already in flight — skipping');
      return reflectionNoop();
    }

    this.reflectionInFlight = true;
    try {
      const candidates = await this.conversationReflection.findReflectableSessions();
      if (candidates.length === 0) {
        this.logger.debug('Reflection cycle: no reflectable sessions');
        return reflectionNoop();
      }

      const candidate = candidates[0];
      this.logger.log(
        `Reflection cycle: reflecting on session ${candidate.sessionId} ` +
          `(${candidate.eventCount} events, last activity ${candidate.lastEventAt.toISOString()})`,
      );

      return await this.conversationReflection.reflectOnSession(candidate.sessionId);
    } finally {
      this.reflectionInFlight = false;
    }
  }

  async runSynthesisCycle(): Promise<SynthesisCycleResult> {
    if (this.synthesisInFlight) {
      this.logger.debug('Synthesis cycle already in flight — skipping');
      return synthesisNoop();
    }

    this.synthesisInFlight = true;
    try {
      const result = await this.crossSessionSynthesis.runSynthesisCycle();

      // Re-grounding sweep runs after synthesis so newly-added entities can
      // resolve previously-ungrounded insights in the same cycle.
      const regroundResult: RegroundResult =
        await this.conversationReflection.regroundUngroundedInsights();
      if (!regroundResult.wasNoop) {
        this.logger.log(
          `Re-grounding sweep: ${regroundResult.insightsExamined} examined, ` +
            `${regroundResult.insightsUpdated} updated, ${regroundResult.edgesCreated} new edges`,
        );
      }

      return result;
    } finally {
      this.synthesisInFlight = false;
    }
  }

  async runDecayCycle(): Promise<DecayCycleResult> {
    if (this.decayInFlight) {
      this.logger.debug('Decay cycle already in flight — skipping');
      return { nodesDecayed: 0, edgesDecayed: 0, nodesPruned: 0, okgNodesDecayed: 0, okgNodesPruned: 0, wasNoop: true };
    }

    this.decayInFlight = true;
    try {
      return await this.confidenceDecay.runDecayCycle();
    } finally {
      this.decayInFlight = false;
    }
  }

  /**
   * Run one self-model write cycle.
   *
   * Exposed publicly so the live smoke test can fire it on demand via
   * LearningService directly, without waiting for the 10-minute timer.
   * The selfModelInFlight guard still applies.
   */
  async runSelfModelCycle(): Promise<SelfModelCycleResult> {
    if (this.selfModelInFlight) {
      this.logger.debug('Self-model cycle already in flight — skipping');
      return { wrote: false, sampleCount: 0, successRate: null, confidence: null, wasNoop: true };
    }

    this.selfModelInFlight = true;
    try {
      return await this.selfModelWriter.runSelfModelCycle();
    } finally {
      this.selfModelInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: full cycle
  // ---------------------------------------------------------------------------

  private async executeCycle(): Promise<MaintenanceCycleResult> {
    const cycleStartMs = Date.now();
    // Step 2a: fetch unlearned events.
    const events = await this.updateWkg.fetchUnlearnedEvents(MAX_EVENTS_PER_CYCLE);

    if (events.length === 0) {
      this.logger.debug('Learning cycle: no unlearned events');
      return noop();
    }

    // Emit CONSOLIDATION_CYCLE_STARTED.
    this.eventLogger.log('CONSOLIDATION_CYCLE_STARTED', {
      eventCount: events.length,
      maxPerCycle: MAX_EVENTS_PER_CYCLE,
    });

    this.logger.log(`Learning cycle: processing ${events.length} events`);
    vlog('consolidation cycle started', { eventCount: events.length, max: MAX_EVENTS_PER_CYCLE });

    const result: Mutable<MaintenanceCycleResult> = {
      eventsProcessed: 0,
      entitiesUpserted: 0,
      edgesUpserted: 0,
      conversationsCreated: 0,
      canProduceEdgesCreated: 0,
      edgesRefined: 0,
      contradictionsDetected: 0,
      wasNoop: false,
    };

    for (const event of events) {
      await this.processEvent(event, result);
    }

    // Emit CONSOLIDATION_CYCLE_COMPLETED.
    this.eventLogger.log('CONSOLIDATION_CYCLE_COMPLETED', {
      eventsProcessed: result.eventsProcessed,
      entitiesUpserted: result.entitiesUpserted,
      edgesUpserted: result.edgesUpserted,
      conversationsCreated: result.conversationsCreated,
      canProduceEdgesCreated: result.canProduceEdgesCreated,
      edgesRefined: result.edgesRefined,
      contradictionsDetected: result.contradictionsDetected,
    });

    this.logger.log(
      `Learning cycle complete: ${result.eventsProcessed} events, ` +
        `${result.entitiesUpserted} entities, ${result.edgesUpserted} edges, ` +
        `${result.conversationsCreated} conversations, ` +
        `${result.canProduceEdgesCreated} can_produce, ` +
        `${result.edgesRefined} refined, ` +
        `${result.contradictionsDetected} contradictions`,
    );

    vlog('consolidation cycle finished', {
      events: result.eventsProcessed,
      entities: result.entitiesUpserted,
      edges: result.edgesUpserted,
      refined: result.edgesRefined,
      contradictions: result.contradictionsDetected,
      durationMs: Date.now() - cycleStartMs,
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private: single event pipeline
  // ---------------------------------------------------------------------------

  private async processEvent(
    event: UnlearnedEvent,
    result: Mutable<MaintenanceCycleResult>,
  ): Promise<void> {
    try {
      // Step 3: upsert entities.
      const entities = await this.upsertEntities.upsertEntities(event);
      result.entitiesUpserted += entities.length;

      // Emit ENTITY_EXTRACTED for each entity.
      for (const entity of entities) {
        this.eventLogger.log(
          'ENTITY_EXTRACTED',
          {
            eventId: event.id,
            nodeId: entity.nodeId,
            label: entity.label,
            provenance: entity.provenance,
            confidence: entity.confidence,
          },
          event.session_id,
        );
      }

      // Step 3b: extract typed edges from structured facts.
      // These are high-quality edges like (Jim) -[LIKES]-> (Coffee) parsed
      // directly from sentence structure. They go into the graph first.
      const { edges: typedEdges, typedPairs } =
        await this.extractTypedEdges.extractTypedEdges(entities, event);
      result.edgesUpserted += typedEdges.length;

      // Step 4: extract co-occurrence edges (RELATED_TO) for leftover pairs.
      // Only creates edges between entities in the same sentence that don't
      // already have a typed edge from step 3b.
      const cooccurrenceEdges = await this.extractEdges.extractEdges(entities, event, typedPairs);
      result.edgesUpserted += cooccurrenceEdges.length;

      // Combine all edges for downstream refinement and contradiction detection.
      const edges = [...typedEdges, ...cooccurrenceEdges];

      // Step 5: create conversation entry.
      const convNodeId = await this.conversationEntry.createEntry(event, entities);
      if (convNodeId) result.conversationsCreated++;

      // Step 6: CAN_PRODUCE edges.
      const canProduceCount = await this.canProduceEdges.createEdges(
        convNodeId,
        event,
      );
      result.canProduceEdgesCreated += canProduceCount;

      // Step 7: LLM edge refinement.
      const refinedCount = await this.refineEdges.refineEdges(edges, event);
      result.edgesRefined += refinedCount;

      // Emit EDGE_REFINED for each refinement.
      if (refinedCount > 0) {
        this.eventLogger.log(
          'EDGE_REFINED',
          {
            eventId: event.id,
            edgesRefined: refinedCount,
            totalEdges: edges.length,
          },
          event.session_id,
        );
      }

      // Step 7b: post-refinement contradiction detection.
      const contradictions = await this.detectContradictions.detectContradictions(edges, event);
      result.contradictionsDetected += contradictions;

      // Step 2b: mark as learned.
      await this.updateWkg.markAsLearned(event.id);
      result.eventsProcessed++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`processEvent failed for event ${event.id}: ${errorMessage}`);

      // Determine the step name from the error context. Because the pipeline
      // steps are sequential and we re-throw from within each awaited call,
      // the step is encoded in the error message by convention (each service
      // includes its class name). We fall back to 'unknown' when it cannot be
      // inferred so the dead-letter row is always written.
      const pipelineStep = inferPipelineStep(errorMessage);

      // Record the failure so silent data loss becomes auditable.
      await this.updateWkg.writeDeadLetter(event.id, pipelineStep, errorMessage);

      // Mark as learned anyway to prevent a broken event from blocking the cycle
      // on every subsequent run. A bad event should not stall the pipeline.
      try {
        await this.updateWkg.markAsLearned(event.id);
        result.eventsProcessed++;
      } catch {
        // If even this fails, let it be — the next cycle will retry.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort: derive the pipeline step name from an error message string.
 *
 * Each pipeline service logs its class name (e.g. "UpsertEntitiesService") in
 * thrown errors. We scan for known class name substrings so the dead-letter
 * row carries the specific step that failed rather than a generic label.
 * Falls back to 'unknown' so dead-letter rows are always written.
 */
function inferPipelineStep(errorMessage: string): string {
  const STEP_MAP: Array<[string, string]> = [
    ['UpsertEntities', 'upsertEntities'],
    ['ExtractTypedEdges', 'extractTypedEdges'],
    ['ExtractEdges', 'extractEdges'],
    ['ConversationEntry', 'conversationEntry'],
    ['CanProduceEdges', 'canProduceEdges'],
    ['RefineEdges', 'refineEdges'],
    ['DetectContradictions', 'detectContradictions'],
    ['markAsLearned', 'markAsLearned'],
  ];

  for (const [token, step] of STEP_MAP) {
    if (errorMessage.includes(token)) return step;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noop(): MaintenanceCycleResult {
  return {
    eventsProcessed: 0,
    entitiesUpserted: 0,
    edgesUpserted: 0,
    conversationsCreated: 0,
    canProduceEdgesCreated: 0,
    edgesRefined: 0,
    contradictionsDetected: 0,
    wasNoop: true,
  };
}

function reflectionNoop(): ReflectionResult {
  return {
    sessionId: '',
    insightsCreated: 0,
    edgesCreated: 0,
    wasNoop: true,
  };
}

function synthesisNoop(): SynthesisCycleResult {
  return {
    pairsExamined: 0,
    synthesesCreated: 0,
    wasNoop: true,
  };
}

/** Utility type to allow mutation of a readonly interface during accumulation. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

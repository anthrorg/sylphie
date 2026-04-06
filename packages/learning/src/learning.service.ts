/**
 * LearningService — Maintenance cycle orchestrator for the Learning subsystem.
 *
 * CANON §Subsystem 3 (Learning): Converts raw experience (TimescaleDB events)
 * into durable knowledge (WKG entities and edges) through a 7-step pipeline
 * executed in discrete, bounded maintenance cycles.
 *
 * Cycle trigger: setInterval (timer-based) with a configurable interval.
 * This is the fallback trigger. In a future phase, the Cognitive Awareness drive
 * should trigger cycles when pressure exceeds a threshold. For now, the timer
 * fires every CYCLE_INTERVAL_MS.
 *
 * Overlap guard: cycleInFlight prevents concurrent cycles. If a cycle is still
 * running when the timer fires, the new tick is dropped silently.
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
  IUpdateWkgService,
  IUpsertEntitiesService,
  IExtractEdgesService,
  IConversationEntryService,
  ICanProduceEdgesService,
  IRefineEdgesService,
  IConversationReflectionService,
  ILearningEventLogger,
  UnlearnedEvent,
} from './interfaces/learning.interfaces';
import {
  UPDATE_WKG_SERVICE,
  UPSERT_ENTITIES_SERVICE,
  EXTRACT_EDGES_SERVICE,
  CONVERSATION_ENTRY_SERVICE,
  CAN_PRODUCE_EDGES_SERVICE,
  REFINE_EDGES_SERVICE,
  CONVERSATION_REFLECTION_SERVICE,
  LEARNING_EVENT_LOGGER,
} from './learning.tokens';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum events processed per cycle (CANON §Subsystem 3 cognitive constraint). */
const MAX_EVENTS_PER_CYCLE = 5;

/** Interval between automatic maintenance cycles in milliseconds. */
const CYCLE_INTERVAL_MS = 60_000;

/** Interval between reflection cycles in milliseconds. */
const REFLECTION_INTERVAL_MS = 300_000; // 5 minutes

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

  /** Timer handle for the automatic maintenance cycle. */
  private cycleTimer: ReturnType<typeof setInterval> | null = null;

  /** Timer handle for the automatic reflection cycle. */
  private reflectionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(UPDATE_WKG_SERVICE)
    private readonly updateWkg: IUpdateWkgService,

    @Inject(UPSERT_ENTITIES_SERVICE)
    private readonly upsertEntities: IUpsertEntitiesService,

    @Inject(EXTRACT_EDGES_SERVICE)
    private readonly extractEdges: IExtractEdgesService,

    @Inject(CONVERSATION_ENTRY_SERVICE)
    private readonly conversationEntry: IConversationEntryService,

    @Inject(CAN_PRODUCE_EDGES_SERVICE)
    private readonly canProduceEdges: ICanProduceEdgesService,

    @Inject(REFINE_EDGES_SERVICE)
    private readonly refineEdges: IRefineEdgesService,

    @Inject(CONVERSATION_REFLECTION_SERVICE)
    private readonly conversationReflection: IConversationReflectionService,

    @Inject(LEARNING_EVENT_LOGGER)
    private readonly eventLogger: ILearningEventLogger,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    // Ensure the reflected_sessions table exists before starting timers.
    await this.conversationReflection.ensureSchema();

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

    this.logger.log(
      `Learning subsystem started — maintenance cycle every ${CYCLE_INTERVAL_MS / 1000}s, ` +
        `reflection cycle every ${REFLECTION_INTERVAL_MS / 1000}s`,
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

  // ---------------------------------------------------------------------------
  // Private: full cycle
  // ---------------------------------------------------------------------------

  private async executeCycle(): Promise<MaintenanceCycleResult> {
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

    const result: Mutable<MaintenanceCycleResult> = {
      eventsProcessed: 0,
      entitiesUpserted: 0,
      edgesUpserted: 0,
      conversationsCreated: 0,
      canProduceEdgesCreated: 0,
      edgesRefined: 0,
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
    });

    this.logger.log(
      `Learning cycle complete: ${result.eventsProcessed} events, ` +
        `${result.entitiesUpserted} entities, ${result.edgesUpserted} edges, ` +
        `${result.conversationsCreated} conversations, ` +
        `${result.canProduceEdgesCreated} can_produce, ` +
        `${result.edgesRefined} refined`,
    );

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

      // Step 4: extract edges.
      const edges = await this.extractEdges.extractEdges(entities, event);
      result.edgesUpserted += edges.length;

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

      // Step 2b: mark as learned.
      await this.updateWkg.markAsLearned(event.id);
      result.eventsProcessed++;
    } catch (err) {
      this.logger.error(
        `processEvent failed for event ${event.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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

/** Utility type to allow mutation of a readonly interface during accumulation. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

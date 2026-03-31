# Epic 7: Learning (Consolidation Pipeline) -- Forge Architectural Analysis

**Status:** Planning
**Epic Scope:** Maintenance cycle orchestrator, consolidation, entity extraction, edge refinement, contradiction detection, learning jobs (temporal patterns, procedures, generalization, correction)
**Analysis Date:** 2026-03-29
**Analyzer:** Forge (NestJS/TypeScript Systems Architect)

---

## Executive Summary

Epic 7 builds the **Learning subsystem** as a NestJS module that converts raw experience into durable knowledge in the World Knowledge Graph. This is the consolidation pipeline: events flow in from TimescaleDB, the LLM assists in entity/relationship extraction, contradictions are flagged as developmental catalysts, and the graph grows with proper provenance discipline.

The architecture must prevent:
1. **Hallucinated knowledge** -- LLM-generated edges carry explicit 0.35 base confidence, not confused with SENSOR/GUARDIAN provenance
2. **Catastrophic interference** -- max 5 learnable events per cycle; no batch processing overload
3. **Type 1 starvation** -- maintenance pressure comes first from Cognitive Awareness drive, timer is fallback; cost discipline maintained
4. **Provenance laundering** -- every entity/edge carries immutable provenance tags; no silent LLM takeover of the knowledge base
5. **Circular learning** -- the system can learn from its own past outputs, but those must be tagged and tracked for health metrics
6. **Job chaos** -- the 7+ learning jobs (temporal patterns, procedures, generalization, correction) must have clear scheduling, priority, and isolation

The Learning subsystem depends on:
- **E2 (Events)** -- queries TimescaleDB for learnable events, marks them processed
- **E3 (Knowledge)** -- reads WKG for context, upserts entities/edges with provenance
- **E4 (Drive Engine)** -- reads Cognitive Awareness drive value for pressure-driven scheduling (no write access)
- **E6 (Communication)** -- uses ILlmService.complete() for entity/edge extraction and refinement

This analysis covers module structure, job registry patterns, DI wiring, async/cancellation patterns, interface refinements, integration points, testing architecture, error handling, and configuration.

---

## 1. Module Architecture & Directory Layout

### 1.1 Directory Tree

```
src/learning/
├── learning.module.ts                          # Module declaration, imports/exports
├── learning.service.ts                         # Public facade (maintenance cycle orchestrator)
├── maintenance/
│   ├── maintenance-cycle.service.ts            # Pressure-driven cycle orchestration, timer fallback
│   ├── maintenance-pressure.service.ts         # Monitors Cognitive Awareness drive, computes pressure state
│   └── maintenance.interfaces.ts               # Maintenance-specific types
├── consolidation/
│   ├── consolidation.service.ts                # Event selection, cycle coordination
│   ├── event-selector.service.ts               # Query TimescaleDB for learnable events (max 5)
│   └── consolidation.interfaces.ts             # Consolidation types
├── entity-extraction/
│   ├── entity-extractor.service.ts             # LLM-assisted entity identification
│   ├── entity-validator.service.ts             # Confidence filtering, deduplication
│   └── entity-extraction.interfaces.ts         # Entity-specific types
├── edge-refinement/
│   ├── edge-refiner.service.ts                 # LLM-assisted relationship identification
│   ├── edge-validator.service.ts               # Consistency checks, cardinality constraints
│   └── edge-refinement.interfaces.ts           # Edge-specific types
├── contradiction-detection/
│   ├── contradiction-detector.service.ts       # Flags conflicts between new and existing knowledge
│   └── contradiction-detection.interfaces.ts   # Contradiction types
├── jobs/
│   ├── learning-job-registry.service.ts        # Job scheduling, orchestration, priority
│   ├── learning-job.interface.ts               # Base interface for all learning jobs
│   ├── temporal-pattern-job.service.ts         # Job: time-based pattern extraction
│   ├── procedure-formation-job.service.ts      # Job: action sequence generalization
│   ├── pattern-generalization-job.service.ts   # Job: clustering similar entities/edges
│   ├── correction-processing-job.service.ts    # Job: handle guardian corrections as learning signals
│   ├── prediction-feedback-job.service.ts      # Job: leverage failed predictions
│   ├── habit-formation-job.service.ts          # Job: recurring behavior consolidation
│   ├── contradiction-resolution-job.service.ts # Job: explore contradictions for growth
│   └── jobs.interfaces.ts                      # Job execution framework types
├── graph-operations/
│   ├── wkg-upsert.service.ts                   # Atomic upsert: nodes and edges with provenance
│   ├── wkg-query.service.ts                    # Rich querying for entity/edge context
│   └── graph-operations.interfaces.ts          # WKG-specific operation types
├── interfaces/
│   ├── learning.interfaces.ts                  # Top-level public interfaces (ILearningService)
│   └── learning.tokens.ts                      # DI injection tokens
├── exceptions/
│   └── learning.exceptions.ts                  # Domain-specific errors
├── config/
│   └── learning.config.ts                      # Learnable event types, job weights, thresholds
├── index.ts                                     # Barrel exports
└── README.md                                    # Module documentation
```

### 1.2 Module Declaration

```typescript
// src/learning/learning.module.ts
import { Module, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LearningService } from './learning.service';
import { MaintenanceCycleService } from './maintenance/maintenance-cycle.service';
import { MaintenancePressureService } from './maintenance/maintenance-pressure.service';
import { ConsolidationService } from './consolidation/consolidation.service';
import { EventSelectorService } from './consolidation/event-selector.service';
import { EntityExtractorService } from './entity-extraction/entity-extractor.service';
import { EntityValidatorService } from './entity-extraction/entity-validator.service';
import { EdgeRefinerService } from './edge-refinement/edge-refiner.service';
import { EdgeValidatorService } from './edge-refinement/edge-validator.service';
import { ContradictionDetectorService } from './contradiction-detection/contradiction-detector.service';
import { LearningJobRegistry } from './jobs/learning-job-registry.service';
import { TemporalPatternJobService } from './jobs/temporal-pattern-job.service';
import { ProcedureFormationJobService } from './jobs/procedure-formation-job.service';
import { PatternGeneralizationJobService } from './jobs/pattern-generalization-job.service';
import { CorrectionProcessingJobService } from './jobs/correction-processing-job.service';
import { PredictionFeedbackJobService } from './jobs/prediction-feedback-job.service';
import { HabitFormationJobService } from './jobs/habit-formation-job.service';
import { ContradictionResolutionJobService } from './jobs/contradiction-resolution-job.service';
import { WkgUpsertService } from './graph-operations/wkg-upsert.service';
import { WkgQueryService } from './graph-operations/wkg-query.service';

import { LEARNING_SERVICE, LEARNING_JOB_REGISTRY } from './interfaces/learning.tokens';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { EventsModule } from '../events/events.module';
import { DriveEngineModule } from '../drive-engine/drive-engine.module';
import { CommunicationModule } from '../communication/communication.module';

@Module({
  imports: [
    ConfigModule,
    KnowledgeModule,       // For WKG upsert/query and Self KG updates
    EventsModule,          // For querying learnable events, marking processed
    DriveEngineModule,     // For reading Cognitive Awareness drive (read-only)
    CommunicationModule,   // For ILlmService.complete()
  ],
  providers: [
    // Maintenance orchestration
    MaintenancePressureService,
    MaintenanceCycleService,

    // Consolidation pipeline
    EventSelectorService,
    ConsolidationService,

    // Entity/edge processing
    EntityExtractorService,
    EntityValidatorService,
    EdgeRefinerService,
    EdgeValidatorService,

    // Contradiction handling
    ContradictionDetectorService,

    // Learning jobs (all registered with LearningJobRegistry)
    TemporalPatternJobService,
    ProcedureFormationJobService,
    PatternGeneralizationJobService,
    CorrectionProcessingJobService,
    PredictionFeedbackJobService,
    HabitFormationJobService,
    ContradictionResolutionJobService,

    // Job orchestration
    LearningJobRegistry,
    {
      provide: LEARNING_JOB_REGISTRY,
      useClass: LearningJobRegistry,
    },

    // Graph operations
    WkgUpsertService,
    WkgQueryService,

    // Public facade
    LearningService,
    {
      provide: LEARNING_SERVICE,
      useClass: LearningService,
    },

    Logger,
  ],
  exports: [
    LEARNING_SERVICE,
    LEARNING_JOB_REGISTRY,  // For testing and advanced usage
  ],
})
export class LearningModule {}
```

---

## 2. Interface Contracts (E0 Refinements)

### 2.1 Core Learning Service Interface

```typescript
// src/learning/interfaces/learning.interfaces.ts

export interface ILearningService {
  /**
   * Trigger a maintenance cycle: consolidate recent experience into WKG.
   * Respects pressure-driven scheduling (Cognitive Awareness drive),
   * with timer fallback if pressure insufficient.
   *
   * Returns a detailed report of what was learned, contradictions detected, jobs executed.
   * Throws LearningCycleError if consolidation fails.
   */
  runMaintenanceCycle(): Promise<MaintenanceCycleResult>;

  /**
   * Check if consolidation should proceed now.
   * Combines pressure state (Cognitive Awareness) with timer state.
   * Non-blocking decision function used by scheduler.
   */
  shouldConsolidate(): Promise<boolean>;

  /**
   * Get statistics about learning health:
   * - Graph growth over time
   * - Type of provenance (SENSOR vs GUARDIAN vs LLM_GENERATED vs INFERENCE)
   * - Learning job success rates
   * - Contradiction resolution rate
   */
  getHealthMetrics(): Promise<LearningHealthMetrics>;

  /**
   * Query learning job status.
   * Used for monitoring and debugging job execution.
   */
  getJobStatus(jobName: string): Promise<JobStatus | null>;
}

export interface MaintenanceCycleResult {
  readonly cycleId: string;
  readonly timestamp: Date;
  readonly pressure: PressureState;
  readonly eventsProcessed: number;
  readonly entitiesUpserted: number;
  readonly edgesRefined: number;
  readonly contradictionsDetected: ContradictionRecord[];
  readonly jobsExecuted: JobExecutionRecord[];
  readonly duration: number; // milliseconds
  readonly success: boolean;
  readonly errors: LearningError[];
}

export interface PressureState {
  readonly cognitiveAwarenessValue: number; // [0, 1]
  readonly isPressureDriven: boolean;
  readonly timeSinceLastCycle: number; // milliseconds
  readonly shouldRunOnTimer: boolean;
}

export interface ContradictionRecord {
  readonly entityId: string;
  readonly existingValue: unknown;
  readonly newValue: unknown;
  readonly confidence: number;
  readonly type: 'ATTRIBUTE_CONFLICT' | 'CARDINALITY_VIOLATION' | 'TYPE_MISMATCH';
  readonly resolved: boolean;
  readonly resolution?: string;
}

export interface JobExecutionRecord {
  readonly jobName: string;
  readonly triggered: boolean;
  readonly duration: number;
  readonly status: 'SUCCESS' | 'PARTIAL' | 'SKIPPED' | 'ERROR';
  readonly itemsProcessed: number;
  readonly error?: string;
}

export interface LearningHealthMetrics {
  readonly graphSize: { nodes: number; edges: number };
  readonly provenanceDistribution: {
    readonly sensor: number;
    readonly guardian: number;
    readonly llmGenerated: number;
    readonly inference: number;
  };
  readonly jobStats: {
    readonly [jobName: string]: {
      readonly execCount: number;
      readonly successRate: number;
      readonly avgDuration: number;
    };
  };
  readonly contradictionStats: {
    readonly totalDetected: number;
    readonly resolved: number;
    readonly pending: number;
  };
  readonly cycleFrequency: number; // cycles per hour
}

export interface LearningError {
  readonly type: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly timestamp: Date;
}
```

### 2.2 Entity Extraction Interface

```typescript
// src/learning/entity-extraction/entity-extraction.interfaces.ts

export interface IEntityExtractionService {
  /**
   * Extract entities from raw event data using LLM assistance.
   *
   * Input: event text, conversation context, existing entities
   * Output: structured entity list with confidence scores
   *
   * Provenance: LLM_GENERATED at base 0.35 confidence
   */
  extract(request: EntityExtractionRequest): Promise<ExtractedEntity[]>;
}

export interface EntityExtractionRequest {
  readonly eventId: string;
  readonly text: string;
  readonly context: EventContext;
  readonly conversationId?: string;
  readonly existingEntities: Map<string, KnownEntity>;
}

export interface EventContext {
  readonly timestamp: Date;
  readonly source: 'CONVERSATION' | 'SENSOR' | 'PREDICTION_OUTCOME' | 'CORRECTION';
  readonly personId: string;
  readonly relatedEventIds: string[];
}

export interface ExtractedEntity {
  readonly label: string;
  readonly type: EntityType;
  readonly attributes: Map<string, unknown>;
  readonly confidence: number;
  readonly provenance: 'LLM_GENERATED';
  readonly llmReasoning: string; // Why the LLM thinks this is an entity
}

export type EntityType =
  | 'PHYSICAL_OBJECT'
  | 'LOCATION'
  | 'PERSON'
  | 'EVENT'
  | 'CONCEPT'
  | 'TIME'
  | 'CUSTOM';

export interface KnownEntity {
  readonly id: string;
  readonly label: string;
  readonly type: EntityType;
  readonly confidence: number;
  readonly provenance: Provenance;
}
```

### 2.3 Edge Refinement Interface

```typescript
// src/learning/edge-refinement/edge-refinement.interfaces.ts

export interface IEdgeRefinementService {
  /**
   * Refine relationships between entities using LLM assistance.
   *
   * Input: two entities, event text, existing edges between them
   * Output: list of relationship edges with labels and confidence
   *
   * Provenance: LLM_GENERATED at base 0.35 confidence
   */
  refine(request: EdgeRefinementRequest): Promise<RefinedEdge[]>;
}

export interface EdgeRefinementRequest {
  readonly sourceEntity: ExtractedEntity;
  readonly targetEntity: ExtractedEntity;
  readonly eventContext: EventContext;
  readonly existingEdges: KnownEdge[];
}

export interface RefinedEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly label: string;
  readonly edgeType: RelationshipType;
  readonly confidence: number;
  readonly provenance: 'LLM_GENERATED';
  readonly attributes: Map<string, unknown>;
  readonly llmReasoning: string;
}

export type RelationshipType =
  | 'IS_A'
  | 'PART_OF'
  | 'LOCATION_OF'
  | 'OWNER_OF'
  | 'CAUSES'
  | 'RELATED_TO'
  | 'CAN_PRODUCE'
  | 'CONTRADICTS'
  | 'CUSTOM';

export interface KnownEdge {
  readonly id: string;
  readonly label: string;
  readonly edgeType: RelationshipType;
  readonly confidence: number;
  readonly provenance: Provenance;
}
```

### 2.4 Contradiction Detection Interface

```typescript
// src/learning/contradiction-detection/contradiction-detection.interfaces.ts

export interface IContradictionDetector {
  /**
   * Check for contradictions between new and existing knowledge.
   *
   * Contradictions are development catalysts -- flag them,
   * log them, but don't suppress them.
   */
  check(entity: WkgEntity, newValue: unknown): Promise<ContradictionResult[]>;
}

export interface ContradictionResult {
  readonly entityId: string;
  readonly attributeName: string;
  readonly existingValue: unknown;
  readonly newValue: unknown;
  readonly existingConfidence: number;
  readonly newConfidence: number;
  readonly existingProvenance: Provenance;
  readonly newProvenance: Provenance;
  readonly severity: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly type: ContradictionType;
  readonly suggestedAction: 'ACCEPT_NEW' | 'KEEP_EXISTING' | 'MERGE' | 'INVESTIGATE';
}

export type ContradictionType =
  | 'DIRECT_CONFLICT'        // "X is red" vs "X is blue"
  | 'CARDINALITY_VIOLATION'  // "has_parent: 1" but found 2 parents
  | 'TYPE_MISMATCH'          // "X is a dog" vs "X is a vehicle"
  | 'TEMPORAL_PARADOX'       // "happened on Monday" vs "happened on Tuesday"
  | 'ATTRIBUTE_MISMATCH';    // Expected numeric, got string
```

### 2.5 Learning Job Interface

```typescript
// src/learning/jobs/learning-job.interface.ts

/**
 * Base interface for all learning jobs.
 *
 * Jobs are specialized consolidation algorithms that run on a schedule
 * (after main consolidation or pressure-triggered).
 * Each job has:
 * - shouldRun(): decision logic (time-based, event-based, or pressure-based)
 * - run(): execution logic that updates the graph
 * - priority: execution order when multiple jobs eligible
 */
export interface ILearningJob {
  /**
   * Unique job identifier, e.g., "temporal-pattern-detection"
   */
  readonly name: string;

  /**
   * Priority order: 0 (highest) to 100 (lowest).
   * Jobs with higher priority execute first in a cycle.
   */
  readonly priority: number;

  /**
   * Description of what this job does.
   */
  readonly description: string;

  /**
   * Determine if this job should run in the current cycle.
   *
   * Can be time-based (hasn't run in N hours),
   * event-based (new events match pattern),
   * or pressure-based (high cognitive load indicates learning opportunity).
   */
  shouldRun(context: JobContext): Promise<boolean>;

  /**
   * Execute the job: query events, update graph, record results.
   *
   * Must be idempotent or clearly indicate side effects.
   * Throws LearningJobError if unrecoverable.
   */
  run(context: JobContext): Promise<JobResult>;
}

export interface JobContext {
  readonly cycleId: string;
  readonly timestamp: Date;
  readonly pressure: PressureState;
  readonly previousJobResults: Map<string, JobResult>;
  readonly graphSnapshot: GraphSnapshot;
}

export interface JobResult {
  readonly jobName: string;
  readonly status: 'SUCCESS' | 'PARTIAL' | 'SKIPPED';
  readonly itemsProcessed: number;
  readonly itemsCreated: number;
  readonly itemsUpdated: number;
  readonly errors: string[];
  readonly duration: number;
  readonly insights?: string[]; // Human-readable findings
}

export interface GraphSnapshot {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly lastUpdateTime: Date;
  readonly entityIndex: Map<string, EntityMetadata>;
}

export interface EntityMetadata {
  readonly id: string;
  readonly label: string;
  readonly type: EntityType;
  readonly lastUpdated: Date;
  readonly provenanceDistribution: {
    readonly sensor: number;
    readonly guardian: number;
    readonly llmGenerated: number;
    readonly inference: number;
  };
}
```

---

## 3. Dependency Injection & Wiring

### 3.1 Module Imports & Dependency Paths

```
LearningModule
├── imports: [ConfigModule, KnowledgeModule, EventsModule, DriveEngineModule, CommunicationModule]
├── depends on:
│   ├── IWkgService (from KnowledgeModule)
│   │   ├── used by: WkgUpsertService, WkgQueryService
│   ├── ISelfKgService (from KnowledgeModule)
│   │   ├── used by: LearningService (for self-model updates)
│   ├── IEventService (from EventsModule)
│   │   ├── used by: EventSelectorService (queryLearnableEvents)
│   │   ├── used by: ConsolidationService (markProcessed)
│   ├── IDriveStateReader (from DriveEngineModule, read-only)
│   │   ├── used by: MaintenancePressureService (readDriveValue)
│   ├── ILlmService (from CommunicationModule)
│   │   ├── used by: EntityExtractorService (complete)
│   │   ├── used by: EdgeRefinerService (complete)
└── exports:
    ├── LEARNING_SERVICE
    └── LEARNING_JOB_REGISTRY
```

### 3.2 Injection Tokens

```typescript
// src/learning/interfaces/learning.tokens.ts

export const LEARNING_SERVICE = Symbol('LEARNING_SERVICE');
export const LEARNING_JOB_REGISTRY = Symbol('LEARNING_JOB_REGISTRY');

// Internal tokens (not exported)
export const MAINTENANCE_CYCLE_SERVICE = Symbol('MAINTENANCE_CYCLE_SERVICE');
export const MAINTENANCE_PRESSURE_SERVICE = Symbol('MAINTENANCE_PRESSURE_SERVICE');
export const CONSOLIDATION_SERVICE = Symbol('CONSOLIDATION_SERVICE');
export const EVENT_SELECTOR_SERVICE = Symbol('EVENT_SELECTOR_SERVICE');
export const ENTITY_EXTRACTOR_SERVICE = Symbol('ENTITY_EXTRACTOR_SERVICE');
export const ENTITY_VALIDATOR_SERVICE = Symbol('ENTITY_VALIDATOR_SERVICE');
export const EDGE_REFINER_SERVICE = Symbol('EDGE_REFINER_SERVICE');
export const EDGE_VALIDATOR_SERVICE = Symbol('EDGE_VALIDATOR_SERVICE');
export const CONTRADICTION_DETECTOR_SERVICE = Symbol('CONTRADICTION_DETECTOR_SERVICE');
export const WKG_UPSERT_SERVICE = Symbol('WKG_UPSERT_SERVICE');
export const WKG_QUERY_SERVICE = Symbol('WKG_QUERY_SERVICE');
```

### 3.3 Example Service Injection

```typescript
// src/learning/learning.service.ts
import { Injectable, Logger, Inject } from '@nestjs/common';
import { IEventService } from '../events/interfaces/events.interfaces';
import { IWkgService } from '../knowledge/interfaces/knowledge.interfaces';
import { IDriveStateReader } from '../drive-engine/interfaces/drive-engine.interfaces';
import { ILlmService } from '../communication/interfaces/communication.interfaces';
import { MaintenanceCycleService } from './maintenance/maintenance-cycle.service';
import { LearningJobRegistry } from './jobs/learning-job-registry.service';

@Injectable()
export class LearningService implements ILearningService {
  constructor(
    private readonly maintenanceCycle: MaintenanceCycleService,
    private readonly jobRegistry: LearningJobRegistry,
    @Inject(IWkgService) private readonly wkg: IWkgService,
    @Inject(IDriveStateReader) private readonly driveReader: IDriveStateReader,
    @Inject(IEventService) private readonly events: IEventService,
    @Inject(ILlmService) private readonly llm: ILlmService,
    private readonly logger: Logger,
  ) {}

  async runMaintenanceCycle(): Promise<MaintenanceCycleResult> {
    const cycleId = randomUUID();
    const startTime = Date.now();

    try {
      // Execute main cycle orchestration
      const result = await this.maintenanceCycle.execute(cycleId);

      // Execute registered jobs
      const jobResults = await this.jobRegistry.executeAll(cycleId);

      return {
        cycleId,
        timestamp: new Date(),
        ...result,
        jobsExecuted: jobResults,
        duration: Date.now() - startTime,
        success: true,
        errors: [],
      };
    } catch (error) {
      this.logger.error(`Maintenance cycle failed: ${error.message}`, error);
      throw error;
    }
  }

  async shouldConsolidate(): Promise<boolean> {
    return this.maintenanceCycle.shouldConsolidate();
  }

  async getHealthMetrics(): Promise<LearningHealthMetrics> {
    // Implementation details in dedicated service
  }

  async getJobStatus(jobName: string): Promise<JobStatus | null> {
    return this.jobRegistry.getStatus(jobName);
  }
}
```

---

## 4. Core Service Implementations

### 4.1 MaintenancePressureService

```typescript
// src/learning/maintenance/maintenance-pressure.service.ts
import { Injectable, Inject, Logger } from '@nestjs/common';
import { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { PressureState } from '../interfaces/learning.interfaces';

@Injectable()
export class MaintenancePressureService {
  private lastCycleTime: Date = new Date();
  private pressureThreshold = 0.6; // Configurable
  private timerIntervalMs = 60 * 60 * 1000; // 1 hour default

  constructor(
    @Inject(IDriveStateReader) private readonly driveReader: IDriveStateReader,
    private readonly logger: Logger,
  ) {}

  /**
   * Compute current pressure state.
   *
   * Pressure comes from Cognitive Awareness drive value.
   * High cognitive load indicates the system is overloaded and needs consolidation.
   *
   * Timer fallback: if pressure insufficient but timer elapsed, consolidate anyway.
   */
  async getPressureState(): Promise<PressureState> {
    const cognitiveAwareness = await this.driveReader.readDriveValue('COGNITIVE_AWARENESS');
    const now = new Date();
    const timeSinceLastCycle = now.getTime() - this.lastCycleTime.getTime();

    const isPressureDriven = cognitiveAwareness > this.pressureThreshold;
    const shouldRunOnTimer = timeSinceLastCycle > this.timerIntervalMs;

    return {
      cognitiveAwarenessValue: cognitiveAwareness,
      isPressureDriven,
      timeSinceLastCycle,
      shouldRunOnTimer,
    };
  }

  recordCycleExecution(): void {
    this.lastCycleTime = new Date();
    this.logger.debug(`Maintenance cycle recorded at ${this.lastCycleTime.toISOString()}`);
  }

  setPressureThreshold(value: number): void {
    if (value < 0 || value > 1) {
      throw new Error('Pressure threshold must be in [0, 1]');
    }
    this.pressureThreshold = value;
  }

  setTimerInterval(milliseconds: number): void {
    if (milliseconds <= 0) {
      throw new Error('Timer interval must be positive');
    }
    this.timerIntervalMs = milliseconds;
  }
}
```

### 4.2 ConsolidationService (Main Pipeline)

```typescript
// src/learning/consolidation/consolidation.service.ts
import { Injectable, Inject, Logger } from '@nestjs/common';
import { EventSelectorService } from './event-selector.service';
import { EntityExtractorService } from '../entity-extraction/entity-extractor.service';
import { EdgeRefinerService } from '../edge-refinement/edge-refiner.service';
import { ContradictionDetectorService } from '../contradiction-detection/contradiction-detector.service';
import { WkgUpsertService } from '../graph-operations/wkg-upsert.service';
import { IEventService } from '../../events/interfaces/events.interfaces';
import { MaintenanceCycleResult, PressureState } from '../interfaces/learning.interfaces';

@Injectable()
export class ConsolidationService {
  constructor(
    private readonly eventSelector: EventSelectorService,
    private readonly entityExtractor: EntityExtractorService,
    private readonly edgeRefiner: EdgeRefinerService,
    private readonly contradictionDetector: ContradictionDetectorService,
    private readonly wkgUpsert: WkgUpsertService,
    @Inject(IEventService) private readonly events: IEventService,
    private readonly logger: Logger,
  ) {}

  /**
   * Execute the main consolidation pipeline.
   *
   * 1. Select up to 5 learnable events
   * 2. For each event:
   *    a. Extract entities (LLM-assisted)
   *    b. Validate entities (dedup, confidence filtering)
   *    c. Refine edges between entities
   *    d. Detect contradictions with existing knowledge
   *    e. Upsert to WKG with provenance
   * 3. Mark events as processed
   * 4. Return detailed report
   */
  async consolidate(
    cycleId: string,
    pressure: PressureState,
  ): Promise<Omit<MaintenanceCycleResult, 'jobsExecuted' | 'success' | 'errors'>> {
    const startTime = Date.now();
    const startTimestamp = new Date();

    this.logger.log(`Consolidation cycle ${cycleId} starting. Pressure: ${pressure.isPressureDriven}`);

    try {
      // 1. Select learnable events (max 5)
      const events = await this.eventSelector.selectLearnableEvents(5);
      this.logger.log(`Selected ${events.length} learnable events for consolidation`);

      let entitiesUpserted = 0;
      let edgesRefined = 0;
      const contradictionsDetected: ContradictionRecord[] = [];

      // 2. Process each event
      for (const event of events) {
        try {
          // 2a. Extract entities
          const entities = await this.entityExtractor.extract({
            eventId: event.id,
            text: event.content,
            context: {
              timestamp: event.timestamp,
              source: event.source,
              personId: event.personId,
              relatedEventIds: [],
            },
            existingEntities: new Map(), // TODO: populate from WKG
          });

          // 2b. Upsert entities to WKG
          for (const entity of entities) {
            await this.wkgUpsert.upsertEntity(entity);
            entitiesUpserted++;
          }

          // 2c. Refine edges between extracted entities
          for (let i = 0; i < entities.length; i++) {
            for (let j = i + 1; j < entities.length; j++) {
              const edges = await this.edgeRefiner.refine({
                sourceEntity: entities[i],
                targetEntity: entities[j],
                eventContext: {
                  timestamp: event.timestamp,
                  source: event.source,
                  personId: event.personId,
                  relatedEventIds: [],
                },
                existingEdges: [],
              });

              // 2d. Detect contradictions and upsert edges
              for (const edge of edges) {
                const contradictions = await this.contradictionDetector.check(
                  { id: edge.sourceId, label: edge.sourceId },
                  edge,
                );
                contradictionsDetected.push(...contradictions);

                await this.wkgUpsert.upsertEdge(edge);
                edgesRefined++;
              }
            }
          }

          // 2e. Mark event as processed
          await this.events.markProcessed(event.id);
        } catch (eventError) {
          this.logger.warn(`Failed to process event ${event.id}: ${eventError.message}`);
          // Continue with next event (partial consolidation)
        }
      }

      const duration = Date.now() - startTime;

      return {
        cycleId,
        timestamp: startTimestamp,
        pressure,
        eventsProcessed: events.length,
        entitiesUpserted,
        edgesRefined,
        contradictionsDetected,
        duration,
      };
    } catch (error) {
      this.logger.error(`Consolidation cycle ${cycleId} failed: ${error.message}`, error);
      throw error;
    }
  }
}
```

---

## 5. Learning Job Registry Pattern

### 5.1 Job Registry & Orchestration

```typescript
// src/learning/jobs/learning-job-registry.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ILearningJob, JobContext, JobResult } from './learning-job.interface';

@Injectable()
export class LearningJobRegistry {
  private jobs: Map<string, ILearningJob> = new Map();
  private jobStatus: Map<string, JobStatus> = new Map();

  constructor(
    private readonly temporalPattern: TemporalPatternJobService,
    private readonly procedureFormation: ProcedureFormationJobService,
    private readonly patternGeneralization: PatternGeneralizationJobService,
    private readonly correctionProcessing: CorrectionProcessingJobService,
    private readonly predictionFeedback: PredictionFeedbackJobService,
    private readonly habitFormation: HabitFormationJobService,
    private readonly contradictionResolution: ContradictionResolutionJobService,
    private readonly logger: Logger,
  ) {
    this.registerJob(temporalPattern);
    this.registerJob(procedureFormation);
    this.registerJob(patternGeneralization);
    this.registerJob(correctionProcessing);
    this.registerJob(predictionFeedback);
    this.registerJob(habitFormation);
    this.registerJob(contradictionResolution);
  }

  /**
   * Register a learning job.
   * Jobs are sorted by priority once registered.
   */
  registerJob(job: ILearningJob): void {
    this.jobs.set(job.name, job);
    this.jobStatus.set(job.name, {
      name: job.name,
      lastRunAt: null,
      lastResult: null,
      isRunning: false,
    });
    this.logger.log(`Registered learning job: ${job.name} (priority: ${job.priority})`);
  }

  /**
   * Execute all eligible jobs in priority order.
   *
   * Each job:
   * 1. Checks shouldRun(context)
   * 2. If eligible, runs with cancellation token
   * 3. Results recorded in job status
   * 4. Errors logged but don't block subsequent jobs
   */
  async executeAll(cycleId: string): Promise<JobExecutionRecord[]> {
    // Sort jobs by priority
    const sortedJobs = Array.from(this.jobs.values()).sort(
      (a, b) => a.priority - b.priority,
    );

    const context: JobContext = {
      cycleId,
      timestamp: new Date(),
      pressure: {}, // Populated by caller
      previousJobResults: new Map(),
      graphSnapshot: {}, // Populated by caller
    };

    const results: JobExecutionRecord[] = [];

    for (const job of sortedJobs) {
      try {
        const status = this.jobStatus.get(job.name);
        if (!status) continue;

        status.isRunning = true;

        const shouldRun = await job.shouldRun(context);
        if (!shouldRun) {
          results.push({
            jobName: job.name,
            triggered: false,
            duration: 0,
            status: 'SKIPPED',
            itemsProcessed: 0,
          });
          status.isRunning = false;
          continue;
        }

        this.logger.log(`Starting learning job: ${job.name}`);
        const startTime = Date.now();

        const result = await job.run(context);
        const duration = Date.now() - startTime;

        status.lastRunAt = new Date();
        status.lastResult = result;
        status.isRunning = false;

        results.push({
          jobName: job.name,
          triggered: true,
          duration,
          status: result.status,
          itemsProcessed: result.itemsProcessed,
        });

        context.previousJobResults.set(job.name, result);

        this.logger.log(
          `Completed learning job: ${job.name} (${duration}ms, status: ${result.status})`,
        );
      } catch (error) {
        this.logger.error(`Learning job ${job.name} failed: ${error.message}`, error);
        results.push({
          jobName: job.name,
          triggered: true,
          duration: 0,
          status: 'ERROR',
          itemsProcessed: 0,
          error: error.message,
        });
      }
    }

    return results;
  }

  getStatus(jobName: string): JobStatus | null {
    return this.jobStatus.get(jobName) || null;
  }
}

export interface JobStatus {
  readonly name: string;
  readonly lastRunAt: Date | null;
  readonly lastResult: JobResult | null;
  readonly isRunning: boolean;
}

export interface JobExecutionRecord {
  readonly jobName: string;
  readonly triggered: boolean;
  readonly duration: number;
  readonly status: 'SUCCESS' | 'PARTIAL' | 'SKIPPED' | 'ERROR';
  readonly itemsProcessed: number;
  readonly error?: string;
}
```

### 5.2 Example Job Implementation

```typescript
// src/learning/jobs/temporal-pattern-job.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ILearningJob, JobContext, JobResult } from './learning-job.interface';

/**
 * Temporal Pattern Detection Job
 *
 * Finds recurring time-based patterns in events:
 * - "Jim usually arrives at 9am"
 * - "Conversations about X happen on Thursdays"
 * - "Coffee cup appears on desk in mornings"
 *
 * Triggered: every 6 hours (timer-based)
 * Priority: medium
 */
@Injectable()
export class TemporalPatternJobService implements ILearningJob {
  readonly name = 'temporal-pattern-detection';
  readonly priority = 40;
  readonly description = 'Detect recurring temporal patterns in events';
  private lastRunTime: Date | null = null;
  private runIntervalMs = 6 * 60 * 60 * 1000; // 6 hours

  constructor(private readonly logger: Logger) {}

  async shouldRun(context: JobContext): Promise<boolean> {
    if (!this.lastRunTime) return true; // First run

    const elapsed = Date.now() - this.lastRunTime.getTime();
    const shouldRun = elapsed > this.runIntervalMs;

    this.logger.debug(
      `${this.name}: elapsed=${elapsed}ms, threshold=${this.runIntervalMs}ms, shouldRun=${shouldRun}`,
    );

    return shouldRun;
  }

  async run(context: JobContext): Promise<JobResult> {
    this.lastRunTime = new Date();

    try {
      // Query recent events grouped by hour/day of week
      // Find patterns with confidence > 0.70
      // Upsert pattern nodes and edges

      // Placeholder implementation
      const itemsProcessed = 0;
      const itemsCreated = 0;

      return {
        jobName: this.name,
        status: 'SUCCESS',
        itemsProcessed,
        itemsCreated,
        itemsUpdated: 0,
        errors: [],
        duration: 0,
        insights: ['No new temporal patterns detected in this cycle'],
      };
    } catch (error) {
      return {
        jobName: this.name,
        status: 'PARTIAL',
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        errors: [error.message],
        duration: 0,
      };
    }
  }
}
```

---

## 6. Async & Cancellation Patterns

### 6.1 Long-Running Cycle Cancellation

```typescript
// src/learning/maintenance/maintenance-cycle.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Injectable()
export class MaintenanceCycleService {
  private cancellationSubject$ = new Subject<void>();

  constructor(private readonly logger: Logger) {}

  /**
   * Execute a full maintenance cycle with cancellation support.
   *
   * If cancellation is requested (e.g., system shutdown),
   * in-flight operations will abort gracefully.
   */
  async execute(cycleId: string): Promise<CycleExecutionResult> {
    const cancellation$ = this.cancellationSubject$.pipe(
      takeUntil(new Promise((resolve) => setTimeout(resolve, 30 * 60 * 1000))), // 30 min timeout
    );

    // Set up abort signal
    const controller = new AbortController();
    const cancellationSubscription = cancellation$.subscribe(() => {
      this.logger.warn(`Cancellation requested for cycle ${cycleId}`);
      controller.abort();
    });

    try {
      // Main consolidation work with cancellation token
      return await this.runConsolidationWithCancellation(cycleId, controller.signal);
    } finally {
      cancellationSubscription.unsubscribe();
    }
  }

  /**
   * Request cancellation of the current cycle.
   * Used during graceful shutdown or emergency stop.
   */
  requestCancellation(): void {
    this.cancellationSubject$.next();
  }

  private async runConsolidationWithCancellation(
    cycleId: string,
    signal: AbortSignal,
  ): Promise<CycleExecutionResult> {
    // Implementation respects signal.aborted
    if (signal.aborted) {
      throw new Error('Consolidation cycle aborted');
    }

    // Work in phases with checkpoint signals
    return {
      cycleId,
      success: true,
    };
  }
}
```

### 6.2 Error Recovery & Partial Consolidation

```typescript
/**
 * Consolidation error handling strategy:
 *
 * - Entity extraction failure (LLM unavailable):
 *   → Skip entity extraction, retry with simpler schema
 *   → Continue to next event
 *   → Record as PARTIAL consolidation
 *
 * - Edge refinement failure:
 *   → Skip edge refinement for that pair
 *   → Continue to next pair
 *   → Mark edges as "unrefined" pending next cycle
 *
 * - Contradiction detection expensive:
 *   → Use approximate checks for performance
 *   → Deep checks run only on high-confidence contradictions
 *
 * - WKG upsert failure (graph locked):
 *   → Buffer failed upserts
 *   → Retry with exponential backoff
 *   → Cap retry attempts to prevent infinite loops
 *
 * Goal: Consolidation is resilient. One failure doesn't abort the entire cycle.
 */
```

---

## 7. Integration Points

### 7.1 With Decision Making Module

```
Learning → Decision Making: NONE (read-only relationship)
Decision Making → Learning: Writes prediction outcomes, episodic memory to TimescaleDB
  - Events tagged with "learnable=true" when prediction failed
  - Triggers maintenance cycle via drive pressure
```

### 7.2 With Events Module

```
Learning ↔ Events:
  - Learning.eventSelector queries Events.queryLearnableEvents(limit=5)
  - Learning marks events processed via Events.markProcessed(eventId)
  - Events module manages event schema with "has_learnable" flag
```

### 7.3 With Knowledge Module

```
Learning ↔ Knowledge:
  - Learning reads WKG via Knowledge.queryNode(), queryEdges()
  - Learning writes WKG via Knowledge.upsertNode(), upsertEdge()
  - All upserts carry PROVENANCE: { type: 'LLM_GENERATED', confidence: 0.35 }
  - Learning reads/writes Self KG for personality metrics
  - Learning CANNOT write to Other KGs (person models)
```

### 7.4 With Drive Engine Module

```
Learning ← Drive Engine (read-only):
  - Learning.maintenancePressure reads Cognitive Awareness drive value
  - No write access to drive rules or evaluation function
  - Pressure value used only for scheduling decision
```

### 7.5 With Communication Module

```
Learning → Communication (LLM service):
  - EntityExtractor.extract() calls Communication.llm.complete()
  - EdgeRefiner.refine() calls Communication.llm.complete()
  - Both LLM calls receive explicit context: "Extract entities. Return JSON."
  - LLM tokens counted against cognitive effort drive budget
```

---

## 8. Configuration

### 8.1 Environment Variables & Defaults

```typescript
// src/learning/config/learning.config.ts
export const LEARNING_CONFIG = {
  // Consolidation limits
  MAX_EVENTS_PER_CYCLE: 5,
  MAX_ENTITIES_PER_EVENT: 20,
  MAX_EDGES_PER_ENTITY_PAIR: 5,

  // Maintenance scheduling
  PRESSURE_THRESHOLD: 0.6,           // Cognitive Awareness > this triggers consolidation
  TIMER_INTERVAL_MS: 60 * 60 * 1000, // 1 hour fallback
  CYCLE_TIMEOUT_MS: 30 * 60 * 1000,  // 30 min max consolidation time

  // Confidence thresholds
  ENTITY_CONFIDENCE_MIN: 0.40,        // Filter low-confidence entities
  EDGE_CONFIDENCE_MIN: 0.35,          // Min edge confidence (LLM_GENERATED base)
  CONTRADICTION_CONFIDENCE_MIN: 0.50, // Flag contradictions above this

  // LLM prompt templates
  ENTITY_EXTRACTION_PROMPT_VERSION: 'v1',
  EDGE_REFINEMENT_PROMPT_VERSION: 'v1',

  // Job scheduling
  JOB_EXECUTION_TIMEOUT_MS: 5 * 60 * 1000, // 5 min per job
  JOB_MAX_RETRIES: 2,
};
```

### 8.2 Configurable Properties

```typescript
// Can be overridden via environment variables
// LEARNING__MAX_EVENTS_PER_CYCLE=10
// LEARNING__PRESSURE_THRESHOLD=0.7
```

---

## 9. Testing Architecture

### 9.1 Unit Testing Pattern

```typescript
// src/learning/entity-extraction/entity-extractor.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { EntityExtractorService } from './entity-extractor.service';
import { ILlmService } from '../../communication/interfaces/communication.interfaces';

describe('EntityExtractorService', () => {
  let service: EntityExtractorService;
  let mockLlmService: Partial<ILlmService>;

  beforeEach(async () => {
    mockLlmService = {
      complete: jest.fn().mockResolvedValue({
        entities: [
          { label: 'Jim', type: 'PERSON', confidence: 0.92 },
          { label: 'Kitchen', type: 'LOCATION', confidence: 0.85 },
        ],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntityExtractorService,
        {
          provide: ILlmService,
          useValue: mockLlmService,
        },
      ],
    }).compile();

    service = module.get<EntityExtractorService>(EntityExtractorService);
  });

  it('should extract entities with LLM_GENERATED provenance', async () => {
    const result = await service.extract({
      eventId: 'evt-1',
      text: 'Jim walked into the kitchen.',
      context: { timestamp: new Date(), source: 'CONVERSATION', personId: 'Person_Jim', relatedEventIds: [] },
      existingEntities: new Map(),
    });

    expect(result).toHaveLength(2);
    expect(result[0].provenance).toBe('LLM_GENERATED');
    expect(result[0].confidence).toBeLessThanOrEqual(0.35); // Base confidence
  });

  it('should handle LLM failures gracefully', async () => {
    mockLlmService.complete = jest.fn().mockRejectedValue(new Error('LLM unavailable'));

    await expect(service.extract({...})).rejects.toThrow();
  });
});
```

### 9.2 Integration Testing Pattern

```typescript
// tests/integration/learning.integration.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { LearningModule } from '../../src/learning/learning.module';
import { KnowledgeModule } from '../../src/knowledge/knowledge.module';
import { EventsModule } from '../../src/events/events.module';

describe('Learning Integration', () => {
  let module: TestingModule;
  let learningService: ILearningService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DatabaseTestModule, // In-memory databases
        LearningModule,
        KnowledgeModule,
        EventsModule,
      ],
    }).compile();

    learningService = module.get(LEARNING_SERVICE);
  });

  afterAll(async () => {
    await module.close();
  });

  it('should consolidate events into WKG with correct provenance', async () => {
    // Seed test events into TimescaleDB
    // Run consolidation cycle
    // Assert WKG contains expected nodes/edges with LLM_GENERATED provenance
    // Assert event marked as processed
  });

  it('should detect contradictions and flag them', async () => {
    // Seed conflicting events
    // Run consolidation
    // Assert contradictions captured in result
  });

  it('should respect pressure-driven scheduling', async () => {
    // Mock Cognitive Awareness = 0.3 (low pressure)
    // Assert shouldConsolidate() returns false
    // Advance time past timer threshold
    // Assert shouldConsolidate() returns true
  });
});
```

---

## 10. Error Handling & Exception Hierarchy

```typescript
// src/learning/exceptions/learning.exceptions.ts

export class LearningError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean = true,
  ) {
    super(message);
    this.name = 'LearningError';
  }
}

export class EntityExtractionError extends LearningError {
  constructor(message: string) {
    super(message, 'ENTITY_EXTRACTION_FAILED', true);
  }
}

export class EdgeRefinementError extends LearningError {
  constructor(message: string) {
    super(message, 'EDGE_REFINEMENT_FAILED', true);
  }
}

export class ContradictionDetectionError extends LearningError {
  constructor(message: string) {
    super(message, 'CONTRADICTION_DETECTION_FAILED', true);
  }
}

export class WkgUpsertError extends LearningError {
  constructor(message: string, recoverable: boolean = true) {
    super(message, 'WKG_UPSERT_FAILED', recoverable);
  }
}

export class MaintenanceCycleError extends LearningError {
  constructor(message: string, public readonly partialResult?: MaintenanceCycleResult) {
    super(message, 'MAINTENANCE_CYCLE_FAILED', true);
  }
}

export class LearningJobError extends LearningError {
  constructor(
    public readonly jobName: string,
    message: string,
    recoverable: boolean = true,
  ) {
    super(message, 'LEARNING_JOB_FAILED', recoverable);
  }
}
```

---

## 11. Health & Observability

### 11.1 Metrics to Export

```typescript
export const LEARNING_METRICS = {
  // Consolidation cycles
  cycles_total: 'counter',
  cycles_success: 'counter',
  cycles_partial: 'counter',
  cycles_failed: 'counter',
  cycle_duration_seconds: 'histogram',

  // Entity/edge processing
  entities_extracted_total: 'counter',
  entities_upserted_total: 'counter',
  edges_refined_total: 'counter',
  edges_upserted_total: 'counter',

  // Contradictions
  contradictions_detected_total: 'counter',
  contradictions_resolved_total: 'counter',

  // Learning jobs
  jobs_executed_total: 'counter',
  jobs_success: 'counter',
  jobs_failed: 'counter',
  job_duration_seconds: 'histogram',

  // Graph health
  wkg_node_count: 'gauge',
  wkg_edge_count: 'gauge',
  provenance_distribution: 'gauge', // By type: SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE

  // Pressure dynamics
  cognitive_awareness_value: 'gauge',
  pressure_driven_cycles: 'counter',
  timer_fallback_cycles: 'counter',
};
```

### 11.2 Logging Strategy

```
[LEARNING] INFO  Consolidation cycle evt-abc-123 starting. Pressure: 0.72 (isPressureDriven=true)
[LEARNING] DEBUG Selected 5 learnable events for consolidation
[LEARNING] DEBUG Entity extraction: 12 entities extracted, 10 retained (2 below confidence threshold)
[LEARNING] DEBUG Edge refinement: 18 edges proposed, 14 upserted
[LEARNING] WARN  Contradiction detected: Person_Jim.age = 30 vs 31 (confidence_mismatch)
[LEARNING] INFO  Consolidation cycle evt-abc-123 completed. Duration: 2.34s. Entities: 10. Edges: 14. Contradictions: 1.

[LEARNING] INFO  Learning job temporal-pattern-detection starting
[LEARNING] DEBUG Job status: triggered=true, eligibility_reason=timer_elapsed (last_run=6h 15m ago)
[LEARNING] INFO  Job temporal-pattern-detection completed. Status: SUCCESS. Items: 3. Duration: 1.23s.

[LEARNING] ERROR Maintenance cycle failed: LLM service unavailable. Partial result: [entities_extracted=7, edges_refined=4]. Will retry next cycle.
```

---

## 12. Known Attractor States & Anti-Patterns

### 12.1 Prevention Strategies

| Attractor State | Prevention |
|-----------------|-----------|
| **LLM Takeover** | Provenance discipline: LLM_GENERATED tagged at 0.35, never confused with GUARDIAN/SENSOR. Health metric tracks provenance distribution. If LLM_GENERATED > 60%, alert. |
| **Catastrophic Interference** | Hard limit: max 5 events per cycle. If queue overflows, skip events (don't batch). Prevents gradient collapse. |
| **Circular Learning** | Track entity origin: if newly upserted entity was generated from own prior output, tag as "self-referential" with lower confidence ceiling. |
| **Contradiction Suppression** | Contradictions logged, never hidden. Flagged as development catalysts. Suggest `INVESTIGATE` action for high-severity contradictions. |
| **Job Thrashing** | Job priorities enforce order. Execution timeouts prevent runaway. If job fails repeatedly, disable temporarily. |
| **Graph Explosion** | Monitor node/edge growth rate. If exceeding threshold (e.g., 1000 nodes/cycle), audit entity extraction for hallucinations. |

---

## 13. Deployment & Operational Considerations

### 13.1 Database Preparation

```sql
-- TimescaleDB: ensure learnable event hypertable
SELECT create_hypertable('events', 'timestamp', if_not_exists => TRUE);

-- Add indexes for efficient learnable event queries
CREATE INDEX CONCURRENTLY idx_events_learnable_timestamp
  ON events (timestamp DESC)
  WHERE has_learnable = true;

-- Neo4j: ensure indexes for entity/edge lookups
CREATE INDEX entity_label_type IF NOT EXISTS
  FOR (n:Entity) ON (n.label, n.type);

CREATE INDEX edge_source_target IF NOT EXISTS
  FOR ()-[r:RELATED_TO]-() ON (r.sourceId, r.targetId);
```

### 13.2 Capacity Planning

```
Assumptions:
- 100 events/day marked learnable
- 20 entities extracted per event (2000 total)
- 3 relationships per entity pair on average (~60k edges)
- LLM completion ~2s per entity extraction, ~1s per edge refinement
- Max consolidation time: 30 minutes

Calculation:
- Entity extraction: 100 events * 20 entities * 2s = 4000s (67 min) ❌ EXCEEDS LIMIT
- Solution: Run smaller cycles more frequently, or batch LLM calls
- Recommendation: Max 5 events/cycle = 200 entities * 2s = 400s ✓

Database capacity:
- Neo4j: 100k+ entities, 600k+ edges easily handled
- TimescaleDB: 100 events/day = 36.5k events/year (well within range)
- Grafeo (Self KG): <1GB typical size
```

### 13.3 Monitoring Checklist

- [ ] Consolidation cycle duration < 30 minutes
- [ ] Entity extraction success rate > 90%
- [ ] LLM_GENERATED confidence ceiling: 0.35 base
- [ ] Contradiction rate < 5% (expected ~2%)
- [ ] Job execution success rate > 95%
- [ ] Provenance distribution tracked (alert if LLM_GENERATED > 60%)
- [ ] WKG growth rate stable (not exponential)

---

## 14. Epic Breakdown (Implementation Tickets)

### Phase 1: Core Infrastructure

1. **E7-T1: Module Structure & DI Wiring**
   - Create LearningModule, export tokens
   - Wire KnowledgeModule, EventsModule, DriveEngineModule, CommunicationModule
   - Verify dependency graph

2. **E7-T2: Maintenance Cycle Orchestrator**
   - MaintenanceCycleService: execute()
   - MaintenancePressureService: getPressureState()
   - Test pressure-driven vs timer-fallback scheduling

### Phase 2: Consolidation Pipeline

3. **E7-T3: Event Selection & Consolidation**
   - EventSelectorService: queryLearnableEvents(limit=5)
   - ConsolidationService: coordinate entity/edge processing
   - Integration with EventsModule

4. **E7-T4: Entity Extraction**
   - EntityExtractorService: LLM-assisted entity identification
   - EntityValidatorService: deduplication, confidence filtering
   - Provenance discipline: LLM_GENERATED at 0.35

5. **E7-T5: Edge Refinement**
   - EdgeRefinerService: LLM-assisted relationship identification
   - EdgeValidatorService: cardinality & type checks
   - Integration with WKG upsert

### Phase 3: Graph Operations & Contradictions

6. **E7-T6: WKG Upsert & Query**
   - WkgUpsertService: atomic upsert with provenance
   - WkgQueryService: entity/edge context lookups
   - Integration with KnowledgeModule

7. **E7-T7: Contradiction Detection**
   - ContradictionDetectorService: identify conflicts
   - Flag as developmental catalysts
   - Return detailed contradiction records

### Phase 4: Learning Jobs

8. **E7-T8: Job Registry & Orchestration**
   - LearningJobRegistry: registration, execution, priority
   - Job interface: shouldRun(), run(), priority
   - Integration testing framework

9. **E7-T9: Temporal Pattern Job**
   - TemporalPatternJobService: time-based pattern detection
   - Example: "Jim arrives at 9am on weekdays"

10. **E7-T10: Procedure Formation Job**
    - ProcedureFormationJobService: action sequence generalization
    - Example: "Morning routine: coffee → desk → check messages"

11. **E7-T11: Pattern Generalization Job**
    - PatternGeneralizationJobService: entity/edge clustering
    - Reduce redundancy, find schema-level patterns

12. **E7-T12: Correction Processing Job**
    - CorrectionProcessingJobService: guardian feedback learning
    - Weight guardian corrections 3x vs algorithmic signals

13. **E7-T13: Prediction Feedback & Habit Formation Jobs**
    - PredictionFeedbackJobService: failed prediction analysis
    - HabitFormationJobService: recurring behavior consolidation

14. **E7-T14: Contradiction Resolution Job**
    - ContradictionResolutionJobService: explore contradictions
    - Suggest knowledge graph updates

### Phase 5: Testing & Observability

15. **E7-T15: Unit Tests**
    - EntityExtractor, EdgeRefiner, ContradictionDetector
    - Job implementations
    - Error handling

16. **E7-T16: Integration Tests**
    - Full consolidation cycle with mocked dependencies
    - Pressure-driven scheduling
    - Job orchestration

17. **E7-T17: Metrics & Observability**
    - Prometheus metrics export
    - Structured logging
    - Health check endpoint

---

## 15. Summary Table: Key Decisions

| Decision | Rationale | Trade-offs |
|----------|-----------|-----------|
| Max 5 events/cycle | Prevents catastrophic interference, keeps consolidation < 30 min | May require more cycles; higher operational load |
| LLM_GENERATED at 0.35 base | Prevents LLM hallucinations from dominating graph | Slower Type 1 graduation; requires guardian feedback to reach 0.80 |
| Pressure-driven scheduling | Honors Cognitive Awareness drive; emergent learning priority | Timer fallback needed if pressure insufficient; operational complexity |
| Job registry pattern | Decouples jobs, enables modular addition | Central registry becomes coupling point; careful DI needed |
| Cancellation via AbortSignal | Standard async pattern; integrates with NestJS lifecycle | Requires careful cleanup in long-running phases |
| Partial consolidation on error | Resilient; one event failure doesn't abort cycle | May produce incomplete graph updates; requires idempotency |

---

## Appendix: Reference Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   LEARNING SUBSYSTEM (E7)                    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         MAINTENANCE ORCHESTRATION                    │   │
│  │  - Pressure-driven (Cognitive Awareness drive)      │   │
│  │  - Timer fallback (1 hour)                          │   │
│  │  - Cycle timeout (30 min)                           │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                    │
│                          ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │      CONSOLIDATION PIPELINE (MAIN CYCLE)             │   │
│  │  1. Select ≤5 learnable events (TimescaleDB)        │   │
│  │  2. Extract entities (LLM @ 0.35 confidence)        │   │
│  │  3. Refine edges (LLM relationships)                │   │
│  │  4. Detect contradictions                           │   │
│  │  5. Upsert to WKG (with provenance)                 │   │
│  │  6. Mark events processed                           │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                    │
│                          ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │      LEARNING JOBS (ASYNCHRONOUS, PRIORITY-BASED)   │   │
│  │  • Temporal Pattern Detection (6h interval)         │   │
│  │  • Procedure Formation (event-triggered)            │   │
│  │  • Pattern Generalization (6h interval)             │   │
│  │  • Correction Processing (event-triggered)          │   │
│  │  • Prediction Feedback (decision-driven)            │   │
│  │  • Habit Formation (weekly)                         │   │
│  │  • Contradiction Resolution (on demand)             │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                    │
│                          ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              WKG WRITES (with provenance)           │   │
│  │  - Entities: LLM_GENERATED (0.35)                   │   │
│  │  - Edges: LLM_GENERATED (0.35)                      │   │
│  │  - Contradictions: logged as development catalysts  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
        │                      │                      │
        ▼                      ▼                      ▼
  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
  │ TimescaleDB  │    │ Neo4j (WKG)  │    │ Grafeo (Self)│
  │ (Read events)│    │ (Write graph)│    │ (Update KG)  │
  └──────────────┘    └──────────────┘    └──────────────┘
```

---

**End of Forge Analysis**

Last Updated: 2026-03-29
Next Session: Implement E7-T1 through E7-T3 (core infrastructure and consolidation)

/**
 * LearningModule — NestJS module for Sylphie's Learning subsystem.
 *
 * CANON §Subsystem 3 (Learning): Converts experience into durable knowledge
 * via a maintenance cycle pipeline: LearnableEvent → entity extraction →
 * edge refinement → contradiction detection → WKG upsert.
 *
 * Full T002 Wiring:
 * ================
 * Imports (required modules):
 *   - DriveEngineModule       (provides DRIVE_STATE_READER, read-only)
 *   - KnowledgeModule         (provides WKG_SERVICE, CONFIDENCE_SERVICE)
 *   - EventsModule            (provides EVENTS_SERVICE)
 *   - CommunicationModule     (provides LLM_SERVICE via re-export from shared)
 *   - ConfigModule            (provides learning cycle config settings)
 *
 * Providers (services exported as public or internal):
 *   PUBLIC EXPORTS:
 *     LEARNING_SERVICE              → LearningService (main orchestrator)
 *     LEARNING_JOB_REGISTRY         → JobRegistryService (job management)
 *
 *   INTERNAL (pipeline + orchestration):
 *     ENTITY_EXTRACTION_SERVICE     → EntityExtractionService
 *     EDGE_REFINEMENT_SERVICE       → EdgeRefinementService
 *     CONTRADICTION_DETECTOR        → ContradictionDetectorService
 *     CONSOLIDATION_SERVICE         → ConsolidationService
 *     EVENT_RANKER_SERVICE          → EventRankerService
 *     MAINTENANCE_CYCLE_SERVICE     → MaintenanceCycleService
 *     PROVENANCE_HEALTH_SERVICE     → ProvenanceHealthService
 *     LEARNING_METRICS_SERVICE      → LearningMetricsService
 *
 *   JOBS:
 *     Registered via JobRegistryService:
 *       - TemporalPatternJob
 *       - ProcedureFormationJob
 *       - CorrectionProcessingJob
 *       - SentenceProcessingJob
 *       - PatternGeneralizationJob
 *
 * Exports:
 *   LEARNING_SERVICE              — Decision Making calls shouldConsolidate()
 *                                    to gate cycle triggering, and
 *                                    runMaintenanceCycle() to execute.
 *   LEARNING_JOB_REGISTRY         — For Testing/Diagnostics: introspection
 *                                    into registered learning jobs.
 *
 * Internal services (pipeline components, metrics, health) are NOT exported.
 * They are orchestrated exclusively by LearningService and MaintenanceCycleService.
 *
 * CANON §Drive Isolation: Injected as DRIVE_STATE_READER (read-only).
 * One-way communication: LearningService reads drive state but never writes.
 * Drive rules are protected by postgres and cannot be modified from here.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DriveEngineModule } from '../drive-engine';
import { KnowledgeModule } from '../knowledge';
import { EventsModule } from '../events';
import { CommunicationModule } from '../communication';

// Main orchestrator
import { LearningService } from './learning.service';

// Pipeline services
import { EntityExtractionService } from './extraction/entity-extraction.service';
import { EdgeRefinementService } from './extraction/edge-refinement.service';
import { ContradictionDetectorService } from './extraction/contradiction-detector.service';

// Consolidation & maintenance
import { ConsolidationService } from './consolidation/consolidation.service';
import { EventRankerService } from './consolidation/event-ranker.service';
import { MaintenanceCycleService } from './consolidation/maintenance-cycle.service';

// Jobs
import { JobRegistryService } from './jobs/job-registry.service';
import { TemporalPatternJob } from './jobs/temporal-pattern.job';
import { ProcedureFormationJob } from './jobs/procedure-formation.job';
import { CorrectionProcessingJob } from './jobs/correction-processing.job';
import { SentenceProcessingJob } from './jobs/sentence-processing.job';
import { PatternGeneralizationJob } from './jobs/pattern-generalization.job';

// Metrics and health
import { ProvenanceHealthService } from './metrics/provenance-health.service';
import { LearningMetricsService } from './metrics/learning-metrics.service';

// Tokens
import {
  LEARNING_SERVICE,
  LEARNING_JOB_REGISTRY,
  ENTITY_EXTRACTION_SERVICE,
  EDGE_REFINEMENT_SERVICE,
  CONTRADICTION_DETECTOR,
  CONSOLIDATION_SERVICE,
  EVENT_RANKER_SERVICE,
  MAINTENANCE_CYCLE_SERVICE,
  PROVENANCE_HEALTH_SERVICE,
  LEARNING_METRICS_SERVICE,
} from './learning.tokens';

@Module({
  imports: [
    DriveEngineModule,
    KnowledgeModule,
    EventsModule,
    CommunicationModule,
    ConfigModule,
  ],
  providers: [
    // Main public orchestrator
    {
      provide: LEARNING_SERVICE,
      useClass: LearningService,
    },

    // Job registry (public for testing/diagnostics)
    {
      provide: LEARNING_JOB_REGISTRY,
      useClass: JobRegistryService,
    },

    // Pipeline services (internal)
    {
      provide: ENTITY_EXTRACTION_SERVICE,
      useClass: EntityExtractionService,
    },
    {
      provide: EDGE_REFINEMENT_SERVICE,
      useClass: EdgeRefinementService,
    },
    {
      provide: CONTRADICTION_DETECTOR,
      useClass: ContradictionDetectorService,
    },

    // Consolidation & orchestration (internal)
    {
      provide: CONSOLIDATION_SERVICE,
      useClass: ConsolidationService,
    },
    {
      provide: EVENT_RANKER_SERVICE,
      useClass: EventRankerService,
    },
    {
      provide: MAINTENANCE_CYCLE_SERVICE,
      useClass: MaintenanceCycleService,
    },

    // Learning jobs (registered via JobRegistry, internal)
    TemporalPatternJob,
    ProcedureFormationJob,
    CorrectionProcessingJob,
    SentenceProcessingJob,
    PatternGeneralizationJob,

    // Metrics and health (internal)
    {
      provide: PROVENANCE_HEALTH_SERVICE,
      useClass: ProvenanceHealthService,
    },
    {
      provide: LEARNING_METRICS_SERVICE,
      useClass: LearningMetricsService,
    },
  ],
  exports: [
    // Public API: main orchestrator + job registry
    LEARNING_SERVICE,
    LEARNING_JOB_REGISTRY,
  ],
})
export class LearningModule {}

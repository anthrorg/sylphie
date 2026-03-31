/**
 * DecisionMakingModule — NestJS module for Sylphie's central cognitive loop.
 *
 * CANON §Subsystem 1 (Decision Making): Orchestrates the full decision cycle:
 * input categorization, action retrieval, prediction generation, arbitration,
 * execution, observation, and episodic encoding. This module is the structural
 * owner of the Type 1 / Type 2 / SHRUG arbitration discipline.
 *
 * EXPORTED tokens (public API for other modules):
 *   DECISION_MAKING_SERVICE — IDecisionMakingService, the sole entry point
 *                             for triggering the cognitive loop and reading
 *                             cognitive context.
 *
 * NOT EXPORTED (internal only):
 *   EPISODIC_MEMORY_SERVICE        — In-process episode store
 *   ARBITRATION_SERVICE            — Type 1/2/SHRUG arbitration
 *   PREDICTION_SERVICE             — Drive-effect prediction and evaluation
 *   ACTION_RETRIEVER_SERVICE       — WKG candidate retrieval
 *   CONFIDENCE_UPDATER_SERVICE     — ACT-R confidence updates and graduation
 *   EXECUTOR_ENGINE                — Cognitive loop state machine
 *   CONSOLIDATION_SERVICE          — Mature episode consolidation
 *   PROCESS_INPUT_SERVICE          — Input categorization and context building
 *   THRESHOLD_COMPUTATION_SERVICE  — Dynamic action threshold computation
 *   DECISION_EVENT_LOGGER          — TimescaleDB event logging and batching
 *   ACTION_HANDLER_REGISTRY        — Action step execution dispatch
 *   SHRUGGABLE_ACTION_SERVICE      — Shrug imperative enforcement
 *   TYPE_1_TRACKER_SERVICE         — Type 1 graduation/demotion tracking
 *   ATTRACTOR_MONITOR_SERVICE      — Attractor state monitoring (future)
 *
 * Internal tokens are intentionally absent from the barrel export. No other
 * module should ever depend on the sub-services directly — they are
 * implementation details of the decision cycle.
 *
 * CANON §Drive Isolation: DriveEngineModule is imported read-only. This module
 * never writes to the Drive Engine; it reads drive state via DRIVE_STATE_READER
 * and reports outcomes via ACTION_OUTCOME_REPORTER.
 *
 * CANON §Events Integration: EventsModule is imported for TimescaleDB logging
 * of all decision-making events.
 */

import { Module } from '@nestjs/common';
import {
  DECISION_MAKING_SERVICE,
  EPISODIC_MEMORY_SERVICE,
  ARBITRATION_SERVICE,
  PREDICTION_SERVICE,
  ACTION_RETRIEVER_SERVICE,
  CONFIDENCE_UPDATER_SERVICE,
  EXECUTOR_ENGINE,
  CONSOLIDATION_SERVICE,
  PROCESS_INPUT_SERVICE,
  THRESHOLD_COMPUTATION_SERVICE,
  DECISION_EVENT_LOGGER,
  ACTION_HANDLER_REGISTRY,
  SHRUGGABLE_ACTION_SERVICE,
  TYPE_1_TRACKER_SERVICE,
} from './decision-making.tokens';
import { DecisionMakingService } from './decision-making.service';
import { EpisodicMemoryService } from './episodic-memory/episodic-memory.service';
import { ArbitrationService } from './arbitration/arbitration.service';
import { PredictionService } from './prediction/prediction.service';
import { ActionRetrieverService } from './action-retrieval/action-retriever.service';
import { ConfidenceUpdaterService } from './confidence/confidence-updater.service';
import { ExecutorEngineService } from './executor/executor-engine.service';
import { ConsolidationService } from './episodic-memory/consolidation.service';
import { ProcessInputService } from './process-input/process-input.service';
import { ThresholdComputationService } from './threshold/threshold-computation.service';
import { DecisionEventLoggerService } from './logging/decision-event-logger.service';
import { ActionHandlerRegistry } from './action-handlers/action-handler-registry.service';
import { ShruggableActionService } from './shrug/shrug-imperative.service';
import { Type1TrackerService } from './graduation/type1-tracker.service';
import { DriveEngineModule } from '../drive-engine/drive-engine.module';
import { EventsModule } from '../events/events.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
  imports: [
    DriveEngineModule, // Provides DRIVE_STATE_READER (read-only facade)
    EventsModule, // Provides EVENTS_SERVICE for TimescaleDB logging
    KnowledgeModule, // Provides WKG_SERVICE for ActionRetrieverService
  ],
  providers: [
    // Main facade
    {
      provide: DECISION_MAKING_SERVICE,
      useClass: DecisionMakingService,
    },
    // Episodic memory
    {
      provide: EPISODIC_MEMORY_SERVICE,
      useClass: EpisodicMemoryService,
    },
    {
      provide: CONSOLIDATION_SERVICE,
      useClass: ConsolidationService,
    },
    // Arbitration and prediction
    {
      provide: ARBITRATION_SERVICE,
      useClass: ArbitrationService,
    },
    {
      provide: PREDICTION_SERVICE,
      useClass: PredictionService,
    },
    // Action retrieval
    {
      provide: ACTION_RETRIEVER_SERVICE,
      useClass: ActionRetrieverService,
    },
    // Confidence and graduation
    {
      provide: CONFIDENCE_UPDATER_SERVICE,
      useClass: ConfidenceUpdaterService,
    },
    {
      provide: TYPE_1_TRACKER_SERVICE,
      useClass: Type1TrackerService,
    },
    // Executor and state machine
    {
      provide: EXECUTOR_ENGINE,
      useClass: ExecutorEngineService,
    },
    // Processing and computation
    {
      provide: PROCESS_INPUT_SERVICE,
      useClass: ProcessInputService,
    },
    {
      provide: THRESHOLD_COMPUTATION_SERVICE,
      useClass: ThresholdComputationService,
    },
    // Logging and event handling
    {
      provide: DECISION_EVENT_LOGGER,
      useClass: DecisionEventLoggerService,
    },
    {
      provide: ACTION_HANDLER_REGISTRY,
      useClass: ActionHandlerRegistry,
    },
    // Arbitration enforcement
    {
      provide: SHRUGGABLE_ACTION_SERVICE,
      useClass: ShruggableActionService,
    },
  ],
  exports: [
    // Public API: only the main facade token
    DECISION_MAKING_SERVICE,
    // All internal tokens are intentionally NOT exported
  ],
})
export class DecisionMakingModule {}

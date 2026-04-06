/**
 * DecisionMakingModule — NestJS module for Sylphie's cognitive decision loop.
 *
 * CANON §Subsystem 1 (Decision Making): The central cognitive loop. Receives
 * SensoryFrames from the multimodal pipeline, runs the 8-state FSM (IDLE ->
 * CATEGORIZING -> RETRIEVING -> PREDICTING -> ARBITRATING -> EXECUTING ->
 * OBSERVING -> LEARNING -> IDLE), and emits episodes to episodic memory.
 *
 * PUBLIC API (exported from index.ts):
 *   DECISION_MAKING_SERVICE — IDecisionMakingService, the sole external facade.
 *
 * Also exports the sensory pipeline services because app-level gateways and
 * controllers wire into TickSamplerService, ModalityRegistryService, and the
 * individual encoders directly.
 *
 * INTERNAL providers (not exported from index.ts — all other tokens):
 *   EXECUTOR_ENGINE, EPISODIC_MEMORY_SERVICE, CONSOLIDATION_SERVICE,
 *   ARBITRATION_SERVICE, PREDICTION_SERVICE, ACTION_RETRIEVER_SERVICE,
 *   CONFIDENCE_UPDATER_SERVICE, THRESHOLD_COMPUTATION_SERVICE,
 *   ACTION_HANDLER_REGISTRY, PROCESS_INPUT_SERVICE, DECISION_EVENT_LOGGER,
 *   SHRUGGABLE_ACTION_SERVICE, TYPE_1_TRACKER_SERVICE,
 *   ATTRACTOR_MONITOR_SERVICE, CONTRADICTION_SCANNER
 *
 * CANON §Drive Isolation: DriveEngineModule is imported so that DRIVE_STATE_READER
 * and ACTION_OUTCOME_REPORTER tokens are resolvable. No subsystem module may
 * write to the Drive Engine's evaluation function through this import.
 *
 * CANON §No Circular Module Dependencies: This module imports DriveEngineModule
 * only. It does not import CommunicationModule, LearningModule, or PlanningModule.
 * Cross-subsystem communication flows through the TimescaleDB event backbone and
 * the WKG — not through direct service injection.
 */

import { Module } from '@nestjs/common';
import { DriveEngineModule } from '@sylphie/drive-engine';
import { LLM_SERVICE, TimescaleModule } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Injection tokens
// ---------------------------------------------------------------------------

import {
  EXECUTOR_ENGINE,
  EPISODIC_MEMORY_SERVICE,
  CONSOLIDATION_SERVICE,
  ARBITRATION_SERVICE,
  PREDICTION_SERVICE,
  ACTION_RETRIEVER_SERVICE,
  CONFIDENCE_UPDATER_SERVICE,
  THRESHOLD_COMPUTATION_SERVICE,
  ACTION_HANDLER_REGISTRY,
  PROCESS_INPUT_SERVICE,
  DECISION_EVENT_LOGGER,
  SHRUGGABLE_ACTION_SERVICE,
  TYPE_1_TRACKER_SERVICE,
  ATTRACTOR_MONITOR_SERVICE,
  CONTRADICTION_SCANNER,
  DECISION_MAKING_SERVICE,
} from './decision-making.tokens';

// ---------------------------------------------------------------------------
// Concrete service implementations
// ---------------------------------------------------------------------------

import { ExecutorEngineService } from './executor/executor-engine.service';
import { EpisodicMemoryService } from './episodic-memory/episodic-memory.service';
import { ConsolidationService } from './episodic-memory/consolidation.service';
import { ArbitrationService } from './arbitration/arbitration.service';
import { PredictionService } from './prediction/prediction.service';
import { ActionRetrieverService } from './action-retrieval/action-retriever.service';
import { ConfidenceUpdaterService } from './confidence/confidence-updater.service';
import { ThresholdComputationService } from './threshold/threshold-computation.service';
import { ActionHandlerRegistryService } from './action-handlers/action-handler-registry.service';
import { ProcessInputService } from './process-input/process-input.service';
import { DecisionEventLoggerService } from './logging/decision-event-logger.service';
import { ShrugImperativeService } from './shrug/shrug-imperative.service';
import { Type1TrackerService } from './graduation/type1-tracker.service';
import { AttractorMonitorService } from './monitoring/attractor-monitor.service';
import { ContradictionScannerService } from './arbitration/contradiction-scanner.service';
import { DecisionMakingService } from './decision-making.service';
import { OllamaLlmService } from './llm/ollama-llm.service';
import { SensoryStreamLoggerService } from './logging/sensory-stream-logger.service';
import { WkgContextService } from './wkg/wkg-context.service';
import { LatentSpaceService } from './latent-space/latent-space.service';
import { DeliberationService } from './deliberation/deliberation.service';
import { ToolRegistryService } from './deliberation/tools/tool-registry';

// ---------------------------------------------------------------------------
// Sensory pipeline services
// ---------------------------------------------------------------------------

import { ModalityRegistryService } from './inputs/registry/modality-registry.service';
import { TextEncoder } from './inputs/encoders/text.encoder';
import { VideoEncoder } from './inputs/encoders/video.encoder';
import { DriveEncoder } from './inputs/encoders/drive.encoder';
import { AudioEncoder } from './inputs/encoders/audio.encoder';
import { SensoryFusionService } from './inputs/fusion/sensory-fusion';
import { TickSamplerService } from './inputs/sampling/tick-sampler';

@Module({
  imports: [
    // Drive Engine provides DRIVE_STATE_READER and ACTION_OUTCOME_REPORTER tokens.
    // CANON §Drive Isolation: this import gives read-only access to drive state;
    // no subsystem may write to the evaluation function through this boundary.
    DriveEngineModule,
    // TimescaleModule is @Global() but explicit import ensures DI resolution
    // order is correct for services that inject it via @Optional().
    TimescaleModule,
  ],
  providers: [
    // ── Token-bound cognitive loop services ─────────────────────────────────

    {
      provide: EXECUTOR_ENGINE,
      useClass: ExecutorEngineService,
    },
    {
      provide: EPISODIC_MEMORY_SERVICE,
      useClass: EpisodicMemoryService,
    },
    {
      provide: CONSOLIDATION_SERVICE,
      useClass: ConsolidationService,
    },
    {
      provide: ARBITRATION_SERVICE,
      useClass: ArbitrationService,
    },
    {
      provide: PREDICTION_SERVICE,
      useClass: PredictionService,
    },
    {
      provide: ACTION_RETRIEVER_SERVICE,
      useClass: ActionRetrieverService,
    },
    {
      provide: CONFIDENCE_UPDATER_SERVICE,
      useClass: ConfidenceUpdaterService,
    },
    {
      provide: THRESHOLD_COMPUTATION_SERVICE,
      useClass: ThresholdComputationService,
    },
    {
      provide: ACTION_HANDLER_REGISTRY,
      useClass: ActionHandlerRegistryService,
    },
    {
      provide: PROCESS_INPUT_SERVICE,
      useClass: ProcessInputService,
    },
    {
      provide: DECISION_EVENT_LOGGER,
      useClass: DecisionEventLoggerService,
    },
    {
      provide: SHRUGGABLE_ACTION_SERVICE,
      useClass: ShrugImperativeService,
    },
    {
      provide: TYPE_1_TRACKER_SERVICE,
      useClass: Type1TrackerService,
    },
    {
      provide: ATTRACTOR_MONITOR_SERVICE,
      useClass: AttractorMonitorService,
    },
    {
      provide: CONTRADICTION_SCANNER,
      useClass: ContradictionScannerService,
    },
    {
      provide: DECISION_MAKING_SERVICE,
      useClass: DecisionMakingService,
    },
    {
      provide: LLM_SERVICE,
      useClass: OllamaLlmService,
    },

    // ── WKG Context Service (central read/write interface to World Knowledge Graph)
    WkgContextService,

    // ── Latent Space (fast pattern matching for Type 1 reflexes)
    LatentSpaceService,

    // ── Deliberation Pipeline (multi-step Type 2 reasoning)
    DeliberationService,
    ToolRegistryService,

    // ── Stream logging (persists encoded frames to TimescaleDB + pgvector) ────
    SensoryStreamLoggerService,

    // ── Sensory pipeline services (registered by class, no token indirection) ─
    // These are exported directly so that app-level code (gateways, controllers)
    // can inject them by class reference without importing this module's tokens.

    ModalityRegistryService,
    TextEncoder,
    VideoEncoder,
    DriveEncoder,
    AudioEncoder,
    SensoryFusionService,
    TickSamplerService,
  ],
  exports: [
    // Public tokens and services.
    DECISION_MAKING_SERVICE,
    LLM_SERVICE,
    WkgContextService,

    // Sensory pipeline services: exported so that app-level gateways and
    // controllers can inject TickSamplerService, ModalityRegistryService,
    // and the individual encoders without re-providing them.
    ModalityRegistryService,
    TextEncoder,
    VideoEncoder,
    DriveEncoder,
    AudioEncoder,
    SensoryFusionService,
    TickSamplerService,
  ],
})
export class DecisionMakingModule {}

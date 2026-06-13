// ---------------------------------------------------------------------------
// Decision Making Module (public API)
// ---------------------------------------------------------------------------

/** The NestJS module — import this in AppModule. */
export { DecisionMakingModule } from './decision-making.module';

/**
 * InboundTurn — the queue entry type for per-turn text threading (WS4 Ticket 2).
 * Exported so CommunicationService (in apps/sylphie) can construct and enqueue
 * turns via IDecisionMakingService.enqueueTurn().
 */
export type { InboundTurn } from './concurrency/inbound-turn';

/**
 * WS4 Ticket 6 — CycleGuardService and queue-position types.
 * Exported so CommunicationService can inject CycleGuardService and subscribe
 * to queuePositionUpdates$ to relay queue-position notifications to waiting speakers.
 */
export { CycleGuardService } from './concurrency/cycle-guard.service';
export type { QueuePositionSnapshot } from './concurrency/cycle-guard.service';

/** The sole public injection token for this subsystem. */
export { DECISION_MAKING_SERVICE } from './decision-making.tokens';

/**
 * Arbitration metrics token and concrete class.
 * Exported so MetricsController can inject ArbitrationService directly to read
 * accumulated Type 1 / Type 2 / SHRUG counts for the CANON health metric.
 * The token is an alias to the module-internal ARBITRATION_SERVICE symbol.
 */
export { ARBITRATION_SERVICE } from './decision-making.tokens';
export { ArbitrationService } from './arbitration/arbitration.service';
export type { ArbitrationMetrics } from './arbitration/arbitration.service';

/**
 * Attractor monitor token and concrete class.
 * Exported so MetricsController can inject AttractorMonitorService to read the
 * rolling prediction window for PredictionMAEMetric.
 */
export { ATTRACTOR_MONITOR_SERVICE } from './decision-making.tokens';
export { AttractorMonitorService } from './monitoring/attractor-monitor.service';
export type { DetectorResult } from './monitoring/attractor-monitor.service';

/**
 * Mood-bleed monitor token and concrete class.
 * WS4 Ticket 8 — Hostile-Interlocutor Mood-Bleed Attractor Alert.
 * Exported so external consumers can inject and interrogate via getStatus().
 */
export { MOOD_BLEED_MONITOR_SERVICE } from './decision-making.tokens';
export { MoodBleedMonitorService } from './monitoring/mood-bleed-monitor.service';

/** Public interface types for consumers. */
export type { IDecisionMakingService, ITensorInferenceService, TensorInferenceResult, PanelContext } from './interfaces/decision-making.interfaces';

/** Tensor inference — externally provided by @Global() CognitionModule. */
export { TENSOR_INFERENCE_SERVICE } from './decision-making.tokens';

/** Latent space — exported for system reset. */
export { LatentSpaceService } from './latent-space/latent-space.service';
export type { LatentMatch, MultiModalLatentMatch } from './latent-space/latent-space.service';

/** Sensory prediction — exported for system reset. */
export { SensoryPredictionService } from './prediction/sensory-prediction.service';

/** Episodic memory — exported for system reset. */
export { EPISODIC_MEMORY_SERVICE } from './decision-making.tokens';
export type { IEpisodicMemoryService } from './interfaces/decision-making.interfaces';

/** Scene prediction — per-object prediction errors for attention and drive routing. */
export { ScenePredictionService, type ScenePredictionResult, type SceneObjectError } from './prediction/scene-prediction.service';

// ---------------------------------------------------------------------------
// Sensory Pipeline (re-exported for backward compatibility)
// ---------------------------------------------------------------------------

export { ModalityRegistryService } from './inputs/registry/modality-registry.service';
export { TextEncoder, isDocumentEncoder } from './inputs/encoders/text.encoder';
export { VideoEncoder } from './inputs/encoders/video.encoder';
export { FaceEncoder } from './inputs/encoders/face.encoder';
export { DriveEncoder } from './inputs/encoders/drive.encoder';
export { AudioEncoder, type AudioChunk } from './inputs/encoders/audio.encoder';
export { SceneEncoder } from './inputs/encoders/scene.encoder';
export { SensoryFusionService } from './inputs/fusion/sensory-fusion';
export { TickSamplerService } from './inputs/sampling/tick-sampler';

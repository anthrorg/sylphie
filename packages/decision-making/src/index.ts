// ---------------------------------------------------------------------------
// Decision Making Module (public API)
// ---------------------------------------------------------------------------

/** The NestJS module — import this in AppModule. */
export { DecisionMakingModule } from './decision-making.module';

/** The sole public injection token for this subsystem. */
export { DECISION_MAKING_SERVICE } from './decision-making.tokens';

/** Public interface types for consumers. */
export type { IDecisionMakingService } from './interfaces/decision-making.interfaces';

// ---------------------------------------------------------------------------
// Sensory Pipeline (re-exported for backward compatibility)
// ---------------------------------------------------------------------------

export { ModalityRegistryService } from './inputs/registry/modality-registry.service';
export { TextEncoder } from './inputs/encoders/text.encoder';
export { VideoEncoder } from './inputs/encoders/video.encoder';
export { DriveEncoder } from './inputs/encoders/drive.encoder';
export { AudioEncoder, type AudioChunk } from './inputs/encoders/audio.encoder';
export { SensoryFusionService } from './inputs/fusion/sensory-fusion';
export { TickSamplerService } from './inputs/sampling/tick-sampler';

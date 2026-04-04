// Inputs — sensory pipeline
export { TextEncoder } from './inputs/encoders/text.encoder';
export { VideoEncoder } from './inputs/encoders/video.encoder';
export { DriveEncoder } from './inputs/encoders/drive.encoder';
export { SensoryFusionService } from './inputs/fusion/sensory-fusion';
export { TickSamplerService } from './inputs/sampling/tick-sampler';
export { ModalityRegistryService } from './inputs/registry/modality-registry.service';

// Executor — main decision loop
export { ExecutorEngine } from './executor/executor-engine';

// Monologue
export {
  InnerMonologueService,
  type MonologueOutput,
} from './monologue/inner-monologue';

// Prediction
export {
  MakePredictionService,
  type Prediction,
} from './prediction/make-prediction';

// Reasoning
export { Type1Handler, type ActionCandidate } from './reasoning/type-1.handler';
export { Type2Handler } from './reasoning/type-2.handler';
export { ReasoningEngine } from './reasoning/reasoning-engine';

// Action
export { MakesChoiceService, type TickEvent } from './action/makes-choice';
export { SystemReactsService } from './action/system-reacts';

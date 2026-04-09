// Sensory pipeline types
export {
  EMBEDDING_DIM,
  type VideoDetection,
  type FaceDetection,
  type SensoryFrame,
  type ModalityType,
} from './sensory-frame';
export { type ModalityEncoder } from './modality-encoder.interface';

// Drive system types
export {
  DriveName,
  DRIVE_INDEX_ORDER,
  DRIVE_RANGE,
  CORE_DRIVES,
  COMPLEMENT_DRIVES,
  INITIAL_DRIVE_STATE,
  clampDriveValue,
  computeTotalPressure,
  type PressureVector,
  type PressureDelta,
  type RuleMatchResult,
  type DriveSnapshot,
} from './drive.types';

// IPC types (Drive Engine isolation boundary)
export {
  DriveIPCMessageType,
  type DriveIPCMessage,
  type ActionOutcomePayload,
  type SoftwareMetricsPayload,
  type SessionStartPayload,
  type SessionEndPayload,
  type DriveSnapshotPayload,
  type OpportunityCreatedPayload,
  type DriveEventPayload,
  type HealthStatusPayload,
  type OpportunityPriority,
  type OpportunityClassification,
} from './ipc.types';

// Provenance types
export {
  type CoreProvenanceSource,
  type ExtendedProvenanceSource,
  type ProvenanceSource,
  PROVENANCE_BASE_CONFIDENCE,
  resolveBaseConfidence,
} from './provenance.types';

// Event types
export * from './event.types';

// Action types
export * from './action.types';

// Decision-making types
export {
  type EncodingDepth,
  type EpisodeInput,
  type Episode,
  type Prediction,
  type PredictionEvaluation,
  type GapType,
  type ShrugDetail,
  type ContradictionScanResult,
  type ContradictionEntry,
  type ThresholdResult,
  type CognitiveContext,
  type ConsolidationCandidate,
  type SemanticRelationship,
  type SemanticConversion,
  type ConsolidationResult,
  type GraduationState,
  type GraduationRecord,
} from './decision-making.types';

// Communication types
export {
  type CycleResponse,
  type InputParseResult,
  type DeliveryPayload,
  type KnowledgeGrounding,
} from './communication.types';

// Confidence types
export {
  CONFIDENCE_THRESHOLDS,
  DEFAULT_DECAY_RATES,
  computeConfidence,
  applyGuardianWeight,
  qualifiesForGraduation,
  qualifiesForDemotion,
  type ACTRParams,
} from './confidence.types';

// Metrics types
export * from './metrics.types';

// Scene types (per-object tracking + scene events)
export {
  SceneEventType,
  type TrackedObjectDTO,
  type SceneEvent,
  type SceneSummary,
  type SceneSnapshot,
} from './scene.types';

// Working memory types
export {
  type WorkingMemorySourceType,
  type WorkingMemoryItem,
  type WorkingMemorySnapshot,
} from './working-memory.types';

// LLM types
export {
  LLM_SERVICE,
  type LlmTier,
  type LlmMessage,
  type LlmRequest,
  type LlmCallMetadata,
  type LlmResponse,
  type EpisodeSummary,
  type WkgContextEntry,
  type PersonModelSummary,
  type LlmContext,
  type Type2CostEstimate,
  type ILlmService,
} from './llm.types';

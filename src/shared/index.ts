/**
 * Shared module public API — barrel re-export of all types, config, and exceptions.
 *
 * Subsystems import from 'src/shared' (or relative equivalents) rather than
 * from individual internal paths. This barrel is the contract boundary.
 *
 * Sections:
 *   1. Config — registerAs() factories and config interfaces
 *   2. Exceptions — SylphieException hierarchy
 *   3. Types — all shared TypeScript types and constants
 *   4. Module — SharedModule for AppModule wiring
 */

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------

export {
  appConfig,
  type AppConfig,
  type AppSectionConfig,
  type Neo4jConfig,
  type TimescaleConfig,
  type PostgresConfig,
  type GrafeoConfig,
  type LlmConfig,
} from './config/app.config';

export { type DatabaseConfig } from './config/database.config';

// ---------------------------------------------------------------------------
// 2. Exceptions
// ---------------------------------------------------------------------------

export { SylphieException } from './exceptions/sylphie.exception';

export {
  KnowledgeException,
  DriveException,
  CommunicationException,
  LearningException,
  PlanningException,
  DecisionMakingException,
} from './exceptions/domain.exceptions';

export {
  ProvenanceMissingError,
  ConfidenceCeilingViolation,
  ContradictionDetectedError,
  DriveUnavailableError,
} from './exceptions/specific.exceptions';

// ---------------------------------------------------------------------------
// 3. Types
// ---------------------------------------------------------------------------

// Provenance
export {
  type CoreProvenanceSource,
  type ExtendedProvenanceSource,
  type ProvenanceSource,
  PROVENANCE_BASE_CONFIDENCE,
  resolveBaseConfidence,
} from './types/provenance.types';

// Confidence dynamics
export {
  type ACTRParams,
  CONFIDENCE_THRESHOLDS,
  DEFAULT_DECAY_RATES,
  computeConfidence,
  applyGuardianWeight,
  qualifiesForGraduation,
  qualifiesForDemotion,
} from './types/confidence.types';

// Drive system
export {
  DriveName,
  DRIVE_INDEX_ORDER,
  DRIVE_RANGE,
  clampDriveValue,
  type PressureVector,
  type PressureDelta,
  type RuleMatchResult,
  type DriveSnapshot,
  INITIAL_DRIVE_STATE,
  CORE_DRIVES,
  COMPLEMENT_DRIVES,
  computeTotalPressure,
} from './types/drive.types';

// Events
export {
  type SubsystemSource,
  type EventType,
  EVENT_BOUNDARY_MAP,
  type SylphieEvent,
  type GuardianFeedbackType,
  type LearnableEvent,
  type ReinforcementEvent,
  type GuardianConfirmationEvent,
  type GuardianCorrectionEvent,
  type ActionExecutedEvent,
  type PredictionEvaluatedEvent,
} from './types/event.types';

// Knowledge graph
export {
  type NodeLevel,
  type KnowledgeNode,
  type KnowledgeEdge,
  type NodeFilter,
  type EdgeFilter,
  type ConflictType,
  type NodeUpsertResult,
  type EdgeUpsertResult,
  type UpsertResult,
  type NodeUpsertRequest,
  type EdgeUpsertRequest,
} from './types/knowledge.types';

// Action system
export {
  type DriveCategory,
  type ActionProcedureData,
  type ActionStep,
  type ActionCandidate,
  type ArbitrationResult,
  type SelectedAction,
  ExecutorState,
  type ActionOutcome,
} from './types/action.types';

// IPC (Drive Engine boundary)
export {
  DriveIPCMessageType,
  type DriveIPCMessage,
  type ActionOutcomePayload,
  type SoftwareMetricsPayload,
  type SessionStartPayload,
  type SessionEndPayload,
  type DriveSnapshotPayload,
  type OpportunityPriority,
  type OpportunityClassification,
  type OpportunityCreatedPayload,
  type DriveEventPayload,
  type HealthStatusPayload,
} from './types/ipc.types';

// LLM
export {
  LLM_SERVICE,
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
} from './types/llm.types';

// Health metrics
export {
  type Type1Type2Ratio,
  type PredictionMAEMetric,
  type ProvenanceRatio,
  type BehavioralDiversityIndex,
  type GuardianResponseRate,
  type InteroceptiveAccuracy,
  type MeanDriveResolutionTime,
  type HealthMetrics,
} from './types/metrics.types';

// ---------------------------------------------------------------------------
// 4. Module
// ---------------------------------------------------------------------------

export { SharedModule } from './shared.module';

/**
 * Barrel export for all Web module DTOs.
 *
 * Centralizes all DTO imports for convenience and clarity.
 */

// Health DTOs
export type { HealthCheckResult, HealthCheckResponse } from './health.dto';

// Drive DTOs
export type {
  DriveValueDto,
  DriveSnapshotDto,
  DriveStateResponse,
  DriveHistoryPoint,
  DriveHistoryResponse,
} from './drive.dto';

// Graph DTOs
export type {
  GraphNodeDto,
  GraphEdgeDto,
  GraphSnapshotResponse,
  GraphStatsResponse,
  GraphQueryParams,
} from './graph.dto';

// Conversation DTOs
export type {
  TheaterViolationDto,
  TheaterCheckDto,
  ConversationMessage,
  ConversationHistoryResponse,
} from './conversation.dto';

// Metrics DTOs
export type { MetricHistoryPoint, MetricValue, MetricsResponse } from './metrics.dto';

// Voice DTOs
export type {
  VoiceTranscriptionResponse,
  VoiceSynthesisResponse,
} from './voice.dto';

// Person Model DTOs
export type { PersonModelSummaryResponse } from './person-model.dto';

// Skills DTOs
export type {
  SkillDto,
  ConceptUploadRequest,
  SkillListResponse,
  SkillUploadResponse,
} from './skills.dto';

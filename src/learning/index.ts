/**
 * Learning module public API — barrel re-export.
 *
 * Consumers import from 'src/learning' (or a relative equivalent) rather than
 * from internal file paths. This barrel is the contract boundary. Internal
 * implementation files (concrete service classes) are not part of the public API.
 *
 * Usage:
 *   import { LearningModule, LEARNING_SERVICE } from '../learning';
 *   import type { ILearningService, MaintenanceCycleResult } from '../learning';
 *
 * Sections:
 *   1. Module      — LearningModule for AppModule wiring
 *   2. Tokens      — DI injection tokens (only LEARNING_SERVICE is exported;
 *                    pipeline-internal tokens are module-private)
 *   3. Interfaces  — All Learning subsystem interface contracts and types
 */

// ---------------------------------------------------------------------------
// 1. Module
// ---------------------------------------------------------------------------

export { LearningModule } from './learning.module';

// ---------------------------------------------------------------------------
// 2. Tokens
// ---------------------------------------------------------------------------

// Public tokens exported from LearningModule. Internal pipeline tokens
// (ENTITY_EXTRACTION_SERVICE, EDGE_REFINEMENT_SERVICE, CONTRADICTION_DETECTOR,
// CONSOLIDATION_SERVICE, etc.) are intentionally omitted — they are private
// to LearningModule and should not be injected by any external module.
export { LEARNING_SERVICE, LEARNING_JOB_REGISTRY } from './learning.tokens';

// ---------------------------------------------------------------------------
// 3. Interfaces and Types
// ---------------------------------------------------------------------------

export type {
  // Original result types
  MaintenanceCycleResult,
  ExtractedEntity,
  EntityResolution,
  RefinedEdge,
  ContradictionCheckResult,
  // New supporting types
  ExtractedEdge,
  Contradiction,
  ContradictionType,
  ContradictionResolution,
  JobResult,
  LearningCycleMetrics,
  ProvenanceHealth,
  SalienceScore,
  ConsolidationResult,
  ConsolidationBatch,
  // Original service interfaces
  ILearningService,
  IEntityExtractionService,
  IEdgeRefinementService,
  IContradictionDetector,
  // New service interfaces
  ILearningJob,
  IConsolidationService,
  IEventRankerService,
  IMaintenanceCycleService,
} from './interfaces/learning.interfaces';

/**
 * Injection tokens for the Learning module.
 *
 * All tokens are Symbols to prevent accidental collisions with tokens from
 * other modules. Consumers inject by referencing the token symbol:
 *
 *   @Inject(LEARNING_SERVICE) private readonly learning: ILearningService
 *
 * Token definitions are co-located here so that importing modules need only
 * reference learning.tokens.ts rather than any internal service file path.
 *
 * CANON §Module boundary: Consumers must import from the barrel (index.ts),
 * not from this file directly. This file is re-exported by the barrel.
 */

// ---------------------------------------------------------------------------
// Public Tokens (exported from module)
// ---------------------------------------------------------------------------

/**
 * DI token for ILearningService.
 * Provided by LearningModule, backed by LearningService.
 * The main public orchestrator for Learning subsystem.
 */
export const LEARNING_SERVICE = Symbol('LEARNING_SERVICE');

/**
 * DI token for ILearningJobRegistry.
 * Provided by LearningModule, backed by JobRegistryService.
 * Internal registry of learnable jobs (entity extraction, edge refinement, etc).
 */
export const LEARNING_JOB_REGISTRY = Symbol('LEARNING_JOB_REGISTRY');

// ---------------------------------------------------------------------------
// Internal Tokens (not exported from module boundary)
// ---------------------------------------------------------------------------

/**
 * DI token for IEntityExtractionService.
 * Provided by LearningModule, backed by EntityExtractionService.
 * Internal to LearningModule — not exported from the module boundary.
 */
export const ENTITY_EXTRACTION_SERVICE = Symbol('ENTITY_EXTRACTION_SERVICE');

/**
 * DI token for IEdgeRefinementService.
 * Provided by LearningModule, backed by EdgeRefinementService.
 * Internal to LearningModule — not exported from the module boundary.
 */
export const EDGE_REFINEMENT_SERVICE = Symbol('EDGE_REFINEMENT_SERVICE');

/**
 * DI token for IContradictionDetector.
 * Provided by LearningModule, backed by ContradictionDetectorService.
 * Internal to LearningModule — not exported from the module boundary.
 */
export const CONTRADICTION_DETECTOR = Symbol('CONTRADICTION_DETECTOR');

/**
 * DI token for IConsolidationService.
 * Provided by LearningModule, backed by ConsolidationService.
 * Internal to LearningModule — not exported from the module boundary.
 */
export const CONSOLIDATION_SERVICE = Symbol('CONSOLIDATION_SERVICE');

/**
 * DI token for IEventRankerService.
 * Provided by LearningModule, backed by EventRankerService.
 * Internal to LearningModule — not exported from the module boundary.
 */
export const EVENT_RANKER_SERVICE = Symbol('EVENT_RANKER_SERVICE');

/**
 * DI token for IMaintenanceCycleService.
 * Provided by LearningModule, backed by MaintenanceCycleService.
 * Internal to LearningModule — not exported from the module boundary.
 */
export const MAINTENANCE_CYCLE_SERVICE = Symbol('MAINTENANCE_CYCLE_SERVICE');

/**
 * DI token for IProvenanceHealthService.
 * Provided by LearningModule, backed by ProvenanceHealthService.
 * Internal to LearningModule — not exported from the module boundary.
 */
export const PROVENANCE_HEALTH_SERVICE = Symbol('PROVENANCE_HEALTH_SERVICE');

/**
 * DI token for ILearningMetricsService.
 * Provided by LearningModule, backed by LearningMetricsService.
 * Internal to LearningModule — not exported from the module boundary.
 */
export const LEARNING_METRICS_SERVICE = Symbol('LEARNING_METRICS_SERVICE');

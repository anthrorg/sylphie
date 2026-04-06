/**
 * NestJS injection tokens for the PlanningModule.
 *
 * EXPORTED tokens (public API -- re-exported from index.ts):
 *   PLANNING_SERVICE    -- IPlanningService, main facade
 *
 * INTERNAL tokens (NOT exported from index.ts):
 *   All pipeline step tokens are internal to PlanningModule only.
 *   No other module should ever inject them.
 */

/**
 * Injection token for IPlanningService.
 * The sole public API token for the Planning subsystem.
 * Re-exported from index.ts.
 */
export const PLANNING_SERVICE = Symbol('PLANNING_SERVICE');

/**
 * Injection token for OpportunityQueueService.
 * INTERNAL TO PlanningModule ONLY. Not exported from index.ts.
 *
 * In-memory priority queue with time-decay, deduplication, and rate limiting.
 * Opportunities decay exponentially and are dropped below threshold.
 */
export const OPPORTUNITY_QUEUE = Symbol('OPPORTUNITY_QUEUE');

/**
 * Injection token for ResearchService.
 * INTERNAL TO PlanningModule ONLY. Not exported from index.ts.
 *
 * Queries TimescaleDB for event frequency, related events, and drive impact
 * history relevant to a given opportunity.
 */
export const RESEARCH_SERVICE = Symbol('RESEARCH_SERVICE');

/**
 * Injection token for SimulationService.
 * INTERNAL TO PlanningModule ONLY. Not exported from index.ts.
 *
 * Estimates outcomes of potential behavioral changes by analyzing historical
 * action outcomes for similar contexts.
 */
export const SIMULATION_SERVICE = Symbol('SIMULATION_SERVICE');

/**
 * Injection token for ProposalService.
 * INTERNAL TO PlanningModule ONLY. Not exported from index.ts.
 *
 * Generates structured plan proposals (ActionStep arrays) from research and
 * simulation data, optionally using LLM assistance.
 */
export const PROPOSAL_SERVICE = Symbol('PROPOSAL_SERVICE');

/**
 * Injection token for ConstraintValidationService.
 * INTERNAL TO PlanningModule ONLY. Not exported from index.ts.
 *
 * Validates plan proposals against safety and coherence constraints using
 * the LLM constraint engine. Retries up to 3 times on failure.
 */
export const CONSTRAINT_VALIDATION_SERVICE = Symbol('CONSTRAINT_VALIDATION_SERVICE');

/**
 * Injection token for ProcedureCreationService.
 * INTERNAL TO PlanningModule ONLY. Not exported from index.ts.
 *
 * Writes validated plan proposals as ActionProcedure nodes to the Neo4j
 * World Knowledge Graph with INFERENCE provenance and base confidence 0.30.
 */
export const PROCEDURE_CREATION_SERVICE = Symbol('PROCEDURE_CREATION_SERVICE');

/**
 * Injection token for PlanEvaluationService.
 * INTERNAL TO PlanningModule ONLY. Not exported from index.ts.
 *
 * Post-execution evaluation of Planning-created procedures. Logs outcome
 * events but does not update confidence directly (that is Decision Making's
 * ConfidenceUpdaterService responsibility).
 */
export const PLAN_EVALUATION_SERVICE = Symbol('PLAN_EVALUATION_SERVICE');

/**
 * Injection token for PlanningEventLoggerService.
 * INTERNAL TO PlanningModule ONLY. Not exported from index.ts.
 *
 * Fire-and-forget event logger that writes PLANNING subsystem events to
 * TimescaleDB. All pipeline steps use this for observability.
 */
export const PLANNING_EVENT_LOGGER = Symbol('PLANNING_EVENT_LOGGER');

/**
 * Injection tokens for PlanningModule.
 *
 * Every service in PlanningModule is provided and consumed via a Symbol token.
 * Consumers inject by token, never by concrete class, so the implementation
 * is decoupled from the injection site.
 *
 * PLANNING_SERVICE is the only token exported from the module barrel (index.ts).
 * All other tokens are internal to PlanningModule — no external module should
 * inject the pipeline services directly.
 */

/** Public facade token. Provided to other modules via PlanningModule's exports. */
export const PLANNING_SERVICE = Symbol('PLANNING_SERVICE');

/** Internal: OpportunityResearchService token. */
export const OPPORTUNITY_RESEARCH_SERVICE = Symbol('OPPORTUNITY_RESEARCH_SERVICE');

/** Internal: SimulationService token. */
export const SIMULATION_SERVICE = Symbol('SIMULATION_SERVICE');

/** Internal: ConstraintValidationService token. */
export const CONSTRAINT_VALIDATION_SERVICE = Symbol('CONSTRAINT_VALIDATION_SERVICE');

/** Internal: ProcedureCreationService token. */
export const PROCEDURE_CREATION_SERVICE = Symbol('PROCEDURE_CREATION_SERVICE');

/** Internal: PlanningRateLimiterService token. */
export const PLANNING_RATE_LIMITER = Symbol('PLANNING_RATE_LIMITER');

/** Internal: OpportunityQueueService token. */
export const OPPORTUNITY_QUEUE = Symbol('OPPORTUNITY_QUEUE');

/** Internal: PlanProposalService token. */
export const PLAN_PROPOSAL_SERVICE = Symbol('PLAN_PROPOSAL_SERVICE');

/** Internal: PlanEvaluationService token. */
export const PLAN_EVALUATION_SERVICE = Symbol('PLAN_EVALUATION_SERVICE');

/** Internal: PlanningPipelineService (orchestrator) token. */
export const PLANNING_PIPELINE_SERVICE = Symbol('PLANNING_PIPELINE_SERVICE');

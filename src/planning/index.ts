/**
 * Public API barrel for PlanningModule.
 *
 * Other modules import exclusively from this barrel, never from internal
 * file paths. What is listed here is the contract; everything else is an
 * implementation detail.
 *
 * EXPORTED:
 *   PlanningModule          — NestJS module for DI registration
 *   PLANNING_SERVICE        — Injection token for IPlanningService
 *   IPlanningService        — Primary planning facade interface
 *   PlanningResult          — Discriminated union result of processOpportunity
 *   QueuedOpportunity       — Entry in the planning priority queue
 *   PlanningState           — Subsystem operational state summary
 *   PlanningException       — Base exception class (and specialized subtypes)
 *
 * NOT EXPORTED (internal to PlanningModule):
 *   OPPORTUNITY_RESEARCH_SERVICE   — Internal pipeline token
 *   SIMULATION_SERVICE             — Internal pipeline token
 *   CONSTRAINT_VALIDATION_SERVICE  — Internal pipeline token
 *   PROCEDURE_CREATION_SERVICE     — Internal pipeline token
 *   PLANNING_RATE_LIMITER          — Internal pipeline token
 *   OPPORTUNITY_QUEUE              — Internal queue token
 *   PLAN_PROPOSAL_SERVICE          — Internal proposal token
 *   PLAN_EVALUATION_SERVICE        — Internal evaluation token
 *   PLANNING_PIPELINE_SERVICE      — Internal pipeline orchestrator token
 *   IOpportunityResearchService    — Internal interface
 *   ISimulationService             — Internal interface
 *   IConstraintValidationService   — Internal interface
 *   IProcedureCreationService      — Internal interface
 *   IPlanningRateLimiter           — Internal interface
 *   ResearchResult                 — Internal pipeline type
 *   SimulationResult               — Internal pipeline type
 *   SimulatedOutcome               — Internal pipeline type
 *   PlanProposal                   — Internal pipeline type
 *   ValidationResult               — Internal pipeline type
 *   ConstraintFailure              — Internal pipeline type
 *   CreatedProcedure               — Internal pipeline type
 *   RateLimiterState               — Internal pipeline type
 *   Concrete service classes       — Implementation details
 */

export { PlanningModule } from './planning.module';

export { PLANNING_SERVICE } from './planning.tokens';

export type { IPlanningService, PlanningResult, QueuedOpportunity, PlanningState } from './interfaces/planning.interfaces';

export {
  PlanningException,
  InsufficientEvidenceError,
  NoViableOutcomeError,
  ValidationFailedError,
  RateLimitExceededError,
  QueueFullError,
  PipelineStageError,
} from './exceptions';

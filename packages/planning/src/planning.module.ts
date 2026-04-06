/**
 * PlanningModule -- NestJS module for Sylphie's Planning subsystem.
 *
 * CANON SS Subsystem 5 (Planning): Converts Opportunities detected by the Drive
 * Engine into new behavioral procedures (ActionProcedure nodes in the WKG)
 * through a research -> simulation -> proposal -> validation -> creation pipeline.
 *
 * PUBLIC API (exported from index.ts):
 *   PLANNING_SERVICE -- IPlanningService, the sole external facade.
 *
 * INTERNAL providers (not exported from index.ts):
 *   OPPORTUNITY_QUEUE, RESEARCH_SERVICE, SIMULATION_SERVICE, PROPOSAL_SERVICE,
 *   CONSTRAINT_VALIDATION_SERVICE, PROCEDURE_CREATION_SERVICE,
 *   PLAN_EVALUATION_SERVICE, PLANNING_EVENT_LOGGER
 *
 * Dependencies:
 *   - DecisionMakingModule: provides LLM_SERVICE (OllamaLlmService).
 *   - TimescaleModule: @Global() but explicitly imported for DI clarity.
 *
 * CANON SS No Circular Module Dependencies: PlanningModule only imports
 * DecisionMakingModule (which imports DriveEngineModule). It does not import
 * CommunicationModule or LearningModule. Opportunities arrive via the
 * TimescaleDB event backbone, not direct service injection.
 */

import { Module } from '@nestjs/common';
import { DecisionMakingModule } from '@sylphie/decision-making';
import { TimescaleModule } from '@sylphie/shared';

import {
  PLANNING_SERVICE,
  OPPORTUNITY_QUEUE,
  RESEARCH_SERVICE,
  SIMULATION_SERVICE,
  PROPOSAL_SERVICE,
  CONSTRAINT_VALIDATION_SERVICE,
  PROCEDURE_CREATION_SERVICE,
  PLAN_EVALUATION_SERVICE,
  PLANNING_EVENT_LOGGER,
} from './planning.tokens';

import { PlanningService } from './planning.service';
import { OpportunityQueueService } from './queue/opportunity-queue.service';
import { ResearchService } from './pipeline/research.service';
import { SimulationService } from './pipeline/simulation.service';
import { ProposalService } from './pipeline/proposal.service';
import { ConstraintValidationService } from './pipeline/constraint-validation.service';
import { ProcedureCreationService } from './pipeline/procedure-creation.service';
import { PlanEvaluationService } from './evaluation/plan-evaluation.service';
import { PlanningEventLoggerService } from './logging/planning-event-logger.service';

@Module({
  imports: [
    // DecisionMakingModule exports LLM_SERVICE. Importing this module gives
    // Planning access to the LLM without creating a direct dependency on the
    // concrete OllamaLlmService.
    DecisionMakingModule,
    // Explicit import even though TimescaleModule is @Global() -- ensures DI
    // resolution order is correct.
    TimescaleModule,
  ],
  providers: [
    // -- Public facade --------------------------------------------------------
    {
      provide: PLANNING_SERVICE,
      useClass: PlanningService,
    },

    // -- Opportunity queue (in-memory, with decay + rate limit) ---------------
    {
      provide: OPPORTUNITY_QUEUE,
      useClass: OpportunityQueueService,
    },

    // -- Pipeline step: Research (TimescaleDB queries) ------------------------
    {
      provide: RESEARCH_SERVICE,
      useClass: ResearchService,
    },

    // -- Pipeline step: Simulation (historical outcome analysis) ---------------
    {
      provide: SIMULATION_SERVICE,
      useClass: SimulationService,
    },

    // -- Pipeline step: Proposal generation (LLM-assisted) --------------------
    {
      provide: PROPOSAL_SERVICE,
      useClass: ProposalService,
    },

    // -- Pipeline step: Constraint validation (LLM, max 3 retries) ------------
    {
      provide: CONSTRAINT_VALIDATION_SERVICE,
      useClass: ConstraintValidationService,
    },

    // -- Pipeline step: Procedure creation (Neo4j WKG write) ------------------
    {
      provide: PROCEDURE_CREATION_SERVICE,
      useClass: ProcedureCreationService,
    },

    // -- Post-execution evaluation --------------------------------------------
    {
      provide: PLAN_EVALUATION_SERVICE,
      useClass: PlanEvaluationService,
    },

    // -- Event logger ---------------------------------------------------------
    {
      provide: PLANNING_EVENT_LOGGER,
      useClass: PlanningEventLoggerService,
    },
  ],
  exports: [
    // PLANNING_SERVICE is the only token exported from this module.
    // All pipeline step tokens are internal implementation details.
    PLANNING_SERVICE,
  ],
})
export class PlanningModule {}

/**
 * PlanningModule — NestJS module for Sylphie's Planning subsystem.
 *
 * CANON §Subsystem 5 (Planning): Triggered by Opportunities detected by the
 * Drive Engine. Researches failure patterns, simulates outcomes, validates
 * proposals via LLM constraint checking, and creates new procedure nodes in
 * the WKG with LLM_GENERATED provenance at confidence 0.35.
 *
 * EXPORTED tokens (public API for other modules):
 *   PLANNING_SERVICE — Planning facade (IPlanningService)
 *
 * NOT EXPORTED (internal pipeline services):
 *   OPPORTUNITY_RESEARCH_SERVICE — Querying TimescaleDB + WKG for evidence
 *   SIMULATION_SERVICE           — Candidate outcome modeling
 *   CONSTRAINT_VALIDATION_SERVICE— LLM-based CANON constraint checking
 *   PROCEDURE_CREATION_SERVICE   — WKG write of the validated procedure node
 *   PLANNING_RATE_LIMITER        — Per-window and active-plans caps
 *   OPPORTUNITY_QUEUE            — Priority queue with decay mechanics
 *   PLAN_PROPOSAL_SERVICE        — Proposal assembly and revision
 *   PLAN_EVALUATION_SERVICE      — Procedure execution evaluation
 *   PLANNING_PIPELINE_SERVICE    — 6-stage pipeline orchestration
 *
 * Import dependencies:
 *   DriveEngineModule — Provides DRIVE_STATE_READER for simulation
 *   EventsModule      — Provides EVENTS_SERVICE for TimescaleDB queries
 *   KnowledgeModule   — Provides KNOWLEDGE_SERVICE for WKG queries/writes
 *   CommunicationModule — Provides LLM_SERVICE for constraint validation
 *
 * CANON §Module boundary: Consumers import from the barrel (index.ts) and
 * inject by the PLANNING_SERVICE token, never by concrete class.
 *
 * CANON §Drive Isolation: PlanningModule does NOT import DriveEngineModule
 * directly for drive-related work. Opportunities arrive via the public
 * event channel. Drive state is read via IDriveStateReader if needed by
 * SimulationService.
 */

import { Module } from '@nestjs/common';

import { DriveEngineModule } from '../drive-engine';
import { EventsModule } from '../events';
import { KnowledgeModule } from '../knowledge';
import { CommunicationModule } from '../communication';
import { PlanningService } from './planning.service';
import { OpportunityResearchService } from './research/opportunity-research.service';
import { SimulationService } from './simulation/simulation.service';
import { ConstraintValidationService } from './validation/constraint-validation.service';
import { ProcedureCreationService } from './creation/procedure-creation.service';
import { PlanningRateLimiterService } from './rate-limiting/planning-rate-limiter.service';
import { OpportunityQueueService } from './queue/opportunity-queue.service';
import { PlanProposalService } from './proposal/plan-proposal.service';
import { PlanEvaluationService } from './evaluation/plan-evaluation.service';
import { PlanningPipelineService } from './pipeline/planning-pipeline.service';
import {
  PLANNING_SERVICE,
  OPPORTUNITY_RESEARCH_SERVICE,
  SIMULATION_SERVICE,
  CONSTRAINT_VALIDATION_SERVICE,
  PROCEDURE_CREATION_SERVICE,
  PLANNING_RATE_LIMITER,
  OPPORTUNITY_QUEUE,
  PLAN_PROPOSAL_SERVICE,
  PLAN_EVALUATION_SERVICE,
  PLANNING_PIPELINE_SERVICE,
} from './planning.tokens';

@Module({
  imports: [
    DriveEngineModule, // Provides DRIVE_STATE_READER for opportunity handling and simulation
    EventsModule, // Provides EVENTS_SERVICE for TimescaleDB event backbone
    KnowledgeModule, // Provides KNOWLEDGE_SERVICE for WKG queries and writes
    CommunicationModule, // Provides LLM_SERVICE for constraint validation
  ],
  providers: [
    {
      provide: PLANNING_SERVICE,
      useClass: PlanningService,
    },
    {
      provide: OPPORTUNITY_RESEARCH_SERVICE,
      useClass: OpportunityResearchService,
    },
    {
      provide: SIMULATION_SERVICE,
      useClass: SimulationService,
    },
    {
      provide: CONSTRAINT_VALIDATION_SERVICE,
      useClass: ConstraintValidationService,
    },
    {
      provide: PROCEDURE_CREATION_SERVICE,
      useClass: ProcedureCreationService,
    },
    {
      provide: PLANNING_RATE_LIMITER,
      useClass: PlanningRateLimiterService,
    },
    {
      provide: OPPORTUNITY_QUEUE,
      useClass: OpportunityQueueService,
    },
    {
      provide: PLAN_PROPOSAL_SERVICE,
      useClass: PlanProposalService,
    },
    {
      provide: PLAN_EVALUATION_SERVICE,
      useClass: PlanEvaluationService,
    },
    {
      provide: PLANNING_PIPELINE_SERVICE,
      useClass: PlanningPipelineService,
    },
  ],
  exports: [
    // Only the public facade is exported.
    // Internal pipeline tokens are intentionally hidden — no other module
    // should depend on research, simulation, validation, creation, or rate
    // limiting directly.
    PLANNING_SERVICE,
  ],
})
export class PlanningModule {}

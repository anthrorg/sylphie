/**
 * PlanningPipelineService — orchestrator for the 6-stage planning pipeline.
 *
 * Coordinates the full pipeline for each Opportunity:
 *   1. Rate-limit gate (via PlanningRateLimiterService)
 *   2. Research (via OpportunityResearchService)
 *   3. Simulation (via SimulationService)
 *   4. Proposal assembly (via PlanProposalService)
 *   5. Constraint validation (via ConstraintValidationService)
 *   6. Procedure creation (via ProcedureCreationService)
 *
 * This service implements the orchestration logic that chains the stages,
 * handles rate limiting, and returns the final PlanningResult.
 *
 * Provided under the PLANNING_PIPELINE_SERVICE token by PlanningModule.
 * Internal — not exported from the module barrel.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Opportunity,
  PlanningResult,
  ResearchResult,
  SimulationResult,
  PlanProposal,
  ValidationResult,
} from '../interfaces/planning.interfaces';
import {
  OPPORTUNITY_RESEARCH_SERVICE,
  SIMULATION_SERVICE,
  PLAN_PROPOSAL_SERVICE,
  CONSTRAINT_VALIDATION_SERVICE,
  PROCEDURE_CREATION_SERVICE,
  PLANNING_RATE_LIMITER,
} from '../planning.tokens';
import type {
  IOpportunityResearchService,
  ISimulationService,
  IPlanProposalService,
  IConstraintValidationService,
  IProcedureCreationService,
  IPlanningRateLimiter,
} from '../interfaces/planning.interfaces';
import { PipelineStageError } from '../exceptions/planning.exceptions';
import { EVENTS_SERVICE, type IEventService, createPlanningEvent } from '../../events';
import { DRIVE_STATE_READER, type IDriveStateReader } from '../../drive-engine';
import type { AppConfig } from '../../shared/config/app.config';

@Injectable()
export class PlanningPipelineService {
  private readonly logger = new Logger(PlanningPipelineService.name);

  constructor(
    private readonly configService: ConfigService<AppConfig>,
    @Inject(PLANNING_RATE_LIMITER) private readonly rateLimiter: IPlanningRateLimiter,
    @Inject(OPPORTUNITY_RESEARCH_SERVICE)
    private readonly researchService: IOpportunityResearchService,
    @Inject(SIMULATION_SERVICE) private readonly simulationService: ISimulationService,
    @Inject(PLAN_PROPOSAL_SERVICE) private readonly proposalService: IPlanProposalService,
    @Inject(CONSTRAINT_VALIDATION_SERVICE)
    private readonly validationService: IConstraintValidationService,
    @Inject(PROCEDURE_CREATION_SERVICE)
    private readonly creationService: IProcedureCreationService,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(DRIVE_STATE_READER) private readonly driveStateReader: IDriveStateReader,
  ) {}

  /**
   * Execute the full planning pipeline for a single Opportunity.
   *
   * Chains the six stages of the planning pipeline:
   *   1. Rate-limit check
   *   2. Research
   *   3. Simulation
   *   4. Proposal assembly
   *   5. Constraint validation
   *   6. Procedure creation
   *
   * Returns a PlanningResult discriminated union describing the outcome.
   * Never throws for expected pipeline exits (insufficient evidence, rate
   * limiting, validation failures, etc.) — those are represented as result
   * variants. Only throws for unexpected infrastructure failures.
   *
   * @param opportunity - The opportunity to process.
   * @returns PlanningResult describing the pipeline outcome.
   * @throws PlanningException for unexpected infrastructure failures.
   */
  async executePipeline(opportunity: Opportunity): Promise<PlanningResult> {
    try {
      // =====================================================================
      // STAGE 1: Rate Limit Check
      // =====================================================================
      if (!this.rateLimiter.canProceed()) {
        this.logger.debug(`Rate limit exceeded for opportunity ${opportunity.id}`);
        const driveSnapshot = this.driveStateReader.getCurrentState();
        const sessionId = this.configService.get('app')?.app?.sessionId ?? 'unknown';
        await this.eventsService.record(
          (createPlanningEvent as any)('PLANNING_RATE_LIMITED', {
            sessionId,
            driveSnapshot,
          }),
        );
        return { status: 'RATE_LIMITED' };
      }

      // =====================================================================
      // STAGE 2: Research
      // =====================================================================
      let research: ResearchResult;
      try {
        research = await this.researchService.research(opportunity);
      } catch (error) {
        this.logger.error(
          `Research phase failed for opportunity ${opportunity.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        const driveSnapshot = this.driveStateReader.getCurrentState();
        const sessionId = this.configService.get('app')?.app?.sessionId ?? 'unknown';
        await this.eventsService.record(
          (createPlanningEvent as any)('ERROR_RECOVERED', {
            sessionId,
            driveSnapshot,
          }),
        );
        throw new PipelineStageError(
          'RESEARCH',
          `Research phase failed: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined,
        );
      }

      if (!research.hasSufficientEvidence) {
        this.logger.debug(`Insufficient evidence for opportunity ${opportunity.id}`);
        return { status: 'INSUFFICIENT_EVIDENCE' };
      }

      // =====================================================================
      // STAGE 3: Simulation
      // =====================================================================
      let simulation: SimulationResult;
      try {
        simulation = await this.simulationService.simulate(research);
      } catch (error) {
        this.logger.error(
          `Simulation phase failed for opportunity ${opportunity.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        const driveSnapshot = this.driveStateReader.getCurrentState();
        const sessionId = this.configService.get('app')?.app?.sessionId ?? 'unknown';
        await this.eventsService.record(
          (createPlanningEvent as any)('ERROR_RECOVERED', {
            sessionId,
            driveSnapshot,
          }),
        );
        throw new PipelineStageError(
          'SIMULATION',
          `Simulation phase failed: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined,
        );
      }

      if (!simulation.hasViableOutcome) {
        this.logger.debug(`No viable outcome from simulation for opportunity ${opportunity.id}`);
        return { status: 'NO_VIABLE_OUTCOME' };
      }

      // =====================================================================
      // STAGE 4: Proposal Assembly
      // =====================================================================
      let proposalsArray: readonly PlanProposal[];
      try {
        proposalsArray = await this.proposalService.propose(research, simulation);
      } catch (error) {
        this.logger.error(
          `Proposal phase failed for opportunity ${opportunity.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        const driveSnapshot = this.driveStateReader.getCurrentState();
        const sessionId = this.configService.get('app')?.app?.sessionId ?? 'unknown';
        await this.eventsService.record(
          (createPlanningEvent as any)('ERROR_RECOVERED', {
            sessionId,
            driveSnapshot,
          }),
        );
        throw new PipelineStageError(
          'PROPOSAL',
          `Proposal phase failed: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined,
        );
      }

      if (proposalsArray.length === 0) {
        this.logger.debug(`No viable proposals generated for opportunity ${opportunity.id}`);
        return { status: 'NO_VIABLE_OUTCOME' };
      }

      // =====================================================================
      // STAGE 5: Constraint Validation (with revision loop)
      // =====================================================================
      const maxProposalRevisions =
        this.configService.get('app')?.planning?.maxProposalRevisions ?? 2;
      let passingProposal: PlanProposal | undefined;
      let passingValidation: ValidationResult | undefined;
      const allFailureReasons: string[] = [];

      for (let proposalIdx = 0; proposalIdx < proposalsArray.length; proposalIdx++) {
        let currentProposal: PlanProposal = proposalsArray[proposalIdx]!;
        let revisionCount = 0;
        let isValid = false;

        // Try initial validation and up to maxProposalRevisions revisions
        while (revisionCount <= maxProposalRevisions && !isValid) {
          try {
            const validation = await this.validationService.validate(currentProposal);

            if (validation.passed) {
              passingProposal = currentProposal;
              passingValidation = validation;
              isValid = true;
              break;
            }

            // Validation failed
            if (revisionCount < maxProposalRevisions) {
              // Extract feedback from validation failures
              const feedbackReasons = validation.failures.map((f) => f.reason);
              this.logger.debug(
                `Proposal ${currentProposal.id} validation failed, attempting revision ${revisionCount + 1}/${maxProposalRevisions}: ${feedbackReasons.join('; ')}`,
              );

              try {
                // Request revision
                currentProposal = (await this.proposalService.revise(
                  currentProposal,
                  feedbackReasons,
                ))!;
                revisionCount++;
              } catch (revisionError) {
                this.logger.warn(
                  `Revision ${revisionCount + 1} failed for proposal ${currentProposal.id}: ${revisionError instanceof Error ? revisionError.message : String(revisionError)}`,
                );
                // Move to next proposal if revision fails
                break;
              }
            } else {
              // Out of revisions for this proposal
              const failureReasons = validation.failures.map((f) => f.reason);
              allFailureReasons.push(
                `Proposal ${proposalIdx}: ${failureReasons.join('; ')}`,
              );
              break;
            }
          } catch (validationError) {
            this.logger.error(
              `Validation phase failed for proposal ${currentProposal.id}: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
            );
            const driveSnapshot = this.driveStateReader.getCurrentState();
            const sessionId = this.configService.get('app')?.app?.sessionId ?? 'unknown';
            await this.eventsService.record(
              (createPlanningEvent as any)('ERROR_RECOVERED', {
                sessionId,
                driveSnapshot,
              }),
            );
            throw new PipelineStageError(
              'VALIDATION',
              `Validation phase failed: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
              validationError instanceof Error ? validationError : undefined,
            );
          }
        }

        // If we found a passing proposal, break out of the proposal loop
        if (isValid && passingProposal && passingValidation) {
          break;
        }
      }

      // If all proposals failed validation
      if (!passingProposal || !passingValidation) {
        this.logger.debug(
          `Validation failed for all proposals for opportunity ${opportunity.id}`,
        );
        return {
          status: 'VALIDATION_FAILED',
          reasons: allFailureReasons.length > 0 ? allFailureReasons : ['All proposals failed validation'],
        };
      }

      // =====================================================================
      // STAGE 6: Procedure Creation
      // =====================================================================
      try {
        const procedure = await this.creationService.create(passingProposal, passingValidation);
        this.rateLimiter.recordPlanCreated();
        this.logger.log(`Plan created successfully: ${procedure.procedureId}`);
        return { status: 'CREATED', procedureId: procedure.procedureId };
      } catch (error) {
        this.logger.error(
          `Procedure creation failed for opportunity ${opportunity.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        const driveSnapshot = this.driveStateReader.getCurrentState();
        const sessionId = this.configService.get('app')?.app?.sessionId ?? 'unknown';
        await this.eventsService.record(
          (createPlanningEvent as any)('ERROR_RECOVERED', {
            sessionId,
            driveSnapshot,
          }),
        );
        throw new PipelineStageError(
          'CREATION',
          `Procedure creation failed: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined,
        );
      }
    } catch (error) {
      // Re-throw pipeline stage errors
      if (error instanceof PipelineStageError) {
        throw error;
      }
      // Wrap unexpected errors
      this.logger.error(
        `Unexpected error in planning pipeline for opportunity ${opportunity?.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new PipelineStageError(
        'PIPELINE',
        `Unexpected error in planning pipeline: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }
}

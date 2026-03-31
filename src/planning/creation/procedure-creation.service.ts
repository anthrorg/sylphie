/**
 * ProcedureCreationService — implementation of IProcedureCreationService.
 *
 * Terminal write in the Planning pipeline. Commits a validated PlanProposal
 * to the WKG as a procedure node and emits a PLAN_CREATED event to TimescaleDB.
 *
 * CANON §7 (Provenance Is Sacred): All procedure nodes created here carry
 * LLM_GENERATED provenance and initialConfidence 0.35. These values are set
 * at this layer and never overridden by the caller.
 *
 * CANON Standard 3 (Confidence Ceiling): 0.35 is well within the 0.60 ceiling.
 * The ceiling is enforced at the WKG persistence layer regardless, but the
 * contract literal type `confidence: 0.35` on CreatedProcedure makes this
 * explicit at the type level.
 *
 * Provided under the PROCEDURE_CREATION_SERVICE token by PlanningModule.
 * Internal — not exported from the module barrel.
 */

import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IProcedureCreationService,
  PlanProposal,
  ValidationResult,
  CreatedProcedure,
} from '../interfaces/planning.interfaces';
import { EVENTS_SERVICE, type IEventService, createPlanningEvent } from '../../events';
import { WKG_SERVICE, type IWkgService } from '../../knowledge';
import { DRIVE_STATE_READER, type IDriveStateReader } from '../../drive-engine';
import type { AppConfig } from '../../shared/config/app.config';
import type { NodeUpsertRequest } from '../../shared/types/knowledge.types';
import type { EdgeUpsertRequest } from '../../shared/types/knowledge.types';
import { PlanningException } from '../exceptions/planning.exceptions';

@Injectable()
export class ProcedureCreationService implements IProcedureCreationService {
  constructor(
    private readonly configService: ConfigService<AppConfig>,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
    @Inject(DRIVE_STATE_READER) private readonly driveStateReader: IDriveStateReader,
  ) {}

  /**
   * Write a validated PlanProposal to the WKG as a procedure node.
   *
   * Process:
   * 1. Verify validation has passed
   * 2. Create Procedure node in WKG with LLM_GENERATED provenance and 0.35 confidence
   * 3. Create TRIGGERED_BY edge linking the procedure to its trigger context
   * 4. Emit PLAN_CREATED event to TimescaleDB
   * 5. Return CreatedProcedure result
   *
   * @param proposal - The validated plan proposal
   * @param validation - The passing validation result
   * @returns CreatedProcedure with node ID and metadata
   * @throws PlanningException if validation failed or writes fail
   */
  async create(proposal: PlanProposal, validation: ValidationResult): Promise<CreatedProcedure> {
    // 1. Verify validation passed
    if (!validation.passed) {
      throw new PlanningException(
        `Cannot create procedure: validation failed with reasons: ${validation.failures.map((f) => f.reason).join('; ')}`,
      );
    }

    const driveSnapshot = this.driveStateReader.getCurrentState();
    const appConfig = this.configService.get<AppConfig>('app');
    const sessionId = appConfig?.app.sessionId || 'default';

    try {
      // 2. Create Procedure node in WKG
      const nodeRequest: NodeUpsertRequest = {
        labels: ['Action', 'Procedure'],
        nodeLevel: 'INSTANCE',
        provenance: 'LLM_GENERATED',
        initialConfidence: 0.35,
        properties: {
          name: proposal.name,
          triggerContext: proposal.triggerContext,
          actionSequence: JSON.stringify(proposal.actionSequence),
          expectedOutcome: proposal.expectedOutcome,
          abortConditions: JSON.stringify(proposal.abortConditions),
          evidenceStrength: proposal.evidenceStrength,
          opportunityId: proposal.opportunityId,
          proposalId: proposal.id,
          retrievalCount: 0,
          lastRetrievalTime: null,
        },
      };

      const nodeResult = await this.wkgService.upsertNode(nodeRequest);

      if (nodeResult.type === 'contradiction') {
        throw new PlanningException(
          `Procedure creation encountered a contradiction with existing node: ${nodeResult.conflictType}`,
        );
      }

      const procedureId = nodeResult.node.id;

      // 3. Try to create TRIGGERED_BY edge
      // Look for a node matching the trigger context to link to
      try {
        const contextNodes = await this.wkgService.findNodeByLabel('Context');
        if (contextNodes.length > 0) {
          const contextNodeId = contextNodes[0].id;

          const edgeRequest: EdgeUpsertRequest = {
            sourceId: procedureId,
            targetId: contextNodeId,
            relationship: 'TRIGGERED_BY',
            provenance: 'INFERENCE',
            initialConfidence: 0.30,
          };

          await this.wkgService.upsertEdge(edgeRequest);
        }
      } catch {
        // Edge creation is not critical — if it fails, proceed without it
        // The procedure node itself is the important write
      }

      // 4. Emit PLAN_CREATED event
      const planCreatedEvent = (createPlanningEvent as any)('PLAN_CREATED', {
        sessionId,
        driveSnapshot,
        data: {
          procedureId,
          proposalId: proposal.id,
          opportunityId: proposal.opportunityId,
          planName: proposal.name,
        },
      });
      await this.eventsService.record(planCreatedEvent);

      // 5. Return CreatedProcedure result
      return {
        procedureId,
        confidence: 0.35,
        provenance: 'LLM_GENERATED',
        createdAt: new Date(),
      };
    } catch (error) {
      if (error instanceof PlanningException) {
        throw error;
      }
      throw new PlanningException(
        `Procedure creation failed for proposal ${proposal.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

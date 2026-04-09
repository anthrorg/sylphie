/**
 * ProcedureCreationService -- Writes validated plans to the WKG as ActionProcedure nodes.
 *
 * CANON SS Subsystem 5 (Planning): "Create Plan Procedure" adds an action node
 * to the World Knowledge Graph. The procedure has INFERENCE provenance with
 * base confidence 0.30 (PROVENANCE_BASE_CONFIDENCE.INFERENCE).
 *
 * The created node starts with:
 *   - confidence = 0.30 (below retrieval threshold 0.50, so it requires use
 *     to build confidence before being retrieved by default)
 *   - actr_count = 0 (no uses yet)
 *   - actr_decay_rate = 0.06 (DEFAULT_DECAY_RATES.INFERENCE)
 *   - Subject to confidence ceiling of 0.60 until guardian confirmation
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Neo4jService, Neo4jInstanceName, verboseFor } from '@sylphie/shared';
import type {
  IProcedureCreationService,
  PlanProposal,
  QueuedOpportunity,
} from '../interfaces/planning.interfaces';

const vlog = verboseFor('Planning');

// ---------------------------------------------------------------------------
// Constants (from CANON via @sylphie/shared provenance + confidence types)
// ---------------------------------------------------------------------------

/** PROVENANCE_BASE_CONFIDENCE.INFERENCE */
const BASE_CONFIDENCE = 0.30;

/** DEFAULT_DECAY_RATES.INFERENCE */
const DECAY_RATE = 0.06;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ProcedureCreationService implements IProcedureCreationService {
  private readonly logger = new Logger(ProcedureCreationService.name);

  constructor(private readonly neo4j: Neo4jService) {}

  async createProcedure(
    proposal: PlanProposal,
    opportunity: QueuedOpportunity,
  ): Promise<string> {
    const nodeId = randomUUID();
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');

    // Guardian-taught procedures get TAUGHT_PROCEDURE provenance and higher
    // base confidence (0.50 meets retrieval threshold immediately).
    const isGuardianTeaching = opportunity.payload.classification === 'GUARDIAN_TEACHING';
    const provenanceType = isGuardianTeaching ? 'TAUGHT_PROCEDURE' : 'INFERENCE';
    const confidence = isGuardianTeaching ? 0.50 : BASE_CONFIDENCE;

    try {
      await session.run(
        `CREATE (p:ActionProcedure {
           node_id: $nodeId,
           name: $name,
           category: $category,
           trigger_context: $triggerContext,
           action_sequence: $actionSequence,
           provenance_type: $provenanceType,
           confidence: $confidence,
           actr_base: $confidence,
           actr_count: 0,
           actr_decay_rate: $decayRate,
           actr_last_retrieval_at: null,
           created_at: datetime(),
           source_opportunity_id: $opportunityId,
           source_classification: $classification,
           rationale: $rationale,
           predicted_drive_effects: $predictedDriveEffects,
           guardian_instruction: $guardianInstruction
         })
         RETURN p.node_id AS nodeId`,
        {
          nodeId,
          name: proposal.name,
          category: proposal.category,
          triggerContext: proposal.triggerContext,
          actionSequence: JSON.stringify(proposal.actionSequence),
          provenanceType,
          confidence,
          decayRate: DECAY_RATE,
          opportunityId: opportunity.payload.id,
          classification: opportunity.payload.classification,
          rationale: proposal.rationale,
          predictedDriveEffects: JSON.stringify(proposal.predictedDriveEffects),
          guardianInstruction: opportunity.payload.guardianInstruction ?? null,
        },
      );

      vlog('procedure created', {
        nodeId,
        name: proposal.name,
        category: proposal.category,
        provenanceType,
        confidence,
        isGuardianTeaching,
        opportunityId: opportunity.payload.id,
        actionStepCount: proposal.actionSequence.length,
        steps: proposal.actionSequence.map((s) => s.stepType),
        triggerContext: proposal.triggerContext,
      });

      this.logger.log(
        `Created ActionProcedure node: ${nodeId} (${proposal.name}, ` +
          `confidence=${confidence}, provenance=${provenanceType})`,
      );

      return nodeId;
    } finally {
      await session.close();
    }
  }
}

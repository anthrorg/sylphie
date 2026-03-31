/**
 * PlanProposalService — implements plan proposal generation.
 *
 * Assembles PlanProposal objects from ResearchResult and SimulationResult,
 * and handles revision cycles if the constraint validator rejects an initial
 * proposal.
 *
 * Implementation constructs proposals with action sequences, trigger contexts, and
 * abort conditions based on simulation outputs. Emits PROPOSAL_GENERATED events
 * to the event backbone.
 *
 * Provided under the PLAN_PROPOSAL_SERVICE token by PlanningModule.
 * Internal — not exported from the module barrel.
 */

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { AppConfig } from '../../shared/config/app.config';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { createPlanningEvent } from '../../events/builders/event-builders';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import type {
  PlanProposal,
  ResearchResult,
  SimulationResult,
} from '../interfaces/planning.interfaces';

@Injectable()
export class PlanProposalService {
  /** Tracks revision count per proposal to enforce max revisions. */
  private readonly revisionCounts = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(DRIVE_STATE_READER) private readonly driveStateReader: IDriveStateReader,
  ) {}

  /**
   * Assemble a PlanProposal from a ResearchResult and SimulationResult.
   *
   * Takes the top candidates from the simulation (sorted by expectedValue),
   * creates PlanProposal objects with action sequences, trigger contexts,
   * and abort conditions derived from the research and simulation outputs.
   *
   * @param research - The research phase output containing evidence assessment.
   * @param simulation - The simulation phase output with ranked candidates.
   * @returns Array of candidate PlanProposal objects (typically top 3).
   */
  async propose(
    research: ResearchResult,
    simulation: SimulationResult,
  ): Promise<PlanProposal[]> {
    const proposals: PlanProposal[] = [];

    // Take top 3 candidates from simulation (already sorted by expectedValue descending)
    const topCandidates = simulation.candidates.slice(0, 3);

    for (const candidate of topCandidates) {
      const proposalId = randomUUID();
      const contextKnowledge = research.contextKnowledge[0] || 'general-context';

      const proposal: PlanProposal = {
        id: proposalId,
        opportunityId: `opp-${proposalId}`, // Generate from proposal context
        name: `Plan: ${candidate.actionType} for ${contextKnowledge}`,
        triggerContext: contextKnowledge,
        actionSequence: [
          {
            stepType: candidate.actionType,
            params: {
              driveEffects: candidate.predictedDriveEffects,
              successProbability: candidate.successProbability,
            },
          },
        ],
        expectedOutcome: this.buildExpectedOutcome(candidate.predictedDriveEffects),
        abortConditions: this.generateAbortConditions(),
        evidenceStrength: research.evidenceStrength,
      };

      proposals.push(proposal);
    }

    // Emit PROPOSAL_GENERATED event
    const driveSnapshot = this.driveStateReader.getCurrentState();
    const appConfig = this.configService.get<AppConfig>('app');
    const sessionId = (appConfig?.app?.sessionId ?? 'unknown-session') as string;
    const event = (createPlanningEvent as any)('PROPOSAL_GENERATED', {
      sessionId,
      driveSnapshot,
      data: {
        proposalCount: proposals.length,
        candidateCount: simulation.candidates.length,
      },
    });
    await this.eventsService.record(event);

    return proposals;
  }

  /**
   * Revise a rejected PlanProposal based on validator feedback.
   *
   * Takes the original proposal and feedback reasons, incrementing revision count.
   * If max revisions exceeded, returns unchanged. Otherwise, attempts to adjust
   * proposal based on feedback keywords.
   *
   * @param proposal - The original rejected proposal.
   * @param feedback - Human-readable feedback reasons from constraint validation.
   * @returns Revised PlanProposal addressing the feedback.
   */
  async revise(
    proposal: PlanProposal,
    feedback: string[],
  ): Promise<PlanProposal> {
    const planningConfig = this.configService.get<AppConfig>('app')?.planning;
    const maxRevisions = planningConfig?.maxProposalRevisions ?? 2;

    const currentRevisions = this.revisionCounts.get(proposal.id) ?? 0;
    if (currentRevisions >= maxRevisions) {
      return proposal;
    }

    // Increment revision count
    this.revisionCounts.set(proposal.id, currentRevisions + 1);

    // Build revised proposal with adjustments based on feedback
    const revisedProposal: PlanProposal = {
      ...proposal,
      abortConditions: this.reviseAbortConditions(
        proposal.abortConditions,
        feedback,
      ),
    };

    return revisedProposal;
  }

  /**
   * Build a human-readable expected outcome description from drive effects.
   */
  private buildExpectedOutcome(
    predictedDriveEffects: Partial<Record<string, number>>,
  ): string {
    const effects = Object.entries(predictedDriveEffects)
      .filter(([, value]) => value !== undefined && value !== 0)
      .map(([drive, value]) => {
        if (value === undefined) return '';
        const direction = value > 0 ? 'reduce' : 'increase';
        return `${direction} ${drive}`;
      })
      .filter((effect) => effect.length > 0);

    if (effects.length === 0) {
      return 'Neutral outcome with no significant drive effects';
    }

    return `Expected to ${effects.join(' and ')}`;
  }

  /**
   * Generate default abort conditions for a proposal.
   */
  private generateAbortConditions(): readonly string[] {
    return [
      'MAE exceeds 0.15 over 3 consecutive uses',
      'Drive anxiety exceeds 0.8 during execution',
      'No measurable improvement after 5 attempts',
    ];
  }

  /**
   * Revise abort conditions based on validator feedback.
   */
  private reviseAbortConditions(
    original: readonly string[],
    feedback: string[],
  ): readonly string[] {
    const feedbackLower = feedback.join(' ').toLowerCase();
    let conditions = [...original];

    // Add additional conditions based on feedback
    if (feedbackLower.includes('timeout')) {
      conditions.push('Execution exceeds 30 seconds');
    }
    if (feedbackLower.includes('safety')) {
      conditions.push('Safety threshold violated');
    }
    if (feedbackLower.includes('resource')) {
      conditions.push('System resource limit reached');
    }

    return conditions;
  }
}

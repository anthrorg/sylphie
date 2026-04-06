/**
 * ProposalService -- Generates structured plan proposals from research and simulation.
 *
 * CANON SS Subsystem 5 (Planning): "Propose Plan" generates a concrete action
 * procedure proposal with ordered ActionSteps.
 *
 * Uses LLM when available for richer, context-aware proposals. Falls back to
 * template-based generation from the simulation's best outcome when LLM is
 * unavailable (Lesion Test support).
 */

import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { LLM_SERVICE, type ILlmService, type ActionStep } from '@sylphie/shared';
import type {
  IProposalService,
  PlanProposal,
  QueuedOpportunity,
  ResearchResult,
  SimulationResult,
} from '../interfaces/planning.interfaces';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ProposalService implements IProposalService {
  private readonly logger = new Logger(ProposalService.name);

  constructor(
    @Optional() @Inject(LLM_SERVICE)
    private readonly llm: ILlmService | null,
  ) {}

  async propose(
    opportunity: QueuedOpportunity,
    research: ResearchResult,
    simulation: SimulationResult,
  ): Promise<PlanProposal> {
    if (this.llm && this.llm.isAvailable()) {
      try {
        return await this.proposeLlm(opportunity, research, simulation);
      } catch (err) {
        this.logger.warn(
          `LLM proposal failed, falling back to template: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return this.proposeTemplate(opportunity, simulation);
  }

  async refine(
    original: PlanProposal,
    violations: readonly string[],
    opportunity: QueuedOpportunity,
  ): Promise<PlanProposal> {
    if (this.llm && this.llm.isAvailable()) {
      try {
        return await this.refineLlm(original, violations, opportunity);
      } catch (err) {
        this.logger.warn(
          `LLM refinement failed, returning original: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // If LLM unavailable for refinement, return original unchanged.
    return original;
  }

  // ---------------------------------------------------------------------------
  // Private: LLM-assisted proposal
  // ---------------------------------------------------------------------------

  private async proposeLlm(
    opportunity: QueuedOpportunity,
    research: ResearchResult,
    simulation: SimulationResult,
  ): Promise<PlanProposal> {
    const best = simulation.bestOutcome!;

    const prompt = [
      'You are Sylphie\'s behavioral planner. Given research data and simulation results,',
      'generate a concrete action procedure for addressing the identified opportunity.',
      '',
      `Opportunity: ${opportunity.payload.classification}`,
      `Affected drive: ${opportunity.payload.affectedDrive}`,
      `Context fingerprint: ${opportunity.payload.contextFingerprint}`,
      '',
      `Research findings:`,
      `  Event frequency (7d): ${research.eventFrequency}`,
      `  Recent occurrences (24h): ${research.recentOccurrences}`,
      `  Patterns: ${research.contextPatterns.join(', ') || 'none detected'}`,
      '',
      `Best simulation outcome:`,
      `  Category: ${best.actionCategory}`,
      `  Description: ${best.description}`,
      `  Confidence: ${best.confidenceEstimate.toFixed(2)}`,
      `  Risk: ${best.riskScore.toFixed(2)}`,
      '',
      'Respond with a JSON object containing:',
      '  name: string (short descriptive name for the procedure)',
      '  category: string (action category)',
      '  triggerContext: string (when this procedure should activate)',
      '  rationale: string (why this plan addresses the opportunity)',
      '  steps: Array<{ stepType: string, params: object }> (ordered action steps)',
    ].join('\n');

    const response = await this.llm!.complete({
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: 'You are a behavioral planner. Respond with valid JSON only.',
      maxTokens: 1024,
      temperature: 0.3,
      metadata: {
        callerSubsystem: 'PLANNING',
        purpose: 'PLAN_PROPOSAL_GENERATION',
        sessionId: 'planning-internal',
      },
    });

    return this.parseLlmProposal(response.content, best.actionCategory);
  }

  private async refineLlm(
    original: PlanProposal,
    violations: readonly string[],
    opportunity: QueuedOpportunity,
  ): Promise<PlanProposal> {
    const prompt = [
      'The following plan proposal was rejected by the constraint validator.',
      'Revise it to address the violations while preserving the core intent.',
      '',
      `Original plan: ${original.name}`,
      `Category: ${original.category}`,
      `Rationale: ${original.rationale}`,
      `Steps: ${JSON.stringify(original.actionSequence)}`,
      '',
      `Violations:`,
      ...violations.map((v) => `  - ${v}`),
      '',
      'Respond with a revised JSON object (same format as original):',
      '  name, category, triggerContext, rationale, steps',
    ].join('\n');

    const response = await this.llm!.complete({
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: 'You are a behavioral planner. Respond with valid JSON only.',
      maxTokens: 1024,
      temperature: 0.3,
      metadata: {
        callerSubsystem: 'PLANNING',
        purpose: 'PLAN_PROPOSAL_REFINEMENT',
        sessionId: 'planning-internal',
      },
    });

    return this.parseLlmProposal(response.content, original.category);
  }

  // ---------------------------------------------------------------------------
  // Private: Template-based proposal
  // ---------------------------------------------------------------------------

  private proposeTemplate(
    opportunity: QueuedOpportunity,
    simulation: SimulationResult,
  ): PlanProposal {
    const best = simulation.bestOutcome;
    const category = best?.actionCategory ?? 'SelfRegulation';
    const classification = opportunity.payload.classification;

    const name = `${classification.toLowerCase().replace(/_/g, '-')}-response`;

    const steps: ActionStep[] = [
      {
        index: 0,
        stepType: 'WKG_QUERY',
        params: {
          query: 'MATCH (p:ActionProcedure) WHERE p.category = $category RETURN p LIMIT 5',
          category,
        },
      },
      {
        index: 1,
        stepType: 'LLM_GENERATE',
        params: {
          purpose: 'generate_response',
          context: `Addressing ${classification} for ${opportunity.payload.affectedDrive}`,
        },
      },
    ];

    return {
      name,
      category,
      triggerContext: opportunity.payload.contextFingerprint,
      actionSequence: steps,
      rationale: `Template-based response to ${classification} ` +
        `affecting ${opportunity.payload.affectedDrive}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: LLM response parsing
  // ---------------------------------------------------------------------------

  private parseLlmProposal(content: string, fallbackCategory: string): PlanProposal {
    try {
      // Extract JSON from potential markdown code blocks.
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, content];
      const parsed = JSON.parse(jsonMatch[1]!.trim());

      const steps: ActionStep[] = (parsed.steps ?? []).map(
        (s: { stepType?: string; params?: Record<string, unknown> }, i: number) => ({
          index: i,
          stepType: s.stepType ?? 'LLM_GENERATE',
          params: s.params ?? {},
        }),
      );

      return {
        name: String(parsed.name ?? 'unnamed-plan'),
        category: String(parsed.category ?? fallbackCategory),
        triggerContext: String(parsed.triggerContext ?? ''),
        actionSequence: steps.length > 0 ? steps : [{
          index: 0,
          stepType: 'LLM_GENERATE',
          params: { purpose: 'execute_plan' },
        }],
        rationale: String(parsed.rationale ?? ''),
      };
    } catch {
      this.logger.warn('Failed to parse LLM proposal -- generating minimal fallback');
      return {
        name: 'llm-parse-fallback',
        category: fallbackCategory,
        triggerContext: '',
        actionSequence: [{
          index: 0,
          stepType: 'LLM_GENERATE',
          params: { purpose: 'execute_plan' },
        }],
        rationale: 'Fallback due to LLM response parsing failure',
      };
    }
  }
}

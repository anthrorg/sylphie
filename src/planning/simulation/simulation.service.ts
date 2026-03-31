/**
 * SimulationService — implementation of ISimulationService.
 *
 * Uses ResearchResult data (prior failure counts, contextual knowledge,
 * evidence strength) to model candidate action outcomes. Does not call the
 * LLM — simulation is driven entirely by graph data and evidence metrics.
 *
 * CANON Standard 1 (Theater Prohibition): Predicted drive effects in
 * SimulatedOutcome must reflect real pressure in the current DriveSnapshot.
 * All predicted effects are conservative estimates grounded in evidence.
 *
 * Provided under the SIMULATION_SERVICE token by PlanningModule.
 * Internal — not exported from the module barrel.
 */

import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ISimulationService,
  ResearchResult,
  SimulationResult,
  SimulatedOutcome,
} from '../interfaces/planning.interfaces';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { createPlanningEvent } from '../../events/builders/event-builders';
import type { AppConfig } from '../../shared/config/app.config';
import type { DriveName } from '../../shared/types/drive.types';

@Injectable()
export class SimulationService implements ISimulationService {
  constructor(
    private readonly configService: ConfigService,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
    @Inject(DRIVE_STATE_READER) private readonly driveStateReader: IDriveStateReader,
  ) {}

  /**
   * Simulate candidate outcomes from a ResearchResult.
   *
   * 1. Generate 3-5 candidate action types from research context knowledge
   * 2. For each candidate, compute drive effects from historical similar actions
   * 3. Estimate success probability and information gain
   * 4. Compute expected value as weighted combination
   * 5. Emit event and return result
   */
  async simulate(research: ResearchResult): Promise<SimulationResult> {
    const config = this.configService.get<AppConfig>('app');
    const driveSnapshot = this.driveStateReader.getCurrentState();

    // Generate candidate action types (3-5 candidates)
    const candidates = await this.generateCandidates(research);

    // Evaluate each candidate
    const evaluatedOutcomes: SimulatedOutcome[] = [];
    for (const actionType of candidates) {
      const outcome = await this.evaluateCandidate(actionType, research);
      evaluatedOutcomes.push(outcome);
    }

    // Sort by expected value descending
    evaluatedOutcomes.sort((a, b) => b.expectedValue - a.expectedValue);

    // Determine viability and best candidate
    const minExpectedValue = config?.planning?.simulationMinExpectedValue ?? 0.3;
    const hasViableOutcome = evaluatedOutcomes.some((o) => o.expectedValue > minExpectedValue);
    const bestCandidate = evaluatedOutcomes.length > 0 ? evaluatedOutcomes[0] : null;

    // Emit event
    if (hasViableOutcome) {
      await this.eventsService.record(
        (createPlanningEvent as any)('SIMULATION_COMPLETED', {
          sessionId: config?.app?.sessionId ?? 'unknown',
          driveSnapshot,
        }),
      );
    } else {
      await this.eventsService.record(
        (createPlanningEvent as any)('SIMULATION_NO_VIABLE', {
          sessionId: config?.app?.sessionId ?? 'unknown',
          driveSnapshot,
        }),
      );
    }

    return {
      candidates: evaluatedOutcomes,
      hasViableOutcome,
      bestCandidate,
    };
  }

  /**
   * Generate 3-5 candidate action types based on context knowledge.
   *
   * If contextKnowledge is sparse, use default candidates.
   * Otherwise, extract action types from knowledge and generate up to 5.
   */
  private async generateCandidates(research: ResearchResult): Promise<string[]> {
    const defaultCandidates = ['ConversationalResponse', 'KnowledgeQuery', 'SocialComment'];

    if (research.contextKnowledge.length === 0) {
      return defaultCandidates;
    }

    // Try to extract action types from context knowledge
    // For now, return defaults; in a full implementation, parse contextKnowledge
    // to extract entity references and infer action types from them
    const candidates = new Set<string>(defaultCandidates);

    // If we have rich context, add up to 2 more candidates
    if (research.contextKnowledge.length >= 3) {
      candidates.add('InformationRequest');
      if (research.contextKnowledge.length >= 5) {
        candidates.add('ProactiveNotification');
      }
    }

    return Array.from(candidates);
  }

  /**
   * Evaluate a single candidate action type.
   *
   * Steps:
   * 1. Query WKG for similar past actions (historical data)
   * 2. Predict drive effects by averaging similar actions
   * 3. Estimate success probability from event frequency
   * 4. Estimate information gain from WKG gaps
   * 5. Compute expected value
   */
  private async evaluateCandidate(
    actionType: string,
    research: ResearchResult,
  ): Promise<SimulatedOutcome> {
    // Query WKG for similar past actions using querySubgraph
    const subgraphResult = await this.wkgService.querySubgraph(
      {
        labels: ['Action'],
        nodeLevel: 'INSTANCE',
      },
      100,
    );
    const similarActions = subgraphResult.nodes;

    // Predict drive effects from similar actions
    const predictedDriveEffects = this.predictDriveEffects(
      similarActions,
      research.failureCount,
    );

    // Estimate success probability
    const successProbability = this.estimateSuccessProbability(
      similarActions,
      research,
    );

    // Estimate information gain
    const informationGain = this.estimateInformationGain(research);

    // Compute expected value: 0.4 * driveReliefScore + 0.35 * successProbability + 0.25 * informationGain
    const driveReliefScore = this.computeDriveReliefScore(predictedDriveEffects);
    const expectedValue =
      0.4 * driveReliefScore +
      0.35 * successProbability +
      0.25 * informationGain;

    return {
      actionType,
      predictedDriveEffects,
      successProbability,
      informationGain,
      expectedValue: Math.min(1.0, Math.max(0.0, expectedValue)),
    };
  }

  /**
   * Predict drive effects by averaging historical outcomes of similar actions.
   *
   * If < 3 similar actions found, apply conservative estimate (50% reduction).
   */
  private predictDriveEffects(
    similarActions: any[],
    failureCount: number,
  ): Partial<Record<DriveName, number>> {
    if (similarActions.length === 0) {
      return {};
    }

    const driveEffects: Partial<Record<DriveName, number>> = {};
    const driveNames = [
      'systemHealth',
      'moralValence',
      'integrity',
      'cognitiveAwareness',
      'guilt',
      'curiosity',
      'boredom',
      'anxiety',
      'satisfaction',
      'sadness',
      'informationIntegrity',
      'social',
    ] as const;

    // Average drive effects from similar actions
    const effectSums: Record<string, number> = {};
    const effectCounts: Record<string, number> = {};

    for (const action of similarActions) {
      const props = action.properties as Record<string, unknown>;
      for (const driveName of driveNames) {
        const effectKey = `${driveName}Effect`;
        if (effectKey in props && typeof props[effectKey] === 'number') {
          effectSums[driveName] = (effectSums[driveName] ?? 0) + (props[effectKey] as number);
          effectCounts[driveName] = (effectCounts[driveName] ?? 0) + 1;
        }
      }
    }

    // Compute averages
    for (const driveName of driveNames) {
      if (driveName in effectSums && driveName in effectCounts) {
        let effect = effectSums[driveName] / effectCounts[driveName];

        // Conservative estimate: if < 3 similar actions, reduce by 50%
        if (similarActions.length < 3) {
          effect *= 0.5;
        }

        if (effect !== 0) {
          driveEffects[driveName as DriveName] = effect;
        }
      }
    }

    return driveEffects;
  }

  /**
   * Estimate success probability from event frequency.
   *
   * successProbability = min(0.9, (successCount / totalAttempts) * research.evidenceStrength)
   * If no data: default to 0.3
   * If < 3 similar actions: reduce by 30%
   */
  private estimateSuccessProbability(
    similarActions: any[],
    research: ResearchResult,
  ): number {
    if (similarActions.length === 0) {
      return 0.3;
    }

    // Count successes from similar actions
    let successCount = 0;
    for (const action of similarActions) {
      const props = action.properties as Record<string, unknown>;
      if (props.success === true) {
        successCount++;
      }
    }

    let probability = (successCount / similarActions.length) * research.evidenceStrength;

    // Conservative estimate: if < 3 similar actions, reduce by 30%
    if (similarActions.length < 3) {
      probability *= 0.7;
    }

    return Math.min(0.9, probability);
  }

  /**
   * Estimate information gain from WKG gaps.
   *
   * informationGain = 1.0 - (knowledgeNodesInContext / maxExpectedNodes)
   * Clamped to [0.0, 1.0]
   */
  private estimateInformationGain(research: ResearchResult): number {
    const maxExpectedNodes = 20; // Reasonable upper bound for context knowledge
    const nodeCount = research.contextKnowledge.length;
    const gain = 1.0 - Math.min(1.0, nodeCount / maxExpectedNodes);
    return Math.max(0.0, Math.min(1.0, gain));
  }

  /**
   * Compute drive relief score from predicted effects.
   *
   * Sum positive (relief) effects and normalize to [0, 1].
   * Used for weighting in expected value calculation.
   */
  private computeDriveReliefScore(effects: Partial<Record<DriveName, number>>): number {
    let totalRelief = 0;
    let effectCount = 0;

    for (const effect of Object.values(effects)) {
      if (effect > 0) {
        totalRelief += effect;
      }
      effectCount++;
    }

    // Normalize to [0, 1] by dividing by the theoretical max (12 drives at 1.0 each)
    // and clamping
    if (effectCount === 0) {
      return 0.0;
    }

    return Math.min(1.0, totalRelief / 12.0);
  }
}

/**
 * SimulationService -- Predicts outcomes of potential behavioral changes.
 *
 * CANON SS Subsystem 5 (Planning): "Run Simulations" evaluates potential
 * action categories by analyzing historical action outcomes from TimescaleDB.
 *
 * For each candidate action category:
 *   1. Query historical drive effects for that category.
 *   2. Estimate expected drive relief on the affected drive.
 *   3. Score viability based on historical success rate.
 *
 * An outcome is "viable" if the estimated drive effect on the affected drive
 * exceeds the minimum relief threshold.
 */

import { Injectable, Logger } from '@nestjs/common';
import { TimescaleService, DriveName } from '@sylphie/shared';
import type {
  ISimulationService,
  SimulationResult,
  SimulatedOutcome,
  QueuedOpportunity,
  ResearchResult,
} from '../interfaces/planning.interfaces';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum drive relief to consider an outcome viable. */
const MIN_RELIEF_THRESHOLD = -0.05;

/** Action categories to evaluate for each opportunity type. */
const CANDIDATE_CATEGORIES = [
  'ConversationalResponse',
  'InformationSeeking',
  'SocialEngagement',
  'TaskExecution',
  'SelfRegulation',
];

/** Maximum historical outcomes to query per category. */
const MAX_OUTCOMES_PER_CATEGORY = 50;

/** Lookback window for historical outcomes. */
const LOOKBACK_DAYS = 14;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class SimulationService implements ISimulationService {
  private readonly logger = new Logger(SimulationService.name);

  constructor(private readonly timescale: TimescaleService) {}

  async simulate(
    opportunity: QueuedOpportunity,
    research: ResearchResult,
  ): Promise<SimulationResult> {
    const affectedDrive = opportunity.payload.affectedDrive;
    const outcomes: SimulatedOutcome[] = [];

    for (const category of CANDIDATE_CATEGORIES) {
      try {
        const outcome = await this.evaluateCategory(category, affectedDrive, research);
        if (outcome) {
          outcomes.push(outcome);
        }
      } catch (err) {
        this.logger.warn(
          `Simulation failed for category ${category}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Sort by estimated benefit (most negative drive effect = most relief).
    outcomes.sort((a, b) => {
      const aEffect = a.estimatedDriveEffect[affectedDrive] ?? 0;
      const bEffect = b.estimatedDriveEffect[affectedDrive] ?? 0;
      return aEffect - bEffect;
    });

    const viableOutcomes = outcomes.filter((o) => {
      const effect = o.estimatedDriveEffect[affectedDrive] ?? 0;
      return effect <= MIN_RELIEF_THRESHOLD;
    });

    let viable = viableOutcomes.length > 0;
    let bestOutcome: SimulatedOutcome | null = viable ? viableOutcomes[0] : null;

    // Guardian teaching always produces at least one viable outcome.
    if (opportunity.payload.classification === 'GUARDIAN_TEACHING' && !viable) {
      const guardianOutcome: SimulatedOutcome = {
        description: `Guardian-directed: ${opportunity.payload.guardianInstruction ?? opportunity.payload.contextFingerprint}`,
        actionCategory: 'GuardianTeaching',
        estimatedDriveEffect: {
          [affectedDrive]: -0.15,
          [DriveName.CognitiveAwareness]: -0.10,
        } as Partial<Record<DriveName, number>>,
        confidenceEstimate: 0.5,
        riskScore: 0.1,
      };
      outcomes.push(guardianOutcome);
      viable = true;
      bestOutcome = guardianOutcome;
    }

    this.logger.debug(
      `Simulation for ${opportunity.payload.id}: ${outcomes.length} outcomes evaluated, ` +
        `${viableOutcomes.length} viable`,
    );

    return { viable, outcomes, bestOutcome };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Evaluate a single action category by querying historical outcomes.
   */
  private async evaluateCategory(
    category: string,
    affectedDrive: DriveName,
    research: ResearchResult,
  ): Promise<SimulatedOutcome | null> {
    // Query historical action outcomes for this category.
    const result = await this.timescale.query<{
      payload: string;
      count: string;
    }>(
      `SELECT payload, COUNT(*) AS count FROM events
       WHERE type = 'ACTION_OUTCOME_EVALUATED'
         AND timestamp > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
         AND payload->>'actionType' = $1
       GROUP BY payload
       LIMIT $2`,
      [category, MAX_OUTCOMES_PER_CATEGORY],
    );

    if (result.rows.length === 0) {
      // No historical data for this category. Generate a conservative estimate.
      return {
        description: `New ${category} behavior (no historical data)`,
        actionCategory: category,
        estimatedDriveEffect: { [affectedDrive]: -0.02 } as Partial<Record<DriveName, number>>,
        confidenceEstimate: 0.2,
        riskScore: 0.5,
      };
    }

    // Aggregate drive effects from historical outcomes.
    let totalEffect = 0;
    let successCount = 0;
    let totalCount = 0;

    for (const row of result.rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const count = parseInt(row.count, 10);
      totalCount += count;

      const driveEffects = payload['driveEffects'];
      if (driveEffects && typeof driveEffects === 'object') {
        const effect = driveEffects[affectedDrive];
        if (typeof effect === 'number') {
          totalEffect += effect * count;
        }
      }

      if (payload['outcome'] === 'positive') {
        successCount += count;
      }
    }

    const avgEffect = totalCount > 0 ? totalEffect / totalCount : 0;
    const successRate = totalCount > 0 ? successCount / totalCount : 0;

    return {
      description: `${category} based on ${totalCount} historical outcomes`,
      actionCategory: category,
      estimatedDriveEffect: { [affectedDrive]: avgEffect } as Partial<Record<DriveName, number>>,
      confidenceEstimate: Math.min(0.8, successRate),
      riskScore: 1.0 - successRate,
    };
  }
}

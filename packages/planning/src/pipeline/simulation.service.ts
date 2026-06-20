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
import { TimescaleService, DriveName, verboseFor } from '@sylphie/shared';
import type {
  ISimulationService,
  SimulationResult,
  SimulatedOutcome,
  QueuedOpportunity,
  ResearchResult,
} from '../interfaces/planning.interfaces';

const vlog = verboseFor('Planning');

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

/**
 * Shrinkage prior pseudo-count: pulls confidence toward 0 when sample size is
 * small, so one lucky success doesn't score the same as 50 consistent successes.
 */
const CONFIDENCE_PRIOR_K = 10;

// ---------------------------------------------------------------------------
// Pure scoring helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Shrinkage-prior confidence estimate.
 *
 * Returns successCount / (totalCount + k).  With k=10:
 *   - count=0  → 0     (no evidence, no confidence)
 *   - count=1, all success → ~0.09  (single lucky win ≠ high confidence)
 *   - count=50, all success → ~0.83 (50 consistent wins → high confidence)
 */
export function computeConfidence(
  successCount: number,
  totalCount: number,
  k: number = CONFIDENCE_PRIOR_K,
): number {
  if (totalCount === 0) return 0;
  return successCount / (totalCount + k);
}

/**
 * Variance-aware risk score in [0, 1].
 *
 * Risk combines two signals:
 *   - badRate:  fraction of observed effects that were non-negative (drive not
 *               relieved — an effect ≥ 0 means no benefit or harm).
 *   - stdDev:   standard deviation of effect values; high spread = unpredictable.
 *
 * riskScore = clamp(badRate + stdDev, 0, 1)
 *
 * With no observations (empty array) the outcome is fully unknown → risk = 1.
 *
 * Accepts an optional parallel weights array (same length as effects) for
 * weighted statistics when observations are repeated. Unweighted when omitted.
 */
export function computeRisk(
  effects: readonly number[],
  weights?: readonly number[],
): number {
  if (effects.length === 0) return 1.0;

  const n = effects.length;
  const w = weights ?? effects.map(() => 1);
  const totalWeight = w.reduce((s, wi) => s + wi, 0);

  // Weighted bad-rate: proportion of weight on effects that gave no drive relief.
  const badWeight = effects.reduce((s, e, i) => s + (e >= 0 ? w[i] : 0), 0);
  const badRate = badWeight / totalWeight;

  // Weighted mean and variance.
  const mean = effects.reduce((s, e, i) => s + e * w[i], 0) / totalWeight;
  const variance =
    effects.reduce((s, e, i) => s + w[i] * (e - mean) ** 2, 0) / totalWeight;
  const stdDev = Math.sqrt(variance);

  return Math.min(1.0, badRate + stdDev);
}

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

    // Each category evaluation is an independent, read-only TimescaleDB query
    // (no shared mutable state -- evaluateCategory only reads affectedDrive +
    // research and returns a fresh object). Run them concurrently and bound
    // wall-clock time by the slowest query rather than their sum. A slow or
    // failing category no longer blocks the others; failures are logged per
    // category via the settled result status.
    const settled = await Promise.allSettled(
      CANDIDATE_CATEGORIES.map((category) =>
        this.evaluateCategory(category, affectedDrive, research),
      ),
    );

    settled.forEach((res, idx) => {
      const category = CANDIDATE_CATEGORIES[idx];
      if (res.status === 'fulfilled') {
        if (res.value) {
          outcomes.push(res.value);
        }
      } else {
        this.logger.warn(
          `Simulation failed for category ${category}: ${
            res.reason instanceof Error ? res.reason.message : String(res.reason)
          }`,
        );
      }
    });

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

    vlog('simulation complete', {
      opportunityId: opportunity.payload.id,
      affectedDrive,
      outcomesEvaluated: outcomes.length,
      viableOutcomes: viableOutcomes.length,
      viable,
      bestOutcome: bestOutcome
        ? {
            category: bestOutcome.actionCategory,
            description: bestOutcome.description,
            estimatedDriveEffect: bestOutcome.estimatedDriveEffect,
            confidence: bestOutcome.confidenceEstimate,
            risk: bestOutcome.riskScore,
          }
        : null,
    });

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
      // No historical data: zero observations → confidence=0, risk=1.
      return {
        description: `New ${category} behavior (no historical data)`,
        actionCategory: category,
        estimatedDriveEffect: { [affectedDrive]: -0.02 } as Partial<Record<DriveName, number>>,
        confidenceEstimate: computeConfidence(0, 0),
        riskScore: computeRisk([]),
      };
    }

    // Aggregate drive effects from historical outcomes across ALL drives seen,
    // not just affectedDrive — collateral harm/benefit must be visible to the
    // planner. totalEffects accumulates count-weighted sums per drive name.
    const totalEffects = new Map<string, number>();
    let successCount = 0;
    let totalCount = 0;
    // Distinct effect values and their observation counts for weighted variance.
    const effectValues: number[] = [];
    const effectCounts: number[] = [];

    for (const row of result.rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const count = parseInt(row.count, 10);
      totalCount += count;

      const driveEffects = payload['driveEffects'];
      if (driveEffects && typeof driveEffects === 'object') {
        for (const [drive, effect] of Object.entries(driveEffects)) {
          if (typeof effect === 'number') {
            totalEffects.set(drive, (totalEffects.get(drive) ?? 0) + effect * count);
            // TK-64: capture per-observation values for the affected drive so
            // computeRisk can use variance-aware risk (alongside TK-63's
            // cross-drive aggregation into totalEffects).
            if (drive === affectedDrive) {
              effectValues.push(effect);
              effectCounts.push(count);
            }
          }
        }
      }

      if (payload['outcome'] === 'positive') {
        successCount += count;
      }
    }

    // Convert accumulated sums to per-drive averages (TK-63 cross-drive aggregation).
    const estimatedDriveEffect: Partial<Record<DriveName, number>> = {};
    for (const [drive, total] of totalEffects.entries()) {
      (estimatedDriveEffect as Record<string, number>)[drive] =
        totalCount > 0 ? total / totalCount : 0;
    }
    // Ensure affectedDrive is always present (mirrors conservative-estimate
    // behaviour and keeps the viable-outcome filter stable).
    if (!(affectedDrive in estimatedDriveEffect)) {
      estimatedDriveEffect[affectedDrive] = 0;
    }

    return {
      description: `${category} based on ${totalCount} historical outcomes`,
      actionCategory: category,
      estimatedDriveEffect,
      confidenceEstimate: computeConfidence(successCount, totalCount),
      riskScore: computeRisk(effectValues, effectCounts),
    };
  }
}

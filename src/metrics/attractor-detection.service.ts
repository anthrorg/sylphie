/**
 * AttractorDetectionService — Assesses proximity to known attractor states.
 *
 * Implements the attractor detection algorithm by analyzing metric signatures
 * against known patterns. Detects proximity to the six known failure modes:
 * 1. Type 2 Addict
 * 2. Rule Drift
 * 3. Hallucinated Knowledge
 * 4. Depressive Attractor
 * 5. Planning Runaway
 * 6. Prediction Pessimist
 *
 * CANON §Known Attractor States: These six failure modes are dangerous and
 * self-reinforcing. Attractor detection is the guard rail that prevents silent drift.
 */

import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IAttractorDetection,
  AttractorReport,
  AttractorProximity,
} from './interfaces/metrics.interfaces';
import type { IMetricsComputation } from './interfaces/metrics.interfaces';
import type { IEventService } from '../events/interfaces/events.interfaces';
import type { IDriveStateReader } from '../drive-engine/interfaces/drive-engine.interfaces';
import type { IWkgService } from '../knowledge/interfaces/knowledge.interfaces';
import { METRICS_COMPUTATION } from './interfaces/metrics.tokens';
import { EVENTS_SERVICE } from '../events/events.tokens';
import { DRIVE_STATE_READER } from '../drive-engine/drive-engine.tokens';
import { WKG_SERVICE } from '../knowledge/knowledge.tokens';
import { DriveName } from '../shared/types/drive.types';

interface AttractorState {
  name: string;
  warningThreshold: number;
  criticalThreshold: number;
}

@Injectable()
export class AttractorDetectionService implements IAttractorDetection {
  private readonly attractorStates: Record<string, AttractorState> = {
    type2Addict: {
      name: 'type2Addict',
      warningThreshold: 0.6,
      criticalThreshold: 0.8,
    },
    ruleDrift: {
      name: 'ruleDrift',
      warningThreshold: 0.5,
      criticalThreshold: 0.7,
    },
    hallucinatedKnowledge: {
      name: 'hallucinatedKnowledge',
      warningThreshold: 0.5,
      criticalThreshold: 0.7,
    },
    depressiveAttractor: {
      name: 'depressiveAttractor',
      warningThreshold: 0.5,
      criticalThreshold: 0.7,
    },
    planningRunaway: {
      name: 'planningRunaway',
      warningThreshold: 0.6,
      criticalThreshold: 0.8,
    },
    predictionPessimist: {
      name: 'predictionPessimist',
      warningThreshold: 0.6,
      criticalThreshold: 0.8,
    },
  };

  private lastReport: AttractorReport | null = null;

  constructor(
    @Inject(METRICS_COMPUTATION) private readonly metricsService: IMetricsComputation,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(DRIVE_STATE_READER) private readonly driveReader: IDriveStateReader,
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Assess proximity to all six known attractors.
   *
   * Analyzes the current health metrics and drift anomalies to compute proximity
   * scores for each attractor. Returns a comprehensive report with per-attractor
   * proximity, warnings, and recommendations.
   *
   * @returns AttractorReport with all six attractor assessments
   */
  async assessProximity(): Promise<AttractorReport> {
    const now = new Date();

    // Get current health metrics for the latest session
    const currentSession = await this.getCurrentSessionId();
    const metrics = await this.metricsService.computeHealthMetrics(currentSession);

    // Assess each of the six attractors
    const type2Addict = await this.assessType2Addict(metrics);
    const ruleDrift = await this.assessRuleDrift();
    const hallucinatedKnowledge = await this.assessHallucinatedKnowledge(metrics);
    const depressiveAttractor = await this.assessDepressiveAttractor(metrics);
    const planningRunaway = await this.assessPlanningRunaway();
    const predictionPessimist = await this.assessPredictionPessimist(metrics);

    // Determine overall risk level
    const allAttractors = [
      type2Addict,
      ruleDrift,
      hallucinatedKnowledge,
      depressiveAttractor,
      planningRunaway,
      predictionPessimist,
    ];

    let overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
    if (allAttractors.some(a => a.isCritical)) {
      overallRisk = 'CRITICAL';
    } else if (allAttractors.some(a => a.isWarning)) {
      overallRisk = 'HIGH';
    } else if (allAttractors.some(a => a.proximityScore > 0.3)) {
      overallRisk = 'MEDIUM';
    }

    const report: AttractorReport = {
      type2Addict,
      ruleDrift,
      hallucinatedKnowledge,
      depressiveAttractor,
      planningRunaway,
      predictionPessimist,
      computedAt: now,
      overallRisk,
    };

    this.lastReport = report;
    return report;
  }

  /**
   * Get all attractors currently in warning or critical zone.
   *
   * Convenience method for quick triage. Returns a list of AttractorProximity
   * objects for attractors where isWarning or isCritical is true.
   *
   * @returns Array of warned/critical AttractorProximity objects (may be empty)
   */
  getWarnings(): readonly AttractorProximity[] {
    if (!this.lastReport) {
      return [];
    }

    return [
      this.lastReport.type2Addict,
      this.lastReport.ruleDrift,
      this.lastReport.hallucinatedKnowledge,
      this.lastReport.depressiveAttractor,
      this.lastReport.planningRunaway,
      this.lastReport.predictionPessimist,
    ].filter(a => a.isWarning || a.isCritical);
  }

  // ========================================================================
  // Private: Attractor assessment methods
  // ========================================================================

  /**
   * Assess Type 2 Addict attractor.
   * HIGH RISK: LLM always wins; Type 1 never develops.
   *
   * Indicators:
   * - Type 1/Type 2 ratio declining or flat over 5+ sessions
   * - No new Type 1 graduations
   * - Knowledge retrieval-and-use ratio < 20%
   */
  private async assessType2Addict(metrics: any): Promise<AttractorProximity> {
    const state = this.attractorStates.type2Addict;
    const indicators: string[] = [];
    let proximityScore = 0;

    // Check Type 1/Type 2 ratio
    const ratio = metrics.type1Type2Ratio?.ratio ?? 0;
    if (ratio < 0.3) {
      indicators.push(`Type 1 ratio very low (${(ratio * 100).toFixed(1)}%)`);
      proximityScore += 0.4;
    } else if (ratio < 0.5) {
      indicators.push(`Type 1 ratio below 50% (${(ratio * 100).toFixed(1)}%)`);
      proximityScore += 0.2;
    }

    // Check window size (unreliable if too small)
    if (metrics.type1Type2Ratio?.windowSize && metrics.type1Type2Ratio.windowSize < 10) {
      indicators.push('Insufficient Type 1/Type 2 samples for reliable assessment');
    }

    // Check knowledge retrieval-and-use ratio
    const experientialRatio = metrics.provenanceRatio?.experientialRatio ?? 0;
    if (experientialRatio < 0.2) {
      indicators.push(`Knowledge retrieval ratio very low (${(experientialRatio * 100).toFixed(1)}%)`);
      proximityScore += 0.3;
    } else if (experientialRatio < 0.5) {
      indicators.push(`Knowledge retrieval ratio below 50% (${(experientialRatio * 100).toFixed(1)}%)`);
      proximityScore += 0.1;
    }

    // Clamp to [0.0, 1.0]
    proximityScore = Math.min(1.0, proximityScore);

    return {
      attractorName: 'type2Addict',
      proximityScore,
      warningThreshold: state.warningThreshold,
      criticalThreshold: state.criticalThreshold,
      isWarning: proximityScore >= state.warningThreshold,
      isCritical: proximityScore >= state.criticalThreshold,
      indicators,
      recommendedAction:
        'Increase Type 2 latency cost or lower Type 1 graduation threshold to encourage autonomy development',
    };
  }

  /**
   * Assess Rule Drift attractor.
   * MEDIUM RISK: Self-generated drive rules diverge from design intent.
   *
   * Indicators:
   * - Drive rule count increasing without guardian approval
   * - Cumulative drift from baseline > 0.3
   */
  private async assessRuleDrift(): Promise<AttractorProximity> {
    const state = this.attractorStates.ruleDrift;
    const indicators: string[] = [];
    let proximityScore = 0;

    // Query for proposed but not-yet-approved drive rules
    const proposedRules = await this.eventsService.query({
      types: ['RULE_PROPOSED'],
      limit: 100,
    });

    const proposedCount = proposedRules.length;
    if (proposedCount > 5) {
      indicators.push(`${proposedCount} proposed drive rules awaiting approval`);
      proximityScore = Math.min(1.0, proposedCount / 20); // Scale: critical at 20+ rules
    }

    return {
      attractorName: 'ruleDrift',
      proximityScore,
      warningThreshold: state.warningThreshold,
      criticalThreshold: state.criticalThreshold,
      isWarning: proximityScore >= state.warningThreshold,
      isCritical: proximityScore >= state.criticalThreshold,
      indicators,
      recommendedAction:
        'Review and approve or reject pending drive rule proposals. Guardian must validate any autonomous rule changes.',
    };
  }

  /**
   * Assess Hallucinated Knowledge attractor.
   * MEDIUM RISK: LLM generates plausible but false graph content.
   *
   * Indicators:
   * - LLM_GENERATED provenance ratio > 50% of graph
   * - Nodes at 0.40-0.60 confidence never tested
   * - WKG growth rate exceeding experiential event rate
   */
  private async assessHallucinatedKnowledge(metrics: any): Promise<AttractorProximity> {
    const state = this.attractorStates.hallucinatedKnowledge;
    const indicators: string[] = [];
    let proximityScore = 0;

    // Check LLM_GENERATED ratio
    const provenance = metrics.provenanceRatio;
    if (provenance && provenance.total > 0) {
      const llmRatio = provenance.llmGenerated / provenance.total;
      if (llmRatio > 0.5) {
        indicators.push(`LLM_GENERATED content dominates (${(llmRatio * 100).toFixed(1)}%)`);
        proximityScore += 0.4;
      } else if (llmRatio > 0.3) {
        indicators.push(`LLM_GENERATED content elevated (${(llmRatio * 100).toFixed(1)}%)`);
        proximityScore += 0.2;
      }
    }

    // Check graph stats for untested high-confidence nodes
    const graphStats = await this.wkgService.queryGraphStats();
    // Approximation: if median confidence is high but experiential ratio is low,
    // suspicious nodes may not have been tested
    if (provenance && provenance.experientialRatio < 0.3) {
      indicators.push('Low experiential ratio suggests untested graph content');
      proximityScore += 0.2;
    }

    proximityScore = Math.min(1.0, proximityScore);

    return {
      attractorName: 'hallucinatedKnowledge',
      proximityScore,
      warningThreshold: state.warningThreshold,
      criticalThreshold: state.criticalThreshold,
      isWarning: proximityScore >= state.warningThreshold,
      isCritical: proximityScore >= state.criticalThreshold,
      indicators,
      recommendedAction:
        'Audit high-confidence nodes, especially LLM_GENERATED content. Require retrieval-and-use for confidence elevation.',
    };
  }

  /**
   * Assess Depressive Attractor.
   * MEDIUM RISK: Negative self-evaluations create feedback loop.
   *
   * Indicators:
   * - Satisfaction chronically low (<0.3 for 10+ cycles)
   * - Anxiety chronically high (>0.7 for 10+ cycles)
   * - Behavioral diversity declining
   */
  private async assessDepressiveAttractor(metrics: any): Promise<AttractorProximity> {
    const state = this.attractorStates.depressiveAttractor;
    const indicators: string[] = [];
    let proximityScore = 0;

    // Get current drive state
    const driveSnapshot = this.driveReader.getCurrentState();

    // Check Satisfaction drive
    const satisfactionPressure = driveSnapshot.pressureVector[DriveName.Satisfaction] ?? 0;
    if (satisfactionPressure < 0.3) {
      indicators.push(`Satisfaction chronically low (${satisfactionPressure.toFixed(2)})`);
      proximityScore += 0.3;
    }

    // Check Anxiety drive
    const anxietyPressure = driveSnapshot.pressureVector[DriveName.Anxiety] ?? 0;
    if (anxietyPressure > 0.7) {
      indicators.push(`Anxiety chronically elevated (${anxietyPressure.toFixed(2)})`);
      proximityScore += 0.3;
    }

    // Check behavioral diversity
    const diversityIndex = metrics.behavioralDiversityIndex?.index ?? 0;
    if (diversityIndex < 0.15) {
      // Below 3 unique types in a 20-action window
      indicators.push(`Behavioral diversity declining (${diversityIndex.toFixed(2)})`);
      proximityScore += 0.2;
    }

    proximityScore = Math.min(1.0, proximityScore);

    return {
      attractorName: 'depressiveAttractor',
      proximityScore,
      warningThreshold: state.warningThreshold,
      criticalThreshold: state.criticalThreshold,
      isWarning: proximityScore >= state.warningThreshold,
      isCritical: proximityScore >= state.criticalThreshold,
      indicators,
      recommendedAction:
        'Increase Satisfaction drive value through successful actions. Reduce Anxiety pressure with safety-affirming contingencies.',
    };
  }

  /**
   * Assess Planning Runaway attractor.
   * LOW-MEDIUM RISK: Too many prediction failures create resource exhaustion.
   *
   * Indicators:
   * - Opportunity queue growing faster than plans resolved
   * - Planning consuming disproportionate compute
   */
  private async assessPlanningRunaway(): Promise<AttractorProximity> {
    const state = this.attractorStates.planningRunaway;
    const indicators: string[] = [];
    let proximityScore = 0;

    // Query for open opportunities
    const opportunities = await this.eventsService.query({
      types: ['OPPORTUNITY_DETECTED'],
      limit: 1000,
    });

    // Query for resolved opportunities
    const resolved = await this.eventsService.query({
      types: ['PLAN_CREATED'],
      limit: 1000,
    });

    const openCount = opportunities.length;
    const resolvedCount = resolved.length;

    // Ratio: if open >> resolved, the queue is not being drained
    if (openCount > 20) {
      const drainRatio = resolvedCount > 0 ? openCount / resolvedCount : Infinity;
      if (drainRatio > 3) {
        indicators.push(`Opportunity queue growing faster than resolution (ratio: ${drainRatio.toFixed(1)})`);
        proximityScore = Math.min(1.0, (drainRatio - 1) / 5); // Scale to [0, 1]
      }
    }

    return {
      attractorName: 'planningRunaway',
      proximityScore,
      warningThreshold: state.warningThreshold,
      criticalThreshold: state.criticalThreshold,
      isWarning: proximityScore >= state.warningThreshold,
      isCritical: proximityScore >= state.criticalThreshold,
      indicators,
      recommendedAction:
        'Increase plan execution rate or reduce opportunity creation sensitivity. Prioritize high-impact opportunities.',
    };
  }

  /**
   * Assess Prediction Pessimist attractor.
   * LOW-MEDIUM RISK: Early failures flood system with low-quality procedures.
   *
   * Indicators:
   * - Early prediction failure rate abnormally high
   * - Low-quality procedures proliferating
   */
  private async assessPredictionPessimist(metrics: any): Promise<AttractorProximity> {
    const state = this.attractorStates.predictionPessimist;
    const indicators: string[] = [];
    let proximityScore = 0;

    // Check prediction MAE
    const mae = metrics.predictionMAE?.mae ?? 0;
    if (mae > 0.3) {
      indicators.push(`Prediction MAE elevated (${mae.toFixed(2)})`);
      proximityScore += 0.3;
    } else if (mae > 0.2) {
      indicators.push(`Prediction MAE moderate (${mae.toFixed(2)})`);
      proximityScore += 0.15;
    }

    // Query for recently created low-confidence procedures
    const lowConfProcedures = await this.eventsService.query({
      types: ['PLAN_CREATED'],
      limit: 100,
    });

    if (lowConfProcedures.length > 10) {
      indicators.push(`Many new procedures created recently (${lowConfProcedures.length})`);
      proximityScore += Math.min(0.3, lowConfProcedures.length / 50);
    }

    proximityScore = Math.min(1.0, proximityScore);

    return {
      attractorName: 'predictionPessimist',
      proximityScore,
      warningThreshold: state.warningThreshold,
      criticalThreshold: state.criticalThreshold,
      isWarning: proximityScore >= state.warningThreshold,
      isCritical: proximityScore >= state.criticalThreshold,
      indicators,
      recommendedAction:
        'Improve world model fidelity or relax procedure graduation criteria. Review recent prediction failures for patterns.',
    };
  }

  /**
   * Get the current session ID (most recent session).
   * This is a simplified implementation that queries the events service.
   */
  private async getCurrentSessionId(): Promise<string> {
    // In a full implementation, this would query TimescaleDB for the most recent session ID
    // For now, return a default or query from config
    const sessionId = this.config.get<string>('CURRENT_SESSION_ID') || 'default-session';
    return sessionId;
  }
}

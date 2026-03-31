/**
 * PlanEvaluationService — implements plan execution evaluation.
 *
 * Evaluates the outcomes of executed procedures by comparing predicted drive
 * effects (from the original plan proposal) against actual recorded drive
 * deltas from the Decision Making cycle.
 *
 * This feedback drives ACT-R confidence dynamics and helps identify systematic
 * prediction failures that may warrant new planning cycles.
 *
 * Provided under the PLAN_EVALUATION_SERVICE token by PlanningModule.
 * Internal — not exported from the module barrel.
 */

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../shared/config/app.config';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { createPlanningEvent } from '../../events/builders/event-builders';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import type { DriveName } from '../../shared/types/drive.types';
import {
  computeConfidence,
  applyGuardianWeight,
  qualifiesForGraduation,
  qualifiesForDemotion,
  DEFAULT_DECAY_RATES,
} from '../../shared/types/confidence.types';
import type { PlanEvaluation } from '../interfaces/planning.interfaces';
import type { ACTRParams } from '../../shared/types/confidence.types';

@Injectable()
export class PlanEvaluationService {
  constructor(
    private readonly configService: ConfigService,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
    @Inject(DRIVE_STATE_READER) private readonly driveStateReader: IDriveStateReader,
  ) {}

  /**
   * Evaluate the execution outcome of a procedure against its predictions.
   *
   * Compares predicted vs actual drive effects, updates confidence via ACT-R,
   * checks graduation/demotion eligibility, and emits evaluation events.
   *
   * @param procedureId - WKG node ID of the executed procedure.
   * @param actualDriveEffects - Actual recorded drive deltas from the execution.
   * @param guardianFeedback - Optional guardian feedback (confirmation or correction).
   * @returns Evaluation result containing prediction accuracy metrics.
   */
  async evaluateExecution(
    procedureId: string,
    actualDriveEffects: Partial<Record<DriveName, number>>,
    guardianFeedback?: 'confirmation' | 'correction',
  ): Promise<PlanEvaluation> {
    // Load procedure from WKG
    const procedure = await this.wkgService.findNode(procedureId);
    if (!procedure) {
      throw new Error(`Procedure not found: ${procedureId}`);
    }

    // Extract expected drive effects from procedure node properties
    const expectedDriveEffects = this.extractExpectedEffects(procedure);

    // Compare expected vs actual and compute MAE
    const mae = this.computeMAE(expectedDriveEffects, actualDriveEffects);

    // Classify outcome
    const outcome = this.classifyOutcome(mae);

    // Load current ACTRParams from procedure node
    const currentACTRParams = this.extractACTRParams(procedure);

    // Use recordRetrievalAndUse to handle confidence updates properly
    const success = outcome !== 'failure';
    await this.wkgService.recordRetrievalAndUse(procedureId, success);

    // If guardian feedback present, apply additional weighting
    let newConfidence = computeConfidence(currentACTRParams);
    if (guardianFeedback && guardianFeedback === 'correction') {
      // Correction: apply negative feedback weight
      newConfidence = Math.max(0, newConfidence - applyGuardianWeight(0.15, 'correction'));
    } else if (guardianFeedback && guardianFeedback === 'confirmation') {
      // Confirmation: apply positive feedback weight
      newConfidence = Math.min(1, newConfidence + applyGuardianWeight(0.15, 'confirmation'));
    } else {
      // No guardian feedback: use the standard computed confidence
      newConfidence = computeConfidence(currentACTRParams);
    }

    // Check graduation/demotion eligibility
    const recentMAEs = await this.queryRecentMAEs(procedureId);
    const graduationEligible = recentMAEs.length >= 10 && qualifiesForGraduation(newConfidence, this.computeAverageMAE(recentMAEs));
    const demotionTriggered = recentMAEs.length >= 10 && qualifiesForDemotion(this.computeAverageMAE(recentMAEs));

    // Get drive snapshot for event
    const driveSnapshot = this.driveStateReader.getCurrentState();
    const appConfig = this.configService.get<AppConfig>('app');
    const sessionId = (appConfig?.app?.sessionId ?? 'unknown-session') as string;

    // Emit PLAN_EVALUATION event always
    const evaluationEvent = (createPlanningEvent as any)('PLAN_EVALUATION', {
      sessionId,
      driveSnapshot,
      data: {
        procedureId,
        mae,
        outcome,
        newConfidence,
        guardianFeedbackApplied: !!guardianFeedback,
      },
    });
    await this.eventsService.record(evaluationEvent);

    // Emit PLAN_FAILURE event if failure
    if (outcome === 'failure') {
      const failureEvent = (createPlanningEvent as any)('PLAN_FAILURE', {
        sessionId,
        driveSnapshot,
        data: {
          procedureId,
          mae,
        },
      });
      await this.eventsService.record(failureEvent);
    }

    const result: PlanEvaluation = {
      mae,
      successCount: outcome === 'success' ? 1 : 0,
      failureCount: outcome === 'failure' ? 1 : 0,
      newConfidence,
    };

    return result;
  }

  /**
   * Extract expected drive effects from a procedure node.
   */
  private extractExpectedEffects(
    procedure: any,
  ): Partial<Record<DriveName, number>> {
    // Expected effects may be stored in expectedOutcome or actionSequence
    if (procedure.properties?.expectedDriveEffects) {
      return procedure.properties.expectedDriveEffects;
    }
    return {};
  }

  /**
   * Extract ACTRParams from a procedure node.
   */
  private extractACTRParams(procedure: any): ACTRParams {
    if (procedure.actrParams) {
      return procedure.actrParams;
    }
    // Fallback to LLM_GENERATED defaults if not set
    return {
      base: 0.35,
      count: 0,
      decayRate: DEFAULT_DECAY_RATES['LLM_GENERATED'],
      lastRetrievalAt: null,
    };
  }

  /**
   * Compute Mean Absolute Error between expected and actual drive effects.
   */
  private computeMAE(
    expected: Partial<Record<DriveName, number>>,
    actual: Partial<Record<DriveName, number>>,
  ): number {
    // Get all drive names that appear in either map
    const driveNames = new Set<string>();
    Object.keys(expected).forEach((d) => driveNames.add(d));
    Object.keys(actual).forEach((d) => driveNames.add(d));

    if (driveNames.size === 0) {
      return 0;
    }

    let totalError = 0;
    Array.from(driveNames).forEach((drive) => {
      const exp = expected[drive as DriveName] ?? 0;
      const act = actual[drive as DriveName] ?? 0;
      totalError += Math.abs(exp - act);
    });

    return totalError / driveNames.size;
  }

  /**
   * Classify outcome based on MAE.
   */
  private classifyOutcome(mae: number): 'success' | 'partial' | 'failure' {
    if (mae < 0.1) {
      return 'success';
    }
    if (mae <= 0.15) {
      return 'partial';
    }
    return 'failure';
  }

  /**
   * Query recent MAE values from PLAN_EVALUATION events for this procedure.
   */
  private async queryRecentMAEs(procedureId: string): Promise<number[]> {
    // This would normally query TimescaleDB for recent PLAN_EVALUATION events
    // For now, return empty array (no history) — in production, implement proper event query
    return [];
  }

  /**
   * Compute average MAE from a list of MAE values.
   */
  private computeAverageMAE(maes: number[]): number {
    if (maes.length === 0) {
      return 0;
    }
    return maes.reduce((sum, mae) => sum + mae, 0) / maes.length;
  }
}

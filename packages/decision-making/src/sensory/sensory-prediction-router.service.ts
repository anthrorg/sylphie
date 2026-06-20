/**
 * SensoryPredictionRouterService — Routes sensory and scene prediction errors
 * to the Drive Engine.
 *
 * Extracted from DecisionMakingService (EP7-B, TK-32). Owns the two routing
 * methods that were formerly private on DecisionMakingService. Behavior is
 * byte-identical to the original inline code.
 *
 * Stateless modulo the two injected collaborators:
 *   - actionOutcomeReporter: fire-and-forget IPC to the Drive Engine.
 *   - scenePrediction:       records routed outcomes for gate observability.
 *
 * Logger name is deliberately set to DecisionMakingService so that log lines
 * remain byte-identical to the pre-extraction golden (AC3).
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ACTION_OUTCOME_REPORTER, type IActionOutcomeReporter } from '@sylphie/drive-engine';
import type { DriveSnapshot } from '@sylphie/shared';
import { ScenePredictionService, type ScenePredictionResult } from '../prediction/scene-prediction.service';

// Must match the source module so that emitted log lines are byte-identical.
const LOGGER_CONTEXT = 'DecisionMakingService';

@Injectable()
export class SensoryPredictionRouterService {
  // Logger context matches the original so log lines are byte-identical (AC3).
  private readonly logger = new Logger(LOGGER_CONTEXT);

  constructor(
    // Optional so the routing path degrades gracefully when the drive engine
    // is not wired (e.g., in unit tests that don't exercise the reporter path).
    @Optional()
    @Inject(ACTION_OUTCOME_REPORTER)
    private readonly actionOutcomeReporter: IActionOutcomeReporter | null,

    private readonly scenePrediction: ScenePredictionService,
  ) {}

  /**
   * Route per-modality sensory prediction errors to drives.
   *
   * Text changes → curiosity (novel information to process).
   * Audio changes → curiosity + focus (unexpected sound demands attention).
   * Video changes → anxiety + focus (environment shifted).
   */
  routeSensoryPredictionErrors(
    errors: Record<string, number>,
    snapshot: DriveSnapshot,
  ): void {
    const totalError = Object.values(errors).reduce((sum, e) => sum + e, 0);
    if (totalError < 0.05) return; // negligible

    if (this.actionOutcomeReporter) {
      try {
        this.actionOutcomeReporter.reportOutcome({
          actionId: 'sensory-prediction',
          actionType: 'SensoryPrediction',
          success: totalError < 0.3,
          metadata: { sensoryPredictionError: totalError },
          feedbackSource: 'INFERENCE',
          theaterCheck: {
            expressionType: 'none',
            correspondingDrive: null,
            driveValue: null,
            isTheatrical: false,
          },
        });
      } catch (err) {
        this.logger.warn(`Sensory prediction error routing failed: ${err}`);
      }
    }
  }

  /**
   * Route per-object scene prediction errors to drives.
   *
   * Novel person → curiosity + social.
   * Person left → mild anxiety.
   * Unknown face → curiosity + focus.
   * Known face identified → social (slight).
   * General scene instability → curiosity.
   *
   * WS5 T1.0: takes the ALREADY-COMPUTED comparison (cached early this cycle),
   * NOT a snapshot to recompute. The caller advances predictions exactly once
   * after this returns. This is the only place scene surprise reaches drives
   * (Curiosity/Anxiety) — the encode-attention saliency term (T1.0) deliberately
   * does NOT, so the perception→drive loop is broken, not relocated (ashby).
   */
  routeScenePredictionErrors(
    result: ScenePredictionResult,
    _snapshot: DriveSnapshot,
  ): void {
    if (result.totalSurprise < 0.05) return;

    if (this.actionOutcomeReporter) {
      try {
        this.actionOutcomeReporter.reportOutcome({
          actionId: 'scene-prediction',
          actionType: 'ScenePrediction',
          success: result.totalSurprise < 0.2,
          metadata: { sceneSurprise: result.totalSurprise },
          feedbackSource: 'INFERENCE',
          theaterCheck: {
            expressionType: 'none',
            correspondingDrive: null,
            driveValue: null,
            isTheatrical: false,
          },
        });
        // WS5 P1a gate seam: record the routed outcome so the gate can assert on
        // the CAUSAL drive effect (computedEffects.curiosity>0, anxiety>0) without
        // polling the noisy net drive-vector delta. Called AFTER reportOutcome so
        // the seam reflects what was actually sent, not a speculative pre-call.
        this.scenePrediction.recordOutcomeRouted(result.totalSurprise);
      } catch (err) {
        this.logger.warn(`Scene prediction error routing failed: ${err}`);
      }
    }
  }
}

/**
 * PlanEvaluationService -- Post-execution evaluation of Planning-created procedures.
 *
 * CANON SS Subsystem 5 (Planning): After a Planning-created procedure (provenance
 * INFERENCE) executes, this service logs the outcome for traceability.
 *
 * NOTE: This service does NOT update the procedure's ACT-R confidence directly.
 * Confidence updates are handled by Decision Making's ConfidenceUpdaterService,
 * which reads from the same event stream. This service is responsible only for
 * logging the PLAN_EVALUATION or PLAN_FAILURE event.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import type {
  IPlanEvaluationService,
  PlanOutcomeData,
  IPlanningEventLogger,
} from '../interfaces/planning.interfaces';
import { PLANNING_EVENT_LOGGER } from '../planning.tokens';

@Injectable()
export class PlanEvaluationService implements IPlanEvaluationService {
  private readonly logger = new Logger(PlanEvaluationService.name);

  constructor(
    @Inject(PLANNING_EVENT_LOGGER)
    private readonly eventLogger: IPlanningEventLogger,
  ) {}

  async evaluateOutcome(procedureId: string, outcome: PlanOutcomeData): Promise<void> {
    if (outcome.executionSuccessful) {
      this.eventLogger.log('PLAN_EVALUATION', {
        procedureId,
        executionSuccessful: true,
        predictionAccurate: outcome.predictionAccurate,
        driveEffectsObserved: outcome.driveEffectsObserved,
      });

      this.logger.debug(
        `Plan evaluation: ${procedureId} executed successfully ` +
          `(prediction accurate: ${outcome.predictionAccurate})`,
      );
    } else {
      this.eventLogger.log('PLAN_FAILURE', {
        procedureId,
        executionSuccessful: false,
        predictionAccurate: outcome.predictionAccurate,
        driveEffectsObserved: outcome.driveEffectsObserved,
      });

      this.logger.warn(`Plan failure: ${procedureId} execution failed`);
    }
  }
}

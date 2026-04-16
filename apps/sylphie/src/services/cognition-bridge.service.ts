/**
 * CognitionBridgeService — lightweight observer for tensor/LLM agreement logging.
 *
 * Tensor inference and training sample submission now happen IN the decision
 * loop (DecisionMakingService.processInput() → ITensorInferenceService).
 * This bridge retains only two responsibilities:
 *
 *   1. Subscribe to response$ to log tensor vs LLM agreement for diagnostics.
 *   2. Expose the most recent sidecar result via getLastResult() for any
 *      service that needs to inspect tensor output after the cycle.
 *
 * The bridge NEVER calls the sidecar itself — that's TensorInferenceAdapter's job.
 */

import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Subscription } from 'rxjs';
import { type CycleResponse, verboseFor } from '@sylphie/shared';
import {
  DECISION_MAKING_SERVICE,
  type IDecisionMakingService,
} from '@sylphie/decision-making';

const vlog = verboseFor('CognitionBridge');

@Injectable()
export class CognitionBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CognitionBridgeService.name);
  private subscription: Subscription | null = null;

  constructor(
    @Inject(DECISION_MAKING_SERVICE)
    private readonly decisionMaking: IDecisionMakingService,
  ) {}

  onModuleInit() {
    this.subscription = this.decisionMaking.response$.subscribe({
      next: (cycle) => this.onCycleResponse(cycle),
    });
    this.logger.log('CognitionBridge active — observing decision cycles');
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }

  /**
   * Log tensor influence on the completed cycle for diagnostics.
   */
  private onCycleResponse(cycle: CycleResponse): void {
    // Log tensor metadata if present (added by DecisionMakingService)
    if (cycle.tensorTopCategory) {
      vlog('cycle completed with tensor', {
        arbitrationType: cycle.arbitrationType,
        tensorTopCategory: cycle.tensorTopCategory,
        tensorConsensus: cycle.tensorConsensus,
        bootstrapMode: cycle.bootstrapMode,
      });
    }
  }
}

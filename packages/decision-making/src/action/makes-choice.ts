import { Injectable, Logger } from '@nestjs/common';
import { SensoryFrame } from '@sylphie/shared';
import { ActionCandidate } from '../reasoning/type-1.handler';
import { Prediction } from '../prediction/make-prediction';

export interface TickEvent {
  timestamp: number;
  frame: SensoryFrame;
  chosenAction: ActionCandidate;
  predictions: Prediction[];
}

/**
 * Final action selection. Emits tick event to TimescaleDB and drive engine.
 */
@Injectable()
export class MakesChoiceService {
  private readonly logger = new Logger(MakesChoiceService.name);

  async commit(
    frame: SensoryFrame,
    action: ActionCandidate,
    predictions: Prediction[],
  ): Promise<TickEvent> {
    this.logger.debug(`Committing action: ${action.actionId}`);
    // TODO: Write tick event to TimescaleDB, emit to drive engine
    return {
      timestamp: Date.now(),
      frame,
      chosenAction: action,
      predictions,
    };
  }
}

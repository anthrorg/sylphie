import { Injectable, Logger } from '@nestjs/common';
import { SensoryFrame } from '@sylphie/shared';
import { MonologueOutput } from '../monologue/inner-monologue';
import { ActionCandidate } from './type-1.handler';

/**
 * Type 2 path — effortful thinking, planning, LLM-assisted.
 * Used when Type 1 can't produce a high-confidence response,
 * or when failed predictions shift weight toward deliberation.
 */
@Injectable()
export class Type2Handler {
  private readonly logger = new Logger(Type2Handler.name);

  async evaluate(
    frame: SensoryFrame,
    monologue: MonologueOutput,
  ): Promise<ActionCandidate | null> {
    this.logger.debug('Evaluating Type 2 (deliberative) path');
    // TODO: LLM-assisted reasoning, planning integration
    return null;
  }
}

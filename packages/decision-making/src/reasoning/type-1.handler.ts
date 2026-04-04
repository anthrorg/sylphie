import { Injectable, Logger } from '@nestjs/common';
import { SensoryFrame } from '@sylphie/shared';
import { MonologueOutput } from '../monologue/inner-monologue';

export interface ActionCandidate {
  /** Identifier for the action */
  actionId: string;
  /** Human-readable description */
  description: string;
  /** Confidence that this is the right action (0–1) */
  confidence: number;
  /** Which path proposed this */
  source: 'type1' | 'type2';
}

/**
 * Type 1 path — reflex, high-confidence actions.
 * Fast pattern matching against known responses.
 * Must convince the reasoning engine it's better than Type 2.
 */
@Injectable()
export class Type1Handler {
  private readonly logger = new Logger(Type1Handler.name);

  async evaluate(
    frame: SensoryFrame,
    monologue: MonologueOutput,
  ): Promise<ActionCandidate | null> {
    this.logger.debug('Evaluating Type 1 (reflex) path');
    // TODO: Pattern match against known high-confidence responses
    return null;
  }
}

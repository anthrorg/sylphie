import { Injectable, Logger } from '@nestjs/common';
import { ActionCandidate } from './type-1.handler';

/**
 * Evaluates Type 1 vs Type 2 candidates.
 * Type 1 must convince this engine it's better than Type 2.
 */
@Injectable()
export class ReasoningEngine {
  private readonly logger = new Logger(ReasoningEngine.name);

  async evaluate(
    type1Candidate: ActionCandidate | null,
    type2Candidate: ActionCandidate | null,
  ): Promise<ActionCandidate | null> {
    this.logger.debug('Reasoning engine evaluating candidates');

    if (!type1Candidate && !type2Candidate) return null;
    if (!type1Candidate) return type2Candidate;
    if (!type2Candidate) return type1Candidate;

    // TODO: Implement proper arbitration logic
    // Type 1 must have higher confidence to win over Type 2
    return type1Candidate.confidence > type2Candidate.confidence
      ? type1Candidate
      : type2Candidate;
  }
}

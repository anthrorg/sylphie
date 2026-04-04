import { Injectable, Logger } from '@nestjs/common';
import { SensoryFrame } from '@sylphie/shared';

export interface MonologueOutput {
  /** Natural-language reasoning trace */
  narrative: string;
  /** Suggested action candidates surfaced from episodic memory + WKG */
  suggestedActions: string[];
  /** Confidence in the current situational understanding (0–1) */
  situationalConfidence: number;
}

/**
 * Inner monologue — reads episodic memory (TimescaleDB) and WKG (Neo4j)
 * to formulate reasoning about what to do. Feeds the executor engine.
 */
@Injectable()
export class InnerMonologueService {
  private readonly logger = new Logger(InnerMonologueService.name);

  async process(frame: SensoryFrame): Promise<MonologueOutput> {
    this.logger.debug('Processing inner monologue');
    // TODO: Read episodic memory + WKG, formulate reasoning
    return {
      narrative: '',
      suggestedActions: [],
      situationalConfidence: 0,
    };
  }
}

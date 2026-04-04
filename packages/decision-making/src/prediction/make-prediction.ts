import { Injectable, Logger } from '@nestjs/common';
import { SensoryFrame } from '@sylphie/shared';

export interface Prediction {
  /** What is predicted to happen */
  description: string;
  /** Expected drive state changes */
  expectedDriveDeltas: number[];
  /** Confidence in this prediction (0–1) */
  confidence: number;
  /** Timestamp when prediction was made */
  madeAt: number;
}

/**
 * Generates predictions from the WKG based on current sensory state.
 * Multiple predictions can run simultaneously.
 */
@Injectable()
export class MakePredictionService {
  private readonly logger = new Logger(MakePredictionService.name);

  async predict(frame: SensoryFrame): Promise<Prediction[]> {
    this.logger.debug('Generating predictions from WKG');
    // TODO: Read WKG, generate predictions based on current state
    return [];
  }
}

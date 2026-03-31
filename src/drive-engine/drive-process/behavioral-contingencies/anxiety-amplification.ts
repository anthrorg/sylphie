/**
 * Anxiety Amplification Contingency
 *
 * CANON §A.15 Behavioral Contingency — Anxiety Amplification:
 * When anxiety is elevated (>0.7) at the time of action dispatch,
 * and the outcome is negative, the confidence reduction is amplified 1.5x.
 *
 * This creates a behavioral pattern: under stress, failures hit harder,
 * reinforcing more cautious behavior until anxiety decreases.
 *
 * This is a Type 1 computation — no blocking calls, pure arithmetic.
 */

/**
 * AnxietyAmplification: Computes amplified confidence reductions under stress.
 */
export class AnxietyAmplification {
  /**
   * Compute amplified confidence reduction based on anxiety level and outcome.
   *
   * Implements CANON §A.15:
   * If anxiety > 0.7 AND outcome is 'failure', reduction *= 1.5
   *
   * @param anxietyAtExecution - Anxiety value (0.0 to 1.0) at time of action
   * @param outcome - 'positive' or 'negative'
   * @param baseReduction - The base reduction amount before amplification
   * @returns Amplified reduction amount (or base if no amplification)
   */
  public amplifyReduction(
    anxietyAtExecution: number,
    outcome: string,
    baseReduction: number,
  ): number {
    // Only amplify on negative outcomes
    if (outcome !== 'negative') {
      return baseReduction;
    }

    // Only amplify if anxiety was elevated (>0.7)
    if (anxietyAtExecution <= 0.7) {
      return baseReduction;
    }

    // Apply 1.5x amplification
    return baseReduction * 1.5;
  }
}

/**
 * Singleton instance for the drive process.
 */
let instance: AnxietyAmplification | null = null;

export function getOrCreateAnxietyAmplification(): AnxietyAmplification {
  if (!instance) {
    instance = new AnxietyAmplification();
  }
  return instance;
}

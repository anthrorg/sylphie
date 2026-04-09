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
 * Drive effects (applied via applyContingencies):
 * - High anxiety + negative outcome: amplify all negative drive deltas by 1.5x.
 *   This makes failures under stress more impactful, pushing toward caution.
 * - High anxiety + positive outcome: provide anxiety relief (-0.10).
 *   Successfully acting despite stress reduces anxiety (builds confidence).
 *
 * This is a Type 1 computation — no blocking calls, pure arithmetic.
 */

import { DriveName, verboseFor } from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');

/** Threshold above which anxiety is considered elevated. */
const ANXIETY_THRESHOLD = 0.7;

/** Amplification factor for negative drive effects under high anxiety. */
const NEGATIVE_AMPLIFICATION_FACTOR = 1.5;

/** Anxiety relief granted when a positive outcome occurs under high anxiety. */
const ANXIETY_RELIEF_ON_SUCCESS = -0.10;

/**
 * AnxietyAmplification: Computes amplified confidence reductions under stress
 * AND produces drive-level effects for the contingency coordinator.
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
    if (anxietyAtExecution <= ANXIETY_THRESHOLD) {
      return baseReduction;
    }

    // Apply 1.5x amplification
    vlog('anxiety amplification fired', {
      anxietyAtExecution,
      outcome,
      baseReduction,
      amplifiedReduction: baseReduction * NEGATIVE_AMPLIFICATION_FACTOR,
      factor: NEGATIVE_AMPLIFICATION_FACTOR,
    });
    return baseReduction * NEGATIVE_AMPLIFICATION_FACTOR;
  }

  /**
   * Compute drive-level effects from anxiety amplification.
   *
   * Called by the ContingencyCoordinator during applyContingencies().
   * Two behavioral effects:
   *
   * 1. High anxiety + negative outcome: amplify all existing negative drive
   *    effects by 1.5x. The amplified portion is returned as additional deltas.
   *    This makes failures under stress hurt more, reinforcing cautious behavior.
   *
   * 2. High anxiety + positive outcome: provide anxiety relief (-0.10).
   *    Successfully acting under stress demonstrates competence and reduces
   *    future anxiety in similar contexts.
   *
   * @param anxietyAtExecution - Anxiety level at time of action dispatch
   * @param outcome - 'positive' or 'negative'
   * @param existingDriveEffects - The drive effects already computed by the
   *   outcome payload (before contingencies). These are what get amplified.
   * @returns Partial map of additional drive deltas from anxiety amplification
   */
  public computeDriveEffects(
    anxietyAtExecution: number,
    outcome: 'positive' | 'negative',
    existingDriveEffects: Partial<Record<DriveName, number>>,
  ): Partial<Record<DriveName, number>> {
    // No effect if anxiety is not elevated
    if (anxietyAtExecution <= ANXIETY_THRESHOLD) {
      return {};
    }

    const deltas: Partial<Record<DriveName, number>> = {};

    if (outcome === 'negative') {
      // Amplify negative drive effects: for each negative delta in the outcome,
      // add an additional 0.5x of that delta (total becomes 1.5x of original).
      // We return only the ADDITIONAL portion — the base is already applied
      // by the normal outcome processing.
      for (const [drive, value] of Object.entries(existingDriveEffects)) {
        if (value !== undefined && value > 0) {
          // Positive delta = pressure increase (a bad effect).
          // Amplify it by adding 50% more.
          const amplification = value * (NEGATIVE_AMPLIFICATION_FACTOR - 1.0);
          deltas[drive as DriveName] = amplification;
        }
      }

      if (Object.keys(deltas).length > 0) {
        vlog('anxiety amplification drive effects (negative outcome)', {
          anxietyAtExecution,
          outcome,
          amplifiedDrives: deltas,
        });
      }
    } else {
      // Positive outcome under high anxiety: provide anxiety relief.
      // Acting successfully despite stress is a learning signal that
      // reduces anxiety for future similar situations.
      deltas[DriveName.Anxiety] = ANXIETY_RELIEF_ON_SUCCESS;

      vlog('anxiety amplification drive effects (positive outcome)', {
        anxietyAtExecution,
        outcome,
        anxietyRelief: ANXIETY_RELIEF_ON_SUCCESS,
      });
    }

    return deltas;
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

/**
 * Per-identity habituation for sustained visual-presence drive pressure.
 *
 * TK-97 — mirrors the ScenePredictionService's AD-0005 familiarity curve:
 *
 *   attenuationFactor(id) = 1 / (1 + HABITUATION_K * exposureCount(id))
 *
 * count=0 (first appearance) → factor=1.0 (full pressure);
 * count=10 → 1/(1+0.6*10)=0.143 (86% attenuation);
 * count=∞ → 0 (identity is fully familiar, no sustained pressure).
 *
 * Crucially, this is PER-IDENTITY — a genuinely new object/person that
 * enters the scene for the first time still fires at full factor=1.0,
 * preserving novelty detection and curiosity/exploration behaviour.
 *
 * The exposure count for each identity is incremented once per cognitive
 * cycle in which that identity is present. Identities that leave the scene
 * (drop out of the undiscovered/unknown sets) retain their count: when they
 * re-enter, they are still habituated (keyed by stable VWM entity ID, just
 * as ScenePredictionService keys on personId-else-label, not trackId).
 *
 * Design choice (AC1): habituation-ONLY, no floor adjustment.  The
 * IDLE_PRESSURE_THRESHOLD (4.0) is unchanged.  After full habituation the
 * sustained-visual-presence contribution approaches 0, so total drive
 * pressure is driven only by the baseline accumulation rates
 * (Curiosity=0.0012/s, Boredom=0.0015/s, Social=0.0009/s, Anxiety=0.0003/s)
 * which do NOT hold pressure above 4.0 in isolation.  A static familiar
 * scene therefore no longer pins the system above the self-tick threshold.
 *
 * Telemetry: computeAttenuatedCount() logs the raw→attenuated count
 * reduction to the DEBUG stream; integration tests assert on the
 * DRIVE_RULE_APPLIED events that reach the drive engine.
 */

import { Injectable, Logger } from '@nestjs/common';

/**
 * Decay constant — must stay in sync with ScenePredictionService (AD-0005).
 * k=0.6: first repeat drops factor from 1.0 to 0.625 (37.5% reduction).
 * Tuning parameter — see ScenePredictionService.FAMILIARITY_DECAY_K comment.
 */
const HABITUATION_K = 0.6;

@Injectable()
export class VisualPresenceHabituatorService {
  private readonly logger = new Logger(VisualPresenceHabituatorService.name);

  /**
   * Per-identity exposure counts (entityId → number of cycles seen).
   * Keyed on the stable VWM entity.id so counts survive trackId reassignments.
   */
  private readonly exposureCounts = new Map<string, number>();

  /**
   * Compute the attenuated effective count for a set of present identities
   * and increment each identity's exposure count for this cycle.
   *
   * Returns the sum of per-identity attenuation factors (∈ [0, n] where n is
   * the number of identities).  Callers multiply this by the per-unit pressure
   * coefficient — the attenuated effective count replaces the raw count in the
   * ACTION_OUTCOME metadata sent to the drive engine.
   *
   * A raw count of zero is returned immediately without mutation so that the
   * drive engine receives no signal for an empty set.
   *
   * @param ids       Stable entity IDs currently in the set (undiscovered
   *                  objects OR unknown persons — call once per category).
   * @param category  Label for telemetry only ('object' | 'person').
   * @returns The attenuated effective count (a float, not an integer).
   */
  computeAttenuatedCount(ids: readonly string[], category: 'object' | 'person'): number {
    if (ids.length === 0) return 0;

    let attenuatedSum = 0;

    for (const id of ids) {
      const count = this.exposureCounts.get(id) ?? 0;
      const factor = 1 / (1 + HABITUATION_K * count);
      attenuatedSum += factor;

      // Increment AFTER reading so the first exposure uses factor=1.0
      this.exposureCounts.set(id, count + 1);
    }

    this.logger.debug(
      `[visual-habituation] ${category}: rawCount=${ids.length} attenuated=${attenuatedSum.toFixed(4)} ` +
        `(counts: ${ids.map(id => `${id.slice(-6)}×${this.exposureCounts.get(id)}`).join(', ')})`,
    );

    return attenuatedSum;
  }

  /**
   * Reset all per-identity exposure counts (e.g. on session reset).
   * Ensures a fresh session starts with full novelty pressure.
   */
  reset(): void {
    this.exposureCounts.clear();
    this.logger.debug('[visual-habituation] exposure counts cleared (session reset)');
  }

  /**
   * Read-only snapshot for testing/telemetry.
   * Returns a plain object keyed by entity ID → exposure count.
   */
  getExposureCounts(): Record<string, number> {
    return Object.fromEntries(this.exposureCounts);
  }
}

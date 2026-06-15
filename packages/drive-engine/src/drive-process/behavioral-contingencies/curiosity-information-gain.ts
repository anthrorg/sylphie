/**
 * Curiosity Information Gain Contingency
 *
 * CANON §A.14 Behavioral Contingency — Curiosity Information Gain:
 * Curiosity drive is relieved proportional to actual new information gained.
 *
 * Information gain sources:
 *   - New nodes: +0.05 per node
 *   - Confidence deltas: +0.10 per unit increase (new confidence)
 *   - Resolved prediction errors: +0.15 per error
 *
 * Revisiting known territory produces ~0 relief (no new information).
 *
 * For now (before WKG is accessible in child process), this accepts parameters
 * directly or extracts from ACTION_OUTCOME context.
 *
 * This is a Type 1 computation — no blocking calls, pure arithmetic.
 */

import { DriveName, verboseFor } from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');

/**
 * Information gain metrics from a learning event.
 */
export interface InformationGainMetrics {
  newNodes: number;
  confidenceDeltas: number; // Sum of positive confidence changes
  resolvedErrors: number;
}

/**
 * CuriosityInformationGain: Computes curiosity relief based on learning outcome.
 */
export class CuriosityInformationGain {
  /**
   * Compute curiosity relief based on information gained.
   *
   * Relief formula:
   *   relief = (newNodes * 0.05) + (confidenceDeltas * 0.10) + (resolvedErrors * 0.15)
   *
   * @param newNodes - Number of new WKG nodes created in this outcome
   * @param confidenceDeltas - Sum of positive confidence increases (for existing nodes)
   * @param resolvedErrors - Number of prediction errors that were resolved
   * @returns Relief amount (negative value = curiosity satisfied)
   */
  public computeRelief(
    newNodes: number,
    confidenceDeltas: number,
    resolvedErrors: number,
  ): number {
    // Clamp inputs to non-negative
    const safeNewNodes = Math.max(0, newNodes);
    const safeConfidenceDeltas = Math.max(0, confidenceDeltas);
    const safeResolvedErrors = Math.max(0, resolvedErrors);

    // Information gain formula
    const relief =
      safeNewNodes * 0.05 + safeConfidenceDeltas * 0.1 + safeResolvedErrors * 0.15;

    // Return negative value (relief = drive reduction)
    if (relief > 0) {
      vlog('curiosity information gain', {
        newNodes: safeNewNodes,
        confidenceDeltas: safeConfidenceDeltas,
        resolvedErrors: safeResolvedErrors,
        relief: -relief,
      });
    }
    return -relief;
  }

  /**
   * Compute curiosity relief from an ActionOutcomePayload's informationGainMetrics.
   *
   * HONESTY GATE (Ticket 2 / §A.14 + CANON Standard 2): curiosity relief is
   * earned ONLY from a real, action-attributed WKG diff. If the metrics object
   * is absent, or its `source` is anything other than 'WKG_DIFF' (i.e.
   * 'UNVERIFIED'), this returns 0 — the system must never defraud curiosity with
   * guessed numbers. Only atlas-computed WKG diffs attributed to THIS action
   * earn relief. The Drive Engine still never touches the WKG; it only judges
   * the pushed, provenance-tagged metric.
   *
   * MAIN contract: until the apps-side reporter threads real metrics and atlas
   * supplies a WKG_DIFF, this stays honest-red (zero relief). That is correct
   * and intended — see wiki/phase4-3a-event-model-plan.md Ticket 2.
   *
   * @param metrics - Optional informationGainMetrics from ActionOutcomePayload
   * @returns Relief amount (negative value = curiosity satisfied, 0 if unverified)
   */
  public computeReliefFromMetrics(
    metrics?: {
      newNodes?: number;
      confidenceDeltas?: number;
      resolvedErrors?: number;
      source?: 'WKG_DIFF' | 'UNVERIFIED';
    },
  ): number {
    // Honesty gate: no metrics, or not a verified WKG diff → zero relief.
    if (!metrics || metrics.source !== 'WKG_DIFF') {
      return 0;
    }

    const newNodes = metrics.newNodes ?? 0;
    const confidenceDeltas = metrics.confidenceDeltas ?? 0;
    const resolvedErrors = metrics.resolvedErrors ?? 0;

    return this.computeRelief(newNodes, confidenceDeltas, resolvedErrors);
  }
}

/**
 * Drive effect from curiosity information gain.
 * Always targets the Curiosity drive.
 */
export interface CuriosityInformationGainEffect {
  drive: DriveName.Curiosity;
  delta: number;
}

/**
 * Singleton instance for the drive process.
 */
let instance: CuriosityInformationGain | null = null;

export function getOrCreateCuriosityInformationGain(): CuriosityInformationGain {
  if (!instance) {
    instance = new CuriosityInformationGain();
  }
  return instance;
}

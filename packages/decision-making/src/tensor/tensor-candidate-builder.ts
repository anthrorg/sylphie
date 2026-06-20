/**
 * TensorCandidateBuilder — Stateless pure transform for tensor-derived
 * action candidates.
 *
 * Extracted from DecisionMakingService (EP7-C, TK-33). Owns the single
 * buildTensorCandidate helper that was formerly a private method on
 * DecisionMakingService. Behavior is byte-identical to the original inline code.
 *
 * Stateless: no injected collaborators, no mutable fields. Registered as a
 * plain provider (no token indirection needed — the caller injects by class).
 */

import { Injectable } from '@nestjs/common';
import { DriveName, type ActionCandidate } from '@sylphie/shared';
import type { TensorInferenceResult } from '../interfaces/decision-making.interfaces';

@Injectable()
export class TensorCandidateBuilder {
  /**
   * Build an ActionCandidate from a tensor inference result.
   *
   * Returns null when:
   *   - tensorTopCategory is absent (tensor did not converge on a category), or
   *   - the argmax action_bias probability is below 0.30 (tensor too uncertain).
   *
   * Confidence is capped by bootstrap mode:
   *   - full:    ≤ 0.95  (allows Type 1 graduation via arbitration)
   *   - partial: ≤ 0.79  (forces Type 2 deliberation — not yet graduated)
   */
  build(
    tensorResult: TensorInferenceResult,
    contextFingerprint: string,
    dominantDrive: DriveName,
  ): ActionCandidate | null {
    const topCategory = tensorResult.tensorTopCategory;
    if (!topCategory) return null;

    // Argmax probability from the action_bias softmax
    const maxProb = Math.max(...tensorResult.actionBias);
    if (maxProb < 0.30) return null; // Tensor too uncertain

    // Confidence gating by bootstrap mode
    const isFullMode = tensorResult.bootstrapMode === 'full';
    const mappedConfidence = isFullMode
      ? Math.min(0.95, maxProb)       // Allow Type 1 in full mode
      : Math.min(0.79, maxProb);      // Force Type 2 in partial mode

    return {
      procedureData: {
        id: `tensor-${topCategory}-${Date.now()}`,
        name: `tensor-${topCategory}`,
        category: topCategory,
        triggerContext: contextFingerprint,
        actionSequence: [{
          index: 0,
          stepType: 'LLM_GENERATE',
          params: {
            instruction: `Respond as ${topCategory} (tensor-guided)`,
            tensorUrgency: tensorResult.urgency,
            tensorNovelty: tensorResult.noveltyScore,
          },
        }],
        provenance: 'INFERENCE' as any,
        confidence: mappedConfidence,
      },
      confidence: mappedConfidence,
      motivatingDrive: dominantDrive,
      contextMatchScore: maxProb,
    };
  }
}

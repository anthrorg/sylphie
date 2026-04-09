/**
 * NarrationBuilderService — converts raw CycleResponse into compact
 * DecisionNarration for the LLM supervisor.
 *
 * The narration is designed to be ~300-500 tokens when serialized, which
 * keeps DeepSeek evaluation calls cheap and fast. Full tensor state,
 * embeddings, and episodic memory are excluded — the supervisor evaluates
 * at the semantic/behavioral level.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CycleResponse, DriveName, PressureVector } from '@sylphie/shared';
import { DRIVE_INDEX_ORDER } from '@sylphie/shared';
import type { DecisionNarration } from './interfaces/supervisor.types';

@Injectable()
export class NarrationBuilderService {
  private readonly logger = new Logger(NarrationBuilderService.name);

  /**
   * Build a compact narration from a CycleResponse.
   *
   * This is the primary data the supervisor LLM will evaluate.
   */
  buildNarration(cycle: CycleResponse): DecisionNarration {
    const driveSnapshot = cycle.driveSnapshot.pressureVector;

    // Find the dominant drive (highest positive pressure)
    const dominantDrive = this.findDominantDrive(driveSnapshot);

    // Build input summary from arbitration result
    const inputSummary = this.buildInputSummary(cycle);

    // Action taken
    const actionTaken = this.extractActionName(cycle);

    return {
      cycleId: cycle.turnId,
      timestamp: new Date(),
      inputSummary,
      arbitrationType: cycle.arbitrationType,
      actionTaken,
      responsePreview: cycle.text.slice(0, 200),
      dominantDrive,
      driveSnapshot,
      // Sidecar fields — populated when cognition-service is running
      convergenceScore: undefined,
      globalModelConfidence: undefined,
      panelDivergenceScores: undefined,
      // Outcome — populated later when reportOutcome fires
      predictionMAE: undefined,
      guardianFeedback: undefined,
      driveEffectsObserved: {},
    };
  }

  /**
   * Identify the drive with the highest positive pressure (most urgent unmet need).
   */
  private findDominantDrive(pressureVector: PressureVector): string {
    let maxPressure = -Infinity;
    let dominantDrive = 'none';

    for (const driveName of DRIVE_INDEX_ORDER) {
      const val = pressureVector[driveName] ?? 0;
      if (val > maxPressure) {
        maxPressure = val;
        dominantDrive = driveName;
      }
    }
    return dominantDrive;
  }

  /**
   * Build a short text summary of what triggered this cycle.
   */
  private buildInputSummary(cycle: CycleResponse): string {
    const parts: string[] = [];

    parts.push(`${cycle.arbitrationType} cycle`);
    parts.push(`latency=${cycle.latencyMs}ms`);

    if (cycle.knowledgeGrounding) {
      parts.push(`grounding=${cycle.knowledgeGrounding}`);
    }

    if (cycle.model) {
      parts.push(`model=${cycle.model}`);
    }

    return parts.join(', ');
  }

  /**
   * Extract a human-readable action name from the cycle.
   */
  private extractActionName(cycle: CycleResponse): string {
    if (cycle.arbitrationType === 'SHRUG') return 'SHRUG';

    const result = cycle.arbitrationResult;
    if (result?.type === 'TYPE_1' && result.candidate?.procedureData) {
      return result.candidate.procedureData.name ?? cycle.actionId;
    }

    return cycle.actionId;
  }
}

/**
 * NarrationBuilderService — converts raw CycleResponse into compact
 * DecisionNarration for the LLM supervisor.
 *
 * The narration is designed to be ~300-500 tokens when serialized, which
 * keeps DeepSeek evaluation calls cheap and fast. Full tensor state,
 * embeddings, and episodic memory are excluded — the supervisor evaluates
 * at the semantic/behavioral level.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import type { CycleResponse, DriveName, PressureVector } from '@sylphie/shared';
import { DRIVE_INDEX_ORDER } from '@sylphie/shared';
import type {
  BehavioralBaseline,
  DecisionNarration,
} from './interfaces/supervisor.types';
import { SidecarControlService } from './sidecar-control.service';

/** One entry in the behavioral-baseline rolling window. */
interface BaselineSample {
  arbitrationType: 'TYPE_1' | 'TYPE_2' | 'SHRUG';
  totalPressure: number;
  pressureVector: PressureVector;
  actionTaken: string;
  latencyMs: number;
}

/** Rolling-window size for the behavioral baseline. */
const BASELINE_WINDOW = 50;

/** Max distinct action names reported in the baseline. */
const MAX_FREQUENT_ACTIONS = 5;

@Injectable()
export class NarrationBuilderService {
  private readonly logger = new Logger(NarrationBuilderService.name);

  /**
   * Rolling window of prior cycles, used to compute the behavioral baseline the
   * supervisor needs for deviation detection (evaluation criterion 4).
   * Bounded — never grows past BASELINE_WINDOW.
   */
  private readonly baselineWindow: BaselineSample[] = [];

  constructor(
    // Optional so the service remains constructable without NestJS DI in unit
    // tests that only exercise baseline logic.
    @Optional() private readonly sidecarControl: SidecarControlService | null = null,
  ) {}

  /**
   * Build a compact narration from a CycleResponse.
   *
   * This is the primary data the supervisor LLM will evaluate.
   *
   * Fetches model state from the cognition sidecar to populate convergenceScore,
   * globalModelConfidence, and panelDivergenceScores. All three are undefined
   * when the sidecar is down or returns null — no exception is thrown.
   */
  async buildNarration(cycle: CycleResponse): Promise<DecisionNarration> {
    const driveSnapshot = cycle.driveSnapshot.pressureVector;

    // Find the dominant drive (highest positive pressure)
    const dominantDrive = this.findDominantDrive(driveSnapshot);

    // Build input summary from arbitration result
    const inputSummary = this.buildInputSummary(cycle);

    // Action taken
    const actionTaken = this.extractActionName(cycle);

    // Compute the behavioral baseline from PRIOR cycles, then fold this cycle
    // in. Computing before the fold means the baseline is the reference frame
    // the current cycle is judged against (it does not include itself).
    const behavioralBaseline = this.computeBaseline();
    this.recordSample({
      arbitrationType: cycle.arbitrationType,
      totalPressure: cycle.driveSnapshot.totalPressure ?? 0,
      pressureVector: driveSnapshot,
      actionTaken,
      latencyMs: cycle.latencyMs,
    });

    // Fetch sidecar model state — undefined when sidecar is down (null return).
    const { convergenceScore, globalModelConfidence, panelDivergenceScores } =
      await this.fetchSidecarModelFields();

    return {
      cycleId: cycle.turnId,
      timestamp: new Date(),
      inputSummary,
      arbitrationType: cycle.arbitrationType,
      actionTaken,
      responsePreview: cycle.text.slice(0, 200),
      dominantDrive,
      driveSnapshot,
      behavioralBaseline,
      // Sidecar fields — populated when cognition-service is running
      convergenceScore,
      globalModelConfidence,
      panelDivergenceScores,
      // Outcome — populated later when reportOutcome fires
      predictionMAE: undefined,
      guardianFeedback: undefined,
      driveEffectsObserved: {},
    };
  }

  /**
   * Fetch and map model-state fields from the sidecar.
   *
   * Returns all three fields as undefined when the sidecar is unavailable,
   * so the caller never needs to handle exceptions here.
   *
   * convergenceScore / globalModelConfidence: 1/(1+training_loss) — the inverse
   * loss is the only scalar quality signal the sidecar exposes. Both fields use
   * the same formula; they represent the same signal at different semantic
   * levels (convergence-model health vs. overall model confidence).
   *
   * panelDivergenceScores: per-panel param ratio relative to the global model
   * (panelParams / globalParams). This is the only per-panel numeric signal
   * available in SidecarModelState; it represents relative model scale as a
   * divergence proxy until the sidecar exposes per-panel loss.
   */
  private async fetchSidecarModelFields(): Promise<{
    convergenceScore: number | undefined;
    globalModelConfidence: number | undefined;
    panelDivergenceScores: Record<string, number> | undefined;
  }> {
    if (!this.sidecarControl) {
      return {
        convergenceScore: undefined,
        globalModelConfidence: undefined,
        panelDivergenceScores: undefined,
      };
    }

    const state = await this.sidecarControl.getModelState();
    if (state === null) {
      return {
        convergenceScore: undefined,
        globalModelConfidence: undefined,
        panelDivergenceScores: undefined,
      };
    }

    // Compute convergence score only when training_loss is a finite number.
    const loss = state.training_loss;
    const score =
      typeof loss === 'number' && Number.isFinite(loss)
        ? 1 / (1 + loss)
        : undefined;

    // Panel divergence: params for each panel as a fraction of global params.
    // Falls back to an empty record when the global model has no params (guard
    // against division-by-zero on an uninitialized sidecar).
    const globalParams = state.models.global.params;
    const panelDivergenceScores: Record<string, number> =
      globalParams > 0
        ? Object.fromEntries(
            Object.entries(state.models.panels).map(([name, panel]) => [
              name,
              panel.params / globalParams,
            ]),
          )
        : {};

    return {
      convergenceScore: score,
      globalModelConfidence: score,
      panelDivergenceScores,
    };
  }

  /**
   * Append a cycle to the bounded rolling baseline window.
   */
  private recordSample(sample: BaselineSample): void {
    this.baselineWindow.push(sample);
    if (this.baselineWindow.length > BASELINE_WINDOW) {
      this.baselineWindow.shift();
    }
  }

  /**
   * Compute the behavioral baseline over the current rolling window.
   *
   * Returns a thin-but-honest baseline when the window is small (sampleCount
   * lets the supervisor discount it). Empty window → sampleCount 0 baseline.
   */
  private computeBaseline(): BehavioralBaseline {
    const n = this.baselineWindow.length;
    if (n === 0) {
      return {
        sampleCount: 0,
        arbitrationMix: { TYPE_1: 0, TYPE_2: 0, SHRUG: 0 },
        meanTotalPressure: 0,
        meanDrivePressure: {},
        frequentActions: [],
        meanLatencyMs: 0,
      };
    }

    const mix = { TYPE_1: 0, TYPE_2: 0, SHRUG: 0 };
    let pressureSum = 0;
    let latencySum = 0;
    const driveSums: Record<string, number> = {};
    const actionCounts = new Map<string, number>();

    for (const s of this.baselineWindow) {
      mix[s.arbitrationType] += 1;
      pressureSum += s.totalPressure;
      latencySum += s.latencyMs;
      for (const drive of DRIVE_INDEX_ORDER) {
        driveSums[drive] = (driveSums[drive] ?? 0) + (s.pressureVector[drive] ?? 0);
      }
      actionCounts.set(s.actionTaken, (actionCounts.get(s.actionTaken) ?? 0) + 1);
    }

    const meanDrivePressure: Record<string, number> = {};
    for (const drive of DRIVE_INDEX_ORDER) {
      meanDrivePressure[drive] = (driveSums[drive] ?? 0) / n;
    }

    const frequentActions = [...actionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_FREQUENT_ACTIONS)
      .map(([action, count]) => ({ action, count }));

    return {
      sampleCount: n,
      arbitrationMix: {
        TYPE_1: mix.TYPE_1 / n,
        TYPE_2: mix.TYPE_2 / n,
        SHRUG: mix.SHRUG / n,
      },
      meanTotalPressure: pressureSum / n,
      meanDrivePressure,
      frequentActions,
      meanLatencyMs: latencySum / n,
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

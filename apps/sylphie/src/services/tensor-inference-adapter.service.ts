/**
 * TensorInferenceAdapter — Implements ITensorInferenceService for the
 * Python cognition sidecar.
 *
 * Wraps CognitionGatewayService to:
 *   1. Call the sidecar with real SensoryFrame data (not zeros).
 *   2. Track bootstrap mode + graduated categories, refreshing periodically.
 *   3. Map CognitionCycleResult to TensorInferenceResult for the decision loop.
 *   4. Submit training samples with real embeddings after each cycle.
 *   5. Maintain a rolling drive history buffer for the Drive Panel.
 *
 * Injected as TENSOR_INFERENCE_SERVICE via @Global() CognitionModule.
 * Consumed by DecisionMakingService.processInput() between RETRIEVING
 * and PREDICTING states.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  verboseFor,
  type SensoryFrame,
  type DriveSnapshot,
  DRIVE_INDEX_ORDER,
} from '@sylphie/shared';
import type {
  ITensorInferenceService,
  TensorInferenceResult,
  PanelContext,
} from '@sylphie/decision-making';
import {
  CognitionGatewayService,
  type CognitionTrainingSample,
} from './cognition-gateway.service';

const vlog = verboseFor('Cognition');

/** How many decision cycles between bootstrap status refreshes. */
const BOOTSTRAP_REFRESH_INTERVAL = 100;

/** Number of drive snapshots to retain for the Drive Panel's drive_history. */
const DRIVE_HISTORY_SIZE = 10;

@Injectable()
export class TensorInferenceAdapter implements ITensorInferenceService, OnModuleInit {
  private readonly logger = new Logger(TensorInferenceAdapter.name);

  private bootstrapMode = 'shadow';
  private graduatedCategories = new Set<string>();
  private cyclesSinceRefresh = 0;

  /** Rolling buffer of flattened drive vectors (each 12 floats). */
  private readonly driveHistoryBuffer: number[][] = [];

  constructor(
    private readonly gateway: CognitionGatewayService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshBootstrapStatus();
  }

  // ---------------------------------------------------------------------------
  // ITensorInferenceService
  // ---------------------------------------------------------------------------

  async infer(
    frame: SensoryFrame,
    driveSnapshot: DriveSnapshot,
    episodicContext?: number[],
    panelContext?: PanelContext,
  ): Promise<TensorInferenceResult | null> {
    if (!this.gateway.isAvailable()) return null;

    // Buffer drive state for the Drive Panel's drive_history
    this.recordDriveVector(driveSnapshot);

    // Periodic bootstrap status refresh (every N cycles)
    this.cyclesSinceRefresh++;
    if (this.cyclesSinceRefresh >= BOOTSTRAP_REFRESH_INTERVAL) {
      this.cyclesSinceRefresh = 0;
      this.refreshBootstrapStatus().catch(() => {});
    }

    // Merge adapter-maintained drive history with caller-provided panel context
    const mergedPanelContext = {
      driveHistory: this.getDriveHistoryFlattened(),
      latentMatchScores: panelContext?.latentMatchScores,
      recentMaeValues: panelContext?.recentMaeValues,
      opportunityFeatures: panelContext?.opportunityFeatures,
    };

    const result = await this.gateway.runCycle(
      frame,
      driveSnapshot,
      episodicContext,
      mergedPanelContext,
    );
    if (!result) return null;

    const mode = this.bootstrapMode;
    const graduated = [...this.graduatedCategories];

    return {
      actionBias: result.global_prior.action_bias,
      urgency: result.global_prior.urgency,
      noveltyScore: result.global_prior.novelty_score,
      consensus: result.convergence?.consensus ?? true,
      divergenceScore: result.convergence?.divergence_score ?? 0,
      panelAgreement: result.convergence?.panel_agreement ?? {},
      tensorTopCategory: result.tensor_top_category ?? null,
      bootstrapMode: mode,
      graduatedCategories: graduated,
      shouldUseTensor: (category: string): boolean => {
        if (mode === 'full') return true;
        if (mode === 'partial') {
          return this.graduatedCategories.has(category.toLowerCase());
        }
        return false;
      },
      inferenceMs: result.inference_ms,
    };
  }

  submitTraining(
    frame: SensoryFrame,
    driveSnapshot: DriveSnapshot,
    actionCategory: string,
    arbitrationType: string,
    tensorTopCategory?: string | null,
  ): void {
    if (!this.gateway.isAvailable()) return;

    // Also buffer drive state from training ticks (every-tick training)
    this.recordDriveVector(driveSnapshot);

    const driveVector = DRIVE_INDEX_ORDER.map(
      (name) => driveSnapshot.pressureVector[name] ?? 0,
    );
    const driveDeltas = DRIVE_INDEX_ORDER.map(
      (name) => driveSnapshot.driveDeltas[name] ?? 0,
    );

    const sample: CognitionTrainingSample = {
      fused_embedding: frame.fused_embedding,
      drive_vector: driveVector,
      drive_deltas: driveDeltas,
      total_pressure: driveSnapshot.totalPressure,
      modality_embeddings: frame.modality_embeddings,
      arbitration_type: arbitrationType,
      action_category: actionCategory,
    };

    this.gateway.submitTrainingSample(sample);

    vlog('training sample submitted', {
      actionCategory,
      arbitrationType,
      tensorTopCategory: tensorTopCategory ?? 'none',
      embeddingNonZero: frame.fused_embedding.some((v) => v !== 0),
    });
  }

  isAvailable(): boolean {
    return this.gateway.isAvailable();
  }

  // ---------------------------------------------------------------------------
  // Drive history buffer
  // ---------------------------------------------------------------------------

  /** Record a drive vector into the rolling history buffer. */
  private recordDriveVector(snapshot: DriveSnapshot): void {
    const vector = DRIVE_INDEX_ORDER.map(
      (name) => snapshot.pressureVector[name] ?? 0,
    );
    this.driveHistoryBuffer.push(vector);
    if (this.driveHistoryBuffer.length > DRIVE_HISTORY_SIZE) {
      this.driveHistoryBuffer.shift();
    }
  }

  /** Flatten the drive history buffer into a single array (10 x 12 = 120 floats). */
  private getDriveHistoryFlattened(): number[] {
    // Pad with zeros if fewer than DRIVE_HISTORY_SIZE entries
    const padCount = DRIVE_HISTORY_SIZE - this.driveHistoryBuffer.length;
    const zeros = new Array(12).fill(0);
    const padded = [
      ...Array.from({ length: padCount }, () => zeros),
      ...this.driveHistoryBuffer,
    ];
    return padded.flat();
  }

  // ---------------------------------------------------------------------------
  // Bootstrap status refresh
  // ---------------------------------------------------------------------------

  private async refreshBootstrapStatus(): Promise<void> {
    const status = await this.gateway.fetchBootstrapStatus();
    if (!status) return;

    const prevMode = this.bootstrapMode;
    this.bootstrapMode = status.mode;
    this.graduatedCategories = new Set(
      status.categories_graduated.map((c) => c.toLowerCase()),
    );

    if (prevMode !== status.mode) {
      this.logger.log(
        `Bootstrap mode transition: ${prevMode} → ${status.mode} ` +
          `(graduated: ${status.categories_graduated.join(', ') || 'none'}, ` +
          `agreement: ${(status.agreement_rate * 100).toFixed(1)}%)`,
      );
    }

    vlog('bootstrap status refreshed', {
      mode: status.mode,
      agreementRate: +(status.agreement_rate * 100).toFixed(1),
      graduated: status.categories_graduated,
    });
  }
}

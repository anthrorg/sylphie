/**
 * CognitionGatewayService — HTTP client for the TensorFlow cognition sidecar.
 *
 * Follows the same pattern as PerceptionGateway's fetch() calls to the
 * perception-service: fire-and-forget for training samples, awaited for
 * inference. Graceful degradation when the sidecar is unavailable.
 *
 * The cognition sidecar runs at COGNITION_HOST (default http://localhost:8431).
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  verboseFor,
  type SensoryFrame,
  type DriveSnapshot,
  DRIVE_INDEX_ORDER,
} from '@sylphie/shared';

const vlog = verboseFor('Cognition');

/** Response shape from POST /cognition/cycle */
export interface CognitionCycleResult {
  global_prior: {
    action_bias: number[];
    urgency: number;
    novelty_score: number;
  };
  panel_opinions: Array<{
    panel_name: string;
    action_bias: number[];
    confidence: number;
    domain_signal: number[];
  }>;
  convergence: {
    consensus: boolean;
    divergence_score: number;
    panel_agreement: Record<string, number>;
  } | null;
  inference_ms: number;
  deliberation_bias?: number[] | null;
  deliberation_confidence?: number | null;
  deliberation_pipeline_weights?: number[] | null;
  tensor_top_category?: string | null;
}

/** Health response from GET /cognition/health */
interface CognitionHealthResult {
  status: string;
  models_loaded: boolean;
  bootstrap_mode: string;
  training_enabled: boolean;
  total_parameters: number;
}

/** Training sample submitted to POST /cognition/train */
export interface CognitionTrainingSample {
  fused_embedding: number[];
  drive_vector: number[];
  drive_deltas: number[];
  total_pressure: number;
  episodic_context?: number[];
  modality_embeddings?: Record<string, number[]>;
  arbitration_type: string;
  action_category?: string;
  response_embedding?: number[];
  outcome?: string;
  drive_effects?: Record<string, number>;
  prediction_mae?: number;
  supervisor_verdict?: string;
  supervisor_correction?: string;
}

@Injectable()
export class CognitionGatewayService implements OnModuleInit {
  private readonly logger = new Logger(CognitionGatewayService.name);
  private readonly host: string;
  private available = false;

  constructor(private readonly config: ConfigService) {
    this.host = this.config.get<string>(
      'COGNITION_HOST',
      'http://localhost:8431',
    );
  }

  async onModuleInit() {
    // Check if the sidecar is reachable on startup
    await this.checkHealth();
  }

  /**
   * Whether the cognition sidecar is currently available.
   * When false, callers should fall back to LLM-only path.
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Run a cognitive cycle through the sidecar.
   *
   * Called from DecisionMakingService.processInput() between PREDICTING
   * and ARBITRATING states.
   *
   * @returns The sidecar's action prior + panel opinions, or null if unavailable.
   */
  async runCycle(
    frame: SensoryFrame,
    driveSnapshot: DriveSnapshot,
    episodicContext?: number[],
  ): Promise<CognitionCycleResult | null> {
    if (!this.available) return null;

    // Assemble the request payload
    const driveVector = DRIVE_INDEX_ORDER.map(
      (name) => driveSnapshot.pressureVector[name] ?? 0,
    );
    const driveDeltas = DRIVE_INDEX_ORDER.map(
      (name) => driveSnapshot.driveDeltas[name] ?? 0,
    );

    const payload = {
      fused_embedding: frame.fused_embedding,
      drive_vector: driveVector,
      drive_deltas: driveDeltas,
      total_pressure: driveSnapshot.totalPressure,
      episodic_context: episodicContext ?? new Array(768).fill(0),
      modality_embeddings: frame.modality_embeddings,
    };

    try {
      const response = await fetch(`${this.host}/cognition/cycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(50), // 50ms timeout — if sidecar is slow, skip
      });

      if (!response.ok) {
        this.logger.warn(
          `Cognition sidecar returned ${response.status}: ${response.statusText}`,
        );
        return null;
      }

      const result = (await response.json()) as CognitionCycleResult;
      vlog('cognition cycle', {
        inference_ms: result.inference_ms,
        urgency: result.global_prior.urgency,
        novelty: result.global_prior.novelty_score,
      });
      return result;
    } catch (err) {
      // Don't flood logs on expected timeout/connection failures
      if ((err as Error).name === 'TimeoutError') {
        vlog('cognition sidecar timeout');
      } else {
        this.logger.warn(
          `Cognition sidecar call failed: ${(err as Error).message}`,
        );
        this.available = false;
        // Schedule a re-check in 30 seconds
        setTimeout(() => this.checkHealth(), 30_000);
      }
      return null;
    }
  }

  /**
   * Submit a training sample to the sidecar. Fire-and-forget.
   *
   * Called at the end of the LEARNING state in DecisionMakingService.
   */
  submitTrainingSample(sample: CognitionTrainingSample): void {
    if (!this.available) return;

    fetch(`${this.host}/cognition/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample),
      signal: AbortSignal.timeout(5_000),
    }).catch((err) => {
      vlog('training sample submission failed', { error: (err as Error).message });
    });
  }

  /**
   * Check if the sidecar is healthy and update availability.
   */
  private async checkHealth(): Promise<void> {
    try {
      const response = await fetch(`${this.host}/cognition/health`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (response.ok) {
        const health = (await response.json()) as CognitionHealthResult;
        this.available = health.models_loaded;
        if (this.available) {
          this.logger.log(
            `Cognition sidecar connected (${health.total_parameters} params, mode=${health.bootstrap_mode})`,
          );
        }
      } else {
        this.available = false;
      }
    } catch {
      this.available = false;
      vlog('cognition sidecar not reachable — LLM-only mode');
    }
  }
}

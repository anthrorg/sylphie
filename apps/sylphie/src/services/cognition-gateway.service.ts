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
import {
  SidecarCircuitBreaker,
  SidecarBreakerState,
} from './sidecar-circuit-breaker';

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
  /**
   * The exact 1561-dim assembled global input vector for this cycle, surfaced
   * by CognitiveCycle._assemble_global_input(). Threaded through to the
   * supervisor so reinforce/correct can send the byte-identical vector the
   * sidecar's _split_input_vector() requires. Optional / back-compatible.
   */
  global_input_vector?: number[] | null;
}

/** Health response from GET /cognition/health */
export interface CognitionHealthResult {
  status: string;
  models_loaded: boolean;
  bootstrap_mode: string;
  training_enabled: boolean;
  total_parameters: number;
}

/** Metrics from GET /cognition/metrics */
export interface CognitionMetrics {
  training_steps: number;
  training_loss: number | null;
  inference_latency_ms: number;
  samples_in_buffer: number;
  checkpoint_count: number;
  per_category_confidence: Record<string, number>;
}

/** Bootstrap status from GET /cognition/bootstrap */
export interface BootstrapStatusResult {
  mode: string;
  agreement_rate: number;
  per_category_agreement: Record<string, number>;
  categories_graduated: string[];
  total_shadow_samples: number;
  total_audit_samples: number;
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
  private bootstrapMode = 'shadow';

  /**
   * Circuit breaker on the sidecar control/cycle path. Opens after repeated
   * failures so a down sidecar fails fast (no per-call timeout tax), probes on
   * a fixed cooldown, and closes on a successful probe. Without it, the loop
   * pays the full timeout on every cycle while the sidecar is hard-down.
   */
  private readonly breaker = new SidecarCircuitBreaker({
    failureThreshold: 5,
    cooldownMs: 30_000,
  });

  constructor(private readonly config: ConfigService) {
    this.host = this.config.get<string>(
      'COGNITION_HOST',
      'http://localhost:8431',
    );
  }

  /** Current circuit-breaker state (diagnostics / dashboard). */
  getBreakerState(): SidecarBreakerState {
    return this.breaker.getState();
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

  /** Current bootstrap mode from the last health check. */
  getBootstrapMode(): string {
    return this.bootstrapMode;
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
    panelContext?: {
      driveHistory?: readonly (readonly number[])[];
      latentMatchScores?: readonly number[];
      recentMaeValues?: readonly number[];
      opportunityFeatures?: readonly number[];
    },
  ): Promise<CognitionCycleResult | null> {
    if (!this.available) return null;

    // Circuit breaker: if the sidecar has failed repeatedly, fail fast instead
    // of paying the per-cycle timeout. canAttempt() also performs the
    // OPEN→HALF_OPEN probe transition once the cooldown elapses.
    if (!this.breaker.canAttempt()) {
      vlog('cognition cycle skipped — breaker open');
      return null;
    }

    // Assemble the request payload
    const driveVector = DRIVE_INDEX_ORDER.map(
      (name) => driveSnapshot.pressureVector[name] ?? 0,
    );
    const driveDeltas = DRIVE_INDEX_ORDER.map(
      (name) => driveSnapshot.driveDeltas[name] ?? 0,
    );

    const payload: Record<string, unknown> = {
      fused_embedding: frame.fused_embedding,
      drive_vector: driveVector,
      drive_deltas: driveDeltas,
      total_pressure: driveSnapshot.totalPressure,
      episodic_context: episodicContext ?? new Array(768).fill(0),
      modality_embeddings: frame.modality_embeddings,
      // Panel domain slices — Python side zero-pads if absent
      ...(panelContext?.driveHistory ? { drive_history: panelContext.driveHistory } : {}),
      ...(panelContext?.latentMatchScores ? { latent_match_scores: panelContext.latentMatchScores } : {}),
      ...(panelContext?.recentMaeValues ? { recent_mae_values: panelContext.recentMaeValues } : {}),
      ...(panelContext?.opportunityFeatures ? { opportunity_features: panelContext.opportunityFeatures } : {}),
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
        this.breaker.recordFailure();
        this.maybeLogBreakerTrip();
        return null;
      }

      const result = (await response.json()) as CognitionCycleResult;
      this.breaker.recordSuccess();
      vlog('cognition cycle', {
        inference_ms: result.inference_ms,
        urgency: result.global_prior.urgency,
        novelty: result.global_prior.novelty_score,
      });
      return result;
    } catch (err) {
      // A timeout or connection failure both count against the breaker — a
      // hung sidecar that times out every call is exactly what should trip it.
      this.breaker.recordFailure();
      this.maybeLogBreakerTrip();

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

  /** Log once when the breaker has just transitioned to OPEN. */
  private maybeLogBreakerTrip(): void {
    if (this.breaker.getState() === SidecarBreakerState.OPEN) {
      this.logger.warn(
        `Cognition sidecar circuit breaker OPEN after ${this.breaker.getConsecutiveFailures()} ` +
          'consecutive failures — skipping sidecar calls until cooldown probe',
      );
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
   * Fetch bootstrap status from the sidecar.
   * Returns graduated categories, agreement rates, and current mode.
   */
  async fetchBootstrapStatus(): Promise<BootstrapStatusResult | null> {
    if (!this.available) return null;

    try {
      const response = await fetch(`${this.host}/cognition/bootstrap`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      const status = (await response.json()) as BootstrapStatusResult;
      this.bootstrapMode = status.mode;
      return status;
    } catch {
      return null;
    }
  }

  /**
   * Fetch training metrics from the sidecar.
   */
  async fetchMetrics(): Promise<CognitionMetrics | null> {
    if (!this.available) return null;

    try {
      const response = await fetch(`${this.host}/cognition/metrics`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as CognitionMetrics;
    } catch {
      return null;
    }
  }

  /**
   * Fetch full model state from the sidecar (per-submodel param counts, weight stats).
   */
  async fetchModelState(): Promise<Record<string, unknown> | null> {
    if (!this.available) return null;

    try {
      const response = await fetch(`${this.host}/cognition/control/state`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Fetch health status (public version of checkHealth for the dashboard).
   */
  async fetchHealth(): Promise<CognitionHealthResult | null> {
    try {
      const response = await fetch(`${this.host}/cognition/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      const health = (await response.json()) as CognitionHealthResult;
      this.available = health.models_loaded;
      this.bootstrapMode = health.bootstrap_mode ?? 'shadow';
      return health;
    } catch {
      return null;
    }
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
        this.bootstrapMode = health.bootstrap_mode ?? 'shadow';
        // A reachable, models-loaded sidecar is a recovery signal — close the
        // breaker so the next cycle is attempted immediately.
        if (this.available) {
          this.breaker.recordSuccess();
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

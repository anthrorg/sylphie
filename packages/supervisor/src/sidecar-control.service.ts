/**
 * SidecarControlService — HTTP client for the cognition sidecar control channel.
 *
 * Routes supervisor interventions (reinforce, correct, freeze, rollback) to the
 * Python cognition-service's control endpoints. Also retrieves model state
 * for the player view dashboard.
 *
 * This service is the bridge between the NestJS supervisor and the Python
 * sidecar. The supervisor decides what intervention to make; this service
 * executes it.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verboseFor } from '@sylphie/shared';
import type { SupervisorIntervention } from './interfaces/supervisor.types';
import {
  SidecarCircuitBreaker,
  SidecarBreakerState,
} from './sidecar-circuit-breaker';

const vlog = verboseFor('SidecarCtrl');

/** Model state snapshot from the sidecar. */
export interface SidecarModelState {
  total_parameters: number;
  training_active: boolean;
  training_steps: number;
  training_loss: number | null;
  bootstrap_mode: string;
  models: {
    global: { params: number };
    panels: Record<string, { params: number }>;
    convergence: { params: number };
    deliberation: {
      pragmatist: { params: number };
      conservative: { params: number };
      advocate: { params: number };
      synthesis: { params: number };
    };
  };
}

@Injectable()
export class SidecarControlService {
  private readonly logger = new Logger(SidecarControlService.name);
  private readonly host: string;

  /**
   * Fail-fast guard around the sidecar HTTP client. When the sidecar has been
   * failing, calls are short-circuited (surfaced as a skip) instead of stacking
   * up blocking 10s timeouts on the supervisor's async path.
   */
  private readonly breaker = new SidecarCircuitBreaker();

  constructor(private readonly config: ConfigService) {
    this.host = this.config.get<string>(
      'COGNITION_HOST',
      'http://localhost:8431',
    );
  }

  /**
   * Execute a supervisor intervention on the sidecar.
   *
   * Routes the intervention type to the appropriate control endpoint.
   */
  async executeIntervention(
    intervention: SupervisorIntervention,
  ): Promise<{ accepted: boolean; error?: string }> {
    try {
      switch (intervention.type) {
        case 'reinforce':
          return await this.reinforce(intervention);

        case 'correct':
          return await this.correct(intervention);

        case 'boost_salience':
          return await this.boostSalience(intervention);

        case 'freeze_model':
          return await this.post(
            `/cognition/control/freeze?model_name=${encodeURIComponent(intervention.modelName ?? 'all')}`,
          );

        case 'unfreeze_model':
          return await this.post(
            `/cognition/control/unfreeze?model_name=${encodeURIComponent(intervention.modelName ?? 'all')}`,
          );

        case 'rollback_checkpoint':
          return await this.post(
            `/cognition/control/rollback?checkpoint_id=${encodeURIComponent(intervention.checkpointId ?? '')}`,
          );

        default:
          return { accepted: false, error: `Unknown intervention type: ${intervention.type}` };
      }
    } catch (err) {
      this.logger.warn(
        `Intervention failed: ${(err as Error).message}`,
      );
      return { accepted: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Intervention payload builders
  //
  // The sidecar's contract (cognition-service/main.py):
  //   POST /reinforce { actionId, inputVector, strengthFactor }
  //   POST /correct   { actionId, inputVector, correctCategory }
  //   POST /boost_salience { category, multiplier, inputVector? }
  //
  // reinforce/correct REQUIRE a GLOBAL_INPUT_DIM (1561) inputVector and validate
  // its length. boost_salience's inputVector is optional.
  // ---------------------------------------------------------------------------

  /**
   * Reinforce: bias the training loop toward the action this cycle took.
   *
   * Maps:
   *   actionId       ← the cycle's executed action (correctionData.targetAction)
   *   strengthFactor ← derived from the verdict weight
   *   inputVector    ← the cycle's GLOBAL_INPUT_DIM feature vector
   *
   * The cycle's assembled global input vector is now plumbed end-to-end
   * (cognition-service surfaces it → CycleResponse.globalInputVector →
   * intervention.inputVector). When it IS present we POST the real signal. It
   * can still be absent for a cycle that had no assembled vector (sidecar
   * unavailable / non-tensor path) — in that case we skip honestly rather than
   * POST a zeroed/guessed vector (a silent stub the sidecar would 422 anyway),
   * returning a not-accepted result with an explicit reason so the loss is
   * auditable, not hidden.
   */
  private async reinforce(
    intervention: SupervisorIntervention,
  ): Promise<{ accepted: boolean; error?: string }> {
    const actionId = this.resolveActionId(intervention);
    if (!actionId) {
      return { accepted: false, error: 'reinforce: no actionId available' };
    }
    if (!intervention.inputVector || intervention.inputVector.length === 0) {
      this.logger.warn(
        'reinforce skipped: this cycle carried no assembled global input vector ' +
          '(sidecar unavailable / non-tensor path) — see SidecarControlService.reinforce',
      );
      return {
        accepted: false,
        error: 'reinforce: inputVector unavailable for this cycle',
      };
    }
    return this.post('/cognition/control/reinforce', {
      actionId,
      inputVector: intervention.inputVector,
      strengthFactor: this.resolveStrengthFactor(intervention),
    });
  }

  /**
   * Correct: inject a corrective (inputVector → correctCategory) training sample.
   *
   * Maps:
   *   actionId       ← the (wrong) action the cycle took (targetAction)
   *   correctCategory← what it SHOULD have done (correctAction)
   *   inputVector    ← the cycle's GLOBAL_INPUT_DIM feature vector
   *
   * inputVector is plumbed end-to-end as in reinforce (see above); it is only
   * absent for a cycle that had no assembled vector, in which case we skip
   * honestly rather than fabricate one.
   */
  private async correct(
    intervention: SupervisorIntervention,
  ): Promise<{ accepted: boolean; error?: string }> {
    const correctCategory =
      intervention.correctionData?.correctAction ??
      intervention.correctionData?.targetAction;
    if (!correctCategory) {
      return {
        accepted: false,
        error: 'correct: no correctCategory (correctAction/targetAction) available',
      };
    }
    if (!intervention.inputVector || intervention.inputVector.length === 0) {
      this.logger.warn(
        'correct skipped: this cycle carried no assembled global input vector ' +
          '(sidecar unavailable / non-tensor path) — see SidecarControlService.correct',
      );
      return {
        accepted: false,
        error: 'correct: inputVector unavailable for this cycle',
      };
    }
    return this.post('/cognition/control/correct', {
      actionId: this.resolveActionId(intervention) ?? correctCategory,
      inputVector: intervention.inputVector,
      correctCategory,
    });
  }

  /**
   * Boost salience: raise the replay salience of a pattern category so the
   * training loop over-samples it. inputVector is OPTIONAL — when present, a
   * fresh high-salience seed sample is injected so the boost has something to
   * act on even if no matching sample is buffered.
   *
   * Maps:
   *   category    ← targetAction/correctAction (the pattern to amplify)
   *   multiplier  ← derived from the verdict weight
   *   inputVector ← optional seed (saliencePattern when it is a full vector,
   *                 otherwise omitted)
   */
  private async boostSalience(
    intervention: SupervisorIntervention,
  ): Promise<{ accepted: boolean; error?: string }> {
    const category =
      intervention.correctionData?.targetAction ??
      intervention.correctionData?.correctAction;
    if (!category) {
      return {
        accepted: false,
        error: 'boost_salience: no category (targetAction/correctAction) available',
      };
    }

    const body: Record<string, unknown> = {
      category,
      multiplier: 1.0 + this.resolveStrengthFactor(intervention),
    };

    // saliencePattern is a seed vector when it is supplied; pass it only as the
    // optional inputVector. Never fabricate one.
    const seed = intervention.inputVector ?? intervention.saliencePattern;
    if (seed && seed.length > 0) {
      body.inputVector = seed;
    }

    return this.post('/cognition/control/boost_salience', body);
  }

  /**
   * The action category a reinforce/correct refers to. Prefers the explicit
   * targetAction from the verdict's correction data.
   */
  private resolveActionId(
    intervention: SupervisorIntervention,
  ): string | undefined {
    return (
      intervention.correctionData?.targetAction ??
      intervention.correctionData?.correctAction
    );
  }

  /**
   * Map the supervisor's intervention weight onto the sidecar's strengthFactor.
   * Defaults to 1.0 (the prior hardcoded weight) and clamps to a sane band so a
   * single intervention can't dominate the replay mix.
   */
  private resolveStrengthFactor(
    intervention: SupervisorIntervention,
  ): number {
    const raw = (intervention.correctionData as { weight?: number } | undefined)
      ?.weight;
    const w = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1.0;
    return Math.max(0.1, Math.min(3.0, w));
  }

  /**
   * Get the current model state from the sidecar.
   *
   * Used by the player view dashboard to show model parameters,
   * training status, and per-model state.
   */
  async getModelState(): Promise<SidecarModelState | null> {
    try {
      const response = await fetch(`${this.host}/cognition/control/state`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) return null;
      return (await response.json()) as SidecarModelState;
    } catch {
      vlog('sidecar model state unavailable');
      return null;
    }
  }

  /**
   * Force a weight checkpoint on the sidecar.
   */
  async forceCheckpoint(
    foundation = false,
  ): Promise<{ saved: boolean; error?: string }> {
    try {
      await this.post(
        `/cognition/checkpoint?foundation=${foundation}`,
      );
      return { saved: true };
    } catch (err) {
      return { saved: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Internal HTTP helper
  // ---------------------------------------------------------------------------

  private async post(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ accepted: boolean; error?: string }> {
    // Fail fast when the breaker is OPEN — surface the skip rather than stacking
    // a blocking 10s timeout against a known-bad sidecar.
    if (!this.breaker.allowRequest()) {
      vlog('sidecar call short-circuited (breaker OPEN)', { path });
      return {
        accepted: false,
        error: `sidecar circuit breaker OPEN (${this.breaker.getConsecutiveFailures()} consecutive failures) — skipping ${path}`,
      };
    }

    const url = `${this.host}${path}`;
    const options: RequestInit = {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    };

    if (body) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      // Network error / timeout — counts as a breaker failure.
      this.recordBreakerFailure();
      throw err;
    }

    if (!response.ok) {
      this.recordBreakerFailure();
      throw new Error(`Sidecar returned ${response.status}: ${response.statusText}`);
    }

    this.breaker.recordSuccess();
    return (await response.json()) as { accepted: boolean; error?: string };
  }

  /** Record a sidecar failure and log when the breaker trips OPEN. */
  private recordBreakerFailure(): void {
    const before = this.breaker.getState();
    this.breaker.recordFailure();
    const after = this.breaker.getState();
    if (before !== SidecarBreakerState.OPEN && after === SidecarBreakerState.OPEN) {
      this.logger.warn(
        `Sidecar circuit breaker TRIPPED after ${this.breaker.getConsecutiveFailures()} consecutive failures — failing fast`,
      );
    }
  }

  /** Current breaker state, for diagnostics / status surfaces. */
  getBreakerState(): SidecarBreakerState {
    return this.breaker.getState();
  }
}

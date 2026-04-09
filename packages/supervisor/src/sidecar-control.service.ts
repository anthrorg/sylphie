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
          return await this.post('/cognition/control/reinforce', {
            type: 'reinforce',
            cycle_id: intervention.cycleId,
            weight: 1.0,
            reason: intervention.correctionData?.reason ?? '',
          });

        case 'correct':
          return await this.post('/cognition/control/correct', {
            type: 'correct',
            cycle_id: intervention.cycleId,
            reason: intervention.correctionData?.reason ?? '',
          });

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

        case 'boost_salience':
          // Not yet implemented on sidecar — log and acknowledge
          this.logger.log(
            'Boost salience requested but not yet implemented on sidecar',
          );
          return { accepted: true };

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
    const url = `${this.host}${path}`;
    const options: RequestInit = {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    };

    if (body) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(`Sidecar returned ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as { accepted: boolean; error?: string };
  }
}

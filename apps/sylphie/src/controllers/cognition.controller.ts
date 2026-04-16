/**
 * CognitionController — Dashboard endpoint for tensor cognition sidecar diagnostics.
 *
 * Aggregates health, bootstrap progress, training metrics, and model state
 * from the Python cognition sidecar into a single JSON response for the
 * Guardian page's tensor dashboard panels.
 *
 * All data is fetched in parallel with 5s timeouts. Missing sections return
 * null rather than failing the entire response.
 */

import { Controller, Get, Logger } from '@nestjs/common';
import { CognitionGatewayService } from '../services/cognition-gateway.service';

@Controller('cognition')
export class CognitionController {
  private readonly logger = new Logger(CognitionController.name);

  constructor(
    private readonly gateway: CognitionGatewayService,
  ) {}

  /**
   * GET /api/cognition/dashboard
   *
   * Returns an aggregated view of the cognition sidecar's state:
   * health, bootstrap progress, training metrics, and model architecture.
   */
  @Get('dashboard')
  async getDashboard() {
    if (!this.gateway.isAvailable()) {
      return { available: false };
    }

    // Fetch all diagnostic data in parallel
    const [health, bootstrap, metrics, modelState] = await Promise.all([
      this.gateway.fetchHealth(),
      this.gateway.fetchBootstrapStatus(),
      this.gateway.fetchMetrics(),
      this.gateway.fetchModelState(),
    ]);

    return {
      available: true,
      health: health
        ? {
            modelsLoaded: health.models_loaded,
            bootstrapMode: health.bootstrap_mode,
            trainingEnabled: health.training_enabled,
            totalParameters: health.total_parameters,
          }
        : null,
      bootstrap: bootstrap
        ? {
            mode: bootstrap.mode,
            agreementRate: bootstrap.agreement_rate,
            perCategoryAgreement: bootstrap.per_category_agreement,
            categoriesGraduated: bootstrap.categories_graduated,
            totalShadowSamples: bootstrap.total_shadow_samples,
            totalAuditSamples: bootstrap.total_audit_samples,
          }
        : null,
      metrics: metrics
        ? {
            trainingSteps: metrics.training_steps,
            trainingLoss: metrics.training_loss,
            inferenceLatencyMs: metrics.inference_latency_ms,
            samplesInBuffer: metrics.samples_in_buffer,
            checkpointCount: metrics.checkpoint_count,
            perCategoryConfidence: metrics.per_category_confidence,
          }
        : null,
      modelState: modelState ?? null,
    };
  }
}

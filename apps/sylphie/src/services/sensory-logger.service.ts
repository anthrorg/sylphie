import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TickSamplerService } from '@sylphie/decision-making';
import { TelemetryGateway } from '../gateways/telemetry.gateway';

const SAMPLE_INTERVAL_MS = 2000;

/**
 * Periodically samples the sensory pipeline and logs the result
 * to the telemetry gateway so the frontend can see data flowing.
 *
 * This is a temporary stand-in for the executor engine's tick loop.
 * Once the executor is wired up, it will call tickSampler.sample()
 * on its own cadence and this service can be removed.
 */
@Injectable()
export class SensoryLoggerService implements OnModuleInit {
  private readonly logger = new Logger(SensoryLoggerService.name);
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tickSampler: TickSamplerService,
    private readonly telemetry: TelemetryGateway,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    this.logger.log(`Sensory sampling started (${SAMPLE_INTERVAL_MS}ms interval)`);
  }

  private async sample() {
    try {
      const frame = await this.tickSampler.sample();

      const modalities = frame.active_modalities;
      const hasSignal = frame.fused_embedding.some((v) => v !== 0);

      this.telemetry.sendLog(
        'info',
        `[sensory] frame: [${modalities.join(', ')}] | fused=${hasSignal ? 'encoded' : 'zero'} | dim=${frame.fused_embedding.length}`,
      );
    } catch (err) {
      this.logger.warn(`Sample failed: ${(err as Error).message}`);
    }
  }
}

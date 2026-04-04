import { Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { SensoryFrame, VideoDetection } from '@sylphie/shared';
import { SensoryFusionService } from '../fusion/sensory-fusion';
import { ModalityRegistryService } from '../registry/modality-registry.service';

/**
 * Tick-driven sensory frame production.
 *
 * Holds the latest raw value for each modality. At each tick: snapshot
 * current values, pass to fusion service, clear event-driven inputs.
 *
 * Input sources push data via the generic update() method or the typed
 * convenience methods. New modalities only need update().
 */
@Injectable()
export class TickSamplerService {
  private readonly logger = new Logger(TickSamplerService.name);
  private readonly frames$ = new Subject<SensoryFrame>();

  /** Latest raw values keyed by modality name */
  private readonly latestValues = new Map<string, unknown>();

  constructor(
    private readonly fusion: SensoryFusionService,
    private readonly registry: ModalityRegistryService,
  ) {}

  /** Observable stream of SensoryFrames for the executor engine */
  get sensoryFrames$() {
    return this.frames$.asObservable();
  }

  /**
   * Update the latest raw value for any modality.
   * Called by input sources (gateways, sidecar clients, drive engine, etc.)
   */
  update(modalityName: string, value: unknown): void {
    this.latestValues.set(modalityName, value);
  }

  // ── Typed convenience methods for known modalities ──────────────

  updateText(text: string): void {
    this.update('text', text);
  }

  updateDriveVector(vector: number[]): void {
    this.update('drives', vector);
  }

  updateVideoDetections(detections: VideoDetection[]): void {
    this.update('video', detections);
  }

  // ── Tick sampling ───────────────────────────────────────────────

  /**
   * Produce a single SensoryFrame from current state.
   * Called by the executor engine's tick loop.
   */
  async sample(): Promise<SensoryFrame> {
    const snapshot = new Map(this.latestValues);
    const frame = await this.fusion.fuse(snapshot);

    // Clear event-driven modalities after consumption
    for (const name of this.registry.getEventDrivenNames()) {
      this.latestValues.delete(name);
    }

    this.frames$.next(frame);
    return frame;
  }
}

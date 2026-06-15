import { Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { EMBEDDING_DIM, FaceDetection, SensoryFrame, VideoDetection, verboseFor } from '@sylphie/shared';

const vlog = verboseFor('Perception');
import type { SceneSnapshot } from '@sylphie/shared';
import { SensoryFusionService } from '../fusion/sensory-fusion';
import { ModalityRegistryService } from '../registry/modality-registry.service';
import { AudioChunk } from '../encoders/audio.encoder';

// ---------------------------------------------------------------------------
// Rolling Window Configuration
// ---------------------------------------------------------------------------

/** Number of recent frames retained in the rolling window. */
const WINDOW_SIZE = 30;

/**
 * EWMA decay factor for temporal blending. Applied per frame:
 *   blended[i] = alpha * current[i] + (1 - alpha) * previous_blended[i]
 *
 * 0.3 means current frame contributes 30%, accumulated history 70%.
 * Higher alpha = more reactive to the present, lower = smoother / more context.
 */
const EWMA_ALPHA = 0.3;

// ---------------------------------------------------------------------------
// TickSamplerService
// ---------------------------------------------------------------------------

/**
 * Tick-driven sensory frame production with rolling temporal context.
 *
 * Holds the latest raw value for each modality. At each tick: snapshot
 * current values, pass to fusion service, blend with temporal context,
 * clear event-driven inputs.
 *
 * Rolling window: retains the last WINDOW_SIZE (30) frames. The fused
 * embedding on each output frame is temporally blended via EWMA so the
 * executor sees context from the recent past, not just the current instant.
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

  /** Rolling window of recent frames (newest at end). */
  private readonly window: SensoryFrame[] = [];

  /**
   * EWMA-blended embedding accumulator. Updated on each sample().
   * Carries temporal context from recent frames into the current embedding.
   * null until the first frame is produced.
   */
  private blendedEmbedding: number[] | null = null;

  constructor(
    private readonly fusion: SensoryFusionService,
    private readonly registry: ModalityRegistryService,
  ) {}

  /** Observable stream of SensoryFrames for the executor engine */
  get sensoryFrames$() {
    return this.frames$.asObservable();
  }

  /** Read-only access to the rolling window for temporal queries. */
  getWindow(): readonly SensoryFrame[] {
    return this.window;
  }

  /** Number of frames currently in the window. */
  get windowSize(): number {
    return this.window.length;
  }

  /**
   * Return the most recent frame without consuming event-driven inputs
   * or updating the EWMA blend.
   *
   * Used by the tensor training path to submit training data on every tick
   * without interfering with the full decision cycle's sample() call.
   * Returns a zero-filled frame if no frames have been produced yet.
   */
  async peek(): Promise<SensoryFrame> {
    const last = this.window[this.window.length - 1];
    if (last) return last;

    // No frames yet — produce one via sample() to bootstrap the window
    return this.sample();
  }

  /** Clear all in-memory state (e.g., on system reset). */
  clear(): void {
    this.latestValues.clear();
    this.window.length = 0;
    this.blendedEmbedding = null;
    this.lastInputAt = 0;
    this.logger.debug('TickSampler cleared: latestValues, window, blendedEmbedding reset.');
  }

  /** Callback invoked when event-driven input arrives. Set by the tick engine. */
  private inputCallback: (() => void) | null = null;

  /** Timestamp of the most recent event-driven input (text, audio, etc.). */
  private lastInputAt = 0;

  /**
   * Register a callback to be invoked immediately when event-driven input arrives.
   * Used by the tick engine to trigger immediate cycles on reactive input.
   * Only one callback is supported — last registration wins.
   */
  onNewInput(callback: () => void): void {
    this.inputCallback = callback;
  }

  /**
   * WS5 T1.0 — callback invoked when a SCENE CHANGE should nudge a cognitive
   * cycle. Kept SEPARATE from the event-driven `inputCallback` so `scene` is NOT
   * made a globally event-driven modality (which would fire a cycle on EVERY
   * frame up to ~15fps and flood the queue — rejected option (a)). The gateway
   * decides WHEN a scene change is salient enough to nudge (deduped + cooldown),
   * and calls `nudgeSceneChange()`; this just forwards to the registered cycle
   * trigger. Last registration wins.
   */
  private sceneNudgeCallback: (() => void) | null = null;

  /** Register the scene-change cycle-nudge callback (WS5 T1.0). */
  onSceneChange(callback: () => void): void {
    this.sceneNudgeCallback = callback;
  }

  /**
   * WS5 T1.0 — fire the scene-change cycle nudge. Called by the perception
   * gateway when a confirmed-object scene change occurs (deduped gateway-side).
   * Does NOT touch `lastInputAt` (this is not human input) and does NOT write any
   * modality slot — the scene is already in the slot via `updateScene`. The nudge
   * exists purely to get a cycle to RUN on a calm/cold backend where the
   * pressure-gated self-tick would not sample the scene.
   */
  nudgeSceneChange(): void {
    if (this.sceneNudgeCallback) {
      vlog('scene-change cycle nudge fired', {});
      this.sceneNudgeCallback();
    }
  }

  /**
   * Update the latest raw value for any modality.
   * Called by input sources (gateways, sidecar clients, drive engine, etc.)
   *
   * If the modality is event-driven (text, audio), the input callback is
   * invoked immediately to trigger an event-driven tick.
   */
  update(modalityName: string, value: unknown): void {
    this.latestValues.set(modalityName, value);

    // Nudge the tick engine immediately for event-driven modalities.
    if (this.registry.getEventDrivenNames().has(modalityName)) {
      this.lastInputAt = Date.now();
      vlog('event-driven input received', {
        modality: modalityName,
        valueType: typeof value,
        ...(modalityName === 'text' ? { textPreview: String(value).substring(0, 80) } : {}),
      });
      if (this.inputCallback) {
        this.inputCallback();
      }
    }
  }

  /** Timestamp (epoch ms) of the most recent event-driven input. */
  getLastInputTimestamp(): number {
    return this.lastInputAt;
  }

  // ── Typed convenience methods for known modalities ──────────────

  updateText(text: string): void {
    this.update('text', text);
  }

  /**
   * WS4 Ticket 2 — record that user input arrived without setting text.
   *
   * Updates `lastInputAt` so the self-tick 30s suppression guard remains accurate
   * when the gateway uses `intakeTurn` (which bypasses `updateText`). Does NOT
   * write text to the slot or fire the event-driven callback — the text travels
   * on the `InboundTurn` and is injected by `runCycleForTurn` at drain time.
   */
  recordInputArrival(): void {
    this.lastInputAt = Date.now();
  }

  /**
   * Inject synthetic text for autonomous processing (e.g., boredom research).
   * Unlike updateText, this does NOT update lastInputAt or trigger the
   * event-driven callback — it just makes the text available for the next
   * sample() call. This prevents synthetic text from being treated as user input.
   */
  injectSyntheticText(text: string): void {
    this.latestValues.set('text', text);
    vlog('synthetic text injected', { textPreview: text.substring(0, 80) });
  }

  updateDriveVector(vector: number[]): void {
    this.update('drives', vector);
  }

  updateVideoDetections(detections: VideoDetection[]): void {
    this.update('video', detections);
  }

  updateAudio(chunk: AudioChunk): void {
    this.update('audio', chunk);
  }

  updateFaces(faces: FaceDetection[]): void {
    this.update('faces', faces);
  }

  updateScene(snapshot: SceneSnapshot): void {
    this.update('scene', snapshot);
  }

  /**
   * P1 #0 — feed the `visual_embedding` modality slot with the SAME
   * SceneSnapshot that backs the `scene` slot. The VisualEmbeddingEncoder pools
   * `objects[].embedding` (the per-CONFIRMED-track appearance vectors) that the
   * SceneEncoder does NOT consume — this is the cross-array signal that was
   * previously discarded at the fusion boundary. Kept as a distinct slot (not a
   * reuse of `scene`) so the registry/fusion dispatch stays modality-agnostic:
   * each encoder reads its OWN named slot. Gateways call this alongside
   * updateScene so a single frame populates both.
   */
  updateVisualEmbedding(snapshot: SceneSnapshot): void {
    this.update('visual_embedding', snapshot);
  }

  updateSceneDescription(description: string): void {
    this.latestValues.set('scene_description', description);
  }

  updateUndiscoveredCount(count: number): void {
    this.latestValues.set('undiscovered_count', count);
  }

  updateUnknownPersonCount(count: number): void {
    this.latestValues.set('unknown_person_count', count);
  }

  // ── Tick sampling ───────────────────────────────────────────────

  /**
   * Produce a single SensoryFrame from current state with temporal context.
   *
   * 1. Snapshot current raw values and fuse into a point-in-time frame
   * 2. Blend the fused embedding with the EWMA accumulator (temporal context)
   * 3. Push the blended frame into the rolling window
   * 4. Clear event-driven modalities
   * 5. Emit and return the temporally-enriched frame
   *
   * The returned frame's fused_embedding carries information from recent
   * history, not just the current instant. Downstream consumers (ProcessInput,
   * context fingerprinting) automatically benefit from temporal context
   * without any changes to their code.
   */
  async sample(opts?: { readonly skipNetworkEmbedding?: boolean }): Promise<SensoryFrame> {
    // Step 1: Produce point-in-time frame from current raw values.
    const snapshot = new Map(this.latestValues);
    const rawFrame = await this.fusion.fuse(snapshot, opts);

    // Step 2: Blend with temporal context via EWMA.
    if (this.blendedEmbedding === null) {
      // First frame — initialize accumulator directly.
      this.blendedEmbedding = [...rawFrame.fused_embedding];
    } else {
      // EWMA: blended = alpha * current + (1 - alpha) * previous
      const current = rawFrame.fused_embedding;
      for (let i = 0; i < this.blendedEmbedding.length; i++) {
        this.blendedEmbedding[i] =
          EWMA_ALPHA * (current[i] ?? 0) +
          (1 - EWMA_ALPHA) * this.blendedEmbedding[i];
      }
    }

    // Build the output frame with the blended embedding.
    const blendedFrame: SensoryFrame = {
      ...rawFrame,
      fused_embedding: [...this.blendedEmbedding],
    };

    // Step 3: Push into rolling window, evict oldest if full.
    this.window.push(blendedFrame);
    if (this.window.length > WINDOW_SIZE) {
      this.window.shift();
    }

    // Step 4: Clear event-driven modalities after consumption.
    for (const name of this.registry.getEventDrivenNames()) {
      this.latestValues.delete(name);
    }

    // Step 5: Emit and return.
    vlog('tick sample produced', {
      activeModalities: blendedFrame.active_modalities,
      windowSize: this.window.length,
      hasText: blendedFrame.active_modalities.includes('text'),
    });

    this.frames$.next(blendedFrame);
    return blendedFrame;
  }

  /**
   * Check whether new meaningful input has arrived since the last sample.
   *
   * Used by the continuous tick loop to decide whether a full decision cycle
   * is warranted or whether the tick should be skipped. Returns true if any
   * event-driven modality has a pending value, which indicates new input
   * (text, audio, etc.) that hasn't been consumed yet.
   *
   * Drive and video modalities are NOT event-driven — they update
   * continuously and don't count as "new input" for this check.
   */
  hasNewInput(): boolean {
    for (const name of this.registry.getEventDrivenNames()) {
      if (this.latestValues.has(name)) {
        return true;
      }
    }
    return false;
  }
}

import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { TickSamplerService } from '@sylphie/decision-making';
import { verboseFor, SceneEventType, type TrackedObjectDTO, type SceneSummary, type FaceDetection } from '@sylphie/shared';

const vlog = verboseFor('Perception');
import { PersonModelService } from '../services/person-model.service';
import { FaceSnapshotService } from '../services/face-snapshot.service';
import { SceneEventDetectorService } from '../services/scene-event-detector.service';
import { VisualWorkingMemoryService } from '../services/visual-working-memory.service';

const MAX_FPS = 15;
const MIN_FRAME_INTERVAL_MS = 1000 / MAX_FPS;

/** Minimum time between VLM caption requests (prevents stacking). */
const CAPTION_COOLDOWN_MS = 5_000;
/** If no scene-change trigger fires, request a periodic caption after this. */
const CAPTION_PERIODIC_MS = 30_000;

/**
 * WS5 T1.0 — minimum time between scene-change CYCLE nudges (NOT caption
 * requests). A burst of OBJECT_APPEARED/DISAPPEARED events within one settling
 * period yields at most one cognitive-cycle nudge, so a flapping scene cannot
 * out-pace the cognitive loop. Held CONSERVATIVE (mirrors CAPTION_COOLDOWN_MS,
 * ~well under one cycle/sec) pending ashby's loop-gain sign-off — the new
 * scene-change→cycle edge changes the scene-surprise event rate into the
 * drive-feedback subsystem, which is ashby's ratified-bound domain. ashby may
 * relax or tighten this; it must stay >= the rumination-breaker window so a
 * flapping scene can't out-pace the breaker's detection (T2.5).
 */
const SCENE_CYCLE_COOLDOWN_MS = 5_000;

@WebSocketGateway({ path: '/ws/perception' })
export class PerceptionGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(PerceptionGateway.name);
  private readonly perceptionHost: string;
  private processing = false;
  private lastFrameTime = 0;

  /** Last VLM caption text (persists between frames). */
  private lastVlmCaption = '';
  /** Timestamp of last completed VLM caption. */
  private lastCaptionAt = 0;
  /** True while a caption request is in-flight (prevents stacking). */
  private captionInFlight = false;

  /**
   * WS5 T1.0 — timestamp of the last scene-change CYCLE nudge. Deduped against
   * SCENE_CYCLE_COOLDOWN_MS so a burst of appear/disappear events fires at most
   * one cognitive cycle per cooldown window. Co-located with the caption dedup
   * (same gateway-owns-pacing pattern).
   */
  private lastSceneCycleAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly tickSampler: TickSamplerService,
    private readonly personModel: PersonModelService,
    private readonly faceSnapshot: FaceSnapshotService,
    private readonly sceneEventDetector: SceneEventDetectorService,
    private readonly vwm: VisualWorkingMemoryService,
  ) {
    this.perceptionHost = this.config.get<string>(
      'PERCEPTION_HOST',
      'http://localhost:8430',
    );
  }

  /**
   * WS5 T0.5 — read-only observability of the per-frame `processing` flag.
   * The gate's inbound camera stub awaits this clearing between injected frames
   * (back-to-back frames inside MIN_FRAME_INTERVAL_MS, or while a prior frame is
   * still in `handleFrame`, are dropped — a dropped novel frame makes P1a/P1c
   * non-deterministic). This is a plain accessor, NOT a GATE_MODE branch: the
   * frame-handling path is identical in and out of the gate.
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * WS5 T4 — reset the scene-cycle cooldown timestamp so the NEXT frame's
   * scene-change event immediately fires a nudge cycle, regardless of when the
   * last nudge fired. Called by MetricsController.resetPerception() so every
   * per-row perception-reset also zeroes the cooldown — without this, a row that
   * starts within 5s of the previous row's final nudge has its first scene-change
   * suppressed (the cross-row cooldown contamination that caused P1c to see only
   * ONE teapot surprise instead of two). Additive seam only: the runtime nudge
   * path is unchanged; this only writes a timestamp field.
   */
  resetCooldown(): void {
    this.lastSceneCycleAt = 0;
  }

  handleConnection(client: WebSocket) {
    this.logger.log('Perception client connected');
    client.on('message', (data: Buffer) => this.handleFrame(client, data));
  }

  handleDisconnect() {
    this.logger.log('Perception client disconnected');
  }

  private async handleFrame(client: WebSocket, jpegData: Buffer) {
    const now = Date.now();
    if (now - this.lastFrameTime < MIN_FRAME_INTERVAL_MS) return;
    if (this.processing) return;

    this.lastFrameTime = now;
    this.processing = true;

    try {
      const response = await fetch(
        `${this.perceptionHost}/perception/detect`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg' },
          body: new Uint8Array(jpegData),
        },
      );

      if (!response.ok) return;

      const result = await response.json();

      // Feed object detections into the sensory pipeline
      const detections = result.detections ?? [];
      const faces = result.faces ?? [];
      vlog('frame processed', {
        detections: detections.length,
        faces: faces.length,
        trackedObjects: (result.tracked_objects ?? []).length,
        latencyMs: Date.now() - now,
      });
      if (detections.length > 0) {
        this.tickSampler.updateVideoDetections(
          detections.map((d: any) => ({
            class: d.label_raw,
            confidence: d.confidence,
            bbox: [d.bbox_x_min, d.bbox_y_min, d.bbox_x_max, d.bbox_y_max],
          })),
        );
      }

      // Feed face detections into the sensory pipeline
      const mappedFaces: FaceDetection[] = faces.map((f: any) => ({
        confidence: f.confidence,
        bbox: [f.bbox_x_min, f.bbox_y_min, f.bbox_x_max, f.bbox_y_max] as [number, number, number, number],
        landmarks: f.landmarks ?? null,
        blendshapes: f.blendshapes ?? null,
      }));

      if (mappedFaces.length > 0) {
        this.tickSampler.updateFaces(mappedFaces);

        // Face snapshot collection (fire-and-forget, best-effort)
        const activePersonId = this.personModel.getActivePersonId();
        if (activePersonId) {
          void this.faceSnapshot
            .processFaceFrame(activePersonId, mappedFaces, jpegData)
            .catch(() => {});
        }
      }

      // --- Scene event detection ---
      // Map Python tracked_objects to TrackedObjectDTOs and run event detection.
      const rawTracked: any[] = result.tracked_objects ?? [];
      const rawSummary = result.scene_summary;

      if (rawTracked.length > 0 && rawSummary) {
        const trackedObjects: TrackedObjectDTO[] = rawTracked.map((t: any) => ({
          trackId: t.track_id,
          state: t.state,
          label: t.label,
          confidence: t.confidence,
          bbox: t.bbox as [number, number, number, number],
          framesSeen: t.frames_seen,
          framesLost: t.frames_lost,
          firstSeenAt: t.first_seen_at ?? null,
          lastSeenAt: t.last_seen_at ?? null,
          embedding: t.embedding ?? null,
          // WS5 T0.8 — data-carried synthetic discriminator. Real sidecar omits
          // it (→ undefined → false downstream); the gate cassette sets it true.
          // This is a value off the detection payload, NOT a GATE_MODE branch.
          synthetic: t.synthetic ?? false,
        }));

        const summary: SceneSummary = {
          totalTracks: rawSummary.total_tracks,
          confirmedCount: rawSummary.confirmed_count,
          lostCount: rawSummary.lost_count,
          newCount: rawSummary.new_count,
          frameSequence: rawSummary.frame_sequence,
        };

        const sceneSnapshot = this.sceneEventDetector.detectEvents(
          trackedObjects,
          mappedFaces,
          summary,
        );

        // Feed scene snapshot into the sensory pipeline
        this.tickSampler.updateScene(sceneSnapshot);

        // Update Visual Working Memory (stabilization + WKG resolution)
        this.vwm.updateScene(sceneSnapshot);

        // --- VLM caption triggering ---
        // Fire a caption request on scene changes or periodically.
        const hasSceneChange = sceneSnapshot.events.some(
          (e) =>
            e.type === SceneEventType.OBJECT_APPEARED ||
            e.type === SceneEventType.PERSON_ARRIVED ||
            e.type === SceneEventType.OBJECT_DISAPPEARED ||
            e.type === SceneEventType.PERSON_LEFT,
        );
        const timeSinceCaption = now - this.lastCaptionAt;
        const shouldCaption =
          !this.captionInFlight &&
          timeSinceCaption >= CAPTION_COOLDOWN_MS &&
          (hasSceneChange || timeSinceCaption >= CAPTION_PERIODIC_MS);

        if (shouldCaption) {
          this.captionInFlight = true;
          this.requestVlmCaption(jpegData).catch(() => {});
        }

        // Compose scene description from VLM caption + VWM entity list
        const vwmDesc = this.vwm.getSceneDescription();
        const parts: string[] = [];
        if (this.lastVlmCaption) {
          parts.push(`Scene: ${this.lastVlmCaption}`);
        }
        if (vwmDesc) {
          parts.push(`Tracked entities:\n${vwmDesc}`);
        }
        const composedDescription = parts.join('\n');
        if (composedDescription) {
          this.tickSampler.updateSceneDescription(composedDescription);
        }
        const undiscovered = this.vwm.getUndiscoveredEntities();
        const unknownPersons = this.vwm.getUnknownPersons();
        this.tickSampler.updateUndiscoveredCount(undiscovered.length);
        this.tickSampler.updateUnknownPersonCount(unknownPersons.length);

        // --- WS5 T1.0: scene-change cognitive-cycle nudge ---
        // A confirmed-object scene change must get a cognitive cycle to RUN on
        // this frame, or a salient-but-CALM visual frame on a drive-cold backend
        // is never sampled (the self-tick is pressure-gated at 4.0 and `scene`
        // is deliberately NOT a globally event-driven modality). Fire AFTER all
        // tick-sampler slot updates for this frame (scene + scene_description +
        // counts) so the drained cycle samples the freshest scene this frame
        // produced. Deduped against SCENE_CYCLE_COOLDOWN_MS so a flapping scene
        // fires at most one cycle per window. The nudge enqueues an
        // originator-less, non-guardian, empty-text turn (no drives written,
        // speakerIsGuardian structurally absent — T0.9/ashby).
        const timeSinceSceneCycle = now - this.lastSceneCycleAt;
        if (hasSceneChange && timeSinceSceneCycle >= SCENE_CYCLE_COOLDOWN_MS) {
          this.lastSceneCycleAt = now;
          this.tickSampler.nudgeSceneChange();
        }

        // Send enriched result to browser (tracked objects + scene events + VWM entities + VLM caption)
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            ...result,
            scene_events: sceneSnapshot.events,
            vwm_entities: this.vwm.getVisibleEntities(),
            vlm_caption: this.lastVlmCaption || null,
          }));
        }
      } else {
        // No tracked objects — send raw result as before
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(result));
        }
      }
    } catch {
      // Perception service unavailable
    } finally {
      this.processing = false;
    }
  }

  /**
   * Fire-and-forget VLM caption request. Sends the current JPEG frame to
   * the perception service's /caption endpoint and stores the result.
   * Never blocks the main detection pipeline.
   */
  private async requestVlmCaption(jpegData: Buffer): Promise<void> {
    try {
      const response = await fetch(
        `${this.perceptionHost}/perception/caption`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg' },
          body: new Uint8Array(jpegData),
        },
      );
      if (!response.ok) return;
      const result = (await response.json()) as { caption: string };
      this.lastVlmCaption = result.caption;
      this.lastCaptionAt = Date.now();
      vlog('vlm caption received', {
        captionLength: result.caption.length,
      });
    } catch {
      // VLM unavailable — no-op, fall back to VWM-only description
    } finally {
      this.captionInFlight = false;
    }
  }
}

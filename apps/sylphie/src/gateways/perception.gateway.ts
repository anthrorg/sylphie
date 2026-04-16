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

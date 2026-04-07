import { Injectable, Logger } from '@nestjs/common';
import {
  type TrackedObjectDTO,
  type SceneEvent,
  type SceneSnapshot,
  type SceneSummary,
  type FaceDetection,
  SceneEventType,
} from '@sylphie/shared';
import { FaceSnapshotService } from './face-snapshot.service';

/**
 * Detects semantic scene events by diffing tracked-object state across frames.
 *
 * Sits between the raw tracker output (per-object lifecycle states) and the
 * cognitive pipeline. Translates state transitions into meaningful events like
 * "a person arrived" or "an object disappeared" that drive attention and curiosity.
 */
@Injectable()
export class SceneEventDetectorService {
  private readonly logger = new Logger(SceneEventDetectorService.name);

  /** Previous frame's confirmed objects, keyed by track ID. */
  private previousObjects = new Map<number, TrackedObjectDTO>();

  /** Track IDs that had an overlapping face detection in the previous frame. */
  private previousFaceTracks = new Set<number>();

  constructor(
    private readonly faceSnapshot: FaceSnapshotService,
  ) {}

  /**
   * Compare current tracked objects against the previous frame and generate
   * semantic scene events.
   *
   * @param currentObjects - Tracked objects from the Python perception service.
   * @param faces - Face detections from the current frame (for occlusion detection).
   * @param summary - Scene summary from the Python service.
   * @returns A SceneSnapshot containing the objects and any detected events.
   */
  detectEvents(
    currentObjects: TrackedObjectDTO[],
    faces: FaceDetection[],
    summary: SceneSummary,
  ): SceneSnapshot {
    const now = Date.now();
    const events: SceneEvent[] = [];

    // Build lookup of current confirmed objects.
    const currentConfirmed = new Map<number, TrackedObjectDTO>();
    for (const obj of currentObjects) {
      if (obj.state === 'confirmed') {
        currentConfirmed.set(obj.trackId, obj);
      }
    }

    // Detect current face-overlapping tracks (person bbox that overlaps a face bbox).
    const currentFaceTracks = new Set<number>();
    for (const obj of currentObjects) {
      if (obj.state !== 'confirmed' || obj.label !== 'person') continue;
      for (const face of faces) {
        if (bboxOverlaps(obj.bbox, face.bbox)) {
          currentFaceTracks.add(obj.trackId);
          break;
        }
      }
    }

    // --- Detect appearances (in current but not in previous) ---
    for (const [trackId, obj] of currentConfirmed) {
      if (this.previousObjects.has(trackId)) continue;

      // Attempt face identification for person tracks with embeddings.
      if (obj.label === 'person' && obj.embedding) {
        const personId = this.faceSnapshot.identifyFace(obj.embedding);
        if (personId) {
          obj.personId = personId;
          events.push({
            type: SceneEventType.FACE_IDENTIFIED,
            trackId,
            label: obj.label,
            confidence: obj.confidence,
            bbox: obj.bbox,
            timestamp: now,
            personId,
          });
        }
        events.push({
          type: SceneEventType.PERSON_ARRIVED,
          trackId,
          label: obj.label,
          confidence: obj.confidence,
          bbox: obj.bbox,
          timestamp: now,
          personId: obj.personId,
        });
      } else {
        events.push({
          type: SceneEventType.OBJECT_APPEARED,
          trackId,
          label: obj.label,
          confidence: obj.confidence,
          bbox: obj.bbox,
          timestamp: now,
        });
      }
    }

    // --- Detect disappearances (in previous but not in current) ---
    for (const [trackId, prevObj] of this.previousObjects) {
      if (currentConfirmed.has(trackId)) continue;

      if (prevObj.label === 'person') {
        events.push({
          type: SceneEventType.PERSON_LEFT,
          trackId,
          label: prevObj.label,
          confidence: prevObj.confidence,
          bbox: prevObj.bbox,
          timestamp: now,
          personId: prevObj.personId,
        });
      } else {
        events.push({
          type: SceneEventType.OBJECT_DISAPPEARED,
          trackId,
          label: prevObj.label,
          confidence: prevObj.confidence,
          bbox: prevObj.bbox,
          timestamp: now,
        });
      }
    }

    // --- Detect face occlusion (person bbox persists but face disappeared) ---
    for (const trackId of this.previousFaceTracks) {
      if (!currentConfirmed.has(trackId)) continue; // track itself is gone
      if (currentFaceTracks.has(trackId)) continue;  // face still visible

      const obj = currentConfirmed.get(trackId)!;
      events.push({
        type: SceneEventType.FACE_OCCLUDED,
        trackId,
        label: obj.label,
        confidence: obj.confidence,
        bbox: obj.bbox,
        timestamp: now,
        personId: obj.personId,
      });
    }

    // --- Re-identify existing person tracks that don't have a personId yet ---
    for (const [trackId, obj] of currentConfirmed) {
      if (obj.personId) continue; // already identified
      if (obj.label !== 'person') continue;
      if (!obj.embedding) continue;
      if (!this.previousObjects.has(trackId)) continue; // handled above in appearances

      const personId = this.faceSnapshot.identifyFace(obj.embedding);
      if (personId) {
        obj.personId = personId;
        events.push({
          type: SceneEventType.FACE_IDENTIFIED,
          trackId,
          label: obj.label,
          confidence: obj.confidence,
          bbox: obj.bbox,
          timestamp: now,
          personId,
        });
      }
    }

    // Update state for next frame.
    this.previousObjects = currentConfirmed;
    this.previousFaceTracks = currentFaceTracks;

    if (events.length > 0) {
      this.logger.debug(
        `Scene events: ${events.map(e => `${e.type}(#${e.trackId} ${e.label}${e.personId ? ` [${e.personId}]` : ''})`).join(', ')}`,
      );
    }

    return {
      timestamp: now,
      frameSequence: summary.frameSequence,
      objects: currentObjects,
      events,
      summary,
    };
  }
}

/**
 * Check if two bounding boxes overlap (simple AABB intersection).
 * Both bboxes are [x_min, y_min, x_max, y_max].
 */
function bboxOverlaps(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

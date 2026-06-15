/**
 * Scene-level types for per-object tracking and event detection.
 *
 * These types bridge the gap between raw per-frame detections and semantic
 * scene understanding — "a new person appeared" rather than "the video
 * embedding changed."
 */

/** DTO for a single tracked object received from the Python perception service. */
export interface TrackedObjectDTO {
  trackId: number;
  state: 'tentative' | 'confirmed' | 'lost' | 'deleted';
  label: string;
  confidence: number;
  bbox: [number, number, number, number];
  framesSeen: number;
  framesLost: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /**
   * Per-object visual embedding (P3.1: 768-D DINOv2-base CLS token; was 1280-D
   * EfficientNet-B0). Only present for CONFIRMED tracks. Length ==
   * OBJECT_EMBEDDING_DIM (sensory-frame.ts).
   */
  embedding: number[] | null;
  /**
   * P3.A — top-K dominant colors of the (masked) bbox crop as `[r, g, b]`
   * triples, from the Python `DominantColorExtractor`. Present only for
   * CONFIRMED tracks; absent/undefined for legacy or cassette frames (the
   * BindingService then simply drops the color signal). Lives alongside the
   * embedding as a session-invariant appearance signal for A.5 re-ID.
   */
  dominantColors?: Array<[number, number, number]>;
  /**
   * P3.A — base64-encoded JPEG of the track's bbox region (forward crop
   * retention, plan §9.3.6). Persisted to `visual_object_embeddings.object_crop_b64`
   * on node creation; deliberately NOT a scorer input (not fetched on the hot
   * re-ID path). Absent/undefined when crop encoding fails or off the sidecar.
   */
  cropB64?: string;
  /** Set by SceneEventDetector when face identification matches a person. */
  personId?: string;
  /**
   * Real camera frame size in pixels (P2.1). Threaded from the perception
   * sidecar's decoded frame so spatial normalizers (bbox centers/sizes,
   * centroid distance) divide by the TRUE dims. Defaults 640x480 when absent
   * (legacy / cassette frames) — absent + defaulted = zero behavior change.
   */
  frameWidth?: number;
  frameHeight?: number;
  /**
   * WS5 T0.8 — synthetic-frame discriminator. The real Python sidecar never
   * sets this (absent → false); the gate's perception cassette sets it `true`
   * so VWM can mark the resulting WORLD :VisualObject node `synthetic:true`
   * (atlas ruling 2026-06-13: a distinct boolean, NOT a provenance_type enum
   * value — provenance_type stays 'SENSOR'). `perception-reset` then deletes
   * `MATCH (n:VisualObject {synthetic:true})` cleanly. This is a data-carried
   * value, not a GATE_MODE branch — the gateway has no test-only code path.
   */
  synthetic?: boolean;
}

/** Semantic event types detected from tracker state transitions. */
export enum SceneEventType {
  /** A new object became CONFIRMED (wasn't tracked before). */
  OBJECT_APPEARED = 'object_appeared',
  /** A previously CONFIRMED object transitioned to LOST or disappeared. */
  OBJECT_DISAPPEARED = 'object_disappeared',
  /** A person-class object appeared (may or may not be identified). */
  PERSON_ARRIVED = 'person_arrived',
  /** An identified person's track was lost. */
  PERSON_LEFT = 'person_left',
  /** A person track's face was matched to a known person profile. */
  FACE_IDENTIFIED = 'face_identified',
  /** A person bbox persists but the overlapping face detection disappeared. */
  FACE_OCCLUDED = 'face_occluded',
}

/** A single semantic scene event derived from tracker state transitions. */
export interface SceneEvent {
  type: SceneEventType;
  trackId: number;
  label: string;
  confidence: number;
  bbox: [number, number, number, number];
  timestamp: number;
  /** For PERSON_ARRIVED/FACE_IDENTIFIED: recognized person ID. */
  personId?: string;
  /** For context: previous bbox when relevant (e.g., movement tracking). */
  previousBbox?: [number, number, number, number];
}

/** Aggregate scene summary from the Python perception service. */
export interface SceneSummary {
  totalTracks: number;
  confirmedCount: number;
  lostCount: number;
  newCount: number;
  frameSequence: number;
}

/** Complete scene state for a single frame: tracked objects + detected events. */
export interface SceneSnapshot {
  timestamp: number;
  frameSequence: number;
  objects: TrackedObjectDTO[];
  events: SceneEvent[];
  summary: SceneSummary;
  /**
   * Real camera frame size in pixels (P2.1); defaults 640x480 when absent
   * (legacy / cassette frames). The SceneEncoder and ScenePredictionService
   * read these to normalize bbox geometry by the TRUE frame dims.
   */
  frameWidth?: number;
  frameHeight?: number;
}

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
  /** 1280D EfficientNet-B0 embedding, only present for CONFIRMED tracks. */
  embedding: number[] | null;
  /** Set by SceneEventDetector when face identification matches a person. */
  personId?: string;
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
}

export const EMBEDDING_DIM = 768;

/**
 * Dimensionality of the raw per-object visual embedding produced by the
 * perception sidecar and carried on `TrackedObjectDTO.embedding`.
 *
 * Today this is the 1280-D EfficientNet-B0 ONNX vector. The Phase-P3 DINOv2
 * backbone swap is a SINGLE input-dim change here (1280 → 1024) against the
 * already-proven `visual_embedding` fusion/fingerprint plumbing — that is the
 * entire reason #0 was built generically. NEVER hardcode 1280 at a consumer;
 * import this const so the P3 swap is one line.
 */
export const OBJECT_EMBEDDING_DIM = 1280;

/**
 * Fingerprint / fused-embedding scheme version. Participates in the
 * `generateFingerprint` hash PREIMAGE (process-input.service.ts) so a v(N)
 * fingerprint can NEVER cross-version-collide with a v(N+1) fingerprint:
 * widening the fused-vector slice or adding a fused modality (e.g. the
 * `visual_embedding` modality, #0) changes the equivalence classes, and the
 * in-hash version guarantees the migration is a clean one-time recall MISS
 * rather than a silent corrupted HIT.
 *
 * v1 → the original 6-modality fusion + first-64-dims fingerprint slice.
 * v2 → adds the `visual_embedding` modality (#0) AND widens the fingerprint to
 *      the FULL fused vector (#3); both land together in ONE bump (batch-atomic).
 *
 * Bumping this is a DELIBERATE, migration-gated act, not cleanup — see the
 * stability invariant "the embedding stays stable OR its change is a
 * frozen+versioned+migration-gated phase transition."
 */
export const EMBEDDING_VERSION = 2;

export interface VideoDetection {
  class: string;
  confidence: number;
  bbox: number[];
  /**
   * Real camera frame size in pixels (P2.1); defaults 640x480 when absent
   * (legacy / cassette frames). The VideoEncoder reads these to normalize bbox
   * centers/area by the TRUE frame dims instead of a hardcoded 640x480.
   */
  frameWidth?: number;
  frameHeight?: number;
}

export interface FaceDetection {
  confidence: number;
  bbox: [number, number, number, number];
  /** 478 MediaPipe mesh landmarks as [x, y] pixel coordinates (may be null). */
  landmarks: number[][] | null;
  /** Named blendshape scores (e.g. jawOpen, browInnerUp), each 0-1 (may be null). */
  blendshapes: Record<string, number> | null;
  /**
   * Real camera frame size in pixels (P2.1); defaults 640x480 when absent
   * (legacy / cassette frames). The FaceEncoder normalizes bbox/landmark/
   * head-pose geometry by the TRUE frame dims when present.
   */
  frameWidth?: number;
  frameHeight?: number;
}

export interface SensoryFrame {
  timestamp: number;

  /** The fused embedding — the "gestalt" of all active modalities (d-dimensional) */
  fused_embedding: number[];

  /** Individual modality embeddings keyed by modality name */
  modality_embeddings: Record<string, number[]>;

  /** Which modalities contributed to this frame */
  active_modalities: string[];

  /** Raw values preserved for TimescaleDB logging, keyed by modality name */
  raw: Record<string, unknown>;
}

/** @deprecated Use string modality names from the ModalityRegistry instead */
export type ModalityType = 'text' | 'video' | 'drives';

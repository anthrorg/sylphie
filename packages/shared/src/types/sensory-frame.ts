export const EMBEDDING_DIM = 768;

/**
 * Dimensionality of the raw per-object visual embedding produced by the
 * perception sidecar and carried on `TrackedObjectDTO.embedding`.
 *
 * P3.1 — this is now the 768-D DINOv2-base CLS-token vector (was the 1280-D
 * EfficientNet-B0 ONNX vector). DINOv2-base was chosen over DINOv2-large/1024
 * deliberately: 768 == `EMBEDDING_DIM`, so the visual-embedding JL projection
 * collapses to identity and is DELETED — the unit-normalized pooled vector
 * feeds fusion directly (a random JL projection would only distort cosine).
 * NEVER hardcode 768 at a consumer; import this const so a future backbone swap
 * stays one line. The visual-embedding encoder also asserts
 * `OBJECT_EMBEDDING_DIM === EMBEDDING_DIM` so a non-768 backbone cannot
 * silently feed a wrong-length vector into fusion.
 */
export const OBJECT_EMBEDDING_DIM = 768;

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
 * v3 → object backbone EfficientNet-1280 → DINOv2-base-768 (+ JL projection
 *      deleted), changing the `visual_embedding` modality DIRECTION. The fused
 *      latent for a given scene moves, so a v2 fingerprint must never re-key a
 *      v3 fingerprint — the in-hash version forces a clean one-time recall miss
 *      rather than a silent corrupted hit (P3.1, migration-gated).
 *
 * Bumping this is a DELIBERATE, migration-gated act, not cleanup — see the
 * stability invariant "the embedding stays stable OR its change is a
 * frozen+versioned+migration-gated phase transition."
 */
export const EMBEDDING_VERSION = 3;

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

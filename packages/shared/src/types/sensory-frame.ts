export const EMBEDDING_DIM = 768;

export interface VideoDetection {
  class: string;
  confidence: number;
  bbox: number[];
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

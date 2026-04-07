/**
 * SensoryPredictionService — Per-modality prediction error detection.
 *
 * Tracks each modality stream's embedding across frames. When a new frame
 * arrives, computes the prediction error (cosine distance between expected
 * and actual) per modality. High prediction errors = something changed on
 * that stream = salience signal for drives.
 *
 * Uses EWMA smoothing on stored embeddings to reduce noise from camera
 * jitter, ambient audio fluctuations, etc.
 *
 * No LLM calls. Pure math.
 */

import { Injectable, Logger } from '@nestjs/common';
import { cosineSimilarity } from '../latent-space/vector-math';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** EWMA smoothing factor. Higher = more weight on current frame. */
const EWMA_ALPHA = 0.3;

/** Minimum error to be considered meaningful (below this is noise). */
const NOISE_FLOOR = 0.02;

// ---------------------------------------------------------------------------
// SensoryPredictionService
// ---------------------------------------------------------------------------

@Injectable()
export class SensoryPredictionService {
  private readonly logger = new Logger(SensoryPredictionService.name);

  /** EWMA-smoothed embeddings from previous frames, keyed by modality. */
  private previousEmbeddings: Record<string, number[]> | null = null;

  /**
   * Compute per-modality prediction errors between expected and actual.
   *
   * Returns a map of modality → prediction error (0 = perfect prediction,
   * 1 = maximally surprising, 2 = opposite direction).
   *
   * Updates internal state for the next frame's prediction.
   */
  computeErrors(currentEmbeddings: Record<string, number[]>): Record<string, number> {
    const errors: Record<string, number> = {};

    if (this.previousEmbeddings === null) {
      // First frame: moderate initial surprise for all modalities.
      for (const modality of Object.keys(currentEmbeddings)) {
        errors[modality] = 0.5;
      }
      // Initialize stored embeddings
      this.previousEmbeddings = {};
      for (const [modality, emb] of Object.entries(currentEmbeddings)) {
        this.previousEmbeddings[modality] = [...emb];
      }
      return errors;
    }

    for (const [modality, currentEmb] of Object.entries(currentEmbeddings)) {
      const prevEmb = this.previousEmbeddings[modality];

      if (!prevEmb) {
        // New modality appeared — maximally surprising
        errors[modality] = 1.0;
      } else {
        // Cosine distance: 1 - similarity. Range [0, 2].
        const distance = 1.0 - cosineSimilarity(prevEmb, currentEmb);
        errors[modality] = distance < NOISE_FLOOR ? 0 : distance;
      }
    }

    // EWMA blend: update stored embeddings toward current frame
    for (const [modality, currentEmb] of Object.entries(currentEmbeddings)) {
      const prev = this.previousEmbeddings[modality];
      if (prev && prev.length === currentEmb.length) {
        for (let i = 0; i < prev.length; i++) {
          prev[i] = EWMA_ALPHA * currentEmb[i] + (1 - EWMA_ALPHA) * prev[i];
        }
      } else {
        this.previousEmbeddings[modality] = [...currentEmb];
      }
    }

    return errors;
  }

  /** Reset state on session boundary or system reset. */
  reset(): void {
    this.previousEmbeddings = null;
    this.logger.debug('Sensory prediction state reset.');
  }
}

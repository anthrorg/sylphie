import { Injectable, Logger } from '@nestjs/common';
import type { SceneSnapshot, TrackedObjectDTO } from '@sylphie/shared';

/** What the service predicted would be in the scene. */
interface PredictedObject {
  trackId: number;
  label: string;
  expectedBbox: [number, number, number, number];
  confidence: number;
  personId?: string;
}

/** Per-object prediction error. */
export interface SceneObjectError {
  trackId: number;
  label: string;
  errorType: 'novel' | 'missing' | 'moved';
  /** Error magnitude in [0, 1]. */
  magnitude: number;
  personId?: string;
}

/** Result of comparing predicted scene against observed scene. */
export interface ScenePredictionResult {
  /** Per-object prediction errors. */
  errors: SceneObjectError[];
  /** Aggregate scene surprise in [0, 1]. */
  totalSurprise: number;
  /** Objects that appeared unexpectedly. */
  novelObjects: TrackedObjectDTO[];
  /** Objects that were expected but disappeared. */
  missingObjects: PredictedObject[];
}

/** Threshold for bbox centroid movement to count as "moved" (fraction of frame). */
const MOVEMENT_THRESHOLD = 0.15;
const FRAME_W = 640;
const FRAME_H = 480;

/**
 * Per-object scene prediction service.
 *
 * Maintains a predicted scene graph ("which objects should be in the next frame")
 * and compares it against the observed scene each tick. Generates structured
 * prediction errors that can route to specific drives:
 *
 * - Novel object → curiosity ("what is that?")
 * - Missing object → anxiety ("where did it go?")
 * - Significant movement → focus ("it's moving")
 *
 * Uses a simple persistence model: whatever is CONFIRMED now will be there
 * in the next frame. This is the right starting point — over time, the
 * prediction model can be enriched with trajectory extrapolation and
 * behavioral patterns.
 */
@Injectable()
export class ScenePredictionService {
  private readonly logger = new Logger(ScenePredictionService.name);

  /** Predicted scene: expected objects for the next frame. */
  private predictedScene = new Map<number, PredictedObject>();

  /** Whether we've seen at least one frame (cold-start guard). */
  private initialized = false;

  /**
   * Compare predicted scene against observed, return per-object errors,
   * then update predictions for the next frame.
   */
  computeSceneErrors(snapshot: SceneSnapshot): ScenePredictionResult {
    const confirmed = snapshot.objects.filter(o => o.state === 'confirmed');
    const confirmedIds = new Set(confirmed.map(o => o.trackId));

    // On first frame, just initialize predictions — no errors to report.
    if (!this.initialized) {
      this.initialized = true;
      this.updatePredictions(confirmed);
      return {
        errors: [],
        totalSurprise: 0,
        novelObjects: [],
        missingObjects: [],
      };
    }

    const errors: SceneObjectError[] = [];
    const novelObjects: TrackedObjectDTO[] = [];
    const missingObjects: PredictedObject[] = [];

    // 1. Check for missing objects (predicted but not observed).
    for (const [trackId, predicted] of this.predictedScene) {
      if (!confirmedIds.has(trackId)) {
        errors.push({
          trackId,
          label: predicted.label,
          errorType: 'missing',
          magnitude: predicted.confidence,
          personId: predicted.personId,
        });
        missingObjects.push(predicted);
      }
    }

    // 2. Check each observed object against predictions.
    for (const obj of confirmed) {
      const predicted = this.predictedScene.get(obj.trackId);

      if (!predicted) {
        // Novel: not predicted at all.
        errors.push({
          trackId: obj.trackId,
          label: obj.label,
          errorType: 'novel',
          magnitude: 1.0,
          personId: obj.personId,
        });
        novelObjects.push(obj);
        continue;
      }

      // Check if it moved significantly.
      const movement = bboxCentroidDistance(obj.bbox, predicted.expectedBbox);
      if (movement > MOVEMENT_THRESHOLD) {
        errors.push({
          trackId: obj.trackId,
          label: obj.label,
          errorType: 'moved',
          magnitude: Math.min(movement / 0.5, 1.0), // normalize: 0.5 = full frame diagonal
          personId: obj.personId,
        });
      }
    }

    // Compute aggregate surprise.
    const totalSurprise = errors.length > 0
      ? Math.min(
          errors.reduce((sum, e) => sum + e.magnitude, 0) / Math.max(confirmed.length, 1),
          1.0,
        )
      : 0;

    if (errors.length > 0) {
      this.logger.debug(
        `Scene prediction errors: ${errors.map(e => `${e.errorType}(#${e.trackId} ${e.label})`).join(', ')}, ` +
        `totalSurprise=${totalSurprise.toFixed(3)}`,
      );
    }

    // Update predictions for next frame.
    this.updatePredictions(confirmed);

    return { errors, totalSurprise, novelObjects, missingObjects };
  }

  /**
   * Update predictions using persistence model:
   * "Whatever is confirmed now will still be there next frame."
   */
  private updatePredictions(confirmed: TrackedObjectDTO[]): void {
    this.predictedScene.clear();
    for (const obj of confirmed) {
      this.predictedScene.set(obj.trackId, {
        trackId: obj.trackId,
        label: obj.label,
        expectedBbox: obj.bbox,
        confidence: obj.confidence,
        personId: obj.personId,
      });
    }
  }
}

/**
 * Compute normalized centroid distance between two bounding boxes.
 * Returns a value in [0, ~1.4] where 1.0 ≈ full frame width distance.
 */
function bboxCentroidDistance(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const cx_a = (a[0] + a[2]) / 2 / FRAME_W;
  const cy_a = (a[1] + a[3]) / 2 / FRAME_H;
  const cx_b = (b[0] + b[2]) / 2 / FRAME_W;
  const cy_b = (b[1] + b[3]) / 2 / FRAME_H;
  return Math.sqrt((cx_a - cx_b) ** 2 + (cy_a - cy_b) ** 2);
}

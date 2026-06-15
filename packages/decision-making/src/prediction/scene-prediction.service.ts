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
/**
 * P2.1 — default frame size used to normalize bbox-centroid movement when a
 * SceneSnapshot carries no real `frameWidth`/`frameHeight` (legacy / cassette
 * frames). The live path threads the TRUE decoded dims from the sidecar via the
 * snapshot; absent → these defaults, so the math is byte-identical to the old
 * hardcoded 640x480.
 */
const DEFAULT_FRAME_W = 640;
const DEFAULT_FRAME_H = 480;

/**
 * WS5 T4 / P1c — familiarity habituation decay constant.
 *
 * On the novel-object branch the surprise magnitude is attenuated by a
 * monotone-decreasing function of how many times this IDENTITY (personId else
 * label) has been seen novel before:
 *
 *     magnitude = NOVEL_BASE_MAGNITUDE / (1 + FAMILIARITY_DECAY_K * count)
 *
 * count=0 (first sighting) → 1.0 (full surprise, requisite variety preserved);
 * count=1 → 1/(1+0.6)=0.625; count=2 → 0.4545; … strictly decreasing toward 0.
 *
 * This is the curiosity-leak control loop: a genuinely new object still fires
 * full surprise while a re-seen one is habituated, per-identity (NOT global), so
 * familiarity composes correctly through `totalSurprise` (which averages
 * per-object magnitudes). The same attenuated magnitude flows to BOTH the
 * encode-attention saliency term (T1.0, decision-making.service.ts:saliencyTerm)
 * AND `routeScenePredictionErrors` drive routing — ONE familiarity source, two
 * consumers (the plan's "don't double-implement" requirement).
 *
 * k=0.6 is a sane default that gives a clearly-measurable first-repeat drop
 * (1.0 → 0.625, a 37.5% reduction) for the P1c gate row while leaving headroom
 * for further habituation. Tuning parameter — flagged for drive/skinner/ashby if
 * the curve shape needs revisiting (it is the curiosity-leak loop gain). Keying
 * on personId-else-label (NOT trackId) is load-bearing: the IoU tracker assigns a
 * fresh monotonic trackId on re-entry (tracker.py:276,284), so a trackId-keyed
 * habituation would be defeated by a walk-out/walk-back; the identity key persists
 * the count across that gap.
 */
const FAMILIARITY_DECAY_K = 0.6;
const NOVEL_BASE_MAGNITUDE = 1.0;

/** Cap on the per-frame surprise inspection ring (read-only gate seam). */
const SURPRISE_RING_CAP = 50;

/** One recorded per-frame surprise observation (read-only gate seam, WS5 P1a/P1c). */
export interface SurpriseObservation {
  /** Monotonic per-frame sequence since the last reset. */
  seq: number;
  /** The aggregate surprise emitted this frame (post-familiarity-attenuation). */
  totalSurprise: number;
  /** Per-identity novel magnitudes this frame (identityKey → attenuated magnitude). */
  novelMagnitudes: Record<string, number>;
  /** Wall-clock when the frame was compared. */
  at: string;
}

/**
 * WS5 P1a gate seam — the most recent ScenePrediction ACTION_OUTCOME that was
 * routed to the drive engine (i.e. totalSurprise >= 0.05 threshold passed).
 * Computed deterministically from the same rule table the drive engine applies
 * (rules.ts ScenePrediction: curiosity=0.02*s, anxiety=0.01*s) so the gate can
 * assert on the CAUSAL effect without polling the noisy net drive-vector delta.
 */
export interface LastScenePredictionOutcome {
  /** Scene surprise value that triggered the outcome (totalSurprise from compareScene). */
  sceneSurprise: number;
  /** Deterministic drive effects the drive engine applied (curiosity=0.02*s, anxiety=0.01*s). */
  computedEffects: { curiosity: number; anxiety: number };
  /** Wall-clock when the outcome was routed. */
  routedAt: string;
}

/** Read-only snapshot of the predictor's habituation state (WS5 P1c gate seam). */
export interface ScenePredictionState {
  /** Whether the predictor has seen a frame since reset (cold-start guard). */
  initialized: boolean;
  /** Per-identity familiarity counts (identityKey → times seen novel). */
  familiarityCounts: Record<string, number>;
  /** The most recent per-frame surprise observations (oldest→newest). */
  recentSurprise: SurpriseObservation[];
  /**
   * WS5 P1a gate seam — the most recent ScenePrediction outcome routed to the
   * drive engine (null if no outcome has fired since the last reset).
   */
  lastRoutedOutcome: LastScenePredictionOutcome | null;
}

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
   * WS5 T4 / P1c — per-IDENTITY familiarity counts. Keyed on `personId ?? label`
   * (NOT trackId), so the count survives the IoU tracker's fresh-trackId-on-
   * re-entry gap (tracker.py:276,284) — walk-out/walk-back is habituated, not
   * re-surprised. This map is the ONLY state that persists across
   * `predictedScene.clear()` each frame; it is cleared ONLY by `reset()` (the
   * scene-predictor-reset gate endpoint). Per-identity (not global) so a
   * genuinely new object still fires full surprise while a familiar one is
   * habituated — requisite variety preserved.
   */
  private familiarityCounts = new Map<string, number>();

  /**
   * WS5 P1a/P1c — read-only per-frame surprise inspection ring. Records the
   * EXACT `totalSurprise` (post-familiarity-attenuation) the predictor emitted
   * into the cognitive cycle each frame — the same value that fed both the
   * encode-attention saliency term and the drive router. The gate reads this via
   * GET /metrics/scene-prediction-state to assert P1a (surprise>0.05 on the novel
   * frame) and P1c (surprise₂<surprise₁ on the identity key). NOT theater: it is
   * the live emitted number, not a recomputation. Bounded to SURPRISE_RING_CAP.
   */
  private surpriseRing: SurpriseObservation[] = [];

  /**
   * WS5 P1a gate seam — cache of the most recent ScenePrediction outcome routed
   * to the drive engine. Set by recordOutcomeRouted() (called from
   * DecisionMakingService.routeScenePredictionErrors after reportOutcome).
   * Cleared by reset(). Null until at least one outcome has fired.
   */
  private lastRoutedOutcome: LastScenePredictionOutcome | null = null;

  /** Monotonic frame counter since the last reset (for the inspection ring). */
  private frameSeq = 0;

  /**
   * WS5 T0.7 — reset the predictor to its cold-start state for a hermetic gate
   * run. The predictor is stateful: `predictedScene` persists across frames and
   * the FIRST `computeSceneErrors` call after reset returns surprise 0 by
   * construction (the `!initialized` branch). This is the determinism mechanism
   * for the P1a "reset → prime-frame (surprise 0) → novel-frame" ordering — it
   * is carried mutable state being zeroed, NOT a seeded RNG (finding L).
   */
  reset(): void {
    this.predictedScene.clear();
    this.initialized = false;
    // WS5 T4/P1c — the familiarity counts and surprise ring are part of the
    // carried state the gate's hermetic determinism depends on. Clearing them
    // here (and ONLY here) is what makes P1c's "surprise₂ < surprise₁" a clean
    // first-vs-second comparison: the prime/novel ordering starts from a known
    // zero-familiarity state, just like predictedScene starts cold.
    this.familiarityCounts.clear();
    this.surpriseRing = [];
    this.frameSeq = 0;
    this.lastRoutedOutcome = null;
    this.logger.debug('Scene predictor reset to cold-start (gate hermeticity).');
  }

  /**
   * WS5 P1a gate seam — record that a ScenePrediction outcome was routed to the
   * drive engine with the given scene surprise value. Called by
   * DecisionMakingService.routeScenePredictionErrors() after a successful
   * reportOutcome() call. Computes deterministic drive effects from the same rule
   * table the drive engine applies (rules.ts ScenePrediction: curiosity=0.02*s,
   * anxiety=0.01*s) so the P1a gate row can assert on the CAUSAL outcome without
   * polling the noisy net drive-vector delta.
   */
  recordOutcomeRouted(sceneSurprise: number): void {
    this.lastRoutedOutcome = {
      sceneSurprise,
      computedEffects: {
        curiosity: 0.02 * sceneSurprise,
        anxiety: 0.01 * sceneSurprise,
      },
      routedAt: new Date().toISOString(),
    };
  }

  /**
   * WS5 P1a/P1c — read-only snapshot of the predictor's habituation state for the
   * gate seam (GET /metrics/scene-prediction-state). Returns the per-identity
   * familiarity counts plus the recent per-frame surprise observations the
   * predictor actually emitted. Read-only — no mutation, no recomputation
   * (Theater Prohibition: the gate asserts on the value the cycle consumed).
   */
  getState(): ScenePredictionState {
    return {
      initialized: this.initialized,
      familiarityCounts: Object.fromEntries(this.familiarityCounts),
      recentSurprise: this.surpriseRing.map((o) => ({
        ...o,
        novelMagnitudes: { ...o.novelMagnitudes },
      })),
      lastRoutedOutcome: this.lastRoutedOutcome
        ? { ...this.lastRoutedOutcome, computedEffects: { ...this.lastRoutedOutcome.computedEffects } }
        : null,
    };
  }

  /** WS5 P1c — the identity key the familiarity map is keyed on (personId else label). */
  private identityKey(obj: { personId?: string; label: string }): string {
    return obj.personId ?? obj.label;
  }

  /**
   * Compare predicted scene against observed, return per-object errors,
   * then update predictions for the next frame.
   *
   * WS5 T1.0: this is the legacy combined entry point — it both COMPARES and
   * ADVANCES predictions in one call. It is preserved for callers that want the
   * one-shot behavior, but the in-cycle decision path must NOT call this AND
   * `compareScene` in the same frame, or predictions advance twice and the next
   * frame's surprise is wrong. The decision cycle uses `compareScene` (pure) +
   * `advancePredictions` (mutating) explicitly so the cached comparison can be
   * reused by both the encode-attention term and the drive router (T1.0). See
   * decision-making.service.ts runCycle ordering.
   */
  computeSceneErrors(snapshot: SceneSnapshot): ScenePredictionResult {
    const result = this.compareScene(snapshot);
    this.advancePredictions(snapshot, result);
    return result;
  }

  /**
   * PURE comparison (WS5 T1.0): compare the predicted scene against the observed
   * snapshot and return per-object errors + aggregate surprise WITHOUT mutating
   * `predictedScene`. Calling this any number of times in a single frame yields
   * the same result. `advancePredictions` must be called EXACTLY ONCE per frame
   * afterwards to roll the persistence model forward.
   *
   * This split is the load-bearing fix for the cycle-ordering refactor: the
   * decision cycle computes surprise ONCE early (to feed both the encode-attention
   * gate and the drive router) and advances predictions ONCE, instead of the old
   * pattern that recomputed-and-readvanced inside `routeScenePredictionErrors`.
   */
  compareScene(snapshot: SceneSnapshot): ScenePredictionResult {
    const confirmed = snapshot.objects.filter(o => o.state === 'confirmed');

    // P2.1 — normalize bbox-centroid movement by the REAL frame dims when the
    // snapshot carries them (live sidecar path), else the legacy defaults.
    const frameW = snapshot.frameWidth ?? DEFAULT_FRAME_W;
    const frameH = snapshot.frameHeight ?? DEFAULT_FRAME_H;

    // On first frame (cold start), there is nothing to compare against — no
    // errors, surprise 0. Predictions are seeded by the subsequent
    // advancePredictions() call, NOT here (this method is pure).
    if (!this.initialized) {
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
    const confirmedIds = new Set(confirmed.map(o => o.trackId));

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
        //
        // WS5 T4/P1c — familiarity habituation. The magnitude is attenuated by
        // how many times this IDENTITY (personId else label) has been seen novel
        // before. First sighting → NOVEL_BASE_MAGNITUDE (1.0, full surprise);
        // each repeat strictly smaller via 1/(1+k·count). This is a PURE READ of
        // the familiarity map here — the count is INCREMENTED once-per-frame in
        // `advancePredictions` (so a double `compareScene` in one frame yields the
        // same magnitude, preserving the pure-comparison contract). Keying on
        // identity (not trackId) is what makes this survive the IoU tracker's
        // fresh-trackId-on-re-entry, so walk-out/walk-back is habituated.
        const key = this.identityKey(obj);
        const seenCount = this.familiarityCounts.get(key) ?? 0;
        const magnitude = NOVEL_BASE_MAGNITUDE / (1 + FAMILIARITY_DECAY_K * seenCount);
        errors.push({
          trackId: obj.trackId,
          label: obj.label,
          errorType: 'novel',
          magnitude,
          personId: obj.personId,
        });
        novelObjects.push(obj);
        continue;
      }

      // Check if it moved significantly.
      const movement = bboxCentroidDistance(
        obj.bbox,
        predicted.expectedBbox,
        frameW,
        frameH,
      );
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

    return { errors, totalSurprise, novelObjects, missingObjects };
  }

  /**
   * MUTATING advance (WS5 T1.0): roll the persistence model forward —
   * "whatever is confirmed now will still be there next frame." Call EXACTLY
   * ONCE per frame, after `compareScene`. Also flips the cold-start guard so the
   * NEXT frame's `compareScene` reports real errors.
   *
   * WS5 T4/P1c: the once-per-frame bookkeeping for habituation lives here (NOT in
   * the pure `compareScene`): the just-computed comparison's novel objects each
   * bump their identity's familiarity count, and the frame's `totalSurprise` +
   * per-identity novel magnitudes are appended to the read-only inspection ring.
   * Doing this in the single mutating call means a double `compareScene` in one
   * frame cannot double-count familiarity. `comparison` is optional only for
   * back-compat with any caller that advances without a comparison (none today in
   * the in-cycle path); when absent, predictions still advance but no familiarity
   * is recorded for that frame.
   */
  advancePredictions(snapshot: SceneSnapshot, comparison?: ScenePredictionResult): void {
    const confirmed = snapshot.objects.filter(o => o.state === 'confirmed');

    if (comparison) {
      // Record the per-identity novel magnitudes the predictor emitted THIS
      // frame, then increment each novel identity's familiarity count so the
      // NEXT sighting (even under a fresh trackId) is habituated.
      const novelMagnitudes: Record<string, number> = {};
      for (const e of comparison.errors) {
        if (e.errorType !== 'novel') continue;
        const key = e.personId ?? e.label;
        novelMagnitudes[key] = e.magnitude;
        this.familiarityCounts.set(key, (this.familiarityCounts.get(key) ?? 0) + 1);
      }
      this.surpriseRing.push({
        seq: this.frameSeq++,
        totalSurprise: comparison.totalSurprise,
        novelMagnitudes,
        at: new Date().toISOString(),
      });
      if (this.surpriseRing.length > SURPRISE_RING_CAP) {
        this.surpriseRing.splice(0, this.surpriseRing.length - SURPRISE_RING_CAP);
      }
    }

    this.initialized = true;
    this.updatePredictions(confirmed);
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
  frameW: number = DEFAULT_FRAME_W,
  frameH: number = DEFAULT_FRAME_H,
): number {
  const cx_a = (a[0] + a[2]) / 2 / frameW;
  const cy_a = (a[1] + a[3]) / 2 / frameH;
  const cx_b = (b[0] + b[2]) / 2 / frameW;
  const cy_b = (b[1] + b[3]) / 2 / frameH;
  return Math.sqrt((cx_a - cx_b) ** 2 + (cy_a - cy_b) ** 2);
}

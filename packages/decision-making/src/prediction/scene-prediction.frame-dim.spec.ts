/**
 * ScenePredictionService — P2.1 frame-dim plumbing (resolution invariance).
 *
 * The "moved" error magnitude is derived from `bboxCentroidDistance`, which
 * normalizes the centroid shift by the frame dims. This proves a movement of the
 * SAME FRACTION of the frame yields the SAME magnitude regardless of camera
 * resolution (the dims are read off the SceneSnapshot), AND that ABSENT dims
 * reproduce the legacy 640x480 normalization byte-identically.
 *
 * Lives in its own spec file (scene-prediction.frame-dim.spec.ts) so it does not
 * share a compilation unit with the pre-existing prediction.service.spec.ts.
 */

import { ScenePredictionService } from './scene-prediction.service';
import type {
  SceneSnapshot,
  TrackedObjectDTO,
  SceneSummary,
} from '@sylphie/shared';

function makeTrack(
  bbox: [number, number, number, number],
  overrides: Partial<TrackedObjectDTO> = {},
): TrackedObjectDTO {
  return {
    trackId: 1,
    state: 'confirmed',
    label: 'cup',
    confidence: 0.9,
    bbox,
    framesSeen: 5,
    framesLost: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    embedding: null,
    ...overrides,
  };
}

function makeSnapshot(
  objects: TrackedObjectDTO[],
  dims?: { w: number; h: number },
): SceneSnapshot {
  const summary: SceneSummary = {
    totalTracks: objects.length,
    confirmedCount: objects.filter((o) => o.state === 'confirmed').length,
    lostCount: 0,
    newCount: 0,
    frameSequence: 1,
  };
  return {
    timestamp: 1,
    frameSequence: 1,
    objects,
    events: [],
    summary,
    ...(dims ? { frameWidth: dims.w, frameHeight: dims.h } : {}),
  };
}

/** A small box centered at (cx, cy). */
function boxAt(cx: number, cy: number): [number, number, number, number] {
  return [cx - 5, cy - 5, cx + 5, cy + 5];
}

/**
 * Prime the predictor with a track at start, then observe it moved by a fixed
 * FRACTION of the frame, and return the emitted "moved" magnitude (or undefined
 * if no moved error fired). `dims` undefined exercises the legacy 640x480 path.
 */
function movedMagnitude(
  dims: { w: number; h: number } | undefined,
  fracX: number,
  fracY: number,
): number | undefined {
  const w = dims?.w ?? 640;
  const h = dims?.h ?? 480;
  const svc = new ScenePredictionService();

  // Frame 1: establish the prediction (track centered).
  const start = makeSnapshot([makeTrack(boxAt(w / 2, h / 2))], dims);
  const r1 = svc.compareScene(start);
  svc.advancePredictions(start, r1);

  // Frame 2: same track, moved by (fracX, fracY) of the frame.
  const movedObj = makeTrack(boxAt(w / 2 + fracX * w, h / 2 + fracY * h));
  const moved = makeSnapshot([movedObj], dims);
  const r2 = svc.compareScene(moved);

  const err = r2.errors.find((e) => e.errorType === 'moved');
  return err?.magnitude;
}

describe('ScenePredictionService — P2.1 resolution invariance', () => {
  // Move by 0.2 of frame width — exceeds MOVEMENT_THRESHOLD (0.15) at any res.
  const FRAC = 0.2;

  it('same fractional movement → same magnitude regardless of resolution', () => {
    const m640 = movedMagnitude({ w: 640, h: 480 }, FRAC, 0);
    const m1280 = movedMagnitude({ w: 1280, h: 720 }, FRAC, 0);

    expect(m640).toBeDefined();
    expect(m1280).toBeDefined();
    expect(m1280!).toBeCloseTo(m640!, 6);
    // 0.2 frac → distance 0.2 → magnitude min(0.2/0.5, 1) = 0.4.
    expect(m640!).toBeCloseTo(0.4, 6);
  });

  it('ABSENT dims → byte-identical to the legacy 640x480 normalization', () => {
    const absent = movedMagnitude(undefined, FRAC, 0);
    const explicit = movedMagnitude({ w: 640, h: 480 }, FRAC, 0);

    expect(absent).toBeDefined();
    expect(explicit).toBeDefined();
    expect(absent!).toBeCloseTo(explicit!, 12);
  });
});

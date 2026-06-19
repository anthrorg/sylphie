/**
 * TK-23 (P4.4) — surprise-cascade property (habituation leg): N distinct changes
 * cannot UNBOUNDEDLY ratchet arousal, because the predictor habituates a REPEATED
 * scene/identity per-identity (scene-prediction.service.ts:161).
 *
 * INVARIANT under test: for a repeated identity, surprise_{k+1} < surprise_k
 * (strictly decreasing via magnitude = NOVEL_BASE / (1 + k·count)). The drive
 * router maps scene surprise to Curiosity = 0.02·s and Anxiety = 0.01·s
 * (rules.ts ScenePrediction, mirrored in
 * ScenePredictionService.recordOutcomeRouted). Therefore the per-exposure
 * Curiosity/Anxiety INCREMENTS form a strictly decreasing series — a familiar
 * scene contributes a shrinking nudge, not a constant ratchet.
 *
 * Curiosity and Anxiety have NO passive decay; the ONLY thing that prevents an
 * unbounded climb from repeated exposure is this per-identity habituation at the
 * surprise source. This test pins that source behavior.
 *
 * Binds to the REAL ScenePredictionService (compareScene/advancePredictions) and
 * the REAL recordOutcomeRouted effect table — not a re-derivation.
 */

import { ScenePredictionService } from './scene-prediction.service';
import type {
  SceneSnapshot,
  TrackedObjectDTO,
  SceneSummary,
} from '@sylphie/shared';

/** Drive-router effect table for a ScenePrediction outcome (rules.ts). */
const CURIOSITY_PER_SURPRISE = 0.02;
const ANXIETY_PER_SURPRISE = 0.01;

function makeTrack(
  trackId: number,
  label: string,
  overrides: Partial<TrackedObjectDTO> = {},
): TrackedObjectDTO {
  return {
    trackId,
    state: 'confirmed',
    label,
    confidence: 1.0,
    bbox: [10, 10, 50, 50],
    framesSeen: 5,
    framesLost: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    embedding: null,
    ...overrides,
  };
}

function makeSnapshot(objects: TrackedObjectDTO[]): SceneSnapshot {
  const summary: SceneSummary = {
    totalTracks: objects.length,
    confirmedCount: objects.filter((o) => o.state === 'confirmed').length,
    lostCount: 0,
    newCount: 0,
    frameSequence: 1,
  };
  return { timestamp: 1, frameSequence: 1, objects, events: [], summary };
}

/**
 * Walk a SINGLE identity (`teapot`) in and out of view N times, returning the
 * novel-surprise emitted on each RE-entry. Each re-entry uses a FRESH trackId,
 * exactly like the IoU tracker assigning a new monotonic id on re-entry
 * (tracker.py:276,284) — so this also proves habituation is keyed on identity,
 * not trackId. The empty intervening frame clears the predicted scene so the next
 * sighting is genuinely "novel" by trackId.
 */
function repeatedIdentitySurpriseSeries(n: number): number[] {
  const svc = new ScenePredictionService();
  const series: number[] = [];

  for (let k = 0; k < n; k++) {
    // Frame: the teapot is present under a fresh trackId.
    const present = makeSnapshot([makeTrack(100 + k, 'teapot')]);
    const r = svc.compareScene(present);
    const novel = r.errors.find((e) => e.errorType === 'novel');
    // After the very first sighting, every re-entry is a novel error.
    if (novel) series.push(r.totalSurprise);
    svc.advancePredictions(present, r);

    // Frame: empty scene — the teapot "leaves" so the next sighting is novel.
    const empty = makeSnapshot([]);
    svc.advancePredictions(empty, svc.compareScene(empty));
  }

  return series;
}

describe('TK-23 surprise-cascade — repeated identity habituates (no constant ratchet)', () => {
  it('surprise_{k+1} < surprise_k for a repeated identity (strictly decreasing)', () => {
    const series = repeatedIdentitySurpriseSeries(6);

    // We saw the identity novel multiple times.
    expect(series.length).toBeGreaterThanOrEqual(4);

    // Strictly decreasing across the whole series.
    for (let i = 1; i < series.length; i++) {
      expect(series[i]).toBeLessThan(series[i - 1]);
    }

    // First sighting is full magnitude (NOVEL_BASE = 1.0); habituation pulls each
    // re-sighting strictly below it.
    expect(series[0]).toBeCloseTo(1.0, 6);
    expect(series[series.length - 1]).toBeLessThan(series[0]);
  });

  it('the Curiosity/Anxiety pressure increments form a strictly DECREASING series', () => {
    const series = repeatedIdentitySurpriseSeries(6);

    // Map each surprise to the drive increments the router would apply.
    const curiosityIncrements = series.map((s) => CURIOSITY_PER_SURPRISE * s);
    const anxietyIncrements = series.map((s) => ANXIETY_PER_SURPRISE * s);

    for (let i = 1; i < series.length; i++) {
      expect(curiosityIncrements[i]).toBeLessThan(curiosityIncrements[i - 1]);
      expect(anxietyIncrements[i]).toBeLessThan(anxietyIncrements[i - 1]);
    }
  });

  it('recordOutcomeRouted reflects the SAME 0.02·s / 0.01·s effect table (no theater)', () => {
    // Pin the increment constants this test uses to the production router seam,
    // so a future change to the effect table breaks BOTH together rather than
    // letting this test drift.
    const svc = new ScenePredictionService();
    const s = 0.4;
    svc.recordOutcomeRouted(s);
    const routed = svc.getState().lastRoutedOutcome;
    expect(routed).not.toBeNull();
    expect(routed!.computedEffects.curiosity).toBeCloseTo(CURIOSITY_PER_SURPRISE * s, 12);
    expect(routed!.computedEffects.anxiety).toBeCloseTo(ANXIETY_PER_SURPRISE * s, 12);
  });

  it('a genuinely NEW identity still fires full surprise (requisite variety preserved)', () => {
    // Habituation is per-identity, not global: after habituating the teapot, a
    // brand-new label fires full novel surprise — the bound is NOT a global cap.
    const svc = new ScenePredictionService();
    for (let k = 0; k < 4; k++) {
      const present = makeSnapshot([makeTrack(100 + k, 'teapot')]);
      svc.advancePredictions(present, svc.compareScene(present));
      const empty = makeSnapshot([]);
      svc.advancePredictions(empty, svc.compareScene(empty));
    }
    // A novel, never-seen identity now:
    const newcomer = makeSnapshot([makeTrack(999, 'umbrella')]);
    const r = svc.compareScene(newcomer);
    expect(r.totalSurprise).toBeCloseTo(1.0, 6);
  });
});

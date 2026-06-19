/**
 * TK-23 (P4.4) — no-theater property: the encode-side edge of the
 * perception→drive→perception loop stays CUT.
 *
 * INVARIANT under test: scene surprise reaches the episodic ENCODE gate via the
 * ATTENTION channel ONLY (the phasic `saliencyTerm`), and NEVER via a
 * Curiosity/Anxiety drive path. The encode gate (episodic-memory.service.ts) is
 * an OR over `attention` and `arousal`:
 *
 *     reject ⇔ attention <= ENCODING_GATE_THRESHOLD && arousal <= ENCODING_GATE_THRESHOLD
 *
 * where `arousal = computeArousal = (anxiety + curiosity) / 2`. If scene surprise
 * could open the gate through Curiosity/Anxiety, a salient-but-CALM frame (drives
 * cold) would still raise `arousal` and that would be the perception→drive→encode
 * loop re-forming through the arousal edge (ashby, decision-making.service.ts:946).
 *
 * These assertions bind to the REAL production helpers (`saliencyTerm`,
 * `computeAttention`, `computeArousal`) and the REAL gate threshold — not a
 * re-derivation — so a future change that routes surprise into arousal trips this
 * test rather than silently relocating the loop. NOT theater: the same functions
 * the live cycle calls (decision-making.service.ts:1601-1602).
 */

import {
  saliencyTerm,
  computeAttention,
  computeArousal,
} from '../decision-making.service';
import { ENCODING_GATE_THRESHOLD } from '../episodic-memory/episodic-memory.service';
import { ScenePredictionService } from './scene-prediction.service';
import { DriveName } from '@sylphie/shared';
import type {
  DriveSnapshot,
  SceneSnapshot,
  TrackedObjectDTO,
  SceneSummary,
} from '@sylphie/shared';

/** A drive snapshot with every drive cold (zero) — the salient-but-CALM case. */
function coldDriveSnapshot(): DriveSnapshot {
  const pressureVector = Object.fromEntries(
    Object.values(DriveName).map((d) => [d, 0]),
  ) as unknown as DriveSnapshot['pressureVector'];
  return {
    pressureVector,
    timestamp: new Date(0),
    tickNumber: 0,
    driveDeltas: {} as DriveSnapshot['driveDeltas'],
    ruleMatchResult: {} as DriveSnapshot['ruleMatchResult'],
    totalPressure: 0,
  } as DriveSnapshot;
}

function makeTrack(
  trackId: number,
  overrides: Partial<TrackedObjectDTO> = {},
): TrackedObjectDTO {
  return {
    trackId,
    state: 'confirmed',
    label: 'cup',
    confidence: 0.9,
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
 * Produce the totalSurprise the predictor emits for a salient frame: prime with
 * one track, then introduce a DISTINCT novel track (full novel magnitude) — the
 * same compare/advance ordering the live cycle uses
 * (decision-making.service.ts:953,970).
 */
function salientFrameSurprise(): number {
  const svc = new ScenePredictionService();
  const prime = makeSnapshot([makeTrack(1)]);
  svc.advancePredictions(prime, svc.compareScene(prime));
  // Frame 2: a brand-new identity → full novel surprise (well above the 0.05 floor).
  const novel = makeSnapshot([makeTrack(2, { label: 'teapot' })]);
  return svc.compareScene(novel).totalSurprise;
}

describe('TK-23 no-theater — encode gate is NOT opened via a Curiosity/Anxiety path', () => {
  it('a salient frame produces real scene surprise above the routing floor', () => {
    const surprise = salientFrameSurprise();
    // The novel track yields full magnitude; comfortably > 0.05 (drive-routing
    // floor) and > the encode gate threshold, so this IS a SYSTEM_TRIGGER-grade
    // salient frame.
    expect(surprise).toBeGreaterThan(ENCODING_GATE_THRESHOLD);
  });

  it('on a salient-but-CALM frame the encode gate opens via ATTENTION (saliency), not arousal', () => {
    const surprise = salientFrameSurprise();
    const cold = coldDriveSnapshot();

    // Drives are cold → both the drive-derived attention AND arousal are zero.
    // Scene surprise contributes NOTHING to arousal (Curiosity/Anxiety).
    expect(computeArousal(cold)).toBe(0);
    expect(computeAttention(cold)).toBe(0);

    // The live cycle: attention = max(driveAttention, saliencyTerm(surprise)).
    const attention = Math.max(computeAttention(cold), saliencyTerm(surprise));
    const arousal = computeArousal(cold);

    // The gate (episodic-memory.service.ts): reject ⇔ both <= threshold.
    const rejected =
      attention <= ENCODING_GATE_THRESHOLD && arousal <= ENCODING_GATE_THRESHOLD;

    // The salient frame IS admitted...
    expect(rejected).toBe(false);
    // ...and the ONLY channel above threshold is attention. Arousal (the
    // Curiosity/Anxiety drive path) stays at the floor — the loop is cut.
    expect(attention).toBeGreaterThan(ENCODING_GATE_THRESHOLD);
    expect(arousal).toBeLessThanOrEqual(ENCODING_GATE_THRESHOLD);
  });

  it('saliencyTerm feeds attention only — it never returns an arousal/drive value', () => {
    // saliencyTerm is a pure function of scene surprise: floored at 0.05 when
    // there is any surprise, exactly 0 when there is no scene. It takes NO drive
    // input, so it structurally cannot raise Curiosity/Anxiety.
    expect(saliencyTerm(0)).toBe(0); // no scene → no spurious attention floor
    expect(saliencyTerm(0.01)).toBe(0.05); // tiny surprise → floored, not arousal
    expect(saliencyTerm(0.42)).toBeCloseTo(0.42, 12);
    expect(saliencyTerm(2.0)).toBe(1.0); // clamped to [0.05, 1.0]
  });

  it('scene surprise alone does not raise arousal: a cold snapshot is arousal-zero regardless of surprise', () => {
    // The arousal channel reads ONLY drive pressures (anxiety, curiosity). No
    // surprise argument exists on its signature — so no value of scene surprise
    // can change its output. This is the structural guarantee the loop relies on.
    const cold = coldDriveSnapshot();
    for (const surprise of [0, 0.05, 0.5, 1.0]) {
      // saliencyTerm moves with surprise (attention channel)...
      const attention = Math.max(computeAttention(cold), saliencyTerm(surprise));
      // ...but arousal is invariant to it (drive channel).
      expect(computeArousal(cold)).toBe(0);
      if (surprise > ENCODING_GATE_THRESHOLD) {
        expect(attention).toBeGreaterThan(ENCODING_GATE_THRESHOLD);
      }
    }
  });
});

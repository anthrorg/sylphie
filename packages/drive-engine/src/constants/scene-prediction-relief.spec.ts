/**
 * TK-22 (P4.3) — AC3 drive-side proof: the EXACT ScenePrediction ActionOutcome
 * payload that routeScenePredictionErrors emits (decision-making.service.ts)
 * yields ZERO relief through the real computeDefaultAffect.
 *
 * The sibling rules.spec.ts already pins the metadata-scaling goldens and a
 * relief invariant — but it builds its payload with feedbackSource
 * 'algorithmic'. routeScenePredictionErrors emits feedbackSource 'INFERENCE'
 * (no OUTCOME_DEFAULTS row → no bonus). This spec closes that gap: it runs the
 * BYTE-FOR-BYTE emitted payload (actionType 'ScenePrediction', metadata
 * { sceneSurprise }, feedbackSource 'INFERENCE') through the SAME rule table the
 * drive engine applies and asserts every produced delta is non-negative
 * (pressure-only — no drive_events row with relief>0).
 *
 * AD-0004: asserts against the EXISTING rule table and EXISTING payload — no new
 * field, no new IPC.
 */

import { DriveName } from '@sylphie/shared';
import type { ActionOutcomePayload } from '@sylphie/shared';
import { computeDefaultAffect } from './rules';

/**
 * Reconstruct the payload routeScenePredictionErrors emits for a given surprise.
 * Mirrors decision-making.service.ts: actionId 'scene-prediction',
 * actionType 'ScenePrediction', metadata { sceneSurprise }, feedbackSource
 * 'INFERENCE', success = surprise < 0.2, non-theatrical.
 */
function emittedScenePredictionPayload(sceneSurprise: number): ActionOutcomePayload {
  return {
    actionId: 'scene-prediction',
    actionType: 'ScenePrediction',
    success: sceneSurprise < 0.2,
    metadata: { sceneSurprise },
    feedbackSource: 'INFERENCE',
    theaterCheck: {
      expressionType: 'none',
      correspondingDrive: null,
      driveValue: null,
      isTheatrical: false,
    },
  } as unknown as ActionOutcomePayload;
}

describe('ScenePrediction emitted-payload relief invariant (TK-22 AC3)', () => {
  // The signal only routes when surprise >= 0.05; sample the routed range to the
  // [0,1] ceiling, including the threshold boundary.
  const surprises = [0.05, 0.2, 0.5, 0.75, 0.99, 1.0];

  it.each(surprises)(
    'INFERENCE-sourced ScenePrediction payload yields zero relief at sceneSurprise=%p',
    (s) => {
      const effects = computeDefaultAffect(emittedScenePredictionPayload(s));

      const deltas = Object.values(effects);
      expect(deltas.length).toBeGreaterThan(0);
      for (const delta of deltas) {
        // relief = a negative delta. ScenePrediction is pressure-only.
        expect(delta as number).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it('scales exactly Curiosity=0.02*s and Anxiety=0.01*s for the emitted payload (no extra axes)', () => {
    const effects = computeDefaultAffect(emittedScenePredictionPayload(0.5));
    expect(effects[DriveName.Curiosity]).toBeCloseTo(0.01, 12);
    expect(effects[DriveName.Anxiety]).toBeCloseTo(0.005, 12);
    // feedbackSource 'INFERENCE' adds no OUTCOME_DEFAULTS bonus → only two axes.
    expect(new Set(Object.keys(effects))).toEqual(
      new Set([DriveName.Curiosity, DriveName.Anxiety]),
    );
  });
});

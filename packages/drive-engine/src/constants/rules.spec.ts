/**
 * Unit tests for the Rule Engine default-affect computation — ScenePrediction.
 *
 * Part of the vision "first green baseline" (jest, mirrors the sibling specs:
 * ipc-message-validator.spec.ts, cross-modulation.spec.ts). Pins the contract
 * for the ScenePrediction sensory signal the perception pipeline emits:
 *
 *   1. computeDefaultAffect('ScenePrediction', { sceneSurprise: s }) scales the
 *      ACTION_TYPE_DEFAULTS map ({Curiosity: 0.02, Anxiety: 0.01}) by s, for
 *      s in {0, 0.5, 1.0}.
 *   2. 'ScenePrediction' is registered in METADATA_SCALED_ACTION_TYPES, so the
 *      drive engine multiplies (not flat-applies) its effects.
 *   3. RELIEF INVARIANT: ScenePrediction never produces a negative (relief)
 *      delta on any axis — it is a pressure-only signal.
 *
 * Goldens below were produced by RUNNING the real computeDefaultAffect.
 */

import { DriveName } from '@sylphie/shared';
import type { ActionOutcomePayload } from '@sylphie/shared';
import { computeDefaultAffect, METADATA_SCALED_ACTION_TYPES } from './rules';

/**
 * Minimal, fully-typed ACTION_OUTCOME payload for a ScenePrediction signal
 * carrying a given scene-surprise magnitude. computeDefaultAffect only reads
 * actionType / metadata / feedbackSource; the rest are inert interface members.
 */
function scenePrediction(sceneSurprise: number): ActionOutcomePayload {
  return {
    actionId: 'test-action',
    actionType: 'ScenePrediction',
    outcome: 'positive',
    metadata: { sceneSurprise },
    feedbackSource: 'algorithmic',
    theaterCheck: {
      expressionType: 'none',
      driveValueAtExpression: 0,
      drive: DriveName.Curiosity,
      isTheatrical: false,
    },
    anxietyAtExecution: 0,
  };
}

describe('rules — ScenePrediction metadata scaling', () => {
  // Goldens pinned by running the real computeDefaultAffect:
  //   s=0   -> { curiosity: 0,    anxiety: 0     }
  //   s=0.5 -> { curiosity: 0.01, anxiety: 0.005 }
  //   s=1.0 -> { curiosity: 0.02, anxiety: 0.01  }
  const cases: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0],
    [0.5, 0.01, 0.005],
    [1.0, 0.02, 0.01],
  ];

  it.each(cases)(
    'scales Curiosity=0.02*s and Anxiety=0.01*s for sceneSurprise=%p',
    (s, expectedCuriosity, expectedAnxiety) => {
      const effects = computeDefaultAffect(scenePrediction(s));
      expect(effects[DriveName.Curiosity]).toBe(expectedCuriosity);
      expect(effects[DriveName.Anxiety]).toBe(expectedAnxiety);
      // Only the two ScenePrediction axes are touched (algorithmic feedback adds nothing).
      expect(new Set(Object.keys(effects))).toEqual(
        new Set([DriveName.Curiosity, DriveName.Anxiety]),
      );
    },
  );
});

describe('rules — METADATA_SCALED_ACTION_TYPES membership', () => {
  it("'ScenePrediction' is a metadata-scaled action type", () => {
    expect(METADATA_SCALED_ACTION_TYPES.has('ScenePrediction')).toBe(true);
  });
});

describe('rules — ScenePrediction relief invariant', () => {
  // Sample across the full [0, 1] surprise range, including the boundaries.
  it.each([0, 0.25, 0.5, 0.75, 1.0])(
    'never produces a relief (negative) delta on any axis at sceneSurprise=%p',
    (s) => {
      const effects = computeDefaultAffect(scenePrediction(s));
      for (const delta of Object.values(effects)) {
        expect(delta as number).toBeGreaterThanOrEqual(0);
      }
    },
  );
});

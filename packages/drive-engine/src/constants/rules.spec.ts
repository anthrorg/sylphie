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

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// ---------------------------------------------------------------------------
// AD-0004 guard — reuse sceneSurprise; NO distinct presenceSurprise axis
// ---------------------------------------------------------------------------

/**
 * Recursively collect every production .ts source file under a directory.
 * Excludes *.spec.ts so the guard scans only shipped source, not test text
 * (this spec necessarily mentions the forbidden identifier in its assertion).
 */
function productionTsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionTsFilesUnder(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('rules — AD-0004: no presenceSurprise axis in drive-engine src', () => {
  const FORBIDDEN = 'presence' + 'Surprise'; // split so this spec is not self-matching

  it('the forbidden identifier appears in no production source file under packages/drive-engine/src', () => {
    // AD-0004 reversed the original Fork-C plan: the live sceneSurprise path
    // already produces the Curiosity+Anxiety PRESSURE the ticket wants, so a
    // separate presence-surprise field/axis must NOT be introduced. This static
    // guard fails the moment such an identifier is reintroduced in shipped
    // drive-engine source. `src` is one level up from this spec's directory.
    const srcRoot = join(__dirname, '..');
    const offenders = productionTsFilesUnder(srcRoot).filter((file) =>
      readFileSync(file, 'utf8').includes(FORBIDDEN),
    );
    expect(offenders).toEqual([]);
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

// ---------------------------------------------------------------------------
// TK-86: InboundHostility action type — AC-1 and AC-2
// ---------------------------------------------------------------------------

/**
 * Minimal ACTION_OUTCOME payload for an InboundHostility signal.
 * hostilityMagnitude in [0,1] — the lexical affect magnitude of the hostile turn.
 */
function inboundHostility(hostilityMagnitude: number): ActionOutcomePayload {
  return {
    actionId: 'test-inbound-hostility',
    actionType: 'InboundHostility',
    outcome: 'negative',
    metadata: { hostilityMagnitude },
    feedbackSource: 'algorithmic',
    theaterCheck: {
      expressionType: 'none',
      driveValueAtExpression: 0,
      drive: DriveName.Anxiety,
      isTheatrical: false,
    },
    anxietyAtExecution: 0,
  };
}

describe('rules — InboundHostility metadata scaling (AC-1, AC-2)', () => {
  // Goldens pinned by running computeDefaultAffect:
  //   m=0   -> { anxiety: 0,     social: 0    }
  //   m=0.5 -> { anxiety: 0.075, social: 0.05 }
  //   m=1.0 -> { anxiety: 0.15,  social: 0.10 }
  const cases: ReadonlyArray<readonly [number, number, number]> = [
    [0,   0,     0    ],
    [0.5, 0.075, 0.05 ],
    [1.0, 0.15,  0.10 ],
  ];

  it.each(cases)(
    'scales Anxiety=0.15*m and Social=0.10*m for hostilityMagnitude=%p',
    (m, expectedAnxiety, expectedSocial) => {
      const effects = computeDefaultAffect(inboundHostility(m));
      // Use closeTo for floating-point arithmetic (0.15 * 0.5 = 0.075000…0001)
      expect(effects[DriveName.Anxiety]).toBeCloseTo(expectedAnxiety, 10);
      expect(effects[DriveName.Social]).toBeCloseTo(expectedSocial, 10);
      // Only Anxiety and Social are touched (algorithmic feedback adds nothing).
      expect(new Set(Object.keys(effects))).toEqual(
        new Set([DriveName.Anxiety, DriveName.Social]),
      );
    },
  );
});

describe('rules — InboundHostility METADATA_SCALED_ACTION_TYPES membership (AC-1)', () => {
  it("'InboundHostility' is registered as a metadata-scaled action type", () => {
    expect(METADATA_SCALED_ACTION_TYPES.has('InboundHostility')).toBe(true);
  });
});

describe('rules — InboundHostility relief invariant (AC-2: no relief on any axis)', () => {
  // Sample across the full [0, 1] magnitude range.
  it.each([0, 0.1, 0.25, 0.5, 0.75, 1.0])(
    'never produces a relief (negative) delta on any axis at hostilityMagnitude=%p',
    (m) => {
      const effects = computeDefaultAffect(inboundHostility(m));
      for (const delta of Object.values(effects)) {
        // AC-2: assert zero relief — no axis may go negative (pressure-only signal)
        expect(delta as number).toBeGreaterThanOrEqual(0);
      }
    },
  );
});

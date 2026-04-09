/**
 * Unit tests for cross-modulation rule engine.
 *
 * Covers:
 *   1. Each individual rule in isolation
 *   2. Rules do not fire when source is below threshold
 *   3. Multiplicative mode: target *= (1 - coefficient * source)
 *   4. Additive mode: target += coefficient * source
 *   5. Additive gap mode: target += coefficient * (source - threshold)
 *   6. Cascading effects (rule ordering matters)
 *   7. Custom rule array injection
 *   8. No-op when all sources are below thresholds
 */

import { DriveName } from '@sylphie/shared';
import {
  applyCrossModulation,
  applyRule,
  CROSS_MODULATION_RULES,
  type CrossModulationRule,
} from './cross-modulation';

// Suppress verbose logging during tests
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return {
    ...actual,
    verboseFor: () => () => {},
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a zeroed drive state with optional overrides. */
function createDriveState(
  overrides: Partial<Record<DriveName, number>> = {},
): Record<DriveName, number> {
  const state: Record<DriveName, number> = {
    [DriveName.SystemHealth]: 0,
    [DriveName.MoralValence]: 0,
    [DriveName.Integrity]: 0,
    [DriveName.CognitiveAwareness]: 0,
    [DriveName.Guilt]: 0,
    [DriveName.Curiosity]: 0,
    [DriveName.Boredom]: 0,
    [DriveName.Anxiety]: 0,
    [DriveName.Satisfaction]: 0,
    [DriveName.Sadness]: 0,
    [DriveName.Focus]: 0,
    [DriveName.Social]: 0,
  };
  return { ...state, ...overrides };
}

/** Get a specific rule by ID from the registry. */
function getRule(id: string): CrossModulationRule {
  const rule = CROSS_MODULATION_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`Rule not found: ${id}`);
  return rule;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossModulationRule registry', () => {
  it('should have exactly 5 active rules', () => {
    expect(CROSS_MODULATION_RULES).toHaveLength(5);
  });

  it('should have unique IDs for all rules', () => {
    const ids = CROSS_MODULATION_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('applyRule (individual rule evaluation)', () => {
  describe('satisfaction-suppresses-boredom (multiplicative)', () => {
    const rule = getRule('satisfaction-suppresses-boredom');

    it('should not fire when satisfaction <= threshold', () => {
      const state = createDriveState({
        [DriveName.Satisfaction]: 0.5, // <= 0.6
        [DriveName.Boredom]: 0.8,
      });

      const effect = applyRule(rule, state);

      expect(effect.fired).toBe(false);
      expect(state[DriveName.Boredom]).toBe(0.8); // unchanged
    });

    it('should reduce boredom multiplicatively when satisfaction > threshold', () => {
      const state = createDriveState({
        [DriveName.Satisfaction]: 0.8,
        [DriveName.Boredom]: 0.6,
      });

      const effect = applyRule(rule, state);

      expect(effect.fired).toBe(true);
      // boredom *= (1 - 0.03 * 0.8) = 0.6 * 0.976 = 0.5856
      expect(state[DriveName.Boredom]).toBeCloseTo(0.6 * (1 - 0.03 * 0.8), 6);
    });

    it('should produce maximum suppression at satisfaction=1.0', () => {
      const state = createDriveState({
        [DriveName.Satisfaction]: 1.0,
        [DriveName.Boredom]: 1.0,
      });

      applyRule(rule, state);

      // boredom *= (1 - 0.03 * 1.0) = 0.97
      expect(state[DriveName.Boredom]).toBeCloseTo(0.97, 6);
    });
  });

  describe('anxiety-amplifies-integrity (additive)', () => {
    const rule = getRule('anxiety-amplifies-integrity');

    it('should not fire when anxiety <= threshold', () => {
      const state = createDriveState({
        [DriveName.Anxiety]: 0.7, // <= threshold (not >)
        [DriveName.Integrity]: 0.3,
      });

      const effect = applyRule(rule, state);

      expect(effect.fired).toBe(false);
      expect(state[DriveName.Integrity]).toBe(0.3);
    });

    it('should increase integrity additively when anxiety > threshold', () => {
      const state = createDriveState({
        [DriveName.Anxiety]: 0.85,
        [DriveName.Integrity]: 0.3,
      });

      const effect = applyRule(rule, state);

      expect(effect.fired).toBe(true);
      // integrity += 0.0012 * 0.85 = 0.3 + 0.00102 = 0.30102
      expect(state[DriveName.Integrity]).toBeCloseTo(0.3 + 0.0012 * 0.85, 6);
    });
  });

  describe('system-health-amplifies-anxiety (additive_gap)', () => {
    const rule = getRule('system-health-amplifies-anxiety');

    it('should not fire when systemHealth <= threshold', () => {
      const state = createDriveState({
        [DriveName.SystemHealth]: 0.7,
        [DriveName.Anxiety]: 0.3,
      });

      const effect = applyRule(rule, state);

      expect(effect.fired).toBe(false);
      expect(state[DriveName.Anxiety]).toBe(0.3);
    });

    it('should increase anxiety proportional to gap above threshold', () => {
      const state = createDriveState({
        [DriveName.SystemHealth]: 0.9,
        [DriveName.Anxiety]: 0.3,
      });

      const effect = applyRule(rule, state);

      expect(effect.fired).toBe(true);
      // anxiety += 0.003 * (0.9 - 0.7) = 0.3 + 0.0006
      expect(state[DriveName.Anxiety]).toBeCloseTo(0.3 + 0.003 * 0.2, 6);
    });
  });

  describe('boredom-amplifies-curiosity (additive_gap)', () => {
    const rule = getRule('boredom-amplifies-curiosity');

    it('should not fire when boredom <= threshold', () => {
      const state = createDriveState({
        [DriveName.Boredom]: 0.5,
        [DriveName.Curiosity]: 0.4,
      });

      const effect = applyRule(rule, state);

      expect(effect.fired).toBe(false);
      expect(state[DriveName.Curiosity]).toBe(0.4);
    });

    it('should increase curiosity proportional to gap above threshold', () => {
      const state = createDriveState({
        [DriveName.Boredom]: 0.9,
        [DriveName.Curiosity]: 0.4,
      });

      const effect = applyRule(rule, state);

      expect(effect.fired).toBe(true);
      // curiosity += 0.003 * (0.9 - 0.6) = 0.4 + 0.0009
      expect(state[DriveName.Curiosity]).toBeCloseTo(0.4 + 0.003 * 0.3, 6);
    });
  });

  describe('guilt-suppresses-satisfaction (multiplicative)', () => {
    const rule = getRule('guilt-suppresses-satisfaction');

    it('should not fire when guilt <= threshold', () => {
      const state = createDriveState({
        [DriveName.Guilt]: 0.3,
        [DriveName.Satisfaction]: 0.7,
      });

      const effect = applyRule(rule, state);

      expect(effect.fired).toBe(false);
      expect(state[DriveName.Satisfaction]).toBe(0.7);
    });

    it('should reduce satisfaction multiplicatively when guilt > threshold', () => {
      const state = createDriveState({
        [DriveName.Guilt]: 0.8,
        [DriveName.Satisfaction]: 0.7,
      });

      const effect = applyRule(rule, state);

      expect(effect.fired).toBe(true);
      // satisfaction *= (1 - 0.03 * 0.8) = 0.7 * 0.976 = 0.6832
      expect(state[DriveName.Satisfaction]).toBeCloseTo(0.7 * (1 - 0.03 * 0.8), 6);
    });
  });
});

describe('applyCrossModulation (full pipeline)', () => {
  it('should be a no-op when all sources are below thresholds', () => {
    const state = createDriveState({
      [DriveName.Satisfaction]: 0.3,
      [DriveName.Anxiety]: 0.2,
      [DriveName.SystemHealth]: 0.1,
      [DriveName.Boredom]: 0.4,
      [DriveName.Guilt]: 0.1,
      [DriveName.Integrity]: 0.5,
      [DriveName.Curiosity]: 0.5,
    });
    const before = { ...state };

    applyCrossModulation(state);

    // All drive values should be unchanged
    for (const drive of Object.values(DriveName)) {
      expect(state[drive]).toBe(before[drive]);
    }
  });

  it('should apply multiple rules when multiple sources exceed thresholds', () => {
    const state = createDriveState({
      [DriveName.Satisfaction]: 0.8,   // > 0.6 -> suppresses boredom
      [DriveName.Guilt]: 0.6,         // > 0.4 -> suppresses satisfaction
      [DriveName.Boredom]: 0.8,
    });

    applyCrossModulation(state);

    // Boredom should be reduced (satisfaction > 0.6)
    expect(state[DriveName.Boredom]).toBeLessThan(0.8);
    // Satisfaction should be reduced (guilt > 0.4)
    expect(state[DriveName.Satisfaction]).toBeLessThan(0.8);
  });

  it('should demonstrate cascading effects (boredom suppressed then read by curiosity rule)', () => {
    const state = createDriveState({
      [DriveName.Satisfaction]: 0.9,   // Rule 1: suppresses boredom
      [DriveName.Boredom]: 0.8,       // Rule 4: amplifies curiosity (after suppression)
      [DriveName.Curiosity]: 0.3,
    });

    applyCrossModulation(state);

    // Boredom is first suppressed by satisfaction
    const suppressedBoredom = 0.8 * (1 - 0.03 * 0.9);
    expect(state[DriveName.Boredom]).toBeCloseTo(suppressedBoredom, 6);

    // Curiosity is then amplified by the SUPPRESSED boredom value
    // Since suppressedBoredom > 0.6, the curiosity rule fires
    const boredomGap = suppressedBoredom - 0.6;
    const expectedCuriosity = 0.3 + 0.003 * boredomGap;
    expect(state[DriveName.Curiosity]).toBeCloseTo(expectedCuriosity, 6);
  });

  it('should accept a custom rule array', () => {
    const customRules: CrossModulationRule[] = [
      {
        id: 'test-rule',
        source: DriveName.Social,
        target: DriveName.Sadness,
        threshold: 0.5,
        mode: 'additive',
        coefficient: 0.01,
        description: 'Test rule: high social increases sadness.',
      },
    ];

    const state = createDriveState({
      [DriveName.Social]: 0.8,
      [DriveName.Sadness]: 0.1,
    });

    applyCrossModulation(state, customRules);

    // sadness += 0.01 * 0.8 = 0.108
    expect(state[DriveName.Sadness]).toBeCloseTo(0.1 + 0.01 * 0.8, 6);
  });
});

describe('behavioral equivalence with old implementation', () => {
  it('should produce identical results to the pre-refactor code for a representative state', () => {
    // This test encodes the exact behavior of the old procedural implementation
    // to ensure the refactoring is a pure internal change with no behavioral drift.
    const state = createDriveState({
      [DriveName.Satisfaction]: 0.75,
      [DriveName.Anxiety]: 0.85,
      [DriveName.SystemHealth]: 0.80,
      [DriveName.Boredom]: 0.70,
      [DriveName.Guilt]: 0.55,
      [DriveName.Integrity]: 0.40,
      [DriveName.Curiosity]: 0.50,
    });

    applyCrossModulation(state);

    // Rule 1: satisfaction(0.75) > 0.6 -> boredom *= (1 - 0.03 * 0.75)
    const expectedBoredom = 0.70 * (1 - 0.03 * 0.75);

    // Rule 2: anxiety(0.85) > 0.7 -> integrity += 0.0012 * 0.85
    const expectedIntegrity = 0.40 + 0.0012 * 0.85;

    // Rule 3: systemHealth(0.80) > 0.7 -> anxiety += 0.003 * (0.80 - 0.7)
    const expectedAnxiety = 0.85 + 0.003 * (0.80 - 0.7);

    // Rule 4: boredom (already modified) > 0.6 -> curiosity += 0.003 * (boredom - 0.6)
    const expectedCuriosity = expectedBoredom > 0.6
      ? 0.50 + 0.003 * (expectedBoredom - 0.6)
      : 0.50;

    // Rule 5: guilt(0.55) > 0.4 -> satisfaction *= (1 - 0.03 * 0.55)
    const expectedSatisfaction = 0.75 * (1 - 0.03 * 0.55);

    expect(state[DriveName.Boredom]).toBeCloseTo(expectedBoredom, 10);
    expect(state[DriveName.Integrity]).toBeCloseTo(expectedIntegrity, 10);
    expect(state[DriveName.Anxiety]).toBeCloseTo(expectedAnxiety, 10);
    expect(state[DriveName.Curiosity]).toBeCloseTo(expectedCuriosity, 10);
    expect(state[DriveName.Satisfaction]).toBeCloseTo(expectedSatisfaction, 10);
  });
});

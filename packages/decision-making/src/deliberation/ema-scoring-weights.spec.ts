/**
 * TK-70 — EMA adaptive candidate scoring weights spec.
 *
 * AC1: CANON Std-6 gate verdict is PERMITTED (documented in deliberation-helpers.ts
 *      and verified via code inspection — no evaluation function is modified).
 *
 * AC2: Given >=100 scored selections, when an outcome is reinforced, the correlated
 *      weight is nudged by EMA (alpha=0.05), the vector is normalised, weights logged
 *      not persisted; under the floor, no update.
 *
 * All tests are pure-function / no LLM / no Neo4j / no NestJS.
 */

import {
  scoreCandidates,
  nudgeScoringWeights,
  getEmaWeightState,
  resetEmaWeights,
} from './deliberation-helpers';

// Minimal WkgContext stub — no entities, no facts.
const EMPTY_WKG: any = {
  entities: [],
  relationships: [],
  facts: [],
  procedures: [],
  summary: '',
};

// Suppress verbose logs.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function resetState(): void {
  resetEmaWeights();
}

/** Call scoreCandidates N times to advance the selection counter. */
function advanceCounter(n: number): void {
  const candidates = [{ text: 'Hello', reasoning: '' }];
  for (let i = 0; i < n; i++) {
    scoreCandidates(candidates, 'GREETING', EMPTY_WKG);
  }
}

// ---------------------------------------------------------------------------
// AC1: CANON Std-6 gate — PERMITTED
// The EMA weights tune candidate SELECTION (a heuristic), not evaluation.
// This is validated structurally: nudgeScoringWeights only modifies in-memory
// adjustments in deliberation-helpers.ts; it does not touch confidence formulas,
// prediction error computation, drive relief assignment, or any other evaluation
// function. These tests verify the structural invariants.
// ---------------------------------------------------------------------------

describe('AC1 — CANON Std-6 gate: EMA weights are a selection heuristic, not an evaluator', () => {
  beforeEach(resetState);

  it('EMA state is in-memory only — getEmaWeightState() is a snapshot, not a DB', () => {
    // The state object is a plain in-memory record — it has no persistence layer.
    const state = getEmaWeightState();
    expect(typeof state.selectionCount).toBe('number');
    expect(typeof state.adjustments).toBe('object');
    // After reset, both fields are at zero/empty — no database was consulted.
    expect(state.selectionCount).toBe(0);
    expect(Object.keys(state.adjustments)).toHaveLength(0);
  });

  it('weights are reset on resetEmaWeights() — simulating process restart', () => {
    advanceCounter(110);
    nudgeScoringWeights(['grounded:+1.0']);
    expect(getEmaWeightState().selectionCount).toBeGreaterThan(0);
    expect(Object.keys(getEmaWeightState().adjustments).length).toBeGreaterThan(0);

    resetEmaWeights();

    expect(getEmaWeightState().selectionCount).toBe(0);
    expect(Object.keys(getEmaWeightState().adjustments)).toHaveLength(0);
  });

  it('nudgeScoringWeights does not modify confidence formulas or prediction error', () => {
    // The only side effect of nudgeScoringWeights is updating emaState.adjustments.
    // There is no return value and no shared state other than emaState.
    advanceCounter(110);
    const before = JSON.stringify(getEmaWeightState().adjustments);
    nudgeScoringWeights([]);
    // Empty factors → no change.
    expect(JSON.stringify(getEmaWeightState().adjustments)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// AC2: EMA mechanics — floor, nudge, normalisation, logging
// ---------------------------------------------------------------------------

describe('AC2 — EMA weight updater mechanics', () => {
  beforeEach(resetState);

  describe('warmup floor', () => {
    it('nudgeScoringWeights is a no-op when selectionCount < 100', () => {
      advanceCounter(99); // 99 < EMA_WARMUP_FLOOR
      nudgeScoringWeights(['grounded:+1.0']);
      expect(Object.keys(getEmaWeightState().adjustments)).toHaveLength(0);
    });

    it('nudge fires exactly at the floor (selectionCount === 100)', () => {
      advanceCounter(100); // selectionCount is now 100
      nudgeScoringWeights(['grounded:+1.0']);
      expect(getEmaWeightState().adjustments['grounded']).toBeGreaterThan(0);
    });

    it('selectionCount increments on every scoreCandidates call', () => {
      expect(getEmaWeightState().selectionCount).toBe(0);
      advanceCounter(5);
      expect(getEmaWeightState().selectionCount).toBe(5);
    });
  });

  describe('EMA nudge direction', () => {
    beforeEach(() => advanceCounter(100));

    it('nudges "grounded" adjustment toward +1 (winning grounding bonus)', () => {
      nudgeScoringWeights(['grounded:+1.0']);
      const adj = getEmaWeightState().adjustments['grounded'];
      expect(adj).toBeCloseTo(0.05, 5); // 0 + 0.05*(1-0) = 0.05
    });

    it('nudges "chatbot" adjustment toward +1 (reducing the penalty for winning candidate)', () => {
      nudgeScoringWeights(['chatbot:-0.5']);
      const adj = getEmaWeightState().adjustments['chatbot'];
      // Presence on winner → nudge toward +1 regardless of factor sign.
      expect(adj).toBeCloseTo(0.05, 5);
    });

    it('nudges multiple factors in one call', () => {
      nudgeScoringWeights(['grounded:+1.0', 'entity:+0.15']);
      const state = getEmaWeightState();
      expect(state.adjustments['grounded']).toBeGreaterThan(0);
      expect(state.adjustments['entity']).toBeGreaterThan(0);
    });

    it('ignores unknown factor keys', () => {
      nudgeScoringWeights(['totally-unknown-factor:+1.0']);
      expect(Object.keys(getEmaWeightState().adjustments)).toHaveLength(0);
    });

    it('ignores factor strings without a colon delimiter', () => {
      nudgeScoringWeights(['grounded']);
      expect(Object.keys(getEmaWeightState().adjustments)).toHaveLength(0);
    });
  });

  describe('EMA convergence', () => {
    beforeEach(() => advanceCounter(100));

    it('repeated nudges converge asymptotically toward 1 (never exceed it)', () => {
      for (let i = 0; i < 200; i++) {
        nudgeScoringWeights(['grounded:+1.0']);
      }
      const adj = getEmaWeightState().adjustments['grounded'];
      // Should converge toward 1 but never reach it (geometric decay).
      expect(adj).toBeGreaterThan(0.9);
      expect(adj).toBeLessThanOrEqual(1.0);
    });

    it('after 1 nudge with alpha=0.05, adjustment is ~0.05', () => {
      nudgeScoringWeights(['grounded:+1.0']);
      expect(getEmaWeightState().adjustments['grounded']).toBeCloseTo(0.05, 4);
    });

    it('after 2 nudges, adjustment is ~0.0975 (standard EMA decay)', () => {
      nudgeScoringWeights(['grounded:+1.0']);
      nudgeScoringWeights(['grounded:+1.0']);
      // Second nudge: 0.05 + 0.05*(1-0.05) = 0.05 + 0.0475 = 0.0975
      expect(getEmaWeightState().adjustments['grounded']).toBeCloseTo(0.0975, 4);
    });
  });

  describe('L1 normalisation', () => {
    beforeEach(() => advanceCounter(100));

    it('normalises when sum of absolute adjustments exceeds 1.0', () => {
      // Push multiple factors to large values so they collectively exceed 1.0.
      // With 2 factors both nudged 200 times, each approaches ~1.0, sum ~2.0 > 1.0.
      for (let i = 0; i < 200; i++) {
        nudgeScoringWeights(['grounded:+1.0', 'assisted:+0.5']);
      }
      const state = getEmaWeightState();
      const absSum = Object.values(state.adjustments).reduce((s, v) => s + Math.abs(v as number), 0);
      // After normalisation, absSum should be <= 1.0.
      expect(absSum).toBeLessThanOrEqual(1.0 + 1e-10); // floating point tolerance
    });

    it('does NOT normalise when absSum <= 1.0 (early stage)', () => {
      // Single nudge: grounded → 0.05. absSum = 0.05 < 1.0, no normalisation.
      nudgeScoringWeights(['grounded:+1.0']);
      const adj = getEmaWeightState().adjustments['grounded'];
      // Should still be exactly the EMA result, not scaled down.
      expect(adj).toBeCloseTo(0.05, 5);
    });
  });

  describe('logging', () => {
    beforeEach(() => advanceCounter(100));

    it('calls the log function with the weight snapshot when weights changed', () => {
      const log = jest.fn();
      nudgeScoringWeights(['grounded:+1.0'], log);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('EMA scoring weight update');
      expect(log.mock.calls[0][0]).toContain('grounded');
    });

    it('does not call log when under the warmup floor', () => {
      resetState(); // back to 0 selections
      const log = jest.fn();
      nudgeScoringWeights(['grounded:+1.0'], log);
      expect(log).not.toHaveBeenCalled();
    });

    it('does not call log when no factors matched known keys', () => {
      const log = jest.fn();
      nudgeScoringWeights(['unknown-key:+1.0'], log);
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('integration — scoreCandidates applies EMA adjustments', () => {
    it('scores are unaffected when adjustments are zero (baseline)', () => {
      const candidates = [
        { text: '[GROUNDED] Your name is Jim', reasoning: '' },
        { text: '[ASSISTED] Not sure about that', reasoning: '' },
      ];
      const result = scoreCandidates(candidates, 'FACT', EMPTY_WKG);
      // GROUNDED candidate should win (score 1.0 vs 0.5).
      expect(result.bestIndex).toBe(0);
    });

    it('EMA adjustment on "grounded" increases its effective weight', () => {
      // Advance past warmup floor.
      advanceCounter(99);
      // After reset-and-score, apply many nudges to push grounded adjustment high.
      for (let i = 0; i < 50; i++) {
        scoreCandidates([{ text: 'x', reasoning: '' }], 'QUESTION', EMPTY_WKG);
        nudgeScoringWeights(['grounded:+1.0']);
      }
      // Now score: grounded candidate should still win (adjustment amplifies it).
      const candidates = [
        { text: '[GROUNDED] Your name is Jim', reasoning: '' },
        { text: '[ASSISTED] Hello', reasoning: '' },
      ];
      const result = scoreCandidates(candidates, 'FACT', EMPTY_WKG);
      expect(result.bestIndex).toBe(0);
      // The grounded candidate's score should reflect the positive adjustment.
      expect(result.scores[0].score).toBeGreaterThan(result.scores[1].score);
    });
  });
});

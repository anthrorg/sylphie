/**
 * Unit tests for CrossSessionSynthesisService pure helpers.
 *
 * Two exported functions are pure (no I/O, no DI) and testable in isolation:
 *
 *   computeSynthesisConfidence(c1, c2, sharedEntityCount)
 *   parseSynthesisResponse(content, sourceId1, sourceId2)
 *
 * No Neo4j or TimescaleDB mocks are needed. The service class wiring is NOT
 * tested here — that is an integration concern.
 *
 * Coverage groups:
 *   A. computeSynthesisConfidence — floor, cap, mean, overlap bonus
 *   B. parseSynthesisResponse     — valid response, no pattern, confabulation guard,
 *                                   malformed lines, invalid PATTERN_TYPE
 */

import {
  computeSynthesisConfidence,
  parseSynthesisResponse,
} from './cross-session-synthesis.service';

// Symbolic constants matching the module-level constants (cannot import private).
const BASE = 0.30;  // SYNTHESIS_BASE_CONFIDENCE
const CAP  = 0.45;  // SYNTHESIS_CONFIDENCE_CAP

// Convenience IDs for confabulation-guard tests.
const ID1 = 'insight-aaa11111';
const ID2 = 'insight-bbb22222';

// ---------------------------------------------------------------------------
// A. computeSynthesisConfidence
// ---------------------------------------------------------------------------

describe('computeSynthesisConfidence', () => {

  // -----------------------------------------------------------------------
  // A1. Floor: result never drops below BASE
  // -----------------------------------------------------------------------
  describe('floor at SYNTHESIS_BASE_CONFIDENCE (0.30)', () => {
    it('returns BASE when both source confidences are at BASE', () => {
      const result = computeSynthesisConfidence(BASE, BASE, 1);
      expect(result).toBeCloseTo(BASE);
    });

    it('never returns below BASE even with very low source confidences', () => {
      const result = computeSynthesisConfidence(0.05, 0.05, 1);
      expect(result).toBeGreaterThanOrEqual(BASE);
    });

    it('floors to BASE when mean of near-zero values is below BASE', () => {
      const result = computeSynthesisConfidence(0.01, 0.01, 1);
      expect(result).toBe(BASE);
    });
  });

  // -----------------------------------------------------------------------
  // A2. Cap: result never exceeds SYNTHESIS_CONFIDENCE_CAP (0.45)
  // -----------------------------------------------------------------------
  describe('cap at SYNTHESIS_CONFIDENCE_CAP (0.45)', () => {
    it('caps at 0.45 even when both source confidences are high', () => {
      const result = computeSynthesisConfidence(0.90, 0.90, 10);
      expect(result).toBe(CAP);
    });

    it('caps at 0.45 for mean=0.60 (GUARDIAN-level source)', () => {
      const result = computeSynthesisConfidence(0.60, 0.60, 1);
      expect(result).toBe(CAP);
    });

    it('does not exceed 0.45 regardless of overlap bonus', () => {
      const result = computeSynthesisConfidence(0.60, 0.45, 100);
      expect(result).toBeLessThanOrEqual(CAP);
    });
  });

  // -----------------------------------------------------------------------
  // A3. Mean calculation
  // -----------------------------------------------------------------------
  describe('mean of source confidences', () => {
    it('uses the arithmetic mean of the two confidence values', () => {
      // mean(0.30, 0.30) = 0.30; no overlap bonus (1 entity)
      const result = computeSynthesisConfidence(0.30, 0.30, 1);
      expect(result).toBeCloseTo(0.30);
    });

    it('averages asymmetric confidences correctly', () => {
      // mean(0.20, 0.40) = 0.30; 1 entity → no bonus
      const result = computeSynthesisConfidence(0.20, 0.40, 1);
      expect(result).toBeCloseTo(0.30);
    });

    it('averages (0.35, 0.35) = 0.35 with 1 shared entity', () => {
      const result = computeSynthesisConfidence(0.35, 0.35, 1);
      expect(result).toBeCloseTo(0.35);
    });
  });

  // -----------------------------------------------------------------------
  // A4. Overlap bonus
  // -----------------------------------------------------------------------
  describe('overlap bonus per shared entity beyond the first', () => {
    it('adds +0.02 per extra entity beyond the first', () => {
      // mean(0.30, 0.30) = 0.30; 3 entities → bonus = (3-1)*0.02 = 0.04
      const result = computeSynthesisConfidence(0.30, 0.30, 3);
      expect(result).toBeCloseTo(0.30 + 0.04);
    });

    it('caps overlap bonus at +0.10 (6 or more extra entities)', () => {
      // mean(0.30, 0.30) = 0.30; 7 entities → (7-1)*0.02 = 0.12, capped at 0.10
      const result = computeSynthesisConfidence(0.30, 0.30, 7);
      expect(result).toBeCloseTo(0.30 + 0.10);
    });

    it('applies no bonus for exactly 1 shared entity (bonus = 0)', () => {
      const withOne   = computeSynthesisConfidence(0.30, 0.30, 1);
      const withTwo   = computeSynthesisConfidence(0.30, 0.30, 2);
      expect(withTwo).toBeGreaterThan(withOne);
    });

    it('clamps at CAP even when bonus would push above 0.45', () => {
      // mean(0.40, 0.40)=0.40; 4 entities → bonus=(4-1)*0.02=0.06 → 0.46 → capped at 0.45
      const result = computeSynthesisConfidence(0.40, 0.40, 4);
      expect(result).toBe(CAP);
    });
  });
});

// ---------------------------------------------------------------------------
// B. parseSynthesisResponse
// ---------------------------------------------------------------------------

describe('parseSynthesisResponse', () => {

  // -----------------------------------------------------------------------
  // B1. Valid response — pattern found
  // -----------------------------------------------------------------------
  describe('when LLM returns a valid pattern-found response', () => {
    const validResponse = [
      'PATTERN_FOUND: true',
      'PATTERN_TYPE: THEMATIC_THREAD',
      'DESCRIPTION: Jim consistently references coffee in morning-productivity contexts.',
      `CITES: ${ID1}, ${ID2}`,
    ].join('\n');

    it('sets patternFound=true', () => {
      const result = parseSynthesisResponse(validResponse, ID1, ID2);
      expect(result.patternFound).toBe(true);
    });

    it('parses PATTERN_TYPE correctly', () => {
      const result = parseSynthesisResponse(validResponse, ID1, ID2);
      expect(result.insightType).toBe('THEMATIC_THREAD');
    });

    it('parses DESCRIPTION correctly', () => {
      const result = parseSynthesisResponse(validResponse, ID1, ID2);
      expect(result.description).toBe(
        'Jim consistently references coffee in morning-productivity contexts.',
      );
    });

    it('sets citesVerified=true when both IDs appear in CITES', () => {
      const result = parseSynthesisResponse(validResponse, ID1, ID2);
      expect(result.citesVerified).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // B2. Valid response — no pattern found
  // -----------------------------------------------------------------------
  describe('when LLM returns PATTERN_FOUND: false', () => {
    const noPatternResponse = [
      'PATTERN_FOUND: false',
      'PATTERN_TYPE: none',
      'DESCRIPTION: none',
      `CITES: ${ID1}, ${ID2}`,
    ].join('\n');

    it('sets patternFound=false', () => {
      const result = parseSynthesisResponse(noPatternResponse, ID1, ID2);
      expect(result.patternFound).toBe(false);
    });

    it('still sets citesVerified=true (CITES line still present)', () => {
      const result = parseSynthesisResponse(noPatternResponse, ID1, ID2);
      expect(result.citesVerified).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // B3. Confabulation guard — CITES does not contain both IDs
  // -----------------------------------------------------------------------
  describe('confabulation guard: CITES field missing or incomplete', () => {
    it('sets citesVerified=false when CITES is missing entirely', () => {
      const noCites = [
        'PATTERN_FOUND: true',
        'PATTERN_TYPE: THEMATIC_THREAD',
        'DESCRIPTION: Some pattern.',
      ].join('\n');
      const result = parseSynthesisResponse(noCites, ID1, ID2);
      expect(result.citesVerified).toBe(false);
    });

    it('sets citesVerified=false when only one ID is cited', () => {
      const oneId = [
        'PATTERN_FOUND: true',
        'PATTERN_TYPE: THEMATIC_THREAD',
        'DESCRIPTION: Some pattern.',
        `CITES: ${ID1}`,
      ].join('\n');
      const result = parseSynthesisResponse(oneId, ID1, ID2);
      expect(result.citesVerified).toBe(false);
    });

    it('sets citesVerified=false when completely wrong IDs are cited', () => {
      const wrongIds = [
        'PATTERN_FOUND: true',
        'PATTERN_TYPE: THEMATIC_THREAD',
        'DESCRIPTION: Some pattern.',
        'CITES: insight-zzz99999, insight-yyy88888',
      ].join('\n');
      const result = parseSynthesisResponse(wrongIds, ID1, ID2);
      expect(result.citesVerified).toBe(false);
    });

    it('sets citesVerified=true when IDs appear in any order', () => {
      const reversed = [
        'PATTERN_FOUND: true',
        'PATTERN_TYPE: THEMATIC_THREAD',
        'DESCRIPTION: Some pattern.',
        `CITES: ${ID2}, ${ID1}`,
      ].join('\n');
      const result = parseSynthesisResponse(reversed, ID1, ID2);
      expect(result.citesVerified).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // B4. Invalid PATTERN_TYPE
  // -----------------------------------------------------------------------
  describe('when PATTERN_TYPE is not a valid InsightType', () => {
    it('sets insightType=null for an unrecognised type', () => {
      const badType = [
        'PATTERN_FOUND: true',
        'PATTERN_TYPE: UNKNOWN_TYPE',
        'DESCRIPTION: Something.',
        `CITES: ${ID1}, ${ID2}`,
      ].join('\n');
      const result = parseSynthesisResponse(badType, ID1, ID2);
      expect(result.insightType).toBeNull();
    });

    it('sets insightType=null for "none" (the no-pattern placeholder)', () => {
      const noneType = [
        'PATTERN_FOUND: false',
        'PATTERN_TYPE: none',
        'DESCRIPTION: none',
        `CITES: ${ID1}, ${ID2}`,
      ].join('\n');
      const result = parseSynthesisResponse(noneType, ID1, ID2);
      expect(result.insightType).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // B5. All valid InsightType values parse correctly
  // -----------------------------------------------------------------------
  describe('all valid InsightType values', () => {
    const types = [
      'DELAYED_REALIZATION',
      'MISSED_CONNECTION',
      'IMPLICIT_INSTRUCTION',
      'CONTRADICTION',
      'THEMATIC_THREAD',
      'TONAL_SHIFT',
    ];

    for (const type of types) {
      it(`parses ${type} correctly`, () => {
        const response = [
          'PATTERN_FOUND: true',
          `PATTERN_TYPE: ${type}`,
          'DESCRIPTION: Test description.',
          `CITES: ${ID1}, ${ID2}`,
        ].join('\n');
        const result = parseSynthesisResponse(response, ID1, ID2);
        expect(result.insightType).toBe(type);
      });
    }
  });

  // -----------------------------------------------------------------------
  // B6. Malformed / empty input
  // -----------------------------------------------------------------------
  describe('malformed or empty input', () => {
    it('returns patternFound=false for empty string', () => {
      const result = parseSynthesisResponse('', ID1, ID2);
      expect(result.patternFound).toBe(false);
    });

    it('returns citesVerified=false for empty string', () => {
      const result = parseSynthesisResponse('', ID1, ID2);
      expect(result.citesVerified).toBe(false);
    });

    it('returns insightType=null for empty string', () => {
      const result = parseSynthesisResponse('', ID1, ID2);
      expect(result.insightType).toBeNull();
    });

    it('returns description=null for empty string', () => {
      const result = parseSynthesisResponse('', ID1, ID2);
      expect(result.description).toBeNull();
    });

    it('handles whitespace-only input gracefully', () => {
      const result = parseSynthesisResponse('   \n   \n   ', ID1, ID2);
      expect(result.patternFound).toBe(false);
    });

    it('ignores unrecognised lines without throwing', () => {
      const noisy = [
        'SOME_RANDOM_LINE: xyz',
        'PATTERN_FOUND: true',
        'PATTERN_TYPE: THEMATIC_THREAD',
        'DESCRIPTION: Real description.',
        `CITES: ${ID1}, ${ID2}`,
        'TRAILING_GARBAGE: ignored',
      ].join('\n');
      const result = parseSynthesisResponse(noisy, ID1, ID2);
      expect(result.patternFound).toBe(true);
      expect(result.insightType).toBe('THEMATIC_THREAD');
    });
  });

  // -----------------------------------------------------------------------
  // B7. Case insensitivity for PATTERN_FOUND
  // -----------------------------------------------------------------------
  describe('case insensitivity for PATTERN_FOUND', () => {
    it('accepts "TRUE" (uppercase)', () => {
      const response = [
        'PATTERN_FOUND: TRUE',
        'PATTERN_TYPE: THEMATIC_THREAD',
        'DESCRIPTION: Test.',
        `CITES: ${ID1}, ${ID2}`,
      ].join('\n');
      const result = parseSynthesisResponse(response, ID1, ID2);
      expect(result.patternFound).toBe(true);
    });

    it('accepts "False" (mixed case)', () => {
      const response = [
        'PATTERN_FOUND: False',
        'PATTERN_TYPE: none',
        'DESCRIPTION: none',
        `CITES: ${ID1}, ${ID2}`,
      ].join('\n');
      const result = parseSynthesisResponse(response, ID1, ID2);
      expect(result.patternFound).toBe(false);
    });
  });
});

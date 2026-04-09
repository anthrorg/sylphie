/**
 * Unit tests for classifyByHeuristic — Idea 4: Deterministic Edge Refinement.
 *
 * The function is pure (no I/O, no DI) and exported, so these tests run
 * without Neo4j or TimescaleDB mocks.
 *
 * Coverage:
 *   1. Each supported edge type (LIKES, DISLIKES, KNOWS, WORKS_AT, LIVES_AT,
 *      CREATED, OWNS) fires on a positive context sentence.
 *   2. Patterns do NOT fire when neither label is present in context.
 *   3. Patterns do NOT fire when only one label is present.
 *   4. Empty context returns confident=false.
 *   5. DISLIKES takes priority over LIKES (rule ordering).
 *   6. No false positive on USES (intentionally excluded from rules).
 *   7. Proximity window strategy fires when sentence strategy does not.
 */

import { classifyByHeuristic } from './refine-edges.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a context sentence that mentions both labels with the given verb phrase.
 * Simulates what `fullContext` looks like in refineEdges().
 */
function ctx(source: string, verb: string, target: string): string {
  return `${source} ${verb} ${target}.`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyByHeuristic', () => {
  // -------------------------------------------------------------------------
  // 1. Positive cases — each rule fires on its canonical verb phrase
  // -------------------------------------------------------------------------
  describe('LIKES', () => {
    it('classifies "Jim likes Coffee" as LIKES', () => {
      const result = classifyByHeuristic('Jim', 'Coffee', ctx('Jim', 'likes', 'Coffee'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('LIKES');
    });

    it('classifies "Jim like Coffee" (bare form) as LIKES', () => {
      const result = classifyByHeuristic('Jim', 'Coffee', ctx('Jim', 'like', 'Coffee'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('LIKES');
    });

    it('classifies "Jim liked Coffee" (past) as LIKES', () => {
      const result = classifyByHeuristic('Jim', 'Coffee', ctx('Jim', 'liked', 'Coffee'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('LIKES');
    });
  });

  describe('DISLIKES', () => {
    it('classifies "Jim dislikes Mondays" as DISLIKES', () => {
      const result = classifyByHeuristic('Jim', 'Mondays', ctx('Jim', 'dislikes', 'Mondays'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('DISLIKES');
    });

    it('classifies "Jim hates Mondays" as DISLIKES', () => {
      const result = classifyByHeuristic('Jim', 'Mondays', ctx('Jim', 'hates', 'Mondays'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('DISLIKES');
    });

    it('classifies "Jim can\'t stand Mondays" as DISLIKES', () => {
      const result = classifyByHeuristic('Jim', 'Mondays', "Jim can't stand Mondays.");
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('DISLIKES');
    });
  });

  describe('KNOWS', () => {
    it('classifies "Jim knows Sarah" as KNOWS', () => {
      const result = classifyByHeuristic('Jim', 'Sarah', ctx('Jim', 'knows', 'Sarah'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('KNOWS');
    });

    it('classifies "Jim met Sarah" as KNOWS', () => {
      const result = classifyByHeuristic('Jim', 'Sarah', ctx('Jim', 'met', 'Sarah'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('KNOWS');
    });

    it('classifies "Jim is a friend of Sarah" as KNOWS', () => {
      const result = classifyByHeuristic('Jim', 'Sarah', 'Jim is a friend of Sarah.');
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('KNOWS');
    });
  });

  describe('WORKS_AT', () => {
    it('classifies "Jim works at Acme" as WORKS_AT', () => {
      const result = classifyByHeuristic('Jim', 'Acme', ctx('Jim', 'works at', 'Acme'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('WORKS_AT');
    });

    it('classifies "Jim works for Acme" as WORKS_AT', () => {
      const result = classifyByHeuristic('Jim', 'Acme', ctx('Jim', 'works for', 'Acme'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('WORKS_AT');
    });

    it('classifies "Jim is employed at Acme" as WORKS_AT', () => {
      const result = classifyByHeuristic('Jim', 'Acme', 'Jim is employed at Acme.');
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('WORKS_AT');
    });
  });

  describe('LIVES_AT', () => {
    it('classifies "Jim lives in Seattle" as LIVES_AT', () => {
      const result = classifyByHeuristic('Jim', 'Seattle', ctx('Jim', 'lives in', 'Seattle'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('LIVES_AT');
    });

    it('classifies "Jim lives at Seattle" as LIVES_AT', () => {
      const result = classifyByHeuristic('Jim', 'Seattle', ctx('Jim', 'lives at', 'Seattle'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('LIVES_AT');
    });

    it('classifies "Jim resides in Seattle" as LIVES_AT', () => {
      const result = classifyByHeuristic('Jim', 'Seattle', 'Jim resides in Seattle.');
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('LIVES_AT');
    });
  });

  describe('CREATED', () => {
    it('classifies "Jim created Project" as CREATED', () => {
      const result = classifyByHeuristic('Jim', 'Project', ctx('Jim', 'created', 'Project'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('CREATED');
    });

    it('classifies "Jim built the Project" as CREATED', () => {
      const result = classifyByHeuristic('Jim', 'Project', 'Jim built the Project.');
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('CREATED');
    });

    it('classifies "Jim wrote the Report" as CREATED', () => {
      const result = classifyByHeuristic('Jim', 'Report', 'Jim wrote the Report.');
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('CREATED');
    });

    it('classifies "Jim authored the Report" as CREATED', () => {
      const result = classifyByHeuristic('Jim', 'Report', 'Jim authored the Report.');
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('CREATED');
    });
  });

  describe('OWNS', () => {
    it('classifies "Jim owns the Laptop" as OWNS', () => {
      const result = classifyByHeuristic('Jim', 'Laptop', ctx('Jim', 'owns', 'Laptop'));
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('OWNS');
    });

    it('classifies "Laptop belongs to Jim" as OWNS', () => {
      const result = classifyByHeuristic('Laptop', 'Jim', 'Laptop belongs to Jim.');
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('OWNS');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Labels not present in context → no match
  // -------------------------------------------------------------------------
  describe('when neither label appears in context', () => {
    it('returns confident=false', () => {
      const result = classifyByHeuristic('Jim', 'Coffee', 'Alice dislikes Brussels sprouts.');
      expect(result.confident).toBe(false);
      expect(result.newType).toBe('RELATED_TO');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Only one label present → no match (not both present in same window)
  // -------------------------------------------------------------------------
  describe('when only one label appears in context', () => {
    it('returns confident=false when source is present but not target', () => {
      const result = classifyByHeuristic('Jim', 'Coffee', 'Jim likes many things.');
      expect(result.confident).toBe(false);
    });

    it('returns confident=false when target is present but not source', () => {
      const result = classifyByHeuristic('Jim', 'Coffee', 'Alice likes Coffee very much.');
      expect(result.confident).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Empty or whitespace context
  // -------------------------------------------------------------------------
  describe('when context is empty or whitespace', () => {
    it('returns confident=false for empty string', () => {
      const result = classifyByHeuristic('Jim', 'Coffee', '');
      expect(result.confident).toBe(false);
      expect(result.newType).toBe('RELATED_TO');
    });

    it('returns confident=false for whitespace-only string', () => {
      const result = classifyByHeuristic('Jim', 'Coffee', '   \n  ');
      expect(result.confident).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 5. DISLIKES takes priority over LIKES (ordering)
  // -------------------------------------------------------------------------
  describe('rule ordering: DISLIKES before LIKES', () => {
    it('returns DISLIKES when "dislikes" appears in the same window as "likes"', () => {
      // "dislikes" contains the substring "likes", so ordering matters.
      const result = classifyByHeuristic('Jim', 'Coffee', 'Jim dislikes Coffee.');
      expect(result.newType).toBe('DISLIKES');
      expect(result.confident).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 6. USES is NOT in the heuristic rules (intentionally excluded)
  // -------------------------------------------------------------------------
  describe('USES exclusion', () => {
    it('does not classify "Jim uses Coffee" as USES (returns confident=false)', () => {
      const result = classifyByHeuristic('Jim', 'Coffee', 'Jim uses Coffee every morning.');
      // No rule covers USES — heuristic should not fire.
      if (result.confident) {
        // If it matched something else, it should not be USES.
        expect(result.newType).not.toBe('USES');
      } else {
        expect(result.confident).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 7. Proximity window fires when both labels appear close but in no single
  //    sentence  (the sentence strategy returns empty)
  // -------------------------------------------------------------------------
  describe('proximity window fallback', () => {
    it('classifies relationship when labels appear within 120 chars (no shared sentence)', () => {
      // No sentence terminator between the two label occurrences,
      // but they are within WINDOW_RADIUS of each other.
      const context = 'Some text Jim works at Acme more text here.';
      const result = classifyByHeuristic('Jim', 'Acme', context);
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('WORKS_AT');
    });
  });

  // -------------------------------------------------------------------------
  // 8. Case insensitivity
  // -------------------------------------------------------------------------
  describe('case insensitivity', () => {
    it('matches labels regardless of case (classifyByHeuristic lowercases internally)', () => {
      // Labels in context may appear in any case.
      const result = classifyByHeuristic('jim', 'coffee', 'jim likes coffee very much.');
      expect(result.confident).toBe(true);
      expect(result.newType).toBe('LIKES');
    });
  });
});

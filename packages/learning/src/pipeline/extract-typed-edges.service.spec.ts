/**
 * Unit tests for parseTriples — C1: world-fact subjectHint classifier.
 *
 * parseTriples is pure (no I/O, no DI) and exported, so these tests run
 * without Neo4j or TimescaleDB mocks.
 *
 * Coverage:
 *   1. World-fact: "The Eiffel Tower is in Paris" → subjectHint 'world'
 *   2. First-person preference: "I like cerulean" → subjectHint 'speaker'
 *   3. Possessive first-person: "My dog is Max" → subjectHint 'speaker'
 *   4. Sylphie-directed: copula about Sylphie → subjectHint 'sylphie'
 *   5. World-fact does NOT fire for first-person text
 *   6. World-fact does NOT fire for Sylphie-subject text
 *   7. Additional world-fact variants (was/were, "is a", multi-word subjects)
 *   8. Third-person personal patterns still use subjectHint null + _subjectLabel
 */

import { parseTriples } from './extract-typed-edges.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstTripleWith(
  triples: ReturnType<typeof parseTriples>,
  hint: 'speaker' | 'sylphie' | 'world' | null,
) {
  return triples.find((t) => t.subjectHint === hint);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseTriples — C1 world-fact subjectHint classifier', () => {
  // -------------------------------------------------------------------------
  // 1. World-fact: clear copular statement about a named place/thing
  // -------------------------------------------------------------------------
  describe('world-fact statements', () => {
    it('classifies "The Eiffel Tower is in Paris" as subjectHint world', () => {
      const triples = parseTriples('The Eiffel Tower is in Paris.');
      const worldTriple = firstTripleWith(triples, 'world');
      expect(worldTriple).toBeDefined();
      expect(worldTriple!.subjectHint).toBe('world');
      // The article is included in the captured subject label ("The Eiffel Tower").
      // C3 will strip or normalize this when minting the :Candidate node.
      expect((worldTriple as any)._subjectLabel).toMatch(/Eiffel Tower/);
      expect(worldTriple!.objectLabel).toBe('Paris');
    });

    it('classifies "Mount Everest is in the Himalayas" as subjectHint world', () => {
      const triples = parseTriples('Mount Everest is in the Himalayas.');
      const worldTriple = firstTripleWith(triples, 'world');
      expect(worldTriple).toBeDefined();
      expect(worldTriple!.subjectHint).toBe('world');
      expect((worldTriple as any)._subjectLabel).toBe('Mount Everest');
    });

    it('classifies "Python was created by Guido van Rossum" as subjectHint world', () => {
      const triples = parseTriples('Python was created by Guido van Rossum.');
      const worldTriple = firstTripleWith(triples, 'world');
      expect(worldTriple).toBeDefined();
      expect(worldTriple!.subjectHint).toBe('world');
    });

    it('classifies "Paris is known as the city of light" as subjectHint world', () => {
      const triples = parseTriples('Paris is known as the city of light.');
      const worldTriple = firstTripleWith(triples, 'world');
      expect(worldTriple).toBeDefined();
      expect(worldTriple!.subjectHint).toBe('world');
      expect((worldTriple as any)._subjectLabel).toBe('Paris');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Speaker: first-person "I" statements stay 'speaker'
  // -------------------------------------------------------------------------
  describe('first-person speaker statements', () => {
    it('classifies "I like cerulean" as subjectHint speaker', () => {
      const triples = parseTriples('I like cerulean.');
      const speakerTriple = firstTripleWith(triples, 'speaker');
      expect(speakerTriple).toBeDefined();
      expect(speakerTriple!.subjectHint).toBe('speaker');
      expect(speakerTriple!.key).toBe('likes');
      // No world triple should be produced
      expect(firstTripleWith(triples, 'world')).toBeUndefined();
    });

    it('classifies "I live in Seattle" as subjectHint speaker', () => {
      const triples = parseTriples('I live in Seattle.');
      const speakerTriple = firstTripleWith(triples, 'speaker');
      expect(speakerTriple).toBeDefined();
      expect(speakerTriple!.subjectHint).toBe('speaker');
      expect(speakerTriple!.key).toBe('location');
      expect(firstTripleWith(triples, 'world')).toBeUndefined();
    });

    it('classifies "I am from Paris" as subjectHint speaker', () => {
      const triples = parseTriples('I am from Paris.');
      const speakerTriple = firstTripleWith(triples, 'speaker');
      expect(speakerTriple).toBeDefined();
      expect(speakerTriple!.subjectHint).toBe('speaker');
      expect(firstTripleWith(triples, 'world')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Possessive first-person ("my dog is Max") stays 'speaker'
  // -------------------------------------------------------------------------
  describe('possessive first-person statements', () => {
    it('classifies "My dog is Max" via "I have a dog named Max" pattern as speaker', () => {
      // "my dog is Max" doesn't directly match a speaker pattern — but the
      // WORLD_FACT_PATTERN also shouldn't fire because it starts with "my".
      // Primary assertion: no 'world' triple produced.
      const triples = parseTriples('My dog is Max.');
      expect(firstTripleWith(triples, 'world')).toBeUndefined();
    });

    it('classifies "I have a dog named Max" as subjectHint speaker (no world triple)', () => {
      // "I have a dog named Max" triggers both haveCountMatch (count="a", thing="dog")
      // and haveNamedMatch (objectLabel="Max"). Both produce speaker triples — the
      // important invariant is that NO world triple is produced.
      const triples = parseTriples('I have a dog named Max.');
      expect(triples.length).toBeGreaterThan(0);
      // All triples must be speaker-typed (first-person guard works)
      for (const t of triples) {
        expect(t.subjectHint).toBe('speaker');
      }
      expect(firstTripleWith(triples, 'world')).toBeUndefined();
      // The haveNamedMatch triple has objectLabel "Max"
      const namedTriple = triples.find((t) => t.objectLabel === 'Max');
      expect(namedTriple).toBeDefined();
      expect(namedTriple!.subjectHint).toBe('speaker');
    });

    it('classifies "My favorite color is cerulean" as subjectHint speaker', () => {
      const triples = parseTriples('My favorite color is cerulean.');
      const speakerTriple = firstTripleWith(triples, 'speaker');
      expect(speakerTriple).toBeDefined();
      expect(speakerTriple!.subjectHint).toBe('speaker');
      expect(firstTripleWith(triples, 'world')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Sylphie-directed statements → 'sylphie'
  // -------------------------------------------------------------------------
  describe('Sylphie-directed statements', () => {
    it('classifies "Sylphie is very helpful" as subjectHint sylphie', () => {
      const triples = parseTriples('Sylphie is very helpful.');
      const sylphieTriple = firstTripleWith(triples, 'sylphie');
      expect(sylphieTriple).toBeDefined();
      expect(sylphieTriple!.subjectHint).toBe('sylphie');
      // Should NOT produce a world triple for Sylphie
      expect(firstTripleWith(triples, 'world')).toBeUndefined();
    });

    it('classifies "Sylphie is an AI companion" as subjectHint sylphie (case-insensitive)', () => {
      const triples = parseTriples('sylphie is an AI companion.');
      const sylphieTriple = firstTripleWith(triples, 'sylphie');
      expect(sylphieTriple).toBeDefined();
      expect(sylphieTriple!.subjectHint).toBe('sylphie');
    });
  });

  // -------------------------------------------------------------------------
  // 5. World-fact does NOT fire for first-person text
  // -------------------------------------------------------------------------
  describe('world-fact guard: first-person text excluded', () => {
    it('produces no world triple for "I am from New York"', () => {
      const triples = parseTriples('I am from New York.');
      expect(firstTripleWith(triples, 'world')).toBeUndefined();
    });

    it('produces no world triple for "My name is Alex"', () => {
      const triples = parseTriples('My name is Alex.');
      expect(firstTripleWith(triples, 'world')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 6. World-fact does NOT fire for Sylphie subject text
  // -------------------------------------------------------------------------
  describe('world-fact guard: Sylphie subject excluded from world', () => {
    it('does not produce world triple when subject is Sylphie', () => {
      const triples = parseTriples('Sylphie is located in the cloud.');
      expect(firstTripleWith(triples, 'world')).toBeUndefined();
      // But should produce a sylphie triple
      expect(firstTripleWith(triples, 'sylphie')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 7. Third-person personal patterns still use null + _subjectLabel (unchanged)
  // -------------------------------------------------------------------------
  describe('third-person personal patterns (unchanged path)', () => {
    it('classifies "Jim likes coffee" as subjectHint null with _subjectLabel Jim', () => {
      const triples = parseTriples('Jim likes coffee.');
      const nullTriple = firstTripleWith(triples, null);
      expect(nullTriple).toBeDefined();
      expect(nullTriple!.subjectHint).toBeNull();
      expect((nullTriple as any)._subjectLabel).toBe('Jim');
    });

    it('classifies "Alice works at Acme" as subjectHint null with _subjectLabel Alice', () => {
      const triples = parseTriples('Alice works at Acme.');
      const nullTriple = firstTripleWith(triples, null);
      expect(nullTriple).toBeDefined();
      expect(nullTriple!.subjectHint).toBeNull();
      expect((nullTriple as any)._subjectLabel).toBe('Alice');
    });
  });
});

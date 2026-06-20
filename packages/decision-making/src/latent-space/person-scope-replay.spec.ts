/**
 * WS4 Ticket 5 (§3.2/§6 A4) — per-person latent-replay scope isolation.
 *
 * INVARIANT under test: a Type 1 pattern whose GROUNDED claim is backed by
 * person A's private OKG must NOT replay GROUNDED to person B; a world-scoped
 * (null) pattern may replay GROUNDED to anyone; and if person B genuinely has
 * the same fact in B's OWN OKG, an honest re-ground re-GROUNDs it off B's facts.
 *
 * TK-84 update: applyOkgRecallGrounding was the §2.10 post-hoc fallback and is
 * now deleted. The latent-replay re-ground uses the same durable path as the
 * four collapsed production sites:
 *   1. applyPersonScopeDemotion(baseGrounding, pattern.groundingPersonId, currentPersonId)
 *      — the single-source-of-truth privacy gate (latent-space.service.ts).
 *   2. retrieveRecallGrounding(currentPersonId, input, currentFacts, emptyWkg)
 *      — resolve the current speaker's OKG fact node BEFORE applying the label.
 *   3. applyRecallGroundingFromRetrieval(retrieval, response, demotedGrounding)
 *      — upgrade to GROUNDED iff the retrieved value surfaces in the response.
 *
 * The behaviour is identical to the deleted helper: when the current speaker
 * has the fact and the value appears in the response, label = GROUNDED with the
 * current speaker's node id; otherwise, label stays at the demoted floor.
 */

import { applyPersonScopeDemotion } from './latent-space.service';
import { discriminateGroundedBy } from '../deliberation/deliberation.service';
import {
  retrieveRecallGrounding,
  applyRecallGroundingFromRetrieval,
} from '../deliberation/recall-retrieval';
import type { WkgContext, WkgEntity } from '../wkg/wkg-context.service';
import type { KnowledgeGrounding } from '@sylphie/shared';

// Suppress verbose logs.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

const EMPTY_WKG: WkgContext = {
  entities: [], facts: [], relationships: [], procedures: [], summary: '',
};

/**
 * Replay a stored-GROUNDED, person-A-scoped pattern as `currentPersonId`, with
 * the current speaker's known OKG facts. Mirrors the real latent-replay flow
 * after TK-84 collapse: demote first, then resolve + apply the pre-arbitration
 * recall retrieval off the CURRENT speaker's own facts.
 */
function replay(opts: {
  groundingPersonId: string | null;
  currentPersonId: string | null;
  input: string;
  response: string;
  currentFacts: string[];
}): { grounding: KnowledgeGrounding; provenance: string | null; demoted: boolean } {
  // A pattern stored as GROUNDED replays with base grounding GROUNDED
  // (groundingForCachedPattern returns the stored verdict unchanged for GROUNDED).
  const base: KnowledgeGrounding = 'GROUNDED';
  const scope = applyPersonScopeDemotion(base, opts.groundingPersonId, opts.currentPersonId);
  // Resolve the CURRENT speaker's recall retrieval (durable path, TK-84).
  const retrieval = retrieveRecallGrounding(
    opts.currentPersonId,
    opts.input,
    opts.currentFacts,
    EMPTY_WKG,
  );
  const reground = applyRecallGroundingFromRetrieval(retrieval, opts.response, scope.grounding);
  return { grounding: reground.grounding, provenance: reground.provenance, demoted: scope.demoted };
}

describe('WS4-T5 A4 — latent-replay person-scope isolation', () => {
  const PERSON_A = 'personA';
  const PERSON_B = 'personB';

  // A pattern grounded off person A's OKG: "your name is Jim" → "Your name is Jim".
  // Person A's fact is name: Jim; person B has a DIFFERENT name (Bea).
  const A_FACTS = ['name: Jim'];
  const B_FACTS_DIFFERENT = ['name: Bea'];
  const B_FACTS_SAME = ['name: Jim']; // B independently taught the same value.
  const INPUT = 'what is my name?';
  const RESPONSE = 'Your name is Jim.';

  it('A-scoped pattern replayed to person B (different facts) → UNKNOWN, response non-empty', () => {
    const r = replay({
      groundingPersonId: PERSON_A,
      currentPersonId: PERSON_B,
      input: INPUT,
      response: RESPONSE,
      currentFacts: B_FACTS_DIFFERENT,
    });
    expect(r.demoted).toBe(true);
    expect(r.grounding).toBe('UNKNOWN');
    expect(r.provenance).toBeNull(); // borrowed A-grounding stripped, not re-grounded
    expect(RESPONSE.length).toBeGreaterThan(0); // reflex still fires (theater prohibition)
  });

  it('A-scoped pattern replayed to person A (its owner) → GROUNDED', () => {
    const r = replay({
      groundingPersonId: PERSON_A,
      currentPersonId: PERSON_A,
      input: INPUT,
      response: RESPONSE,
      currentFacts: A_FACTS,
    });
    expect(r.demoted).toBe(false);
    expect(r.grounding).toBe('GROUNDED');
  });

  it('null-scoped (world) pattern replayed to person B → GROUNDED', () => {
    const r = replay({
      groundingPersonId: null,
      currentPersonId: PERSON_B,
      input: INPUT,
      response: RESPONSE,
      currentFacts: B_FACTS_DIFFERENT,
    });
    expect(r.demoted).toBe(false);
    expect(r.grounding).toBe('GROUNDED'); // world knowledge replays to anyone
  });

  it('A-scoped pattern replayed to B who INDEPENDENTLY knows the same fact → re-GROUNDed off B', () => {
    // Demotion strips A's grounding, then the honest re-ground off B's OWN facts
    // re-GROUNDs it because B genuinely has name: Jim. Provenance points at B.
    const r = replay({
      groundingPersonId: PERSON_A,
      currentPersonId: PERSON_B,
      input: INPUT,
      response: RESPONSE,
      currentFacts: B_FACTS_SAME,
    });
    expect(r.demoted).toBe(true); // borrowed A-grounding WAS stripped
    expect(r.grounding).toBe('GROUNDED'); // but B's own fact re-grounds honestly
    expect(r.provenance).toBe(`attr-${PERSON_B}-name`); // provenance is B's node, not A's
  });
});

describe('WS4-T5 A4 — applyPersonScopeDemotion unit (pure gate)', () => {
  it('null scope never demotes', () => {
    expect(applyPersonScopeDemotion('GROUNDED', null, 'anyone')).toEqual({
      grounding: 'GROUNDED',
      demoted: false,
    });
  });
  it('matching personId never demotes', () => {
    expect(applyPersonScopeDemotion('GROUNDED', 'p1', 'p1')).toEqual({
      grounding: 'GROUNDED',
      demoted: false,
    });
  });
  it('mismatched personId demotes GROUNDED → UNKNOWN', () => {
    expect(applyPersonScopeDemotion('GROUNDED', 'p1', 'p2')).toEqual({
      grounding: 'UNKNOWN',
      demoted: true,
    });
  });
  it('non-GROUNDED is never demoted even on mismatch', () => {
    expect(applyPersonScopeDemotion('LLM_ASSISTED', 'p1', 'p2')).toEqual({
      grounding: 'LLM_ASSISTED',
      demoted: false,
    });
    expect(applyPersonScopeDemotion('UNKNOWN', 'p1', 'p2')).toEqual({
      grounding: 'UNKNOWN',
      demoted: false,
    });
  });
  it('mismatch with null currentPersonId (unknown speaker) demotes — fail closed', () => {
    expect(applyPersonScopeDemotion('GROUNDED', 'p1', null)).toEqual({
      grounding: 'UNKNOWN',
      demoted: true,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WS4-T5 §3.1 — write-time source discrimination (the regression that mythos
// caught). The bug: the old write predicate re-derived "is this WKG-backed?"
// from AMBIENT WKG context, so a GROUNDED-via-OKG verdict that happened to have
// an UNRELATED topical entity in context (e.g. a stray capitalized word matched
// as an :Entity) was mislabeled WKG-backed and WORLD-SCOPED — leaking person A's
// private fact to person B. discriminateGroundedBy reads the verdict's SOURCE
// off the cascade rule that fired (OKG recall WINS over topical-WKG), so the
// presence of an unrelated entity cannot flip an OKG fact to world-scope.
// ───────────────────────────────────────────────────────────────────────────
describe('WS4-T5 §3.1 — discriminateGroundedBy (write-time source)', () => {
  const entity = (label: string, nodeType: string): WkgEntity => ({
    nodeId: `entity-${label.toLowerCase()}`,
    label,
    nodeType,
    properties: {},
    confidence: 0.6,
    provenance: 'WORLD',
  });
  const wkg = (entities: WkgEntity[], facts: WkgContext['facts'] = []): WkgContext => ({
    entities,
    relationships: [],
    facts,
    procedures: [],
    summary: '',
  });

  const NAME_FACTS = ['name: Jim'];
  const NAME_RESPONSE = 'Your name is Jim.';

  it('THE BUG: GROUNDED via OKG person-fact + UNRELATED topical entity present → OKG (person-scope)', () => {
    // This is the exact live-verified failure: verdict GROUNDED because the OKG
    // fact "name: Jim" surfaced in the reply, while WKG context independently
    // holds a stray "Remind" entity. The OLD predicate saw the topical entity and
    // world-scoped; the discriminator must return 'OKG' so the write person-scopes.
    const strayEntity = entity('Remind', 'Entity');
    const source = discriminateGroundedBy(
      'GROUNDED',
      wkg([strayEntity]),
      NAME_RESPONSE,
      NAME_FACTS,
      null, // personFactRecalled path: GROUNDED set without okg provenance string
    );
    expect(source).toBe('OKG');
  });

  it('GROUNDED via OKG provenance (pre-arbitration retrieval upgrade) → OKG even with topical entity', () => {
    const source = discriminateGroundedBy(
      'GROUNDED',
      wkg([entity('Kyoto', 'Entity')]),
      'Your favorite city is Kyoto.',
      ['favorite_city: Kyoto'],
      'attr-guardian-favorite_city', // provenance present → unambiguously OKG
    );
    expect(source).toBe('OKG');
  });

  it('GROUNDED via real WKG fact, no OKG match → WKG (world-scope)', () => {
    const source = discriminateGroundedBy(
      'GROUNDED',
      wkg([entity('Paris', 'Entity')], [{ subject: 'France', predicate: 'capital', object: 'Paris', confidence: 0.9, provenance: 'WORLD' }]),
      'The capital of France is Paris.',
      [], // no person facts at all
      null,
    );
    expect(source).toBe('WKG');
  });

  it('GROUNDED via topical entity only, no OKG match → WKG (world-scope)', () => {
    const source = discriminateGroundedBy(
      'GROUNDED',
      wkg([entity('Paris', 'Entity')]),
      'Paris is a city.',
      [],
      null,
    );
    expect(source).toBe('WKG');
  });

  it('base-context-only entities (Drive/CoBeing) with no OKG → null (ambiguous → person-scope)', () => {
    const source = discriminateGroundedBy(
      'GROUNDED',
      wkg([entity('Curiosity', 'Drive'), entity('Sylphie', 'CoBeing')]),
      'Some response.',
      [],
      null,
    );
    expect(source).toBeNull(); // not provably WKG → write site person-scopes
  });

  it('non-GROUNDED verdict → null regardless of context', () => {
    expect(discriminateGroundedBy('UNKNOWN', wkg([entity('Paris', 'Entity')]), 'x', NAME_FACTS, null)).toBeNull();
    expect(discriminateGroundedBy('LLM_ASSISTED', wkg([]), 'x', NAME_FACTS, 'attr-x-y')).toBeNull();
  });

  it('OKG wins over WKG: person-fact AND topical entity both present → OKG', () => {
    // Both rules could fire; the cascade gives OKG precedence, so source is OKG
    // (person-scope) — never world-scope. This is the precedence the bug ignored.
    const source = discriminateGroundedBy(
      'GROUNDED',
      wkg([entity('Kyoto', 'Entity')]), // unrelated topical entity
      NAME_RESPONSE, // contains "Jim" → personFactRecalled fires
      NAME_FACTS,
      null,
    );
    expect(source).toBe('OKG');
  });
});

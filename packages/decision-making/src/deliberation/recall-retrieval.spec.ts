/**
 * WS3 Ticket T1 — pre-arbitration grounded recall retrieval.
 *
 * Verifies the PURE retrieval core: a recall question resolves the grounding
 * fact node id (OKG attr-id or single-hop WKG node_id) ONCE, before arbitration,
 * with real provenance and the C2 honesty guard intact.
 *
 * Lives in the decision-making jest root (the repo's only jest root). The module
 * imports recallKeyForQuestion/getRecalledFactForRecall from deliberation.service
 * and the WkgContext type from wkg-context.service — exercised here without any
 * Neo4j or LLM (the WKG context is a plain object, mirroring how the cycle passes
 * the already-assembled single-hop context).
 */

import {
  retrieveRecallGrounding,
  applyRecallGroundingFromRetrieval,
} from './recall-retrieval';
import { recallKeyForQuestion } from './deliberation.service';
import type { WkgContext } from '../wkg/wkg-context.service';

// Suppress verbose logs.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

const EMPTY_WKG: WkgContext = {
  entities: [], facts: [], relationships: [], procedures: [], summary: '',
};

const PERSON = 'user-jim';
const KNOWN_FACTS = ['name: Jim', 'location: Seattle', 'dog: Max'];

describe('WS3-T1 — retrieveRecallGrounding (pre-arbitration, single-hop)', () => {
  it('OKG hit — "what is my name?" resolves attr-id at retrieval time', () => {
    const r = retrieveRecallGrounding(PERSON, 'what is my name?', KNOWN_FACTS, EMPTY_WKG);
    expect(r).not.toBeNull();
    expect(r!.recallKey).toBe('name');
    expect(r!.factNodeId).toBe('attr-user-jim-name'); // deterministic, real (Std 4)
    expect(r!.factValue).toBe('Jim');
    expect(r!.source).toBe('OKG');
    expect(r!.personId).toBe(PERSON);
  });

  it('OKG hit — location recall resolves the right key/value', () => {
    const r = retrieveRecallGrounding(PERSON, 'where do I live?', KNOWN_FACTS, EMPTY_WKG);
    expect(r!.recallKey).toBe('location');
    expect(r!.factNodeId).toBe('attr-user-jim-location');
    expect(r!.factValue).toBe('Seattle');
    expect(r!.source).toBe('OKG');
  });

  it('non-recall question → null (no provenance, cheap exit)', () => {
    const r = retrieveRecallGrounding(PERSON, 'tell me a story about dragons', KNOWN_FACTS, EMPTY_WKG);
    expect(r).toBeNull();
  });

  it('unknowable recall → null when no taught fact and no WKG entity (C2 honest)', () => {
    // "what is my favorite food" maps to no recall key (excluded from color).
    const r = retrieveRecallGrounding(PERSON, 'what is my favorite food?', KNOWN_FACTS, EMPTY_WKG);
    expect(r).toBeNull();
  });

  it('recall question with an untaught key → null (no OKG fact, no WKG)', () => {
    // occupation is a recall key, but it is not in KNOWN_FACTS.
    const r = retrieveRecallGrounding(PERSON, 'what do I do for work?', KNOWN_FACTS, EMPTY_WKG);
    expect(r).toBeNull();
  });

  it('WKG single-hop fallback — recall key, OKG miss, topical entity present → WKG node id', () => {
    const wkg: WkgContext = {
      ...EMPTY_WKG,
      entities: [
        // Base-context node must NOT be chosen as provenance.
        { nodeId: 'drive-1', label: 'Curiosity', nodeType: 'Drive', properties: {}, confidence: 0.5, provenance: 'INFERENCE' },
        { nodeId: 'wkg-paris-1', label: 'Paris', nodeType: 'Entity', properties: {}, confidence: 0.7, provenance: 'GUARDIAN' },
      ],
    };
    // 'occupation' has no OKG fact here → falls through to WKG single hop.
    const r = retrieveRecallGrounding(PERSON, 'what is my job?', undefined, wkg);
    expect(r).not.toBeNull();
    expect(r!.source).toBe('WKG');
    expect(r!.factNodeId).toBe('wkg-paris-1'); // real matched node_id, NOT the Drive node
    expect(r!.confidence).toBe(0.7); // surfaced, not lifted (Std 3)
  });

  it('WKG fallback skips Drive/CoBeing/Word base-context nodes', () => {
    const wkg: WkgContext = {
      ...EMPTY_WKG,
      entities: [
        { nodeId: 'drive-1', label: 'X', nodeType: 'Drive', properties: {}, confidence: 0.5, provenance: 'INFERENCE' },
        { nodeId: 'cobeing-1', label: 'Sylphie', nodeType: 'CoBeing', properties: {}, confidence: 0.9, provenance: 'SELF' },
      ],
    };
    const r = retrieveRecallGrounding(PERSON, 'what is my job?', undefined, wkg);
    expect(r).toBeNull(); // only base-context → nothing to ground on
  });

  it('OKG wins over WKG when both could match (more specific provenance)', () => {
    const wkg: WkgContext = {
      ...EMPTY_WKG,
      entities: [
        { nodeId: 'wkg-jim-1', label: 'Jim', nodeType: 'Entity', properties: {}, confidence: 0.6, provenance: 'GUARDIAN' },
      ],
    };
    const r = retrieveRecallGrounding(PERSON, 'what is my name?', KNOWN_FACTS, wkg);
    expect(r!.source).toBe('OKG');
    expect(r!.factNodeId).toBe('attr-user-jim-name');
  });

  it('no personId and no WKG → null (no provenance to resolve)', () => {
    const r = retrieveRecallGrounding(null, 'what is my name?', KNOWN_FACTS, EMPTY_WKG);
    expect(r).toBeNull(); // OKG needs personId; WKG empty
  });
});

describe('WS3-T1 — applyRecallGroundingFromRetrieval (label upgrade + honesty guard)', () => {
  const retrieval = retrieveRecallGrounding(PERSON, 'what is my name?', KNOWN_FACTS, EMPTY_WKG)!;

  it('value surfaced in response → GROUNDED with the retrieved node id', () => {
    const out = applyRecallGroundingFromRetrieval(retrieval, 'Your name is Jim!', 'LLM_ASSISTED');
    expect(out.grounding).toBe('GROUNDED');
    expect(out.provenance).toBe('attr-user-jim-name');
    expect(out.groundedBy).toBe('OKG');
  });

  it('value NOT surfaced → label stays, provenance null (C2 honesty guard)', () => {
    // The node was retrieved, but the LLM paraphrased the value away. We must NOT
    // claim GROUNDED — the response is not demonstrably backed by the fact.
    const out = applyRecallGroundingFromRetrieval(retrieval, 'I think you told me earlier.', 'LLM_ASSISTED');
    expect(out.grounding).toBe('LLM_ASSISTED');
    expect(out.provenance).toBeNull();
    expect(out.groundedBy).toBeNull();
  });

  it('already GROUNDED → not double-labeled', () => {
    const out = applyRecallGroundingFromRetrieval(retrieval, 'Your name is Jim!', 'GROUNDED');
    expect(out.grounding).toBe('GROUNDED');
    expect(out.provenance).toBeNull(); // no override
  });

  it('null retrieval → passthrough (non-recall turn)', () => {
    const out = applyRecallGroundingFromRetrieval(null, 'anything', 'UNKNOWN');
    expect(out.grounding).toBe('UNKNOWN');
    expect(out.provenance).toBeNull();
    expect(out.groundedBy).toBeNull();
  });

  it('WKG-sourced retrieval surfaced → GROUNDED with WKG node id + WKG source', () => {
    const wkg: WkgContext = {
      ...EMPTY_WKG,
      entities: [
        { nodeId: 'wkg-paris-1', label: 'Paris', nodeType: 'Entity', properties: {}, confidence: 0.7, provenance: 'GUARDIAN' },
      ],
    };
    const wkgRetrieval = retrieveRecallGrounding(PERSON, 'what is my job?', undefined, wkg)!;
    const out = applyRecallGroundingFromRetrieval(wkgRetrieval, 'It relates to Paris somehow.', 'LLM_ASSISTED');
    expect(out.grounding).toBe('GROUNDED');
    expect(out.provenance).toBe('wkg-paris-1');
    expect(out.groundedBy).toBe('WKG');
  });
});

/**
 * knowledge_retrieval metric gate — pre-arbitration QUESTION intent for the
 * procedure-handler and latent-reflex branches.
 *
 * Those two branches skip the LLM inner-monologue, so they have no
 * monologueParsed.intent in scope. The cycle reuses recallKeyForQuestion() — the
 * SAME deterministic recall classifier that backs computeRecallRetrieval — to
 * stamp intent='QUESTION' (CANON Std-1: reused, never recomputed, never defaulted
 * to a passing value). This block pins the exact mapping the fix relies on:
 *
 *   const cycleRecallIntent = recallKeyForQuestion(inputText) ? 'QUESTION' : undefined;
 *
 * The CRITICAL property the metric needs: a recall question is classified QUESTION
 * even when no fact node grounds it (UNKNOWN outcome). That is why the fix keys off
 * recallKeyForQuestion (the question classifier), NOT recallRetrieval!==null (the
 * grounding result) — the latter would drop tried-and-failed turns the metric must
 * count in its denominator.
 */
describe('knowledge_retrieval gate — procedure/latent pre-arbitration intent', () => {
  // The exact expression the cycle evaluates once and stamps on both branches.
  const cycleRecallIntent = (text: string): 'QUESTION' | undefined =>
    recallKeyForQuestion(text) ? 'QUESTION' : undefined;

  it('recall question → QUESTION (procedure/latent branch stamps it)', () => {
    expect(cycleRecallIntent('what is my name?')).toBe('QUESTION');
    expect(cycleRecallIntent('where do I live?')).toBe('QUESTION');
    expect(cycleRecallIntent('what is my dog called?')).toBe('QUESTION');
  });

  it('recall question with NO grounding still classifies QUESTION (denominator-correct)', () => {
    // 'occupation' is a recall key but not in KNOWN_FACTS, so retrieveRecall-
    // Grounding returns null (no node). The intent is STILL QUESTION — this is a
    // tried-and-failed retrieval turn the metric must count (UNKNOWN outcome).
    expect(retrieveRecallGrounding(PERSON, 'what do I do for work?', KNOWN_FACTS, EMPTY_WKG)).toBeNull();
    expect(cycleRecallIntent('what do I do for work?')).toBe('QUESTION');
  });

  it('non-recall input → undefined (left unset → persists as null → excluded)', () => {
    // Std-1: never fabricate QUESTION. A greeting / statement / non-recall ask
    // carries no recall key, so the branch leaves intent unset and the row is
    // correctly excluded from the QUESTION-gated denominator.
    expect(cycleRecallIntent('hello there!')).toBeUndefined();
    expect(cycleRecallIntent('I had a great day today')).toBeUndefined();
    expect(cycleRecallIntent('tell me a story about dragons')).toBeUndefined();
    expect(cycleRecallIntent('what is my favorite food?')).toBeUndefined(); // not a recall key
  });

  it('empty / missing input text → undefined (watchdog / self-tick honesty)', () => {
    // A self-initiated tick with no input has no classification → null, never
    // a fabricated QUESTION (matches the fix\'s `frame.raw.text ?? \'\'` default).
    expect(cycleRecallIntent('')).toBeUndefined();
  });
});

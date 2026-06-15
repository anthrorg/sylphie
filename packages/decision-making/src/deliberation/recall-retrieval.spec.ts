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
  resolveRecallKey,
  RECALL_SEMANTIC_THRESHOLD,
  type RecallKeyEncoder,
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

/**
 * WS3 C8 — semantic recall-key resolver (regex-FIRST → embed → intersect →
 * threshold). Pure: the encoder is MOCKED (no Ollama). The mock embeds by
 * concept token so cosine is deterministic — a paraphrase the regex misses still
 * lands on the right canonical key, while an unknowable never does (it is not a
 * taught key, so it is never even a candidate).
 */
describe('WS3-C8 — resolveRecallKey (semantic, regex-first)', () => {
  // Concept → 3-dim one-hot. cosine(same concept)=1, cosine(diff concept)=0.
  // The mock maps any text containing a concept's trigger words to that concept's
  // axis, so the query and the matching canonical form land on the same axis.
  const AXES: Record<string, number[]> = {
    name: [1, 0, 0, 0, 0],
    location: [0, 1, 0, 0, 0],
    dog: [0, 0, 1, 0, 0],
    color: [0, 0, 0, 1, 0],
    occupation: [0, 0, 0, 0, 1],
    other: [0.2, 0.2, 0.2, 0.2, 0.2], // off-axis: low cosine with every key (~0.45)
  };
  const conceptOf = (text: string): string => {
    const t = text.toLowerCase();
    if (/based|live|city|located/.test(t)) return 'location';
    if (/\bname\b/.test(t)) return 'name';
    if (/dog|pet/.test(t)) return 'dog';
    if (/colou?r/.test(t)) return 'color';
    if (/work|job|profession/.test(t)) return 'occupation';
    return 'other';
  };
  const mockEncoder = (): RecallKeyEncoder & { calls: { q: number; d: number } } => {
    const calls = { q: 0, d: 0 };
    return {
      calls,
      encodeQuery: async (t: string) => {
        calls.q++;
        return AXES[conceptOf(t)];
      },
      encodeDocument: async (t: string) => {
        calls.d++;
        return AXES[conceptOf(t)];
      },
    };
  };

  it('regex HIT → returns the regex key WITHOUT embedding (C1 preserved exactly)', async () => {
    const enc = mockEncoder();
    const key = await resolveRecallKey('what is my name?', KNOWN_FACTS, enc);
    expect(key).toBe('name');
    // No embedding ran — the regex short-circuits before the semantic pass.
    expect(enc.calls.q).toBe(0);
    expect(enc.calls.d).toBe(0);
  });

  it('paraphrase generalization — regex MISS, embedding matches location', async () => {
    const enc = mockEncoder();
    // "Remind me where I'm based?" — recallKeyForQuestion contains 'where' so it
    // actually HITS location via regex; use a phrasing with NO regex trigger word
    // to exercise the embedding path: "Remind me which town I'm based in".
    // 'town' is not in the regex; 'based' is not in the regex → regex MISS.
    expect(recallKeyForQuestion("Remind me which town I'm based in")).toBeNull();
    const key = await resolveRecallKey("Remind me which town I'm based in", KNOWN_FACTS, enc);
    expect(key).toBe('location'); // embedding rescued it
    expect(enc.calls.q).toBeGreaterThan(0); // the semantic pass actually ran
  });

  it('paraphrase resolves end-to-end → GROUNDED + attr-<p>-location provenance', async () => {
    const enc = mockEncoder();
    const resolvedKey = await resolveRecallKey("Remind me which town I'm based in", KNOWN_FACTS, enc);
    const retrieval = retrieveRecallGrounding(PERSON, "Remind me which town I'm based in", KNOWN_FACTS, EMPTY_WKG, resolvedKey);
    expect(retrieval).not.toBeNull();
    expect(retrieval!.recallKey).toBe('location');
    expect(retrieval!.factNodeId).toBe('attr-user-jim-location');
    const out = applyRecallGroundingFromRetrieval(retrieval, 'You are based in Seattle.', 'LLM_ASSISTED');
    expect(out.grounding).toBe('GROUNDED');
    expect(out.provenance).toBe('attr-user-jim-location');
    expect(out.groundedBy).toBe('OKG');
  });

  it('unknowable stays honest — "breakfast" is not a taught key → null', async () => {
    const enc = mockEncoder();
    // No regex key, and 'breakfast' is not a canonical taught key → no candidate
    // even gets embedded → null → never GROUNDED (C2 preserved by construction).
    expect(recallKeyForQuestion('What did I have for breakfast?')).toBeNull();
    const key = await resolveRecallKey('What did I have for breakfast?', KNOWN_FACTS, enc);
    expect(key).toBeNull();
  });

  it('semantic match only among TAUGHT keys — occupation untaught → null', async () => {
    const enc = mockEncoder();
    // Phrasing with NO occupation regex trigger word (work|job|occupation|
    // profession) so the embedding path is the one under test. The mock maps
    // 'work' in conceptOf, so use a phrasing the *resolver* regex misses but the
    // *mock* still classifies occupation — "what's my line of work" hits the
    // regex; instead drive the embedding via a phrase the regex misses entirely.
    expect(recallKeyForQuestion('Remind me what I do day to day for a living')).toBeNull();
    // mock conceptOf sees 'work'? no — 'living' isn't a trigger → 'other' axis,
    // which is below threshold anyway; but the load-bearing assertion is the
    // INTERSECTION gate: occupation is NOT a taught key in KNOWN_FACTS, so even
    // if it scored high it could never be a candidate → null.
    const key = await resolveRecallKey('Remind me what I do day to day for a living', KNOWN_FACTS, enc);
    expect(key).toBeNull();
  });

  it('intersection gate is load-bearing — untaught key with PERFECT score still → null', async () => {
    // Force a perfect occupation embedding match, but occupation is untaught.
    // The intersection (candidates = canonical ∩ taught) drops it BEFORE scoring,
    // so it returns null. This is the exact mechanism that keeps unknowables and
    // untaught dimensions un-groundable (C2 by construction).
    const occEnc: RecallKeyEncoder = {
      encodeQuery: async () => AXES.occupation, // perfect match to occupation form
      encodeDocument: async (t: string) => AXES[conceptOf(t)],
    };
    // Regex must miss for the embedding path to run.
    const q = 'Remind me what I do day to day for a living';
    expect(recallKeyForQuestion(q)).toBeNull();
    // occupation NOT in KNOWN_FACTS → not a candidate → null despite a 1.0 score.
    expect(await resolveRecallKey(q, KNOWN_FACTS, occEnc)).toBeNull();
    // Same encoder, but NOW occupation IS taught → it resolves (proves the gate,
    // not a coincidental miss, is what blocked it above).
    expect(await resolveRecallKey(q, [...KNOWN_FACTS, 'occupation: software'], occEnc)).toBe('occupation');
  });

  it('candidate-safety — CANDIDATE-provenance WKG entity is never returned', () => {
    const wkg: WkgContext = {
      ...EMPTY_WKG,
      entities: [
        { nodeId: 'cand-1', label: 'Banoffee', nodeType: 'Entity', properties: {}, confidence: 0.55, provenance: 'CANDIDATE' },
      ],
    };
    // A recall key with no OKG fact would fall to WKG — but the only entity is a
    // :Candidate, which the resolver excludes (CANON Std-3). Result: null.
    const r = retrieveRecallGrounding(PERSON, 'what is my job?', undefined, wkg, 'occupation');
    expect(r).toBeNull();
  });

  it('candidate excluded even when a real entity is also present (candidate not chosen)', () => {
    const wkg: WkgContext = {
      ...EMPTY_WKG,
      entities: [
        { nodeId: 'cand-1', label: 'Banoffee', nodeType: 'Entity', properties: {}, confidence: 0.55, provenance: 'CANDIDATE' },
        { nodeId: 'wkg-real-1', label: 'Seattle', nodeType: 'Entity', properties: {}, confidence: 0.8, provenance: 'GUARDIAN' },
      ],
    };
    const r = retrieveRecallGrounding(PERSON, 'what is my job?', undefined, wkg, 'occupation');
    expect(r).not.toBeNull();
    expect(r!.factNodeId).toBe('wkg-real-1'); // the real entity, NEVER the candidate
    expect(r!.factNodeId).not.toBe('cand-1');
  });

  it('degradation — no encoder → equals regex-only (regex miss → null)', async () => {
    // Encoder absent → the semantic pass is skipped → regex-only behavior. The
    // paraphrase the regex misses now returns null (never regresses C1; worst
    // case C8 == current regex behavior).
    expect(recallKeyForQuestion("Remind me which town I'm based in")).toBeNull();
    const key = await resolveRecallKey("Remind me which town I'm based in", KNOWN_FACTS, null);
    expect(key).toBeNull();
    // ...but a regex HIT still resolves with no encoder (regex is first).
    expect(await resolveRecallKey('what is my name?', KNOWN_FACTS, null)).toBe('name');
  });

  it('degradation — encoder returns the zero-vector sentinel → skip semantic pass', async () => {
    const zeroEnc: RecallKeyEncoder = {
      encodeQuery: async () => new Array(5).fill(0),
      encodeDocument: async () => AXES.location,
    };
    // Ollama-down sentinel on the query → semantic pass aborts → regex-only → null.
    const key = await resolveRecallKey("Remind me which town I'm based in", KNOWN_FACTS, zeroEnc);
    expect(key).toBeNull();
  });

  it('threshold — an off-key paraphrase below threshold is rejected', async () => {
    const enc = mockEncoder();
    // 'other' axis sits at ~0.45 cosine with every key axis — below 0.62 → no
    // key accepted, even though candidates exist. Guards against over-grounding.
    expect(RECALL_SEMANTIC_THRESHOLD).toBeGreaterThan(0.45);
    const key = await resolveRecallKey('tell me something interesting', KNOWN_FACTS, enc);
    expect(key).toBeNull();
  });
});

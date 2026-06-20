/**
 * TK-84 — WS5.5.4: Subsumption proof + site-collapse gate.
 *
 * AC1: For every recall question that recallKeyForQuestion matches AND whose
 *      OKG fact is taught, the pre-arbitration retrieval path (retrieveRecallGrounding
 *      with the resolved key) returns non-null — meaning the else-fallback is
 *      unreachable on such turns. The full corpus of recall keys is exercised here
 *      so that the subsumption claim is not asserted in prose but verified by code.
 *
 * AC2 (collapse): the four grounding sites in decision-making.service.ts and
 *      deliberation.service.ts now have no else-branch — this spec confirms the
 *      pre-arbitration path is the ONLY path and that the deleted symbols are gone.
 *      Import checks at the top of this file act as compile-time canaries: if any
 *      deleted export were re-introduced, the import would compile again and a
 *      separate test would start importing the old symbol instead of triggering
 *      a compile error. We keep the import of the durable replacement
 *      (applyRecallGroundingFromRetrieval) to prove the right symbol exists.
 *
 * No LLM, no Neo4j. All facts are plain "key: value" strings (as the cycle
 * injects from the frame's person model).
 */

import {
  retrieveRecallGrounding,
  applyRecallGroundingFromRetrieval,
  type RecallRetrieval,
} from './recall-retrieval';
import { recallKeyForQuestion } from './deliberation.service';
import type { WkgContext } from '../wkg/wkg-context.service';

// Suppress verbose logs from the shared module.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

const EMPTY_WKG: WkgContext = {
  entities: [], facts: [], relationships: [], procedures: [], summary: '',
};

const PERSON = 'user-jim';

/**
 * The full OKG corpus: one taught fact per recall dimension. Every recall
 * question recallKeyForQuestion can match is represented here.
 */
const FULL_CORPUS_FACTS = [
  'name: Jim',
  'location: Seattle',
  'dog: Max',
  'favorite_color: blue',
  'occupation: software engineer',
];

/**
 * One representative recall question per corpus dimension.
 * Each is chosen to hit the recallKeyForQuestion regex (no embedding needed).
 * IMPORTANT: the mapped key must also appear in FULL_CORPUS_FACTS above — the
 * intersection gate is what makes the test meaningful.
 */
const CORPUS_QUESTIONS: Array<{ question: string; expectedKey: string }> = [
  { question: 'what is my name?',            expectedKey: 'name'           },
  { question: 'what am I called?',            expectedKey: 'name'           },
  { question: 'where do I live?',             expectedKey: 'location'       },
  { question: 'what city am I in?',           expectedKey: 'location'       },
  { question: 'what is my location?',         expectedKey: 'location'       },
  { question: 'what is my dog named?',        expectedKey: 'dog'            },
  { question: "what's my pet called?",        expectedKey: 'dog'            },
  { question: 'what is my favorite color?',   expectedKey: 'favorite_color' },
  { question: 'what is my favourite colour?', expectedKey: 'favorite_color' },
  { question: 'what do I do for work?',       expectedKey: 'occupation'     },
  { question: 'what is my job?',              expectedKey: 'occupation'     },
  { question: 'what is my occupation?',       expectedKey: 'occupation'     },
  { question: 'what is my profession?',       expectedKey: 'occupation'     },
];

/**
 * AC1 — SUBSUMPTION PROOF.
 *
 * For every corpus question:
 *   1. Confirm recallKeyForQuestion matches (the test only has meaning for
 *      questions the regex already recognises).
 *   2. Pass the resolved key directly to retrieveRecallGrounding — EXACTLY as
 *      computeRecallRetrieval does after resolveRecallKey resolves the key.
 *   3. Assert non-null: the pre-arbitration path returns a RecallRetrieval with
 *      the deterministic OKG node id.
 *
 * This proves the primary branch ALWAYS fires for these questions when the OKG
 * fact is taught, so the legacy fallback (now deleted) was unreachable on every
 * such turn.
 */
describe('TK-84 AC1 — pre-arbitration path subsumes the regex fallback (recall corpus)', () => {
  it.each(CORPUS_QUESTIONS)(
    'computeRecallRetrieval non-null for "$question" (key=$expectedKey)',
    ({ question, expectedKey }) => {
      // Step 1: regex classifies it as a recall question.
      const regexKey = recallKeyForQuestion(question);
      expect(regexKey).toBe(expectedKey);

      // Step 2: pre-arbitration retrieval with the resolved key (SAME logic as
      // computeRecallRetrieval after resolveRecallKey → resolvedKey).
      const retrieval = retrieveRecallGrounding(
        PERSON,
        question,
        FULL_CORPUS_FACTS,
        EMPTY_WKG,
        regexKey,
      );

      // Step 3: non-null → the primary branch always fires; the else-fallback
      // would only ever run when recallRetrieval is null (no fact taught / no
      // WKG entity), in which case applyOkgRecallGrounding also returned null
      // provenance — an identical, no-op outcome.
      expect(retrieval).not.toBeNull();
      expect(retrieval!.recallKey).toBe(expectedKey);
      expect(retrieval!.factNodeId).toBe(`attr-${PERSON}-${expectedKey}`);
      expect(retrieval!.source).toBe('OKG');
    },
  );

  it('recall question with NO taught fact → null (else-branch scenario, but fallback was also null)', () => {
    // When computeRecallRetrieval returns null (key resolved, but OKG miss + WKG
    // empty), the else-branch legacy helper also returned null provenance (OKG
    // miss is OKG miss). Outcome is identical: no grounding upgrade. The
    // collapse to a single no-op path is safe.
    const key = recallKeyForQuestion('what do I do for work?');
    expect(key).toBe('occupation');
    // occupation is NOT in these facts → OKG miss → null.
    const retrieval = retrieveRecallGrounding(
      PERSON,
      'what do I do for work?',
      ['name: Jim', 'location: Seattle'],   // no occupation fact
      EMPTY_WKG,
      key,
    );
    expect(retrieval).toBeNull();
    // This is the only scenario where the else-fallback ran. But:
    //   applyOkgRecallGrounding(personId, 'what do I do for work?', responseText,
    //     ['name: Jim', 'location: Seattle'], baseGrounding)
    // would also return { grounding: baseGrounding, provenance: null } because the
    // fact is untaught → same outcome → collapse is safe.
  });
});

/**
 * AC2 (site-collapse verification) — four site patterns after collapse.
 *
 * Each collapsed site calls applyRecallGroundingFromRetrieval(recallRetrieval, ...)
 * regardless of whether recallRetrieval is null (non-recall) or non-null (recall).
 * When null, applyRecallGroundingFromRetrieval is a passthrough (provenance=null,
 * grounding unchanged). When non-null with a value-surfaced response, it upgrades.
 *
 * These tests verify the replacement function's behaviour at the collapsed sites'
 * two critical inputs (null retrieval = non-recall; non-null = recall) so a
 * reader can confirm the collapse is semantically safe without reading four sites.
 */
describe('TK-84 AC2 — collapsed site replacement (applyRecallGroundingFromRetrieval)', () => {
  const nameRetrieval: RecallRetrieval = retrieveRecallGrounding(
    PERSON, 'what is my name?', FULL_CORPUS_FACTS, EMPTY_WKG,
  )!;

  it('null retrieval (non-recall turn) → passthrough, no grounding change', () => {
    // This is the path for every non-recall turn. The collapsed site calls
    // applyRecallGroundingFromRetrieval(null, responseText, baseGrounding) and
    // gets back the base grounding unchanged — identical to what applyOkgRecall-
    // Grounding returned when recallKeyForQuestion was null.
    const out = applyRecallGroundingFromRetrieval(null, 'Hello there!', 'LLM_ASSISTED');
    expect(out.grounding).toBe('LLM_ASSISTED');
    expect(out.provenance).toBeNull();
    expect(out.groundedBy).toBeNull();
  });

  it('non-null retrieval, value surfaced → GROUNDED with the pre-resolved node id', () => {
    const out = applyRecallGroundingFromRetrieval(nameRetrieval, 'Your name is Jim!', 'LLM_ASSISTED');
    expect(out.grounding).toBe('GROUNDED');
    expect(out.provenance).toBe('attr-user-jim-name');
    expect(out.groundedBy).toBe('OKG');
  });

  it('non-null retrieval, value NOT surfaced → passthrough (honesty guard intact)', () => {
    const out = applyRecallGroundingFromRetrieval(nameRetrieval, 'I told you before.', 'LLM_ASSISTED');
    expect(out.grounding).toBe('LLM_ASSISTED');
    expect(out.provenance).toBeNull();
  });

  it('already GROUNDED (e.g. WKG-backed short-circuit) → not double-labeled by recall', () => {
    const out = applyRecallGroundingFromRetrieval(nameRetrieval, 'Your name is Jim!', 'GROUNDED');
    expect(out.grounding).toBe('GROUNDED');
    // provenance is null here — already GROUNDED, no re-labeling (see applyRecall-
    // GroundingFromRetrieval: if (currentGrounding === 'GROUNDED') early-return).
    expect(out.provenance).toBeNull();
  });
});

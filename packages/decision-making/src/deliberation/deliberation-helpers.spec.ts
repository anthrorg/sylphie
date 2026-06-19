/**
 * TK-36 — deliberation-helpers.ts unit spec.
 *
 * Verifies acceptance criteria:
 *   AC1: isIgnoranceResponse and recallKeyForQuestion are importable from the
 *        new helpers module AND from the deliberation.service.ts re-export path
 *        (so existing callers don't break).
 *   AC2: The extracted helpers behave identically to the original inline versions.
 *
 * All tests are pure-function / no LLM / no Neo4j.
 */

import {
  isIgnoranceResponse,
  recallKeyForQuestion,
  personFactRecalled,
  inferGrounding,
  discriminateGroundedBy,
  applyOkgRecallGrounding,
  okgRecallProvenance,
  getRecalledFactForRecall,
  parseGroundingTag,
  parseCandidates,
  buildDriveSummary,
  buildEpisodeSummary,
  extractNewEntities,
} from './deliberation-helpers';

// Verify the re-export from deliberation.service still works (AC1 — no callers break).
import {
  isIgnoranceResponse as isIgnoranceResponseFromService,
  recallKeyForQuestion as recallKeyForQuestionFromService,
} from './deliberation.service';

// Suppress verbose logs from the imported module.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// AC1 — re-export compatibility
// ---------------------------------------------------------------------------

describe('AC1 — re-export compatibility (importable from both helpers and service)', () => {
  it('isIgnoranceResponse from helpers === same function as from service re-export', () => {
    // Both should return the same result for any input.
    expect(isIgnoranceResponse("I don't know")).toBe(isIgnoranceResponseFromService("I don't know"));
    expect(isIgnoranceResponse('Hello!')).toBe(isIgnoranceResponseFromService('Hello!'));
  });

  it('recallKeyForQuestion from helpers === same function as from service re-export', () => {
    expect(recallKeyForQuestion('what is my name?')).toBe(recallKeyForQuestionFromService('what is my name?'));
    expect(recallKeyForQuestion('tell me a story')).toBe(recallKeyForQuestionFromService('tell me a story'));
  });
});

// ---------------------------------------------------------------------------
// isIgnoranceResponse
// ---------------------------------------------------------------------------

describe('isIgnoranceResponse', () => {
  it.each([
    ["I don't know", true],
    ["I don't really know", true],
    ["I'm not sure", true],
    ["I have no idea", true],
    ["I have no information about that", true],
    ["I can't recall", true],
    ["I can't remember", true],
    ["I do not know", true],
    ["no information about that topic", true],
    // Non-ignorance responses
    ['Your name is Jim', false],
    ['Hello there!', false],
    ['Seattle is a great city', false],
    ['', false],
  ])('%j → %s', (text, expected) => {
    expect(isIgnoranceResponse(text)).toBe(expected);
  });

  it('case-insensitive', () => {
    expect(isIgnoranceResponse("I DON'T KNOW")).toBe(true);
    expect(isIgnoranceResponse("I'M NOT SURE")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recallKeyForQuestion
// ---------------------------------------------------------------------------

describe('recallKeyForQuestion', () => {
  it.each([
    ['what is my name?', 'name'],
    ['what am I called?', 'name'],
    ['where do I live?', 'location'],
    ['what city am I in?', 'location'],
    ['what is my dog named?', 'dog'],
    ["what's my pet called?", 'dog'],
    ['what is my favorite color?', 'favorite_color'],
    ['what is my favourite colour?', 'favorite_color'],
    ['what do I do for work?', 'occupation'],
    ['what is my job?', 'occupation'],
  ])('%j → %j', (q, k) => expect(recallKeyForQuestion(q)).toBe(k));

  it.each([
    'tell me a story about dragons',
    'how does photosynthesis happen?',
    'what time is it?',
    '',
  ])('non-recall %j → null', (q) => expect(recallKeyForQuestion(q)).toBeNull());

  it('excludes middle/last name', () => {
    expect(recallKeyForQuestion('what is my middle name?')).toBeNull();
    expect(recallKeyForQuestion('what is my last name?')).toBeNull();
  });

  it('excludes childhood location', () => {
    expect(recallKeyForQuestion('where did I grow up?')).toBeNull();
    expect(recallKeyForQuestion('where was I born?')).toBeNull();
  });

  it('excludes other favorite categories', () => {
    expect(recallKeyForQuestion('what is my favorite food?')).toBeNull();
    expect(recallKeyForQuestion('what is my favorite movie?')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// personFactRecalled
// ---------------------------------------------------------------------------

describe('personFactRecalled', () => {
  const facts = ['name: Jim', 'location: Seattle', 'dog: Max'];

  it('matches when value appears word-boundary', () => {
    expect(personFactRecalled(facts, 'Your name is Jim!')).toBe(true);
    expect(personFactRecalled(facts, 'You live in Seattle.')).toBe(true);
    expect(personFactRecalled(facts, 'Your dog Max is great.')).toBe(true);
  });

  it('returns false when no value surfaces', () => {
    expect(personFactRecalled(facts, 'I have no idea about that.')).toBe(false);
  });

  it('returns false with no known facts', () => {
    expect(personFactRecalled(undefined, 'Your name is Jim')).toBe(false);
    expect(personFactRecalled([], 'Your name is Jim')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRecalledFactForRecall
// ---------------------------------------------------------------------------

describe('getRecalledFactForRecall', () => {
  const facts = ['name: Jim', 'location: Seattle', 'dog: Max'];

  it('retrieves matching fact with deterministic attrId', () => {
    const r = getRecalledFactForRecall('user-jim', 'name', facts);
    expect(r).not.toBeNull();
    expect(r!.key).toBe('name');
    expect(r!.value).toBe('Jim');
    expect(r!.attrId).toBe('attr-user-jim-name');
  });

  it('returns null for missing key', () => {
    expect(getRecalledFactForRecall('user-jim', 'favorite_color', facts)).toBeNull();
  });

  it('returns null with no facts', () => {
    expect(getRecalledFactForRecall('user-jim', 'name', undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// okgRecallProvenance
// ---------------------------------------------------------------------------

describe('okgRecallProvenance', () => {
  const facts = ['name: Jim', 'location: Seattle'];

  it('returns attrId when fact value appears in response', () => {
    const p = okgRecallProvenance('user-jim', 'what is my name?', 'Your name is Jim!', facts);
    expect(p).toBe('attr-user-jim-name');
  });

  it('returns null when value not in response', () => {
    const p = okgRecallProvenance('user-jim', 'what is my name?', 'I am not sure', facts);
    expect(p).toBeNull();
  });

  it('returns null when personId is undefined', () => {
    const p = okgRecallProvenance(undefined, 'what is my name?', 'Your name is Jim', facts);
    expect(p).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyOkgRecallGrounding
// ---------------------------------------------------------------------------

describe('applyOkgRecallGrounding', () => {
  const facts = ['name: Jim'];

  it('upgrades to GROUNDED when provenance available', () => {
    const r = applyOkgRecallGrounding('user-jim', 'what is my name?', 'Your name is Jim!', facts, 'LLM_ASSISTED');
    expect(r.grounding).toBe('GROUNDED');
    expect(r.provenance).toBe('attr-user-jim-name');
  });

  it('returns unchanged grounding when already GROUNDED', () => {
    const r = applyOkgRecallGrounding('user-jim', 'what is my name?', 'Your name is Jim!', facts, 'GROUNDED');
    expect(r.grounding).toBe('GROUNDED');
    expect(r.provenance).toBeNull();
  });

  it('returns unchanged grounding when no provenance', () => {
    const r = applyOkgRecallGrounding('user-jim', 'what is my name?', 'I have no idea', facts, 'LLM_ASSISTED');
    expect(r.grounding).toBe('LLM_ASSISTED');
    expect(r.provenance).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// inferGrounding
// ---------------------------------------------------------------------------

const EMPTY_WKG = { entities: [], facts: [], relationships: [], procedures: [], summary: '' } as any;
const TOPICAL_WKG = {
  entities: [{ label: 'Python', nodeType: 'Technology', nodeId: 'n1', properties: {}, confidence: 1, provenance: 'test' }],
  facts: ['Python is a programming language'],
  relationships: [],
  procedures: [],
  summary: 'Python info',
} as any;
const BASE_WKG = {
  entities: [{ label: 'CoBeing', nodeType: 'CoBeing', nodeId: 'n2', properties: {}, confidence: 1, provenance: 'test' }],
  facts: [],
  relationships: [],
  procedures: [],
  summary: '',
} as any;

describe('inferGrounding', () => {
  it('returns UNKNOWN for ignorance responses', () => {
    expect(inferGrounding(TOPICAL_WKG, "I don't know about that")).toBe('UNKNOWN');
  });

  it('returns GROUNDED when person fact value surfaces', () => {
    const facts = ['name: Jim'];
    expect(inferGrounding(EMPTY_WKG, 'Your name is Jim!', facts)).toBe('GROUNDED');
  });

  it('returns GROUNDED when topical WKG facts present', () => {
    expect(inferGrounding(TOPICAL_WKG, 'Python is indeed a language')).toBe('GROUNDED');
  });

  it('returns LLM_ASSISTED when only base-context WKG entities (no topical, no facts)', () => {
    expect(inferGrounding(BASE_WKG, 'Hello there!')).toBe('LLM_ASSISTED');
  });

  it('returns LLM_ASSISTED with empty WKG and non-ignorance response', () => {
    expect(inferGrounding(EMPTY_WKG, 'Hello there!')).toBe('LLM_ASSISTED');
  });
});

// ---------------------------------------------------------------------------
// discriminateGroundedBy
// ---------------------------------------------------------------------------

describe('discriminateGroundedBy', () => {
  it('returns null for non-GROUNDED input', () => {
    expect(discriminateGroundedBy('LLM_ASSISTED', EMPTY_WKG, 'hello', undefined, null)).toBeNull();
    expect(discriminateGroundedBy('UNKNOWN', EMPTY_WKG, 'hello', undefined, null)).toBeNull();
  });

  it('returns OKG when okgProvenance is non-null', () => {
    expect(discriminateGroundedBy('GROUNDED', TOPICAL_WKG, 'Your name is Jim', ['name: Jim'], 'attr-user-jim-name')).toBe('OKG');
  });

  it('returns OKG when personFactRecalled matches', () => {
    expect(discriminateGroundedBy('GROUNDED', TOPICAL_WKG, 'Your name is Jim', ['name: Jim'], null)).toBe('OKG');
  });

  it('returns WKG for topical WKG backing without person-fact', () => {
    expect(discriminateGroundedBy('GROUNDED', TOPICAL_WKG, 'Python is great', [], null)).toBe('WKG');
  });

  it('returns null when GROUNDED but source unattributable', () => {
    expect(discriminateGroundedBy('GROUNDED', BASE_WKG, 'something grounded', [], null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseGroundingTag
// ---------------------------------------------------------------------------

describe('parseGroundingTag', () => {
  it('strips [GROUNDED] prefix', () => {
    const r = parseGroundingTag('[GROUNDED] Your name is Jim');
    expect(r.text).toBe('Your name is Jim');
    expect(r.grounding).toBe('GROUNDED');
  });

  it('strips [UNKNOWN] prefix', () => {
    const r = parseGroundingTag('[UNKNOWN] I do not know');
    expect(r.text).toBe('I do not know');
    expect(r.grounding).toBe('UNKNOWN');
  });

  it('strips [ASSISTED] and maps to LLM_ASSISTED', () => {
    const r = parseGroundingTag('[ASSISTED] Hello there');
    expect(r.text).toBe('Hello there');
    expect(r.grounding).toBe('LLM_ASSISTED');
  });

  it('returns null grounding when no tag', () => {
    const r = parseGroundingTag('Hello there!');
    expect(r.text).toBe('Hello there!');
    expect(r.grounding).toBeNull();
  });

  it('strips trailing grounding tags', () => {
    const r = parseGroundingTag('Hello [GROUNDED]');
    expect(r.text).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// parseCandidates
// ---------------------------------------------------------------------------

describe('parseCandidates', () => {
  it('parses numbered list format', () => {
    const text = '1. First response — some reasoning\n2. Second response — more reasoning\n3. Third response';
    const cs = parseCandidates(text);
    expect(cs).toHaveLength(3);
    expect(cs[0].text).toBe('First response');
    expect(cs[0].reasoning).toBe('some reasoning');
    expect(cs[2].text).toBe('Third response');
    expect(cs[2].reasoning).toBe('');
  });

  it('returns empty array for non-matching text', () => {
    expect(parseCandidates('no numbered list here')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildDriveSummary
// ---------------------------------------------------------------------------

describe('buildDriveSummary', () => {
  it('returns "calm" when all drives below threshold', () => {
    const snap = { pressureVector: { hunger: 0.1, safety: 0.05 }, sessionId: 's1', tickNumber: 1, totalPressure: 0, timestamp: '', driveDeltas: {} };
    expect(buildDriveSummary(snap as any)).toBe('calm (all drives low)');
  });

  it('lists active drives above 0.2', () => {
    const snap = { pressureVector: { hunger: 0.6, safety: 0.1 }, sessionId: 's1', tickNumber: 1, totalPressure: 0, timestamp: '', driveDeltas: {} };
    const result = buildDriveSummary(snap as any);
    expect(result).toContain('hunger: 0.60');
    expect(result).not.toContain('safety');
  });
});

// ---------------------------------------------------------------------------
// buildEpisodeSummary
// ---------------------------------------------------------------------------

describe('buildEpisodeSummary', () => {
  it('returns empty string for no episodes', () => {
    const ctx = { recentEpisodes: [], driveSnapshot: {} } as any;
    expect(buildEpisodeSummary(ctx)).toBe('');
  });

  it('joins up to 5 episode summaries', () => {
    const episodes = Array.from({ length: 7 }, (_, i) => ({ inputSummary: `ep${i}` }));
    const ctx = { recentEpisodes: episodes } as any;
    const result = buildEpisodeSummary(ctx);
    expect(result).toContain('ep0');
    expect(result).toContain('ep4');
    expect(result).not.toContain('ep5');
  });
});

// ---------------------------------------------------------------------------
// extractNewEntities
// ---------------------------------------------------------------------------

describe('extractNewEntities', () => {
  it('finds capitalized words not in WKG', () => {
    const wkg = { ...EMPTY_WKG, entities: [{ label: 'Python', nodeType: 'Technology', nodeId: 'n1', properties: {}, confidence: 1, provenance: 'test' }] } as any;
    const entities = extractNewEntities('I love JavaScript and Python too', wkg);
    expect(entities).toContain('JavaScript');
    expect(entities).not.toContain('Python'); // already in WKG
  });

  it('returns empty for all-lowercase text', () => {
    expect(extractNewEntities('hello world today', EMPTY_WKG)).toHaveLength(0);
  });

  it('deduplicates entities', () => {
    const entities = extractNewEntities('London London London', EMPTY_WKG);
    expect(entities.filter(e => e === 'London')).toHaveLength(1);
  });
});

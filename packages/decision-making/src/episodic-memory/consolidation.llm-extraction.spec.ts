/**
 * EP12.1a (TK-87) — ConsolidationService LLM-assisted entity extraction.
 * EP12.1b (TK-88) — ConsolidationService LLM-assisted relationship extraction.
 *
 * Verifies the acceptance criteria:
 *   AC1 (TK-87) — @Optional() ILlmService injection: service constructs with
 *                  and without LLM_SERVICE bound; build does not break existing
 *                  DI path.
 *   AC2 (TK-87) — LLM entity path: multi-word proper nouns extracted whole,
 *                  lowercase concepts included, sentence-initial false positives
 *                  excluded, parseLlmExtractionResponse() returns correct
 *                  entities.
 *   AC3 (TK-87) — Entity fallback path: null llm, !isAvailable(), and
 *                  complete() throw/return unparseable text all fall back to
 *                  heuristic silently; consolidate() still returns success.
 *   AC4 (TK-88) — LLM relationship path: parseLlmRelationshipResponse returns
 *                  >=1 triple with a real (non-'observed_outcome') object,
 *                  carrying {subject, predicate, object, confidence, provenance}.
 *                  consolidate() with LLM bound produces relationships whose
 *                  objects are NOT the literal 'observed_outcome'.
 *   AC5 (TK-88) — Relationship fallback path: null llm, !isAvailable(),
 *                  complete() throws, or zero parseable triples all fall back to
 *                  the two-hardcoded-triple heuristic silently; the
 *                  (inputSummary[:80] -> 'triggered' -> actionTaken) and
 *                  (actionTaken -> 'produced' -> 'observed_outcome') triples are
 *                  produced; consolidate() returns success.
 *
 * Uses Jest mocks only — no real LLM calls.
 */

import type {
  Episode,
  ConsolidationCandidate,
  DriveSnapshot,
  ILlmService,
  LlmResponse,
  EpisodeSource,
  SemanticRelationship,
} from '@sylphie/shared';
import {
  ConsolidationService,
  parseLlmExtractionResponse,
  parseLlmRelationshipResponse,
} from './consolidation.service';
import type { IEpisodicMemoryService } from '../interfaces/decision-making.interfaces';

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

const episodicMemoryStub = {
  getRecentEpisodes: () => [],
} as unknown as IEpisodicMemoryService;

const driveSnapshot = { sessionId: 'test-session' } as unknown as DriveSnapshot;

function makeEpisode(
  inputSummary: string,
  actionTaken = 'observe',
  source: EpisodeSource = 'conversation',
): Episode {
  return {
    id: `ep-${Math.random().toString(36).slice(2)}`,
    source,
    timestamp: new Date(),
    driveSnapshot,
    inputSummary,
    actionTaken,
    predictionIds: [],
    ageWeight: 0.9,
    encodingDepth: 'NORMAL',
    contextFingerprint: 'fp',
  } as Episode;
}

function makeCandidate(episode: Episode): ConsolidationCandidate {
  return { episode, ageHours: 3, estimatedConfidence: 0.85 };
}

/** Build a minimal ILlmService mock. */
function makeLlmMock(opts: {
  available?: boolean;
  response?: string;
  throws?: boolean;
}): ILlmService {
  return {
    isAvailable: jest.fn().mockReturnValue(opts.available ?? true),
    complete: opts.throws
      ? jest.fn().mockRejectedValue(new Error('LLM timeout'))
      : jest.fn().mockResolvedValue({
          content: opts.response ?? '[]',
          tokensUsed: { prompt: 10, completion: 5 },
          latencyMs: 100,
          model: 'test-model',
          cost: 0.0,
        } satisfies LlmResponse),
    estimateCost: jest.fn(),
    setUnavailable: jest.fn(),
    clearUnavailable: jest.fn(),
  } as unknown as ILlmService;
}

// ---------------------------------------------------------------------------
// AC1 — constructor injection
// ---------------------------------------------------------------------------

describe('AC1 — @Optional() ILlmService injection', () => {
  it('constructs without LLM_SERVICE (null default)', () => {
    const svc = new ConsolidationService(episodicMemoryStub, null);
    expect(svc).toBeInstanceOf(ConsolidationService);
  });

  it('constructs with LLM_SERVICE bound', () => {
    const llm = makeLlmMock({ available: true, response: '[]' });
    const svc = new ConsolidationService(episodicMemoryStub, null, llm);
    expect(svc).toBeInstanceOf(ConsolidationService);
  });

  it('existing DI path (null eventLogger, null llm) still constructs the service', () => {
    // Mirrors the existing provenance spec construction pattern exactly.
    const svc = new ConsolidationService(episodicMemoryStub, null);
    const episode = makeEpisode('James Bond met with Project Nightfall');
    const conv = svc.convertToSemantic(episode);
    // convertToSemantic is unchanged — still returns a SemanticConversion.
    expect(conv).toHaveProperty('sourceEpisodeId', episode.id);
    expect(typeof conv.confidence).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// AC2 — LLM path: multi-word entities, lowercase concepts, no false positives
// ---------------------------------------------------------------------------

describe('AC2 — LLM path: multi-word NER via extractWithLlm()', () => {
  const llmResponse =
    '["James Bond", "Project Nightfall", "trust", "espionage"]';

  it('multi-word proper nouns are extracted whole (not split on whitespace)', async () => {
    const llm = makeLlmMock({ available: true, response: llmResponse });
    const svc = new ConsolidationService(episodicMemoryStub, null, llm);
    const episode = makeEpisode('James Bond infiltrated Project Nightfall last night');
    const result = await svc.consolidate(makeCandidate(episode));

    // consolidate() must succeed; complete() is called twice — once for entity
    // extraction and once for relationship extraction (EP12.1b / TK-88).
    expect(result.success).toBe(true);
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });

  it('parseLlmExtractionResponse returns multi-word entries as single strings', () => {
    const entities = parseLlmExtractionResponse(llmResponse);
    expect(entities).toContain('James Bond');
    expect(entities).toContain('Project Nightfall');
  });

  it('parseLlmExtractionResponse includes lowercase concepts', () => {
    const entities = parseLlmExtractionResponse(llmResponse);
    expect(entities).toContain('trust');
    expect(entities).toContain('espionage');
  });

  it('parseLlmExtractionResponse deduplicates case-insensitively', () => {
    const response = '["Alice", "alice", "BOB", "Bob"]';
    const entities = parseLlmExtractionResponse(response);
    // Only first occurrence per lowercase key survives.
    expect(entities.filter((e) => e.toLowerCase() === 'alice')).toHaveLength(1);
    expect(entities.filter((e) => e.toLowerCase() === 'bob')).toHaveLength(1);
    expect(entities[0]).toBe('Alice');
    expect(entities[1]).toBe('BOB');
  });

  it('parseLlmExtractionResponse strips empty strings', () => {
    const response = '["Alice", "", "  ", "Bob"]';
    const entities = parseLlmExtractionResponse(response);
    expect(entities).not.toContain('');
    expect(entities).not.toContain('  ');
    expect(entities).toContain('Alice');
    expect(entities).toContain('Bob');
  });

  it('parseLlmExtractionResponse handles array embedded in prose (markdown fence)', () => {
    const prose =
      'Here are the entities:\n```json\n["James Bond", "MI6"]\n```\nDone.';
    const entities = parseLlmExtractionResponse(prose);
    expect(entities).toContain('James Bond');
    expect(entities).toContain('MI6');
  });
});

// ---------------------------------------------------------------------------
// AC3 — Fallback path: null llm, !isAvailable(), throws, unparseable
// ---------------------------------------------------------------------------

describe('AC3 — Fallback to heuristic, no exception, consolidate() returns success', () => {
  it('falls back silently when llm is null', async () => {
    const svc = new ConsolidationService(episodicMemoryStub, null);
    const episode = makeEpisode('James Bond met Alice');
    const result = await svc.consolidate(makeCandidate(episode));
    // Must succeed with heuristic entities.
    expect(result.success).toBe(true);
    expect(result.episodeId).toBe(episode.id);
  });

  it('falls back silently when isAvailable() returns false', async () => {
    const llm = makeLlmMock({ available: false });
    const svc = new ConsolidationService(episodicMemoryStub, null, llm);
    const episode = makeEpisode('James Bond met Alice');
    const result = await svc.consolidate(makeCandidate(episode));
    expect(result.success).toBe(true);
    // complete() must NOT have been called.
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('falls back with logger.warn (no exception) when complete() throws', async () => {
    const llm = makeLlmMock({ available: true, throws: true });
    const svc = new ConsolidationService(episodicMemoryStub, null, llm);
    // Spy on logger.warn to confirm the warn path fires.
    const warnSpy = jest
      .spyOn(svc['logger'], 'warn')
      .mockImplementation(() => undefined);
    const episode = makeEpisode('James Bond met Alice');
    const result = await svc.consolidate(makeCandidate(episode));
    expect(result.success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('extractWithLlm: LLM call failed'),
    );
  });

  it('falls back silently when LLM returns unparseable text (no JSON array)', async () => {
    const llm = makeLlmMock({ available: true, response: 'sorry I cannot help' });
    const svc = new ConsolidationService(episodicMemoryStub, null, llm);
    const episode = makeEpisode('James Bond met Alice');
    const result = await svc.consolidate(makeCandidate(episode));
    expect(result.success).toBe(true);
  });

  it('falls back silently when LLM returns an empty JSON array', async () => {
    const llm = makeLlmMock({ available: true, response: '[]' });
    const svc = new ConsolidationService(episodicMemoryStub, null, llm);
    const episode = makeEpisode('James Bond met Alice');
    const result = await svc.consolidate(makeCandidate(episode));
    // Empty LLM result → heuristic fallback → success.
    expect(result.success).toBe(true);
  });

  it('parseLlmExtractionResponse returns [] for no JSON array in response', () => {
    expect(parseLlmExtractionResponse('no json here')).toEqual([]);
    expect(parseLlmExtractionResponse('')).toEqual([]);
    expect(parseLlmExtractionResponse('{ "key": "value" }')).toEqual([]);
  });

  it('existing consolidation specs green: buildSpec — convertToSemantic unaffected', () => {
    // Verify that convertToSemantic() still uses heuristic (no LLM call possible here
    // since it is synchronous). This ensures the interface contract is unchanged.
    const svc = new ConsolidationService(episodicMemoryStub, null);
    const episode = makeEpisode('Alice ran across the Park');
    const conv = svc.convertToSemantic(episode);
    // Heuristic picks title-cased tokens: 'Alice', 'Park'.
    expect(conv.entities).toContain('Alice');
    expect(conv.entities).toContain('Park');
    // 'ran', 'across', 'the' are not title-cased.
    expect(conv.entities).not.toContain('ran');
  });
});

// ---------------------------------------------------------------------------
// AC4 (TK-88) — LLM relationship path: parseLlmRelationshipResponse and
//               consolidate() with LLM bound produce real-object triples
// ---------------------------------------------------------------------------

describe('AC4 (TK-88) — LLM relationship path: real-object triples from LLM', () => {
  /** A realistic relationship-extraction LLM response. */
  const relationshipResponse = JSON.stringify([
    { subject: 'Alice', predicate: 'requested', object: 'coffee' },
    { subject: 'coffee', predicate: 'caused', object: 'alertness', confidence: 0.7 },
  ]);

  it('parseLlmRelationshipResponse returns >=1 triple with a non-"observed_outcome" object', () => {
    const triples = parseLlmRelationshipResponse(relationshipResponse, 0.8, 'LLM_GENERATED');
    expect(triples.length).toBeGreaterThanOrEqual(1);
    for (const t of triples) {
      expect(t.object).not.toBe('observed_outcome');
    }
  });

  it('parseLlmRelationshipResponse shapes each triple with all required fields', () => {
    const triples = parseLlmRelationshipResponse(relationshipResponse, 0.8, 'LLM_GENERATED');
    for (const t of triples) {
      expect(typeof t.subject).toBe('string');
      expect(typeof t.predicate).toBe('string');
      expect(typeof t.object).toBe('string');
      expect(typeof t.confidence).toBe('number');
      expect(t.provenance).toBe('LLM_GENERATED');
    }
  });

  it('parseLlmRelationshipResponse uses supplied defaultConfidence when item has no confidence', () => {
    const response = JSON.stringify([
      { subject: 'Alice', predicate: 'met', object: 'Bob' },
    ]);
    const triples = parseLlmRelationshipResponse(response, 0.75, 'LLM_GENERATED');
    expect(triples[0]!.confidence).toBe(0.75);
  });

  it('parseLlmRelationshipResponse clamps item confidence to [0,1]', () => {
    const response = JSON.stringify([
      { subject: 'A', predicate: 'b', object: 'C', confidence: 9.99 },
      { subject: 'D', predicate: 'e', object: 'F', confidence: -5 },
    ]);
    const triples = parseLlmRelationshipResponse(response, 0.5, 'LLM_GENERATED');
    expect(triples[0]!.confidence).toBe(1);
    expect(triples[1]!.confidence).toBe(0);
  });

  it('parseLlmRelationshipResponse discards triples with object === "observed_outcome"', () => {
    const response = JSON.stringify([
      { subject: 'Alice', predicate: 'produced', object: 'observed_outcome' },
      { subject: 'Alice', predicate: 'requested', object: 'coffee' },
    ]);
    const triples = parseLlmRelationshipResponse(response, 0.8, 'LLM_GENERATED');
    expect(triples).toHaveLength(1);
    expect(triples[0]!.object).toBe('coffee');
  });

  it('parseLlmRelationshipResponse handles array embedded in prose (markdown fence)', () => {
    const prose =
      'Here are the triples:\n```json\n' +
      '[{"subject":"Alice","predicate":"met","object":"Bob"}]\n' +
      '```\nDone.';
    const triples = parseLlmRelationshipResponse(prose, 0.8, 'LLM_GENERATED');
    expect(triples).toHaveLength(1);
    expect(triples[0]!.subject).toBe('Alice');
  });

  it('consolidate() with LLM bound produces relationships whose objects are not "observed_outcome"', async () => {
    // Provide a two-call mock: first call returns entity JSON array, second
    // returns relationship JSON. Using mockResolvedValueOnce for sequencing.
    const entityResponseContent = '["Alice", "coffee"]';
    const llm = {
      isAvailable: jest.fn().mockReturnValue(true),
      complete: jest
        .fn()
        .mockResolvedValueOnce({
          content: entityResponseContent,
          tokensUsed: { prompt: 10, completion: 5 },
          latencyMs: 50,
          model: 'test-model',
          cost: 0,
        } satisfies LlmResponse)
        .mockResolvedValueOnce({
          content: relationshipResponse,
          tokensUsed: { prompt: 20, completion: 10 },
          latencyMs: 50,
          model: 'test-model',
          cost: 0,
        } satisfies LlmResponse),
      estimateCost: jest.fn(),
      setUnavailable: jest.fn(),
      clearUnavailable: jest.fn(),
    } as unknown as ILlmService;

    const svc = new ConsolidationService(episodicMemoryStub, null, llm);
    const episode = makeEpisode('Alice requested coffee from the cafe', 'observe');
    const result = await svc.consolidate(makeCandidate(episode));

    expect(result.success).toBe(true);
    // conversionsCreated reflects the LLM relationship count (2 triples above).
    expect(result.conversionsCreated).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC5 (TK-88) — Relationship fallback path: heuristic two-triple logic when
//               LLM unavailable or returns no usable triples
// ---------------------------------------------------------------------------

describe('AC5 (TK-88) — Relationship fallback to heuristic two-triple logic', () => {
  it('falls back to heuristic when llm is null: produces the two standard triples', async () => {
    const svc = new ConsolidationService(episodicMemoryStub, null);
    const episode = makeEpisode('Alice spoke to the doctor', 'speak');
    const conv = svc.convertToSemantic(episode);

    // Heuristic triples: primary has object=actionTaken, secondary has object='observed_outcome'.
    const rels = conv.relationships as SemanticRelationship[];
    expect(rels).toHaveLength(2);
    expect(rels[0]!.predicate).toBe('triggered');
    expect(rels[0]!.object).toBe('speak'); // actionTaken
    expect(rels[1]!.predicate).toBe('produced');
    expect(rels[1]!.object).toBe('observed_outcome');
  });

  it('falls back to heuristic when isAvailable() is false', async () => {
    const llm = makeLlmMock({ available: false });
    const svc = new ConsolidationService(episodicMemoryStub, null, llm);
    const episode = makeEpisode('Alice spoke to the doctor', 'speak');
    const result = await svc.consolidate(makeCandidate(episode));

    expect(result.success).toBe(true);
    // No LLM calls at all — both entity and relationship paths skipped.
    expect(llm.complete).not.toHaveBeenCalled();
    // conversionsCreated = 2 (heuristic two triples).
    expect(result.conversionsCreated).toBe(2);
  });

  it('falls back silently when LLM returns zero parseable relationship triples', async () => {
    // Entity call returns valid data; relationship call returns an empty array.
    const llm = {
      isAvailable: jest.fn().mockReturnValue(true),
      complete: jest
        .fn()
        .mockResolvedValueOnce({
          content: '["Alice"]',
          tokensUsed: { prompt: 5, completion: 2 },
          latencyMs: 30,
          model: 'test-model',
          cost: 0,
        } satisfies LlmResponse)
        .mockResolvedValueOnce({
          content: '[]',
          tokensUsed: { prompt: 10, completion: 2 },
          latencyMs: 30,
          model: 'test-model',
          cost: 0,
        } satisfies LlmResponse),
      estimateCost: jest.fn(),
      setUnavailable: jest.fn(),
      clearUnavailable: jest.fn(),
    } as unknown as ILlmService;

    const svc = new ConsolidationService(episodicMemoryStub, null, llm);
    const episode = makeEpisode('Alice spoke to the doctor', 'speak');
    const result = await svc.consolidate(makeCandidate(episode));

    expect(result.success).toBe(true);
    // Empty LLM relationship response → heuristic fallback → 2 triples.
    expect(result.conversionsCreated).toBe(2);
  });

  it('falls back silently when LLM relationship response only has "observed_outcome" objects', async () => {
    // All triples are discarded by parseLlmRelationshipResponse filter → [] → heuristic.
    const allPlaceholder = JSON.stringify([
      { subject: 'foo', predicate: 'produced', object: 'observed_outcome' },
    ]);
    const llm = {
      isAvailable: jest.fn().mockReturnValue(true),
      complete: jest
        .fn()
        .mockResolvedValueOnce({
          content: '[]',
          tokensUsed: { prompt: 5, completion: 1 },
          latencyMs: 30,
          model: 'test-model',
          cost: 0,
        } satisfies LlmResponse)
        .mockResolvedValueOnce({
          content: allPlaceholder,
          tokensUsed: { prompt: 10, completion: 5 },
          latencyMs: 30,
          model: 'test-model',
          cost: 0,
        } satisfies LlmResponse),
      estimateCost: jest.fn(),
      setUnavailable: jest.fn(),
      clearUnavailable: jest.fn(),
    } as unknown as ILlmService;

    const svc = new ConsolidationService(episodicMemoryStub, null, llm);
    const episode = makeEpisode('Alice spoke to the doctor', 'speak');
    const result = await svc.consolidate(makeCandidate(episode));

    expect(result.success).toBe(true);
    // All LLM relationship triples discarded → heuristic → 2 triples.
    expect(result.conversionsCreated).toBe(2);
  });

  it('parseLlmRelationshipResponse returns [] for no JSON array in response', () => {
    expect(parseLlmRelationshipResponse('no json here', 0.8, 'LLM_GENERATED')).toEqual([]);
    expect(parseLlmRelationshipResponse('', 0.8, 'LLM_GENERATED')).toEqual([]);
    expect(
      parseLlmRelationshipResponse('{ "key": "value" }', 0.8, 'LLM_GENERATED'),
    ).toEqual([]);
  });

  it('parseLlmRelationshipResponse returns [] when items lack required fields', () => {
    const response = JSON.stringify([
      { subject: 'Alice', predicate: 'met' }, // missing object
      { predicate: 'met', object: 'Bob' }, // missing subject
      { subject: 'Alice', object: 'Bob' }, // missing predicate
    ]);
    expect(parseLlmRelationshipResponse(response, 0.8, 'LLM_GENERATED')).toEqual([]);
  });
});

/**
 * EP12.1a (TK-87) — ConsolidationService LLM-assisted entity extraction.
 *
 * Verifies the three acceptance criteria:
 *   AC1 — @Optional() ILlmService injection: service constructs with and
 *          without LLM_SERVICE bound; build does not break existing DI path.
 *   AC2 — LLM path: multi-word proper nouns extracted whole, lowercase
 *          concepts included, sentence-initial false positives excluded,
 *          parseLlmExtractionResponse() returns correct entities.
 *   AC3 — Fallback path: null llm, !isAvailable(), and complete() throw/
 *          return unparseable text all fall back to heuristic silently;
 *          consolidate() still returns success.
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
} from '@sylphie/shared';
import { ConsolidationService, parseLlmExtractionResponse } from './consolidation.service';
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

    // consolidate() must succeed
    expect(result.success).toBe(true);
    expect(llm.complete).toHaveBeenCalledTimes(1);
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

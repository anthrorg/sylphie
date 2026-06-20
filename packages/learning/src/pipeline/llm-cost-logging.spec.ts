/**
 * TK-46 — Cost logging on learning LLM call sites.
 *
 * Acceptance criterion:
 *   Given a learning cycle that invokes the LLM, when it completes, then a
 *   'LLM cost [<step>]: $X (Np+Nc tokens)' line is emitted.
 *   For local Ollama (pricing = 0), $0.000000 is logged — always logged when
 *   the LLM was called.
 *
 * Strategy:
 *   The services are full NestJS classes, but we can construct them directly
 *   without a DI container by passing mocked constructor arguments. Each test:
 *     1. Builds a minimal mock LlmService that resolves with a known
 *        tokensUsed response.
 *     2. Mocks Logger.log so we can capture the log output.
 *     3. Invokes the relevant method and asserts the exact log line format.
 *
 * We test the three call sites independently:
 *   A. ConversationReflectionService.reflectOnSession   → [conversation-reflection]
 *   B. CrossSessionSynthesisService.synthesizePair       → [cross-session-synthesis]
 *   C. RefineEdgesService.refineEdges (LLM phase)        → [refine-edges]
 */

import { Logger } from '@nestjs/common';
import type { ILlmService, LlmRequest, LlmResponse, TimescaleService, Neo4jService } from '@sylphie/shared';
import { ConversationReflectionService } from './conversation-reflection.service';
import { CrossSessionSynthesisService } from './cross-session-synthesis.service';
import { RefineEdgesService } from './refine-edges.service';
import type { ILearningEventLogger } from '../interfaces/learning.interfaces';

// ---------------------------------------------------------------------------
// Shared mock builders
// ---------------------------------------------------------------------------

/**
 * Build a minimal ILlmService mock that always reports available and resolves
 * `complete()` with the supplied tokensUsed values.
 */
function makeLlm(promptTokens: number, completionTokens: number): ILlmService {
  const response: LlmResponse = {
    content: 'INSIGHT: THEMATIC_THREAD | 0.5 | test\nENTITIES: none\nEDGE: none',
    tokensUsed: { prompt: promptTokens, completion: completionTokens },
    latencyMs: 100,
    model: 'test-model',
    cost: 0,
  };

  return {
    isAvailable: () => true,
    complete: (_req: LlmRequest) => Promise.resolve(response),
    // estimateCost is not called by the services under test; stub to satisfy interface.
    estimateCost: () => ({ tokenEstimate: 0, latencyEstimate: 0, effortPressure: 0 }),
  } as unknown as ILlmService;
}

/**
 * Build a minimal TimescaleService mock that always returns empty result sets.
 * The learning services need it for DB queries but we short-circuit the LLM
 * path so most won't be called.
 */
function makeTimescale() {
  return {
    query: () => Promise.resolve({ rows: [] }),
  } as unknown as TimescaleService;
}

/**
 * Build a minimal Neo4jService mock.
 */
function makeNeo4j() {
  const session = {
    run: () => Promise.resolve({ records: [], summary: {} }),
    close: () => Promise.resolve(),
  };
  return {
    getSession: () => session,
  } as unknown as Neo4jService;
}

/**
 * Build a minimal ILearningEventLogger mock.
 */
function makeEventLogger() {
  return { log: () => {} } as unknown as ILearningEventLogger;
}

// ---------------------------------------------------------------------------
// Helper: spy on Logger.prototype.log and capture matching calls
// ---------------------------------------------------------------------------

function spyOnLoggerLog(target: Logger): jest.SpyInstance {
  return jest.spyOn(target, 'log').mockImplementation(() => {});
}

// ---------------------------------------------------------------------------
// A. ConversationReflectionService — [conversation-reflection]
// ---------------------------------------------------------------------------

describe('ConversationReflectionService — cost logging', () => {
  let logSpy: jest.SpyInstance;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs "LLM cost [conversation-reflection]: $X (Np+Nc tokens)" after a successful LLM call', async () => {
    // 1,000,000 prompt + 500,000 completion tokens → pricing from env defaults
    // (DEEPSEEK_DEFAULT_INPUT_PRICE_PER_M = 0.28, OUTPUT = 0.42)
    // cost = (1_000_000/1_000_000)*0.28 + (500_000/1_000_000)*0.42 = 0.28 + 0.21 = 0.49
    const promptTok = 1_000_000;
    const completionTok = 500_000;
    const llm = makeLlm(promptTok, completionTok);
    const timescale = makeTimescale();
    const neo4j = makeNeo4j();
    const eventLogger = makeEventLogger();

    // Override timescale.query so gatherSessionEvents returns at least 4 events
    // (MIN_EVENTS_FOR_REFLECTION check), and the LLM is called.
    const fakeEvents = Array.from({ length: 5 }, (_, i) => ({
      id: `ev-${i}`,
      type: 'INPUT_RECEIVED',
      timestamp: new Date(),
      subsystem: 'COMMUNICATION',
      payload: { content: `message ${i}` },
    }));
    (timescale as any).query = () => Promise.resolve({ rows: fakeEvents });

    // Neo4j returns no entities (to keep test simple).
    const neo4jSession = {
      run: () => Promise.resolve({ records: [] }),
      close: () => Promise.resolve(),
    };
    (neo4j as any).getSession = () => neo4jSession;

    const service = new ConversationReflectionService(llm, timescale, neo4j, eventLogger);
    logSpy = spyOnLoggerLog((service as any).logger);

    await service.reflectOnSession('test-session-1');

    // Find the cost log line among all logger.log calls.
    const costLine = (logSpy.mock.calls as [unknown][])
      .map(([msg]) => String(msg))
      .find((msg) => msg.startsWith('LLM cost [conversation-reflection]:'));

    expect(costLine).toBeDefined();
    // $0.490000 — 6 decimal places.
    expect(costLine).toMatch(/^LLM cost \[conversation-reflection\]: \$[\d.]+\s+\(\d+p\+\d+c tokens\)$/);
    expect(costLine).toContain(`${promptTok}p+${completionTok}c tokens`);
  });

  it('logs $0.000000 when pricing rates are zero (Ollama-style local call)', async () => {
    const promptTok = 200;
    const completionTok = 100;
    // Override env so prices are 0.
    const origInput = process.env['DEEPSEEK_INPUT_PRICE_PER_M'];
    const origOutput = process.env['DEEPSEEK_OUTPUT_PRICE_PER_M'];
    process.env['DEEPSEEK_INPUT_PRICE_PER_M'] = '0';
    process.env['DEEPSEEK_OUTPUT_PRICE_PER_M'] = '0';

    try {
      const llm = makeLlm(promptTok, completionTok);
      const timescale = makeTimescale();
      const neo4j = makeNeo4j();
      const eventLogger = makeEventLogger();

      const fakeEvents = Array.from({ length: 5 }, (_, i) => ({
        id: `ev-${i}`,
        type: 'INPUT_RECEIVED',
        timestamp: new Date(),
        subsystem: 'COMMUNICATION',
        payload: { content: `msg ${i}` },
      }));
      (timescale as any).query = () => Promise.resolve({ rows: fakeEvents });
      const neo4jSession = {
        run: () => Promise.resolve({ records: [] }),
        close: () => Promise.resolve(),
      };
      (neo4j as any).getSession = () => neo4jSession;

      // Construct fresh service (pricing resolved at construction time).
      const service = new ConversationReflectionService(llm, timescale, neo4j, eventLogger);
      logSpy = spyOnLoggerLog((service as any).logger);

      await service.reflectOnSession('test-session-ollama');

      const costLine = (logSpy.mock.calls as [unknown][])
        .map(([msg]) => String(msg))
        .find((msg) => msg.startsWith('LLM cost [conversation-reflection]:'));

      expect(costLine).toBeDefined();
      expect(costLine).toContain('$0.000000');
    } finally {
      // Restore env.
      if (origInput === undefined) delete process.env['DEEPSEEK_INPUT_PRICE_PER_M'];
      else process.env['DEEPSEEK_INPUT_PRICE_PER_M'] = origInput;
      if (origOutput === undefined) delete process.env['DEEPSEEK_OUTPUT_PRICE_PER_M'];
      else process.env['DEEPSEEK_OUTPUT_PRICE_PER_M'] = origOutput;
    }
  });
});

// ---------------------------------------------------------------------------
// B. CrossSessionSynthesisService — [cross-session-synthesis]
// ---------------------------------------------------------------------------

describe('CrossSessionSynthesisService — cost logging', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs "LLM cost [cross-session-synthesis]: $X (Np+Nc tokens)" after a successful LLM call', async () => {
    const promptTok = 400;
    const completionTok = 80;
    // LLM returns PATTERN_FOUND: false (simplest path through synthesizePair).
    const response: LlmResponse = {
      content: `PATTERN_FOUND: false\nPATTERN_TYPE: none\nDESCRIPTION: none\nCITES: insight-a, insight-b`,
      tokensUsed: { prompt: promptTok, completion: completionTok },
      latencyMs: 50,
      model: 'test-model',
      cost: 0,
    };
    const llm: ILlmService = {
      isAvailable: () => true,
      complete: () => Promise.resolve(response),
      estimateCost: () => ({ tokenEstimate: 0, latencyEstimate: 0, effortPressure: 0 }),
    } as unknown as ILlmService;

    const timescale = makeTimescale();
    const neo4j = makeNeo4j();
    const eventLogger = makeEventLogger();

    const service = new CrossSessionSynthesisService(llm, timescale, neo4j, eventLogger);
    const logSpy = spyOnLoggerLog((service as any).logger);

    // markPairAttempted calls timescale.query — keep returning empty rows.
    (timescale as any).query = () => Promise.resolve({ rows: [] });

    const pair = {
      insight1Id: 'insight-a',
      insight1Description: 'desc a',
      insight1Type: 'THEMATIC_THREAD' as const,
      insight1SessionId: 'session-1',
      insight1Confidence: 0.30,
      insight2Id: 'insight-b',
      insight2Description: 'desc b',
      insight2Type: 'THEMATIC_THREAD' as const,
      insight2SessionId: 'session-2',
      insight2Confidence: 0.30,
      sharedEntities: ['Coffee'],
    };

    await service.synthesizePair(pair);

    const costLine = (logSpy.mock.calls as [unknown][])
      .map(([msg]) => String(msg))
      .find((msg) => msg.startsWith('LLM cost [cross-session-synthesis]:'));

    expect(costLine).toBeDefined();
    expect(costLine).toMatch(/^LLM cost \[cross-session-synthesis\]: \$[\d.]+\s+\(\d+p\+\d+c tokens\)$/);
    expect(costLine).toContain(`${promptTok}p+${completionTok}c tokens`);
  });
});

// ---------------------------------------------------------------------------
// C. RefineEdgesService — [refine-edges]
// ---------------------------------------------------------------------------

describe('RefineEdgesService — cost logging', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs "LLM cost [refine-edges]: $X (Np+Nc tokens)" when LLM phase runs', async () => {
    const promptTok = 150;
    const completionTok = 30;
    const response: LlmResponse = {
      // Return no valid refinements — simplest path.
      content: 'no valid edges here',
      tokensUsed: { prompt: promptTok, completion: completionTok },
      latencyMs: 25,
      model: 'test-model',
      cost: 0,
    };
    const llm: ILlmService = {
      isAvailable: () => true,
      complete: () => Promise.resolve(response),
      estimateCost: () => ({ tokenEstimate: 0, latencyEstimate: 0, effortPressure: 0 }),
    } as unknown as ILlmService;

    const timescale = makeTimescale();
    const neo4j = makeNeo4j();

    const service = new RefineEdgesService(llm, timescale, neo4j);
    const logSpy = spyOnLoggerLog((service as any).logger);

    // Supply one RELATED_TO edge that heuristics cannot classify (no co-occurring verb).
    // This forces the LLM phase.
    const edges: import('../interfaces/learning.interfaces').ExtractedEdge[] = [
      {
        sourceId: 'node-a',
        sourceLabel: 'Widget',
        targetId: 'node-b',
        targetLabel: 'Gadget',
        relType: 'RELATED_TO',
        provenance: 'SENSOR' as const,
        confidence: 0.5,
        sessionId: 'session-x',
      },
    ];

    const event: import('../interfaces/learning.interfaces').UnlearnedEvent = {
      id: 'ev-x',
      type: 'INPUT_PARSED',
      timestamp: new Date(),
      subsystem: 'COMMUNICATION',
      session_id: 'session-x',
      payload: { content: 'Widget and Gadget coexist' },
      schema_version: 1,
    };

    // gatherPersonContext calls timescale.query
    (timescale as any).query = () => Promise.resolve({ rows: [] });

    await service.refineEdges(edges, event);

    const costLine = (logSpy.mock.calls as [unknown][])
      .map(([msg]) => String(msg))
      .find((msg) => msg.startsWith('LLM cost [refine-edges]:'));

    expect(costLine).toBeDefined();
    expect(costLine).toMatch(/^LLM cost \[refine-edges\]: \$[\d.]+\s+\(\d+p\+\d+c tokens\)$/);
    expect(costLine).toContain(`${promptTok}p+${completionTok}c tokens`);
  });
});

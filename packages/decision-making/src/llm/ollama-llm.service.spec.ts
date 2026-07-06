/**
 * TK-48 — OllamaLlmService cost consolidation spec.
 *
 * Verifies acceptance criteria:
 *   AC1: Given a DeepSeek call with known tokens, LlmResponse.cost equals
 *        estimateLlmCostUsd(...) with the resolved pricing rates (same result
 *        at default rates as the old hardcoded constants).
 *   AC2: Given custom DEEPSEEK_INPUT_PRICE_PER_M / DEEPSEEK_OUTPUT_PRICE_PER_M
 *        env vars, cost reflects them; no DEEPSEEK_*_COST_PER_M constant
 *        remains in the service; build green.
 *
 * All tests are pure-function / no real network / no Ollama.
 */

import {
  estimateLlmCostUsd,
  resolveLlmPricingFromEnv,
  DEEPSEEK_DEFAULT_INPUT_PRICE_PER_M,
  DEEPSEEK_DEFAULT_OUTPUT_PRICE_PER_M,
} from '@sylphie/shared';

// Suppress verbose logs from imported module
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Utility: build a minimal fetch mock that returns a DeepSeek-shaped response
// ---------------------------------------------------------------------------
function makeFetchMock(promptTokens: number, completionTokens: number, content = 'hello') {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      model: 'deepseek-reasoner',
    }),
    text: async () => '',
  });
}

// ---------------------------------------------------------------------------
// Build a minimal OllamaLlmService in isolation (no NestJS DI)
// ---------------------------------------------------------------------------

// We import the class directly and call onModuleInit() manually so we can
// inject a custom process.env snapshot for pricing tests.
import { OllamaLlmService } from './ollama-llm.service';

function buildService(env: NodeJS.ProcessEnv = {}): OllamaLlmService {
  // Minimal ConfigService stub
  const config = {
    get: (key: string, def?: unknown) => {
      const map: Record<string, unknown> = {
        'ollama.host': 'http://localhost:11434',
        'ollama.modelQuick': 'qwen2.5:3b',
        'ollama.modelMedium': 'qwen2.5:7b',
        'ollama.modelDeep': 'qwen2.5:14b',
        'ollama.chatTimeoutMs': 5000,
        'ollama.deepseekApiKey': 'sk-test-key',
        'ollama.deepseekBaseUrl': 'https://api.deepseek.com',
        'ollama.deepseekModel': 'deepseek-reasoner',
        'ollama.deepseekMediumModel': '',
      };
      return key in map ? map[key] : def;
    },
  } as any;

  const service = new OllamaLlmService(config);

  // Patch resolveLlmPricingFromEnv to use our test env snapshot.
  // We do this by temporarily overriding the env before calling onModuleInit.
  const savedEnv = { ...process.env };
  Object.assign(process.env, env);
  // Remove keys NOT in our env snapshot so we don't inherit host env vars.
  for (const key of ['DEEPSEEK_INPUT_PRICE_PER_M', 'DEEPSEEK_OUTPUT_PRICE_PER_M']) {
    if (!(key in env)) {
      delete process.env[key];
    }
  }
  service.onModuleInit();
  // Restore env
  Object.assign(process.env, savedEnv);
  for (const key of ['DEEPSEEK_INPUT_PRICE_PER_M', 'DEEPSEEK_OUTPUT_PRICE_PER_M']) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }

  return service;
}

const BASE_REQUEST = {
  tier: 'deep' as const,
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 200,
  temperature: 0.7,
  metadata: { purpose: 'test' },
};

// ---------------------------------------------------------------------------
// AC1 — default rates: cost equals estimateLlmCostUsd at documented defaults
// ---------------------------------------------------------------------------

describe('AC1 — default rates produce cost identical to estimateLlmCostUsd', () => {
  const PROMPT_TOKENS = 1000;
  const COMPLETION_TOKENS = 500;

  beforeEach(() => {
    // Install the fetch mock globally for this test
    global.fetch = makeFetchMock(PROMPT_TOKENS, COMPLETION_TOKENS) as any;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('cost equals estimateLlmCostUsd with documented DeepSeek defaults', async () => {
    const service = buildService({}); // no custom env → defaults

    const response = await service.complete(BASE_REQUEST);

    const expectedRates = resolveLlmPricingFromEnv({});
    const expectedCost = estimateLlmCostUsd(PROMPT_TOKENS, COMPLETION_TOKENS, expectedRates);

    expect(response.cost).toBe(expectedCost);
  });

  it('default rates match documented DeepSeek pricing constants', () => {
    // Sanity-check: the shared utility defaults equal the old hardcoded values.
    const rates = resolveLlmPricingFromEnv({});
    expect(rates.inputPricePerM).toBe(DEEPSEEK_DEFAULT_INPUT_PRICE_PER_M);
    expect(rates.outputPricePerM).toBe(DEEPSEEK_DEFAULT_OUTPUT_PRICE_PER_M);
  });

  it('cost is non-zero for non-zero token counts', async () => {
    const service = buildService({});
    const response = await service.complete(BASE_REQUEST);
    expect(response.cost).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — custom env vars are reflected in cost; no hardcoded COST_PER_M constant
// ---------------------------------------------------------------------------

describe('AC2 — custom DEEPSEEK_*_PRICE_PER_M env vars are reflected in cost', () => {
  const PROMPT_TOKENS = 2000;
  const COMPLETION_TOKENS = 1000;

  beforeEach(() => {
    global.fetch = makeFetchMock(PROMPT_TOKENS, COMPLETION_TOKENS) as any;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses custom input price when DEEPSEEK_INPUT_PRICE_PER_M is set', async () => {
    const customEnv = {
      DEEPSEEK_INPUT_PRICE_PER_M: '1.00',   // 1.00 vs default 0.28
      DEEPSEEK_OUTPUT_PRICE_PER_M: '0.42',
    };
    const service = buildService(customEnv);
    const response = await service.complete(BASE_REQUEST);

    const customRates = resolveLlmPricingFromEnv(customEnv);
    const expected = estimateLlmCostUsd(PROMPT_TOKENS, COMPLETION_TOKENS, customRates);

    expect(response.cost).toBe(expected);
    // And it differs from the default-rate cost
    const defaultRates = resolveLlmPricingFromEnv({});
    const defaultCost = estimateLlmCostUsd(PROMPT_TOKENS, COMPLETION_TOKENS, defaultRates);
    expect(response.cost).not.toBe(defaultCost);
  });

  it('uses custom output price when DEEPSEEK_OUTPUT_PRICE_PER_M is set', async () => {
    const customEnv = {
      DEEPSEEK_INPUT_PRICE_PER_M: '0.28',
      DEEPSEEK_OUTPUT_PRICE_PER_M: '2.00',  // 2.00 vs default 0.42
    };
    const service = buildService(customEnv);
    const response = await service.complete(BASE_REQUEST);

    const customRates = resolveLlmPricingFromEnv(customEnv);
    const expected = estimateLlmCostUsd(PROMPT_TOKENS, COMPLETION_TOKENS, customRates);

    expect(response.cost).toBe(expected);
    const defaultRates = resolveLlmPricingFromEnv({});
    const defaultCost = estimateLlmCostUsd(PROMPT_TOKENS, COMPLETION_TOKENS, defaultRates);
    expect(response.cost).not.toBe(defaultCost);
  });

  it('both custom rates together produce correct combined cost', async () => {
    const customEnv = {
      DEEPSEEK_INPUT_PRICE_PER_M: '0.50',
      DEEPSEEK_OUTPUT_PRICE_PER_M: '1.50',
    };
    const service = buildService(customEnv);
    const response = await service.complete(BASE_REQUEST);

    const customRates = resolveLlmPricingFromEnv(customEnv);
    const expected = estimateLlmCostUsd(PROMPT_TOKENS, COMPLETION_TOKENS, customRates);

    expect(response.cost).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Source-level guard: DEEPSEEK_*_COST_PER_M must not exist in the service file
// ---------------------------------------------------------------------------

describe('AC2 — no DEEPSEEK_*_COST_PER_M constant in service source', () => {
  it('service source does not contain the old hardcoded COST_PER_M constants', () => {
    // Read the source file content and assert the removed constants are gone.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, 'ollama-llm.service.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/DEEPSEEK_INPUT_COST_PER_M/);
    expect(src).not.toMatch(/DEEPSEEK_OUTPUT_COST_PER_M/);
  });
});

// ---------------------------------------------------------------------------
// TK-124 — LLM chat timeout: both client.chat() call sites must abort a
// stalled non-streaming Ollama request rather than hang forever.
//
// Mechanism under test: a custom `fetch` supplied via the Ollama client's
// Config.fetch hook, wrapping EVERY outgoing HTTP request in its own fresh
// AbortController + AbortSignal.timeout(this.timeoutMs) — NOT client.abort()
// (which cannot cancel a non-streaming call and is instance-wide for
// streamed ones per ollama-js v0.6.3).
// ---------------------------------------------------------------------------

/** Build a service with a configurable chatTimeoutMs, no DeepSeek routing (forces local Ollama). */
function buildLocalOllamaService(chatTimeoutMs: number): OllamaLlmService {
  const config = {
    get: (key: string, def?: unknown) => {
      const map: Record<string, unknown> = {
        'ollama.host': 'http://localhost:11434',
        'ollama.modelQuick': 'qwen2.5:3b',
        'ollama.modelMedium': 'qwen2.5:7b',
        'ollama.modelDeep': 'qwen2.5:14b',
        'ollama.chatTimeoutMs': chatTimeoutMs,
        'ollama.deepseekApiKey': '', // no DeepSeek — force local Ollama path
        'ollama.deepseekBaseUrl': 'https://api.deepseek.com',
        'ollama.deepseekModel': 'deepseek-reasoner',
        'ollama.deepseekMediumModel': '',
      };
      return key in map ? map[key] : def;
    },
  } as any;

  const service = new OllamaLlmService(config);
  service.onModuleInit();
  return service;
}

/**
 * A fetch mock that never resolves on its own, but rejects with an
 * AbortError the moment the request's signal fires — the same contract
 * real `fetch` honors for an aborted request.
 */
function makeHangingFetchMock(): jest.Mock {
  return jest.fn((_input: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) {
        if (signal.aborted) {
          const err = new Error('This operation was aborted');
          (err as any).name = 'AbortError';
          reject(err);
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            const err = new Error('This operation was aborted');
            (err as any).name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      }
      // Otherwise: never resolves — simulates a wedged Ollama socket.
    });
  });
}

describe('TK-124 AC1 — stalled non-streaming chat() call is aborted by its own per-request timeout', () => {
  const REQUEST = {
    tier: 'quick' as const,
    systemPrompt: 'You are helpful.',
    messages: [{ role: 'user' as const, content: 'Hello' }],
    maxTokens: 50,
    temperature: 0.7,
    metadata: { purpose: 'test' },
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('processInput settles (rejects) instead of hanging forever when the underlying Ollama chat() call is stalled', async () => {
    const fetchMock = makeHangingFetchMock();
    global.fetch = fetchMock as any;

    const service = buildLocalOllamaService(30); // 30ms timeout — fast test

    await expect(service.complete(REQUEST)).rejects.toBeDefined();
  });

  it('the underlying fetch call receives a signal that is actually aborted (not just abandoned)', async () => {
    const fetchMock = makeHangingFetchMock();
    global.fetch = fetchMock as any;

    const service = buildLocalOllamaService(30);

    await expect(service.complete(REQUEST)).rejects.toBeDefined();

    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(init.signal).toBeDefined();
    expect((init.signal as AbortSignal).aborted).toBe(true);
  });

  it('each outgoing request gets its OWN fresh AbortController (two stalled calls do not share one signal)', async () => {
    const fetchMock = makeHangingFetchMock();
    global.fetch = fetchMock as any;

    const service = buildLocalOllamaService(30);

    await expect(service.complete(REQUEST)).rejects.toBeDefined();
    await expect(service.complete(REQUEST)).rejects.toBeDefined();

    expect(fetchMock.mock.calls.length).toBe(2);
    const signal1 = (fetchMock.mock.calls[0]![1] as RequestInit).signal as AbortSignal;
    const signal2 = (fetchMock.mock.calls[1]![1] as RequestInit).signal as AbortSignal;
    expect(signal1).not.toBe(signal2);
    expect(signal1.aborted).toBe(true);
    expect(signal2.aborted).toBe(true);
  });

  it('a fast (non-stalled) call completes normally without ever aborting', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: 'hi there' },
        model: 'qwen2.5:3b',
        prompt_eval_count: 5,
        eval_count: 3,
      }),
      text: async () => '',
    }));
    global.fetch = fetchMock as any;

    const service = buildLocalOllamaService(30);
    const response = await service.complete(REQUEST);

    expect(response.content).toBe('hi there');
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });
});

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

function buildService(
  env: NodeJS.ProcessEnv = {},
  configOverrides: Record<string, unknown> = {},
): OllamaLlmService {
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
        ...configOverrides,
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

// ---------------------------------------------------------------------------
// TK-124 — LLM chat timeout via Config.fetch (per-request AbortSignal.timeout)
// ---------------------------------------------------------------------------

describe('TK-124 AC1 — hung Ollama chat() call is aborted after chatTimeoutMs', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a stalled client causes complete() to settle (reject), and the underlying fetch was actually aborted (not just abandoned)', async () => {
    const TIMEOUT_MS = 30;
    let capturedSignal: AbortSignal | undefined;

    // Simulate a wedged Ollama socket: fetch never resolves on its own; it
    // only rejects if/when its signal aborts (real fetch/AbortController
    // semantics — the request is truly cancelled, not merely abandoned).
    global.fetch = jest.fn((_input: unknown, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          (err as Error & { name: string }).name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const service = buildService({}, { 'ollama.chatTimeoutMs': TIMEOUT_MS });
    const request = { ...BASE_REQUEST, tier: 'quick' as const };

    // The promise MUST settle (reject) — proving the hung call is unwedged —
    // rather than hanging forever.
    await expect(service.complete(request)).rejects.toThrow();

    // The mechanism must be a real abort, not a bare Promise.race that leaves
    // the underlying request running unaborted: the signal handed to fetch
    // must itself have transitioned to aborted.
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('a fast (non-hung) call is NOT aborted — the timeout does not fire for normal-latency responses', async () => {
    const TIMEOUT_MS = 5000;
    global.fetch = jest.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      return {
        ok: true,
        json: async () => ({
          message: { content: 'hi' },
          model: 'qwen2.5:3b',
          prompt_eval_count: 5,
          eval_count: 3,
        }),
        text: async () => '',
      } as Response;
    }) as unknown as typeof fetch;

    const service = buildService({}, { 'ollama.chatTimeoutMs': TIMEOUT_MS });
    const request = { ...BASE_REQUEST, tier: 'quick' as const };

    const response = await service.complete(request);
    expect(response.content).toBe('hi');
  });
});

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

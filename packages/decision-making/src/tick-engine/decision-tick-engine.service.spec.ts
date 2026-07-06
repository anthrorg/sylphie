/**
 * DecisionTickEngineService unit tests — TK-31 acceptance criteria.
 *
 * AC1: The extraction compiles and all tests pass (same count — verified by
 *      running the full suite; these tests ADD to the count).
 * AC2: Behavior byte-identical — same log lines, same CycleGuard wiring.
 * AC3: Golden of tick-loop log lines + CycleGuard wiring pre-extraction matches
 *      post-extraction (verified by asserting the exact log strings produced).
 *
 * Test harness:
 *   - Fake/stub implementations of all injected dependencies.
 *   - Fake timers (jest.useFakeTimers) for timer-driven tick control.
 *   - Captured logger output to verify exact log line text (AC3 golden).
 *   - CycleGuard stub to verify enqueueing / notifyExternalComplete calls.
 */

import { Logger } from '@nestjs/common';
import { DecisionTickEngineService } from './decision-tick-engine.service';
import type { TickEngineCallbacks } from './decision-tick-engine.service';
import { OllamaLlmService } from '../llm/ollama-llm.service';

// Suppress verbose logs in tests.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogEntry {
  level: 'log' | 'warn' | 'debug' | 'error';
  message: string;
}

/** Build a minimal stub for all injected services. */
function buildEngine(opts: {
  executorIdle?: boolean;
  totalPressure?: number;
  lastInputTs?: number;
  hasNewInput?: boolean;
  tensorAvailable?: boolean;
  onProcessInput?: () => Promise<void>;
  onEnqueue?: (turn: unknown) => void;
} = {}): {
  engine: DecisionTickEngineService;
  logs: LogEntry[];
  notifyExternalCompleteCalls: number[];
  enqueueCalls: unknown[];
} {
  const logs: LogEntry[] = [];
  const notifyExternalCompleteCalls: number[] = [];
  const enqueueCalls: unknown[] = [];

  // Spy on Logger so we can capture log output.
  jest.spyOn(Logger.prototype, 'log').mockImplementation(function (msg: string) {
    logs.push({ level: 'log', message: msg });
  });
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(function (msg: string) {
    logs.push({ level: 'warn', message: msg });
  });
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(function (msg: string) {
    logs.push({ level: 'debug', message: msg });
  });
  jest.spyOn(Logger.prototype, 'error').mockImplementation(function (msg: string) {
    logs.push({ level: 'error', message: msg });
  });

  const executorState = opts.executorIdle !== false ? 'IDLE' : 'EXECUTING';

  const mockTickSampler = {
    onNewInput: jest.fn(),
    onSceneChange: jest.fn(),
    hasNewInput: jest.fn(() => opts.hasNewInput ?? false),
    getLastInputTimestamp: jest.fn(() => opts.lastInputTs ?? 0),
    peek: jest.fn(async () => makeFakeFrame()),
    sample: jest.fn(async () => makeFakeFrame()),
    injectSyntheticText: jest.fn(),
  };

  const mockCycleGuard = {
    enqueue: jest.fn((turn: unknown) => {
      enqueueCalls.push(turn);
      opts.onEnqueue?.(turn);
    }),
    getQueueStats: jest.fn(() => ({ tickInFlight: false })),
    notifyExternalComplete: jest.fn(() => {
      notifyExternalCompleteCalls.push(Date.now());
    }),
  };

  const mockDriveStateReader = {
    getCurrentState: jest.fn(() => ({
      totalPressure: opts.totalPressure ?? 0,
      pressureVector: {
        Boredom: 0,
        Curiosity: 0,
        Anxiety: 0,
        Sadness: 0,
        Guilt: 0,
        Focus: 0,
        CognitiveAwareness: 0,
        Novelty: 0,
        Satisfaction: 0,
        Social: 0,
      },
      tickNumber: 1,
      sessionId: 'session-test',
      timestamp: new Date(),
      driveDeltas: {},
      ruleMatchResult: { ruleId: null, eventType: 'TEST', matched: false },
    })),
  };

  const mockExecutorEngine = {
    getState: jest.fn(() => executorState),
  };

  const mockStreamLogger = {
    logFrame: jest.fn(),
  };

  const mockWkgContext = {
    queryEntities: jest.fn(async () => []),
  };

  const mockTensorInference = opts.tensorAvailable
    ? {
        isAvailable: jest.fn(() => true),
        submitTraining: jest.fn(),
      }
    : null;

  const mockMoodBleedMonitor = {
    onCycleStart: jest.fn(),
    onCycleEnd: jest.fn(),
  };

  const engine = new DecisionTickEngineService(
    mockTickSampler as any,
    mockCycleGuard as any,
    mockDriveStateReader as any,
    mockExecutorEngine as any,
    mockStreamLogger as any,
    mockWkgContext as any,
    mockTensorInference as any,
    mockMoodBleedMonitor as any,
  );

  const callbacks: TickEngineCallbacks = {
    processInput: opts.onProcessInput ?? jest.fn(async () => {}),
  };
  engine.wire(callbacks);

  return { engine, logs, notifyExternalCompleteCalls, enqueueCalls };
}

function makeFakeFrame() {
  return {
    active_modalities: ['text'],
    fused_embedding: new Array(768).fill(0),
    raw: { text: 'test' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  jest.restoreAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('DecisionTickEngineService — startTickLoop / stopTickLoop', () => {
  it('AC3 golden: logs exact "Starting tick engine" message on start', () => {
    const { engine, logs } = buildEngine();
    engine.startTickLoop(200);

    const startLog = logs.find((l) => l.message.includes('Starting tick engine'));
    expect(startLog).toBeDefined();
    // AC3: byte-identical log line
    expect(startLog!.message).toBe('Starting tick engine: timer=200ms, event-driven=immediate');
    expect(startLog!.level).toBe('log');

    engine.stopTickLoop();
  });

  it('AC3 golden: logs exact "Tick engine stopped." on stop', () => {
    const { engine, logs } = buildEngine();
    engine.startTickLoop(200);
    logs.length = 0; // clear start log
    engine.stopTickLoop();

    const stopLog = logs.find((l) => l.message === 'Tick engine stopped.');
    expect(stopLog).toBeDefined();
    expect(stopLog!.level).toBe('log');
  });

  it('warns and ignores duplicate startTickLoop calls', () => {
    const { engine, logs } = buildEngine();
    engine.startTickLoop(200);
    engine.startTickLoop(200); // duplicate

    const warnLog = logs.find((l) => l.message.includes('Tick loop already running'));
    expect(warnLog).toBeDefined();
    expect(warnLog!.message).toBe('Tick loop already running; ignoring duplicate start.');

    engine.stopTickLoop();
  });

  it('stopTickLoop is safe to call when not running', () => {
    const { engine, logs } = buildEngine();
    expect(() => engine.stopTickLoop()).not.toThrow();
    // No "Tick engine stopped." log when not running
    const stopLog = logs.find((l) => l.message === 'Tick engine stopped.');
    expect(stopLog).toBeUndefined();
  });
});

describe('DecisionTickEngineService — CycleGuard wiring (AC2)', () => {
  it('onNewInput callback enqueues a turn into CycleGuard', () => {
    const { engine, enqueueCalls } = buildEngine();
    engine.startTickLoop(200);

    // Extract the onNewInput callback that was registered
    const mockTickSampler = (engine as any).tickSampler;
    const onNewInputCb: () => void = mockTickSampler.onNewInput.mock.calls[0][0];
    expect(typeof onNewInputCb).toBe('function');

    onNewInputCb(); // simulate a new input event
    expect(enqueueCalls).toHaveLength(1);

    const turn = enqueueCalls[0] as any;
    expect(turn.isGuardian).toBe(false);
    expect(turn.text).toBe(''); // safety-net path — no per-turn text
    expect(typeof turn.turnId).toBe('string');

    engine.stopTickLoop();
  });

  it('onSceneChange callback enqueues a sceneNudge turn into CycleGuard', () => {
    const { engine, enqueueCalls } = buildEngine();
    engine.startTickLoop(200);

    const mockTickSampler = (engine as any).tickSampler;
    const onSceneChangeCb: () => void = mockTickSampler.onSceneChange.mock.calls[0][0];
    expect(typeof onSceneChangeCb).toBe('function');

    onSceneChangeCb(); // simulate a scene change
    expect(enqueueCalls).toHaveLength(1);

    const turn = enqueueCalls[0] as any;
    expect(turn.sceneNudge).toBe(true);
    expect(turn.isGuardian).toBe(false);
    expect(turn.text).toBe('');

    engine.stopTickLoop();
  });
});

describe('DecisionTickEngineService — isSelfTickInFlight (AC2)', () => {
  it('returns false initially', () => {
    const { engine } = buildEngine();
    expect(engine.isSelfTickInFlight()).toBe(false);
  });

  it('returns true during an in-flight self-tick and false after', async () => {
    let inflightDuringTick = false;
    const processInput = jest.fn(async () => {
      // Check the flag mid-tick
      inflightDuringTick = (engine as any).selfTickInFlight;
    });

    const { engine } = buildEngine({
      totalPressure: 10, // above IDLE_PRESSURE_THRESHOLD
      lastInputTs: 0,    // > 30s ago
      onProcessInput: processInput,
    });
    engine.startTickLoop(200);

    // Freeze lastSelfInitiatedAt so cooldown doesn't block
    (engine as any).lastSelfInitiatedAt = 0;

    await engine.onTick(false);

    expect(inflightDuringTick).toBe(true);
    expect(engine.isSelfTickInFlight()).toBe(false); // reset in finally
    engine.stopTickLoop();
  });
});

describe('DecisionTickEngineService — onTick self-tick guard (AC2)', () => {
  it('skips tick when another self-tick is in flight', async () => {
    const processInput = jest.fn(async () => {});
    const { engine } = buildEngine({
      totalPressure: 10,
      lastInputTs: 0,
      onProcessInput: processInput,
    });

    // Artificially set in-flight
    (engine as any).selfTickInFlight = true;
    await engine.onTick(false);
    expect(processInput).not.toHaveBeenCalled();
  });

  it('skips tick when executor is not IDLE', async () => {
    const processInput = jest.fn(async () => {});
    const { engine } = buildEngine({
      executorIdle: false,
      onProcessInput: processInput,
    });

    await engine.onTick(false);
    expect(processInput).not.toHaveBeenCalled();
  });

  it('skips self-tick when pressure is below threshold', async () => {
    const processInput = jest.fn(async () => {});
    const { engine } = buildEngine({
      totalPressure: 1.0, // below IDLE_PRESSURE_THRESHOLD (4.0)
      onProcessInput: processInput,
    });

    await engine.onTick(false);
    expect(processInput).not.toHaveBeenCalled();
  });

  it('skips self-tick when last input was < 30s ago', async () => {
    const processInput = jest.fn(async () => {});
    const { engine } = buildEngine({
      totalPressure: 10,
      lastInputTs: Date.now() - 5_000, // 5s ago — within 30s window
      onProcessInput: processInput,
    });

    await engine.onTick(false);
    expect(processInput).not.toHaveBeenCalled();
  });

  it('skips self-tick when within SELF_INITIATE_COOLDOWN_MS', async () => {
    const processInput = jest.fn(async () => {});
    const { engine } = buildEngine({
      totalPressure: 10,
      lastInputTs: 0, // long ago
      onProcessInput: processInput,
    });

    // Set lastSelfInitiatedAt to just now
    (engine as any).lastSelfInitiatedAt = Date.now() - 100;
    await engine.onTick(false);
    expect(processInput).not.toHaveBeenCalled();
  });

  it('notifyExternalComplete is called after a self-tick (AC2 CycleGuard wiring)', async () => {
    const processInput = jest.fn(async () => {});
    const { engine, notifyExternalCompleteCalls } = buildEngine({
      totalPressure: 10,
      lastInputTs: 0,
      onProcessInput: processInput,
    });

    (engine as any).lastSelfInitiatedAt = 0;
    await engine.onTick(false);

    expect(notifyExternalCompleteCalls.length).toBeGreaterThanOrEqual(1);
    engine.stopTickLoop();
  });
});

describe('DecisionTickEngineService — DEFAULT_TICK_MS constant (AC2)', () => {
  it('DEFAULT_TICK_MS is 200', () => {
    expect(DecisionTickEngineService.DEFAULT_TICK_MS).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// TK-124 AC2 — a hung Ollama socket during a self-tick must still let the
// existing finally block run (selfTickInFlight cleared, notifyExternalComplete
// called exactly once via the EXISTING :403 call) once the chat timeout aborts
// the underlying request. This is an integration test: processInput wraps a
// REAL OllamaLlmService.complete() call against a stalled fetch, proving the
// AC1 timeout mechanism actually reaches and unwedges the self-tick path.
// ---------------------------------------------------------------------------

describe('DecisionTickEngineService — TK-124 AC2: hung chat during a self-tick unwedges via chat timeout', () => {
  function buildLocalOllamaService(chatTimeoutMs: number): OllamaLlmService {
    const config = {
      get: (key: string, def?: unknown) => {
        const map: Record<string, unknown> = {
          'ollama.host': 'http://localhost:11434',
          'ollama.modelQuick': 'qwen2.5:3b',
          'ollama.modelMedium': 'qwen2.5:7b',
          'ollama.modelDeep': 'qwen2.5:14b',
          'ollama.chatTimeoutMs': chatTimeoutMs,
          'ollama.deepseekApiKey': '', // force local Ollama path
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
      });
    });
  }

  it('notifyExternalComplete fires exactly once (via the existing :403 call) when the self-tick chat call is stalled and the chat timeout aborts it', async () => {
    // This test needs REAL timers so AbortSignal.timeout(30) actually fires.
    jest.useRealTimers();

    const fetchMock = makeHangingFetchMock();
    global.fetch = fetchMock as any;

    const llm = buildLocalOllamaService(30); // fast timeout for a quick test

    const processInput = jest.fn(async () => {
      // Real LLM call against the stalled fetch — must settle (reject) rather
      // than hang, via the chat-timeout mechanism (TK-124 AC1).
      await llm.complete({
        tier: 'quick',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 20,
        temperature: 0.7,
        metadata: { purpose: 'self-tick-test' },
      });
    });

    const { engine, notifyExternalCompleteCalls } = buildEngine({
      totalPressure: 10,
      lastInputTs: 0,
      onProcessInput: processInput,
    });
    (engine as any).lastSelfInitiatedAt = 0;

    // onTick awaits processInput, which awaits the real (stalled) LLM call.
    // Because processInput's own error is caught internally (:388-390) and
    // the finally block always runs, onTick itself resolves even though the
    // underlying chat() call rejected.
    await engine.onTick(false);

    expect(processInput).toHaveBeenCalledTimes(1);
    // The chat call was attempted and its promise settled (rejected) — proven
    // by onTick() itself resolving rather than hanging forever.
    expect(fetchMock).toHaveBeenCalled();
    // selfTickInFlight cleared and notifyExternalComplete called exactly once
    // via the EXISTING call at :403 — not a duplicate/separate reset path.
    expect(engine.isSelfTickInFlight()).toBe(false);
    expect(notifyExternalCompleteCalls).toHaveLength(1);
  });
});

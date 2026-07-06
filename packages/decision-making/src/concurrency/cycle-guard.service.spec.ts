/**
 * CycleGuardService unit tests — WS4 Ticket 1 acceptance criteria.
 *
 * Covers spec §7 criteria testable without the multi-socket gate harness:
 *
 *  Q1.1 Burst: 5 turns <50ms → exactly 5 responses, zero silent drops
 *  Q1.2 No executor throws (queue prevents double-cycle entry at :438)
 *  Q1.3 Well-formed responses, no interleave
 *  Q1.4 Injected hang → watchdog kill + recovery within T_max+1000ms + queue drains
 *  Q1.5 Zombie guard (CRITICAL): late-resolving killed cycle emits NO second response
 *  Q1.6 Back-pressure: 13 turns → exactly 1 decline, 12 responses
 *  Q1.7 Guardian priority: guardian turn serviced before normal turns
 *  Q1.9 Circuit breaker: 3 kills → ENTER; 2 probes → EXIT
 *
 * Uses jest fake timers for Q1.4, Q1.5, Q1.9 so the suite stays fast.
 */

import { CycleGuardService } from './cycle-guard.service';
import type { InboundTurn } from './inbound-turn';
import type { TurnDeclinedEvent, WatchdogKillEvent, BreakerStateEvent } from './cycle-guard.service';

// Suppress verbose logs in tests
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return {
    ...actual,
    verboseFor: () => () => {},
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let turnCounter = 0;

function makeTurn(overrides: Partial<InboundTurn> = {}): InboundTurn {
  turnCounter++;
  const now = Date.now();
  return {
    turnId: `turn-${turnCounter}`,
    isGuardian: false,
    receivedAt: now,
    enqueuedAt: now,
    text: `test turn ${turnCounter}`,
    ...overrides,
  };
}

/**
 * Build a CycleGuardService with a minimal mock executor engine and
 * configurable cycle runner.
 */
function buildGuard(opts: {
  cycleDelayMs?: number;
  hangCycle?: boolean;
  cycleResults?: boolean[];
  onShrug?: (turnId: string, msg: string, epoch: number) => void;
}): {
  guard: CycleGuardService;
  responses: Array<{ turnId: string; epoch: number }>;
  declines: TurnDeclinedEvent[];
  kills: WatchdogKillEvent[];
  breaker: BreakerStateEvent[];
  executorState: { current: string };
  shrugs: Array<{ turnId: string; msg: string; epoch: number }>;
} {
  const responses: Array<{ turnId: string; epoch: number }> = [];
  const declines: TurnDeclinedEvent[] = [];
  const kills: WatchdogKillEvent[] = [];
  const breaker: BreakerStateEvent[] = [];
  const shrugs: Array<{ turnId: string; msg: string; epoch: number }> = [];
  const executorState = { current: 'IDLE' };

  const mockExecutor = {
    getState: () => executorState.current,
    forceIdle: () => { executorState.current = 'IDLE'; },
  };

  let resultIndex = 0;
  const cycleRunner = async (turn: InboundTurn, myEpoch: number): Promise<boolean> => {
    if (opts.hangCycle) {
      // Never resolves — simulates a wedged LLM call.
      return new Promise<boolean>(() => {});
    }
    const delay = opts.cycleDelayMs ?? 0;
    if (delay > 0) {
      await new Promise<void>(res => setTimeout(res, delay));
    }
    const success = opts.cycleResults?.[resultIndex++] ?? true;
    if (success) {
      responses.push({ turnId: turn.turnId, epoch: myEpoch });
    }
    return success;
  };

  const shrugEmitter = (turnId: string, msg: string, epoch: number): void => {
    shrugs.push({ turnId, msg, epoch });
    opts.onShrug?.(turnId, msg, epoch);
  };

  const guard = new CycleGuardService(null);
  guard.register(cycleRunner, shrugEmitter, mockExecutor as any);

  guard.turnDeclined$.subscribe(e => declines.push(e));
  guard.cycleWatchdogKill$.subscribe(e => kills.push(e));
  guard.circuitBreakerState$.subscribe(e => breaker.push(e));

  return { guard, responses, declines, kills, breaker, executorState, shrugs };
}

/** Wait for all microtasks and macrotasks to drain (used with fake timers). */
async function flushAll(ms = 0): Promise<void> {
  // Process all pending promises.
  await Promise.resolve();
  await Promise.resolve();
  if (ms > 0) {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Q1.1 — Burst: 5 turns → exactly 5 responses, zero silent drops
// ---------------------------------------------------------------------------

describe('Q1.1 — Burst (5 turns < depth)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
  });

  it('processes exactly 5 turns from a burst with no drops', async () => {
    const { guard, responses, declines } = buildGuard({ cycleDelayMs: 0 });

    const turns = Array.from({ length: 5 }, () => makeTurn());
    for (const t of turns) guard.enqueue(t);

    // Drain all timers and promises
    // Advance time 0ms to flush all synchronous setTimeouts
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    expect(responses).toHaveLength(5);
    expect(declines).toHaveLength(0);

    // All 5 turnIds should appear in responses.
    const responseIds = new Set(responses.map(r => r.turnId));
    for (const t of turns) {
      expect(responseIds).toContain(t.turnId);
    }

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// Q1.2 — No executor throws (:438 guard never fires under queue)
// ---------------------------------------------------------------------------

describe('Q1.2 — No executor throws under queue', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('serializes turns so processInput is never called with executor non-IDLE', async () => {
    // The guard serializes: one pop → one cycle. Between cycles tickInFlight = false.
    // The :438 guard fires if executor !== IDLE at call time; the queue prevents
    // concurrent calls so the guard should never fire.
    let maxConcurrent = 0;
    let current = 0;

    const guard = new CycleGuardService(null);
    const responses: string[] = [];

    const mockExecutor = {
      getState: () => (current > 0 ? 'CATEGORIZING' : 'IDLE'),
      forceIdle: () => {},
    };

    guard.register(
      async (turn, _epoch) => {
        current++;
        if (current > maxConcurrent) maxConcurrent = current;
        await Promise.resolve(); // yield
        responses.push(turn.turnId);
        current--;
        return true;
      },
      (_turnId, _msg, _epoch) => {},
      mockExecutor as any,
    );

    const turns = Array.from({ length: 5 }, () => makeTurn());
    for (const t of turns) guard.enqueue(t);

    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // Must NEVER have more than 1 cycle running at a time.
    expect(maxConcurrent).toBe(1);
    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// Q1.3 — Well-formed, no interleave
// ---------------------------------------------------------------------------

describe('Q1.3 — No interleave', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('processes turns in FIFO order, responses non-empty and sequenced', async () => {
    const { guard, responses } = buildGuard({ cycleDelayMs: 0 });

    const turns = [makeTurn(), makeTurn(), makeTurn()];
    for (const t of turns) guard.enqueue(t);

    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    expect(responses).toHaveLength(3);
    // FIFO: responses should be in the order turns were enqueued.
    expect(responses[0]?.turnId).toBe(turns[0]?.turnId);
    expect(responses[1]?.turnId).toBe(turns[1]?.turnId);
    expect(responses[2]?.turnId).toBe(turns[2]?.turnId);

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// Q1.4 — Injected hang → watchdog kill + recovery within T_max+1000ms + queue drains
// ---------------------------------------------------------------------------

describe('Q1.4 — Watchdog recovery from injected hang', () => {
  const WATCHDOG_MS = 25_000;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('kills the hung cycle, emits SHRUG, drains subsequent turns', async () => {
    const shrugs: string[] = [];
    const hangCtrl = { resolve: null as null | (() => void) };
    let callCount = 0;

    const guard = new CycleGuardService(null);
    const responses: string[] = [];
    const kills: WatchdogKillEvent[] = [];

    const mockExecutor = {
      getState: () => 'EXECUTING',
      forceIdle: jest.fn(),
    };

    guard.register(
      async (turn, _epoch) => {
        callCount++;
        if (callCount === 1) {
          // First turn: hang forever.
          return new Promise<boolean>(resolve => { hangCtrl.resolve = () => resolve(false); });
        }
        // Subsequent turns: complete immediately.
        responses.push(turn.turnId);
        return true;
      },
      (turnId, _msg, _epoch) => { shrugs.push(turnId); },
      mockExecutor as any,
    );

    guard.cycleWatchdogKill$.subscribe(e => kills.push(e));

    const hung = makeTurn({ turnId: 'hung-turn' });
    const follower1 = makeTurn({ turnId: 'follower-1' });
    const follower2 = makeTurn({ turnId: 'follower-2' });

    guard.enqueue(hung);
    guard.enqueue(follower1);
    guard.enqueue(follower2);

    // Let the hung cycle start.
    await Promise.resolve();
    await Promise.resolve();

    // Advance past T_max + some buffer.
    jest.advanceTimersByTime(WATCHDOG_MS + 500);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Watchdog should have fired.
    expect(kills).toHaveLength(1);
    expect(kills[0]?.turnId).toBe('hung-turn');
    expect(shrugs).toContain('hung-turn');

    // forceIdle should have been called.
    expect(mockExecutor.forceIdle).toHaveBeenCalled();

    // Queue should drain the remaining turns.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    expect(responses).toContain('follower-1');
    expect(responses).toContain('follower-2');

    // Release the hang (simulates Ollama eventually resolving — but epoch is stale).
    hangCtrl.resolve?.();
    await Promise.resolve();

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// Q1.5 — ZOMBIE GUARD (CRITICAL): late-resolving killed cycle emits NO second response
// ---------------------------------------------------------------------------

describe('Q1.5 — Zombie guard: late-resolving killed cycle emits NO second response', () => {
  const WATCHDOG_MS = 25_000;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('ensures a late-resolving killed cycle does not emit a second response', async () => {
    // This test verifies the epoch fence at spec site :1248.
    // A cycle is killed by the watchdog at T_max. The LLM (mocked as the
    // cycleRunner) resolves at T+28s. The zombie cycle must emit NOTHING.

    const lateCtrl = { resolve: null as null | ((v: boolean) => void) };
    let zombieAttemptedEmit = false;
    let callCount = 0;
    const survivorResponses: string[] = [];

    // We need to test the epoch fence where it matters: the cycleRunner
    // captures `myEpoch` and checks `isEpochCurrent(myEpoch)` before acting.
    // Simulate this by having the zombie runner check the epoch after the
    // watchdog fires.

    const guard = new CycleGuardService(null);
    const kills: WatchdogKillEvent[] = [];
    const shrugs: Array<{ turnId: string }> = [];

    const mockExecutor = {
      getState: () => 'EXECUTING',
      forceIdle: jest.fn(),
    };

    guard.register(
      async (turn, myEpoch) => {
        callCount++;
        if (callCount === 1) {
          // Zombie cycle: hang until test resolves it late.
          const result = await new Promise<boolean>(resolve => { lateCtrl.resolve = resolve; });
          // At this point the watchdog has incremented epoch.
          // Check if we are still the current epoch.
          if (!guard.isEpochCurrent(myEpoch)) {
            // We are a zombie — do NOT emit.
            zombieAttemptedEmit = false; // epoch check passed
            return false;
          }
          zombieAttemptedEmit = true; // should not happen
          return result;
        }
        // Successor cycle (run after watchdog recovery).
        survivorResponses.push(turn.turnId);
        return true;
      },
      (turnId, _msg, _epoch) => { shrugs.push({ turnId }); },
      mockExecutor as any,
    );

    guard.cycleWatchdogKill$.subscribe(e => kills.push(e));

    const zombie = makeTurn({ turnId: 'zombie-turn' });
    const survivor = makeTurn({ turnId: 'survivor-turn' });

    guard.enqueue(zombie);
    guard.enqueue(survivor);

    // Let zombie cycle start.
    await Promise.resolve();
    await Promise.resolve();

    // Fire watchdog.
    jest.advanceTimersByTime(WATCHDOG_MS + 100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(kills).toHaveLength(1);
    expect(kills[0]?.turnId).toBe('zombie-turn');

    // Survivor should drain and complete.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }
    expect(survivorResponses).toContain('survivor-turn');

    // Now resolve the zombie late (~T+28s scenario).
    jest.advanceTimersByTime(3_000);
    lateCtrl.resolve?.(true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The zombie must NOT have emitted — epoch check should have stopped it.
    expect(zombieAttemptedEmit).toBe(false);

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// Q1.6 — Back-pressure: 13 turns → exactly 1 decline, 12 responses
// ---------------------------------------------------------------------------

describe('Q1.6 — Back-pressure (13 non-guardian turns)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('emits exactly 1 CYCLE_BACKPRESSURE_DECLINE when queue overflows', async () => {
    // Back-pressure policy (spec §2):
    //   - Queue depth = 12 waiting turns (in-flight not counted).
    //   - When a 13th WAITING turn would arrive (first turn already running = 14 total),
    //     evict the oldest non-head non-guardian waiting turn and decline it.
    //   - Guardian turns are NEVER evicted.
    //
    // Test flow:
    //   1. Enqueue turn-first → starts running immediately (in-flight, not in queue).
    //   2. Enqueue 12 more → fills the waiting queue to capacity (12).
    //   3. Enqueue 1 more → triggers overflow: evicts oldest non-head = waiting-1.
    //   4. Total outcomes = 13 responses (first + 11 survivors + overflow) + 1 decline = 14.
    //   5. "No silent drop" invariant: every arrival gets exactly one outcome.
    const firstCtrl = { resolve: null as null | (() => void) };
    let callCount = 0;

    const guard = new CycleGuardService(null);
    const responses: string[] = [];
    const declines: TurnDeclinedEvent[] = [];

    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };

    guard.register(
      async (turn, _epoch) => {
        callCount++;
        if (callCount === 1) {
          // Block first cycle until we finish enqueueing all turns.
          await new Promise<void>(resolve => { firstCtrl.resolve = resolve; });
        }
        responses.push(turn.turnId);
        return true;
      },
      (_turnId, _msg, _epoch) => {},
      mockExecutor as any,
    );
    guard.turnDeclined$.subscribe(e => declines.push(e));

    // Turn 1: starts running immediately (in-flight, not in the waiting queue).
    const firstTurn = makeTurn({ turnId: 'turn-first' });
    guard.enqueue(firstTurn);

    // Flush to start the blocked cycle so the in-flight slot is held.
    await Promise.resolve();

    // Turns 2-13: fill the waiting queue to capacity (12 waiting).
    for (let i = 0; i < 12; i++) {
      guard.enqueue(makeTurn({ turnId: `waiting-${i}` }));
    }

    // No declines yet — queue has exactly 12 waiting (at capacity).
    expect(declines).toHaveLength(0);

    // Turn 14: overflows → evicts oldest non-head non-guardian = waiting-1.
    guard.enqueue(makeTurn({ turnId: 'overflow-turn' }));

    // Exactly 1 decline should fire.
    expect(declines).toHaveLength(1);
    expect(declines[0]?.reason).toBe('BACKPRESSURE');
    expect(declines[0]?.message).toContain("overwhelmed");

    // Unblock the first cycle and let the queue drain.
    firstCtrl.resolve?.();
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // 14 arrivals → 1 decline + 13 responses (no silent drops).
    // Every arrival gets exactly one outcome (CANON Theater Prohibition).
    expect(declines).toHaveLength(1);
    expect(responses.length + declines.length).toBe(14);

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// Q1.7 — Guardian priority
// ---------------------------------------------------------------------------

describe('Q1.7 — Guardian priority', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('serves the guardian turn before normal turns when in-flight cycle completes', async () => {
    const firstCtrl = { resolve: null as null | (() => void) };
    let callCount = 0;
    const order: string[] = [];

    const guard = new CycleGuardService(null);
    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };

    guard.register(
      async (turn, _epoch) => {
        callCount++;
        if (callCount === 1) {
          // Block first turn.
          await new Promise<void>(resolve => { firstCtrl.resolve = resolve; });
        }
        order.push(turn.turnId);
        return true;
      },
      (_t, _m, _e) => {},
      mockExecutor as any,
    );

    // Enqueue first normal turn (starts the blocked cycle).
    const first = makeTurn({ turnId: 'normal-first', isGuardian: false });
    guard.enqueue(first);
    await Promise.resolve();

    // While first is in flight, enqueue 3 non-guardian + 1 guardian.
    guard.enqueue(makeTurn({ turnId: 'normal-a', isGuardian: false }));
    guard.enqueue(makeTurn({ turnId: 'normal-b', isGuardian: false }));
    guard.enqueue(makeTurn({ turnId: 'normal-c', isGuardian: false }));
    guard.enqueue(makeTurn({ turnId: 'guardian-X', isGuardian: true }));

    // Unblock first cycle.
    firstCtrl.resolve?.();

    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // Guardian should be served BEFORE normal-a/b/c.
    const guardianPos = order.indexOf('guardian-X');
    const normalAPos = order.indexOf('normal-a');

    expect(guardianPos).toBeGreaterThan(-1); // guardian was served
    // Guardian should come before or at most one position after first:
    // first (index 0), then guardian (index 1) since guardian lane drains first.
    expect(guardianPos).toBeLessThan(normalAPos);

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// Q1.9 — Circuit breaker: 3 kills → ENTER; 2 probes → EXIT
// ---------------------------------------------------------------------------

describe('Q1.9 — Circuit breaker trip and exit', () => {
  const WATCHDOG_MS = 25_000;
  const PROBE_INTERVAL_MS = 30_000;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('trips after 3 consecutive kills and exits after 2 successful probes', async () => {
    let callCount = 0;
    const breaker: BreakerStateEvent[] = [];
    const shrugs: string[] = [];

    const guard = new CycleGuardService(null);

    const mockExecutor = {
      getState: () => 'EXECUTING',
      forceIdle: jest.fn(),
    };

    // First 3 calls hang forever (to trip watchdog 3 times).
    // Probe calls (4th and 5th) succeed.
    guard.register(
      async (_turn, _epoch) => {
        callCount++;
        if (callCount <= 3) {
          return new Promise<boolean>(() => {}); // hang → watchdog kills
        }
        // Probe successes.
        return true;
      },
      (turnId, _msg, _epoch) => { shrugs.push(turnId); },
      mockExecutor as any,
    );

    guard.circuitBreakerState$.subscribe(e => breaker.push(e));

    // Enqueue 3 turns to trigger 3 watchdog kills.
    const t1 = makeTurn({ turnId: 'kill-1' });
    const t2 = makeTurn({ turnId: 'kill-2' });
    const t3 = makeTurn({ turnId: 'kill-3' });
    guard.enqueue(t1);

    // Fire first watchdog.
    await Promise.resolve();
    jest.advanceTimersByTime(WATCHDOG_MS + 100);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Enqueue next after first kill.
    guard.enqueue(t2);
    await Promise.resolve();
    jest.advanceTimersByTime(WATCHDOG_MS + 100);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Enqueue third after second kill.
    guard.enqueue(t3);
    await Promise.resolve();
    jest.advanceTimersByTime(WATCHDOG_MS + 100);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // After 3 kills, circuit breaker should have entered.
    const enters = breaker.filter(e => e.type === 'ENTER');
    expect(enters).toHaveLength(1);
    expect(guard.isDegradedMode).toBe(true);

    // Advance probe interval twice to trigger 2 successful probes.
    jest.advanceTimersByTime(PROBE_INTERVAL_MS + 100);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // First probe success.
    jest.advanceTimersByTime(PROBE_INTERVAL_MS + 100);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await Promise.resolve(); await Promise.resolve();

    // After 2 successful probes, circuit breaker should have exited.
    const exits = breaker.filter(e => e.type === 'EXIT');
    expect(exits).toHaveLength(1);
    expect(guard.isDegradedMode).toBe(false);

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// Q1.8 — Lesion parity (fast cycles never trip watchdog)
// ---------------------------------------------------------------------------

describe('Q1.8 — Lesion parity: fast cycles do not trip watchdog', () => {
  const WATCHDOG_MS = 25_000;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('completes 5 fast cycles with zero watchdog kills', async () => {
    const { guard, responses, kills } = buildGuard({ cycleDelayMs: 0 });

    const turns = Array.from({ length: 5 }, () => makeTurn());
    for (const t of turns) guard.enqueue(t);

    // Drain quickly without advancing past watchdog.
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(1); // well below 25s
    }

    expect(kills).toHaveLength(0);
    expect(responses).toHaveLength(5);

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// Invariant tests
// ---------------------------------------------------------------------------

describe('Invariants', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('I4: queue depth never exceeds 12 waiting turns', async () => {
    const ctrl = { resolve: null as null | (() => void) };

    const guard = new CycleGuardService(null);
    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };

    guard.register(
      async (_turn, _epoch) => {
        await new Promise<void>(resolve => { ctrl.resolve = resolve; });
        return true;
      },
      () => {},
      mockExecutor as any,
    );

    // Enqueue 20 turns.
    for (let i = 0; i < 20; i++) {
      guard.enqueue(makeTurn());
    }

    // Queue depth (waiting only, not the in-flight) must be ≤ 12.
    // The first was dequeued when enqueued (it immediately started), so
    // at most 12 are waiting.
    const stats = guard.getQueueStats();
    expect(stats.total).toBeLessThanOrEqual(12);

    ctrl.resolve?.();
    guard.destroy();
  });

  it('isEpochCurrent returns false for a stale epoch', () => {
    const { guard } = buildGuard({});
    // Increment the epoch manually.
    const oldEpoch = guard.cycleEpoch;
    (guard as any).cycleEpoch++;

    expect(guard.isEpochCurrent(oldEpoch)).toBe(false);
    expect(guard.isEpochCurrent(guard.cycleEpoch)).toBe(true);
    guard.destroy();
  });

  it('guardian turns are never evicted (overflow evicts normal turns instead)', async () => {
    const ctrl = { resolve: null as null | (() => void) };

    const guard = new CycleGuardService(null);
    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };
    const declines: TurnDeclinedEvent[] = [];

    guard.register(
      async (_turn, _epoch) => {
        await new Promise<void>(resolve => { ctrl.resolve = resolve; });
        return true;
      },
      () => {},
      mockExecutor as any,
    );
    guard.turnDeclined$.subscribe(e => declines.push(e));

    // Fill the queue: first turn is in-flight, 12 more in the queue.
    guard.enqueue(makeTurn({ turnId: 'first', isGuardian: false }));
    await Promise.resolve();

    // Fill queue with 11 normal + 1 guardian.
    for (let i = 0; i < 11; i++) {
      guard.enqueue(makeTurn({ isGuardian: false }));
    }
    const guardianTurn = makeTurn({ turnId: 'guardian-safe', isGuardian: true });
    guard.enqueue(guardianTurn);

    // Queue is full (12 waiting). Add one more normal — should trigger eviction.
    guard.enqueue(makeTurn({ turnId: 'overflow-normal', isGuardian: false }));

    // The guardian turn must NOT be in the declines.
    const declinedIds = declines.map(d => d.turnId);
    expect(declinedIds).not.toContain('guardian-safe');

    // A non-guardian was declined.
    expect(declines.length).toBeGreaterThan(0);

    ctrl.resolve?.();
    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// Pre-fix: drainNext vs selfTickInFlight race
//
// Invariant: exactly one cycle at a time regardless of trigger source (I1/N4).
// A queue turn arriving mid-self-tick must NOT start a concurrent cycle.
// After the self-tick completes (notifyExternalComplete()), the queued turn
// must drain and receive a response (not be stranded forever).
// ---------------------------------------------------------------------------

describe('Pre-fix — drainNext vs selfTickInFlight race', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('queued turn does not start while self-tick is in flight', async () => {
    // Simulate: self-tick holds the mutex (isExternallyBusy returns true),
    // a queue turn arrives, drainNext defers; no concurrent cycle fires.

    let selfTickInFlight = true; // external self-tick is running
    let maxConcurrent = 0;
    let concurrent = 0;
    const responses: string[] = [];

    const guard = new CycleGuardService(null);
    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };

    guard.register(
      async (turn, _epoch) => {
        concurrent++;
        if (concurrent > maxConcurrent) maxConcurrent = concurrent;
        await Promise.resolve();
        responses.push(turn.turnId);
        concurrent--;
        return true;
      },
      () => {},
      mockExecutor as any,
      // isExternallyBusy — simulates selfTickInFlight flag
      () => selfTickInFlight,
    );

    // Enqueue a turn while self-tick is in flight.
    const turn = makeTurn({ turnId: 'queued-while-self-tick' });
    guard.enqueue(turn);

    // Flush microtasks — drainNext should defer because isExternallyBusy.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // No cycle should have started yet (self-tick is still in flight).
    expect(responses).toHaveLength(0);
    expect(maxConcurrent).toBe(0);

    // Self-tick finishes — clears the flag and calls notifyExternalComplete().
    selfTickInFlight = false;
    guard.notifyExternalComplete();

    // Now the queued turn should drain.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    expect(responses).toHaveLength(1);
    expect(responses[0]).toBe('queued-while-self-tick');
    // Never two concurrent cycles.
    expect(maxConcurrent).toBe(1);

    guard.destroy();
  });

  it('queued turns are NOT stranded when self-tick completes (re-drain fires)', async () => {
    // This test verifies the re-drain: if notifyExternalComplete() is NOT called,
    // the turn would be stranded. WITH the call, it resumes.
    // Indirectly tests that the seam in DecisionMakingService.onTick finally
    // calling notifyExternalComplete() is wired correctly.

    let selfTickInFlight = true;
    const responses: string[] = [];

    const guard = new CycleGuardService(null);
    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };

    guard.register(
      async (turn, _epoch) => {
        responses.push(turn.turnId);
        return true;
      },
      () => {},
      mockExecutor as any,
      () => selfTickInFlight,
    );

    // Enqueue 3 turns while self-tick is in flight.
    guard.enqueue(makeTurn({ turnId: 't1' }));
    guard.enqueue(makeTurn({ turnId: 't2' }));
    guard.enqueue(makeTurn({ turnId: 't3' }));

    // Flush — all deferred.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }
    expect(responses).toHaveLength(0); // stranded

    // Self-tick ends; notify.
    selfTickInFlight = false;
    guard.notifyExternalComplete();

    // All 3 should drain now.
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    expect(responses).toHaveLength(3);
    expect(responses).toContain('t1');
    expect(responses).toContain('t2');
    expect(responses).toContain('t3');

    guard.destroy();
  });

  it('queue turn starts immediately when no self-tick is in flight', async () => {
    // Baseline: when isExternallyBusy returns false, normal drain behavior.
    const responses: string[] = [];

    const guard = new CycleGuardService(null);
    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };

    guard.register(
      async (turn, _epoch) => {
        responses.push(turn.turnId);
        return true;
      },
      () => {},
      mockExecutor as any,
      () => false, // no self-tick
    );

    const turn = makeTurn({ turnId: 'immediate-drain' });
    guard.enqueue(turn);

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    expect(responses).toHaveLength(1);
    expect(responses[0]).toBe('immediate-drain');

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// TK-77 — EP14.10: Decision-cycle concurrency guard (overlap test)
//
// Acceptance criterion 1: given two cycle triggers arriving for the same
// backend within one in-flight cycle, the second is queued or dropped — never
// run concurrently.
//
// Acceptance criterion 2: CycleGuard is confirmed live.
//   Guard location: cycle-guard.service.ts
//   Mutex set:      :530  this.tickInFlight = true   (runCycle, "Acquire mutex")
//   Mutex checked:  :475  if (this.tickInFlight) return  (drainNext)
//   Mutex released: :550  this.tickInFlight = false  (runCycle finally block)
//   Epoch fence:    :535  const myEpoch = ++this.cycleEpoch
//   Epoch checked:  :555  if (myEpoch === this.cycleEpoch)
// ---------------------------------------------------------------------------

describe('TK-77 — Overlap guard: two triggers during one in-flight cycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('AC1: second trigger is queued while first cycle is in-flight; neither runs concurrently', async () => {
    // Scenario: first cycle starts and holds the mutex (slow async work). A
    // second trigger arrives immediately. The guard must never run both at once;
    // it queues the second and runs it only after the first finishes.

    let concurrent = 0;
    let maxConcurrent = 0;
    const startOrder: string[] = [];
    const completionOrder: string[] = [];

    // Latch: lets us confirm the first cycle is truly in-flight before we
    // enqueue the second trigger (avoids a race where trigger-2 arrives before
    // the first cycle even starts).
    let firstCycleStartedResolve: (() => void) | null = null;
    const firstCycleStarted = new Promise<void>(r => { firstCycleStartedResolve = r; });
    let firstCycleReleaseResolve: (() => void) | null = null;
    const firstCycleRelease = new Promise<void>(r => { firstCycleReleaseResolve = r; });

    const guard = new CycleGuardService(null);
    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };

    guard.register(
      async (turn, _epoch) => {
        // Track concurrency — the maximum must never exceed 1.
        concurrent++;
        if (concurrent > maxConcurrent) maxConcurrent = concurrent;
        startOrder.push(turn.turnId);

        if (turn.turnId === 'trigger-1') {
          // Signal that the first cycle is now in-flight, then hold the mutex.
          firstCycleStartedResolve?.();
          await firstCycleRelease;
        }
        // Small yield for subsequent turns (ensures async ordering is real).
        await Promise.resolve();

        completionOrder.push(turn.turnId);
        concurrent--;
        return true;
      },
      () => {},
      mockExecutor as any,
    );

    // Enqueue first trigger — starts running immediately.
    const trigger1 = makeTurn({ turnId: 'trigger-1' });
    guard.enqueue(trigger1);

    // Wait until cycle 1 is confirmed in-flight (holds the mutex).
    await firstCycleStarted;

    // Confirm the mutex IS held before enqueuing the second trigger.
    expect(guard.getQueueStats().tickInFlight).toBe(true);

    // Enqueue the second trigger while the first is in-flight.
    // The guard must queue this — not start a concurrent second cycle.
    const trigger2 = makeTurn({ turnId: 'trigger-2' });
    guard.enqueue(trigger2);

    // Flush microtasks — drain must still be deferred (tickInFlight = true).
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // trigger-2 must not have started yet.
    expect(startOrder).toEqual(['trigger-1']);
    expect(maxConcurrent).toBe(1); // only 1 cycle ever in-flight so far

    // Release the first cycle.
    firstCycleReleaseResolve?.();

    // Drain remaining.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // Both triggers must complete; second is served after first, never concurrently.
    expect(completionOrder).toEqual(['trigger-1', 'trigger-2']);
    expect(maxConcurrent).toBe(1); // never exceeded 1 throughout

    guard.destroy();
  });

  it('AC1 (overflow path): when queue is at capacity, an older waiting turn is evicted (honest decline) — new trigger is queued, never run concurrently', async () => {
    // Variant: the waiting queue is already full when the second trigger arrives.
    // Per the back-pressure policy the oldest non-head non-guardian waiting turn is
    // evicted (honest BACKPRESSURE decline) and the new trigger is admitted.
    // In either case — admitted or evicted — no concurrent cycle must ever fire.
    let firstReleaseResolve: (() => void) | null = null;
    const firstRelease = new Promise<void>(r => { firstReleaseResolve = r; });
    let concurrent = 0;
    let maxConcurrent = 0;

    const guard = new CycleGuardService(null);
    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };
    const declines: string[] = [];

    guard.register(
      async (turn, _epoch) => {
        concurrent++;
        if (concurrent > maxConcurrent) maxConcurrent = concurrent;

        if (turn.turnId === 'inflight') {
          // Hold the mutex until we are told to proceed.
          await firstRelease;
        }
        await Promise.resolve();
        concurrent--;
        return true;
      },
      () => {},
      mockExecutor as any,
    );

    guard.turnDeclined$.subscribe(e => declines.push(e.turnId));

    // Enqueue first turn — starts running immediately, holds the mutex.
    guard.enqueue(makeTurn({ turnId: 'inflight' }));
    await Promise.resolve();

    // Fill the waiting queue to capacity (12 slots).
    for (let i = 0; i < 12; i++) {
      guard.enqueue(makeTurn({ turnId: `filler-${i}` }));
    }

    // This 13th waiting turn overflows — per policy, the oldest non-head
    // non-guardian waiting turn is evicted (filler-1, since filler-0 is
    // head-of-line), and 'overflow' is admitted in its place.
    guard.enqueue(makeTurn({ turnId: 'overflow' }));

    // Exactly one decline must have fired (the evicted filler).
    expect(declines).toHaveLength(1);
    // Still only 1 cycle in-flight — no concurrent cycle was started.
    expect(maxConcurrent).toBe(1);
    // The queue is still at the depth cap (12), not 13.
    expect(guard.getQueueStats().total).toBe(12);

    // Release and drain.
    firstReleaseResolve?.();
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // Concurrent cycles never occurred throughout.
    expect(maxConcurrent).toBe(1);

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// TK-123 — Epoch-guarded mutex release: a stale watchdog-killed cycle's
// finally must not release/disarm a SUCCESSOR cycle's mutex/watchdog.
//
// Bug (pre-fix): runCycle's finally called disarmWatchdog()/cleared
// tickInFlight/inFlightTurn UNCONDITIONALLY, even when myEpoch was stale
// (watchdog already fired and a successor had started under a new epoch).
// A late-resolving zombie promise would tear down the successor's live
// watchdog and falsely mark the mutex free while the successor cycle was
// still running.
// ---------------------------------------------------------------------------

describe('TK-123 — Epoch-guarded mutex release', () => {
  const WATCHDOG_MS = 25_000;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('AC1+AC2: a zombie cycle whose finally runs after a successor has started under a new epoch does not disarm the watchdog or clear tickInFlight/inFlightTurn for the successor; exactly one honest outcome per turn, never concurrent', async () => {
    const zombieCtrl = { resolve: null as null | ((v: boolean) => void) };
    const successorCtrl = { resolve: null as null | ((v: boolean) => void) };
    let callCount = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const responses: string[] = [];
    const kills: WatchdogKillEvent[] = [];

    const guard = new CycleGuardService(null);
    const mockExecutor = { getState: () => 'EXECUTING', forceIdle: jest.fn() };

    guard.register(
      async (turn, _epoch) => {
        callCount++;
        concurrent++;
        if (concurrent > maxConcurrent) maxConcurrent = concurrent;
        try {
          if (callCount === 1) {
            // Zombie: hangs until resolved explicitly, well after its watchdog fires.
            const result = await new Promise<boolean>(resolve => { zombieCtrl.resolve = resolve; });
            return result;
          }
          // Successor: also controllable so we can inspect state while it is
          // still in-flight (before it completes).
          const result = await new Promise<boolean>(resolve => { successorCtrl.resolve = resolve; });
          if (result) responses.push(turn.turnId);
          return result;
        } finally {
          concurrent--;
        }
      },
      (_turnId, _msg, _epoch) => {},
      mockExecutor as any,
    );
    guard.cycleWatchdogKill$.subscribe(e => kills.push(e));

    const zombie = makeTurn({ turnId: 'zombie-turn' });
    const successor = makeTurn({ turnId: 'successor-turn' });

    guard.enqueue(zombie);
    await Promise.resolve();
    await Promise.resolve();

    // Successor queued while zombie is in-flight.
    guard.enqueue(successor);

    // Fire the zombie's watchdog: forceIdle, tickInFlight=false, epoch++, SHRUG, drain.
    jest.advanceTimersByTime(WATCHDOG_MS + 100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(kills).toHaveLength(1);
    expect(kills[0]?.turnId).toBe('zombie-turn');

    // Let the successor's runCycle actually start (drained after the watchdog kill).
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // The successor must now own the mutex under the NEW epoch.
    const statsBeforeZombieResolves = guard.getQueueStats();
    expect(statsBeforeZombieResolves.tickInFlight).toBe(true);
    expect(statsBeforeZombieResolves.cycleEpoch).toBe(2);
    expect((guard as any).inFlightTurn?.turnId).toBe('successor-turn');
    const watchdogHandleBefore = (guard as any).watchdogHandle;
    expect(watchdogHandleBefore).not.toBeNull();

    // Never more than one cycle running concurrently.
    expect(maxConcurrent).toBe(1);

    // Now resolve the ZOMBIE late — its finally runs while the successor is
    // still in-flight under the new epoch (AC1 + AC2 scenario).
    zombieCtrl.resolve?.(true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The successor's mutex/watchdog/inFlightTurn must be UNCHANGED by the
    // zombie's stale finally — this is the epoch-guard fix under test.
    const statsAfterZombieResolves = guard.getQueueStats();
    expect(statsAfterZombieResolves.tickInFlight).toBe(true);
    expect(statsAfterZombieResolves.cycleEpoch).toBe(2);
    expect((guard as any).inFlightTurn?.turnId).toBe('successor-turn');
    expect((guard as any).watchdogHandle).toBe(watchdogHandleBefore);

    // The zombie must not have produced a response (only reachable if its own
    // finally had wrongly torn down/re-armed shared state and let it re-emit).
    expect(responses).not.toContain('zombie-turn');
    expect(maxConcurrent).toBe(1);

    // Now let the successor complete normally — it gets exactly one honest outcome.
    successorCtrl.resolve?.(true);
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    expect(responses).toEqual(['successor-turn']);
    expect(maxConcurrent).toBe(1);

    guard.destroy();
  });

  it('AC3 (regression): an ordinary cycle with no watchdog fire/epoch bump still disarms the watchdog, releases the mutex, and drains the next queued turn to completion', async () => {
    const { guard, responses, kills } = buildGuard({ cycleDelayMs: 0 });

    const first = makeTurn({ turnId: 'ordinary-first' });
    const second = makeTurn({ turnId: 'ordinary-second' });

    guard.enqueue(first);
    guard.enqueue(second);

    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // No watchdog fired — this is the plain happy path.
    expect(kills).toHaveLength(0);

    // Both turns completed — the second was not left queued forever, proving
    // the epoch-gated release does not brick ordinary (non-zombie) turns.
    expect(responses.map(r => r.turnId)).toEqual(['ordinary-first', 'ordinary-second']);

    // Watchdog disarmed and mutex freed after the last cycle.
    const stats = guard.getQueueStats();
    expect(stats.tickInFlight).toBe(false);
    expect((guard as any).watchdogHandle).toBeNull();

    guard.destroy();
  });
});

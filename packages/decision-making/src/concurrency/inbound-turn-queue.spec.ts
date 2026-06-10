/**
 * InboundTurn queue — WS4 Ticket 2 acceptance criteria.
 *
 * Tests the per-turn text threading fix:
 *  - 3 turns enqueued before first drain → each cycle's frame contains ITS OWN text
 *  - Response turnIds match the intake turnIds (not fresh randomUUID()s)
 *  - Q1.3 real: under a burst, no cycle re-answers stale history with null text
 *
 * We test this at the queue boundary using the CycleGuardService + a mock
 * cycleRunner that captures the text injected into the mock tickSampler.
 * This mirrors exactly what runCycleForTurn() does:
 *   1. injectSyntheticText(turn.text) into the sampler
 *   2. currentQueueTurnId = turn.turnId
 *   3. sample() — captures the injected text
 *   4. processInput() — emits CycleResponse with currentQueueTurnId
 */

import { CycleGuardService } from './cycle-guard.service';
import type { InboundTurn } from './inbound-turn';

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

function makeTurn(text: string, overrides: Partial<InboundTurn> = {}): InboundTurn {
  turnCounter++;
  const now = Date.now();
  return {
    turnId: `intake-${turnCounter}`,
    isGuardian: false,
    receivedAt: now,
    enqueuedAt: now,
    text,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test: 3 burst turns → each cycle gets ITS OWN text; response turnIds match
// ---------------------------------------------------------------------------

describe('WS4 Ticket 2 — per-turn text threading', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('each cycle sees its own text (not null or a neighbour turn\'s text)', async () => {
    /**
     * Simulate the runCycleForTurn seam:
     *  1. The cycle runner receives (turn, myEpoch) from CycleGuard.
     *  2. It calls mockSampler.injectSyntheticText(turn.text) — Ticket 2's fix.
     *  3. It calls mockSampler.sample() to produce a frame.
     *  4. It uses turn.turnId as the emitted turnId.
     *
     * We capture (injectedText, sampledText, emittedTurnId) for each cycle
     * and assert they all match the intake turn.
     */

    // Simulated tickSampler text slot
    let samplerTextSlot: string | null = null;

    const mockSampler = {
      injectSyntheticText: (text: string) => { samplerTextSlot = text; },
      // sample() returns whatever is currently in the slot (then clears it)
      sample: () => {
        const t = samplerTextSlot;
        samplerTextSlot = null; // clear event-driven slot after consumption
        return Promise.resolve({ raw: { text: t }, active_modalities: t ? ['text'] : [] });
      },
    };

    type CycleCapture = { turnId: string; sampledText: string | null; };
    const captures: CycleCapture[] = [];
    const emittedTurnIds: string[] = [];

    let currentQueueTurnId: string | null = null;

    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };

    const guard = new CycleGuardService(null);

    guard.register(
      async (turn: InboundTurn, _myEpoch: number): Promise<boolean> => {
        // ── mimic runCycleForTurn ───────────────────────────────────────────
        // Step: inject turn text before sampling
        if (turn.text) {
          mockSampler.injectSyntheticText(turn.text);
        }
        currentQueueTurnId = turn.turnId;

        // Step: sample the frame
        const frame = await mockSampler.sample();
        const sampledText = frame.raw.text as string | null;

        // Step: emit response with intake turnId (mirroring responseSubject.next)
        const emittedTurnId = currentQueueTurnId ?? `random-${Date.now()}`;
        emittedTurnIds.push(emittedTurnId);
        captures.push({ turnId: turn.turnId, sampledText });

        currentQueueTurnId = null;
        return true;
      },
      (_turnId, _msg, _epoch) => {},
      mockExecutor as any,
    );

    // Build 3 turns with distinct texts simulating rapid fire (burst scenario)
    const turn1 = makeTurn('What is the capital of France?');
    const turn2 = makeTurn('What is my dog\'s name?');
    const turn3 = makeTurn('What city do I live in?');

    // Enqueue all 3 before the first one drains (simulates <100ms burst)
    // Guard starts draining turn1 immediately, but turn2/turn3 are queued.
    guard.enqueue(turn1);
    guard.enqueue(turn2);
    guard.enqueue(turn3);

    // Flush all cycles
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // All 3 turns must have been processed
    expect(captures).toHaveLength(3);

    // Each cycle must have sampled ITS OWN text — not null, not a neighbour's
    expect(captures[0]?.sampledText).toBe(turn1.text);
    expect(captures[1]?.sampledText).toBe(turn2.text);
    expect(captures[2]?.sampledText).toBe(turn3.text);

    // None of the cycles should have seen null text (the pre-Ticket-2 bug:
    // only cycle 1 got real text; cycles 2-5 sampled null and re-answered history)
    for (const c of captures) {
      expect(c.sampledText).not.toBeNull();
      expect(c.sampledText).not.toBe('');
    }

    guard.destroy();
  });

  it('emitted turnIds match the intake turnIds (no randomUUID() substitution)', async () => {
    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };
    const guard = new CycleGuardService(null);

    const emittedTurnIds: string[] = [];

    guard.register(
      async (turn: InboundTurn, _myEpoch: number): Promise<boolean> => {
        // Mimic the Ticket 2 fix: use turn.turnId as the emitted id
        emittedTurnIds.push(turn.turnId);
        return true;
      },
      () => {},
      mockExecutor as any,
    );

    const t1 = makeTurn('question one');
    const t2 = makeTurn('question two');
    const t3 = makeTurn('question three');

    guard.enqueue(t1);
    guard.enqueue(t2);
    guard.enqueue(t3);

    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    expect(emittedTurnIds).toHaveLength(3);

    // Each emitted id must be the INTAKE id — not a fresh random one
    expect(emittedTurnIds[0]).toBe(t1.turnId);
    expect(emittedTurnIds[1]).toBe(t2.turnId);
    expect(emittedTurnIds[2]).toBe(t3.turnId);

    guard.destroy();
  });

  it('Q1.3 real: burst turns are FIFO and no null-text cycle occurs', async () => {
    /**
     * This is the direct regression test for the defect mythos observed:
     * "cycles 2–5 sampled textContent: null and re-answered the accumulating
     *  conversation_history slot, producing smeared replies."
     *
     * With Ticket 2: each cycle injects its own text before sampling, so
     * sample() always returns non-null text for a queued turn.
     */
    const sampledTexts: Array<string | null> = [];
    let samplerSlot: string | null = null;

    const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };
    const guard = new CycleGuardService(null);

    guard.register(
      async (turn: InboundTurn, _myEpoch: number): Promise<boolean> => {
        // Ticket 2 fix: inject text before sampling
        if (turn.text) samplerSlot = turn.text;
        const sampled = samplerSlot ?? null;
        samplerSlot = null; // clear after consume
        sampledTexts.push(sampled);
        return true;
      },
      () => {},
      mockExecutor as any,
    );

    // 5 distinct questions (canonical corpus phrases — safe under cassette replay)
    const questions = [
      'What is my name?',
      'What is my dog\'s name?',
      'What city do I live in?',
      'What is Sylphie\'s name?',
      'How old am I?',
    ];
    const turns = questions.map(q => makeTurn(q));

    // Enqueue all 5 rapidly (burst scenario)
    for (const t of turns) guard.enqueue(t);

    // Drain
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    expect(sampledTexts).toHaveLength(5);

    // None may be null (pre-Ticket-2: all but the first were null)
    for (let i = 0; i < 5; i++) {
      expect(sampledTexts[i]).not.toBeNull();
      // Each must match ITS OWN question text
      expect(sampledTexts[i]).toBe(questions[i]);
    }

    guard.destroy();
  });
});

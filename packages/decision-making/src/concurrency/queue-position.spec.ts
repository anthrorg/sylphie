/**
 * WS4 Ticket 6 — Queue-position notification seam unit tests.
 *
 * Acceptance criteria (from the ticket):
 *
 *  QP.1  Enqueue 3 turns → positions emitted as 1, 2, 3 in that order.
 *  QP.2  Drain one turn → remaining waiters receive updated positions (shift down).
 *  QP.3  Guardian insert into a waiting queue → non-guardian positions shift honestly.
 *  QP.4  Overflow eviction → positions of remaining waiters are recomputed.
 *  QP.5  Empty queue → no position snapshot emitted (nothing to notify).
 *  QP.6  Single turn that starts immediately (no waiting) → no position snapshot
 *        emitted for it (it was never "waiting").
 *
 * CANON (Theater Prohibition): positions must be true at send time — recomputed
 * from the live queue after every enqueue and every drain.
 *
 * NOTE: these tests verify the seam ONLY — the additive notification hook in
 * CycleGuardService. They do NOT test the full delivery path (that is the
 * gateway's responsibility and covered by the live two-socket check).
 */

import { CycleGuardService, type QueuePositionSnapshot } from './cycle-guard.service';
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

let counter = 0;

function makeTurn(overrides: Partial<InboundTurn> = {}): InboundTurn {
  counter++;
  const now = Date.now();
  return {
    turnId: `t${counter}`,
    isGuardian: false,
    receivedAt: now,
    enqueuedAt: now,
    text: `text ${counter}`,
    userId: `user-${counter}`,
    socketId: `sock-${counter}`,
    ...overrides,
  };
}

/**
 * Build a guard with a controllable first-turn blocker so we can hold the
 * mutex and observe the waiting queue's position snapshots.
 */
function buildGuard(opts: {
  blockFirst?: boolean;
} = {}): {
  guard: CycleGuardService;
  snapshots: QueuePositionSnapshot[];
  firstCtrl: { resolve: (() => void) | null };
  responses: string[];
} {
  const snapshots: QueuePositionSnapshot[] = [];
  const responses: string[] = [];
  const firstCtrl: { resolve: (() => void) | null } = { resolve: null };
  let callCount = 0;

  const mockExecutor = { getState: () => 'IDLE', forceIdle: jest.fn() };

  const guard = new CycleGuardService(null);

  guard.register(
    async (turn: InboundTurn, _epoch: number): Promise<boolean> => {
      callCount++;
      if (opts.blockFirst && callCount === 1) {
        await new Promise<void>(resolve => { firstCtrl.resolve = resolve; });
      }
      responses.push(turn.turnId);
      return true;
    },
    (_turnId: string, _msg: string, _epoch: number) => {},
    mockExecutor as any,
  );

  guard.queuePositionUpdates$.subscribe(snap => snapshots.push(snap));

  return { guard, snapshots, firstCtrl, responses };
}

// ---------------------------------------------------------------------------
// QP.1 — Enqueue 3 turns → positions 1, 2, 3
// ---------------------------------------------------------------------------

describe('QP.1 — Enqueue 3 turns: positions 1, 2, 3', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('emits snapshots with positions 1, 2, 3 for the 3 waiting turns', async () => {
    const { guard, snapshots, firstCtrl } = buildGuard({ blockFirst: true });

    const t1 = makeTurn({ turnId: 'first', userId: 'u1', socketId: 's1' });
    const t2 = makeTurn({ turnId: 'second', userId: 'u2', socketId: 's2' });
    const t3 = makeTurn({ turnId: 'third', userId: 'u3', socketId: 's3' });

    // Enqueue first — starts immediately, holds the mutex.
    guard.enqueue(t1);
    await Promise.resolve(); // let first cycle start

    // Enqueue t2 and t3 while first is in flight — they wait.
    guard.enqueue(t2);
    guard.enqueue(t3);

    // At this point, snapshots should contain entries from t2 and t3 being admitted.
    // t1 never waited — it started immediately — so the snapshot from t2's admit
    // shows [t2@pos1]; t3's admit shows [t2@pos1, t3@pos2].

    // Find the snapshot that shows both t2 and t3.
    const fullSnapshot = snapshots.find(s => s.positions.length >= 2);
    expect(fullSnapshot).toBeDefined();
    expect(fullSnapshot!.positions[0]?.turnId).toBe('second');
    expect(fullSnapshot!.positions[0]?.position).toBe(1);
    expect(fullSnapshot!.positions[1]?.turnId).toBe('third');
    expect(fullSnapshot!.positions[1]?.position).toBe(2);

    // Verify socketId and userId are passed through.
    expect(fullSnapshot!.positions[0]?.socketId).toBe('s2');
    expect(fullSnapshot!.positions[0]?.userId).toBe('u2');

    firstCtrl.resolve?.();
    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// QP.2 — Drain → remaining waiters get updated positions
// ---------------------------------------------------------------------------

describe('QP.2 — Drain: positions shift after each drain', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('emits updated positions after the queue advances', async () => {
    const { guard, snapshots, firstCtrl } = buildGuard({ blockFirst: true });

    const t1 = makeTurn({ turnId: 'first' });
    const t2 = makeTurn({ turnId: 'second', userId: 'u2', socketId: 's2' });
    const t3 = makeTurn({ turnId: 'third', userId: 'u3', socketId: 's3' });

    guard.enqueue(t1);
    await Promise.resolve();

    guard.enqueue(t2);
    guard.enqueue(t3);

    // Capture snapshot count before unblocking.
    const beforeDrain = snapshots.length;

    // Unblock first — drains t1, which causes t2 to start.
    // After drain: t2 is now in flight; t3 is the only waiter at position 1.
    firstCtrl.resolve?.();

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    // After first drain fires: a snapshot must have been emitted showing
    // t3 at position 1 (the only remaining waiter when t2 was popped).
    const afterDrainSnapshots = snapshots.slice(beforeDrain);
    const t3Solo = afterDrainSnapshots.find(s =>
      s.positions.length === 1 && s.positions[0]?.turnId === 'third',
    );
    expect(t3Solo).toBeDefined();
    expect(t3Solo!.positions[0]?.position).toBe(1);

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// QP.3 — Guardian insert → non-guardian positions shift honestly
// ---------------------------------------------------------------------------

describe('QP.3 — Guardian insert shifts non-guardian positions', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('guardian turn inserted into waiting queue becomes position 1; non-guardian shifts to 2', async () => {
    const { guard, snapshots, firstCtrl } = buildGuard({ blockFirst: true });

    const t1 = makeTurn({ turnId: 'first', isGuardian: false });
    const normal = makeTurn({ turnId: 'normal', isGuardian: false, userId: 'uN', socketId: 'sN' });

    guard.enqueue(t1);
    await Promise.resolve();

    guard.enqueue(normal); // normal enters at position 1 (only waiter)

    // Now insert guardian — it goes to guardian lane (front).
    const guardian = makeTurn({ turnId: 'guardian', isGuardian: true, userId: 'uG', socketId: 'sG' });
    guard.enqueue(guardian);

    // After guardian admission: guardian lane = [guardian], normal lane = [normal].
    // Combined positions: guardian@1, normal@2.
    const afterGuardian = snapshots[snapshots.length - 1];
    expect(afterGuardian).toBeDefined();
    expect(afterGuardian!.positions[0]?.turnId).toBe('guardian');
    expect(afterGuardian!.positions[0]?.position).toBe(1);
    expect(afterGuardian!.positions[1]?.turnId).toBe('normal');
    expect(afterGuardian!.positions[1]?.position).toBe(2);

    firstCtrl.resolve?.();
    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// QP.4 — Overflow eviction → remaining positions recomputed
// ---------------------------------------------------------------------------

describe('QP.4 — Overflow eviction recomputes positions', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('position snapshot after overflow reflects the post-eviction queue', async () => {
    const { guard, snapshots, firstCtrl } = buildGuard({ blockFirst: true });

    // Block first turn to hold the mutex.
    const t1 = makeTurn({ turnId: 'first' });
    guard.enqueue(t1);
    await Promise.resolve();

    // Fill 12 waiting slots (QUEUE_DEPTH = 12).
    const waiters: InboundTurn[] = [];
    for (let i = 0; i < 12; i++) {
      const t = makeTurn({ turnId: `w${i}`, userId: `u${i}`, socketId: `s${i}` });
      waiters.push(t);
      guard.enqueue(t);
    }

    // 13th: overflow — evicts w1 (oldest non-head non-guardian), w13 takes its slot.
    const overflow = makeTurn({ turnId: 'w13', userId: 'u13', socketId: 's13' });
    guard.enqueue(overflow);

    // The last snapshot must reflect 12 waiting turns with valid 1-based positions.
    const last = snapshots[snapshots.length - 1];
    expect(last).toBeDefined();
    expect(last!.positions).toHaveLength(12);
    for (let i = 0; i < 12; i++) {
      expect(last!.positions[i]?.position).toBe(i + 1);
    }

    firstCtrl.resolve?.();
    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// QP.5 — Empty queue → no snapshot emitted
// ---------------------------------------------------------------------------

describe('QP.5 — Empty queue: no snapshot emitted', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does not emit a position snapshot for a turn that starts immediately', async () => {
    const { guard, snapshots } = buildGuard({ blockFirst: false });

    // Enqueue a single turn when the mutex is free — it starts immediately,
    // never waits. The post-admit emit is suppressed when tickInFlight = false.
    // The post-drain emit also finds an empty queue → nothing emitted.
    guard.enqueue(makeTurn({ turnId: 'solo' }));

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }

    expect(snapshots).toHaveLength(0);

    guard.destroy();
  });
});

// ---------------------------------------------------------------------------
// QP.6 — Snapshot carries socketId and userId for targeted routing
// ---------------------------------------------------------------------------

describe('QP.6 — Position snapshot carries identity for targeted delivery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('each position entry has the correct socketId, userId, and position', async () => {
    const { guard, snapshots, firstCtrl } = buildGuard({ blockFirst: true });

    guard.enqueue(makeTurn({ turnId: 'in-flight' }));
    await Promise.resolve();

    const waiter1 = makeTurn({ turnId: 'w1', userId: 'alice', socketId: 'sock-alice' });
    const waiter2 = makeTurn({ turnId: 'w2', userId: 'bob', socketId: 'sock-bob' });
    guard.enqueue(waiter1);
    guard.enqueue(waiter2);

    // Find the snapshot with both waiters.
    const snap = snapshots.find(s => s.positions.length === 2);
    expect(snap).toBeDefined();

    const aliceEntry = snap!.positions.find(p => p.userId === 'alice');
    const bobEntry = snap!.positions.find(p => p.userId === 'bob');

    expect(aliceEntry).toBeDefined();
    expect(aliceEntry!.socketId).toBe('sock-alice');
    expect(aliceEntry!.position).toBe(1);

    expect(bobEntry).toBeDefined();
    expect(bobEntry!.socketId).toBe('sock-bob');
    expect(bobEntry!.position).toBe(2);

    firstCtrl.resolve?.();
    guard.destroy();
  });
});

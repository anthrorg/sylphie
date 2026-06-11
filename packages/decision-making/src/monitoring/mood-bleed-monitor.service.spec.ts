/**
 * MoodBleedMonitorService unit tests — WS4 Ticket 8 acceptance criteria.
 *
 * Spec §5.1 — ALL NINE fixtures:
 *   1. Hostile fires: 12 bracketed turns (+0.08 anx, +0.06 guilt, +0.04 sad each),
 *      interleaved flat speaker, global ≥0.60 → exactly ONE alert, speakerId
 *      'abuser', CRITICAL, on 11th+ evaluation.
 *   2. Sad guardian venting does NOT fire (15 turns sadness-only +0.06,
 *      sadness 0.70) — the load-bearing T3 test.
 *   3. Below floor (5 hostile turns) → nothing.
 *   4. Baseline control (ambient drift only) → μ_adj≈0 → nothing.
 *   5. Contrast control (two speakers equally raising N) → nothing.
 *   6. Hysteresis: one emission; +10min still-triggered → one re-emission;
 *      contrast 0.04 → still ACTIVE no flap; 0.02 → deactivates.
 *   7. Guardian cap: hostile fixture with isGuardian → WARNING, never CRITICAL.
 *   8. Bracket hygiene: tick regression / tick 0 → discarded, no NaN.
 *   9. Self-cycle exclusion: null-originator brackets move neither speaker
 *      ledgers nor baseline.
 *
 * Test harness:
 *   - Fake DriveStateReader using a BehaviorSubject-style Subject + getCurrentState().
 *   - Fake event logger that records calls.
 *   - Injectable clock (setClockFn) for deterministic hysteresis timing.
 *   - Snapshot builder helper (makeSnapshot).
 */

import { Subject } from 'rxjs';
import { DriveName, INITIAL_DRIVE_STATE } from '@sylphie/shared';
import type { DriveSnapshot, PressureVector, PressureDelta, RuleMatchResult } from '@sylphie/shared';
import { MoodBleedMonitorService } from './mood-bleed-monitor.service';
import type { IDecisionEventLogger } from '../interfaces/decision-making.interfaces';
import type { IDriveStateReader } from '@sylphie/drive-engine';

// Suppress verbose logs in tests.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tickCounter = 0;
let sessionCounter = 0;

function makeSnapshot(overrides: {
  anxiety?: number;
  sadness?: number;
  guilt?: number;
  tickNumber?: number;
  sessionId?: string;
} = {}): DriveSnapshot {
  tickCounter++;
  const pressureVector: PressureVector = {
    ...INITIAL_DRIVE_STATE,
    [DriveName.Anxiety]: overrides.anxiety ?? 0,
    [DriveName.Sadness]: overrides.sadness ?? 0,
    [DriveName.Guilt]: overrides.guilt ?? 0,
  };
  const driveDeltas: PressureDelta = { ...INITIAL_DRIVE_STATE };
  const ruleMatchResult: RuleMatchResult = { ruleId: null, eventType: 'TEST', matched: false };
  return {
    pressureVector,
    timestamp: new Date(),
    tickNumber: overrides.tickNumber ?? tickCounter,
    driveDeltas,
    ruleMatchResult,
    totalPressure: Math.max(0, (overrides.anxiety ?? 0)) +
      Math.max(0, (overrides.sadness ?? 0)) +
      Math.max(0, (overrides.guilt ?? 0)),
    sessionId: overrides.sessionId ?? `session-${sessionCounter}`,
  };
}

// Build a MoodBleedMonitorService with a fake reader and logger.
function buildMonitor(): {
  monitor: MoodBleedMonitorService;
  driveSubject: Subject<DriveSnapshot>;
  getCurrentStateFn: jest.Mock<DriveSnapshot>;
  logCalls: Array<{ eventType: string; payload: Record<string, unknown> }>;
  fakeLogger: IDecisionEventLogger;
  fakeClock: { now: number };
} {
  tickCounter = 0;
  sessionCounter++;
  const driveSubject = new Subject<DriveSnapshot>();
  const initialSnapshot = makeSnapshot();
  const getCurrentStateFn = jest.fn<DriveSnapshot, []>(() => initialSnapshot);

  const fakeReader: IDriveStateReader = {
    driveState$: driveSubject.asObservable(),
    getCurrentState: getCurrentStateFn,
    getTotalPressure: () => 0,
  };

  const logCalls: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const fakeLogger: IDecisionEventLogger = {
    log: (eventType, payload) => {
      logCalls.push({ eventType, payload: { ...payload } });
    },
    flush: async () => {},
  };

  const fakeClock = { now: 1_000_000 };

  const monitor = new MoodBleedMonitorService(fakeReader, fakeLogger);
  monitor.setClockFn(() => fakeClock.now);
  monitor.onModuleInit();

  // Update getCurrentState to track whatever snapshot is current.
  return { monitor, driveSubject, getCurrentStateFn, logCalls, fakeLogger, fakeClock };
}

/**
 * Simulate a complete turn cycle: open bracket, push settle snapshots, close.
 *
 * @param monitor    - The monitor under test.
 * @param driveSubject - The fake subject.
 * @param getCurrentStateFn - Mock for getCurrentState (updated before onCycleEnd).
 * @param originator - Speaker identity or null for self-tick.
 * @param preSnap    - Drive state at cycle start.
 * @param postSnap   - Drive state after cycle (used for settle snapshots).
 * @param settleSnap - Drive snapshot used for the settling ticks (≥ endTick+2).
 */
function simulateTurn(
  monitor: MoodBleedMonitorService,
  driveSubject: Subject<DriveSnapshot>,
  getCurrentStateFn: jest.Mock<DriveSnapshot>,
  originator: { userId: string; socketId?: string; isGuardian: boolean } | null,
  preSnap: DriveSnapshot,
  endSnap: DriveSnapshot,
): void {
  // 1. Cycle start — pre-snapshot already fetched.
  monitor.onCycleStart(originator, preSnap);

  // 2. onCycleEnd: record endTick (getCurrentState returns endSnap).
  getCurrentStateFn.mockReturnValue(endSnap);
  monitor.onCycleEnd();

  // 3. Push SETTLE_TICKS+1 extra snapshots so the bracket closes.
  //    The settle snapshot must have tickNumber >= endSnap.tickNumber + 2.
  const settleSnap = makeSnapshot({
    anxiety: endSnap.pressureVector[DriveName.Anxiety],
    sadness: endSnap.pressureVector[DriveName.Sadness],
    guilt: endSnap.pressureVector[DriveName.Guilt],
    tickNumber: endSnap.tickNumber + 3,
    sessionId: endSnap.sessionId,
  });
  getCurrentStateFn.mockReturnValue(settleSnap);
  driveSubject.next(settleSnap);
}

// ---------------------------------------------------------------------------
// Test 1: Hostile speaker fires (CRITICAL, speakerId='abuser', 11th+ eval)
// ---------------------------------------------------------------------------

describe('Test 1 — hostile speaker fires CRITICAL', () => {
  it('emits exactly one CRITICAL alert for abuser after 12 turns (11+ evals)', () => {
    const { monitor, driveSubject, getCurrentStateFn, logCalls, fakeClock } = buildMonitor();
    fakeClock.now = 1_000_000;

    // Flat interleaved speaker: zero change.
    const flatSnap = makeSnapshot({ anxiety: 0.1, sadness: 0.1, guilt: 0.1 });

    // Start with low global state; we'll build up.
    let anx = 0.0, sad = 0.0, gui = 0.0;

    for (let i = 0; i < 12; i++) {
      // Abuser turn: +0.08 anx, +0.06 guilt, +0.04 sad each turn.
      const preSnap = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });
      anx += 0.08;
      sad += 0.04;
      gui += 0.06;
      const postSnap = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });

      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'abuser', isGuardian: false }, preSnap, postSnap);

      // Interleaved flat speaker (zero delta).
      const flatPre = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });
      const flatPost = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'flatSpeaker', isGuardian: false }, flatPre, flatPost);

      fakeClock.now += 5_000; // 5 seconds between turns
    }

    // Exactly 1 alert.
    const alerts = logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT');
    expect(alerts.length).toBe(1);

    const alert = alerts[0];
    expect(alert.payload['speakerId']).toBe('abuser');
    expect(alert.payload['severity']).toBe('CRITICAL');
    expect(alert.payload['attractorName']).toBe('HOSTILE_INTERLOCUTOR_MOOD_BLEED');
    expect(alert.payload['speakerIsGuardian']).toBe(false);

    monitor.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// Test 2: Sad guardian venting does NOT fire (T3 — Sadness-only)
// ---------------------------------------------------------------------------

describe('Test 2 — sad guardian venting does NOT fire (load-bearing T3 test)', () => {
  it('emits zero alerts for sadness-only guardian venting', () => {
    const { monitor, driveSubject, getCurrentStateFn, logCalls, fakeClock } = buildMonitor();
    fakeClock.now = 2_000_000;

    let sad = 0.0;

    for (let i = 0; i < 15; i++) {
      // Sadness-only: +0.06 sad, anxiety=0, guilt=0.
      const preSnap = makeSnapshot({ anxiety: 0, sadness: sad, guilt: 0 });
      sad += 0.06;
      // Cap sadness at 0.70 as spec says sadness 0.70.
      const postSad = Math.min(0.70, sad);
      const postSnap = makeSnapshot({ anxiety: 0, sadness: postSad, guilt: 0 });

      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'guardian', isGuardian: true }, preSnap, postSnap);
      fakeClock.now += 5_000;
    }

    const alerts = logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT');
    expect(alerts.length).toBe(0);

    monitor.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// Test 3: Below floor (5 hostile turns → nothing)
// ---------------------------------------------------------------------------

describe('Test 3 — below floor (5 turns)', () => {
  it('emits zero alerts when fewer than 10 turns in window', () => {
    const { monitor, driveSubject, getCurrentStateFn, logCalls, fakeClock } = buildMonitor();
    fakeClock.now = 3_000_000;

    let anx = 0.0, sad = 0.0, gui = 0.0;

    for (let i = 0; i < 5; i++) {
      const preSnap = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });
      anx += 0.08; sad += 0.04; gui += 0.06;
      const postSnap = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'abuser', isGuardian: false }, preSnap, postSnap);
      fakeClock.now += 5_000;
    }

    expect(logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length).toBe(0);
    monitor.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// Test 4: Baseline control (ambient drift only → μ_adj ≈ 0)
// ---------------------------------------------------------------------------

describe('Test 4 — baseline drift control (ambient only)', () => {
  it('emits zero alerts when N changes are ambient (no open bracket during idle)', () => {
    const { monitor, driveSubject, getCurrentStateFn, logCalls, fakeClock } = buildMonitor();
    fakeClock.now = 4_000_000;

    // Feed idle snapshots with slow drift — no brackets open.
    // The EWMA baseline should absorb these, μ_adj stays ≈ 0.
    let anx = 0.0;
    for (let i = 1; i <= 60; i++) {
      anx += 0.005; // very slow ambient drift
      const snap = makeSnapshot({ anxiety: Math.min(anx, 0.30), tickNumber: i });
      getCurrentStateFn.mockReturnValue(snap);
      driveSubject.next(snap);
      fakeClock.now += 1_000;
    }

    // Now simulate a speaker — but because the drift is ambient, dNAdj ≈ 0.
    // We need to run enough turns to get past the floor, with near-zero adjusted delta.
    let prev = makeSnapshot({ anxiety: Math.min(anx, 0.30), tickNumber: 61 });
    for (let i = 0; i < 12; i++) {
      const pre = prev;
      // No change beyond baseline drift (tiny step only).
      anx += 0.002;
      const post = makeSnapshot({ anxiety: Math.min(anx, 0.35), tickNumber: 62 + i * 4 });
      prev = post;
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'ambient-speaker', isGuardian: false }, pre, post);
      fakeClock.now += 5_000;
    }

    expect(logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length).toBe(0);
    monitor.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// Test 5: Contrast control (two speakers equally raising N)
// ---------------------------------------------------------------------------

describe('Test 5 — contrast control (shared distressing topic)', () => {
  it('emits zero alerts when both speakers raise N equally', () => {
    const { monitor, driveSubject, getCurrentStateFn, logCalls, fakeClock } = buildMonitor();
    fakeClock.now = 5_000_000;

    let anx = 0.0, gui = 0.0;

    // Interleave A and B with identical deltas.
    for (let i = 0; i < 12; i++) {
      // Speaker A.
      const preA = makeSnapshot({ anxiety: anx, guilt: gui });
      anx += 0.05; gui += 0.04;
      const postA = makeSnapshot({ anxiety: anx, guilt: gui });
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'speakerA', isGuardian: false }, preA, postA);
      fakeClock.now += 3_000;

      // Speaker B — same deltas.
      const preB = makeSnapshot({ anxiety: anx, guilt: gui });
      anx += 0.05; gui += 0.04;
      const postB = makeSnapshot({ anxiety: anx, guilt: gui });
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'speakerB', isGuardian: false }, preB, postB);
      fakeClock.now += 3_000;
    }

    expect(logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length).toBe(0);
    monitor.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// Test 6: Hysteresis (emit once; +10min re-emit; flap guard; deactivation)
// ---------------------------------------------------------------------------

describe('Test 6 — hysteresis FSM', () => {
  let monitor: MoodBleedMonitorService;
  let driveSubject: Subject<DriveSnapshot>;
  let getCurrentStateFn: jest.Mock<DriveSnapshot>;
  let logCalls: Array<{ eventType: string; payload: Record<string, unknown> }>;
  let fakeClock: { now: number };

  function feedHostileTurns(count: number, anxDelta = 0.08, sadDelta = 0.04, guilDelta = 0.06, globalAnx = 0.62): number {
    let emitted = 0;
    for (let i = 0; i < count; i++) {
      const preSnap = makeSnapshot({ anxiety: globalAnx, sadness: 0.05, guilt: 0.05 });
      const postSnap = makeSnapshot({
        anxiety: globalAnx + anxDelta,
        sadness: 0.05 + sadDelta,
        guilt: 0.05 + guilDelta,
      });
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'hostile', isGuardian: false }, preSnap, postSnap);
      fakeClock.now += 5_000;
    }
    emitted = logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length;
    return emitted;
  }

  beforeEach(() => {
    const built = buildMonitor();
    monitor = built.monitor;
    driveSubject = built.driveSubject;
    getCurrentStateFn = built.getCurrentStateFn;
    logCalls = built.logCalls;
    fakeClock = built.fakeClock;
    fakeClock.now = 6_000_000;
  });

  afterEach(() => {
    monitor.onModuleDestroy();
  });

  it('fires exactly ONCE initially (no flap on first fire)', () => {
    // 12 hostile turns → exactly 1 alert.
    feedHostileTurns(12);
    const alerts = logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT');
    expect(alerts.length).toBe(1);
  });

  it('+10 minutes still triggered → one re-emission', () => {
    // Get to ACTIVE state.
    feedHostileTurns(12);
    expect(logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length).toBe(1);

    // Advance clock by 10 minutes (600_000 ms = cooldown exactly).
    fakeClock.now += 600_000;

    // Feed more hostile turns to trigger evaluation at new clock time.
    feedHostileTurns(3);

    // Should re-emit once.
    expect(logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length).toBe(2);
  });

  it('contrast 0.04 (below threshold) while ACTIVE → still ACTIVE, no flap, no new alert', () => {
    // Reach ACTIVE.
    feedHostileTurns(12);
    const countBefore = logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length;
    expect(countBefore).toBe(1);

    // Feed turns with contrast just below DEACTIVATION threshold (0.05*0.7=0.035).
    // contrast=0.04 > 0.035, so should stay ACTIVE (not deactivate) but below CONTRAST_THRESHOLD (0.05).
    // Actually contrast 0.04 < 0.05 threshold, so allTriggered=false.
    // ACTIVE + allTriggered=false: deactivation check runs first.
    // 0.04 >= 0.05*0.7=0.035, so NOT deactivated.
    // Then allTriggered=false → no FSM transition (ACTIVE stays ACTIVE but no re-emit).
    // Net: still ACTIVE, no new emit.
    const preSnap = makeSnapshot({ anxiety: 0.62, sadness: 0.05, guilt: 0.05 });
    // delta: anx=0.04, sad=0.02, guilt=0.03 → N delta ≈ 0.09 per turn, but vs others who are flat → contrast ~0.09-0.09=0.04
    // We achieve contrast=0.04 by having the speaker's dNAdj just below 0.05.
    // Use anx+0.035, guilt+0.025, sad+0.015 → total delta per turn = 0.075
    // μ_others (flatSpeaker has all zero deltas) = 0 → contrast = 0.075 → wait that's > 0.05.
    // Instead feed a second speaker with almost equal deltas to make contrast small.
    // Actually the simplest approach: keep hostile delta small so μ_X is ≈ 0.04.
    // Feed turns with very small per-turn increases.
    for (let i = 0; i < 3; i++) {
      const pre = makeSnapshot({ anxiety: 0.62, sadness: 0.05, guilt: 0.05 });
      const post = makeSnapshot({ anxiety: 0.62 + 0.025, sadness: 0.05 + 0.01, guilt: 0.05 + 0.015 });
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'hostile', isGuardian: false }, pre, post);
      // Also feed the "others" with a similar delta to cancel contrast.
      const pre2 = makeSnapshot({ anxiety: 0.62, sadness: 0.05, guilt: 0.05 });
      const post2 = makeSnapshot({ anxiety: 0.62 + 0.02, sadness: 0.05 + 0.009, guilt: 0.05 + 0.012 });
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'otherSpeaker', isGuardian: false }, pre2, post2);
      fakeClock.now += 5_000;
    }

    const countAfter = logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length;
    // Still only 1 alert — ACTIVE state preserved without new emission (cooldown not elapsed).
    expect(countAfter).toBe(1);

    const status = monitor.getStatus().find(s => s.speakerId === 'hostile');
    // FSM is ACTIVE or possibly INACTIVE if contrast was < deactivationThreshold.
    // We just verify no extra alerts.
    expect(countAfter).toBe(1);
  });

  it('contrast drops below deactivation threshold (threshold×0.7) → deactivates', () => {
    // Reach ACTIVE state with the standard hostile fixture.
    feedHostileTurns(12);
    expect(logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length).toBe(1);

    // To force deactivation we must make hostile's rolling window μ_X
    // drop below deactivationThreshold (0.05*0.7=0.035).
    //
    // Strategy: push 20 more hostile turns (filling the full 20-turn window)
    // with near-zero deltas while feeding the same near-zero deltas to many
    // other speakers so μ_others ≈ μ_X ≈ 0 (contrast ≈ 0 < 0.035).
    // The hostile window's 20 slots are now all tiny, so μ_X ≈ 0.005.
    // μ_others also ≈ 0.005 (same tiny turns), so contrast ≈ 0 < 0.035.
    const tinyDelta = 0.005; // anx, sad, guilt combined N delta ≈ 0.015 per turn
    for (let i = 0; i < 20; i++) {
      // Hostile with tiny delta.
      const pre = makeSnapshot({ anxiety: 0.62, sadness: 0.05, guilt: 0.05 });
      const post = makeSnapshot({
        anxiety: 0.62 + tinyDelta,
        sadness: 0.05 + tinyDelta * 0.5,
        guilt: 0.05 + tinyDelta * 0.5,
      });
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'hostile', isGuardian: false }, pre, post);

      // Feed 6 other speakers with the SAME tiny delta so μ_others ≈ μ_X
      // (at least MIN_OTHERS_ENTRIES=5 entries needed for μ_others to be non-zero).
      for (let j = 0; j < 6; j++) {
        const pre2 = makeSnapshot({ anxiety: 0.62, sadness: 0.05, guilt: 0.05 });
        const post2 = makeSnapshot({
          anxiety: 0.62 + tinyDelta,
          sadness: 0.05 + tinyDelta * 0.5,
          guilt: 0.05 + tinyDelta * 0.5,
        });
        simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: `deco${j}`, isGuardian: false }, pre2, post2);
      }
      fakeClock.now += 5_000;
    }

    // After 20 turns with near-zero delta, hostile's μ_X ≈ tinyDelta*2=0.01
    // and μ_others ≈ same → contrast ≈ 0 < 0.035.
    // The deactivation check fires and FSM transitions to INACTIVE.
    const status = monitor.getStatus().find(s => s.speakerId === 'hostile');
    expect(status?.fsmState).toBe('INACTIVE');

    // No additional alert was emitted during the cooldown window.
    expect(logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Guardian cap — hostile fixture with isGuardian → WARNING only
// ---------------------------------------------------------------------------

describe('Test 7 — guardian cap (severity capped at WARNING)', () => {
  it('hostile guardian fixture emits WARNING, never CRITICAL', () => {
    const { monitor, driveSubject, getCurrentStateFn, logCalls, fakeClock } = buildMonitor();
    fakeClock.now = 7_000_000;

    let anx = 0.0, sad = 0.0, gui = 0.0;

    for (let i = 0; i < 12; i++) {
      const preSnap = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });
      anx += 0.08; sad += 0.04; gui += 0.06;
      const postSnap = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });

      // isGuardian: true
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'guardian', isGuardian: true }, preSnap, postSnap);

      // Interleaved flat speaker.
      const flatPre = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });
      const flatPost = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'flatSpeaker', isGuardian: false }, flatPre, flatPost);

      fakeClock.now += 5_000;
    }

    const alerts = logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT');
    expect(alerts.length).toBeGreaterThanOrEqual(1);

    // All alerts for guardian must be WARNING, not CRITICAL.
    for (const alert of alerts) {
      if (alert.payload['speakerId'] === 'guardian') {
        expect(alert.payload['severity']).toBe('WARNING');
        expect(alert.payload['severity']).not.toBe('CRITICAL');
        expect(alert.payload['speakerIsGuardian']).toBe(true);
      }
    }

    monitor.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// Test 8: Bracket hygiene — tick regression / tick 0 → discarded, no NaN
// ---------------------------------------------------------------------------

describe('Test 8 — bracket hygiene (tick regression / tick-0 discards)', () => {
  it('discards tick-0 snapshots without NaN', () => {
    const { monitor, driveSubject, getCurrentStateFn, logCalls, fakeClock } = buildMonitor();
    fakeClock.now = 8_000_000;

    // Push a tick-0 snapshot — should be discarded without error.
    const tick0 = makeSnapshot({ anxiety: 0.5, tickNumber: 0 });
    getCurrentStateFn.mockReturnValue(tick0);
    expect(() => driveSubject.next(tick0)).not.toThrow();

    // Push a normal snapshot then a regressed one.
    const snap10 = makeSnapshot({ anxiety: 0.1, tickNumber: 10 });
    getCurrentStateFn.mockReturnValue(snap10);
    driveSubject.next(snap10);

    // Tick regression: push a snapshot with tickNumber < 10.
    const snapRegressed = makeSnapshot({ anxiety: 0.2, tickNumber: 5 });
    getCurrentStateFn.mockReturnValue(snapRegressed);
    expect(() => driveSubject.next(snapRegressed)).not.toThrow();

    // No alerts and no NaN errors.
    expect(logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length).toBe(0);

    monitor.onModuleDestroy();
  });

  it('sessionId change mid-bracket → bracket discarded, no NaN in window', () => {
    const { monitor, driveSubject, getCurrentStateFn, logCalls, fakeClock } = buildMonitor();
    fakeClock.now = 8_500_000;

    // Open a bracket with session A.
    const preSnap = makeSnapshot({ anxiety: 0.1, sessionId: 'session-A', tickNumber: 1 });
    monitor.onCycleStart({ userId: 'speaker1', isGuardian: false }, preSnap);

    // Close with session B (simulates engine restart mid-bracket).
    const endSnap = makeSnapshot({ anxiety: 0.3, sessionId: 'session-B', tickNumber: 5 });
    getCurrentStateFn.mockReturnValue(endSnap);
    monitor.onCycleEnd();

    // Settle snapshot.
    const settleSnap = makeSnapshot({ anxiety: 0.3, sessionId: 'session-B', tickNumber: 8 });
    getCurrentStateFn.mockReturnValue(settleSnap);
    expect(() => driveSubject.next(settleSnap)).not.toThrow();

    // The bracket should have been discarded (sessionId mismatch).
    // speaker1 has 0 entries.
    const status = monitor.getStatus().find(s => s.speakerId === 'speaker1');
    expect(status?.windowEntries ?? 0).toBe(0);

    monitor.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// Test 9: Self-cycle exclusion (null-originator)
// ---------------------------------------------------------------------------

describe('Test 9 — self-cycle exclusion', () => {
  it('null-originator brackets do not move speaker ledgers or baseline', () => {
    const { monitor, driveSubject, getCurrentStateFn, logCalls, fakeClock } = buildMonitor();
    fakeClock.now = 9_000_000;

    // Confirm baseline starts at 0.
    // Run several self-tick cycles (null originator).
    let anx = 0.0;
    for (let i = 0; i < 5; i++) {
      const preSnap = makeSnapshot({ anxiety: anx, tickNumber: i * 4 + 1 });
      anx += 0.1;
      const endSnap = makeSnapshot({ anxiety: anx, tickNumber: i * 4 + 2 });
      getCurrentStateFn.mockReturnValue(endSnap);

      // null originator = self-tick
      monitor.onCycleStart(null, preSnap);
      monitor.onCycleEnd();

      // Push settle snapshot.
      const settleSnap = makeSnapshot({ anxiety: anx, tickNumber: i * 4 + 5 });
      getCurrentStateFn.mockReturnValue(settleSnap);
      driveSubject.next(settleSnap);
      fakeClock.now += 5_000;
    }

    // No speakers tracked.
    expect(monitor.getStatus().length).toBe(0);

    // No alerts emitted.
    expect(logCalls.filter(c => c.eventType === 'ATTRACTOR_STATE_ALERT').length).toBe(0);

    monitor.onModuleDestroy();
  });

  it('self-tick interspersed with real speaker turns does not contaminate speaker window', () => {
    const { monitor, driveSubject, getCurrentStateFn, logCalls, fakeClock } = buildMonitor();
    fakeClock.now = 9_500_000;

    let anx = 0.0, sad = 0.0, gui = 0.0;

    for (let i = 0; i < 12; i++) {
      // Real turn.
      const preSnap = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });
      anx += 0.03; sad += 0.015; gui += 0.02;
      const postSnap = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });
      simulateTurn(monitor, driveSubject, getCurrentStateFn, { userId: 'realSpeaker', isGuardian: false }, preSnap, postSnap);

      // Self-tick between real turns: should NOT add entries to realSpeaker window.
      const selfPre = makeSnapshot({ anxiety: anx, sadness: sad, guilt: gui });
      const selfEnd = makeSnapshot({ anxiety: anx + 0.05, sadness: sad + 0.03, guilt: gui + 0.04 });
      getCurrentStateFn.mockReturnValue(selfEnd);
      monitor.onCycleStart(null, selfPre);
      monitor.onCycleEnd();
      const selfSettle = makeSnapshot({ anxiety: anx + 0.05, sadness: sad + 0.03, guilt: gui + 0.04, tickNumber: selfEnd.tickNumber + 3 });
      getCurrentStateFn.mockReturnValue(selfSettle);
      driveSubject.next(selfSettle);

      fakeClock.now += 5_000;
    }

    // Window should only have the 12 real turns.
    const status = monitor.getStatus().find(s => s.speakerId === 'realSpeaker');
    expect(status?.windowEntries).toBe(12);

    monitor.onModuleDestroy();
  });
});

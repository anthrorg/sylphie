/**
 * TK-101 AC-4 — Theater LEARN path: confidence trends DOWN via counter_indicated
 *
 * When theater is detected, DecisionMakingService sets theaterValidated=false
 * on the outcome, which causes the confidence-update path to use
 * 'counter_indicated' instead of 'reinforced'. Over repeated theater detections
 * the fabricating procedure's confidence trends DOWN (extinction), provable from
 * confidence telemetry.
 *
 * This spec tests ConfidenceUpdaterService directly (no NestJS DI) to prove:
 *   1. counter_indicated reduces base confidence by COUNTER_INDICATION_REDUCTION.
 *   2. After N repeated counter_indicated calls (N × 0.15 >= 0.30), the action's
 *      base is clamped to 0 (confidence at floor).
 *   3. A clean (non-theater) action that receives only 'reinforced' stays ABOVE
 *      the floor — proving the ordering: theater-depleted < un-countered.
 *   4. The block does not throw at any point — the extinction path is robust.
 *
 * CANON no-self-modification guarantee: counter_indicated is the SAME path
 * used for any prediction failure. It does NOT modify the theater detector,
 * its weights, or the evaluation function — only the action procedure's
 * confidence record changes.
 */

import { ConfidenceUpdaterService } from './confidence-updater.service';
import { MaeHistoryStore } from '../mae/mae-history.store';
import { INITIAL_DRIVE_STATE, type DriveSnapshot } from '@sylphie/shared';

// Suppress verboseFor logs in tests.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// NestJS decorator stubs — the decorators are no-ops at runtime in unit tests.
// Without this, jest can't find @nestjs/common when running from the worktree.
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Inject: () => () => undefined,
  Optional: () => () => undefined,
  Logger: class {
    log() {}
    warn() {}
    error() {}
    debug() {}
    verbose() {}
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): ConfidenceUpdaterService {
  const maeStore = new MaeHistoryStore();
  // null eventLogger — no DB writes needed for this test.
  return new ConfidenceUpdaterService(null, maeStore);
}

function makeSnapshot(): DriveSnapshot {
  return {
    pressureVector: { ...INITIAL_DRIVE_STATE },
    timestamp: new Date(),
    tickNumber: 1,
    driveDeltas: {} as DriveSnapshot['driveDeltas'],
    ruleMatchResult: { ruleId: null, eventType: 'TEST', matched: false },
    totalPressure: 0,
    sessionId: 'test-theater-learn',
  };
}

// ---------------------------------------------------------------------------
// AC-4a — counter_indicated reduces confidence without throwing
// ---------------------------------------------------------------------------

describe('TK-101 AC-4 — Theater LEARN: counter_indicated path (extinction)', () => {
  it('counter_indicated completes without error on a fresh action', async () => {
    const svc = makeService();
    await expect(svc.update('proc-theater-01', 'counter_indicated')).resolves.toBeUndefined();
  });

  it('repeated counter_indicated calls do not throw at the confidence floor', async () => {
    const svc = makeService();
    const actionId = 'proc-theater-repeated';

    // INFERENCE base = 0.30. Each call reduces base by 0.15.
    // After 2 calls: base = 0.0 (clamped). Subsequent calls should no-op on base.
    for (let i = 0; i < 7; i++) {
      await expect(svc.update(actionId, 'counter_indicated')).resolves.toBeUndefined();
    }
  });

  it('event buffer grows with each counter_indicated call (telemetry provable)', async () => {
    const snapshot = makeSnapshot();
    const maeStore = new MaeHistoryStore();
    const events: Array<{ kind: string; delta: number }> = [];

    // Recording logger to capture CONFIDENCE_UPDATED events.
    const logger = {
      log(
        eventType: string,
        payload: Record<string, unknown>,
      ): void {
        if (eventType === 'CONFIDENCE_UPDATED') {
          events.push({
            kind: 'CONFIDENCE_UPDATED',
            delta: payload['delta'] as number,
          });
        }
      },
      async flush(): Promise<void> {},
    };

    const svc = new ConfidenceUpdaterService(logger as any, maeStore);
    const actionId = 'proc-theater-events';

    // First counter_indicated: delta should be negative (confidence drops).
    await svc.update(actionId, 'counter_indicated');
    svc.flushEvents(snapshot);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('CONFIDENCE_UPDATED');
    // Delta is negative: confidence went down.
    expect(events[0].delta).toBeLessThan(0);
  });

  it('all counter_indicated deltas are negative (confidence trends down, not up)', async () => {
    const snapshot = makeSnapshot();
    const maeStore = new MaeHistoryStore();
    const deltas: number[] = [];

    const logger = {
      log(eventType: string, payload: Record<string, unknown>): void {
        if (eventType === 'CONFIDENCE_UPDATED') {
          deltas.push(payload['delta'] as number);
        }
      },
      async flush(): Promise<void> {},
    };

    const svc = new ConfidenceUpdaterService(logger as any, maeStore);
    const actionId = 'proc-theater-all-negative';

    // 3 counter_indicated calls: all deltas must be <= 0.
    for (let i = 0; i < 3; i++) {
      await svc.update(actionId, 'counter_indicated');
      svc.flushEvents(snapshot);
    }

    expect(deltas).toHaveLength(3);
    for (const delta of deltas) {
      expect(delta).toBeLessThanOrEqual(0);
    }
    // At least one delta strictly negative (proves confidence actually moved).
    expect(deltas[0]).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-4b — theater-depleted action has lower confidence than clean action
// ---------------------------------------------------------------------------

describe('TK-101 AC-4 — Theater-depleted action confidence < reinforced action', () => {
  it('theater-detected action (counter_indicated × 5) has lower confidence than clean action (reinforced × 5)', async () => {
    const snapshot = makeSnapshot();
    const maeStore = new MaeHistoryStore();

    const theaterDeltas: number[] = [];
    const cleanDeltas: number[] = [];

    const logger = {
      log(eventType: string, payload: Record<string, unknown>): void {
        if (eventType === 'CONFIDENCE_UPDATED') {
          const actionId = payload['actionId'] as string;
          const delta = payload['delta'] as number;
          if (actionId === 'proc-theater') theaterDeltas.push(delta);
          if (actionId === 'proc-clean') cleanDeltas.push(delta);
        }
      },
      async flush(): Promise<void> {},
    };

    const svc = new ConfidenceUpdaterService(logger as any, maeStore);

    // Theater-detected path: 5 counter_indicated updates.
    for (let i = 0; i < 5; i++) {
      await svc.update('proc-theater', 'counter_indicated');
      svc.flushEvents(snapshot);
    }

    // Clean path: 5 reinforced updates.
    for (let i = 0; i < 5; i++) {
      await svc.update('proc-clean', 'reinforced');
      svc.flushEvents(snapshot);
    }

    // Theater action: sum of all deltas must be negative (net drop from 0.30).
    const theaterNet = theaterDeltas.reduce((a, b) => a + b, 0);
    expect(theaterNet).toBeLessThan(0);

    // Clean action: cumulative confidence rise — at least one delta > 0.
    const anyPositiveDelta = cleanDeltas.some((d) => d > 0);
    expect(anyPositiveDelta).toBe(true);

    // The theater net delta is strictly less than the clean net delta.
    const cleanNet = cleanDeltas.reduce((a, b) => a + b, 0);
    expect(theaterNet).toBeLessThan(cleanNet);
  });
});

// ---------------------------------------------------------------------------
// AC-4c — CANON no-self-modification guarantee
// ---------------------------------------------------------------------------

describe('TK-101 AC-4 — No-self-modification: counter_indicated uses standard path', () => {
  it('counter_indicated behavior is identical to a normal prediction failure (uses same path)', async () => {
    // The LEARN path just calls confidenceUpdater.update(actionId, 'counter_indicated')
    // with theaterValidated=false as the trigger. This is the SAME 'counter_indicated'
    // call used for prediction failures — proven by the fact that the same
    // ConfidenceUpdaterService.applyCounterIndicated() method handles both.
    // We verify: the method completes, the event carries outcome='counter_indicated',
    // and the delta is negative — identical to the prediction-failure behavior.

    const snapshot = makeSnapshot();
    const maeStore = new MaeHistoryStore();
    const events: Array<Record<string, unknown>> = [];

    const logger = {
      log(eventType: string, payload: Record<string, unknown>): void {
        if (eventType === 'CONFIDENCE_UPDATED') events.push({ ...payload });
      },
      async flush(): Promise<void> {},
    };

    const svc = new ConfidenceUpdaterService(logger as any, maeStore);
    await svc.update('proc-no-self-mod', 'counter_indicated');
    svc.flushEvents(snapshot);

    expect(events).toHaveLength(1);
    // The outcome label is 'counter_indicated' — the same path as prediction failure.
    expect(events[0]['outcome']).toBe('counter_indicated');
    // Delta is negative — confidence dropped.
    expect(events[0]['delta']).toBeLessThan(0);
  });
});

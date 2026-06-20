/**
 * Unit tests for ConfidenceUpdaterService.flushEvents() — TK-67 acceptance criteria.
 *
 * AC1: Given a 'reinforced' update with a DriveSnapshot at flush, when flushEvents
 *      runs, then a CONFIDENCE_UPDATED row is written with correct actionId/delta/
 *      driveSnapshot; a TYPE_1_GRADUATION row is written (no stdout-only).
 *
 * AC2a: Given flushEvents on an empty buffer, when called, then no writes & no error.
 *
 * AC2b: Given a batch of 'decayed' updates across multiple actions, when flushEvents
 *       runs, then exactly one CONFIDENCE_UPDATED row per action (no aggregation).
 *
 * Strategy: use a recording fake for IDecisionEventLogger (same pattern as the
 * social-comment-initiated spec and decision-event-logger spec). Supply a minimal
 * DriveSnapshot matching the current @sylphie/shared shape.
 */

import { ConfidenceUpdaterService } from './confidence-updater.service';
import { INITIAL_DRIVE_STATE, type DriveSnapshot } from '@sylphie/shared';

// Suppress verboseFor logs in tests.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface LoggedEvent {
  eventType: string;
  payload: Record<string, unknown>;
  driveSnapshot: DriveSnapshot;
  sessionId: string;
  correlationId?: string;
}

class RecordingEventLogger {
  readonly events: LoggedEvent[] = [];

  log(
    eventType: string,
    payload: Record<string, unknown>,
    driveSnapshot: DriveSnapshot,
    sessionId: string,
    correlationId?: string,
  ): void {
    this.events.push({ eventType, payload, driveSnapshot, sessionId, correlationId });
  }

  async flush(): Promise<void> {}
}

/**
 * Build a structurally-valid DriveSnapshot. The service only reads sessionId
 * and forwards the whole snapshot to the event logger, so exact drive values
 * are immaterial — only shape + sessionId matter.
 */
function makeSnapshot(sessionId = 'test-session'): DriveSnapshot {
  return {
    pressureVector: { ...INITIAL_DRIVE_STATE },
    timestamp: new Date(),
    tickNumber: 1,
    driveDeltas: {} as DriveSnapshot['driveDeltas'],
    ruleMatchResult: { ruleId: null, eventType: 'TEST', matched: false },
    totalPressure: 0,
    sessionId,
  };
}

/**
 * Build a ConfidenceUpdaterService with a recording logger.
 * The service is constructed directly (no NestJS DI needed in unit tests).
 */
function makeService(): { service: ConfidenceUpdaterService; logger: RecordingEventLogger } {
  const logger = new RecordingEventLogger();
  // Constructor signature: (eventLogger: IDecisionEventLogger | null)
  const service = new ConfidenceUpdaterService(logger as any);
  return { service, logger };
}

// ---------------------------------------------------------------------------
// AC1 — reinforced update with graduation → CONFIDENCE_UPDATED + TYPE_1_GRADUATION
// ---------------------------------------------------------------------------

describe('flushEvents — AC1: reinforced update with DriveSnapshot', () => {
  it('writes a CONFIDENCE_UPDATED row with correct actionId, delta, and driveSnapshot', async () => {
    const { service, logger } = makeService();
    const snapshot = makeSnapshot('session-ac1');
    const actionId = 'action-reinforce-1';

    await service.update(actionId, 'reinforced');
    service.flushEvents(snapshot);

    const updated = logger.events.filter((e) => e.eventType === 'CONFIDENCE_UPDATED');
    expect(updated).toHaveLength(1);

    const event = updated[0];
    expect(event.payload['actionId']).toBe(actionId);
    expect(typeof event.payload['delta']).toBe('number');
    expect(typeof event.payload['newConfidence']).toBe('number');
    expect(event.payload['outcome']).toBe('reinforced');
    // The driveSnapshot passed through is the one supplied at flush time.
    expect(event.driveSnapshot).toBe(snapshot);
    expect(event.sessionId).toBe('session-ac1');
  });

  it('writes a TYPE_1_GRADUATION row (not just stdout) when the action crosses the graduation threshold', async () => {
    // graduation requires confidence > 0.80 AND recentMAE < 0.10.
    // ACT-R formula: base(0.30) + 0.12 * ln(count) - 0.06 * ln(hours+1).
    // With hours≈0: need 0.30 + 0.12*ln(count) > 0.80 → count > ~65.
    // We run 80 iterations to ensure we cross the threshold.
    const { service: s, logger: l } = makeService();
    const snap = makeSnapshot('session-graduation');
    const actionId = 'action-graduate';

    let graduationFired = false;
    for (let i = 0; i < 80; i++) {
      s.recordPredictionMAE(actionId, 0.01); // low MAE — satisfies MAE gate
      await s.update(actionId, 'reinforced');
      s.flushEvents(snap);

      const grad = l.events.filter((e) => e.eventType === 'TYPE_1_GRADUATION');
      if (grad.length > 0) {
        graduationFired = true;
        // Verify the graduation event was written via eventLogger (not just a debug log).
        expect(grad[0].payload['actionId']).toBe(actionId);
        expect(typeof grad[0].payload['newConfidence']).toBe('number');
        expect((grad[0].payload['newConfidence'] as number)).toBeGreaterThan(0.80);
        expect(grad[0].driveSnapshot).toBe(snap);
        break;
      }
    }

    expect(graduationFired).toBe(true);
  });

  it('delta is (newConfidence - preUpdateConfidence), positive after the second reinforcement', async () => {
    const { service, logger } = makeService();
    const snapshot = makeSnapshot();
    const actionId = 'action-delta-check';

    // First reinforcement: count 0→1, ln(1)=0, so delta=0 (ACT-R arithmetic fact).
    await service.update(actionId, 'reinforced');
    service.flushEvents(snapshot);
    logger.events.length = 0;

    // Second reinforcement: count 1→2, ln(2)>0, so confidence rises and delta>0.
    await service.update(actionId, 'reinforced');
    service.flushEvents(snapshot);

    const event = logger.events.find((e) => e.eventType === 'CONFIDENCE_UPDATED');
    expect(event).toBeDefined();
    // After the second call base=0.30 + 0.12*ln(2) ≈ 0.383 → delta > 0.
    expect(event!.payload['delta']).toBeGreaterThan(0);
    // The event carries the correct outcome label.
    expect(event!.payload['outcome']).toBe('reinforced');
  });
});

// ---------------------------------------------------------------------------
// AC2a — empty buffer → no writes, no error
// ---------------------------------------------------------------------------

describe('flushEvents — AC2a: empty buffer', () => {
  it('is a no-op when no update has been called', () => {
    const { service, logger } = makeService();
    const snapshot = makeSnapshot();

    // No update() calls — buffer is empty.
    expect(() => service.flushEvents(snapshot)).not.toThrow();
    expect(logger.events).toHaveLength(0);
  });

  it('is a no-op after a prior flush already consumed the buffer', async () => {
    const { service, logger } = makeService();
    const snapshot = makeSnapshot();

    await service.update('action-double-flush', 'reinforced');
    service.flushEvents(snapshot); // consumes buffer
    logger.events.length = 0; // clear recording

    // Second flush with same snapshot — buffer is already empty.
    service.flushEvents(snapshot);
    expect(logger.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2b — batch of decayed updates → one row per action, no aggregation
// ---------------------------------------------------------------------------

describe('flushEvents — AC2b: batch decay, one row per action', () => {
  it('emits exactly one CONFIDENCE_UPDATED row per action when multiple actions are decayed', async () => {
    const { service, logger } = makeService();
    const snapshot = makeSnapshot('session-batch');

    const actionIds = ['action-a', 'action-b', 'action-c'];

    // Prime each action so it has a confidence record (bootstrap, then decay).
    for (const id of actionIds) {
      await service.update(id, 'reinforced'); // creates record
      service.flushEvents(snapshot);          // flush reinforced events
    }

    // Clear logger to isolate the decay batch.
    logger.events.length = 0;

    // Decay all three actions.
    for (const id of actionIds) {
      await service.update(id, 'decayed');
    }
    service.flushEvents(snapshot); // single flush for the whole batch

    const updated = logger.events.filter((e) => e.eventType === 'CONFIDENCE_UPDATED');
    // One row per action — no aggregation.
    expect(updated).toHaveLength(actionIds.length);

    // Each row carries the correct actionId.
    const emittedIds = updated.map((e) => e.payload['actionId']);
    for (const id of actionIds) {
      expect(emittedIds).toContain(id);
    }

    // All rows carry the same driveSnapshot (the one passed at flush time).
    for (const row of updated) {
      expect(row.driveSnapshot).toBe(snapshot);
    }
  });

  it('does not aggregate multiple decays into a single row', async () => {
    const { service, logger } = makeService();
    const snapshot = makeSnapshot();

    // Three separate decay updates for the same action (unusual but must not aggregate).
    const actionId = 'action-no-aggregate';
    await service.update(actionId, 'reinforced'); // create record
    service.flushEvents(snapshot);

    logger.events.length = 0;

    // Decay 3 times without flushing between — all buffered.
    await service.update(actionId, 'decayed');
    await service.update(actionId, 'decayed');
    await service.update(actionId, 'decayed');
    service.flushEvents(snapshot);

    // Should produce 3 individual CONFIDENCE_UPDATED rows, not 1 aggregated.
    const rows = logger.events.filter((e) => e.eventType === 'CONFIDENCE_UPDATED');
    expect(rows).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('flushEvents — null eventLogger', () => {
  it('does not throw when eventLogger is null (no DI provider)', async () => {
    // Construct with null eventLogger — simulates the optional injection not provided.
    const service = new ConfidenceUpdaterService(null);
    const snapshot = makeSnapshot();

    await service.update('action-null-logger', 'reinforced');
    expect(() => service.flushEvents(snapshot)).not.toThrow();
  });
});

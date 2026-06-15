/**
 * Unit tests for the SOCIAL_COMMENT_INITIATED emission in
 * DecisionMakingService.reportOutcome() (self-model social_interaction, LEG 1).
 *
 * The Std-1 honest contract:
 *   - A GENUINELY PROACTIVE bid (self-initiated tick, NO originator, real
 *     communicative response) is recorded at cycle-emit time into the private
 *     `pendingProactiveSocial` map, then reportOutcome() emits exactly ONE
 *     SOCIAL_COMMENT_INITIATED event carrying a NON-NULL session_id.
 *   - A REACTIVE outcome (originator present → no pendingProactiveSocial entry)
 *     emits NOTHING. Reactive replies must never enter the success-rate
 *     denominator (the theater trap the spec warns about).
 *
 * Detection of the proactive condition happens in processInput() (the cycle),
 * NOT in reportOutcome(). The cycle sets the pendingProactiveSocial entry ONLY
 * when there is no currentTurnContext AND no frame turn_id AND the response was a
 * real (non-degraded) communicative emit. This spec exercises the consume side:
 * a seeded entry (what a proactive cycle leaves behind) → emit; no entry (what a
 * reactive cycle leaves behind) → no emit.
 *
 * Strategy: a generic auto-stub Proxy satisfies the ~24 constructor deps that
 * reportOutcome() does not exercise on the SHRUG path; a real recording fake is
 * supplied for the two deps it does (eventLogger + driveStateReader).
 */

import { DecisionMakingService } from './decision-making.service';
import type { ActionOutcome } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Recording fakes for the deps reportOutcome() actually touches
// ---------------------------------------------------------------------------

interface LoggedEvent {
  eventType: string;
  payload: Record<string, unknown>;
  sessionId: string;
  correlationId?: string;
}

class RecordingEventLogger {
  readonly events: LoggedEvent[] = [];
  log(
    eventType: string,
    payload: Record<string, unknown>,
    _driveSnapshot: unknown,
    sessionId: string,
    correlationId?: string,
  ): void {
    this.events.push({ eventType, payload, sessionId, correlationId });
  }
  async flush(): Promise<void> {}
}

/** Minimal drive snapshot with the fields reportOutcome reads. */
function fakeSnapshot(sessionId: string) {
  return {
    sessionId,
    pressureVector: {},
    totalPressure: 0,
    tickNumber: 1,
  };
}

class FakeDriveStateReader {
  constructor(private readonly sessionId: string) {}
  getCurrentState() {
    return fakeSnapshot(this.sessionId);
  }
}

/**
 * Auto-stub: any property access returns a no-op function (returning undefined),
 * so the constructor deps reportOutcome() does not meaningfully use on the SHRUG
 * path (predictionService, confidenceUpdater, attractorMonitor, latentSpace, …)
 * are satisfied without hand-writing each one.
 */
function autoStub(): never {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: () => () => undefined,
  };
  return new Proxy({}, handler) as unknown as never;
}

/**
 * Construct DecisionMakingService positionally. Only eventLogger (index 7) and
 * driveStateReader (index 10) are real recording fakes; the rest are auto-stubs.
 * actionOutcomeReporter (index 11) is a recording stub so the drive-forwarding
 * block runs without throwing (and we can assert socialCommentTimestamp is
 * untouched by our additive code path).
 */
function makeService(sessionId: string): {
  service: DecisionMakingService;
  eventLogger: RecordingEventLogger;
  driveOutcomes: Array<Record<string, unknown>>;
} {
  const eventLogger = new RecordingEventLogger();
  const driveStateReader = new FakeDriveStateReader(sessionId);
  const driveOutcomes: Array<Record<string, unknown>> = [];
  const actionOutcomeReporter = {
    reportOutcome: (o: Record<string, unknown>) => {
      driveOutcomes.push(o);
    },
  };

  const service = new DecisionMakingService(
    autoStub(), // 0  executorEngine
    autoStub(), // 1  actionRetriever
    autoStub(), // 2  predictionService
    autoStub(), // 3  arbitrationService
    autoStub(), // 4  episodicMemory
    autoStub(), // 5  confidenceUpdater
    autoStub(), // 6  consolidationService
    eventLogger as unknown as never, // 7  eventLogger
    autoStub(), // 8  processInputService
    autoStub(), // 9  actionHandlerRegistry
    driveStateReader as unknown as never, // 10 driveStateReader
    actionOutcomeReporter as unknown as never, // 11 actionOutcomeReporter
    autoStub(), // 12 tensorInference
    autoStub(), // 13 llm
    autoStub(), // 14 attractorMonitor
    autoStub(), // 15 moodBleedMonitor
    autoStub(), // 16 tickSampler
    autoStub(), // 17 streamLogger
    autoStub(), // 18 latentSpace
    autoStub(), // 19 wkgContext
    autoStub(), // 20 deliberation
    autoStub(), // 21 sensoryPrediction
    autoStub(), // 22 scenePrediction
    autoStub(), // 23 modalityRegistry
    autoStub(), // 24 cycleGuard
  );

  return { service, eventLogger, driveOutcomes };
}

/** A SHRUG outcome — hasProcedureNode=false, so reportOutcome skips the
 * procedure-backed branches and reaches the drive-forward + social block. */
function shrugOutcome(): ActionOutcome {
  return {
    selectedAction: {
      actionId: 'cap-action-1',
      arbitrationResult: { type: 'SHRUG', reason: 'test' },
      selectedAt: new Date(),
      theaterValidated: true,
    },
    predictionAccurate: true,
    predictionError: 0.1,
    driveEffectsObserved: {},
    anxietyAtExecution: 0,
    observedAt: new Date(),
  } as unknown as ActionOutcome;
}

// Seed the private pendingProactiveSocial map the way a PROACTIVE cycle would.
function seedProactive(
  service: DecisionMakingService,
  actionId: string,
  entry: { turnId: string; sessionId: string; initiatedAt: number },
): void {
  (service as unknown as {
    pendingProactiveSocial: Map<string, typeof entry>;
  }).pendingProactiveSocial.set(actionId, entry);
}

// ---------------------------------------------------------------------------
// (1) Proactive bid → emits SOCIAL_COMMENT_INITIATED with non-null session_id
// ---------------------------------------------------------------------------

describe('reportOutcome — proactive self-tick bid', () => {
  it('emits exactly one SOCIAL_COMMENT_INITIATED with the captured session_id', async () => {
    const { service, eventLogger } = makeService('drive-session-xyz');
    const actionId = 'cap-action-1';
    seedProactive(service, actionId, {
      turnId: 'turn-abc',
      sessionId: 'drive-session-xyz',
      initiatedAt: 1_700_000_000_000,
    });

    await service.reportOutcome(actionId, shrugOutcome());

    const social = eventLogger.events.filter(
      (e) => e.eventType === 'SOCIAL_COMMENT_INITIATED',
    );
    expect(social.length).toBe(1);
    expect(social[0].sessionId).toBe('drive-session-xyz');
    expect(social[0].sessionId).not.toBeNull();
    expect(social[0].payload['turnId']).toBe('turn-abc');
    expect(social[0].payload['sessionId']).toBe('drive-session-xyz');
    expect(social[0].payload['actionId']).toBe(actionId);
    expect(social[0].payload['initiatedAt']).toBe(1_700_000_000_000);
  });

  it('consumes the pending entry (no second emit on a repeat reportOutcome)', async () => {
    const { service, eventLogger } = makeService('drive-session-xyz');
    const actionId = 'cap-action-1';
    seedProactive(service, actionId, {
      turnId: 'turn-abc',
      sessionId: 'drive-session-xyz',
      initiatedAt: 1_700_000_000_000,
    });

    await service.reportOutcome(actionId, shrugOutcome());
    await service.reportOutcome(actionId, shrugOutcome());

    const social = eventLogger.events.filter(
      (e) => e.eventType === 'SOCIAL_COMMENT_INITIATED',
    );
    expect(social.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (2) Reactive outcome (no pending entry) → NO emission
// ---------------------------------------------------------------------------

describe('reportOutcome — reactive reply (originator present)', () => {
  it('emits NO SOCIAL_COMMENT_INITIATED when there is no proactive pending entry', async () => {
    const { service, eventLogger } = makeService('drive-session-xyz');
    // No seedProactive — this is what a reactive cycle (originator present)
    // leaves behind: the cycle's `isProactiveSocialBid` was false, so no entry.

    await service.reportOutcome('cap-action-2', shrugOutcome());

    const social = eventLogger.events.filter(
      (e) => e.eventType === 'SOCIAL_COMMENT_INITIATED',
    );
    expect(social.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (3) Additive-only — the drive forward still sets socialCommentTimestamp and
//     our path does not interfere with it.
// ---------------------------------------------------------------------------

describe('reportOutcome — additive, no drive drift', () => {
  it('still forwards socialCommentTimestamp to the drive engine (unchanged behavior)', async () => {
    const { service, driveOutcomes } = makeService('drive-session-xyz');
    seedProactive(service, 'cap-action-1', {
      turnId: 'turn-abc',
      sessionId: 'drive-session-xyz',
      initiatedAt: 1_700_000_000_000,
    });

    await service.reportOutcome('cap-action-1', shrugOutcome());

    expect(driveOutcomes.length).toBe(1);
    // The drive-side contingency input is untouched: socialCommentTimestamp is
    // still set on the forwarded outcome regardless of our additive telemetry.
    expect(typeof driveOutcomes[0]['socialCommentTimestamp']).toBe('number');
  });
});

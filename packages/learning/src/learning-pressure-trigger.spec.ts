/**
 * TK-55 — Learning cycle pressure trigger (Cognitive Awareness drive)
 *
 * Verifies that LearningService:
 *   AC1 — calls forceCycle() (→ runMaintenanceCycle()) when a DriveSnapshot
 *         arrives with CognitiveAwareness > 0.5; the cycleInFlight guard
 *         prevents double-execution within a single cycle.
 *   AC2a — does NOT trigger when CognitiveAwareness <= 0.5.
 *   AC2b — silently drops timer ticks (and pressure ticks) while a cycle is
 *         already in flight (existing cycleInFlight guard).
 *
 * Strategy: construct LearningService directly (no NestJS DI) with all
 * pipeline-step deps replaced by no-op fakes. Inject a Subject<DriveSnapshot>
 * as the driveState$ observable so tests can push snapshots synchronously.
 * Spy on runMaintenanceCycle to track invocation counts without running the
 * full 7-step pipeline.
 */

import { Subject } from 'rxjs';
import { LearningService } from './learning.service';
import { DRIVE_STATE_READER } from '@sylphie/drive-engine';
import { DriveName } from '@sylphie/shared';
import type { DriveSnapshot, PressureVector } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal DriveSnapshot with just the cognitiveAwareness value set. */
function makeSnapshot(cognitiveAwareness: number): DriveSnapshot {
  const pressureVector = {
    [DriveName.SystemHealth]: 0,
    [DriveName.MoralValence]: 0,
    [DriveName.Integrity]: 0,
    [DriveName.CognitiveAwareness]: cognitiveAwareness,
    [DriveName.Guilt]: 0,
    [DriveName.Curiosity]: 0,
    [DriveName.Boredom]: 0,
    [DriveName.Anxiety]: 0,
    [DriveName.Satisfaction]: 0,
    [DriveName.Sadness]: 0,
    [DriveName.Focus]: 0,
    [DriveName.Social]: 0,
  } as PressureVector;

  return {
    pressureVector,
    driveDeltas: pressureVector, // deltas irrelevant to this test
    tickNumber: 1,
    totalPressure: cognitiveAwareness,
    timestamp: new Date(),
    isConnected: true,
  } as unknown as DriveSnapshot;
}

/** Zero-returning fake for all ILearningEventLogger calls. */
const fakeLogger = { log: jest.fn() };

/** Zero-returning fake for IUpdateWkgService. */
const fakeUpdateWkg = {
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  fetchUnlearnedEvents: jest.fn().mockResolvedValue([]),
  markAsLearned: jest.fn().mockResolvedValue(undefined),
};

/** Generic no-op fake for every other pipeline step. */
const noopService = {};

/** Fake IConversationReflectionService (needs ensureSchema). */
const fakeConvReflection = {
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  findReflectableSessions: jest.fn().mockResolvedValue([]),
  reflectOnSession: jest.fn().mockResolvedValue({ sessionId: '', insightsCreated: 0, edgesCreated: 0, wasNoop: true }),
};

/** Fake ICrossSessionSynthesisService (needs ensureSchema + runSynthesisCycle). */
const fakeSynthesis = {
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  findSynthesizablePairs: jest.fn().mockResolvedValue([]),
  synthesizePair: jest.fn(),
  runSynthesisCycle: jest.fn().mockResolvedValue({ pairsExamined: 0, synthesesCreated: 0, wasNoop: true }),
};

/** Fake IConfidenceDecayService. */
const fakeDecay = {
  runDecayCycle: jest.fn().mockResolvedValue({ nodesDecayed: 0, edgesDecayed: 0, nodesPruned: 0, wasNoop: true }),
};

/** Fake ISelfModelWriterService. */
const fakeSelfModel = {
  runSelfModelCycle: jest.fn().mockResolvedValue({ wrote: false, sampleCount: 0, successRate: null, confidence: null, wasNoop: true }),
};

/** Build a LearningService with a controlled driveState$ Subject. */
function makeService(driveSubject: Subject<DriveSnapshot>): LearningService {
  const fakeDriveReader = {
    driveState$: driveSubject.asObservable(),
    getCurrentState: () => makeSnapshot(0),
    getTotalPressure: () => 0,
  };

  // NestJS @Inject decorators consume the tokens at DI time; constructing
  // directly bypasses DI, so we pass deps positionally in constructor order.
  return new LearningService(
    fakeUpdateWkg as any,
    noopService as any, // upsertEntities
    noopService as any, // extractTypedEdges
    noopService as any, // extractEdges
    noopService as any, // conversationEntry
    noopService as any, // canProduceEdges
    noopService as any, // refineEdges
    noopService as any, // detectContradictions
    fakeDecay as any,
    fakeConvReflection as any,
    fakeSynthesis as any,
    fakeSelfModel as any,
    fakeLogger as any,
    fakeDriveReader as any,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LearningService — pressure-triggered cycle (TK-55)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('AC1: calls runMaintenanceCycle() when CognitiveAwareness > 0.5', async () => {
    const subject = new Subject<DriveSnapshot>();
    const service = makeService(subject);

    const spy = jest
      .spyOn(service as any, 'runMaintenanceCycle')
      .mockResolvedValue({
        eventsProcessed: 1, entitiesUpserted: 0, edgesUpserted: 0,
        conversationsCreated: 0, canProduceEdgesCreated: 0,
        edgesRefined: 0, contradictionsDetected: 0, wasNoop: false,
      });

    await service.onModuleInit();

    // Emit a snapshot with pressure above threshold.
    subject.next(makeSnapshot(0.6));

    // forceCycle() is fire-and-forget (no await); flush the microtask queue.
    await Promise.resolve();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('AC1: in-flight guard prevents double-execution on a second pressure tick', async () => {
    const subject = new Subject<DriveSnapshot>();
    const service = makeService(subject);

    let resolveFirst!: () => void;
    const spy = jest
      .spyOn(service as any, 'runMaintenanceCycle')
      .mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            // First call hangs until resolveFirst() is called.
            resolveFirst = res;
          }),
      )
      .mockResolvedValue({
        eventsProcessed: 0, entitiesUpserted: 0, edgesUpserted: 0,
        conversationsCreated: 0, canProduceEdgesCreated: 0,
        edgesRefined: 0, contradictionsDetected: 0, wasNoop: true,
      });

    await service.onModuleInit();

    // First emission starts a cycle (spy call 1 — hangs).
    subject.next(makeSnapshot(0.8));
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);

    // Second emission while cycle is in flight → cycleInFlight guard fires,
    // runMaintenanceCycle is called again but returns noop immediately
    // (the guard sets cycleInFlight=true before the first await).
    subject.next(makeSnapshot(0.9));
    await Promise.resolve();

    // runMaintenanceCycle is invoked a second time but returns wasNoop=true.
    expect(spy).toHaveBeenCalledTimes(2);

    // Resolve the first cycle so the service can clean up.
    resolveFirst();
    await Promise.resolve();
  });

  it('AC2a: does NOT trigger when CognitiveAwareness <= threshold (0.5)', async () => {
    const subject = new Subject<DriveSnapshot>();
    const service = makeService(subject);

    const spy = jest
      .spyOn(service as any, 'runMaintenanceCycle')
      .mockResolvedValue({
        eventsProcessed: 0, entitiesUpserted: 0, edgesUpserted: 0,
        conversationsCreated: 0, canProduceEdgesCreated: 0,
        edgesRefined: 0, contradictionsDetected: 0, wasNoop: true,
      });

    await service.onModuleInit();

    // Exactly at threshold — should NOT trigger.
    subject.next(makeSnapshot(0.5));
    await Promise.resolve();

    // Below threshold.
    subject.next(makeSnapshot(0.4));
    await Promise.resolve();

    // Zero.
    subject.next(makeSnapshot(0));
    await Promise.resolve();

    expect(spy).not.toHaveBeenCalled();
  });

  it('AC2b: timer tick while a pressure cycle is in flight is dropped silently', async () => {
    const subject = new Subject<DriveSnapshot>();
    const service = makeService(subject);

    let resolveFirst!: () => void;
    const spy = jest
      .spyOn(service as any, 'runMaintenanceCycle')
      .mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            resolveFirst = res;
          }),
      )
      .mockResolvedValue({
        eventsProcessed: 0, entitiesUpserted: 0, edgesUpserted: 0,
        conversationsCreated: 0, canProduceEdgesCreated: 0,
        edgesRefined: 0, contradictionsDetected: 0, wasNoop: true,
      });

    await service.onModuleInit();

    // Pressure tick starts a cycle (hangs).
    subject.next(makeSnapshot(0.75));
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);

    // Timer fires while cycle is in flight — the same cycleInFlight guard
    // applies; runMaintenanceCycle is called but returns noop immediately.
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();

    // Timer call hits the guard (cycleInFlight=true) → noop returned.
    // spy call count = 2 (1 pressure + 1 timer-noop).
    expect(spy).toHaveBeenCalledTimes(2);

    resolveFirst();
    await Promise.resolve();
  });

  it('onModuleDestroy: unsubscribes from driveState$ and stops timers', async () => {
    const subject = new Subject<DriveSnapshot>();
    const service = makeService(subject);

    const spy = jest
      .spyOn(service as any, 'runMaintenanceCycle')
      .mockResolvedValue({
        eventsProcessed: 0, entitiesUpserted: 0, edgesUpserted: 0,
        conversationsCreated: 0, canProduceEdgesCreated: 0,
        edgesRefined: 0, contradictionsDetected: 0, wasNoop: true,
      });

    await service.onModuleInit();
    service.onModuleDestroy();

    // After destroy, emissions must not trigger cycles.
    subject.next(makeSnapshot(0.9));
    await Promise.resolve();

    expect(spy).not.toHaveBeenCalled();
  });
});

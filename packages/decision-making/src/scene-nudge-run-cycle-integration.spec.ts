/**
 * TK-21 / P4.2 — AC3 INTEGRATION coverage for the production stamp seam.
 *
 * The sibling `process-input/scene-nudge-system-trigger.spec.ts` proves the
 * stamp→categorize DESIGN at the CycleGuard level, but it hand-rolls the
 * `if (turn.sceneNudge) frame.raw['system_trigger'] = true` line inside its own
 * cycle runner. That means it would still pass if the REAL stamp in
 * `DecisionMakingService.runCycleForTurn` were deleted — it verifies the design,
 * not the wire.
 *
 * This spec closes that gap: it drives the REAL private `runCycleForTurn` with a
 * `sceneNudge` turn and a REAL `ProcessInputService`, and asserts the production
 * stamp causes the frame to categorize as SYSTEM_TRIGGER. Delete the stamp line
 * in runCycleForTurn and THIS test fails (mutation-verified: removing the stamp
 * yields MULTIMODAL_INPUT and the first test goes red). The ~24 constructor deps
 * the stamp path does not exercise are satisfied by a generic auto-stub Proxy
 * (same strategy as social-comment-initiated.spec.ts); the handful the path DOES
 * touch (tickSampler, driveStateReader, streamLogger, processInputService) are
 * real or recording fakes.
 */

import { DecisionMakingService } from './decision-making.service';
import { ProcessInputService } from './process-input/process-input.service';
import type { InboundTurn } from './concurrency/inbound-turn';
import {
  EMBEDDING_DIM,
  DRIVE_INDEX_ORDER,
  type SensoryFrame,
  type DriveSnapshot,
} from '@sylphie/shared';

jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Frame + snapshot helpers
// ---------------------------------------------------------------------------

/** A salient-but-calm visual frame (video + scene, no human text/audio). */
function salientCalmFrame(): SensoryFrame {
  return {
    timestamp: 1,
    fused_embedding: new Array(EMBEDDING_DIM).fill(0),
    modality_embeddings: {},
    active_modalities: ['video', 'scene'],
    raw: { video: { detections: [] } },
  };
}

/** A drive-COLD snapshot: every drive at 0.0, total pressure 0.0. */
function coldSnapshot(): DriveSnapshot {
  const pressureVector: Record<string, number> = {};
  for (const d of DRIVE_INDEX_ORDER) pressureVector[d] = 0;
  return {
    pressureVector,
    totalPressure: 0,
    sessionId: 'sess-1',
    tickNumber: 1,
  } as unknown as DriveSnapshot;
}

// ---------------------------------------------------------------------------
// Auto-stub for the constructor deps the stamp path does not exercise.
// Any property access returns a no-op function. Re-instantiated per service so
// state never leaks between tests.
// ---------------------------------------------------------------------------

function autoStub(): never {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: () => () => undefined,
  };
  return new Proxy({}, handler) as unknown as never;
}

// ---------------------------------------------------------------------------
// Construct the real service with a real ProcessInputService + the real
// collaborators runCycleForTurn touches before/at the stamp.
// ---------------------------------------------------------------------------

function makeService(frame: SensoryFrame): {
  service: DecisionMakingService;
  categories: string[];
} {
  // A REAL ProcessInputService — its categorizeFrame is the production
  // classifier we want to exercise against the frame runCycleForTurn produces.
  const processInputService = new ProcessInputService(null, null, null);

  const categories: string[] = [];

  // tickSampler.sample() returns the frame the production stamp is written onto.
  // The sceneNudge path skips injectSyntheticText (empty text), so only sample()
  // matters here.
  const tickSampler = {
    injectSyntheticText: jest.fn(),
    sample: jest.fn(async () => frame),
  };

  const driveStateReader = {
    getCurrentState: jest.fn(() => coldSnapshot()),
  };

  const streamLogger = {
    logFrame: jest.fn(),
  };

  const service = new DecisionMakingService(
    autoStub(), // 0  executorEngine
    autoStub(), // 1  actionRetriever
    autoStub(), // 2  predictionService
    autoStub(), // 3  arbitrationService
    autoStub(), // 4  episodicMemory
    autoStub(), // 5  confidenceUpdater
    autoStub(), // 6  consolidationService
    autoStub(), // 7  eventLogger
    processInputService as unknown as never, // 8  processInputService (REAL)
    autoStub(), // 9  actionHandlerRegistry
    driveStateReader as unknown as never, // 10 driveStateReader (fake)
    autoStub(), // 11 actionOutcomeReporter
    autoStub(), // 12 tensorInference
    autoStub(), // 13 llm
    autoStub(), // 14 attractorMonitor
    autoStub(), // 15 moodBleedMonitor
    tickSampler as unknown as never, // 16 tickSampler (fake → returns frame)
    streamLogger as unknown as never, // 17 streamLogger (fake)
    autoStub(), // 18 latentSpace
    autoStub(), // 19 wkgContext
    autoStub(), // 20 deliberation
    autoStub(), // 21 sensoryPrediction
    autoStub(), // 22 scenePrediction
    autoStub(), // 23 modalityRegistry
    autoStub(), // 24 cycleGuard
  );

  // runCycleForTurn applies the production stamp, then calls the service's OWN
  // inner `processInput(frame, epoch)` cycle (decision-making.service.ts:830).
  // We intercept that single method to capture the frame AS runCycleForTurn
  // handed it over — i.e. AFTER the stamp — and run the REAL production
  // categorizer on it. This keeps the test focused on the stamp→categorize wire
  // without dragging in the full 250-line cycle (arbitration, retrieval, etc.),
  // while still exercising the real `if (turn.sceneNudge) ...` line and the real
  // categorizeFrame. Returns void, matching the inner method's contract.
  jest
    .spyOn(service as unknown as { processInput(f: SensoryFrame, e?: number): Promise<void> }, 'processInput')
    .mockImplementation(async (f: SensoryFrame) => {
      const result = await processInputService.processInput(f, coldSnapshot());
      categories.push(result.inputCategory);
    });

  return { service, categories };
}

/** Invoke the private runCycleForTurn positionally. */
function runCycle(service: DecisionMakingService, turn: InboundTurn): Promise<boolean> {
  return (
    service as unknown as {
      runCycleForTurn(t: InboundTurn, epoch: number): Promise<boolean>;
    }
  ).runCycleForTurn(turn, 1);
}

function sceneNudgeTurn(): InboundTurn {
  return {
    turnId: 'scene-nudge-1',
    isGuardian: false,
    receivedAt: Date.now(),
    enqueuedAt: Date.now(),
    text: '',
    sceneNudge: true,
  } as InboundTurn;
}

function visualTurn(): InboundTurn {
  return {
    turnId: 'visual-1',
    isGuardian: false,
    receivedAt: Date.now(),
    enqueuedAt: Date.now(),
    text: '',
    sceneNudge: false,
  } as InboundTurn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TK-21 AC3 (integration) — real runCycleForTurn stamps sceneNudge → SYSTEM_TRIGGER', () => {
  afterEach(() => jest.restoreAllMocks());

  it('the PRODUCTION stamp in runCycleForTurn drives a SYSTEM_TRIGGER categorization', async () => {
    const frame = salientCalmFrame();
    const { service, categories } = makeService(frame);

    await runCycle(service, sceneNudgeTurn());

    // The real ProcessInputService saw the frame AFTER runCycleForTurn applied
    // its stamp, and categorized it SYSTEM_TRIGGER. If the production stamp line
    // (`if (turn.sceneNudge) frame.raw['system_trigger'] = true`) is removed,
    // the same frame (video+scene) categorizes MULTIMODAL_INPUT and this fails.
    expect(categories).toContain('SYSTEM_TRIGGER');
    // And the stamp is actually present on the frame the cycle processed.
    expect((frame.raw as Record<string, unknown>)['system_trigger']).toBe(true);
  });

  it('a NON-sceneNudge visual turn is NOT stamped → no SYSTEM_TRIGGER promotion', async () => {
    const frame = salientCalmFrame();
    const { service, categories } = makeService(frame);

    await runCycle(service, visualTurn());

    // Without the sceneNudge stamp, the same video+scene frame classifies by its
    // modalities (MULTIMODAL_INPUT here) — never promoted to SYSTEM_TRIGGER — and
    // carries no system_trigger marker.
    expect(categories).not.toContain('SYSTEM_TRIGGER');
    expect((frame.raw as Record<string, unknown>)['system_trigger']).toBeUndefined();
  });
});

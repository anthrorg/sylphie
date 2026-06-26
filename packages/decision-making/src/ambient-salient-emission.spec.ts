/**
 * TK-98 — END-TO-END regression for ambient-vs-salient self-initiated emission.
 *
 * Drives the REAL DecisionMakingService cycle (runCycleForTurn → processInput)
 * with a real, stateful ExecutorEngine fake and recording fakes for the three
 * collaborators the acceptance criteria turn on:
 *
 *   - responseSubject (the chat-delivery seam): how many CycleResponses emit,
 *     and with what emissionIntent.
 *   - episodicMemory.encode: did EPISODIC state update this cycle?
 *   - actionOutcomeReporter.reportOutcome via the REAL SensoryPredictionRouter:
 *     did CURIOSITY/scene drive state update this cycle?
 *
 * The three TK-98 acceptance criteria:
 *
 *   AC0  A STATIC/familiar self-tick (no inbound user turn, scene surprise below
 *        the SALIENT novelty threshold) → emissionIntent stays AMBIENT_NONE and
 *        ZERO chat deliveries are produced, WHILE curiosity/episodic state STILL
 *        updates. This is the load-bearing case: the worth-saying suppression
 *        must skip ONLY the emit, never the downstream curiosity drive routing.
 *
 *   AC1  A genuinely NEW salient scene event (scene surprise >= the novelty
 *        threshold) → stamped SALIENT_OBSERVATION and produces exactly ONE
 *        comment (not a stream).
 *
 *   AC2  A real user turn (currentTurnContext set by runCycleForTurn) → stamped
 *        USER_REPLY and a response IS produced (never gated).
 *
 * Strategy mirrors scene-nudge-run-cycle-integration.spec.ts and
 * social-comment-initiated.spec.ts: an auto-stub Proxy satisfies the deps the
 * cycle does not behaviorally depend on; targeted fakes drive the rest.
 */

import { DecisionMakingService } from './decision-making.service';
import { ProcessInputService } from './process-input/process-input.service';
import { SensoryPredictionRouterService } from './sensory/sensory-prediction-router.service';
import type { InboundTurn } from './concurrency/inbound-turn';
import { WorthSayingGate, SCENE_NOVELTY_THRESHOLD } from './monitoring/worth-saying-gate';
import {
  ExecutorState,
  EMBEDDING_DIM,
  DRIVE_INDEX_ORDER,
  type SensoryFrame,
  type SceneSnapshot,
  type DriveSnapshot,
  type CycleResponse,
  type ArbitrationResult,
} from '@sylphie/shared';

jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Frame + snapshot helpers
// ---------------------------------------------------------------------------

/** A vision-only frame (video + scene, no human text/audio) — a self-tick percept. */
function visionFrame(scene: SceneSnapshot): SensoryFrame {
  return {
    timestamp: 1,
    fused_embedding: new Array(EMBEDDING_DIM).fill(0),
    modality_embeddings: {},
    active_modalities: ['video', 'scene'],
    raw: { video: { detections: [] }, scene },
  };
}

/** A conversation frame carrying real user text (a USER_REPLY turn). */
function textFrame(text: string): SensoryFrame {
  return {
    timestamp: 1,
    fused_embedding: new Array(EMBEDDING_DIM).fill(0),
    modality_embeddings: {},
    active_modalities: ['text'],
    raw: { text },
  };
}

/** Minimal scene snapshot (the predictor fake reads totalSurprise, not this). */
function emptyScene(): SceneSnapshot {
  return { objects: [], timestamp: 1 } as unknown as SceneSnapshot;
}

/** A drive-COLD snapshot: every drive at 0.0. */
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
// Stateful ExecutorEngine fake — the pre-cycle guard requires getState()===IDLE
// and the cycle transitions through the 8 states. We just track the current one.
// ---------------------------------------------------------------------------

class FakeExecutorEngine {
  private state: ExecutorState = ExecutorState.IDLE;
  getState(): ExecutorState {
    return this.state;
  }
  transition(next: ExecutorState): void {
    this.state = next;
  }
  forceIdle(): void {
    this.state = ExecutorState.IDLE;
  }
  captureSnapshot(_s: DriveSnapshot): void {}
}

// ---------------------------------------------------------------------------
// Auto-stub for the constructor deps the cycle does not behaviorally use.
// ---------------------------------------------------------------------------

function autoStub(): never {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: () => () => undefined,
  };
  return new Proxy({}, handler) as unknown as never;
}

// ---------------------------------------------------------------------------
// Build the service with targeted fakes.
//
// `sceneSurprise` controls the predictor's totalSurprise for this cycle.
// `arbitrationType` controls what arbitration returns (SHRUG → deliberation
// fallback path, which is the realistic self-tick path).
// ---------------------------------------------------------------------------

interface Harness {
  service: DecisionMakingService;
  emitted: CycleResponse[];
  encodeCalls: number;
  driveOutcomes: Array<Record<string, unknown>>;
}

function makeService(opts: {
  sceneSurprise: number;
  responseText: string;
  arbitrationType?: 'SHRUG' | 'TYPE_2';
}): Harness {
  const emitted: CycleResponse[] = [];
  let encodeCalls = 0;
  const driveOutcomes: Array<Record<string, unknown>> = [];

  const executorEngine = new FakeExecutorEngine();

  const driveStateReader = { getCurrentState: () => coldSnapshot() };
  const streamLogger = { logFrame: () => undefined };

  // Real ProcessInputService — categorizes the frame and returns the result
  // shape the cycle destructures. null deps are fine for categorize/summarize.
  const processInputService = new ProcessInputService(null, null, null);

  const predictionService = {
    pruneStale: () => undefined,
    generatePredictions: async () => [],
  };

  const episodicMemory = {
    getRecentEpisodes: () => [],
    encode: async () => {
      encodeCalls += 1;
    },
  };

  // Scene predictor: returns a controlled totalSurprise so the worth-saying gate
  // and the scene drive router both see the same value (as production does).
  const sceneComparison = { totalSurprise: opts.sceneSurprise };
  const scenePrediction = {
    compareScene: () => sceneComparison,
    advancePredictions: () => undefined,
  };

  const sensoryPrediction = { computeErrors: () => ({}) };

  const latentSpace = {
    searchMultiModal: () => null,
    hotLayerSize: 0,
    recordUse: () => undefined,
    writeMultiModal: async () => [],
  };

  const arbitrationType = opts.arbitrationType ?? 'SHRUG';
  const arbitrationResult: ArbitrationResult =
    arbitrationType === 'SHRUG'
      ? {
          type: 'SHRUG',
          reason: 'self-tick — no confident reflex',
          shrugDetail: {
            gapTypes: ['LOW_CONFIDENCE'],
            candidateConfidences: [],
            threshold: 0.5,
            reason: 'self-tick',
          },
        }
      : ({ type: 'TYPE_2', candidate: { procedureData: null, confidence: 0.4 } } as unknown as ArbitrationResult);
  const arbitrationService = { arbitrate: async () => arbitrationResult };

  // Deliberation produces the candidate utterance. The cycle decides whether to
  // EMIT it (worth-saying gate) — that decision is what we are testing.
  const deliberation = {
    deliberate: async () => ({
      responseText: opts.responseText,
      totalTokens: { prompt: 1, completion: 1 },
      totalLatencyMs: 1,
      trace: [],
      confidence: 0.5,
      knowledgeGrounding: 'LLM_ASSISTED',
      intent: undefined,
      groundingProvenance: null,
      groundedBy: null,
      degradedNoLlm: false,
      winningCandidateFactors: [],
      actionRequest: undefined,
    }),
  };

  const recallRetrievalHelper = { computeRecallRetrieval: async () => null };

  const wkgContext = {
    getContextForFrame: async () => ({ entities: [] }),
    captureWkgSnapshot: async () => ({}),
    writeActionProcedure: async () => 'proc-1',
    reinforceFactNode: async () => null,
  };

  const attractorMonitor = {
    getRecentMAEValues: () => [],
    runDetectors: async () => [],
    recordArbitration: () => undefined,
  };

  // RECORDING actionOutcomeReporter — captures every drive outcome the cycle
  // forwards. This is the "curiosity state updated" probe.
  const actionOutcomeReporter = {
    reportOutcome: (o: Record<string, unknown>) => {
      driveOutcomes.push(o);
    },
  };

  // REAL router so the test exercises the actual curiosity-routing wire. It
  // forwards scene/sensory prediction errors to actionOutcomeReporter and calls
  // scenePrediction.recordOutcomeRouted (auto-stubbed below via the proxy).
  const sensoryPredictionRouter = new SensoryPredictionRouterService(
    actionOutcomeReporter as unknown as never,
    { recordOutcomeRouted: () => undefined } as unknown as never,
  );

  const cycleGuard = {
    register: () => undefined,
    isEpochCurrent: () => true,
    enqueue: () => undefined,
    destroy: () => undefined,
    get cycleEpoch() {
      return 1;
    },
    isSelfTickInFlight: () => false,
  };

  const tickSampler = {
    injectSyntheticText: () => undefined,
    // sample() returns the per-test frame; set below via closure swap.
    sample: async () => harnessFrame,
  };

  let harnessFrame: SensoryFrame = textFrame('placeholder');

  const service = new DecisionMakingService(
    executorEngine as unknown as never, // 0  executorEngine
    autoStub(), // 1  actionRetriever
    predictionService as unknown as never, // 2  predictionService
    arbitrationService as unknown as never, // 3  arbitrationService
    episodicMemory as unknown as never, // 4  episodicMemory
    autoStub(), // 5  confidenceUpdater
    null as unknown as never, // 6  consolidationService (Optional → null)
    autoStub(), // 7  eventLogger
    processInputService as unknown as never, // 8  processInputService (REAL)
    autoStub(), // 9  actionHandlerRegistry
    driveStateReader as unknown as never, // 10 driveStateReader
    actionOutcomeReporter as unknown as never, // 11 actionOutcomeReporter
    null as unknown as never, // 12 tensorInference (Optional → null)
    null as unknown as never, // 13 llm (Optional → null; deliberation owns LLM)
    attractorMonitor as unknown as never, // 14 attractorMonitor
    null as unknown as never, // 15 moodBleedMonitor (Optional → null)
    tickSampler as unknown as never, // 16 tickSampler
    streamLogger as unknown as never, // 17 streamLogger
    latentSpace as unknown as never, // 18 latentSpace
    wkgContext as unknown as never, // 19 wkgContext
    deliberation as unknown as never, // 20 deliberation
    sensoryPrediction as unknown as never, // 21 sensoryPrediction
    scenePrediction as unknown as never, // 22 scenePrediction
    autoStub(), // 23 modalityRegistry
    cycleGuard as unknown as never, // 24 cycleGuard
    autoStub(), // 25 tickEngine
    sensoryPredictionRouter as unknown as never, // 26 sensoryPredictionRouter (REAL)
    autoStub(), // 27 tensorCandidateBuilder
    recallRetrievalHelper as unknown as never, // 28 recallRetrievalHelper
    autoStub(), // 29 visualPresenceHabituator
  );

  // Subscribe to the chat-delivery seam.
  service.response$.subscribe((r) => emitted.push(r));

  // Expose a setter so each test installs its own frame before runCycleForTurn.
  (service as unknown as { __setFrame: (f: SensoryFrame) => void }).__setFrame = (
    f: SensoryFrame,
  ) => {
    harnessFrame = f;
  };

  return { service, emitted, get encodeCalls() { return encodeCalls; }, driveOutcomes } as unknown as Harness;
}

/** Invoke the private runCycleForTurn positionally. */
function runCycle(service: DecisionMakingService, turn: InboundTurn): Promise<boolean> {
  return (
    service as unknown as {
      runCycleForTurn(t: InboundTurn, epoch: number): Promise<boolean>;
    }
  ).runCycleForTurn(turn, 1);
}

function setFrame(service: DecisionMakingService, frame: SensoryFrame): void {
  (service as unknown as { __setFrame: (f: SensoryFrame) => void }).__setFrame(frame);
}

/** A self-initiated scene-nudge turn (currentTurnContext stays null → AMBIENT_NONE). */
function sceneNudgeTurn(turnId: string): InboundTurn {
  return {
    turnId,
    isGuardian: false,
    receivedAt: Date.now(),
    enqueuedAt: Date.now(),
    text: '',
    sceneNudge: true,
  } as InboundTurn;
}

/** A real user turn (currentTurnContext set → USER_REPLY). */
function userTurn(turnId: string, text: string): InboundTurn {
  return {
    turnId,
    userId: 'guardian',
    isGuardian: true,
    receivedAt: Date.now(),
    enqueuedAt: Date.now(),
    text,
    sceneNudge: false,
  } as InboundTurn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TK-98 — ambient vs salient self-initiated emission (end-to-end cycle)', () => {
  // A surprise BELOW the SALIENT novelty threshold but ABOVE the drive-routing
  // floor (0.05): the cycle must stay SILENT yet STILL update curiosity.
  const STATIC_SURPRISE = (SCENE_NOVELTY_THRESHOLD + 0.05) / 2; // 0.175 — < 0.30, > 0.05

  describe('AC0 — static/familiar self-tick: AMBIENT_NONE, zero deliveries, state still updates', () => {
    // CRITICAL: AC0 must exercise the WORTH-SAYING SUPPRESSION path, not the
    // empty-response path. So deliberation MUST produce a non-empty utterance
    // (arbitrationType TYPE_2 → deliberation pipeline runs) which the gate then
    // SUPPRESSES because the scene is static (surprise < novelty threshold) and
    // the content is ungrounded. This is exactly the case the early-`return` bug
    // dropped curiosity routing on.
    it('produces ZERO chat deliveries (worth-saying suppressed a real utterance)', async () => {
      const h = makeService({
        sceneSurprise: STATIC_SURPRISE,
        responseText: 'the room looks the same',
        arbitrationType: 'TYPE_2',
      });
      setFrame(h.service, visionFrame(emptyScene()));

      await runCycle(h.service, sceneNudgeTurn('static-1'));

      expect(h.emitted.length).toBe(0);
    });

    it('STILL encodes an episode (episodic state updates despite suppression)', async () => {
      const h = makeService({
        sceneSurprise: STATIC_SURPRISE,
        responseText: 'the room looks the same',
        arbitrationType: 'TYPE_2',
      });
      setFrame(h.service, visionFrame(emptyScene()));

      await runCycle(h.service, sceneNudgeTurn('static-2'));

      // episodicMemory.encode ran upstream of the emit gate.
      expect(h.encodeCalls).toBeGreaterThanOrEqual(1);
    });

    it('STILL routes scene surprise to the drives (curiosity state updates despite suppression)', async () => {
      const h = makeService({
        sceneSurprise: STATIC_SURPRISE,
        responseText: 'the room looks the same',
        arbitrationType: 'TYPE_2',
      });
      setFrame(h.service, visionFrame(emptyScene()));

      await runCycle(h.service, sceneNudgeTurn('static-3'));

      // The REAL SensoryPredictionRouter forwarded a ScenePrediction outcome —
      // this is the curiosity/drive update AC0 requires. The PRE-FIX early
      // `return` skipped this entirely; this assertion is the regression guard.
      const sceneOutcomes = h.driveOutcomes.filter((o) => o['actionType'] === 'ScenePrediction');
      expect(sceneOutcomes.length).toBe(1);
      expect((sceneOutcomes[0]['metadata'] as Record<string, unknown>)['sceneSurprise']).toBeCloseTo(
        STATIC_SURPRISE,
        5,
      );
    });
  });

  describe('AC1 — genuinely NEW salient event: exactly one SALIENT_OBSERVATION', () => {
    it('emits exactly ONE comment stamped SALIENT_OBSERVATION', async () => {
      // Surprise at/above the novelty threshold → worth saying. A novel scene
      // drives a TYPE_2 deliberation (the realistic self-tick path that PRODUCES
      // an utterance for the worth-saying gate to then evaluate).
      const h = makeService({
        sceneSurprise: 0.6,
        responseText: 'something new just appeared',
        arbitrationType: 'TYPE_2',
      });
      setFrame(h.service, visionFrame(emptyScene()));

      await runCycle(h.service, sceneNudgeTurn('novel-1'));

      expect(h.emitted.length).toBe(1);
      expect(h.emitted[0].emissionIntent).toBe('SALIENT_OBSERVATION');
      // Self-initiated → no originator on the emitted response.
      expect(h.emitted[0].originator).toBeUndefined();
    });

    it('a REPEAT of the same novel line on a second cycle is content-deduped (no stream)', async () => {
      const h = makeService({
        sceneSurprise: 0.6,
        responseText: 'something new just appeared',
        arbitrationType: 'TYPE_2',
      });

      setFrame(h.service, visionFrame(emptyScene()));
      await runCycle(h.service, sceneNudgeTurn('novel-2a'));

      // Second cycle, SAME high surprise, SAME response text → dedup suppresses it.
      setFrame(h.service, visionFrame(emptyScene()));
      await runCycle(h.service, sceneNudgeTurn('novel-2b'));

      // Exactly one emission total — novelty fires once, the repeat is deduped.
      expect(h.emitted.length).toBe(1);
      expect(h.emitted[0].emissionIntent).toBe('SALIENT_OBSERVATION');
    });
  });

  describe('AC2 — real user turn: USER_REPLY served (never gated)', () => {
    it('emits a USER_REPLY response for an inbound user turn', async () => {
      // Even with ZERO scene surprise, a user turn must be answered.
      const h = makeService({ sceneSurprise: 0, responseText: 'yes, I hear you' });
      setFrame(h.service, textFrame('are you there?'));

      await runCycle(h.service, userTurn('user-1', 'are you there?'));

      expect(h.emitted.length).toBe(1);
      expect(h.emitted[0].emissionIntent).toBe('USER_REPLY');
      // User turns carry the originator (guardian identity).
      expect(h.emitted[0].originator).toBeDefined();
      expect(h.emitted[0].text).toBe('yes, I hear you');
    });
  });

  describe('worth-saying gate unit invariants (supporting AC0/AC1)', () => {
    it('USER_REPLY bypasses the gate', () => {
      const gate = new WorthSayingGate();
      const r = gate.evaluate({
        emissionIntent: 'USER_REPLY',
        responseText: 'hi',
        cachedSceneSurprise: 0,
        responseGrounding: 'LLM_ASSISTED',
      });
      expect(r.worthSaying).toBe(true);
      expect(r.intent).toBe('USER_REPLY');
    });

    it('AMBIENT_NONE static input (low surprise, ungrounded) is suppressed', () => {
      const gate = new WorthSayingGate();
      const r = gate.evaluate({
        emissionIntent: 'AMBIENT_NONE',
        responseText: 'nothing new',
        cachedSceneSurprise: STATIC_SURPRISE,
        responseGrounding: 'LLM_ASSISTED',
      });
      expect(r.worthSaying).toBe(false);
      expect(r.intent).toBe('AMBIENT_NONE');
    });

    it('AMBIENT_NONE with novel surprise is promoted to SALIENT_OBSERVATION', () => {
      const gate = new WorthSayingGate();
      const r = gate.evaluate({
        emissionIntent: 'AMBIENT_NONE',
        responseText: 'a new object appeared',
        cachedSceneSurprise: SCENE_NOVELTY_THRESHOLD + 0.1,
        responseGrounding: 'LLM_ASSISTED',
      });
      expect(r.worthSaying).toBe(true);
      expect(r.intent).toBe('SALIENT_OBSERVATION');
    });
  });
});

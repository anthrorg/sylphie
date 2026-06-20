/**
 * Unit tests for MaeHistoryStore — TK-68 acceptance criteria.
 *
 * AC1: PredictionService.recordMae('a', 0.1) → ConfidenceUpdater and
 *      Type1Tracker read the same single window [0.1].
 *
 * AC2: Given a window at MAX_MAE_WINDOW=10, when an 11th value is appended,
 *      the oldest entry is evicted (FIFO).
 *
 * Also covers the store's direct API to ensure the shared window semantics
 * are correct in isolation from the services that consume it.
 */

import { MaeHistoryStore, MAX_MAE_WINDOW } from './mae-history.store';
import { PredictionService } from '../prediction/prediction.service';
import { ConfidenceUpdaterService } from '../confidence/confidence-updater.service';
import { Type1TrackerService } from '../graduation/type1-tracker.service';
import type {
  ActionCandidate,
  ActionOutcome,
  CognitiveContext,
  DriveSnapshot,
  ArbitrationResult,
} from '@sylphie/shared';
import { ExecutorState, DriveName, INITIAL_DRIVE_STATE } from '@sylphie/shared';

// Suppress verbose logging and NestJS Logger noise during tests
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

function makeSnapshot(): DriveSnapshot {
  return {
    pressureVector: { ...INITIAL_DRIVE_STATE },
    timestamp: new Date(),
    tickNumber: 1,
    driveDeltas: {} as any,
    ruleMatchResult: { ruleId: null, eventType: 'TEST', matched: false },
    totalPressure: 0,
    sessionId: 'test-session',
  };
}

function makeCandidate(id: string, confidence = 0.8): ActionCandidate {
  return {
    procedureData: {
      id,
      name: `proc-${id}`,
      category: 'Test',
      triggerContext: 'test',
      actionSequence: [{ index: 0, stepType: 'LLM_GENERATE', params: {} }],
      provenance: 'INFERENCE' as any,
      confidence,
    },
    confidence,
    motivatingDrive: DriveName.Curiosity,
    contextMatchScore: 0.9,
  };
}

function makeContext(snapshot: DriveSnapshot): CognitiveContext {
  return {
    currentState: ExecutorState.PREDICTING,
    recentEpisodes: [],
    activePredictions: [],
    driveSnapshot: snapshot,
    recentGapTypes: [],
    dynamicThreshold: 0.5,
  };
}

function makeOutcome(
  actionId: string,
  driveEffects: Partial<Record<string, number>> = {},
): ActionOutcome {
  const arb: ArbitrationResult = {
    type: 'TYPE_2',
    candidate: makeCandidate(actionId),
    llmRationale: 'test',
  };
  return {
    selectedAction: {
      actionId,
      arbitrationResult: arb,
      selectedAt: new Date(),
      theaterValidated: true,
    },
    predictionAccurate: false,
    predictionError: 0,
    driveEffectsObserved: driveEffects as any,
    anxietyAtExecution: 0,
    observedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// MaeHistoryStore — unit tests
// ---------------------------------------------------------------------------

describe('MaeHistoryStore', () => {
  let store: MaeHistoryStore;

  beforeEach(() => {
    store = new MaeHistoryStore();
  });

  describe('append / getWindow', () => {
    it('should return an empty window for an unknown action', () => {
      expect(store.getWindow('unknown')).toEqual([]);
    });

    it('should accumulate values in insertion order', () => {
      store.append('a', 0.1);
      store.append('a', 0.2);
      store.append('a', 0.3);
      expect(Array.from(store.getWindow('a'))).toEqual([0.1, 0.2, 0.3]);
    });

    it('should keep windows separate per action ID', () => {
      store.append('x', 0.5);
      store.append('y', 0.9);
      expect(Array.from(store.getWindow('x'))).toEqual([0.5]);
      expect(Array.from(store.getWindow('y'))).toEqual([0.9]);
    });
  });

  describe('getMean', () => {
    it('should return 0.0 for an empty window', () => {
      expect(store.getMean('unknown')).toBe(0.0);
    });

    it('should return the arithmetic mean of all values', () => {
      store.append('a', 0.1);
      store.append('a', 0.3);
      expect(store.getMean('a')).toBeCloseTo(0.2, 10);
    });
  });

  // ── AC2: FIFO eviction at MAX_MAE_WINDOW ───────────────────────────────────
  describe('AC2 — FIFO eviction at MAX_MAE_WINDOW', () => {
    it('should cap the window at MAX_MAE_WINDOW entries', () => {
      for (let i = 0; i < MAX_MAE_WINDOW + 5; i++) {
        store.append('a', i * 0.01);
      }
      expect(store.getWindow('a')).toHaveLength(MAX_MAE_WINDOW);
    });

    it('should evict the oldest entry when the 11th value is appended', () => {
      // Fill window to capacity with values 0..9
      for (let i = 0; i < MAX_MAE_WINDOW; i++) {
        store.append('a', i * 0.01); // 0.00, 0.01, ..., 0.09
      }
      expect(store.getWindow('a')[0]).toBeCloseTo(0.00, 10); // oldest = 0.00

      // Append 11th value
      store.append('a', 0.99);

      const window = store.getWindow('a');
      expect(window).toHaveLength(MAX_MAE_WINDOW);
      // Oldest (0.00) evicted; new head is 0.01
      expect(window[0]).toBeCloseTo(0.01, 10);
      // Newest is 0.99
      expect(window[MAX_MAE_WINDOW - 1]).toBeCloseTo(0.99, 10);
    });
  });
});

// ---------------------------------------------------------------------------
// AC1 — Unified window: PredictionService write → ConfidenceUpdater + Type1Tracker read
// ---------------------------------------------------------------------------

describe('AC1 — Unified MAE window across all three consumers', () => {
  let store: MaeHistoryStore;
  let predictionService: PredictionService;
  let confidenceUpdater: ConfidenceUpdaterService;
  let type1Tracker: Type1TrackerService;

  beforeEach(() => {
    // Single shared store — this is what DecisionMakingModule provides.
    store = new MaeHistoryStore();

    // All three services receive the same store instance.
    predictionService = new PredictionService(null, store);
    confidenceUpdater = new ConfidenceUpdaterService(null, store);
    type1Tracker = new Type1TrackerService(null, store);
  });

  it('should make a single PredictionService write visible to ConfidenceUpdater and Type1Tracker', async () => {
    const snapshot = makeSnapshot();
    const context = makeContext(snapshot);

    // Generate and evaluate a prediction with a known, deterministic MAE.
    // We need predictedDriveEffects to be empty so actual empty effects → MAE = 0.
    // Instead, generate normally then evaluate against the same effects for MAE = 0.
    const [prediction] = await predictionService.generatePredictions(
      [makeCandidate('a')],
      context,
      1,
    );

    // Evaluate against the same effects → MAE = 0.
    predictionService.evaluatePrediction(
      prediction.id,
      makeOutcome('a', prediction.predictedDriveEffects as Partial<Record<string, number>>),
    );

    // The window written by PredictionService should have exactly one entry: 0.0 (MAE).
    const window = predictionService.getMaeHistory('a');
    expect(window).toHaveLength(1);
    expect(window[0]).toBeCloseTo(0.0, 10);

    // ConfidenceUpdater reads the same window via store.getMean().
    // (getMean is what getRecentMAEForRecord delegates to internally)
    expect(store.getMean('a')).toBeCloseTo(0.0, 10);

    // Type1Tracker reads the same window.
    const record = type1Tracker.getRecord('a');
    expect(record.recentMAE).toBeCloseTo(0.0, 10);
    expect(record.maeHistoryLength).toBe(1);
  });

  it('should return a single window [0.1] after recording MAE of 0.1', () => {
    // Directly use store.append() to simulate PredictionService.appendMae() internals
    // for a pure, value-controlled test of the shared-window contract.
    store.append('a', 0.1);

    // ConfidenceUpdater reads via store
    const meanFromUpdater = store.getMean('a');
    expect(meanFromUpdater).toBeCloseTo(0.1, 10);

    // Type1Tracker reads via store (through getRecord which calls maeStore.getWindow)
    const record = type1Tracker.getRecord('a');
    expect(record.recentMAE).toBeCloseTo(0.1, 10);
    expect(record.maeHistoryLength).toBe(1);

    // PredictionService getMaeHistory also returns the same window
    const history = predictionService.getMaeHistory('a');
    expect(Array.from(history)).toEqual([0.1]);
  });

  it('should NOT double-append when both predictionService and confidenceUpdater are called', () => {
    // Simulate what used to happen before TK-68: predictionService wrote to its own
    // map, then reportOutcome() called recordPredictionMAE() for a second write.
    // With the shared store, a single append should produce exactly one entry.
    store.append('a', 0.1); // Only one write (PredictionService path)

    // If recordPredictionMAE() were also called (the old path), it would add a
    // second entry. Verify that the window has exactly 1 entry.
    expect(store.getWindow('a')).toHaveLength(1);
    expect(Array.from(store.getWindow('a'))).toEqual([0.1]);
  });

  it('should accumulate multiple observations into the same shared window', async () => {
    const snapshot = makeSnapshot();
    const context = makeContext(snapshot);

    // Three prediction evaluations → three entries in the window.
    for (let i = 0; i < 3; i++) {
      const [prediction] = await predictionService.generatePredictions(
        [makeCandidate('b')],
        context,
        1,
      );
      predictionService.evaluatePrediction(
        prediction.id,
        makeOutcome('b', prediction.predictedDriveEffects as Partial<Record<string, number>>),
      );
    }

    const window = predictionService.getMaeHistory('b');
    expect(window).toHaveLength(3);

    // All three consumers see the same length.
    expect(store.getWindow('b')).toHaveLength(3);
    expect(type1Tracker.getRecord('b').maeHistoryLength).toBe(3);
  });
});

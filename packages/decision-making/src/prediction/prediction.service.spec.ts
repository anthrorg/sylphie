/**
 * Unit tests for PredictionService — generation, evaluation, lookup, and pruning.
 *
 * Covers:
 *   1. generatePredictions creates predictions for top N candidates
 *   2. evaluatePrediction computes correct MAE against real outcomes
 *   3. evaluatePrediction marks accurate when MAE < 0.10
 *   4. getActivePredictionIdForAction finds prediction by procedure ID
 *   5. pruneStale removes predictions older than the cutoff
 *   6. getMaeHistory returns per-action rolling MAE window
 *   7. evaluatePrediction throws for unknown prediction IDs
 */

import { PredictionService } from './prediction.service';
import type {
  ActionCandidate,
  ActionOutcome,
  CognitiveContext,
  DriveSnapshot,
  Episode,
  ArbitrationResult,
} from '@sylphie/shared';
import { ExecutorState, DriveName, INITIAL_DRIVE_STATE } from '@sylphie/shared';

// Suppress verbose logging during tests
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

function makeSnapshot(overrides: Partial<DriveSnapshot> = {}): DriveSnapshot {
  return {
    pressureVector: { ...INITIAL_DRIVE_STATE },
    timestamp: new Date(),
    tickNumber: 1,
    driveDeltas: {} as any,
    ruleMatchResult: { ruleId: null, eventType: 'TEST', matched: false },
    totalPressure: 0,
    sessionId: 'test-session',
    ...overrides,
  };
}

function makeCandidate(id: string, confidence = 0.8): ActionCandidate {
  return {
    procedureData: {
      id,
      name: `test-proc-${id}`,
      category: 'TestCategory',
      triggerContext: 'test-context',
      actionSequence: [{ index: 0, stepType: 'LLM_GENERATE', params: {} }],
      provenance: 'INFERENCE' as any,
      confidence,
      driveEffects: {},
    },
    confidence,
    motivatingDrive: DriveName.Curiosity,
    contextMatchScore: 0.9,
  };
}

function makeContext(
  snapshot: DriveSnapshot,
  episodes: readonly Episode[] = [],
): CognitiveContext {
  return {
    currentState: ExecutorState.PREDICTING,
    recentEpisodes: episodes,
    activePredictions: [],
    driveSnapshot: snapshot,
    recentGapTypes: [],
    dynamicThreshold: 0.50,
  };
}

function makeOutcome(
  actionId: string,
  driveEffects: Partial<Record<string, number>> = {},
): ActionOutcome {
  const arbitrationResult: ArbitrationResult = {
    type: 'TYPE_2',
    candidate: makeCandidate(actionId),
    reason: 'test',
  };
  return {
    selectedAction: {
      actionId,
      arbitrationResult,
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
// Tests
// ---------------------------------------------------------------------------

describe('PredictionService', () => {
  let service: PredictionService;

  beforeEach(() => {
    // No event logger — @Optional injection
    service = new PredictionService(null);
  });

  describe('generatePredictions', () => {
    it('should generate predictions for each candidate up to maxCandidates', async () => {
      const snapshot = makeSnapshot();
      const candidates = [makeCandidate('a'), makeCandidate('b'), makeCandidate('c'), makeCandidate('d')];
      const context = makeContext(snapshot);

      const predictions = await service.generatePredictions(candidates, context, 3);

      expect(predictions).toHaveLength(3);
      expect(predictions[0].actionCandidate.procedureData!.id).toBe('a');
      expect(predictions[1].actionCandidate.procedureData!.id).toBe('b');
      expect(predictions[2].actionCandidate.procedureData!.id).toBe('c');
    });

    it('should return empty array for no candidates', async () => {
      const context = makeContext(makeSnapshot());
      const predictions = await service.generatePredictions([], context);
      expect(predictions).toHaveLength(0);
    });

    it('should discount confidence by 0.8', async () => {
      const candidate = makeCandidate('a', 0.9);
      const context = makeContext(makeSnapshot());

      const [prediction] = await service.generatePredictions([candidate], context, 1);

      expect(prediction.confidence).toBeCloseTo(0.72, 4);
    });

    it('should generate random core-drive deltas when no episodes match', async () => {
      const context = makeContext(makeSnapshot());
      const [prediction] = await service.generatePredictions([makeCandidate('a')], context, 1);

      // Should have some drive effect keys
      expect(Object.keys(prediction.predictedDriveEffects).length).toBeGreaterThan(0);
    });
  });

  describe('evaluatePrediction', () => {
    it('should compute correct MAE for matching drive keys', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext(snapshot);
      const [prediction] = await service.generatePredictions([makeCandidate('a')], context, 1);

      // Override predictedDriveEffects for deterministic test via manual prediction store manipulation
      // Instead, use the outcome with known values to test the MAE formula
      const outcome = makeOutcome('a', prediction.predictedDriveEffects);

      // Same effects → MAE should be 0
      const evaluation = service.evaluatePrediction(prediction.id, outcome);
      expect(evaluation.mae).toBeCloseTo(0, 4);
      expect(evaluation.accurate).toBe(true);
    });

    it('should compute non-zero MAE when predicted and actual differ', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext(snapshot);
      const [prediction] = await service.generatePredictions([makeCandidate('a')], context, 1);

      // Set actual to large values that differ from predicted
      const driveEffects: Record<string, number> = {};
      for (const key of Object.keys(prediction.predictedDriveEffects)) {
        driveEffects[key] = (prediction.predictedDriveEffects[key] ?? 0) + 0.5;
      }

      const outcome = makeOutcome('a', driveEffects);
      const evaluation = service.evaluatePrediction(prediction.id, outcome);

      // Each drive differs by exactly 0.5, so MAE = 0.5
      expect(evaluation.mae).toBeCloseTo(0.5, 4);
      expect(evaluation.accurate).toBe(false);
    });

    it('should mark accurate when MAE < 0.10', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext(snapshot);
      const [prediction] = await service.generatePredictions([makeCandidate('a')], context, 1);

      // Small offset from predicted
      const driveEffects: Record<string, number> = {};
      for (const key of Object.keys(prediction.predictedDriveEffects)) {
        driveEffects[key] = (prediction.predictedDriveEffects[key] ?? 0) + 0.05;
      }

      const outcome = makeOutcome('a', driveEffects);
      const evaluation = service.evaluatePrediction(prediction.id, outcome);

      expect(evaluation.mae).toBeCloseTo(0.05, 4);
      expect(evaluation.accurate).toBe(true);
    });

    it('should throw for unknown prediction ID', () => {
      expect(() => {
        service.evaluatePrediction('nonexistent-id', makeOutcome('a'));
      }).toThrow('not found');
    });

    it('should remove prediction from active store after evaluation', async () => {
      const context = makeContext(makeSnapshot());
      const [prediction] = await service.generatePredictions([makeCandidate('a')], context, 1);

      service.evaluatePrediction(prediction.id, makeOutcome('a'));

      // Second evaluation should throw — prediction was removed
      expect(() => {
        service.evaluatePrediction(prediction.id, makeOutcome('a'));
      }).toThrow('not found');
    });
  });

  describe('getActivePredictionIdForAction', () => {
    it('should find prediction by action ID', async () => {
      const context = makeContext(makeSnapshot());
      await service.generatePredictions(
        [makeCandidate('action-x'), makeCandidate('action-y')],
        context,
        2,
      );

      const id = service.getActivePredictionIdForAction('action-y');
      expect(id).not.toBeNull();
      expect(typeof id).toBe('string');
    });

    it('should return null for unknown action ID', async () => {
      const context = makeContext(makeSnapshot());
      await service.generatePredictions([makeCandidate('action-x')], context, 1);

      expect(service.getActivePredictionIdForAction('unknown')).toBeNull();
    });

    it('should return null after prediction is evaluated', async () => {
      const context = makeContext(makeSnapshot());
      const [prediction] = await service.generatePredictions([makeCandidate('a')], context, 1);

      service.evaluatePrediction(prediction.id, makeOutcome('a'));

      expect(service.getActivePredictionIdForAction('a')).toBeNull();
    });
  });

  describe('pruneStale', () => {
    it('should remove predictions older than the cutoff', async () => {
      const context = makeContext(makeSnapshot());
      await service.generatePredictions([makeCandidate('old')], context, 1);

      // Prune with 0ms cutoff — everything is stale
      service.pruneStale(0);

      expect(service.getActivePredictionIdForAction('old')).toBeNull();
    });

    it('should keep recent predictions', async () => {
      const context = makeContext(makeSnapshot());
      await service.generatePredictions([makeCandidate('recent')], context, 1);

      // Prune with 60s cutoff — just generated, should survive
      service.pruneStale(60_000);

      expect(service.getActivePredictionIdForAction('recent')).not.toBeNull();
    });
  });

  describe('getMaeHistory', () => {
    it('should return empty array for unknown action', () => {
      expect(service.getMaeHistory('unknown')).toEqual([]);
    });

    it('should accumulate MAE values per action', async () => {
      const context = makeContext(makeSnapshot());

      for (let i = 0; i < 3; i++) {
        const [prediction] = await service.generatePredictions(
          [makeCandidate('action-a')],
          context,
          1,
        );
        service.evaluatePrediction(prediction.id, makeOutcome('action-a'));
      }

      const history = service.getMaeHistory('action-a');
      expect(history).toHaveLength(3);
    });

    it('should cap at 10 entries', async () => {
      const context = makeContext(makeSnapshot());

      for (let i = 0; i < 15; i++) {
        const [prediction] = await service.generatePredictions(
          [makeCandidate('action-b')],
          context,
          1,
        );
        service.evaluatePrediction(prediction.id, makeOutcome('action-b'));
      }

      const history = service.getMaeHistory('action-b');
      expect(history).toHaveLength(10);
    });
  });
});

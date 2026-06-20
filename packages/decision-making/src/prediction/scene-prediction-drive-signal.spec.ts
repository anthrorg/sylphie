/**
 * TK-22 (P4.3) — the ScenePrediction DRIVE SIGNAL contract.
 *
 * routeScenePredictionErrors (SensoryPredictionRouterService) is the SOLE place
 * scene surprise reaches the drive engine. This spec pins that emit path as a
 * SIGNAL that is independent of the gateway's cycle TRIGGER (the cooldown seam
 * exercised in perception-scene-nudge.gateway.spec.ts):
 *
 *   AC1 — a comparison with totalSurprise >= 0.05 emits exactly one
 *         ActionOutcome (actionType 'ScenePrediction', metadata.sceneSurprise in
 *         [0, 1]) to the drive engine; a sub-threshold (<0.05) comparison emits
 *         nothing (the SIGNAL is gated on surprise magnitude, NOT on the cycle
 *         that ran it).
 *   AC3 — the emitted payload's metadata is non-null and passes a strict()
 *         schema (no stray keys), and the routed value's drive effects are
 *         pressure-only (no relief). ScenePrediction is pressure-only by
 *         construction (Curiosity=+0.02*s, Anxiety=+0.01*s). The drive-engine
 *         rule-table half of AC3 — that the EXACT emitted payload yields zero
 *         relief through computeDefaultAffect across [0,1] — is owned by
 *         drive-engine/src/constants/scene-prediction-relief.spec.ts (the rule
 *         table is internal to that module and not reachable across the barrel).
 *
 * AD-0004: no new IPC, no new field — these assertions are made against the
 * EXISTING reportOutcome payload, not a new seam.
 *
 * EP7-B (TK-32): routeScenePredictionErrors was extracted from DecisionMakingService
 * into SensoryPredictionRouterService. The test now constructs the router directly —
 * two meaningful params (actionOutcomeReporter + scenePrediction), no auto-stub noise.
 */

import { z } from 'zod';
import { SensoryPredictionRouterService } from '../sensory/sensory-prediction-router.service';
import { ScenePredictionService } from './scene-prediction.service';
import type { ScenePredictionResult } from './scene-prediction.service';
import type { ActionOutcomePayload } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Captured {
  payloads: ActionOutcomePayload[];
}

/**
 * Construct SensoryPredictionRouterService with a recording actionOutcomeReporter
 * and a real ScenePredictionService so recordOutcomeRouted() runs honestly.
 */
function makeService(): { service: SensoryPredictionRouterService; captured: Captured } {
  const captured: Captured = { payloads: [] };
  const actionOutcomeReporter = {
    reportOutcome: (p: ActionOutcomePayload) => {
      captured.payloads.push(p);
    },
  };
  const scenePrediction = new ScenePredictionService();

  const service = new SensoryPredictionRouterService(
    actionOutcomeReporter as unknown as never,
    scenePrediction,
  );

  return { service, captured };
}

/** Invoke routeScenePredictionErrors with a result + dummy snapshot. */
function route(service: SensoryPredictionRouterService, result: ScenePredictionResult): void {
  service.routeScenePredictionErrors(result, { sessionId: 's', pressureVector: {} } as never);
}

/** A ScenePredictionResult carrying a given aggregate surprise. */
function resultWithSurprise(totalSurprise: number): ScenePredictionResult {
  return { errors: [], totalSurprise, novelObjects: [], missingObjects: [] };
}

/**
 * Strict schema for the ScenePrediction metadata the drive engine consumes.
 * `.strict()` rejects any stray key (AD-0004: ONLY sceneSurprise is carried).
 * sceneSurprise must be a real number clamped to [0, 1].
 */
const sceneMetadataSchema = z
  .object({ sceneSurprise: z.number().min(0).max(1) })
  .strict();

// ---------------------------------------------------------------------------
// AC1 — the SIGNAL fires (and only when surprise crosses threshold)
// ---------------------------------------------------------------------------

describe('routeScenePredictionErrors — ScenePrediction signal emit (AC1)', () => {
  it('emits exactly one ScenePrediction ActionOutcome with metadata.sceneSurprise in [0,1] when surprise >= 0.05', () => {
    const { service, captured } = makeService();

    route(service, resultWithSurprise(0.42));

    expect(captured.payloads).toHaveLength(1);
    const p = captured.payloads[0];
    expect(p.actionType).toBe('ScenePrediction');
    expect(p.metadata?.sceneSurprise).toBe(0.42);
    expect(p.metadata!.sceneSurprise!).toBeGreaterThanOrEqual(0);
    expect(p.metadata!.sceneSurprise!).toBeLessThanOrEqual(1);
  });

  it('fires at the 0.05 threshold boundary (inclusive)', () => {
    const { service, captured } = makeService();
    route(service, resultWithSurprise(0.05));
    expect(captured.payloads).toHaveLength(1);
    expect(captured.payloads[0].metadata?.sceneSurprise).toBe(0.05);
  });

  it('does NOT emit a signal below the 0.05 surprise threshold', () => {
    const { service, captured } = makeService();
    route(service, resultWithSurprise(0.049));
    expect(captured.payloads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — drive-events contract: non-null, strict-valid sceneSurprise, zero relief
// ---------------------------------------------------------------------------

describe('routeScenePredictionErrors — drive-events contract (AC3)', () => {
  // Sample across the surprise range above threshold, including the [0,1] ceiling.
  const surprises = [0.05, 0.2, 0.5, 0.99, 1.0];

  it.each(surprises)(
    'emits non-null sceneSurprise that passes strict() validation at surprise=%p',
    (s) => {
      const { service, captured } = makeService();
      route(service, resultWithSurprise(s));

      expect(captured.payloads).toHaveLength(1);
      const meta = captured.payloads[0].metadata;
      expect(meta).toBeDefined();
      expect(meta?.sceneSurprise).not.toBeNull();
      // .strict() rejects extra keys; AD-0004 says ONLY sceneSurprise is carried.
      expect(() => sceneMetadataSchema.parse(meta)).not.toThrow();
    },
  );

  it.each(surprises)(
    'records the routed outcome with strictly-positive (pressure-only) drive effects at surprise=%p',
    (s) => {
      const captured: ActionOutcomePayload[] = [];
      const scenePrediction = new ScenePredictionService();
      const service = makeServiceWith(scenePrediction, captured);

      route(service, resultWithSurprise(s));

      // The drive-engine rule-table relief invariant (ScenePrediction yields zero
      // relief through computeDefaultAffect across [0,1]) is owned and proven in
      // drive-engine/src/constants/rules.spec.ts. Here we assert the SAME pressure
      // sign on the value the cycle actually routed: the predictor's recorded
      // computedEffects mirror the rule table (curiosity=0.02*s, anxiety=0.01*s),
      // so neither axis is ever a relief (negative) delta.
      const routed = scenePrediction.getState().lastRoutedOutcome;
      expect(routed).not.toBeNull();
      expect(routed!.computedEffects.curiosity).toBeGreaterThanOrEqual(0);
      expect(routed!.computedEffects.anxiety).toBeGreaterThanOrEqual(0);
    },
  );
});

// ---------------------------------------------------------------------------
// trigger-vs-signal: the SIGNAL is driven by the comparison, not the gateway.
// recordOutcomeRouted runs on the REAL predictor so the gate seam reflects the
// value actually sent (the same number a sceneNudge-triggered cycle would emit).
// ---------------------------------------------------------------------------

describe('routeScenePredictionErrors — signal is independent of the cycle trigger', () => {
  it('records the routed outcome on the real predictor with matching sceneSurprise', () => {
    const captured: ActionOutcomePayload[] = [];
    const scenePrediction = new ScenePredictionService();
    const service = makeServiceWith(scenePrediction, captured);

    route(service, resultWithSurprise(0.42));

    const state = scenePrediction.getState();
    expect(state.lastRoutedOutcome).not.toBeNull();
    expect(state.lastRoutedOutcome!.sceneSurprise).toBe(0.42);
    // The deterministic drive effects the gate asserts on are strictly positive
    // (curiosity=0.02*s, anxiety=0.01*s) — pressure, never relief.
    expect(state.lastRoutedOutcome!.computedEffects.curiosity).toBeGreaterThan(0);
    expect(state.lastRoutedOutcome!.computedEffects.anxiety).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — sensory prediction errors (routeSensoryPredictionErrors)
// ---------------------------------------------------------------------------

describe('routeSensoryPredictionErrors — SensoryPrediction signal emit (AC2)', () => {
  it('emits exactly one SensoryPrediction ActionOutcome when total error >= 0.05', () => {
    const { service, captured } = makeService();
    service.routeSensoryPredictionErrors(
      { text: 0.3, audio: 0.1 },
      { sessionId: 's', pressureVector: {} } as never,
    );
    expect(captured.payloads).toHaveLength(1);
    const p = captured.payloads[0];
    expect(p.actionType).toBe('SensoryPrediction');
    expect(p.metadata?.sensoryPredictionError).toBeCloseTo(0.4);
  });

  it('does NOT emit when total error is below 0.05', () => {
    const { service, captured } = makeService();
    service.routeSensoryPredictionErrors(
      { text: 0.02, audio: 0.02 },
      { sessionId: 's', pressureVector: {} } as never,
    );
    expect(captured.payloads).toHaveLength(0);
  });

  it('marks success=true when total error < 0.3, false otherwise', () => {
    const { service, captured } = makeService();

    service.routeSensoryPredictionErrors({ text: 0.1 }, { sessionId: 's', pressureVector: {} } as never);
    expect(captured.payloads[0].success).toBe(true);

    captured.payloads.length = 0;
    service.routeSensoryPredictionErrors({ text: 0.5 }, { sessionId: 's', pressureVector: {} } as never);
    expect(captured.payloads[0].success).toBe(false);
  });
});

/** Construct router with caller-owned predictor + capture array. */
function makeServiceWith(
  scenePrediction: ScenePredictionService,
  captured: ActionOutcomePayload[],
): SensoryPredictionRouterService {
  const actionOutcomeReporter = {
    reportOutcome: (p: ActionOutcomePayload) => {
      captured.push(p);
    },
  };
  return new SensoryPredictionRouterService(
    actionOutcomeReporter as unknown as never,
    scenePrediction,
  );
}

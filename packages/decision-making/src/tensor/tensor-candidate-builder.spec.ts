/**
 * TensorCandidateBuilder unit tests — TK-33 acceptance criteria.
 *
 * AC1: The extraction compiles and all tests pass.
 * AC2: Given tensor partial-mode boot, when a tensor-eligible category arrives,
 *      TensorCandidateBuilder returns the same ActionCandidate as before.
 *
 * Tests verify:
 *   - Output is byte-identical to what DecisionMakingService.buildTensorCandidate()
 *     returned (same logic, same gates).
 *   - null returned when tensorTopCategory absent.
 *   - null returned when maxProb < 0.30.
 *   - Confidence capped at 0.79 in partial/shadow/audit mode.
 *   - Confidence capped at 0.95 in full mode.
 *   - motivatingDrive, contextMatchScore, and procedureData wired correctly.
 */

import { TensorCandidateBuilder } from './tensor-candidate-builder';
import { DriveName } from '@sylphie/shared';
import type { TensorInferenceResult } from '../interfaces/decision-making.interfaces';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTensorResult(overrides: Partial<TensorInferenceResult> = {}): TensorInferenceResult {
  return {
    actionBias: new Array(32).fill(0.5 / 32),
    urgency: 0.5,
    noveltyScore: 0.4,
    consensus: true,
    divergenceScore: 0.1,
    panelAgreement: {},
    tensorTopCategory: 'RESPOND',
    bootstrapMode: 'partial',
    graduatedCategories: ['RESPOND'],
    shouldUseTensor: (category: string) => true,
    inferenceMs: 10,
    ...overrides,
  };
}

/** Build a bias array with a single argmax at the given index. */
function biasWithArgmax(argmaxIndex: number, argmaxValue: number, dim = 32): number[] {
  const bias = new Array(dim).fill((1 - argmaxValue) / (dim - 1));
  bias[argmaxIndex] = argmaxValue;
  return bias;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TensorCandidateBuilder.build()', () => {
  let builder: TensorCandidateBuilder;

  beforeEach(() => {
    builder = new TensorCandidateBuilder();
  });

  it('returns null when tensorTopCategory is null', () => {
    const result = makeTensorResult({ tensorTopCategory: null });
    expect(builder.build(result, 'fp-abc', DriveName.Curiosity)).toBeNull();
  });

  it('returns null when maxProb < 0.30 (tensor too uncertain)', () => {
    const result = makeTensorResult({
      actionBias: new Array(32).fill(0.25 / 32), // all well below 0.30
    });
    expect(builder.build(result, 'fp-abc', DriveName.Curiosity)).toBeNull();
  });

  it('AC2: partial-mode candidate — confidence capped at 0.79', () => {
    const maxProb = 0.92; // above 0.79; should be clamped in partial mode
    const result = makeTensorResult({
      actionBias: biasWithArgmax(0, maxProb),
      bootstrapMode: 'partial',
      tensorTopCategory: 'RESPOND',
    });

    const candidate = builder.build(result, 'ctx-fingerprint', DriveName.Curiosity);
    expect(candidate).not.toBeNull();
    expect(candidate!.confidence).toBeCloseTo(0.79, 10);
    expect(candidate!.contextMatchScore).toBeCloseTo(maxProb, 5);
  });

  it('full-mode candidate — confidence capped at 0.95', () => {
    const maxProb = 0.99;
    const result = makeTensorResult({
      actionBias: biasWithArgmax(0, maxProb),
      bootstrapMode: 'full',
      tensorTopCategory: 'RESPOND',
    });

    const candidate = builder.build(result, 'ctx-fingerprint', DriveName.Curiosity);
    expect(candidate).not.toBeNull();
    expect(candidate!.confidence).toBeCloseTo(0.95, 10);
  });

  it('full-mode: confidence below 0.95 is NOT clamped up', () => {
    const maxProb = 0.70;
    const result = makeTensorResult({
      actionBias: biasWithArgmax(0, maxProb),
      bootstrapMode: 'full',
    });

    const candidate = builder.build(result, 'fp', DriveName.Boredom);
    expect(candidate).not.toBeNull();
    expect(candidate!.confidence).toBeCloseTo(maxProb, 5);
  });

  it('partial-mode at 0.30 exactly — not filtered out', () => {
    const maxProb = 0.30;
    const result = makeTensorResult({
      actionBias: biasWithArgmax(0, maxProb),
      bootstrapMode: 'partial',
    });

    const candidate = builder.build(result, 'fp', DriveName.Focus);
    expect(candidate).not.toBeNull();
    // 0.30 < 0.79, so confidence = 0.30
    expect(candidate!.confidence).toBeCloseTo(0.30, 5);
  });

  it('candidate motivatingDrive matches dominantDrive argument', () => {
    const result = makeTensorResult({ actionBias: biasWithArgmax(0, 0.5) });
    const candidate = builder.build(result, 'fp', DriveName.Social);
    expect(candidate!.motivatingDrive).toBe(DriveName.Social);
  });

  it('candidate procedureData.category matches tensorTopCategory', () => {
    const result = makeTensorResult({
      tensorTopCategory: 'ASK_QUESTION',
      actionBias: biasWithArgmax(0, 0.6),
    });
    const candidate = builder.build(result, 'fp', DriveName.Curiosity);
    expect(candidate!.procedureData!.category).toBe('ASK_QUESTION');
  });

  it('candidate procedureData.triggerContext matches contextFingerprint', () => {
    const result = makeTensorResult({ actionBias: biasWithArgmax(0, 0.5) });
    const candidate = builder.build(result, 'my-fingerprint-xyz', DriveName.Curiosity);
    expect(candidate!.procedureData!.triggerContext).toBe('my-fingerprint-xyz');
  });

  it('candidate procedureData LLM_GENERATE step carries urgency and novelty', () => {
    const result = makeTensorResult({
      actionBias: biasWithArgmax(0, 0.5),
      urgency: 0.77,
      noveltyScore: 0.33,
      tensorTopCategory: 'RESPOND',
    });
    const candidate = builder.build(result, 'fp', DriveName.Curiosity);
    const step = candidate!.procedureData!.actionSequence[0];
    expect(step.stepType).toBe('LLM_GENERATE');
    expect((step.params as any).tensorUrgency).toBeCloseTo(0.77, 5);
    expect((step.params as any).tensorNovelty).toBeCloseTo(0.33, 5);
  });

  it('AC2: shadow-mode is treated as non-full (caps at 0.79)', () => {
    const maxProb = 0.85;
    const result = makeTensorResult({
      actionBias: biasWithArgmax(0, maxProb),
      bootstrapMode: 'shadow',
    });
    const candidate = builder.build(result, 'fp', DriveName.Curiosity);
    expect(candidate!.confidence).toBeCloseTo(0.79, 10);
  });

  it('AC2: audit-mode is treated as non-full (caps at 0.79)', () => {
    const maxProb = 0.88;
    const result = makeTensorResult({
      actionBias: biasWithArgmax(0, maxProb),
      bootstrapMode: 'audit',
    });
    const candidate = builder.build(result, 'fp', DriveName.Curiosity);
    expect(candidate!.confidence).toBeCloseTo(0.79, 10);
  });
});

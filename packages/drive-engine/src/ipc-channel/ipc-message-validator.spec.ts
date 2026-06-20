/**
 * Unit tests for the IPC message validator — the vision "first green baseline".
 *
 * These tests pin two contracts at the drive-engine IPC boundary, both of which
 * matter for the vision pipeline that feeds sensory/scene signals into the
 * drive engine via ACTION_OUTCOME messages:
 *
 *   1. CLAMP. metadata.sceneSurprise and metadata.sensoryPredictionError are
 *      declared z.number().min(0).max(1) in ipc-message-validator.ts (:45-46).
 *      Out-of-range magnitudes (1.5, -0.1) MUST be rejected; in-range values
 *      (0, 1, 0.5) MUST be accepted. A vision sidecar that emits a garbage
 *      surprise value cannot silently poison the drive state.
 *
 *   2. INJECTED driveEffects IS REJECTED (CANON Standard 6, made executable).
 *      The ACTION_OUTCOME payload schema ends with .strict(), so a
 *      hostile/erroneous top-level `driveEffects` field on the payload HARD-FAILS
 *      validation at the isolation boundary rather than silently passing through.
 *      This is the primary, structural defense: the main process can never
 *      dictate pre-computed drive effects across the boundary.
 *
 *      We then keep the engine's design as a SECOND, defense-in-depth layer:
 *      even if validation were bypassed, the drive engine computes ALL effects
 *      itself (drive-engine.ts:547-567 → getDefaultAffect → computeDefaultAffect,
 *      constants/rules.ts:218) and never reads a pre-computed driveEffects field
 *      off the inbound payload.
 *
 *      So we assert:
 *        (a) the payload-with-injected-driveEffects is REJECTED by the validator
 *            (and a valid payload is accepted), and
 *        (b) belt-and-suspenders: the affect computed for that exact payload
 *            (via the clean, unit-testable computeDefaultAffect layer) is
 *            byte-for-byte the same as the payload WITHOUT the injected field —
 *            the engine's effect computation is independent of the injection.
 *
 * Golden affect values below were produced by RUNNING the real
 * computeDefaultAffect (ScenePrediction default curiosity:0.02 / anxiety:0.01,
 * scaled by sceneSurprise=0.5; feedbackSource 'algorithmic' adds no outcome
 * bonus): { curiosity: 0.01, anxiety: 0.005 }.
 */

import { DriveIPCMessageType, DriveName } from '@sylphie/shared';
import type { ActionOutcomePayload } from '@sylphie/shared';
import {
  validateInboundMessage,
  safeValidateMessage,
} from './ipc-message-validator';
import { getDefaultAffect } from '../drive-process/default-affect';
import { computeDefaultAffect } from '../constants/rules';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal-but-valid ACTION_OUTCOME payload. Callers override metadata
 * (and may inject extra top-level fields) to exercise individual contracts.
 */
function makePayload(
  metadata: ActionOutcomePayload['metadata'],
  actionType = 'ScenePrediction',
): ActionOutcomePayload {
  return {
    actionId: 'act-1',
    actionType,
    outcome: 'positive',
    metadata,
    feedbackSource: 'algorithmic',
    theaterCheck: {
      expressionType: 'none',
      driveValueAtExpression: 0,
      drive: DriveName.Curiosity,
      isTheatrical: false,
    },
    anxietyAtExecution: 0,
  };
}

/** Wrap a payload in a full inbound ACTION_OUTCOME envelope. */
function makeInbound(payload: ActionOutcomePayload): unknown {
  return {
    type: DriveIPCMessageType.ACTION_OUTCOME,
    timestamp: new Date(),
    payload,
  };
}

// ---------------------------------------------------------------------------
// 1. Clamp — sceneSurprise and sensoryPredictionError in [0, 1]
// ---------------------------------------------------------------------------

describe('ipc-message-validator — metadata magnitude clamp [0, 1]', () => {
  const REJECTED = [1.5, -0.1];
  const ACCEPTED = [0, 1, 0.5];

  describe('sceneSurprise', () => {
    it.each(REJECTED)('rejects out-of-range sceneSurprise=%p', (v) => {
      const result = safeValidateMessage(
        makeInbound(makePayload({ sceneSurprise: v })),
        'inbound',
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('sceneSurprise');
      }
    });

    it.each(ACCEPTED)('accepts in-range sceneSurprise=%p', (v) => {
      const result = safeValidateMessage(
        makeInbound(makePayload({ sceneSurprise: v })),
        'inbound',
      );
      expect(result.success).toBe(true);
    });
  });

  describe('sensoryPredictionError', () => {
    it.each(REJECTED)('rejects out-of-range sensoryPredictionError=%p', (v) => {
      const result = safeValidateMessage(
        makeInbound(makePayload({ sensoryPredictionError: v })),
        'inbound',
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('sensoryPredictionError');
      }
    });

    it.each(ACCEPTED)('accepts in-range sensoryPredictionError=%p', (v) => {
      const result = safeValidateMessage(
        makeInbound(makePayload({ sensoryPredictionError: v })),
        'inbound',
      );
      expect(result.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Injected top-level driveEffects is REJECTED at the isolation boundary
// ---------------------------------------------------------------------------

describe('ipc-message-validator — injected driveEffects is rejected (CANON Std-6)', () => {
  // A clean baseline payload and a hostile clone with a top-level driveEffects
  // field injected (cast away from the type, since the wire could carry it).
  const cleanPayload = makePayload({ sceneSurprise: 0.5 });
  const injectedPayload = {
    ...makePayload({ sceneSurprise: 0.5 }),
    // Pre-computed effects the main process must NEVER be allowed to dictate.
    driveEffects: {
      [DriveName.Social]: 999,
      [DriveName.Anxiety]: -999,
    },
  } as ActionOutcomePayload;

  it('(a) REJECTS a payload carrying an injected top-level driveEffects field', () => {
    // The ACTION_OUTCOME schema ends with .strict(), so the unrecognized
    // top-level field hard-fails validation instead of passing through.
    const result = safeValidateMessage(makeInbound(injectedPayload), 'inbound');
    expect(result.success).toBe(false);
    if (!result.success) {
      // .strict() produces a validation error (the unrecognized-key issue).
      // Note: Zod's message text for unrecognized keys varies by version
      // (it may read ": Invalid input" rather than naming the key), so we
      // assert that an error was produced — NOT its exact text. The fact that
      // `driveEffects` specifically is the cause is pinned by test (a2): the
      // identical payload WITHOUT that field is ACCEPTED.
      expect(result.error).toBeTruthy();
    }
    // And it throws on the strict parse path too.
    expect(() => validateInboundMessage(makeInbound(injectedPayload))).toThrow();
  });

  it('(a2) ACCEPTS the same payload WITHOUT the injected field', () => {
    // The clean baseline (every field declared in the schema) still validates —
    // flipping to .strict() does not reject any legitimate producer payload.
    const result = safeValidateMessage(makeInbound(cleanPayload), 'inbound');
    expect(result.success).toBe(true);
  });

  it('(b) the drive engine ignores it: computed affect equals the clean default, unaffected by the injection', () => {
    // GOLDEN (pinned by running the real computeDefaultAffect):
    //   ScenePrediction → curiosity:0.02, anxiety:0.01, each scaled by
    //   sceneSurprise=0.5 → curiosity:0.01, anxiety:0.005.
    //   feedbackSource 'algorithmic' adds no outcome bonus.
    const expected = {
      [DriveName.Curiosity]: 0.01,
      [DriveName.Anxiety]: 0.005,
    };

    const cleanAffect = getDefaultAffect(cleanPayload);
    const injectedAffect = getDefaultAffect(injectedPayload);

    // The clean computation matches the golden default...
    expect(cleanAffect).toEqual(expected);
    // ...and the injected driveEffects field does not move it at all.
    expect(injectedAffect).toEqual(cleanAffect);
    expect(injectedAffect).toEqual(expected);

    // The injected magnitudes (999 / -999) never leak into the result.
    expect(injectedAffect[DriveName.Social]).toBeUndefined();
    expect(injectedAffect[DriveName.Anxiety]).toBe(0.005);
  });

  it('(b-direct) computeDefaultAffect derives effects solely from actionType/metadata/feedbackSource', () => {
    // Sanity: the underlying pure function — the layer the engine actually uses
    // at drive-engine.ts:547-567 — reads only the declared signal fields. A
    // payload that differs ONLY by the injected driveEffects produces an
    // identical effects map.
    expect(computeDefaultAffect(injectedPayload)).toEqual(
      computeDefaultAffect(cleanPayload),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. TK-86 / DEC-24: metadata.hostilityMagnitude survives validation (AC-1)
// ---------------------------------------------------------------------------

describe('ipc-message-validator — hostilityMagnitude survives validation (AC-1 / DEC-24)', () => {
  // hostilityMagnitude is additive inside z.object() metadata (not .strict()),
  // so it must pass through validation and not be stripped or hard-rejected.

  it('accepts a payload with hostilityMagnitude in [0, 1]', () => {
    const payload = makePayload({ hostilityMagnitude: 0.7 }, 'InboundHostility');
    const result = safeValidateMessage(makeInbound(payload), 'inbound');
    expect(result.success).toBe(true);
  });

  it('rejects hostilityMagnitude > 1', () => {
    const payload = makePayload({ hostilityMagnitude: 1.5 }, 'InboundHostility');
    const result = safeValidateMessage(makeInbound(payload), 'inbound');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('hostilityMagnitude');
    }
  });

  it('rejects hostilityMagnitude < 0', () => {
    const payload = makePayload({ hostilityMagnitude: -0.1 }, 'InboundHostility');
    const result = safeValidateMessage(makeInbound(payload), 'inbound');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('hostilityMagnitude');
    }
  });

  it('hostilityMagnitude is preserved after validation (not stripped)', () => {
    const payload = makePayload({ hostilityMagnitude: 0.8 }, 'InboundHostility');
    const envelope = makeInbound(payload);
    const result = safeValidateMessage(envelope, 'inbound');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload.metadata.hostilityMagnitude).toBe(0.8);
    }
  });
});

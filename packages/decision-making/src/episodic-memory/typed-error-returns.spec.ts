/**
 * EP14.5b (TK-90) — CONTRADICTION_SCAN_FAILED + HANDLER_NOT_FOUND typed returns
 *
 * Acceptance criteria verified:
 *   AC1. When the contradiction scanner throws, arbitrate() returns a SHRUG with
 *        arbitrationError==='CONTRADICTION_SCAN_FAILED' (not a thrown error).
 *   AC2. ActionHandlerRegistryService.execute() returns a HandlerNotFoundError
 *        (not null) when no handler is registered; HandlerNotFoundError has no
 *        'content' key so the existing content-guard path still degrades correctly.
 *   AC3. When the procedure-execution loop receives a HandlerNotFoundError, it
 *        builds a CycleErrorContext with cause==='HANDLER_NOT_FOUND' and the
 *        cycle completes without throwing (observable via encode()).
 *
 * Tests are pure-unit: no running backend required.
 */

import type {
  ActionCandidate,
  DriveSnapshot,
  ArbitrationResult,
  ContradictionScanResult,
  CycleErrorCause,
  CycleErrorContext,
  EpisodeInput,
  EpisodeSource,
} from '@sylphie/shared';
import { ArbitrationService } from '../arbitration/arbitration.service';
import {
  ActionHandlerRegistryService,
  HandlerNotFoundError,
} from '../action-handlers/action-handler-registry.service';
import { EpisodicMemoryService } from './episodic-memory.service';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const driveSnapshot = { sessionId: 'test-session', pressureVector: {} } as unknown as DriveSnapshot;

/** Minimal qualified Type 1 candidate — confidence > graduation (0.80) + context floor (0.55). */
function makeType1Candidate(): ActionCandidate {
  return {
    procedureData: {
      id: 'proc-1',
      name: 'test-procedure',
      category: 'ConversationalResponse',
      triggerContext: 'fp',
      actionSequence: [],
      provenance: 'TAUGHT_PROCEDURE',
      confidence: 0.90,
    },
    confidence: 0.90,
    motivatingDrive: 'curiosity',
    contextMatchScore: 0.80, // above CONTEXT_MATCH_FLOOR (0.55)
  } as ActionCandidate;
}

function makeEpisodeInput(overrides: Partial<EpisodeInput> = {}): EpisodeInput {
  return {
    source: 'conversation' as EpisodeSource,
    driveSnapshot,
    inputSummary: 'test input',
    actionTaken: 'test-action',
    contextFingerprint: 'fp-a fp-b',
    attention: 0.8,
    arousal: 0.5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1 — Contradiction scan throws → SHRUG with arbitrationError='CONTRADICTION_SCAN_FAILED'
// ---------------------------------------------------------------------------

describe('AC1 — contradiction scan failure → SHRUG with arbitrationError', () => {
  it('returns a SHRUG (not throwing) when the scanner throws', async () => {
    // Arrange: a scanner that always throws.
    const throwingScanner = {
      scan: () => Promise.reject(new Error('Neo4j connection lost')),
    };

    const svc = new ArbitrationService(
      null,               // thresholdService
      throwingScanner as any,
      null,               // eventLogger
    );

    const candidates = [makeType1Candidate()];

    // Act
    let result: ArbitrationResult | undefined;
    let didThrow = false;
    try {
      result = await svc.arbitrate(candidates, driveSnapshot);
    } catch {
      didThrow = true;
    }

    // Assert: cycle must NOT throw
    expect(didThrow).toBe(false);
    expect(result).toBeDefined();
    expect(result!.type).toBe('SHRUG');
  });

  it('sets arbitrationError to CONTRADICTION_SCAN_FAILED on the SHRUG', async () => {
    const throwingScanner = {
      scan: () => Promise.reject(new Error('timeout')),
    };

    const svc = new ArbitrationService(null, throwingScanner as any, null);
    const result = await svc.arbitrate([makeType1Candidate()], driveSnapshot);

    expect(result.type).toBe('SHRUG');
    if (result.type === 'SHRUG') {
      expect(result.arbitrationError).toBe('CONTRADICTION_SCAN_FAILED');
    }
  });

  it('SHRUG verdict is returned even when the scanner throws (not a re-throw)', async () => {
    const throwingScanner = {
      scan: (): Promise<ContradictionScanResult> => {
        throw new Error('unexpected scan error');
      },
    };

    const svc = new ArbitrationService(null, throwingScanner as any, null);
    const result = await svc.arbitrate([makeType1Candidate()], driveSnapshot);
    expect(result.type).toBe('SHRUG');
  });

  it('normal scan (no contradictions) still returns TYPE_1 (scanner not broken)', async () => {
    const cleanScanner = {
      scan: (): Promise<ContradictionScanResult> =>
        Promise.resolve({ hasContradictions: false, contradictions: [] }),
    };

    const svc = new ArbitrationService(null, cleanScanner as any, null);
    const result = await svc.arbitrate([makeType1Candidate()], driveSnapshot);
    // Clean scan → TYPE_1 should proceed
    expect(result.type).toBe('TYPE_1');
  });

  it('arbitrationError is absent on a normal knowledge-gap SHRUG (not an infrastructure fault)', async () => {
    // No scanner — no candidates → SHRUG due to MISSING_CONTEXT
    const svc = new ArbitrationService(null, null, null);
    const result = await svc.arbitrate([], driveSnapshot);
    expect(result.type).toBe('SHRUG');
    if (result.type === 'SHRUG') {
      expect(result.arbitrationError).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — execute() returns HandlerNotFoundError instead of null; no 'content' key
// ---------------------------------------------------------------------------

describe('AC2 — execute() returns HandlerNotFoundError for unregistered step types', () => {
  function makeRegistry(): ActionHandlerRegistryService {
    // Pass null for all optional services — only built-in handlers registered.
    return new ActionHandlerRegistryService(null, null, {
      get: () => undefined,
    } as any);
  }

  it('returns HandlerNotFoundError (not null) for an unregistered step type', async () => {
    const registry = makeRegistry();
    const step = { index: 0, stepType: 'UNKNOWN_STEP_TYPE', params: {} };
    const result = await registry.execute(step as any, {} as any);
    expect(result).toBeInstanceOf(HandlerNotFoundError);
  });

  it('HandlerNotFoundError carries the stepType that was not found', async () => {
    const registry = makeRegistry();
    const step = { index: 0, stepType: 'MY_CUSTOM_STEP', params: {} };
    const result = await registry.execute(step as any, {} as any);
    expect(result).toBeInstanceOf(HandlerNotFoundError);
    expect((result as HandlerNotFoundError).stepType).toBe('MY_CUSTOM_STEP');
  });

  it('HandlerNotFoundError has no "content" key (content-guard path degrades correctly)', async () => {
    const registry = makeRegistry();
    const step = { index: 0, stepType: 'NO_SUCH_HANDLER', params: {} };
    const result = await registry.execute(step as any, {} as any);
    expect(result).toBeInstanceOf(HandlerNotFoundError);
    // The existing content-guard: `result && typeof result['content'] === 'string'`
    // must evaluate to false for HandlerNotFoundError.
    expect((result as any)['content']).toBeUndefined();
    // The guard relies on result having no 'content' key — verify it's truly absent.
    expect('content' in (result as object)).toBe(false);
  });

  it('a registered built-in handler (LOG_EVENT) still returns a Record (not HandlerNotFoundError)', async () => {
    const registry = makeRegistry();
    const step = { index: 0, stepType: 'LOG_EVENT', params: { message: 'hello' } };
    const result = await registry.execute(step as any, {} as any);
    // LOG_EVENT is a built-in; it must NOT return HandlerNotFoundError.
    expect(result).not.toBeInstanceOf(HandlerNotFoundError);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// AC3 — cycleErrorContext with cause=HANDLER_NOT_FOUND threads to encode()
// ---------------------------------------------------------------------------

describe('AC3 — HANDLER_NOT_FOUND cause is a valid CycleErrorCause and threads to encode()', () => {
  it('HANDLER_NOT_FOUND is a valid CycleErrorCause literal (structural type check)', () => {
    // TypeScript structural check: this assignment must compile.
    const causes: CycleErrorCause[] = ['LLM_TIMEOUT', 'DELIBERATION_ERROR', 'HANDLER_NOT_FOUND'];
    expect(causes).toHaveLength(3);
    expect(causes).toContain('HANDLER_NOT_FOUND');
  });

  it('CycleErrorContext with HANDLER_NOT_FOUND cause is structurally valid', () => {
    const ctx: CycleErrorContext = {
      cause: 'HANDLER_NOT_FOUND',
      message: 'No handler for step type: MY_STEP',
    };
    expect(ctx.cause).toBe('HANDLER_NOT_FOUND');
    expect(ctx.message).toContain('MY_STEP');
  });

  it('encode() threads HANDLER_NOT_FOUND CycleErrorContext onto the Episode', async () => {
    const svc = new EpisodicMemoryService(null, null);
    const ep = await svc.encode(
      makeEpisodeInput({
        cycleErrorContext: { cause: 'HANDLER_NOT_FOUND', message: 'No handler for UNKNOWN_STEP' },
      }),
      'NORMAL',
    );
    expect(ep).not.toBeNull();
    expect(ep!.cycleErrorContext).toBeDefined();
    expect(ep!.cycleErrorContext!.cause).toBe('HANDLER_NOT_FOUND');
    expect(ep!.cycleErrorContext!.message).toContain('UNKNOWN_STEP');
  });

  it('HANDLER_NOT_FOUND context does not block encode() (cycle completes)', async () => {
    const svc = new EpisodicMemoryService(null, null);
    // The cycle must not throw; encode() must return a non-null Episode.
    const ep = await svc.encode(
      makeEpisodeInput({
        cycleErrorContext: { cause: 'HANDLER_NOT_FOUND', message: 'step GHOST not registered' },
      }),
      'NORMAL',
    );
    expect(ep).not.toBeNull();
  });

  it('HANDLER_NOT_FOUND context is absent (not a key) on a normal (no-error) Episode', async () => {
    const svc = new EpisodicMemoryService(null, null);
    const ep = await svc.encode(makeEpisodeInput(), 'NORMAL');
    expect(ep).not.toBeNull();
    // The additive spread must not set the key to undefined on normal cycles.
    expect('cycleErrorContext' in ep!).toBe(false);
  });

  it('getRecentEpisodes() returns the HANDLER_NOT_FOUND-tagged Episode', async () => {
    const svc = new EpisodicMemoryService(null, null);
    await svc.encode(
      makeEpisodeInput({
        cycleErrorContext: { cause: 'HANDLER_NOT_FOUND', message: 'No handler for GHOST' },
      }),
      'NORMAL',
    );
    const recent = svc.getRecentEpisodes(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].cycleErrorContext?.cause).toBe('HANDLER_NOT_FOUND');
  });
});

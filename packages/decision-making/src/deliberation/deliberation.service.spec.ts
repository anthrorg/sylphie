/**
 * TK-126 (DEC-32, Option A) — DeliberationService shouldDebate gate integration spec.
 *
 * Verifies the honest debate-gate confidence signal end-to-end through the real
 * deliberate() pipeline (not just the pure normalizeScoreToConfidence/scoreCandidates
 * unit tests in deliberation-helpers.spec.ts):
 *
 *   AC1: A high-quality (GROUNDED, no-penalty) candidate's confidence clears
 *        DEBATE_THRESHOLD via the real scoreCandidates signal.
 *   AC2: The full compound-OR shouldDebate gate — confidence alone is NOT
 *        sufficient. High confidence + wkg.entities present + low anxiety =>
 *        debate skipped (fewer LLM calls). Either condition alone flipping
 *        forces debate even at the same high confidence (OR-gate not neutered).
 *   AC3: A genuinely weak/untagged candidate still triggers debate — the gate
 *        was made honest via a real signal, not neutered into never-debate.
 *
 * All LLM calls are mocked (no real Ollama/DeepSeek). Debate/arbiter firing is
 * observed via llm.complete() call count: 2 calls (monologue + candidates) when
 * debate is skipped, 5 calls (+ for/against/arbiter) when it fires.
 */

import { DeliberationService } from './deliberation.service';
import { DriveName } from '@sylphie/shared';
import type { WkgContext, WkgEntity } from '../wkg/wkg-context.service';
import type { RecallRetrieval } from './recall-retrieval';

jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MONOLOGUE_CONTENT =
  '[INTENT: QUESTION]\n[ENTITY: none]\n[THOUGHT: need to think]\n[RESPONSE: NEEDS_DELIBERATION]';

const STRONG_CANDIDATE_CONTENT = '1. [GROUNDED] That sounds nice, thanks for sharing.';
const WEAK_CANDIDATE_CONTENT = '1. That is interesting.';

function makeLlmResponse(content: string) {
  return {
    content,
    tokensUsed: { prompt: 10, completion: 10 },
    latencyMs: 1,
    model: 'test-model',
    cost: 0,
  };
}

function makeWkgEntity(label: string): WkgEntity {
  return { nodeId: `n-${label}`, label, nodeType: 'Entity', properties: {}, confidence: 0.9, provenance: 'test' };
}

function makeWkg(opts: { withEntity: boolean }): WkgContext {
  return {
    entities: opts.withEntity ? [makeWkgEntity('Zzyzx')] : [],
    relationships: [],
    facts: [],
    procedures: [],
    summary: '',
  };
}

function makeDriveSnapshot(anxiety: number) {
  return {
    // Keyed by the DriveName enum's runtime string VALUES (e.g. 'anxiety'),
    // not its TS key names — this is how deliberation.service.ts actually
    // indexes: pressureVector[DriveName.Anxiety].
    pressureVector: {
      [DriveName.SystemHealth]: 0,
      [DriveName.MoralValence]: 0,
      [DriveName.Integrity]: 0,
      [DriveName.CognitiveAwareness]: 0,
      [DriveName.Guilt]: 0,
      [DriveName.Curiosity]: 0,
      [DriveName.Boredom]: 0,
      [DriveName.Anxiety]: anxiety,
      [DriveName.Satisfaction]: 0,
      [DriveName.Sadness]: 0,
      [DriveName.Focus]: 0,
      [DriveName.Social]: 0,
    },
    totalPressure: anxiety,
    tickNumber: 1,
    sessionId: 'session-test',
    timestamp: new Date(),
    driveDeltas: {},
    ruleMatchResult: { ruleId: null, eventType: 'TEST', matched: false },
  } as any;
}

function makeFrame(text: string) {
  return {
    timestamp: Date.now(),
    fused_embedding: new Array(8).fill(0),
    modality_embeddings: {},
    active_modalities: ['text'],
    raw: { text },
  } as any;
}

function makeContext(anxiety: number) {
  return {
    currentState: 'IDLE',
    recentEpisodes: [],
    activePredictions: [],
    driveSnapshot: makeDriveSnapshot(anxiety),
    recentGapTypes: [],
    dynamicThreshold: 0.5,
  } as any;
}

/** Build a DeliberationService with an LLM mock that answers by request purpose. */
function buildService(opts: { candidateContent: string; withEntity: boolean }): {
  service: DeliberationService;
  completeCalls: Array<{ purpose: string }>;
} {
  const completeCalls: Array<{ purpose: string }> = [];

  const llm = {
    isAvailable: () => true,
    complete: jest.fn(async (req: any) => {
      const purpose = req.metadata?.purpose ?? 'UNKNOWN';
      completeCalls.push({ purpose });
      switch (purpose) {
        case 'DELIBERATION_MONOLOGUE':
          return makeLlmResponse(MONOLOGUE_CONTENT);
        case 'DELIBERATION_CANDIDATES':
          return makeLlmResponse(opts.candidateContent);
        case 'DELIBERATION_FOR':
          return makeLlmResponse('This response is warm and appropriate.');
        case 'DELIBERATION_AGAINST':
          return makeLlmResponse('No strong objections.');
        case 'DELIBERATION_ARBITER':
          return makeLlmResponse('APPROVE\nConfidence: 8');
        default:
          return makeLlmResponse('');
      }
    }),
    // Deliberately NO completeWithTools — forces the plain complete() candidate path.
  };

  const wkgContext = {
    getContextForFrame: jest.fn(async () => makeWkg({ withEntity: opts.withEntity })),
  };

  const toolRegistry = {
    setConversationHistory: jest.fn(),
    getToolDefinitions: jest.fn(() => []),
    createExecutor: jest.fn(),
  };

  const contextWindow = {
    assemble: jest.fn((req: any) => ({
      systemPrompt: (req.systemParts ?? []).filter(Boolean).join('\n'),
      messages: req.currentMessages,
      historyMessagesIncluded: 0,
      historyMessagesDropped: 0,
      estimatedPromptTokens: 0,
      systemPromptTruncated: false,
    })),
  };

  const service = new DeliberationService(
    llm as any,
    wkgContext as any,
    toolRegistry as any,
    contextWindow as any,
    null, // episodicMemory
    null, // eventLogger
    null, // workingMemory
  );

  return { service, completeCalls };
}

// ---------------------------------------------------------------------------
// AC1 — confidence reflects the real scoreCandidates signal and clears DEBATE_THRESHOLD
// ---------------------------------------------------------------------------

describe('TK-126 AC1 — a high-quality (GROUNDED, no-penalty) candidate clears DEBATE_THRESHOLD', () => {
  it('shouldDebate is false (no debate/arbiter calls) when confidence clears 0.7, entities are present, and anxiety is low', async () => {
    const { service, completeCalls } = buildService({ candidateContent: STRONG_CANDIDATE_CONTENT, withEntity: true });

    const result = await service.deliberate(makeFrame('Tell me something.'), makeContext(0.1));

    // Only monologue + candidates — no debate/arbiter LLM calls.
    expect(completeCalls.map(c => c.purpose)).toEqual([
      'DELIBERATION_MONOLOGUE',
      'DELIBERATION_CANDIDATES',
    ]);
    expect(result.trace.stepsExecuted).toBe(3);
    expect(result.trace.debate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC2 — compound-OR gate: confidence alone is insufficient
// ---------------------------------------------------------------------------

describe('TK-126 AC2 — compound-OR shouldDebate gate is not neutered by the confidence fix', () => {
  it('debate is skipped only when ALL three conditions hold: confidence>=0.7 AND entities present AND anxiety<=0.5', async () => {
    const { service, completeCalls } = buildService({ candidateContent: STRONG_CANDIDATE_CONTENT, withEntity: true });

    await service.deliberate(makeFrame('Tell me something.'), makeContext(0.2));

    expect(completeCalls).toHaveLength(2); // no debate
  });

  it('debate STILL fires when wkg.entities.length === 0, even at the same high confidence', async () => {
    const { service, completeCalls } = buildService({ candidateContent: STRONG_CANDIDATE_CONTENT, withEntity: false });

    await service.deliberate(makeFrame('Tell me something.'), makeContext(0.1));

    expect(completeCalls).toHaveLength(5); // debate + arbiter fired
    expect(completeCalls.map(c => c.purpose)).toContain('DELIBERATION_ARBITER');
  });

  it('debate STILL fires when anxiety > 0.5, even at the same high confidence and entities present', async () => {
    const { service, completeCalls } = buildService({ candidateContent: STRONG_CANDIDATE_CONTENT, withEntity: true });

    await service.deliberate(makeFrame('Tell me something.'), makeContext(0.6));

    expect(completeCalls).toHaveLength(5); // debate + arbiter fired
    expect(completeCalls.map(c => c.purpose)).toContain('DELIBERATION_ARBITER');
  });
});

// ---------------------------------------------------------------------------
// AC3 — a genuinely weak/untagged candidate still triggers debate (gate is honest)
// ---------------------------------------------------------------------------

describe('TK-126 AC3 — a genuinely uncertain candidate still triggers debate (regression: gate not neutered)', () => {
  it('an untagged candidate (score ~0.5, confidence ~0.690) triggers debate even with entities present and low anxiety', async () => {
    const { service, completeCalls } = buildService({ candidateContent: WEAK_CANDIDATE_CONTENT, withEntity: true });

    const result = await service.deliberate(makeFrame('Tell me something.'), makeContext(0.1));

    expect(completeCalls).toHaveLength(5); // debate fired — the gate is honest, not always-skip
    expect(result.trace.stepsExecuted).toBe(5);
    expect(result.trace.debate).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TK-127 (DEC-31 / AD-0048) — provenance threads through the real deliberate()
// short-circuit path (deliberation.service.ts:446-450), not just the pure
// applyRecallGroundingFromRetrieval function in isolation. Proves the fix
// actually reaches a real caller: an already-GROUNDED verdict (via wkg.facts)
// whose recall retrieval's fact value surfaces in the response now carries
// groundingProvenance out on the DeliberationResult — this is what
// decision-making.service.ts's WS3-T2 reinforcement gate keys on
// (recallRetrieval.factNodeId === responseGroundingProvenance).
// ---------------------------------------------------------------------------

describe('TK-127 — recall-retrieval provenance threads through the short-circuit deliberate() path', () => {
  it('an already-GROUNDED (via wkg.facts) short-circuit response whose recall value surfaces carries groundingProvenance (post-fix)', async () => {
    const { service } = buildService({ candidateContent: STRONG_CANDIDATE_CONTENT, withEntity: false });

    // Short-circuit path: GREETING intent with a direct RESPONSE (no
    // NEEDS_DELIBERATION) skips candidate generation entirely.
    const monologueContent = '[INTENT: GREETING]\n[ENTITY: none]\n[THOUGHT: ok]\n[RESPONSE: Your name is Jim!]';
    (service as any).llm.complete = jest.fn(async (req: any) => ({
      content: monologueContent,
      tokensUsed: { prompt: 5, completion: 5 },
      latencyMs: 1,
      model: 'test-model',
      cost: 0,
    }));

    // wkg.facts non-empty so knowledgeGrounding is ALREADY 'GROUNDED' before
    // applyRecallGroundingFromRetrieval runs (deliberation.service.ts:429) —
    // this is the exact "already GROUNDED by an earlier signal" scenario the
    // pre-fix bug suppressed provenance for.
    (service as any).wkgContext.getContextForFrame = jest.fn(async () => ({
      entities: [],
      relationships: [],
      facts: [{ subject: 'user', predicate: 'name', object: 'Jim', confidence: 0.9, provenance: 'GUARDIAN' }],
      procedures: [],
      summary: '',
    } as WkgContext));

    const recallRetrieval: RecallRetrieval = {
      recallKey: 'name',
      factNodeId: 'attr-user-jim-name',
      factValue: 'Jim',
      source: 'OKG',
      personId: 'user',
    };

    const result = await service.deliberate(
      makeFrame('what is my name?'),
      makeContext(0.1),
      recallRetrieval,
    );

    expect(result.knowledgeGrounding).toBe('GROUNDED');
    // Post-fix: provenance threads because the value ("Jim") surfaced in the
    // response — pre-fix this was null solely because grounding was already
    // GROUNDED before the check ran.
    expect(result.groundingProvenance).toBe('attr-user-jim-name');
    expect(result.groundedBy).toBe('OKG');
  });
});

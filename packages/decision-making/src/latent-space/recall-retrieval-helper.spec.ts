/**
 * RecallRetrievalHelper unit tests — TK-33 acceptance criteria.
 *
 * AC1: The extraction compiles and all tests pass.
 * AC2: Behavior byte-identical to the original DecisionMakingService private
 *      methods computeRecallRetrieval() and recallKeyEncoder().
 *
 * Tests verify:
 *   - computeRecallRetrieval() returns null for empty/non-recall text.
 *   - computeRecallRetrieval() returns OKG recall when knownFacts contain the key.
 *   - computeRecallRetrieval() returns null when no recall key resolved.
 *   - WKG fallback path exercises getContextForFrame on OKG miss.
 *   - recallKeyEncoder() returns null when no text encoder registered.
 *   - recallKeyEncoder() returns an encoder seam when a document-capable encoder exists.
 *   - WKG lookup failure is caught and null returned (not rethrown).
 *
 * NestJS Logger is mocked so log lines don't reach test output.
 */

import { Logger } from '@nestjs/common';
import { RecallRetrievalHelper } from './recall-retrieval-helper';

// Suppress NestJS Logger output during tests.
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SensoryFrame with text. */
function frameWith(text: string, personId?: string, knownFacts?: string[]) {
  return {
    timestamp: Date.now(),
    fused_embedding: [],
    modality_embeddings: {},
    active_modalities: ['text'],
    raw: {
      text,
      person_model: personId ? { personId, knownFacts: knownFacts ?? [] } : undefined,
    },
  };
}

/** Stub WkgContextService that returns an empty context (OKG miss path). */
function makeWkgStub(opts: { throws?: boolean } = {}) {
  return {
    getContextForFrame: jest.fn(async () => {
      if (opts.throws) throw new Error('Neo4j unavailable');
      return { entities: [], facts: [], relationships: [], procedures: [], summary: '' };
    }),
  };
}

/** Stub ModalityRegistryService with no encoders registered. */
function makeRegistryStub(opts: { hasEncoder?: boolean } = {}) {
  const encoderStub = opts.hasEncoder
    ? {
        encode: jest.fn(async (t: string) => new Array(768).fill(0.1)),
        encodeDocument: jest.fn(async (t: string) => new Array(768).fill(0.2)),
      }
    : null;

  return {
    get: jest.fn((name: string) => (name === 'text' ? encoderStub : null)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecallRetrievalHelper.computeRecallRetrieval()', () => {
  it('returns null for a frame with empty text', async () => {
    const helper = new RecallRetrievalHelper(makeWkgStub() as any, makeRegistryStub() as any);
    const result = await helper.computeRecallRetrieval(frameWith('') as any);
    expect(result).toBeNull();
  });

  it('returns null for non-recall text (no key resolved)', async () => {
    const helper = new RecallRetrievalHelper(makeWkgStub() as any, makeRegistryStub() as any);
    const result = await helper.computeRecallRetrieval(frameWith('Hello there!') as any);
    expect(result).toBeNull();
  });

  it('returns OKG recall for "what is my name" when name is taught', async () => {
    const wkg = makeWkgStub();
    const registry = makeRegistryStub();
    const helper = new RecallRetrievalHelper(wkg as any, registry as any);

    const frame = frameWith('what is my name?', 'person-42', ['name: Alice']);
    const result = await helper.computeRecallRetrieval(frame as any);

    expect(result).not.toBeNull();
    expect(result!.recallKey).toBe('name');
    expect(result!.factValue).toBe('Alice');
    expect(result!.source).toBe('OKG');
    expect(result!.personId).toBe('person-42');
    // OKG path does NOT hit Neo4j
    expect(wkg.getContextForFrame).not.toHaveBeenCalled();
  });

  it('returns null when key resolves but fact is not taught (OKG miss + empty WKG)', async () => {
    const wkg = makeWkgStub(); // returns empty WKG
    const registry = makeRegistryStub();
    const helper = new RecallRetrievalHelper(wkg as any, registry as any);

    // Name is NOT in knownFacts
    const frame = frameWith('what is my name?', 'person-42', []);
    const result = await helper.computeRecallRetrieval(frame as any);

    expect(result).toBeNull();
    // WKG was consulted since OKG missed
    expect(wkg.getContextForFrame).toHaveBeenCalledTimes(1);
  });

  it('catches WKG lookup failures and returns null', async () => {
    const wkg = makeWkgStub({ throws: true });
    const registry = makeRegistryStub();
    const helper = new RecallRetrievalHelper(wkg as any, registry as any);

    const frame = frameWith('what is my name?', 'person-42', []);
    // Must not throw — degrade to null
    const result = await helper.computeRecallRetrieval(frame as any);
    expect(result).toBeNull();
  });

  it('returns null when frame has no person_model', async () => {
    const wkg = makeWkgStub();
    const registry = makeRegistryStub();
    const helper = new RecallRetrievalHelper(wkg as any, registry as any);

    const frame = frameWith('what is my name?');
    const result = await helper.computeRecallRetrieval(frame as any);
    // No person → OKG cannot ground → empty WKG → null
    expect(result).toBeNull();
  });
});

describe('RecallRetrievalHelper.recallKeyEncoder()', () => {
  it('returns null when no text encoder is registered', () => {
    const helper = new RecallRetrievalHelper(makeWkgStub() as any, makeRegistryStub() as any);
    expect(helper.recallKeyEncoder()).toBeNull();
  });

  it('returns a RecallKeyEncoder seam when a document-capable encoder is registered', () => {
    const helper = new RecallRetrievalHelper(
      makeWkgStub() as any,
      makeRegistryStub({ hasEncoder: true }) as any,
    );
    const enc = helper.recallKeyEncoder();
    // Should expose encodeQuery and encodeDocument
    expect(enc).not.toBeNull();
    expect(typeof enc!.encodeQuery).toBe('function');
    expect(typeof enc!.encodeDocument).toBe('function');
  });
});

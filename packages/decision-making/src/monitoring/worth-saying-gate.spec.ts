/**
 * TK-104: Worth-saying gate unit tests.
 *
 * Tests the three acceptance criteria directly:
 *
 * AC1 — Content-dedup: two consecutive self-initiated cycles with the SAME
 *   response text → the second is suppressed.
 *
 * AC2 — Novel salient event passes: a genuinely novel scene event
 *   (cachedSceneSurprise >= SCENE_NOVELTY_THRESHOLD) IS judged worth saying
 *   even when the context is otherwise static (no GROUNDED content).
 *
 * AC3 is tested via the bootstrap-attenuation unit tests in
 * action-retriever-bootstrap-attenuation.spec.ts (different file, covers the
 * retrieval-time confidence cap for SYSTEM_BOOTSTRAP candidates).
 *
 * Strategy: WorthSayingGate has no NestJS dependencies. All tests are plain
 * unit tests that instantiate the gate directly.
 */

import {
  WorthSayingGate,
  normaliseHash,
  SCENE_NOVELTY_THRESHOLD,
  RECENT_TEXT_CAPACITY,
} from './worth-saying-gate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a gate with N pre-recorded emissions. */
function gateWithHistory(texts: string[]): WorthSayingGate {
  const gate = new WorthSayingGate();
  for (const t of texts) {
    gate.recordEmission(t);
  }
  return gate;
}

// ---------------------------------------------------------------------------
// AC1 — Content-dedup: same text is suppressed on second self-initiated cycle
// ---------------------------------------------------------------------------

describe('WorthSayingGate — AC1 content-dedup', () => {
  it('allows first emission (no history)', () => {
    const gate = new WorthSayingGate();
    const result = gate.evaluate('Hello there!', 0, 'LLM_ASSISTED');
    // First cycle: no scene surprise, no grounding → suppressed by STATIC_CONTEXT.
    // But the DEDUP check passes (nothing in history), so the gate reaches the
    // NOVELTY branch, finds nothing novel, and returns NOT worth saying.
    expect(result.worthSaying).toBe(false);
    expect(result.reason).toContain('STATIC_CONTEXT');
  });

  it('allows emission when scene surprise is high (novel event)', () => {
    const gate = new WorthSayingGate();
    const result = gate.evaluate('A ball rolled in!', SCENE_NOVELTY_THRESHOLD, 'LLM_ASSISTED');
    expect(result.worthSaying).toBe(true);
    expect(result.reason).toContain('SALIENT_OBSERVATION');
  });

  it('suppresses a duplicate self-initiated utterance even when scene has low surprise', () => {
    const gate = gateWithHistory(['Hello there!']);
    // Second cycle: same text, no scene surprise → dedup suppresses it.
    const result = gate.evaluate('Hello there!', 0, 'LLM_ASSISTED');
    expect(result.worthSaying).toBe(false);
    expect(result.reason).toContain('CONTENT_DEDUP');
  });

  it('suppresses even when normalisation differs (case / whitespace)', () => {
    const gate = gateWithHistory(['Hello  there!']);
    // "hello there!" normalises to same hash as "Hello  there!"
    const result = gate.evaluate('HELLO THERE!', 0, 'LLM_ASSISTED');
    expect(result.worthSaying).toBe(false);
    expect(result.reason).toContain('CONTENT_DEDUP');
  });

  it('allows a different utterance after a repeated one is recorded', () => {
    const gate = gateWithHistory(['Hello there!']);
    // Different text, no scene surprise, no grounding → STATIC_CONTEXT (not CONTENT_DEDUP)
    const result = gate.evaluate('How are you doing?', 0, 'LLM_ASSISTED');
    // Still suppressed by STATIC_CONTEXT — different text but nothing novel.
    expect(result.worthSaying).toBe(false);
    expect(result.reason).toContain('STATIC_CONTEXT');
  });

  it('dedup takes priority over novelty: a novel scene with a dup text is still suppressed', () => {
    const gate = gateWithHistory(['Oh, a ball!']);
    // Same text, but this time scene surprise is high.
    // Dedup check fires FIRST — the content is still a repeat even with novelty.
    const result = gate.evaluate('Oh, a ball!', SCENE_NOVELTY_THRESHOLD + 0.1, 'LLM_ASSISTED');
    expect(result.worthSaying).toBe(false);
    expect(result.reason).toContain('CONTENT_DEDUP');
  });

  it('recordEmission only records when called; evaluate does not auto-record', () => {
    const gate = new WorthSayingGate();
    // Just calling evaluate does NOT add to dedup history.
    gate.evaluate('Hello!', 0, 'LLM_ASSISTED');
    gate.evaluate('Hello!', 0, 'LLM_ASSISTED');
    // No history recorded → third call still goes through dedup check clean.
    // Without any recordEmission, the only suppression reason would be STATIC_CONTEXT.
    const result = gate.evaluate('Hello!', 0, 'LLM_ASSISTED');
    expect(result.reason).not.toContain('CONTENT_DEDUP');
    expect(result.reason).toContain('STATIC_CONTEXT');
  });

  it('caps the dedup history at RECENT_TEXT_CAPACITY entries (oldest evicted)', () => {
    const gate = new WorthSayingGate();
    // Fill history to capacity.
    for (let i = 0; i < RECENT_TEXT_CAPACITY; i++) {
      gate.recordEmission(`utterance-${i}`);
    }
    expect(gate.trackedCount).toBe(RECENT_TEXT_CAPACITY);

    // Add one more — oldest ('utterance-0') should be evicted.
    gate.recordEmission('utterance-overflow');
    expect(gate.trackedCount).toBe(RECENT_TEXT_CAPACITY);

    // utterance-0 was evicted so it is no longer in the dedup buffer.
    // Without scene surprise or grounding, the gate will return STATIC_CONTEXT
    // (not CONTENT_DEDUP) for utterance-0.
    const result = gate.evaluate('utterance-0', 0, 'LLM_ASSISTED');
    expect(result.reason).not.toContain('CONTENT_DEDUP');
  });
});

// ---------------------------------------------------------------------------
// AC2 — Novel salient event IS judged worth saying
// ---------------------------------------------------------------------------

describe('WorthSayingGate — AC2 salient scene event', () => {
  it('passes when cachedSceneSurprise >= SCENE_NOVELTY_THRESHOLD', () => {
    const gate = new WorthSayingGate();
    const result = gate.evaluate(
      'A new object appeared!',
      SCENE_NOVELTY_THRESHOLD, // exactly at threshold
      'LLM_ASSISTED',
    );
    expect(result.worthSaying).toBe(true);
    expect(result.reason).toContain('SALIENT_OBSERVATION');
  });

  it('passes when surprise is well above threshold', () => {
    const gate = new WorthSayingGate();
    const result = gate.evaluate('Someone walked in!', 1.5, 'LLM_ASSISTED');
    expect(result.worthSaying).toBe(true);
    expect(result.reason).toContain('SALIENT_OBSERVATION');
  });

  it('does NOT pass when surprise is below threshold (static room)', () => {
    const gate = new WorthSayingGate();
    const result = gate.evaluate('Nothing happening.', SCENE_NOVELTY_THRESHOLD - 0.01, 'LLM_ASSISTED');
    // Without grounding this falls through to STATIC_CONTEXT.
    expect(result.worthSaying).toBe(false);
    expect(result.reason).toContain('STATIC_CONTEXT');
  });

  it('static scene (surprise=0) stays silent', () => {
    const gate = new WorthSayingGate();
    const result = gate.evaluate('The room looks the same.', 0, 'LLM_ASSISTED');
    expect(result.worthSaying).toBe(false);
  });

  it('GROUNDED content is worth saying even without scene surprise', () => {
    const gate = new WorthSayingGate();
    const result = gate.evaluate(
      'Your name is Jim.',
      0,       // no scene surprise
      'GROUNDED',
    );
    expect(result.worthSaying).toBe(true);
    expect(result.reason).toContain('GROUNDED_INSIGHT');
  });
});

// ---------------------------------------------------------------------------
// normaliseHash — helper unit tests
// ---------------------------------------------------------------------------

describe('normaliseHash', () => {
  it('lowercases text', () => {
    expect(normaliseHash('HELLO WORLD')).toBe('hello world');
  });

  it('collapses multiple spaces', () => {
    expect(normaliseHash('hello  world')).toBe('hello world');
  });

  it('strips leading and trailing whitespace', () => {
    expect(normaliseHash('  hello world  ')).toBe('hello world');
  });

  it('produces the same hash for semantically identical strings', () => {
    expect(normaliseHash('Hello,  World!')).toBe(normaliseHash('hello, world!'));
  });
});

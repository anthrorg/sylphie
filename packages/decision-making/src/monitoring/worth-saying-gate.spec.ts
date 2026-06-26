/**
 * TK-104 — WorthSayingGate unit tests.
 *
 * AC0 (repeat-suppression): two consecutive self-initiated cycles with
 *      unchanged context → the second does NOT emit the same utterance again.
 * AC1 (novelty-passes): a genuinely novel salient event IS judged worth saying
 *      (passes the gate → SALIENT_OBSERVATION), while a static scene is silent.
 *
 * Plus the seam-keying invariant: USER_REPLY / DELIBERATE_GREET BYPASS the gate
 * (the user-reply path is never gated — TK-104 non_goal).
 */

import {
  WorthSayingGate,
  SCENE_NOVELTY_THRESHOLD,
  normaliseHash,
} from './worth-saying-gate';
import type { EmissionIntent, KnowledgeGrounding } from '@sylphie/shared';

function input(overrides: {
  emissionIntent?: EmissionIntent;
  responseText?: string;
  cachedSceneSurprise?: number;
  responseGrounding?: KnowledgeGrounding;
}) {
  return {
    emissionIntent: overrides.emissionIntent ?? 'AMBIENT_NONE',
    responseText: overrides.responseText ?? 'hello there',
    cachedSceneSurprise: overrides.cachedSceneSurprise ?? 0,
    responseGrounding: overrides.responseGrounding ?? 'LLM_ASSISTED',
  };
}

describe('WorthSayingGate — AC0 repeat-suppression', () => {
  it('suppresses the SAME self-initiated utterance on the second unchanged cycle', () => {
    const gate = new WorthSayingGate();

    // Cycle 1: static self-tick that DOES have something to say (novel scene)
    // so it passes and is recorded.
    const first = gate.evaluate(
      input({ responseText: 'I see a red ball', cachedSceneSurprise: 1.0 }),
    );
    expect(first.worthSaying).toBe(true);
    gate.recordEmission('I see a red ball');

    // Cycle 2: UNCHANGED context, SAME line — must be suppressed by content-dedup
    // even though the scene surprise is still high.
    const second = gate.evaluate(
      input({ responseText: 'I see a red ball', cachedSceneSurprise: 1.0 }),
    );
    expect(second.worthSaying).toBe(false);
    expect(second.reason).toContain('CONTENT_DEDUP');
  });

  it('dedup is whitespace/case insensitive (normalised)', () => {
    const gate = new WorthSayingGate();
    gate.recordEmission('Hello   There');
    const r = gate.evaluate(
      input({ responseText: '  hello there  ', cachedSceneSurprise: 1.0 }),
    );
    expect(r.worthSaying).toBe(false);
    expect(normaliseHash('  hello there  ')).toBe(normaliseHash('Hello   There'));
  });

  it('a DIFFERENT line in the same context is not deduped', () => {
    const gate = new WorthSayingGate();
    gate.recordEmission('I see a red ball');
    const r = gate.evaluate(
      input({ responseText: 'I see a blue cube', cachedSceneSurprise: 1.0 }),
    );
    expect(r.worthSaying).toBe(true);
    expect(r.intent).toBe('SALIENT_OBSERVATION');
  });
});

describe('WorthSayingGate — AC1 novelty is a positive trigger', () => {
  it('a genuinely novel salient event passes → SALIENT_OBSERVATION', () => {
    const gate = new WorthSayingGate();
    const r = gate.evaluate(
      input({
        responseText: 'a ball just rolled into view',
        cachedSceneSurprise: SCENE_NOVELTY_THRESHOLD + 0.1,
      }),
    );
    expect(r.worthSaying).toBe(true);
    expect(r.intent).toBe('SALIENT_OBSERVATION');
    expect(r.reason).toContain('SALIENT_OBSERVATION');
  });

  it('a static room (no novelty, no grounding) is NOT worth saying', () => {
    const gate = new WorthSayingGate();
    const r = gate.evaluate(
      input({
        responseText: 'the room looks the same',
        cachedSceneSurprise: 0,
        responseGrounding: 'LLM_ASSISTED',
      }),
    );
    expect(r.worthSaying).toBe(false);
    expect(r.intent).toBe('AMBIENT_NONE');
    expect(r.reason).toContain('STATIC_CONTEXT');
  });

  it('surprise just BELOW threshold stays silent', () => {
    const gate = new WorthSayingGate();
    const r = gate.evaluate(
      input({ cachedSceneSurprise: SCENE_NOVELTY_THRESHOLD - 0.01 }),
    );
    expect(r.worthSaying).toBe(false);
  });

  it('new GROUNDED content also passes as worth saying', () => {
    const gate = new WorthSayingGate();
    const r = gate.evaluate(
      input({ cachedSceneSurprise: 0, responseGrounding: 'GROUNDED' }),
    );
    expect(r.worthSaying).toBe(true);
    expect(r.intent).toBe('SALIENT_OBSERVATION');
  });
});

describe('WorthSayingGate — seam keying (USER_REPLY / DELIBERATE_GREET bypass)', () => {
  it('USER_REPLY always bypasses the gate, even on a static repeated line', () => {
    const gate = new WorthSayingGate();
    gate.recordEmission('hello there'); // would dedup a self-initiated line
    const r = gate.evaluate(
      input({
        emissionIntent: 'USER_REPLY',
        responseText: 'hello there',
        cachedSceneSurprise: 0,
      }),
    );
    expect(r.worthSaying).toBe(true);
    expect(r.intent).toBe('USER_REPLY');
    expect(r.reason).toContain('BYPASS');
  });

  it('DELIBERATE_GREET bypasses the gate', () => {
    const gate = new WorthSayingGate();
    const r = gate.evaluate(
      input({ emissionIntent: 'DELIBERATE_GREET', cachedSceneSurprise: 0 }),
    );
    expect(r.worthSaying).toBe(true);
    expect(r.intent).toBe('DELIBERATE_GREET');
  });
});

describe('WorthSayingGate — recordEmission bookkeeping', () => {
  it('does not record empty text and is idempotent for the same line', () => {
    const gate = new WorthSayingGate();
    gate.recordEmission('');
    expect(gate.trackedCount).toBe(0);
    gate.recordEmission('one line');
    gate.recordEmission('one line');
    expect(gate.trackedCount).toBe(1);
  });

  it('caps the recent-utterance buffer at capacity (oldest evicted)', () => {
    const gate = new WorthSayingGate();
    for (let i = 0; i < 15; i++) {
      gate.recordEmission(`line ${i}`);
    }
    expect(gate.trackedCount).toBe(10);
    // The oldest ("line 0") was evicted → a repeat of it is NOT deduped.
    const r = gate.evaluate(
      input({ responseText: 'line 0', cachedSceneSurprise: 1.0 }),
    );
    expect(r.worthSaying).toBe(true);
  });
});

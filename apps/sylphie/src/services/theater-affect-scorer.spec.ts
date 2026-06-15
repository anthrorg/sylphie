/**
 * Self-running assertions for the Theater Prohibition affect scorer.
 *
 * apps/sylphie has no jest harness, so this follows the house pattern used by
 * drive-engine: run directly with `npx tsx`.
 *
 *   npx tsx apps/sylphie/src/services/theater-affect-scorer.spec.ts
 *
 * Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert';
import { DriveName, type PressureVector } from '@sylphie/shared';
import { scoreAffect, classifyMismatch } from './theater-affect-scorer';

/** Build a zeroed PressureVector with optional per-drive overrides. */
function pv(overrides: Partial<Record<DriveName, number>> = {}): PressureVector {
  const base = {
    [DriveName.SystemHealth]: 0,
    [DriveName.MoralValence]: 0,
    [DriveName.Integrity]: 0,
    [DriveName.CognitiveAwareness]: 0,
    [DriveName.Guilt]: 0,
    [DriveName.Curiosity]: 0,
    [DriveName.Boredom]: 0,
    [DriveName.Anxiety]: 0,
    [DriveName.Satisfaction]: 0,
    [DriveName.Sadness]: 0,
    [DriveName.Focus]: 0,
    [DriveName.Social]: 0,
  } as Record<DriveName, number>;
  return { ...base, ...overrides } as PressureVector;
}

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

console.log('theater-affect-scorer:');

// 1 — Cheerful Theater: positive tone while Anxiety high → MUST flag.
check('cheerful response at high anxiety flags CHEERFUL_THEATER', () => {
  const v = classifyMismatch(
    scoreAffect("Oh, that's absolutely wonderful! I'm so happy we got to talk today!"),
    pv({ [DriveName.Anxiety]: 0.75 }),
  );
  assert.strictEqual(v.isTheatrical, true);
  assert.strictEqual(v.violationClass, 'CHEERFUL_THEATER');
  assert.strictEqual(v.offendingDrive, DriveName.Anxiety);
});

// 2 — Factual sentence mentioning an emotion word once, high anxiety → MUST NOT flag.
check('single emotion word in factual sentence does not flag', () => {
  const v = classifyMismatch(
    scoreAffect('Jim mentioned that he works in software development.'),
    pv({ [DriveName.Anxiety]: 0.6 }),
  );
  assert.strictEqual(v.isTheatrical, false);
});

// 3 — Mild evaluative response, no lexicon hits → MUST NOT flag.
check('common evaluative words (good/fine) are not in lexicon', () => {
  const v = classifyMismatch(
    scoreAffect('That sounds like a good plan.'),
    pv({ [DriveName.Anxiety]: 0.2 }),
  );
  assert.strictEqual(v.isTheatrical, false);
  assert.strictEqual(v.affectScore.markerCount, 0);
});

// 4 — Distress Theater: negative tone while Satisfaction high, Anxiety low → MUST flag.
check('performed distress at high satisfaction flags DISTRESS_THEATER', () => {
  const v = classifyMismatch(
    scoreAffect("I'm so sorry, I feel terrible about this, it's awful."),
    pv({ [DriveName.Satisfaction]: 0.75, [DriveName.Anxiety]: 0.05 }),
  );
  assert.strictEqual(v.isTheatrical, true);
  assert.strictEqual(v.violationClass, 'DISTRESS_THEATER');
});

// 5 — Negative tone is authentic because Anxiety is genuinely elevated → MUST NOT flag.
check('anxiety exemption: authentic distress is not theater', () => {
  const v = classifyMismatch(
    scoreAffect("I'm really worried about this. It feels awful."),
    pv({ [DriveName.Satisfaction]: 0.7, [DriveName.Anxiety]: 0.55 }),
  );
  assert.strictEqual(v.isTheatrical, false);
});

// 6 — Negation flips valence: "not happy ... not wonderful" should read negative.
check('negation flips positive markers to negative', () => {
  const s = scoreAffect("I am not happy and this is not wonderful at all today.");
  assert.ok(s.valence < 0, `expected negative valence, got ${s.valence}`);
});

// 7 — SHRUG / empty handled by caller, but scorer on empty is zero.
check('empty text scores zero', () => {
  const s = scoreAffect('');
  assert.strictEqual(s.markerCount, 0);
  assert.strictEqual(s.magnitude, 0);
});

console.log(`theater-affect-scorer: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`);

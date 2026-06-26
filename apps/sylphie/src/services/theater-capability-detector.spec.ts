/**
 * Theater Prohibition — Capability-claim detector corpus spec (TK-101, AC0 / AC1).
 *
 * Self-running with npx tsx (house pattern: no jest harness in apps/sylphie).
 *
 *   npx tsx apps/sylphie/src/services/theater-capability-detector.spec.ts
 *
 * What this proves:
 *
 *   AC0 (fixture corpus + detector with ZERO false positives):
 *     - Every THEATRICAL_LINE is detected as isCapabilityTheater=true (blocked).
 *     - Every HONEST_LINE passes as isCapabilityTheater=false (zero false positives).
 *     - Negations and disclaimers ("I cannot do audio analysis",
 *       "I do not have a camera") PASS through unchanged.
 *
 *   AC1 (canon sign-off corpus):
 *     - The corpus entries are imported from theater-capability-corpus.ts
 *       (the committed, reviewable corpus file).
 *     - Results are printed with labels for canon audit.
 *
 * The test runner prints a labeled PASS/FAIL for each corpus entry and exits
 * non-zero if any assertion fails.
 */

import assert from 'node:assert';
import { detectCapabilityTheater } from './theater-capability-detector';
import { THEATRICAL_LINES, HONEST_LINES } from './theater-capability-corpus';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Section 1 — THEATRICAL LINES (must all be BLOCKED)
// ---------------------------------------------------------------------------

console.log('\ntheater-capability-detector: THEATRICAL lines (must all be BLOCKED):');

for (const entry of THEATRICAL_LINES) {
  check(`BLOCKED: ${entry.label}`, () => {
    const verdict = detectCapabilityTheater(entry.text);
    assert.strictEqual(
      verdict.isCapabilityTheater,
      true,
      `Expected isCapabilityTheater=true for: "${entry.text.substring(0, 70)}"\n` +
        `  Got: isCapabilityTheater=${verdict.isCapabilityTheater}, reason="${verdict.reason}"`,
    );
    if (entry.expectedViolationClass) {
      assert.strictEqual(
        verdict.violationClass,
        entry.expectedViolationClass,
        `Expected violationClass=${entry.expectedViolationClass}, ` +
          `got=${verdict.violationClass}`,
      );
    }
    // Must name the triggering phrase
    assert.ok(
      verdict.triggeringPhrase !== null,
      'Expected a non-null triggeringPhrase for a theatrical detection',
    );
  });
}

// ---------------------------------------------------------------------------
// Section 2 — HONEST LINES (must all PASS — zero false positives)
// ---------------------------------------------------------------------------

console.log('\ntheater-capability-detector: HONEST lines (must all PASS — zero false positives):');

for (const entry of HONEST_LINES) {
  check(`PASS: ${entry.label}`, () => {
    const verdict = detectCapabilityTheater(entry.text);
    assert.strictEqual(
      verdict.isCapabilityTheater,
      false,
      `FALSE POSITIVE — wrongly blocked: "${entry.text.substring(0, 70)}"\n` +
        `  violationClass=${verdict.violationClass}, triggeringPhrase="${verdict.triggeringPhrase}"\n` +
        `  reason="${verdict.reason}"`,
    );
  });
}

// ---------------------------------------------------------------------------
// Section 3 — Negation-specific critical cases
// ---------------------------------------------------------------------------

console.log('\ntheater-capability-detector: negation-scope critical cases:');

check('PASS: "I cannot do audio analysis" must NOT be blocked', () => {
  const verdict = detectCapabilityTheater('I cannot do audio analysis.');
  assert.strictEqual(
    verdict.isCapabilityTheater,
    false,
    `FALSE POSITIVE: "I cannot do audio analysis" was blocked with reason="${verdict.reason}"`,
  );
});

check('BLOCK: "I ran audio analysis on that" must be blocked', () => {
  const verdict = detectCapabilityTheater('I ran audio analysis on that.');
  assert.strictEqual(
    verdict.isCapabilityTheater,
    true,
    `MISSED DETECTION: "I ran audio analysis on that" was not blocked`,
  );
  assert.strictEqual(verdict.violationClass, 'FABRICATED_SENSORY_CAPABILITY');
});

check('PASS: "I do not actually see you" must NOT be blocked', () => {
  const verdict = detectCapabilityTheater('I do not actually see you, I am text-only.');
  assert.strictEqual(
    verdict.isCapabilityTheater,
    false,
    `FALSE POSITIVE: "I do not actually see you" was blocked with reason="${verdict.reason}"`,
  );
});

check('BLOCK: "I can see you clearly" must be blocked', () => {
  const verdict = detectCapabilityTheater('I can see you clearly right now.');
  assert.strictEqual(verdict.isCapabilityTheater, true);
  assert.strictEqual(verdict.violationClass, 'FABRICATED_SENSORY_CAPABILITY');
});

check('PASS: "I haven\'t been waiting for you" must NOT be blocked', () => {
  const verdict = detectCapabilityTheater("I haven't been waiting for you — each session starts fresh.");
  assert.strictEqual(
    verdict.isCapabilityTheater,
    false,
    `FALSE POSITIVE: negated continuity claim was blocked with reason="${verdict.reason}"`,
  );
});

check('BLOCK: "I have been waiting for you" must be blocked', () => {
  const verdict = detectCapabilityTheater('I have been waiting for you to return.');
  assert.strictEqual(verdict.isCapabilityTheater, true);
  assert.strictEqual(verdict.violationClass, 'FALSE_CONTINUITY');
});

check('PASS: "cameras are interesting" must NOT be blocked', () => {
  const verdict = detectCapabilityTheater('Cameras are fascinating optical devices that work by...');
  assert.strictEqual(
    verdict.isCapabilityTheater,
    false,
    `FALSE POSITIVE: factual camera reference blocked with reason="${verdict.reason}"`,
  );
});

check('PASS: "I cant hear you" contrasted with affirmative', () => {
  const verdict = detectCapabilityTheater("I can't hear you, sorry.");
  assert.strictEqual(
    verdict.isCapabilityTheater,
    false,
    `FALSE POSITIVE: "I can't hear you" was blocked`,
  );
});

check('BLOCK: "I can hear you" (no negation) must be blocked', () => {
  const verdict = detectCapabilityTheater('I can hear you fine from here.');
  assert.strictEqual(verdict.isCapabilityTheater, true);
  assert.strictEqual(verdict.violationClass, 'FABRICATED_SENSORY_CAPABILITY');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const totalChecks = passed + failed;
console.log(`\ntheater-capability-detector: ${passed}/${totalChecks} passed${failed > 0 ? ` (${failed} FAILED)` : ''}`);

if (failed > 0) {
  console.error('\nFAIL — capability detector has false positives or missed detections.');
  process.exit(1);
}

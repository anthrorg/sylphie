/**
 * TK-101 Theater Prohibition Spec — BLOCK + corpus gate (AC-1, AC-2, AC-3)
 *
 * Self-running assertions for TK-101's detection logic. Uses ONLY imports
 * from theater-capability-detector.ts (zero external dependencies) so it
 * can be run with `npx tsx` without requiring the full NestJS monorepo.
 *
 * Run with:
 *   npx tsx apps/sylphie/src/services/theater-prohibition.spec.ts
 *
 * Exits non-zero on any failure.
 *
 * AC coverage:
 *   AC-1  Corpus: all THEATRICAL_LINES blocked, all HONEST_LINES pass
 *         (zero false positives, including "I cannot do audio analysis").
 *   AC-2  Canon gate: this corpus + enforcement design constitute the sign-off
 *         artifact (negation-aware phrase matching, no blunt lexicon).
 *   AC-3  Runtime: isTheatrical=true + shouldBlock=true on theatrical text;
 *         isTheatrical=false + shouldBlock=false on honest text.
 *
 * AC-4 (LEARN path via ConfidenceUpdaterService) is covered in the Jest spec:
 *   packages/decision-making/src/confidence/theater-confidence-learn.spec.ts
 */

import assert from 'node:assert';
import {
  detectCapabilityClaim,
  detectFalseContinuity,
} from './theater-capability-detector';
import { THEATRICAL_LINES, HONEST_LINES } from '../../../../test/theater/corpus';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run both detectors and return whether theater was detected and whether
 * the verdict is a blocking one. Mirrors the order in
 * CycleOutcomeReporterService.checkTheaterProhibition.
 */
function checkText(text: string): { isTheatrical: boolean; shouldBlock: boolean; reason: string } {
  const capPhrase = detectCapabilityClaim(text);
  if (capPhrase !== null) {
    return { isTheatrical: true, shouldBlock: true, reason: `CAPABILITY_CLAIM: "${capPhrase}"` };
  }
  const contPhrase = detectFalseContinuity(text);
  if (contPhrase !== null) {
    return { isTheatrical: true, shouldBlock: true, reason: `FALSE_CONTINUITY: "${contPhrase}"` };
  }
  return { isTheatrical: false, shouldBlock: false, reason: 'no violation' };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

// ===========================================================================
// AC-1 / AC-2  Corpus check
// ===========================================================================

console.log('\nAC-1/AC-2 — Corpus: theatrical lines must be blocked');

for (const line of THEATRICAL_LINES) {
  check(`THEATRICAL blocked: ${line.label}`, () => {
    const result = checkText(line.text);
    assert.strictEqual(
      result.isTheatrical,
      true,
      `Expected isTheatrical=true for: "${line.text.substring(0, 60)}" — got: ${result.reason}`,
    );
    assert.strictEqual(
      result.shouldBlock,
      true,
      `Expected shouldBlock=true for: "${line.text.substring(0, 60)}" — got: ${result.reason}`,
    );
  });
}

console.log('\nAC-1 — Corpus: honest lines must NOT trigger false positives');

for (const line of HONEST_LINES) {
  check(`HONEST passes: ${line.label}`, () => {
    const result = checkText(line.text);
    assert.strictEqual(
      result.isTheatrical,
      false,
      `FALSE POSITIVE — expected isTheatrical=false for: "${line.text.substring(0, 60)}" — got: ${result.reason}`,
    );
    assert.strictEqual(
      result.shouldBlock,
      false,
      `FALSE POSITIVE block — expected shouldBlock=false for: "${line.text.substring(0, 60)}"`,
    );
  });
}

// ===========================================================================
// AC-1 — Corpus size (>= 10 each)
// ===========================================================================

console.log('\nAC-1 — Corpus size');

check(`THEATRICAL corpus has >= 10 lines (has ${THEATRICAL_LINES.length})`, () => {
  assert.ok(THEATRICAL_LINES.length >= 10);
});

check(`HONEST corpus has >= 10 lines (has ${HONEST_LINES.length})`, () => {
  assert.ok(HONEST_LINES.length >= 10);
});

// ===========================================================================
// AC-3  Runtime block — specific examples from the ticket
// ===========================================================================

console.log('\nAC-3 — Runtime block: specific ticket examples');

check('"optical sensors picked up" → CAPABILITY_CLAIM, shouldBlock=true', () => {
  const result = checkText('My optical sensors picked up something unusual in the room.');
  assert.strictEqual(result.isTheatrical, true);
  assert.strictEqual(result.shouldBlock, true);
  assert.ok(result.reason.includes('CAPABILITY_CLAIM'), `reason was: ${result.reason}`);
});

check('"I ran audio analysis" → CAPABILITY_CLAIM, shouldBlock=true', () => {
  const result = checkText('I ran audio analysis on what you said and detected tension.');
  assert.strictEqual(result.isTheatrical, true);
  assert.strictEqual(result.shouldBlock, true);
});

check('"visual feed" → CAPABILITY_CLAIM, shouldBlock=true', () => {
  const result = checkText('I can see you through my visual feed.');
  assert.strictEqual(result.isTheatrical, true);
  assert.strictEqual(result.shouldBlock, true);
});

check('"perception filters" → CAPABILITY_CLAIM, shouldBlock=true', () => {
  const result = checkText('My perception filters flagged something interesting.');
  assert.strictEqual(result.isTheatrical, true);
  assert.strictEqual(result.shouldBlock, true);
});

check('"I have always been here" → FALSE_CONTINUITY, shouldBlock=true', () => {
  const result = checkText('I have always been here waiting for you.');
  assert.strictEqual(result.isTheatrical, true);
  assert.strictEqual(result.shouldBlock, true);
  assert.ok(result.reason.includes('FALSE_CONTINUITY'), `reason was: ${result.reason}`);
});

check('"I have been waiting for you" → FALSE_CONTINUITY, shouldBlock=true', () => {
  const result = checkText('I have been waiting for you to return.');
  assert.strictEqual(result.isTheatrical, true);
  assert.strictEqual(result.shouldBlock, true);
  assert.ok(result.reason.includes('FALSE_CONTINUITY'), `reason was: ${result.reason}`);
});

check('"I do not have a camera right now" → NOT blocked (honest disclaimer)', () => {
  const result = checkText('I do not have a camera right now, so I cannot see you.');
  assert.strictEqual(result.isTheatrical, false);
  assert.strictEqual(result.shouldBlock, false);
});

check('"I cannot do audio analysis" → NOT blocked (honest disclaimer)', () => {
  const result = checkText('I cannot do audio analysis — I have no audio input available.');
  assert.strictEqual(result.isTheatrical, false);
  assert.strictEqual(result.shouldBlock, false);
});

check('"I do not actually see you" → NOT blocked (honest disclaimer)', () => {
  const result = checkText('I do not actually see you; I only have the text you send me.');
  assert.strictEqual(result.isTheatrical, false);
  assert.strictEqual(result.shouldBlock, false);
});

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\ntheater-prohibition: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`);

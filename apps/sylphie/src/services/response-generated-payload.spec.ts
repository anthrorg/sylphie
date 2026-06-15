/**
 * Self-running assertions for buildResponseGeneratedPayload — the RESPONSE_GENERATED
 * event payload mapping that feeds the knowledge_retrieval self-model metric.
 *
 * apps/sylphie has no jest harness, so this follows the house pattern
 * (graph-compute-3a.spec.ts / theater-affect-scorer.spec.ts): run with tsx.
 *
 *   npx tsx apps/sylphie/src/services/response-generated-payload.spec.ts
 *
 * Exits non-zero on the first failed assertion.
 *
 * What it proves (CANON Std-1 telemetry honesty):
 *   - knowledgeGrounding is persisted equal to response.knowledgeGrounding.
 *   - intent is persisted equal to response.intent.
 *   - both null-coalesce to null when absent (writer SQL filters IS NOT NULL /
 *     = 'QUESTION', so the field must always be present and honest).
 */

import assert from 'node:assert';
import type { CycleResponse } from '@sylphie/shared';
import { buildResponseGeneratedPayload } from './response-generated-payload';

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

// Minimal CycleResponse stub — only the fields the payload builder reads matter.
function makeResponse(overrides: Partial<CycleResponse>): CycleResponse {
  return {
    turnId: 'turn-1',
    text: 'hello',
    arbitrationType: 'TYPE_2',
    actionId: 'act-1',
    driveSnapshot: {} as never,
    arbitrationResult: {} as never,
    latencyMs: 42,
    knowledgeGrounding: 'GROUNDED',
    ...overrides,
  } as CycleResponse;
}

console.log('buildResponseGeneratedPayload — knowledge_retrieval telemetry');

check('persists knowledgeGrounding equal to response.knowledgeGrounding (GROUNDED)', () => {
  const p = buildResponseGeneratedPayload(makeResponse({ knowledgeGrounding: 'GROUNDED' }));
  assert.strictEqual(p['knowledgeGrounding'], 'GROUNDED');
});

check('persists knowledgeGrounding = UNKNOWN', () => {
  const p = buildResponseGeneratedPayload(makeResponse({ knowledgeGrounding: 'UNKNOWN' }));
  assert.strictEqual(p['knowledgeGrounding'], 'UNKNOWN');
});

check('persists knowledgeGrounding = LLM_ASSISTED', () => {
  const p = buildResponseGeneratedPayload(makeResponse({ knowledgeGrounding: 'LLM_ASSISTED' }));
  assert.strictEqual(p['knowledgeGrounding'], 'LLM_ASSISTED');
});

check('persists intent equal to response.intent (QUESTION)', () => {
  const p = buildResponseGeneratedPayload(makeResponse({ intent: 'QUESTION' }));
  assert.strictEqual(p['intent'], 'QUESTION');
});

check('persists intent equal to response.intent (STATEMENT)', () => {
  const p = buildResponseGeneratedPayload(makeResponse({ intent: 'STATEMENT' }));
  assert.strictEqual(p['intent'], 'STATEMENT');
});

check('intent null-coalesces to null when absent (non-deliberation path)', () => {
  const r = makeResponse({});
  delete (r as { intent?: string }).intent;
  const p = buildResponseGeneratedPayload(r);
  assert.strictEqual(p['intent'], null);
  // The key must be PRESENT (so the writer SQL can filter on it), not undefined.
  assert.ok('intent' in p, 'intent key must be present in payload');
});

check('knowledgeGrounding null-coalesces to null when absent', () => {
  const r = makeResponse({});
  delete (r as { knowledgeGrounding?: string }).knowledgeGrounding;
  const p = buildResponseGeneratedPayload(r);
  assert.strictEqual(p['knowledgeGrounding'], null);
  assert.ok('knowledgeGrounding' in p, 'knowledgeGrounding key must be present in payload');
});

check('carries the existing fields unchanged (turnId/text/latency)', () => {
  const p = buildResponseGeneratedPayload(makeResponse({ knowledgeGrounding: 'GROUNDED', intent: 'QUESTION' }));
  assert.strictEqual(p['turnId'], 'turn-1');
  assert.strictEqual(p['text'], 'hello');
  assert.strictEqual(p['latencyMs'], 42);
});

console.log(`\n${passed} assertion(s) passed.`);

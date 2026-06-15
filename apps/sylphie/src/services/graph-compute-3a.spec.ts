/**
 * Self-running assertions for the Phase 4 Wave 2 (3a) graph-compute layer:
 *   - WkgDiffService.computeInformationGain (pure diff + honesty gate)
 *   - self-assessment Std-2/Std-3 mapping helpers
 *
 * apps/sylphie has no jest harness, so this follows the house pattern used by
 * theater-affect-scorer.spec.ts and drive-engine: run directly with `npx tsx`.
 *
 *   npx tsx apps/sylphie/src/services/graph-compute-3a.spec.ts
 *
 * Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert';
import { Neo4jService } from '@sylphie/shared';
import {
  WkgDiffService,
  type WkgSnapshot,
  type WkgNodeState,
} from './wkg-diff.service';
import {
  clampCapabilityConfidence,
  toAssessmentProvenance,
  KNOWN_CAPABILITY_NAMES,
  CONFIDENCE_CEILING,
} from './self-assessment.service';

// The diff is pure — no Neo4j calls reached. Pass a null driver as the dep.
const diff = new WkgDiffService(null as unknown as Neo4jService);

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

function node(over: Partial<WkgNodeState> = {}): WkgNodeState {
  return {
    confidence: 0,
    lastActionId: null,
    unresolvedPredictionError: false,
    ...over,
  };
}

function snap(
  captured: boolean,
  entries: Array<[string, WkgNodeState]> = [],
): WkgSnapshot {
  return { captured, nodes: new Map(entries), capturedAt: new Date(0) };
}

console.log('graph-compute-3a (WKG-diff):');

// 1 — Missing before-snapshot → UNVERIFIED.
check('missing before-snapshot yields UNVERIFIED', () => {
  const r = diff.computeInformationGain(snap(false), snap(true), 'act-1');
  assert.strictEqual(r.source, 'UNVERIFIED');
  assert.strictEqual(r.newNodes, 0);
  assert.strictEqual(r.confidenceDeltas, 0);
  assert.strictEqual(r.resolvedErrors, 0);
});

// 2 — Missing actionId → UNVERIFIED.
check('empty actionId yields UNVERIFIED', () => {
  const r = diff.computeInformationGain(snap(true), snap(true), '');
  assert.strictEqual(r.source, 'UNVERIFIED');
});

// 3 — New node stamped with THIS action → counted as WKG_DIFF.
check('new node attributed to this action counts', () => {
  const before = snap(true, []);
  const after = snap(true, [['n1', node({ lastActionId: 'act-1' })]]);
  const r = diff.computeInformationGain(before, after, 'act-1');
  assert.strictEqual(r.source, 'WKG_DIFF');
  assert.strictEqual(r.newNodes, 1);
});

// 4 — New node carrying NO attribution marker → graph changed but unattributable
//     → honest-red UNVERIFIED (today's writers don't stamp last_action_id yet).
check('new node without marker is UNVERIFIED (honest-red)', () => {
  const before = snap(true, []);
  const after = snap(true, [['n1', node({ lastActionId: null })]]);
  const r = diff.computeInformationGain(before, after, 'act-1');
  assert.strictEqual(r.source, 'UNVERIFIED');
  assert.strictEqual(r.newNodes, 0);
});

// 5 — Concurrent writer (foreign action marker appeared) → UNVERIFIED.
check('concurrent writer marker forces UNVERIFIED', () => {
  const before = snap(true, []);
  const after = snap(true, [
    ['mine', node({ lastActionId: 'act-1' })],
    ['theirs', node({ lastActionId: 'act-OTHER' })],
  ]);
  const r = diff.computeInformationGain(before, after, 'act-1');
  assert.strictEqual(r.source, 'UNVERIFIED');
});

// 6 — Positive confidence delta on a pre-existing node attributed to this action.
check('positive confidence delta on existing node is summed', () => {
  const before = snap(true, [['n1', node({ confidence: 0.4 })]]);
  const after = snap(true, [['n1', node({ confidence: 0.55, lastActionId: 'act-1' })]]);
  const r = diff.computeInformationGain(before, after, 'act-1');
  assert.strictEqual(r.source, 'WKG_DIFF');
  assert.ok(Math.abs(r.confidenceDeltas - 0.15) < 1e-9, `got ${r.confidenceDeltas}`);
});

// 7 — Negative/zero confidence change is NOT counted (never negative relief).
check('confidence decrease is ignored, no-op diff is a valid WKG_DIFF zero', () => {
  const before = snap(true, [['n1', node({ confidence: 0.6, lastActionId: 'act-1' })]]);
  const after = snap(true, [['n1', node({ confidence: 0.5, lastActionId: 'act-1' })]]);
  const r = diff.computeInformationGain(before, after, 'act-1');
  // No positive change anywhere, no foreign marker, no unattributable change →
  // a clean (empty) WKG_DIFF that earns zero relief.
  assert.strictEqual(r.source, 'WKG_DIFF');
  assert.strictEqual(r.confidenceDeltas, 0);
  assert.strictEqual(r.newNodes, 0);
});

// 8 — Resolved prediction-error marker attributed to this action.
check('resolved prediction-error flips count', () => {
  const before = snap(true, [['e1', node({ unresolvedPredictionError: true })]]);
  const after = snap(true, [
    ['e1', node({ unresolvedPredictionError: false, lastActionId: 'act-1' })],
  ]);
  const r = diff.computeInformationGain(before, after, 'act-1');
  assert.strictEqual(r.source, 'WKG_DIFF');
  assert.strictEqual(r.resolvedErrors, 1);
});

// 9 — Truly empty diff (graph unchanged) → clean WKG_DIFF, all zero.
check('unchanged graph is a clean zero WKG_DIFF', () => {
  const both: Array<[string, WkgNodeState]> = [['n1', node({ confidence: 0.5 })]];
  const r = diff.computeInformationGain(snap(true, both), snap(true, both), 'act-1');
  assert.strictEqual(r.source, 'WKG_DIFF');
  assert.strictEqual(r.newNodes, 0);
  assert.strictEqual(r.confidenceDeltas, 0);
  assert.strictEqual(r.resolvedErrors, 0);
});

console.log('graph-compute-3a (KG-Self mapping):');

// 10 — Std-3: non-GUARDIAN confidence is clamped to the 0.60 ceiling.
check('Std-3 clamps inferred capability confidence to 0.60', () => {
  assert.strictEqual(clampCapabilityConfidence(0.95, 'INFERENCE'), CONFIDENCE_CEILING);
  assert.strictEqual(clampCapabilityConfidence(0.95, 'SYSTEM_BOOTSTRAP'), CONFIDENCE_CEILING);
  assert.strictEqual(
    clampCapabilityConfidence(0.95, 'GUARDIAN_APPROVED_INFERENCE'),
    CONFIDENCE_CEILING,
  );
});

// 11 — Std-3: GUARDIAN provenance may exceed the ceiling.
check('Std-3 allows GUARDIAN confidence above the ceiling', () => {
  assert.strictEqual(clampCapabilityConfidence(0.95, 'GUARDIAN'), 0.95);
  // still clamped to [0,1]
  assert.strictEqual(clampCapabilityConfidence(1.5, 'GUARDIAN'), 1);
});

// 12 — Std-2: unknown/null provenance defaults to INFERENCE, never GUARDIAN.
check('unknown provenance never promotes to GUARDIAN', () => {
  assert.strictEqual(toAssessmentProvenance(null), 'INFERENCE');
  assert.strictEqual(toAssessmentProvenance('whatever'), 'INFERENCE');
  assert.strictEqual(toAssessmentProvenance('INFERENCE'), 'INFERENCE');
  assert.strictEqual(toAssessmentProvenance('GUARDIAN'), 'GUARDIAN');
  assert.strictEqual(
    toAssessmentProvenance('GUARDIAN_APPROVED_INFERENCE'),
    'GUARDIAN_APPROVED_INFERENCE',
  );
  assert.strictEqual(toAssessmentProvenance('SYSTEM_BOOTSTRAP'), 'SYSTEM_BOOTSTRAP');
});

// 13 — Capability name allowlist matches the CAPABILITY_TO_DRIVE_MAP keys.
check('capability name allowlist is exactly the four drive-map keys', () => {
  assert.strictEqual(KNOWN_CAPABILITY_NAMES.size, 4);
  for (const k of ['social_interaction', 'knowledge_retrieval', 'prediction_accuracy', 'error_correction']) {
    assert.ok(KNOWN_CAPABILITY_NAMES.has(k), `missing ${k}`);
  }
  assert.ok(!KNOWN_CAPABILITY_NAMES.has('made_up_capability'));
});

console.log(`graph-compute-3a: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`);

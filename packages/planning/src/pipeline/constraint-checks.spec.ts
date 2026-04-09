/**
 * Unit tests for constraint-checks.ts pure functions.
 *
 * These tests run with zero external dependencies using Node.js built-in assert.
 * Run via: npx tsx packages/planning/src/pipeline/constraint-checks.spec.ts
 *
 * Covers all 5 constraint functions with valid and invalid inputs:
 *   1. checkStepTypeValidity
 *   2. checkAddressesOpportunity
 *   3. checkProcedureConflict
 *   4. checkNoTheatricalBehavior
 *   5. checkContingencyTracing
 */

import assert from 'node:assert/strict';
import {
  checkStepTypeValidity,
  checkAddressesOpportunity,
  checkProcedureConflict,
  checkNoTheatricalBehavior,
  checkContingencyTracing,
  VALID_STEP_TYPES,
} from './constraint-checks.js';
import { DriveName } from '@sylphie/shared';
import type { PlanProposal, QueuedOpportunity } from '../interfaces/planning.interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposal(overrides: Partial<PlanProposal> = {}): PlanProposal {
  return {
    name: 'test-plan',
    category: 'SelfRegulation',
    triggerContext: 'prediction_failure_pattern:curiosity:ctx-abc123',
    rationale:
      'Addresses PREDICTION_FAILURE_PATTERN for curiosity drive by querying the WKG ' +
      'and generating a targeted response.',
    actionSequence: [
      {
        index: 0,
        stepType: 'WKG_QUERY',
        params: { query: 'MATCH (p:ActionProcedure) RETURN p LIMIT 5' },
      },
      {
        index: 1,
        stepType: 'LLM_GENERATE',
        params: { purpose: 'generate_response' },
      },
    ],
    predictedDriveEffects: { [DriveName.Curiosity]: -0.3, [DriveName.Satisfaction]: -0.1 },
    ...overrides,
  };
}

function makeOpportunity(overrides: Partial<QueuedOpportunity['payload']> = {}): QueuedOpportunity {
  return {
    payload: {
      id: 'opp-1',
      contextFingerprint: 'ctx-abc123',
      classification: 'PREDICTION_FAILURE_PATTERN',
      priority: 'MEDIUM',
      sourceEventId: 'evt-1',
      affectedDrive: DriveName.Curiosity,
      ...overrides,
    },
    enqueuedAt: new Date(),
    initialPriority: 0.6,
    currentPriority: 0.6,
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function describe(suiteName: string, fn: () => void): void {
  console.log(`\n  ${suiteName}`);
  fn();
}

function it(testName: string, fn: () => void): void {
  try {
    fn();
    console.log(`    PASS  ${testName}`);
    passed++;
  } catch (err) {
    console.error(`    FAIL  ${testName}`);
    console.error(`          ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// VALID_STEP_TYPES set
// ---------------------------------------------------------------------------

describe('VALID_STEP_TYPES', () => {
  it('contains LLM_GENERATE, WKG_QUERY, TTS_SPEAK, LOG_EVENT', () => {
    assert.ok(VALID_STEP_TYPES.has('LLM_GENERATE'));
    assert.ok(VALID_STEP_TYPES.has('WKG_QUERY'));
    assert.ok(VALID_STEP_TYPES.has('TTS_SPEAK'));
    assert.ok(VALID_STEP_TYPES.has('LOG_EVENT'));
  });

  it('does NOT contain EMIT_EVENT (the bug from the old LLM prompt)', () => {
    assert.ok(!VALID_STEP_TYPES.has('EMIT_EVENT'));
  });
});

// ---------------------------------------------------------------------------
// 1. checkStepTypeValidity
// ---------------------------------------------------------------------------

describe('checkStepTypeValidity', () => {
  it('passes when all step types are valid', () => {
    const result = checkStepTypeValidity(makeProposal());
    assert.equal(result.passed, true);
    assert.equal(result.constraint, 'STEP_TYPE_VALIDITY');
  });

  it('passes for all four valid individual types', () => {
    for (const stepType of ['LLM_GENERATE', 'WKG_QUERY', 'TTS_SPEAK', 'LOG_EVENT']) {
      const proposal = makeProposal({
        actionSequence: [{ index: 0, stepType, params: { purpose: 'test', query: 'test' } }],
      });
      const result = checkStepTypeValidity(proposal);
      assert.equal(result.passed, true, `Expected ${stepType} to be valid`);
    }
  });

  it('fails when a step has an invalid type', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'EMIT_EVENT', params: { event: 'foo' } },
      ],
    });
    const result = checkStepTypeValidity(proposal);
    assert.equal(result.passed, false);
    assert.ok(result.message.includes('EMIT_EVENT'), 'Message should name the invalid type');
    assert.ok(result.message.includes('LLM_GENERATE'), 'Message should list valid types');
  });

  it('fails and names every invalid step when multiple are wrong', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'EMIT_EVENT', params: {} },
        { index: 1, stepType: 'LLM_GENERATE', params: { purpose: 'ok' } },
        { index: 2, stepType: 'UNKNOWN_TYPE', params: {} },
      ],
    });
    const result = checkStepTypeValidity(proposal);
    assert.equal(result.passed, false);
    assert.ok(result.message.includes('step[0]'));
    assert.ok(result.message.includes('step[2]'));
    // Valid step at index 1 should not appear in the failure message
    assert.ok(!result.message.includes('step[1]'));
  });

  it('passes for an empty action sequence', () => {
    const proposal = makeProposal({ actionSequence: [] });
    const result = checkStepTypeValidity(proposal);
    assert.equal(result.passed, true);
  });
});

// ---------------------------------------------------------------------------
// 2. checkAddressesOpportunity
// ---------------------------------------------------------------------------

describe('checkAddressesOpportunity', () => {
  it('passes when rationale contains the opportunity classification', () => {
    const proposal = makeProposal({
      rationale: 'This addresses PREDICTION_FAILURE_PATTERN for the agent.',
      triggerContext: 'some-generic-context',
    });
    const opp = makeOpportunity({ contextFingerprint: 'ctx-xyz999' });
    const result = checkAddressesOpportunity(proposal, opp);
    assert.equal(result.passed, true);
  });

  it('passes when rationale contains the affected drive', () => {
    const proposal = makeProposal({
      rationale: 'This plan reduces curiosity drive pressure.',
      triggerContext: 'generic-ctx',
    });
    const opp = makeOpportunity({ contextFingerprint: 'ctx-xyz999' });
    const result = checkAddressesOpportunity(proposal, opp);
    assert.equal(result.passed, true);
  });

  it('passes when triggerContext matches the opportunity contextFingerprint exactly', () => {
    const proposal = makeProposal({
      rationale: 'Generic plan with no explicit references',
      triggerContext: 'ctx-abc123',
    });
    const opp = makeOpportunity({ contextFingerprint: 'ctx-abc123' });
    const result = checkAddressesOpportunity(proposal, opp);
    assert.equal(result.passed, true);
  });

  it('passes via case-insensitive matching', () => {
    const proposal = makeProposal({
      rationale: 'Handles prediction_failure_pattern situation for CURIOSITY.',
      triggerContext: 'unrelated-context',
    });
    const opp = makeOpportunity({ contextFingerprint: 'ctx-xyz999' });
    const result = checkAddressesOpportunity(proposal, opp);
    assert.equal(result.passed, true);
  });

  it('fails when proposal contains no reference to classification, drive, or context', () => {
    const proposal = makeProposal({
      name: 'generic-plan',
      rationale: 'This is a completely generic rationale about nothing specific.',
      triggerContext: 'unrelated-fingerprint',
      actionSequence: [
        { index: 0, stepType: 'LLM_GENERATE', params: { purpose: 'talk' } },
      ],
    });
    const opp = makeOpportunity({
      classification: 'BEHAVIORAL_NARROWING',
      affectedDrive: DriveName.Focus,
      contextFingerprint: 'ctx-unmatched-xyz',
    });
    const result = checkAddressesOpportunity(proposal, opp);
    assert.equal(result.passed, false);
    assert.ok(result.message.includes('BEHAVIORAL_NARROWING'));
    assert.ok(result.message.includes(DriveName.Focus));
  });

  it('passes when classification appears in a step param', () => {
    const proposal = makeProposal({
      rationale: 'Generic.',
      triggerContext: 'generic',
      actionSequence: [
        {
          index: 0,
          stepType: 'LLM_GENERATE',
          params: { purpose: 'address guardian_teaching scenario', instruction: 'do something' },
        },
      ],
    });
    const opp = makeOpportunity({
      classification: 'GUARDIAN_TEACHING',
      affectedDrive: DriveName.Social,
      contextFingerprint: 'ctx-xyz999',
    });
    const result = checkAddressesOpportunity(proposal, opp);
    assert.equal(result.passed, true);
  });
});

// ---------------------------------------------------------------------------
// 3. checkProcedureConflict
// ---------------------------------------------------------------------------

describe('checkProcedureConflict', () => {
  it('passes when existingTriggerContexts is empty', () => {
    const result = checkProcedureConflict(makeProposal(), new Set());
    assert.equal(result.passed, true);
  });

  it('passes when triggerContext is not in existing set', () => {
    const existing = new Set(['ctx-other1', 'ctx-other2']);
    const result = checkProcedureConflict(makeProposal(), existing);
    assert.equal(result.passed, true);
  });

  it('fails when triggerContext exactly matches an existing one', () => {
    const triggerContext = 'prediction_failure_pattern:curiosity:ctx-abc123';
    const existing = new Set([triggerContext, 'ctx-unrelated']);
    const proposal = makeProposal({ triggerContext });
    const result = checkProcedureConflict(proposal, existing);
    assert.equal(result.passed, false);
    assert.ok(result.message.includes(triggerContext));
  });

  it('does NOT fail on partial match -- only exact string equality', () => {
    const existing = new Set(['prediction_failure_pattern:curiosity:ctx-abc12']); // truncated
    const proposal = makeProposal({
      triggerContext: 'prediction_failure_pattern:curiosity:ctx-abc123',
    });
    const result = checkProcedureConflict(proposal, existing);
    assert.equal(result.passed, true);
  });
});

// ---------------------------------------------------------------------------
// 4. checkNoTheatricalBehavior
// ---------------------------------------------------------------------------

describe('checkNoTheatricalBehavior', () => {
  it('passes when expressive steps are backed by non-zero drive effects', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'LLM_GENERATE', params: { purpose: 'respond' } },
      ],
      predictedDriveEffects: { [DriveName.Curiosity]: -0.3 },
    });
    const result = checkNoTheatricalBehavior(proposal);
    assert.equal(result.passed, true);
  });

  it('passes for non-expressive plans even with zero drive effects', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'WKG_QUERY', params: { query: 'SELECT ...' } },
        { index: 1, stepType: 'LOG_EVENT', params: { event: 'query_done' } },
      ],
      predictedDriveEffects: {},
    });
    const result = checkNoTheatricalBehavior(proposal);
    assert.equal(result.passed, true);
    assert.ok(result.message.includes('no expressive steps'));
  });

  it('fails when an LLM_GENERATE step has no drive effects', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'LLM_GENERATE', params: { purpose: 'say something' } },
      ],
      predictedDriveEffects: {},
    });
    const result = checkNoTheatricalBehavior(proposal);
    assert.equal(result.passed, false);
    assert.ok(result.message.includes('Theater Prohibition') || result.message.includes('CANON Standard 1'));
  });

  it('fails when a TTS_SPEAK step has only zero drive effects', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'TTS_SPEAK', params: { text: 'Hello!' } },
      ],
      predictedDriveEffects: { [DriveName.Curiosity]: 0, [DriveName.Satisfaction]: 0 },
    });
    const result = checkNoTheatricalBehavior(proposal);
    assert.equal(result.passed, false);
  });

  it('passes when TTS_SPEAK is backed by a negative drive effect (relief)', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'TTS_SPEAK', params: { text: 'Hello!' } },
      ],
      predictedDriveEffects: { [DriveName.Social]: -0.2 },
    });
    const result = checkNoTheatricalBehavior(proposal);
    assert.equal(result.passed, true);
  });

  it('passes for a mixed plan where one step is expressive and drive effects exist', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'WKG_QUERY', params: { query: 'SELECT ...' } },
        { index: 1, stepType: 'LLM_GENERATE', params: { purpose: 'respond' } },
      ],
      predictedDriveEffects: { [DriveName.Focus]: -0.15 },
    });
    const result = checkNoTheatricalBehavior(proposal);
    assert.equal(result.passed, true);
  });
});

// ---------------------------------------------------------------------------
// 5. checkContingencyTracing
// ---------------------------------------------------------------------------

describe('checkContingencyTracing', () => {
  it('passes when all steps have non-empty params with required fields', () => {
    const result = checkContingencyTracing(makeProposal());
    assert.equal(result.passed, true);
  });

  it('fails when a step has empty params', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'LOG_EVENT', params: {} },
      ],
    });
    const result = checkContingencyTracing(proposal);
    assert.equal(result.passed, false);
    assert.ok(result.message.includes('step[0]'));
    assert.ok(result.message.includes('empty params'));
  });

  it('fails when a WKG_QUERY step is missing the "query" param', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'WKG_QUERY', params: { filter: 'something' } },
      ],
    });
    const result = checkContingencyTracing(proposal);
    assert.equal(result.passed, false);
    assert.ok(result.message.includes('WKG_QUERY'));
    assert.ok(result.message.includes('"query"'));
  });

  it('fails when a WKG_QUERY step has an empty query string', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'WKG_QUERY', params: { query: '   ' } },
      ],
    });
    const result = checkContingencyTracing(proposal);
    assert.equal(result.passed, false);
  });

  it('fails when an LLM_GENERATE step has neither "purpose" nor "instruction"', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'LLM_GENERATE', params: { temperature: 0.7 } },
      ],
    });
    const result = checkContingencyTracing(proposal);
    assert.equal(result.passed, false);
    assert.ok(result.message.includes('LLM_GENERATE'));
    assert.ok(result.message.includes('"purpose"') || result.message.includes('"instruction"'));
  });

  it('passes when an LLM_GENERATE step has a "purpose" param', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'LLM_GENERATE', params: { purpose: 'generate_response' } },
      ],
    });
    const result = checkContingencyTracing(proposal);
    assert.equal(result.passed, true);
  });

  it('passes when an LLM_GENERATE step has an "instruction" param but no "purpose"', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'LLM_GENERATE', params: { instruction: 'Explain the concept.' } },
      ],
    });
    const result = checkContingencyTracing(proposal);
    assert.equal(result.passed, true);
  });

  it('fails and reports all violations when multiple steps have issues', () => {
    const proposal = makeProposal({
      actionSequence: [
        { index: 0, stepType: 'WKG_QUERY', params: { filter: 'only filter, no query' } },
        { index: 1, stepType: 'LLM_GENERATE', params: { context: 'some context' } },
        { index: 2, stepType: 'TTS_SPEAK', params: { text: 'hello' } },
      ],
    });
    const result = checkContingencyTracing(proposal);
    assert.equal(result.passed, false);
    // Both WKG_QUERY and LLM_GENERATE violations should be reported
    assert.ok(result.message.includes('step[0]'));
    assert.ok(result.message.includes('step[1]'));
    // TTS_SPEAK is fine (non-empty params, no special requirement)
    assert.ok(!result.message.includes('step[2]'));
  });

  it('passes for an empty action sequence', () => {
    const proposal = makeProposal({ actionSequence: [] });
    const result = checkContingencyTracing(proposal);
    assert.equal(result.passed, true);
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}

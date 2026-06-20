/**
 * Integration tests for ConstraintValidationService.
 *
 * These tests verify end-to-end behaviour of validate() including:
 *   - fetchExistingTriggerContexts() hits a real Cypher path (mocked Neo4j session)
 *   - Constraint 3 (PROCEDURE_CONFLICT) fires when a duplicate trigger context is returned
 *   - Fail-closed behaviour: Neo4j unreachable → deferred result, no false positives
 *
 * Acceptance criteria (TK-65 / EP14.4):
 *   AC1: duplicate trigger → validate() returns passed=false, violations=['procedure_conflict']
 *   AC2: empty set (no nodes) or Neo4j unreachable → no PROCEDURE_CONFLICT violation,
 *        and on error the result is deferred (not a blind pass)
 *
 * Run via: npx tsx packages/planning/src/pipeline/constraint-validation.service.spec.ts
 *
 * Uses zero external dependencies: Neo4j, ProposalService, and EventLogger are all
 * simple in-process stubs. No NestJS DI container needed.
 */

import assert from 'node:assert/strict';
import { ConstraintValidationService } from './constraint-validation.service.js';
import type {
  PlanProposal,
  QueuedOpportunity,
  IProposalService,
  IPlanningEventLogger,
  PlanningEventType,
  ValidationResult,
} from '../interfaces/planning.interfaces.js';
import { DriveName, type Neo4jService } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Stub types (match the shapes the service calls — nothing more)
// ---------------------------------------------------------------------------

/** Minimal Neo4j session stub. run() returns a record array; close() is a no-op. */
interface StubSession {
  run(query: string): Promise<{ records: Array<{ get(key: string): unknown }> }>;
  close(): Promise<void>;
}

/** Minimal Neo4jService stub — getSession() returns the provided StubSession. */
class StubNeo4jService {
  constructor(private readonly session: StubSession) {}

  getSession(_name: unknown, _mode: unknown): StubSession {
    return this.session;
  }
}

/** IProposalService stub — refine() echoes the proposal back unchanged.
 *  Structurally typed; cast to IProposalService at the injection site. */
class StubProposalService {
  async generate(_opportunity: QueuedOpportunity): Promise<PlanProposal> {
    throw new Error('StubProposalService.generate should not be called in this test');
  }

  async refine(
    proposal: PlanProposal,
    _violations: readonly string[],
    _opportunity: QueuedOpportunity,
  ): Promise<PlanProposal> {
    // Return the same proposal unchanged so that retry attempts hit the same
    // constraint failure and exhaust MAX_RETRIES cleanly without masking the
    // violation we are asserting on.
    return proposal;
  }
}

/** IPlanningEventLogger stub — collects all calls for assertion. */
class StubEventLogger implements IPlanningEventLogger {
  readonly calls: Array<{ eventType: PlanningEventType; payload: Record<string, unknown> }> = [];

  log(eventType: PlanningEventType, payload: Record<string, unknown>): void {
    this.calls.push({ eventType, payload });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposal(overrides: Partial<PlanProposal> = {}): PlanProposal {
  return {
    name: 'test-plan',
    category: 'SelfRegulation',
    triggerContext: 'prediction_failure_pattern:curiosity:ctx-abc123',
    rationale:
      'Addresses PREDICTION_FAILURE_PATTERN for curiosity drive.',
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
    predictedDriveEffects: { [DriveName.Curiosity]: -0.3 },
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

/**
 * Build a Neo4j session stub that returns the given trigger_context strings
 * as if queried from WORLD (i.e. MATCH (p:ActionProcedure) RETURN p.trigger_context).
 */
function sessionReturning(triggerContexts: string[]): StubSession {
  return {
    async run(_query: string) {
      return {
        records: triggerContexts.map((ctx) => ({
          get(key: string) {
            if (key === 'ctx') return ctx;
            throw new Error(`Unexpected record key: ${key}`);
          },
        })),
      };
    },
    async close() {},
  };
}

/** Build a Neo4j session stub whose run() throws to simulate DB unreachability. */
function sessionThrowing(errorMessage: string): StubSession {
  return {
    async run(_query: string): Promise<never> {
      throw new Error(errorMessage);
    },
    async close() {},
  };
}

/**
 * Construct a ConstraintValidationService with the given session.
 * NestJS DI is bypassed — the service's constructor params are injected directly.
 */
function buildService(session: StubSession): {
  service: ConstraintValidationService;
  eventLogger: StubEventLogger;
} {
  const eventLogger = new StubEventLogger();
  const neo4j = new StubNeo4jService(session);
  const proposalService = new StubProposalService();

  // ConstraintValidationService constructor: (proposalService, eventLogger, neo4j)
  const service = new ConstraintValidationService(
    proposalService as unknown as IProposalService,
    eventLogger as unknown as IPlanningEventLogger,
    neo4j as unknown as Neo4jService,
  );
  return { service, eventLogger };
}

// ---------------------------------------------------------------------------
// Test runner (matches the pattern used in constraint-checks.spec.ts)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function describe(suiteName: string, fn: () => void): void {
  console.log(`\n  ${suiteName}`);
  fn();
}

function it(testName: string, fn: () => Promise<void> | void): void {
  // Wrap async tests: we run them synchronously via a resolution trick below.
  // We collect results after all tests are registered.
  pendingTests.push({ testName, fn });
}

const pendingTests: Array<{ testName: string; fn: () => Promise<void> | void }> = [];

// ---------------------------------------------------------------------------
// AC1 — Duplicate trigger fires constraint 3
// ---------------------------------------------------------------------------

describe('AC1: duplicate trigger context → PROCEDURE_CONFLICT violation', () => {
  it('given an ActionProcedure with trigger_context="greet" in WORLD, validate() returns passed=false with procedure_conflict in violations', async () => {
    // The WORLD session returns "greet" as an existing trigger context.
    const { service } = buildService(sessionReturning(['greet']));

    const proposal = makeProposal({ triggerContext: 'greet' });
    const opportunity = makeOpportunity();

    const result: ValidationResult = await service.validate(proposal, opportunity);

    assert.equal(result.passed, false, 'validate() must fail when trigger context is a duplicate');
    assert.ok(
      result.violations.includes('procedure_conflict'),
      `violations must contain "procedure_conflict"; got: ${JSON.stringify(result.violations)}`,
    );
    assert.equal(result.deferred, false, 'a conflict failure is not a deferral');
    assert.ok(result.reasoning.includes('greet'), 'reasoning should name the conflicting context');
  });

  it('fires on an exact match only — non-matching existing contexts do not conflict', async () => {
    const { service } = buildService(sessionReturning(['greet-extended', 'other-context']));

    const proposal = makeProposal({ triggerContext: 'greet' });
    const opportunity = makeOpportunity();

    const result = await service.validate(proposal, opportunity);

    // "greet" is NOT in the existing set — no PROCEDURE_CONFLICT expected.
    // (The proposal still passes all other constraints.)
    assert.equal(result.deferred, false);
    assert.ok(
      !result.violations.includes('procedure_conflict'),
      `violations must NOT contain procedure_conflict; got: ${JSON.stringify(result.violations)}`,
    );
  });

  it('fires on any non-empty duplicate, not just "greet"', async () => {
    const ctx = 'prediction_failure_pattern:curiosity:ctx-abc123';
    const { service } = buildService(sessionReturning([ctx, 'unrelated-ctx']));

    const proposal = makeProposal({ triggerContext: ctx });
    const opportunity = makeOpportunity();

    const result = await service.validate(proposal, opportunity);

    assert.equal(result.passed, false);
    assert.ok(result.violations.includes('procedure_conflict'));
  });
});

// ---------------------------------------------------------------------------
// AC2 — No false positives when no existing procedures / DB unreachable
// ---------------------------------------------------------------------------

describe('AC2a: no ActionProcedure nodes → empty set, no false positives', () => {
  it('given no ActionProcedure nodes, validate() passes when all other constraints are met', async () => {
    // Empty record list → fetchExistingTriggerContexts returns ok:true, contexts:Set{}
    const { service } = buildService(sessionReturning([]));

    const proposal = makeProposal();
    const opportunity = makeOpportunity();

    const result = await service.validate(proposal, opportunity);

    assert.equal(result.passed, true, 'must pass when no existing procedures conflict');
    assert.equal(result.violations.length, 0);
    assert.equal(result.deferred, false);
  });

  it('a proposal with a unique triggerContext passes even if other procedures exist', async () => {
    const { service } = buildService(sessionReturning(['ctx-other-1', 'ctx-other-2']));

    const proposal = makeProposal({ triggerContext: 'ctx-unique-xyz' });
    const opportunity = makeOpportunity();

    const result = await service.validate(proposal, opportunity);

    assert.equal(result.passed, true);
    assert.ok(!result.violations.includes('procedure_conflict'));
    assert.equal(result.deferred, false);
  });
});

describe('AC2b: Neo4j unreachable → fail-closed defer, no false positive pass', () => {
  it('when getSession().run() throws, validate() returns deferred=true instead of passing blindly', async () => {
    const { service, eventLogger } = buildService(sessionThrowing('ECONNREFUSED'));

    const proposal = makeProposal();
    const opportunity = makeOpportunity();

    const result = await service.validate(proposal, opportunity);

    // Must NOT silently pass — that would write a possibly-duplicate procedure.
    assert.equal(result.passed, false, 'must not pass when the conflict check is blind');
    assert.equal(result.deferred, true, 'must set deferred=true so PlanningService re-enqueues');
    // violations is empty on a deferral (the check could not run, not a constraint fail)
    assert.equal(result.violations.length, 0, 'deferred results carry no constraint violations');
    assert.ok(result.reasoning.includes('unreachable'), 'reasoning must explain why it deferred');

    // The event logger should have received a PLAN_VALIDATION_FAILED event.
    const failedEvents = eventLogger.calls.filter(
      (c) => c.eventType === 'PLAN_VALIDATION_FAILED',
    );
    assert.equal(failedEvents.length, 1, 'should emit exactly one PLAN_VALIDATION_FAILED event');
    assert.equal(failedEvents[0].payload['deferred'], true);
  });

  it('deferred result carries the opportunityId in reasoning', async () => {
    const { service } = buildService(sessionThrowing('neo4j service error'));

    const opportunity = makeOpportunity({ id: 'opp-defer-42' });
    const proposal = makeProposal();

    const result = await service.validate(proposal, opportunity);

    assert.equal(result.deferred, true);
    assert.ok(
      result.reasoning.includes('opp-defer-42'),
      'reasoning must include the opportunity id for traceability',
    );
  });
});

// ---------------------------------------------------------------------------
// Run all tests (async)
// ---------------------------------------------------------------------------

async function runAll(): Promise<void> {
  for (const { testName, fn } of pendingTests) {
    try {
      await fn();
      console.log(`    PASS  ${testName}`);
      passed++;
    } catch (err) {
      console.error(`    FAIL  ${testName}`);
      console.error(`          ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});

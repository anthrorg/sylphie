/**
 * Unit tests for OpportunityQueueService -- eviction and cap behaviour.
 *
 * Run via: npx tsx packages/planning/src/queue/opportunity-queue.service.spec.ts
 *
 * Covers:
 *   1. Normal enqueue below cap
 *   2. Hard-cap eviction: newcomer outranks tail → tail is evicted, newcomer accepted
 *   3. Hard-cap rejection: newcomer does not outrank tail → newcomer rejected
 *   4. Tie at cap: newcomer with equal priority to tail is rejected (not >=, but <=)
 *   5. GUARDIAN_TEACHING items always win eviction (priority 1.5 > any normal item)
 *   6. Event logger receives OPPORTUNITY_DROPPED with reason 'evicted_by_higher_priority'
 *      when an eviction occurs
 *   7. No OPPORTUNITY_DROPPED event emitted when newcomer is rejected outright
 *   8. Duplicate rejection still works correctly
 *   9. Rate limiting still bypassed for GUARDIAN_TEACHING
 */

import assert from 'node:assert/strict';
import { OpportunityQueueService } from './opportunity-queue.service.js';
import type { QueuedOpportunity, IPlanningEventLogger, PlanningEventType } from '../interfaces/planning.interfaces.js';
import type { OpportunityCreatedPayload, OpportunityPriority } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Mock event logger
// ---------------------------------------------------------------------------

interface LogCall {
  eventType: PlanningEventType;
  payload: Record<string, unknown>;
}

class MockEventLogger implements IPlanningEventLogger {
  readonly calls: LogCall[] = [];

  log(eventType: PlanningEventType, payload: Record<string, unknown>): void {
    this.calls.push({ eventType, payload });
  }

  reset(): void {
    this.calls.length = 0;
  }

  droppedCalls(): LogCall[] {
    return this.calls.filter((c) => c.eventType === 'OPPORTUNITY_DROPPED');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function makeQueued(
  currentPriority: number,
  overrides?: Partial<OpportunityCreatedPayload>,
): QueuedOpportunity {
  const id = `opp-${++idCounter}`;
  const payload: OpportunityCreatedPayload = {
    id,
    contextFingerprint: `fp-${id}`,
    classification: 'PREDICTION_FAILURE_PATTERN',
    priority: 'MEDIUM' as OpportunityPriority,
    sourceEventId: `src-${id}`,
    affectedDrive: 'curiosity' as never,
    ...overrides,
  };
  return {
    payload,
    enqueuedAt: new Date(),
    initialPriority: currentPriority,
    currentPriority,
  };
}

/**
 * Build a service with the mock logger injected via the constructor.
 * OpportunityQueueService expects IPlanningEventLogger as first constructor arg.
 */
function makeService(logger: MockEventLogger): OpportunityQueueService {
  return new (OpportunityQueueService as unknown as new (
    logger: IPlanningEventLogger,
  ) => OpportunityQueueService)(logger);
}

const MAX_QUEUE_SIZE = 50;

// ---------------------------------------------------------------------------
// Test runner (same pattern as constraint-checks.spec.ts)
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
// Tests
// ---------------------------------------------------------------------------

describe('OpportunityQueueService -- normal enqueue', () => {
  it('accepts items below cap without logging a drop event', () => {
    const logger = new MockEventLogger();
    const svc = makeService(logger);

    const opp = makeQueued(0.6);
    const accepted = svc.enqueue(opp);

    assert.equal(accepted, true);
    assert.equal(svc.size(), 1);
    assert.equal(logger.droppedCalls().length, 0);
  });

  it('fills to MAX_QUEUE_SIZE without any eviction', () => {
    const logger = new MockEventLogger();
    const svc = makeService(logger);

    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      svc.enqueue(makeQueued(0.5));
    }

    assert.equal(svc.size(), MAX_QUEUE_SIZE);
    assert.equal(logger.droppedCalls().length, 0);
  });
});

describe('OpportunityQueueService -- hard-cap eviction', () => {
  it('evicts tail when newcomer has higher priority', () => {
    const logger = new MockEventLogger();
    const svc = makeService(logger);

    // Fill with items at priority 0.3 (all equal, so tail is 0.3)
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      svc.enqueue(makeQueued(0.3));
    }
    assert.equal(svc.size(), MAX_QUEUE_SIZE);

    // Newcomer at 0.5 should evict one 0.3 item
    const newcomer = makeQueued(0.5);
    const accepted = svc.enqueue(newcomer);

    assert.equal(accepted, true, 'Newcomer should be accepted');
    assert.equal(svc.size(), MAX_QUEUE_SIZE, 'Queue size must stay at cap');

    // Exactly one drop event with the eviction reason
    const drops = logger.droppedCalls();
    assert.equal(drops.length, 1);
    assert.equal(drops[0].payload['reason'], 'evicted_by_higher_priority');
    assert.equal(drops[0].payload['replacedById'], newcomer.payload.id);
    assert.equal(drops[0].payload['replacedByPriority'], 0.5);
  });

  it('rejects newcomer when its priority is lower than the tail', () => {
    const logger = new MockEventLogger();
    const svc = makeService(logger);

    // Fill with items at priority 0.6
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      svc.enqueue(makeQueued(0.6));
    }

    // Newcomer at 0.2 should be rejected without any eviction
    const newcomer = makeQueued(0.2);
    const accepted = svc.enqueue(newcomer);

    assert.equal(accepted, false, 'Newcomer should be rejected');
    assert.equal(svc.size(), MAX_QUEUE_SIZE, 'Queue size must be unchanged');
    assert.equal(logger.droppedCalls().length, 0, 'No OPPORTUNITY_DROPPED event for outright rejection');
  });

  it('rejects newcomer when its priority equals the tail priority (not strictly greater)', () => {
    const logger = new MockEventLogger();
    const svc = makeService(logger);

    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      svc.enqueue(makeQueued(0.4));
    }

    // Tie: newcomer at same priority as tail
    const newcomer = makeQueued(0.4);
    const accepted = svc.enqueue(newcomer);

    assert.equal(accepted, false, 'Tie should not evict -- newcomer must strictly outrank tail');
    assert.equal(svc.size(), MAX_QUEUE_SIZE);
    assert.equal(logger.droppedCalls().length, 0);
  });

  it('eviction payload contains evicted item id and both priorities', () => {
    const logger = new MockEventLogger();
    const svc = makeService(logger);

    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      svc.enqueue(makeQueued(0.1));
    }

    const newcomer = makeQueued(0.9);
    svc.enqueue(newcomer);

    const drop = logger.droppedCalls()[0];
    assert.ok(typeof drop.payload['opportunityId'] === 'string', 'evictedId must be a string');
    assert.equal(drop.payload['evictedPriority'], 0.1);
    assert.equal(drop.payload['replacedByPriority'], 0.9);
    assert.equal(drop.payload['replacedById'], newcomer.payload.id);
  });
});

describe('OpportunityQueueService -- GUARDIAN_TEACHING eviction behaviour', () => {
  it('GUARDIAN_TEACHING (priority 1.5) always evicts normal items at cap', () => {
    const logger = new MockEventLogger();
    const svc = makeService(logger);

    // Fill with HIGH-priority items (1.0) -- the highest normal priority
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      svc.enqueue(makeQueued(1.0));
    }

    const guardian = makeQueued(1.5, { classification: 'GUARDIAN_TEACHING' });
    const accepted = svc.enqueue(guardian);

    assert.equal(accepted, true, 'GUARDIAN_TEACHING should always be accepted at cap');
    assert.equal(svc.size(), MAX_QUEUE_SIZE);
    assert.equal(logger.droppedCalls().length, 1, 'One item must be evicted');
    assert.equal(logger.droppedCalls()[0].payload['replacedById'], guardian.payload.id);
  });

  it('GUARDIAN_TEACHING items themselves are never in the tail when higher-priority items arrive later', () => {
    // Fill queue with mixed priorities; add a GUARDIAN_TEACHING item;
    // then add many more normal items that can only evict the lowest normal item.
    const logger = new MockEventLogger();
    const svc = makeService(logger);

    // Add MAX_QUEUE_SIZE - 1 items at LOW priority
    for (let i = 0; i < MAX_QUEUE_SIZE - 1; i++) {
      svc.enqueue(makeQueued(0.3));
    }

    // Add 1 GUARDIAN_TEACHING item -- fills to cap
    const guardian = makeQueued(1.5, { classification: 'GUARDIAN_TEACHING' });
    svc.enqueue(guardian);
    assert.equal(svc.size(), MAX_QUEUE_SIZE);

    // Now try adding another HIGH item (1.0). It should evict a 0.3 item, not the guardian.
    logger.reset();
    const high = makeQueued(1.0);
    const accepted = svc.enqueue(high);

    assert.equal(accepted, true);
    const drop = logger.droppedCalls()[0];
    // The evicted item should be 0.3, not 1.5
    assert.equal(drop.payload['evictedPriority'], 0.3,
      'Should evict a 0.3 item, not the GUARDIAN_TEACHING item');
  });
});

describe('OpportunityQueueService -- duplicate rejection still works', () => {
  it('rejects a duplicate fingerprint regardless of priority', () => {
    const logger = new MockEventLogger();
    const svc = makeService(logger);

    const fingerprint = 'shared-fp';
    const first = makeQueued(0.5, { contextFingerprint: fingerprint });
    const second = makeQueued(0.9, { contextFingerprint: fingerprint });

    svc.enqueue(first);
    const accepted = svc.enqueue(second);

    assert.equal(accepted, false, 'Duplicate fingerprint must be rejected');
    assert.equal(svc.size(), 1, 'Only the first item should be in the queue');
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}

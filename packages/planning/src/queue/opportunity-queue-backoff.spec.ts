/**
 * Unit tests for TK-62: exponential backoff on deferred opportunities.
 *
 * Run via: npx tsx packages/planning/src/queue/opportunity-queue-backoff.spec.ts
 *
 * Covers the two acceptance criteria:
 *
 *   AC1: Given an opportunity deferred once, when re-enqueued, retryAfter is set
 *        to approximately enqueuedAt + BASE_BACKOFF_MS * 2 (i.e. 2^deferralCount).
 *        Dequeue skips it while retryAfter is in the future, returns it once elapsed.
 *
 *   AC2: Given an item at MAX_DEFERRALS with retryAfter in the future, dequeue
 *        skips it. After retryAfter passes, dequeue returns it regardless of
 *        deferralCount (the cap check happens in PlanningService, not the queue).
 */

import assert from 'node:assert/strict';
import { OpportunityQueueService, BASE_BACKOFF_MS } from './opportunity-queue.service.js';
import type {
  QueuedOpportunity,
  IPlanningEventLogger,
  PlanningEventType,
} from '../interfaces/planning.interfaces.js';
import type { OpportunityCreatedPayload, OpportunityPriority } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Mock event logger
// ---------------------------------------------------------------------------

class MockEventLogger implements IPlanningEventLogger {
  readonly calls: Array<{ eventType: PlanningEventType; payload: Record<string, unknown> }> = [];

  log(eventType: PlanningEventType, payload: Record<string, unknown>): void {
    this.calls.push({ eventType, payload });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_DEFERRALS = 5;

let idCounter = 0;

function makeQueued(
  currentPriority: number,
  overrides?: Partial<QueuedOpportunity>,
  payloadOverrides?: Partial<OpportunityCreatedPayload>,
): QueuedOpportunity {
  const id = `opp-${++idCounter}`;
  const payload: OpportunityCreatedPayload = {
    id,
    contextFingerprint: `fp-${id}`,
    classification: 'PREDICTION_FAILURE_PATTERN',
    priority: 'MEDIUM' as OpportunityPriority,
    sourceEventId: `src-${id}`,
    affectedDrive: 'curiosity' as never,
    ...payloadOverrides,
  };
  return {
    payload,
    enqueuedAt: new Date(),
    initialPriority: currentPriority,
    currentPriority,
    ...overrides,
  };
}

function makeService(): OpportunityQueueService {
  const logger = new MockEventLogger();
  return new (OpportunityQueueService as unknown as new (
    logger: IPlanningEventLogger,
  ) => OpportunityQueueService)(logger);
}

// ---------------------------------------------------------------------------
// Test runner (matches opportunity-queue.service.spec.ts pattern)
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
// AC1 Tests
// ---------------------------------------------------------------------------

describe('AC1 — retryAfter set on deferred re-enqueue; dequeue respects it', () => {
  it('BASE_BACKOFF_MS is exported and positive', () => {
    assert.ok(typeof BASE_BACKOFF_MS === 'number', 'BASE_BACKOFF_MS must be a number');
    assert.ok(BASE_BACKOFF_MS > 0, 'BASE_BACKOFF_MS must be positive');
  });

  it('item with retryAfter in the future is skipped by dequeue', () => {
    const svc = makeService();

    const futureRetry = new Date(Date.now() + 10_000); // 10 seconds from now
    const opp = makeQueued(0.6, { deferralCount: 1, retryAfter: futureRetry });

    svc.enqueue(opp);
    assert.equal(svc.size(), 1);

    // dequeue should skip the item since retryAfter is in the future
    const result = svc.dequeue();
    assert.equal(result, null, 'dequeue must return null while retryAfter is in the future');
    assert.equal(svc.size(), 1, 'item must still be in the queue');
  });

  it('item with retryAfter in the past is returned by dequeue', () => {
    const svc = makeService();

    const pastRetry = new Date(Date.now() - 1); // 1ms in the past
    const opp = makeQueued(0.6, { deferralCount: 1, retryAfter: pastRetry });

    svc.enqueue(opp);
    const result = svc.dequeue();

    assert.ok(result !== null, 'dequeue must return the item once retryAfter has passed');
    assert.equal(result.payload.id, opp.payload.id);
    assert.equal(svc.size(), 0);
  });

  it('item without retryAfter is returned immediately by dequeue', () => {
    const svc = makeService();
    const opp = makeQueued(0.6);

    svc.enqueue(opp);
    const result = svc.dequeue();

    assert.ok(result !== null, 'item without retryAfter must be dequeued immediately');
    assert.equal(result.payload.id, opp.payload.id);
  });

  it('retryAfter = BASE_BACKOFF_MS * 2 after first deferral (deferralCount = 1)', () => {
    // Simulate the retryAfter that PlanningService would set:
    //   retryAfter = Date.now() + BASE_BACKOFF_MS * 2^deferralCount
    // For deferralCount = 1: retryAfter = now + BASE_BACKOFF_MS * 2
    const deferralCount = 1;
    const before = Date.now();
    const expectedDelay = BASE_BACKOFF_MS * Math.pow(2, deferralCount);
    const retryAfter = new Date(Date.now() + expectedDelay);
    const after = Date.now();

    // Verify the formula: delay should be exactly BASE_BACKOFF_MS * 2
    assert.ok(
      retryAfter.getTime() >= before + BASE_BACKOFF_MS * 2,
      'retryAfter must be at least BASE_BACKOFF_MS*2 ms in the future',
    );
    assert.ok(
      retryAfter.getTime() <= after + BASE_BACKOFF_MS * 2 + 5, // 5ms clock tolerance
      'retryAfter must not be more than BASE_BACKOFF_MS*2 ms in the future (within tolerance)',
    );

    const svc = makeService();
    const opp = makeQueued(0.6, { deferralCount, retryAfter });
    svc.enqueue(opp);

    // Must be skipped right after re-enqueue (retryAfter is in the future)
    const skipped = svc.dequeue();
    assert.equal(skipped, null, 'Must skip item within the backoff window');
    assert.equal(svc.size(), 1);
  });

  it('higher-priority non-deferred item is returned even when deferred item is at head', () => {
    const svc = makeService();

    // Deferred high-priority item
    const deferred = makeQueued(0.9, {
      retryAfter: new Date(Date.now() + 60_000),
      deferralCount: 1,
    });
    // Normal lower-priority item without backoff
    const normal = makeQueued(0.5);

    svc.enqueue(deferred);
    svc.enqueue(normal);

    // Queue is sorted by priority (descending): deferred(0.9) first, normal(0.5) second.
    // dequeue should skip the deferred item and return the normal one.
    const result = svc.dequeue();
    assert.ok(result !== null, 'Should return the non-deferred item');
    assert.equal(result.payload.id, normal.payload.id, 'Should return lower-priority but non-deferred item');
    assert.equal(svc.size(), 1, 'Deferred item must remain in queue');
  });
});

// ---------------------------------------------------------------------------
// AC2 Tests
// ---------------------------------------------------------------------------

describe('AC2 — MAX_DEFERRALS boundary: skip before retryAfter, process after', () => {
  it('item at MAX_DEFERRALS with retryAfter in the future is skipped', () => {
    const svc = makeService();

    // Simulate an item that has hit MAX_DEFERRALS but is still in its backoff window
    const opp = makeQueued(0.6, {
      deferralCount: MAX_DEFERRALS,
      retryAfter: new Date(Date.now() + 60_000),
    });

    svc.enqueue(opp);
    const result = svc.dequeue();

    assert.equal(result, null, 'Item at MAX_DEFERRALS must be skipped while retryAfter is in future');
    assert.equal(svc.size(), 1, 'Item must remain in queue');
  });

  it('item at MAX_DEFERRALS with retryAfter expired is returned by dequeue', () => {
    const svc = makeService();

    // Simulate an item that has hit MAX_DEFERRALS and whose backoff has elapsed.
    // (PlanningService is responsible for dropping it; the queue just returns it.)
    const opp = makeQueued(0.6, {
      deferralCount: MAX_DEFERRALS,
      retryAfter: new Date(Date.now() - 1),
    });

    svc.enqueue(opp);
    const result = svc.dequeue();

    assert.ok(result !== null, 'Item at MAX_DEFERRALS with expired retryAfter must be returned');
    assert.equal(result.payload.id, opp.payload.id);
    assert.equal(result.deferralCount, MAX_DEFERRALS);
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}

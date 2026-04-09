/**
 * Unit tests for OpportunityQueue -- eviction and cap behaviour.
 *
 * Run via: npx tsx packages/drive-engine/src/drive-process/opportunity-queue.spec.ts
 *
 * Covers:
 *   1. Normal add below cap -- returns true
 *   2. Hard-cap eviction: newcomer outranks tail → tail evicted, newcomer inserted, returns true
 *   3. Hard-cap rejection: newcomer does not outrank tail → rejected, returns false, queue unchanged
 *   4. Tie at cap: newcomer priority equals tail → rejected (must strictly outrank)
 *   5. guardianTriggered items carry the priority set by the scorer -- queue treats them as any other
 *      priority value (the scorer is responsible for assigning elevated priority)
 *   6. Queue remains sorted after eviction
 *   7. getTop, remove, size, getAll still work correctly after eviction
 */

import assert from 'node:assert/strict';
import { OpportunityQueue } from './opportunity-queue.js';
import type { Opportunity } from './opportunity.js';

// Suppress verbose logging during tests
const _originalEnv = process.env['SYLPHIE_VERBOSE'];

// Mock verboseFor to a no-op before importing the module under test.
// Because the module is already imported above, we patch it here via module
// augmentation. Since the spec runs through tsx (no module isolation), we need
// to ensure verboseFor is a no-op. The import at the top already uses the real
// verboseFor, but vlog calls will be no-ops when SYLPHIE_VERBOSE is unset.
// No action needed -- vlog is gated on env var.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function makeOpp(priority: number, guardianTriggered = false): Opportunity {
  const id = `opp-${++idCounter}`;
  return {
    id,
    predictionType: `type-${id}`,
    classification: 'LOW_PRIORITY',
    mae: 0.15,
    failureCount: 1,
    priority,
    sessionNumber: 5,
    totalPressure: 0.4,
    guardianTriggered,
    createdAt: new Date(),
    updatedAt: new Date(),
    consecutiveGoodPredictions: 0,
    contextFingerprint: `fp-${id}`,
  };
}

const MAX_QUEUE_SIZE = 50;

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
// Tests
// ---------------------------------------------------------------------------

describe('OpportunityQueue -- add below cap', () => {
  it('returns true and increments size for a normal add', () => {
    const q = new OpportunityQueue();
    const result = q.add(makeOpp(0.5));
    assert.equal(result, true);
    assert.equal(q.size(), 1);
  });

  it('fills to MAX_QUEUE_SIZE without eviction', () => {
    const q = new OpportunityQueue();
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      const result = q.add(makeOpp(0.5));
      assert.equal(result, true);
    }
    assert.equal(q.size(), MAX_QUEUE_SIZE);
  });
});

describe('OpportunityQueue -- hard-cap eviction', () => {
  it('evicts tail and accepts newcomer when newcomer priority > tail priority', () => {
    const q = new OpportunityQueue();

    // Fill with low-priority items
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      q.add(makeOpp(0.2));
    }
    assert.equal(q.size(), MAX_QUEUE_SIZE);

    const newcomer = makeOpp(0.8);
    const result = q.add(newcomer);

    assert.equal(result, true, 'Newcomer should be accepted');
    assert.equal(q.size(), MAX_QUEUE_SIZE, 'Queue size must stay at cap');

    // The newcomer should be in the queue
    const all = q.getAll();
    assert.ok(all.some((o) => o.id === newcomer.id), 'Newcomer must be in the queue');
  });

  it('rejects newcomer when newcomer priority < tail priority', () => {
    const q = new OpportunityQueue();

    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      q.add(makeOpp(0.7));
    }

    const newcomer = makeOpp(0.1);
    const result = q.add(newcomer);

    assert.equal(result, false, 'Newcomer with lower priority should be rejected');
    assert.equal(q.size(), MAX_QUEUE_SIZE, 'Queue size must be unchanged');

    const all = q.getAll();
    assert.ok(!all.some((o) => o.id === newcomer.id), 'Rejected newcomer must not appear in queue');
  });

  it('rejects newcomer when newcomer priority equals tail priority', () => {
    const q = new OpportunityQueue();

    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      q.add(makeOpp(0.5));
    }

    // Tie case
    const newcomer = makeOpp(0.5);
    const result = q.add(newcomer);

    assert.equal(result, false, 'Tie should not replace tail -- must strictly outrank');
    assert.equal(q.size(), MAX_QUEUE_SIZE);
  });

  it('queue remains sorted after eviction (highest priority first)', () => {
    const q = new OpportunityQueue();

    // Add a mix of priorities
    const priorities = [0.9, 0.7, 0.5, 0.3];
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      q.add(makeOpp(priorities[i % priorities.length]));
    }

    // Evict the lowest item with a high-priority newcomer
    const newcomer = makeOpp(1.0);
    q.add(newcomer);

    const top5 = q.getTop(5);
    // Verify descending order
    for (let i = 0; i < top5.length - 1; i++) {
      assert.ok(
        top5[i].priority >= top5[i + 1].priority,
        `Queue not sorted: ${top5[i].priority} < ${top5[i + 1].priority} at position ${i}`,
      );
    }
  });

  it('multiple consecutive evictions each reduce a lower-priority item', () => {
    const q = new OpportunityQueue();

    // Fill with items at 0.1
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      q.add(makeOpp(0.1));
    }

    // Add 5 newcomers each outranking the tail
    for (let i = 0; i < 5; i++) {
      const result = q.add(makeOpp(0.5 + i * 0.05));
      assert.equal(result, true, `Eviction ${i + 1} should succeed`);
    }

    // Queue should still be at cap
    assert.equal(q.size(), MAX_QUEUE_SIZE);

    // All 5 high-priority items should be present
    const all = q.getAll();
    const highCount = all.filter((o) => o.priority >= 0.5).length;
    assert.equal(highCount, 5);
  });
});

describe('OpportunityQueue -- guardianTriggered behaviour', () => {
  it('guardianTriggered item with high priority evicts low-priority tail', () => {
    const q = new OpportunityQueue();

    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      q.add(makeOpp(0.3, false));
    }

    // guardianTriggered=true, with priority assigned by scorer (e.g. 1.5)
    const guardian = makeOpp(1.5, true);
    const result = q.add(guardian);

    assert.equal(result, true, 'Guardian item should be accepted');
    assert.equal(q.size(), MAX_QUEUE_SIZE);

    const all = q.getAll();
    assert.ok(all.some((o) => o.id === guardian.id), 'Guardian item must be in queue');
  });

  it('guardianTriggered item with LOW priority (scorer did not boost it) is still rejected at cap', () => {
    const q = new OpportunityQueue();

    // Fill with medium-priority items
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      q.add(makeOpp(0.6, false));
    }

    // guardianTriggered=true but priority is low (shouldn't happen in practice,
    // but the queue should not grant special treatment beyond priority comparison)
    const guardian = makeOpp(0.1, true);
    const result = q.add(guardian);

    assert.equal(result, false, 'Low-priority guardian item should still be rejected at cap');
  });
});

describe('OpportunityQueue -- existing API unchanged', () => {
  it('getTop returns at most N items in priority order', () => {
    const q = new OpportunityQueue();
    q.add(makeOpp(0.9));
    q.add(makeOpp(0.3));
    q.add(makeOpp(0.6));

    const top2 = q.getTop(2);
    assert.equal(top2.length, 2);
    assert.ok(top2[0].priority >= top2[1].priority);
  });

  it('remove returns true and decrements size', () => {
    const q = new OpportunityQueue();
    const opp = makeOpp(0.5);
    q.add(opp);

    const removed = q.remove(opp.id);
    assert.equal(removed, true);
    assert.equal(q.size(), 0);
  });

  it('remove returns false for unknown id', () => {
    const q = new OpportunityQueue();
    const removed = q.remove('nonexistent-id');
    assert.equal(removed, false);
  });

  it('replaceAll resets queue to provided items in sorted order', () => {
    const q = new OpportunityQueue();
    q.add(makeOpp(0.9));

    const newItems = [makeOpp(0.2), makeOpp(0.8), makeOpp(0.5)];
    q.replaceAll(newItems);

    assert.equal(q.size(), 3);
    const top = q.getTop(1);
    assert.equal(top[0].priority, 0.8, 'replaceAll should sort; highest priority first');
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}

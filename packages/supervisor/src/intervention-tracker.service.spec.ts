/**
 * Unit tests for InterventionTrackerService — lifecycle tracking.
 *
 * Run via: npx tsx packages/supervisor/src/intervention-tracker.service.spec.ts
 *
 * Covers the ticket-5 lifecycle:
 *   1. proposed() opens a record at phase 'proposed' and persists a transition
 *   2. applied() / rejected() advance the phase and append transitions
 *   3. outcomeObserved() records the outcome and closes the loop
 *   4. transitions for an unknown id are ignored (no throw)
 *   5. no TimescaleService → tracking still works in-memory (no throw)
 */

import assert from 'node:assert/strict';
import { InterventionTrackerService } from './intervention-tracker.service.js';
import type { SupervisorIntervention } from './interfaces/supervisor.types.js';

class MockTimescale {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  async query(sql: string, params?: unknown[]): Promise<any> {
    this.calls.push({ sql, params: params ?? [] });
    return { rows: [] };
  }
}

function makeIntervention(
  over: Partial<SupervisorIntervention> = {},
): SupervisorIntervention {
  return {
    type: 'reinforce',
    source: 'supervisor',
    timestamp: new Date(),
    cycleId: 'cycle-9',
    ...over,
  };
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok ${name}`);
}

console.log('InterventionTrackerService');

// 1 + 2 + 3: full happy-path lifecycle.
check('tracks proposed → applied → outcome_observed', () => {
  const ts = new MockTimescale();
  const svc = new InterventionTrackerService(ts as any);

  const id = svc.proposed(makeIntervention());
  let rec = svc.get(id)!;
  assert.equal(rec.currentPhase, 'proposed');
  assert.equal(rec.transitions.length, 1);

  svc.applied(id, 'sidecar accepted');
  rec = svc.get(id)!;
  assert.equal(rec.currentPhase, 'applied');
  assert.equal(rec.transitions.length, 2);

  svc.outcomeObserved(id, 'positive', 'MAE improved');
  rec = svc.get(id)!;
  assert.equal(rec.currentPhase, 'outcome_observed');
  assert.equal(rec.outcome, 'positive');
  assert.equal(rec.transitions.length, 3);

  // Each transition forwarded to the audit trail as SUPERVISOR_INTERVENTION.
  assert.equal(ts.calls.length, 3);
  for (const c of ts.calls) {
    assert.match(c.sql, /INSERT INTO events/);
    const payload = JSON.parse(c.params[6] as string);
    assert.equal(c.params[3], 'SUPERVISOR'); // subsystem
    assert.equal(c.params[1], 'SUPERVISOR_INTERVENTION'); // type
    assert.equal(payload.interventionId, id);
  }
});

// rejected path.
check('rejected advances phase and records the error detail', () => {
  const svc = new InterventionTrackerService(null as any);
  const id = svc.proposed(makeIntervention());
  svc.rejected(id, 'sidecar 503');
  const rec = svc.get(id)!;
  assert.equal(rec.currentPhase, 'rejected');
  assert.equal(rec.transitions.at(-1)?.detail, 'sidecar 503');
});

// 4: unknown id is a no-op.
check('transition on unknown id is ignored (no throw)', () => {
  const svc = new InterventionTrackerService(null as any);
  svc.applied('does-not-exist');
  svc.outcomeObserved('nope', 'neutral');
  assert.ok(true);
});

// 5: no timescale → in-memory tracking still works.
check('no TimescaleService → in-memory lifecycle still tracked', () => {
  const svc = new InterventionTrackerService(null as any);
  const id = svc.proposed(makeIntervention());
  svc.applied(id);
  const recent = svc.getRecent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].currentPhase, 'applied');
});

console.log(`\nInterventionTrackerService: ${passed} checks passed\n`);

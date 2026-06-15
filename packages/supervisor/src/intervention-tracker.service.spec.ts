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

// 6: awaitingOutcome returns only applied-but-unobserved records, and an
// observed record leaves the set (backs the supervisor's auto-attribution).
check('awaitingOutcome tracks applied records until outcome is observed', () => {
  const svc = new InterventionTrackerService(null as any);

  const idProposed = svc.proposed(makeIntervention({ cycleId: 'c-proposed' }));
  const idApplied = svc.proposed(makeIntervention({ cycleId: 'c-applied' }));
  const idRejected = svc.proposed(makeIntervention({ cycleId: 'c-rejected' }));

  svc.applied(idApplied);
  svc.rejected(idRejected);

  // Only the applied-and-unobserved record is awaiting an outcome.
  let waiting = svc.awaitingOutcome();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].interventionId, idApplied);
  assert.equal(waiting[0].intervention.cycleId, 'c-applied');
  // The still-proposed record is not in the set.
  assert.ok(!waiting.some((r) => r.interventionId === idProposed));

  // Observing the outcome removes it from the awaiting set (attributed once).
  svc.outcomeObserved(idApplied, 'positive', 'next-eval c-later rating=good');
  waiting = svc.awaitingOutcome();
  assert.equal(waiting.length, 0);
  assert.equal(svc.get(idApplied)!.outcome, 'positive');
});

console.log(`\nInterventionTrackerService: ${passed} checks passed\n`);

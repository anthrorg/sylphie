/**
 * Unit tests for VerdictAuditService — auditable verdict persistence.
 *
 * Run via: npx tsx packages/supervisor/src/verdict-audit.service.spec.ts
 *
 * Covers the ticket-1 audit-trail leg:
 *   1. A recorded verdict is flushed to TimescaleDB as a SUPERVISOR_VERDICT
 *      event under subsystem 'SUPERVISOR' (the existing events backbone).
 *   2. The persisted payload carries truthful LLM_GENERATED provenance, the
 *      model id, the reasoning trace, and the evaluation reason (CANON Std-2).
 *   3. correlation_id == cycleId so the verdict joins back to its cycle.
 *   4. No TimescaleService → no throw (graceful degradation).
 */

import assert from 'node:assert/strict';
import { VerdictAuditService } from './verdict-audit.service.js';
import type {
  SupervisorVerdict,
  VerdictAuditRecord,
} from './interfaces/supervisor.types.js';

// ---------------------------------------------------------------------------
// Mock TimescaleService
// ---------------------------------------------------------------------------

class MockTimescale {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  async query(sql: string, params?: unknown[]): Promise<any> {
    this.calls.push({ sql, params: params ?? [] });
    return { rows: [] };
  }
}

function makeVerdict(over: Partial<SupervisorVerdict> = {}): SupervisorVerdict {
  return {
    cycleId: 'cycle-123',
    timestamp: new Date('2026-06-14T00:00:00Z'),
    rating: 'questionable',
    confidence: 0.7,
    reasoning: 'drive pressure ignored',
    reasoningTrace: 'step1 ... step2 ... conclusion',
    flagForGuardian: true,
    flagReason: 'possible non-sequitur',
    suggestedCorrection: null,
    inputTokens: 120,
    outputTokens: 80,
    costUsd: 0.0012,
    ...over,
  };
}

function makeRecord(v: SupervisorVerdict): VerdictAuditRecord {
  return {
    verdict: v,
    provenance: 'LLM_GENERATED',
    model: 'deepseek-reasoner',
    evaluationReason: 'attractor_alert',
  };
}

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed++;
    console.log(`  ok ${name}`);
  });
}

async function main(): Promise<void> {
  console.log('VerdictAuditService');

  // 1 + 2 + 3: persistence shape, provenance, correlation.
  await check('flushes a SUPERVISOR_VERDICT event with truthful provenance', async () => {
    const ts = new MockTimescale();
    const svc = new VerdictAuditService(ts as any);

    svc.record(makeRecord(makeVerdict()));
    await svc.flush();

    assert.equal(ts.calls.length, 1, 'exactly one INSERT');
    const { sql, params } = ts.calls[0];
    assert.match(sql, /INSERT INTO events/);

    // 9 columns per row.
    assert.equal(params.length, 9);
    const [, type, , subsystem, sessionId, driveSnapshot, payloadJson, correlationId] =
      params as [unknown, string, unknown, string, string, unknown, string, string];

    assert.equal(type, 'SUPERVISOR_VERDICT');
    assert.equal(subsystem, 'SUPERVISOR');
    assert.equal(sessionId, 'cycle-123');
    assert.equal(correlationId, 'cycle-123', 'correlation_id == cycleId');
    assert.equal(driveSnapshot, null);

    const payload = JSON.parse(payloadJson);
    assert.equal(payload.provenance, 'LLM_GENERATED', 'Std-2 truthful provenance');
    assert.equal(payload.model, 'deepseek-reasoner');
    assert.equal(payload.evaluationReason, 'attractor_alert');
    assert.equal(payload.verdict.rating, 'questionable');
    assert.equal(payload.verdict.reasoningTrace, 'step1 ... step2 ... conclusion');
    assert.equal(payload.verdict.flagForGuardian, true);
  });

  // 4: graceful degradation when Timescale is absent.
  await check('no TimescaleService → record + flush never throw', async () => {
    const svc = new VerdictAuditService(null as any);
    svc.record(makeRecord(makeVerdict()));
    await svc.flush(); // must not throw
    assert.ok(true);
  });

  // Batching: multiple records flush in a single multi-row INSERT.
  await check('multiple verdicts flush as one batched INSERT', async () => {
    const ts = new MockTimescale();
    const svc = new VerdictAuditService(ts as any);
    svc.record(makeRecord(makeVerdict({ cycleId: 'a' })));
    svc.record(makeRecord(makeVerdict({ cycleId: 'b' })));
    await svc.flush();
    assert.equal(ts.calls.length, 1);
    assert.equal(ts.calls[0].params.length, 18, 'two rows × 9 columns');
  });

  console.log(`\nVerdictAuditService: ${passed} checks passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

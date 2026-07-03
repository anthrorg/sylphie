/**
 * GuardianRulesService — unit tests for TK-155 (guardian pool routing).
 *
 * Verifies:
 *   - getProposedRules / getActiveRules (reads) query the RUNTIME pool only,
 *     never the guardian pool.
 *   - approveRule runs its entire BEGIN..COMMIT transaction (including the
 *     internal SELECT lookup) against a client checked out from the
 *     GUARDIAN pool, and never touches the runtime pool.
 *   - approveRule throws NotFoundException + rolls back when the proposed
 *     rule isn't pending, still entirely on the guardian pool.
 *   - rejectRule writes via the GUARDIAN pool only.
 *   - Fail-closed (AC2): when the guardian pool is unconfigured (its
 *     connect()/query() reject, as guardian-pool.provider.ts's unconfigured
 *     stand-in does), approveRule/rejectRule propagate that error and never
 *     fall back to the runtime pool.
 *
 * Pools are mocked directly (no live DB, no NestJS bootstrap) — constructor
 * injection makes this a plain `new GuardianRulesService(runtimePool, guardianPool)`.
 */

import { NotFoundException } from '@nestjs/common';
import { GuardianRulesService } from './guardian-rules.service';

// ---------------------------------------------------------------------------
// Minimal pg.Pool-shaped mocks
// ---------------------------------------------------------------------------

function makeRuntimePoolMock(rows: unknown[] = []) {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
    connect: jest.fn(),
  };
}

/**
 * Builds a guardian pool mock backing approveRule's connect()+client.query()
 * path. `proposedRow` null simulates "not found / not pending".
 */
function makeGuardianPoolMock(options?: {
  proposedRow?: Record<string, unknown> | null;
  connectRejects?: Error;
  queryRejects?: Error;
  rejectUpdateRows?: unknown[];
}) {
  const proposedRow =
    options?.proposedRow === undefined
      ? { id: 'proposed-1', trigger_pattern: 'trigger-x', effect: 'effect-y', confidence: 0.42 }
      : options.proposedRow;

  const clientQuery = jest.fn().mockImplementation(async (sql: string) => {
    const s = sql.trim().toUpperCase();
    if (s.startsWith('SELECT')) {
      return { rows: proposedRow === null ? [] : [proposedRow] };
    }
    // BEGIN / INSERT / UPDATE / COMMIT / ROLLBACK
    return { rows: [] };
  });
  const clientRelease = jest.fn();
  const client = { query: clientQuery, release: clientRelease };

  const connect = options?.connectRejects
    ? jest.fn().mockRejectedValue(options.connectRejects)
    : jest.fn().mockResolvedValue(client);

  const poolQuery = jest.fn().mockImplementation(async (sql: string) => {
    if (options?.queryRejects) {
      throw options.queryRejects;
    }
    const s = sql.trim().toUpperCase();
    if (s.startsWith('UPDATE')) {
      return { rows: options?.rejectUpdateRows ?? [{ id: 'proposed-1' }] };
    }
    return { rows: [] };
  });

  return { query: poolQuery, connect, _client: client, _clientQuery: clientQuery, _clientRelease: clientRelease };
}

function buildService(overrides?: {
  runtimePool?: ReturnType<typeof makeRuntimePoolMock>;
  guardianPool?: ReturnType<typeof makeGuardianPoolMock>;
}) {
  const runtimePool = overrides?.runtimePool ?? makeRuntimePoolMock();
  const guardianPool = overrides?.guardianPool ?? makeGuardianPoolMock();
  const service = new GuardianRulesService(runtimePool as any, guardianPool as any);
  return { service, runtimePool, guardianPool };
}

// ---------------------------------------------------------------------------
// Reads stay on the runtime pool
// ---------------------------------------------------------------------------

describe('GuardianRulesService — reads route to POSTGRES_RUNTIME_POOL', () => {
  it('getProposedRules queries the runtime pool and never touches the guardian pool', async () => {
    const runtimePool = makeRuntimePoolMock([
      {
        id: 'p1',
        triggerPattern: 't',
        effect: 'e',
        confidence: 0.5,
        proposedBy: 'sylphie',
        reasoning: null,
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    ]);
    const guardianPool = makeGuardianPoolMock();
    const { service } = buildService({ runtimePool, guardianPool });

    const result = await service.getProposedRules();

    expect(runtimePool.query).toHaveBeenCalledTimes(1);
    expect(guardianPool.query).not.toHaveBeenCalled();
    expect(guardianPool.connect).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it('getActiveRules queries the runtime pool and never touches the guardian pool', async () => {
    const runtimePool = makeRuntimePoolMock([]);
    const guardianPool = makeGuardianPoolMock();
    const { service } = buildService({ runtimePool, guardianPool });

    await service.getActiveRules();

    expect(runtimePool.query).toHaveBeenCalledTimes(1);
    expect(guardianPool.query).not.toHaveBeenCalled();
    expect(guardianPool.connect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// approveRule — entire transaction on the guardian pool
// ---------------------------------------------------------------------------

describe('GuardianRulesService.approveRule — writes route to POSTGRES_GUARDIAN_POOL', () => {
  it('runs BEGIN/SELECT/INSERT/UPDATE/COMMIT on a guardian-pool client and never touches the runtime pool', async () => {
    const runtimePool = makeRuntimePoolMock();
    const guardianPool = makeGuardianPoolMock();
    const { service } = buildService({ runtimePool, guardianPool });

    await service.approveRule('proposed-1');

    expect(guardianPool.connect).toHaveBeenCalledTimes(1);
    expect(runtimePool.query).not.toHaveBeenCalled();
    expect(runtimePool.connect).not.toHaveBeenCalled();

    const calledSql = guardianPool._clientQuery.mock.calls.map((c: unknown[]) =>
      (c[0] as string).trim().toUpperCase(),
    );
    expect(calledSql[0]).toBe('BEGIN');
    expect(calledSql.some((s: string) => s.startsWith('SELECT'))).toBe(true);
    expect(calledSql.some((s: string) => s.startsWith('INSERT INTO DRIVE_RULES'))).toBe(true);
    expect(calledSql.some((s: string) => s.startsWith('UPDATE PROPOSED_DRIVE_RULES'))).toBe(true);
    expect(calledSql[calledSql.length - 1]).toBe('COMMIT');
    expect(guardianPool._clientRelease).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundException and rolls back when the proposed rule is missing/not pending', async () => {
    const runtimePool = makeRuntimePoolMock();
    const guardianPool = makeGuardianPoolMock({ proposedRow: null });
    const { service } = buildService({ runtimePool, guardianPool });

    await expect(service.approveRule('missing-id')).rejects.toBeInstanceOf(NotFoundException);

    const calledSql = guardianPool._clientQuery.mock.calls.map((c: unknown[]) =>
      (c[0] as string).trim().toUpperCase(),
    );
    expect(calledSql).toContain('ROLLBACK');
    expect(calledSql.some((s: string) => s.startsWith('INSERT'))).toBe(false);
    expect(guardianPool._clientRelease).toHaveBeenCalledTimes(1);
    expect(runtimePool.query).not.toHaveBeenCalled();
  });

  it('fails CLOSED: propagates the guardian pool connect() rejection and never falls back to the runtime pool', async () => {
    const guardianCredsError = new Error(
      'Guardian credentials not configured: POSTGRES_GUARDIAN_USER/POSTGRES_GUARDIAN_PASSWORD are unset',
    );
    const runtimePool = makeRuntimePoolMock();
    const guardianPool = makeGuardianPoolMock({ connectRejects: guardianCredsError });
    const { service } = buildService({ runtimePool, guardianPool });

    await expect(service.approveRule('proposed-1')).rejects.toBe(guardianCredsError);

    expect(guardianPool.connect).toHaveBeenCalledTimes(1);
    expect(runtimePool.query).not.toHaveBeenCalled();
    expect(runtimePool.connect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// rejectRule — write on the guardian pool
// ---------------------------------------------------------------------------

describe('GuardianRulesService.rejectRule — writes route to POSTGRES_GUARDIAN_POOL', () => {
  it('updates status via the guardian pool and never touches the runtime pool', async () => {
    const runtimePool = makeRuntimePoolMock();
    const guardianPool = makeGuardianPoolMock();
    const { service } = buildService({ runtimePool, guardianPool });

    await service.rejectRule('proposed-1');

    expect(guardianPool.query).toHaveBeenCalledTimes(1);
    expect((guardianPool.query.mock.calls[0][0] as string).toUpperCase()).toContain('UPDATE');
    expect(runtimePool.query).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the proposed rule is missing/not pending', async () => {
    const runtimePool = makeRuntimePoolMock();
    const guardianPool = makeGuardianPoolMock({ rejectUpdateRows: [] });
    const { service } = buildService({ runtimePool, guardianPool });

    await expect(service.rejectRule('missing-id')).rejects.toBeInstanceOf(NotFoundException);
    expect(runtimePool.query).not.toHaveBeenCalled();
  });

  it('fails CLOSED: propagates the guardian pool query() rejection and never falls back to the runtime pool', async () => {
    const guardianCredsError = new Error(
      'Guardian credentials not configured: POSTGRES_GUARDIAN_USER/POSTGRES_GUARDIAN_PASSWORD are unset',
    );
    const runtimePool = makeRuntimePoolMock();
    const guardianPool = makeGuardianPoolMock({ queryRejects: guardianCredsError });
    const { service } = buildService({ runtimePool, guardianPool });

    await expect(service.rejectRule('proposed-1')).rejects.toBe(guardianCredsError);
    expect(runtimePool.query).not.toHaveBeenCalled();
  });
});

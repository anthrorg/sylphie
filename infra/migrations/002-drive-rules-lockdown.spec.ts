/**
 * Unit tests for infra/migrations/002-drive-rules-lockdown.ts — the pure,
 * DB-free logic (flag parsing, literal escaping, and the forward/reverse
 * statement-plan builders that encode the DEC-34 grant matrix).
 *
 * The live-DB behavior (REVOKE actually denies, RLS actually enforces,
 * REVERSE actually restores) is proven by the companion continuity/reverse
 * smoke (infra/migrations/002-drive-rules-lockdown.smoke.ts) against a
 * throwaway container — that is a live-DB proof, not a unit test, and is
 * intentionally not run here.
 *
 * Run via: npx tsx infra/migrations/002-drive-rules-lockdown.spec.ts
 * (standalone tsx / node:assert script — same pattern as
 * packages/drive-engine/src/drive-process/opportunity-queue.spec.ts.)
 */

import assert from 'node:assert/strict';
import {
  parseFlags,
  sqlLiteral,
  redactPassword,
  buildForwardPlan,
  buildReversePlan,
  tableExists,
  roleExists,
  getRowCount,
  isLocalPostgresHost,
  GUARDIAN_ADMIN_PASSWORD_ENV,
  DRIVE_ENGINE_PASSWORD_ENV,
  DRIVE_RULES_SELECT_POLICY,
  DRIVE_RULES_GUARDIAN_POLICY,
  PROPOSED_SELECT_POLICY,
  PROPOSED_GUARDIAN_POLICY,
  PROPOSED_PROPOSER_INSERT_POLICY,
  type Queryable,
} from './002-drive-rules-lockdown';

// ---------------------------------------------------------------------------
// Test runner (matches opportunity-queue.spec.ts's minimal harness, made
// async-aware since the DB-helper tests below are async).
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function describe(suiteName: string, fn: () => void | Promise<void>): Promise<void> {
  console.log(`\n  ${suiteName}`);
  await fn();
}

async function it(testName: string, fn: () => void | Promise<void>): Promise<void> {
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

// ---------------------------------------------------------------------------
// Fake Queryable — records issued SQL + params, returns canned rows.
// ---------------------------------------------------------------------------

function makeFakePool(responder: (sql: string, params?: unknown[]) => { rows: any[]; rowCount: number | null }): {
  db: Queryable;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db: Queryable = {
    query: (async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return responder(sql, params);
    }) as unknown as Queryable['query'],
  };
  return { db, calls };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  await describe('parseFlags', async () => {
    await it('defaults to dry-run forward with no flags/env', () => {
      const flags = parseFlags([], {});
      assert.equal(flags.confirmed, false);
      assert.equal(flags.reverse, false);
    });

    await it('--confirm sets confirmed=true', () => {
      const flags = parseFlags(['node', 'script.ts', '--confirm'], {});
      assert.equal(flags.confirmed, true);
      assert.equal(flags.reverse, false);
    });

    await it('SYLPHIE_MIGRATE_CONFIRM=1 sets confirmed=true', () => {
      const flags = parseFlags([], { SYLPHIE_MIGRATE_CONFIRM: '1' });
      assert.equal(flags.confirmed, true);
    });

    await it('--reverse sets reverse=true independent of confirm', () => {
      const flags = parseFlags(['--reverse'], {});
      assert.equal(flags.confirmed, false);
      assert.equal(flags.reverse, true);
    });

    await it('--reverse --confirm sets both', () => {
      const flags = parseFlags(['--reverse', '--confirm'], {});
      assert.equal(flags.confirmed, true);
      assert.equal(flags.reverse, true);
    });

    await it('SYLPHIE_MIGRATE_REVERSE=1 sets reverse=true', () => {
      const flags = parseFlags([], { SYLPHIE_MIGRATE_REVERSE: '1' });
      assert.equal(flags.reverse, true);
    });
  });

  await describe('sqlLiteral', async () => {
    await it('wraps a plain value in single quotes', () => {
      assert.equal(sqlLiteral('hunter2'), "'hunter2'");
    });

    await it('rejects a value containing a single quote', () => {
      assert.throws(() => sqlLiteral("bad'pw"), /single-quote/);
    });

    await it('rejects a value containing a backslash', () => {
      assert.throws(() => sqlLiteral('bad\\pw'), /backslash/);
    });
  });

  await describe('redactPassword', async () => {
    await it('redacts an embedded PASSWORD literal', () => {
      const stmt = "CREATE ROLE guardian_admin LOGIN PASSWORD 'supersecret'";
      const redacted = redactPassword(stmt);
      assert.ok(!redacted.includes('supersecret'), 'plaintext password must not survive redaction');
      assert.ok(redacted.includes('***REDACTED***'));
    });

    await it('leaves statements without PASSWORD untouched', () => {
      const stmt = 'GRANT SELECT ON drive_rules TO sylphie_app';
      assert.equal(redactPassword(stmt), stmt);
    });
  });

  await describe('buildForwardPlan — the DEC-34 grant matrix, encoded as an ordered statement list', async () => {
    await it('includes CREATE TABLE IF NOT EXISTS for both tables (never DROP)', () => {
      const plan = buildForwardPlan({ guardianAdminExists: true, driveEngineExists: true });
      assert.ok(plan.some((s) => s.includes('CREATE TABLE IF NOT EXISTS drive_rules')));
      assert.ok(plan.some((s) => s.includes('CREATE TABLE IF NOT EXISTS proposed_drive_rules')));
      assert.ok(!plan.some((s) => /DROP\s+TABLE/i.test(s)), 'must never drop a table');
    });

    await it('pins ownership to sylphie_admin for both tables', () => {
      const plan = buildForwardPlan({ guardianAdminExists: true, driveEngineExists: true });
      assert.ok(plan.includes('ALTER TABLE drive_rules OWNER TO sylphie_admin'));
      assert.ok(plan.includes('ALTER TABLE proposed_drive_rules OWNER TO sylphie_admin'));
    });

    await it('skips CREATE ROLE when both roles already exist', () => {
      const plan = buildForwardPlan({ guardianAdminExists: true, driveEngineExists: true });
      assert.ok(!plan.some((s) => s.includes('CREATE ROLE')));
    });

    await it('creates guardian_admin with the supplied password when it does not exist', () => {
      const plan = buildForwardPlan({
        guardianAdminExists: false,
        driveEngineExists: true,
        guardianAdminPassword: 'gpw123',
      });
      assert.ok(plan.some((s) => s === "CREATE ROLE guardian_admin LOGIN PASSWORD 'gpw123'"));
    });

    await it('creates drive_engine with the supplied password when it does not exist', () => {
      const plan = buildForwardPlan({
        guardianAdminExists: true,
        driveEngineExists: false,
        driveEnginePassword: 'depw123',
      });
      assert.ok(plan.some((s) => s === "CREATE ROLE drive_engine LOGIN PASSWORD 'depw123'"));
    });

    await it('throws (no hardcoded default) when guardian_admin must be created and the password env is unset', () => {
      assert.throws(
        () => buildForwardPlan({ guardianAdminExists: false, driveEngineExists: true }),
        new RegExp(GUARDIAN_ADMIN_PASSWORD_ENV),
      );
    });

    await it('throws (no hardcoded default) when drive_engine must be created and the password env is unset', () => {
      assert.throws(
        () => buildForwardPlan({ guardianAdminExists: true, driveEngineExists: false }),
        new RegExp(DRIVE_ENGINE_PASSWORD_ENV),
      );
    });

    await it('REVOKE ALL FROM PUBLIC for both tables, in addition to the three known roles', () => {
      const plan = buildForwardPlan({ guardianAdminExists: true, driveEngineExists: true });
      assert.ok(plan.includes('REVOKE ALL ON drive_rules FROM PUBLIC'));
      assert.ok(plan.includes('REVOKE ALL ON proposed_drive_rules FROM PUBLIC'));
    });

    await it('REVOKE ALL precedes any GRANT for both tables (REVOKE is the primary denial)', () => {
      const plan = buildForwardPlan({ guardianAdminExists: true, driveEngineExists: true });
      const revokeIdx = plan.findIndex((s) => s.startsWith('REVOKE ALL ON drive_rules'));
      const firstGrantIdx = plan.findIndex((s) => s.startsWith('GRANT'));
      assert.ok(revokeIdx >= 0 && firstGrantIdx >= 0);
      assert.ok(revokeIdx < firstGrantIdx, 'REVOKE ALL must run before any GRANT');
    });

    await it('encodes the exact DEC-34 grant matrix', () => {
      const plan = buildForwardPlan({ guardianAdminExists: true, driveEngineExists: true });
      // drive_rules
      assert.ok(plan.includes('GRANT SELECT ON drive_rules TO sylphie_app'));
      assert.ok(plan.includes('GRANT SELECT ON drive_rules TO drive_engine'));
      assert.ok(plan.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON drive_rules TO guardian_admin'));
      // proposed_drive_rules
      assert.ok(plan.includes('GRANT SELECT, INSERT ON proposed_drive_rules TO sylphie_app'));
      assert.ok(plan.includes('GRANT SELECT ON proposed_drive_rules TO drive_engine'));
      assert.ok(plan.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON proposed_drive_rules TO guardian_admin'));
      // sylphie_app must NEVER get a write grant on drive_rules
      assert.ok(
        !plan.some((s) => /GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON drive_rules TO[^;]*sylphie_app/i.test(s)),
        'sylphie_app must never be granted a write privilege on drive_rules',
      );
    });

    await it('enables and forces RLS on both tables', () => {
      const plan = buildForwardPlan({ guardianAdminExists: true, driveEngineExists: true });
      for (const table of ['drive_rules', 'proposed_drive_rules']) {
        assert.ok(plan.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
        assert.ok(plan.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
      }
    });

    await it('drops each policy before recreating it (idempotent re-apply)', () => {
      const plan = buildForwardPlan({ guardianAdminExists: true, driveEngineExists: true });
      for (const policy of [
        DRIVE_RULES_SELECT_POLICY,
        DRIVE_RULES_GUARDIAN_POLICY,
        PROPOSED_SELECT_POLICY,
        PROPOSED_GUARDIAN_POLICY,
        PROPOSED_PROPOSER_INSERT_POLICY,
      ]) {
        const dropIdx = plan.findIndex(
          (s) =>
            s === `DROP POLICY IF EXISTS ${policy} ON drive_rules` ||
            s === `DROP POLICY IF EXISTS ${policy} ON proposed_drive_rules`,
        );
        const createIdx = plan.findIndex((s) => s.startsWith(`CREATE POLICY ${policy} `));
        assert.ok(dropIdx >= 0, `expected a DROP POLICY IF EXISTS for ${policy}`);
        assert.ok(createIdx >= 0, `expected a CREATE POLICY for ${policy}`);
        assert.ok(dropIdx < createIdx, `DROP must precede CREATE for ${policy}`);
      }
    });

    await it('the proposer-insert policy WITH CHECKs status = pending', () => {
      const plan = buildForwardPlan({ guardianAdminExists: true, driveEngineExists: true });
      assert.ok(
        plan.some(
          (s) =>
            s.startsWith(`CREATE POLICY ${PROPOSED_PROPOSER_INSERT_POLICY}`) &&
            s.includes("WITH CHECK (status = 'pending')"),
        ),
      );
    });

    await it('is stable/idempotent — building the plan twice with the same inputs yields the same statements', () => {
      const needs = {
        guardianAdminExists: false,
        driveEngineExists: false,
        guardianAdminPassword: 'a',
        driveEnginePassword: 'b',
      };
      assert.deepEqual(buildForwardPlan(needs), buildForwardPlan(needs));
    });
  });

  await describe('buildReversePlan', async () => {
    await it('produces no statements when neither table exists', () => {
      assert.deepEqual(buildReversePlan({ driveRulesExists: false, proposedExists: false }), []);
    });

    await it('restores sylphie_app write grants and disables RLS on drive_rules only', () => {
      const plan = buildReversePlan({ driveRulesExists: true, proposedExists: false });
      assert.ok(plan.includes('GRANT INSERT, UPDATE, DELETE ON drive_rules TO sylphie_app'));
      assert.ok(plan.includes('ALTER TABLE drive_rules NO FORCE ROW LEVEL SECURITY'));
      assert.ok(plan.includes('ALTER TABLE drive_rules DISABLE ROW LEVEL SECURITY'));
      assert.ok(!plan.some((s) => s.includes('proposed_drive_rules')));
    });

    await it('restores sylphie_app UPDATE/DELETE (not a redundant INSERT) on proposed_drive_rules', () => {
      const plan = buildReversePlan({ driveRulesExists: false, proposedExists: true });
      assert.ok(plan.includes('GRANT UPDATE, DELETE ON proposed_drive_rules TO sylphie_app'));
      assert.ok(!plan.some((s) => s.startsWith('GRANT') && s.includes('INSERT') && s.includes('proposed_drive_rules')));
    });

    await it('drops every policy this migration created, for whichever tables exist', () => {
      const plan = buildReversePlan({ driveRulesExists: true, proposedExists: true });
      for (const policy of [
        DRIVE_RULES_SELECT_POLICY,
        DRIVE_RULES_GUARDIAN_POLICY,
        PROPOSED_SELECT_POLICY,
        PROPOSED_GUARDIAN_POLICY,
        PROPOSED_PROPOSER_INSERT_POLICY,
      ]) {
        assert.ok(plan.some((s) => s.includes(`DROP POLICY IF EXISTS ${policy}`)), `missing DROP POLICY for ${policy}`);
      }
    });

    await it('never drops a role or a table', () => {
      const plan = buildReversePlan({ driveRulesExists: true, proposedExists: true });
      assert.ok(!plan.some((s) => /DROP\s+(ROLE|TABLE)/i.test(s)));
    });
  });

  await describe('isLocalPostgresHost — gates docker-exec vs direct pg_dump in backupIfExists()', async () => {
    await it('treats localhost/127.0.0.1/::1 as local', () => {
      assert.equal(isLocalPostgresHost('localhost'), true);
      assert.equal(isLocalPostgresHost('127.0.0.1'), true);
      assert.equal(isLocalPostgresHost('::1'), true);
    });

    await it('treats a remote hostname (e.g. Railway) as NOT local', () => {
      assert.equal(isLocalPostgresHost('sylphie-postgres.railway.internal'), false);
      assert.equal(isLocalPostgresHost('some-remote-host.example.com'), false);
    });
  });

  await describe('tableExists / roleExists / getRowCount — thin DB helpers, fake Queryable', async () => {
    await it('tableExists returns true when the catalog query finds a row', async () => {
      const { db } = makeFakePool(() => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
      assert.equal(await tableExists(db, 'drive_rules'), true);
    });

    await it('tableExists returns false when the catalog query finds nothing', async () => {
      const { db } = makeFakePool(() => ({ rows: [], rowCount: 0 }));
      assert.equal(await tableExists(db, 'drive_rules'), false);
    });

    await it('roleExists queries pg_roles with the role name as a bound parameter', async () => {
      const { db, calls } = makeFakePool(() => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
      await roleExists(db, 'guardian_admin');
      assert.ok(calls[0]!.sql.includes('pg_roles'));
      assert.deepEqual(calls[0]!.params, ['guardian_admin']);
    });

    await it('getRowCount returns null when the table does not exist (no COUNT query issued)', async () => {
      const { db, calls } = makeFakePool(() => ({ rows: [], rowCount: 0 }));
      const count = await getRowCount(db, 'drive_rules');
      assert.equal(count, null);
      assert.equal(calls.length, 1, 'must not issue a COUNT(*) query against a table that does not exist');
    });

    await it('getRowCount returns the row count when the table exists', async () => {
      let call = 0;
      const { db } = makeFakePool(() => {
        call++;
        if (call === 1) return { rows: [{ '?column?': 1 }], rowCount: 1 }; // tableExists check
        return { rows: [{ n: 2 }], rowCount: 1 }; // COUNT(*) query
      });
      const count = await getRowCount(db, 'drive_rules');
      assert.equal(count, 2);
    });
  });

  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Unhandled spec error:', err);
  process.exit(1);
});

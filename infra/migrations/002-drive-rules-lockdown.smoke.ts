#!/usr/bin/env npx tsx
/**
 * infra/migrations/002-drive-rules-lockdown.smoke.ts
 *
 * Continuity/reverse proof for TK-154 (DEC-34 / AD-0051+AD-0052) — the
 * runnable check behind acceptance criteria AC1, AC3, and AC4:
 *
 *   AC1 — sylphie_app write on drive_rules is denied with "permission
 *         denied"; guardian_admin write succeeds.
 *   AC2 — sylphie_app SELECT on drive_rules and SELECT+INSERT(pending) on
 *         proposed_drive_rules succeed; INSERT with a non-pending status is
 *         denied by the proposer-insert RLS WITH CHECK policy (a distinct
 *         Postgres error — "row-level security policy", NOT "permission
 *         denied" — proven via expectRlsCheckDenied(), separate from
 *         expectDenied()'s REVOKE-level oracle); UPDATE/DELETE on
 *         proposed_drive_rules is denied at the grant level. (DB-level half
 *         only — the end-to-end guardian-approve-path half is TK-155.)
 *   AC3 — existing row count/contents unchanged across the forward
 *         migration; a fresh/empty DB converges to the same end-state.
 *   AC4 — REVERSE restores sylphie_app's write grants and disables RLS.
 *
 * SAFETY — Sentinel rule: "test migrations against a copy, not live data."
 * This script spins up a THROWAWAY, disposable Postgres container (name
 * prefixed `sentinel-tk154-smoketest-`, random high host port) and NEVER
 * touches the real `sylphie-postgres` container or its named volume. It
 * runs the actual infra/postgres/init/*.sql scripts on first boot, so
 * `sylphie_app` exists exactly as it does in the real dev stack. The
 * container is torn down in a `finally` block, even on failure.
 *
 * Flow:
 *   1. Boot the throwaway container; wait for Postgres to accept
 *      connections.
 *   2. Run 002-drive-rules-lockdown.ts --confirm against the TRULY EMPTY
 *      DB (drive_rules/proposed_drive_rules do not exist yet) — proves
 *      convergence from a fresh start (AC3, fresh-DB half).
 *   3. Seed representative rows into both tables.
 *   4. Re-run the SAME forward migration --confirm (tables now pre-exist,
 *      simulating the real hand-created live state) — proves idempotency
 *      and that existing row count/contents are UNCHANGED (AC3 existing
 *      half).
 *   5. Probe as sylphie_app and guardian_admin (AC1/AC2). Every probe runs
 *      inside BEGIN/ROLLBACK so the seeded rows are never actually
 *      mutated — same technique as
 *      packages/drive-engine/src/postgres-verification/verify-rls.ts.
 *   6. Assert seeded row count/contents are still exactly what was seeded
 *      (AC3/AC4 — no probe, allowed or denied, may leave a side effect).
 *   7. Run the migration --reverse --confirm, then re-probe as
 *      sylphie_app: UPDATE/INSERT/DELETE on drive_rules now succeed
 *      (inside a rolled-back transaction) and RLS is disabled on
 *      drive_rules — proves reversibility (AC4).
 *
 * Exits 0 (PASS) or 1 (FAIL) with a step-by-step report.
 *
 * Run: npx tsx infra/migrations/002-drive-rules-lockdown.smoke.ts
 *      (or: yarn migrate:drive-rules-lockdown:smoke)
 *
 * Requires Docker. Does not require --confirm — this script always applies
 * (forward, then reverse) against its own throwaway container; there is no
 * dry-run mode for the smoke itself (the migration script it drives still
 * has its own dry-run default).
 */

import { spawnSync, execSync } from 'child_process';
import { Pool } from 'pg';
import * as path from 'path';

const REPO_ROOT = process.cwd();
const CONTAINER_NAME = `sentinel-tk154-smoketest-${Date.now()}`;
// Random-ish high port derived from PID to reduce collisions across parallel runs.
const HOST_PORT = 55432 + (process.pid % 500);

const ADMIN_USER = 'sylphie_admin';
const ADMIN_PASSWORD = 'smoketest_admin_pw';
const DB_NAME = 'sylphie_system';
const GUARDIAN_PASSWORD = 'smoketest_guardian_pw';
const DRIVE_ENGINE_PASSWORD = 'smoketest_drive_engine_pw';
// Matches infra/postgres/init/001-runtime-user.sql's hardcoded dev password —
// the init script runs unmodified inside the throwaway container.
const SYLPHIE_APP_PASSWORD = 'sylphie_app_dev';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function step(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
    failed++;
    failures.push(name);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPostgres(pool: Pool, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Postgres did not become ready in time');
      }
      await sleep(500);
    }
  }
}

function runMigration(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('npx', ['tsx', 'infra/migrations/002-drive-rules-lockdown.ts', ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf-8',
    shell: true,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Runs `sql` inside BEGIN/ROLLBACK. Returns ok=true only if it failed with
 * a GRANT-level denial ("permission denied") — the PRIMARY write-denial
 * mechanism (the REVOKE ALL statements in buildForwardPlan()). Kept
 * distinct from expectRlsCheckDenied() below so the two denial mechanisms
 * (REVOKE vs RLS WITH CHECK) stay individually provable, matching the
 * migration header comment's own REVOKE-primary/RLS-defense-in-depth split.
 */
async function expectDenied(pool: Pool, sql: string): Promise<{ ok: boolean; detail?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('ROLLBACK');
    return { ok: false, detail: 'statement SUCCEEDED but was expected to be denied' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {/* connection may already be aborted */});
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: msg.toLowerCase().includes('permission denied'), detail: msg };
  } finally {
    client.release();
  }
}

/**
 * Runs `sql` inside BEGIN/ROLLBACK. Returns ok=true only if it failed with
 * an RLS WITH CHECK denial ("new row violates row-level security policy").
 * This is the defense-in-depth layer (`proposed_drive_rules_proposer_insert`'s
 * WITH CHECK (status = 'pending')) — Postgres reports this denial with a
 * different message than a REVOKE-level "permission denied", so it needs
 * its own oracle rather than reusing expectDenied()'s substring match.
 */
async function expectRlsCheckDenied(pool: Pool, sql: string): Promise<{ ok: boolean; detail?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('ROLLBACK');
    return { ok: false, detail: 'statement SUCCEEDED but was expected to be denied by an RLS policy' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {/* connection may already be aborted */});
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: /row-level security policy/i.test(msg), detail: msg };
  } finally {
    client.release();
  }
}

/** Runs `sql` inside BEGIN/ROLLBACK so a successful probe never mutates seeded data. */
async function expectAllowed(pool: Pool, sql: string): Promise<{ ok: boolean; detail?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('ROLLBACK');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {/* connection may already be aborted */});
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    client.release();
  }
}

async function countRows(pool: Pool, table: 'drive_rules' | 'proposed_drive_rules'): Promise<number> {
  const res = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
  return res.rows[0]!.n;
}

async function main(): Promise<void> {
  console.log('\n=== TK-154 continuity/reverse smoke — throwaway container ===\n');
  console.log(`Container: ${CONTAINER_NAME}  (host port ${HOST_PORT}; never touches sylphie-postgres)`);

  const initDir = path.join(REPO_ROOT, 'infra', 'postgres', 'init');

  let containerStarted = false;
  const adminPool = new Pool({
    host: 'localhost',
    port: HOST_PORT,
    database: DB_NAME,
    user: ADMIN_USER,
    password: ADMIN_PASSWORD,
    max: 3,
  });
  let sylphieAppPool: Pool | undefined;
  let guardianPool: Pool | undefined;

  try {
    execSync(
      `docker run -d --name ${CONTAINER_NAME}` +
        ` -e POSTGRES_USER=${ADMIN_USER} -e POSTGRES_PASSWORD=${ADMIN_PASSWORD} -e POSTGRES_DB=${DB_NAME}` +
        ` -p ${HOST_PORT}:5432` +
        ` -v "${initDir}:/docker-entrypoint-initdb.d"` +
        ' postgres:17',
      { stdio: 'inherit', shell: 'bash' },
    );
    containerStarted = true;

    const adminEnv: NodeJS.ProcessEnv = {
      ...process.env,
      POSTGRES_HOST: 'localhost',
      POSTGRES_PORT: String(HOST_PORT),
      POSTGRES_DB: DB_NAME,
      POSTGRES_ADMIN_USER: ADMIN_USER,
      POSTGRES_ADMIN_PASSWORD: ADMIN_PASSWORD,
      POSTGRES_CONTAINER: CONTAINER_NAME,
      POSTGRES_GUARDIAN_PASSWORD: GUARDIAN_PASSWORD,
      POSTGRES_DRIVE_ENGINE_PASSWORD: DRIVE_ENGINE_PASSWORD,
    };

    await waitForPostgres(adminPool);
    console.log('Postgres ready.\n');

    // -----------------------------------------------------------------
    // 1. Forward migration against a truly empty DB (fresh-DB convergence)
    // -----------------------------------------------------------------
    const preCheck = await adminPool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'drive_rules'`,
    );
    step('drive_rules does not exist before first apply', preCheck.rowCount === 0);

    const firstApply = runMigration(['--confirm'], adminEnv);
    step('forward migration (fresh DB) exits 0', firstApply.status === 0, firstApply.stderr || firstApply.stdout);

    const postCheck = await adminPool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'drive_rules'`,
    );
    step('drive_rules exists after first apply', (postCheck.rowCount ?? 0) > 0);

    // -----------------------------------------------------------------
    // 2. Seed representative rows
    // -----------------------------------------------------------------
    await adminPool.query(
      `INSERT INTO drive_rules (trigger_pattern, effect, confidence, enabled)
       VALUES ('PREDICTION_FAILED', 'anxiety += 0.10', 0.70, true),
              ('SOCIAL_COMMENT_ACK', 'social -= 0.15', 0.55, true)`,
    );
    await adminPool.query(
      `INSERT INTO proposed_drive_rules (trigger_pattern, effect, confidence, proposed_by, reasoning, status)
       VALUES ('CURIOSITY_SPIKE', 'curiosity -= 0.20', 0.40, 'SYSTEM', 'smoke seed', 'pending')`,
    );
    const seedCounts = {
      drive_rules: await countRows(adminPool, 'drive_rules'),
      proposed_drive_rules: await countRows(adminPool, 'proposed_drive_rules'),
    };
    step('seed rows inserted', seedCounts.drive_rules === 2 && seedCounts.proposed_drive_rules === 1);

    // -----------------------------------------------------------------
    // 3. Re-run forward migration — idempotent, tables now pre-exist
    //    (simulates the real live hand-created state) — AC3
    // -----------------------------------------------------------------
    const secondApply = runMigration(['--confirm'], adminEnv);
    step(
      'forward migration (pre-existing tables) exits 0 -- idempotent re-run',
      secondApply.status === 0,
      secondApply.stderr || secondApply.stdout,
    );

    const countsAfterReapply = {
      drive_rules: await countRows(adminPool, 'drive_rules'),
      proposed_drive_rules: await countRows(adminPool, 'proposed_drive_rules'),
    };
    step(
      'row counts unchanged across re-apply (AC3)',
      countsAfterReapply.drive_rules === seedCounts.drive_rules &&
        countsAfterReapply.proposed_drive_rules === seedCounts.proposed_drive_rules,
    );

    // -----------------------------------------------------------------
    // 4. Probe as sylphie_app -- AC1 / AC2
    // -----------------------------------------------------------------
    sylphieAppPool = new Pool({
      host: 'localhost',
      port: HOST_PORT,
      database: DB_NAME,
      user: 'sylphie_app',
      password: SYLPHIE_APP_PASSWORD,
      max: 3,
    });

    const appUpdateDenied = await expectDenied(sylphieAppPool, `UPDATE drive_rules SET enabled = false`);
    step('sylphie_app UPDATE drive_rules -> permission denied (AC1)', appUpdateDenied.ok, appUpdateDenied.detail);

    const appInsertDenied = await expectDenied(
      sylphieAppPool,
      `INSERT INTO drive_rules (trigger_pattern, effect) VALUES ('X', 'Y')`,
    );
    step('sylphie_app INSERT drive_rules -> permission denied (AC1)', appInsertDenied.ok, appInsertDenied.detail);

    const appDeleteDenied = await expectDenied(sylphieAppPool, `DELETE FROM drive_rules`);
    step('sylphie_app DELETE drive_rules -> permission denied (AC1)', appDeleteDenied.ok, appDeleteDenied.detail);

    const appSelectAllowed = await expectAllowed(sylphieAppPool, `SELECT COUNT(*) FROM drive_rules`);
    step('sylphie_app SELECT drive_rules -> succeeds (AC2)', appSelectAllowed.ok, appSelectAllowed.detail);

    const appProposeAllowed = await expectAllowed(
      sylphieAppPool,
      `INSERT INTO proposed_drive_rules (trigger_pattern, effect, confidence, proposed_by, status)
       VALUES ('SMOKE_PROBE', 'x += 0.0', 0.5, 'SMOKE', 'pending')`,
    );
    step(
      "sylphie_app INSERT proposed_drive_rules (status='pending') -> succeeds (AC2)",
      appProposeAllowed.ok,
      appProposeAllowed.detail,
    );

    const appProposedInsertApprovedDenied = await expectRlsCheckDenied(
      sylphieAppPool,
      `INSERT INTO proposed_drive_rules (trigger_pattern, effect, confidence, proposed_by, status)
       VALUES ('SMOKE_PROBE_BAD', 'x += 0.0', 0.5, 'SMOKE', 'approved')`,
    );
    step(
      "sylphie_app INSERT proposed_drive_rules (status='approved') -> denied by proposer-insert RLS policy (AC2)",
      appProposedInsertApprovedDenied.ok,
      appProposedInsertApprovedDenied.detail,
    );

    const appProposedUpdateDenied = await expectDenied(
      sylphieAppPool,
      `UPDATE proposed_drive_rules SET status = 'approved'`,
    );
    step(
      'sylphie_app UPDATE proposed_drive_rules -> permission denied (AC2)',
      appProposedUpdateDenied.ok,
      appProposedUpdateDenied.detail,
    );

    const appProposedDeleteDenied = await expectDenied(sylphieAppPool, `DELETE FROM proposed_drive_rules`);
    step(
      'sylphie_app DELETE proposed_drive_rules -> permission denied (AC2)',
      appProposedDeleteDenied.ok,
      appProposedDeleteDenied.detail,
    );

    // -----------------------------------------------------------------
    // 5. Probe as guardian_admin -- AC1
    // -----------------------------------------------------------------
    guardianPool = new Pool({
      host: 'localhost',
      port: HOST_PORT,
      database: DB_NAME,
      user: 'guardian_admin',
      password: GUARDIAN_PASSWORD,
      max: 3,
    });

    const guardianInsertAllowed = await expectAllowed(
      guardianPool,
      `INSERT INTO drive_rules (trigger_pattern, effect) VALUES ('SMOKE_GUARDIAN', 'x += 0.0')`,
    );
    step('guardian_admin INSERT drive_rules -> succeeds (AC1)', guardianInsertAllowed.ok, guardianInsertAllowed.detail);

    const guardianUpdateAllowed = await expectAllowed(guardianPool, `UPDATE drive_rules SET enabled = enabled`);
    step('guardian_admin UPDATE drive_rules -> succeeds (AC1)', guardianUpdateAllowed.ok, guardianUpdateAllowed.detail);

    const guardianDeleteAllowed = await expectAllowed(
      guardianPool,
      `DELETE FROM drive_rules WHERE trigger_pattern = 'nonexistent-smoke-probe'`,
    );
    step('guardian_admin DELETE drive_rules -> succeeds (AC1)', guardianDeleteAllowed.ok, guardianDeleteAllowed.detail);

    // -----------------------------------------------------------------
    // 6. Row count/content preservation (all probes above were rolled
    //    back, so the seeded rows must be untouched) — AC3/AC4
    // -----------------------------------------------------------------
    const countsAfterProbes = {
      drive_rules: await countRows(adminPool, 'drive_rules'),
      proposed_drive_rules: await countRows(adminPool, 'proposed_drive_rules'),
    };
    step(
      'seeded row count unchanged after all probes (AC3/AC4)',
      countsAfterProbes.drive_rules === seedCounts.drive_rules &&
        countsAfterProbes.proposed_drive_rules === seedCounts.proposed_drive_rules,
    );

    // -----------------------------------------------------------------
    // 7. REVERSE -- AC4
    // -----------------------------------------------------------------
    const reverseApply = runMigration(['--reverse', '--confirm'], adminEnv);
    step('reverse migration exits 0', reverseApply.status === 0, reverseApply.stderr || reverseApply.stdout);

    const appUpdateAllowedAfterReverse = await expectAllowed(sylphieAppPool, `UPDATE drive_rules SET enabled = enabled`);
    step(
      'sylphie_app UPDATE drive_rules succeeds after REVERSE (AC4)',
      appUpdateAllowedAfterReverse.ok,
      appUpdateAllowedAfterReverse.detail,
    );

    const appInsertAllowedAfterReverse = await expectAllowed(
      sylphieAppPool,
      `INSERT INTO drive_rules (trigger_pattern, effect) VALUES ('POST_REVERSE_PROBE', 'x += 0.0')`,
    );
    step(
      'sylphie_app INSERT drive_rules succeeds after REVERSE (AC4)',
      appInsertAllowedAfterReverse.ok,
      appInsertAllowedAfterReverse.detail,
    );

    const appDeleteAllowedAfterReverse = await expectAllowed(
      sylphieAppPool,
      `DELETE FROM drive_rules WHERE trigger_pattern = 'nonexistent-smoke-probe'`,
    );
    step(
      'sylphie_app DELETE drive_rules succeeds after REVERSE (AC4)',
      appDeleteAllowedAfterReverse.ok,
      appDeleteAllowedAfterReverse.detail,
    );

    const rlsStatus = await adminPool.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'drive_rules'`,
    );
    step('RLS disabled on drive_rules after REVERSE (AC4)', rlsStatus.rows[0]?.relrowsecurity === false);

    const countsAfterReverse = {
      drive_rules: await countRows(adminPool, 'drive_rules'),
      proposed_drive_rules: await countRows(adminPool, 'proposed_drive_rules'),
    };
    step(
      'seeded row count unchanged after REVERSE (AC4)',
      countsAfterReverse.drive_rules === seedCounts.drive_rules &&
        countsAfterReverse.proposed_drive_rules === seedCounts.proposed_drive_rules,
    );
  } catch (err) {
    step(
      'smoke run completed without an unhandled exception',
      false,
      err instanceof Error ? err.stack || err.message : String(err),
    );
  } finally {
    await adminPool.end().catch(() => {/* best effort */});
    if (sylphieAppPool) await sylphieAppPool.end().catch(() => {/* best effort */});
    if (guardianPool) await guardianPool.end().catch(() => {/* best effort */});
    if (containerStarted) {
      console.log(`\nTearing down throwaway container ${CONTAINER_NAME}...`);
      try {
        execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'inherit', shell: 'bash' });
      } catch {
        console.error(`WARNING: failed to remove throwaway container ${CONTAINER_NAME} -- remove it manually.`);
      }
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('\nFailed checks:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

// Only run when executed directly (npx tsx .../002-drive-rules-lockdown.smoke.ts),
// never when imported (e.g. for a load-only syntax/reference sanity check).
if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled smoke error:', err);
    process.exit(1);
  });
}

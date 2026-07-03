#!/usr/bin/env npx tsx
/**
 * infra/migrations/002-drive-rules-lockdown.ts  (TK-154 / DEC-34 / AD-0051+AD-0052)
 *
 * CONVERGENT drive_rules lockdown migration — CANON Immutable Standard 6
 * (No Self-Modification of Evaluation / Drive Isolation).
 *
 * BACKGROUND
 * ----------
 * `drive_rules` and `proposed_drive_rules` already exist on the live
 * sylphie-postgres database, but were hand-created out-of-repo — never
 * codified as DDL, never locked down with the DEC-34 grant matrix. The
 * live-DB probe behind AD-0052 found: both tables are owned by
 * `sylphie_admin`; `guardian_admin` already exists as a role. `sylphie_app`
 * (the runtime role) currently holds SELECT, INSERT on `drive_rules` and
 * full SELECT/INSERT/UPDATE/DELETE on `proposed_drive_rules` (confirmed by
 * a live read-only probe against sylphie-postgres — see migration.md §7),
 * via the standing `ALTER DEFAULT PRIVILEGES` grant set in
 * infra/postgres/init/001-runtime-user.sql — this is a live CANON Std-6
 * violation: the application process that reads drive rules for behavioral
 * evaluation can also write new ones directly into `drive_rules`, and can
 * self-approve a proposal by flipping `proposed_drive_rules.status` itself
 * (UPDATE is currently ungated).
 *
 * This migration is CONVERGENT: it reaches the same locked-down end-state
 * from ANY starting point —
 *   (a) a completely fresh/empty database (the tables do not exist yet), or
 *   (b) the live database (tables exist, hand-created, currently
 *       over-permissioned).
 * Re-running it against an already-locked-down database is a safe no-op.
 * It NEVER drops or recreates a table, and it never alters row data.
 *
 * Steps (idempotent; see buildForwardPlan() for the exact statement list;
 * all run inside a single transaction on --confirm):
 *   1. CREATE TABLE IF NOT EXISTS drive_rules, proposed_drive_rules — first
 *      in-repo codification of the live schema. Column shapes sourced from
 *      the two consumers:
 *        packages/drive-engine/src/rule-proposer/postgres-rules-client.ts
 *        apps/sylphie/src/services/guardian-rules.service.ts
 *      No-op where a table already exists.
 *   2. ALTER TABLE ... OWNER TO sylphie_admin (idempotent) — pins ownership
 *      away from the runtime role so REVOKE actually bites.
 *   3. Create role guardian_admin / drive_engine (LOGIN) if they do not
 *      already exist. Postgres has no native `CREATE ROLE IF NOT EXISTS`;
 *      this checks pg_roles first. Passwords come from
 *      POSTGRES_GUARDIAN_PASSWORD / POSTGRES_DRIVE_ENGINE_PASSWORD — there
 *      is NO hardcoded default. If a role does not exist and its password
 *      env var is unset, the migration HARD-STOPS rather than create a
 *      passwordless/trust-auth role. If the role already exists, its
 *      password is left untouched (never clobbers a live credential).
 *   4. Per-table REVOKE ALL (from the three known roles AND from PUBLIC)
 *      then GRANT the exact DEC-34 matrix (below). REVOKE is the PRIMARY
 *      write-denial (raises "permission denied"); this neutralizes the 001
 *      default-privilege grant for JUST these two tables WITHOUT touching
 *      the global `ALTER DEFAULT PRIVILEGES` statement (blast radius: every
 *      other sylphie_app-owned table depends on that staying intact).
 *   5. ENABLE + FORCE ROW LEVEL SECURITY, drop-and-recreate per-role
 *      policies. RLS here is defense-in-depth, NOT the primary denial
 *      layer — the REVOKE in step 4 is what actually blocks the write.
 *
 * Grant matrix (end-state):
 *
 *   |                      | sylphie_app    | drive_engine | guardian_admin              |
 *   |----------------------|----------------|--------------|-----------------------------|
 *   | drive_rules          | SELECT         | SELECT       | SELECT, INSERT, UPDATE, DELETE |
 *   | proposed_drive_rules | SELECT, INSERT | SELECT       | SELECT, INSERT, UPDATE, DELETE |
 *
 * Policies (TO role, drop-and-recreate on every apply):
 *   - `drive_rules_select_all_roles`             FOR SELECT TO sylphie_app, drive_engine, guardian_admin USING (true)
 *   - `drive_rules_guardian_all`                 FOR ALL    TO guardian_admin                            USING (true) WITH CHECK (true)
 *   - `proposed_drive_rules_select_all_roles`    FOR SELECT TO sylphie_app, drive_engine, guardian_admin USING (true)
 *   - `proposed_drive_rules_guardian_all`        FOR ALL    TO guardian_admin                            USING (true) WITH CHECK (true)
 *   - `proposed_drive_rules_proposer_insert`     FOR INSERT TO sylphie_app                                            WITH CHECK (status = 'pending')
 *   - No write policy for sylphie_app on drive_rules, ever.
 *
 * NON-GOALS (explicitly out of scope for this migration)
 * --------------------------------------------------------
 * - Does NOT edit infra/postgres/init/001-runtime-user.sql or change its
 *   global `ALTER DEFAULT PRIVILEGES` (blast radius: other tables).
 * - Does NOT wire the dormant RlsVerificationService (TK-129 / DEP-3).
 * - Does NOT touch application code or the guardian approve/reject path
 *   (TK-155, which depends_on this ticket, wires POSTGRES_GUARDIAN_POOL).
 *
 * SAFETY
 * ------
 * - Dry-run by default: prints current state (tables/roles/grants) plus the
 *   exact planned statement list, makes no writes, exits 0.
 * - Add --confirm (or SYLPHIE_MIGRATE_CONFIRM=1) to apply.
 * - Add --reverse (or SYLPHIE_MIGRATE_REVERSE=1) to select the REVERSE path
 *   instead of forward. Combine with --confirm to apply the reverse;
 *   without --confirm, reverse is also a dry-run preview.
 * - Before any --confirm write (forward OR reverse), takes a pg_dump
 *   data-only backup of every table that already exists, plus a best-effort
 *   grants/schema text snapshot. Host-aware: when POSTGRES_HOST is local
 *   (localhost/127.0.0.1/::1), backs up via `docker exec` into
 *   POSTGRES_CONTAINER; for any remote host (e.g. Railway prod), runs
 *   pg_dump directly against POSTGRES_HOST:POSTGRES_PORT instead — NEVER
 *   docker-exec, which would silently target an unrelated local container
 *   and produce a false-positive "verified backup" of the wrong database.
 *   A pg_dump failure for a table that DOES exist is a HARD-STOP — the
 *   migration proceeds without a backup only when there is nothing to back
 *   up yet (fresh DB / already-reversed).
 * - Runs as `sylphie_admin` (table owner) — NEVER the runtime pool.
 * - The full statement list (forward or reverse) runs inside a single
 *   transaction: any failure rolls back everything (Sentinel rule: wrap
 *   multi-step DB operations in a transaction).
 *
 * REVERSE
 * -------
 * Run with --reverse [--confirm]. This is a FUNCTIONAL rollback (restores
 * sylphie_app's ability to write both tables and disables RLS) — it is NOT
 * a byte-exact restore of whatever ad-hoc grants existed before this
 * migration first ran. In particular it grants MORE than the live-probe
 * pre-state actually held (the probe found sylphie_app had only SELECT,
 * INSERT on drive_rules — no UPDATE/DELETE — see migration.md §7); reverse
 * restores full INSERT/UPDATE/DELETE instead. This is intentional: the
 * point of reverse is "give sylphie_app write access back", not "reproduce
 * the exact accidental grant set a hand-created table happened to have". If
 * an exact restore is ever needed, use the pre-write `\dp` grants snapshot
 * captured by backupIfExists() as the reference, not this statement list.
 * Reverse does NOT drop the roles or the tables (creating them was
 * non-destructive, and dropping them is not required to restore write
 * access):
 *
 *   GRANT INSERT, UPDATE, DELETE ON drive_rules TO sylphie_app;
 *   GRANT UPDATE, DELETE ON proposed_drive_rules TO sylphie_app;
 *   ALTER TABLE drive_rules NO FORCE ROW LEVEL SECURITY;
 *   ALTER TABLE drive_rules DISABLE ROW LEVEL SECURITY;
 *   ALTER TABLE proposed_drive_rules NO FORCE ROW LEVEL SECURITY;
 *   ALTER TABLE proposed_drive_rules DISABLE ROW LEVEL SECURITY;
 *   DROP POLICY IF EXISTS <every policy this migration created>;
 *
 * See buildReversePlan() for the exact statement list.
 *
 * USAGE
 * -----
 *   # Forward, dry run (always safe — no DB changes):
 *   npx tsx infra/migrations/002-drive-rules-lockdown.ts
 *
 *   # Forward, live:
 *   npx tsx infra/migrations/002-drive-rules-lockdown.ts --confirm
 *
 *   # Reverse, dry run:
 *   npx tsx infra/migrations/002-drive-rules-lockdown.ts --reverse
 *
 *   # Reverse, live:
 *   npx tsx infra/migrations/002-drive-rules-lockdown.ts --reverse --confirm
 *
 * PRODUCTION DEPLOYMENT ORDERING (do not apply --confirm in isolation)
 * ----------------------------------------------------------------
 * apps/sylphie/src/services/guardian-rules.service.ts `approveRule()` /
 * `rejectRule()` currently write drive_rules / proposed_drive_rules over
 * POSTGRES_RUNTIME_POOL (the sylphie_app-credentialed pool). The instant
 * this migration's --confirm lands, those two methods start failing with
 * "permission denied" — the guardian dashboard's approve/reject path breaks
 * — until TK-155 (the dependent ticket) rewires them onto a
 * guardian-credentialed pool. This migration prints an explicit warning
 * about this before every apply (see runForward()); do not run --confirm
 * against a live environment ahead of TK-155 shipping.
 *
 * See also: pipeline/working/20260625-002-codebase-audit-findings-remediation-roadmap/migration.md
 * (the authoring migration plan) and
 * infra/migrations/002-drive-rules-lockdown.smoke.ts (the continuity/reverse
 * proof — AC1/AC3/AC4).
 */

import { Pool, type PoolClient } from 'pg';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Always use process.cwd() for the repo root — never __dirname.
const REPO_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export function parseFlags(
  argv: string[],
  env: NodeJS.ProcessEnv,
): { confirmed: boolean; reverse: boolean } {
  return {
    confirmed: argv.includes('--confirm') || env['SYLPHIE_MIGRATE_CONFIRM'] === '1',
    reverse: argv.includes('--reverse') || env['SYLPHIE_MIGRATE_REVERSE'] === '1',
  };
}

const { confirmed: CONFIRMED, reverse: REVERSE } = parseFlags(process.argv, process.env);

// ---------------------------------------------------------------------------
// Admin connection (sylphie_admin — table owner). Matches docker-compose.yml
// (sylphie-postgres, host port 5434) and the env var names used by
// packages/shared/src/config/database.config.ts.
// ---------------------------------------------------------------------------

const ADMIN_CONFIG = {
  host: process.env['POSTGRES_HOST'] || 'localhost',
  port: parseInt(process.env['POSTGRES_PORT'] || '5434', 10),
  database: process.env['POSTGRES_DB'] || 'sylphie_system',
  user: process.env['POSTGRES_ADMIN_USER'] || 'sylphie_admin',
  password: process.env['POSTGRES_ADMIN_PASSWORD'] || 'sylphie_admin_dev',
};

// Docker container name the pg_dump/psql backup commands exec into — ONLY
// used when ADMIN_CONFIG.host is a local address (see isLocalPostgresHost()
// below). For a remote target (e.g. Railway prod), `docker exec` would run
// pg_dump against whatever postgres happens to be running in a LOCAL
// container of this name, which has nothing to do with the remote database
// the migration pool is actually writing to — a false-positive "verified
// backup" that silently backs up the wrong database. See
// isLocalPostgresHost() / backupIfExists().
const POSTGRES_CONTAINER = process.env['POSTGRES_CONTAINER'] || 'sylphie-postgres';

/**
 * True when `host` refers to the machine this script itself is running on
 * (where `docker exec <container>` reaches the intended postgres). False for
 * any remote host (Railway, etc.), where docker-exec-into-a-local-container
 * would silently target the WRONG database.
 */
export function isLocalPostgresHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// New role passwords — NO hardcoded default. Only required when the role
// does not already exist (see buildForwardPlan()).
export const GUARDIAN_ADMIN_PASSWORD_ENV = 'POSTGRES_GUARDIAN_PASSWORD';
export const DRIVE_ENGINE_PASSWORD_ENV = 'POSTGRES_DRIVE_ENGINE_PASSWORD';

// ---------------------------------------------------------------------------
// Policy names (drop-and-recreate on every forward apply).
// ---------------------------------------------------------------------------

export const DRIVE_RULES_SELECT_POLICY = 'drive_rules_select_all_roles';
export const DRIVE_RULES_GUARDIAN_POLICY = 'drive_rules_guardian_all';
export const PROPOSED_SELECT_POLICY = 'proposed_drive_rules_select_all_roles';
export const PROPOSED_GUARDIAN_POLICY = 'proposed_drive_rules_guardian_all';
export const PROPOSED_PROPOSER_INSERT_POLICY = 'proposed_drive_rules_proposer_insert';

// ---------------------------------------------------------------------------
// Schema — first in-repo codification of the live drive_rules /
// proposed_drive_rules tables. Column shapes sourced from the two
// consumers (see header comment). NEVER drops or recreates an existing
// table — a no-op wherever the table already exists.
// ---------------------------------------------------------------------------

// Column shapes + nullability verified 2026-07-03 against the live
// sylphie-postgres (localhost:5434) via a READ-ONLY information_schema
// probe run as part of this migration's authoring review (no writes) —
// confidence is DOUBLE PRECISION (not NUMERIC — avoids the well-known
// node-pg "numeric returned as string" gotcha, and matches what the live
// column already is); enabled/created_at/updated_at/status are NOT
// constrained NOT NULL on the live table (only their DEFAULTs make them
// non-null in practice) — the DDL below matches that exactly rather than
// tightening it, since "matching the live schema" is the point of this
// first-in-repo codification, not improving on it.
export const CREATE_DRIVE_RULES_SQL = `
CREATE TABLE IF NOT EXISTS drive_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_pattern TEXT NOT NULL,
  effect          TEXT NOT NULL,
  confidence      DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  enabled         BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
)`.trim();

export const CREATE_PROPOSED_DRIVE_RULES_SQL = `
CREATE TABLE IF NOT EXISTS proposed_drive_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_pattern TEXT NOT NULL,
  effect          TEXT NOT NULL,
  confidence      DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  proposed_by     TEXT NOT NULL,
  reasoning       TEXT,
  status          TEXT DEFAULT 'pending'
                    CONSTRAINT proposed_drive_rules_status_check
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at      TIMESTAMPTZ DEFAULT now()
)`.trim();

// ---------------------------------------------------------------------------
// Pure helpers (no DB access) — exported for the unit spec.
// ---------------------------------------------------------------------------

/**
 * Minimal safe literal-quoting for DDL contexts where PostgreSQL does not
 * support bind parameters (e.g. `CREATE ROLE ... PASSWORD`). Passwords here
 * are operator-supplied via env vars, not attacker input, but embedded
 * quotes/backslashes are rejected defensively rather than escaped, so a
 * malformed password fails loudly instead of producing surprising SQL.
 */
export function sqlLiteral(value: string): string {
  if (value.includes("'") || value.includes('\\')) {
    throw new Error(
      'Value must not contain a single-quote or backslash character ' +
        '(unsafe for direct SQL literal embedding in a DDL statement).',
    );
  }
  return `'${value}'`;
}

/** Redacts an embedded `PASSWORD '...'` literal for safe console/log display. */
export function redactPassword(stmt: string): string {
  return stmt.replace(/PASSWORD\s+'[^']*'/i, "PASSWORD '***REDACTED***'");
}

export interface ForwardRoleNeeds {
  guardianAdminExists: boolean;
  driveEngineExists: boolean;
  /** Required only when guardianAdminExists is false. */
  guardianAdminPassword?: string | undefined;
  /** Required only when driveEngineExists is false. */
  driveEnginePassword?: string | undefined;
}

/**
 * Builds the ordered list of forward SQL statements. Pure function — no DB
 * access — so it is exhaustively unit-testable. Throws (rather than
 * emitting a passwordless CREATE ROLE) if a role must be created and its
 * password env var is unset.
 */
export function buildForwardPlan(needs: ForwardRoleNeeds): string[] {
  const stmts: string[] = [];

  stmts.push(CREATE_DRIVE_RULES_SQL);
  stmts.push(CREATE_PROPOSED_DRIVE_RULES_SQL);

  stmts.push('ALTER TABLE drive_rules OWNER TO sylphie_admin');
  stmts.push('ALTER TABLE proposed_drive_rules OWNER TO sylphie_admin');

  if (!needs.guardianAdminExists) {
    if (!needs.guardianAdminPassword) {
      throw new Error(
        `Cannot create role 'guardian_admin': ${GUARDIAN_ADMIN_PASSWORD_ENV} is not set ` +
          '(no hardcoded default — refusing to create a passwordless role).',
      );
    }
    stmts.push(`CREATE ROLE guardian_admin LOGIN PASSWORD ${sqlLiteral(needs.guardianAdminPassword)}`);
  }
  if (!needs.driveEngineExists) {
    if (!needs.driveEnginePassword) {
      throw new Error(
        `Cannot create role 'drive_engine': ${DRIVE_ENGINE_PASSWORD_ENV} is not set ` +
          '(no hardcoded default — refusing to create a passwordless role).',
      );
    }
    stmts.push(`CREATE ROLE drive_engine LOGIN PASSWORD ${sqlLiteral(needs.driveEnginePassword)}`);
  }

  // REVOKE ALL is the PRIMARY write-denial (migration.md §2 step 4). It runs
  // BEFORE the GRANTs below so the end-state is deterministic regardless of
  // whatever ad-hoc privileges the live/hand-created table carries today.
  stmts.push('REVOKE ALL ON drive_rules FROM sylphie_app, drive_engine, guardian_admin');
  stmts.push('REVOKE ALL ON proposed_drive_rules FROM sylphie_app, drive_engine, guardian_admin');
  // Also strip PUBLIC — a hand-created table may carry a stray grant to
  // PUBLIC (or the default PUBLIC CONNECT-adjacent privileges) that would
  // otherwise let ANY role read/write around the three known grantees above
  // and quietly break the "deterministic end-state regardless of starting
  // privileges" convergence claim.
  stmts.push('REVOKE ALL ON drive_rules FROM PUBLIC');
  stmts.push('REVOKE ALL ON proposed_drive_rules FROM PUBLIC');

  stmts.push('GRANT SELECT ON drive_rules TO sylphie_app');
  stmts.push('GRANT SELECT ON drive_rules TO drive_engine');
  stmts.push('GRANT SELECT, INSERT, UPDATE, DELETE ON drive_rules TO guardian_admin');
  stmts.push('GRANT SELECT, INSERT ON proposed_drive_rules TO sylphie_app');
  stmts.push('GRANT SELECT ON proposed_drive_rules TO drive_engine');
  stmts.push('GRANT SELECT, INSERT, UPDATE, DELETE ON proposed_drive_rules TO guardian_admin');

  stmts.push('ALTER TABLE drive_rules ENABLE ROW LEVEL SECURITY');
  stmts.push('ALTER TABLE drive_rules FORCE ROW LEVEL SECURITY');
  stmts.push('ALTER TABLE proposed_drive_rules ENABLE ROW LEVEL SECURITY');
  stmts.push('ALTER TABLE proposed_drive_rules FORCE ROW LEVEL SECURITY');

  stmts.push(`DROP POLICY IF EXISTS ${DRIVE_RULES_SELECT_POLICY} ON drive_rules`);
  stmts.push(
    `CREATE POLICY ${DRIVE_RULES_SELECT_POLICY} ON drive_rules ` +
      'FOR SELECT TO sylphie_app, drive_engine, guardian_admin USING (true)',
  );
  stmts.push(`DROP POLICY IF EXISTS ${DRIVE_RULES_GUARDIAN_POLICY} ON drive_rules`);
  stmts.push(
    `CREATE POLICY ${DRIVE_RULES_GUARDIAN_POLICY} ON drive_rules ` +
      'FOR ALL TO guardian_admin USING (true) WITH CHECK (true)',
  );

  stmts.push(`DROP POLICY IF EXISTS ${PROPOSED_SELECT_POLICY} ON proposed_drive_rules`);
  stmts.push(
    `CREATE POLICY ${PROPOSED_SELECT_POLICY} ON proposed_drive_rules ` +
      'FOR SELECT TO sylphie_app, drive_engine, guardian_admin USING (true)',
  );
  stmts.push(`DROP POLICY IF EXISTS ${PROPOSED_GUARDIAN_POLICY} ON proposed_drive_rules`);
  stmts.push(
    `CREATE POLICY ${PROPOSED_GUARDIAN_POLICY} ON proposed_drive_rules ` +
      'FOR ALL TO guardian_admin USING (true) WITH CHECK (true)',
  );
  stmts.push(`DROP POLICY IF EXISTS ${PROPOSED_PROPOSER_INSERT_POLICY} ON proposed_drive_rules`);
  stmts.push(
    `CREATE POLICY ${PROPOSED_PROPOSER_INSERT_POLICY} ON proposed_drive_rules ` +
      "FOR INSERT TO sylphie_app WITH CHECK (status = 'pending')",
  );

  return stmts;
}

export interface ReverseNeeds {
  driveRulesExists: boolean;
  proposedExists: boolean;
}

/**
 * Builds the ordered list of reverse SQL statements. Pure function — no DB
 * access. Only touches tables that exist (nothing to reverse on a table
 * that was never created). Never drops roles or tables.
 */
export function buildReversePlan(needs: ReverseNeeds): string[] {
  const stmts: string[] = [];

  if (needs.driveRulesExists) {
    stmts.push('GRANT INSERT, UPDATE, DELETE ON drive_rules TO sylphie_app');
    stmts.push('ALTER TABLE drive_rules NO FORCE ROW LEVEL SECURITY');
    stmts.push('ALTER TABLE drive_rules DISABLE ROW LEVEL SECURITY');
    stmts.push(`DROP POLICY IF EXISTS ${DRIVE_RULES_SELECT_POLICY} ON drive_rules`);
    stmts.push(`DROP POLICY IF EXISTS ${DRIVE_RULES_GUARDIAN_POLICY} ON drive_rules`);
  }
  if (needs.proposedExists) {
    stmts.push('GRANT UPDATE, DELETE ON proposed_drive_rules TO sylphie_app');
    stmts.push('ALTER TABLE proposed_drive_rules NO FORCE ROW LEVEL SECURITY');
    stmts.push('ALTER TABLE proposed_drive_rules DISABLE ROW LEVEL SECURITY');
    stmts.push(`DROP POLICY IF EXISTS ${PROPOSED_SELECT_POLICY} ON proposed_drive_rules`);
    stmts.push(`DROP POLICY IF EXISTS ${PROPOSED_GUARDIAN_POLICY} ON proposed_drive_rules`);
    stmts.push(`DROP POLICY IF EXISTS ${PROPOSED_PROPOSER_INSERT_POLICY} ON proposed_drive_rules`);
  }

  return stmts;
}

// ---------------------------------------------------------------------------
// DB-touching helpers
// ---------------------------------------------------------------------------

/** Structural subset of `Pool`/`PoolClient` — lets the pure-logic tests below stay DB-free. */
export interface Queryable {
  query: Pool['query'];
}

export async function tableExists(db: Queryable, tableName: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function roleExists(db: Queryable, roleName: string): Promise<boolean> {
  const res = await db.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [roleName]);
  return (res.rowCount ?? 0) > 0;
}

/** Returns null if the table does not exist (rather than throwing). */
export async function getRowCount(db: Queryable, tableName: 'drive_rules' | 'proposed_drive_rules'): Promise<number | null> {
  if (!(await tableExists(db, tableName))) return null;
  // tableName is always one of the two fixed literals above — never externally supplied.
  const res = await db.query(`SELECT COUNT(*)::int AS n FROM ${tableName}`);
  return res.rows[0].n;
}

interface GrantRow {
  grantee: string;
  table_name: string;
  privilege_type: string;
}

// Grantees this migration knows about and manages deliberately. Anything
// else showing up in the live grants snapshot (a stray grant to PUBLIC that
// survived, a fourth role, etc.) is surfaced as [UNEXPECTED] by printGrants()
// rather than silently filtered out — a filtered snapshot would make the
// "deterministic end-state regardless of starting privileges" convergence
// claim look true even when an unmanaged grantee was quietly left in place.
const KNOWN_GRANTEES = new Set(['sylphie_app', 'drive_engine', 'guardian_admin', 'sylphie_admin']);

async function getGrantsSnapshot(db: Queryable): Promise<GrantRow[]> {
  // Intentionally NOT filtered to the three known grantees — see
  // KNOWN_GRANTEES comment above.
  const res = await db.query(
    `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE table_name IN ('drive_rules', 'proposed_drive_rules')
      ORDER BY table_name, grantee, privilege_type`,
  );
  return res.rows as GrantRow[];
}

// ---------------------------------------------------------------------------
// Console helpers (matches infra/migrations/001-legacy-pattern-rescope.ts)
// ---------------------------------------------------------------------------

function header(text: string): void {
  const line = '─'.repeat(60);
  console.log(`\n${line}\n  ${text}\n${line}`);
}

function info(t: string): void { console.log(`  [INFO]  ${t}`); }
function ok(t: string): void { console.log(`  [OK]    ${t}`); }
function warn(t: string): void { console.log(`  [WARN]  ${t}`); }
function fail(t: string): void { console.error(`  [FAIL]  ${t}`); }

function printGrants(label: string, rows: GrantRow[]): void {
  info(`${label}:`);
  if (rows.length === 0) {
    console.log('      (none found)');
    return;
  }
  for (const r of rows) {
    const flag = KNOWN_GRANTEES.has(r.grantee) ? '' : '  [UNEXPECTED GRANTEE]';
    console.log(`      ${r.table_name}  ${r.grantee}  ${r.privilege_type}${flag}`);
  }
  const unexpected = rows.filter((r) => !KNOWN_GRANTEES.has(r.grantee));
  if (unexpected.length > 0) {
    warn(
      `Found grant(s) to grantee(s) outside the DEC-34 matrix: ${[...new Set(unexpected.map((r) => r.grantee))].join(', ')}. ` +
        'REVOKE ALL ... FROM PUBLIC is included in the forward plan, but a named fourth role is not automatically revoked — investigate.',
    );
  }
}

// ---------------------------------------------------------------------------
// Backup — pg_dump every table that already exists (data-only) plus a
// best-effort grants/schema text snapshot. HARD-STOPS if a table that
// exists fails to back up; a fresh/already-reversed DB with nothing to back
// up is not an error (Sentinel: never block fresh-DB convergence on a
// backup for data that does not exist).
// ---------------------------------------------------------------------------

async function backupIfExists(
  tables: Array<{ table: string; exists: boolean }>,
): Promise<void> {
  const existing = tables.filter((t) => t.exists);
  if (existing.length === 0) {
    info('Neither table exists yet — nothing to back up (fresh-DB / already-reversed run).');
    return;
  }

  const backupDir = path.join(REPO_ROOT, 'backups');
  try {
    fs.mkdirSync(backupDir, { recursive: true });
  } catch (err) {
    fail(`Cannot create backup directory ${backupDir}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const isLocal = isLocalPostgresHost(ADMIN_CONFIG.host);

  if (isLocal) {
    info(`Backup target: LOCAL docker container "${POSTGRES_CONTAINER}" (POSTGRES_HOST=${ADMIN_CONFIG.host}).`);
  } else {
    warn(
      `POSTGRES_HOST (${ADMIN_CONFIG.host}) is NOT local — a "docker exec ${POSTGRES_CONTAINER} pg_dump" would ` +
        'silently back up whatever postgres is in a LOCAL container of that name, NOT the remote database this ' +
        'migration is about to write to. Running pg_dump directly against the remote host/port instead.',
    );
  }

  for (const { table } of existing) {
    const backupFile = path.join(backupDir, `${table}-pre-tk154-lockdown-${timestamp}.sql`);
    try {
      if (isLocal) {
        execSync(
          `docker exec ${POSTGRES_CONTAINER} pg_dump` +
            ` -U ${ADMIN_CONFIG.user}` +
            ` -d ${ADMIN_CONFIG.database}` +
            ` -t ${table} --data-only` +
            ` > "${backupFile}"`,
          { shell: 'bash', stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } else {
        // Remote target: run pg_dump directly against ADMIN_CONFIG's own
        // host/port so the backup actually observes the system being
        // written to — never docker-exec into an unrelated local container.
        execSync(
          `pg_dump` +
            ` -h ${ADMIN_CONFIG.host}` +
            ` -p ${ADMIN_CONFIG.port}` +
            ` -U ${ADMIN_CONFIG.user}` +
            ` -d ${ADMIN_CONFIG.database}` +
            ` -t ${table} --data-only` +
            ` > "${backupFile}"`,
          {
            shell: 'bash',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PGPASSWORD: ADMIN_CONFIG.password },
          },
        );
      }
      ok(`Backup written: ${backupFile}`);
    } catch (backupErr) {
      // HARD-STOP: never proceed to write against an existing table without
      // a verified backup of it that actually observes the target system.
      fail(`pg_dump FAILED for ${table}: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`);
      fail('Migration ABORTED — no data was modified.');
      if (isLocal) {
        fail(
          `Ensure Docker is running (docker ps | grep ${POSTGRES_CONTAINER}) and retry, ` +
            'or take a manual backup before proceeding.',
        );
      } else {
        fail(
          'Ensure a `pg_dump` client (matching the target Postgres major version) is installed and on PATH ' +
            `on this machine, and that ${ADMIN_CONFIG.host}:${ADMIN_CONFIG.port} is reachable, then retry. ` +
            'Do NOT proceed without a verified backup of the remote database — take one manually ' +
            '(e.g. via the Railway CLI / dashboard backup feature) before re-running with --confirm.',
        );
      }
      process.exit(1);
    }
  }

  // Grants + schema text snapshot — best-effort. Not a hard-stop on failure:
  // the data backup above is the load-bearing safety net for AC "row count
  // + contents unchanged"; this snapshot is supplementary operator context.
  const snapshotFile = path.join(backupDir, `drive_rules-grants-schema-pre-tk154-lockdown-${timestamp}.txt`);
  try {
    const snapshotCmd = isLocal
      ? `docker exec ${POSTGRES_CONTAINER} psql -U ${ADMIN_CONFIG.user} -d ${ADMIN_CONFIG.database}` +
        ' -c "\\dp drive_rules proposed_drive_rules" -c "\\d drive_rules" -c "\\d proposed_drive_rules"' +
        ` > "${snapshotFile}"`
      : `psql -h ${ADMIN_CONFIG.host} -p ${ADMIN_CONFIG.port} -U ${ADMIN_CONFIG.user} -d ${ADMIN_CONFIG.database}` +
        ' -c "\\dp drive_rules proposed_drive_rules" -c "\\d drive_rules" -c "\\d proposed_drive_rules"' +
        ` > "${snapshotFile}"`;
    execSync(snapshotCmd, {
      shell: 'bash',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: isLocal ? process.env : { ...process.env, PGPASSWORD: ADMIN_CONFIG.password },
    });
    ok(`Grants/schema snapshot written: ${snapshotFile}`);
  } catch (snapErr) {
    warn(`Could not capture grants/schema snapshot (non-fatal): ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`);
  }
}

// ---------------------------------------------------------------------------
// Forward
// ---------------------------------------------------------------------------

async function runForward(pool: Pool): Promise<void> {
  header('Step 0: current state');

  const drRulesExists = await tableExists(pool, 'drive_rules');
  const drProposedExists = await tableExists(pool, 'proposed_drive_rules');
  info(`drive_rules exists: ${drRulesExists}`);
  info(`proposed_drive_rules exists: ${drProposedExists}`);

  printGrants('Current grants (before)', await getGrantsSnapshot(pool));

  const rowCountBefore = {
    drive_rules: await getRowCount(pool, 'drive_rules'),
    proposed_drive_rules: await getRowCount(pool, 'proposed_drive_rules'),
  };
  info(`drive_rules row count: ${rowCountBefore.drive_rules ?? '(table does not exist yet)'}`);
  info(`proposed_drive_rules row count: ${rowCountBefore.proposed_drive_rules ?? '(table does not exist yet)'}`);

  const guardianAdminExists = await roleExists(pool, 'guardian_admin');
  const driveEngineExists = await roleExists(pool, 'drive_engine');
  info(`role guardian_admin exists: ${guardianAdminExists}`);
  info(`role drive_engine exists: ${driveEngineExists}`);

  let plan: string[];
  try {
    plan = buildForwardPlan({
      guardianAdminExists,
      driveEngineExists,
      guardianAdminPassword: process.env[GUARDIAN_ADMIN_PASSWORD_ENV],
      driveEnginePassword: process.env[DRIVE_ENGINE_PASSWORD_ENV],
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  header('Planned forward statements (in order)');
  for (const stmt of plan) {
    console.log(`    ${redactPassword(stmt)}`);
  }

  header('PRODUCTION DEPLOYMENT ORDERING WARNING');
  warn(
    'Once this migration is --confirm-ed, sylphie_app loses INSERT/UPDATE/DELETE on drive_rules ' +
      'and UPDATE/DELETE on proposed_drive_rules.',
  );
  warn(
    'apps/sylphie/src/services/guardian-rules.service.ts approveRule()/rejectRule() currently run ' +
      'over the sylphie_app-credentialed pool (POSTGRES_RUNTIME_POOL) and WILL START FAILING with ' +
      '"permission denied" the moment this lands — until TK-155 rewires them onto a guardian-credentialed pool.',
  );
  warn('Do NOT apply --confirm to a live environment ahead of TK-155 shipping.');

  if (!CONFIRMED) {
    header('DRY RUN — no changes made');
    console.log(`
  To apply:
    npx tsx infra/migrations/002-drive-rules-lockdown.ts --confirm
  Or:
    SYLPHIE_MIGRATE_CONFIRM=1 npx tsx infra/migrations/002-drive-rules-lockdown.ts
`);
    return;
  }

  header('Step 1: pre-write backup');
  await backupIfExists([
    { table: 'drive_rules', exists: drRulesExists },
    { table: 'proposed_drive_rules', exists: drProposedExists },
  ]);

  header('Step 2: applying forward migration (single transaction)');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const stmt of plan) {
      await client.query(stmt);
    }
    await client.query('COMMIT');
    ok(`Forward migration committed (${plan.length} statements).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {/* ignore rollback error */});
    fail(`Forward migration failed — rolled back: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    client.release();
  }

  header('Step 3: post-migration verification');
  const rowCountAfter = {
    drive_rules: await getRowCount(pool, 'drive_rules'),
    proposed_drive_rules: await getRowCount(pool, 'proposed_drive_rules'),
  };
  info(`drive_rules row count: before=${rowCountBefore.drive_rules ?? 0} after=${rowCountAfter.drive_rules}`);
  info(
    `proposed_drive_rules row count: before=${rowCountBefore.proposed_drive_rules ?? 0} ` +
      `after=${rowCountAfter.proposed_drive_rules}`,
  );
  if (
    (rowCountBefore.drive_rules ?? 0) !== rowCountAfter.drive_rules ||
    (rowCountBefore.proposed_drive_rules ?? 0) !== rowCountAfter.proposed_drive_rules
  ) {
    warn('Row counts changed across the migration — this migration must NEVER alter row data. Investigate immediately.');
  } else {
    ok('Row counts unchanged — convergent migration touched grants/ownership/RLS only, no row data.');
  }

  printGrants('Grants after migration', await getGrantsSnapshot(pool));
  header('Forward migration complete');
}

// ---------------------------------------------------------------------------
// Reverse
// ---------------------------------------------------------------------------

async function runReverse(pool: Pool): Promise<void> {
  header('Step 0: current state (reverse)');

  const drRulesExists = await tableExists(pool, 'drive_rules');
  const drProposedExists = await tableExists(pool, 'proposed_drive_rules');
  info(`drive_rules exists: ${drRulesExists}`);
  info(`proposed_drive_rules exists: ${drProposedExists}`);

  if (!drRulesExists && !drProposedExists) {
    ok('Neither table exists — nothing to reverse.');
    return;
  }

  const plan = buildReversePlan({ driveRulesExists: drRulesExists, proposedExists: drProposedExists });

  header('Planned reverse statements (in order)');
  for (const stmt of plan) {
    console.log(`    ${stmt}`);
  }

  if (!CONFIRMED) {
    header('DRY RUN (reverse) — no changes made');
    console.log(`
  To apply:
    npx tsx infra/migrations/002-drive-rules-lockdown.ts --reverse --confirm
`);
    return;
  }

  header('Step 1: pre-write backup (reverse)');
  await backupIfExists([
    { table: 'drive_rules', exists: drRulesExists },
    { table: 'proposed_drive_rules', exists: drProposedExists },
  ]);

  header('Step 2: applying reverse (single transaction)');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const stmt of plan) {
      await client.query(stmt);
    }
    await client.query('COMMIT');
    ok(`Reverse migration committed (${plan.length} statements). sylphie_app write grants restored, RLS disabled.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {/* ignore rollback error */});
    fail(`Reverse migration failed — rolled back: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    client.release();
  }

  header('Reverse migration complete');
  console.log(`
  Roles (guardian_admin, drive_engine) and the tables themselves are left in
  place intentionally — see the REVERSE section of the header comment.
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  header('TK-154 — drive_rules lockdown migration (DEC-34 / AD-0051+AD-0052, CANON Std-6)');
  info(`Repo root: ${REPO_ROOT}`);
  info(`Direction: ${REVERSE ? 'REVERSE' : 'FORWARD'}`);
  info(`Mode: ${CONFIRMED ? 'LIVE (--confirm)' : 'DRY RUN (no writes)'}`);
  info(`Admin connection: ${ADMIN_CONFIG.user}@${ADMIN_CONFIG.host}:${ADMIN_CONFIG.port}/${ADMIN_CONFIG.database}`);

  const pool = new Pool({
    ...ADMIN_CONFIG,
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  });

  try {
    if (REVERSE) {
      await runReverse(pool);
    } else {
      await runForward(pool);
    }
  } finally {
    await pool.end();
  }
}

// Only run when executed directly (npx tsx .../002-drive-rules-lockdown.ts),
// never when imported by the unit spec.
if (require.main === module) {
  main().catch((err) => {
    fail(`Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

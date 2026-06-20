#!/usr/bin/env npx tsx
/**
 * infra/migrations/001-legacy-pattern-rescope.ts  (TK-78 / DEC-7 / AD-0011)
 *
 * One-shot idempotent migration: re-attribute legacy world-scoped GROUNDED
 * patterns in `learned_patterns` to `grounding_person_id = 'guardian'`.
 *
 * Background
 * ----------
 * Before Wave-3 three-graph isolation (commit 1f53de2, merged 2026-06-13),
 * every learned pattern was written with `grounding_person_id IS NULL`
 * (world-scoped). That includes ~293 rows that carry GROUNDED claims derived
 * from guardian-private WKG facts (name, city, dog). After Wave-3, a future
 * second person would receive GROUNDED replies citing Jim's personal facts,
 * because `applyPersonScopeDemotion()` only demotes OKG-scoped patterns
 * (non-null `grounding_person_id`) for non-matching speakers.
 *
 * This migration closes the gap by re-scoping those pre-Wave-3 GROUNDED rows
 * to `grounding_person_id = 'guardian'` so `applyPersonScopeDemotion()` demotes
 * them to UNKNOWN for any non-guardian speaker.
 *
 * The `created_at < '2026-06-13'` clause is load-bearing: it scopes only the
 * pre-Wave-3 legacy corpus and prevents over-matching new world-scoped rows that
 * were intentionally written as world-scoped after Wave-3 (DEC-17).
 *
 * SAFETY
 * ------
 * - Dry-run by default: prints count + 5-row sample, no writes, exits 0.
 * - Add --confirm (or SYLPHIE_MIGRATE_CONFIRM=1) to apply live.
 * - Takes a pg_dump table backup BEFORE any UPDATE when --confirm is given.
 * - Backup failure → HARD-STOP (process.exit(1)). This migration is destructive;
 *   proceeding without a backup is prohibited. (DEC-17 / TK-78 AC2)
 * - Idempotent: the WHERE clause scopes only NULL rows, so a re-run is a no-op.
 *
 * REVERSE
 * -------
 * To undo, connect to TimescaleDB and run:
 *
 *   UPDATE learned_patterns
 *     SET grounding_person_id = NULL
 *   WHERE grounding_person_id = 'guardian'
 *     AND knowledge_grounding = 'GROUNDED'
 *     AND created_at < '2026-06-13';
 *
 * Or restore from the backup produced at migration time:
 *
 *   cat backups/learned_patterns-pre-tk78-<timestamp>.sql | \
 *     docker exec -i sylphie-timescaledb psql -U sylphie sylphie_events
 *
 * USAGE
 * -----
 *   # Dry run (always safe — no DB changes):
 *   npx tsx infra/migrations/001-legacy-pattern-rescope.ts
 *
 *   # Live run (applies migration):
 *   npx tsx infra/migrations/001-legacy-pattern-rescope.ts --confirm
 *
 *   # Via environment variable:
 *   SYLPHIE_MIGRATE_CONFIRM=1 npx tsx infra/migrations/001-legacy-pattern-rescope.ts
 */

import { Pool } from 'pg';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Always use process.cwd() for the repo root — never __dirname.
const REPO_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Confirmation gate
// ---------------------------------------------------------------------------

const CONFIRMED =
  process.argv.includes('--confirm') ||
  process.env['SYLPHIE_MIGRATE_CONFIRM'] === '1';

// ---------------------------------------------------------------------------
// TimescaleDB connection (same defaults as scripts/reset-data.ts)
// ---------------------------------------------------------------------------

const TIMESCALE_CONFIG = {
  host:     process.env['TIMESCALE_HOST']     || 'localhost',
  port:     parseInt(process.env['TIMESCALE_PORT'] || '5433', 10),
  database: process.env['TIMESCALE_DB']       || 'sylphie_events',
  user:     process.env['TIMESCALE_USER']     || 'sylphie',
  password: process.env['TIMESCALE_PASSWORD'] || 'sylphie_events_dev',
};

// ---------------------------------------------------------------------------
// SQL — the created_at < '2026-06-13' clause is LOAD-BEARING (DEC-17):
// it prevents over-matching new intentionally-world-scoped rows written
// after Wave-3. Do not remove or relax this predicate.
// ---------------------------------------------------------------------------

/** Count candidates (the same filter used by the UPDATE — idempotency is structural). */
const COUNT_SQL = `
  SELECT COUNT(*)::int AS n
    FROM learned_patterns
   WHERE grounding_person_id IS NULL
     AND knowledge_grounding = 'GROUNDED'
     AND created_at < '2026-06-13'
`;

/** 5-row sample for dry-run preview. */
const SAMPLE_SQL = `
  SELECT id,
         LEFT(response_text, 80) AS preview,
         created_at
    FROM learned_patterns
   WHERE grounding_person_id IS NULL
     AND knowledge_grounding = 'GROUNDED'
     AND created_at < '2026-06-13'
   ORDER BY created_at
   LIMIT 5
`;

/**
 * The migration UPDATE.
 *
 * Idempotency: the WHERE clause is identical to COUNT_SQL — rows already set
 * to grounding_person_id='guardian' are excluded (IS NULL does not match them),
 * so a re-run is always a no-op.
 */
const UPDATE_SQL = `
  UPDATE learned_patterns
     SET grounding_person_id = 'guardian'
   WHERE grounding_person_id IS NULL
     AND knowledge_grounding = 'GROUNDED'
     AND created_at < '2026-06-13'
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function header(text: string): void {
  const line = '─'.repeat(60);
  console.log(`\n${line}\n  ${text}\n${line}`);
}

function info(t: string): void  { console.log(`  [INFO]  ${t}`); }
function ok(t: string): void    { console.log(`  [OK]    ${t}`); }
function warn(t: string): void  { console.log(`  [WARN]  ${t}`); }
function fail(t: string): void  { console.error(`  [FAIL]  ${t}`); }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  header('TK-78 — Legacy warm-pattern re-scoping migration (DEC-7 / AD-0011)');
  info(`Repo root: ${REPO_ROOT}`);
  info(`Mode: ${CONFIRMED ? 'LIVE (--confirm)' : 'DRY RUN (no writes)'}`);

  const pool = new Pool({
    ...TIMESCALE_CONFIG,
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  });

  try {
    // ------------------------------------------------------------------
    // 1. Count candidate rows (always, dry-run and live)
    // ------------------------------------------------------------------
    header('Step 1: count candidate rows');

    let candidateCount: number;
    try {
      const res = await pool.query<{ n: number }>(COUNT_SQL);
      candidateCount = res.rows[0]!.n;
    } catch (err) {
      fail(`COUNT query failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    info(
      `Candidate rows (grounding_person_id IS NULL AND knowledge_grounding='GROUNDED' ` +
      `AND created_at < '2026-06-13'): ${candidateCount}`,
    );

    if (candidateCount === 0) {
      ok('No candidates found — migration already applied or DB is clean. Nothing to do.');
      process.exit(0);
    }

    // Sanity warning: if the count is wildly outside the expected range, flag it
    // so a human can verify before applying. This is an informational guard — the
    // script proceeds in dry-run and requires explicit confirmation to apply anyway.
    if (candidateCount < 50 || candidateCount > 600) {
      warn(
        `Expected ~293 rows (pre-Wave-3 corpus); found ${candidateCount}. ` +
        `Verify the filter is correct before applying.`,
      );
    }

    // ------------------------------------------------------------------
    // 2. Show a 5-row sample (always)
    // ------------------------------------------------------------------
    try {
      const sampleRes = await pool.query<{
        id: string;
        preview: string;
        created_at: Date;
      }>(SAMPLE_SQL);

      info(`5-row sample (oldest first):`);
      for (const row of sampleRes.rows) {
        const dateStr = String(row.created_at).substring(0, 10);
        console.log(`    ${row.id}  ${dateStr}  ${row.preview}`);
      }
    } catch (err) {
      warn(`Could not fetch sample rows: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ------------------------------------------------------------------
    // Dry-run exit
    // ------------------------------------------------------------------
    if (!CONFIRMED) {
      header('DRY RUN — no changes made');
      console.log(`
  Matched rows:  ${candidateCount}
  Migration SQL: UPDATE learned_patterns
                   SET grounding_person_id = 'guardian'
                 WHERE grounding_person_id IS NULL
                   AND knowledge_grounding = 'GROUNDED'
                   AND created_at < '2026-06-13'

  To apply:
    npx tsx infra/migrations/001-legacy-pattern-rescope.ts --confirm
  Or:
    SYLPHIE_MIGRATE_CONFIRM=1 npx tsx infra/migrations/001-legacy-pattern-rescope.ts
`);
      process.exit(0);
    }

    // ------------------------------------------------------------------
    // 3. Backup BEFORE write (HARD-STOP on failure — AC2 / DEC-17)
    // ------------------------------------------------------------------
    header('Step 2: pg_dump backup (required before any write)');

    const backupDir = path.join(REPO_ROOT, 'backups');
    try {
      fs.mkdirSync(backupDir, { recursive: true });
    } catch (err) {
      fail(
        `Cannot create backup directory ${backupDir}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      // HARD-STOP: never proceed without a backup destination.
      process.exit(1);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupDir, `learned_patterns-pre-tk78-${timestamp}.sql`);

    try {
      // pg_dump of the single table via docker exec (matches reset-data.ts convention).
      execSync(
        `docker exec sylphie-timescaledb pg_dump` +
        ` -U ${TIMESCALE_CONFIG.user}` +
        ` -d ${TIMESCALE_CONFIG.database}` +
        ` -t learned_patterns --data-only` +
        ` > "${backupFile}"`,
        { shell: 'bash', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      ok(`Backup written to: ${backupFile}`);
    } catch (backupErr) {
      // HARD-STOP (AC2 / DEC-17): a destructive prod migration NEVER continues
      // on a backup failure. process.exit(1) — do not continue-with-WARN.
      fail(
        `pg_dump FAILED: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`,
      );
      fail('Migration ABORTED — no data was modified.');
      fail(
        'Ensure Docker is running (docker ps | grep sylphie-timescaledb) ' +
        'and retry, or take a manual backup before proceeding.',
      );
      process.exit(1);
    }

    // ------------------------------------------------------------------
    // 4. Apply migration in a transaction
    // ------------------------------------------------------------------
    header(`Step 3: UPDATE grounding_person_id = 'guardian'`);

    const client = await pool.connect();
    let updatedCount = 0;
    try {
      await client.query('BEGIN');
      const updateRes = await client.query(UPDATE_SQL);
      updatedCount = updateRes.rowCount ?? 0;
      await client.query('COMMIT');
      ok(`Updated ${updatedCount} rows → grounding_person_id = 'guardian'.`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {/* ignore rollback error */});
      fail(`UPDATE failed — rolled back: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      client.release();
    }

    // ------------------------------------------------------------------
    // 5. Verify: remaining NULL+GROUNDED+pre-Wave3 rows = 0 (idempotency)
    // ------------------------------------------------------------------
    header('Step 4: idempotency verification');

    let remaining: number;
    try {
      const verifyRes = await pool.query<{ n: number }>(COUNT_SQL);
      remaining = verifyRes.rows[0]!.n;
    } catch (err) {
      warn(
        `Verification query failed (manual check required): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      remaining = -1;
    }

    if (remaining === 0) {
      ok('Idempotency check PASSED — 0 NULL GROUNDED pre-Wave-3 rows remain.');
    } else if (remaining > 0) {
      warn(
        `${remaining} NULL GROUNDED pre-Wave-3 rows still present — unexpected. ` +
        `Investigate before re-running.`,
      );
    }

    // ------------------------------------------------------------------
    // Done
    // ------------------------------------------------------------------
    header('Migration complete');
    console.log(`
  Summary:
    Matched and updated: ${updatedCount} rows
    Remaining NULL GROUNDED pre-Wave-3 rows: ${remaining >= 0 ? remaining : '(verification failed)'}
    Backup file: ${backupFile}

  REVERSE step (if needed — restores prior NULL world-scope):
    Connect to TimescaleDB and run:

      UPDATE learned_patterns
        SET grounding_person_id = NULL
      WHERE grounding_person_id = 'guardian'
        AND knowledge_grounding = 'GROUNDED'
        AND created_at < '2026-06-13';

    Or restore from backup:
      cat "${backupFile}" | \\
        docker exec -i sylphie-timescaledb psql \\
          -U ${TIMESCALE_CONFIG.user} ${TIMESCALE_CONFIG.database}
`);

  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  fail(`Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

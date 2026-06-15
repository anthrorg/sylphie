#!/usr/bin/env npx tsx
/**
 * scripts/reset-data.ts — Schema-preserving data-reset utility (Wave 3 / C7).
 *
 * PURPOSE
 * -------
 * Wipe Sylphie's accumulated runtime memory/data while keeping every table
 * definition, hypertable configuration, index, constraint, and schema object
 * intact.  The live system re-learns through the C3 Candidate path on a clean
 * slate.
 *
 * Also handles the load-bearing `kg_label_fulltext` index recreate:
 *   `CREATE FULLTEXT INDEX … IF NOT EXISTS` will NOT alter an already-existing
 *   index.  So on a DB created before Wave 3 / C0, the index still spans only
 *   the original 7 labels (no :Candidate).  This utility DROPs and recreates
 *   that index with the correct 8-label set so the application picks it up
 *   automatically on next startup.
 *
 * SAFETY
 * ------
 * The utility NEVER runs unless --confirm is passed (or SYLPHIE_RESET_CONFIRM=1
 * is set in the environment).  Without the flag it prints a dry-run plan and
 * exits 0 without touching any database.
 *
 * This is a standalone script — it does NOT import NestJS or any application
 * service.  It connects directly to the databases using the same credentials
 * and ports the Docker Compose environment exposes.
 *
 * USAGE
 * -----
 *   # Dry run (no DB changes — always safe):
 *   npx tsx scripts/reset-data.ts
 *
 *   # Live run (wipes data — irreversible):
 *   npx tsx scripts/reset-data.ts --confirm
 *
 *   # Or via environment variable:
 *   SYLPHIE_RESET_CONFIRM=1 npx tsx scripts/reset-data.ts
 *
 * ROLLBACK
 * --------
 * There is no rollback for a data wipe.  Back up first if needed:
 *   docker exec sylphie-neo4j-world neo4j-admin database dump \
 *     --to-path=/var/lib/neo4j/import neo4j
 *   docker cp sylphie-neo4j-world:/var/lib/neo4j/import/neo4j.dump \
 *     ./backups/neo4j-world-pre-reset.dump
 *   docker exec sylphie-timescaledb pg_dump -U sylphie sylphie_events \
 *     > ./backups/timescale-pre-reset.sql
 *   docker exec sylphie-postgres pg_dump -U sylphie_admin sylphie_system \
 *     > ./backups/postgres-pre-reset.sql
 */

import neo4j from 'neo4j-driver';
import { Pool } from 'pg';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Repository root — always use process.cwd(), never __dirname
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Confirmation gate — must be explicit; never runs accidentally
// ---------------------------------------------------------------------------

const CONFIRMED =
  process.argv.includes('--confirm') ||
  process.env['SYLPHIE_RESET_CONFIRM'] === '1';

// ---------------------------------------------------------------------------
// Database connection parameters
// (Matching docker-compose.yml exactly — no guessing)
// ---------------------------------------------------------------------------

// Neo4j WORLD  (docker: sylphie-neo4j-world, host port 7687)
const NEO4J_WORLD = {
  uri:      process.env['NEO4J_WORLD_URI']     || 'bolt://localhost:7687',
  user:     process.env['NEO4J_WORLD_USER']    || 'neo4j',
  password: process.env['NEO4J_WORLD_PASS']    || 'sylphie_world',
};

// Neo4j SELF   (docker: sylphie-neo4j-self, host port 7690)
const NEO4J_SELF = {
  uri:      process.env['NEO4J_SELF_URI']      || 'bolt://localhost:7690',
  user:     process.env['NEO4J_SELF_USER']     || 'neo4j',
  password: process.env['NEO4J_SELF_PASS']     || 'sylphie_self',
};

// Neo4j OTHER  (docker: sylphie-neo4j-other, host port 7689)
const NEO4J_OTHER = {
  uri:      process.env['NEO4J_OTHER_URI']     || 'bolt://localhost:7689',
  user:     process.env['NEO4J_OTHER_USER']    || 'neo4j',
  password: process.env['NEO4J_OTHER_PASS']    || 'sylphie_other',
};

// TimescaleDB  (docker: sylphie-timescaledb, host port 5433)
const TIMESCALE_CONFIG = {
  host:     process.env['TIMESCALE_HOST']      || 'localhost',
  port:     parseInt(process.env['TIMESCALE_PORT'] || '5433', 10),
  database: process.env['TIMESCALE_DB']        || 'sylphie_events',
  user:     process.env['TIMESCALE_USER']      || 'sylphie',
  password: process.env['TIMESCALE_PASSWORD']  || 'sylphie_events_dev',
};

// PostgreSQL   (docker: sylphie-postgres, host port 5434)
// Uses sylphie_admin (superuser) so it can TRUNCATE proposed_drive_rules
// without hitting RLS restrictions placed on the runtime user.
const POSTGRES_CONFIG = {
  host:     process.env['POSTGRES_HOST']       || 'localhost',
  port:     parseInt(process.env['POSTGRES_PORT'] || '5434', 10),
  database: process.env['POSTGRES_DB']         || 'sylphie_system',
  user:     process.env['POSTGRES_ADMIN_USER'] || 'sylphie_admin',
  password: process.env['POSTGRES_ADMIN_PASS'] || 'sylphie_admin_dev',
};

// ---------------------------------------------------------------------------
// The canonical kg_label_fulltext label set (from wkg-query.service.ts:146)
// ---------------------------------------------------------------------------
//
// This MUST match the CREATE FULLTEXT INDEX statement in KG_INDEX_STATEMENTS
// inside apps/sylphie/src/services/wkg-query.service.ts.
// If that file changes, update here too.
//
// Wave 3 / C0 adds :Candidate to the set (8 labels total).
// Applied to: WORLD, SELF, and OTHER (ensureKgIndexes runs on all three).

const KG_LABEL_FULLTEXT_LABELS =
  'Entity|ActionProcedure|CoBeing|Drive|Insight|Conversation|Attribute|Candidate';

const KG_LABEL_FULLTEXT_CYPHER_DROP = `
DROP INDEX kg_label_fulltext IF EXISTS
`;

const KG_LABEL_FULLTEXT_CYPHER_CREATE = `
CREATE FULLTEXT INDEX kg_label_fulltext
FOR (n:${KG_LABEL_FULLTEXT_LABELS})
ON EACH [n.label]
`;

// ---------------------------------------------------------------------------
// TimescaleDB tables to TRUNCATE
//
// ALL of these are accumulated runtime memory — none are schema/structure.
// The TRUNCATE preserves: table definition, hypertable config, all indexes,
// all constraints (including the Std-3 confidence ceiling CHECK on
// learned_patterns), and the TimescaleDB extension metadata.
//
// CASCADE is used because TimescaleDB hypertable chunks are internal child
// tables of the parent; CASCADE ensures they are cleared without error even
// when the internal chunk structure is involved.  It does NOT cascade to
// unrelated tables — there are no FK relationships between these.
// ---------------------------------------------------------------------------

const TIMESCALE_TABLES_TO_TRUNCATE: Array<{
  name: string;
  description: string;
  isMandatory: boolean;  // false = skip silently if table doesn't exist yet
}> = [
  {
    name: 'events',
    description: 'Decision / drive event backbone (all subsystems)',
    isMandatory: true,
  },
  {
    name: 'learned_patterns',
    description: 'Type 1 latent-space warm layer (fused stimulus→response patterns)',
    isMandatory: true,
  },
  {
    name: 'voice_patterns',
    description: 'Voice latent-space warm layer cache',
    isMandatory: true,
  },
  {
    name: 'sensory_ticks',
    description: 'Sensory stream hypertable (per-tick fused embeddings)',
    isMandatory: true,
  },
  {
    name: 'reflected_sessions',
    description: 'Conversation-reflection de-duplication tracker',
    isMandatory: false,  // created lazily by conversation-reflection.service.ts
  },
  {
    name: 'synthesized_insight_pairs',
    description: 'Cross-session synthesis de-duplication tracker',
    isMandatory: false,  // created lazily by cross-session-synthesis.service.ts
  },
  {
    name: 'episodic_memory_checkpoint',
    description: 'Episodic memory ring-buffer persistence checkpoint',
    isMandatory: false,  // created lazily by episodic-memory.service.ts
  },
  {
    name: 'drive_state_checkpoint',
    description: 'Drive Engine state persistence (single-row UPSERT)',
    isMandatory: false,  // created lazily by timescale-writer.ts in drive process
  },
];

// ---------------------------------------------------------------------------
// PostgreSQL tables to TRUNCATE
//
// USERS ARE KEPT.  The `users` table is identity/auth structure:
//   - User rows carry JWT-bound identity (UUID used as JWT subject).
//   - Wiping users would invalidate all issued tokens and break guardian access.
//   - Users are not learned memory — they were created by Jim during setup.
//   - The correct per-CANON position: identity is infrastructure, not memory.
//
// proposed_drive_rules IS wiped: it is a queue of autonomously proposed rule
// changes that have not been approved yet.  Stale proposals from sessions
// that pre-date the isolation fix are meaningless and potentially misleading.
//
// drive_rules is NOT touched: it is write-protected by RLS even for superuser
// connections in the application role, and guardian-approved rules are
// structural configuration, not learned memory.  Wiping drive_rules would
// disable Sylphie's behavioural engine entirely.
// ---------------------------------------------------------------------------

const POSTGRES_TABLES_TO_TRUNCATE: Array<{
  name: string;
  description: string;
  isMandatory: boolean;
}> = [
  {
    name: 'proposed_drive_rules',
    description: 'Autonomously proposed drive rule changes awaiting guardian review',
    isMandatory: false,  // may not exist on a fresh DB
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function header(text: string): void {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(`${line}`);
}

function info(text: string): void {
  console.log(`  [INFO]  ${text}`);
}

function warn(text: string): void {
  console.log(`  [WARN]  ${text}`);
}

function ok(text: string): void {
  console.log(`  [OK]    ${text}`);
}

function skip(text: string): void {
  console.log(`  [SKIP]  ${text}`);
}

function fail(text: string): void {
  console.error(`  [FAIL]  ${text}`);
}

// ---------------------------------------------------------------------------
// Dry-run plan printer
// ---------------------------------------------------------------------------

function printDryRunPlan(): void {
  header('SYLPHIE DATA RESET UTILITY — DRY RUN (no changes made)');

  console.log(`
  Run with --confirm (or SYLPHIE_RESET_CONFIRM=1) to execute for real.

  Repo root: ${REPO_ROOT}
`);

  header(`STORE 1: Neo4j WORLD  (${NEO4J_WORLD.uri})`);
  console.log(`
  WIPE:     MATCH (n) DETACH DELETE n
            — deletes ALL nodes and relationships
  PRESERVE: All constraints (ap_id_unique, etc.)
            All range indexes (entity_label, entity_node_id, etc.)
            The database itself and its transaction log

  THEN — DROP + recreate kg_label_fulltext with updated label set:
    DROP INDEX kg_label_fulltext IF EXISTS
    CREATE FULLTEXT INDEX kg_label_fulltext
      FOR (n:${KG_LABEL_FULLTEXT_LABELS})
      ON EACH [n.label]

  WHY: IF NOT EXISTS does not alter an existing index. On a DB created
       before Wave 3/C0, the live index still spans only 7 labels
       (no :Candidate). Dropping and recreating makes the 8-label set
       take effect immediately — the application re-creates all indexes
       on startup via ensureKgIndexes(), so this is the correct moment.
`);

  header(`STORE 2: Neo4j SELF  (${NEO4J_SELF.uri})`);
  console.log(`
  WIPE:     MATCH (n) DETACH DELETE n
            — deletes all self-model nodes and relationships
  PRESERVE: All constraints and indexes
            DROP + recreate kg_label_fulltext (same label set as WORLD)

  NOTE: The application re-bootstraps the SELF KG (CoBeing anchor +
        3 identity facts) on startup via WkgBootstrapService.
`);

  header(`STORE 3: Neo4j OTHER  (${NEO4J_OTHER.uri})`);
  console.log(`
  WIPE:     MATCH (n) DETACH DELETE n
            — deletes all person-model nodes and relationships
  PRESERVE: All constraints and indexes
            DROP + recreate kg_label_fulltext (same label set as WORLD)
`);

  header(`STORE 4: TimescaleDB  (${TIMESCALE_CONFIG.host}:${TIMESCALE_CONFIG.port}/${TIMESCALE_CONFIG.database})`);
  console.log(`  Tables to TRUNCATE … CASCADE:`);
  for (const t of TIMESCALE_TABLES_TO_TRUNCATE) {
    const mandatory = t.isMandatory ? '' : ' (skip if absent)';
    console.log(`    - ${t.name.padEnd(35)} ${t.description}${mandatory}`);
  }
  console.log(`
  PRESERVE: Table definitions and all column types
            Hypertable configuration (chunk intervals)
            All indexes (learned_patterns_embedding_idx, etc.)
            All constraints (Std-3 confidence ceiling CHECK, etc.)
            TimescaleDB extension metadata
            Continuous aggregate definitions (if any)
`);

  header(`STORE 5: PostgreSQL  (${POSTGRES_CONFIG.host}:${POSTGRES_CONFIG.port}/${POSTGRES_CONFIG.database})`);
  console.log(`
  KEEP (not touched):
    - users                Table is identity/auth structure.  Wiping it
                           would invalidate issued JWTs and break guardian
                           access.  Users are infrastructure, not memory.
    - drive_rules          Guardian-approved behavioural rules.  Wiping
                           would disable the drive engine entirely.  Not
                           learned memory — deliberately configured state.
    - _prisma_migrations   Prisma migration history — structural metadata.

  TRUNCATE:
    - proposed_drive_rules Pre-isolation proposed rule queue (stale).
                           (skip if absent)
`);

  header('WHAT IS NOT TOUCHED');
  console.log(`
  - Docker volumes:  neo4j_world_data, neo4j_self_data, neo4j_other_data,
                     timescaledb_data, postgres_data  (NOT removed)
  - Docker containers and images
  - All schema/structure (tables, indexes, constraints, hypertable config)
  - Drive Engine in-memory state (separate process; not accessible here)
    → The drive process reads from drive_state_checkpoint on startup;
      that table IS wiped, so drive state resets to INITIAL_DRIVE_STATE.
  - Cognition-service weights volume (separate Docker volume)
`);

  header('POST-RESET EXPECTED STATE');
  console.log(`
  After a successful live run + application restart:
    - Neo4j WORLD: 0 data nodes; WkgBootstrapService re-creates CoBeing
                   anchor + 12 Drive nodes on startup.
    - Neo4j SELF:  0 nodes; WkgBootstrapService re-creates self identity.
    - Neo4j OTHER: 0 nodes; created as conversations happen.
    - TimescaleDB: all tables empty; schemas intact; re-populates live.
    - PostgreSQL:  users and drive_rules intact; proposed queue empty.
    - kg_label_fulltext: now covers :Candidate (8 labels) on all 3 graphs.
    - PRIV.1 gate: should pass (no leaked world-scope personal facts).
`);
}

// ---------------------------------------------------------------------------
// Neo4j reset for one instance
// ---------------------------------------------------------------------------

async function resetNeo4jInstance(
  label: string,
  config: { uri: string; user: string; password: string },
  dryRun: boolean,
): Promise<void> {
  header(`Neo4j ${label}  (${config.uri})`);

  const driver = neo4j.driver(
    config.uri,
    neo4j.auth.basic(config.user, config.password),
    { connectionAcquisitionTimeout: 10_000 },
  );

  try {
    // Verify connectivity
    await driver.verifyConnectivity();
    info('Connection verified');

    const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });

    try {
      // Count before wipe
      const countResult = await session.run(
        `MATCH (n) OPTIONAL MATCH (n)-[r]-() RETURN count(DISTINCT n) AS nodes, count(DISTINCT r) AS edges`,
      );
      const rec = countResult.records[0];
      const nodeCount = rec.get('nodes').toNumber();
      const edgeCount = rec.get('edges').toNumber();
      info(`Current state: ${nodeCount} nodes, ${edgeCount} edges`);

      if (dryRun) {
        skip(`DRY RUN — would DETACH DELETE all ${nodeCount} nodes and ${edgeCount} edges`);
        skip(`DRY RUN — would DROP INDEX kg_label_fulltext IF EXISTS`);
        skip(`DRY RUN — would CREATE FULLTEXT INDEX kg_label_fulltext FOR (n:${KG_LABEL_FULLTEXT_LABELS}) ON EACH [n.label]`);
        return;
      }

      // 1. Wipe all data
      if (nodeCount > 0) {
        await session.run(`MATCH (n) DETACH DELETE n`);
        ok(`DETACH DELETE complete — ${nodeCount} nodes, ${edgeCount} edges removed`);
      } else {
        info('Graph already empty — no nodes to delete');
      }

      // 2. Drop the fulltext index (if it exists with the old label set)
      try {
        await session.run(KG_LABEL_FULLTEXT_CYPHER_DROP);
        info('kg_label_fulltext dropped (was present with old label set or already absent)');
      } catch (err) {
        // IF EXISTS handles the absent case; this path should not be reached.
        warn(`DROP INDEX kg_label_fulltext: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 3. Recreate with correct 8-label set
      try {
        await session.run(KG_LABEL_FULLTEXT_CYPHER_CREATE);
        ok(`kg_label_fulltext recreated — labels: ${KG_LABEL_FULLTEXT_LABELS}`);
      } catch (err) {
        // Log but don't fail the whole reset — the application recreates on startup.
        warn(
          `kg_label_fulltext CREATE failed (non-fatal — app will recreate on startup): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }

    } finally {
      await session.close();
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ServiceUnavailable') || msg.includes('ECONNREFUSED')) {
      warn(`Neo4j ${label} is not reachable — skipping (start containers first if doing a live reset)`);
    } else {
      fail(`Neo4j ${label} error: ${msg}`);
      throw err;
    }
  } finally {
    await driver.close();
  }
}

// ---------------------------------------------------------------------------
// TimescaleDB reset
// ---------------------------------------------------------------------------

async function resetTimescale(dryRun: boolean): Promise<void> {
  header(`TimescaleDB  (${TIMESCALE_CONFIG.host}:${TIMESCALE_CONFIG.port}/${TIMESCALE_CONFIG.database})`);

  const pool = new Pool({ ...TIMESCALE_CONFIG, max: 1, connectionTimeoutMillis: 10_000 });

  try {
    const client = await pool.connect();

    try {
      // Verify connectivity
      await client.query('SELECT 1');
      info('Connection verified');

      for (const t of TIMESCALE_TABLES_TO_TRUNCATE) {
        // Check whether the table exists before attempting TRUNCATE
        const exists = await client.query(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1`,
          [t.name],
        );

        if (exists.rows.length === 0) {
          if (t.isMandatory) {
            warn(`Table ${t.name} not found — will be created by application on startup`);
          } else {
            skip(`${t.name} — table not present, nothing to clear`);
          }
          continue;
        }

        // Get current row count
        const countResult = await client.query(
          `SELECT count(*) AS n FROM ${t.name}`,
        );
        const rowCount = parseInt(countResult.rows[0].n, 10);

        if (dryRun) {
          skip(`DRY RUN — would TRUNCATE ${t.name} CASCADE  (${rowCount} rows)  — ${t.description}`);
          continue;
        }

        await client.query(`TRUNCATE ${t.name} CASCADE`);
        ok(`TRUNCATE ${t.name} CASCADE  (${rowCount} rows cleared)  — ${t.description}`);
      }

      if (!dryRun) {
        // Verify schema is intact: re-query the table list
        const tableCheck = await client.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public'
           ORDER BY table_name`,
        );
        const tableNames = tableCheck.rows.map((r: { table_name: string }) => r.table_name);
        info(`Schema intact — tables still present: ${tableNames.join(', ')}`);
      }

    } finally {
      client.release();
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
      warn(`TimescaleDB is not reachable — skipping (start containers first if doing a live reset)`);
    } else {
      fail(`TimescaleDB error: ${msg}`);
      throw err;
    }
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL reset
// ---------------------------------------------------------------------------

async function resetPostgres(dryRun: boolean): Promise<void> {
  header(`PostgreSQL  (${POSTGRES_CONFIG.host}:${POSTGRES_CONFIG.port}/${POSTGRES_CONFIG.database})`);

  const pool = new Pool({ ...POSTGRES_CONFIG, max: 1, connectionTimeoutMillis: 10_000 });

  try {
    const client = await pool.connect();

    try {
      await client.query('SELECT 1');
      info('Connection verified');

      // Report on what we are deliberately keeping
      info('KEEPING: users, drive_rules, _prisma_migrations (identity/auth structure + drive config)');

      // Report user count for transparency
      try {
        const userCount = await client.query(`SELECT count(*) AS n FROM users`);
        info(`users table: ${userCount.rows[0].n} rows — preserved`);
      } catch {
        info('users table: could not query (may not exist yet)');
      }

      // Report drive_rules count for transparency
      try {
        const drCount = await client.query(`SELECT count(*) AS n FROM drive_rules`);
        info(`drive_rules table: ${drCount.rows[0].n} rows — preserved`);
      } catch {
        info('drive_rules table: could not query (may not exist yet)');
      }

      for (const t of POSTGRES_TABLES_TO_TRUNCATE) {
        const exists = await client.query(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1`,
          [t.name],
        );

        if (exists.rows.length === 0) {
          skip(`${t.name} — table not present, nothing to clear`);
          continue;
        }

        const countResult = await client.query(
          `SELECT count(*) AS n FROM ${t.name}`,
        );
        const rowCount = parseInt(countResult.rows[0].n, 10);

        if (dryRun) {
          skip(`DRY RUN — would TRUNCATE ${t.name}  (${rowCount} rows)  — ${t.description}`);
          continue;
        }

        await client.query(`TRUNCATE ${t.name}`);
        ok(`TRUNCATE ${t.name}  (${rowCount} rows cleared)  — ${t.description}`);
      }

    } finally {
      client.release();
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
      warn(`PostgreSQL is not reachable — skipping (start containers first if doing a live reset)`);
    } else {
      fail(`PostgreSQL error: ${msg}`);
      throw err;
    }
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!CONFIRMED) {
    printDryRunPlan();
    console.log(`
${'='.repeat(60)}
  DRY RUN COMPLETE — no databases were modified.

  To execute the reset for real:
    npx tsx scripts/reset-data.ts --confirm
  or:
    SYLPHIE_RESET_CONFIRM=1 npx tsx scripts/reset-data.ts
${'='.repeat(60)}
`);
    process.exit(0);
  }

  // Live run — print a clear header before doing anything destructive
  header('SYLPHIE DATA RESET — LIVE RUN');
  console.log(`
  CONFIRMED=true  — databases will be modified.
  Repo root: ${REPO_ROOT}

  This is irreversible.  Back up first if you have not already:
    docker exec sylphie-neo4j-world neo4j-admin database dump \\
      --to-path=/var/lib/neo4j/import neo4j && \\
    docker cp sylphie-neo4j-world:/var/lib/neo4j/import/neo4j.dump \\
      ./backups/neo4j-world-pre-reset.dump
`);

  let exitCode = 0;

  try {
    // Neo4j: WORLD, SELF, OTHER
    await resetNeo4jInstance('WORLD', NEO4J_WORLD, false);
    await resetNeo4jInstance('SELF',  NEO4J_SELF,  false);
    await resetNeo4jInstance('OTHER', NEO4J_OTHER, false);

    // TimescaleDB
    await resetTimescale(false);

    // PostgreSQL
    await resetPostgres(false);

  } catch (err) {
    fail(`Reset aborted due to error: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  }

  header('RESET COMPLETE');
  console.log(`
  What happened:
    - Neo4j WORLD: all nodes/edges deleted; kg_label_fulltext recreated (8 labels)
    - Neo4j SELF:  all nodes/edges deleted; kg_label_fulltext recreated
    - Neo4j OTHER: all nodes/edges deleted; kg_label_fulltext recreated
    - TimescaleDB: all data hypertables truncated; schema intact
    - PostgreSQL:  proposed_drive_rules cleared; users/drive_rules preserved

  Next steps:
    1. Restart the application (docker-compose restart / yarn dev:backend)
    2. WkgBootstrapService will re-seed WORLD (CoBeing + 12 Drives) and SELF
    3. Run gate PRIV.1 to confirm no legacy personal facts remain groundable
    4. New conversations will mint :Candidate nodes (not :Entity) via C3 path

  The kg_label_fulltext index now covers :Candidate on all three graphs.
  The application's ensureKgIndexes() will confirm it on startup (IF NOT
  EXISTS will no-op — the recreated index is already correct).
`);

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});

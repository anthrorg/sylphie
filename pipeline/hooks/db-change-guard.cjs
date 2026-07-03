#!/usr/bin/env node
/**
 * db-change-guard.cjs — repo-wide PreToolUse guard for database changes.
 *
 * WHY
 * ---
 * Sylphie's whole point is durable, accumulated knowledge/identity (CON-2/CON-3).
 * A schema change that forces a database WIPE destroys exactly that. This hook
 * makes the wipe-prone operations impossible to do silently: it HARD-BLOCKS the
 * destructive ones and points at the safe incremental-migration path instead.
 *
 * INSTALL: run  `node pipeline/hooks/install-db-guard.cjs`  once. It registers
 * this script as a PreToolUse (Write|Edit|Bash) hook in .claude/settings.json.
 *
 * SCOPE  (matcher: Write | Edit | Bash)
 *   HARD BLOCK (exit 2):
 *     - Bash commands that wipe/destroy DB state (down -v, prisma migrate reset,
 *       reset:confirm, DROP/TRUNCATE/DETACH DELETE, neo4j-admin database drop…).
 *     - Edits to infra/{postgres,timescaledb}/init/** — those scripts only run on
 *       a FRESH volume, so evolving a schema through them implies recreating the
 *       volume, i.e. wiping a populated DB.
 *   REMINDER (exit 0, non-blocking):
 *     - Edits to prisma/schema.prisma, *.sql, *.cypher outside the migration dirs.
 *   ALLOW silently:
 *     - New files under infra/migrations/** or prisma/migrations/** (the GOOD path).
 *     - Anything explicitly approved (see ESCAPE HATCH).
 *
 * ESCAPE HATCH (auditable)
 *   A genuinely necessary destructive change is allowed when EITHER:
 *     - the Bash command is prefixed with  SYLPHIE_DB_CHANGE_APPROVED=1 , or
 *     - the process env has SYLPHIE_DB_CHANGE_APPROVED=1, or
 *     - the file  infra/migrations/.db-change-approved  exists (ideally citing the
 *       contract decision id that authorized it).
 *   Every approved override is logged to pipeline/logs/db-guard.log. The sweep cog
 *   flags a lingering .db-change-approved marker so it can't silently stay on.
 *
 * Convention this enforces already lives in the repo:
 *   infra/migrations/001-legacy-pattern-rescope.ts and scripts/reset-data.ts
 *   (dry-run default, --confirm to apply, backup-before-write with hard-stop,
 *   idempotent, documented REVERSE). See pipeline/policies/db-change-safety.md.
 */
'use strict';
const fs = require('fs');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch (_) {}
let data = {};
try { data = JSON.parse(raw || '{}'); } catch (_) {}

const tool = data.tool_name || '';
const ti = data.tool_input || {};
const cwd = (data.cwd || process.cwd() || '.').replace(/\\/g, '/');
const filePath = String(ti.file_path || ti.path || '').replace(/\\/g, '/');
const command = String(ti.command || '');

const markerPath = `${cwd}/infra/migrations/.db-change-approved`;

function approved() {
  if (process.env.SYLPHIE_DB_CHANGE_APPROVED === '1') return true;
  if (/\bSYLPHIE_DB_CHANGE_APPROVED=1\b/.test(command)) return true;
  try { if (fs.existsSync(markerPath)) return true; } catch (_) {}
  return false;
}

function logLine(line) {
  try {
    fs.appendFileSync(`${cwd}/pipeline/logs/db-guard.log`,
      `${new Date().toISOString()} ${line}\n`);
  } catch (_) {}
}

function block(reason) {
  process.stderr.write('[db-change-guard] BLOCKED\n' + reason + '\n');
  process.exit(2); // exit 2 => PreToolUse denies the call; stderr is fed back.
}

const POLICY = 'See pipeline/policies/db-change-safety.md.';

// --------------------------------------------------------------------------- //
// 1) Destructive Bash
// --------------------------------------------------------------------------- //
if (tool === 'Bash' && command) {
  const destructive = [
    /docker(\s+compose|-compose)\s+down\b[^\n]*(?:\s-v\b|--volumes\b)/i,
    /prisma\s+migrate\s+reset/i,
    /\breset:confirm\b/i,
    /reset-data\.ts[^\n]*--confirm/i,
    /\bDROP\s+(DATABASE|SCHEMA|TABLE)\b/i,
    /\bTRUNCATE\b/i,
    /DETACH\s+DELETE/i,
    /neo4j-admin\s+database\s+(drop|delete)/i,
  ];
  if (destructive.some((re) => re.test(command))) {
    if (approved()) {
      logLine(`APPROVED destructive bash: ${command.slice(0, 240)}`);
      process.exit(0);
    }
    block(
      `This command wipes or destroys database state:\n  ${command}\n\n` +
      `Sylphie's accumulated memory/identity must survive schema changes (CON-2/CON-3).\n` +
      `Do NOT wipe to evolve a schema. Instead:\n` +
      `  1. Write an incremental migration under infra/migrations/NNN-*.ts\n` +
      `     (dry-run default, --confirm to apply, backup-before-write with hard-stop, REVERSE documented).\n` +
      `  2. Record it as an append-only decision in planning/contract.yaml.\n` +
      `  3. If the wipe is truly unavoidable: back up first, then approve explicitly —\n` +
      `     run as  SYLPHIE_DB_CHANGE_APPROVED=1 <command>\n` +
      `     (or create infra/migrations/.db-change-approved citing the decision id).\n` +
      POLICY
    );
  }
}

// --------------------------------------------------------------------------- //
// 2) File edits
// --------------------------------------------------------------------------- //
if ((tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') && filePath) {
  const isInit = /\/infra\/(postgres|timescaledb)\/init\//.test(filePath);
  const isMigrationFile = /\/(infra\/migrations|prisma\/migrations)\//.test(filePath);

  if (isInit) {
    if (approved()) {
      logLine(`APPROVED init-script edit: ${filePath}`);
      process.exit(0);
    }
    block(
      `Editing a DB init script changes the schema only on a FRESH volume — applying it\n` +
      `to the running system means recreating the volume, i.e. WIPING the populated DB.\n  ${filePath}\n\n` +
      `Evolve the schema with an incremental migration instead (infra/migrations/NNN-*.ts),\n` +
      `so the live databases keep their accumulated data.\n` +
      `If this is a fresh-install/init-only change (not schema evolution on a populated DB),\n` +
      `approve explicitly via infra/migrations/.db-change-approved or SYLPHIE_DB_CHANGE_APPROVED=1.\n` +
      POLICY
    );
  }

  const isNoise = /\/(test|__tests__|fixtures|dist|node_modules|\.venv)\//.test(filePath);
  const isDbSurface =
    !isMigrationFile && !isNoise &&
    (/\/prisma\/schema\.prisma$/.test(filePath) || /\.sql$/.test(filePath) || /\.cypher$/.test(filePath));

  if (isDbSurface) {
    logLine(`DB-surface edit (reminder): ${filePath}`);
    process.stderr.write(
      '[db-change-guard] NOTICE: DB-surface change. Ensure a migration plan — forward ' +
      'migration via the incremental path, backfill assessment, backup + REVERSE, and a ' +
      'data-continuity smoke. ' + POLICY + '\n'
    );
    process.exit(0); // non-blocking
  }
}

process.exit(0);

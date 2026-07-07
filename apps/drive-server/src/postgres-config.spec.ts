/**
 * Unit tests for resolvePostgresConfig() — TK-138.
 *
 * Run via: npx tsx apps/drive-server/src/postgres-config.spec.ts
 * (apps/drive-server has no jest harness configured; follows the same
 * standalone tsx + node:assert pattern as
 * packages/drive-engine/src/drive-process/opportunity-queue.spec.ts)
 *
 * Previously the default database name fell back to 'sylphie' — the real
 * name used everywhere else (docker-compose.yml, .env.example,
 * drive-engine.module.ts) is 'sylphie_system'. With POSTGRES_DB unset, the
 * drive-server would connect to a database that does not exist.
 */

import assert from 'node:assert/strict';
import { resolvePostgresConfig, DEFAULT_POSTGRES_DB } from './postgres-config.js';

let passed = 0;
let failed = 0;

function describe(suiteName: string, fn: () => void): void {
  console.log(`\n  ${suiteName}`);
  fn();
}

function it(testName: string, fn: () => void): void {
  try {
    fn();
    console.log(`    PASS  ${testName}`);
    passed++;
  } catch (err) {
    console.error(`    FAIL  ${testName}`);
    console.error(`          ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

describe('resolvePostgresConfig — POSTGRES_DB default (TK-138)', () => {
  it('resolves the default database name to the REAL name (sylphie_system), not "sylphie"', () => {
    const config = resolvePostgresConfig({} as NodeJS.ProcessEnv);
    assert.equal(config.database, 'sylphie_system');
    assert.equal(config.database, DEFAULT_POSTGRES_DB);
    assert.notEqual(config.database, 'sylphie');
  });

  it('honors an explicit POSTGRES_DB override', () => {
    const config = resolvePostgresConfig({ POSTGRES_DB: 'custom_db' } as NodeJS.ProcessEnv);
    assert.equal(config.database, 'custom_db');
  });

  it('resolves host/port/user/password with sane defaults', () => {
    const config = resolvePostgresConfig({} as NodeJS.ProcessEnv);
    assert.equal(config.host, 'localhost');
    assert.equal(config.port, 5432);
    assert.equal(config.user, 'sylphie');
    assert.equal(config.password, 'sylphie');
  });

  it('prefers POSTGRES_RUNTIME_USER/PASSWORD over POSTGRES_USER/PASSWORD', () => {
    const config = resolvePostgresConfig({
      POSTGRES_RUNTIME_USER: 'runtime_user',
      POSTGRES_RUNTIME_PASSWORD: 'runtime_pass',
      POSTGRES_USER: 'other_user',
      POSTGRES_PASSWORD: 'other_pass',
    } as NodeJS.ProcessEnv);
    assert.equal(config.user, 'runtime_user');
    assert.equal(config.password, 'runtime_pass');
  });
});

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}

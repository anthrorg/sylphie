/**
 * TK-150 (item 20260702-005) — env! non-null assertions replaced with a
 * fail-loud check.
 *
 * AC: given a missing env var, when config is read, then it fails loud
 * (not !-masked, i.e. not silently `undefined`).
 */

import { neo4jConfig, timescaleConfig, postgresConfig } from './database.config';

const REQUIRED_KEYS = [
  'NEO4J_WORLD_URI',
  'NEO4J_WORLD_USER',
  'NEO4J_WORLD_PASSWORD',
  'NEO4J_SELF_URI',
  'NEO4J_SELF_USER',
  'NEO4J_SELF_PASSWORD',
  'NEO4J_OTHER_URI',
  'NEO4J_OTHER_USER',
  'NEO4J_OTHER_PASSWORD',
  'TIMESCALE_USER',
  'TIMESCALE_PASSWORD',
  'POSTGRES_ADMIN_USER',
  'POSTGRES_ADMIN_PASSWORD',
  'POSTGRES_RUNTIME_USER',
  'POSTGRES_RUNTIME_PASSWORD',
];

function setAllRequired(): void {
  for (const key of REQUIRED_KEYS) {
    process.env[key] = `test-${key.toLowerCase()}`;
  }
}

describe('database.config — required env vars fail loud when missing', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('neo4jConfig() throws a named error when a required var is missing, instead of silently returning undefined', () => {
    setAllRequired();
    delete process.env.NEO4J_WORLD_PASSWORD;

    // registerAs() wraps the factory — invoking it directly (as ConfigModule
    // does internally) must throw naming the missing var.
    expect(() => neo4jConfig()).toThrow('NEO4J_WORLD_PASSWORD');
  });

  it('neo4jConfig() succeeds and returns real values when everything is set', () => {
    setAllRequired();
    const config = neo4jConfig();
    expect(config.world.password).toBe('test-neo4j_world_password');
  });

  it('timescaleConfig() throws naming the missing var', () => {
    setAllRequired();
    delete process.env.TIMESCALE_USER;
    expect(() => timescaleConfig()).toThrow('TIMESCALE_USER');
  });

  it('postgresConfig() throws naming the missing var', () => {
    setAllRequired();
    delete process.env.POSTGRES_RUNTIME_PASSWORD;
    expect(() => postgresConfig()).toThrow('POSTGRES_RUNTIME_PASSWORD');
  });

  it('postgresConfig() leaves the deliberately-optional guardian credentials unasserted (fail CLOSED elsewhere, not a boot crash)', () => {
    setAllRequired();
    delete process.env.POSTGRES_GUARDIAN_USER;
    delete process.env.POSTGRES_GUARDIAN_PASSWORD;
    const config = postgresConfig();
    expect(config.guardianUser).toBeUndefined();
    expect(config.guardianPassword).toBeUndefined();
  });
});

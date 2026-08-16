/**
 * Postgres connection config resolution for the standalone drive-server.
 *
 * Extracted to its own module (TK-138) so the POSTGRES_DB default can be
 * unit-tested without triggering main.ts's import-time side effects
 * (spinning up the WebSocket server and engine).
 *
 * Previously the default fell back to 'sylphie' — the real database name
 * used everywhere else in the repo (drive-engine.module.ts, docker-compose.yml,
 * .env.example) is 'sylphie_system'. With no POSTGRES_DB env var set, the
 * drive-server would attempt to connect to a database that does not exist.
 */

export interface ResolvedPostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** The real default database name (matches docker-compose.yml / .env.example). */
export const DEFAULT_POSTGRES_DB = 'sylphie_system';

export function resolvePostgresConfig(env: NodeJS.ProcessEnv = process.env): ResolvedPostgresConfig {
  return {
    host: env.POSTGRES_HOST || 'localhost',
    port: parseInt(env.POSTGRES_PORT || '5432', 10),
    database: env.POSTGRES_DB || DEFAULT_POSTGRES_DB,
    user: env.POSTGRES_RUNTIME_USER || env.POSTGRES_USER || 'sylphie',
    password: env.POSTGRES_RUNTIME_PASSWORD || env.POSTGRES_PASSWORD || 'sylphie',
  };
}

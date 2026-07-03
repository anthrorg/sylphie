/**
 * Guardian pool factory — TK-155.
 *
 * Builds the privileged pg.Pool used ONLY for guardian rule write
 * transactions (GuardianRulesService.approveRule / rejectRule). It is
 * intentionally separate from POSTGRES_RUNTIME_POOL: TK-154 REVOKEs write
 * access to drive_rules / proposed_drive_rules from the `sylphie_app` role
 * (CANON Immutable Standard 6 — No Self-Modification of Evaluation). Only
 * the `guardian_admin` role, reachable exclusively through this pool, may
 * perform the promote/reject DML.
 *
 * Fail closed, not fail crash: if POSTGRES_GUARDIAN_USER/PASSWORD are unset
 * or blank, the app must still boot — reads and every other write path are
 * unaffected — but any attempt to USE the guardian pool must reject
 * immediately with a clear, typed error (GuardianCredentialsNotConfiguredError)
 * rather than a confusing pg authentication failure or a hung connection
 * attempt against a role that was never given credentials.
 */

import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { GuardianCredentialsNotConfiguredError } from '@sylphie/shared';

const logger = new Logger('GuardianPoolProvider');

export interface GuardianPoolOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string | undefined;
  readonly password: string | undefined;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
}

/**
 * Builds the guardian-write pool.
 *
 * @returns A real `pg.Pool` connected as `guardian_admin` when both
 *   `user` and `password` are present, or an unconfigured stand-in whose
 *   `query()`/`connect()` calls reject with
 *   {@link GuardianCredentialsNotConfiguredError} when either is missing.
 *
 * Never throws synchronously — safe to call from a NestJS factory provider
 * during module initialization (no boot-time crash on missing creds).
 */
export function createGuardianPool(opts: GuardianPoolOptions): Pool {
  if (!opts.user || !opts.password) {
    return createUnconfiguredGuardianPool();
  }

  return new Pool({
    host: opts.host,
    port: opts.port,
    database: opts.database,
    user: opts.user,
    password: opts.password,
    max: opts.max ?? 2,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5000,
  });
}

/**
 * A Pool-shaped stand-in that never opens a socket. Every entry point
 * GuardianRulesService reaches (`query`, `connect`) rejects with a typed,
 * actionable error. This is what makes the guardian write path fail CLOSED
 * rather than silently falling back to another pool or hanging against
 * misconfigured credentials.
 */
function createUnconfiguredGuardianPool(): Pool {
  // Boot-time signal (LOW finding, TK-155 review): without this, the first
  // sign of a misconfigured deploy is a rejected write at use time — proposals
  // would quietly queue as pending with no explanation. This is a WARN, not a
  // crash: the app must still boot and reads must still work.
  logger.warn(
    'guardian pool unconfigured — approve/reject disabled until ' +
      'POSTGRES_GUARDIAN_USER/POSTGRES_GUARDIAN_PASSWORD are set',
  );

  const rejectUnconfigured = (): Promise<never> =>
    Promise.reject(
      new GuardianCredentialsNotConfiguredError(
        'POSTGRES_GUARDIAN_USER/POSTGRES_GUARDIAN_PASSWORD are unset — guardian rule writes are disabled until configured',
      ),
    );

  return {
    query: rejectUnconfigured,
    connect: rejectUnconfigured,
    end: () => Promise.resolve(),
    on: () => undefined,
  } as unknown as Pool;
}

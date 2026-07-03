/**
 * TK-155 — guardian-pool.provider unit tests.
 *
 * Verifies:
 *   AC1 support — when guardian credentials ARE configured, createGuardianPool
 *     returns a real pg.Pool (so the wired provider actually reaches
 *     guardian_admin once TK-154's role/grants exist).
 *   AC2 — when guardian credentials are unset/blank, createGuardianPool does
 *     NOT throw synchronously (no boot-time crash) and returns a stand-in
 *     whose query()/connect() reject with a clear
 *     "guardian credentials not configured" error (fail CLOSED).
 *
 * Never opens a real socket: the "configured" case only asserts the returned
 * value is a live pg.Pool instance and immediately calls .end() without ever
 * invoking .query()/.connect() (pg pools are lazy — construction alone does
 * not connect).
 */

import { Pool } from 'pg';
import { createGuardianPool } from './guardian-pool.provider';
import { GuardianCredentialsNotConfiguredError } from '@sylphie/shared';

describe('createGuardianPool', () => {
  const baseOpts = {
    host: 'localhost',
    port: 5434,
    database: 'sylphie_system',
  };

  afterEach(async () => {
    jest.restoreAllMocks();
  });

  it('returns a real pg.Pool when guardian user + password are configured', async () => {
    const pool = createGuardianPool({
      ...baseOpts,
      user: 'guardian_admin',
      password: 'a-real-secret',
    });

    expect(pool).toBeInstanceOf(Pool);

    // No query/connect was ever called — safe to tear down without a live DB.
    await pool.end();
  });

  it('does NOT throw synchronously when user + password are both unset', () => {
    expect(() =>
      createGuardianPool({ ...baseOpts, user: undefined, password: undefined }),
    ).not.toThrow();
  });

  it('does NOT throw synchronously when only the password is missing', () => {
    expect(() =>
      createGuardianPool({ ...baseOpts, user: 'guardian_admin', password: undefined }),
    ).not.toThrow();
  });

  it('does NOT throw synchronously when only the user is missing', () => {
    expect(() =>
      createGuardianPool({ ...baseOpts, user: undefined, password: 'a-real-secret' }),
    ).not.toThrow();
  });

  it('fails CLOSED: .query() rejects with GuardianCredentialsNotConfiguredError when unconfigured', async () => {
    const pool = createGuardianPool({ ...baseOpts, user: undefined, password: undefined });

    await expect(pool.query('SELECT 1')).rejects.toBeInstanceOf(
      GuardianCredentialsNotConfiguredError,
    );
    await expect(pool.query('SELECT 1')).rejects.toThrow(
      /guardian credentials not configured/i,
    );
  });

  it('fails CLOSED: .connect() rejects with GuardianCredentialsNotConfiguredError when unconfigured', async () => {
    const pool = createGuardianPool({ ...baseOpts, user: '', password: '' });

    await expect(pool.connect()).rejects.toBeInstanceOf(
      GuardianCredentialsNotConfiguredError,
    );
  });

  it('unconfigured stand-in .end() resolves without attempting any network I/O', async () => {
    const pool = createGuardianPool({ ...baseOpts, user: undefined, password: undefined });
    await expect(pool.end()).resolves.toBeUndefined();
  });
});

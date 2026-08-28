/**
 * TK-150 (item 20260702-005) — Prisma DSN URL-escaping.
 *
 * AC: given a DSN with a special-character password and a missing env var,
 * when the client connects / env is read, then the special-char password
 * DSN connects (i.e. the URL is built correctly), and a missing env fails
 * loud (not !-masked). This spec covers the DSN-escaping half;
 * database.config.spec.ts covers the fail-loud env half.
 */

import { buildPostgresUrl } from './prisma.service';

describe('buildPostgresUrl', () => {
  it('URL-escapes a password containing structurally-significant characters', () => {
    const url = buildPostgresUrl({
      runtimeUser: 'sylphie_app',
      runtimePassword: 'p@ss:w/ord#1%',
      host: 'localhost',
      port: 5434,
      database: 'sylphie_system',
    });

    // The unescaped password would inject an extra `@` (breaking the
    // authority/host split), `/` (breaking the path split), `:` (breaking
    // the user/password split), and `#` (introducing a bogus fragment).
    expect(url).toBe(
      'postgresql://sylphie_app:p%40ss%3Aw%2Ford%231%25@localhost:5434/sylphie_system',
    );

    // Round-trip through the URL parser to prove it's now a single,
    // correctly-bounded host/port/database — not a URL an unescaped
    // password would have silently mis-split.
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('localhost');
    expect(parsed.port).toBe('5434');
    expect(parsed.pathname).toBe('/sylphie_system');
    expect(decodeURIComponent(parsed.password)).toBe('p@ss:w/ord#1%');
  });

  it('escapes a username containing special characters too', () => {
    const url = buildPostgresUrl({
      runtimeUser: 'user@name',
      runtimePassword: 'plainpassword',
      host: 'db.internal',
      port: 5432,
      database: 'sylphie_system',
    });
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.username)).toBe('user@name');
    expect(parsed.hostname).toBe('db.internal');
  });

  it('produces a plain, unmodified URL for credentials with no special characters', () => {
    const url = buildPostgresUrl({
      runtimeUser: 'sylphie_app',
      runtimePassword: 'plainpassword',
      host: 'localhost',
      port: 5434,
      database: 'sylphie_system',
    });
    expect(url).toBe('postgresql://sylphie_app:plainpassword@localhost:5434/sylphie_system');
  });
});

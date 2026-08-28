/**
 * TK-151 (item 20260702-005) — withTransaction ROLLBACK must propagate the
 * ORIGINAL error, not the rollback error.
 *
 * AC: given a transaction that fails and triggers ROLLBACK, when the
 * rollback itself also errors, then withTransaction propagates the
 * original error, not the rollback error.
 */

import { TimescaleService } from './timescale.service';

// Minimal ConfigService stub — only `.get('timescale')` is exercised by the
// constructor's Pool setup.
function makeConfigService() {
  return {
    get: (key: string) => {
      if (key === 'timescale') {
        return {
          host: 'localhost',
          port: 5433,
          database: 'sylphie_events_test',
          user: 'test',
          password: 'test',
          maxConnections: 1,
          idleTimeoutMs: 1000,
          connectionTimeoutMs: 1000,
        };
      }
      return undefined;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeClient(queryImpl: (sql: string) => Promise<unknown>) {
  return {
    query: jest.fn(queryImpl),
    release: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('TimescaleService.withTransaction', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('propagates the ORIGINAL error when ROLLBACK itself also fails', async () => {
    const originalError = new Error('original failure inside the transaction');
    const rollbackError = new Error('connection dropped during ROLLBACK');

    const client = makeClient(async (sql: string) => {
      if (sql === 'BEGIN') return undefined;
      if (sql === 'ROLLBACK') throw rollbackError;
      return undefined;
    });

    const service = new TimescaleService(makeConfigService());
    // `pool` is TS-private (compile-time only) — swap it for a fake pool
    // whose connect() hands back our scripted mock client.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).pool = { connect: jest.fn().mockResolvedValue(client) };

    await expect(
      service.withTransaction(async () => {
        throw originalError;
      }),
    ).rejects.toBe(originalError);

    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('propagates the original error normally when ROLLBACK succeeds', async () => {
    const originalError = new Error('the real failure');
    const client = makeClient(async () => undefined);

    const service = new TimescaleService(makeConfigService());
    // `pool` is TS-private (compile-time only) — swap it for a fake pool
    // whose connect() hands back our scripted mock client.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).pool = { connect: jest.fn().mockResolvedValue(client) };

    await expect(
      service.withTransaction(async () => {
        throw originalError;
      }),
    ).rejects.toBe(originalError);
  });

  it('commits and returns the result on success (no rollback at all)', async () => {
    const client = makeClient(async () => undefined);
    const service = new TimescaleService(makeConfigService());
    // `pool` is TS-private (compile-time only) — swap it for a fake pool
    // whose connect() hands back our scripted mock client.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).pool = { connect: jest.fn().mockResolvedValue(client) };

    const result = await service.withTransaction(async () => 'ok');
    expect(result).toBe('ok');
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
  });
});

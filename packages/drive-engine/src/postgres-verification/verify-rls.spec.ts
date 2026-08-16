/**
 * Unit tests for RlsVerificationService.onModuleInit() — TK-129.
 *
 * RlsVerificationService is now registered in DriveEngineModule's providers
 * (previously registered in no module, so OnModuleInit never ran). These
 * tests exercise its abort-on-misconfig / proceed-on-correct behavior
 * directly against a mocked Postgres pool.
 */

import { RlsVerificationService } from './verify-rls';

function permissionDeniedError(): Error {
  return new Error('permission denied for table drive_rules');
}

/** A mock pg Pool whose connect() hands out a fresh mock client each call. */
function makeMockPool(clientFactories: Array<() => { query: jest.Mock; release: jest.Mock }>) {
  let call = 0;
  return {
    connect: jest.fn(async () => {
      const factory = clientFactories[call] ?? clientFactories[clientFactories.length - 1];
      call++;
      return factory();
    }),
  } as any;
}

describe('RlsVerificationService.onModuleInit', () => {
  it('proceeds (does not throw) when RLS is correctly enforced', async () => {
    // Check 1: UPDATE denied. Check 2: DELETE denied. Check 3: SELECT ok.
    // Check 4: INSERT ok (BEGIN; INSERT; ROLLBACK).
    const pool = makeMockPool([
      () => ({ query: jest.fn().mockRejectedValue(permissionDeniedError()), release: jest.fn() }),
      () => ({ query: jest.fn().mockRejectedValue(permissionDeniedError()), release: jest.fn() }),
      () => ({ query: jest.fn().mockResolvedValue({ rows: [{ count: '0' }] }), release: jest.fn() }),
      () => ({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }),
    ]);

    const service = new RlsVerificationService(pool);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('ABORTS (throws) when RLS is misconfigured — sylphie_app can UPDATE drive_rules', async () => {
    // Check 1: UPDATE succeeds (should have been denied) — RLS is broken.
    const pool = makeMockPool([
      () => ({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }),
    ]);

    const service = new RlsVerificationService(pool);
    await expect(service.onModuleInit()).rejects.toThrow(/RLS FAILURE/i);
  });

  it('ABORTS (throws) when sylphie_app can DELETE drive_rules', async () => {
    const pool = makeMockPool([
      () => ({ query: jest.fn().mockRejectedValue(permissionDeniedError()), release: jest.fn() }),
      () => ({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }),
    ]);

    const service = new RlsVerificationService(pool);
    await expect(service.onModuleInit()).rejects.toThrow(/RLS FAILURE/i);
  });

  it('does not abort (warns) when tables do not exist yet (pre-migration dev state)', async () => {
    const pool = makeMockPool([
      () => ({
        query: jest.fn().mockRejectedValue(new Error('relation "drive_rules" does not exist')),
        release: jest.fn(),
      }),
    ]);

    const service = new RlsVerificationService(pool);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('does not abort (warns) when Postgres is unreachable in dev', async () => {
    const pool = makeMockPool([
      () => ({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5432')), release: jest.fn() }),
    ]);

    const service = new RlsVerificationService(pool);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('DriveEngineModule registration (TK-129)', () => {
  it('registers RlsVerificationService as a provider', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DriveEngineModule } = require('../drive-engine.module');
    const metadata = Reflect.getMetadata('providers', DriveEngineModule) as unknown[];
    expect(metadata).toBeDefined();
    expect(metadata).toContain(RlsVerificationService);
  });
});

/**
 * TK-95 — Neo4j [other] / OKG connectivity unit tests.
 *
 * Root cause (AC1): the Neo4j driver was constructed without logging the URI
 * or validating required env vars. A missing / wrong NEO4J_OTHER_URI produces
 * the "Neo4j 4.0 default-encryption change" error because `bolt://` URIs on
 * Railway's private networking (plain-text Bolt port 7687) fail when the driver
 * silently attempts TLS. The fix:
 *
 *   1. Log the URI scheme+host at driver creation time (diagnostic evidence in
 *      boot logs — AC1 evidence surface).
 *   2. Log a clear error when URI/user/password are missing (vs. confusing
 *      driver error message — AC1 "cause RECORDED" requirement).
 *   3. Explicitly set `encrypted: false` for bolt:// / neo4j:// URIs to prevent
 *      the TLS-on-plain-text connection failure (root fix — AC2 + AC3).
 *
 * These tests cover the driver-construction logic using a fake neo4j module;
 * no live Neo4j connection is required.
 *
 * AC references:
 *   AC1 — cause recorded as app-side URI/encryption/env before fix
 *   AC2 — GET /api/graph/okg/count returns 200 (requires live Neo4j; tested
 *          manually post-deploy per AC1 evidence guide)
 *   AC3 — no 'Failed to connect to Neo4j [other]' in deployment logs (requires
 *          live deploy; the encrypted:false fix and URI logging are the mechanism)
 */

import { Neo4jInstanceName } from './neo4j.constants';
import { Neo4jService } from './neo4j.service';

// ---------------------------------------------------------------------------
// Fake neo4j-driver module — intercepts neo4j.driver() calls so we can
// assert on the config options passed to the driver constructor.
// ---------------------------------------------------------------------------

interface CapturedDriverCall {
  uri: string;
  authToken: { scheme: string; principal: string };
  config: Record<string, unknown>;
}

const capturedDriverCalls: CapturedDriverCall[] = [];
let fakeVerifyConnectivityShouldFail = false;

// Replace the neo4j-driver module import inside Neo4jService with a fake.
// neo4j-driver exports a default object (`import neo4j from 'neo4j-driver'`);
// jest.mock must return an object with a `default` key AND set __esModule:true
// so the import interop resolves correctly.
jest.mock('neo4j-driver', () => {
  const fakeDriver = {
    verifyConnectivity: jest.fn().mockImplementation(async () => {
      if (fakeVerifyConnectivityShouldFail) {
        throw new Error('ServiceUnavailable: could not connect');
      }
    }),
    session: jest.fn().mockReturnValue({ close: jest.fn(), run: jest.fn() }),
    close: jest.fn().mockResolvedValue(undefined),
  };

  const neo4jMock = {
    __esModule: true,
    default: {
      driver: jest.fn(
        (uri: string, auth: Record<string, unknown>, config: Record<string, unknown>) => {
          capturedDriverCalls.push({ uri, authToken: auth as CapturedDriverCall['authToken'], config });
          return fakeDriver;
        },
      ),
      auth: {
        basic: jest.fn((user: string, pass: string) => ({ scheme: 'basic', principal: user, credentials: pass })),
      },
      session: {
        READ: 'READ',
        WRITE: 'WRITE',
      },
    },
  };
  // Make neo4jMock.default also callable as the top-level module for CJS interop
  return neo4jMock;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_URI = 'bolt://neo4j-other.railway.internal:7687';
const DEFAULT_USER = 'neo4j';
const DEFAULT_PASSWORD = 'secret';

function makeConfig(overrides: {
  uri?: string | null;
  user?: string | null;
  password?: string | null;
  database?: string;
} = {}): Parameters<typeof Neo4jService.prototype['constructor']>[0] {
  // Use explicit null/undefined to test missing-value paths without ?? defaults
  const uri = 'uri' in overrides ? (overrides.uri as string) : DEFAULT_URI;
  const user = 'user' in overrides ? (overrides.user as string) : DEFAULT_USER;
  const password = 'password' in overrides ? (overrides.password as string) : DEFAULT_PASSWORD;
  return {
    instances: [
      {
        name: Neo4jInstanceName.OTHER,
        uri,
        user,
        password,
        database: overrides.database ?? 'neo4j',
        maxConnectionPoolSize: 50,
        connectionTimeoutMs: 5000,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Neo4jService — TK-95 URI/encryption/env fixes', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    capturedDriverCalls.length = 0;
    fakeVerifyConnectivityShouldFail = false;
    // Spy on Logger output via the prototype (NestJS Logger)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Logger } = require('@nestjs/common');
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── AC1: root cause recorded ──────────────────────────────────────────────

  it('AC1a: logs URI scheme+host at driver creation for each configured instance', () => {
    new Neo4jService(makeConfig({ uri: 'bolt://neo4j-other.railway.internal:7687' }));

    // The log message must include the scheme and host so boot logs show what
    // is being attempted — the primary diagnostic surface for this bug.
    const logMessages = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const uriLog = logMessages.find((m) => m.includes('neo4j-other.railway.internal'));
    expect(uriLog).toBeDefined();
    expect(uriLog).toContain('bolt:');
    expect(uriLog).toContain('[other]');
  });

  it('AC1b: logs a clear error when NEO4J_OTHER_URI is missing (undefined)', () => {
    new Neo4jService(makeConfig({ uri: null }));

    // NestJS Logger.error is called as logger.error(message, ...optionalParams).
    // The spy is on Logger.prototype.error; first arg is the message string.
    const errorMessages = errorSpy.mock.calls.map(
      (args: unknown[]) => String(args[0]),
    );
    const missingLog = errorMessages.find((m) =>
      m.includes('[other]') && m.includes('misconfigured'),
    );
    // Debug: if not found, print what was logged
    if (!missingLog) {
      throw new Error(
        `Expected error log about missing NEO4J_OTHER_URI but got:\n` +
          `  error calls: ${JSON.stringify(errorSpy.mock.calls)}\n` +
          `  log calls: ${JSON.stringify(logSpy.mock.calls.slice(0, 3))}`,
      );
    }
    // Must name the missing field so the operator knows exactly what to set
    expect(missingLog).toContain('(missing)');
    expect(missingLog).toContain('NEO4J_OTHER_URI');
  });

  it('AC1c: logs a clear error when NEO4J_OTHER_PASSWORD is missing (undefined)', () => {
    new Neo4jService(makeConfig({ password: null }));

    const errorMessages = errorSpy.mock.calls.map(
      (args: unknown[]) => String(args[0]),
    );
    const missingLog = errorMessages.find((m) =>
      m.includes('[other]') && m.includes('misconfigured'),
    );
    if (!missingLog) {
      throw new Error(
        `Expected error log about missing password but got:\n` +
          `  error calls: ${JSON.stringify(errorSpy.mock.calls)}`,
      );
    }
    expect(missingLog).toContain('(missing)');
  });

  it('AC1d: logs a clear error when NEO4J_OTHER_USER is missing (undefined)', () => {
    new Neo4jService(makeConfig({ user: null }));

    const errorMessages = errorSpy.mock.calls.map(
      (args: unknown[]) => String(args[0]),
    );
    const missingLog = errorMessages.find((m) =>
      m.includes('[other]') && m.includes('misconfigured'),
    );
    if (!missingLog) {
      throw new Error(
        `Expected error log about missing user but got:\n` +
          `  error calls: ${JSON.stringify(errorSpy.mock.calls)}`,
      );
    }
    expect(missingLog).toContain('(missing)');
  });

  // ── AC2/AC3: encryption fix — the root cause of the connect failure ───────

  it('AC2/3a: driver constructed with encrypted:false for bolt:// URI (Railway plain-text Bolt)', () => {
    new Neo4jService(makeConfig({ uri: 'bolt://neo4j-other.railway.internal:7687' }));

    expect(capturedDriverCalls).toHaveLength(1);
    const config = capturedDriverCalls[0].config;
    // encrypted:false prevents the driver from attempting TLS on a plain-text
    // Bolt port — this is the root fix for the "Neo4j 4.0 encryption change" error.
    expect(config.encrypted).toBe(false);
  });

  it('AC2/3b: driver constructed with encrypted:false for neo4j:// URI', () => {
    new Neo4jService(makeConfig({ uri: 'neo4j://neo4j-other.railway.internal:7687' }));

    expect(capturedDriverCalls).toHaveLength(1);
    expect(capturedDriverCalls[0].config.encrypted).toBe(false);
  });

  it('AC2/3c: encrypted flag is NOT forcibly set to false for bolt+s:// (TLS-signaling URI)', () => {
    // bolt+s:// is the correct URI for encrypted endpoints; the fix must not
    // override the driver's TLS-from-URI behavior for encrypted schemes.
    new Neo4jService(makeConfig({ uri: 'bolt+s://neo4j-other.railway.internal:7687' }));

    expect(capturedDriverCalls).toHaveLength(1);
    // The config spread only applies encrypted:false for plain-text schemes.
    expect(capturedDriverCalls[0].config.encrypted).toBeUndefined();
  });

  it('AC2/3d: pool size and timeout are forwarded to the driver config', () => {
    new Neo4jService(makeConfig());

    expect(capturedDriverCalls[0].config.maxConnectionPoolSize).toBe(50);
    expect(capturedDriverCalls[0].config.connectionTimeout).toBe(5000);
  });

  // ── AC3: onModuleInit failure log includes URI ────────────────────────────

  it('AC3a: onModuleInit error log includes the URI when connection fails', async () => {
    fakeVerifyConnectivityShouldFail = true;
    const service = new Neo4jService(
      makeConfig({ uri: 'bolt://neo4j-other.railway.internal:7687' }),
    );

    await service.onModuleInit();

    // The error message must include the URI summary so the operator can see
    // exactly what connection was attempted without searching env var dumps.
    const errorMessages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const connectError = errorMessages.find((m) =>
      m.includes('Failed to connect to Neo4j') && m.includes('[other]'),
    );
    expect(connectError).toBeDefined();
    expect(connectError).toContain('neo4j-other.railway.internal');
    // Must also give actionable remediation hint
    expect(connectError).toContain('NEO4J_OTHER_URI');
    expect(connectError).toContain('bolt://');
    // Retries default to 5 attempts × 3s each = up to 15s; use longer timeout.
  }, 30000 /* ms */);
});

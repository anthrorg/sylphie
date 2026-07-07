/**
 * TK-112 — qualify e1.payload in meanDriveResolutionTimes; surface query errors.
 *
 * Direct-instantiation unit test (repo convention). computeMeanDriveResolutionTimes
 * is private; exercised via bracket-notation call, same pattern used elsewhere in
 * this codebase for private-method unit tests.
 */

import { MetricsController } from './metrics.controller';

/** Postgres-shaped error the real driver raises for an unqualified ambiguous column. */
class AmbiguousColumnError extends Error {
  code = '42702';
  constructor() {
    super('column reference "payload" is ambiguous');
  }
}

/**
 * A tiny query-text-aware TimescaleDB stub that models the ONE Postgres rule
 * this ticket's bug/fix hinges on: a `payload->>'drive'` reference not
 * qualified by a table alias is ambiguous whenever both `e1` and `e2` are in
 * scope (a self-join on `events`, exactly the shape this query uses) and
 * Postgres raises 42702. This is a modeled proxy for that behavior — this
 * environment has no live Postgres to assert the real driver against — but
 * it encodes the exact mechanical rule being fixed, so it faithfully
 * discriminates the qualified (fixed) query from the unqualified (buggy) one.
 */
function makeTimescaleStub(rows: Array<{ drive: string; mean_ms: string; sample_count: string }>) {
  return {
    query: jest.fn(async (sql: string) => {
      const bareAmbiguousRef = /(?<!e1\.|e2\.)payload->>'drive'/;
      if (bareAmbiguousRef.test(sql)) {
        throw new AmbiguousColumnError();
      }
      return { rows };
    }),
  };
}

function makeController(timescale: { query: jest.Mock }) {
  const noop = {} as any;
  return new MetricsController(
    noop, // ARBITRATION_SERVICE
    noop, // ATTRACTOR_MONITOR_SERVICE
    noop, // DRIVE_STATE_READER
    noop, // Neo4jService
    timescale as any, // TimescaleService
    noop, // LatentSpaceService
    noop, // PersonModelService
    noop, // ModalityRegistryService
    noop, // WkgContextService
    noop, // LEARNING_SERVICE
    noop, // EPISODIC_MEMORY_SERVICE
    noop, // ScenePredictionService
    noop, // VisualWorkingMemoryService
    noop, // PerceptionGateway
    noop, // VisualPresenceHabituatorService
  );
}

// The pre-fix query text (kept here only as a literal control input for the
// stub's ambiguity check below — not re-introduced into production source).
const UNFIXED_QUERY_FRAGMENT = `SELECT
   payload->>'drive' AS drive,
   AVG(EXTRACT(EPOCH FROM (e2.timestamp - e1.timestamp)) * 1000) AS mean_ms,
   COUNT(*) AS sample_count
 FROM events e1
 JOIN events e2 ON e2.session_id = e1.session_id
 GROUP BY payload->>'drive'`;

describe('MetricsController.computeMeanDriveResolutionTimes (TK-112)', () => {
  const seededRows = [{ drive: 'curiosity', mean_ms: '4200.5', sample_count: '7' }];

  it('AC1: >=5 seeded pairs against the FIXED (qualified) query returns a numeric entry, not {}', async () => {
    const timescale = makeTimescaleStub(seededRows);
    const controller = makeController(timescale);

    const result = await (controller as any).computeMeanDriveResolutionTimes(new Date());

    expect(result).not.toEqual({});
    expect(result.curiosity).toMatchObject({ drive: 'curiosity', sampleCount: 7 });
    expect(result.curiosity.meanMs).toBeCloseTo(4200.5);
    // Confirm the actual production SQL text is qualified (drives AC1's pass
    // off the real fix, not an accidentally-lenient stub).
    const [sqlUsed] = timescale.query.mock.calls[0];
    expect(sqlUsed).toMatch(/e1\.payload->>'drive'/);
    expect(sqlUsed).toMatch(/GROUP BY\s+e1\.payload->>'drive'/);
  });

  it('control: the SAME seed shape against the UNFIXED (unqualified) query throws 42702, proving AC1 discriminates on the SQL fix, not sample volume', async () => {
    const timescale = makeTimescaleStub(seededRows);

    await expect(timescale.query(UNFIXED_QUERY_FRAGMENT)).rejects.toMatchObject({ code: '42702' });
  });

  it('surfaces a non-ambiguous-column failure (e.g. a stubbed connection error) instead of silently returning {}', async () => {
    const timescale = { query: jest.fn().mockRejectedValue(new Error('connection terminated unexpectedly')) };
    const controller = makeController(timescale);

    await expect((controller as any).computeMeanDriveResolutionTimes(new Date())).rejects.toThrow(
      'connection terminated unexpectedly',
    );
  });
});

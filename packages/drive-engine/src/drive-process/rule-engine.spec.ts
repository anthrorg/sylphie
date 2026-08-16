/**
 * Unit tests for RuleEngine.reloadRules() surfacing failures — TK-139.
 *
 * Previously reloadRules() caught every error, logged to stderr, and
 * swallowed it — initialize()'s own docstring promised "@throws Error if
 * the initial rule load fails" but that never happened; a broken initial
 * load still resulted in "Rule engine initialized" logging with 0 rules.
 */

import { RuleEngine } from './rule-engine';

function makeFailingPool() {
  return {
    query: jest.fn().mockRejectedValue(new Error('connection refused')),
  } as any;
}

function makeWorkingPool(rows: any[] = []) {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
  } as any;
}

describe('RuleEngine — reloadRules failure surfaces instead of being swallowed', () => {
  it('initialize() rejects when the initial rule load fails', async () => {
    const engine = new RuleEngine();
    const pool = makeFailingPool();
    await expect(engine.initialize(pool)).rejects.toThrow(/connection refused/);
  });

  it('initialize() resolves normally when the initial rule load succeeds', async () => {
    const engine = new RuleEngine();
    const pool = makeWorkingPool([]);
    await expect(engine.initialize(pool)).resolves.toBeUndefined();
    engine.shutdown();
  });

  it('a forced reload failure throws (does not silently swallow) when called directly', async () => {
    const engine = new RuleEngine();
    const pool = makeWorkingPool([]);
    await engine.initialize(pool);
    engine.shutdown();

    // Force a subsequent reload failure and call the private reloadRules
    // directly (bypassing the periodic timer's own try/catch) to prove the
    // method itself throws rather than swallowing.
    (pool.query as jest.Mock).mockRejectedValueOnce(new Error('forced reload failure'));
    await expect((engine as any).reloadRules()).rejects.toThrow(/forced reload failure/);
  });
});

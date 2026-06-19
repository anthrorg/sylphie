/**
 * FastFactWriterService — unit tests for TK-34 (EP7-D).
 *
 * Verifies:
 *   AC1 — The extracted methods compile and run (build gate is the harder check
 *          but this file exercises the routing logic without Neo4j/WKG live deps).
 *   AC2 — Given a guardian utterance "My name is Jim", writeFastFacts routes the
 *          speaker fact to personModel.writeFact with isGuardian=true — same
 *          provenance tier as before extraction.
 *
 * Runs with Jest via: yarn workspace @sylphie/app test
 */

import { FastFactWriterService } from './fast-fact-writer.service';
import type { ExtractedFact } from './person-model.service';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makePersonModelStub() {
  return {
    writeFact: jest.fn().mockResolvedValue(undefined),
  };
}

function makeNeo4jStub() {
  const sessionStub = {
    run: jest.fn().mockResolvedValue({ records: [] }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    getSession: jest.fn().mockReturnValue(sessionStub),
    _sessionStub: sessionStub,
  };
}

function makeWkgDiffStub() {
  return {
    captureWkgSnapshot: jest.fn().mockResolvedValue({ nodeCount: 0, nodes: {} }),
    computeInformationGain: jest.fn().mockReturnValue({
      source: 'WKG_DIFF',
      newNodeCount: 0,
      deltaNodeCount: 0,
      attributedActionId: null,
    }),
  };
}

function makeOutcomeReporterStub() {
  return {
    reportOutcome: jest.fn(),
  };
}

function buildService(overrides?: { personModel?: ReturnType<typeof makePersonModelStub> }) {
  const personModel = overrides?.personModel ?? makePersonModelStub();
  const neo4j = makeNeo4jStub();
  const wkgDiff = makeWkgDiffStub();
  const outcomeReporter = makeOutcomeReporterStub();

  const service = new FastFactWriterService(
    neo4j as any,
    wkgDiff as any,
    outcomeReporter as any,
    personModel as any,
  );

  return { service, personModel, neo4j, wkgDiff, outcomeReporter };
}

// ---------------------------------------------------------------------------
// AC2 — provenance tier unchanged after extraction
// ---------------------------------------------------------------------------

describe('FastFactWriterService.writeFastFacts — speaker fact routing', () => {
  it('routes a guardian speaker-fact to personModel.writeFact with isGuardian=true', async () => {
    // Simulates: parseInput("My name is Jim", ..., userId="guardian", isGuardian=true)
    // extractFactsFromText returns [{ key:"name", value:"Jim", target:"speaker", ... }]
    const { service, personModel } = buildService();

    const facts: ExtractedFact[] = [
      {
        key: 'name',
        value: 'Jim',
        source: 'self_reported',
        rawText: 'My name is Jim',
        target: 'speaker',
      },
    ];

    await service.writeFastFacts('guardian', facts, true);

    // Must have called personModel.writeFact with the fact AND isGuardian=true
    // (GUARDIAN provenance tier — same as before TK-34 extraction).
    expect(personModel.writeFact).toHaveBeenCalledTimes(1);
    expect(personModel.writeFact).toHaveBeenCalledWith('guardian', facts[0], true);
  });

  it('routes a non-guardian speaker-fact to personModel.writeFact with isGuardian=false', async () => {
    const { service, personModel } = buildService();

    const facts: ExtractedFact[] = [
      {
        key: 'name',
        value: 'Alice',
        source: 'self_reported',
        rawText: 'My name is Alice',
        target: 'speaker',
      },
    ];

    await service.writeFastFacts('user-123', facts, false);

    expect(personModel.writeFact).toHaveBeenCalledWith('user-123', facts[0], false);
  });

  it('does NOT call personModel.writeFact for sylphie-targeted facts', async () => {
    const { service, personModel } = buildService();

    const facts: ExtractedFact[] = [
      {
        key: 'name',
        value: 'Sylphie',
        source: 'self_reported',
        rawText: 'Your name is Sylphie',
        target: 'sylphie',
      },
    ];

    await service.writeFastFacts('guardian', facts, true);

    // Sylphie facts go to Self KG + WKG — not the person model.
    expect(personModel.writeFact).not.toHaveBeenCalled();
  });

  it('handles mixed facts, routing each to the correct graph', async () => {
    const { service, personModel, neo4j } = buildService();

    const facts: ExtractedFact[] = [
      {
        key: 'name',
        value: 'Jim',
        source: 'self_reported',
        rawText: 'My name is Jim',
        target: 'speaker',
      },
      {
        key: 'name',
        value: 'Sylphie',
        source: 'self_reported',
        rawText: 'Your name is Sylphie',
        target: 'sylphie',
      },
    ];

    await service.writeFastFacts('guardian', facts, true);

    // Speaker fact → OKG
    expect(personModel.writeFact).toHaveBeenCalledTimes(1);
    expect(personModel.writeFact).toHaveBeenCalledWith('guardian', facts[0], true);

    // Sylphie fact → Self KG (SELF instance) + WKG (WORLD instance)
    // getSession is called once per write (Self KG) + once per write (WKG)
    expect(neo4j.getSession).toHaveBeenCalledTimes(2);
  });

  it('does not throw when personModel.writeFact rejects (graceful error handling)', async () => {
    const personModel = makePersonModelStub();
    personModel.writeFact.mockRejectedValue(new Error('neo4j down'));
    const { service } = buildService({ personModel });

    const facts: ExtractedFact[] = [
      {
        key: 'name',
        value: 'Jim',
        source: 'self_reported',
        rawText: 'My name is Jim',
        target: 'speaker',
      },
    ];

    // Should not throw — errors are caught and logged as warnings.
    await expect(service.writeFastFacts('guardian', facts, true)).resolves.toBeUndefined();
  });
});

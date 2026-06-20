/**
 * TK-54 — Dead-letter tracking unit tests.
 *
 * Acceptance criteria:
 *   AC1: Given a processEvent() that throws at any step, when the catch runs,
 *        a row {event_id, pipeline_step, error_message, retry_count=0, failed_at}
 *        is inserted; the event is still marked learned.
 *   AC2: Given the table DDL on a fresh DB, when applied, then created as a
 *        hypertable on failed_at; a simulated UpsertEntities throw yields one
 *        dead-letter row with the right step/error.
 *
 * Strategy: capture every SQL statement issued by UpdateWkgService and
 * LearningService using a fake TimescaleService. No live DB is needed.
 */

// ---------------------------------------------------------------------------
// Module stubs — keep the NestJS and shared import graphs from exploding.
//
// @nestjs/common: decorators are no-ops at runtime; we need enough symbols
// for UpdateWkgService and LearningService to be constructable.
// @nestjs/config: pulled in by @sylphie/shared's config barrel.
// @sylphie/shared: we only need verboseFor + TimescaleService; stub the rest
// so the database.config barrel (which imports @nestjs/config) never runs.
// ---------------------------------------------------------------------------

jest.mock('@nestjs/common', () => {
  const noop = () => () => {};
  return {
    Injectable: noop,
    Inject: noop,
    Optional: noop,
    Global: noop,
    Module: noop,
    OnModuleInit: noop,
    OnModuleDestroy: noop,
    Logger: class {
      log() {}
      debug() {}
      error() {}
      warn() {}
    },
  };
});

jest.mock('@nestjs/config', () => ({
  ConfigService: class {},
  registerAs: (_token: string, fn: () => unknown) => fn,
}));

// Stub @sylphie/shared to return only what UpdateWkgService needs.
// This prevents the barrel from importing database.config → @nestjs/config
// which requires the full NestJS runtime to be present.
jest.mock('@sylphie/shared', () => ({
  TimescaleService: class {},
  verboseFor: (_area: string) => (..._args: unknown[]) => {},
  // Add other symbols if more specs start using them.
}));

import { UpdateWkgService } from './update-wkg.service';
import { LearningService } from '../learning.service';
import type {
  IUpdateWkgService,
  IUpsertEntitiesService,
  IExtractTypedEdgesService,
  IExtractEdgesService,
  IConversationEntryService,
  ICanProduceEdgesService,
  IRefineEdgesService,
  IDetectContradictionsService,
  IConfidenceDecayService,
  IConversationReflectionService,
  ICrossSessionSynthesisService,
  ISelfModelWriterService,
  ILearningEventLogger,
  UnlearnedEvent,
  MaintenanceCycleResult,
  ReflectionResult,
  SynthesisCycleResult,
  DecayCycleResult,
  SelfModelCycleResult,
} from '../interfaces/learning.interfaces';

// ---------------------------------------------------------------------------
// Captured SQL helper
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

class CapturingTimescale {
  readonly queries: CapturedQuery[] = [];

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql: sql.trim(), params });
    return { rows: [] };
  }
}

// ---------------------------------------------------------------------------
// Minimal stub implementations for LearningService dependencies
// ---------------------------------------------------------------------------

/** A UpdateWkgService whose upsert throws but still captures SQL. */
function makeUpdateWkg(timescale: CapturingTimescale): IUpdateWkgService {
  const svc = new UpdateWkgService(timescale as unknown as never);
  return svc;
}

function makeThrowingUpsertEntities(errorMessage: string): IUpsertEntitiesService {
  return {
    async upsertEntities(_event: UnlearnedEvent) {
      throw new Error(errorMessage);
    },
  };
}

function makeNoopExtractTypedEdges(): IExtractTypedEdgesService {
  return {
    async extractTypedEdges() {
      return { edges: [], typedPairs: new Set() };
    },
  };
}

function makeNoopExtractEdges(): IExtractEdgesService {
  return {
    async extractEdges() {
      return [];
    },
  };
}

function makeNoopConversationEntry(): IConversationEntryService {
  return {
    async createEntry() {
      return '';
    },
  };
}

function makeNoopCanProduceEdges(): ICanProduceEdgesService {
  return {
    async createEdges() {
      return 0;
    },
  };
}

function makeNoopRefineEdges(): IRefineEdgesService {
  return {
    async refineEdges() {
      return 0;
    },
  };
}

function makeNoopDetectContradictions(): IDetectContradictionsService {
  return {
    async detectContradictions() {
      return 0;
    },
  };
}

function makeNoopConfidenceDecay(): IConfidenceDecayService {
  return {
    async runDecayCycle() {
      return { nodesDecayed: 0, edgesDecayed: 0, nodesPruned: 0, wasNoop: true };
    },
  };
}

function makeNoopConversationReflection(): IConversationReflectionService {
  return {
    async ensureSchema() {},
    async findReflectableSessions() { return []; },
    async reflectOnSession(): Promise<ReflectionResult> {
      return { sessionId: '', insightsCreated: 0, edgesCreated: 0, wasNoop: true };
    },
  };
}

function makeNoopCrossSessionSynthesis(): ICrossSessionSynthesisService {
  return {
    async ensureSchema() {},
    async findSynthesizablePairs() { return []; },
    async synthesizePair() {
      return { nodeId: null, sourceInsightIds: [], confidence: 0, patternFound: false };
    },
    async runSynthesisCycle(): Promise<SynthesisCycleResult> {
      return { pairsExamined: 0, synthesesCreated: 0, wasNoop: true };
    },
  };
}

function makeNoopSelfModelWriter(): ISelfModelWriterService {
  return {
    async runSelfModelCycle(): Promise<SelfModelCycleResult> {
      return { wrote: false, sampleCount: 0, successRate: null, confidence: null, wasNoop: true };
    },
  };
}

function makeNoopEventLogger(): ILearningEventLogger {
  return {
    log() {},
  };
}

// ---------------------------------------------------------------------------
// Test event builder
// ---------------------------------------------------------------------------

function makeEvent(id = 'evt-dead-1'): UnlearnedEvent {
  return {
    id,
    type: 'INPUT_RECEIVED',
    timestamp: new Date(),
    subsystem: 'communication',
    session_id: 'sess-1',
    payload: { content: 'Hello world' },
    schema_version: 1,
  };
}

// ---------------------------------------------------------------------------
// AC2 — DDL: ensureDeadLetterSchema() creates hypertable on failed_at
// ---------------------------------------------------------------------------

describe('TK-54 AC2 — UpdateWkgService.ensureDeadLetterSchema() DDL', () => {
  let timescale: CapturingTimescale;
  let svc: UpdateWkgService;

  beforeEach(async () => {
    timescale = new CapturingTimescale();
    svc = new UpdateWkgService(timescale as unknown as never);
    await svc.ensureDeadLetterSchema();
  });

  it('issues a CREATE TABLE IF NOT EXISTS for failed_learning_events', () => {
    const createTable = timescale.queries.find(
      (q) =>
        q.sql.includes('CREATE TABLE IF NOT EXISTS') &&
        q.sql.includes('failed_learning_events'),
    );
    expect(createTable).toBeDefined();
  });

  it('the CREATE TABLE includes event_id, pipeline_step, error_message columns', () => {
    const createTable = timescale.queries.find(
      (q) => q.sql.includes('failed_learning_events') && q.sql.includes('CREATE TABLE'),
    );
    expect(createTable!.sql).toContain('event_id');
    expect(createTable!.sql).toContain('pipeline_step');
    expect(createTable!.sql).toContain('error_message');
  });

  it('the CREATE TABLE includes retry_count with DEFAULT 0', () => {
    const createTable = timescale.queries.find(
      (q) => q.sql.includes('failed_learning_events') && q.sql.includes('CREATE TABLE'),
    );
    expect(createTable!.sql).toContain('retry_count');
    expect(createTable!.sql).toContain('DEFAULT 0');
  });

  it('the CREATE TABLE includes a failed_at TIMESTAMPTZ column', () => {
    const createTable = timescale.queries.find(
      (q) => q.sql.includes('failed_learning_events') && q.sql.includes('CREATE TABLE'),
    );
    expect(createTable!.sql).toContain('failed_at');
    expect(createTable!.sql).toContain('TIMESTAMPTZ');
  });

  it('calls create_hypertable on failed_at via a DO block', () => {
    const hypertable = timescale.queries.find(
      (q) => q.sql.includes('create_hypertable') && q.sql.includes('failed_learning_events'),
    );
    expect(hypertable).toBeDefined();
    expect(hypertable!.sql).toContain("'failed_at'");
  });

  it('the DO block is idempotent (wraps create_hypertable in IF NOT EXISTS guard)', () => {
    const hypertable = timescale.queries.find(
      (q) => q.sql.includes('create_hypertable') && q.sql.includes('failed_learning_events'),
    );
    // Guard uses hypertables catalog check — not a bare call.
    expect(hypertable!.sql).toContain('hypertables');
    expect(hypertable!.sql).toContain('hypertable_name');
  });
});

// ---------------------------------------------------------------------------
// AC1 — writeDeadLetter() inserts a row with the right shape
// ---------------------------------------------------------------------------

describe('TK-54 AC1a — UpdateWkgService.writeDeadLetter() INSERT', () => {
  let timescale: CapturingTimescale;
  let svc: UpdateWkgService;

  beforeEach(async () => {
    timescale = new CapturingTimescale();
    svc = new UpdateWkgService(timescale as unknown as never);
  });

  it('inserts a row into failed_learning_events', async () => {
    await svc.writeDeadLetter('evt-1', 'upsertEntities', 'Something blew up');

    const insert = timescale.queries.find(
      (q) => q.sql.includes('INSERT INTO failed_learning_events'),
    );
    expect(insert).toBeDefined();
  });

  it('passes event_id, pipeline_step, error_message as positional params', async () => {
    await svc.writeDeadLetter('evt-42', 'upsertEntities', 'UpsertEntities failed');

    const insert = timescale.queries.find(
      (q) => q.sql.includes('INSERT INTO failed_learning_events'),
    );
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe('evt-42');
    expect(insert!.params[1]).toBe('upsertEntities');
    expect(insert!.params[2]).toBe('UpsertEntities failed');
  });

  it('sets retry_count=0 in the SQL (not a param, uses literal 0)', async () => {
    await svc.writeDeadLetter('evt-1', 'upsertEntities', 'err');

    const insert = timescale.queries.find(
      (q) => q.sql.includes('INSERT INTO failed_learning_events'),
    );
    expect(insert!.sql).toContain('0');
  });

  it('uses NOW() for failed_at in the INSERT (not a param)', async () => {
    await svc.writeDeadLetter('evt-1', 'upsertEntities', 'err');

    const insert = timescale.queries.find(
      (q) => q.sql.includes('INSERT INTO failed_learning_events'),
    );
    expect(insert!.sql).toContain('NOW()');
  });

  it('swallows errors without rethrowing (dead-letter write must not cascade)', async () => {
    // Fake a timescale that throws on INSERT.
    const faultyTimescale = {
      async query<T>(sql: string): Promise<{ rows: T[] }> {
        if (sql.includes('INSERT INTO failed_learning_events')) {
          throw new Error('DB unavailable');
        }
        return { rows: [] };
      },
    };
    const faultySvc = new UpdateWkgService(faultyTimescale as unknown as never);

    // Should resolve without throwing.
    await expect(
      faultySvc.writeDeadLetter('evt-1', 'upsertEntities', 'err'),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC1 — End-to-end: LearningService.processEvent() catch block writes dead letter
// ---------------------------------------------------------------------------

describe('TK-54 AC1b — LearningService.processEvent() catch writes dead-letter row', () => {
  let timescale: CapturingTimescale;

  /**
   * Build a LearningService wired to a capturing TimescaleDB fake.
   * UpsertEntitiesService is replaced with a throwing stub so the catch block fires.
   */
  function makeService(errorMessage: string): LearningService {
    timescale = new CapturingTimescale();
    const updateWkg = makeUpdateWkg(timescale);

    // LearningService constructor takes concrete injected instances via @Inject tokens.
    // We construct it directly by casting so we bypass NestJS DI in tests,
    // exactly as the other spec files in this package do.
    return new LearningService(
      updateWkg as unknown as never,
      makeThrowingUpsertEntities(errorMessage) as unknown as never,
      makeNoopExtractTypedEdges() as unknown as never,
      makeNoopExtractEdges() as unknown as never,
      makeNoopConversationEntry() as unknown as never,
      makeNoopCanProduceEdges() as unknown as never,
      makeNoopRefineEdges() as unknown as never,
      makeNoopDetectContradictions() as unknown as never,
      makeNoopConfidenceDecay() as unknown as never,
      makeNoopConversationReflection() as unknown as never,
      makeNoopCrossSessionSynthesis() as unknown as never,
      makeNoopSelfModelWriter() as unknown as never,
      makeNoopEventLogger() as unknown as never,
    );
  }

  it('inserts a dead-letter row when UpsertEntitiesService throws', async () => {
    const service = makeService('UpsertEntities exploded');

    // Patch fetchUnlearnedEvents to return our controlled event.
    const updateWkg = (service as unknown as { updateWkg: IUpdateWkgService }).updateWkg;
    const originalFetch = updateWkg.fetchUnlearnedEvents.bind(updateWkg);
    updateWkg.fetchUnlearnedEvents = async () => [makeEvent()];

    await service.runMaintenanceCycle();

    // Restore.
    updateWkg.fetchUnlearnedEvents = originalFetch;

    const insert = timescale.queries.find(
      (q) => q.sql.includes('INSERT INTO failed_learning_events'),
    );
    expect(insert).toBeDefined();
  });

  it('dead-letter row carries the correct event_id', async () => {
    const service = makeService('UpsertEntities exploded');
    const updateWkg = (service as unknown as { updateWkg: IUpdateWkgService }).updateWkg;
    updateWkg.fetchUnlearnedEvents = async () => [makeEvent('evt-specific-42')];

    await service.runMaintenanceCycle();

    const insert = timescale.queries.find(
      (q) => q.sql.includes('INSERT INTO failed_learning_events'),
    );
    expect(insert!.params[0]).toBe('evt-specific-42');
  });

  it('dead-letter row carries pipeline_step=upsertEntities for a UpsertEntities throw', async () => {
    const service = makeService('UpsertEntities exploded');
    const updateWkg = (service as unknown as { updateWkg: IUpdateWkgService }).updateWkg;
    updateWkg.fetchUnlearnedEvents = async () => [makeEvent()];

    await service.runMaintenanceCycle();

    const insert = timescale.queries.find(
      (q) => q.sql.includes('INSERT INTO failed_learning_events'),
    );
    // pipeline_step is the second param ($2).
    expect(insert!.params[1]).toBe('upsertEntities');
  });

  it('dead-letter row carries the error message', async () => {
    const errMsg = 'UpsertEntities: neo4j connection refused';
    const service = makeService(errMsg);
    const updateWkg = (service as unknown as { updateWkg: IUpdateWkgService }).updateWkg;
    updateWkg.fetchUnlearnedEvents = async () => [makeEvent()];

    await service.runMaintenanceCycle();

    const insert = timescale.queries.find(
      (q) => q.sql.includes('INSERT INTO failed_learning_events'),
    );
    expect(insert!.params[2]).toBe(errMsg);
  });

  it('event is still marked learned after a dead-letter write', async () => {
    const service = makeService('UpsertEntities exploded');
    const updateWkg = (service as unknown as { updateWkg: IUpdateWkgService }).updateWkg;
    updateWkg.fetchUnlearnedEvents = async () => [makeEvent('evt-mark-learned')];

    await service.runMaintenanceCycle();

    const markLearned = timescale.queries.find(
      (q) =>
        q.sql.includes('UPDATE events SET has_learned = true') &&
        q.params.includes('evt-mark-learned'),
    );
    expect(markLearned).toBeDefined();
  });

  it('exactly one dead-letter row is written per failed event', async () => {
    const service = makeService('UpsertEntities exploded');
    const updateWkg = (service as unknown as { updateWkg: IUpdateWkgService }).updateWkg;
    updateWkg.fetchUnlearnedEvents = async () => [makeEvent('evt-once')];

    await service.runMaintenanceCycle();

    const inserts = timescale.queries.filter(
      (q) => q.sql.includes('INSERT INTO failed_learning_events'),
    );
    expect(inserts).toHaveLength(1);
  });

  it('the MaintenanceCycleResult still counts the failed event as processed', async () => {
    const service = makeService('UpsertEntities exploded');
    const updateWkg = (service as unknown as { updateWkg: IUpdateWkgService }).updateWkg;
    updateWkg.fetchUnlearnedEvents = async () => [makeEvent()];

    const result: MaintenanceCycleResult = await service.runMaintenanceCycle();
    expect(result.eventsProcessed).toBe(1);
  });
});

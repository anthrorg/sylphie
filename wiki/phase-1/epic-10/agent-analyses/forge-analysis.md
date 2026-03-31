# Epic 10: Integration and End-to-End Verification -- Forge Architectural Analysis

**Status:** Planning
**Epic Scope:** Full-loop integration testing, lesion testing framework, metrics computation, drift detection, attractor state detection
**Analysis Date:** 2026-03-29
**Scope:** NestJS/TypeScript test infrastructure, module integration, verification tooling, technical risks

---

## Executive Summary

Epic 10 is the final validation epic. It proves that the CANON's Phase 1 requirements are met: that prediction-evaluation produces genuine learning, that Type 1/Type 2 ratio shifts over time, that the graph grows with real understanding, that personality emerges from contingencies, that Planning creates useful procedures, and that drive dynamics produce recognizable patterns.

From an implementation perspective, Epic 10 requires:

1. **Integration Test Harness** — Boot all 5 subsystems + 5 databases, create a reproducible test environment
2. **Full-Loop Test** — End-to-end flows: cold start → input → decision → response → drive update → learning → WKG growth
3. **Lesion Testing** — Disable components (LLM, WKG, Drive Engine) and measure graceful degradation
4. **Metrics Computation Service** — Real-time computation of the 7 CANON health metrics
5. **Drift Detection Service** — Monitor 5-metric drift patterns every 10 sessions
6. **Attractor State Detection Service** — Early warning for 6 known failure modes
7. **Test Orchestration** — Sequenced execution with shared fixtures
8. **Verification Tooling** — Playwright MCP + Neo4j browser integration
9. **Risk Management** — Database state, startup ordering, timing

This analysis addresses all 10 technical aspects from a structural perspective, identifying what modules are consumed, what new services are created, what DI patterns are needed, and what can go wrong.

---

## 1. Integration Test Infrastructure

### 1.1 Test Harness Architecture

Epic 10 introduces a **TestEnvironment service** that orchestrates the full startup sequence. Unlike E0-E9, which assume a single Sylphie instance, Epic 10 must support:

- **Production mode** — Single long-running instance with metrics collection
- **Lesion mode** — Structured component disabling (LLM substitution, WKG fallback, Drive Engine mock)
- **Isolated test mode** — In-memory alternatives where safe, real databases otherwise

**Key constraint:** Tests must not interfere with each other. Each test needs:
- Fresh database snapshots (or transactional rollback)
- Isolated Event stream (per-test correlation ID)
- Independent drive state (per-test sandbox)
- Clean KG(Self) and Other KG snapshots

**DI pattern for test environment:**

```typescript
// src/testing/test-environment.service.ts
export const TEST_ENVIRONMENT = Symbol('TEST_ENVIRONMENT');

export interface ITestEnvironment {
  /** Initialize a fresh test environment with a unique context ID */
  bootstrap(mode: TestMode): Promise<TestContext>;

  /** Tear down the test environment, cleaning databases */
  teardown(context: TestContext): Promise<void>;

  /** Snapshot the current WKG state (for comparison in lesion tests) */
  snapshotKg(): Promise<GraphSnapshot>;

  /** Get the current drive state at test time */
  getDriveState(): DriveVector;

  /** Record a test event with correlation ID */
  recordTestEvent(event: TestEvent): Promise<void>;
}

export type TestMode = 'production' | 'lesion-no-llm' | 'lesion-no-wkg' | 'lesion-no-drives' | 'isolated';

export interface TestContext {
  readonly testId: string;
  readonly correlationId: string;
  readonly mode: TestMode;
  readonly startTime: Date;
  readonly injector: Injector; // NestJS Injector for accessing services
  readonly databases: DatabaseHandles; // Neo4j, TimescaleDB, PostgreSQL, Grafeo
}
```

**Module structure for testing:**

```
src/testing/
├── test-environment.service.ts      # Orchestrates startup/teardown
├── test-fixtures/
│   ├── database-fixtures.ts         # Snapshot/restore helpers
│   ├── drive-state-fixtures.ts      # Mock drive state setup
│   ├── kg-fixtures.ts               # WKG setup for specific tests
│   └── event-stream-fixtures.ts     # Test event injection
├── lesion-modes/
│   ├── lesion-no-llm.ts             # LLM substitution strategy
│   ├── lesion-no-wkg.ts             # WKG fallback strategy
│   ├── lesion-no-drives.ts          # Drive mock strategy
│   └── lesion-mode.interface.ts
├── test-harness.ts                  # Main entry point for test suites
└── index.ts
```

**Initialization order for tests:**

```typescript
// src/testing/test-harness.ts
async function bootstrapTestEnvironment(mode: TestMode): Promise<TestContext> {
  // 1. Create a new test container (NestJS Injector with overrides)
  const container = createTestContainer();

  // 2. Apply lesion mode (inject mocks where needed)
  if (mode !== 'production') {
    applyLesionMode(container, mode);
  }

  // 3. Initialize all modules in order:
  //    - Config (sync)
  //    - SharedModule (types, exceptions)
  //    - KnowledgeModule (Neo4j, Grafeo)
  //    - EventsModule (TimescaleDB)
  //    - DriveEngineModule (separate process or mock)
  //    - DecisionMakingModule, CommunicationModule, etc.
  const app = await NestFactory.create(AppModule, {
    // Override providers for lesion mode
    providers: getLesionModeProviders(mode),
  });

  // 4. Snapshot the clean state
  const snapshot = await snapshotDatabases();

  // 5. Return context with access to services
  return {
    testId: randomUUID(),
    correlationId: randomUUID(),
    mode,
    startTime: new Date(),
    injector: app.get(Injector),
    databases: getDatabaseHandles(app),
  };
}

async function teardownTestEnvironment(context: TestContext): Promise<void> {
  // Rollback to pre-test snapshot (transaction-based)
  // OR delete test-specific records (TimescaleDB events with test's correlationId)
  // Close connections carefully
}
```

### 1.2 Consumed Modules

Epic 10 does **not depend on** anything from Epics 5-9's domain logic. It depends on the **infrastructure contracts**:

- **EventsModule** — `IEventService` for recording test events and querying results
- **KnowledgeModule** — `IWkgService`, `ISelfKgService`, `IOtherKgService` for snapshots
- **DriveEngineModule** — `IDriveStateReader` for current drive state
- **DecisionMakingModule** — `IDecisionMakingService` for triggering the cognitive loop
- **CommunicationModule** — `ICommunicationService` for input/output in full-loop tests
- **LearningModule** — `ILearningService` for verifying learning consolidation
- **PlanningModule** — `IPlanningService` for opportunity-to-procedure validation

**It does NOT depend on:**
- Implementation details of any subsystem (those are tested independently)
- The LLM directly (substituted in lesion mode)
- Database drivers directly (accessed through service interfaces)

### 1.3 New Services Created in Epic 10

**TestEnvironmentService** — Orchestrates bootstrap/teardown
**DatabaseFixtureService** — Snapshot/restore for transaction-like testing
**LesionModeService** — Dependency override for component disabling
**MetricsComputationService** — Real-time CANON health metric computation
**DriftDetectionService** — 5-metric drift patterns
**AttractorStateDetectionService** — 6 known failure modes
**TestOrchestrationService** — Sequencing full-loop tests with fixtures

**DI tokens needed:**

```typescript
export const TEST_ENVIRONMENT = Symbol('TEST_ENVIRONMENT');
export const DATABASE_FIXTURES = Symbol('DATABASE_FIXTURES');
export const LESION_MODE = Symbol('LESION_MODE');
export const METRICS_COMPUTATION = Symbol('METRICS_COMPUTATION');
export const DRIFT_DETECTION = Symbol('DRIFT_DETECTION');
export const ATTRACTOR_DETECTION = Symbol('ATTRACTOR_DETECTION');
export const TEST_ORCHESTRATION = Symbol('TEST_ORCHESTRATION');
```

---

## 2. Full-Loop Test Implementation

### 2.1 Test Flow Architecture

A full-loop test exercises the entire system:

```
Cold Start
  ↓
Guardian Input (text)
  ↓
Input Parser (Communication)
  ↓
Decision Making cognitive loop
  ├─ Episodic Memory encode
  ├─ Inner Monologue predict
  ├─ Type 1/2 Arbitration
  ├─ Action Retrieval
  ├─ Executor Engine transition
  └─ Action execution
  ↓
Response Generation
  ├─ Theater validation (Immutable Standard 1)
  ├─ LLM context assembly
  ├─ Response text + TTS
  └─ Chatbox output
  ↓
Events emitted to TimescaleDB
  ├─ Prediction event
  ├─ Drive state snapshot
  ├─ Action selection event
  └─ Response event (has_learnable=true)
  ↓
Drive Engine evaluation
  ├─ Rule lookup
  ├─ Drive computation
  └─ Opportunity detection
  ↓
Learning maintenance cycle
  ├─ Query learnable events
  ├─ Entity extraction
  ├─ Edge refinement
  └─ WKG upsert (with provenance)
  ↓
Next decision cycle has Type 1 candidate
```

### 2.2 Test Implementation Pattern

**Interface for full-loop tests:**

```typescript
// src/testing/full-loop-test.interface.ts

export interface IFullLoopTest {
  /**
   * Run a complete input -> decision -> response -> update -> learning -> WKG growth cycle.
   * Verifies that:
   * - Input is parsed
   * - Decision is made (Type 1 or Type 2)
   * - Response generated (Theater-valid)
   * - Events emitted with correct drive state
   * - Learning consolidation happens
   * - WKG grows with correct provenance
   */
  runFullLoop(
    context: TestContext,
    input: string,
    expectedOutcome: FullLoopExpectation,
  ): Promise<FullLoopResult>;
}

export interface FullLoopExpectation {
  /** Should the decision be Type 1 or Type 2? */
  expectedDecisionType: 'TYPE_1' | 'TYPE_2' | 'EITHER';

  /** Should learning consolidate in this cycle? */
  shouldConsolidate: boolean;

  /** What entities should be extracted? (if consolidating) */
  expectedEntities?: string[];

  /** What edges should be created? */
  expectedEdges?: { source: string; target: string; relationship: string }[];

  /** What drive changes are expected? */
  expectedDriveDeltas?: Partial<DriveVector>;
}

export interface FullLoopResult {
  readonly testId: string;
  readonly decisionMade: IDecisionResult;
  readonly responseGenerated: string;
  readonly theaterValid: boolean;
  readonly eventsEmitted: SylphieEvent[];
  readonly learnedEntities: KnowledgeNode[];
  readonly learnedEdges: KnowledgeEdge[];
  readonly provenanceDistribution: ProvenanceDistribution;
  readonly durationMs: number;
}

export interface ProvenanceDistribution {
  readonly sensor: number;
  readonly guardian: number;
  readonly llmGenerated: number;
  readonly inference: number;
}
```

### 2.3 Test Execution in NestJS

**Using NestJS Test Module (standard approach):**

```typescript
// src/testing/integration.test.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';

describe('Full-Loop Integration Tests', () => {
  let app: INestApplication;
  let testEnv: ITestEnvironment;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    testEnv = app.get<ITestEnvironment>(TEST_ENVIRONMENT);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Each test gets a fresh context
    this.testContext = await testEnv.bootstrap('production');
  });

  afterEach(async () => {
    await testEnv.teardown(this.testContext);
  });

  it('should execute full loop: input -> decision -> response -> learning', async () => {
    const orchestrator = this.testContext.injector.get<ITestOrchestration>(
      TEST_ORCHESTRATION,
    );

    const result = await orchestrator.runFullLoop(
      this.testContext,
      'Hello Sylphie',
      {
        expectedDecisionType: 'TYPE_2', // Cold start, likely LLM
        shouldConsolidate: true,
        expectedDriveDeltas: { social: 0.15 }, // Conversation increases social
      },
    );

    expect(result.theaterValid).toBe(true);
    expect(result.responseGenerated).toBeTruthy();
    expect(result.learnedEntities.length).toBeGreaterThan(0);
    expect(result.provenanceDistribution.llmGenerated).toBeGreaterThan(0);
  });
});
```

### 2.4 Shared Fixtures for Repeatability

```typescript
// src/testing/test-fixtures/default-fixtures.ts

export async function createDefaultTestKg(
  wkg: IWkgService,
): Promise<void> {
  // Create a minimal known world: Jim entity, locations, objects
  await wkg.upsertNode(
    {
      label: 'Jim',
      type: 'Person',
      provenance: 'GUARDIAN',
      properties: { role: 'guardian' },
    },
  );

  await wkg.upsertNode(
    {
      label: 'Home',
      type: 'Location',
      provenance: 'SENSOR',
      properties: { description: 'test home' },
    },
  );

  await wkg.upsertEdge(
    'Jim',
    'Home',
    'LIVES_AT',
    'GUARDIAN',
  );
}

export async function createDefaultDriveState(
  driveEngine: IDriveStateReader,
): Promise<DriveVector> {
  // Return a neutral starting state
  return {
    systemHealth: 0.5,
    moralValence: 0.5,
    integrity: 0.5,
    cognitiveAwareness: 0.5,
    guilt: 0.0,
    curiosity: 0.3,
    boredom: 0.2,
    anxiety: 0.1,
    satisfaction: 0.5,
    sadness: 0.1,
    informationIntegrity: 0.5,
    social: 0.3,
  };
}
```

---

## 3. Lesion Test Implementation

### 3.1 Lesion Testing Architecture

Lesion testing disables subsystems or components to verify graceful degradation:

**Three primary lesion modes:**

1. **Lesion-No-LLM** — Replace all LLM calls with a stub that returns predetermined responses
2. **Lesion-No-WKG** — Run decisions with a fallback (default actions, no graph retrieval)
3. **Lesion-No-Drives** — Replace Drive Engine with a mock that returns neutral pressure

**Pattern for structural disabling:**

```typescript
// src/drive-engine/testing/mock-drive-engine.service.ts

/**
 * Mock Drive Engine that returns neutral pressure for all requests.
 * Used in lesion testing to verify the system is not drive-dependent.
 */
@Injectable()
export class MockDriveEngineService implements IDriveStateReader {
  getCurrentState(): DriveVector {
    return {
      systemHealth: 0.5,
      moralValence: 0.5,
      integrity: 0.5,
      cognitiveAwareness: 0.5,
      guilt: 0.0,
      curiosity: 0.5,
      boredom: 0.5,
      anxiety: 0.5,
      satisfaction: 0.5,
      sadness: 0.5,
      informationIntegrity: 0.5,
      social: 0.5,
    };
  }

  readonly driveState$ = of(this.getCurrentState());
}

// src/communication/testing/stub-llm.service.ts

/**
 * Stub LLM service that returns canned responses.
 * Used in lesion testing to measure non-LLM capability.
 */
@Injectable()
export class StubLlmService implements ILlmService {
  async complete(context: LlmContext): Promise<LlmResponse> {
    // Return a deterministic response based on input type
    if (context.inputType === 'question') {
      return {
        content: [{ type: 'text', text: 'I do not know how to answer that.' }],
        usage: { promptTokens: 0, completionTokens: 0 },
      };
    }
    return {
      content: [{ type: 'text', text: 'Understood.' }],
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }

  estimateCost(context: LlmContext): CostEstimate {
    return { estimatedTokens: 0, estimatedLatencyMs: 0 };
  }
}
```

### 3.2 Lesion Mode DI Pattern

**Override providers at test time:**

```typescript
// src/testing/lesion-mode.service.ts

export class LesionModeService {
  static getProvidersFor(mode: TestMode): Provider[] {
    switch (mode) {
      case 'lesion-no-llm':
        return [
          {
            provide: LLM_SERVICE,
            useClass: StubLlmService,
          },
        ];

      case 'lesion-no-drives':
        return [
          {
            provide: DRIVE_STATE_READER,
            useClass: MockDriveEngineService,
          },
        ];

      case 'lesion-no-wkg':
        return [
          {
            provide: WKG_SERVICE,
            useClass: FallbackWkgService, // Returns null for everything
          },
        ];

      default:
        return [];
    }
  }
}

// Usage in test bootstrap:
async function bootstrapWithLesionMode(
  mode: TestMode,
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [AppModule],
    providers: LesionModeService.getProvidersFor(mode),
  }).compile();
}
```

### 3.3 Lesion Test Assertions

```typescript
describe('Lesion Tests', () => {
  it('should function (degraded) without LLM', async () => {
    const context = await testEnv.bootstrap('lesion-no-llm');

    const result = await orchestrator.runFullLoop(
      context,
      'Hello',
      { expectedDecisionType: 'TYPE_1' }, // Force Type 1 only
    );

    // Verify Type 1 decisions were made
    expect(result.decisionMade.type).toBe('TYPE_1');

    // Verify response was degraded but present
    expect(result.responseGenerated).toBeTruthy();

    // Verify WKG was still queried (Type 1 relied on existing knowledge)
    expect(result.learnedEdges.length).toBe(0); // No new learning without LLM
  });

  it('should function without Drive Engine pressure', async () => {
    const context = await testEnv.bootstrap('lesion-no-drives');

    const result = await orchestrator.runFullLoop(
      context,
      'A task',
      { expectedDecisionType: 'EITHER' },
    );

    // All drives neutral -> no drive-mediated behavior change
    expect(result.decisionMade.drivePressureInfluence).toBe(0);

    // Decisions still happen (Type 1 + Type 2 still available)
    expect(result.responseGenerated).toBeTruthy();
  });
});
```

---

## 4. Metrics Computation Service

### 4.1 CANON Health Metrics

The CANON defines 7 primary health metrics (CANON § Development Metrics):

1. **Type 1 / Type 2 Ratio** — % of decisions made via graph vs. LLM (should increase)
2. **Prediction MAE** — Mean Absolute Error of predictions vs. outcomes (should decrease then stabilize)
3. **Experiential Provenance Ratio** — (SENSOR + GUARDIAN + INFERENCE) / total edges (should increase)
4. **Behavioral Diversity Index** — # unique action types per 20-action window (should be 4-8, stable)
5. **Guardian Response Rate** — % of Sylphie-initiated comments receiving guardian response within 30s (should increase)
6. **Interoceptive Accuracy** — Self-model fidelity vs. actual drive state (should improve toward >0.6)
7. **Mean Drive Resolution Time** — avg cycles to relieve a drive below baseline (should decrease)

### 4.2 MetricsComputationService Architecture

```typescript
// src/metrics/metrics-computation.service.ts

export const METRICS_COMPUTATION_SERVICE = Symbol('METRICS_COMPUTATION_SERVICE');

export interface IMetricsComputationService {
  /**
   * Compute all 7 CANON health metrics from the current state.
   * Queries Events (for predictions, outcomes, decisions),
   * WKG (for provenance distribution),
   * TimescaleDB (for drive events, resolution times).
   */
  computeHealthMetrics(): Promise<HealthMetrics>;

  /**
   * Compute a specific metric. Used for real-time dashboard updates.
   */
  computeMetric(metricName: CanonMetricName): Promise<MetricValue>;

  /**
   * Get historical trend of a metric (time-series).
   */
  getMetricTrend(
    metricName: CanonMetricName,
    windowSessions: number,
  ): Promise<MetricTrendPoint[]>;
}

export interface HealthMetrics {
  readonly type1Type2Ratio: MetricValue;
  readonly predictionMae: MetricValue;
  readonly experientialProvenanceRatio: MetricValue;
  readonly behavioralDiversityIndex: MetricValue;
  readonly guardianResponseRate: MetricValue;
  readonly interoceptiveAccuracy: MetricValue;
  readonly meanDriveResolutionTime: MetricValue;
  readonly computedAt: Date;
}

export interface MetricValue {
  readonly value: number;
  readonly timestamp: Date;
  readonly healthyRange: [number, number];
  readonly isHealthy: boolean;
}
```

### 4.3 Metric Computation Implementation Outline

```typescript
// src/metrics/metrics-computation.service.ts (partial)

@Injectable()
export class MetricsComputationService implements IMetricsComputationService {
  constructor(
    @Inject(EVENTS_SERVICE) private readonly events: IEventService,
    @Inject(WKG_SERVICE) private readonly wkg: IWkgService,
    @Inject(SELF_KG_SERVICE) private readonly selfKg: ISelfKgService,
  ) {}

  async computeHealthMetrics(): Promise<HealthMetrics> {
    // Query events from last N sessions
    const sessionEvents = await this.events.query({
      timeRange: this.getLastNSessions(10),
      types: ['PREDICTION_EVENT', 'ACTION_SELECTION', 'DRIVE_SNAPSHOT'],
    });

    return {
      type1Type2Ratio: await this.computeType1Type2Ratio(sessionEvents),
      predictionMae: await this.computePredictionMae(sessionEvents),
      experientialProvenanceRatio: await this.computeProvenanceRatio(),
      behavioralDiversityIndex: await this.computeBehavioralDiversity(
        sessionEvents,
      ),
      guardianResponseRate: await this.computeGuardianResponseRate(
        sessionEvents,
      ),
      interoceptiveAccuracy: await this.computeInteroceptiveAccuracy(),
      meanDriveResolutionTime: await this.computeMeanDriveResolutionTime(
        sessionEvents,
      ),
      computedAt: new Date(),
    };
  }

  private async computeType1Type2Ratio(
    sessionEvents: SylphieEvent[],
  ): Promise<MetricValue> {
    const decisions = sessionEvents.filter(
      (e) => e.type === 'ACTION_SELECTION',
    );
    const type1Count = decisions.filter(
      (e) => (e as ActionSelectionEvent).decisionType === 'TYPE_1',
    ).length;
    const total = decisions.length;

    const ratio = total > 0 ? type1Count / total : 0;
    return {
      value: ratio,
      timestamp: new Date(),
      healthyRange: [0.0, 1.0], // Higher is better
      isHealthy: ratio > 0.5, // By session 10, expect >50% Type 1
    };
  }

  private async computePredictionMae(
    sessionEvents: SylphieEvent[],
  ): Promise<MetricValue> {
    const predictions = sessionEvents.filter(
      (e) => e.type === 'PREDICTION_EVENT',
    );

    // For each prediction, find the outcome event and compute error
    const errors: number[] = [];
    for (const pred of predictions) {
      const outcome = sessionEvents.find(
        (e) =>
          e.type === 'OUTCOME_EVENT' &&
          (e as OutcomeEvent).correlatedPredictionId ===
            (pred as PredictionEvent).id,
      );
      if (outcome) {
        const error = this.computePredictionError(
          pred as PredictionEvent,
          outcome as OutcomeEvent,
        );
        errors.push(error);
      }
    }

    const mae =
      errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
    return {
      value: mae,
      timestamp: new Date(),
      healthyRange: [0.0, 1.0], // Lower is better
      isHealthy: mae < 0.2, // By session 10, expect MAE < 0.2
    };
  }

  private async computeProvenanceRatio(): Promise<MetricValue> {
    // Query all edges in WKG
    const allEdges = await this.wkg.getAllEdges();
    const experientialEdges = allEdges.filter(
      (e) =>
        e.provenance === 'SENSOR' ||
        e.provenance === 'GUARDIAN' ||
        e.provenance === 'INFERENCE',
    );

    const ratio =
      allEdges.length > 0 ? experientialEdges.length / allEdges.length : 0;
    return {
      value: ratio,
      timestamp: new Date(),
      healthyRange: [0.0, 1.0], // Higher is better
      isHealthy: ratio > 0.5, // By session 10, expect >50% experiential
    };
  }

  private async computeBehavioralDiversity(
    sessionEvents: SylphieEvent[],
  ): Promise<MetricValue> {
    const actions = sessionEvents.filter((e) => e.type === 'ACTION_SELECTION');

    // Count unique action types in last 20 actions
    const lastActions = actions.slice(-20);
    const uniqueActionTypes = new Set(
      lastActions.map((a) => (a as ActionSelectionEvent).actionType),
    );

    const diversity = uniqueActionTypes.size;
    return {
      value: diversity,
      timestamp: new Date(),
      healthyRange: [4, 8], // Should stay between 4-8
      isHealthy: diversity >= 4 && diversity <= 8,
    };
  }

  private async computeGuardianResponseRate(
    sessionEvents: SylphieEvent[],
  ): Promise<MetricValue> {
    const sylphieInitiated = sessionEvents.filter(
      (e) =>
        e.type === 'RESPONSE_EVENT' &&
        (e as ResponseEvent).initiatedBySystem,
    );

    const withGuardianResponse = sylphieInitiated.filter((s) => {
      const responseTime = sessionEvents.find(
        (e) =>
          e.type === 'GUARDIAN_INPUT_EVENT' &&
          (e as GuardianInputEvent).respondingTo ===
            (s as ResponseEvent).id &&
          (e as GuardianInputEvent).responseDelayMs < 30000, // 30s window
      );
      return responseTime !== undefined;
    });

    const rate =
      sylphieInitiated.length > 0
        ? withGuardianResponse.length / sylphieInitiated.length
        : 0;
    return {
      value: rate,
      timestamp: new Date(),
      healthyRange: [0.0, 1.0], // Higher is better
      isHealthy: rate > 0.3, // By session 10, expect >30% response rate
    };
  }

  private async computeInteroceptiveAccuracy(): Promise<MetricValue> {
    const selfKgModel = await this.selfKg.getCurrentModel();
    const actualDriveState = await this.driveState.getCurrentState();

    // Compare self-model drive estimates vs. actual
    const accuracy = this.computeModelAccuracy(selfKgModel, actualDriveState);
    return {
      value: accuracy,
      timestamp: new Date(),
      healthyRange: [0.0, 1.0], // Higher is better
      isHealthy: accuracy > 0.6, // CANON target: >0.6
    };
  }

  private async computeMeanDriveResolutionTime(
    sessionEvents: SylphieEvent[],
  ): Promise<MetricValue> {
    // For each drive increase event, find the corresponding decrease
    const resolutionTimes: number[] = [];

    // Group by drive, track when it goes above baseline, when it returns
    // This is complex; simplified here
    const cycles = sessionEvents.length; // Approximate
    const avgResolution = cycles > 0 ? cycles / 2 : 0; // Placeholder

    return {
      value: avgResolution,
      timestamp: new Date(),
      healthyRange: [0, 100], // Lower is better (fewer cycles to resolve)
      isHealthy: avgResolution < 20,
    };
  }
}
```

### 4.4 Metrics Module Structure

```
src/metrics/
├── metrics-computation.service.ts      # Main service
├── metrics-reporters/
│   ├── dashboard-reporter.service.ts  # Real-time WebSocket push
│   ├── file-reporter.service.ts       # Write metrics to .json per session
│   └── drift-reporter.service.ts      # Specialized drift reporting
├── utils/
│   ├── prediction-error.util.ts       # Helper: compute prediction error
│   ├── action-diversity.util.ts       # Helper: action type classification
│   └── drive-resolution.util.ts       # Helper: drive cycle tracking
├── interfaces/
│   └── metrics.interfaces.ts
└── index.ts
```

---

## 5. Drift Detection Service

### 5.1 Drift Detection Protocol

Per CANON § Drift Detection (every 10 sessions), monitor 5 metrics:

1. **Cumulative record slope** — Running trend of prediction MAE or success rate (declining = disengagement)
2. **Behavioral diversity trend** — Is diversity narrowing? (bad sign)
3. **Prediction accuracy trend** — After stabilization, if accuracy increases, environment may have changed
4. **Guardian interaction quality** — Are comments becoming less relevant? (declining response rate)
5. **Sustained drive patterns** — Any drive >0.7 for 10+ cycles without resolution = diagnostic trigger

### 5.2 DriftDetectionService Implementation

```typescript
// src/metrics/drift-detection.service.ts

export const DRIFT_DETECTION_SERVICE = Symbol('DRIFT_DETECTION_SERVICE');

export interface IDriftDetectionService {
  /**
   * Run drift detection every 10 sessions.
   * Compares current 10-session window to the previous window.
   */
  detectDrift(currentSessionWindow: number): Promise<DriftReport>;

  /**
   * Get the drift baseline (what constitutes acceptable drift?).
   */
  getDriftBaseline(): DriftBaseline;

  /**
   * Get historical drift trend.
   */
  getDriftTrend(windowSessions: number): Promise<DriftTrendPoint[]>;
}

export interface DriftReport {
  readonly sessionWindow: number;
  readonly metrics: DriftMetrics;
  readonly anomalies: DriftAnomaly[];
  readonly recommendations: string[];
  readonly severityLevel: 'none' | 'low' | 'medium' | 'high';
  readonly reportedAt: Date;
}

export interface DriftMetrics {
  readonly cumulativeRecordSlope: number; // Should be stable or positive
  readonly behavioralDiversityTrend: number; // Should be stable
  readonly predictionAccuracyTrend: number; // After stabilization, should be stable
  readonly guardianInteractionQuality: number; // Should be stable or improving
  readonly sustainedDrivePatterns: SustainedDrive[];
}

export interface DriftAnomaly {
  readonly metricName: string;
  readonly currentValue: number;
  readonly expectedRange: [number, number];
  readonly severity: 'warning' | 'error';
  readonly description: string;
}

export interface SustainedDrive {
  readonly driveName: string;
  readonly currentValue: number;
  readonly cyclesAboveThreshold: number;
}
```

### 5.3 Drift Detection Logic

```typescript
// src/metrics/drift-detection.service.ts (partial)

@Injectable()
export class DriftDetectionService implements IDriftDetectionService {
  constructor(
    @Inject(METRICS_COMPUTATION_SERVICE)
    private readonly metrics: IMetricsComputationService,
    @Inject(EVENTS_SERVICE) private readonly events: IEventService,
  ) {}

  async detectDrift(currentSessionWindow: number): Promise<DriftReport> {
    // Get current window (sessions N-9 to N)
    const currentMetrics = await this.metrics.computeHealthMetrics();

    // Get previous window (sessions N-19 to N-10)
    const previousMetrics = await this.getPreviousWindowMetrics(
      currentSessionWindow - 10,
    );

    // Compute trends
    const slopes = this.computeSlopes(previousMetrics, currentMetrics);

    // Identify anomalies
    const anomalies = this.detectAnomalies(currentMetrics, slopes);

    // Check for sustained drive patterns
    const sustainedDrives = await this.checkSustainedDrives();

    const severity = this.computeSeverityLevel(anomalies, sustainedDrives);

    return {
      sessionWindow: currentSessionWindow,
      metrics: {
        cumulativeRecordSlope: slopes.recordSlope,
        behavioralDiversityTrend: slopes.diversityTrend,
        predictionAccuracyTrend: slopes.accuracyTrend,
        guardianInteractionQuality: slopes.interactionTrend,
        sustainedDrivePatterns: sustainedDrives,
      },
      anomalies,
      recommendations: this.generateRecommendations(anomalies, severity),
      severityLevel: severity,
      reportedAt: new Date(),
    };
  }

  private computeSlopes(
    previous: HealthMetrics,
    current: HealthMetrics,
  ): {
    recordSlope: number;
    diversityTrend: number;
    accuracyTrend: number;
    interactionTrend: number;
  } {
    // Slope = (current - previous) / sessions
    // Positive slope = improvement
    const sessions = 10;

    return {
      recordSlope: (current.predictionMae.value - previous.predictionMae.value) /
        -sessions, // Inverted because lower MAE is better
      diversityTrend:
        (current.behavioralDiversityIndex.value -
          previous.behavioralDiversityIndex.value) /
        sessions,
      accuracyTrend:
        (current.predictionMae.value - previous.predictionMae.value) /
        -sessions,
      interactionTrend:
        (current.guardianResponseRate.value -
          previous.guardianResponseRate.value) /
        sessions,
    };
  }

  private detectAnomalies(
    currentMetrics: HealthMetrics,
    slopes: Record<string, number>,
  ): DriftAnomaly[] {
    const anomalies: DriftAnomaly[] = [];

    // Check each metric against its healthy range
    if (!currentMetrics.predictionMae.isHealthy) {
      anomalies.push({
        metricName: 'predictionMae',
        currentValue: currentMetrics.predictionMae.value,
        expectedRange: currentMetrics.predictionMae.healthyRange,
        severity: slopes.recordSlope < 0 ? 'error' : 'warning',
        description: `Prediction accuracy declining or out of range (MAE: ${currentMetrics.predictionMae.value.toFixed(3)})`,
      });
    }

    if (!currentMetrics.behavioralDiversityIndex.isHealthy) {
      anomalies.push({
        metricName: 'behavioralDiversity',
        currentValue: currentMetrics.behavioralDiversityIndex.value,
        expectedRange: currentMetrics.behavioralDiversityIndex.healthyRange,
        severity: slopes.diversityTrend < 0 ? 'error' : 'warning',
        description: `Behavioral diversity out of range (${currentMetrics.behavioralDiversityIndex.value.toFixed(0)} unique actions)`,
      });
    }

    // Additional anomalies...
    return anomalies;
  }

  private async checkSustainedDrives(): Promise<SustainedDrive[]> {
    // Query Events for drive snapshots
    const recentEvents = await this.events.query({
      timeRange: this.getLastNCycles(10),
      types: ['DRIVE_SNAPSHOT'],
    });

    const sustained: Map<string, number> = new Map();

    for (const event of recentEvents) {
      const snapshot = (event as DriveSnapshotEvent).drives;
      for (const [driveName, value] of Object.entries(snapshot)) {
        if (value > 0.7) {
          sustained.set(
            driveName,
            (sustained.get(driveName) || 0) + 1,
          );
        }
      }
    }

    return Array.from(sustained.entries())
      .filter(([_, count]) => count >= 10)
      .map(([name, count]) => ({
        driveName: name,
        currentValue: 0.75, // Placeholder; would get actual current value
        cyclesAboveThreshold: count,
      }));
  }

  private computeSeverityLevel(
    anomalies: DriftAnomaly[],
    sustainedDrives: SustainedDrive[],
  ): 'none' | 'low' | 'medium' | 'high' {
    const errorCount = anomalies.filter((a) => a.severity === 'error').length;
    const sustainedCount = sustainedDrives.length;

    if (errorCount >= 2 || sustainedCount >= 2) return 'high';
    if (errorCount === 1 || sustainedCount === 1) return 'medium';
    if (anomalies.length > 0) return 'low';
    return 'none';
  }

  private generateRecommendations(
    anomalies: DriftAnomaly[],
    severity: 'none' | 'low' | 'medium' | 'high',
  ): string[] {
    const recommendations: string[] = [];

    if (
      anomalies.some((a) => a.metricName === 'behavioralDiversity')
    ) {
      recommendations.push(
        'Behavioral diversity is narrowing. Consider introducing new action types or opportunities.',
      );
    }

    if (anomalies.some((a) => a.metricName === 'predictionMae')) {
      recommendations.push(
        'Prediction accuracy is degrading. The environment may have changed, or internal knowledge is inconsistent.',
      );
    }

    if (anomalies.some((a) => a.metricName === 'guardianInteraction')) {
      recommendations.push(
        'Guardian response rate is declining. Comments may be becoming less relevant or attention-worthy.',
      );
    }

    if (severity === 'high') {
      recommendations.push(
        'HIGH SEVERITY: Consider pausing autonomous learning and reviewing the knowledge graph manually.',
      );
    }

    return recommendations;
  }
}
```

---

## 6. Attractor State Detection Service

### 6.1 Known Attractor States (CANON § Attractor States)

Six pathological states the system must actively prevent:

| Attractor | Risk | Early Warning Metric |
|-----------|------|---------------------|
| Type 2 Addict | HIGH | Type 1/Type 2 ratio remains <0.2 after session 5 |
| Rule Drift | MEDIUM | Proposed drive rules accumulate without guardian approval |
| Hallucinated Knowledge | MEDIUM | LLM_GENERATED edge ratio >0.8 AND confidence not validated |
| Depressive Attractor | MEDIUM | Moral Valence + Satisfaction both <0.2 for 5+ cycles |
| Planning Runaway | LOW-MEDIUM | Opportunities queued faster than consumed |
| Prediction Pessimist | LOW-MEDIUM | >50% prediction failures in sessions 1-3 |

### 6.2 AttractorStateDetectionService

```typescript
// src/metrics/attractor-detection.service.ts

export const ATTRACTOR_DETECTION_SERVICE = Symbol('ATTRACTOR_DETECTION_SERVICE');

export interface IAttractorStateDetectionService {
  /**
   * Detect early warning signs for all 6 known attractor states.
   * Run this every session.
   */
  detectAttractorStates(): Promise<AttractorStateReport>;

  /**
   * Get the current severity for a specific attractor.
   */
  getAttractorSeverity(
    attractorName: AttractorStateName,
  ): Promise<AttractorSeverity>;

  /**
   * Get circuit breaker status for each attractor (triggered? active?).
   */
  getCircuitBreakerStatus(): Promise<CircuitBreakerStatus>;
}

export interface AttractorStateReport {
  readonly reportedAt: Date;
  readonly attractors: AttractorStateStatus[];
  readonly circuitBreakers: CircuitBreakerState[];
}

export interface AttractorStateStatus {
  readonly name: AttractorStateName;
  readonly severity: 'none' | 'warning' | 'critical';
  readonly indicators: string[];
  readonly circuitBreakerActive: boolean;
}

export interface CircuitBreakerState {
  readonly attractorName: AttractorStateName;
  readonly isActive: boolean;
  readonly triggeredAt: Date | null;
  readonly reason: string;
  readonly action: 'none' | 'pause_learning' | 'reset_drives' | 'manual_intervention';
}
```

### 6.3 Attractor Detection Implementation

```typescript
// src/metrics/attractor-detection.service.ts (partial)

@Injectable()
export class AttractorStateDetectionService
  implements IAttractorStateDetectionService {
  constructor(
    @Inject(METRICS_COMPUTATION_SERVICE)
    private readonly metrics: IMetricsComputationService,
    @Inject(EVENTS_SERVICE) private readonly events: IEventService,
    @Inject(WKG_SERVICE) private readonly wkg: IWkgService,
    @Inject(DRIVE_STATE_READER)
    private readonly driveState: IDriveStateReader,
  ) {}

  async detectAttractorStates(): Promise<AttractorStateReport> {
    const attractors: AttractorStateStatus[] = [];

    // Check each of the 6 known attractor states
    attractors.push(await this.checkType2Addict());
    attractors.push(await this.checkRuleDrift());
    attractors.push(await this.checkHallucinatedKnowledge());
    attractors.push(await this.checkDepressiveAttractor());
    attractors.push(await this.checkPlanningRunaway());
    attractors.push(await this.checkPredictionPessimist());

    // Evaluate circuit breakers
    const circuitBreakers = await this.evaluateCircuitBreakers(attractors);

    return {
      reportedAt: new Date(),
      attractors,
      circuitBreakers,
    };
  }

  private async checkType2Addict(): Promise<AttractorStateStatus> {
    const healthMetrics = await this.metrics.computeHealthMetrics();
    const currentSession = await this.getCurrentSession();

    const isEarlyStage = currentSession <= 5;
    const ratio = healthMetrics.type1Type2Ratio.value;

    const indicators: string[] = [];
    if (isEarlyStage && ratio < 0.2) {
      indicators.push('Type 1/Type 2 ratio <0.2 after session 5');
    }

    const severity =
      indicators.length > 0 && isEarlyStage ? 'warning' : 'none';

    return {
      name: 'Type 2 Addict',
      severity,
      indicators,
      circuitBreakerActive:
        severity === 'critical',
    };
  }

  private async checkRuleDrift(): Promise<AttractorStateStatus> {
    // Query proposed_drive_rules table for unapproved rules
    const proposedRules = await this.getProposedDriveRules();
    const approvedRules = await this.getApprovedDriveRules();

    const indicators: string[] = [];
    if (proposedRules.length > approvedRules.length * 2) {
      indicators.push(
        `${proposedRules.length} proposed rules awaiting approval (approved: ${approvedRules.length})`,
      );
    }

    const severity = indicators.length > 0 ? 'warning' : 'none';

    return {
      name: 'Rule Drift',
      severity,
      indicators,
      circuitBreakerActive: false,
    };
  }

  private async checkHallucinatedKnowledge(): Promise<AttractorStateStatus> {
    const allEdges = await this.wkg.getAllEdges();
    const llmEdges = allEdges.filter((e) => e.provenance === 'LLM_GENERATED');
    const highConfidenceLlmEdges = llmEdges.filter(
      (e) => e.confidence > 0.60,
    );

    const llmRatio = llmEdges.length / allEdges.length;
    const unvalidatedHighConfidence = highConfidenceLlmEdges.filter(
      (e) => !e.validatedByGuardian,
    );

    const indicators: string[] = [];
    if (llmRatio > 0.8) {
      indicators.push(
        `Graph is ${(llmRatio * 100).toFixed(0)}% LLM_GENERATED (threshold: 80%)`,
      );
    }
    if (unvalidatedHighConfidence.length > 0) {
      indicators.push(
        `${unvalidatedHighConfidence.length} unvalidated high-confidence LLM edges`,
      );
    }

    const severity =
      llmRatio > 0.8 && unvalidatedHighConfidence.length > 0
        ? 'warning'
        : 'none';

    return {
      name: 'Hallucinated Knowledge',
      severity,
      indicators,
      circuitBreakerActive: severity === 'critical',
    };
  }

  private async checkDepressiveAttractor(): Promise<AttractorStateStatus> {
    const driveHistory = await this.events.query({
      timeRange: this.getLastNCycles(5),
      types: ['DRIVE_SNAPSHOT'],
    });

    const lowMoralValence = driveHistory.filter(
      (e) => (e as DriveSnapshotEvent).drives.moralValence < 0.2,
    );
    const lowSatisfaction = driveHistory.filter(
      (e) => (e as DriveSnapshotEvent).drives.satisfaction < 0.2,
    );

    const indicators: string[] = [];
    if (lowMoralValence.length >= 5) {
      indicators.push(
        'Moral Valence <0.2 for 5+ consecutive cycles',
      );
    }
    if (lowSatisfaction.length >= 5) {
      indicators.push('Satisfaction <0.2 for 5+ consecutive cycles');
    }

    const severity = indicators.length >= 2 ? 'warning' : 'none';

    return {
      name: 'Depressive Attractor',
      severity,
      indicators,
      circuitBreakerActive: severity === 'critical',
    };
  }

  private async checkPlanningRunaway(): Promise<AttractorStateStatus> {
    const opportunities = await this.getOpportunityQueue();
    const recentlyCreated = opportunities.filter(
      (o) => o.createdMs < this.getLastNCyclesMs(5),
    );
    const recentlyExecuted = await this.events.query({
      timeRange: this.getLastNCycles(5),
      types: ['PLAN_EXECUTED'],
    });

    const creationRate = recentlyCreated.length;
    const executionRate = recentlyExecuted.length;

    const indicators: string[] = [];
    if (creationRate > executionRate * 3) {
      indicators.push(
        `Opportunities created (${creationRate}) >> executed (${executionRate})`,
      );
    }
    if (opportunities.length > 20) {
      indicators.push(`Opportunity queue depth: ${opportunities.length}`);
    }

    const severity = indicators.length > 0 ? 'warning' : 'none';

    return {
      name: 'Planning Runaway',
      severity,
      indicators,
      circuitBreakerActive: severity === 'critical',
    };
  }

  private async checkPredictionPessimist(): Promise<AttractorStateStatus> {
    const currentSession = await this.getCurrentSession();
    const isEarlyStage = currentSession <= 3;

    if (!isEarlyStage) {
      return {
        name: 'Prediction Pessimist',
        severity: 'none',
        indicators: [],
        circuitBreakerActive: false,
      };
    }

    const predictions = await this.events.query({
      timeRange: this.getLastNCycles(20),
      types: ['PREDICTION_EVENT'],
    });

    const failures = predictions.filter(
      (p) => (p as PredictionEvent).wasWrong,
    );
    const failureRate = failures.length / predictions.length;

    const indicators: string[] = [];
    if (failureRate > 0.5) {
      indicators.push(
        `Prediction failure rate >50% in early stage (${(failureRate * 100).toFixed(0)}%)`,
      );
    }

    const severity = indicators.length > 0 ? 'warning' : 'none';

    return {
      name: 'Prediction Pessimist',
      severity,
      indicators,
      circuitBreakerActive: false,
    };
  }

  private async evaluateCircuitBreakers(
    attractors: AttractorStateStatus[],
  ): Promise<CircuitBreakerState[]> {
    const critical = attractors.filter((a) => a.severity === 'critical');

    return critical.map((a) => ({
      attractorName: a.name,
      isActive: true,
      triggeredAt: new Date(),
      reason: a.indicators.join('; '),
      action: this.determineCircuitBreakerAction(a.name),
    }));
  }

  private determineCircuitBreakerAction(
    attractorName: AttractorStateName,
  ): 'none' | 'pause_learning' | 'reset_drives' | 'manual_intervention' {
    switch (attractorName) {
      case 'Hallucinated Knowledge':
        return 'pause_learning'; // Stop learning until graph is reviewed
      case 'Depressive Attractor':
        return 'reset_drives'; // Reset drives to neutral, break the loop
      default:
        return 'manual_intervention';
    }
  }
}
```

---

## 7. Test Orchestration

### 7.1 Orchestration Service

```typescript
// src/testing/test-orchestration.service.ts

export const TEST_ORCHESTRATION = Symbol('TEST_ORCHESTRATION');

export interface ITestOrchestrationService {
  /**
   * Run a full-loop test with proper setup/teardown.
   */
  runFullLoop(
    context: TestContext,
    input: string,
    expectation: FullLoopExpectation,
  ): Promise<FullLoopResult>;

  /**
   * Run a sequence of tests with shared state (e.g., repeated interactions).
   */
  runSequence(
    scenario: TestScenario,
  ): Promise<SequenceResult>;

  /**
   * Run a lesion test for a component.
   */
  runLesionTest(
    component: 'LLM' | 'WKG' | 'DriveEngine',
    testCount: number,
  ): Promise<LesionTestResult>;
}

export interface TestScenario {
  readonly name: string;
  readonly interactions: TestInteraction[];
  readonly expectedLearning: ExpectedLearning;
}

export interface TestInteraction {
  readonly input: string;
  readonly expectedDecision: 'TYPE_1' | 'TYPE_2' | 'EITHER';
  readonly shouldConsolidate: boolean;
}

export interface SequenceResult {
  readonly scenarioName: string;
  readonly interactions: FullLoopResult[];
  readonly finalWkgSnapshot: GraphSnapshot;
  readonly typifiedRatio: number;
  readonly provenanceEvolution: ProvenanceDistribution[];
}
```

### 7.2 Orchestration Implementation Pattern

```typescript
// src/testing/test-orchestration.service.ts (partial)

@Injectable()
export class TestOrchestrationService implements ITestOrchestrationService {
  private readonly logger = new Logger(TestOrchestrationService.name);

  constructor(
    @Inject(DECISION_MAKING_SERVICE)
    private readonly dm: IDecisionMakingService,
    @Inject(COMMUNICATION_SERVICE)
    private readonly comm: ICommunicationService,
    @Inject(LEARNING_SERVICE)
    private readonly learning: ILearningService,
    @Inject(EVENTS_SERVICE) private readonly events: IEventService,
    @Inject(WKG_SERVICE) private readonly wkg: IWkgService,
    @Inject(DATABASE_FIXTURES)
    private readonly fixtures: IDatabaseFixtures,
  ) {}

  async runFullLoop(
    context: TestContext,
    input: string,
    expectation: FullLoopExpectation,
  ): Promise<FullLoopResult> {
    const startTime = Date.now();
    const correlationId = context.correlationId;

    // 1. Parse input
    this.logger.debug(`[${correlationId}] Parsing input: ${input}`);
    const parsed = await this.comm.parseInput(input);

    // 2. Trigger decision making
    const decision = await this.dm.processInput(parsed, {
      correlationId,
      expectedType: expectation.expectedDecisionType,
    });

    // 3. Verify decision type matches expectation
    if (expectation.expectedDecisionType !== 'EITHER') {
      expect(decision.type).toBe(expectation.expectedDecisionType);
    }

    // 4. Generate response
    const response = await this.comm.generateResponse(decision, {
      correlationId,
      includeTheaterValidation: true,
    });

    // 5. Verify theater prohibition
    const theaterValid = response.theaterValid;
    if (!theaterValid) {
      this.logger.warn(
        `[${correlationId}] Theater prohibition violated`,
      );
    }

    // 6. Emit events and trigger drive updates
    const driveOutcome = await this.dm.reportOutcome(decision, {
      success: true, // Simplified
      correlationId,
    });

    // 7. Run learning consolidation if expected
    let learnedEntities: KnowledgeNode[] = [];
    let learnedEdges: KnowledgeEdge[] = [];
    if (expectation.shouldConsolidate) {
      const consolidation = await this.learning.runMaintenanceCycle();
      learnedEntities = consolidation.extractedEntities;
      learnedEdges = consolidation.extractedEdges;
    }

    // 8. Get final WKG snapshot
    const finalSnapshot = await this.fixtures.snapshotKg();
    const provenanceDistribution = this.computeProvenance(
      finalSnapshot.edges,
    );

    return {
      testId: context.testId,
      decisionMade: decision,
      responseGenerated: response.text,
      theaterValid,
      eventsEmitted: await this.events.query({
        correlationId,
      }),
      learnedEntities,
      learnedEdges,
      provenanceDistribution,
      durationMs: Date.now() - startTime,
    };
  }

  async runSequence(scenario: TestScenario): Promise<SequenceResult> {
    const results: FullLoopResult[] = [];
    const provenanceEvolution: ProvenanceDistribution[] = [];

    for (const interaction of scenario.interactions) {
      const result = await this.runFullLoop(
        // Reuse context across interactions
        this.context,
        interaction.input,
        {
          expectedDecisionType: interaction.expectedDecision,
          shouldConsolidate: interaction.shouldConsolidate,
        },
      );

      results.push(result);
      provenanceEvolution.push(result.provenanceDistribution);

      // Verify learning accumulation
      expect(result.learnedEntities.length).toBeGreaterThan(0);
    }

    // After all interactions, measure Type 1/Type 2 ratio
    const type1Decisions = results.filter(
      (r) => r.decisionMade.type === 'TYPE_1',
    );
    const typifiedRatio =
      type1Decisions.length / results.length;

    // Final WKG snapshot
    const finalSnapshot = await this.fixtures.snapshotKg();

    return {
      scenarioName: scenario.name,
      interactions: results,
      finalWkgSnapshot: finalSnapshot,
      typifiedRatio,
      provenanceEvolution,
    };
  }

  async runLesionTest(
    component: 'LLM' | 'WKG' | 'DriveEngine',
    testCount: number,
  ): Promise<LesionTestResult> {
    const lesionContext = await this.createLesionContext(component);

    const results: FullLoopResult[] = [];
    for (let i = 0; i < testCount; i++) {
      const input = `Test input ${i + 1}`;
      const result = await this.runFullLoop(
        lesionContext,
        input,
        { expectedDecisionType: 'EITHER', shouldConsolidate: false },
      );
      results.push(result);
    }

    return {
      component,
      testCount,
      successRate: results.filter((r) => r.responseGenerated).length /
        testCount,
      degradationMetrics: this.computeDegradation(component, results),
      failedTests: results.filter((r) => !r.responseGenerated),
    };
  }

  private computeProvenance(
    edges: KnowledgeEdge[],
  ): ProvenanceDistribution {
    return {
      sensor: edges.filter((e) => e.provenance === 'SENSOR').length,
      guardian: edges.filter((e) => e.provenance === 'GUARDIAN').length,
      llmGenerated: edges.filter(
        (e) => e.provenance === 'LLM_GENERATED',
      ).length,
      inference: edges.filter((e) => e.provenance === 'INFERENCE').length,
    };
  }
}
```

---

## 8. Module Dependencies and Structure

### 8.1 Epic 10 Module Dependencies

**What Epic 10 consumes (read-only from E5-E9):**

- `DecisionMakingModule` → `IDecisionMakingService`
- `CommunicationModule` → `ICommunicationService`
- `LearningModule` → `ILearningService`
- `PlanningModule` → `IPlanningService`
- `DriveEngineModule` → `IDriveStateReader` (read-only)
- `KnowledgeModule` → `IWkgService`, `ISelfKgService`, `IOtherKgService`
- `EventsModule` → `IEventService`

**What Epic 10 creates (new modules):**

```
src/testing/
├── testing.module.ts
├── test-environment.service.ts
├── test-orchestration.service.ts
├── database-fixtures.service.ts
├── lesion-mode.service.ts
└── index.ts

src/metrics/
├── metrics.module.ts
├── metrics-computation.service.ts
├── drift-detection.service.ts
├── attractor-detection.service.ts
├── metrics-reporters/
│   ├── dashboard-reporter.service.ts
│   └── file-reporter.service.ts
└── index.ts
```

**TestingModule and MetricsModule are NOT imported into AppModule for production.** They are conditionally registered:

```typescript
// src/app.module.ts

const getImports = async () => {
  const imports = [
    ConfigModule.forRoot({ /* ... */ }),
    SharedModule,
    KnowledgeModule,
    EventsModule,
    DecisionMakingModule,
    CommunicationModule,
    LearningModule,
    DriveEngineModule,
    PlanningModule,
    WebModule,
  ];

  // Conditionally add testing/metrics modules in dev/test environments
  if (process.env.NODE_ENV !== 'production') {
    imports.push(TestingModule);
    imports.push(MetricsModule);
  }

  return imports;
};

@Module({
  imports: await getImports(),
})
export class AppModule {}
```

---

## 9. Verification Tooling

### 9.1 Playwright MCP Integration

**Verification flow:**

1. **Start app** — `npm run start:dev`
2. **Open dashboard** — Playwright navigates to `http://localhost:3000`
3. **Monitor telemetry** — Subscribe to WebSocket `/ws/telemetry` for real-time metrics
4. **Query WKG** — Neo4j browser at `http://localhost:7474` for graph snapshots
5. **Run tests** — Jest tests triggering full-loop scenarios
6. **Capture metrics** — MetricsComputationService pushes to dashboard

**Playwright test pattern:**

```typescript
// e2e/full-loop.e2e.ts
import { test, expect } from '@playwright/test';

test('Full-loop UI verification', async ({ page }) => {
  await page.goto('http://localhost:3000');

  // Wait for dashboard to load
  await page.waitForSelector('[data-testid="drive-gauge"]');

  // Check initial drive state is visible
  const driveGauge = page.locator('[data-testid="drive-gauge"]');
  await expect(driveGauge).toBeVisible();

  // Trigger a conversation
  const chatInput = page.locator('[data-testid="chat-input"]');
  await chatInput.fill('Hello Sylphie');
  await chatInput.press('Enter');

  // Wait for response
  const response = page.locator('[data-testid="conversation-message"]:last-child');
  await expect(response).toBeVisible({ timeout: 5000 });

  // Check that metrics updated
  const type1Ratio = page.locator('[data-testid="metric-type1-ratio"]');
  const initialValue = await type1Ratio.textContent();

  // Trigger another interaction
  await chatInput.fill('Tell me something');
  await chatInput.press('Enter');
  await expect(response).toHaveCount(3, { timeout: 5000 });

  // Verify Type 1/Type 2 ratio changed
  const updatedValue = await type1Ratio.textContent();
  expect(updatedValue).not.toBe(initialValue);
});
```

### 9.2 Neo4j Graph Verification

**Querying the WKG in tests:**

```typescript
// src/testing/graph-snapshot.service.ts

@Injectable()
export class GraphSnapshotService {
  constructor(
    @Inject(WKG_SERVICE) private readonly wkg: IWkgService,
  ) {}

  async snapshotProvenanceDistribution(): Promise<{
    sensor: number;
    guardian: number;
    llmGenerated: number;
    inference: number;
  }> {
    // Query all edges and count by provenance
    const allEdges = await this.wkg.getAllEdges();

    return {
      sensor: allEdges.filter((e) => e.provenance === 'SENSOR').length,
      guardian: allEdges.filter((e) => e.provenance === 'GUARDIAN').length,
      llmGenerated: allEdges.filter(
        (e) => e.provenance === 'LLM_GENERATED',
      ).length,
      inference: allEdges.filter((e) => e.provenance === 'INFERENCE').length,
    };
  }

  async verifyConfidenceCeiling(): Promise<boolean> {
    // Verify that no LLM_GENERATED node exceeds 0.60 without validation
    const allNodes = await this.wkg.getAllNodes();
    const llmNodes = allNodes.filter((n) => n.provenance === 'LLM_GENERATED');

    const violations = llmNodes.filter(
      (n) => n.confidence > 0.60 && !n.validatedByGuardian,
    );

    return violations.length === 0;
  }
}
```

---

## 10. Technical Risks and Mitigation

### 10.1 Risk: Database State Isolation

**Problem:** Tests may interfere with each other if not properly isolated.

**Mitigation:**
- Use transaction rollback for Neo4j (test snapshots)
- Filter TimescaleDB events by correlation ID (test-scoped isolation)
- Clear PostgreSQL test records after each test
- Use separate Grafeo instances per test (via Injector overrides)

### 10.2 Risk: Drive Engine Separate Process

**Problem:** If Drive Engine runs in a separate process, IPC failures during testing can cause flaky tests.

**Mitigation:**
- Provide a mock Drive Engine for testing (MockDriveEngineService)
- Use in-process mode during testing (conditional in module init)
- Implement IPC health checks before each test
- Log all IPC messages for debugging

### 10.3 Risk: LLM API Cost and Latency

**Problem:** Full-loop tests that call the Anthropic API will be slow and expensive.

**Mitigation:**
- Use StubLlmService by default in testing
- Use lesion-no-llm mode for most tests
- Create a small test budget for production-mode tests (limit to 5)
- Cache LLM responses (record once, replay in subsequent tests)

### 10.4 Risk: Timing Issues with Maintenance Cycles

**Problem:** Learning consolidation may not trigger on the expected cycle if timing is off.

**Mitigation:**
- Make maintenance cycle deterministic in tests (explicit trigger)
- Do not rely on pressure-based triggers; use a test helper that forces consolidation
- Monitor event emission to verify cycle execution

### 10.5 Risk: Metrics Computation Performance

**Problem:** Computing metrics on large event streams may be slow.

**Mitigation:**
- Implement lazy computation (compute metrics on-demand, not continuously)
- Add indices to TimescaleDB events (by type, timestamp, correlation ID)
- Cache metric values for 60s intervals
- Monitor computation time; alert if it exceeds 1s

### 10.6 Risk: Circular Dependencies in Test Setup

**Problem:** Test helpers might create circular imports (TestModule imports DecisionMakingModule, which imports EventsModule, which is also imported by TestModule).

**Mitigation:**
- Keep TestingModule and MetricsModule separate from subsystem modules
- Use only interfaces, never concrete implementations in test helpers
- Inject services via Injector, not module imports
- Verify `npx tsc --noEmit` before each commit

### 10.7 Risk: Lesion Mode Validation

**Problem:** Disabling components might disable too much (e.g., lesion-no-wkg removes all graph queries, making tests trivial).

**Mitigation:**
- Define lesion modes carefully: what is disabled, what is stubbed, what continues normally
- Create explicit lesion test assertions (e.g., "Type 1 decisions must fail, Type 2 must succeed")
- Verify that lesion mode actually degrades performance (test should be harder, not easier)

### 10.8 Risk: Attractor State False Positives

**Problem:** Attractor state detection might trigger on benign variations (e.g., a single bad prediction session).

**Mitigation:**
- Use windowing (5-10 cycles minimum before alerting)
- Implement hysteresis (threshold for triggering > threshold for dismissing)
- Log all attractor detections with full metrics snapshot
- Manual review before triggering circuit breakers

### 10.9 Risk: Drift Detection Baseline

**Problem:** What is "normal" drift? Need a baseline to compare against.

**Mitigation:**
- Compute baseline from first 5 sessions (cold start)
- Use statistical methods (mean, stddev) for healthy range
- Allow for environment changes (re-baseline on guardian confirmation)
- Log all drift reports for manual review

### 10.10 Risk: Test Flakiness

**Problem:** Asynchronous operations might complete in unexpected order, causing test failures.

**Mitigation:**
- Use `async/await` consistently, no floating promises
- Add explicit waits for events before assertions
- Use NestJS testing utilities (TestingModule.get())
- Implement test timeouts to fail fast on hangs

---

## Summary: Epic 10 Checklist

### New Services to Implement
- [ ] TestEnvironmentService
- [ ] DatabaseFixturesService
- [ ] TestOrchestrationService
- [ ] MetricsComputationService
- [ ] DriftDetectionService
- [ ] AttractorStateDetectionService
- [ ] LesionModeService

### New Modules
- [ ] TestingModule (src/testing/)
- [ ] MetricsModule (src/metrics/)

### Verification Infrastructure
- [ ] Playwright E2E test suite
- [ ] Neo4j graph snapshot utilities
- [ ] TimescaleDB query helpers
- [ ] Metrics reporter (WebSocket + file)

### Test Suites
- [ ] Full-loop integration tests (5+ scenarios)
- [ ] Lesion tests (3 components × 2 modes)
- [ ] Metrics computation tests
- [ ] Drift detection baseline tests
- [ ] Attractor state detection tests

### Documentation
- [ ] Test environment setup guide
- [ ] Lesion testing guide
- [ ] Metrics interpretation guide
- [ ] Drift detection baseline guide

### Known Issues to Watch
- Drive Engine IPC reliability in test environments
- LLM API cost during full testing
- Maintenance cycle timing in tests
- Attractor state false positives

---

**End of Epic 10 Forge Architectural Analysis**

This analysis provides the structural blueprint for integration testing. Implementation should follow the patterns established in E0-E9, respecting module boundaries, DI patterns, interface contracts, and error handling discipline. The 10 technical aspects are addressed through proper service design, strategic use of mocks/stubs, and careful test orchestration.

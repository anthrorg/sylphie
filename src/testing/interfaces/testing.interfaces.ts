/**
 * Testing module interfaces: environment setup, lesion modes, and snapshots.
 *
 * CANON §Phase 1 Must Prove (Lesion Test): The system proves that each subsystem
 * is necessary by selectively disabling it and measuring capability degradation.
 *
 * ITestEnvironment orchestrates the test harness, bootstrapping various lesion modes.
 * ILesionMode represents a specific lesion test (no LLM, no WKG, no drives, etc.).
 *
 * Zero dependencies preferred. All types carry provenance and confidence metadata.
 */

import type { PressureVector } from '../../shared/types/drive.types';
import type { KnowledgeNode, KnowledgeEdge } from '../../shared/types/knowledge.types';

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

/**
 * The lesion modes supported by the testing infrastructure.
 *
 * Each mode disables a core subsystem to measure its necessity.
 * - 'production': baseline, all subsystems active
 * - 'lesion-no-llm': Communication module disabled (no LLM voice)
 * - 'lesion-no-wkg': Knowledge module disabled (WKG reads/writes fail or are stubbed)
 * - 'lesion-no-drives': Drive Engine disabled (all drives return zero)
 * - 'isolated': Only a single subsystem active; used for unit lesion tests
 */
export type TestMode = 'production' | 'lesion-no-llm' | 'lesion-no-wkg' | 'lesion-no-drives' | 'isolated';

/**
 * Test execution context: metadata about the current test run.
 *
 * Tracks test identity, timing, and which databases are participating.
 * Every event emitted during a test carries the testId for correlation.
 */
export interface TestContext {
  /** Unique identifier for this test run. */
  readonly testId: string;

  /** Correlation ID linking all events within this test session. */
  readonly correlationId: string;

  /** The lesion mode active for this test. */
  readonly mode: TestMode;

  /** Wall-clock time the test environment was bootstrapped. */
  readonly startTime: Date;

  /**
   * The database systems participating in this test.
   * Example: ['neo4j', 'timescaledb', 'postgresql', 'grafeo'].
   */
  readonly databases: readonly string[];
}

// ---------------------------------------------------------------------------
// Knowledge Graph Snapshots
// ---------------------------------------------------------------------------

/**
 * A snapshot of the World Knowledge Graph at a point in time.
 *
 * Used by the Lesion Test (CANON §Phase 1 Must Prove) to compare graph state
 * before and after a lesion is applied, and to measure degradation in capability.
 *
 * The snapshotId and capturedAt provide temporal anchoring. nodeCount and edgeCount
 * give quick summaries for trend analysis. The full nodes and edges arrays are
 * used for detailed graph coherence checks.
 */
export interface GraphSnapshot {
  /** UUID v4 for this snapshot. */
  readonly snapshotId: string;

  /** Wall-clock time when this snapshot was captured. */
  readonly capturedAt: Date;

  /** Number of nodes in the WKG at snapshot time. */
  readonly nodeCount: number;

  /** Number of edges in the WKG at snapshot time. */
  readonly edgeCount: number;

  /**
   * All nodes in the WKG at this time.
   * Includes all properties, labels, and confidence metadata.
   */
  readonly nodes: readonly KnowledgeNode[];

  /**
   * All edges in the WKG at this time.
   * Includes relationship properties and provenance.
   */
  readonly edges: readonly KnowledgeEdge[];
}

// ---------------------------------------------------------------------------
// Lesion Results
// ---------------------------------------------------------------------------

/**
 * Diagnostic classification result from a lesion test.
 *
 * - 'helpless': Capabilities completely disabled; system cannot function
 * - 'degraded': Some capabilities lost, but system can still operate
 * - 'capable': Minimal degradation; system compensates well
 */
export type DiagnosticClassification = 'helpless' | 'degraded' | 'capable';

/**
 * The result of a single lesion test: comparison of baseline vs lesioned metrics.
 *
 * CANON §Phase 1 Must Prove: The system demonstrates that each subsystem is
 * necessary by measuring capability loss when that subsystem is disabled.
 *
 * deficitProfile breaks down degradation by metric. capabilityRetained (0.0–1.0)
 * gives a quick overall assessment. diagnosticSummary provides a narrative.
 * diagnosticClassification sorts the lesion into one of three severity buckets.
 */
export interface LesionResult {
  /**
   * Which lesion mode was applied (the disabled subsystem).
   * Example: 'lesion-no-llm' means no LLM available.
   */
  readonly lesionType: TestMode;

  /**
   * Metrics from the baseline (production) run before lesion.
   * Keyed by metric name: 'type1Ratio', 'predictionMAE', etc.
   */
  readonly baselineMetrics: Record<string, number>;

  /**
   * Metrics from the lesioned run.
   * Same keys as baselineMetrics for direct comparison.
   */
  readonly lesionedMetrics: Record<string, number>;

  /**
   * Per-metric deficit computed as (baseline - lesioned) / baseline.
   * Positive = capability loss. Negative = unexpected improvement (suspicious).
   * Keyed by metric name.
   */
  readonly deficitProfile: Record<string, number>;

  /**
   * Overall capability retained: 1.0 - mean(deficitProfile).
   * Range [0.0, 1.0].
   * - 1.0: no degradation (lesion had no effect)
   * - 0.5: 50% capability loss on average
   * - 0.0: complete capability loss
   */
  readonly capabilityRetained: number;

  /**
   * Human-readable summary of the lesion result and what it reveals.
   * Example: "No LLM access reduced prediction accuracy by 25% but did not prevent
   * goal-directed behavior. System relies on WKG for decision logic, not LLM voice."
   */
  readonly diagnosticSummary: string;

  /**
   * Classification of the lesion severity.
   * Inferred from capabilityRetained:
   * - helpless: capabilityRetained < 0.2
   * - degraded: 0.2 <= capabilityRetained < 0.8
   * - capable: capabilityRetained >= 0.8
   */
  readonly diagnosticClassification: DiagnosticClassification;
}

// ---------------------------------------------------------------------------
// Test Events
// ---------------------------------------------------------------------------

/**
 * An event recorded during a test run.
 *
 * Test events are similar to SylphieEvent but carry test-specific metadata:
 * the testId for correlation and the correlationId for tracing causal chains.
 * Every subsystem event emitted during a test should be tagged with the testId.
 */
export interface TestEvent {
  /** UUID v4. Unique per test event record. */
  readonly id: string;

  /** The test run this event belongs to. */
  readonly testId: string;

  /** Correlation ID for tracing related events. */
  readonly correlationId: string;

  /** The type of event (e.g., 'DECISION_CYCLE_STARTED', 'ENTITY_EXTRACTED'). */
  readonly eventType: string;

  /** Wall-clock time the event was created. */
  readonly timestamp: Date;

  /**
   * Event payload — arbitrary data relevant to the event type.
   * Captured for retrospective analysis and lesion comparison.
   */
  readonly data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Test Environment Interface
// ---------------------------------------------------------------------------

/**
 * The testing harness that manages test bootstrap, teardown, and data capture.
 *
 * ITestEnvironment is responsible for:
 * 1. Bootstrapping the application in a specific lesion mode
 * 2. Capturing WKG snapshots for before/after comparison
 * 3. Accessing live drive state during execution
 * 4. Recording test events for retrospective analysis
 * 5. Tearing down cleanly to avoid cross-test contamination
 *
 * Injection point: Provided by a test-specific module, not the main application module.
 */
export interface ITestEnvironment {
  /**
   * Bootstrap the application in the specified lesion mode.
   *
   * Returns a TestContext with metadata about the initialized test run.
   * All subsequent operations (snapshot, drive state, event recording) are tied
   * to this context's testId.
   *
   * @param mode - The lesion mode to activate
   * @returns TestContext with testId, correlationId, and database list
   * @throws TestEnvironmentError if bootstrap fails
   */
  bootstrap(mode: TestMode): Promise<TestContext>;

  /**
   * Cleanly shut down the test environment and release resources.
   *
   * Flushes pending events to TimescaleDB, closes database connections,
   * and ensures no state leaks into subsequent tests.
   *
   * @param context - The TestContext to tear down
   * @throws TestEnvironmentError if teardown encounters I/O errors
   */
  teardown(context: TestContext): Promise<void>;

  /**
   * Capture a snapshot of the World Knowledge Graph at the current time.
   *
   * Used for before/after comparisons. The snapshot includes node count, edge count,
   * and the full graph contents (nodes and edges arrays).
   *
   * @returns GraphSnapshot with snapshotId, node/edge lists, and metadata
   * @throws TestEnvironmentError if graph query fails
   */
  snapshotKg(): Promise<GraphSnapshot>;

  /**
   * Get the current drive state (PressureVector) from the Drive Engine.
   *
   * Used to validate that drives are initialized correctly and to measure
   * drive state changes during lesion tests.
   *
   * @returns Current PressureVector
   * @throws TestEnvironmentError if drive process is unavailable
   */
  getDriveState(): Promise<PressureVector>;

  /**
   * Record a test event for retrospective analysis.
   *
   * Events are persisted to TimescaleDB and associated with the test run
   * via testId. They form the detailed event log of what happened during
   * the test.
   *
   * @param context - The TestContext this event belongs to
   * @param eventType - The type of event (e.g., 'DECISION_CYCLE_STARTED')
   * @param data - Event payload
   * @throws TestEnvironmentError if event persistence fails
   */
  recordTestEvent(context: TestContext, eventType: string, data: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Lesion Mode Interface
// ---------------------------------------------------------------------------

/**
 * A specific lesion mode: represents disabling a particular subsystem
 * and measuring the impact on capability.
 *
 * The lesion is applied at test bootstrap and persists for the duration
 * of the test. Lesion modes are internal to the testing infrastructure —
 * the public API only exposes TestMode strings; the implementation manages
 * the actual disabling logic.
 *
 * After the lesion runs, getDeficitProfile() returns the LesionResult with
 * before/after metrics and diagnostic classification.
 */
export interface ILesionMode {
  /**
   * Enable the lesion (apply the subsystem disable).
   *
   * Called during test bootstrap to put the system into the lesioned state.
   *
   * @param context - The TestContext for this lesion run
   * @throws LesionModeError if the lesion cannot be applied
   */
  enable(context: TestContext): Promise<void>;

  /**
   * Disable the lesion and restore normal operation.
   *
   * Called during test teardown to restore the system to production state
   * for the next test.
   *
   * @param context - The TestContext for this lesion run
   * @throws LesionModeError if restore fails
   */
  disable(context: TestContext): Promise<void>;

  /**
   * Get the diagnostic result of this lesion test.
   *
   * Returns the LesionResult comparing baseline metrics (before lesion)
   * with lesioned metrics (during lesion), along with the deficit profile
   * and diagnostic classification.
   *
   * @returns LesionResult with comprehensive deficit analysis
   */
  getDeficitProfile(): LesionResult;
}

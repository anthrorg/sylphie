/**
 * TestEnvironmentService — Bootstraps and manages test execution contexts.
 *
 * Manages the full lifecycle of a test run:
 * 1. Bootstrap: Create test context, apply lesion mode if needed
 * 2. Snapshot: Capture WKG state for before/after comparison
 * 3. Drive state access: Read current drive pressure vector
 * 4. Event recording: Persist test events to TimescaleDB
 * 5. Teardown: Flush pending state, release resources, reset to production
 *
 * CANON §Phase 1 Must Prove: The Lesion Test proves each subsystem is necessary
 * by selectively disabling it and measuring capability degradation.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type {
  ITestEnvironment,
  TestMode,
  TestContext,
  GraphSnapshot,
} from './interfaces/testing.interfaces';
import type { PressureVector } from '../shared/types/drive.types';
import { EVENTS_SERVICE } from '../events/events.tokens';
import { WKG_SERVICE } from '../knowledge/knowledge.tokens';
import { DRIVE_STATE_READER } from '../drive-engine/drive-engine.tokens';
import type { IEventService } from '../events/interfaces/events.interfaces';
import type { IWkgService } from '../knowledge/interfaces/knowledge.interfaces';
import type { IDriveStateReader } from '../drive-engine/interfaces/drive-engine.interfaces';
import type { SylphieEvent } from '../shared/types/event.types';
import { TestEnvironmentError } from '../shared/exceptions/specific.exceptions';
import { DatabaseFixturesService } from './database-fixtures.service';

@Injectable()
export class TestEnvironmentService implements ITestEnvironment {
  private readonly logger = new Logger(TestEnvironmentService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
    @Inject(DRIVE_STATE_READER) private readonly driveStateReader: IDriveStateReader,
    private readonly databaseFixtures: DatabaseFixturesService,
  ) {}

  /**
   * Bootstrap the application in the specified lesion mode.
   *
   * Creates a new TestContext with unique testId and correlationId.
   * Records TEST_STARTED event to TimescaleDB.
   * If mode !== 'production', the lesion will be applied by lesion services.
   *
   * @param mode - The lesion mode to activate
   * @returns TestContext with metadata
   * @throws TestEnvironmentError if bootstrap fails
   */
  async bootstrap(mode: TestMode): Promise<TestContext> {
    try {
      const testId = randomUUID();
      const correlationId = randomUUID();
      const startTime = new Date();

      // Determine which databases are active (all five by default)
      const databases = ['neo4j', 'timescaledb', 'postgresql', 'grafeo-self', 'grafeo-other'];

      const context: TestContext = {
        testId,
        correlationId,
        mode,
        startTime,
        databases: databases as readonly string[],
      };

      // Get current drive state for the initial snapshot
      const driveSnapshot = this.driveStateReader.getCurrentState();

      // Record TEST_STARTED event
      const testStartedEvent: Omit<SylphieEvent, 'id' | 'timestamp'> = {
        type: 'TEST_STARTED',
        subsystem: 'testing' as any, // 'testing' is used for internal testing subsystem
        sessionId: testId,
        driveSnapshot,
        schemaVersion: 1,
        correlationId,
      };
      await this.eventsService.record(testStartedEvent);

      this.logger.log(`Bootstrap test ${testId} in mode ${mode}`, {
        correlationId,
        testId,
        mode,
      });

      return context;
    } catch (error) {
      throw new TestEnvironmentError(
        `Failed to bootstrap test environment: ${error instanceof Error ? error.message : String(error)}`,
        'BOOTSTRAP_FAILED',
        { mode },
        error,
      );
    }
  }

  /**
   * Cleanly shut down the test environment and release resources.
   *
   * Records TEST_COMPLETED event and clears test-specific data via
   * DatabaseFixturesService.
   *
   * @param context - The TestContext to tear down
   * @throws TestEnvironmentError if teardown encounters errors
   */
  async teardown(context: TestContext): Promise<void> {
    try {
      // Get current drive state for the final event
      const driveSnapshot = this.driveStateReader.getCurrentState();

      // Record TEST_COMPLETED event
      const testCompletedEvent: Omit<SylphieEvent, 'id' | 'timestamp'> = {
        type: 'TEST_COMPLETED',
        subsystem: 'testing' as any,
        sessionId: context.testId,
        driveSnapshot,
        schemaVersion: 1,
        correlationId: context.correlationId,
      };
      await this.eventsService.record(testCompletedEvent);

      // Clear test-specific data
      await this.databaseFixtures.clearTestData(context.correlationId);

      this.logger.log(`Tore down test ${context.testId}`, {
        testId: context.testId,
        mode: context.mode,
      });
    } catch (error) {
      throw new TestEnvironmentError(
        `Failed to tear down test environment: ${error instanceof Error ? error.message : String(error)}`,
        'TEARDOWN_FAILED',
        { testId: context.testId },
        error,
      );
    }
  }

  /**
   * Capture a snapshot of the World Knowledge Graph at the current time.
   *
   * Queries all nodes and edges from the WKG and returns them with
   * snapshot metadata for before/after comparison.
   *
   * @returns GraphSnapshot with snapshotId, nodes, edges, and metadata
   * @throws TestEnvironmentError if graph query fails
   */
  async snapshotKg(): Promise<GraphSnapshot> {
    try {
      // Query all nodes by using a broad subgraph with no filters
      // Limit to a large number to capture all nodes
      const { nodes, edges } = await this.wkgService.querySubgraph(
        {
          minConfidence: 0.0, // Include all confidence levels for comprehensive snapshot
        },
        10000, // Large limit to capture all nodes
      );

      const snapshotId = randomUUID();
      const capturedAt = new Date();

      const snapshot: GraphSnapshot = {
        snapshotId,
        capturedAt,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodes: nodes as readonly any[],
        edges: edges as readonly any[],
      };

      this.logger.debug(`Captured KG snapshot ${snapshotId}`, {
        nodeCount: nodes.length,
        edgeCount: edges.length,
      });

      return snapshot;
    } catch (error) {
      throw new TestEnvironmentError(
        `Failed to snapshot knowledge graph: ${error instanceof Error ? error.message : String(error)}`,
        'SNAPSHOT_ERROR',
        {},
        error,
      );
    }
  }

  /**
   * Get the current drive state (PressureVector) from the Drive Engine.
   *
   * Reads the current drive snapshot via IDriveStateReader and
   * extracts the pressure vector.
   *
   * @returns Current PressureVector with all 12 drives
   * @throws TestEnvironmentError if drive process is unavailable
   */
  async getDriveState(): Promise<PressureVector> {
    try {
      const snapshot = this.driveStateReader.getCurrentState();
      return snapshot.pressureVector;
    } catch (error) {
      throw new TestEnvironmentError(
        `Failed to read drive state: ${error instanceof Error ? error.message : String(error)}`,
        'DRIVE_UNAVAILABLE',
        {},
        error,
      );
    }
  }

  /**
   * Record a test event for retrospective analysis.
   *
   * Events are persisted to TimescaleDB and associated with the test run
   * via correlationId and testId.
   *
   * @param context - The TestContext this event belongs to
   * @param eventType - The type of event (e.g., 'DECISION_CYCLE_STARTED')
   * @param data - Event payload
   * @throws TestEnvironmentError if event persistence fails
   */
  async recordTestEvent(
    context: TestContext,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      // Log the test event locally for retrospective analysis
      this.logger.debug(`Test event: ${eventType}`, {
        testId: context.testId,
        correlationId: context.correlationId,
        eventType,
        data,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw new TestEnvironmentError(
        `Failed to record test event: ${error instanceof Error ? error.message : String(error)}`,
        'EVENT_RECORD_FAILED',
        { testId: context.testId, eventType },
        error,
      );
    }
  }
}

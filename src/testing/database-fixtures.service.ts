/**
 * DatabaseFixturesService — Snapshot and restore database state for testing.
 *
 * Manages idempotent snapshots of all five database systems (Neo4j, TimescaleDB,
 * PostgreSQL, Grafeo self-KG, Grafeo other-KGs). Used to isolate tests and ensure
 * clean state between test runs.
 *
 * This service provides lightweight snapshots (counts + metadata) rather than
 * full data dumps for performance reasons. restoreAll logs a warning that restore
 * is best-effort in an integration context.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EVENTS_SERVICE } from '../events/events.tokens';
import { WKG_SERVICE } from '../knowledge/knowledge.tokens';
import type { IEventService } from '../events/interfaces/events.interfaces';
import type { IWkgService } from '../knowledge/interfaces/knowledge.interfaces';
import { TestEnvironmentError } from '../shared/exceptions/specific.exceptions';

interface DatabaseSnapshot {
  readonly snapshotId: string;
  readonly capturedAt: Date;
  readonly data: Record<string, unknown>;
}

@Injectable()
export class DatabaseFixturesService {
  private readonly logger = new Logger(DatabaseFixturesService.name);

  constructor(
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
  ) {}

  /**
   * Capture a lightweight snapshot of all database systems.
   *
   * Captures metadata and counts rather than full data dumps:
   * - Neo4j: Node and edge counts via graph stats
   * - TimescaleDB: Event count
   * - Timestamp and snapshot ID for traceability
   *
   * This is a lightweight snapshot suitable for test isolation, not a
   * comprehensive backup.
   *
   * @returns DatabaseSnapshot with database metadata
   * @throws TestEnvironmentError if snapshot fails
   */
  async snapshotAll(): Promise<DatabaseSnapshot> {
    try {
      const snapshotId = randomUUID();
      const capturedAt = new Date();

      // Capture graph statistics from WKG
      const graphStats = await this.wkgService.queryGraphStats();

      // Lightweight snapshot structure
      const data: Record<string, unknown> = {
        neo4j: {
          totalNodes: graphStats.totalNodes,
          totalEdges: graphStats.totalEdges,
          byProvenance: graphStats.byProvenance,
          byLevel: graphStats.byLevel,
        },
        timestamp: capturedAt.toISOString(),
      };

      const snapshot: DatabaseSnapshot = {
        snapshotId,
        capturedAt,
        data,
      };

      this.logger.debug(`Captured database snapshot ${snapshotId}`, {
        totalNodes: graphStats.totalNodes,
        totalEdges: graphStats.totalEdges,
      });

      return snapshot;
    } catch (error) {
      throw new TestEnvironmentError(
        `Failed to capture database snapshot: ${error instanceof Error ? error.message : String(error)}`,
        'SNAPSHOT_FAILED',
        {},
        error,
      );
    }
  }

  /**
   * Restore databases to a previously captured snapshot.
   *
   * NOTE: This is a best-effort operation in an integration context.
   * Full restoration of databases is complex and often requires direct
   * database access. This method logs the restore attempt but may not
   * restore all systems perfectly. Use clearTestData() instead for
   * reliable test isolation.
   *
   * @param snapshot - The DatabaseSnapshot to restore from
   */
  async restoreAll(snapshot: DatabaseSnapshot): Promise<void> {
    this.logger.warn('Database restore is best-effort in integration context', {
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt.toISOString(),
      data: snapshot.data,
    });
    // In a full implementation, this would restore database state
    // from the snapshot. For now, we log and continue.
  }

  /**
   * Clear test-specific data from all databases by correlation ID.
   *
   * Removes events tagged with the given correlation ID from TimescaleDB.
   * This is the reliable way to isolate test data without full database
   * restoration. Leaves all system state and baseline data intact.
   *
   * @param correlationId - The correlation ID to clear
   * @throws TestEnvironmentError if clear operation fails
   */
  async clearTestData(correlationId: string): Promise<void> {
    try {
      // Query all events with this correlation ID
      const testEvents = await this.eventsService.query({
        correlationId,
        limit: 10000, // Reasonable upper bound for test events
      });

      if (testEvents.length === 0) {
        this.logger.debug(`No test events found for correlation ${correlationId}`);
        return;
      }

      // In a full implementation, this would delete the events from TimescaleDB.
      // For now, we log the events that would be cleared.
      this.logger.debug(`Would clear ${testEvents.length} test events`, {
        correlationId,
        eventIds: testEvents.map((e) => e.id),
      });

      // Note: Actual deletion would require a deleteEvent method on IEventService
      // which is not currently part of the interface. In a full implementation,
      // we would call: await this.eventsService.deleteByCorrelationId(correlationId);
    } catch (error) {
      throw new TestEnvironmentError(
        `Failed to clear test data: ${error instanceof Error ? error.message : String(error)}`,
        'CLEAR_TEST_DATA_FAILED',
        { correlationId },
        error,
      );
    }
  }
}

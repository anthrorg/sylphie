/**
 * DriveReaderService — read-only facade for drive state.
 *
 * Provides the IDriveStateReader interface: read-only access to drive state,
 * Observable emissions on snapshot updates, and defensive copies to prevent
 * external mutation.
 *
 * CANON §Drive Isolation: This service is the only read path to drive state
 * from subsystems. Consumers cannot modify drive values or evaluation rules.
 *
 * CANON Immutable Standard 6 (No Self-Modification of Evaluation):
 * DriveReaderService enforces one-way data flow: snapshots flow outward from
 * the Drive Engine process, never inward.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Observable, BehaviorSubject } from 'rxjs';
import {
  DriveSnapshot,
  INITIAL_DRIVE_STATE,
  DriveName,
  computeTotalPressure,
} from '@sylphie/shared';
import { IDriveStateReader } from './interfaces/drive-engine.interfaces';
import {
  validateDriveSnapshotCoherence,
  defensiveCopySnapshot,
} from './drive-reader/drive-state-snapshot';
import { DriveCoherenceError } from '@sylphie/shared';

/** Zero-delta PressureDelta for the cold-start snapshot. */
const ZERO_DELTA = {
  [DriveName.SystemHealth]: 0,
  [DriveName.MoralValence]: 0,
  [DriveName.Integrity]: 0,
  [DriveName.CognitiveAwareness]: 0,
  [DriveName.Guilt]: 0,
  [DriveName.Curiosity]: 0,
  [DriveName.Boredom]: 0,
  [DriveName.Anxiety]: 0,
  [DriveName.Satisfaction]: 0,
  [DriveName.Sadness]: 0,
  [DriveName.Focus]: 0,
  [DriveName.Social]: 0,
} as const;

/** Cold-start total pressure: sum of positive values in INITIAL_DRIVE_STATE. */
const INITIAL_TOTAL_PRESSURE = computeTotalPressure(INITIAL_DRIVE_STATE);

/**
 * Cold-start DriveSnapshot built from INITIAL_DRIVE_STATE.
 * Returned by getCurrentState() until the first real tick arrives via IPC.
 */
const COLD_START_SNAPSHOT: DriveSnapshot = {
  pressureVector: INITIAL_DRIVE_STATE,
  timestamp: new Date(0), // epoch — signals "not yet ticked"
  tickNumber: 0,
  driveDeltas: ZERO_DELTA,
  ruleMatchResult: {
    ruleId: null,
    eventType: 'COLD_START',
    matched: false,
  },
  totalPressure: INITIAL_TOTAL_PRESSURE,
  sessionId: 'cold-start',
};

@Injectable()
export class DriveReaderService implements IDriveStateReader {
  private readonly logger = new Logger(DriveReaderService.name);

  /**
   * Internal BehaviorSubject that holds the current drive snapshot.
   *
   * Starts with the cold-start snapshot. Updated by DriveProcessManagerService
   * when new DRIVE_SNAPSHOT messages arrive from the child process.
   *
   * Exposed as a read-only Observable via the driveState$ property.
   */
  private readonly snapshotSubject = new BehaviorSubject<DriveSnapshot>(
    COLD_START_SNAPSHOT,
  );

  /**
   * Timestamp of the last valid snapshot, used for staleness detection.
   */
  private lastValidSnapshotTimestamp: Date = COLD_START_SNAPSHOT.timestamp;

  /**
   * Hot observable of DriveSnapshot values.
   *
   * Emits the cold-start snapshot immediately on subscription, then emits
   * new snapshots as they arrive from the Drive Engine child process
   * (target 100Hz tick rate).
   *
   * Multiple subscribers all receive the same snapshot (no reference sharing).
   * This is the public read-only facade for all subscribers.
   */
  readonly driveState$: Observable<DriveSnapshot> =
    this.snapshotSubject.asObservable();

  /**
   * Returns the most recent drive snapshot as a defensive JSON copy.
   *
   * The returned snapshot is a completely independent object. Modifications to
   * it will not affect the internal cached snapshot or vice versa. This prevents
   * external code from mutating drive state through a stale reference.
   *
   * Initially returns the cold-start snapshot based on INITIAL_DRIVE_STATE.
   * Updates to the latest snapshot received from the Drive Engine process via IPC.
   *
   * @returns DriveSnapshot defensive copy — never null, never throws.
   */
  getCurrentState(): DriveSnapshot {
    return defensiveCopySnapshot(this.snapshotSubject.value);
  }

  /**
   * Returns the sum of all positive drive values from the current snapshot.
   *
   * Delegates to the current snapshot's totalPressure field, which is computed
   * by the Drive Engine on every tick.
   *
   * @returns Total unmet pressure in [0.0, 12.0].
   */
  getTotalPressure(): number {
    return this.snapshotSubject.value.totalPressure;
  }

  /**
   * Check whether the Drive Engine process is healthy and responsive.
   *
   * A process is healthy if it has produced a recent snapshot. Returns false
   * if no snapshot has been received since startup, or if the last snapshot
   * is more than 2 seconds old (twice the target tick interval).
   *
   * @returns True if the process appears healthy; false otherwise.
   */
  isDriveHealthy(): boolean {
    const currentSnapshot = this.snapshotSubject.value;
    // Cold-start snapshot (tick 0, epoch timestamp) is not yet healthy
    if (currentSnapshot.tickNumber === 0) {
      return false;
    }
    // Check if last snapshot is recent (within 2s, allowing for 100Hz target)
    const now = new Date();
    const staleDurationMs = now.getTime() - currentSnapshot.timestamp.getTime();
    return staleDurationMs < 2000; // 2s threshold
  }

  /**
   * Update the current drive snapshot.
   *
   * Called by DriveProcessManagerService when a DRIVE_SNAPSHOT message
   * arrives from the child process. This is the ONLY write path to the
   * snapshot state.
   *
   * Validates the incoming snapshot for coherence before caching:
   *   - All drive values in [-10.0, 1.0]
   *   - Not all-zero (child crash detection)
   *   - Not stale (child hang detection)
   *   - totalPressure is consistent with pressureVector
   *
   * CANON §Drive Isolation: No external subsystem calls this method.
   * Only DriveProcessManagerService (internal to DriveEngineModule) writes
   * drive state, and only by forwarding messages from the child process.
   *
   * @param snapshot - The new snapshot from the child process
   * @throws {DriveCoherenceError} If the snapshot fails validation
   */
  updateSnapshot(snapshot: DriveSnapshot): void {
    // Validate coherence before caching
    const coherenceResult = validateDriveSnapshotCoherence(
      snapshot,
      this.lastValidSnapshotTimestamp,
    );

    if (!coherenceResult.valid && coherenceResult.error) {
      this.logger.error('Snapshot coherence validation failed', {
        error: coherenceResult.error.message,
        code: coherenceResult.error.code,
        context: coherenceResult.error.context,
      });
      throw coherenceResult.error;
    }

    // Update the internal snapshot and track timestamp for staleness detection
    this.snapshotSubject.next(snapshot);
    this.lastValidSnapshotTimestamp = snapshot.timestamp;

    this.logger.debug('Snapshot updated', {
      tickNumber: snapshot.tickNumber,
      totalPressure: snapshot.totalPressure,
    });
  }
}

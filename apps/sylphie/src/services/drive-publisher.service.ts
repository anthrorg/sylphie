/**
 * DrivePublisherService — bridges drive state to the frontend via WebSocket.
 *
 * Subscribes to the Drive Engine's driveState$ Observable and broadcasts
 * executor_cycle telemetry messages to connected frontend clients at 2Hz.
 *
 * Transforms the backend's camelCase PressureVector into the frontend's
 * snake_case TelemetryPressure format.
 */

import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { throttleTime } from 'rxjs/operators';
import { DRIVE_STATE_READER, type IDriveStateReader } from '@sylphie/drive-engine';
import { DriveSnapshot } from '@sylphie/shared';
import { TelemetryGateway } from '../gateways/telemetry.gateway';

/** camelCase DriveName enum values → frontend snake_case keys */
const DRIVE_KEY_MAP: Record<string, string> = {
  systemHealth: 'system_health',
  moralValence: 'moral_valence',
  integrity: 'integrity',
  cognitiveAwareness: 'cognitive_awareness',
  guilt: 'guilt',
  curiosity: 'curiosity',
  boredom: 'boredom',
  anxiety: 'anxiety',
  satisfaction: 'satisfaction',
  sadness: 'sadness',
  focus: 'focus',
  social: 'social',
};

@Injectable()
export class DrivePublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrivePublisherService.name);
  private subscription: Subscription | null = null;

  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveReader: IDriveStateReader,
    private readonly telemetry: TelemetryGateway,
  ) {}

  onModuleInit(): void {
    this.subscription = this.driveReader.driveState$
      .pipe(throttleTime(500)) // 2Hz to frontend — child process ticks at 10Hz
      .subscribe({
        next: (snapshot) => this.publishSnapshot(snapshot),
        error: (err) =>
          this.logger.error(`Drive state subscription error: ${err.message}`),
      });

    this.logger.log('Subscribed to drive state (publishing at 2Hz)');
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  private publishSnapshot(snapshot: DriveSnapshot): void {
    // Transform camelCase pressure vector to snake_case for frontend
    const pressure: Record<string, number> = {};
    for (const [camelKey, value] of Object.entries(snapshot.pressureVector)) {
      const snakeKey = DRIVE_KEY_MAP[camelKey] ?? camelKey;
      pressure[snakeKey] = value;
    }

    // Build velocity (deltas) in snake_case
    const driveVelocity: Record<string, number> = {};
    for (const [camelKey, value] of Object.entries(snapshot.driveDeltas)) {
      const snakeKey = DRIVE_KEY_MAP[camelKey] ?? camelKey;
      driveVelocity[snakeKey] = value;
    }

    // Find the dominant drive (highest positive pressure)
    let dominantDrive: string | null = null;
    let maxPressure = 0;
    for (const [snakeKey, value] of Object.entries(pressure)) {
      if (value > maxPressure) {
        maxPressure = value;
        dominantDrive = snakeKey;
      }
    }

    this.telemetry.broadcast({
      type: 'executor_cycle',
      timestamp: snapshot.timestamp instanceof Date
        ? snapshot.timestamp.getTime()
        : Number(snapshot.timestamp),
      pressure,
      pressure_metadata: {
        sequence_number: snapshot.tickNumber,
        timestamp_ms: snapshot.timestamp instanceof Date
          ? snapshot.timestamp.getTime()
          : Number(snapshot.timestamp),
        is_stale: false,
      },
      drive_velocity: driveVelocity,
      drive_entropy: 0,
      dominant_drive: dominantDrive,
      category: null,
      action: null,
      action_confidence: null,
      state: 'idle',
      transition_count: 0,
      cycle_count: snapshot.tickNumber,
      guardian_present: null,
      speech_refractory: 0,
      action_diversity: {},
      system_health: { total_pressure: snapshot.totalPressure },
      schema_version: 1,
      dynamic_threshold: 0,
    });
  }
}

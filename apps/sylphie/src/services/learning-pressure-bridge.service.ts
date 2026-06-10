/**
 * LearningPressureBridgeService — wires CognitiveAwareness drive pressure to
 * learning cycle scheduling.
 *
 * CANON §Subsystem 3 (Learning): The LearningService docstring explicitly notes
 * that the timer-based cycle trigger is a "fallback" and that CognitiveAwareness
 * drive pressure should be the primary trigger. This bridge implements that wiring
 * without adding a drive-engine dependency to the learning package.
 *
 * Design: subscribe to driveState$ here (in the app layer where both tokens are
 * available), and call learningService.forceCycle() when CognitiveAwareness
 * pressure exceeds the threshold. A 30s debounce prevents back-to-back forced
 * cycles during sustained high-pressure windows.
 */

import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { DRIVE_STATE_READER, type IDriveStateReader } from '@sylphie/drive-engine';
import { type DriveSnapshot, DriveName, verboseFor } from '@sylphie/shared';
import { LEARNING_SERVICE, type ILearningService } from '@sylphie/learning';

const vlog = verboseFor('Learning');

/** CognitiveAwareness pressure above this threshold triggers an immediate cycle. */
const PRESSURE_CYCLE_THRESHOLD = 0.70;

/** Minimum milliseconds between pressure-triggered cycles. */
const MIN_CYCLE_INTERVAL_MS = 30_000;

@Injectable()
export class LearningPressureBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LearningPressureBridgeService.name);
  private subscription: Subscription | null = null;
  private lastForcedCycleAt = 0;

  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveReader: IDriveStateReader,

    @Inject(LEARNING_SERVICE)
    private readonly learningService: ILearningService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.driveReader.driveState$.subscribe({
      next: (snapshot) => this.onDriveSnapshot(snapshot),
      error: (err: Error) => {
        this.logger.error(`Drive state subscription error: ${err.message}`);
      },
    });

    this.logger.log(
      `Learning pressure bridge active (threshold=${PRESSURE_CYCLE_THRESHOLD}, ` +
        `minInterval=${MIN_CYCLE_INTERVAL_MS / 1000}s)`,
    );
  }

  onModuleDestroy(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  private onDriveSnapshot(snapshot: DriveSnapshot): void {
    const cognitiveAwareness = snapshot.pressureVector[DriveName.CognitiveAwareness] ?? 0;

    if (cognitiveAwareness < PRESSURE_CYCLE_THRESHOLD) return;

    const now = Date.now();
    if (now - this.lastForcedCycleAt < MIN_CYCLE_INTERVAL_MS) return;

    this.lastForcedCycleAt = now;

    vlog('pressure-triggered cycle', {
      cognitiveAwareness: +cognitiveAwareness.toFixed(3),
      threshold: PRESSURE_CYCLE_THRESHOLD,
    });

    this.learningService.forceCycle().catch((err: unknown) => {
      this.logger.error(
        `Pressure-triggered cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}

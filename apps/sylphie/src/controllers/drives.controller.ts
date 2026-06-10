import {
  Controller,
  Get,
  Post,
  Body,
  Inject,
  NotImplementedException,
} from '@nestjs/common';
import { DRIVE_STATE_READER, type IDriveStateReader } from '@sylphie/drive-engine';

@Controller('drives')
export class DrivesController {
  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveReader: IDriveStateReader,
  ) {}

  /**
   * GET /drives — read-only drive-engine liveness snapshot.
   *
   * Exposes the monotonically-increasing tick counter so external probes (the
   * Provability Gate's drive-tick-rate assertion) can measure that the separate
   * drive process is alive. Strictly read-only via IDriveStateReader, so CANON
   * §Drive Isolation holds (no writes cross the process boundary here).
   */
  @Get()
  getSnapshot(): {
    tickNumber: number;
    totalPressure: number;
    timestamp: string;
    isConnected: boolean;
  } {
    const snapshot = this.driveReader.getCurrentState();
    const ts =
      snapshot.timestamp instanceof Date
        ? snapshot.timestamp
        : new Date(snapshot.timestamp as unknown as string);
    // isConnected requires a recent tick, not merely a non-zero counter — once
    // the drive process dies the snapshot freezes and tickNumber stays > 0
    // forever. Mirror PressureController's 2s recency window so a stalled
    // process correctly reads as disconnected.
    const isRecent = Date.now() - ts.getTime() < 2000;
    return {
      tickNumber: snapshot.tickNumber,
      totalPressure: snapshot.totalPressure,
      timestamp: ts.toISOString(),
      isConnected: snapshot.tickNumber > 0 && isRecent,
    };
  }

  // ---------------------------------------------------------------------------
  // Drive mutation endpoints — intentionally NOT implemented.
  //
  // CANON §Drive Isolation: the main app process cannot mutate drive state
  // (the Drive Engine runs in a separate process with Postgres RLS denying the
  // app UPDATE/DELETE on drive rules). These control surfaces would have to
  // route through a permitted path (e.g. guardian-feedback events the Drive
  // Engine itself processes) — that design decision is open (stub-inventory
  // §3.3). Until then they return 501 rather than a fake {} success, so a
  // caller is never misled into thinking an override took effect.
  // ---------------------------------------------------------------------------

  private static readonly NOT_SUPPORTED =
    'Drive mutation from the app process is forbidden by CANON Drive Isolation. ' +
    'Route changes through guardian-feedback events instead (see stub-inventory §3.3).';

  @Post('override')
  setOverride(@Body() _body: { drive: string; value: number; active: boolean }): never {
    throw new NotImplementedException(DrivesController.NOT_SUPPORTED);
  }

  @Post('drift')
  setDrift(@Body() _body: { drive: string; rate: number }): never {
    throw new NotImplementedException(DrivesController.NOT_SUPPORTED);
  }

  @Post('reset')
  resetOverrides(): never {
    throw new NotImplementedException(DrivesController.NOT_SUPPORTED);
  }
}

@Controller('pressure')
export class PressureController {
  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveReader: IDriveStateReader,
  ) {}

  @Get()
  getStatus() {
    const snapshot = this.driveReader.getCurrentState();
    // Healthy if we've received at least one real tick and it's recent (within 2s)
    const hasRealTick = snapshot.tickNumber > 0;
    const snapshotMs = snapshot.timestamp instanceof Date
      ? snapshot.timestamp.getTime()
      : new Date(snapshot.timestamp as unknown as string).getTime();
    const isRecent = Date.now() - snapshotMs < 2000;
    const isConnected = hasRealTick && isRecent;
    return {
      is_connected: isConnected,
      is_stale: !isConnected,
    };
  }
}

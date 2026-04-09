import { Controller, Get, Post, Body, Inject } from '@nestjs/common';
import { DRIVE_STATE_READER, type IDriveStateReader } from '@sylphie/drive-engine';

@Controller('drives')
export class DrivesController {
  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveReader: IDriveStateReader,
  ) {}

  @Post('override')
  setOverride(@Body() _body: { drive: string; value: number; active: boolean }) {
    return {};
  }

  @Post('drift')
  setDrift(@Body() _body: { drive: string; rate: number }) {
    return {};
  }

  @Post('reset')
  resetOverrides() {
    return {};
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

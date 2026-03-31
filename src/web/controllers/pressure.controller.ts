import { Controller, Get, Inject } from '@nestjs/common';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';

/**
 * PressureController — Drive engine connection status.
 *
 * Returns whether the drive engine is connected and producing
 * non-stale pressure data. Used by the frontend's pressure status hook.
 */
@Controller('api/pressure')
export class PressureController {
  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
  ) {}

  @Get()
  getPressureStatus(): { is_connected: boolean; is_stale: boolean } {
    const state = this.driveStateReader.getCurrentState();
    const hasData = state.tickNumber > 0;
    return { is_connected: hasData, is_stale: !hasData };
  }
}

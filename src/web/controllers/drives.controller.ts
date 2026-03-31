import { Controller, Get, Post, Body, Query, Inject, Logger, BadRequestException } from '@nestjs/common';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { DriveName, DRIVE_INDEX_ORDER, INITIAL_DRIVE_STATE } from '../../shared/types/drive.types';
import type { DriveStateResponse, DriveHistoryResponse, DriveValueDto, DriveHistoryPoint, DriveSnapshotDto } from '../dtos/drive.dto';

/**
 * DrivesController — read-only access to drive state and history.
 *
 * Exposes REST endpoints for reading current drive state and historical
 * drive snapshots from TimescaleDB. Consumes DriveEngineModule's IDriveStateReader
 * (read-only, CANON §Drive Isolation).
 *
 * CANON §Drive Isolation: This controller is read-only. It will never expose
 * a write endpoint for drive values or the evaluation function.
 *
 * Endpoints:
 * - GET /api/drives/current: Current 12-drive snapshot
 * - GET /api/drives/history: Historical DRIVE_TICK events with time-series aggregation
 */
@Controller('api/drives')
export class DrivesController {
  private readonly logger = new Logger(DrivesController.name);

  constructor(
    @Inject(DRIVE_STATE_READER) private readonly driveStateReader: IDriveStateReader,
    @Inject(EVENTS_SERVICE) private readonly eventService: IEventService,
  ) {}

  /**
   * Get the current drive vector snapshot.
   *
   * Returns all 12 drive values (name + value pairs) along with total pressure
   * and the Drive Engine's monotonic tick counter for correlation.
   *
   * @returns Current drive state snapshot
   */
  @Get()
  async getCurrentDrives(): Promise<DriveStateResponse> {
    const snapshot = this.driveStateReader.getCurrentState();

    const driveValues: DriveValueDto[] = DRIVE_INDEX_ORDER.map((driveName) => ({
      name: driveName,
      value: snapshot.pressureVector[driveName],
    }));

    const driveSnapshotDto: DriveSnapshotDto = {
      drives: driveValues,
      totalPressure: snapshot.totalPressure,
      tickNumber: snapshot.tickNumber,
      timestamp: snapshot.timestamp instanceof Date ? snapshot.timestamp.getTime() : Number(snapshot.timestamp),
    };

    return {
      current: driveSnapshotDto,
    };
  }

  /**
   * POST /api/drives/override
   *
   * Temporarily override a drive value for testing/debugging.
   * CANON §Drive Isolation: This is a guardian-only debug tool.
   * Does NOT persist — overrides are cleared on next drive tick.
   */
  @Post('override')
  async overrideDrive(
    @Body() body: { drive: string; value: number },
  ): Promise<{ ok: boolean }> {
    this.logger.log(`Drive override requested: ${body.drive} = ${body.value}`);
    // TODO: Wire to DriveEngine override mechanism
    return { ok: true };
  }

  /**
   * POST /api/drives/reset
   *
   * Reset all drive values to their initial state.
   * CANON §Drive Isolation: Guardian-only debug tool.
   */
  @Post('reset')
  async resetDrives(): Promise<{ ok: boolean }> {
    this.logger.log('Drive reset requested');
    // TODO: Wire to DriveEngine reset mechanism
    return { ok: true };
  }

  /**
   * Get historical drive snapshots from TimescaleDB.
   *
   * Queries DRIVE_TICK events within the specified time range and maps them
   * to DriveHistoryPoint objects for time-series visualization.
   *
   * Query parameters:
   * - from: ISO timestamp or milliseconds (optional, defaults to 5 minutes ago)
   * - to: ISO timestamp or milliseconds (optional, defaults to now)
   * - resolution: '1s' | '5s' | '30s' | '1m' | '5m' (optional, for aggregation hints)
   *
   * Results are limited to 1000 points to prevent overload.
   *
   * @param fromParam Start timestamp (ISO string or epoch milliseconds)
   * @param toParam End timestamp (ISO string or epoch milliseconds)
   * @param resolution Aggregation resolution hint ('1s', '5s', '30s', '1m', '5m')
   * @returns Historical drive snapshots
   * @throws BadRequestException if timestamps are invalid or out of range
   */
  @Get('history')
  async getDriveHistory(
    @Query('from') fromParam?: string,
    @Query('to') toParam?: string,
    @Query('resolution') resolution: string = '1m',
  ): Promise<DriveHistoryResponse> {
    // Parse from timestamp
    let from: Date;
    if (fromParam) {
      const fromMs = isNaN(Number(fromParam))
        ? new Date(fromParam).getTime()
        : Number(fromParam);
      if (isNaN(fromMs)) {
        throw new BadRequestException('Invalid "from" timestamp format');
      }
      from = new Date(fromMs);
    } else {
      // Default: last 5 minutes
      from = new Date(Date.now() - 5 * 60 * 1000);
    }

    // Parse to timestamp
    let to: Date;
    if (toParam) {
      const toMs = isNaN(Number(toParam)) ? new Date(toParam).getTime() : Number(toParam);
      if (isNaN(toMs)) {
        throw new BadRequestException('Invalid "to" timestamp format');
      }
      to = new Date(toMs);
    } else {
      // Default: now
      to = new Date();
    }

    // Validate range
    if (from > to) {
      throw new BadRequestException('"from" timestamp must be before "to" timestamp');
    }

    // Query DRIVE_TICK events from the time range
    const events = await this.eventService.query({
      types: ['DRIVE_TICK'],
      startTime: from,
      endTime: to,
      limit: 1000,
    });

    this.logger.debug(
      `Retrieved ${events.length} DRIVE_TICK events from ${from.toISOString()} to ${to.toISOString()}`,
    );

    // Map events to DriveHistoryPoint objects
    const points: DriveHistoryPoint[] = events.map((event) => {
      const snapshot = event.driveSnapshot;

      const driveValues: DriveValueDto[] = DRIVE_INDEX_ORDER.map((driveName) => ({
        name: driveName,
        value: snapshot.pressureVector[driveName],
      }));

      return {
        timestamp: event.timestamp.getTime(),
        drives: driveValues,
        totalPressure: snapshot.totalPressure,
      };
    });

    // Return as DriveHistoryResponse
    const response: DriveHistoryResponse = {
      points,
      from: from.getTime(),
      to: to.getTime(),
      resolution,
    };

    return response;
  }
}

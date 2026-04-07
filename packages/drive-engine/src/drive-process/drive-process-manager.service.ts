/**
 * Real implementation of IDriveProcessManager.
 *
 * Manages the Drive Engine child process lifecycle using child_process.fork().
 * Establishes the IPC channel, attaches message handlers, and forwards
 * drive snapshots to DriveReaderService.
 *
 * This service is INTERNAL to DriveEngineModule. It is NOT exported from
 * the module barrel (index.ts). The injection token DRIVE_PROCESS_MANAGER
 * is only wired inside DriveEngineModule's providers array.
 *
 * Lifecycle: start() is called from DriveEngineModule's OnModuleInit hook.
 * stop() is called from the OnModuleDestroy hook.
 *
 * CANON §Drive Isolation: This is the sole bridge between the main NestJS
 * process and the isolated Drive Engine child. All inbound messages are
 * forwarded to listeners; all outbound messages are sent through the
 * IpcChannelService without mutation.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  DriveIPCMessage,
  DriveIPCMessageType,
  DriveSnapshotPayload,
  TimescaleService,
  type OpportunityCreatedPayload,
} from '@sylphie/shared';
import { IDriveProcessManager } from '../interfaces/drive-engine.interfaces';
import { DriveReaderService } from '../drive-reader.service';
import { WsChannelService } from '../ipc-channel/ws-channel.service';
import { HealthMonitor } from '../ipc-channel/health-monitor';
import { RecoveryMechanism } from '../ipc-channel/recovery';

@Injectable()
export class DriveProcessManagerService implements IDriveProcessManager {
  private readonly logger = new Logger(DriveProcessManagerService.name);

  private healthMonitor: HealthMonitor;
  private recovery: RecoveryMechanism;
  private started = false;
  private wsUrl: string;

  constructor(
    private driveReaderService: DriveReaderService,
    private wsChannel: WsChannelService,
    private timescale: TimescaleService,
    private config: ConfigService,
  ) {
    this.wsUrl = this.config.get<string>('DRIVE_ENGINE_WS_URL', 'ws://localhost:3001');
    this.healthMonitor = new HealthMonitor(this.wsChannel);
    this.recovery = new RecoveryMechanism(
      this.wsChannel,
      this.healthMonitor,
      this.wsUrl,
    );
  }

  /**
   * Start the drive computation child process.
   *
   * Spawns the child via child_process.fork(), attaches IPC message handlers,
   * forwards DRIVE_SNAPSHOT messages to DriveReaderService, and waits for
   * the initial health check response.
   *
   * @throws {Error} If the process fails to spawn or initial health check times out.
   */
  async start(): Promise<void> {
    if (this.started) {
      this.logger.warn('DriveProcessManager already started');
      return;
    }

    try {
      this.logger.log(`Connecting to Drive Engine at ${this.wsUrl}`);

      // Connect to the Drive Engine WebSocket server
      this.wsChannel.connect(this.wsUrl);

      // Attach handlers for inbound messages
      this.attachMessageHandlers();

      // Start health monitoring
      this.healthMonitor.start();

      // Wait for initial health check (2000ms timeout)
      // Non-blocking: if the server isn't up yet, recovery will handle reconnection
      try {
        await this.waitForInitialHealthCheck(2000);
        this.logger.log('Drive Engine connected and healthy');
      } catch {
        this.logger.warn(
          'Drive Engine not available on startup — recovery will reconnect',
        );
      }

      this.started = true;
    } catch (error) {
      this.logger.error(
        `Failed to connect to Drive Engine: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Stop the drive computation child process gracefully.
   *
   * Shuts down the health monitor and gracefully closes the IPC channel.
   * Waits for the child process to exit cleanly (5s timeout), then force-kills
   * if necessary.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      this.logger.warn('DriveProcessManager not started');
      return;
    }

    try {
      this.logger.log('Disconnecting from Drive Engine');

      // Stop the health monitor
      this.healthMonitor.stop();

      // Close the WebSocket connection gracefully
      await this.wsChannel.close(5000);

      this.started = false;
      this.logger.log('Drive Engine connection closed');
    } catch (error) {
      this.logger.error(
        `Error disconnecting from Drive Engine: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check whether the Drive Engine connection is healthy.
   *
   * Returns true if the WebSocket is open and we've received a snapshot
   * within the heartbeat window (default 5 seconds).
   */
  isHealthy(): boolean {
    return this.wsChannel.isHealthy();
  }

  // ---------------------------------------------------------------------------
  // Private: Message Handlers and Utilities
  // ---------------------------------------------------------------------------

  /**
   * Attach handlers for inbound IPC messages from the child process.
   *
   * Handlers are registered for:
   *   - DRIVE_SNAPSHOT: Forward to DriveReaderService
   *   - OPPORTUNITY_CREATED: Reserved for Planning subsystem (T006)
   *   - DRIVE_EVENT: Reserved for event logging
   *   - HEALTH_STATUS: Internal health check response
   */
  private attachMessageHandlers(): void {
    // DRIVE_SNAPSHOT: Forward to DriveReaderService to update subscribers
    // Also record arrival in the health monitor for liveness tracking.
    this.wsChannel.onMessage(
      DriveIPCMessageType.DRIVE_SNAPSHOT,
      (message: DriveIPCMessage<DriveSnapshotPayload>) => {
        try {
          this.healthMonitor.recordSnapshot();
          this.driveReaderService.updateSnapshot(message.payload.snapshot);
        } catch (error) {
          this.logger.error(
            `Error updating drive snapshot: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // OPPORTUNITY_CREATED: Write to TimescaleDB event backbone for Planning.
    // CANON §No Circular Module Dependencies: Cross-subsystem communication
    // flows through TimescaleDB, not direct service injection. Planning polls
    // for OPPORTUNITY_DETECTED events with has_planned = false.
    this.wsChannel.onMessage(
      DriveIPCMessageType.OPPORTUNITY_CREATED,
      (message: DriveIPCMessage<OpportunityCreatedPayload>) => {
        this.logger.debug(
          `Opportunity created: ${message.payload.id} (${message.payload.classification})`,
        );
        this.writeOpportunityEvent(message.payload);
      },
    );

    // DRIVE_EVENT: Reserved for event logging
    // For now, log and ignore
    this.wsChannel.onMessage(
      DriveIPCMessageType.DRIVE_EVENT,
      (message: DriveIPCMessage<any>) => {
        this.logger.debug(
          `Drive event: ${message.payload.driveEventType} on ${message.payload.drive}`,
        );
        // TODO: Forward to event backbone (TimescaleDB)
      },
    );

    // HEALTH_STATUS: Internal response from health check pings
    this.wsChannel.onMessage(
      DriveIPCMessageType.HEALTH_STATUS,
      (message: DriveIPCMessage<any>) => {
        this.logger.debug(
          `Health check response: tick=${message.payload.currentTick}, healthy=${message.payload.healthy}`,
        );
      },
    );

    this.logger.debug('Message handlers attached');
  }

  /**
   * Wait for the initial health check response from the child process.
   *
   * Polls the health monitor until it reports the process is healthy or
   * the timeout expires.
   *
   * @param timeoutMs - Maximum time to wait
   * @throws {Error} If timeout expires without receiving health check
   */
  private async waitForInitialHealthCheck(timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const pollIntervalMs = 100;

    while (Date.now() - startTime < timeoutMs) {
      if (this.wsChannel.isHealthy()) {
        this.logger.debug('Initial health check successful');
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Initial health check timeout (waited ${timeoutMs}ms)`,
    );
  }

  /**
   * Write an OPPORTUNITY_DETECTED event to TimescaleDB for Planning to poll.
   *
   * Fire-and-forget: errors are logged but do not propagate. The Planning
   * subsystem ingests these events via polling (has_planned = false).
   */
  private writeOpportunityEvent(payload: OpportunityCreatedPayload): void {
    const id = randomUUID();
    const timestamp = new Date();

    this.timescale
      .query(
        `INSERT INTO events
           (id, type, timestamp, subsystem, session_id, drive_snapshot, payload, schema_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          'OPPORTUNITY_DETECTED',
          timestamp,
          'DRIVE_ENGINE',
          'drive-engine-internal',
          null,
          JSON.stringify({
            ...payload,
            has_planned: false,
          }),
          1,
        ],
      )
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to write opportunity event: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}


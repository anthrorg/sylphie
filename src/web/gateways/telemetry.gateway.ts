import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketServer,
} from '@nestjs/websockets';
import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subscription } from 'rxjs';
import type { DriveSnapshot } from '../../shared/types/drive.types';
import { DRIVE_INDEX_ORDER } from '../../shared/types/drive.types';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { IConnectionManagerService } from '../interfaces/web.interfaces';
import { CONNECTION_MANAGER } from '../web.tokens';
import type { WebConfig } from '../web.config';
import type { TelemetryFrame, TelemetryEvent } from '../interfaces/websocket.interfaces';
import type { DriveSnapshotDto, DriveValueDto } from '../dtos/drive.dto';
import type { WireProtocol } from '../interfaces/wire-protocol';
import { getWireProtocol } from '../interfaces/wire-protocol';
import { adaptTelemetryFrame } from '../adapters';

/**
 * TelemetryGateway — Real-time drive state telemetry stream.
 *
 * WebSocket gateway for streaming drive state snapshots to connected dashboard clients.
 * Subscribes to DriveEngineModule's driveState$ Observable and batches events for
 * efficient delivery.
 *
 * Supports dual-protocol via the `protocol` query parameter on the WebSocket
 * upgrade URL:
 *   - `?protocol=cobeing-v1`  : emits a single CoBeing_DriveFrame (executor_cycle)
 *                               per flush window using adaptTelemetryFrame().
 *   - default (no param)      : emits a batched TelemetryFrame in Sylphie-native
 *                               camelCase format, unchanged from the original behaviour.
 *
 * The protocol is negotiated once at connection time and is immutable for the
 * lifetime of the connection. There is no mid-session renegotiation.
 *
 * CANON §Drive Isolation: This gateway is read-only. It will never accept
 * messages that mutate drive values or the evaluation function.
 *
 * Channel: 'telemetry'
 * Path: '/ws/telemetry'
 */
@WebSocketGateway({ path: '/ws/telemetry' })
export class TelemetryGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(TelemetryGateway.name);

  @WebSocketServer()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private server!: any;

  /**
   * Per-client subscriptions to driveState$ Observable.
   * Map<client, Subscription>
   */
  private readonly clientSubscriptions = new Map<unknown, Subscription>();

  /**
   * Per-client sequence numbers for frame ordering (sylphie-native only).
   * Map<client, number>
   */
  private readonly sequenceNumbers = new Map<unknown, number>();

  /**
   * Per-client event buffers for batching (sylphie-native only).
   * Map<client, TelemetryEvent[]>
   */
  private readonly eventBuffers = new Map<unknown, TelemetryEvent[]>();

  /**
   * Per-client buffer timeout IDs.
   * Map<client, NodeJS.Timeout>
   */
  private readonly bufferTimeouts = new Map<unknown, NodeJS.Timeout>();

  /**
   * Per-client negotiated wire protocol.
   *
   * Read once in handleConnection via getWireProtocol(). Immutable for the
   * lifetime of the connection. Drives the serialisation branch in flushBuffer.
   *
   * Map<client, WireProtocol>
   */
  private readonly clientProtocols = new Map<unknown, WireProtocol>();

  /**
   * Latest DriveSnapshot per CoBeing client.
   *
   * CoBeing clients receive a single CoBeing_DriveFrame per flush window
   * (not a batched envelope). Rather than buffering DTO events and then
   * re-converting them, we store the most-recent raw DriveSnapshot so that
   * adaptTelemetryFrame() can be called directly at flush time.
   *
   * For sylphie-native clients this map is never written to; those clients
   * use eventBuffers instead.
   *
   * Map<client, DriveSnapshot>
   */
  private readonly cobeingLatestSnapshots = new Map<unknown, DriveSnapshot>();

  private readonly telemetryBatchIntervalMs: number;
  private readonly telemetryMaxBatchSize: number;

  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
    @Inject(CONNECTION_MANAGER)
    private readonly connectionManager: IConnectionManagerService,
    private readonly configService: ConfigService,
  ) {
    const webConfig = this.configService.get<WebConfig>('web');
    this.telemetryBatchIntervalMs = webConfig?.telemetry.batchIntervalMs ?? 500;
    this.telemetryMaxBatchSize = webConfig?.telemetry.maxBatchSize ?? 50;

    this.logger.debug(
      `Initialized TelemetryGateway with batch interval ${this.telemetryBatchIntervalMs}ms, max batch size ${this.telemetryMaxBatchSize}`,
    );
  }

  /**
   * Handle a new WebSocket client connection.
   *
   * Negotiates the wire protocol via getWireProtocol(), stores the preference,
   * registers the client with ConnectionManager on the 'telemetry' channel,
   * subscribes to driveState$ Observable, and initialises per-client buffers.
   *
   * @param client - The connected WebSocket client
   */
  handleConnection(client: unknown, req?: unknown): void {
    this.logger.debug('Client connected to telemetry gateway');

    // Negotiate and store the wire protocol for this connection.
    // With @nestjs/platform-ws, the HTTP upgrade request is the second arg.
    const protocol = getWireProtocol(req ?? client);
    this.clientProtocols.set(client, protocol);

    // Register with connection manager
    this.connectionManager.register(client, 'telemetry');

    // Initialise per-client state (used by both protocols)
    this.sequenceNumbers.set(client, 0);

    // sylphie-native uses an event buffer; cobeing-v1 uses the snapshot store
    if (protocol === 'sylphie-native') {
      this.eventBuffers.set(client, []);
    }

    // Subscribe to drive state updates
    const subscription = this.driveStateReader.driveState$.subscribe(
      (driveSnapshot: DriveSnapshot) => {
        this.handleDriveSnapshot(client, driveSnapshot);
      },
    );

    this.clientSubscriptions.set(client, subscription);
    this.logger.debug(
      `Telemetry client registered protocol=${protocol} (total: ${this.connectionManager.getConnectionCount('telemetry')})`,
    );
  }

  /**
   * Handle a client disconnection.
   *
   * Unsubscribes from driveState$ Observable, clears all per-client state
   * (including protocol preference and CoBeing snapshot store), cancels
   * pending buffer timeouts, and unregisters from ConnectionManager.
   *
   * @param client - The disconnected WebSocket client
   */
  handleDisconnect(client: unknown): void {
    this.logger.debug('Client disconnecting from telemetry gateway');

    // Unsubscribe and clean up
    const subscription = this.clientSubscriptions.get(client);
    if (subscription) {
      subscription.unsubscribe();
      this.clientSubscriptions.delete(client);
    }

    // Cancel any pending buffer timeout
    const timeoutId = this.bufferTimeouts.get(client);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.bufferTimeouts.delete(client);
    }

    // Clear per-client state
    this.eventBuffers.delete(client);
    this.sequenceNumbers.delete(client);
    this.clientProtocols.delete(client);
    this.cobeingLatestSnapshots.delete(client);

    // Unregister from connection manager
    this.connectionManager.unregister(client, 'telemetry');

    this.logger.debug(
      `Telemetry client unregistered (total: ${this.connectionManager.getConnectionCount('telemetry')})`,
    );
  }

  /**
   * Module cleanup on destroy.
   *
   * Cancels all pending buffer timeouts.
   */
  onModuleDestroy(): void {
    for (const timeoutId of this.bufferTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this.bufferTimeouts.clear();
  }

  /**
   * Handle an incoming drive state snapshot.
   *
   * Branches on the client's negotiated wire protocol:
   *
   * - sylphie-native: converts the snapshot to a DriveSnapshotDto, wraps it in
   *   a TelemetryEvent, and appends it to the per-client event buffer. Flushes
   *   immediately when the buffer reaches maxBatchSize; otherwise schedules a
   *   flush after batchIntervalMs.
   *
   * - cobeing-v1: stores the raw DriveSnapshot as the latest snapshot for this
   *   client and schedules a flush after batchIntervalMs (no buffering —
   *   cobeing clients receive one CoBeing_DriveFrame per flush window, not a
   *   batched envelope). Any previously stored snapshot for this client is
   *   replaced (we only ever need the most recent one).
   *
   * @private
   */
  private handleDriveSnapshot(
    client: unknown,
    driveSnapshot: DriveSnapshot,
  ): void {
    const protocol = this.clientProtocols.get(client);

    // Client may have disconnected; ignore if protocol entry is gone
    if (!protocol) {
      return;
    }

    if (protocol === 'cobeing-v1') {
      this.handleDriveSnapshotCobeing(client, driveSnapshot);
    } else {
      this.handleDriveSnapshotNative(client, driveSnapshot);
    }
  }

  /**
   * Cobeing-v1 snapshot handling.
   *
   * Stores the latest DriveSnapshot and schedules a flush. The flush will call
   * adaptTelemetryFrame() once per window, emitting a single executor_cycle frame.
   *
   * @private
   */
  private handleDriveSnapshotCobeing(
    client: unknown,
    driveSnapshot: DriveSnapshot,
  ): void {
    // Overwrite with the most recent snapshot — we only send one frame per window
    this.cobeingLatestSnapshots.set(client, driveSnapshot);

    // Cancel any existing timeout and reschedule
    const existingTimeout = this.bufferTimeouts.get(client);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.bufferTimeouts.delete(client);
    }

    const timeoutId = setTimeout(() => {
      this.flushBuffer(client);
    }, this.telemetryBatchIntervalMs);

    this.bufferTimeouts.set(client, timeoutId);
  }

  /**
   * Sylphie-native snapshot handling.
   *
   * Converts the snapshot to a DriveSnapshotDto, wraps it in a TelemetryEvent,
   * buffers it, and flushes when the buffer is full or the batch interval elapses.
   *
   * @private
   */
  private handleDriveSnapshotNative(
    client: unknown,
    driveSnapshot: DriveSnapshot,
  ): void {
    // Get or initialize client buffer
    const buffer = this.eventBuffers.get(client);
    if (!buffer) {
      // Client may have disconnected; ignore
      return;
    }

    // Convert DriveSnapshot to DriveSnapshotDto
    const driveValues: DriveValueDto[] = DRIVE_INDEX_ORDER.map((driveName) => ({
      name: driveName,
      value: driveSnapshot.pressureVector[driveName],
    }));

    const driveSnapshotDto: DriveSnapshotDto = {
      drives: driveValues,
      totalPressure: driveSnapshot.totalPressure,
      tickNumber: driveSnapshot.tickNumber,
      timestamp: driveSnapshot.timestamp.getTime(),
    };

    // Create telemetry event from drive snapshot
    const event: TelemetryEvent = {
      type: 'DRIVE_SNAPSHOT',
      timestamp: Date.now(),
      payload: {
        driveSnapshot: driveSnapshotDto,
      },
    };

    // Add to buffer
    buffer.push(event);

    // Cancel existing timeout if present
    const existingTimeout = this.bufferTimeouts.get(client);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.bufferTimeouts.delete(client);
    }

    // Flush if buffer is full
    if (buffer.length >= this.telemetryMaxBatchSize) {
      this.flushBuffer(client);
      return;
    }

    // Schedule flush after interval if not already scheduled
    const timeoutId = setTimeout(() => {
      this.flushBuffer(client);
    }, this.telemetryBatchIntervalMs);

    this.bufferTimeouts.set(client, timeoutId);
  }

  /**
   * Flush buffered state for a client.
   *
   * Branches on the client's negotiated wire protocol:
   *
   * - sylphie-native: constructs a TelemetryFrame from the buffered events and
   *   sends it via the connection manager. Resets the event buffer and increments
   *   the sequence number.
   *
   * - cobeing-v1: calls adaptTelemetryFrame() on the latest stored DriveSnapshot
   *   and sends the resulting CoBeing_DriveFrame directly (no envelope wrapper).
   *   Removes the stored snapshot after sending.
   *
   * @private
   */
  private flushBuffer(client: unknown): void {
    const seqNum = this.sequenceNumbers.get(client);
    const protocol = this.clientProtocols.get(client);

    if (seqNum === undefined || !protocol) {
      return;
    }

    // Clear the timeout entry regardless of protocol
    const timeoutId = this.bufferTimeouts.get(client);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.bufferTimeouts.delete(client);
    }

    if (protocol === 'cobeing-v1') {
      this.flushCobeing(client, seqNum);
    } else {
      this.flushNative(client, seqNum);
    }
  }

  /**
   * Flush for cobeing-v1 clients.
   *
   * Sends a single CoBeing_DriveFrame produced by adaptTelemetryFrame().
   * No-ops if no snapshot has been received since the last flush.
   *
   * @private
   */
  private flushCobeing(client: unknown, seqNum: number): void {
    const snapshot = this.cobeingLatestSnapshots.get(client);
    if (!snapshot) {
      // No snapshot received yet in this window — nothing to send
      return;
    }

    const frame = adaptTelemetryFrame(snapshot);

    this.connectionManager.sendToClient(client, frame).catch((error: Error) => {
      this.logger.warn(
        `Failed to send cobeing telemetry frame to client: ${error.message}`,
      );
    });

    // Remove the consumed snapshot and advance sequence number
    this.cobeingLatestSnapshots.delete(client);
    this.sequenceNumbers.set(client, seqNum + 1);
  }

  /**
   * Flush for sylphie-native clients.
   *
   * Constructs a TelemetryFrame from the buffered TelemetryEvents and sends it.
   * Resets the buffer and increments the sequence number.
   *
   * @private
   */
  private flushNative(client: unknown, seqNum: number): void {
    const buffer = this.eventBuffers.get(client);

    if (!buffer) {
      return;
    }

    // If buffer is empty, nothing to send
    if (buffer.length === 0) {
      return;
    }

    // Construct telemetry frame
    const frame: TelemetryFrame = {
      type: 'telemetry',
      events: [...buffer],
      timestamp: Date.now(),
      sequenceNumber: seqNum,
    };

    // Send to client
    this.connectionManager.sendToClient(client, frame).catch((error: Error) => {
      this.logger.warn(
        `Failed to send telemetry frame to client: ${error.message}`,
      );
    });

    // Update sequence number and clear buffer
    this.sequenceNumbers.set(client, seqNum + 1);
    this.eventBuffers.set(client, []);
  }
}

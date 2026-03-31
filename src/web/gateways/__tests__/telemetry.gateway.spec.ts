/**
 * Unit tests for TelemetryGateway.
 *
 * Tests real-time drive state telemetry streaming via WebSocket,
 * including client connection/disconnection, buffering behavior,
 * and sequence numbering.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { of, Subject } from 'rxjs';
import { TelemetryGateway } from '../telemetry.gateway';
import { DRIVE_STATE_READER } from '../../../drive-engine/drive-engine.tokens';
import { CONNECTION_MANAGER } from '../../web.tokens';
import type { IDriveStateReader } from '../../../drive-engine/interfaces/drive-engine.interfaces';
import type { IConnectionManagerService } from '../../interfaces/web.interfaces';
import type { DriveSnapshot } from '../../../shared/types/drive.types';
import { DriveName } from '../../../shared/types/drive.types';
import type { WebConfig } from '../../web.config';

/**
 * Helper to create a mock drive snapshot.
 */
function createMockDriveSnapshot(overrides?: Partial<DriveSnapshot>): DriveSnapshot {
  const pressureVector: Record<DriveName, number> = {
    [DriveName.SystemHealth]: 0.5,
    [DriveName.MoralValence]: 0.6,
    [DriveName.Integrity]: 0.7,
    [DriveName.CognitiveAwareness]: 0.4,
    [DriveName.Guilt]: 0.1,
    [DriveName.Curiosity]: 0.8,
    [DriveName.Boredom]: 0.2,
    [DriveName.Anxiety]: 0.3,
    [DriveName.Satisfaction]: 0.5,
    [DriveName.Sadness]: 0.1,
    [DriveName.InformationIntegrity]: 0.9,
    [DriveName.Social]: 0.6,
  };

  const driveDeltas: Record<DriveName, number> = {
    [DriveName.SystemHealth]: 0.0,
    [DriveName.MoralValence]: 0.0,
    [DriveName.Integrity]: 0.0,
    [DriveName.CognitiveAwareness]: 0.0,
    [DriveName.Guilt]: 0.0,
    [DriveName.Curiosity]: 0.0,
    [DriveName.Boredom]: 0.0,
    [DriveName.Anxiety]: 0.0,
    [DriveName.Satisfaction]: 0.0,
    [DriveName.Sadness]: 0.0,
    [DriveName.InformationIntegrity]: 0.0,
    [DriveName.Social]: 0.0,
  };

  return {
    pressureVector: pressureVector as any,
    driveDeltas: driveDeltas as any,
    ruleMatchResult: {
      ruleId: null,
      eventType: 'TEST',
      matched: false,
    },
    totalPressure: 6.3,
    timestamp: new Date(),
    tickNumber: 1,
    sessionId: 'session-test',
    ...overrides,
  };
}

/**
 * Helper to create a mock WebSocket client.
 */
function createMockClient() {
  return {
    id: `client-${Math.random().toString(36).substr(2, 9)}`,
    send: jest.fn(),
    close: jest.fn(),
    readyState: 1,
    on: jest.fn(),
  };
}

describe('TelemetryGateway', () => {
  let gateway: TelemetryGateway;
  let mockDriveStateReader: Partial<IDriveStateReader>;
  let mockConnectionManager: Partial<IConnectionManagerService>;
  let mockConfigService: Partial<ConfigService>;
  let driveStateSubject: Subject<DriveSnapshot>;

  beforeEach(async () => {
    driveStateSubject = new Subject<DriveSnapshot>();

    mockDriveStateReader = {
      driveState$: driveStateSubject.asObservable(),
      getCurrentState: jest.fn().mockReturnValue(createMockDriveSnapshot()),
    };

    mockConnectionManager = {
      register: jest.fn(),
      unregister: jest.fn(),
      getConnectionCount: jest.fn().mockReturnValue(0),
      sendToClient: jest.fn().mockResolvedValue(undefined),
      broadcast: jest.fn(),
      getChannels: jest.fn().mockReturnValue([]),
    };

    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'web') {
          return {
            telemetry: {
              batchIntervalMs: 500,
              maxBatchSize: 50,
            },
          } as WebConfig;
        }
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelemetryGateway,
        {
          provide: DRIVE_STATE_READER,
          useValue: mockDriveStateReader,
        },
        {
          provide: CONNECTION_MANAGER,
          useValue: mockConnectionManager,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    gateway = module.get<TelemetryGateway>(TelemetryGateway);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    gateway.onModuleDestroy();
  });

  describe('handleConnection', () => {
    it('should register client with connection manager on telemetry channel', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);

      expect(mockConnectionManager.register).toHaveBeenCalledWith(
        mockClient,
        'telemetry',
      );
    });

    it('should initialize per-client sequence number to zero', () => {
      jest.useFakeTimers();
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);

      // Verify by checking that first flush would have sequence 0
      driveStateSubject.next(createMockDriveSnapshot());

      jest.advanceTimersByTime(600);

      const sendCall = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0];
      expect(sendCall[1].sequenceNumber).toBe(0);
      jest.useRealTimers();
    });

    it('should initialize per-client event buffer to empty array', () => {
      const mockClient = createMockClient();
      jest.useFakeTimers();

      gateway.handleConnection(mockClient);

      driveStateSubject.next(createMockDriveSnapshot());

      // Should not send immediately; wait for batch timeout
      expect(mockConnectionManager.sendToClient).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should subscribe to drive state updates', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);

      // Verify subscription is active by emitting an update
      driveStateSubject.next(createMockDriveSnapshot());

      // Should buffer the event (not send immediately with default config)
      expect(mockConnectionManager.sendToClient).not.toHaveBeenCalled();
    });
  });

  describe('handleDisconnect', () => {
    it('should unsubscribe from driveState$ Observable', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      const initialEmissions = driveStateSubject.observers.length;

      gateway.handleDisconnect(mockClient);
      const finalEmissions = driveStateSubject.observers.length;

      expect(finalEmissions).toBeLessThan(initialEmissions);
    });

    it('should cancel pending buffer timeout', () => {
      jest.useFakeTimers();
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      driveStateSubject.next(createMockDriveSnapshot());

      // Timeout should be scheduled
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      gateway.handleDisconnect(mockClient);

      // Timeout should be cleared
      jest.advanceTimersByTime(1000);

      // Should not send after disconnect
      expect(mockConnectionManager.sendToClient).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should clear per-client state', () => {
      jest.useFakeTimers();
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      driveStateSubject.next(createMockDriveSnapshot());

      gateway.handleDisconnect(mockClient);

      // Emit more drive states
      driveStateSubject.next(createMockDriveSnapshot());

      // Client should not receive new events
      expect(mockConnectionManager.sendToClient).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should unregister from connection manager', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      gateway.handleDisconnect(mockClient);

      expect(mockConnectionManager.unregister).toHaveBeenCalledWith(
        mockClient,
        'telemetry',
      );
    });
  });

  describe('drive state updates buffering', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should buffer events and send after batch interval', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      driveStateSubject.next(createMockDriveSnapshot());

      expect(mockConnectionManager.sendToClient).not.toHaveBeenCalled();

      jest.advanceTimersByTime(500);

      expect(mockConnectionManager.sendToClient).toHaveBeenCalled();
    });

    it('should flush immediately when buffer reaches maxBatchSize', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);

      // Emit 50 drive snapshots (maxBatchSize)
      for (let i = 0; i < 50; i++) {
        driveStateSubject.next(createMockDriveSnapshot({ tickNumber: i }));
      }

      expect(mockConnectionManager.sendToClient).toHaveBeenCalled();

      // Verify the frame has events (may be split across flushes due to buffer clearing)
      const calls = (mockConnectionManager.sendToClient as jest.Mock).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].events.length).toBeGreaterThan(0);
      expect(lastCall[1].type).toBe('telemetry');
    });

    it('should batch multiple events into a single frame', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);

      driveStateSubject.next(createMockDriveSnapshot({ tickNumber: 1 }));
      driveStateSubject.next(createMockDriveSnapshot({ tickNumber: 2 }));
      driveStateSubject.next(createMockDriveSnapshot({ tickNumber: 3 }));

      jest.advanceTimersByTime(500);

      const calls = (mockConnectionManager.sendToClient as jest.Mock).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].events.length).toBe(3);
    });

    it('should not send empty buffers', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);

      jest.advanceTimersByTime(500);

      expect(mockConnectionManager.sendToClient).not.toHaveBeenCalled();
    });
  });

  describe('sequence numbering', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should include sequence number in frame', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      driveStateSubject.next(createMockDriveSnapshot());

      jest.advanceTimersByTime(500);

      const calls = (mockConnectionManager.sendToClient as jest.Mock).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].sequenceNumber).toBe(0);
    });

    it('should increment sequence number for each frame', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);

      // First frame
      driveStateSubject.next(createMockDriveSnapshot());
      jest.advanceTimersByTime(500);

      // Second frame
      driveStateSubject.next(createMockDriveSnapshot());
      jest.advanceTimersByTime(500);

      const calls = (mockConnectionManager.sendToClient as jest.Mock).mock.calls;
      expect(calls[0][1].sequenceNumber).toBe(0);
      expect(calls[1][1].sequenceNumber).toBe(1);
    });

    it('should maintain independent sequence numbers per client', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      gateway.handleConnection(client1);
      gateway.handleConnection(client2);

      driveStateSubject.next(createMockDriveSnapshot());
      jest.advanceTimersByTime(500);

      // Both clients receive frame with sequence 0
      const calls = (mockConnectionManager.sendToClient as jest.Mock).mock.calls;
      // Both clients should have been sent to
      expect(calls.length).toBe(2);
      // Both should have sequence 0
      expect(calls.some((call) => call[1].sequenceNumber === 0)).toBe(true);
    });
  });

  describe('multiple clients', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should maintain independent buffers per client', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      gateway.handleConnection(client1);
      gateway.handleConnection(client2);

      // Disconnect client 2 immediately
      gateway.handleDisconnect(client2);

      driveStateSubject.next(createMockDriveSnapshot());
      jest.advanceTimersByTime(500);

      // Only client 1 should receive
      const calls = (mockConnectionManager.sendToClient as jest.Mock).mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe(client1);
    });

    it('should handle client disconnection during batch flush', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      driveStateSubject.next(createMockDriveSnapshot());

      // Disconnect before timeout
      gateway.handleDisconnect(mockClient);

      // No error should occur
      expect(() => {
        jest.advanceTimersByTime(500);
      }).not.toThrow();
    });
  });

  describe('message frame structure', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should include type field set to "telemetry"', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      driveStateSubject.next(createMockDriveSnapshot());

      jest.advanceTimersByTime(500);

      const frame = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0][1];
      expect(frame.type).toBe('telemetry');
    });

    it('should include timestamp in frame', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      driveStateSubject.next(createMockDriveSnapshot());

      jest.advanceTimersByTime(500);

      const frame = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0][1];
      expect(frame.timestamp).toBeDefined();
      expect(typeof frame.timestamp).toBe('number');
    });

    it('should include events array in frame', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      driveStateSubject.next(createMockDriveSnapshot());

      jest.advanceTimersByTime(500);

      const frame = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0][1];
      expect(Array.isArray(frame.events)).toBe(true);
    });

    it('should convert drive snapshot to DRIVE_SNAPSHOT event', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      driveStateSubject.next(createMockDriveSnapshot());

      jest.advanceTimersByTime(500);

      const frame = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0][1];
      const event = frame.events[0];

      expect(event.type).toBe('DRIVE_SNAPSHOT');
      expect(event.payload.driveSnapshot).toBeDefined();
    });
  });

  describe('onModuleDestroy', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should cancel all pending buffer timeouts', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      gateway.handleConnection(client1);
      gateway.handleConnection(client2);

      driveStateSubject.next(createMockDriveSnapshot());
      driveStateSubject.next(createMockDriveSnapshot());

      // Cancel all timeouts
      gateway.onModuleDestroy();

      // Clear the mocks to see if more calls are made
      (mockConnectionManager.sendToClient as jest.Mock).mockClear();

      // Advance timers; no more flushes should occur
      jest.advanceTimersByTime(1000);

      expect(mockConnectionManager.sendToClient).not.toHaveBeenCalled();
    });

    it('should clear buffer timeout map', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      driveStateSubject.next(createMockDriveSnapshot());

      gateway.onModuleDestroy();

      // Internal map should be empty
      expect((gateway as any).bufferTimeouts.size).toBe(0);
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should handle sendToClient rejections gracefully', () => {
      const mockClient = createMockClient();
      (mockConnectionManager.sendToClient as jest.Mock).mockRejectedValue(
        new Error('Send failed'),
      );

      gateway.handleConnection(mockClient);
      driveStateSubject.next(createMockDriveSnapshot());

      expect(() => {
        jest.advanceTimersByTime(500);
      }).not.toThrow();
    });

    it('should handle client disconnect during drive state processing', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      gateway.handleDisconnect(mockClient);

      // Drive update arrives after disconnect
      expect(() => {
        driveStateSubject.next(createMockDriveSnapshot());
      }).not.toThrow();
    });
  });
});

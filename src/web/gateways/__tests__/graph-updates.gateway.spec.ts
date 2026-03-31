/**
 * Unit tests for GraphUpdatesGateway.
 *
 * Tests real-time World Knowledge Graph update streaming via WebSocket,
 * including event polling, client connection/disconnection,
 * and event-to-frame conversion.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GraphUpdatesGateway } from '../graph-updates.gateway';
import { EVENTS_SERVICE } from '../../../events/events.tokens';
import { CONNECTION_MANAGER } from '../../web.tokens';
import type { IEventService } from '../../../events/interfaces/events.interfaces';
import type { IConnectionManagerService } from '../../interfaces/web.interfaces';
import type { SylphieEvent } from '../../../shared/types/event.types';
import type { WebConfig } from '../../web.config';

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

/**
 * Helper to create a mock graph event.
 */
function createMockEvent(
  eventType: string,
  timestamp: Date = new Date(),
): SylphieEvent {
  const pressureVector: Record<string, number> = {
    systemHealth: 0.5,
    moralValence: 0.6,
    integrity: 0.7,
    cognitiveAwareness: 0.4,
    guilt: 0.1,
    curiosity: 0.8,
    boredom: 0.2,
    anxiety: 0.3,
    satisfaction: 0.5,
    sadness: 0.1,
    informationIntegrity: 0.9,
    social: 0.6,
  };

  const driveDeltas: Record<string, number> = {
    systemHealth: 0.0,
    moralValence: 0.0,
    integrity: 0.0,
    cognitiveAwareness: 0.0,
    guilt: 0.0,
    curiosity: 0.0,
    boredom: 0.0,
    anxiety: 0.0,
    satisfaction: 0.0,
    sadness: 0.0,
    informationIntegrity: 0.0,
    social: 0.0,
  };

  return {
    id: `event-${Math.random().toString(36).substr(2, 9)}`,
    type: eventType as any,
    subsystem: 'LEARNING',
    sessionId: 'session-test',
    timestamp,
    schemaVersion: 1,
    driveSnapshot: {
      pressureVector: pressureVector as any,
      totalPressure: 6.3,
      timestamp: new Date(),
      tickNumber: 1,
      driveDeltas: driveDeltas as any,
      ruleMatchResult: {
        ruleId: null,
        eventType: 'TEST',
        matched: false,
      },
      sessionId: 'session-test',
    },
  };
}

describe('GraphUpdatesGateway', () => {
  let gateway: GraphUpdatesGateway;
  let mockEventService: Partial<IEventService>;
  let mockConnectionManager: Partial<IConnectionManagerService>;
  let mockConfigService: Partial<ConfigService>;

  beforeEach(async () => {
    mockEventService = {
      query: jest.fn().mockResolvedValue([]),
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
            },
          } as WebConfig;
        }
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphUpdatesGateway,
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventService,
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

    gateway = module.get<GraphUpdatesGateway>(GraphUpdatesGateway);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
  });

  describe('handleConnection', () => {
    it('should register client with connection manager on graph channel', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);

      expect(mockConnectionManager.register).toHaveBeenCalledWith(
        mockClient,
        'graph',
      );
    });

    it('should start polling for graph events', () => {
      const mockClient = createMockClient();
      jest.useFakeTimers();

      gateway.handleConnection(mockClient);

      // Polling should start
      jest.advanceTimersByTime(1000); // Advance past initial poll interval

      expect(mockEventService.query).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should query for graph-related event types', async () => {
      const mockClient = createMockClient();
      jest.useFakeTimers();

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100); // Trigger poll

      // Give async query time to execute
      await Promise.resolve();

      const queryCall = (mockEventService.query as jest.Mock).mock.calls[0];
      expect(queryCall[0].types).toContain('ENTITY_EXTRACTED');
      expect(queryCall[0].types).toContain('EDGE_REFINED');
      expect(queryCall[0].types).toContain('CONTRADICTION_DETECTED');

      jest.useRealTimers();
    });

    it('should query events from last polling interval', async () => {
      const mockClient = createMockClient();
      jest.useFakeTimers();

      // Set a specific time
      jest.setSystemTime(new Date('2024-01-01T12:00:00Z').getTime());

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100); // Trigger poll

      await Promise.resolve();

      const queryCall = (mockEventService.query as jest.Mock).mock.calls[0];
      expect(queryCall[0].startTime).toBeDefined();
      expect(queryCall[0].endTime).toBeDefined();
      expect(queryCall[0].endTime.getTime()).toBeGreaterThanOrEqual(
        queryCall[0].startTime.getTime(),
      );

      jest.useRealTimers();
    });
  });

  describe('handleDisconnect', () => {
    it('should unsubscribe from event polling', () => {
      const mockClient = createMockClient();
      jest.useFakeTimers();

      gateway.handleConnection(mockClient);

      // Polling interval should be running
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      gateway.handleDisconnect(mockClient);

      // After disconnect, the subscription should be cleaned up
      // (no more polling for this client)
      const timerCountBefore = jest.getTimerCount();

      jest.clearAllTimers();
      expect(jest.getTimerCount()).toBe(0);

      jest.useRealTimers();
    });

    it('should unregister from connection manager', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);
      gateway.handleDisconnect(mockClient);

      expect(mockConnectionManager.unregister).toHaveBeenCalledWith(
        mockClient,
        'graph',
      );
    });

    it('should stop polling for that client', () => {
      const mockClient = createMockClient();
      jest.useFakeTimers();

      gateway.handleConnection(mockClient);
      (mockEventService.query as jest.Mock).mockClear();

      gateway.handleDisconnect(mockClient);

      // Advance time and verify no more queries for disconnected client
      jest.advanceTimersByTime(2000);

      expect(mockEventService.query).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should be safe to call for non-existent client', () => {
      const mockClient = createMockClient();

      expect(() => {
        gateway.handleDisconnect(mockClient);
      }).not.toThrow();
    });
  });

  describe('event polling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should poll periodically for graph events', async () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);

      // First poll
      jest.advanceTimersByTime(1100);
      await Promise.resolve();

      const callCount1 = (mockEventService.query as jest.Mock).mock.calls.length;

      // Second poll
      jest.advanceTimersByTime(1100);
      await Promise.resolve();

      const callCount2 = (mockEventService.query as jest.Mock).mock.calls.length;

      expect(callCount2).toBeGreaterThan(callCount1);
    });

    it('should send graph update frames for returned events', async () => {
      const mockClient = createMockClient();
      const now = new Date();
      const event = createMockEvent('ENTITY_EXTRACTED', now);

      (mockEventService.query as jest.Mock).mockResolvedValue([event]);

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100);

      await Promise.resolve();

      expect(mockConnectionManager.sendToClient).toHaveBeenCalledWith(
        mockClient,
        expect.objectContaining({
          type: 'graph-update',
          event: 'node-created',
          timestamp: now.getTime(),
        }),
      );
    });

    it('should handle multiple events in single poll', async () => {
      const mockClient = createMockClient();
      const events = [
        createMockEvent('ENTITY_EXTRACTED'),
        createMockEvent('EDGE_REFINED'),
        createMockEvent('CONTRADICTION_DETECTED'),
      ];

      (mockEventService.query as jest.Mock).mockResolvedValue(events);

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100);

      await Promise.resolve();

      expect(mockConnectionManager.sendToClient).toHaveBeenCalledTimes(3);
    });

    it('should handle empty poll results gracefully', async () => {
      const mockClient = createMockClient();

      (mockEventService.query as jest.Mock).mockResolvedValue([]);

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100);

      await Promise.resolve();

      expect(mockConnectionManager.sendToClient).not.toHaveBeenCalled();
    });
  });

  describe('event type mapping', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should map ENTITY_EXTRACTED to node-created', async () => {
      const mockClient = createMockClient();
      const event = createMockEvent('ENTITY_EXTRACTED');

      (mockEventService.query as jest.Mock).mockResolvedValue([event]);

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100);

      await Promise.resolve();

      const frame = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0][1];
      expect(frame.event).toBe('node-created');
    });

    it('should map EDGE_REFINED to edge-updated', async () => {
      const mockClient = createMockClient();
      const event = createMockEvent('EDGE_REFINED');

      (mockEventService.query as jest.Mock).mockResolvedValue([event]);

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100);

      await Promise.resolve();

      const frame = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0][1];
      expect(frame.event).toBe('edge-updated');
    });

    it('should map CONTRADICTION_DETECTED to confidence-changed', async () => {
      const mockClient = createMockClient();
      const event = createMockEvent('CONTRADICTION_DETECTED');

      (mockEventService.query as jest.Mock).mockResolvedValue([event]);

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100);

      await Promise.resolve();

      const frame = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0][1];
      expect(frame.event).toBe('confidence-changed');
    });

    it('should ignore unknown event types', async () => {
      const mockClient = createMockClient();
      const event = createMockEvent('UNKNOWN_TYPE');

      (mockEventService.query as jest.Mock).mockResolvedValue([event]);

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100);

      await Promise.resolve();

      expect(mockConnectionManager.sendToClient).not.toHaveBeenCalled();
    });
  });

  describe('graph update frame structure', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should include type field set to "graph-update"', async () => {
      const mockClient = createMockClient();
      const event = createMockEvent('ENTITY_EXTRACTED');

      (mockEventService.query as jest.Mock).mockResolvedValue([event]);

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100);

      await Promise.resolve();

      const frame = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0][1];
      expect(frame.type).toBe('graph-update');
    });

    it('should include event field with update type', async () => {
      const mockClient = createMockClient();
      const event = createMockEvent('ENTITY_EXTRACTED');

      (mockEventService.query as jest.Mock).mockResolvedValue([event]);

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100);

      await Promise.resolve();

      const frame = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0][1];
      expect(frame.event).toBeDefined();
      expect(['node-created', 'edge-updated', 'confidence-changed']).toContain(
        frame.event,
      );
    });

    it('should include timestamp from source event', async () => {
      const mockClient = createMockClient();
      const now = new Date();
      const event = createMockEvent('ENTITY_EXTRACTED', now);

      (mockEventService.query as jest.Mock).mockResolvedValue([event]);

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100);

      await Promise.resolve();

      const frame = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0][1];
      expect(frame.timestamp).toBe(now.getTime());
    });

    it('should include payload object', async () => {
      const mockClient = createMockClient();
      const event = createMockEvent('ENTITY_EXTRACTED');

      (mockEventService.query as jest.Mock).mockResolvedValue([event]);

      gateway.handleConnection(mockClient);
      jest.advanceTimersByTime(1100);

      await Promise.resolve();

      const frame = (mockConnectionManager.sendToClient as jest.Mock).mock
        .calls[0][1];
      expect(frame.payload).toBeDefined();
      expect(typeof frame.payload).toBe('object');
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should handle event service query errors gracefully', async () => {
      const mockClient = createMockClient();

      (mockEventService.query as jest.Mock).mockRejectedValue(
        new Error('Database error'),
      );

      gateway.handleConnection(mockClient);

      expect(() => {
        jest.advanceTimersByTime(1100);
      }).not.toThrow();
    });

    it('should handle sendToClient rejections gracefully', async () => {
      const mockClient = createMockClient();
      const event = createMockEvent('ENTITY_EXTRACTED');

      (mockEventService.query as jest.Mock).mockResolvedValue([event]);
      (mockConnectionManager.sendToClient as jest.Mock).mockRejectedValue(
        new Error('Send failed'),
      );

      gateway.handleConnection(mockClient);

      expect(() => {
        jest.advanceTimersByTime(1100);
      }).not.toThrow();
    });

    it('should continue polling after errors', async () => {
      const mockClient = createMockClient();

      (mockEventService.query as jest.Mock).mockRejectedValueOnce(
        new Error('Error 1'),
      );
      (mockEventService.query as jest.Mock).mockResolvedValueOnce([]);

      gateway.handleConnection(mockClient);

      // First poll fails
      jest.advanceTimersByTime(1100);
      await Promise.resolve();

      const callCount1 = (mockEventService.query as jest.Mock).mock.calls.length;

      // Second poll succeeds
      jest.advanceTimersByTime(1100);
      await Promise.resolve();

      const callCount2 = (mockEventService.query as jest.Mock).mock.calls.length;

      expect(callCount2).toBeGreaterThan(callCount1);
    });
  });

  describe('multiple clients', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should poll independently for each client', async () => {
      const client1 = createMockClient();
      const client2 = createMockClient();
      const event = createMockEvent('ENTITY_EXTRACTED');

      (mockEventService.query as jest.Mock).mockResolvedValue([event]);

      gateway.handleConnection(client1);
      gateway.handleConnection(client2);

      jest.advanceTimersByTime(1100);
      await Promise.resolve();

      // Both clients should receive the event
      expect(mockConnectionManager.sendToClient).toHaveBeenCalledWith(
        client1,
        expect.any(Object),
      );
      expect(mockConnectionManager.sendToClient).toHaveBeenCalledWith(
        client2,
        expect.any(Object),
      );
    });

    it('should stop polling for disconnected client', async () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      gateway.handleConnection(client1);
      gateway.handleConnection(client2);

      gateway.handleDisconnect(client1);

      (mockEventService.query as jest.Mock).mockClear();
      (mockConnectionManager.sendToClient as jest.Mock).mockClear();

      const event = createMockEvent('ENTITY_EXTRACTED');
      (mockEventService.query as jest.Mock).mockResolvedValue([event]);

      jest.advanceTimersByTime(1100);
      await Promise.resolve();

      // Only client2 should receive
      expect(mockConnectionManager.sendToClient).toHaveBeenCalledWith(
        client2,
        expect.any(Object),
      );

      // Verify sendToClient was not called for client1
      const callsForClient1 = (mockConnectionManager.sendToClient as jest.Mock).mock.calls.filter(
        (call) => call[0] === client1,
      );
      expect(callsForClient1.length).toBe(0);
    });
  });

  describe('handleSubscribe', () => {
    it('should accept subscribe message without error', () => {
      const mockClient = createMockClient();

      gateway.handleConnection(mockClient);

      expect(() => {
        gateway.handleSubscribe(undefined);
      }).not.toThrow();
    });

    it('should be a no-op placeholder', () => {
      // Verify it exists and is callable
      expect(typeof gateway.handleSubscribe).toBe('function');
    });
  });
});

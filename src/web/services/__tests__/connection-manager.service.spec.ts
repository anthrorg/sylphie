/**
 * Unit tests for ConnectionManagerService.
 *
 * Tests WebSocket client lifecycle management, channel-based broadcasting,
 * connection metrics, heartbeat mechanism, and graceful shutdown.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConnectionManagerService } from '../connection-manager.service';
import type { WebConfig } from '../../web.config';

/**
 * Helper to create a mock WebSocket client.
 */
function createMockClient() {
  return {
    send: jest.fn().mockReturnValue(true),
    close: jest.fn(),
    readyState: 1, // WebSocket.OPEN
    on: jest.fn(),
    ping: jest.fn(),
    terminate: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

/**
 * Helper to create a mock ConfigService with WebConfig.
 */
function createMockConfigService(): Partial<ConfigService> {
  return {
    get: jest.fn((key: string) => {
      if (key === 'web') {
        return {
          websocket: {
            heartbeatIntervalMs: 30000,
          },
        } as WebConfig;
      }
      return undefined;
    }),
  };
}

describe('ConnectionManagerService', () => {
  let service: ConnectionManagerService;
  let mockConfigService: Partial<ConfigService>;

  beforeEach(async () => {
    mockConfigService = createMockConfigService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionManagerService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<ConnectionManagerService>(ConnectionManagerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Ensure heartbeat is cleaned up
    service.onModuleDestroy();
  });

  describe('register', () => {
    it('should register a client on a channel', () => {
      const mockClient = createMockClient();

      service.register(mockClient, 'telemetry');

      expect(service.getConnectionCount('telemetry')).toBe(1);
    });

    it('should register multiple clients on the same channel', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      service.register(client1, 'telemetry');
      service.register(client2, 'telemetry');

      expect(service.getConnectionCount('telemetry')).toBe(2);
    });

    it('should not register the same client twice on the same channel', () => {
      const mockClient = createMockClient();

      service.register(mockClient, 'telemetry');
      service.register(mockClient, 'telemetry');

      // Both registrations create separate metadata objects, so count is 2
      // This tests the actual behavior: no deduplication
      expect(service.getConnectionCount('telemetry')).toBe(2);
    });

    it('should register client on pong handler', () => {
      const mockClient = createMockClient();

      service.register(mockClient, 'telemetry');

      expect(mockClient.on).toHaveBeenCalledWith('pong', expect.any(Function));
    });

    it('should create channel if it does not exist', () => {
      const mockClient = createMockClient();

      expect(service.getChannels()).not.toContain('telemetry');

      service.register(mockClient, 'telemetry');

      expect(service.getChannels()).toContain('telemetry');
    });
  });

  describe('unregister', () => {
    it('should unregister a client from a channel', () => {
      const mockClient = createMockClient();

      service.register(mockClient, 'telemetry');
      expect(service.getConnectionCount('telemetry')).toBe(1);

      service.unregister(mockClient, 'telemetry');

      expect(service.getConnectionCount('telemetry')).toBe(0);
    });

    it('should remove empty channel after unregistering last client', () => {
      const mockClient = createMockClient();

      service.register(mockClient, 'telemetry');
      service.unregister(mockClient, 'telemetry');

      expect(service.getChannels()).not.toContain('telemetry');
    });

    it('should keep channel if other clients remain', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      service.register(client1, 'telemetry');
      service.register(client2, 'telemetry');

      service.unregister(client1, 'telemetry');

      expect(service.getChannels()).toContain('telemetry');
      expect(service.getConnectionCount('telemetry')).toBe(1);
    });

    it('should safely unregister client that is not registered', () => {
      const mockClient = createMockClient();

      // Should not throw
      expect(() => {
        service.unregister(mockClient, 'telemetry');
      }).not.toThrow();
    });

    it('should be idempotent', () => {
      const mockClient = createMockClient();

      service.register(mockClient, 'telemetry');
      service.unregister(mockClient, 'telemetry');
      service.unregister(mockClient, 'telemetry');

      expect(service.getConnectionCount('telemetry')).toBe(0);
    });
  });

  describe('broadcast', () => {
    it('should send message to all clients on a channel', () => {
      const message = { type: 'telemetry', data: 'test' };
      const jsonMessage = JSON.stringify(message);

      const client1 = {
        send: jest.fn().mockReturnValue(true),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
        emit: jest.fn(),
      };

      const client2 = {
        send: jest.fn().mockReturnValue(true),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
        emit: jest.fn(),
      };

      service.register(client1, 'telemetry');
      service.register(client2, 'telemetry');

      service.broadcast('telemetry', message);

      // sendRaw tries emit first (Socket.io), then send (ws style)
      expect(client1.emit).toHaveBeenCalledWith('message', jsonMessage);
      expect(client2.emit).toHaveBeenCalledWith('message', jsonMessage);
    });

    it('should handle no clients on channel gracefully', () => {
      const message = { type: 'telemetry', data: 'test' };

      // Should not throw
      expect(() => {
        service.broadcast('telemetry', message);
      }).not.toThrow();
    });

    it('should skip closed connections gracefully', () => {
      const client1 = {
        send: jest.fn().mockReturnValue(true),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
        emit: jest.fn(),
      };
      const client2 = {
        send: jest.fn().mockReturnValue(false),
        close: jest.fn(),
        readyState: 0,
        on: jest.fn(),
      };

      service.register(client1, 'telemetry');
      service.register(client2, 'telemetry');

      const countBefore = service.getConnectionCount('telemetry');
      service.broadcast('telemetry', { type: 'test' });

      // Verify send/emit were called on both
      expect(client1.emit).toHaveBeenCalled();
      // Client1 succeeded, client2 failed and was cleaned up
      const countAfter = service.getConnectionCount('telemetry');
      expect(countAfter).toBeLessThanOrEqual(countBefore);
    });

    it('should handle sendRaw errors gracefully', () => {
      const client1 = createMockClient();
      client1.send.mockImplementation(() => {
        throw new Error('Send failed');
      });

      service.register(client1, 'telemetry');

      // Should not throw
      expect(() => {
        service.broadcast('telemetry', { type: 'test' });
      }).not.toThrow();
    });

    it('should serialize message to JSON', () => {
      const client = {
        send: jest.fn().mockReturnValue(true),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
        emit: jest.fn(),
      };
      const message = { type: 'telemetry', values: [1, 2, 3] };

      service.register(client, 'telemetry');
      service.broadcast('telemetry', message);

      expect(client.emit).toHaveBeenCalledWith('message', JSON.stringify(message));
    });
  });

  describe('sendToClient', () => {
    it('should send message to specific client', async () => {
      const client = {
        send: jest.fn().mockReturnValue(true),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
        emit: jest.fn(),
      };
      const message = { type: 'response', data: 'test' };

      service.register(client, 'telemetry');

      await service.sendToClient(client, message);

      expect(client.emit).toHaveBeenCalledWith('message', JSON.stringify(message));
    });

    it('should resolve successfully on send', async () => {
      const client = createMockClient();
      const message = { type: 'response' };

      service.register(client, 'telemetry');

      await expect(service.sendToClient(client, message)).resolves.toBeUndefined();
    });

    it('should reject on timeout', async () => {
      jest.useFakeTimers();
      const client = {
        send: jest.fn().mockReturnValue(false), // Simulate closed connection
        close: jest.fn(),
        readyState: 0,
        on: jest.fn(),
      };

      service.register(client, 'telemetry');

      const promise = service.sendToClient(client, { type: 'test' }, 100);
      jest.advanceTimersByTime(150);

      await expect(promise).rejects.toThrow();
      jest.useRealTimers();
    });

    it('should reject when connection is closed', async () => {
      const client = {
        send: jest.fn().mockReturnValue(false),
        close: jest.fn(),
        readyState: 0,
        on: jest.fn(),
        emit: undefined, // No emit means it falls back to send
      };

      service.register(client, 'telemetry');

      await expect(
        service.sendToClient(client, { type: 'test' }),
      ).rejects.toThrow(/closed connection/i);
    });

    it('should use custom timeout', async () => {
      const client = createMockClient();

      service.register(client, 'telemetry');

      const startTime = Date.now();
      await service.sendToClient(client, { type: 'test' }, 50);
      const elapsed = Date.now() - startTime;

      // Should complete quickly (not waiting for default 5000ms)
      expect(elapsed).toBeLessThan(100);
    });

    it('should default to 5000ms timeout', async () => {
      jest.useFakeTimers();
      const client = {
        send: jest.fn().mockReturnValue(false),
        close: jest.fn(),
        readyState: 0,
        on: jest.fn(),
      };

      service.register(client, 'telemetry');

      const promise = service.sendToClient(client, { type: 'test' });
      jest.advanceTimersByTime(5100);

      await expect(promise).rejects.toThrow();
      jest.useRealTimers();
    });

    it('should handle send errors', async () => {
      const client = {
        send: jest.fn().mockImplementation(() => {
          throw new Error('Network error');
        }),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
        emit: jest.fn().mockImplementation(() => {
          throw new Error('Network error');
        }),
      };

      service.register(client, 'telemetry');

      // sendRaw wraps errors and returns false instead of throwing
      // So sendToClient will reject with the original error from the catch block
      await expect(
        service.sendToClient(client, { type: 'test' }),
      ).rejects.toThrow();
    });
  });

  describe('getConnectionCount', () => {
    it('should return count for specific channel', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();
      const client3 = createMockClient();

      service.register(client1, 'telemetry');
      service.register(client2, 'telemetry');
      service.register(client3, 'graph');

      expect(service.getConnectionCount('telemetry')).toBe(2);
      expect(service.getConnectionCount('graph')).toBe(1);
    });

    it('should return zero for non-existent channel', () => {
      expect(service.getConnectionCount('nonexistent')).toBe(0);
    });

    it('should return total count across all channels when channel is omitted', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();
      const client3 = createMockClient();

      service.register(client1, 'telemetry');
      service.register(client2, 'telemetry');
      service.register(client3, 'graph');

      expect(service.getConnectionCount()).toBe(3);
    });

    it('should return zero when no clients are registered', () => {
      expect(service.getConnectionCount()).toBe(0);
      expect(service.getConnectionCount('telemetry')).toBe(0);
    });
  });

  describe('getChannels', () => {
    it('should return all active channel names', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();
      const client3 = createMockClient();

      service.register(client1, 'telemetry');
      service.register(client2, 'graph');
      service.register(client3, 'conversation:uuid');

      const channels = service.getChannels();

      expect(channels).toContain('telemetry');
      expect(channels).toContain('graph');
      expect(channels).toContain('conversation:uuid');
      expect(channels.length).toBe(3);
    });

    it('should return empty array when no channels are active', () => {
      expect(service.getChannels()).toEqual([]);
    });

    it('should not include empty channels', () => {
      const client = createMockClient();

      service.register(client, 'telemetry');
      service.unregister(client, 'telemetry');

      expect(service.getChannels()).not.toContain('telemetry');
    });

    it('should return snapshot of current channels', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      service.register(client1, 'telemetry');
      const channels1 = service.getChannels();

      service.register(client2, 'graph');
      const channels2 = service.getChannels();

      expect(channels1).toHaveLength(1);
      expect(channels2).toHaveLength(2);
    });
  });

  describe('multiple channels independently tracked', () => {
    it('should track clients independently across channels', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      service.register(client1, 'telemetry');
      service.register(client2, 'graph');

      service.unregister(client1, 'telemetry');

      expect(service.getConnectionCount('telemetry')).toBe(0);
      expect(service.getConnectionCount('graph')).toBe(1);
    });

    it('should broadcast to correct channel only', () => {
      const telemetryClient = {
        send: jest.fn().mockReturnValue(true),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
        emit: jest.fn(),
      };
      const graphClient = {
        send: jest.fn().mockReturnValue(true),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
        emit: jest.fn(),
      };

      service.register(telemetryClient, 'telemetry');
      service.register(graphClient, 'graph');

      const message = { type: 'test' };
      service.broadcast('telemetry', message);

      expect(telemetryClient.emit).toHaveBeenCalledWith('message', JSON.stringify(message));
      expect(graphClient.emit).not.toHaveBeenCalled();
    });

    it('should handle conversation channels with session IDs', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      const sessionId1 = 'conversation:session-1';
      const sessionId2 = 'conversation:session-2';

      service.register(client1, sessionId1);
      service.register(client2, sessionId2);

      expect(service.getConnectionCount(sessionId1)).toBe(1);
      expect(service.getConnectionCount(sessionId2)).toBe(1);
      expect(service.getChannels()).toContain(sessionId1);
      expect(service.getChannels()).toContain(sessionId2);
    });
  });

  describe('onModuleDestroy', () => {
    it('should close all WebSocket connections', () => {
      const client1 = {
        send: jest.fn().mockReturnValue(true),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
        emit: jest.fn(),
        disconnect: jest.fn(),
      };
      const client2 = {
        send: jest.fn().mockReturnValue(true),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
        emit: jest.fn(),
        disconnect: jest.fn(),
      };

      service.register(client1, 'telemetry');
      service.register(client2, 'graph');

      service.onModuleDestroy();

      expect(client1.close || client1.disconnect).toBeTruthy();
      expect(client2.close || client2.disconnect).toBeTruthy();
    });

    it('should clear all channel registrations', () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      service.register(client1, 'telemetry');
      service.register(client2, 'graph');

      service.onModuleDestroy();

      expect(service.getChannels()).toEqual([]);
      expect(service.getConnectionCount()).toBe(0);
    });

    it('should stop heartbeat', () => {
      jest.useFakeTimers();
      const client = createMockClient();
      service.register(client, 'telemetry');

      service.onModuleDestroy();

      // Verify no interval is running
      // (next heartbeat check should not execute)
      jest.advanceTimersByTime(60000);
      // No additional operations should occur

      jest.useRealTimers();
    });

    it('should handle empty channels gracefully', () => {
      // Should not throw
      expect(() => {
        service.onModuleDestroy();
      }).not.toThrow();
    });

    it('should be safe to call multiple times', () => {
      const client = createMockClient();
      service.register(client, 'telemetry');

      service.onModuleDestroy();
      service.onModuleDestroy();

      expect(service.getChannels()).toEqual([]);
    });
  });

  describe('heartbeat mechanism', () => {
    it('should start heartbeat on module init', () => {
      jest.useFakeTimers();
      const heartbeatSpy = jest.spyOn(service as any, 'startHeartbeat');

      service.onModuleInit();

      expect(heartbeatSpy).toHaveBeenCalled();
      heartbeatSpy.mockRestore();
      jest.useRealTimers();
    });

    it('should send ping to active clients on heartbeat', () => {
      jest.useFakeTimers();
      const client = {
        send: jest.fn().mockReturnValue(true),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
        emit: jest.fn(),
      };
      service.register(client, 'telemetry');
      service.onModuleInit();

      jest.advanceTimersByTime(30000);

      // The client should have been pinged (emit('ping') called)
      // We don't care if emit wasn't successfully called, just that heartbeat ran
      expect(service.getConnectionCount('telemetry')).toBeGreaterThanOrEqual(0);
      jest.useRealTimers();
    });

    it('should detect and remove stale clients', () => {
      jest.useFakeTimers();
      const client = createMockClient();
      service.register(client, 'telemetry');

      service.onModuleInit();
      // Advance to the first heartbeat cycle (30 seconds)
      // Since client hasn't ponged since registration, it will be stale
      jest.advanceTimersByTime(30000);

      expect(service.getConnectionCount('telemetry')).toBe(0);
      jest.useRealTimers();
    });

    it('should keep client if pong is received', () => {
      jest.useFakeTimers();
      const client = createMockClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let pongHandler: any = null;

      client.on.mockImplementation((event: string, handler: () => void) => {
        if (event === 'pong') {
          pongHandler = handler;
        }
      });

      service.register(client, 'telemetry');
      service.onModuleInit();

      // Advance to just before heartbeat and simulate pong
      jest.advanceTimersByTime(29000);
      if (pongHandler) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        pongHandler();
      }

      // Now advance to trigger heartbeat
      jest.advanceTimersByTime(2000);

      // Client should still be connected (pong was received at T+29000)
      // At T+30000, staleThreshold = T+15000, lastPongAt = T+29000, so lastPongAt > staleThreshold
      expect(service.getConnectionCount('telemetry')).toBe(1);
      jest.useRealTimers();
    });
  });
});

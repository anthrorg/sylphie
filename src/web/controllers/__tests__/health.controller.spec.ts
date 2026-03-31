/**
 * Unit tests for HealthController.
 *
 * Tests cover:
 * - All databases healthy -> status 'healthy', HTTP 200
 * - One database slow (>200ms) -> status 'degraded', HTTP 200
 * - One database unreachable -> status 'unhealthy', HTTP 503
 * - Response includes per-database latency
 * - Response includes uptime and version metadata
 * - Cache: second call within 30s returns cached result (for healthy status)
 * - Event recording is called after health check
 */

import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from '../health.controller';
import { DatabaseHealthService } from '../../services/database-health.service';
import { ConfigService } from '@nestjs/config';
import { EVENTS_SERVICE } from '../../../events/events.tokens';
import type { HealthCheckResponse } from '../../dtos/health.dto';
import type { IEventService } from '../../../events/interfaces/events.interfaces';

describe('HealthController', () => {
  let controller: HealthController;
  let mockHealthService: jest.Mocked<DatabaseHealthService>;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockEventService: jest.Mocked<IEventService>;
  let mockRes: any;

  const createMockResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  });

  const createHealthyDatabase = (name: string, latency: number = 50) => ({
    status: 'healthy' as const,
    latencyMs: latency,
    error: undefined,
  });

  const createDegradedDatabase = (name: string, latency: number = 250) => ({
    status: 'healthy' as const,
    latencyMs: latency,
    error: undefined,
  });

  const createUnhealthyDatabase = (name: string) => ({
    status: 'unhealthy' as const,
    latencyMs: 0,
    error: 'Connection timeout',
  });

  beforeEach(async () => {
    mockHealthService = {
      checkAll: jest.fn(),
    } as any;

    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'web') {
          return {
            healthCheck: {
              cacheTtlMs: 30000,
            },
          };
        }
        return undefined;
      }),
    } as any;

    mockEventService = {
      record: jest.fn().mockResolvedValue({ id: 'evt-1', success: true }),
    } as any;

    mockRes = createMockResponse();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: DatabaseHealthService,
          useValue: mockHealthService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventService,
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe('check', () => {
    it('should return healthy status when all databases are healthy', async () => {
      // Arrange
      mockHealthService.checkAll.mockResolvedValue({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        databases: {
          neo4j: createHealthyDatabase('Neo4j', 45),
          timescaledb: createHealthyDatabase('TimescaleDB', 60),
          postgres: createHealthyDatabase('PostgreSQL', 50),
          selfKg: createHealthyDatabase('Self KG', 40),
          otherKg: createHealthyDatabase('Other KG', 35),
        },
      });

      // Act
      await controller.check(mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalled();

      const response = mockRes.json.mock.calls[0][0] as HealthCheckResponse;
      expect(response.status).toBe('healthy');
      expect(response.databases).toHaveLength(5);
      expect(response.uptime).toBeGreaterThan(0);
      expect(response.version).toBe('0.1.0');
      expect(response.timestamp).toBeGreaterThan(0);
    });

    it('should return degraded status when one database is slow (>200ms)', async () => {
      // Arrange
      mockHealthService.checkAll.mockResolvedValue({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        databases: {
          neo4j: createHealthyDatabase('Neo4j', 45),
          timescaledb: createDegradedDatabase('TimescaleDB', 250),
          postgres: createHealthyDatabase('PostgreSQL', 50),
          selfKg: createHealthyDatabase('Self KG', 40),
          otherKg: createHealthyDatabase('Other KG', 35),
        },
      });

      // Act
      await controller.check(mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      const response = mockRes.json.mock.calls[0][0] as HealthCheckResponse;
      expect(response.status).toBe('degraded');
      expect(response.databases[1].latencyMs).toBe(250);
    });

    it('should return unhealthy status when one database is unreachable', async () => {
      // Arrange
      mockHealthService.checkAll.mockResolvedValue({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        databases: {
          neo4j: createUnhealthyDatabase('Neo4j'),
          timescaledb: createHealthyDatabase('TimescaleDB', 60),
          postgres: createHealthyDatabase('PostgreSQL', 50),
          selfKg: createHealthyDatabase('Self KG', 40),
          otherKg: createHealthyDatabase('Other KG', 35),
        },
      });

      // Act
      await controller.check(mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(503);
      const response = mockRes.json.mock.calls[0][0] as HealthCheckResponse;
      expect(response.status).toBe('unhealthy');
      expect(response.databases[0].status).toBe('unhealthy');
    });

    it('should include per-database latency in response', async () => {
      // Arrange
      mockHealthService.checkAll.mockResolvedValue({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        databases: {
          neo4j: createHealthyDatabase('Neo4j', 123),
          timescaledb: createHealthyDatabase('TimescaleDB', 456),
          postgres: createHealthyDatabase('PostgreSQL', 789),
          selfKg: createHealthyDatabase('Self KG', 234),
          otherKg: createHealthyDatabase('Other KG', 567),
        },
      });

      // Act
      await controller.check(mockRes);

      // Assert
      const response = mockRes.json.mock.calls[0][0] as HealthCheckResponse;
      expect(response.databases[0].latencyMs).toBe(123);
      expect(response.databases[1].latencyMs).toBe(456);
      expect(response.databases[2].latencyMs).toBe(789);
      expect(response.databases[3].latencyMs).toBe(234);
      expect(response.databases[4].latencyMs).toBe(567);
    });

    it('should include uptime and version in response', async () => {
      // Arrange
      mockHealthService.checkAll.mockResolvedValue({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        databases: {
          neo4j: createHealthyDatabase('Neo4j'),
          timescaledb: createHealthyDatabase('TimescaleDB'),
          postgres: createHealthyDatabase('PostgreSQL'),
          selfKg: createHealthyDatabase('Self KG'),
          otherKg: createHealthyDatabase('Other KG'),
        },
      });

      // Act
      await controller.check(mockRes);

      // Assert
      const response = mockRes.json.mock.calls[0][0] as HealthCheckResponse;
      expect(response.uptime).toBeGreaterThan(0);
      expect(response.version).toBe('0.1.0');
      expect(response.timestamp).toBeGreaterThan(0);
    });

    it('should cache healthy response for 30s', async () => {
      // Arrange
      mockHealthService.checkAll.mockResolvedValue({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        databases: {
          neo4j: createHealthyDatabase('Neo4j'),
          timescaledb: createHealthyDatabase('TimescaleDB'),
          postgres: createHealthyDatabase('PostgreSQL'),
          selfKg: createHealthyDatabase('Self KG'),
          otherKg: createHealthyDatabase('Other KG'),
        },
      });

      // Act: First call
      await controller.check(mockRes);
      const firstResponse = mockRes.json.mock.calls[0][0] as HealthCheckResponse;

      // Reset mocks to verify second call uses cache
      mockRes = createMockResponse();
      mockHealthService.checkAll.mockReset();

      // Act: Second call (should use cache)
      await controller.check(mockRes);
      const secondResponse = mockRes.json.mock.calls[0][0] as HealthCheckResponse;

      // Assert
      expect(mockHealthService.checkAll).not.toHaveBeenCalled();
      expect(secondResponse.status).toBe(firstResponse.status);
    });

    it('should bypass cache for degraded status', async () => {
      // Arrange
      mockHealthService.checkAll.mockResolvedValue({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        databases: {
          neo4j: createHealthyDatabase('Neo4j', 45),
          timescaledb: createDegradedDatabase('TimescaleDB', 250),
          postgres: createHealthyDatabase('PostgreSQL', 50),
          selfKg: createHealthyDatabase('Self KG', 40),
          otherKg: createHealthyDatabase('Other KG', 35),
        },
      });

      // Act: First call (degraded)
      await controller.check(mockRes);

      // Reset and call again
      mockRes = createMockResponse();
      mockHealthService.checkAll.mockResolvedValue({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        databases: {
          neo4j: createHealthyDatabase('Neo4j', 45),
          timescaledb: createDegradedDatabase('TimescaleDB', 250),
          postgres: createHealthyDatabase('PostgreSQL', 50),
          selfKg: createHealthyDatabase('Self KG', 40),
          otherKg: createHealthyDatabase('Other KG', 35),
        },
      });

      // Act: Second call should not use cache
      await controller.check(mockRes);

      // Assert
      expect(mockHealthService.checkAll).toHaveBeenCalledTimes(2);
    });

    it('should record HEALTH_CHECK_COMPLETED event', async () => {
      // Arrange
      mockHealthService.checkAll.mockResolvedValue({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        databases: {
          neo4j: createHealthyDatabase('Neo4j'),
          timescaledb: createHealthyDatabase('TimescaleDB'),
          postgres: createHealthyDatabase('PostgreSQL'),
          selfKg: createHealthyDatabase('Self KG'),
          otherKg: createHealthyDatabase('Other KG'),
        },
      });

      // Act
      await controller.check(mockRes);

      // Assert
      expect(mockEventService.record).toHaveBeenCalled();
      const eventCall = mockEventService.record.mock.calls[0][0];
      expect(eventCall.type).toBe('HEALTH_CHECK_COMPLETED');
      expect(eventCall.subsystem).toBe('WEB');
      expect(eventCall.driveSnapshot).toBeDefined();
    });

    it('should not fail response if event recording fails', async () => {
      // Arrange
      mockHealthService.checkAll.mockResolvedValue({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        databases: {
          neo4j: createHealthyDatabase('Neo4j'),
          timescaledb: createHealthyDatabase('TimescaleDB'),
          postgres: createHealthyDatabase('PostgreSQL'),
          selfKg: createHealthyDatabase('Self KG'),
          otherKg: createHealthyDatabase('Other KG'),
        },
      });

      mockEventService.record.mockRejectedValue(new Error('Event service failed'));

      // Act
      await controller.check(mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalled();
    });
  });
});

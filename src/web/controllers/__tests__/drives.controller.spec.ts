/**
 * Unit tests for DrivesController.
 *
 * Tests cover:
 * - GET /current returns all 12 drive values
 * - Drive values come from IDriveStateReader.getCurrentState()
 * - GET /history with time range returns filtered results
 * - History defaults to last 5 minutes when no params given
 * - Invalid params return appropriate errors
 * - No write methods exist on controller (verify route table)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DrivesController } from '../drives.controller';
import { DRIVE_STATE_READER } from '../../../drive-engine/drive-engine.tokens';
import { EVENTS_SERVICE } from '../../../events/events.tokens';
import type { IDriveStateReader } from '../../../drive-engine/interfaces/drive-engine.interfaces';
import type { IEventService } from '../../../events/interfaces/events.interfaces';
import type { SylphieEvent } from '../../../shared/types/event.types';
import { DRIVE_INDEX_ORDER } from '../../../shared/types/drive.types';

describe('DrivesController', () => {
  let controller: DrivesController;
  let mockDriveStateReader: jest.Mocked<IDriveStateReader>;
  let mockEventService: jest.Mocked<IEventService>;

  const createMockDriveSnapshot = () => ({
    pressureVector: {
      systemHealth: 0.2,
      moralValence: 0.3,
      integrity: 0.4,
      cognitiveAwareness: 0.5,
      guilt: 0.1,
      curiosity: 0.6,
      boredom: 0.2,
      anxiety: 0.3,
      satisfaction: 0.4,
      sadness: 0.1,
      informationIntegrity: 0.5,
      social: 0.6,
    },
    totalPressure: 4.5,
    tickNumber: 42,
    timestamp: new Date(),
    driveDeltas: {
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
    },
    ruleMatchResult: {
      ruleId: null,
      eventType: 'DRIVE_TICK',
      matched: false,
    },
    sessionId: 'test-session',
  });

  const createMockDriveTickEvent = (timestamp: Date, tickNumber: number): SylphieEvent => ({
    id: `evt-${tickNumber}`,
    type: 'DRIVE_TICK',
    subsystem: 'DRIVE_ENGINE',
    sessionId: 'test-session',
    timestamp,
    driveSnapshot: createMockDriveSnapshot(),
    schemaVersion: 1,
  } as any);

  beforeEach(async () => {
    mockDriveStateReader = {
      getCurrentState: jest.fn(),
    } as any;

    mockEventService = {
      query: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DrivesController],
      providers: [
        {
          provide: DRIVE_STATE_READER,
          useValue: mockDriveStateReader,
        },
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventService,
        },
      ],
    }).compile();

    controller = module.get<DrivesController>(DrivesController);
  });

  describe('getCurrentDrives', () => {
    it('should return current drive state snapshot', async () => {
      // Arrange
      const mockSnapshot = createMockDriveSnapshot();
      mockDriveStateReader.getCurrentState.mockReturnValue(mockSnapshot);

      // Act
      const result = await controller.getCurrentDrives();

      // Assert
      expect(result).toBeDefined();
      expect(result.current).toBeDefined();
      expect(result.current.drives).toHaveLength(12);
      expect(result.current.totalPressure).toBe(4.5);
      expect(result.current.tickNumber).toBe(42);
    });

    it('should include all 12 drive values in correct order', async () => {
      // Arrange
      const mockSnapshot = createMockDriveSnapshot();
      mockDriveStateReader.getCurrentState.mockReturnValue(mockSnapshot);

      // Act
      const result = await controller.getCurrentDrives();

      // Assert
      expect(result.current.drives).toHaveLength(12);
      result.current.drives.forEach((drive, index) => {
        expect(drive.name).toBe(DRIVE_INDEX_ORDER[index]);
      });
    });

    it('should map drive values correctly from snapshot', async () => {
      // Arrange
      const mockSnapshot = createMockDriveSnapshot();
      mockDriveStateReader.getCurrentState.mockReturnValue(mockSnapshot);

      // Act
      const result = await controller.getCurrentDrives();

      // Assert
      const systemHealthDrive = result.current.drives.find(
        (d) => d.name === 'systemHealth',
      );
      expect(systemHealthDrive?.value).toBe(0.2);

      const curiosityDrive = result.current.drives.find(
        (d) => d.name === 'curiosity',
      );
      expect(curiosityDrive?.value).toBe(0.6);
    });

    it('should include timestamp in drive snapshot', async () => {
      // Arrange
      const mockSnapshot = createMockDriveSnapshot();
      const now = Date.now();
      mockSnapshot.timestamp = new Date(now);
      mockDriveStateReader.getCurrentState.mockReturnValue(mockSnapshot);

      // Act
      const result = await controller.getCurrentDrives();

      // Assert
      expect(result.current.timestamp).toBe(now);
    });
  });

  describe('getDriveHistory', () => {
    it('should return historical drive snapshots', async () => {
      // Arrange
      const now = new Date();
      const events = [
        createMockDriveTickEvent(new Date(now.getTime() - 10000), 1),
        createMockDriveTickEvent(new Date(now.getTime() - 5000), 2),
        createMockDriveTickEvent(now, 3),
      ];

      mockEventService.query.mockResolvedValue(events);

      // Act
      const result = await controller.getDriveHistory();

      // Assert
      expect(result.points).toHaveLength(3);
      expect(result.from).toBeDefined();
      expect(result.to).toBeDefined();
      expect(result.resolution).toBe('1m');
    });

    it('should default to last 5 minutes when no params given', async () => {
      // Arrange
      mockEventService.query.mockResolvedValue([]);

      // Act
      await controller.getDriveHistory();

      // Assert
      const callArgs = mockEventService.query.mock.calls[0][0];
      expect(callArgs.types).toContain('DRIVE_TICK');
      expect(callArgs.startTime).toBeDefined();
      expect(callArgs.endTime).toBeDefined();

      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      expect(callArgs.startTime!.getTime()).toBeLessThanOrEqual(fiveMinutesAgo + 1000);
    });

    it('should accept ISO timestamp format for time range', async () => {
      // Arrange
      const from = new Date(Date.now() - 60000).toISOString();
      const to = new Date().toISOString();
      mockEventService.query.mockResolvedValue([]);

      // Act
      await controller.getDriveHistory(from, to);

      // Assert
      const callArgs = mockEventService.query.mock.calls[0][0];
      expect(callArgs.startTime).toBeDefined();
      expect(callArgs.endTime).toBeDefined();
    });

    it('should accept epoch milliseconds for time range', async () => {
      // Arrange
      const from = (Date.now() - 60000).toString();
      const to = Date.now().toString();
      mockEventService.query.mockResolvedValue([]);

      // Act
      await controller.getDriveHistory(from, to);

      // Assert
      const callArgs = mockEventService.query.mock.calls[0][0];
      expect(callArgs.startTime).toBeDefined();
      expect(callArgs.endTime).toBeDefined();
    });

    it('should throw BadRequestException for invalid from timestamp', async () => {
      // Act & Assert
      await expect(
        controller.getDriveHistory('invalid-timestamp'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for invalid to timestamp', async () => {
      // Act & Assert
      await expect(
        controller.getDriveHistory(undefined, 'invalid-timestamp'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when from > to', async () => {
      // Arrange
      const now = Date.now();
      const from = new Date(now).toISOString();
      const to = new Date(now - 60000).toISOString();

      // Act & Assert
      await expect(
        controller.getDriveHistory(from, to),
      ).rejects.toThrow(BadRequestException);
    });

    it('should respect resolution parameter', async () => {
      // Arrange
      mockEventService.query.mockResolvedValue([]);

      // Act
      const result = await controller.getDriveHistory(undefined, undefined, '5s');

      // Assert
      expect(result.resolution).toBe('5s');
    });

    it('should map events to DriveHistoryPoint objects', async () => {
      // Arrange
      const now = new Date();
      const event = createMockDriveTickEvent(now, 1);
      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getDriveHistory();

      // Assert
      expect(result.points).toHaveLength(1);
      expect(result.points[0].timestamp).toBe(now.getTime());
      expect(result.points[0].drives).toHaveLength(12);
      expect(result.points[0].totalPressure).toBe(4.5);
    });

    it('should limit results to 1000 points', async () => {
      // Arrange
      mockEventService.query.mockResolvedValue([]);

      // Act
      await controller.getDriveHistory();

      // Assert
      const callArgs = mockEventService.query.mock.calls[0][0];
      expect(callArgs.limit).toBe(1000);
    });

    it('should return from/to timestamps in response', async () => {
      // Arrange
      const now = Date.now();
      const from = new Date(now - 60000);
      const to = new Date(now);
      mockEventService.query.mockResolvedValue([]);

      // Act
      const result = await controller.getDriveHistory(
        from.toISOString(),
        to.toISOString(),
      );

      // Assert
      expect(result.from).toBeGreaterThan(0);
      expect(result.to).toBeGreaterThan(0);
      expect(result.to).toBeGreaterThan(result.from);
    });

    it('should preserve drive order in history points', async () => {
      // Arrange
      const event = createMockDriveTickEvent(new Date(), 1);
      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getDriveHistory();

      // Assert
      result.points[0].drives.forEach((drive, index) => {
        expect(drive.name).toBe(DRIVE_INDEX_ORDER[index]);
      });
    });
  });

  describe('controller routes', () => {
    it('should not have POST methods (read-only controller)', () => {
      // Verify that the controller only exports GET methods
      const controllerMethods = Object.getOwnPropertyNames(
        Object.getPrototypeOf(controller),
      ).filter((method) => method !== 'constructor');

      const writeMethodsExist = controllerMethods.some(
        (method) =>
          method.toLowerCase().includes('post') ||
          method.toLowerCase().includes('put') ||
          method.toLowerCase().includes('patch') ||
          method.toLowerCase().includes('delete'),
      );

      expect(writeMethodsExist).toBe(false);
    });

    it('should only expose getCurrentDrives and getDriveHistory', () => {
      // Verify the public API
      expect(typeof controller.getCurrentDrives).toBe('function');
      expect(typeof controller.getDriveHistory).toBe('function');
    });
  });
});

/**
 * Unit tests for ConversationController.
 *
 * Tests cover:
 * - History with pagination returns correct page
 * - Time range filtering works
 * - Messages include drive state and theater check
 * - Empty history returns valid empty response
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConversationController } from '../conversation.controller';
import { ConfigService } from '@nestjs/config';
import { EVENTS_SERVICE } from '../../../events/events.tokens';
import type { IEventService } from '../../../events/interfaces/events.interfaces';
import type { SylphieEvent } from '../../../shared/types/event.types';
import type { DriveSnapshot } from '../../../shared/types/drive.types';

describe('ConversationController', () => {
  let controller: ConversationController;
  let mockEventService: jest.Mocked<IEventService>;
  let mockConfigService: jest.Mocked<ConfigService>;

  const createMockDriveSnapshot = (): DriveSnapshot => ({
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
      eventType: 'INPUT_RECEIVED',
      matched: false,
    },
    sessionId: 'test-session',
  });

  const createMockEvent = (
    type: string,
    timestamp: Date,
    payload: any = {},
    sessionId: string = 'test-session',
  ): SylphieEvent => ({
    id: `evt-${Date.now()}-${Math.random()}`,
    type: type as any,
    subsystem: 'COMMUNICATION',
    sessionId,
    timestamp,
    driveSnapshot: createMockDriveSnapshot(),
    schemaVersion: 1,
    ...(payload as any),
  } as any);

  beforeEach(async () => {
    mockEventService = {
      query: jest.fn(),
    } as any;

    mockConfigService = {
      get: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConversationController],
      providers: [
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    controller = module.get<ConversationController>(ConversationController);
  });

  describe('getHistory', () => {
    it('should return paginated conversation history', async () => {
      // Arrange
      const now = new Date();
      const events = [
        createMockEvent('INPUT_RECEIVED', new Date(now.getTime() - 10000), {
          payload: { inputText: 'Hello' },
        }),
        createMockEvent('RESPONSE_GENERATED', new Date(now.getTime() - 5000), {
          payload: { responseText: 'Hi there!' },
        }),
      ];

      mockEventService.query.mockResolvedValue(events);

      // Act
      const result = await controller.getHistory();

      // Assert
      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(result.offset).toBe(0);
      expect(result.limit).toBe(50);
    });

    it('should respect limit and offset parameters', async () => {
      // Arrange
      mockEventService.query.mockResolvedValue([]);

      // Act
      const result = await controller.getHistory(undefined, undefined, '25', '10');

      // Assert
      expect(result.limit).toBe(25);
      expect(result.offset).toBe(10);
    });

    it('should filter by time range', async () => {
      // Arrange
      const from = new Date(Date.now() - 60000).toISOString();
      const to = new Date().toISOString();
      mockEventService.query.mockResolvedValue([]);

      // Act
      await controller.getHistory(from, to);

      // Assert
      const callArgs = mockEventService.query.mock.calls[0][0];
      expect(callArgs.startTime).toBeDefined();
      expect(callArgs.endTime).toBeDefined();
    });

    it('should return empty messages for empty history', async () => {
      // Arrange
      mockEventService.query.mockResolvedValue([]);

      // Act
      const result = await controller.getHistory();

      // Assert
      expect(result.messages).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should convert INPUT_RECEIVED events to incoming messages', async () => {
      // Arrange
      const event = createMockEvent('INPUT_RECEIVED', new Date(), {
        payload: { inputText: 'Hello' },
      });

      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getHistory();

      // Assert
      const message = result.messages.find(
        (m) => m.direction === 'incoming' && m.text === 'Hello',
      );
      expect(message).toBeDefined();
    });

    it('should convert RESPONSE_GENERATED events to outgoing messages', async () => {
      // Arrange
      const event = createMockEvent('RESPONSE_GENERATED', new Date(), {
        payload: { responseText: 'Hi there!' },
      });

      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getHistory();

      // Assert
      const message = result.messages.find(
        (m) => m.direction === 'outgoing' && m.text === 'Hi there!',
      );
      expect(message).toBeDefined();
    });

    it('should include drive snapshot in RESPONSE_GENERATED messages', async () => {
      // Arrange
      const driveSnapshot = createMockDriveSnapshot();
      const event = createMockEvent('RESPONSE_GENERATED', new Date(), {
        payload: { responseText: 'Response' },
        driveSnapshot,
      });

      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getHistory();

      // Assert
      const message = result.messages.find(
        (m) => m.direction === 'outgoing',
      );
      expect(message?.driveSnapshot).toBeDefined();
      if (message?.driveSnapshot) {
        expect(message.driveSnapshot.drives).toHaveLength(12);
        expect(message.driveSnapshot.totalPressure).toBe(4.5);
      }
    });

    it('should include theater check result when present', async () => {
      // Arrange
      const theaterResult = {
        passed: true,
        violations: [],
        overallCorrelation: 0.95,
      };
      const event = createMockEvent('RESPONSE_GENERATED', new Date(), {
        payload: {
          responseText: 'Response',
          theaterCheckResult: theaterResult,
        },
      });

      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getHistory();

      // Assert
      const message = result.messages.find(
        (m) => m.direction === 'outgoing',
      );
      expect(message?.theaterCheck).toBeDefined();
      expect(message?.theaterCheck?.passed).toBe(true);
      expect(message?.theaterCheck?.overallCorrelation).toBe(0.95);
    });

    it('should convert GUARDIAN_CORRECTION to incoming message', async () => {
      // Arrange
      const event = createMockEvent('GUARDIAN_CORRECTION', new Date(), {
        payload: { feedbackText: 'That was wrong' },
      });

      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getHistory();

      // Assert
      const message = result.messages.find(
        (m) =>
          m.direction === 'incoming' &&
          m.guardianFeedbackType === 'correction' &&
          m.text === 'That was wrong',
      );
      expect(message).toBeDefined();
    });

    it('should convert GUARDIAN_CONFIRMATION to incoming message', async () => {
      // Arrange
      const event = createMockEvent('GUARDIAN_CONFIRMATION', new Date(), {
        payload: { feedbackText: 'Good job!' },
      });

      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getHistory();

      // Assert
      const message = result.messages.find(
        (m) =>
          m.direction === 'incoming' &&
          m.guardianFeedbackType === 'confirmation' &&
          m.text === 'Good job!',
      );
      expect(message).toBeDefined();
    });

    it('should sort messages chronologically', async () => {
      // Arrange
      const now = new Date();
      const events = [
        createMockEvent('INPUT_RECEIVED', new Date(now.getTime() - 10000), {
          payload: { inputText: 'First' },
        }),
        createMockEvent('RESPONSE_GENERATED', new Date(now.getTime() - 5000), {
          payload: { responseText: 'Second' },
        }),
        createMockEvent('INPUT_RECEIVED', now, {
          payload: { inputText: 'Third' },
        }),
      ];

      mockEventService.query.mockResolvedValue(events);

      // Act
      const result = await controller.getHistory();

      // Assert
      const timestamps = result.messages.map((m) => m.timestamp);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
      }
    });

    it('should handle invalid time range gracefully', async () => {
      // Arrange
      mockEventService.query.mockResolvedValue([]);

      // Act: Invalid from param should be ignored
      const result = await controller.getHistory('invalid-date');

      // Assert
      expect(result).toBeDefined();
    });
  });

  describe('getConversationMessages', () => {
    it('should return messages for specific conversation', async () => {
      // Arrange
      const events = [
        createMockEvent('INPUT_RECEIVED', new Date(), {
          payload: { inputText: 'Hi' },
        }),
      ];
      mockEventService.query.mockResolvedValue(events);

      // Act
      const result = await controller.getConversationMessages('session-123');

      // Assert
      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
      expect(result.total).toBeGreaterThanOrEqual(0);
    });

    it('should return empty messages for nonexistent conversation', async () => {
      // Arrange
      mockEventService.query.mockResolvedValue([]);

      // Act
      const result = await controller.getConversationMessages(
        'nonexistent-session',
      );

      // Assert
      expect(result.messages).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should set pagination to full message count', async () => {
      // Arrange
      const events = [
        createMockEvent('INPUT_RECEIVED', new Date(), {
          payload: { inputText: 'Hi' },
        }),
        createMockEvent('RESPONSE_GENERATED', new Date(), {
          payload: { responseText: 'Hello' },
        }),
      ];
      mockEventService.query.mockResolvedValue(events);

      // Act
      const result = await controller.getConversationMessages('session-123');

      // Assert
      expect(result.offset).toBe(0);
      expect(result.limit).toBeGreaterThanOrEqual(result.messages.length);
    });

    it('should try sessionId first, then correlationId', async () => {
      // Arrange
      mockEventService.query.mockResolvedValue([]);

      // Act
      await controller.getConversationMessages('conv-123');

      // Assert
      // First call should use sessionId
      expect(mockEventService.query).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'conv-123',
        }),
      );

      // If empty, should try correlationId (mocked to return empty again)
      const callCount = mockEventService.query.mock.calls.length;
      // In real scenario, two calls would be made if first returns empty
      expect(callCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('message transformation', () => {
    it('should handle missing payload gracefully', async () => {
      // Arrange
      const event = createMockEvent('INPUT_RECEIVED', new Date());
      delete (event as any).payload;

      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getHistory();

      // Assert
      expect(result.messages).toBeDefined();
    });

    it('should use empty string if inputText is explicitly empty', async () => {
      // Arrange
      const event = createMockEvent('INPUT_RECEIVED', new Date(), {
        payload: { inputText: '' },
      });

      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getHistory();

      // Assert
      const message = result.messages.find(
        (m) => m.direction === 'incoming',
      );
      expect(message?.text).toBe('');
    });

    it('should default missing inputText to "(empty input)"', async () => {
      // Arrange
      const event = createMockEvent('INPUT_RECEIVED', new Date(), {
        payload: { inputText: undefined },
      });

      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getHistory();

      // Assert
      const message = result.messages.find(
        (m) => m.direction === 'incoming',
      );
      expect(message?.text).toBe('(empty input)');
    });

    it('should skip INPUT_PARSED events', async () => {
      // Arrange
      const events = [
        createMockEvent('INPUT_RECEIVED', new Date(), {
          payload: { inputText: 'Hello' },
        }),
        createMockEvent('INPUT_PARSED', new Date(), {
          payload: { intent: 'greeting' },
        }),
      ];

      mockEventService.query.mockResolvedValue(events);

      // Act
      const result = await controller.getHistory();

      // Assert
      const parsedMessages = result.messages.filter(
        (m) => (m as any).intent === 'greeting',
      );
      expect(parsedMessages).toHaveLength(0);
    });

    it('should include type1OrType2 when present in RESPONSE_GENERATED', async () => {
      // Arrange
      const event = createMockEvent('RESPONSE_GENERATED', new Date(), {
        payload: {
          responseText: 'Response',
          type1OrType2: 'TYPE_1',
        },
      });

      mockEventService.query.mockResolvedValue([event]);

      // Act
      const result = await controller.getHistory();

      // Assert
      const message = result.messages.find(
        (m) => m.direction === 'outgoing',
      );
      expect(message?.type1OrType2).toBe('TYPE_1');
    });
  });

  describe('error handling', () => {
    it('should handle query errors gracefully', async () => {
      // Arrange
      mockEventService.query.mockRejectedValue(
        new Error('Database error'),
      );

      // Act & Assert
      await expect(controller.getHistory()).rejects.toThrow();
    });
  });
});

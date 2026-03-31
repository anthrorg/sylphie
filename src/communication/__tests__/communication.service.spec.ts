/**
 * Unit tests for CommunicationService (E6-T012).
 *
 * Tests the ICommunicationService facade and its three main methods:
 * - handleGuardianInput(): processes raw input, parses, checks contingency
 * - generateResponse(): calls response generator, reports cost, delivers response
 * - initiateComment(): generates spontaneous comment, tracks for contingency
 */

import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';

import { CommunicationService } from '../communication.service';
import type {
  ICommunicationService,
  GuardianInput,
  ParsedInput,
  ActionIntent,
  GeneratedResponse,
} from '../interfaces/communication.interfaces';
import { DriveName, type DriveSnapshot } from '../../shared/types/drive.types';
import {
  INPUT_PARSER_SERVICE,
  RESPONSE_GENERATOR,
  PERSON_MODELING_SERVICE,
  STT_SERVICE,
  TTS_SERVICE,
  CHATBOX_GATEWAY,
  SOCIAL_CONTINGENCY,
} from '../communication.tokens';
import { DRIVE_STATE_READER, ACTION_OUTCOME_REPORTER } from '../../drive-engine';
import { EVENTS_SERVICE } from '../../events';

// Mock implementations
class MockInputParser {
  async parse(): Promise<ParsedInput> {
    return {
      intentType: 'QUESTION',
      entities: [],
      guardianFeedbackType: 'none',
      rawText: 'test input',
      confidence: 0.85,
      contextReferences: [],
    };
  }
}

class MockResponseGenerator {
  async generate(): Promise<GeneratedResponse> {
    return {
      text: 'Test response',
      driveSnapshot: { sessionId: 'test-session' } as unknown as DriveSnapshot,
      theaterCheck: {
        passed: true,
        violations: [],
        overallCorrelation: 1.0,
      },
      tokensUsed: 100,
      latencyMs: 150,
    };
  }
}

class MockPersonModeling {
  async getPersonModel() {
    return null;
  }
  async updateFromConversation() {}
}

class MockSttService {
  async transcribe() {
    return {
      text: 'transcribed text',
      confidence: 0.90,
      languageCode: 'en',
      durationMs: 2000,
    };
  }
}

class MockTtsService {
  async synthesize() {
    return {
      audioBuffer: Buffer.from('audio data'),
      durationMs: 1000,
      format: 'mp3' as const,
    };
  }
}

class MockChatboxGateway {
  broadcastResponse() {}
  broadcastInitiatedComment() {}
  getThread() {
    return null;
  }
  getAllThreads() {
    return new Map();
  }
}

class MockSocialContingency {
  trackSylphieInitiated() {}
  checkGuardianResponse() {
    return null;
  }
}

class MockDriveStateReader {
  async getCurrentState(): Promise<DriveSnapshot> {
    return {
      sessionId: 'test-session',
      motivatingDrive: DriveName.Social,
    } as unknown as DriveSnapshot;
  }
}

class MockActionOutcomeReporter {
  async reportOutcome() {}
}

class MockEventService {
  async record() {
    return { id: randomUUID() };
  }
}

describe('CommunicationService (E6-T012)', () => {
  let service: CommunicationService;
  let mockInputParser: MockInputParser;
  let mockResponseGenerator: MockResponseGenerator;
  let mockPersonModeling: MockPersonModeling;
  let mockSttService: MockSttService;
  let mockTtsService: MockTtsService;
  let mockChatboxGateway: MockChatboxGateway;
  let mockSocialContingency: MockSocialContingency;
  let mockDriveStateReader: MockDriveStateReader;
  let mockActionOutcomeReporter: MockActionOutcomeReporter;
  let mockEventService: MockEventService;

  beforeEach(async () => {
    mockInputParser = new MockInputParser();
    mockResponseGenerator = new MockResponseGenerator();
    mockPersonModeling = new MockPersonModeling();
    mockSttService = new MockSttService();
    mockTtsService = new MockTtsService();
    mockChatboxGateway = new MockChatboxGateway();
    mockSocialContingency = new MockSocialContingency();
    mockDriveStateReader = new MockDriveStateReader();
    mockActionOutcomeReporter = new MockActionOutcomeReporter();
    mockEventService = new MockEventService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunicationService,
        {
          provide: INPUT_PARSER_SERVICE,
          useValue: mockInputParser,
        },
        {
          provide: RESPONSE_GENERATOR,
          useValue: mockResponseGenerator,
        },
        {
          provide: PERSON_MODELING_SERVICE,
          useValue: mockPersonModeling,
        },
        {
          provide: STT_SERVICE,
          useValue: mockSttService,
        },
        {
          provide: TTS_SERVICE,
          useValue: mockTtsService,
        },
        {
          provide: CHATBOX_GATEWAY,
          useValue: mockChatboxGateway,
        },
        {
          provide: SOCIAL_CONTINGENCY,
          useValue: mockSocialContingency,
        },
        {
          provide: DRIVE_STATE_READER,
          useValue: mockDriveStateReader,
        },
        {
          provide: ACTION_OUTCOME_REPORTER,
          useValue: mockActionOutcomeReporter,
        },
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventService,
        },
      ],
    }).compile();

    service = module.get<CommunicationService>(CommunicationService);
  });

  describe('handleGuardianInput()', () => {
    it('should return structured ParsedInput with no response generation', async () => {
      const input: GuardianInput = {
        text: 'What is the capital of France?',
        sessionId: 'session-123',
        timestamp: new Date(),
      };

      const result = await service.handleGuardianInput(input);

      expect(result).toBeDefined();
      expect(result.parsed).toBeDefined();
      expect(result.parsed.intentType).toBe('QUESTION');
      expect(result.parsed.confidence).toBe(0.85);
      expect(result.responseGenerated).toBe(false);
      expect(result.eventIds).toBeDefined();
      expect(result.eventIds.length).toBeGreaterThan(0);
    });

    it('should transcribe voice input when voiceBuffer is present', async () => {
      const transcribeSpy = jest.spyOn(mockSttService, 'transcribe');

      const input: GuardianInput = {
        text: '', // Will be populated by STT
        voiceBuffer: Buffer.from('audio data'),
        sessionId: 'session-123',
        timestamp: new Date(),
      };

      await service.handleGuardianInput(input);

      expect(transcribeSpy).toHaveBeenCalledWith(input.voiceBuffer);
    });

    it('should gracefully degrade if STT fails', async () => {
      jest.spyOn(mockSttService, 'transcribe').mockRejectedValueOnce(
        new Error('STT unavailable'),
      );

      const input: GuardianInput = {
        text: '',
        voiceBuffer: Buffer.from('audio data'),
        sessionId: 'session-123',
        timestamp: new Date(),
      };

      // Should not throw; should return fallback parse
      const result = await service.handleGuardianInput(input);
      expect(result.parsed).toBeDefined();
    });

    it('should check for social contingency on guardian input', async () => {
      const contingencySpy = jest.spyOn(mockSocialContingency, 'checkGuardianResponse');

      const input: GuardianInput = {
        text: 'Great comment!',
        sessionId: 'session-123',
        timestamp: new Date(),
      };

      await service.handleGuardianInput(input);

      expect(contingencySpy).toHaveBeenCalled();
    });

    it('should emit INPUT_RECEIVED and INPUT_PARSED events', async () => {
      const recordSpy = jest.spyOn(mockEventService, 'record');

      const input: GuardianInput = {
        text: 'Test input',
        sessionId: 'session-123',
        timestamp: new Date(),
      };

      await service.handleGuardianInput(input);

      expect(recordSpy).toHaveBeenCalledTimes(2); // INPUT_RECEIVED + INPUT_PARSED
    });

    it('should handle empty input gracefully', async () => {
      const input: GuardianInput = {
        text: '',
        sessionId: 'session-123',
        timestamp: new Date(),
      };

      const result = await service.handleGuardianInput(input);

      expect(result.parsed).toBeDefined();
      // Empty input still gets parsed by LLM — confidence depends on mock return value
    });
  });

  describe('generateResponse()', () => {
    it('should generate response via ResponseGeneratorService', async () => {
      const generateSpy = jest.spyOn(mockResponseGenerator, 'generate');

      const intent: ActionIntent = {
        actionType: 'RESPOND_TO_QUESTION',
        content: 'Answer this question',
        motivatingDrive: DriveName.Curiosity,
        driveSnapshot: { sessionId: 'session-123' } as unknown as DriveSnapshot,
      };

      const response = await service.generateResponse(intent);

      expect(generateSpy).toHaveBeenCalledWith(
        intent,
        expect.any(String), // conversationId
        expect.any(String), // personId
      );
      expect(response.text).toBe('Test response');
    });

    it('should read drive state before generation', async () => {
      const driveReadSpy = jest.spyOn(mockDriveStateReader, 'getCurrentState');

      const intent: ActionIntent = {
        actionType: 'RESPOND_TO_QUESTION',
        content: 'Answer',
        motivatingDrive: DriveName.Curiosity,
        driveSnapshot: { sessionId: 'session-123' } as unknown as DriveSnapshot,
      };

      await service.generateResponse(intent);

      expect(driveReadSpy).toHaveBeenCalled();
    });

    it('should report Type 2 cost to Drive Engine', async () => {
      const reportSpy = jest.spyOn(mockActionOutcomeReporter, 'reportOutcome');

      const intent: ActionIntent = {
        actionType: 'RESPOND_TO_QUESTION',
        content: 'Answer',
        motivatingDrive: DriveName.Curiosity,
        driveSnapshot: { sessionId: 'session-123' } as unknown as DriveSnapshot,
      };

      await service.generateResponse(intent);

      expect(reportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'GENERATE_RESPONSE',
          success: true,
        }),
      );
    });

    it('should broadcast response via ChatboxGateway', async () => {
      const broadcastSpy = jest.spyOn(mockChatboxGateway, 'broadcastResponse');

      const intent: ActionIntent = {
        actionType: 'RESPOND_TO_QUESTION',
        content: 'Answer',
        motivatingDrive: DriveName.Curiosity,
        driveSnapshot: { sessionId: 'session-123' } as unknown as DriveSnapshot,
      };

      await service.generateResponse(intent);

      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.any(String), // threadId
        'Test response',
        expect.any(Date),
      );
    });

    it('should gracefully degrade if TTS fails', async () => {
      jest.spyOn(mockTtsService, 'synthesize').mockRejectedValueOnce(
        new Error('TTS unavailable'),
      );

      const intent: ActionIntent = {
        actionType: 'RESPOND_TO_QUESTION',
        content: 'Answer',
        motivatingDrive: DriveName.Curiosity,
        driveSnapshot: { sessionId: 'session-123' } as unknown as DriveSnapshot,
      };

      // Should not throw; should deliver text-only response
      const response = await service.generateResponse(intent);
      expect(response.text).toBe('Test response');
    });

    it('should emit RESPONSE_DELIVERED event', async () => {
      const recordSpy = jest.spyOn(mockEventService, 'record');

      const intent: ActionIntent = {
        actionType: 'RESPOND_TO_QUESTION',
        content: 'Answer',
        motivatingDrive: DriveName.Curiosity,
        driveSnapshot: { sessionId: 'session-123' } as unknown as DriveSnapshot,
      };

      await service.generateResponse(intent);

      expect(recordSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'RESPONSE_DELIVERED',
        }),
      );
    });

    it('should update person model after response generation', async () => {
      const updateSpy = jest.spyOn(mockPersonModeling, 'updateFromConversation');

      const intent: ActionIntent = {
        actionType: 'RESPOND_TO_QUESTION',
        content: 'Answer',
        motivatingDrive: DriveName.Curiosity,
        driveSnapshot: { sessionId: 'session-123' } as unknown as DriveSnapshot,
      };

      await service.generateResponse(intent);

      expect(updateSpy).toHaveBeenCalledWith(
        expect.any(String), // personId
        expect.objectContaining({
          intentType: 'STATEMENT',
        }),
        expect.objectContaining({
          text: 'Test response',
        }),
      );
    });

    it('should include Theater validation result in response', async () => {
      const intent: ActionIntent = {
        actionType: 'RESPOND_TO_QUESTION',
        content: 'Answer',
        motivatingDrive: DriveName.Curiosity,
        driveSnapshot: { sessionId: 'session-123' } as unknown as DriveSnapshot,
      };

      const response = await service.generateResponse(intent);

      expect(response.theaterCheck).toBeDefined();
      expect(response.theaterCheck.passed).toBe(true);
      expect(response.theaterCheck.violations).toBeDefined();
    });
  });

  describe('initiateComment()', () => {
    it('should generate spontaneous comment via ResponseGeneratorService', async () => {
      const generateSpy = jest.spyOn(mockResponseGenerator, 'generate');

      const driveSnapshot: DriveSnapshot = {
        sessionId: 'session-123',
        motivatingDrive: DriveName.Social,
      } as unknown as DriveSnapshot;

      await service.initiateComment(driveSnapshot);

      expect(generateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'INITIATE_COMMENT',
        }),
        expect.any(String), // threadId
        expect.any(String), // personId
      );
    });

    it('should track comment for social contingency', async () => {
      const trackSpy = jest.spyOn(mockSocialContingency, 'trackSylphieInitiated');

      const driveSnapshot: DriveSnapshot = {
        sessionId: 'session-123',
        motivatingDrive: DriveName.Social,
      } as unknown as DriveSnapshot;

      await service.initiateComment(driveSnapshot);

      expect(trackSpy).toHaveBeenCalledWith(
        expect.any(String), // utteranceId
        expect.any(Date),
      );
    });

    it('should broadcast initiated comment via ChatboxGateway', async () => {
      const broadcastSpy = jest.spyOn(mockChatboxGateway, 'broadcastInitiatedComment');

      const driveSnapshot: DriveSnapshot = {
        sessionId: 'session-123',
        motivatingDrive: DriveName.Social,
      } as unknown as DriveSnapshot;

      await service.initiateComment(driveSnapshot);

      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.any(String), // threadId
        'Test response',
        expect.any(String), // motivatingDrive
        expect.any(Date),
      );
    });

    it('should emit SOCIAL_COMMENT_INITIATED event', async () => {
      const recordSpy = jest.spyOn(mockEventService, 'record');

      const driveSnapshot = {
        sessionId: 'session-123',
        motivatingDrive: DriveName.Social,
      } as unknown as DriveSnapshot;

      await service.initiateComment(driveSnapshot);

      expect(recordSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SOCIAL_COMMENT_INITIATED',
        }),
      );
    });

    it('should return null when theater prohibition is violated (Shrug Imperative)', async () => {
      jest.spyOn(mockResponseGenerator, 'generate').mockResolvedValueOnce({
        text: 'Test response',
        driveSnapshot: { sessionId: 'test-session' } as unknown as DriveSnapshot,
        theaterCheck: {
          passed: false, // Theater violation
          violations: [
            {
              expressionType: 'pressure' as const,
              drive: DriveName.Social,
              driveValue: 0.1,
              threshold: 0.2,
              description: 'Expressing social need that is not present',
            },
          ],
          overallCorrelation: 0.3,
        },
        tokensUsed: 100,
        latencyMs: 150,
      });

      const driveSnapshot = {
        sessionId: 'session-123',
        motivatingDrive: DriveName.Social,
      } as unknown as DriveSnapshot;

      const result = await service.initiateComment(driveSnapshot);

      expect(result).toBeNull();
    });

    it('should return response when theater prohibition is satisfied', async () => {
      const driveSnapshot = {
        sessionId: 'session-123',
        motivatingDrive: DriveName.Social,
      } as unknown as DriveSnapshot;

      const result = await service.initiateComment(driveSnapshot);

      expect(result).toBeDefined();
      expect(result?.text).toBe('Test response');
    });

    it('should read drive state before generating comment', async () => {
      const driveReadSpy = jest.spyOn(mockDriveStateReader, 'getCurrentState');

      const driveSnapshot = {
        sessionId: 'session-123',
        motivatingDrive: DriveName.Social,
      } as unknown as DriveSnapshot;

      await service.initiateComment(driveSnapshot);

      expect(driveReadSpy).toHaveBeenCalled();
    });
  });

  describe('Integration tests', () => {
    it('should handle complete input-to-output flow without errors', async () => {
      // Step 1: Process guardian input
      const input: GuardianInput = {
        text: 'What is AI?',
        sessionId: 'session-123',
        timestamp: new Date(),
      };

      const inputResult = await service.handleGuardianInput(input);
      expect(inputResult.parsed).toBeDefined();

      // Step 2: Generate response
      const intent: ActionIntent = {
        actionType: 'RESPOND_TO_QUESTION',
        content: 'Answer the AI question',
        motivatingDrive: DriveName.Curiosity,
        driveSnapshot: { sessionId: 'session-123' } as unknown as DriveSnapshot,
      };

      const response = await service.generateResponse(intent);
      expect(response.text).toBeDefined();
      expect(response.theaterCheck.passed).toBe(true);

      // Step 3: Initiate spontaneous comment
      const driveSnapshot = {
        sessionId: 'session-123',
        motivatingDrive: DriveName.Social,
      } as unknown as DriveSnapshot;

      const comment = await service.initiateComment(driveSnapshot);
      expect(comment?.text).toBeDefined();
    });
  });
});

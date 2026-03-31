/**
 * Unit tests for LlmContextAssemblerService.
 *
 * Tests cover:
 * - Drive state injection into LLM context
 * - Drive narrative construction (high, low, neutral drives)
 * - Theater Prohibition instruction generation
 * - Person model source isolation (Other KG only)
 * - Token budget enforcement
 * - Context component prioritization
 * - LlmRequest assembly
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { LlmContextAssemblerService } from '../llm-context-assembler.service';
import { PERSON_MODELING_SERVICE } from '../../communication.tokens';
import type {
  IPersonModelingService,
  ActionIntent,
  PersonModel,
} from '../../interfaces/communication.interfaces';
import type { DriveSnapshot } from '../../../shared/types/drive.types';
import { DriveName, INITIAL_DRIVE_STATE } from '../../../shared/types/drive.types';
import type { AppConfig } from '../../../shared/config/app.config';

// Mock person modeling service
const mockPersonModelingService: Partial<IPersonModelingService> = {
  getPersonModel: jest.fn(),
  updateFromConversation: jest.fn(),
};

// Mock config service
const mockConfigService: Partial<ConfigService> = {
  get: jest.fn(),
};

describe('LlmContextAssemblerService', () => {
  let service: LlmContextAssemblerService;
  let personModelingService: any;
  let configService: any;

  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks();

    // Default config mock
    const defaultConfig: AppConfig = {
      app: {
        port: 3000,
        env: 'test',
        logLevel: 'debug',
        sessionId: 'test-session',
      },
      neo4j: {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'neo4j',
        database: 'neo4j',
        maxConnectionPoolSize: 50,
        connectionTimeoutMs: 5000,
      },
      timescale: {
        host: 'localhost',
        port: 5433,
        database: 'sylphie_events',
        user: 'sylphie',
        password: 'test',
        maxConnections: 20,
        idleTimeoutMs: 30000,
        connectionTimeoutMs: 5000,
        retentionDays: 90,
        compressionDays: 7,
      },
      postgres: {
        host: 'localhost',
        port: 5434,
        database: 'sylphie_system',
        adminUser: 'admin',
        adminPassword: 'test',
        runtimeUser: 'runtime',
        runtimePassword: 'test',
        driveEngineUser: 'drive_engine',
        driveEnginePassword: 'test',
        guardianAdminUser: 'guardian',
        guardianAdminPassword: 'test',
        maxConnections: 10,
        idleTimeoutMs: 30000,
        connectionTimeoutMs: 5000,
      },
      grafeo: {
        selfKgPath: './data/self-kg',
        otherKgPath: './data/other-kgs',
        maxNodesPerKg: 10000,
      },
      llm: {
        anthropicApiKey: 'test-key',
        model: 'claude-sonnet-4-20250514',
        maxTokens: 4096,
        temperature: 0.7,
        costTrackingEnabled: true,
      },
      openaiVoice: {
        apiKey: 'test-key',
        defaultVoice: 'nova',
        defaultFormat: 'mp3',
        defaultSpeed: 1.0,
      },
    };

    (mockConfigService.get as jest.Mock).mockReturnValue(defaultConfig);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmContextAssemblerService,
        {
          provide: PERSON_MODELING_SERVICE,
          useValue: mockPersonModelingService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<LlmContextAssemblerService>(LlmContextAssemblerService);
    personModelingService = module.get(PERSON_MODELING_SERVICE);
    configService = module.get(ConfigService);
  });

  // =========================================================================
  // Basic Assembly Tests
  // =========================================================================

  describe('assemble', () => {
    it('should assemble a complete LlmRequest', async () => {
      // Setup
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      // Act
      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      // Assert
      expect(request.messages).toBeDefined();
      expect(request.systemPrompt).toBeDefined();
      expect(request.maxTokens).toBe(4096);
      expect(request.temperature).toBe(0.7);
      expect(request.metadata.callerSubsystem).toBe('COMMUNICATION');
      expect(request.metadata.purpose).toBe('TYPE_2_RESPONSE_GENERATION');
      expect(request.metadata.sessionId).toBe(driveState.sessionId);
    });

    it('should include at least one message (the action intent)', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.messages.length).toBeGreaterThan(0);
      expect(request.messages[request.messages.length - 1].role).toBe('user');
      expect(request.messages[request.messages.length - 1].content).toContain(
        intent.content,
      );
    });

    it('should use configured maxTokens from AppConfig', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.maxTokens).toBe(4096);
    });
  });

  // =========================================================================
  // Drive State Injection Tests
  // =========================================================================

  describe('drive state injection', () => {
    it('should include drive snapshot in LlmRequest metadata', async () => {
      const driveState = createMockDriveSnapshot({
        [DriveName.Curiosity]: 0.75,
        [DriveName.Anxiety]: 0.4,
      });
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.metadata.sessionId).toBe(driveState.sessionId);
    });

    it('should always include drive state in system prompt', async () => {
      const driveState = createMockDriveSnapshot({
        [DriveName.Curiosity]: 0.75,
      });
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.systemPrompt).toBeDefined();
      expect(request.systemPrompt.length).toBeGreaterThan(0);
      // System prompt should contain mention of drives or emotional state
      expect(
        request.systemPrompt.toLowerCase().match(/feel|emotional|state|drive/),
      ).toBeTruthy();
    });
  });

  // =========================================================================
  // Drive Narrative Tests
  // =========================================================================

  describe('drive narrative construction', () => {
    it('should describe high drives (> 0.6)', async () => {
      const driveState = createMockDriveSnapshot({
        [DriveName.Curiosity]: 0.75,
        [DriveName.Anxiety]: 0.1, // Below threshold
      });
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      // Should describe curiosity (eager to learn and explore is the narrative)
      expect(request.systemPrompt).toMatch(/eager|explore|curiosity/i);
    });

    it('should describe low drives (< -0.3, extended relief)', async () => {
      const driveState = createMockDriveSnapshot({
        [DriveName.Anxiety]: -2.5, // Extended relief
      });
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.systemPrompt).toContain('calm');
    });

    it('should omit neutral drives', async () => {
      const driveState = createMockDriveSnapshot({
        [DriveName.Curiosity]: 0.45, // Neutral
        [DriveName.Anxiety]: 0.1, // Neutral
      });
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      // Narrative should not mention these specific low-pressure drives
      // but should say something like "balanced"
      expect(request.systemPrompt.toLowerCase()).toMatch(/balanced|content/);
    });

    it('should include numerical pressure values for high drives', async () => {
      const driveState = createMockDriveSnapshot({
        [DriveName.Curiosity]: 0.75,
      });
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      // Should contain the pressure value
      expect(request.systemPrompt).toMatch(/0\.\d{2}/);
    });
  });

  // =========================================================================
  // Theater Prohibition Tests
  // =========================================================================

  describe('Theater Prohibition instruction', () => {
    it('should include Theater Prohibition directive in system prompt', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.systemPrompt).toContain('THEATER PROHIBITION');
      expect(request.systemPrompt).toContain('Do NOT express emotions');
    });

    it('should block pressure expressions when drive < 0.2', async () => {
      const driveState = createMockDriveSnapshot({
        [DriveName.Curiosity]: 0.15, // Below threshold
        [DriveName.Anxiety]: 0.1, // Below threshold
      });
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      // Should mention blocked pressure expressions
      expect(request.systemPrompt).toContain('Do NOT express pressure');
    });

    it('should block relief expressions when drive > 0.3', async () => {
      const driveState = createMockDriveSnapshot({
        [DriveName.Satisfaction]: 0.5, // Above relief threshold
      });
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      // Should mention blocked relief expressions
      expect(request.systemPrompt).toContain('Do NOT express relief');
    });
  });

  // =========================================================================
  // Person Model Tests (Isolation Verification)
  // =========================================================================

  describe('person model isolation (Other KG only)', () => {
    it('should retrieve person model from IPersonModelingService', async () => {
      const mockPersonModel: PersonModel = {
        personId: 'person-jim',
        name: 'Jim',
        communicationPreferences: { verbosity: 'concise' },
        interactionCount: 5,
        lastInteraction: new Date(),
        knownTopics: ['robotics', 'AI'],
      };

      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(
        mockPersonModel,
      );

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(personModelingService.getPersonModel).toHaveBeenCalledWith(
        'person-jim',
      );
      // System prompt should include person model information (personId is used)
      expect(request.systemPrompt).toContain('person-jim');
      expect(request.systemPrompt).toMatch(/interaction|preference/i);
    });

    it('should handle missing person model gracefully', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      // Should still assemble successfully without person model
      expect(request.messages.length).toBeGreaterThan(0);
      expect(request.systemPrompt).toBeDefined();
    });

    it('should handle person model retrieval errors gracefully', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockRejectedValue(
        new Error('Other KG unavailable'),
      );

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      // Should still assemble successfully despite error
      expect(request.messages.length).toBeGreaterThan(0);
      expect(request.systemPrompt).toBeDefined();
    });

    it('should include person interaction summary in context', async () => {
      const mockPersonModel: PersonModel = {
        personId: 'person-jim',
        name: 'Jim',
        communicationPreferences: { verbosity: 'detailed', formality: 'casual' },
        interactionCount: 12,
        lastInteraction: new Date(),
        knownTopics: ['robotics'],
      };

      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(
        mockPersonModel,
      );

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      // Should include facts about the person (personId, interactions, preferences)
      expect(request.systemPrompt).toContain('person-jim');
      expect(
        request.systemPrompt.toLowerCase().match(/interaction|preference|detailed|robotics/),
      ).toBeTruthy();
    });
  });

  // =========================================================================
  // Token Budget Tests
  // =========================================================================

  describe('token budget enforcement', () => {
    it('should respect maxTokens from AppConfig', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.maxTokens).toBe(4096);
    });

    it('should use default maxTokens when config is unavailable', async () => {
      (mockConfigService.get as jest.Mock).mockReturnValue(null);

      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      // Should use default of 4096
      expect(request.maxTokens).toBe(4096);
    });
  });

  // =========================================================================
  // System Prompt Tests
  // =========================================================================

  describe('system prompt construction', () => {
    it('should include Sylphie persona statement', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.systemPrompt).toContain('Sylphie');
      expect(request.systemPrompt).toContain('AI companion');
    });

    it('should include drive narrative', async () => {
      const driveState = createMockDriveSnapshot({
        [DriveName.Curiosity]: 0.8,
      });
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.systemPrompt).toMatch(/emotional|feel|state/i);
    });

    it('should include Theater Prohibition', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.systemPrompt).toContain('THEATER PROHIBITION');
    });
  });

  // =========================================================================
  // Message Assembly Tests
  // =========================================================================

  describe('message assembly', () => {
    it('should end with user message from action intent', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent('What is the meaning of life?');

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      const lastMessage = request.messages[request.messages.length - 1];
      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content).toContain('What is the meaning of life?');
    });

    it('should include action intent content in messages', async () => {
      const driveState = createMockDriveSnapshot();
      const customContent = 'The user asked about quantum physics.';
      const intent = createMockActionIntent(customContent);

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      const messageContent = request.messages
        .map((m) => m.content)
        .join(' ');
      expect(messageContent).toContain(customContent);
    });
  });

  // =========================================================================
  // Metadata Tests
  // =========================================================================

  describe('LlmRequest metadata', () => {
    it('should set callerSubsystem to COMMUNICATION', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.metadata.callerSubsystem).toBe('COMMUNICATION');
    });

    it('should set purpose to TYPE_2_RESPONSE_GENERATION', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.metadata.purpose).toBe('TYPE_2_RESPONSE_GENERATION');
    });

    it('should include sessionId from driveState', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-123',
        'person-jim',
      );

      expect(request.metadata.sessionId).toBe('test-session-123');
    });

    it('should include correlationId from conversationId', async () => {
      const driveState = createMockDriveSnapshot();
      const intent = createMockActionIntent();

      (personModelingService.getPersonModel as jest.Mock).mockResolvedValue(null);

      const request = await service.assemble(
        intent,
        driveState,
        'conversation-456',
        'person-jim',
      );

      expect(request.metadata.correlationId).toBe('conversation-456');
    });
  });
});

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock ActionIntent for testing.
 */
function createMockActionIntent(
  content: string = 'The user asked a question about robotics.',
): ActionIntent {
  return {
    actionType: 'RESPOND_TO_QUESTION',
    content,
    motivatingDrive: DriveName.Curiosity,
    driveSnapshot: createMockDriveSnapshot(),
  };
}

/**
 * Create a mock DriveSnapshot for testing.
 *
 * @param overrides - Optional drive overrides
 */
function createMockDriveSnapshot(
  overrides?: Partial<Record<DriveName, number>>,
): DriveSnapshot {
  const pressureVector = { ...INITIAL_DRIVE_STATE };

  if (overrides) {
    for (const [drive, value] of Object.entries(overrides)) {
      (pressureVector as any)[drive] = value;
    }
  }

  return {
    pressureVector,
    timestamp: new Date(),
    tickNumber: 1,
    driveDeltas: {
      systemHealth: 0,
      moralValence: 0,
      integrity: 0,
      cognitiveAwareness: 0,
      guilt: 0,
      curiosity: 0,
      boredom: 0,
      anxiety: 0,
      satisfaction: 0,
      sadness: 0,
      informationIntegrity: 0,
      social: 0,
    },
    ruleMatchResult: {
      ruleId: null,
      eventType: 'DEFAULT_AFFECT',
      matched: false,
    },
    totalPressure: 2.5,
    sessionId: 'test-session-123',
  };
}

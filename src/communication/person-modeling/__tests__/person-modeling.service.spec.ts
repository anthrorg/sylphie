/**
 * Unit tests for PersonModelingService.
 *
 * Tests:
 * - Person model retrieval and null handling
 * - Person model creation
 * - Conversation-based model updates
 * - Trait extraction from interactions
 * - Communication preference inference
 * - Other KG isolation (no WKG cross-contamination)
 * - Provenance enforcement (LLM_GENERATED / INFERENCE only)
 * - Timestamp tracking for decay
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PersonModelingService } from '../person-modeling.service';
import { OTHER_KG_SERVICE } from '../../../knowledge';
import type {
  IOtherKgService,
  PersonModel as KgPersonModel,
  PersonTrait,
} from '../../../knowledge';
import type {
  PersonModel,
  ParsedInput,
  GeneratedResponse,
  ParsedEntity,
} from '../../interfaces/communication.interfaces';
import type { DriveSnapshot } from '../../../shared/types/drive.types';
import { DriveName } from '../../../shared/types/drive.types';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal DriveSnapshot for testing.
 */
function createDriveSnapshot(
  pressureValues: Partial<Record<DriveName, number>> = {},
): DriveSnapshot {
  return {
    pressureVector: {
      [DriveName.SystemHealth]: pressureValues[DriveName.SystemHealth] ?? 0.0,
      [DriveName.MoralValence]: pressureValues[DriveName.MoralValence] ?? 0.0,
      [DriveName.Integrity]: pressureValues[DriveName.Integrity] ?? 0.0,
      [DriveName.CognitiveAwareness]:
        pressureValues[DriveName.CognitiveAwareness] ?? 0.0,
      [DriveName.Guilt]: pressureValues[DriveName.Guilt] ?? 0.0,
      [DriveName.Curiosity]: pressureValues[DriveName.Curiosity] ?? 0.0,
      [DriveName.Boredom]: pressureValues[DriveName.Boredom] ?? 0.0,
      [DriveName.Anxiety]: pressureValues[DriveName.Anxiety] ?? 0.0,
      [DriveName.Satisfaction]: pressureValues[DriveName.Satisfaction] ?? 0.0,
      [DriveName.Sadness]: pressureValues[DriveName.Sadness] ?? 0.0,
      [DriveName.InformationIntegrity]:
        pressureValues[DriveName.InformationIntegrity] ?? 0.0,
      [DriveName.Social]: pressureValues[DriveName.Social] ?? 0.0,
    },
    timestamp: new Date(),
    tickNumber: 1,
    driveDeltas: {
      [DriveName.SystemHealth]: 0,
      [DriveName.MoralValence]: 0,
      [DriveName.Integrity]: 0,
      [DriveName.CognitiveAwareness]: 0,
      [DriveName.Guilt]: 0,
      [DriveName.Curiosity]: 0,
      [DriveName.Boredom]: 0,
      [DriveName.Anxiety]: 0,
      [DriveName.Satisfaction]: 0,
      [DriveName.Sadness]: 0,
      [DriveName.InformationIntegrity]: 0,
      [DriveName.Social]: 0,
    },
    ruleMatchResult: { ruleId: null, eventType: '', matched: false },
    totalPressure: 0,
    sessionId: 'test-session',
  };
}

/**
 * Create a minimal KG person model for testing.
 */
function createKgPersonModel(
  overrides?: Partial<KgPersonModel>,
): KgPersonModel {
  const traits: PersonTrait[] = [
    {
      id: 'trait-1',
      name: 'prefers-direct-answers',
      confidence: 0.65,
      provenance: 'INFERENCE',
      actrParams: {
        base: 0.30,
        count: 2,
        decayRate: 0.05,
        lastRetrievalAt: new Date(),
      },
      createdAt: new Date(),
    },
  ];

  return {
    personId: 'person_jim',
    name: 'Jim',
    traits,
    interactionCount: 5,
    lastInteractionAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Create a minimal ParsedInput for testing.
 */
function createParsedInput(overrides?: Partial<ParsedInput>): ParsedInput {
  const entities: ParsedEntity[] = [];

  return {
    intentType: 'QUESTION',
    entities,
    guardianFeedbackType: 'none',
    rawText: 'What is machine learning?',
    confidence: 0.85,
    contextReferences: [],
    ...overrides,
  };
}

/**
 * Create a minimal GeneratedResponse for testing.
 */
function createGeneratedResponse(
  overrides?: Partial<GeneratedResponse>,
): GeneratedResponse {
  return {
    text: 'Machine learning is a subset of artificial intelligence.',
    driveSnapshot: createDriveSnapshot(),
    theaterCheck: {
      passed: true,
      violations: [],
      overallCorrelation: 1.0,
    },
    tokensUsed: 50,
    latencyMs: 500,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('PersonModelingService', () => {
  let service: PersonModelingService;
  let mockOtherKgService: any;

  beforeEach(async () => {
    mockOtherKgService = {
      getPersonModel: jest.fn(),
      createPerson: jest.fn(),
      updatePersonModel: jest.fn(),
      queryPersonTraits: jest.fn(),
      queryInteractionHistory: jest.fn(),
      recordInteraction: jest.fn(),
      getKnownPersonIds: jest.fn(),
      deletePerson: jest.fn(),
      healthCheck: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PersonModelingService,
        {
          provide: OTHER_KG_SERVICE,
          useValue: mockOtherKgService,
        },
      ],
    }).compile();

    service = module.get<PersonModelingService>(PersonModelingService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // getPersonModel
  // =========================================================================

  describe('getPersonModel', () => {
    it('should return sanitized person model when person exists', async () => {
      const kgModel = createKgPersonModel();
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const result = await service.getPersonModel('person_jim');

      expect(result).toBeDefined();
      expect(result?.personId).toBe('person_jim');
      expect(result?.name).toBe('Jim');
      expect(result?.interactionCount).toBe(5);
    });

    it('should return null when person does not exist', async () => {
      mockOtherKgService.getPersonModel.mockResolvedValue(null);

      const result = await service.getPersonModel('person_nonexistent');

      expect(result).toBeNull();
    });

    it('should extract communication preferences from traits', async () => {
      const kgModel = createKgPersonModel({
        traits: [
          {
            id: 'trait-1',
            name: 'prefers-concise-answers',
            confidence: 0.65,
            provenance: 'INFERENCE',
            actrParams: {
              base: 0.30,
              count: 2,
              decayRate: 0.05,
              lastRetrievalAt: new Date(),
            },
            createdAt: new Date(),
          },
          {
            id: 'trait-2',
            name: 'prefers-formal-tone',
            confidence: 0.60,
            provenance: 'INFERENCE',
            actrParams: {
              base: 0.30,
              count: 1,
              decayRate: 0.05,
              lastRetrievalAt: new Date(),
            },
            createdAt: new Date(),
          },
        ],
      });
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const result = await service.getPersonModel('person_jim');

      expect(result?.communicationPreferences.verbosity).toBe('concise');
      expect(result?.communicationPreferences.formality).toBe('formal');
    });

    it('should extract known topics from traits', async () => {
      const kgModel = createKgPersonModel({
        traits: [
          {
            id: 'trait-1',
            name: 'interested-in-machine-learning',
            confidence: 0.55,
            provenance: 'INFERENCE',
            actrParams: {
              base: 0.30,
              count: 1,
              decayRate: 0.05,
              lastRetrievalAt: new Date(),
            },
            createdAt: new Date(),
          },
          {
            id: 'trait-2',
            name: 'interested-in-robotics',
            confidence: 0.52,
            provenance: 'INFERENCE',
            actrParams: {
              base: 0.30,
              count: 1,
              decayRate: 0.05,
              lastRetrievalAt: new Date(),
            },
            createdAt: new Date(),
          },
        ],
      });
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const result = await service.getPersonModel('person_jim');

      expect(result?.knownTopics).toContain('machine-learning');
      expect(result?.knownTopics).toContain('robotics');
    });

    it('should not expose raw graph structure in returned model', async () => {
      const kgModel = createKgPersonModel();
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const result = await service.getPersonModel('person_jim');

      // Verify no raw KG data in response
      expect(result).not.toHaveProperty('traits');
      expect(result).not.toHaveProperty('actrParams');
      expect((result as any).createdAt).toBeUndefined();
    });

    it('should propagate errors from OtherKgService', async () => {
      mockOtherKgService.getPersonModel.mockRejectedValue(
        new Error('KG read failed'),
      );

      await expect(service.getPersonModel('person_jim')).rejects.toThrow(
        'KG read failed',
      );
    });
  });

  // =========================================================================
  // updateFromConversation
  // =========================================================================

  describe('updateFromConversation', () => {
    it('should update person model with inferred traits', async () => {
      const kgModel = createKgPersonModel();
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const parsed = createParsedInput();
      const response = createGeneratedResponse();

      await service.updateFromConversation('person_jim', parsed, response);

      expect(mockOtherKgService.updatePersonModel).toHaveBeenCalled();
      const updateCall = mockOtherKgService.updatePersonModel.mock.calls[0];
      expect(updateCall[0]).toBe('person_jim');
      expect(updateCall[1].traitsToUpsert).toBeDefined();
      expect(Array.isArray(updateCall[1].traitsToUpsert)).toBe(true);
    });

    it('should infer concise preference from short response', async () => {
      const kgModel = createKgPersonModel();
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const parsed = createParsedInput({
        rawText: 'What is AI?',
      });
      const response = createGeneratedResponse({
        text: 'AI is artificial intelligence.',
      });

      await service.updateFromConversation('person_jim', parsed, response);

      const updateCall = mockOtherKgService.updatePersonModel.mock.calls[0];
      const traits = updateCall[1].traitsToUpsert;
      const conciseTrait = traits.find(
        (t: any) => t.name === 'prefers-concise-answers',
      );
      expect(conciseTrait).toBeDefined();
    });

    it('should infer detailed preference from long response', async () => {
      const kgModel = createKgPersonModel();
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const parsed = createParsedInput();
      const response = createGeneratedResponse({
        text: 'Machine learning is a subset of artificial intelligence that focuses on enabling systems to learn and improve from experience without being explicitly programmed. It involves the development of algorithms and statistical models that allow computers to identify patterns in data and make predictions or decisions based on those patterns. There are three main types: supervised learning, unsupervised learning, and reinforcement learning. Each has different applications and use cases.',
      });

      await service.updateFromConversation('person_jim', parsed, response);

      const updateCall = mockOtherKgService.updatePersonModel.mock.calls[0];
      const traits = updateCall[1].traitsToUpsert;
      const detailedTrait = traits.find(
        (t: any) => t.name === 'prefers-detailed-answers',
      );
      expect(detailedTrait).toBeDefined();
    });

    it('should infer question frequency trait from question intent', async () => {
      const kgModel = createKgPersonModel();
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const parsed = createParsedInput({
        intentType: 'QUESTION',
        confidence: 0.85,
      });
      const response = createGeneratedResponse();

      await service.updateFromConversation('person_jim', parsed, response);

      const updateCall = mockOtherKgService.updatePersonModel.mock.calls[0];
      const traits = updateCall[1].traitsToUpsert;
      const questionTrait = traits.find(
        (t: any) => t.name === 'frequently-asks-questions',
      );
      expect(questionTrait).toBeDefined();
    });

    it('should infer urgency preference from urgent language', async () => {
      const kgModel = createKgPersonModel();
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const parsed = createParsedInput({
        rawText: 'I need this ASAP, its urgent!',
      });
      const response = createGeneratedResponse();

      await service.updateFromConversation('person_jim', parsed, response);

      const updateCall = mockOtherKgService.updatePersonModel.mock.calls[0];
      const traits = updateCall[1].traitsToUpsert;
      const urgencyTrait = traits.find(
        (t: any) => t.name === 'prefers-quick-response',
      );
      expect(urgencyTrait).toBeDefined();
    });

    it('should infer topics from entity extraction', async () => {
      const kgModel = createKgPersonModel();
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const parsed = createParsedInput({
        entities: [
          {
            name: 'machine learning',
            type: 'TOPIC',
            wkgNodeId: null,
            confidence: 0.90,
          },
          {
            name: 'neural networks',
            type: 'DOMAIN',
            wkgNodeId: null,
            confidence: 0.85,
          },
        ],
      });
      const response = createGeneratedResponse();

      await service.updateFromConversation('person_jim', parsed, response);

      const updateCall = mockOtherKgService.updatePersonModel.mock.calls[0];
      const traits = updateCall[1].traitsToUpsert;
      const mlTrait = traits.find(
        (t: any) => t.name === 'interested-in-machine-learning',
      );
      const nnTrait = traits.find(
        (t: any) => t.name === 'interested-in-neural-networks',
      );
      expect(mlTrait).toBeDefined();
      expect(nnTrait).toBeDefined();
    });

    it('should not add duplicate traits', async () => {
      const kgModel = createKgPersonModel({
        traits: [
          {
            id: 'trait-1',
            name: 'prefers-concise-answers',
            confidence: 0.65,
            provenance: 'INFERENCE',
            actrParams: {
              base: 0.30,
              count: 2,
              decayRate: 0.05,
              lastRetrievalAt: new Date(),
            },
            createdAt: new Date(),
          },
        ],
      });
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const parsed = createParsedInput();
      const response = createGeneratedResponse({
        text: 'AI is artificial intelligence.',
      });

      await service.updateFromConversation('person_jim', parsed, response);

      const updateCall = mockOtherKgService.updatePersonModel.mock.calls[0];
      const traits = updateCall[1].traitsToUpsert;
      const conciseCount = traits.filter(
        (t: any) => t.name === 'prefers-concise-answers',
      ).length;
      expect(conciseCount).toBeLessThanOrEqual(1);
    });

    it('should enforce INFERENCE provenance on inferred traits', async () => {
      const kgModel = createKgPersonModel();
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const parsed = createParsedInput();
      const response = createGeneratedResponse({
        text: 'AI is artificial intelligence.',
      });

      await service.updateFromConversation('person_jim', parsed, response);

      const updateCall = mockOtherKgService.updatePersonModel.mock.calls[0];
      const traits = updateCall[1].traitsToUpsert;
      for (const trait of traits) {
        expect(['INFERENCE', 'LLM_GENERATED']).toContain(trait.provenance);
      }
    });

    it('should handle non-existent person gracefully', async () => {
      mockOtherKgService.getPersonModel.mockResolvedValue(null);

      const parsed = createParsedInput();
      const response = createGeneratedResponse();

      await service.updateFromConversation('person_nonexistent', parsed, response);

      // Should not throw, but also should not call updatePersonModel
      expect(mockOtherKgService.updatePersonModel).not.toHaveBeenCalled();
    });

    it('should propagate errors from OtherKgService', async () => {
      mockOtherKgService.getPersonModel.mockRejectedValue(
        new Error('KG write failed'),
      );

      const parsed = createParsedInput();
      const response = createGeneratedResponse();

      await expect(
        service.updateFromConversation('person_jim', parsed, response),
      ).rejects.toThrow('KG write failed');
    });
  });

  // =========================================================================
  // createPerson
  // =========================================================================

  describe('createPerson', () => {
    it('should delegate to OtherKgService.createPerson', async () => {
      await service.createPerson('person_jim', 'Jim');

      expect(mockOtherKgService.createPerson).toHaveBeenCalledWith(
        'person_jim',
        'Jim',
      );
    });

    it('should propagate errors from OtherKgService', async () => {
      mockOtherKgService.createPerson.mockRejectedValue(
        new Error('Creation failed'),
      );

      await expect(service.createPerson('person_jim', 'Jim')).rejects.toThrow(
        'Creation failed',
      );
    });
  });

  // =========================================================================
  // Integration Tests
  // =========================================================================

  describe('integration: multiple interactions', () => {
    it('should incrementally refine person model across interactions', async () => {
      const kgModel = createKgPersonModel({
        traits: [],
        interactionCount: 0,
      });
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      // First interaction
      const parsed1 = createParsedInput({
        rawText: 'What is AI?',
        intentType: 'QUESTION',
      });
      const response1 = createGeneratedResponse({
        text: 'AI is artificial intelligence.',
      });

      await service.updateFromConversation('person_jim', parsed1, response1);

      // Second interaction
      const parsed2 = createParsedInput({
        rawText: 'Can you quickly explain neural networks?',
        intentType: 'QUESTION',
      });
      const response2 = createGeneratedResponse({
        text: 'Neural networks are computing systems inspired by biological neural networks.',
      });

      await service.updateFromConversation('person_jim', parsed2, response2);

      // Verify multiple update calls
      expect(mockOtherKgService.updatePersonModel).toHaveBeenCalledTimes(2);
    });

    it('should handle high-confidence entities as topic interests', async () => {
      const kgModel = createKgPersonModel();
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const parsed = createParsedInput({
        entities: [
          {
            name: 'reinforcement learning',
            type: 'TOPIC',
            wkgNodeId: 'node-123',
            confidence: 0.95,
          },
        ],
      });
      const response = createGeneratedResponse();

      await service.updateFromConversation('person_jim', parsed, response);

      const updateCall = mockOtherKgService.updatePersonModel.mock.calls[0];
      const traits = updateCall[1].traitsToUpsert;
      const rlTrait = traits.find(
        (t: any) => t.name === 'interested-in-reinforcement-learning',
      );
      expect(rlTrait).toBeDefined();
      expect(rlTrait.confidence).toBeGreaterThanOrEqual(0.60);
    });
  });

  // =========================================================================
  // Isolation Tests
  // =========================================================================

  describe('Other KG isolation', () => {
    it('should never access WKG directly (only through IOtherKgService)', async () => {
      const kgModel = createKgPersonModel();
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      await service.getPersonModel('person_jim');

      // Verify that ONLY Other KG service methods are called
      expect(mockOtherKgService.getPersonModel).toHaveBeenCalled();
      expect(mockOtherKgService.updatePersonModel).not.toHaveBeenCalled();
    });

    it('should use personId as isolation boundary', async () => {
      const jim = createKgPersonModel({ personId: 'person_jim' });
      const jane = createKgPersonModel({
        personId: 'person_jane',
        name: 'Jane',
      });

      mockOtherKgService.getPersonModel.mockImplementation((id: string) => {
        if (id === 'person_jim') return Promise.resolve(jim);
        if (id === 'person_jane') return Promise.resolve(jane);
        return Promise.resolve(null);
      });

      const resultJim = await service.getPersonModel('person_jim');
      const resultJane = await service.getPersonModel('person_jane');

      expect(resultJim?.name).toBe('Jim');
      expect(resultJane?.name).toBe('Jane');
    });
  });

  // =========================================================================
  // Data Sanitization Tests
  // =========================================================================

  describe('data sanitization', () => {
    it('should not expose internal KG node IDs', async () => {
      const kgModel = createKgPersonModel({
        traits: [
          {
            id: 'internal-trait-id-xyz',
            name: 'prefers-concise-answers',
            confidence: 0.65,
            provenance: 'INFERENCE',
            actrParams: {
              base: 0.30,
              count: 2,
              decayRate: 0.05,
              lastRetrievalAt: new Date(),
            },
            createdAt: new Date(),
          },
        ],
      });
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const result = await service.getPersonModel('person_jim');

      // Result should have no actrParams or internal IDs
      expect((result as any).traits).toBeUndefined();
      expect((result as any).actrParams).toBeUndefined();
      expect((result as any).id).toBeUndefined();
    });

    it('should filter low-confidence traits from preferences', async () => {
      const kgModel = createKgPersonModel({
        traits: [
          {
            id: 'trait-1',
            name: 'prefers-formal',
            confidence: 0.35,
            provenance: 'INFERENCE',
            actrParams: {
              base: 0.30,
              count: 0,
              decayRate: 0.05,
              lastRetrievalAt: new Date(),
            },
            createdAt: new Date(),
          },
          {
            id: 'trait-2',
            name: 'prefers-casual',
            confidence: 0.70,
            provenance: 'INFERENCE',
            actrParams: {
              base: 0.30,
              count: 3,
              decayRate: 0.05,
              lastRetrievalAt: new Date(),
            },
            createdAt: new Date(),
          },
        ],
      });
      mockOtherKgService.getPersonModel.mockResolvedValue(kgModel);

      const result = await service.getPersonModel('person_jim');

      // Low-confidence formal trait should not appear in preferences
      expect(result?.communicationPreferences.formality).not.toBe('formal');
      // High-confidence casual trait should appear
      expect(result?.communicationPreferences.formality).toBe('casual');
    });
  });
});

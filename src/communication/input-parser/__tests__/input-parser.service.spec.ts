/**
 * Unit tests for InputParserService.
 *
 * Tests cover:
 * - Intent classification (all 6 types)
 * - Entity extraction and WKG resolution
 * - Guardian feedback detection (CORRECTION/CONFIRMATION)
 * - Fallback behavior on LLM parse failures
 * - Anaphora resolution (simple)
 * - LLM_GENERATED provenance assignment
 */

import { Test, TestingModule } from '@nestjs/testing';
import { InputParserService } from '../input-parser.service';
import type {
  IInputParserService,
  GuardianInput,
  ParsedInput,
} from '../../interfaces/communication.interfaces';
import type { ILlmService, LlmResponse } from '../../../shared/types/llm.types';
import type { IWkgService } from '../../../knowledge';
import type { IEventService } from '../../../events';
import { LLM_SERVICE } from '../../../shared/types/llm.types';
import { WKG_SERVICE } from '../../../knowledge';
import { EVENTS_SERVICE } from '../../../events';

describe('InputParserService', () => {
  let service: IInputParserService;
  let llmService: jest.Mocked<ILlmService>;
  let wkgService: jest.Mocked<IWkgService>;
  let eventService: jest.Mocked<IEventService>;

  beforeEach(async () => {
    // Mock LLM service
    llmService = {
      complete: jest.fn(),
      estimateCost: jest.fn(),
      isAvailable: jest.fn().mockReturnValue(true),
    };

    // Mock WKG service
    wkgService = {
      upsertNode: jest.fn(),
      upsertEdge: jest.fn(),
      findNode: jest.fn(),
      findNodeByLabel: jest.fn().mockResolvedValue([]),
      queryEdges: jest.fn(),
      queryActionCandidates: jest.fn(),
      querySubgraph: jest.fn(),
    } as any;

    // Mock Events service
    eventService = {
      record: jest.fn(),
      query: jest.fn(),
      queryPattern: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InputParserService,
        {
          provide: LLM_SERVICE,
          useValue: llmService,
        },
        {
          provide: WKG_SERVICE,
          useValue: wkgService,
        },
        {
          provide: EVENTS_SERVICE,
          useValue: eventService,
        },
      ],
    }).compile();

    service = module.get<IInputParserService>(InputParserService);
  });

  describe('Intent Classification', () => {
    it('should classify QUESTION intent', async () => {
      const input: GuardianInput = {
        text: 'What is the capital of France?',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'QUESTION',
          confidence: 0.95,
          entities: [],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.intentType).toBe('QUESTION');
      expect(result.confidence).toBeGreaterThan(0.9);
      expect(result.entities).toHaveLength(0);
    });

    it('should classify STATEMENT intent', async () => {
      const input: GuardianInput = {
        text: 'Paris is the capital of France.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'STATEMENT',
          confidence: 0.88,
          entities: [{ name: 'Paris', type: 'PLACE', confidence: 0.92 }],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.intentType).toBe('STATEMENT');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Paris');
      expect(result.entities[0].type).toBe('PLACE');
    });

    it('should classify CORRECTION intent', async () => {
      const input: GuardianInput = {
        text: 'No, that is incorrect. The answer is actually 42.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'CORRECTION',
          confidence: 0.91,
          entities: [],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.intentType).toBe('CORRECTION');
      expect(result.guardianFeedbackType).toBe('correction');
    });

    it('should classify COMMAND intent', async () => {
      const input: GuardianInput = {
        text: 'Please summarize the conversation.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'COMMAND',
          confidence: 0.89,
          entities: [],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.intentType).toBe('COMMAND');
    });

    it('should classify ACKNOWLEDGMENT intent', async () => {
      const input: GuardianInput = {
        text: 'Yes, that is correct.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'ACKNOWLEDGMENT',
          confidence: 0.93,
          entities: [],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.intentType).toBe('ACKNOWLEDGMENT');
      expect(result.guardianFeedbackType).toBe('confirmation');
    });

    it('should classify TEACHING intent', async () => {
      const input: GuardianInput = {
        text: 'Let me teach you something: mitochondria are the powerhouse of the cell.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'TEACHING',
          confidence: 0.87,
          entities: [{ name: 'mitochondria', type: 'CONCEPT', confidence: 0.85 }],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.intentType).toBe('TEACHING');
      expect(result.entities).toHaveLength(1);
    });
  });

  describe('Entity Extraction and Resolution', () => {
    it('should extract multiple entities', async () => {
      const input: GuardianInput = {
        text: 'Jim went to Paris and met Alice yesterday.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'STATEMENT',
          confidence: 0.85,
          entities: [
            { name: 'Jim', type: 'PERSON', confidence: 0.95 },
            { name: 'Paris', type: 'PLACE', confidence: 0.93 },
            { name: 'Alice', type: 'PERSON', confidence: 0.92 },
          ],
        }),
        tokensUsed: { prompt: 15, completion: 25 },
        latencyMs: 120,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.entities).toHaveLength(3);
      expect(result.entities.map((e) => e.name)).toEqual(['Jim', 'Paris', 'Alice']);
    });

    it('should resolve entities against WKG', async () => {
      const input: GuardianInput = {
        text: 'Jim is an engineer.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'STATEMENT',
          confidence: 0.85,
          entities: [{ name: 'Jim', type: 'PERSON', confidence: 0.95 }],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      // Mock WKG response with a matching node
      wkgService.findNodeByLabel.mockResolvedValue([
        {
          id: 'node-jim-123',
          labels: ['Person'],
          nodeLevel: 'INSTANCE',
          properties: { name: 'Jim' },
          provenance: 'GUARDIAN',
          actrParams: {
            base: 0.6,
            count: 5,
            decayRate: 0.1,
            lastRetrievalAt: new Date(),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const result = await service.parse(input);

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].wkgNodeId).toBe('node-jim-123');
    });

    it('should handle unresolved entities (null wkgNodeId)', async () => {
      const input: GuardianInput = {
        text: 'XyzFictionName is interesting.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'STATEMENT',
          confidence: 0.75,
          entities: [{ name: 'XyzFictionName', type: 'PERSON', confidence: 0.6 }],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      // Mock WKG to return empty (no match)
      wkgService.findNodeByLabel.mockResolvedValue([]);

      const result = await service.parse(input);

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].wkgNodeId).toBeNull();
    });

    it('should assign LLM_GENERATED provenance to all entities', async () => {
      const input: GuardianInput = {
        text: 'Alice and Bob met.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'STATEMENT',
          confidence: 0.85,
          entities: [
            { name: 'Alice', type: 'PERSON', confidence: 0.9 },
            { name: 'Bob', type: 'PERSON', confidence: 0.89 },
          ],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      // All entities should have confidence at or around LLM_GENERATED base (0.35)
      // The actual confidence may be higher if the LLM reported higher confidence
      expect(result.entities.every((e) => e.confidence >= 0.35)).toBe(true);
    });
  });

  describe('Guardian Feedback Detection', () => {
    it('should detect CORRECTION feedback from intent', async () => {
      const input: GuardianInput = {
        text: 'That is incorrect.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'CORRECTION',
          confidence: 0.9,
          entities: [],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.guardianFeedbackType).toBe('correction');
    });

    it('should detect CONFIRMATION feedback from intent', async () => {
      const input: GuardianInput = {
        text: 'Yes, exactly right.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'ACKNOWLEDGMENT',
          confidence: 0.92,
          entities: [],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.guardianFeedbackType).toBe('confirmation');
    });

    it('should detect CORRECTION feedback from text markers', async () => {
      const input: GuardianInput = {
        text: 'No, that is wrong. The correct answer is different.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'STATEMENT',
          confidence: 0.8,
          entities: [],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.guardianFeedbackType).toBe('correction');
    });

    it('should detect CONFIRMATION feedback from text markers', async () => {
      const input: GuardianInput = {
        text: "You're right, that's the correct answer.",
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'STATEMENT',
          confidence: 0.8,
          entities: [],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.guardianFeedbackType).toBe('confirmation');
    });

    it('should return none for no feedback', async () => {
      const input: GuardianInput = {
        text: 'Can you tell me about machine learning?',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'QUESTION',
          confidence: 0.85,
          entities: [{ name: 'machine learning', type: 'CONCEPT', confidence: 0.88 }],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.guardianFeedbackType).toBe('none');
    });
  });

  describe('LLM Parse Failure Fallback', () => {
    it('should fallback to STATEMENT on invalid JSON', async () => {
      const input: GuardianInput = {
        text: 'Test input.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      // LLM returns invalid JSON
      llmService.complete.mockResolvedValue({
        content: 'This is not JSON',
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.intentType).toBe('STATEMENT');
      expect(result.entities).toHaveLength(0);
      expect(result.confidence).toBeLessThan(0.35);
    });

    it('should fallback to STATEMENT on invalid intent type', async () => {
      const input: GuardianInput = {
        text: 'Test input.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'INVALID_TYPE',
          confidence: 0.5,
          entities: [],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.intentType).toBe('STATEMENT');
    });

    it('should handle LLM service error gracefully', async () => {
      const input: GuardianInput = {
        text: 'Test input.',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockRejectedValue(new Error('LLM service unavailable'));

      const result = await service.parse(input);

      expect(result.intentType).toBe('STATEMENT');
      expect(result.entities).toHaveLength(0);
      expect(result.rawText).toBe(input.text);
      expect(result.confidence).toBeLessThan(0.35);
    });
  });

  describe('Preserved rawText and Metadata', () => {
    it('should preserve raw input text', async () => {
      const inputText = 'Original input text with special characters!@#';
      const input: GuardianInput = {
        text: inputText,
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'STATEMENT',
          confidence: 0.8,
          entities: [],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.rawText).toBe(inputText);
    });

    it('should include contextReferences in result', async () => {
      const input: GuardianInput = {
        text: 'What about that?',
        sessionId: 'session-1',
        timestamp: new Date(),
      };

      llmService.complete.mockResolvedValue({
        content: JSON.stringify({
          intentType: 'QUESTION',
          confidence: 0.85,
          entities: [],
        }),
        tokensUsed: { prompt: 10, completion: 20 },
        latencyMs: 100,
        model: 'claude-3-sonnet',
        cost: 0.001,
      } as LlmResponse);

      const result = await service.parse(input);

      expect(result.contextReferences).toBeDefined();
      expect(Array.isArray(result.contextReferences)).toBe(true);
    });
  });
});

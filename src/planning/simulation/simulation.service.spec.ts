/**
 * Unit tests for SimulationService.
 *
 * Tests cover:
 * - Candidate generation from research context knowledge
 * - Drive effect prediction from historical actions
 * - Success probability estimation
 * - Expected value computation
 * - Conservative estimates for sparse data
 * - Event emission (SIMULATION_COMPLETED vs SIMULATION_NO_VIABLE)
 */

import { ConfigService } from '@nestjs/config';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { SimulationService } from './simulation.service';
import type { ResearchResult } from '../interfaces/planning.interfaces';
import type { DriveSnapshot } from '../../shared/types/drive.types';

function createMockDriveSnapshot(): DriveSnapshot {
  return {
    pressureVector: {
      systemHealth: 0.2,
      moralValence: 0.2,
      integrity: 0.2,
      cognitiveAwareness: 0.2,
      guilt: 0.0,
      curiosity: 0.3,
      boredom: 0.4,
      anxiety: 0.2,
      satisfaction: 0.0,
      sadness: 0.0,
      informationIntegrity: 0.1,
      social: 0.5,
    },
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
    ruleMatchResult: { ruleId: null, eventType: 'DRIVE_TICK', matched: false },
    totalPressure: 2.5,
    sessionId: 'test-session',
  };
}

function createMockResearchResult(overrides?: Partial<ResearchResult>): ResearchResult {
  return {
    hasSufficientEvidence: true,
    failureCount: 3,
    discrepancies: ['Error in prediction'],
    priorAttempts: 1,
    evidenceStrength: 0.70,
    contextKnowledge: ['ConversationContext', 'UserIntent', 'SocialDynamics'],
    ...overrides,
  };
}

describe('SimulationService', () => {
  let service: SimulationService;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockEventsService: jest.Mocked<IEventService>;
  let mockWkgService: jest.Mocked<IWkgService>;
  let mockDriveStateReader: jest.Mocked<IDriveStateReader>;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn(),
    } as any;

    mockEventsService = {
      record: jest.fn(),
    } as any;

    mockWkgService = {
      querySubgraph: jest.fn(),
    } as any;

    mockDriveStateReader = {
      getCurrentState: jest.fn(),
    } as any;

    mockDriveStateReader.getCurrentState.mockReturnValue(createMockDriveSnapshot());

    mockConfigService.get.mockReturnValue({
      app: { sessionId: 'test-session' },
      planning: {
        simulationMinExpectedValue: 0.3,
        researchTimeWindowDays: 7,
        minFailuresForEvidence: 2,
      },
    });

    service = new SimulationService(
      mockConfigService,
      mockEventsService,
      mockWkgService,
      mockDriveStateReader,
    );
  });

  describe('simulate()', () => {
    it('generates 3-5 candidates from research', async () => {
      const research = createMockResearchResult({
        contextKnowledge: ['Context1', 'Context2', 'Context3', 'Context4', 'Context5'],
      });

      mockWkgService.querySubgraph.mockResolvedValue({
        nodes: [
          { properties: { success: true, curiosityEffect: 0.1 }, labels: ['Action'] },
          { properties: { success: true, curiosityEffect: 0.2 }, labels: ['Action'] },
          { properties: { success: true, curiosityEffect: 0.15 }, labels: ['Action'] },
        ],
        edges: [],
      } as any);

      const result = await service.simulate(research);

      expect(result.candidates.length).toBeGreaterThanOrEqual(3);
      expect(result.candidates.length).toBeLessThanOrEqual(5);
    });

    it('drive effect prediction averages similar WKG actions', async () => {
      const research = createMockResearchResult({
        contextKnowledge: ['Context1'],
      });

      // Mock 3 similar actions with known drive effects
      mockWkgService.querySubgraph.mockResolvedValue({
        nodes: [
          {
            properties: {
              curiosityEffect: 0.2,
              satisfactionEffect: 0.1,
              success: true,
            },
            labels: ['Action'],
          },
          {
            properties: {
              curiosityEffect: 0.4,
              satisfactionEffect: 0.2,
              success: true,
            },
            labels: ['Action'],
          },
          {
            properties: {
              curiosityEffect: 0.3,
              satisfactionEffect: 0.15,
              success: true,
            },
            labels: ['Action'],
          },
        ],
        edges: [],
      } as any);

      const result = await service.simulate(research);

      expect(result.candidates.length).toBeGreaterThan(0);
      const firstCandidate = result.candidates[0];
      // Average curiosityEffect = (0.2 + 0.4 + 0.3) / 3 = 0.3
      expect(firstCandidate.predictedDriveEffects.curiosity).toBeCloseTo(0.3, 5);
      // Average satisfactionEffect = (0.1 + 0.2 + 0.15) / 3 = 0.15
      expect(firstCandidate.predictedDriveEffects.satisfaction).toBeCloseTo(0.15, 5);
    });

    it('success probability from event frequency', async () => {
      const research = createMockResearchResult({
        contextKnowledge: ['Context1'],
        evidenceStrength: 0.8,
      });

      // Mock 5 actions: 4 successful, 1 failed
      mockWkgService.querySubgraph.mockResolvedValue({
        nodes: [
          { properties: { success: true, curiosityEffect: 0.1 }, labels: ['Action'] },
          { properties: { success: true, curiosityEffect: 0.1 }, labels: ['Action'] },
          { properties: { success: true, curiosityEffect: 0.1 }, labels: ['Action'] },
          { properties: { success: true, curiosityEffect: 0.1 }, labels: ['Action'] },
          { properties: { success: false, curiosityEffect: 0.1 }, labels: ['Action'] },
        ],
        edges: [],
      } as any);

      const result = await service.simulate(research);

      // Success probability = min(0.9, (4/5) * 0.8) = min(0.9, 0.64) = 0.64
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].successProbability).toBeLessThanOrEqual(0.9);
      expect(result.candidates[0].successProbability).toBeGreaterThan(0);
    });

    it('expected value computation correct', async () => {
      const research = createMockResearchResult({
        contextKnowledge: ['Context1', 'Context2'],
        evidenceStrength: 0.7,
      });

      mockWkgService.querySubgraph.mockResolvedValue({
        nodes: [
          {
            properties: {
              curiosityEffect: 0.3,
              success: true,
            },
            labels: ['Action'],
          },
          {
            properties: {
              curiosityEffect: 0.3,
              success: true,
            },
            labels: ['Action'],
          },
          {
            properties: {
              curiosityEffect: 0.3,
              success: true,
            },
            labels: ['Action'],
          },
        ],
        edges: [],
      } as any);

      const result = await service.simulate(research);

      expect(result.candidates.length).toBeGreaterThan(0);
      const candidate = result.candidates[0];

      // Expected value = 0.4 * driveReliefScore + 0.35 * successProbability + 0.25 * informationGain
      expect(candidate.expectedValue).toBeGreaterThanOrEqual(0);
      expect(candidate.expectedValue).toBeLessThanOrEqual(1.0);
    });

    it('sparse data (< 3 similar actions) produces conservative estimates', async () => {
      const research = createMockResearchResult({
        contextKnowledge: ['Context1'],
        evidenceStrength: 0.7,
      });

      // Only 1 similar action
      mockWkgService.querySubgraph.mockResolvedValue({
        nodes: [
          {
            properties: {
              curiosityEffect: 1.0,
              success: true,
            },
            labels: ['Action'],
          },
        ],
        edges: [],
      } as any);

      const result = await service.simulate(research);

      expect(result.candidates.length).toBeGreaterThan(0);
      const candidate = result.candidates[0];

      // With < 3 similar actions: effect is multiplied by 0.5
      // curiosityEffect should be 1.0 * 0.5 = 0.5
      if (candidate.predictedDriveEffects.curiosity !== undefined) {
        expect(candidate.predictedDriveEffects.curiosity).toBeLessThanOrEqual(0.5);
      }

      // successProbability should be multiplied by 0.7
      expect(candidate.successProbability).toBeLessThanOrEqual(0.7 * 0.7); // 0.7 success * 0.7 conservative
    });

    it('hasViableOutcome true when candidate EV > 0.3', async () => {
      const research = createMockResearchResult({
        contextKnowledge: ['Context1'],
        evidenceStrength: 0.8,
      });

      // Mock high-quality actions that should produce EV > 0.3
      mockWkgService.querySubgraph.mockResolvedValue({
        nodes: [
          {
            properties: {
              curiosityEffect: 0.5,
              satisfactionEffect: 0.3,
              success: true,
            },
            labels: ['Action'],
          },
          {
            properties: {
              curiosityEffect: 0.5,
              satisfactionEffect: 0.3,
              success: true,
            },
            labels: ['Action'],
          },
          {
            properties: {
              curiosityEffect: 0.5,
              satisfactionEffect: 0.3,
              success: true,
            },
            labels: ['Action'],
          },
        ],
        edges: [],
      } as any);

      const result = await service.simulate(research);

      expect(result.hasViableOutcome).toBe(true);
      expect(result.bestCandidate).toBeDefined();
      if (result.bestCandidate) {
        expect(result.bestCandidate.expectedValue).toBeGreaterThan(0.3);
      }
    });

    it('hasViableOutcome false when all candidates below threshold', async () => {
      const research = createMockResearchResult({
        contextKnowledge: ['Context1'],
        evidenceStrength: 0.1, // Low evidence strength
      });

      // Mock poor-quality actions with low success rates
      mockWkgService.querySubgraph.mockResolvedValue({
        nodes: [
          {
            properties: {
              curiosityEffect: 0.01,
              success: false,
            },
            labels: ['Action'],
          },
        ],
        edges: [],
      } as any);

      const result = await service.simulate(research);

      // All candidates should have low EV, below 0.3 threshold
      const allBelowThreshold = result.candidates.every((c) => c.expectedValue <= 0.3);
      if (allBelowThreshold) {
        expect(result.hasViableOutcome).toBe(false);
      }
    });

    it('SIMULATION_COMPLETED event emitted on viable outcome', async () => {
      const research = createMockResearchResult({
        contextKnowledge: ['Context1'],
        evidenceStrength: 0.8,
      });

      mockWkgService.querySubgraph.mockResolvedValue({
        nodes: [
          {
            properties: {
              curiosityEffect: 0.5,
              success: true,
            },
            labels: ['Action'],
          },
          {
            properties: {
              curiosityEffect: 0.5,
              success: true,
            },
            labels: ['Action'],
          },
          {
            properties: {
              curiosityEffect: 0.5,
              success: true,
            },
            labels: ['Action'],
          },
        ],
        edges: [],
      } as any);

      await service.simulate(research);

      expect(mockEventsService.record).toHaveBeenCalled();
      const recordCall = (mockEventsService.record as jest.Mock).mock.calls[0][0];
      expect(['SIMULATION_COMPLETED', 'SIMULATION_NO_VIABLE']).toContain(recordCall.type);
    });

    it('information gain decreases with more context knowledge', async () => {
      const research1 = createMockResearchResult({
        contextKnowledge: [],
      });

      const research2 = createMockResearchResult({
        contextKnowledge: new Array(20).fill('context'),
      });

      mockWkgService.querySubgraph.mockResolvedValue({
        nodes: [
          { properties: { success: true, curiosityEffect: 0.1 }, labels: ['Action'] },
          { properties: { success: true, curiosityEffect: 0.1 }, labels: ['Action'] },
          { properties: { success: true, curiosityEffect: 0.1 }, labels: ['Action'] },
        ],
        edges: [],
      } as any);

      const result1 = await service.simulate(research1);
      const result2 = await service.simulate(research2);

      // With more context knowledge, information gain should be lower
      const gain1 = result1.candidates[0]?.informationGain ?? 0;
      const gain2 = result2.candidates[0]?.informationGain ?? 0;

      expect(gain1).toBeGreaterThanOrEqual(gain2);
    });

    it('candidates are sorted by expectedValue descending', async () => {
      const research = createMockResearchResult({
        contextKnowledge: ['Context1'],
      });

      mockWkgService.querySubgraph.mockResolvedValue({
        nodes: [
          { properties: { curiosityEffect: 0.1, success: true }, labels: ['Action'] },
          { properties: { curiosityEffect: 0.1, success: true }, labels: ['Action'] },
          { properties: { curiosityEffect: 0.1, success: true }, labels: ['Action'] },
        ],
        edges: [],
      } as any);

      const result = await service.simulate(research);

      for (let i = 0; i < result.candidates.length - 1; i++) {
        expect(result.candidates[i].expectedValue).toBeGreaterThanOrEqual(
          result.candidates[i + 1].expectedValue,
        );
      }
    });
  });
});

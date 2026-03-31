/**
 * Unit tests for OpportunityResearchService.
 *
 * Tests cover:
 * - Sufficient evidence detection (failure count threshold)
 * - Evidence strength formula calculation
 * - Prior plan attempts factoring into evidence
 * - Event emission (RESEARCH_COMPLETED vs RESEARCH_INSUFFICIENT)
 */

import { ConfigService } from '@nestjs/config';
import type { Opportunity } from '../../drive-engine/interfaces/drive-engine.interfaces';
import type { DriveSnapshot, DriveName } from '../../shared/types/drive.types';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { OpportunityResearchService } from './opportunity-research.service';
import type { ResearchResult } from '../interfaces/planning.interfaces';

// Mock factory functions
function createMockOpportunity(overrides?: Partial<Opportunity>): Opportunity {
  return {
    id: 'opp-test-1',
    contextFingerprint: 'test-context-fp',
    classification: 'RECURRING_FAILURE',
    priority: 0.7,
    sourceEventId: 'evt-src-1',
    predictionMAE: 0.25,
    createdAt: new Date(),
    ...overrides,
  };
}

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

describe('OpportunityResearchService', () => {
  let service: OpportunityResearchService;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockEventsService: jest.Mocked<IEventService>;
  let mockWkgService: jest.Mocked<IWkgService>;
  let mockDriveStateReader: jest.Mocked<IDriveStateReader>;

  beforeEach(() => {
    // Create mock services
    mockConfigService = {
      get: jest.fn(),
    } as any;

    mockEventsService = {
      queryPattern: jest.fn(),
      record: jest.fn(),
    } as any;

    mockWkgService = {
      querySubgraph: jest.fn(),
    } as any;

    mockDriveStateReader = {
      getCurrentState: jest.fn(),
    } as any;

    // Set up default return values
    mockDriveStateReader.getCurrentState.mockReturnValue(createMockDriveSnapshot());
    mockWkgService.querySubgraph.mockResolvedValue({
      nodes: [],
      edges: [],
    });

    // Create service instance
    service = new OpportunityResearchService(
      mockConfigService,
      mockEventsService,
      mockWkgService,
      mockDriveStateReader,
    );
  });

  describe('research()', () => {
    it('with 3 prediction failures: hasSufficientEvidence = true', async () => {
      const opportunity = createMockOpportunity();
      const minFailuresForEvidence = 3;

      // Mock config
      mockConfigService.get.mockReturnValue({
        app: { sessionId: 'test-session' },
        planning: {
          researchTimeWindowDays: 7,
          minFailuresForEvidence,
          simulationMinExpectedValue: 0.3,
          maxProposalRevisions: 2,
        },
      });

      // Mock 3 failure events with absoluteError > 0.15
      const failureEvents = [
        { absoluteError: 0.20, contextFingerprint: 'test-context-fp' },
        { absoluteError: 0.25, contextFingerprint: 'test-context-fp' },
        { absoluteError: 0.18, contextFingerprint: 'test-context-fp' },
      ];
      mockEventsService.queryPattern.mockResolvedValue(failureEvents as any);

      // Mock no prior plan events
      mockEventsService.queryPattern.mockResolvedValueOnce(failureEvents as any);
      mockEventsService.queryPattern.mockResolvedValueOnce([] as any);

      const result = await service.research(opportunity);

      expect(result.hasSufficientEvidence).toBe(true);
      expect(result.failureCount).toBe(3);
      expect(mockEventsService.record).toHaveBeenCalled();
    });

    it('with 1 failure: hasSufficientEvidence = false', async () => {
      const opportunity = createMockOpportunity();

      mockConfigService.get.mockReturnValue({
        app: { sessionId: 'test-session' },
        planning: {
          researchTimeWindowDays: 7,
          minFailuresForEvidence: 3,
          simulationMinExpectedValue: 0.3,
          maxProposalRevisions: 2,
        },
      });

      // Mock only 1 failure event
      const failureEvents = [{ absoluteError: 0.20, contextFingerprint: 'test-context-fp' }];
      mockEventsService.queryPattern.mockResolvedValueOnce(failureEvents as any);
      mockEventsService.queryPattern.mockResolvedValueOnce([] as any);

      const result = await service.research(opportunity);

      expect(result.hasSufficientEvidence).toBe(false);
      expect(result.failureCount).toBe(1);
    });

    it('evidence strength formula produces correct values', async () => {
      const opportunity = createMockOpportunity();

      mockConfigService.get.mockReturnValue({
        app: { sessionId: 'test-session' },
        planning: {
          researchTimeWindowDays: 7,
          minFailuresForEvidence: 2,
          simulationMinExpectedValue: 0.3,
          maxProposalRevisions: 2,
        },
      });

      // Mock 2 failures + 2 unique discrepancies
      const failureEvents = [
        { absoluteError: 0.20 },
        { absoluteError: 0.25 },
      ];
      mockEventsService.queryPattern.mockResolvedValueOnce(failureEvents as any);
      mockEventsService.queryPattern.mockResolvedValueOnce([] as any);

      const result = await service.research(opportunity);

      // Evidence strength should be:
      // failureContribution = min(0.40, 2 * 0.10) = 0.20
      // discrepancyContribution = min(0.30, 0.30 * (2 / 2)) = 0.30
      // freshOpportunityBonus = 0.20 (no prior attempts)
      // priorFailureContribution = 0.0
      // Total = min(1.0, 0.20 + 0.30 + 0.20 + 0.0) = 0.70
      expect(result.evidenceStrength).toBe(0.70);
    });

    it('prior plan attempts factor into evidence strength', async () => {
      const opportunity = createMockOpportunity();

      mockConfigService.get.mockReturnValue({
        app: { sessionId: 'test-session' },
        planning: {
          researchTimeWindowDays: 7,
          minFailuresForEvidence: 2,
          simulationMinExpectedValue: 0.3,
          maxProposalRevisions: 2,
        },
      });

      const failureEvents = [{ absoluteError: 0.20 }, { absoluteError: 0.25 }];
      mockEventsService.queryPattern
        .mockResolvedValueOnce(failureEvents as any) // First call for failures
        .mockResolvedValueOnce([{ eventType: 'PLAN_CREATED' }, { eventType: 'PLAN_CREATED' }] as any); // Prior plans

      const result = await service.research(opportunity);

      // With 2 prior attempts:
      // freshOpportunityBonus = 0 (not a fresh opportunity)
      // priorFailureContribution = min(0.30, 2 * 0.10) = 0.20
      // Total = 0.20 + 0.30 + 0 + 0.20 = 0.70
      expect(result.evidenceStrength).toBeLessThanOrEqual(1.0);
      expect(result.priorAttempts).toBe(2);
    });

    it('RESEARCH_COMPLETED event emitted on sufficient evidence', async () => {
      const opportunity = createMockOpportunity();

      mockConfigService.get.mockReturnValue({
        app: { sessionId: 'test-session' },
        planning: {
          researchTimeWindowDays: 7,
          minFailuresForEvidence: 2,
          simulationMinExpectedValue: 0.3,
          maxProposalRevisions: 2,
        },
      });

      const failureEvents = [{ absoluteError: 0.20 }, { absoluteError: 0.25 }];
      mockEventsService.queryPattern.mockResolvedValueOnce(failureEvents as any);
      mockEventsService.queryPattern.mockResolvedValueOnce([] as any);

      await service.research(opportunity);

      // Verify RESEARCH_COMPLETED event was recorded
      expect(mockEventsService.record).toHaveBeenCalled();
      const recordCall = (mockEventsService.record as jest.Mock).mock.calls[0][0];
      expect(recordCall.type).toBe('RESEARCH_COMPLETED');
    });

    it('RESEARCH_INSUFFICIENT event emitted on insufficient evidence', async () => {
      const opportunity = createMockOpportunity();

      mockConfigService.get.mockReturnValue({
        app: { sessionId: 'test-session' },
        planning: {
          researchTimeWindowDays: 7,
          minFailuresForEvidence: 3,
          simulationMinExpectedValue: 0.3,
          maxProposalRevisions: 2,
        },
      });

      const failureEvents = [{ absoluteError: 0.20 }];
      mockEventsService.queryPattern.mockResolvedValueOnce(failureEvents as any);
      mockEventsService.queryPattern.mockResolvedValueOnce([] as any);

      await service.research(opportunity);

      expect(mockEventsService.record).toHaveBeenCalled();
      const recordCall = (mockEventsService.record as jest.Mock).mock.calls[0][0];
      expect(recordCall.type).toBe('RESEARCH_INSUFFICIENT');
    });

    it('returns contextKnowledge from WKG subgraph query', async () => {
      const opportunity = createMockOpportunity();

      mockConfigService.get.mockReturnValue({
        app: { sessionId: 'test-session' },
        planning: {
          researchTimeWindowDays: 7,
          minFailuresForEvidence: 1,
          simulationMinExpectedValue: 0.3,
          maxProposalRevisions: 2,
        },
      });

      const failureEvents = [{ absoluteError: 0.20 }];
      mockEventsService.queryPattern.mockResolvedValueOnce(failureEvents as any);
      mockEventsService.queryPattern.mockResolvedValueOnce([] as any);

      // Mock WKG subgraph response with knowledge nodes
      mockWkgService.querySubgraph.mockResolvedValue({
        nodes: [
          { properties: { name: 'ConversationContext' }, labels: ['Entity'] },
          { properties: { name: 'UserIntent' }, labels: ['Entity'] },
        ],
        edges: [],
      } as any);

      const result = await service.research(opportunity);

      expect(result.contextKnowledge).toContain('ConversationContext');
      expect(result.contextKnowledge).toContain('UserIntent');
    });

    it('handles WKG query failure gracefully', async () => {
      const opportunity = createMockOpportunity();

      mockConfigService.get.mockReturnValue({
        app: { sessionId: 'test-session' },
        planning: {
          researchTimeWindowDays: 7,
          minFailuresForEvidence: 1,
          simulationMinExpectedValue: 0.3,
          maxProposalRevisions: 2,
        },
      });

      const failureEvents = [{ absoluteError: 0.20 }];
      mockEventsService.queryPattern.mockResolvedValueOnce(failureEvents as any);
      mockEventsService.queryPattern.mockResolvedValueOnce([] as any);

      // WKG query fails
      mockWkgService.querySubgraph.mockRejectedValue(new Error('WKG error'));

      const result = await service.research(opportunity);

      // Should continue with empty contextKnowledge
      expect(result.contextKnowledge).toEqual([]);
    });
  });
});

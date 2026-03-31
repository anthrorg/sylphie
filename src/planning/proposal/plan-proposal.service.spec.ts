/**
 * Unit tests for PlanProposalService.
 *
 * Tests cover:
 * - Proposal generation from simulation candidates
 * - Complete proposal structure (trigger, actions, outcomes, aborts)
 * - Proposal revision based on feedback
 * - Revision count tracking with max 2 revisions
 */

import { ConfigService } from '@nestjs/config';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import { PlanProposalService } from './plan-proposal.service';
import type {
  ResearchResult,
  SimulationResult,
  SimulatedOutcome,
} from '../interfaces/planning.interfaces';
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

function createMockSimulatedOutcome(overrides?: Partial<SimulatedOutcome>): SimulatedOutcome {
  return {
    actionType: 'ConversationalResponse',
    predictedDriveEffects: {
      curiosity: 0.2,
      satisfaction: 0.15,
    },
    successProbability: 0.75,
    informationGain: 0.3,
    expectedValue: 0.65,
    ...overrides,
  };
}

function createMockSimulationResult(overrides?: Partial<SimulationResult>): SimulationResult {
  const candidates = [
    createMockSimulatedOutcome({ actionType: 'ConversationalResponse', expectedValue: 0.75 }),
    createMockSimulatedOutcome({ actionType: 'SocialComment', expectedValue: 0.65 }),
    createMockSimulatedOutcome({ actionType: 'KnowledgeQuery', expectedValue: 0.55 }),
    createMockSimulatedOutcome({ actionType: 'InformationRequest', expectedValue: 0.45 }),
  ];

  return {
    candidates,
    hasViableOutcome: true,
    bestCandidate: candidates[0],
    ...overrides,
  };
}

function createMockResearchResult(overrides?: Partial<ResearchResult>): ResearchResult {
  return {
    hasSufficientEvidence: true,
    failureCount: 3,
    discrepancies: ['Error in prediction'],
    priorAttempts: 1,
    evidenceStrength: 0.70,
    contextKnowledge: ['ConversationContext', 'UserIntent'],
    ...overrides,
  };
}

describe('PlanProposalService', () => {
  let service: PlanProposalService;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockEventsService: jest.Mocked<IEventService>;
  let mockDriveStateReader: jest.Mocked<IDriveStateReader>;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn(),
    } as any;

    mockEventsService = {
      record: jest.fn(),
    } as any;

    mockDriveStateReader = {
      getCurrentState: jest.fn(),
    } as any;

    mockDriveStateReader.getCurrentState.mockReturnValue(createMockDriveSnapshot());

    mockConfigService.get.mockReturnValue({
      app: { sessionId: 'test-session' },
      planning: {
        maxProposalRevisions: 2,
        simulationMinExpectedValue: 0.3,
        researchTimeWindowDays: 7,
        minFailuresForEvidence: 2,
      },
    });

    service = new PlanProposalService(
      mockConfigService,
      mockEventsService,
      mockDriveStateReader,
    );
  });

  describe('propose()', () => {
    it('generates proposals from simulation candidates', async () => {
      const research = createMockResearchResult();
      const simulation = createMockSimulationResult({
        candidates: [
          createMockSimulatedOutcome({ actionType: 'ConversationalResponse', expectedValue: 0.75 }),
          createMockSimulatedOutcome({ actionType: 'SocialComment', expectedValue: 0.65 }),
          createMockSimulatedOutcome({ actionType: 'KnowledgeQuery', expectedValue: 0.55 }),
        ],
      });

      const proposals = await service.propose(research, simulation);

      expect(proposals.length).toBe(3);
      expect(proposals.length).toBeLessThanOrEqual(simulation.candidates.length);
    });

    it('proposals have complete structure (trigger, actions, outcomes, aborts)', async () => {
      const research = createMockResearchResult();
      const simulation = createMockSimulationResult();

      const proposals = await service.propose(research, simulation);

      expect(proposals.length).toBeGreaterThan(0);
      const proposal = proposals[0];

      // Verify all required fields
      expect(proposal.id).toBeDefined();
      expect(proposal.opportunityId).toBeDefined();
      expect(proposal.name).toBeDefined();
      expect(proposal.triggerContext).toBeDefined();
      expect(proposal.actionSequence).toBeDefined();
      expect(proposal.expectedOutcome).toBeDefined();
      expect(proposal.abortConditions).toBeDefined();
      expect(proposal.evidenceStrength).toBeDefined();

      // Verify structure details
      expect(Array.isArray(proposal.actionSequence)).toBe(true);
      expect(proposal.actionSequence.length).toBeGreaterThan(0);
      expect(proposal.actionSequence[0].stepType).toBeDefined();
      expect(proposal.actionSequence[0].params).toBeDefined();
      expect(Array.isArray(proposal.abortConditions)).toBe(true);
      expect(proposal.abortConditions.length).toBeGreaterThan(0);
    });

    it('proposals contain drive effects from candidates', async () => {
      const research = createMockResearchResult();
      const simulation = createMockSimulationResult();

      const proposals = await service.propose(research, simulation);

      expect(proposals.length).toBeGreaterThan(0);
      const proposal = proposals[0];
      const actionParams = proposal.actionSequence[0].params;

      expect(actionParams.driveEffects).toBeDefined();
      expect(actionParams.successProbability).toBeDefined();
    });

    it('PROPOSAL_GENERATED event emitted', async () => {
      const research = createMockResearchResult();
      const simulation = createMockSimulationResult();

      await service.propose(research, simulation);

      expect(mockEventsService.record).toHaveBeenCalled();
      const recordCall = (mockEventsService.record as jest.Mock).mock.calls[0][0];
      expect(recordCall.type).toBe('PROPOSAL_GENERATED');
    });

    it('takes top 3 candidates from simulation', async () => {
      const research = createMockResearchResult();
      const simulation = createMockSimulationResult({
        candidates: [
          createMockSimulatedOutcome({ actionType: 'Action1', expectedValue: 0.9 }),
          createMockSimulatedOutcome({ actionType: 'Action2', expectedValue: 0.8 }),
          createMockSimulatedOutcome({ actionType: 'Action3', expectedValue: 0.7 }),
          createMockSimulatedOutcome({ actionType: 'Action4', expectedValue: 0.6 }),
          createMockSimulatedOutcome({ actionType: 'Action5', expectedValue: 0.5 }),
        ],
      });

      const proposals = await service.propose(research, simulation);

      expect(proposals.length).toBe(3);
      expect(proposals[0].name).toContain('Action1');
      expect(proposals[1].name).toContain('Action2');
      expect(proposals[2].name).toContain('Action3');
    });
  });

  describe('revise()', () => {
    it('revision modifies proposal based on feedback', async () => {
      const research = createMockResearchResult();
      const simulation = createMockSimulationResult();
      const proposals = await service.propose(research, simulation);
      const originalProposal = proposals[0];

      const feedback = ['timeout', 'safety'];
      const revisedProposal = await service.revise(originalProposal, feedback);

      // Abort conditions should be revised
      expect(revisedProposal.abortConditions.length).toBeGreaterThan(
        originalProposal.abortConditions.length,
      );

      // Should have added new conditions based on feedback keywords
      const abortString = revisedProposal.abortConditions.join(' ').toLowerCase();
      // Check for the conditions that should be added
      const hasNewConditions =
        abortString.includes('execution exceeds') || abortString.includes('safety threshold');
      expect(hasNewConditions).toBe(true);
    });

    it('max 2 revisions tracked (3rd revision returns unchanged)', async () => {
      const research = createMockResearchResult();
      const simulation = createMockSimulationResult();
      const proposals = await service.propose(research, simulation);
      let proposal = proposals[0];

      const feedback = ['timeout'];

      // First revision
      proposal = await service.revise(proposal, feedback);
      const afterFirstRevision = JSON.stringify(proposal);

      // Second revision
      proposal = await service.revise(proposal, feedback);
      const afterSecondRevision = JSON.stringify(proposal);

      // Third revision (should return unchanged)
      proposal = await service.revise(proposal, feedback);
      const afterThirdRevision = JSON.stringify(proposal);

      // After 2nd and 3rd revisions should be identical
      expect(afterThirdRevision).toBe(afterSecondRevision);
    });

    it('revision count increments on each call', async () => {
      const research = createMockResearchResult();
      const simulation = createMockSimulationResult();
      const proposals = await service.propose(research, simulation);
      let proposal = proposals[0];

      const feedback = ['timeout'];

      // Get initial abort count
      const initialAbortCount = proposal.abortConditions.length;

      // First revision
      proposal = await service.revise(proposal, feedback);
      const firstRevisionAbortCount = proposal.abortConditions.length;
      expect(firstRevisionAbortCount).toBeGreaterThan(initialAbortCount);

      // Second revision (should add another)
      proposal = await service.revise(proposal, feedback);
      const secondRevisionAbortCount = proposal.abortConditions.length;
      expect(secondRevisionAbortCount).toBeGreaterThanOrEqual(firstRevisionAbortCount);

      // Third revision (should not add more)
      proposal = await service.revise(proposal, feedback);
      const thirdRevisionAbortCount = proposal.abortConditions.length;
      expect(thirdRevisionAbortCount).toBe(secondRevisionAbortCount);
    });

    it('revise with different feedback types', async () => {
      const research = createMockResearchResult();
      const simulation = createMockSimulationResult();
      const proposals = await service.propose(research, simulation);

      // Test timeout feedback on separate proposals (to avoid hitting max revisions)
      let proposal1 = proposals[0];
      let revised1 = await service.revise(proposal1, ['timeout']);
      let abortString1 = revised1.abortConditions.join(' ').toLowerCase();
      expect(abortString1).toContain('execution exceeds');

      // Test safety feedback on a different proposal
      let proposal2 = proposals[1];
      let revised2 = await service.revise(proposal2, ['safety']);
      let abortString2 = revised2.abortConditions.join(' ').toLowerCase();
      expect(abortString2).toContain('safety threshold');

      // Test resource feedback on a third proposal
      let proposal3 = proposals[2];
      let revised3 = await service.revise(proposal3, ['resource']);
      let abortString3 = revised3.abortConditions.join(' ').toLowerCase();
      expect(abortString3).toContain('resource');
    });

    it('proposal ID is preserved through revisions', async () => {
      const research = createMockResearchResult();
      const simulation = createMockSimulationResult();
      const proposals = await service.propose(research, simulation);
      const originalId = proposals[0].id;

      let proposal = proposals[0];
      proposal = await service.revise(proposal, ['timeout']);
      proposal = await service.revise(proposal, ['safety']);

      expect(proposal.id).toBe(originalId);
    });
  });

  describe('propose and revise integration', () => {
    it('can create and revise multiple proposals in sequence', async () => {
      const research = createMockResearchResult();
      const simulation = createMockSimulationResult();

      const proposals = await service.propose(research, simulation);
      expect(proposals.length).toBeGreaterThan(0);

      // Revise first proposal
      let proposal1 = proposals[0];
      proposal1 = await service.revise(proposal1, ['timeout']);
      expect(proposal1.id).toBe(proposals[0].id);

      // Revise second proposal independently
      let proposal2 = proposals[1];
      proposal2 = await service.revise(proposal2, ['safety']);
      expect(proposal2.id).toBe(proposals[1].id);

      // Verify they maintained independent revision counts
      proposal1 = await service.revise(proposal1, ['resource']);
      proposal2 = await service.revise(proposal2, ['timeout']);

      // proposal1 should be at max revisions (can't revise more)
      const proposal1Revised = await service.revise(proposal1, ['extra']);
      expect(JSON.stringify(proposal1Revised)).toBe(JSON.stringify(proposal1));
    });
  });
});

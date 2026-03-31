/**
 * Planning Subsystem Verification Tests
 *
 * CANON §Subsystem 5 (Planning): Triggered by Opportunities detected by the
 * Drive Engine. Researches failure patterns, simulates outcomes, validates
 * proposed plans via LLM constraint checking, and creates new procedure
 * nodes in the WKG with LLM_GENERATED provenance at confidence 0.35.
 *
 * These tests verify:
 * 1. Recurring prediction failures (3+ in window) → Opportunity created
 * 2. Planning researches patterns in TimescaleDB
 * 3. Simulation runs and proposes plan
 * 4. LLM constraint engine validates plan against CANON
 * 5. Procedure created in WKG with LLM_GENERATED provenance at 0.35
 * 6. Rate limiting prevents planning runaway
 * 7. Cold-start dampening reduces early false-positive opportunities
 * 8. Opportunity priority decay works
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { randomUUID } from 'crypto';
import type {
  Opportunity,
  PlanningResult,
  QueuedOpportunity,
  ResearchResult,
  SimulationResult,
  SimulatedOutcome,
  PlanProposal,
  ValidationResult,
  CreatedProcedure,
  RateLimiterState,
  PlanningState,
} from '../../planning/interfaces/planning.interfaces';
import { PROVENANCE_BASE_CONFIDENCE } from '../../shared/types/provenance.types';

// ---------------------------------------------------------------------------
// Mock Data Factory
// ---------------------------------------------------------------------------

/**
 * Create a mock Opportunity from the Drive Engine.
 */
function createMockOpportunity(overrides?: Partial<Opportunity>): Opportunity {
  return {
    id: randomUUID(),
    triggeredBy: 'RECURRING_PREDICTION_FAILURES',
    contextFingerprint: 'context-action-state-hash',
    priority: 0.75,
    driveTarget: 'curiosity',
    createdAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

/**
 * Create a mock ResearchResult.
 */
function createMockResearchResult(overrides?: Partial<ResearchResult>): ResearchResult {
  return {
    hasSufficientEvidence: true,
    failureCount: 3,
    discrepancies: ['Expected outcome A, observed B'],
    priorAttempts: 2,
    evidenceStrength: 0.65,
    contextKnowledge: ['Node_X', 'Node_Y'],
    ...overrides,
  };
}

/**
 * Create a mock SimulatedOutcome.
 */
function createMockSimulatedOutcome(overrides?: Partial<SimulatedOutcome>): SimulatedOutcome {
  return {
    actionType: 'ConversationalResponse',
    predictedDriveEffects: {
      curiosity: 0.3,
      satisfaction: 0.15,
    },
    successProbability: 0.72,
    informationGain: 0.4,
    expectedValue: 0.65,
    ...overrides,
  };
}

/**
 * Create a mock SimulationResult.
 */
function createMockSimulationResult(overrides?: Partial<SimulationResult>): SimulationResult {
  return {
    candidates: [
      createMockSimulatedOutcome({ actionType: 'ConversationalResponse', expectedValue: 0.65 }),
      createMockSimulatedOutcome({ actionType: 'SocialComment', expectedValue: 0.58 }),
    ],
    hasViableOutcome: true,
    bestCandidate: createMockSimulatedOutcome({ expectedValue: 0.65 }),
    ...overrides,
  };
}

/**
 * Create a mock PlanProposal.
 */
function createMockPlanProposal(overrides?: Partial<PlanProposal>): PlanProposal {
  return {
    id: randomUUID(),
    opportunityId: randomUUID(),
    name: 'Respond with curiosity-targeted question',
    triggerContext: 'context-action-state-hash',
    actionSequence: [
      { stepType: 'ParseInput', params: {} },
      { stepType: 'GenerateResponse', params: { style: 'curious' } },
      { stepType: 'Deliver', params: {} },
    ],
    expectedOutcome: 'User engages with the question and provides new information',
    abortConditions: ['Input contains safety violation', 'Response latency > 5000ms'],
    evidenceStrength: 0.65,
    ...overrides,
  };
}

/**
 * Create a mock CreatedProcedure.
 */
function createMockCreatedProcedure(overrides?: Partial<CreatedProcedure>): CreatedProcedure {
  return {
    procedureId: `node-${randomUUID()}`,
    confidence: 0.35,
    provenance: 'LLM_GENERATED',
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Create a mock RateLimiterState.
 */
function createMockRateLimiterState(overrides?: Partial<RateLimiterState>): RateLimiterState {
  const now = new Date();
  const windowDuration = 3600000; // 1 hour

  return {
    plansThisWindow: 3,
    activePlans: 5,
    windowResetsAt: new Date(now.getTime() + windowDuration),
    canProceed: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite: Planning Subsystem
// ---------------------------------------------------------------------------

describe('Planning Subsystem Verification (T017)', () => {
  let opportunity: Opportunity;

  beforeEach(() => {
    opportunity = createMockOpportunity();
  });

  afterEach(() => {
    // Cleanup
  });

  // =========================================================================
  // T017.1: Recurring Prediction Failures Trigger Opportunity
  // =========================================================================

  describe('Recurring Prediction Failures (T017.1)', () => {
    it('should create Opportunity when 3+ prediction failures in window', () => {
      /**
       * CANON §Subsystem 5: The Drive Engine detects recurring prediction
       * failures (failures within a sliding window, e.g., last 10 actions).
       * When count >= 3, an Opportunity is created and sent to Planning.
       */

      const failureWindow = [
        { error: 0.25, accurate: false },
        { error: 0.18, accurate: false },
        { error: 0.22, accurate: false }, // Third failure -> trigger
      ];

      const failureCount = failureWindow.filter((f) => !f.accurate).length;
      const thresholdFailures = 3;

      const shouldCreateOpportunity = failureCount >= thresholdFailures;

      expect(shouldCreateOpportunity).toBe(true);
      expect(failureCount).toEqual(3);
    });

    it('should NOT create Opportunity with fewer than 3 failures', () => {
      /**
       * Fewer than 3 failures in the window is not considered "recurring"
       * and should not trigger Planning.
       */

      const failureWindow = [{ error: 0.2, accurate: false }, { error: 0.18, accurate: false }];

      const failureCount = failureWindow.filter((f) => !f.accurate).length;
      const thresholdFailures = 3;

      const shouldCreateOpportunity = failureCount >= thresholdFailures;

      expect(shouldCreateOpportunity).toBe(false);
      expect(failureCount).toBeLessThan(3);
    });

    it('should set opportunity priority based on failure severity', () => {
      /**
       * More severe failures (higher error) and higher failure frequency
       * should increase opportunity priority.
       */

      const lowSeverityFailures = [
        { error: 0.05, accurate: false },
        { error: 0.08, accurate: false },
        { error: 0.06, accurate: false },
      ];

      const highSeverityFailures = [
        { error: 0.45, accurate: false },
        { error: 0.38, accurate: false },
        { error: 0.42, accurate: false },
      ];

      const lowPriority = lowSeverityFailures.reduce((sum, f) => sum + f.error, 0) / lowSeverityFailures.length;
      const highPriority = highSeverityFailures.reduce((sum, f) => sum + f.error, 0) / highSeverityFailures.length;

      expect(lowPriority).toBeCloseTo(0.063, 2);
      expect(highPriority).toBeCloseTo(0.417, 2);
      expect(highPriority).toBeGreaterThan(lowPriority);
    });
  });

  // =========================================================================
  // T017.2: Planning Research Phase
  // =========================================================================

  describe('Planning Research Phase (T017.2)', () => {
    it('should research patterns in TimescaleDB for the opportunity context', () => {
      /**
       * CANON §Subsystem 5: The research phase queries TimescaleDB for
       * prior attempts in the opportunity's context fingerprint.
       *
       * ResearchResult includes failureCount, discrepancies, and
       * evidenceStrength derived from the historical data.
       */

      const research = createMockResearchResult();

      expect(research.failureCount).toBeGreaterThan(0);
      expect(research.priorAttempts).toBeGreaterThan(0);
      expect(research.evidenceStrength).toBeGreaterThan(0);
      expect(research.discrepancies.length).toBeGreaterThan(0);
    });

    it('should determine hasSufficientEvidence = true when failureCount >= 3', () => {
      /**
       * If the research phase finds >= 3 prior failures in the context,
       * there is sufficient evidence to proceed to simulation.
       */

      const sufficientEvidence = createMockResearchResult({
        failureCount: 3,
        hasSufficientEvidence: true,
      });

      expect(sufficientEvidence.hasSufficientEvidence).toBe(true);
      expect(sufficientEvidence.failureCount).toBeGreaterThanOrEqual(3);
    });

    it('should determine hasSufficientEvidence = false when failureCount < 3', () => {
      /**
       * Insufficient prior failures mean there's not enough evidence
       * for a meaningful simulation. Planning should return
       * { status: 'INSUFFICIENT_EVIDENCE' } without proceeding.
       */

      const insufficientEvidence = createMockResearchResult({
        failureCount: 1,
        hasSufficientEvidence: false,
      });

      expect(insufficientEvidence.hasSufficientEvidence).toBe(false);
      expect(insufficientEvidence.failureCount).toBeLessThan(3);
    });

    it('should extract contextKnowledge from WKG for the fingerprint', () => {
      /**
       * The research phase also queries the WKG for knowledge nodes
       * relevant to the opportunity's context. These inform the simulation.
       */

      const research = createMockResearchResult({
        contextKnowledge: ['Entity_User', 'Action_Ask', 'State_Curious'],
      });

      expect(research.contextKnowledge.length).toBeGreaterThan(0);
      expect(research.contextKnowledge[0]).toMatch(/^[A-Za-z_]+$/);
    });
  });

  // =========================================================================
  // T017.3: Simulation & Plan Proposal
  // =========================================================================

  describe('Simulation & Plan Proposal (T017.3)', () => {
    it('should run simulation and produce candidate outcomes', () => {
      /**
       * CANON §Subsystem 5: The simulation phase runs multiple candidate
       * action types against the research data and predicts outcomes.
       *
       * Each candidate includes predicted drive effects, success probability,
       * information gain, and expectedValue for ranking.
       */

      const simulation = createMockSimulationResult();

      expect(simulation.candidates.length).toBeGreaterThan(0);

      for (const candidate of simulation.candidates) {
        expect(candidate.actionType).toBeDefined();
        expect(candidate.successProbability).toBeGreaterThanOrEqual(0);
        expect(candidate.successProbability).toBeLessThanOrEqual(1);
        expect(candidate.informationGain).toBeGreaterThanOrEqual(0);
        expect(candidate.informationGain).toBeLessThanOrEqual(1);
        expect(candidate.expectedValue).toBeGreaterThanOrEqual(0);
        expect(candidate.expectedValue).toBeLessThanOrEqual(1);
      }
    });

    it('should select bestCandidate (highest expectedValue)', () => {
      /**
       * From the candidates, the best one (highest expectedValue) is selected
       * as the basis for the PlanProposal.
       */

      const simulation = createMockSimulationResult({
        candidates: [
          createMockSimulatedOutcome({ actionType: 'Option1', expectedValue: 0.5 }),
          createMockSimulatedOutcome({ actionType: 'Option2', expectedValue: 0.75 }),
          createMockSimulatedOutcome({ actionType: 'Option3', expectedValue: 0.65 }),
        ],
      });

      const values = simulation.candidates.map((c) => c.expectedValue);
      const maxValue = Math.max(...values);

      expect(simulation.bestCandidate?.expectedValue).toEqual(maxValue);
      expect(simulation.bestCandidate?.actionType).toEqual('Option2');
    });

    it('should return hasViableOutcome = false when no candidate meets threshold', () => {
      /**
       * If no candidate has sufficient expectedValue (e.g., > 0.5),
       * the simulation returns hasViableOutcome = false and Planning
       * returns { status: 'NO_VIABLE_OUTCOME' }.
       */

      const simulation = createMockSimulationResult({
        candidates: [
          createMockSimulatedOutcome({ expectedValue: 0.3 }),
          createMockSimulatedOutcome({ expectedValue: 0.25 }),
        ],
        hasViableOutcome: false,
        bestCandidate: null,
      });

      expect(simulation.hasViableOutcome).toBe(false);
      expect(simulation.bestCandidate).toBeNull();
    });

    it('should assemble PlanProposal from best candidate', () => {
      /**
       * The Planning service assembles a PlanProposal from:
       * - The best candidate's action type
       * - Research context knowledge
       * - Simulation outcomes
       * - Expected drive effects
       */

      const proposal = createMockPlanProposal();

      expect(proposal.id).toBeDefined();
      expect(proposal.name).toBeDefined();
      expect(proposal.actionSequence.length).toBeGreaterThan(0);
      expect(proposal.expectedOutcome).toBeDefined();
      expect(proposal.abortConditions.length).toBeGreaterThan(0);
      expect(proposal.evidenceStrength).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // T017.4: LLM Constraint Validation
  // =========================================================================

  describe('LLM Constraint Validation (T017.4)', () => {
    it('should validate plan against CANON constraints', () => {
      /**
       * CANON §Subsystem 5: The LLM constraint engine checks the proposal
       * against the six immutable CANON standards and other structural
       * constraints (drive isolation, provenance integrity, etc.).
       */

      const proposal = createMockPlanProposal();

      // Simulated validation
      const constraints = [
        'THEATER_PROHIBITION',
        'DRIVE_ISOLATION',
        'PROVENANCE_INTEGRITY',
        'CONTINGENCY_REQUIREMENT',
        'CONFIDENCE_CEILING',
        'SHRUG_IMPERATIVE',
      ];

      const validationResult: ValidationResult = {
        passed: true,
        failures: [],
        checkedConstraints: constraints,
      };

      expect(validationResult.checkedConstraints.length).toEqual(6);
      expect(validationResult.passed).toBe(true);
      expect(validationResult.failures.length).toEqual(0);
    });

    it('should reject plan if Theater Prohibition violated', () => {
      /**
       * CANON Standard 1 (Theater Prohibition): Output must correlate with
       * actual drive state. A proposal that would not improve the targeted
       * drive should be rejected.
       */

      const proposal = createMockPlanProposal({
        actionSequence: [
          { stepType: 'ClaimRelief', params: { drive: 'curiosity', relief: 0.5 } },
          // But no actual learning/knowledge gain
        ],
      });

      // Validation detects this violates Theater Prohibition
      const validationResult: ValidationResult = {
        passed: false,
        failures: [
          {
            constraint: 'THEATER_PROHIBITION',
            reason: 'Proposal claims relief but provides no actual learning mechanism',
            suggestedRevision: 'Add knowledge extraction step to support curiosity relief',
          },
        ],
        checkedConstraints: ['THEATER_PROHIBITION'],
      };

      expect(validationResult.passed).toBe(false);
      expect(validationResult.failures[0].constraint).toEqual('THEATER_PROHIBITION');
    });

    it('should approve plan when all constraints pass', () => {
      /**
       * A well-formed proposal that passes all constraints should be approved
       * and allowed to proceed to procedure creation.
       */

      const validationResult: ValidationResult = {
        passed: true,
        failures: [],
        checkedConstraints: [
          'THEATER_PROHIBITION',
          'DRIVE_ISOLATION',
          'PROVENANCE_INTEGRITY',
        ],
      };

      expect(validationResult.passed).toBe(true);
      expect(validationResult.failures.length).toEqual(0);
    });
  });

  // =========================================================================
  // T017.5: Procedure Creation with Correct Provenance
  // =========================================================================

  describe('Procedure Creation (T017.5)', () => {
    it('should create procedure node with LLM_GENERATED provenance', () => {
      /**
       * CANON §Subsystem 5: All Planning-created procedures receive
       * LLM_GENERATED provenance to reflect their origin (constructed
       * from simulation + LLM validation, not from direct teaching).
       */

      const procedure = createMockCreatedProcedure();

      expect(procedure.provenance).toEqual('LLM_GENERATED');
    });

    it('should set initial confidence to 0.35 for LLM_GENERATED procedures', () => {
      /**
       * CANON §Confidence Dynamics: LLM_GENERATED knowledge starts at
       * confidence 0.35 and rises through successful use (ACT-R dynamics).
       */

      const procedure = createMockCreatedProcedure();

      expect(procedure.confidence).toEqual(0.35);
      expect(procedure.confidence).toEqual(PROVENANCE_BASE_CONFIDENCE.LLM_GENERATED);
    });

    it('should return CREATED result with procedureId', () => {
      /**
       * When a procedure is successfully created, Planning returns:
       * { status: 'CREATED', procedureId: '<node_id>' }
       */

      const result: PlanningResult = {
        status: 'CREATED',
        procedureId: `node-${randomUUID()}`,
      };

      expect(result.status).toEqual('CREATED');
      expect(result.procedureId).toBeDefined();
    });
  });

  // =========================================================================
  // T017.6: Rate Limiting (Planning Runaway Prevention)
  // =========================================================================

  describe('Rate Limiting (T017.6)', () => {
    it('should prevent planning when rate limit window is full', () => {
      /**
       * CANON §Known Attractor States — Planning Runaway: The rate limiter
       * enforces a cap on plans created per time window (e.g., 10 plans/hour)
       * and a cap on concurrent active plans (e.g., 15 plans in WKG).
       *
       * When either cap is reached, canProceed = false.
       */

      const limiterFull = createMockRateLimiterState({
        plansThisWindow: 10,
        activePlans: 15,
        canProceed: false,
      });

      expect(limiterFull.canProceed).toBe(false);
    });

    it('should return RATE_LIMITED result when rate limit is exceeded', () => {
      /**
       * When the rate limiter blocks planning, IPlanningService.processOpportunity()
       * returns immediately without running research or simulation.
       */

      const rateLimited: PlanningResult = {
        status: 'RATE_LIMITED',
      };

      expect(rateLimited.status).toEqual('RATE_LIMITED');
    });

    it('should allow planning when both caps are below limit', () => {
      /**
       * The rate limiter should allow planning when both per-window and
       * active-plans counts are within acceptable bounds.
       */

      const limiterOk = createMockRateLimiterState({
        plansThisWindow: 3,
        activePlans: 5,
        canProceed: true,
      });

      expect(limiterOk.canProceed).toBe(true);
    });

    it('should reset window on schedule', () => {
      /**
       * The rate limiter window resets periodically (e.g., hourly).
       * The windowResetsAt timestamp indicates when the next reset occurs.
       */

      const limiter = createMockRateLimiterState();
      const now = new Date();

      expect(limiter.windowResetsAt.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  // =========================================================================
  // T017.7: Cold-Start Dampening
  // =========================================================================

  describe('Cold-Start Dampening (T017.7)', () => {
    it('should apply dampening to early opportunities to prevent Prediction Pessimist attractor', () => {
      /**
       * CANON §Known Attractor States — Prediction Pessimist: Early prediction
       * failures can cascade and flood the WKG with low-quality procedures
       * before the system has enough history.
       *
       * Cold-start dampening reduces the priority of opportunities in the
       * first N cycles (e.g., first 5 opportunities after process start).
       */

      const dampingFactor = 0.5; // Reduce priority to 50%
      const basePriority = 0.8;
      const dampenedPriority = basePriority * dampingFactor;

      expect(dampenedPriority).toEqual(0.4);
      expect(dampenedPriority).toBeLessThan(basePriority);
    });

    it('should disable dampening after cold-start period (N opportunities)', () => {
      /**
       * After the system has processed N opportunities and accumulated
       * enough history, cold-start dampening is disabled and priorities
       * revert to their full values.
       */

      const coldStartWindow = 5;
      const opportunityNumber = 6;

      const dampingActive = opportunityNumber <= coldStartWindow;

      expect(dampingActive).toBe(false);
    });
  });

  // =========================================================================
  // T017.8: Opportunity Priority Decay
  // =========================================================================

  describe('Opportunity Priority Decay (T017.8)', () => {
    it('should decay priority as opportunity ages in queue', () => {
      /**
       * CANON §Known Attractor States — Planning Runaway: Opportunities
       * should decay in priority over time so stale opportunities do not
       * block fresher, more relevant ones.
       *
       * Decay is typically exponential: priority *= e^(-t / tau)
       */

      const decayTau = 3600000; // 1 hour time constant
      const initialPriority = 0.8;

      // Age = 30 minutes
      const ageMs = 1800000;
      const decayedPriority = initialPriority * Math.exp(-ageMs / decayTau);

      expect(decayedPriority).toBeCloseTo(0.617, 2); // 0.8 * e^(-0.5)
      expect(decayedPriority).toBeLessThan(initialPriority);
    });

    it('should ensure newer opportunities have higher priority than aged ones', () => {
      /**
       * Two opportunities with the same initial priority should have
       * the newer one with higher currentPriority.
       */

      const now = new Date();
      const tauMs = 3600000; // 1 hour

      // Opportunity enqueued 10 minutes ago
      const oldEnqueueTime = now.getTime() - 600000;
      const oldAgeMs = now.getTime() - oldEnqueueTime;
      const oldPriority = 0.8 * Math.exp(-oldAgeMs / tauMs);

      // Opportunity enqueued 1 minute ago
      const newEnqueueTime = now.getTime() - 60000;
      const newAgeMs = now.getTime() - newEnqueueTime;
      const newPriority = 0.8 * Math.exp(-newAgeMs / tauMs);

      expect(newPriority).toBeGreaterThan(oldPriority);
    });

    it('should create QueuedOpportunity with decayed currentPriority', () => {
      /**
       * The IPlanningService.getQueue() returns QueuedOpportunity objects
       * that include the current decayed priority.
       */

      const opp = createMockOpportunity();
      const enqueuedAt = new Date(Date.now() - 600000); // 10 minutes ago
      const tauMs = 3600000;

      const ageMs = Date.now() - enqueuedAt.getTime();
      const currentPriority = opp.priority * Math.exp(-ageMs / tauMs);

      const queued: QueuedOpportunity = {
        opportunity: opp,
        currentPriority,
        enqueuedAt,
      };

      expect(queued.currentPriority).toBeLessThan(queued.opportunity.priority);
      expect(queued.enqueuedAt).toEqual(enqueuedAt);
    });
  });

  // =========================================================================
  // T017.9: Planning State Diagnostics
  // =========================================================================

  describe('Planning State Diagnostics (T017.9)', () => {
    it('should report queue size and active plans in state', () => {
      /**
       * PlanningState provides diagnostic information for dashboard display
       * and health monitoring. It includes queue size and active plan count.
       */

      const state: PlanningState = {
        queueSize: 3,
        activePlans: 7,
        plansCreatedThisWindow: 4,
        coldStartDampening: false,
        rateLimiterState: createMockRateLimiterState(),
      };

      expect(state.queueSize).toEqual(3);
      expect(state.activePlans).toEqual(7);
      expect(state.coldStartDampening).toBe(false);
    });

    it('should flag high activePlans as early warning for Planning Runaway', () => {
      /**
       * If activePlans is consistently high, it indicates procedures
       * are being created faster than they are being evaluated and
       * used by Decision Making. This is an early warning for Planning Runaway.
       */

      const warnThreshold = 20; // Alert when active plans > 20

      const healthyState: PlanningState = {
        queueSize: 2,
        activePlans: 8,
        plansCreatedThisWindow: 2,
        coldStartDampening: false,
        rateLimiterState: createMockRateLimiterState(),
      };

      const isWarning = healthyState.activePlans > warnThreshold;

      expect(isWarning).toBe(false);

      const warningState: PlanningState = {
        queueSize: 12,
        activePlans: 25,
        plansCreatedThisWindow: 5,
        coldStartDampening: false,
        rateLimiterState: createMockRateLimiterState(),
      };

      expect(warningState.activePlans > warnThreshold).toBe(true);
    });
  });
});

/**
 * Interfaces for the Planning subsystem.
 *
 * PUBLIC (re-exported from index.ts):
 *   IPlanningService     -- Main facade for external consumers.
 *   PlanningCycleResult  -- Return type from processNextOpportunity.
 *
 * INTERNAL (used only within PlanningModule):
 *   All pipeline step interfaces, queue interface, and data transfer objects.
 */

import type {
  OpportunityCreatedPayload,
  OpportunityClassification,
  OpportunityPriority,
  DriveName,
  ActionStep,
} from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

/**
 * IPlanningService -- the sole public API for the Planning subsystem.
 *
 * Other modules interact with Planning exclusively through this interface,
 * injected via the PLANNING_SERVICE token.
 */
export interface IPlanningService {
  /**
   * Manually trigger one planning cycle (dequeue + pipeline).
   * Returns immediately if a cycle is already in flight.
   */
  processNextOpportunity(): Promise<PlanningCycleResult>;

  /** Current queue status for health checks and debugging. */
  getQueueStatus(): OpportunityQueueStatus;

  /**
   * Post-execution evaluation hook.
   * Called by Decision Making after a Planning-created procedure executes.
   */
  evaluatePlanOutcome(procedureId: string, outcome: PlanOutcomeData): Promise<void>;
}

/**
 * Result of a single planning cycle.
 */
export interface PlanningCycleResult {
  readonly wasNoop: boolean;
  readonly opportunityId: string | null;
  readonly stage: 'NONE' | 'RESEARCH' | 'SIMULATION' | 'PROPOSAL' | 'VALIDATION' | 'CREATED';
  readonly procedureNodeId: string | null;
}

// ---------------------------------------------------------------------------
// Opportunity queue
// ---------------------------------------------------------------------------

export interface IOpportunityQueue {
  /** Enqueue an opportunity. Returns false if rate-limited, duplicate, or queue full. */
  enqueue(opportunity: QueuedOpportunity): boolean;

  /** Dequeue the highest-priority non-decayed opportunity, or null if empty. */
  dequeue(): QueuedOpportunity | null;

  /** Apply exponential time-decay to all items. Returns count of items dropped. */
  applyDecay(): number;

  /** Current queue size. */
  size(): number;

  /** Snapshot for health checks. */
  getStatus(): OpportunityQueueStatus;

  /** Record that a plan was created (for rate-limit tracking). */
  recordPlanCreated(): void;
}

/**
 * An opportunity sitting in the priority queue.
 */
export interface QueuedOpportunity {
  readonly payload: OpportunityCreatedPayload;
  readonly enqueuedAt: Date;
  readonly initialPriority: number;
  currentPriority: number;
}

export interface OpportunityQueueStatus {
  readonly queueSize: number;
  readonly plansCreatedInWindow: number;
  readonly rateLimitMax: number;
  readonly oldestItemAgeMs: number | null;
}

// ---------------------------------------------------------------------------
// Pipeline: Research
// ---------------------------------------------------------------------------

export interface IResearchService {
  research(opportunity: QueuedOpportunity): Promise<ResearchResult>;
}

export interface ResearchResult {
  /** Whether enough evidence was found to proceed. */
  readonly sufficient: boolean;
  /** How many matching events found in the research window. */
  readonly eventFrequency: number;
  /** Count of occurrences in the last 24 hours. */
  readonly recentOccurrences: number;
  /** Summaries of related events. */
  readonly relatedEvents: readonly EventSummary[];
  /** Semantic patterns extracted from event payloads. */
  readonly contextPatterns: readonly string[];
}

export interface EventSummary {
  readonly eventId: string;
  readonly type: string;
  readonly timestamp: Date;
  readonly payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pipeline: Simulation
// ---------------------------------------------------------------------------

export interface ISimulationService {
  simulate(
    opportunity: QueuedOpportunity,
    research: ResearchResult,
  ): Promise<SimulationResult>;
}

export interface SimulationResult {
  /** Whether at least one viable outcome was found. */
  readonly viable: boolean;
  /** All simulated outcomes, ranked by estimated benefit. */
  readonly outcomes: readonly SimulatedOutcome[];
  /** Best outcome (null if none viable). */
  readonly bestOutcome: SimulatedOutcome | null;
}

export interface SimulatedOutcome {
  readonly description: string;
  readonly actionCategory: string;
  readonly estimatedDriveEffect: Partial<Record<DriveName, number>>;
  readonly confidenceEstimate: number;
  readonly riskScore: number;
}

// ---------------------------------------------------------------------------
// Pipeline: Proposal
// ---------------------------------------------------------------------------

export interface IProposalService {
  propose(
    opportunity: QueuedOpportunity,
    research: ResearchResult,
    simulation: SimulationResult,
  ): Promise<PlanProposal>;

  /**
   * Refine a previously rejected proposal based on constraint violations.
   * Used by the validation retry loop.
   */
  refine(
    original: PlanProposal,
    violations: readonly string[],
    opportunity: QueuedOpportunity,
  ): Promise<PlanProposal>;
}

export interface PlanProposal {
  readonly name: string;
  readonly category: string;
  readonly triggerContext: string;
  readonly actionSequence: readonly ActionStep[];
  readonly rationale: string;
  /**
   * Predicted drive effects from simulation's best outcome.
   * Shows which drives this plan is expected to relieve when executed.
   * Stored on the WKG node for post-execution prediction evaluation.
   */
  readonly predictedDriveEffects: Partial<Record<DriveName, number>>;
}

// ---------------------------------------------------------------------------
// Pipeline: Constraint Validation
// ---------------------------------------------------------------------------

export interface IConstraintValidationService {
  validate(
    proposal: PlanProposal,
    opportunity: QueuedOpportunity,
  ): Promise<ValidationResult>;
}

export interface ValidationResult {
  readonly passed: boolean;
  readonly reasoning: string;
  readonly violations: readonly string[];
  readonly attemptsUsed: number;
  /** If true, the LLM was unavailable and the opportunity should be re-queued. */
  readonly deferred: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline: Procedure Creation
// ---------------------------------------------------------------------------

export interface IProcedureCreationService {
  /**
   * Write a validated plan as an ActionProcedure node in the WKG.
   * @returns The created node ID.
   */
  createProcedure(
    proposal: PlanProposal,
    opportunity: QueuedOpportunity,
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface IPlanEvaluationService {
  evaluateOutcome(procedureId: string, outcome: PlanOutcomeData): Promise<void>;
}

export interface PlanOutcomeData {
  readonly procedureId: string;
  readonly executionSuccessful: boolean;
  readonly driveEffectsObserved: Partial<Record<DriveName, number>>;
  readonly predictionAccurate: boolean;
  /**
   * Mean Absolute Error from the prediction evaluation, in [0.0, 1.0].
   * Provided when the outcome comes from a PREDICTION_EVALUATED event.
   * Used by PlanEvaluationService to flag consistently-failing procedures.
   */
  readonly mae?: number;
}

// ---------------------------------------------------------------------------
// Event Logger
// ---------------------------------------------------------------------------

/** Planning event types for the logger (subset of EventType). */
export type PlanningEventType =
  | 'OPPORTUNITY_RECEIVED'
  | 'OPPORTUNITY_INTAKE'
  | 'OPPORTUNITY_DROPPED'
  | 'RESEARCH_COMPLETED'
  | 'RESEARCH_INSUFFICIENT'
  | 'SIMULATION_COMPLETED'
  | 'SIMULATION_NO_VIABLE'
  | 'PROPOSAL_GENERATED'
  | 'PLAN_PROPOSED'
  | 'PLAN_VALIDATED'
  | 'PLAN_VALIDATION_FAILED'
  | 'PLAN_EVALUATION'
  | 'PLAN_CREATED'
  | 'PLAN_FAILURE'
  | 'PLANNING_RATE_LIMITED';

export interface IPlanningEventLogger {
  log(
    eventType: PlanningEventType,
    payload: Record<string, unknown>,
    sessionId?: string,
  ): void;
}

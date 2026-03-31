# FORGE ANALYSIS: Epic 8 (Planning — Opportunity-to-Procedure Pipeline)

**Analyzed:** 2026-03-29
**Epic:** 8 (Planning)
**Complexity:** L
**Dependencies:** E2 (Events), E3 (Knowledge), E4 (Drive Engine), E5 (Decision Making)
**Status:** Structural design (no implementations)

---

## 1. Module Structure

The Planning module (`src/planning/`) is a subsystem that transforms detected Opportunities (from Drive Engine) into new behavioral procedures through a six-stage pipeline. The architecture is designed to prevent Planning Runaway and Prediction Pessimist attractor states while maintaining strict groundedness in evidence.

### Full Directory Layout

```
src/planning/
├── planning.module.ts                          # NestJS module declaration
├── planning.service.ts                         # Main orchestrator (PlanningService)
├── planning.tokens.ts                          # DI tokens for injection
├──
├── interfaces/
│   ├── planning.interfaces.ts                  # All contracts (see §2)
│   ├── planning-events.types.ts                # Event type definitions
│   └── index.ts                                # Barrel export
│
├── pipeline/
│   ├── planning-pipeline.service.ts            # Main pipeline orchestrator
│   ├── pipeline-stage.interface.ts             # Generalized stage interface (optional)
│   └── index.ts
│
├── intake/
│   ├── opportunity-queue.service.ts            # Priority queue with decay
│   ├── opportunity-queue.types.ts              # QueuedOpportunity, QueueState
│   ├── queue-decay.service.ts                  # Decay math (pure or service-wrapped)
│   └── index.ts
│
├── research/
│   ├── opportunity-research.service.ts         # Stage 2: query patterns
│   ├── event-pattern-analyzer.service.ts       # Pattern extraction helper
│   ├── research.types.ts                       # ResearchResult, Discrepancy
│   └── index.ts
│
├── simulation/
│   ├── outcome-simulator.service.ts            # Stage 3: model outcomes
│   ├── candidate-generator.service.ts          # Generate action candidates
│   ├── drive-effect-predictor.service.ts       # Predict drive changes
│   ├── success-estimator.service.ts            # Estimate success probability
│   ├── information-gain-estimator.service.ts   # Estimate information value
│   ├── simulation.types.ts                     # SimulatedOutcome, ExpectedValue
│   └── index.ts
│
├── proposal/
│   ├── plan-proposal.service.ts                # Stage 4: generate proposals
│   ├── llm-proposal-prompts.ts                 # LLM prompt templates (pure)
│   ├── proposal.types.ts                       # PlanProposal, ActionStep
│   └── index.ts
│
├── validation/
│   ├── constraint-validation.service.ts        # Stage 5: LLM validation
│   ├── constraint-checkers/
│   │   ├── safety-constraints.checker.ts       # Theater Prohibition, etc.
│   │   ├── feasibility-constraints.checker.ts  # Complexity, dependencies
│   │   ├── coherence-constraints.checker.ts    # LLM logical coherence
│   │   ├── immutable-standards.checker.ts      # All 6 Immutable Standards
│   │   └── index.ts
│   ├── validation.types.ts                     # ValidationResult, ConstraintCheckResult
│   └── index.ts
│
├── procedure-creation/
│   ├── procedure-creation.service.ts           # Stage 6: write to WKG
│   ├── procedure.types.ts                      # Procedure node schema
│   └── index.ts
│
├── post-execution/
│   ├── plan-evaluation.service.ts              # Post-execution evaluation
│   ├── evaluation.types.ts                     # PlanEvaluation, ExecutionOutcome
│   └── index.ts
│
├── rate-limiting/
│   ├── planning-rate-limiter.service.ts        # Token/plan/time windows
│   ├── cold-start-dampening.service.ts         # Early-phase reduction
│   ├── rate-limiter.types.ts                   # RateLimiterState, LimitWindow
│   └── index.ts
│
├── exceptions/
│   ├── planning.exceptions.ts                  # PlanningException hierarchy
│   └── index.ts
│
└── index.ts                                    # Barrel export
```

### Subdirectory Purposes

| Directory | Purpose | Scope |
|-----------|---------|-------|
| `interfaces/` | All service contracts and type definitions | Public API |
| `pipeline/` | Pipeline orchestration and stage management | Core business logic |
| `intake/` | Opportunity queue management with decay | Infrastructure |
| `research/` | Event pattern analysis and evidence gathering | Pipeline stage |
| `simulation/` | Outcome modeling and expected value computation | Pipeline stage |
| `proposal/` | Plan generation from simulation results | Pipeline stage |
| `validation/` | LLM constraint checking and plan rejection | Pipeline stage |
| `procedure-creation/` | Writing validated plans to WKG | Pipeline stage |
| `post-execution/` | Plan outcome tracking and confidence updates | Infrastructure |
| `rate-limiting/` | Plan creation budgets and early-phase dampening | Infrastructure |
| `exceptions/` | Domain-specific exception hierarchy | Error handling |

### Module Dependency Tree

```
planning.module.ts
│
├── imports:
│   ├── ConfigModule (cycle config, rate limits, decay rates)
│   ├── EventsModule (read learnable events, query patterns, record planning events)
│   ├── KnowledgeModule (upsertNode for procedures, findNode for context, queryEdges)
│   └── (optional) DriveEngineModule via DRIVE_STATE_READER token (read-only drive state for context)
│
├── providers:
│   ├── PlanningService (exports this)
│   ├── PlanningPipelineService
│   ├── OpportunityQueueService
│   ├── OpportunityResearchService
│   ├── OutcomeSimulatorService
│   ├── PlanProposalService
│   ├── ConstraintValidationService
│   ├── ProcedureCreationService
│   ├── PlanEvaluationService
│   ├── PlanningRateLimiter
│   ├── ColdStartDampening
│   ├── (all constraint checkers)
│   ├── (all supporting services)
│   └── (nested in subdirectory modules if needed)
│
└── exports:
    ├── PlanningService (only public API)
    └── (optional) Planning token for Decision Making injection
```

---

## 2. Interface Contracts

All interfaces are defined in `src/planning/interfaces/planning.interfaces.ts` with complete JSDoc contracts. Supporting type definitions live in subdirectory `.types.ts` files.

### Core Service Interfaces

#### IPlanningService (Main Entry Point)

```typescript
/**
 * Main Planning subsystem service. Receives Opportunities from Drive Engine,
 * processes them through a six-stage pipeline, and creates new procedures in the WKG.
 *
 * CANON Principles:
 * - Plans are hypotheses, not solutions (tested, not trusted)
 * - Every plan is evaluated post-execution
 * - Plans follow ACT-R confidence dynamics (start at 0.35, earned to 0.80)
 * - Guardian Asymmetry: guardian feedback 2x/3x weight on plan outcomes
 * - Rate limiting prevents Planning Runaway
 * - Cold-start dampening prevents Prediction Pessimist
 *
 * Thread safety: Each Opportunity is processed independently. Multiple Opportunities
 * can be in different pipeline stages concurrently. Queue and rate limiter are protected
 * by NestJS singleton scope.
 */
@Injectable()
export interface IPlanningService {
  /**
   * Main entry point. Receives an Opportunity from Drive Engine and processes it
   * through the pipeline. Returns immediately (async); processing continues in background.
   *
   * @param opportunity - Opportunity from Drive Engine with context and failure pattern
   * @returns Promise<{ enqueuedAt: Date; opportunityId: string }>
   * @throws PlanningException if opportunity structure is invalid
   *
   * Process:
   * 1. Check rate limits. If exceeded, emit PLANNING_RATE_LIMITED event and return early.
   * 2. Enqueue into priority queue with cold-start dampening applied.
   * 3. Emit OPPORTUNITY_INTAKE event.
   * 4. Begin async pipeline processing (processQueuedOpportunities).
   */
  processOpportunity(opportunity: Opportunity): Promise<{ enqueuedAt: Date; opportunityId: string }>;

  /**
   * Get current state of opportunity queue and rate limiter.
   *
   * @returns Promise<PlanningState>
   *   - queueSize: current backlog
   *   - maxQueueSize: hard limit
   *   - plansCreatedThisWindow: count in current time window
   *   - maxPlansPerWindow: hourly limit
   *   - activePlans: procedures awaiting evaluation
   *   - maxActivePlans: concurrent limit
   *   - rateLimitedCount: total times rate limited
   *   - coldStartThreshold: decision count for full dampening
   *   - currentDecisionCount: decisions processed so far
   */
  getState(): Promise<PlanningState>;

  /**
   * Query all Opportunities currently in the queue (for debugging/monitoring).
   *
   * @returns Promise<QueuedOpportunity[]> ordered by current priority (highest first)
   * @throws PlanningException if queue is unreachable
   */
  getOpportunityQueue(): Promise<QueuedOpportunity[]>;

  /**
   * Force evaluation of a specific Opportunity without rate limiting.
   * Used by guardian to expedite planning on critical issues.
   *
   * @param opportunityId - ID of queued Opportunity
   * @returns Promise<PlanningResult>
   * @throws PlanningException if opportunity not found
   * @throws PlanningException if already being processed
   *
   * Precondition: Guardian must have explicitly requested this. This is an admin override.
   * Bypasses rate limits but not validation or CANON constraints.
   */
  processOpportunityNow(opportunityId: string): Promise<PlanningResult>;

  /**
   * Start the background queue processing loop.
   * Called once during NestJS module initialization.
   *
   * @returns Promise<void>
   *
   * Behavior:
   * - Polls the queue every N ms (configurable, default 100ms)
   * - Dequeues highest-priority Opportunity
   * - Calls internal _processPipelineAsync
   * - Catches and logs errors (does not throw)
   * - Loop continues until module shutdown
   *
   * Precondition: Drive Engine is running and emitting Opportunities to TimescaleDB.
   */
  startQueueProcessingLoop(): Promise<void>;

  /**
   * Graceful shutdown. Waits for in-flight pipeline processing to complete.
   *
   * @returns Promise<void>
   *
   * Behavior:
   * - Stop accepting new Opportunities
   * - Wait for active pipelines (max 30s timeout)
   * - Emit PLANNING_SHUTDOWN event
   * - Return
   */
  shutdown(): Promise<void>;
}
```

#### IPlanningPipelineService (Core Pipeline)

```typescript
/**
 * Main pipeline orchestrator. Coordinates six stages: Intake, Research, Simulate,
 * Propose, Validate, Create. Processes a single Opportunity through all stages.
 *
 * Each stage is a separate service with its own interface. This service coordinates
 * them and handles inter-stage communication and error recovery.
 */
@Injectable()
export interface IPlanningPipelineService {
  /**
   * Process a single Opportunity through the full pipeline.
   *
   * @param opportunity - Opportunity to process
   * @returns Promise<PlanningResult> with status and optional results/errors at each stage
   *
   * Process:
   * 1. Check rate limits (PlanningRateLimiter.canProceed)
   * 2. RESEARCH: OpportunityResearchService.research(opportunity)
   * 3. SIMULATE: OutcomeSimulator.simulate(research)
   * 4. PROPOSE: PlanProposalService.propose(research, simulations)
   * 5. VALIDATE: For each proposal, ConstraintValidationService.validate(proposal)
   *    - If passes, create procedure via ProcedureCreationService.create(proposal, validation)
   *    - Emit PLAN_CREATED event with confidence
   *    - Return success
   * 6. If all proposals fail validation, emit PLANNING_VALIDATION_FAILED and return failure
   *
   * Error handling:
   * - Research errors: return { status: 'RESEARCH_ERROR', error }
   * - Simulation errors: return { status: 'SIMULATION_ERROR', error }
   * - Proposal errors: return { status: 'PROPOSAL_ERROR', error }
   * - Validation errors: try next proposal, or return failure if all fail
   * - WKG write errors: emit error event, return { status: 'CREATION_ERROR', error }
   *
   * All errors are logged to TimescaleDB with full context.
   */
  processOpportunity(opportunity: Opportunity): Promise<PlanningResult>;
}

type PlanningResult =
  | { status: 'RATE_LIMITED'; opportunity: Opportunity; reason: string }
  | { status: 'RESEARCH_ERROR'; opportunity: Opportunity; error: PlanningException }
  | { status: 'INSUFFICIENT_EVIDENCE'; opportunity: Opportunity; research: ResearchResult }
  | { status: 'SIMULATION_ERROR'; opportunity: Opportunity; error: PlanningException }
  | { status: 'NO_VIABLE_OUTCOME'; opportunity: Opportunity; research: ResearchResult; simulations: SimulationResult }
  | { status: 'PROPOSAL_ERROR'; opportunity: Opportunity; error: PlanningException }
  | { status: 'VALIDATION_FAILED'; opportunity: Opportunity; proposals: PlanProposal[]; validationResults: ValidationResult[] }
  | { status: 'CREATION_ERROR'; opportunity: Opportunity; proposal: PlanProposal; error: PlanningException }
  | { status: 'CREATED'; opportunity: Opportunity; procedure: CreatedProcedure };
```

#### IOpportunityQueueService (Intake Stage)

```typescript
/**
 * Priority queue for Opportunities with exponential decay and maximum size enforcement.
 *
 * CANON Principles:
 * - Unaddressed Opportunities lose priority over time (decay)
 * - Queue has hard maximum size
 * - When queue is full, lowest-priority Opportunity is dropped
 * - No infinite backlog accumulation
 *
 * Decay formula: priority(t) = priority(0) * (1 - decayRate) ^ (hours)
 * Default: decayRate = 0.10 per hour, maxQueueSize = 50
 */
@Injectable()
export interface IOpportunityQueueService {
  /**
   * Add Opportunity to queue with cold-start dampening applied.
   *
   * @param opportunity - Raw Opportunity from Drive Engine
   * @param coldStartDampening - Reduction factor (0.0 = full effect, 1.0 = no reduction)
   * @returns Promise<{ enqueuedAt: Date; currentPriority: number }>
   *
   * Behavior:
   * 1. Apply cold-start dampening: adjustedPriority = opportunity.priority * (1 - coldStartDampening)
   * 2. Enqueue with timestamp
   * 3. If queue exceeds maxQueueSize:
   *    a. Apply decay to all items
   *    b. Sort by current priority (highest first)
   *    c. Drop the lowest-priority item
   *    d. Emit OPPORTUNITY_DROPPED event with reason
   * 4. Emit OPPORTUNITY_ENQUEUED event
   *
   * @throws PlanningException if opportunity is null or invalid
   */
  enqueue(opportunity: Opportunity, coldStartDampening: number): Promise<{ enqueuedAt: Date; currentPriority: number }>;

  /**
   * Dequeue the highest-priority Opportunity.
   *
   * @returns Promise<QueuedOpportunity | null>
   *
   * Behavior:
   * 1. Apply decay to all items based on time since enqueue
   * 2. Filter out negligible items (priority < 0.01)
   * 3. Sort by current priority (highest first)
   * 4. Dequeue and return the first item
   * 5. If queue is empty, return null
   *
   * Note: Decay is computed fresh on every dequeue. No background process is needed.
   */
  dequeue(): Promise<QueuedOpportunity | null>;

  /**
   * Get current queue state.
   *
   * @returns Promise<QueueState>
   *   - size: current queue length
   *   - maxSize: hard limit
   *   - opportunities: all items (unsorted)
   *   - droppedCount: total items dropped due to queue full
   *   - oldestEnqueueTime: timestamp of oldest item
   */
  getState(): Promise<QueueState>;

  /**
   * Clear the queue (emergency shutdown).
   * @returns Promise<{ clearedCount: number }>
   */
  clear(): Promise<{ clearedCount: number }>;
}

interface QueuedOpportunity extends Opportunity {
  readonly enqueuedAt: Date;
  readonly appliedDampening: number;
  readonly initialPriority: number;
  readonly currentPriority: number;  // computed dynamically on read
}

interface QueueState {
  readonly size: number;
  readonly maxSize: number;
  readonly opportunities: QueuedOpportunity[];
  readonly droppedCount: number;
  readonly oldestEnqueueTime: Date | null;
}
```

#### IOpportunityResearchService (Research Stage)

```typescript
/**
 * Queries TimescaleDB for event patterns matching an Opportunity's context.
 * Produces evidence quality assessment and discrepancy analysis.
 *
 * CANON Principle:
 * - Plans must be grounded in observed patterns
 * - Research answers: what happened, why it failed, what did the system expect vs. actual
 */
@Injectable()
export interface IOpportunityResearchService {
  /**
   * Research an Opportunity by querying TimescaleDB for related events.
   *
   * @param opportunity - Opportunity with context fingerprint
   * @returns Promise<ResearchResult>
   *
   * Process:
   * 1. Query TimescaleDB for prediction events matching context.fingerprint (last 7 days, configurable)
   * 2. Filter for prediction failures (MAE > 0.15)
   * 3. Extract discrepancies (expected vs. actual outcome)
   * 4. Query WKG for knowledge relevant to this context
   * 5. Query TimescaleDB for prior plan attempts on same context
   * 6. Assess evidence sufficiency:
   *    - Need >= 2 failures with MAE > 0.15
   *    - If fewer, insufficient evidence
   * 7. Compute evidence strength (0.0-1.0) from failure count, consistency, prior attempts
   * 8. Return ResearchResult
   *
   * @throws PlanningException if TimescaleDB query fails
   * @throws PlanningException if WKG query fails
   */
  research(opportunity: Opportunity): Promise<ResearchResult>;
}

interface ResearchResult {
  readonly opportunity: Opportunity;
  readonly eventPattern: EventPattern;
  readonly failures: PredictionFailure[];
  readonly discrepancies: Discrepancy[];
  readonly relevantKnowledge: KnowledgeNode[];
  readonly priorAttempts: PriorPlanAttempt[];
  readonly hasSufficientEvidence: boolean;
  readonly evidenceStrength: number;  // 0.0-1.0
}

interface EventPattern {
  readonly contextFingerprint: string;
  readonly timeWindow: string;  // e.g., '7d'
  readonly events: TimescaleEvent[];
  readonly failureCount: number;
  readonly averageMAE: number;
}

interface Discrepancy {
  readonly expected: PredictedOutcome;
  readonly actual: ActualOutcome;
  readonly mae: number;
  readonly context: ContextFingerprint;
}
```

#### IOutcomeSimulator (Simulation Stage)

```typescript
/**
 * Models potential outcomes of candidate actions using historical patterns and drive effects.
 * Generates candidates, predicts drive changes, estimates success probability, and
 * computes expected value.
 *
 * CANON Principle:
 * - Simulation is conservative. Overconfident simulations lead to failed plans.
 * - Simulations based on sparse data produce wide uncertainty, not precise predictions.
 * - Prefer simple plans with moderate value over complex plans with high value but high risk.
 */
@Injectable()
export interface IOutcomeSimulator {
  /**
   * Simulate potential outcomes for candidate actions.
   *
   * @param research - ResearchResult with context and event patterns
   * @returns Promise<SimulationResult>
   *
   * Process:
   * 1. Generate candidate actions from research context (max 5 candidates)
   * 2. For each candidate:
   *    a. Predict drive effects using WKG similar actions
   *    b. Estimate success probability from historical frequency
   *    c. Estimate information gain (how much new knowledge would be gained)
   *    d. Compute expected value: f(driveEffects, successProb, informationGain)
   * 3. Sort by expected value (descending)
   * 4. Return SimulationResult with top N candidates and hasViableOutcome flag
   *
   * Expected value function (basic, per Planner agent):
   * - 40% weight on drive relief (positive effects on core drives)
   * - 40% weight on success probability
   * - 20% weight on information gain
   *
   * @throws PlanningException if WKG query fails
   * @throws PlanningException if drive state read fails
   */
  simulate(research: ResearchResult): Promise<SimulationResult>;
}

interface SimulationResult {
  readonly simulations: SimulatedOutcome[];
  readonly hasViableOutcome: boolean;  // any expected value > 0.3
  readonly bestCandidate: SimulatedOutcome;
}

interface SimulatedOutcome {
  readonly action: CandidateAction;
  readonly predictedDriveEffects: Partial<DriveVector>;
  readonly successProbability: number;
  readonly informationGain: number;
  readonly expectedValue: number;
  readonly uncertainty: number;  // std deviation of estimate
}
```

#### IPlanProposalService (Proposal Stage)

```typescript
/**
 * Generates concrete plan proposals from simulation results.
 * Proposals include trigger context, action sequence, expected outcome, and abort conditions.
 *
 * CANON Principle:
 * - Plans start as unvalidated candidates
 * - LLM constraint engine validates before commitment
 * - Proposals can be revised if validation feedback is actionable
 */
@Injectable()
export interface IPlanProposalService {
  /**
   * Generate initial plan proposals from simulation and research results.
   *
   * @param research - ResearchResult with context and prior attempts
   * @param simulations - SimulationResult with top candidates
   * @returns Promise<PlanProposal[]> (max 3 proposals)
   *
   * Process:
   * 1. For each top-N simulated outcome:
   *    a. Generate a plan description (what, why, when)
   *    b. Create action sequence with steps, dependencies, fallbacks
   *    c. Set expected outcomes and abort conditions
   *    d. Include evidence strength and simulated value metadata
   * 2. Sort by complexity (prefer simpler plans)
   * 3. Return top N proposals (max 3)
   *
   * Proposals are NOT validated yet -- they are candidates for validation.
   *
   * @throws PlanningException if simulation results are invalid
   */
  propose(research: ResearchResult, simulations: SimulationResult): Promise<PlanProposal[]>;

  /**
   * Revise a proposal based on constraint validation feedback.
   *
   * @param proposal - Original proposal that failed validation
   * @param feedback - ConstraintCheckResult with specific failures
   * @returns Promise<PlanProposal> (revised)
   *
   * Process:
   * 1. Parse constraint feedback
   * 2. Modify proposal to address specific constraint failures
   * 3. Return revised proposal (single revision, not iterative)
   *
   * If feedback is not actionable (e.g., "proposal violates Immutable Standard 1"),
   * throw PlanningException to signal that this proposal line cannot be fixed.
   *
   * @throws PlanningException if feedback is not actionable
   */
  revise(proposal: PlanProposal, feedback: ConstraintCheckResult): Promise<PlanProposal>;
}

interface PlanProposal {
  readonly id: string;
  readonly opportunityId: string;
  readonly description: string;

  readonly procedure: {
    readonly name: string;
    readonly triggerContext: ContextFingerprint;
    readonly actionSequence: ActionStep[];
    readonly expectedOutcome: PredictedOutcome;
    readonly abortConditions: AbortCondition[];
  };

  readonly evidenceStrength: number;  // 0.0-1.0
  readonly simulatedExpectedValue: number;
  readonly complexity: number;  // 1-10, based on step count and dependencies
}

interface ActionStep {
  readonly order: number;
  readonly action: Action;
  readonly expectedDuration: number;  // ms
  readonly dependsOn?: number;  // previous step order, if any
  readonly fallback?: Action;  // what to do if this step fails
}

interface AbortCondition {
  readonly trigger: string;  // e.g., 'anxiety > 0.8', 'guardian_interrupt'
  readonly action: Action;  // what to do when triggered
}
```

#### IConstraintValidationService (Validation Stage)

```typescript
/**
 * LLM constraint engine. Validates plan proposals against safety, feasibility,
 * coherence, and Immutable Standard constraints.
 *
 * CANON Principle:
 * - All six Immutable Standards must be checked
 * - Constraint failures are reasons to reject or revise
 * - LLM serves as a sanity check, not a decision maker
 */
@Injectable()
export interface IConstraintValidationService {
  /**
   * Validate a plan proposal against all constraints.
   *
   * @param proposal - Plan to validate
   * @returns Promise<ValidationResult>
   *
   * Constraints checked:
   * 1. Safety: does not express unsupported emotions, does not harm the system
   * 2. Feasibility: dependencies can be satisfied, no circular dependencies
   * 3. Coherence: LLM checks if the plan makes logical sense (not contradictory)
   * 4. Immutable Standards:
   *    a. Theater Prohibition: no unsupported emotional expressions
   *    b. Contingency Requirement: all reinforcements trace to specific behaviors
   *    c. Confidence Ceiling: no assumed untested knowledge > 0.60
   *    d. Shrug Imperative: has an "do nothing" option for uncertainty
   *    e. (Standard 5 handled in Drive Engine, not relevant here)
   *    f. No Self-Modification: does not attempt to modify evaluation function
   *
   * Result:
   * - If all constraints pass: { passes: true, checkedConstraints: [...] }
   * - If any constraint fails: { passes: false, failures: [...], suggestedRevisions: [...] }
   *
   * @throws PlanningException if LLM call fails
   * @throws PlanningException if constraint check crashes
   */
  validate(proposal: PlanProposal): Promise<ValidationResult>;
}

interface ValidationResult {
  readonly passes: boolean;
  readonly checkedConstraints: ConstraintCheckResult[];
  readonly failures?: ConstraintCheckResult[];
  readonly suggestedRevisions?: string[];  // actionable feedback for revision
}

interface ConstraintCheckResult {
  readonly constraint: 'SAFETY' | 'FEASIBILITY' | 'COHERENCE' | 'IMMUTABLE_STANDARDS' | 'CUSTOM';
  readonly passes: boolean;
  readonly details?: unknown;  // constraint-specific details
  readonly feedback?: string;  // human-readable explanation
}
```

#### IProcedureCreationService (Procedure Creation Stage)

```typescript
/**
 * Writes validated plan proposals as procedure nodes in the WKG.
 * Procedures start at 0.35 confidence (LLM_GENERATED base) and follow ACT-R dynamics.
 *
 * CANON Principle:
 * - Plans are hypotheses, not solutions
 * - Confidence earned through successful use, not granted at creation
 * - All procedures carry LLM_GENERATED provenance (created via constraint engine)
 */
@Injectable()
export interface IProcedureCreationService {
  /**
   * Create a procedure node in the WKG for a validated plan.
   *
   * @param proposal - Validated PlanProposal
   * @param validation - ValidationResult confirming all constraints pass
   * @returns Promise<CreatedProcedure>
   *
   * Process:
   * 1. Create Procedure node in WKG:
   *    - type: 'Procedure'
   *    - name: proposal.procedure.name
   *    - properties: all procedure data, evidence, opportunity ID
   *    - provenance: 'LLM_GENERATED' (constraint engine used LLM)
   *    - confidence: 0.35 (base for LLM_GENERATED, per CANON)
   *    - retrievalCount: 0
   *    - lastRetrievalTime: null
   * 2. Create edges:
   *    - TRIGGERED_BY edge from procedure to context entity
   *    - CAN_ACHIEVE edge from procedure to expected outcome node
   * 3. Emit PLAN_CREATED event with confidence 0.35
   * 4. Return CreatedProcedure
   *
   * @throws KnowledgeException if WKG write fails
   * @throws PlanningException if proposal is malformed
   */
  create(proposal: PlanProposal, validation: ValidationResult): Promise<CreatedProcedure>;
}

interface CreatedProcedure {
  readonly id: string;  // node ID in WKG
  readonly confidence: number;  // always 0.35 at creation
  readonly status: 'AWAITING_FIRST_USE';
}
```

#### IPlanEvaluationService (Post-Execution Evaluation)

```typescript
/**
 * Evaluates plan execution outcomes and updates procedure confidence per ACT-R.
 * Feeds failed plans back to Drive Engine as prediction failures.
 *
 * CANON Principle:
 * - Plans are tested, not trusted
 * - Confidence updated based on outcome (success/failure)
 * - Failed plans create new Opportunities (cycle continues)
 * - Guardian feedback on plan outcomes carries 2x/3x weight
 */
@Injectable()
export interface IPlanEvaluationService {
  /**
   * Evaluate a plan after execution.
   *
   * @param procedureId - ID of procedure node in WKG
   * @param execution - ProcedureExecution with actual outcomes
   * @returns Promise<PlanEvaluation>
   *
   * Process:
   * 1. Retrieve procedure node from WKG
   * 2. Compare expected drive effects to actual drive effects
   * 3. Compute MAE (mean absolute error) of prediction
   * 4. Classify as success (MAE < 0.10), partial (0.10 <= MAE <= 0.15), failure (MAE > 0.15)
   * 5. Update procedure confidence using ACT-R formula:
   *    - Base: 0.35
   *    - Formula: min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
   *    - On success: increment count, reset decay timer
   *    - On failure: apply confidence penalty
   * 6. Update procedure node in WKG with new confidence and MAE
   * 7. Emit PLAN_EVALUATION event
   * 8. If failure: emit PLAN_FAILURE event (may trigger new Opportunity from Drive Engine)
   * 9. Return PlanEvaluation
   *
   * @throws KnowledgeException if procedure not found
   * @throws KnowledgeException if WKG update fails
   */
  evaluateExecution(procedureId: string, execution: ProcedureExecution): Promise<PlanEvaluation>;
}

interface PlanEvaluation {
  readonly mae: number;
  readonly success: boolean;  // MAE < 0.10
  readonly failure: boolean;  // MAE > 0.15
  readonly newConfidence: number;
}

interface ProcedureExecution {
  readonly procedureId: string;
  readonly context: ContextFingerprint;
  readonly expectedDriveEffects: Partial<DriveVector>;
  readonly actualDriveEffects: Partial<DriveVector>;
  readonly outcome: 'success' | 'partial' | 'failure';
}
```

#### IPlanningRateLimiter (Infrastructure)

```typescript
/**
 * Prevents Planning Runaway by enforcing limits on:
 * - Plans created per time window (e.g., 3 per hour)
 * - Active plans awaiting evaluation (e.g., max 10)
 * - LLM tokens per plan (e.g., max 4000 tokens)
 * - Cold-start dampening (reduced Opportunity weight in early sessions)
 *
 * CANON Principle:
 * - Planning cannot consume unbounded resources
 * - Cold-start dampening prevents Prediction Pessimist attractor state
 */
@Injectable()
export interface IPlanningRateLimiter {
  /**
   * Check if the system can proceed with plan creation.
   *
   * @returns boolean (true = proceed, false = rate limited)
   *
   * Checks:
   * 1. Plans created in current time window < maxPlansPerWindow
   * 2. Active plans < maxActivePlans
   * 3. LLM token budget remaining (if plan would exceed, return false)
   *
   * Time windows are sliding. Internally tracks window start time and resets when window expires.
   */
  canProceed(): boolean;

  /**
   * Record that a plan was created. Increments internal counters.
   *
   * @param tokensUsed - Tokens spent on LLM calls for this plan (proposal + validation)
   * @returns void
   *
   * Called by ProcedureCreationService after plan is written to WKG.
   */
  recordPlanCreated(tokensUsed: number): void;

  /**
   * Record that a plan execution was evaluated. Decrements active plan counter.
   *
   * @param procedureId - Procedure that was evaluated
   * @returns void
   */
  recordPlanEvaluated(procedureId: string): void;

  /**
   * Get current rate limiter state.
   *
   * @returns Promise<RateLimiterState>
   *   - windowDuration: ms
   *   - windowStart: Date
   *   - plansCreatedThisWindow: count
   *   - maxPlansPerWindow: limit
   *   - activePlans: count
   *   - maxActivePlans: limit
   *   - tokensUsedThisWindow: count
   *   - maxTokensPerWindow: limit (optional)
   *   - rateLimitedCount: total times limited
   */
  getState(): Promise<RateLimiterState>;
}

interface RateLimiterState {
  readonly windowDuration: number;  // ms
  readonly windowStart: Date;
  readonly plansCreatedThisWindow: number;
  readonly maxPlansPerWindow: number;
  readonly activePlans: number;
  readonly maxActivePlans: number;
  readonly tokensUsedThisWindow: number;
  readonly maxTokensPerWindow?: number;
  readonly rateLimitedCount: number;
}
```

#### IColdStartDampening (Infrastructure)

```typescript
/**
 * Reduces Opportunity weight in early operation (first N decisions).
 * Prevents Prediction Pessimist attractor state (flooding with low-quality procedures
 * before the graph has substance to support them).
 *
 * CANON Principle:
 * - Early prediction failures are noise, not signals
 * - Reduce planning weight until experience accumulates
 * - Linear dampening from max reduction to zero over decision count threshold
 */
@Injectable()
export interface IColdStartDampening {
  /**
   * Compute dampening factor for an Opportunity.
   *
   * @param totalDecisions - Total decisions processed so far (global counter)
   * @returns number (0.0 to 1.0, where 1.0 = full dampening, 0.0 = no dampening)
   *
   * Formula:
   * - if totalDecisions >= coldStartThreshold: return 0.0 (no dampening)
   * - else: return 0.8 * (1 - totalDecisions / coldStartThreshold) (linear decay)
   *
   * Example (coldStartThreshold = 100):
   * - Decision 0: dampening = 0.80 (Opportunity priority * 0.20)
   * - Decision 50: dampening = 0.40 (Opportunity priority * 0.60)
   * - Decision 100+: dampening = 0.0 (full priority)
   *
   * This is a pure function (no state). Dampening is applied when enqueueing by
   * PlanningService (which has access to totalDecisions counter).
   */
  compute(totalDecisions: number): number;

  /**
   * Get the cold-start configuration.
   *
   * @returns Promise<ColdStartConfig>
   *   - threshold: decision count for full effect
   *   - maxDampening: maximum reduction factor (0.8 = 80% reduction)
   *   - enabled: whether dampening is active
   */
  getConfig(): Promise<ColdStartConfig>;
}

interface ColdStartConfig {
  readonly threshold: number;
  readonly maxDampening: number;
  readonly enabled: boolean;
}
```

---

## 3. DI Wiring

### Injection Tokens

```typescript
// src/planning/planning.tokens.ts

export const PLANNING_SERVICE = Symbol('PLANNING_SERVICE');
export const PLANNING_PIPELINE_SERVICE = Symbol('PLANNING_PIPELINE_SERVICE');
export const OPPORTUNITY_QUEUE_SERVICE = Symbol('OPPORTUNITY_QUEUE_SERVICE');
export const OPPORTUNITY_RESEARCH_SERVICE = Symbol('OPPORTUNITY_RESEARCH_SERVICE');
export const OUTCOME_SIMULATOR_SERVICE = Symbol('OUTCOME_SIMULATOR_SERVICE');
export const PLAN_PROPOSAL_SERVICE = Symbol('PLAN_PROPOSAL_SERVICE');
export const CONSTRAINT_VALIDATION_SERVICE = Symbol('CONSTRAINT_VALIDATION_SERVICE');
export const PROCEDURE_CREATION_SERVICE = Symbol('PROCEDURE_CREATION_SERVICE');
export const PLAN_EVALUATION_SERVICE = Symbol('PLAN_EVALUATION_SERVICE');
export const PLANNING_RATE_LIMITER = Symbol('PLANNING_RATE_LIMITER');
export const COLD_START_DAMPENING = Symbol('COLD_START_DAMPENING');
```

### Module Declaration

```typescript
// src/planning/planning.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { EventsModule } from '../events/events.module';
import { PlanningService } from './planning.service';
import { PlanningPipelineService } from './pipeline/planning-pipeline.service';
import { OpportunityQueueService } from './intake/opportunity-queue.service';
import { OpportunityResearchService } from './research/opportunity-research.service';
import { OutcomeSimulatorService } from './simulation/outcome-simulator.service';
import { PlanProposalService } from './proposal/plan-proposal.service';
import { ConstraintValidationService } from './validation/constraint-validation.service';
import { ProcedureCreationService } from './procedure-creation/procedure-creation.service';
import { PlanEvaluationService } from './post-execution/plan-evaluation.service';
import { PlanningRateLimiter } from './rate-limiting/planning-rate-limiter.service';
import { ColdStartDampening } from './rate-limiting/cold-start-dampening.service';

// Constraint checkers
import { SafetyConstraintsChecker } from './validation/constraint-checkers/safety-constraints.checker';
import { FeasibilityConstraintsChecker } from './validation/constraint-checkers/feasibility-constraints.checker';
import { CoherenceConstraintsChecker } from './validation/constraint-checkers/coherence-constraints.checker';
import { ImmutableStandardsChecker } from './validation/constraint-checkers/immutable-standards.checker';

// Supporting services
import { EventPatternAnalyzer } from './research/event-pattern-analyzer.service';
import { CandidateGenerator } from './simulation/candidate-generator.service';
import { DriveEffectPredictor } from './simulation/drive-effect-predictor.service';
import { SuccessEstimator } from './simulation/success-estimator.service';
import { InformationGainEstimator } from './simulation/information-gain-estimator.service';

import {
  PLANNING_SERVICE,
  PLANNING_PIPELINE_SERVICE,
  OPPORTUNITY_QUEUE_SERVICE,
  OPPORTUNITY_RESEARCH_SERVICE,
  OUTCOME_SIMULATOR_SERVICE,
  PLAN_PROPOSAL_SERVICE,
  CONSTRAINT_VALIDATION_SERVICE,
  PROCEDURE_CREATION_SERVICE,
  PLAN_EVALUATION_SERVICE,
  PLANNING_RATE_LIMITER,
  COLD_START_DAMPENING,
} from './planning.tokens';

@Module({
  imports: [
    ConfigModule,
    KnowledgeModule,    // upsertNode, findNode, queryEdges
    EventsModule,       // query patterns, record planning events
  ],
  providers: [
    // Main service
    {
      provide: PLANNING_SERVICE,
      useClass: PlanningService,
    },

    // Pipeline and supporting services
    {
      provide: PLANNING_PIPELINE_SERVICE,
      useClass: PlanningPipelineService,
    },
    {
      provide: OPPORTUNITY_QUEUE_SERVICE,
      useClass: OpportunityQueueService,
    },
    {
      provide: OPPORTUNITY_RESEARCH_SERVICE,
      useClass: OpportunityResearchService,
    },
    {
      provide: OUTCOME_SIMULATOR_SERVICE,
      useClass: OutcomeSimulatorService,
    },
    {
      provide: PLAN_PROPOSAL_SERVICE,
      useClass: PlanProposalService,
    },
    {
      provide: CONSTRAINT_VALIDATION_SERVICE,
      useClass: ConstraintValidationService,
    },
    {
      provide: PROCEDURE_CREATION_SERVICE,
      useClass: ProcedureCreationService,
    },
    {
      provide: PLAN_EVALUATION_SERVICE,
      useClass: PlanEvaluationService,
    },

    // Infrastructure
    {
      provide: PLANNING_RATE_LIMITER,
      useClass: PlanningRateLimiter,
    },
    {
      provide: COLD_START_DAMPENING,
      useClass: ColdStartDampening,
    },

    // Constraint checkers
    SafetyConstraintsChecker,
    FeasibilityConstraintsChecker,
    CoherenceConstraintsChecker,
    ImmutableStandardsChecker,

    // Supporting services
    EventPatternAnalyzer,
    CandidateGenerator,
    DriveEffectPredictor,
    SuccessEstimator,
    InformationGainEstimator,
  ],
  exports: [PLANNING_SERVICE],  // Only the main service is public
})
export class PlanningModule {}
```

### Service Constructor Injection Pattern

```typescript
// Example: PlanningService

import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PLANNING_PIPELINE_SERVICE, OPPORTUNITY_QUEUE_SERVICE, PLANNING_RATE_LIMITER, COLD_START_DAMPENING } from './planning.tokens';
import { DRIVE_STATE_READER } from '../drive-engine/drive-engine.tokens';
import { EVENTS_SERVICE } from '../events/events.tokens';

@Injectable()
export class PlanningService implements IPlanningService {
  private readonly logger = new Logger(PlanningService.name);
  private totalDecisionsProcessed: number = 0;  // For cold-start dampening
  private queueProcessingActive: boolean = false;

  constructor(
    @Inject(PLANNING_PIPELINE_SERVICE)
    private readonly pipeline: IPlanningPipelineService,

    @Inject(OPPORTUNITY_QUEUE_SERVICE)
    private readonly queue: IOpportunityQueueService,

    @Inject(PLANNING_RATE_LIMITER)
    private readonly rateLimiter: IPlanningRateLimiter,

    @Inject(COLD_START_DAMPENING)
    private readonly coldStartDampening: IColdStartDampening,

    @Inject(DRIVE_STATE_READER)
    private readonly driveState: IDriveStateReader,

    @Inject(EVENTS_SERVICE)
    private readonly events: IEventsService,

    private readonly config: ConfigService<PlanningConfig>,
  ) {}

  // Implementation follows...
}
```

---

## 4. Cross-Module Dependencies

### Import Graph

```
PlanningModule
├── imports:
│   ├── ConfigModule
│   │   └── provides: ConfigService<AppConfig>
│   │
│   ├── EventsModule (shared store)
│   │   ├── exports: EVENTS_SERVICE (IEventsService)
│   │   └── usage:
│   │       - queryLearnableEvents: research stage
│   │       - queryEventFrequency: pattern analysis
│   │       - queryEventPattern: opportunity investigation
│   │       - record: logging all planning events (OPPORTUNITY_INTAKE, PLAN_CREATED, PLAN_FAILURE, etc.)
│   │
│   ├── KnowledgeModule (shared store)
│   │   ├── exports: WKG_SERVICE, SELF_KG_SERVICE, CONFIDENCE_SERVICE
│   │   └── usage:
│   │       - upsertNode: create procedure nodes
│   │       - findNode: query context entities
│   │       - queryEdges: find similar actions for simulation
│   │       - recordRetrievalAndUse: track procedure access (for ACT-R)
│   │
│   └── (implicit) DriveEngineModule (read-only)
│       ├── exports: DRIVE_STATE_READER
│       └── usage:
│           - getCurrentState: used in outcome simulation for drive context
│           - driveState$ Observable: subscribe to current drive state
│
├── does NOT import:
│   ├── DecisionMakingModule (boundary violation if imported)
│   ├── LearningModule (indirect interaction only)
│   ├── CommunicationModule (indirect interaction only)
│
└── exports:
    └── PLANNING_SERVICE (IPlanningService) — only public API
```

### Event Communication Patterns

**Events Planning Module Emits (to TimescaleDB):**
- `OPPORTUNITY_INTAKE` — Opportunity received and enqueued
- `OPPORTUNITY_DROPPED` — Opportunity dropped due to queue full
- `PLANNING_RATE_LIMITED` — Rate limit exceeded
- `RESEARCH_COMPLETE` — Research stage completed
- `SIMULATION_COMPLETE` — Simulation stage completed
- `PROPOSAL_GENERATED` — Proposal candidates generated
- `PLAN_VALIDATION_START` — Constraint validation beginning
- `PLAN_VALIDATION_FAILED` — Proposal failed constraint check
- `PLAN_CREATED` — Procedure successfully created in WKG
- `PLAN_EVALUATION` — Plan execution evaluated
- `PLAN_FAILURE` — Plan execution produced poor outcome
- `PLANNING_COST` — LLM call costs (proposal + validation tokens)

**Events Planning Module Consumes (from TimescaleDB):**
- Prediction failure events (from Decision Making) — fed to Drive Engine for Opportunity detection
- No direct event consumption. Queue processing is pull-based (dequeue via IOpportunityQueueService).

**One-Way Dependency:**
- Drive Engine -> Planning: Opportunities are events; Planning reads them from TimescaleDB (pub-sub via events)
- Planning -> Decision Making: Created procedures appear in WKG; Decision Making queries them

---

## 5. Configuration Schema

### PlanningConfig Type

```typescript
// src/planning/config/planning.config.ts

import { IsNumber, IsBoolean, Min, Max } from 'class-validator';

export class PlanningConfig {
  /**
   * Opportunity priority queue maximum size.
   * When queue reaches this size and a new item arrives, the lowest-priority
   * item is dropped.
   * Default: 50
   */
  @IsNumber()
  @Min(10)
  @Max(200)
  maxQueueSize: number = 50;

  /**
   * Exponential decay rate for queued Opportunities (per hour).
   * priority(t) = priority(0) * (1 - decayRate) ^ (hours)
   * Default: 0.10 (10% per hour)
   */
  @IsNumber()
  @Min(0.01)
  @Max(0.99)
  opportunityDecayRatePerHour: number = 0.10;

  /**
   * Maximum plans that can be created per time window.
   * Default: 3 (per hour)
   */
  @IsNumber()
  @Min(1)
  @Max(20)
  maxPlansPerWindow: number = 3;

  /**
   * Time window for plan creation rate limiting (milliseconds).
   * Default: 3600000 (1 hour)
   */
  @IsNumber()
  @Min(60000)
  @Max(86400000)
  planningWindowDuration: number = 3600000;

  /**
   * Maximum active plans awaiting evaluation.
   * If this limit is reached, no new plans are created until some execute and are evaluated.
   * Default: 10
   */
  @IsNumber()
  @Min(1)
  @Max(50)
  maxActivePlans: number = 10;

  /**
   * Maximum LLM tokens per plan (proposal + validation).
   * Default: 4000
   */
  @IsNumber()
  @Min(500)
  @Max(8000)
  maxTokensPerPlan: number = 4000;

  /**
   * Cold-start threshold: decision count at which dampening reaches zero.
   * For decisions 0 to N, Opportunity weight is reduced.
   * For decisions > N, full priority is used.
   * Default: 100
   */
  @IsNumber()
  @Min(10)
  @Max(1000)
  coldStartThreshold: number = 100;

  /**
   * Maximum dampening factor in cold-start phase.
   * At decision 0, dampening = maxColdStartDampening.
   * At decision coldStartThreshold, dampening = 0.
   * Default: 0.8 (80% reduction in early phase)
   */
  @IsNumber()
  @Min(0.1)
  @Max(0.9)
  maxColdStartDampening: number = 0.8;

  /**
   * Minimum evidence strength required to proceed with research.
   * ResearchService.hasSufficientEvidence check.
   * Default: 0.4 (40% strength)
   */
  @IsNumber()
  @Min(0.0)
  @Max(1.0)
  minEvidenceStrength: number = 0.4;

  /**
   * Minimum expected value required for a simulated outcome to be "viable".
   * SimulationResult.hasViableOutcome check.
   * Default: 0.3
   */
  @IsNumber()
  @Min(0.0)
  @Max(1.0)
  minViableExpectedValue: number = 0.3;

  /**
   * Maximum number of candidate actions to simulate per opportunity.
   * Default: 5
   */
  @IsNumber()
  @Min(1)
  @Max(20)
  maxCandidateActionsToSimulate: number = 5;

  /**
   * Maximum number of proposals to generate per research result.
   * Default: 3
   */
  @IsNumber()
  @Min(1)
  @Max(10)
  maxProposalsToGenerate: number = 3;

  /**
   * Maximum number of times a proposal can be revised based on validation feedback.
   * After this many revisions, if still failing validation, the proposal is abandoned.
   * Default: 2
   */
  @IsNumber()
  @Min(1)
  @Max(5)
  maxProposalRevisions: number = 2;

  /**
   * Polling interval for the queue processing loop (milliseconds).
   * How often the planning service checks for queued Opportunities to process.
   * Default: 100ms
   */
  @IsNumber()
  @Min(10)
  @Max(5000)
  queueProcessingIntervalMs: number = 100;

  /**
   * Maximum time to wait for in-flight pipelines to complete during shutdown (milliseconds).
   * Default: 30000 (30 seconds)
   */
  @IsNumber()
  @Min(1000)
  @Max(300000)
  shutdownTimeoutMs: number = 30000;

  /**
   * Enable planning subsystem.
   * If false, all planning operations return early (no-op).
   * Default: true
   */
  @IsBoolean()
  enabled: boolean = true;

  /**
   * Time window for event pattern queries (e.g., '7d' for last 7 days).
   * Passed to EventsModule.queryPattern.
   * Default: '7d'
   */
  eventPatternTimeWindow: string = '7d';

  /**
   * Maximum number of events to analyze per research phase.
   * Prevents unbounded query results.
   * Default: 1000
   */
  @IsNumber()
  @Min(10)
  @Max(10000)
  maxEventsToAnalyzePerResearch: number = 1000;
}
```

### Integration in AppConfig

```typescript
// src/shared/config/app.config.ts (existing, extend)

export class AppConfig {
  @IsBoolean()
  debug: boolean = false;

  neo4j: Neo4jConfig;
  timescale: TimescaleConfig;
  llm: LlmConfig;
  planning: PlanningConfig;  // NEW
}
```

---

## 6. Error Handling

### Exception Hierarchy

```typescript
// src/planning/exceptions/planning.exceptions.ts

import { SylphieException } from '../../shared/exceptions/sylphie.exception';

/**
 * Base exception for all Planning subsystem errors.
 */
export class PlanningException extends SylphieException {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
    this.name = 'PlanningException';
  }
}

/**
 * Opportunity intake stage errors.
 */
export class OpportunityIntakeException extends PlanningException {}

export class InvalidOpportunityError extends OpportunityIntakeException {
  constructor(opportunityId: string, reason: string) {
    super(`Invalid opportunity: ${opportunityId} (${reason})`, {
      opportunityId,
      reason,
    });
  }
}

export class QueueFullError extends OpportunityIntakeException {
  constructor(maxSize: number, droppedId: string) {
    super(`Opportunity queue full (max ${maxSize}). Dropped: ${droppedId}`, {
      maxSize,
      droppedId,
    });
  }
}

/**
 * Research stage errors.
 */
export class ResearchException extends PlanningException {}

export class InsufficientEvidenceError extends ResearchException {
  constructor(opportunityId: string, evidenceStrength: number, required: number) {
    super(
      `Insufficient evidence for opportunity ${opportunityId}: ${evidenceStrength.toFixed(2)} < ${required.toFixed(2)}`,
      { opportunityId, evidenceStrength, required },
    );
  }
}

export class EventQueryFailedError extends ResearchException {
  constructor(fingerprint: string, cause: Error) {
    super(`Failed to query events for context ${fingerprint}`, {
      fingerprint,
      originalError: cause.message,
    });
  }
}

/**
 * Simulation stage errors.
 */
export class SimulationException extends PlanningException {}

export class NoViableOutcomeError extends SimulationException {
  constructor(opportunityId: string, bestExpectedValue: number) {
    super(
      `No viable outcome found for opportunity ${opportunityId}: best expected value ${bestExpectedValue.toFixed(2)} < threshold`,
      { opportunityId, bestExpectedValue },
    );
  }
}

/**
 * Proposal stage errors.
 */
export class ProposalException extends PlanningException {}

export class ProposalGenerationFailedError extends ProposalException {
  constructor(reason: string, cause?: Error) {
    super(`Failed to generate proposals: ${reason}`, {
      originalError: cause?.message,
    });
  }
}

export class ProposalRevisionFailedError extends ProposalException {
  constructor(proposalId: string, maxRevisions: number) {
    super(
      `Proposal ${proposalId} failed validation after ${maxRevisions} revisions. Abandoned.`,
      { proposalId, maxRevisions },
    );
  }
}

/**
 * Validation stage errors.
 */
export class ValidationException extends PlanningException {}

export class ConstraintViolationError extends ValidationException {
  constructor(constraint: string, proposal: string, reason: string) {
    super(`Proposal ${proposal} violates ${constraint}: ${reason}`, {
      constraint,
      proposal,
      reason,
    });
  }
}

export class ImmutableStandardViolationError extends ValidationException {
  constructor(standard: number, proposal: string, reason: string) {
    super(
      `Proposal ${proposal} violates Immutable Standard ${standard}: ${reason}`,
      { standard, proposal, reason },
    );
  }
}

export class LlmValidationFailedError extends ValidationException {
  constructor(reason: string, cause?: Error) {
    super(`LLM constraint validation failed: ${reason}`, {
      originalError: cause?.message,
    });
  }
}

/**
 * Procedure creation errors.
 */
export class ProcedureCreationException extends PlanningException {}

export class ProcedureNodeCreationFailedError extends ProcedureCreationException {
  constructor(proposalId: string, cause: Error) {
    super(`Failed to create procedure node for proposal ${proposalId}`, {
      proposalId,
      originalError: cause.message,
    });
  }
}

export class ProcedureEdgeCreationFailedError extends ProcedureCreationException {
  constructor(procedureId: string, edgeType: string, cause: Error) {
    super(`Failed to create ${edgeType} edge for procedure ${procedureId}`, {
      procedureId,
      edgeType,
      originalError: cause.message,
    });
  }
}

/**
 * Plan evaluation errors.
 */
export class PlanEvaluationException extends PlanningException {}

export class ProcedureNotFoundError extends PlanEvaluationException {
  constructor(procedureId: string) {
    super(`Procedure not found: ${procedureId}`, { procedureId });
  }
}

/**
 * Rate limiting errors (informational, not exceptional).
 */
export class RateLimitExceededError extends PlanningException {
  constructor(limitType: 'plans_per_window' | 'active_plans' | 'tokens_per_plan') {
    super(`Rate limit exceeded: ${limitType}`, { limitType });
  }
}

/**
 * Cold-start dampening configuration errors.
 */
export class ColdStartConfigError extends PlanningException {
  constructor(reason: string) {
    super(`Cold-start dampening configuration error: ${reason}`, { reason });
  }
}
```

### Error Handling in Services

```typescript
// Example: OpportunityResearchService error handling

async research(opportunity: Opportunity): Promise<ResearchResult> {
  try {
    // Research logic
  } catch (error) {
    if (error instanceof EventQueryFailedError) {
      this.logger.error(`Research failed: event query error`, { error, opportunity });
      throw error;  // Re-throw to caller
    }

    if (error instanceof QueryError) {  // From EventsModule
      throw new ResearchException(
        `Failed to query events for opportunity ${opportunity.id}`,
        {
          opportunityId: opportunity.id,
          originalError: error.message,
        },
      );
    }

    // Unexpected error -- wrap and re-throw
    throw new ResearchException(
      `Unexpected error during research phase`,
      {
        opportunityId: opportunity.id,
        originalError: (error as Error).message,
      },
    );
  }
}
```

---

## 7. Async Patterns

### Pipeline Concurrency Model

```
Opportunities are processed asynchronously but independently.

Timeline:
  Time 0: Opportunity A enqueued -> Research begins -> processing active
  Time 50ms: Opportunity B enqueued -> queued (waiting for processing slot)
  Time 150ms: Opp A reaches Validate stage -> Research returns
  Time 200ms: Opp B Research begins -> Opp A Validate ongoing
  Time 300ms: Opp A procedure created -> Opp B Research ongoing
  Time 400ms: Opp B Validate begins
  ...

Key properties:
1. Queue processing is sequential (one Opportunity at a time through pipeline stages)
2. But each Opportunity can be in any pipeline stage independently
3. The queue-dequeue loop is non-blocking (async with interval polling)
4. LLM calls (proposal + validation) are awaited (blocking, but reported to Drive Engine as cost)
5. WKG writes are awaited (can block if DB is slow, but essential for ACID)
6. EventsModule writes are fire-and-forget (async, not awaited)
```

### RxJS Integration

```typescript
// The Planning subsystem does NOT use RxJS for its core pipeline.
// RxJS is used only where Drive Engine or shared infrastructure uses it.

// Optional: Planning could subscribe to Opportunity events as a Subject
// This is an implementation detail, not required by the interface.

// Example (if implemented):
@Injectable()
export class PlanningService implements IPlanningService, OnModuleInit {
  private opportunities$ = new Subject<Opportunity>();

  onModuleInit(): void {
    // Subscribe to Opportunity events from Drive Engine (via EventsModule or direct pub-sub)
    this.opportunities$
      .pipe(
        filter(opp => this.rateLimiter.canProceed()),
        map(opp => ({
          opp,
          dampening: this.coldStartDampening.compute(this.totalDecisions),
        })),
      )
      .subscribe(({ opp, dampening }) => {
        this.queue.enqueue(opp, dampening).catch(error => {
          this.logger.error('Failed to enqueue opportunity', { error, opp });
        });
      });
  }
}
```

### Lifecycle Hooks

```typescript
// src/planning/planning.service.ts

@Injectable()
export class PlanningService implements IPlanningService, OnModuleInit, OnModuleDestroy {
  constructor(
    // ... dependencies
  ) {}

  /**
   * Called when PlanningModule initializes.
   * Starts the queue processing loop.
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Planning subsystem initializing...');

    // Start the queue processing loop (fire-and-forget)
    this.startQueueProcessingLoop().catch(error => {
      this.logger.error('Queue processing loop crashed', { error });
    });

    this.logger.log('Planning subsystem ready');
  }

  /**
   * Called when NestJS app shuts down.
   * Waits for in-flight processing to complete.
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('Planning subsystem shutting down...');

    await this.shutdown();

    this.logger.log('Planning subsystem shut down');
  }

  /**
   * The queue processing loop.
   * Runs in the background, polling for queued Opportunities.
   */
  private async startQueueProcessingLoop(): Promise<void> {
    this.queueProcessingActive = true;

    while (this.queueProcessingActive) {
      try {
        const opportunity = await this.queue.dequeue();

        if (opportunity) {
          // Process the Opportunity through the pipeline (await for completion)
          const result = await this.pipeline.processOpportunity(opportunity);

          // Log the result
          this.logger.debug(`Pipeline result: ${result.status}`, {
            opportunityId: opportunity.id,
            status: result.status,
          });
        }

        // Sleep for the configured interval before checking queue again
        await this.sleep(this.config.get('planning.queueProcessingIntervalMs'));
      } catch (error) {
        this.logger.error('Queue processing loop error (will continue)', { error });
        // Continue the loop -- do not crash
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

---

## 8. Type Safety

### Core Type Relationships

```typescript
// src/shared/types/planning.types.ts (to be added to shared)

/**
 * Opportunity: published by Drive Engine when prediction failures create
 * patterns that suggest a new behavioral procedure is needed.
 */
export interface Opportunity {
  readonly id: string;  // unique identifier
  readonly driveEngineEventId: string;  // link back to Drive Engine event
  readonly context: ContextFingerprint;  // what was the situation?
  readonly predictionFailurePattern: PredictionFailurePattern;  // what went wrong?
  readonly priority: number;  // 0.0-1.0, based on drive urgency
  readonly createdAt: Date;
}

/**
 * Context fingerprint: minimal representation of a situation.
 * Used to group similar events and match procedure triggers.
 */
export interface ContextFingerprint {
  readonly primaryEntity: string;  // e.g., 'Person_Jim' or 'Emotion_Confusion'
  readonly recentEvents: string[];  // last N event types
  readonly driveState: Partial<DriveVector>;  // simplified drive snapshot
  readonly hash: string;  // deterministic hash of above (for grouping)
}

/**
 * Predicted outcome: what the system expected to happen.
 */
export interface PredictedOutcome {
  readonly driveEffects: Partial<DriveVector>;
  readonly behaviors: string[];
  readonly contexts: ContextFingerprint[];
}

/**
 * Action: represents a single step in a procedure or a candidate for simulation.
 */
export interface Action {
  readonly type: 'speak' | 'ask' | 'execute' | 'reflect' | 'explore' | 'reflex';
  readonly target?: string;  // e.g., 'guardian', 'environment', 'self'
  readonly parameters: Record<string, unknown>;
}

/**
 * Procedure: a sequence of actions and conditions, stored in WKG as an Action node.
 */
export interface Procedure {
  readonly id: string;  // WKG node ID
  readonly name: string;
  readonly triggerContext: ContextFingerprint;
  readonly actionSequence: ActionStep[];
  readonly expectedOutcome: PredictedOutcome;
  readonly abortConditions: AbortCondition[];
  readonly confidence: number;  // ACT-R confidence (0.0-1.0)
  readonly provenance: 'LLM_GENERATED';
  readonly retrievalCount: number;
  readonly lastRetrievalTime: Date | null;
  readonly lastMAE: number | null;
}
```

### Type Guards

```typescript
// src/planning/types/type-guards.ts

export function isOpportunity(value: unknown): value is Opportunity {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'context' in value &&
    'predictionFailurePattern' in value &&
    typeof (value as { id: unknown }).id === 'string'
  );
}

export function isContextFingerprint(value: unknown): value is ContextFingerprint {
  return (
    typeof value === 'object' &&
    value !== null &&
    'primaryEntity' in value &&
    'hash' in value &&
    typeof (value as { hash: unknown }).hash === 'string'
  );
}

export function isPlanProposal(value: unknown): value is PlanProposal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'procedure' in value &&
    'evidenceStrength' in value
  );
}

export function isValidationResult(value: unknown): value is ValidationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'passes' in value &&
    typeof (value as { passes: unknown }).passes === 'boolean'
  );
}
```

### Avoiding `any`

```typescript
// Pattern: Use unknown at boundaries, then narrow

async function processUnknownInput(input: unknown): Promise<Opportunity> {
  if (!isOpportunity(input)) {
    throw new InvalidOpportunityError(
      String((input as Record<string, unknown>).id ?? 'unknown'),
      'Input did not match Opportunity shape',
    );
  }
  // Now TypeScript knows input is Opportunity
  return input;
}

// Pattern: Generic constraints for type-safe arrays

function processResults<T extends PlanningResult>(results: T[]): T[] {
  return results.filter(r => r.status !== 'RATE_LIMITED');
}

// Pattern: Discriminated unions for result types (already done above)
```

---

## 9. Ticket Breakdown Recommendation

The Epic 8 implementation should be decomposed into sequential tickets (sprints) with clear dependencies and testability criteria.

### Ticket Ordering

**Phase A: Scaffolding & Configuration (Prerequisite)**

| Ticket | Title | Complexity | Dependencies | Purpose |
|--------|-------|-----------|---|---------|
| **E8-T001** | Define Planning interfaces and types | S | E0 | Create all interface contracts, type definitions, injection tokens |
| **E8-T002** | Wire PlanningModule with DI | S | E8-T001 | Create planning.module.ts, all providers, verify compilation |

**Phase B: Core Infrastructure (Foundation)**

| Ticket | Title | Complexity | Dependencies | Purpose |
|--------|-------|-----------|---|---------|
| **E8-T003** | Implement OpportunityQueueService | M | E8-T002 | Queue with decay, max size enforcement, enqueue/dequeue |
| **E8-T004** | Implement PlanningRateLimiter | M | E8-T002 | Plan creation limits, active plan limits, token budgets |
| **E8-T005** | Implement ColdStartDampening | S | E8-T002 | Compute function, configuration, integration point |
| **E8-T006** | Implement PlanningService main orchestrator | M | E8-T002, E8-T003, E8-T004, E8-T005 | Main entry point, queue loop, lifecycle hooks |

**Phase C: Research & Analysis (Information Gathering)**

| Ticket | Title | Complexity | Dependencies | Purpose |
|--------|-------|-----------|---|---------|
| **E8-T007** | Implement OpportunityResearchService | M | E8-T002, E2 (Events) | Query patterns, evidence assessment, discrepancy analysis |
| **E8-T008** | Implement EventPatternAnalyzer helper | S | E8-T007 | Supporting service for pattern extraction |

**Phase D: Simulation (Outcome Modeling)**

| Ticket | Title | Complexity | Dependencies | Purpose |
|--------|-------|-----------|---|---------|
| **E8-T009** | Implement OutcomeSimulator | L | E8-T002, E3 (Knowledge) | Generate candidates, predict effects, compute expected value |
| **E8-T010** | Implement simulation helper services | M | E8-T009 | CandidateGenerator, DriveEffectPredictor, SuccessEstimator, InformationGainEstimator |

**Phase E: Proposal & Validation (Plan Generation)**

| Ticket | Title | Complexity | Dependencies | Purpose |
|--------|-------|-----------|---|---------|
| **E8-T011** | Implement PlanProposalService | M | E8-T002 | Generate proposals from research/simulations, revision logic |
| **E8-T012** | Implement ConstraintValidationService | L | E8-T002, E6 (Communication for LLM) | Validate proposals against all constraints |
| **E8-T013** | Implement constraint checker classes | M | E8-T012 | Safety, Feasibility, Coherence, ImmutableStandards checkers |

**Phase F: Execution (Procedure Creation & Evaluation)**

| Ticket | Title | Complexity | Dependencies | Purpose |
|--------|-------|-----------|---|---------|
| **E8-T014** | Implement ProcedureCreationService | M | E8-T002, E3 (Knowledge) | Write procedures to WKG with provenance/confidence |
| **E8-T015** | Implement PlanEvaluationService | M | E8-T002, E3 (Knowledge) | Post-execution evaluation, confidence updates, ACT-R |

**Phase G: Pipeline Integration (Orchestration)**

| Ticket | Title | Complexity | Dependencies | Purpose |
|--------|-------|-----------|---|---------|
| **E8-T016** | Implement PlanningPipelineService | M | E8-T002, E8-T007 through E8-T015 | Coordinate all stages, error handling, logging |

**Phase H: End-to-End Testing & Documentation**

| Ticket | Title | Complexity | Dependencies | Purpose |
|--------|-------|-----------|---|---------|
| **E8-T017** | Integration tests: cold start dampening | S | E8-T001 through E8-T016 | Verify cold-start behavior, no Planning Runaway |
| **E8-T018** | Integration tests: full pipeline | M | E8-T001 through E8-T016 | End-to-end: Opportunity -> Procedure |
| **E8-T019** | Integration tests: Prediction Pessimist prevention | M | E8-T001 through E8-T016 | Verify low-quality procedures are rejected/fade |
| **E8-T020** | Write session log & documentation update | S | E8-T001 through E8-T019 | Per CANON rules, document changes and gotchas |

### Per-Ticket Success Criteria

**E8-T001 (Interfaces & Types):**
- All interfaces defined with complete JSDoc
- All type definitions match Planner agent domain expertise
- All injection tokens defined and exported
- `npx tsc --noEmit` passes with zero errors

**E8-T002 (Module Wiring):**
- PlanningModule imports EventsModule, KnowledgeModule, ConfigModule
- All providers registered with correct tokens
- Module exports only PLANNING_SERVICE token
- No circular module dependencies
- `npx tsc --noEmit` passes

**E8-T003 (OpportunityQueueService):**
- Enqueue: accepts Opportunity, applies cold-start dampening, respects max size
- Dequeue: applies decay formula, returns highest-priority item or null
- getState: returns accurate queue metrics
- Unit tests: enqueue 100 items, apply decay, verify priority ordering

**E8-T004 (PlanningRateLimiter):**
- canProceed: checks all three limits (plans/window, active, tokens)
- recordPlanCreated: increments counters
- Window resets correctly after duration
- Unit tests: hit all three limits, verify reset behavior

**E8-T005 (ColdStartDampening):**
- compute: returns correct dampening factor per formula
- At decision 0: dampening = 0.8 (configurable)
- At decision threshold: dampening = 0.0
- Configuration integration verified

**E8-T006 (PlanningService):**
- processOpportunity: enqueues + returns immediately
- startQueueProcessingLoop: begins background processing
- getState: returns accurate state (queue size, rate limits, etc.)
- shutdown: waits for in-flight pipelines, emits PLANNING_SHUTDOWN event
- Integration test: 3 Opportunities enqueued, processed sequentially

**E8-T007 (OpportunityResearchService):**
- research: queries TimescaleDB via EventsModule
- Identifies failures (MAE > 0.15)
- Queries WKG for context
- Assesses evidence strength correctly
- Integration test: given prediction failures in TimescaleDB, produces ResearchResult

**E8-T008 (EventPatternAnalyzer):**
- Extracts event patterns from query results
- Computes average MAE
- Groups by context fingerprint
- Unit tests on mock event data

**E8-T009 (OutcomeSimulator):**
- Generates 3-5 candidate actions
- Predicts drive effects from similar WKG actions
- Estimates success probability from frequency
- Computes expected value correctly
- Integration test: given research result, produces SimulationResult with viable candidates

**E8-T010 (Simulation Helpers):**
- CandidateGenerator: creates 3-5 distinct Action candidates
- DriveEffectPredictor: queries WKG for similar actions, aggregates effects
- SuccessEstimator: computes probability from historical frequency
- InformationGainEstimator: estimates new knowledge value
- Unit tests on mock WKG data

**E8-T011 (PlanProposalService):**
- propose: generates 3 proposals from research + simulations
- Descriptions are human-readable and grounded in evidence
- Action sequences have dependencies and fallbacks
- revise: modifies proposal based on constraint feedback
- Integration test: proposals pass basic sanity checks

**E8-T012 (ConstraintValidationService):**
- validate: checks all constraint categories
- Returns ValidationResult with passes/failures
- Calls LLM via LLMService from CommunicationModule (read-only injection)
- All 6 Immutable Standards checked (ImmutableStandardsChecker)
- Integration test: valid proposal passes, invalid proposal fails with feedback

**E8-T013 (Constraint Checkers):**
- SafetyConstraintsChecker: detects unsupported emotional expressions, harmful actions
- FeasibilityConstraintsChecker: checks dependency feasibility, complexity
- CoherenceConstraintsChecker: LLM check for logical coherence
- ImmutableStandardsChecker: validates all 6 standards (requires detailed understanding of each)
- Unit tests: valid/invalid proposals for each constraint

**E8-T014 (ProcedureCreationService):**
- create: writes Procedure node to WKG with:
  - provenance: 'LLM_GENERATED'
  - confidence: 0.35
  - All properties from proposal
- Creates TRIGGERED_BY and CAN_ACHIEVE edges
- Emits PLAN_CREATED event
- Integration test: proposal -> WKG node with correct properties

**E8-T015 (PlanEvaluationService):**
- evaluateExecution: computes MAE from expected vs actual drive effects
- Updates confidence using ACT-R formula
- Classifies outcome as success/partial/failure
- Emits PLAN_EVALUATION and (if failure) PLAN_FAILURE events
- Integration test: execution with known outcome -> updated confidence

**E8-T016 (PlanningPipelineService):**
- processOpportunity: orchestrates all 6 stages
- Returns appropriate PlanningResult for each outcome
- Handles errors gracefully, emits events for all paths
- Retry logic for proposal revisions (max 2)
- Integration test: full pipeline from Opportunity to Procedure

**E8-T017-E8-T020 (Testing & Docs):**
- Cold-start tests: verify dampening in early phase, then normal planning
- Full pipeline: Opportunity intake -> queue -> research -> sim -> proposal -> validate -> create
- Prediction Pessimist: low-quality procedures are rejected or fade due to low confidence
- Attractor state tests: verify Planning Runaway prevention (rate limits), Prediction Pessimist prevention (cold-start + confidence ceiling)
- Session log: document all changes, gotchas, wiring

---

## Summary

**FORGE ANALYSIS for Epic 8: Planning** provides:

1. **Complete module structure** with six pipeline stages and supporting infrastructure
2. **Full interface contracts** for all services with JSDoc explaining CANON principles
3. **DI wiring pattern** with tokens, module declaration, and constructor injection examples
4. **Cross-module dependencies** clearly mapped: Events and Knowledge are shared stores; Drive Engine is read-only
5. **Configuration schema** with validated class-validator configuration
6. **Exception hierarchy** for every failure mode with context preservation
7. **Async patterns** showing queue processing loop, lifecycle hooks, no RxJS coupling
8. **Type safety** with type guards, discriminated unions, no `any`
9. **Ticket breakdown** with 20 tickets, dependencies, and success criteria for E8-T001 through E8-T020

The architecture enforces CANON constraints through structure:
- **Rate limiting** prevents Planning Runaway
- **Cold-start dampening** prevents Prediction Pessimist
- **Provenance + confidence ceiling** ensure plans are tested, not trusted
- **Post-execution evaluation** feeds plan failures back to Drive Engine
- **All 6 Immutable Standards** enforced in constraint validation

Ready for implementation by Planner agent.

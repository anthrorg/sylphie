# Epic 8: Planning -- PLANNER ANALYSIS

**Agent:** Planner (Planning Subsystem Engineer)
**Date:** 2026-03-29
**Status:** Epic-level architectural analysis for Epic 8 (Opportunity-to-Procedure Pipeline)
**Reference:** CANON, Planner Agent Profile (`.claude/agents/planner.md`), Roadmap lines 329-370

---

## Executive Summary

Epic 8 implements the Planning subsystem -- the mechanism that converts detected Opportunities into new behavioral Procedures. This is the subsystem that gives Sylphie the ability to grow and adapt. It receives Opportunities from the Drive Engine (when predictions fail repeatedly), researches the failure patterns in TimescaleDB, simulates potential solutions, proposes plans, validates them against CANON constraints via the LLM, and creates new procedure nodes in the WKG.

**Core Principle:** Plans are hypotheses, not solutions. Every plan is tested through actual execution. Plans start at low confidence (0.35, LLM_GENERATED provenance) and must earn higher confidence through successful use or be demoted/dropped when they fail.

**Risk Profile:** Medium complexity, high integration surface. Core tension: new procedures start at 0.35 confidence (below the 0.50 retrieval threshold), which creates a gap for Decision Making to fill.

---

## 1. Pipeline Architecture

The Planning subsystem operates as a six-stage asynchronous pipeline. Multiple Opportunities can be at different stages simultaneously. Each stage can succeed, fail, be rate-limited, or require revision.

### 1.1 Stage-by-Stage Breakdown

#### Stage 1: INTAKE
**Input:** Opportunity event from Drive Engine
**Gate:** Rate limiting check (must be able to proceed before entering pipeline)
**Output:** Accepted Opportunity or RATE_LIMITED signal

- Receives Opportunity from Drive Engine via TimescaleDB event (published by Drive Engine, subscribed by Planning)
- Checks against PlanningRateLimiter (can we process this now without violating hourly/active plan limits?)
- Records OPPORTUNITY_INTAKE event to TimescaleDB
- If rate-limited, records PLANNING_RATE_LIMITED event and returns early
- If accepted, forwards to Research stage

**Key data from Opportunity:**
- `opportunityId`: Unique identifier
- `context`: ContextFingerprint containing entity IDs and predictor state
- `pattern`: Description of what failed (e.g., "prediction of user reaction was off by 0.25")
- `priority`: Initial priority value (decays over time in queue)
- `coldStartDampened`: Boolean indicating if cold-start dampening applies

#### Stage 2: RESEARCH
**Input:** Opportunity
**Gate:** Evidence sufficiency check
**Output:** ResearchResult or INSUFFICIENT_EVIDENCE signal

- Queries TimescaleDB for the event history pattern around this Opportunity's context fingerprint (7-day window, configurable)
- Retrieves all events matching the context, filters for prediction accuracy measurements
- Identifies prediction failures (MAE > 0.15) in the matching events
- Computes discrepancies: what was expected vs. what actually happened
- Queries WKG for relevant knowledge nodes connected to this context
- Queries TimescaleDB for prior plan attempts on this same context fingerprint
- Computes evidence strength score (0.0 to 1.0):
  - More failures = stronger evidence (+up to 0.40)
  - Consistent discrepancy pattern = stronger evidence (+up to 0.30)
  - No prior attempts = fresh opportunity (+0.20)
  - Failed prior attempts = evidence of need for new approach (+up to 0.30)
- Gate: `hasSufficientEvidence` must be true (failures >= 2 AND some discrepancy MAE > 0.15)
- Records OPPORTUNITY_RESEARCH event with evidence strength
- Returns ResearchResult or INSUFFICIENT_EVIDENCE

**ResearchResult structure:**
- Opportunity reference
- Event pattern (all matching events, with timestamps)
- List of failures (events with prediction MAE > 0.15)
- Discrepancies (expected vs. actual, with MAE for each)
- Relevant knowledge from WKG (nodes connected to context)
- Prior plan attempts (what has been tried before for this context)
- Evidence strength score (0.0-1.0)
- hasSufficientEvidence boolean

#### Stage 3: SIMULATE
**Input:** ResearchResult
**Gate:** Viability gate (at least one simulated outcome with expected value > 0.3)
**Output:** SimulationResult or NO_VIABLE_OUTCOME signal

- Gets current drive state snapshot from Drive Engine (read-only)
- Generates candidate actions based on research discrepancies (e.g., "if user expected friendly response but got technical, try more personal tone")
- For each candidate action:
  - Predicts drive effects using WKG knowledge of similar past actions (uses `averageDriveEffects` properties on action nodes)
  - Estimates success probability by pattern matching to similar historical actions
  - Estimates information gain (how much new knowledge would this action produce?)
  - Computes expected value combining all three factors
- Sorts candidates by expected value
- Gate: `hasViableOutcome` = at least one candidate with expected value > 0.3
- Records OPPORTUNITY_SIMULATION event with all simulation outcomes
- Returns SimulationResult or NO_VIABLE_OUTCOME

**SimulationResult structure:**
- All simulated outcomes (ordered by expected value)
- hasViableOutcome boolean
- bestCandidate: the highest-expected-value simulation

#### Stage 4: PROPOSE
**Input:** ResearchResult, SimulationResult
**Gate:** None (proposes multiple candidates, validation gates them)
**Output:** PlanProposal[] (one or more candidates)

- For each viable simulated outcome, generates concrete plan proposals
- LLM-assisted proposal generation (calls Claude to synthesize action sequence)
- Generates multiple proposals per simulation (e.g., "approach this by being friendlier" could mean "ask open-ended questions" or "use informal language" -- generate both)
- Each proposal includes:
  - Description of the plan
  - Trigger context fingerprint (when should this fire)
  - Action sequence (ordered steps with dependencies and fallback actions)
  - Expected outcome (predicted drive effects and external effects)
  - Abort conditions (when to abandon the plan mid-execution)
  - Evidence strength score (inherited from research)
  - Simulated expected value (inherited from simulation)
  - Complexity score (number of steps, dependencies)
- Records PLAN_PROPOSALS_GENERATED event
- Returns PlanProposal[]

**PlanProposal structure:**
```typescript
interface PlanProposal {
  id: string;
  opportunityId: string;
  description: string;

  procedure: {
    name: string;
    triggerContext: ContextFingerprint;
    actionSequence: ActionStep[];
    expectedOutcome: PredictedOutcome;
    abortConditions: AbortCondition[];
  };

  evidenceStrength: number;
  simulatedExpectedValue: number;
  complexity: number;
}

interface ActionStep {
  order: number;
  action: Action;
  expectedDuration: number;  // milliseconds
  dependsOn?: number;        // previous step order
  fallback?: Action;         // what if this step fails
}
```

#### Stage 5: VALIDATE
**Input:** PlanProposal
**Gate:** Constraint validation (must pass all checks)
**Output:** ValidationResult with passes=true OR revision feedback

- For each proposal:
  - Runs synchronous constraint checks (safety, feasibility)
  - Calls LLM constraint engine to check coherence and Immutable Standards compliance
  - Checks all six Immutable Standards:
    1. **Theater Prohibition:** Does the plan involve expressing emotions without drive support?
    2. **Contingency Requirement:** Does every reinforcement in the plan trace to a specific behavior?
    3. **Confidence Ceiling:** Does it assume knowledge > 0.60 without retrieval-and-use?
    4. **Shrug Imperative:** Does it have a "do nothing" option when uncertain?
    5. **Guardian Asymmetry:** Does it respect that guardian feedback outweighs algorithm? (Cannot bypass guardian overrides)
    6. **No Self-Modification:** Does it attempt to modify how success is measured?
  - Extracts suggested revisions from constraint failures
  - Records PLAN_VALIDATED event (success or with failures)

**ValidationResult structure:**
- passes: boolean
- if passes = true:
  - checkedConstraints: all constraint check results
- if passes = false:
  - failures: which constraints failed and why
  - checkedConstraints: all results
  - suggestedRevisions: LLM-generated revision suggestions

#### Stage 6: CREATE
**Input:** ValidatedProposal (PlanProposal + ValidationResult where passes=true)
**Gate:** None (if we got here, it passed validation)
**Output:** CreatedProcedure (successfully written to WKG)

- Creates a Procedure node in the WKG:
  - Type: "Procedure"
  - Properties include the action sequence, expected outcome, trigger context, abort conditions
  - Provenance: "LLM_GENERATED" (constraint engine used LLM)
  - Base confidence: 0.35 (LLM_GENERATED base)
  - Metadata: evidence strength, simulated expected value, creation timestamp, created from opportunity ID
- Creates edges:
  - TRIGGERED_BY: Procedure -> primary context entity (when this context is active, this procedure is available)
  - Any other relevant edges based on the procedure's domain
- Records PLAN_CREATED event with procedure ID, confidence, opportunity ID
- Returns CreatedProcedure (ID, confidence, status='AWAITING_FIRST_USE')
- Rate limiter increments: records this plan creation for hourly limit tracking

### 1.2 Asynchrony and Concurrency

- INTAKE -> RESEARCH -> SIMULATE -> PROPOSE can execute serially for one opportunity
- VALIDATE runs on each proposal from PROPOSE (can parallelize across proposals)
- CREATE runs synchronously after successful validation (one write at a time to WKG)
- Multiple opportunities can be at different stages simultaneously:
  - Opp1 at VALIDATE stage
  - Opp2 at RESEARCH stage
  - Opp3 at PROPOSE stage
- No strict ordering -- the pipeline respects gates but doesn't block other opportunities

### 1.3 Failure Paths and Revision Loops

**Insufficient Evidence path:**
- Research returns `hasSufficientEvidence = false`
- Planning records OPPORTUNITY_INSUFFICIENT_EVIDENCE event
- Opportunity stays in queue, priority decays
- On next dequeue cycle (or if more failures for this context occur and opportunity re-enters queue), it may be retried

**No Viable Outcome path:**
- Simulation returns `hasViableOutcome = false`
- Planning records OPPORTUNITY_NO_VIABLE_OUTCOME event
- Opportunity is considered "not planning-addressable" -- the issue is not something Planning can solve through behavioral change
- Opportunity dropped from queue (or very low priority)

**Validation Failure path:**
- Proposal fails one or more constraints
- Planning extracts suggested revisions from validation result
- **Proposal Revision Loop:** Can attempt up to 2 revisions
  - Pass validation result back to proposer
  - Proposer LLM generates revised plan based on feedback
  - Validator runs again on revised plan
  - If passes, proceeds to CREATE
  - If still fails after max revisions, proposal is dropped
- Records PLAN_VALIDATION_FAILED event
- Moves to next proposal (if any)
- If all proposals fail validation, opportunity is dropped (or stays in queue for future retry)

---

## 2. Interface Design

All interfaces live in the E0 skeleton module. Planning module imports and implements them.

### 2.1 Core Service Interfaces

#### IPlanningService (Main Pipeline Coordinator)

```typescript
interface IPlanningService {
  // Main entry point: receive opportunity, drive through pipeline
  processOpportunity(opportunity: Opportunity): Promise<PlanningResult>;

  // Dequeue highest-priority opportunity from queue
  dequeueNextOpportunity(): Promise<Opportunity | null>;

  // Check current queue status (for monitoring)
  getQueueStatus(): QueueStatus;

  // Manually add opportunity (for testing, or for Drive Engine's direct calls)
  queueOpportunity(opportunity: Opportunity): void;
}

interface PlanningResult {
  status: 'CREATED' | 'RATE_LIMITED' | 'INSUFFICIENT_EVIDENCE' |
          'NO_VIABLE_OUTCOME' | 'VALIDATION_FAILED';
  opportunity: Opportunity;
  research?: ResearchResult;
  simulations?: SimulationResult;
  proposals?: PlanProposal[];
  procedure?: CreatedProcedure;
  error?: string;
}
```

#### IOpportunityResearchService

```typescript
interface IOpportunityResearchService {
  // Research the opportunity pattern
  research(opportunity: Opportunity): Promise<ResearchResult>;

  // Compute evidence strength score
  computeEvidenceStrength(
    failures: PredictionFailure[],
    discrepancies: Discrepancy[],
    priorAttempts: PriorPlan[],
  ): number;

  // Check if research has sufficient evidence for planning
  hasSufficientEvidence(result: ResearchResult): boolean;
}

interface ResearchResult {
  opportunity: Opportunity;
  eventPattern: EventPattern;
  failures: PredictionFailure[];
  discrepancies: Discrepancy[];
  relevantKnowledge: WKGNode[];
  priorAttempts: PriorPlan[];
  hasSufficientEvidence: boolean;
  evidenceStrength: number;  // 0.0 to 1.0
}

interface Discrepancy {
  expected: any;         // what prediction said would happen
  actual: any;           // what actually happened
  mae: number;           // mean absolute error
  context: ContextData;
}

interface PriorPlan {
  contextFingerprint: string;
  procedureId: string;
  outcome: 'SUCCESS' | 'FAILED' | 'PARTIAL';
  timestamp: Date;
}
```

#### ISimulationService (Outcome Modeling)

```typescript
interface ISimulationService {
  // Simulate potential outcomes of candidate actions
  simulate(research: ResearchResult): Promise<SimulationResult>;

  // Generate candidate actions from research discrepancies
  generateCandidateActions(research: ResearchResult): CandidateAction[];

  // Predict drive effects using historical pattern matching
  predictDriveEffects(
    action: CandidateAction,
    currentDrives: DriveSnapshot,
    knowledge: WKGNode[],
  ): Partial<DriveSnapshot>;

  // Estimate success probability
  estimateSuccessProbability(
    action: CandidateAction,
    eventPattern: EventPattern,
  ): number;

  // Estimate information gain
  estimateInformationGain(
    action: CandidateAction,
    knowledge: WKGNode[],
  ): number;

  // Compute expected value
  computeExpectedValue(
    driveEffects: Partial<DriveSnapshot>,
    successProbability: number,
    informationGain: number,
  ): number;
}

interface SimulationResult {
  simulations: SimulatedOutcome[];
  hasViableOutcome: boolean;
  bestCandidate?: SimulatedOutcome;
}

interface SimulatedOutcome {
  action: CandidateAction;
  predictedDriveEffects: Partial<DriveSnapshot>;
  successProbability: number;
  informationGain: number;
  expectedValue: number;
}

interface CandidateAction {
  type: string;           // e.g., 'adjust_tone', 'ask_question', 'show_empathy'
  parameters: Record<string, any>;
  rationale: string;      // why this action might address the discrepancy
}
```

#### IPlanProposalService (Plan Synthesis)

```typescript
interface IPlanProposalService {
  // Generate plan proposals from research and simulation
  propose(
    research: ResearchResult,
    simulations: SimulationResult,
  ): Promise<PlanProposal[]>;

  // Revise a proposal based on validation feedback
  revise(
    proposal: PlanProposal,
    suggestedRevisions: string[],
  ): Promise<PlanProposal>;
}

interface PlanProposal {
  id: string;
  opportunityId: string;
  description: string;

  procedure: {
    name: string;
    triggerContext: ContextFingerprint;
    actionSequence: ActionStep[];
    expectedOutcome: PredictedOutcome;
    abortConditions: AbortCondition[];
  };

  evidenceStrength: number;
  simulatedExpectedValue: number;
  complexity: number;
}

interface ActionStep {
  order: number;
  action: Action;
  expectedDuration: number;
  dependsOn?: number;
  fallback?: Action;
}

interface AbortCondition {
  trigger: string;
  action: 'pause' | 'abort' | 'escalate';
  rationale: string;
}
```

#### IConstraintValidationService (LLM Validation Engine)

```typescript
interface IConstraintValidationService {
  // Validate proposal against all constraints
  validate(proposal: PlanProposal): Promise<ValidationResult>;

  // Check safety constraints (no harm to system or guardian)
  checkSafetyConstraints(proposal: PlanProposal): Promise<ConstraintCheckResult>;

  // Check feasibility constraints (can the action be executed?)
  checkFeasibilityConstraints(proposal: PlanProposal): Promise<ConstraintCheckResult>;

  // Check coherence (does the plan make logical sense?)
  checkCoherenceConstraints(proposal: PlanProposal): Promise<ConstraintCheckResult>;

  // Check all six Immutable Standards
  checkImmutableStandards(proposal: PlanProposal): Promise<ConstraintCheckResult>;

  // Extract revision suggestions from failed constraints
  extractSuggestedRevisions(failures: ConstraintCheckResult[]): string[];
}

interface ValidationResult {
  passes: boolean;
  checkedConstraints: ConstraintCheckResult[];
  failures?: ConstraintCheckResult[];
  suggestedRevisions?: string[];
}

interface ConstraintCheckResult {
  constraint: string;  // e.g., 'SAFETY', 'COHERENCE', 'THEATER_PROHIBITION'
  passes: boolean;
  details: string;
}
```

#### IProcedureCreationService (WKG Writer)

```typescript
interface IProcedureCreationService {
  // Create procedure node in WKG
  create(
    proposal: PlanProposal,
    validation: ValidationResult,
  ): Promise<CreatedProcedure>;
}

interface CreatedProcedure {
  id: string;           // procedure node ID in WKG
  confidence: number;   // starts at 0.35 (LLM_GENERATED base)
  status: 'AWAITING_FIRST_USE';
  name: string;
  triggerContext: ContextFingerprint;
}
```

#### IPlanEvaluationService (Post-Execution Feedback)

```typescript
interface IPlanEvaluationService {
  // Evaluate how a procedure performed after execution
  evaluateExecution(
    procedureId: string,
    execution: ProcedureExecution,
  ): Promise<PlanEvaluation>;
}

interface ProcedureExecution {
  procedureId: string;
  context: ContextData;
  actualDriveEffects: Partial<DriveSnapshot>;
  actualOutcome: any;
  executionDuration: number;  // milliseconds
  timestamp: Date;
}

interface PlanEvaluation {
  mae: number;
  success: boolean;      // MAE < 0.10
  failure: boolean;      // MAE > 0.15
  newConfidence: number;
}
```

### 2.2 Queue and Rate Limiting Interfaces

#### IOpportunityQueueService (Priority Queue with Decay)

```typescript
interface IOpportunityQueueService {
  // Enqueue an opportunity with priority decay tracking
  enqueue(opportunity: Opportunity): void;

  // Dequeue the highest-priority opportunity (with decay applied)
  dequeue(): QueuedOpportunity | null;

  // Get current queue status
  getStatus(): QueueStatus;

  // Peek at next opportunity without removing
  peek(): QueuedOpportunity | null;
}

interface QueuedOpportunity extends Opportunity {
  enqueuedAt: Date;
  currentPriority: number;  // decays over time
}

interface QueueStatus {
  size: number;
  maxSize: number;
  nextOpportunity?: QueuedOpportunity;
  averagePriority: number;
  oldestOpportunity?: QueuedOpportunity;
}
```

#### IPlanningRateLimiter (Capacity Control)

```typescript
interface IPlanningRateLimiter {
  // Check if we can proceed with a new plan
  canProceed(): boolean;

  // Record that a plan was created (increment counters)
  recordPlanCreated(): void;

  // Get current rate limiting status
  getStatus(): RateLimitStatus;

  // Reset state (used in tests or manual recovery)
  reset(): void;
}

interface RateLimitStatus {
  plansCreatedThisWindow: number;
  maxPlansPerWindow: number;
  windowDurationMs: number;
  activePlans: number;
  maxActivePlans: number;
  canProceed: boolean;
  nextWindowResetAt: Date;
}
```

### 2.3 Event and Logging Interfaces

All Planning events go to IEventService (provided by Events module). Key event types:

```typescript
type PlanningEventType =
  | 'OPPORTUNITY_INTAKE'
  | 'OPPORTUNITY_RESEARCH'
  | 'OPPORTUNITY_SIMULATION'
  | 'PLAN_PROPOSALS_GENERATED'
  | 'PLAN_VALIDATED'
  | 'PLAN_VALIDATION_FAILED'
  | 'PLAN_CREATED'
  | 'PLAN_EXECUTION'
  | 'PLAN_EVALUATION'
  | 'PLAN_FAILURE'
  | 'PLANNING_RATE_LIMITED'
  | 'OPPORTUNITY_INSUFFICIENT_EVIDENCE'
  | 'OPPORTUNITY_NO_VIABLE_OUTCOME'
  | 'OPPORTUNITY_DROPPED';

interface PlanningEvent {
  type: PlanningEventType;
  opportunityId?: string;
  procedureId?: string;
  timestamp: Date;
  data: Record<string, any>;
}
```

---

## 3. Key Types

### 3.1 Core Domain Types

#### Opportunity

```typescript
interface Opportunity {
  id: string;
  context: ContextFingerprint;
  pattern: string;              // description of what failed
  priority: number;             // 0.0 to 1.0
  coldStartDampened: boolean;
  createdAt: Date;
  detectedBy: string;           // "Drive Engine"
}

interface ContextFingerprint {
  primaryEntity: string;        // main entity in the context (e.g., person_jim)
  secondaryEntities: string[];
  predictor: string;            // which predictor failed
  situationalFactors: Record<string, any>;  // mood, time of day, etc.
}
```

#### Action

```typescript
interface Action {
  type: string;
  parameters: Record<string, any>;
  expectedDuration?: number;
  constraints?: string[];
}
```

#### PredictedOutcome

```typescript
interface PredictedOutcome {
  driveEffects: Partial<DriveSnapshot>;
  externalEffects: string[];
  confidence: number;
}
```

#### ContextData

```typescript
interface ContextData {
  entities: string[];
  timestamp: Date;
  sessionId: string;
  driveState: DriveSnapshot;
  recentActions: Action[];
}
```

### 3.2 Confidence and Provenance

Every procedure created by Planning carries:
- Provenance: `LLM_GENERATED`
- Base confidence: `0.35`
- Retrieval count: `0`
- Last retrieval time: `null`
- ACT-R formula applies: `min(1.0, 0.35 + 0.12 * ln(count) - d * ln(hours + 1))`

After first successful use: `0.35 + 0.12 * ln(1) = 0.35` (ln(1) = 0, so first use resets decay, confidence stays at base)
After 5 successful uses: `0.35 + 0.12 * ln(5) = 0.35 + 0.19 = 0.54` (approaching retrieval threshold of 0.50)
Type 1 graduation: confidence > 0.80 AND MAE < 0.10 over last 10 uses

---

## 4. Rate Limiting & Cold-Start Prevention

### 4.1 Planning Runaway Prevention

**Planning Runaway** occurs when too many prediction failures create too many Opportunities, leading to too many Plans, exhausting resources and filling the graph with low-quality procedures.

**Prevention strategy:**

#### Structural Rate Limiting

```
Max Plans Per Hour: 3
Max Active Plans: 10
Max Tokens Per Plan: 4000
Opportunity Queue Max Size: 50
```

- **Hourly rate limit:** At most 3 plans created per 1-hour sliding window
- **Active plan limit:** At most 10 plans awaiting their first successful use
- **Token budget:** Each plan LLM call (proposal + validation) is capped at 4000 tokens
- **Queue size:** Hard maximum of 50 Opportunities in the queue; if full, lowest-priority Opportunity is dropped

#### Opportunity Priority Decay

```
Decay Rate Per Hour: 0.10 (10% decay)
Formula: priority *= (1 - 0.10)^hours_in_queue
```

- Old, unaddressed Opportunities become less likely to be processed
- Prevents accumulation of stale, low-impact Opportunities
- System focuses on recent, high-priority failures

### 4.2 Prediction Pessimist Prevention

**Prediction Pessimist** occurs when early operation generates many failed predictions because the system has insufficient knowledge to make good predictions. The system floods itself with procedures before the WKG can support them.

**Prevention strategy:**

#### Cold-Start Dampening

```typescript
function computeColdStartDampening(
  totalDecisions: number,
  coldStartThreshold: number = 100,  // configurable
): number {
  if (totalDecisions >= coldStartThreshold) {
    return 0.0;  // no dampening
  }
  // Linear dampening from 0.8 to 0.0
  return 0.8 * (1 - totalDecisions / coldStartThreshold);
}
```

- In the first N decisions (default 100), all Opportunity generation is dampened
- Decision 0: dampening = 0.8 (80% reduction in Opportunity weight)
- Decision 50: dampening = 0.4 (40% reduction)
- Decision 100+: dampening = 0.0 (no reduction)
- Effect: In early operation, the Drive Engine detects failures but generates Opportunities at reduced weight, limiting Planning's activation frequency

#### Evidence Sufficiency Gate

- Research stage requires: failures >= 2 AND some MAE > 0.15
- Does not proceed to simulation if the pattern is not yet evident
- Prevents planning from responding to single-shot noise

---

## 5. Post-Execution Evaluation

Plans do not end when created. Every plan that is executed must be evaluated against its predictions.

### 5.1 Execution Flow

1. Decision Making selects a procedure (including newly created ones) as a candidate action
2. Executor Engine runs the procedure's action sequence
3. Actual outcomes are recorded: drive effects, external effects, duration
4. Plan Evaluation Service compares expected vs. actual outcomes (MAE computation)
5. ACT-R confidence update formula applied
6. If plan failed (MAE > 0.15), failure is recorded as a new prediction failure event that may create new Opportunities

### 5.2 Confidence Update Mechanics

```typescript
function updateProcedureConfidence(
  procedure: Procedure,
  mae: number,
  success: boolean,
): number {
  const currentConfidence = procedure.confidence;
  const retrievalCount = (procedure.retrievalCount ?? 0) + 1;
  const hoursSinceCreation = (Date.now() - procedure.createdAt.getTime()) / (1000 * 60 * 60);

  // ACT-R: min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
  const base = 0.35;  // LLM_GENERATED
  const decayRate = 0.05;  // per-type tunable

  let newConfidence = base + 0.12 * Math.log(retrievalCount) - decayRate * Math.log(hoursSinceCreation + 1);

  // If failure, confidence gets amplified penalty
  if (mae > 0.15) {
    newConfidence *= 0.7;  // 30% reduction for failure
  }

  return Math.min(1.0, newConfidence);
}
```

### 5.3 Demotion Criteria

- If MAE > 0.15: procedure is flagged as needing revision or demotion
- If confidence drops below 0.50: procedure becomes irretrievable in standard queries
- If procedure is never selected (context never recurs): confidence decays below threshold, procedure disappears from retrieval

### 5.4 Feedback to Drive Engine

- PLAN_FAILURE events are recorded to TimescaleDB
- Drive Engine reads these events and may create new Opportunities if failures are recurring
- This creates a virtuous cycle: failed plans generate new Opportunities, which generate improved plans

---

## 6. Cross-Module Dependencies

### 6.1 Inbound Dependencies (What Planning Needs)

#### From Drive Engine
- Opportunity events published to TimescaleDB
- Current drive state snapshot (read-only via IDriveStateReader)
- Drive rules (read-only, for constraint validation context)

#### From Events (E2)
- IEventService for recording all Planning events
- TimescaleDB event queries (eventService.queryPattern(), eventService.queryPriorPlans())
- Event stream subscription for Opportunities

#### From Knowledge (E3)
- IWKGService for reading the world knowledge graph
- IWKGService for creating procedure nodes with provenance
- Node/edge creation interface with confidence initialization

#### From Communication (Vox)
- LLMService (shared) for:
  - Plan proposal generation (Claude Sonnet, ~500-1000 tokens per proposal)
  - Constraint validation (Claude Haiku, ~300-500 tokens per validation)
  - Revision generation (Claude Haiku, ~200-400 tokens per revision)
- Total token budget per plan: ~4000 tokens (configurable rate limiter parameter)

#### From Decision Making (Cortex)
- Procedure execution outcomes (feed into Plan Evaluation)
- Actual vs. expected drive effects after execution
- Confidence updater interface for updating procedure confidence

### 6.2 Outbound Exports (What Planning Provides)

#### To Decision Making (Cortex)
- IPlanningService.getQueueStatus(): for monitoring
- Procedure nodes in WKG available for action selection
- Created procedures with low initial confidence (0.35)
- **Tension point:** New procedures are below retrieval threshold (0.50). Cortex must have a mechanism to trial untested procedures (e.g., occasional "try something new" action, or temporary confidence boost for procedures with 0.30-0.50 confidence).

#### To Events (E2)
- All planning events (OPPORTUNITY_INTAKE through PLAN_EVALUATION)
- TimescaleDB records for drive engine to read

#### To Knowledge (E3)
- Procedure nodes created with LLM_GENERATED provenance at 0.35 base confidence
- Edges connecting procedures to trigger contexts (TRIGGERED_BY)

### 6.3 Circular Dependencies and Resolution

**Potential circular dependency:** Planning -> Decision Making (for execution outcomes) -> Planning (for confidence updates)

**Resolution:** Decoupled via Events/TimescaleDB:
- Decision Making records execution outcomes to TimescaleDB as events
- Planning subscribes to those events and reads the information
- No direct call dependency, purely event-driven through shared store

---

## 7. Tension Points

### 7.1 New Procedure Confidence Ceiling

**Tension:** New procedures start at 0.35 confidence (LLM_GENERATED base), which is below the 0.50 retrieval threshold. This means newly created plans would never be retrieved and selected by Decision Making.

**Impact on Decision Making:**
- Standard ACT-R retrieval query (`confidence >= 0.50`) will not return new procedures
- New procedures are "invisible" to normal action selection
- New procedures cannot be tested because they're never selected

**Resolution Options (for Cortex agent to design):**
1. **Trial mechanism:** Decision Making occasionally selects a "try something new" action that retrieves procedures with 0.30-0.50 confidence
2. **Temporary boost:** Newly created procedures (< 24 hours old, `status='AWAITING_FIRST_USE'`) get a temporary +0.20 confidence boost during the first 24 hours only
3. **Separate query:** Decision Making queries for procedures in the 0.30-0.50 band with decay-based aging, selecting from them occasionally
4. **Cortex role:** The Decision Making agent must design the mechanism to give new procedures a fair trial

**This is a Cortex problem, not a Planning problem.** Planning creates the procedures correctly (at 0.35). Cortex must ensure new procedures get a chance to prove themselves.

### 7.2 Simulation Uncertainty and Overconfidence

**Tension:** Simulation estimates success probability based on sparse historical data. Early in operation, the WKG is small and patterns are weak, making success estimates unreliable.

**Impact:**
- Simulations may predict high expected value for plans that actually fail
- This can lead to creating many low-quality procedures

**Mitigation:**
- Conservative estimation: if historical data is sparse (< 3 similar actions), simulation widens uncertainty bounds
- Lower expected value threshold for sparse data: only candidates with very high expected value proceed to proposal
- Evidence sufficiency gate in Research stage requires at least 2 failures; does not overfit to single events

### 7.3 LLM Generation Quality and Theater

**Tension:** Plan proposals are LLM-generated. The LLM can generate elegant-sounding but unfounded plans.

**Impact:**
- Plans that don't actually address the problem
- Plans that violate Immutable Standards (e.g., expressing emotions without drive support)
- Plans that are incoherent or unfeasible

**Mitigation:**
- LLM_GENERATED provenance with 0.35 base confidence (lower than GUARDIAN at 0.60) ensures plans don't claim unearned confidence
- Constraint validation via LLM checks against Immutable Standards
- Post-execution evaluation: if plan fails (MAE > 0.15), confidence is reduced and the plan may be demoted or dropped
- Theater Prohibition: if a plan involves emotional expression, Drive Engine gives zero reinforcement if the corresponding drive is < 0.2

### 7.4 Rate Limiter vs. Opportunity Backlog

**Tension:** Max 3 plans per hour. Opportunity queue max 50. If Opportunities arrive faster than they can be processed, the queue fills up and low-priority Opportunities are dropped.

**Impact:**
- Some Opportunities never get addressed
- If an important Opportunity gets dropped and never re-detected, the system misses the chance to improve

**Mitigation:**
- Priority decay ensures old Opportunities lose priority but don't disappear immediately
- Cold-start dampening keeps early Opportunities from overwhelming the queue
- Guardian can manually queue Opportunities for immediate processing if needed
- Monitoring: Planning provides queue status (QueueStatus) to dashboard for observability

---

## 8. Testing and Verification Strategy

### 8.1 Unit-Level Verification (for each stage)

**INTAKE stage:**
- Rate limiter correctly blocks when limits exceeded
- Event is recorded to TimescaleDB
- Correct opportunity passed to RESEARCH

**RESEARCH stage:**
- TimescaleDB event queries return correct patterns
- Evidence strength computation is accurate
- Sufficient evidence gate works (correctly rejects < 2 failures)

**SIMULATE stage:**
- Candidate actions generated from discrepancies
- Drive effect predictions use WKG knowledge correctly
- Expected value computation combines factors appropriately

**PROPOSE stage:**
- LLM generates multiple distinct proposals
- Proposal structure is valid (has all required fields)

**VALIDATE stage:**
- Constraint checks execute and return correct results
- Immutable Standards are checked
- Constraint failures are translated to revision suggestions
- LLM coherence check works

**CREATE stage:**
- Procedure node created in WKG with correct structure
- Provenance set to LLM_GENERATED
- Confidence initialized to 0.35
- Edges created correctly

**EVALUATE stage:**
- Confidence update formula applied correctly
- MAE computation is accurate
- Failure penalty applied when MAE > 0.15

### 8.2 Integration-Level Verification (full pipeline)

**End-to-end happy path:**
1. Drive Engine publishes Opportunity with high evidence
2. Planning intakes, researches, simulates, proposes, validates, creates procedure
3. Procedure appears in WKG with correct properties
4. Procedure is eventually selected by Decision Making
5. Procedure executes and produces outcome
6. Evaluation updates procedure confidence

**Failure paths:**
- Insufficient evidence: Opportunity stays in queue, decays
- No viable outcome: Opportunity dropped with event logged
- Validation failure with successful revision: revised plan created
- Validation failure with no successful revision: Opportunity dropped

### 8.3 Attractor State Tests

**Planning Runaway:**
- Create 100 Opportunities with high priority
- Verify only 3 are processed per hour
- Verify queue size capped at 50
- Verify oldest Opportunities decay and get dropped

**Prediction Pessimist:**
- In first 50 decisions, generate prediction failures continuously
- Verify Opportunities are created at reduced weight (dampened)
- Verify plans created are conservative and low-volume
- At decision 101, verify dampening is zero and normal operation resumes

### 8.4 Lesion Test (for Phase 1 verification)

- Run full loop with Planning subsystem
- Disable Planning, run same input sequence
- Compare:
  - Number of procedures created (should be higher with Planning)
  - Prediction accuracy over time (should improve faster with Planning)
  - Type 1 availability (should be higher because Planning provides procedures)

---

## 9. Cross-Module Interactions (Detailed)

### 9.1 Planning <-> Drive Engine

**One-way communication:** Planning reads, never writes.

- Planning reads: current drive state (for simulation context)
- Drive Engine writes: Opportunity events to TimescaleDB
- Planning subscribes: to OPPORTUNITY_CREATED events from Drive Engine
- Planning publishes: PLAN_FAILURE events for failed procedures (Drive Engine reads these as prediction failures)

**Scenario:** Guardian says "that was not what I wanted" (correction). Drive Engine notes the failure. If this pattern repeats, Drive Engine publishes Opportunity. Planning researches and creates a procedure. Procedure is tested. If the procedure produces better outcomes, confidence increases. If it continues to fail, Drive Engine may create a new Opportunity.

### 9.2 Planning <-> Decision Making

**Tension point:** Procedure availability and confidence.

- Planning creates: procedure nodes in WKG at 0.35 confidence
- Decision Making reads: procedure nodes via WKG queries
- Decision Making must: have a mechanism to trial procedures with 0.30-0.50 confidence
- Planning reads: execution outcomes from TimescaleDB events recorded by Decision Making
- Planning updates: procedure confidence based on outcomes

**Scenario:** Planning creates a procedure for "when user seems confused, ask clarifying questions" at 0.35 confidence. Cortex's "try something new" action triggers and selects this procedure (because it's new and below normal threshold). Procedure is executed. Outcomes are recorded. Plan Evaluation updates confidence. If successful, confidence rises; if failed, confidence falls.

### 9.3 Planning <-> Knowledge (WKG)

**Knowledge owns schema; Planning uses creation interface.**

- Planning calls: IWKGService.createNode() with procedure properties
- Planning passes: provenance = 'LLM_GENERATED', confidence = 0.35
- Knowledge validates: node conforms to Procedure schema
- Knowledge enforces: Confidence Ceiling (no knowledge > 0.60 without retrieval-and-use)
- Planning reads: existing action nodes via WKG queries (for simulation pattern matching)

**Scenario:** Planning creates procedure "ask follow-up question". Knowledge creates node, stores it in graph. Decision Making queries for available actions, gets back both old actions (higher confidence) and new procedure (0.35). Cortex selects new procedure. Procedure is executed. Executor updates confidence in WKG via Knowledge module.

### 9.4 Planning <-> Learning

**Indirect communication via shared stores.**

- Learning consolidates: experience into WKG entities and edges
- Planning benefits: from richer WKG (better simulation data)
- Learning reads: planning events for context about procedures
- No direct interface between subsystems

**Scenario:** Guardian teaches Sylphie about a new concept. Learning extracts it, creates nodes in WKG. Later, Planning simulates an action and queries WKG for similar actions. Finds the newly learned knowledge. Improves simulation quality.

### 9.5 Planning <-> Communication

**Minimal direct interaction; communication is action executor.**

- Planning creates: procedures that may include communication actions (e.g., "ask user for feedback")
- Communication executes: the action when Decision Making selects the procedure
- Communication publishes: actual response outcomes
- Planning reads: communication outcomes as part of procedure execution feedback

---

## 10. Ticket Breakdown Recommendation

### 10.1 Recommended Ticket Order and Dependencies

```
EPIC 8 PLANNING -- Suggested Ticket Order
========================================

Block 1 (Interfaces & Types)
  T8.0.1: Define all core types (Opportunity, PlanProposal, ValidationResult, etc.)
    Dependencies: None (pure types)
    Effort: Small (< 2 hours)

  T8.0.2: Define all service interfaces (IPlanning*, IOpportunityQueue, IPlanningRateLimiter)
    Dependencies: T8.0.1
    Effort: Small (< 2 hours)

Block 2 (Rate Limiting & Queue)
  T8.1.1: Implement PlanningRateLimiter
    Dependencies: T8.0.2
    Effort: Small (straightforward state machine)
    Tests: Verify 3-per-hour limit, active plan limit, reset

  T8.1.2: Implement OpportunityQueueService with priority decay
    Dependencies: T8.0.2
    Effort: Small (priority queue + decay math)
    Tests: Verify max size, decay formula, dequeue ordering

Block 3 (Research Service)
  T8.2.1: Implement OpportunityResearchService
    Dependencies: T8.0.2, Events (E2), Knowledge (E3)
    Effort: Medium (complex pattern matching)
    Tests: Verify evidence strength computation, sufficiency gate
    Key: Must query TimescaleDB for event patterns and WKG for knowledge

Block 4 (Simulation Service)
  T8.3.1: Implement SimulationService
    Dependencies: T8.0.2, T8.2.1, Knowledge (E3), Drive Engine (E4)
    Effort: Medium (multiple prediction algorithms)
    Tests: Verify candidate action generation, drive effect prediction, expected value
    Key: Conservative estimation for sparse data

Block 5 (Proposal & Validation)
  T8.4.1: Implement PlanProposalService
    Dependencies: T8.0.2, T8.3.1, Communication LLM
    Effort: Medium (LLM integration + multiple proposal generation)
    Tests: Verify multiple distinct proposals, valid structure
    Key: LLM calls for proposal generation and revision

  T8.4.2: Implement ConstraintValidationService
    Dependencies: T8.0.2, T8.4.1, Communication LLM, Knowledge (E3)
    Effort: Medium-High (checks 6 Immutable Standards + LLM validation)
    Tests: Verify each constraint check, revision suggestion extraction
    Key: Theater Prohibition, Confidence Ceiling, etc.

Block 6 (Procedure Creation)
  T8.5.1: Implement ProcedureCreationService
    Dependencies: T8.0.2, Knowledge (E3)
    Effort: Small (WKG node/edge creation with correct provenance)
    Tests: Verify node created, confidence = 0.35, edges correct

Block 7 (Post-Execution Evaluation)
  T8.6.1: Implement PlanEvaluationService
    Dependencies: T8.0.2, T8.5.1, Knowledge (E3), Events (E2)
    Effort: Medium (ACT-R confidence formula, feedback to Drive Engine)
    Tests: Verify confidence update formula, failure feedback, demotion logic

Block 8 (Main Pipeline Coordinator)
  T8.7.1: Implement PlanningService (main orchestrator)
    Dependencies: All of T8.1 through T8.6
    Effort: Medium (orchestrates all stages, error handling, revision loops)
    Tests: End-to-end happy path, all failure paths, revision loop
    Key: Asynchrony, rate limiting integration, event recording

Block 9 (Cold-Start Prevention & Monitoring)
  T8.8.1: Implement cold-start dampening in Drive Engine integration
    Dependencies: T8.7.1, Drive Engine (E4)
    Effort: Small (simple multiplier on Opportunity weight)
    Tests: Verify dampening decay rate over first 100 decisions

  T8.8.2: Implement Planning telemetry / monitoring hooks
    Dependencies: T8.7.1, Events (E2)
    Effort: Small (queue status, rate limiter status, event counts)
    Tests: Verify stats are accurate, dashboard can query them

Block 10 (Integration Tests)
  T8.9.1: Full-loop integration test
    Dependencies: All of T8.1-T8.8, Cortex (E5) for procedure selection
    Effort: Medium (requires working Cortex)
    Tests: Opportunity -> Plan -> Procedure -> Selection -> Execution -> Evaluation

  T8.9.2: Attractor state tests (Planning Runaway, Prediction Pessimist)
    Dependencies: T8.8.1, full integration
    Effort: Medium (multi-cycle simulations)
    Tests: Verify rate limiting caps plans, cold-start dampening works
```

### 10.2 Critical Path

```
E0 (types/interfaces) ->
  T8.1 (Queue + RateLimiter) [in parallel] ->
  T8.2 (Research) ->
  T8.3 (Simulate) ->
  T8.4.1 (Propose) ->
  T8.4.2 (Validate) ->
  T8.5 (Create) ->
  T8.6 (Evaluate) ->
  T8.7 (Main Service) ->
  T8.8 (Cold-Start + Telemetry) ->
  T8.9 (Integration Tests)
```

Parallelizable:
- T8.1.1 and T8.1.2 can run in parallel (independent)
- T8.4.1 and T8.4.2 can run in parallel after T8.3 (independent of each other)
- T8.2 and T8.3 depend on each other but both depend on T8.1

### 10.3 Effort Estimation

| Block | Tickets | Effort | Notes |
|-------|---------|--------|-------|
| 1 (Types) | T8.0.1-2 | 4 hours | Pure types/interfaces |
| 2 (Queue) | T8.1.1-2 | 4 hours | Can parallelize |
| 3 (Research) | T8.2.1 | 6 hours | Complex pattern matching |
| 4 (Simulate) | T8.3.1 | 8 hours | Multiple algorithms |
| 5 (Proposal) | T8.4.1-2 | 12 hours | LLM integration, validation |
| 6 (Create) | T8.5.1 | 3 hours | Straightforward WKG write |
| 7 (Evaluate) | T8.6.1 | 6 hours | ACT-R formula + feedback |
| 8 (Main) | T8.7.1 | 8 hours | Orchestration + error handling |
| 9 (Monitoring) | T8.8.1-2 | 4 hours | Integration hooks |
| 10 (Tests) | T8.9.1-2 | 10 hours | Full-loop + attractor tests |
| **Total** | **20 tickets** | **~65 hours** | ~8 days at 8 hrs/day |

---

## 11. Known Issues & Gotchas

### 11.1 New Procedure Confidence Gap

**Issue:** Procedures start at 0.35, below retrieval threshold (0.50). Decision Making cannot see them normally.

**Gotcha:** If Cortex doesn't implement a trial mechanism, new procedures will never be selected and will decay without being tested.

**Mitigation:** Cortex agent must design the trial mechanism as part of Decision Making.

### 11.2 LLM Token Budget

**Issue:** Each plan can consume up to 4000 tokens (proposal + validation + revisions). At 3 plans per hour, that's 12,000 tokens/hour for planning alone.

**Gotcha:** If other subsystems are also heavy LLM users, the total token budget can be exceeded.

**Mitigation:** Shared LLM service tracks token usage across all subsystems. If budget threatened, rate limiter can reduce plans-per-hour.

### 11.3 TimescaleDB Event Pattern Queries

**Issue:** Research service queries TimescaleDB for event patterns. If TimescaleDB is not properly indexed on (context_fingerprint, timestamp), queries can be slow.

**Gotcha:** Slow queries block the research stage, backing up the entire pipeline.

**Mitigation:** E2 (Events) must ensure proper indexing. Planning should set reasonable query timeouts.

### 11.4 WKG Knowledge Sparsity

**Issue:** In early operation, the WKG has few action nodes with historical drive effects. Simulation must estimate with minimal data.

**Gotcha:** Simulation estimates become unreliable, leading to poor plans.

**Mitigation:** Cold-start dampening + Evidence Sufficiency gate prevent the system from creating too many plans before the WKG has substance.

### 11.5 Procedure Trigger Context Matching

**Issue:** Procedures are created with a trigger context (ContextFingerprint). When Decision Making queries for available procedures, it must match the current context to the procedure's trigger context.

**Gotcha:** If context matching is too strict, new procedures never fire. If too loose, procedures fire in inappropriate contexts.

**Mitigation:** Context fingerprints must balance specificity and generalization. Primary entity is always included; secondary entities and situational factors are weighted.

---

## 12. Summary & Next Steps

### 12.1 Epic 8 Scope

Epic 8 implements the full Planning pipeline: INTAKE -> RESEARCH -> SIMULATE -> PROPOSE -> VALIDATE -> CREATE. It includes rate limiting, cold-start dampening, opportunity queue with decay, and post-execution evaluation.

**What it does NOT include:**
- Opportunity detection (that's Drive Engine's job in E4)
- Procedure selection (that's Decision Making's job in E5)
- Knowledge consolidation (that's Learning's job in E7)

**What it DEPENDS on:**
- E0: All type definitions and service interfaces
- E1: PostgreSQL for drive rules (read-only)
- E2: Events and TimescaleDB for event queries
- E3: Knowledge (WKG) for reading and writing
- E4: Drive Engine for Opportunity events and drive state (read-only)
- Communication: LLM service for proposal and validation

### 12.2 Key Design Principles

1. **Plans are hypotheses:** Created at 0.35 confidence, tested through execution, demoted if they fail.
2. **Rate-limited:** Max 3 plans per hour, max 10 active, max 50 in queue. Prevents Planning Runaway.
3. **Cold-start dampened:** Early prediction failures don't flood the system with procedures. Dampening decays to zero by decision 100.
4. **Evaluation-driven:** Every plan execution is evaluated. Failures feed back to Drive Engine as prediction failures.
5. **Constraint-validated:** Plans checked against all six Immutable Standards before creation.
6. **Grounded in evidence:** Plans based on actual observed patterns in TimescaleDB, not LLM speculation.

### 12.3 Tension for Cortex Agent

**The gap:** New procedures are created at 0.35 confidence, below the normal retrieval threshold of 0.50. Cortex must implement a mechanism to trial untested procedures.

**Options:**
- Occasional "try something new" action that queries 0.30-0.50 procedures
- Temporary confidence boost for procedures < 24 hours old
- Separate "experimental" action selection alongside standard selection

**This is Cortex's design problem to solve in E5.**

---

**Analysis complete. Ready for Cortex and Executor agents to review cross-module impacts.**

/**
 * Planning module interface contracts.
 *
 * CANON §Subsystem 5 (Planning): Triggered by Opportunities detected by the
 * Drive Engine. Researches failure patterns, simulates outcomes, validates
 * proposed plans via LLM constraint checking, and creates new procedure
 * nodes in the WKG with LLM_GENERATED provenance at confidence 0.35.
 *
 * CANON §Known Attractor States — Planning Runaway: The opportunity queue
 * must apply priority decay and the rate limiter must enforce per-window
 * plan creation caps. Without these, Planning generates an unbounded number
 * of low-quality procedures that flood the WKG.
 *
 * CANON §Known Attractor States — Prediction Pessimist: Early prediction
 * failures must not cascade. The rate limiter and insufficient-evidence gate
 * in IPlanningService.processOpportunity() exist to prevent this.
 *
 * CANON §Confidence Dynamics: All procedure nodes created by Planning carry
 * LLM_GENERATED provenance and start at confidence 0.35.
 * CANON Immutable Standard 3 (Confidence Ceiling): No node exits creation
 * above 0.60 regardless of provenance — 0.35 for LLM_GENERATED is already
 * well within that ceiling.
 *
 * Injection tokens defined in planning.tokens.ts.
 */

import type { DriveName } from '../../shared/types/drive.types';
import type { Opportunity } from '../../drive-engine/interfaces/drive-engine.interfaces';

// ---------------------------------------------------------------------------
// Re-export Opportunity for downstream consumers
// ---------------------------------------------------------------------------

export type { Opportunity };

// ---------------------------------------------------------------------------
// PlanningResult — discriminated union (5 variants)
// ---------------------------------------------------------------------------

/**
 * The result of processing a single Opportunity through the full planning
 * pipeline: research → simulation → proposal → validation → creation.
 *
 * CREATED:              A new procedure node was committed to the WKG.
 *                       procedureId is the WKG node ID of the created procedure.
 *
 * RATE_LIMITED:         The rate limiter determined the planning window is
 *                       saturated. The opportunity was dropped without processing.
 *                       CANON §Known Attractor States — Planning Runaway.
 *
 * INSUFFICIENT_EVIDENCE: The research phase did not find enough prior-attempt
 *                         data or contextual knowledge to produce a meaningful
 *                         simulation. No plan was created.
 *
 * NO_VIABLE_OUTCOME:    The simulation produced zero candidates with a positive
 *                       expected value. Creating a plan here would be Theater
 *                       (CANON Standard 1 — the procedure would not correlate
 *                       with genuine drive improvement).
 *
 * VALIDATION_FAILED:    The LLM constraint validator rejected the proposed plan.
 *                       reasons carries the human-readable failures for logging
 *                       and guardian review.
 */
export type PlanningResult =
  | { readonly status: 'CREATED'; readonly procedureId: string }
  | { readonly status: 'RATE_LIMITED' }
  | { readonly status: 'INSUFFICIENT_EVIDENCE' }
  | { readonly status: 'NO_VIABLE_OUTCOME' }
  | { readonly status: 'VALIDATION_FAILED'; readonly reasons: readonly string[] };

// ---------------------------------------------------------------------------
// QueuedOpportunity
// ---------------------------------------------------------------------------

/**
 * An Opportunity that has been accepted into the planning queue with a
 * decaying priority score.
 *
 * CANON §Known Attractor States — Planning Runaway: priority decays over
 * time so that stale opportunities do not block fresher, higher-impact ones.
 * The decay calculation requires both priority and createdAt on Opportunity
 * itself (satisfied by the Opportunity interface in drive-engine.interfaces.ts).
 */
export interface QueuedOpportunity {
  /** The underlying opportunity as received from the Drive Engine. */
  readonly opportunity: Opportunity;

  /**
   * Current effective priority after decay has been applied.
   * Starts equal to opportunity.priority and decreases as the opportunity
   * ages in the queue. Value in [0.0, 1.0].
   */
  readonly currentPriority: number;

  /** Wall-clock time this opportunity was added to the planning queue. */
  readonly enqueuedAt: Date;
}

// ---------------------------------------------------------------------------
// PlanningState
// ---------------------------------------------------------------------------

/**
 * Summary of the planning subsystem's current operational state.
 * Returned by IPlanningService.getState() for dashboard display and diagnostics.
 */
export interface PlanningState {
  /** Number of opportunities currently waiting in the priority queue. */
  readonly queueSize: number;

  /**
   * Number of plans whose procedure nodes exist in the WKG but have not
   * yet been evaluated by a Decision Making cycle. Measures plan utilization
   * pressure — if this grows unboundedly, the Planning Runaway attractor
   * may be active.
   */
  readonly activePlans: number;

  /**
   * Count of plans created in the current rate-limiter window.
   * Compared against the per-window cap to determine whether canProceed() is true.
   */
  readonly plansCreatedThisWindow: number;

  /**
   * Whether the cold-start dampening multiplier is currently active.
   * True for the first N opportunities after process start to prevent the
   * Prediction Pessimist attractor from forming before the system has enough
   * history to produce reliable research results.
   */
  readonly coldStartDampening: boolean;

  /** Current state of the rate limiter. */
  readonly rateLimiterState: RateLimiterState;
}

// ---------------------------------------------------------------------------
// ResearchResult
// ---------------------------------------------------------------------------

/**
 * The structured output of the research phase for a single Opportunity.
 *
 * IOpportunityResearchService assembles this by querying TimescaleDB for
 * prior attempts in the opportunity's context fingerprint and the WKG for
 * contextual knowledge nodes. The Planning pipeline gates on hasSufficientEvidence
 * before proceeding to simulation.
 */
export interface ResearchResult {
  /**
   * Whether the research phase found enough prior-attempt data and contextual
   * knowledge to support a meaningful simulation.
   *
   * If false, IPlanningService returns { status: 'INSUFFICIENT_EVIDENCE' }
   * without invoking ISimulationService.
   */
  readonly hasSufficientEvidence: boolean;

  /**
   * Number of prior action failures recorded in TimescaleDB for the
   * opportunity's contextFingerprint. Feeds the failure-frequency heuristic
   * used by ISimulationService to weight success probability.
   */
  readonly failureCount: number;

  /**
   * Semantic discrepancies found in the WKG between the expected action
   * outcome and the recorded state after prior attempts.
   * Each entry is a human-readable description of a specific mismatch.
   */
  readonly discrepancies: readonly string[];

  /**
   * Count of prior Planning pipeline attempts for this opportunity's
   * contextFingerprint. Prevents the same opportunity from spawning
   * unbounded research cycles.
   */
  readonly priorAttempts: number;

  /**
   * Normalized evidence strength in [0.0, 1.0]. Derived from failureCount,
   * contextKnowledge depth, and the age of the most recent prior attempt.
   * Used by ISimulationService.simulate() to weight candidate scores.
   */
  readonly evidenceStrength: number;

  /**
   * Knowledge nodes retrieved from the WKG that are relevant to the
   * opportunity's contextFingerprint. Used by ISimulationService to ground
   * candidate action types in actual world knowledge.
   */
  readonly contextKnowledge: readonly string[];
}

// ---------------------------------------------------------------------------
// SimulationResult + SimulatedOutcome
// ---------------------------------------------------------------------------

/**
 * A single candidate action outcome produced by simulation.
 *
 * Each candidate represents one potential action type the system could
 * take to address the opportunity. The Planning pipeline selects the
 * bestCandidate (highest expectedValue) as the basis for PlanProposal.
 */
export interface SimulatedOutcome {
  /**
   * The action type this candidate represents.
   * Corresponds to the category field on ActionProcedureData.
   * Example values: 'ConversationalResponse', 'SocialComment', 'KnowledgeQuery'
   */
  readonly actionType: string;

  /**
   * Predicted per-drive effect deltas if this action type succeeds.
   * Partial map — only drives expected to change are included.
   * Positive values = pressure relief (drive satisfied).
   * Negative values = additional pressure (action worsens the drive).
   */
  readonly predictedDriveEffects: Partial<Record<DriveName, number>>;

  /**
   * Estimated probability this action type produces a positive outcome
   * in the opportunity's context. Derived from ResearchResult.evidenceStrength
   * and the historical failure rate for this action type.
   * Value in [0.0, 1.0].
   */
  readonly successProbability: number;

  /**
   * Expected reduction in informational uncertainty if this action type
   * is executed. Higher gain favors the action even if direct drive relief
   * is modest — satisfies InformationIntegrity drive.
   * Value in [0.0, 1.0].
   */
  readonly informationGain: number;

  /**
   * Composite expected value: weighted combination of predicted drive relief,
   * success probability, and information gain. Used to rank candidates and
   * select the best one.
   * Value in [0.0, 1.0].
   */
  readonly expectedValue: number;
}

/**
 * The full output of a simulation run for one ResearchResult.
 */
export interface SimulationResult {
  /** All candidate outcomes evaluated by the simulation. May be empty. */
  readonly candidates: readonly SimulatedOutcome[];

  /**
   * Whether at least one candidate has an expectedValue above the minimum
   * viable threshold. If false, IPlanningService returns { status: 'NO_VIABLE_OUTCOME' }.
   */
  readonly hasViableOutcome: boolean;

  /**
   * The candidate with the highest expectedValue. Null if candidates is empty.
   * Forms the basis for PlanProposal construction.
   */
  readonly bestCandidate: SimulatedOutcome | null;
}

// ---------------------------------------------------------------------------
// PlanProposal
// ---------------------------------------------------------------------------

/**
 * A fully assembled plan proposal submitted to IConstraintValidationService.
 *
 * Built by IPlanningService from the ResearchResult and SimulationResult.
 * The LLM constraint validator reviews the full proposal before it can be
 * committed as a procedure node in the WKG.
 *
 * CANON §Planning: The LLM here is acting as a constraint checker, not as
 * the decision maker. The proposal itself was constructed from graph data
 * and simulation results — the LLM validates logical consistency and
 * CANON compliance but did not author the plan.
 */
export interface PlanProposal {
  /** UUID v4. Correlates the proposal to the final CreatedProcedure. */
  readonly id: string;

  /** The ID of the Opportunity that triggered this planning cycle. */
  readonly opportunityId: string;

  /** Human-readable name for the proposed action procedure. */
  readonly name: string;

  /**
   * The trigger context fingerprint from the originating Opportunity.
   * Stored on the procedure node so Decision Making can match it during
   * action candidate retrieval.
   */
  readonly triggerContext: string;

  /**
   * Ordered sequence of action steps constituting this procedure.
   * Each entry is a step type identifier and its parameters, keyed by
   * index. At least one step is required.
   */
  readonly actionSequence: readonly { readonly stepType: string; readonly params: Record<string, unknown> }[];

  /**
   * Human-readable description of the expected outcome if this procedure
   * is executed successfully.
   */
  readonly expectedOutcome: string;

  /**
   * Conditions under which execution of this procedure should be aborted.
   * Each entry is a human-readable condition description. The executor
   * checks these during the OBSERVING phase.
   */
  readonly abortConditions: readonly string[];

  /**
   * Evidence strength inherited from ResearchResult.evidenceStrength.
   * Carried on the proposal so the validator can assess whether the
   * supporting evidence is adequate for the complexity of the plan.
   * Value in [0.0, 1.0].
   */
  readonly evidenceStrength: number;
}

// ---------------------------------------------------------------------------
// ValidationResult + ConstraintFailure
// ---------------------------------------------------------------------------

/**
 * A specific constraint that the proposed plan violated.
 */
export interface ConstraintFailure {
  /**
   * Identifier of the constraint that failed.
   * Example: 'THEATER_PROHIBITION', 'DRIVE_ISOLATION', 'PROVENANCE_INTEGRITY'
   */
  readonly constraint: string;

  /** Human-readable explanation of why the constraint was violated. */
  readonly reason: string;

  /**
   * Optional suggestion from the validator for how to revise the proposal
   * to satisfy this constraint. Surfaced in the guardian review queue.
   */
  readonly suggestedRevision?: string;
}

/**
 * Result of running a PlanProposal through IConstraintValidationService.
 *
 * The validator checks each proposal against the six immutable CANON standards
 * and any additional structural constraints (drive isolation, provenance
 * integrity, action step validity). A proposal that fails any constraint is
 * not committed to the WKG.
 */
export interface ValidationResult {
  /**
   * True if all checked constraints passed. False if one or more failed.
   * Only a passing validation allows IProcedureCreationService.create() to proceed.
   */
  readonly passed: boolean;

  /**
   * List of specific constraint failures. Empty if passed is true.
   * Each failure carries sufficient context for guardian review.
   */
  readonly failures: readonly ConstraintFailure[];

  /**
   * Names of every constraint that was checked, whether it passed or failed.
   * Enables auditing of which constraints are active and which were evaluated.
   */
  readonly checkedConstraints: readonly string[];
}

// ---------------------------------------------------------------------------
// CreatedProcedure
// ---------------------------------------------------------------------------

/**
 * The result of successfully committing a validated plan as a procedure node
 * in the WKG.
 *
 * CANON §Confidence Dynamics: All Planning-created procedures start at
 * confidence 0.35 with LLM_GENERATED provenance. This reflects that the
 * procedure was constructed from simulation + LLM validation, not from direct
 * guardian teaching or sensor observation.
 *
 * Confidence rises via ACT-R dynamics as the procedure is successfully
 * retrieved and used by Decision Making. Type 1 graduation (confidence > 0.80,
 * MAE < 0.10) remains possible through performance.
 */
export interface CreatedProcedure {
  /** WKG node ID of the newly created procedure node. */
  readonly procedureId: string;

  /**
   * Initial confidence assigned at creation.
   * Locked at 0.35 for LLM_GENERATED provenance (CANON §Confidence Dynamics).
   */
  readonly confidence: 0.35;

  /**
   * Provenance assigned to the procedure node.
   * Always LLM_GENERATED for Planning-created procedures.
   * CANON §7 (Provenance Is Sacred): This tag is never erased.
   */
  readonly provenance: 'LLM_GENERATED';

  /** Wall-clock time the procedure node was written to the WKG. */
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// RateLimiterState
// ---------------------------------------------------------------------------

/**
 * Operational state of the planning rate limiter.
 *
 * CANON §Known Attractor States — Planning Runaway: The rate limiter enforces
 * a hard cap on plans created per time window and a concurrent-active-plans
 * limit. Both caps must be respected to prevent the WKG from being flooded
 * with low-quality procedure nodes.
 */
export interface RateLimiterState {
  /**
   * Number of plans created in the current time window.
   * Compared against the per-window cap configured via AppConfig.
   */
  readonly plansThisWindow: number;

  /**
   * Number of procedure nodes currently in the WKG that have not yet been
   * evaluated by a Decision Making cycle. A rising count here is an early
   * warning for Planning Runaway.
   */
  readonly activePlans: number;

  /** Wall-clock time at which the current rate-limiter window resets. */
  readonly windowResetsAt: Date;

  /**
   * Convenience flag: true if both the per-window cap and the active-plans
   * cap have not been exceeded. Mirrors IPlanningRateLimiter.canProceed().
   */
  readonly canProceed: boolean;
}

// ---------------------------------------------------------------------------
// Interface: IPlanningService
// ---------------------------------------------------------------------------

/**
 * Primary facade for the Planning subsystem.
 *
 * Coordinates the full pipeline for each Opportunity:
 *   1. Rate-limit gate (IPlanningRateLimiter.canProceed)
 *   2. Research (IOpportunityResearchService.research)
 *   3. Simulation (ISimulationService.simulate)
 *   4. Proposal assembly
 *   5. Constraint validation (IConstraintValidationService.validate)
 *   6. Procedure creation (IProcedureCreationService.create)
 *
 * Other modules interact only with this facade. The internal pipeline services
 * are not exported from the module barrel.
 *
 * Injection token: PLANNING_SERVICE (planning.tokens.ts)
 * Provided by: PlanningService
 */
export interface IPlanningService {
  /**
   * Accept and process an Opportunity from the Drive Engine.
   *
   * Runs the opportunity through the full six-stage pipeline and returns a
   * PlanningResult discriminated union describing the outcome. Never throws
   * for expected pipeline exits (insufficient evidence, rate limiting, etc.) —
   * those are represented as result variants. Only throws for unexpected
   * infrastructure failures (database unreachable, unrecoverable IPC error).
   *
   * CANON §Known Attractor States — Planning Runaway: If canProceed() is false,
   * returns { status: 'RATE_LIMITED' } immediately without running research or
   * simulation. This is the primary guard against runaway plan generation.
   *
   * @param opportunity - The opportunity surfaced by the Drive Engine.
   * @returns A PlanningResult describing the pipeline outcome.
   * @throws {PlanningException} For unexpected infrastructure failures only.
   */
  processOpportunity(opportunity: Opportunity): Promise<PlanningResult>;

  /**
   * Return the current contents of the opportunity priority queue.
   *
   * Entries are sorted by currentPriority descending (highest priority first).
   * The array is a snapshot — it does not update as the queue changes.
   *
   * @returns Readonly snapshot of queued opportunities, sorted by priority.
   */
  getOpportunityQueue(): readonly QueuedOpportunity[];

  /**
   * Return a summary of the planning subsystem's current state.
   *
   * Used by the dashboard for diagnostics and attractor state monitoring.
   * Safe to call at any time, including during active pipeline execution.
   *
   * @returns Current PlanningState snapshot.
   */
  getState(): PlanningState;
}

// ---------------------------------------------------------------------------
// Interface: IOpportunityResearchService
// ---------------------------------------------------------------------------

/**
 * Researches an Opportunity by querying TimescaleDB for prior failure history
 * and the WKG for contextual knowledge relevant to the opportunity fingerprint.
 *
 * Internal to PlanningModule. Not exported from the module barrel.
 *
 * Injection token: OPPORTUNITY_RESEARCH_SERVICE (planning.tokens.ts)
 * Provided by: OpportunityResearchService
 */
export interface IOpportunityResearchService {
  /**
   * Gather evidence for an Opportunity from TimescaleDB and the WKG.
   *
   * Queries TimescaleDB for prior action failures whose contextFingerprint
   * matches the opportunity's contextFingerprint. Queries the WKG for
   * knowledge nodes relevant to the same fingerprint. Assembles these into
   * a ResearchResult that the simulation phase consumes.
   *
   * If fewer than the minimum required prior attempts are found, returns a
   * ResearchResult with hasSufficientEvidence = false. The pipeline does not
   * proceed to simulation in that case.
   *
   * @param opportunity - The opportunity to research.
   * @returns ResearchResult with evidence assessment and context knowledge.
   * @throws {PlanningException} If TimescaleDB or WKG queries fail.
   */
  research(opportunity: Opportunity): Promise<ResearchResult>;
}

// ---------------------------------------------------------------------------
// Interface: ISimulationService
// ---------------------------------------------------------------------------

/**
 * Simulates candidate action outcomes given a ResearchResult.
 *
 * Uses the evidence gathered by IOpportunityResearchService to model what
 * would happen if different action types were applied in the opportunity's
 * context. Does not call the LLM — simulation is graph-data-driven.
 *
 * Internal to PlanningModule. Not exported from the module barrel.
 *
 * Injection token: SIMULATION_SERVICE (planning.tokens.ts)
 * Provided by: SimulationService
 */
export interface ISimulationService {
  /**
   * Simulate candidate outcomes from a ResearchResult.
   *
   * Evaluates plausible action types against the researched evidence to
   * produce SimulatedOutcome entries. Each candidate is scored by expected
   * drive relief, success probability, and information gain. The result
   * identifies the best candidate and flags whether any viable outcome exists.
   *
   * CANON Standard 1 (Theater Prohibition): Simulation must not produce
   * candidates that predict drive relief the system does not actually have.
   * Predicted drive effects must reflect real pressure in the current
   * DriveSnapshot, not hypothetical states.
   *
   * @param research - The assembled ResearchResult from the research phase.
   * @returns SimulationResult with ranked candidates and viability flag.
   * @throws {PlanningException} If the WKG query for action type candidates fails.
   */
  simulate(research: ResearchResult): Promise<SimulationResult>;
}

// ---------------------------------------------------------------------------
// Interface: IConstraintValidationService
// ---------------------------------------------------------------------------

/**
 * Validates a PlanProposal against the six CANON immutable standards and
 * structural integrity constraints before it is committed to the WKG.
 *
 * Uses the LLM as a constraint checker — the LLM did not author the plan and
 * cannot modify it, but it assesses whether the plan's expected outcomes,
 * abort conditions, and action sequence are logically consistent and compliant.
 *
 * Internal to PlanningModule. Not exported from the module barrel.
 *
 * Injection token: CONSTRAINT_VALIDATION_SERVICE (planning.tokens.ts)
 * Provided by: ConstraintValidationService
 */
export interface IConstraintValidationService {
  /**
   * Run a PlanProposal through all active constraint checks.
   *
   * Always checks the six CANON immutable standards. Additionally checks
   * drive isolation (the plan must not include steps that write to the drive
   * evaluation function), provenance integrity (all action steps must carry
   * explicit provenance), and action step validity (all stepTypes must be
   * registered executor handlers).
   *
   * If the LLM call for constraint assessment fails, this method throws
   * rather than returning a passing ValidationResult. Allowing an unvalidated
   * plan to proceed would be a CANON Standard 6 violation.
   *
   * CANON §Dual-Process — Type 2 cost reporting: The LLM call here must
   * report its latency and token cost via IActionOutcomeReporter.reportMetrics()
   * to maintain the cognitive effort pressure signal. This is the caller's
   * responsibility (PlanningService.processOpportunity).
   *
   * @param proposal - The plan proposal to validate.
   * @returns ValidationResult with passed flag, failures, and checked constraints.
   * @throws {PlanningException} If the LLM call or a CANON check throws unexpectedly.
   */
  validate(proposal: PlanProposal): Promise<ValidationResult>;
}

// ---------------------------------------------------------------------------
// Interface: IProcedureCreationService
// ---------------------------------------------------------------------------

/**
 * Commits a validated PlanProposal as a procedure node in the WKG.
 *
 * This is the terminal write in the Planning pipeline. Only called after
 * IConstraintValidationService.validate() returns { passed: true }.
 *
 * CANON §7 (Provenance Is Sacred): The node is written with LLM_GENERATED
 * provenance and confidence 0.35. These values are not negotiable at creation.
 *
 * Internal to PlanningModule. Not exported from the module barrel.
 *
 * Injection token: PROCEDURE_CREATION_SERVICE (planning.tokens.ts)
 * Provided by: ProcedureCreationService
 */
export interface IProcedureCreationService {
  /**
   * Write a validated PlanProposal to the WKG as a procedure node.
   *
   * Creates a node with labels ['Action', 'Procedure'], provenance
   * LLM_GENERATED, and initialConfidence 0.35. The proposal's triggerContext
   * is stored on the node for Decision Making retrieval matching.
   *
   * Also emits a PLAN_CREATED event to TimescaleDB so the full audit trail
   * from OPPORTUNITY_DETECTED through PLAN_CREATED is preserved.
   *
   * @param proposal - The validated plan proposal to commit.
   * @param validation - The passing ValidationResult (caller must verify passed = true).
   * @returns CreatedProcedure with the WKG node ID and provenance metadata.
   * @throws {PlanningException} If the WKG write fails or validation.passed is false.
   */
  create(proposal: PlanProposal, validation: ValidationResult): Promise<CreatedProcedure>;
}

// ---------------------------------------------------------------------------
// ContextFingerprint
// ---------------------------------------------------------------------------

/**
 * A unique signature for a situational context that triggered an Opportunity.
 *
 * Used to group similar opportunities together and query prior attempts in
 * TimescaleDB. The fingerprint identifies the "condition pattern" the system
 * encountered. Multiple identical fingerprints allow the research phase to
 * find evidence and the learning subsystem to refine procedures.
 *
 * CANON §Planning: Context fingerprints enable evidence accumulation for
 * similar situations without explicitly naming or classifying them.
 */
export interface ContextFingerprint {
  /** Primary entity (person, object, concept) involved in the condition. */
  readonly primaryEntity: string;

  /** Related secondary entities (if any) that participated. */
  readonly secondaryEntities: readonly string[];

  /** Situational factors (context, environment, state descriptors). */
  readonly situationalFactors: readonly string[];
}

// ---------------------------------------------------------------------------
// PredictedOutcome
// ---------------------------------------------------------------------------

/**
 * A predicted outcome of a single action, including drive effects and confidence.
 *
 * Used by the simulation phase to describe what would happen if an action
 * type were executed in the opportunity's context.
 */
export interface PredictedOutcome {
  /**
   * Expected changes to drive values if this action succeeds.
   * Partial map: only drives expected to change are included.
   * Positive values = pressure relief (drive satisfied).
   * Negative values = additional pressure (action worsens the drive).
   */
  readonly driveEffects: Partial<Record<DriveName, number>>;

  /**
   * Estimated duration in milliseconds this action would take to execute
   * and see effects. Used for planning horizon and opportunity windows.
   */
  readonly expectedDurationMs: number;

  /**
   * Confidence in this prediction in [0.0, 1.0].
   * Derived from evidence strength and historical accuracy of similar predictions.
   */
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// AbortCondition
// ---------------------------------------------------------------------------

/**
 * A condition under which a procedure should halt execution.
 *
 * Evaluated by the executor during the OBSERVING phase. If any condition
 * becomes true during execution, the procedure is aborted with an
 * ABORT_CONDITION_MET signal.
 */
export interface AbortCondition {
  /**
   * Human-readable condition description.
   * Example: "If the user provides negative feedback"
   * Example: "If anxiety rises above 0.7"
   */
  readonly condition: string;

  /**
   * Numeric threshold for the condition if it measures a scalar value.
   * May be null if the condition is purely boolean.
   */
  readonly threshold?: number;

  /**
   * Action to take if this condition is triggered.
   * Example: "HALT", "SKIP_TO_STEP_3", "RETRY"
   */
  readonly action: string;
}

// ---------------------------------------------------------------------------
// ActionStep
// ---------------------------------------------------------------------------

/**
 * A single step in a procedure's action sequence.
 *
 * Ordered steps are executed sequentially by the executor. Each step may
 * have dependencies (previous steps that must complete first) and fallback
 * steps if the action fails.
 */
export interface ActionStep {
  /** Sequential index of this step in the procedure. */
  readonly order: number;

  /**
   * The action type identifier this step represents.
   * Example: "ConversationalResponse", "QueryWKG", "SetDriveTarget"
   */
  readonly action: string;

  /**
   * Estimated duration in milliseconds for this step's execution.
   * Used for planning total procedure duration and timeout calculations.
   */
  readonly expectedDurationMs: number;

  /**
   * IDs of prior steps that must complete before this one executes.
   * Empty array if no dependencies.
   */
  readonly dependsOn: readonly number[];

  /**
   * Alternative action type to execute if this step fails.
   * Null if no fallback exists (failure terminates the procedure).
   */
  readonly fallback?: string;
}

// ---------------------------------------------------------------------------
// PlanEvaluation
// ---------------------------------------------------------------------------

/**
 * Result of evaluating a created procedure after it has been executed and observed.
 *
 * CANON §Confidence Dynamics: All procedures created by Planning start at 0.35.
 * Confidence increases via ACT-R dynamics as they are successfully retrieved and used.
 * This evaluation type tracks whether execution met expectations and updates confidence.
 */
export interface PlanEvaluation {
  /**
   * Mean Absolute Error for the executed procedure's predictions.
   * Calculated from prediction vs. observed outcome across multiple uses.
   * Value in [0.0, 1.0].
   */
  readonly mae: number;

  /**
   * Number of successful executions of this procedure.
   * Contributes to confidence growth via ACT-R dynamics.
   */
  readonly successCount: number;

  /**
   * Number of failed executions of this procedure.
   * High failure count relative to success triggers demotion or deprecation.
   */
  readonly failureCount: number;

  /**
   * Current confidence after evaluation, reflecting both historical performance
   * and ACT-R recency/frequency effects. Value in [0.0, 1.0].
   */
  readonly newConfidence: number;
}

// ---------------------------------------------------------------------------
// ColdStartConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for cold-start dampening in the Planning subsystem.
 *
 * CANON §Known Attractor States — Prediction Pessimist: Early prediction
 * failures can cascade and demoralize the system. Cold-start dampening
 * reduces plan creation rate until the system has accumulated enough
 * historical data to produce reliable research results.
 */
export interface ColdStartConfig {
  /**
   * Number of opportunities after system start before cold-start dampening is disabled.
   * Value in [0, 1000]. Default: 100.
   */
  readonly threshold: number;

  /**
   * Multiplier applied to plan quality scores during cold start.
   * Value in [0.0, 1.0]. Default: 0.8 (20% reduction in expected value).
   */
  readonly initialDampening: number;

  /**
   * Ramp type: "linear" or "exponential".
   * Linear: dampening decreases uniformly as opportunities increase.
   * Exponential: dampening decreases sharply as threshold approaches.
   * Default: "linear".
   */
  readonly rampType: 'linear' | 'exponential';
}

// ---------------------------------------------------------------------------
// RateLimitConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for the Planning rate limiter.
 *
 * CANON §Known Attractor States — Planning Runaway: Without rate limiting,
 * a cascade of prediction failures can cause unbounded procedure creation.
 * Both per-window and active-plan caps are required defenses.
 */
export interface RateLimitConfig {
  /**
   * Maximum number of plans that can be created within a single time window.
   * Value in [1, 100]. Default: 3.
   */
  readonly maxPlansPerWindow: number;

  /**
   * Duration of the rate-limiter window in milliseconds.
   * Example: 3600000 = 1 hour. Default: 3600000.
   */
  readonly windowDurationMs: number;

  /**
   * Maximum number of active procedures (created but not yet evaluated by Decision Making)
   * that can exist concurrently. Value in [1, 100]. Default: 10.
   */
  readonly maxActivePlans: number;

  /**
   * Maximum token budget per plan for LLM constraint validation.
   * Prevents unbounded token consumption. Default: 4000.
   */
  readonly maxTokensPerPlan: number;
}

// ---------------------------------------------------------------------------
// QueueConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for the opportunity priority queue.
 *
 * CANON §Known Attractor States — Planning Runaway: The queue must apply
 * priority decay so that stale opportunities do not block fresher, higher-impact ones.
 */
export interface QueueConfig {
  /**
   * Maximum number of opportunities the queue can hold before rejecting new ones.
   * Value in [1, 1000]. Default: 50.
   */
  readonly maxSize: number;

  /**
   * Rate at which opportunity priority decays per hour.
   * Value in [0.0, 1.0]. Default: 0.10 (10% per hour).
   * Decay formula: effective_priority = base_priority * (1 - decayRate) ^ hours_in_queue
   */
  readonly decayRatePerHour: number;

  /**
   * Minimum priority threshold below which an opportunity is automatically dropped.
   * Prevents the queue from holding stale, low-priority opportunities indefinitely.
   * Value in [0.0, 0.1]. Default: 0.01.
   */
  readonly minPriorityThreshold: number;
}

// ---------------------------------------------------------------------------
// Interface: IPlanningRateLimiter
// ---------------------------------------------------------------------------

/**
 * Enforces per-window plan creation caps and active-plans limits.
 *
 * CANON §Known Attractor States — Planning Runaway: Without rate limiting,
 * a cascade of prediction failures can cause the Planning subsystem to create
 * an unbounded number of procedure nodes that are never selected for execution.
 * Both the per-window cap and the active-plans cap are required defenses.
 *
 * Internal to PlanningModule. Not exported from the module barrel.
 *
 * Injection token: PLANNING_RATE_LIMITER (planning.tokens.ts)
 * Provided by: PlanningRateLimiterService
 */
export interface IPlanningRateLimiter {
  /**
   * Check whether the planning pipeline may proceed with a new plan.
   *
   * Returns false if either the per-window plan creation cap or the
   * active-plans cap has been reached. Must be called at the start of every
   * processOpportunity() invocation before any I/O.
   *
   * @returns True if the pipeline may proceed; false if rate-limited.
   */
  canProceed(): boolean;

  /**
   * Record that a new plan was successfully created and committed to the WKG.
   *
   * Increments the per-window plan counter and the active-plans counter.
   * Must be called by PlanningService immediately after a successful
   * IProcedureCreationService.create() call.
   */
  recordPlanCreated(): void;

  /**
   * Record that an active plan was evaluated (executed and observed) by
   * Decision Making.
   *
   * Decrements the active-plans counter. Prevents the active-plans cap from
   * being permanently saturated after a batch of plan creations.
   *
   * Called by PlanningService when it receives a PREDICTION_EVALUATED event
   * referencing a Planning-created procedure.
   */
  recordPlanEvaluated(): void;

  /**
   * Return the current rate limiter state for dashboard display and diagnostics.
   *
   * @returns Snapshot of the current RateLimiterState.
   */
  getState(): RateLimiterState;
}

// ---------------------------------------------------------------------------
// Interface: IOpportunityQueueService
// ---------------------------------------------------------------------------

/**
 * Manages the priority queue of opportunities awaiting processing.
 *
 * CANON §Known Attractor States — Planning Runaway: The queue must apply
 * priority decay and the rate limiter must enforce per-window plan creation
 * caps. Without these, Planning generates an unbounded number of low-quality
 * procedures that flood the WKG.
 *
 * Internal to PlanningModule. Not exported from the module barrel.
 *
 * Injection token: OPPORTUNITY_QUEUE (planning.tokens.ts)
 * Provided by: OpportunityQueueService
 */
export interface IOpportunityQueueService {
  /**
   * Add an opportunity to the priority queue.
   *
   * The opportunity is wrapped in a QueuedOpportunity with currentPriority
   * equal to the base priority from the Opportunity itself. As time passes,
   * priority decays according to the configured decay rate.
   *
   * If the queue is at maxSize, the lowest-priority item is evicted to make
   * room for the new entry (unless the new entry's priority is also below
   * minPriorityThreshold, in which case it is rejected entirely).
   *
   * @param opportunity - The opportunity to enqueue
   * @returns true if enqueued; false if rejected due to low priority
   */
  enqueue(opportunity: Opportunity): boolean;

  /**
   * Remove and return the highest-priority opportunity from the queue.
   *
   * Returns null if the queue is empty. The returned opportunity's
   * currentPriority reflects decay applied since enqueueing.
   *
   * @returns The highest-priority QueuedOpportunity, or null if queue is empty
   */
  dequeue(): QueuedOpportunity | null;

  /**
   * Return the current state of the queue without modifying it.
   *
   * Entries are sorted by currentPriority descending (highest priority first).
   * The array is a snapshot — it does not update as the queue changes.
   *
   * @returns Readonly snapshot of all queued opportunities
   */
  getState(): readonly QueuedOpportunity[];

  /**
   * Return the number of opportunities currently in the queue.
   *
   * @returns Current queue size
   */
  size(): number;
}

// ---------------------------------------------------------------------------
// Interface: IPlanProposalService
// ---------------------------------------------------------------------------

/**
 * Assembles and refines PlanProposals from research and simulation results.
 *
 * Responsible for converting the structured output of research and simulation
 * phases into human-readable, constraint-validatable proposals. Also handles
 * proposal revision when the guardian provides corrective feedback.
 *
 * Internal to PlanningModule. Not exported from the module barrel.
 *
 * Injection token: PLAN_PROPOSAL_SERVICE (planning.tokens.ts)
 * Provided by: PlanProposalService
 */
export interface IPlanProposalService {
  /**
   * Assemble a list of PlanProposals from research and simulation results.
   *
   * Takes the structured output of the research and simulation phases and
   * produces one or more ranked proposal candidates. May generate multiple
   * proposals with different action sequences for guardian or LLM review.
   *
   * CANON §Planning: The proposals are constructed from graph data and
   * simulation results — they are not authored by the LLM.
   *
   * @param research - Research result with evidence and context
   * @param simulations - Simulation results with candidate actions
   * @returns Array of PlanProposal candidates, sorted by expected value (highest first)
   */
  propose(research: ResearchResult, simulations: SimulationResult): Promise<readonly PlanProposal[]>;

  /**
   * Revise a proposal based on guardian feedback or constraint validation failures.
   *
   * Takes a proposal and feedback (e.g., constraint failures from the LLM validator)
   * and produces a revised proposal. The revision might alter action steps, abort
   * conditions, or expected outcomes.
   *
   * Revisions are limited by a configurable maximum to prevent infinite loops.
   *
   * @param proposal - The original proposal to revise
   * @param feedback - Feedback reasons for revision (constraint failures, etc.)
   * @returns A revised PlanProposal, or null if revision quota exceeded
   */
  revise(proposal: PlanProposal, feedback: readonly string[]): Promise<PlanProposal | null>;
}

// ---------------------------------------------------------------------------
// Interface: IPlanEvaluationService
// ---------------------------------------------------------------------------

/**
 * Evaluates a procedure's execution against its predictions.
 *
 * Compares actual outcomes to predicted outcomes, calculates prediction accuracy
 * (MAE), and determines whether the procedure should graduate (to Type 1) or be
 * demoted (back to Type 2 or deprecated).
 *
 * Internal to PlanningModule. Not exported from the module barrel.
 *
 * Injection token: PLAN_EVALUATION_SERVICE (planning.tokens.ts)
 * Provided by: PlanEvaluationService
 */
export interface IPlanEvaluationService {
  /**
   * Evaluate a procedure's execution against its historical predictions.
   *
   * Queries TimescaleDB for all execution events (ACTION_EXECUTED, PREDICTION_EVALUATED)
   * tied to this procedure. Calculates MAE, success/failure counts, and derives a new
   * confidence value via ACT-R dynamics.
   *
   * CANON §Confidence Dynamics: Graduates to Type 1 if confidence > 0.80 AND MAE < 0.10
   * over the last 10 uses.
   *
   * @param procedureId - WKG node ID of the procedure to evaluate
   * @param executionData - Observed execution outcomes (predictions vs. reality)
   * @returns PlanEvaluation with updated confidence and performance metrics
   */
  evaluateExecution(
    procedureId: string,
    executionData: { predictedDriveEffects: Partial<Record<DriveName, number>>; observedDriveEffects: Partial<Record<DriveName, number>> },
  ): Promise<PlanEvaluation>;
}

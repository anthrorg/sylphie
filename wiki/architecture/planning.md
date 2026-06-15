# planning — Architecture Reference

> Living document. Last updated: 2026-06-13. Auto-generated from full-file reads (one agent per file); verify before trusting any single line.

**16 files** mapped.

## File-by-file

### `packages/planning/src/`

#### index.ts
*barrel* — Public API facade for Planning subsystem; selectively exports only DI token and service interface.

This is a minimal barrel export that deliberately hides implementation details. It exports three items: PlanningModule (NestJS module to import), PLANNING_SERVICE (DI token), and IPlanningService (type-only interface). All pipeline step tokens, concrete service classes, and internal interfaces are intentionally NOT exported per subsystem encapsulation. This enforces that external consumers can only depend on the published interface, not implementation details.

- **Exports:** `PlanningModule`, `PLANNING_SERVICE`, `IPlanningService`, `PlanningCycleResult`, `PlanOutcomeData`
- **Deps:** `./planning.module`, `./planning.tokens`, `./interfaces/planning.interfaces`
- **Gotchas:** Deliberately restrictive barrel design; internal services (ResearchService, SimulationService, ProposalService, etc.) are not exported and must not be imported externally.

#### planning.module.ts
*module* — NestJS module for Sylphie Planning subsystem (SS5): research -> simulation -> proposal -> validation -> creation pipeline converting Drive-detected opportunities into WKG ActionProcedure nodes.

PlanningModule is the root DI container for the Planning subsystem. It imports DecisionMakingModule (for LLM_SERVICE used by ProposalService) and TimescaleModule. It provides a single public export (PLANNING_SERVICE / PlanningService facade) and eight internal providers: OpportunityQueueService (in-memory queue with decay/rate-limit), ResearchService (TimescaleDB queries), SimulationService (outcome analysis), ProposalService (LLM-assisted generation), ConstraintValidationService (5 deterministic rules, no LLM), ProcedureCreationService (Neo4j WKG write), PlanEvaluationService (post-execution eval), PlanningEventLoggerService (event logging). The module enforces CANON SS no-circular-dependencies: opportunities arrive via TimescaleDB event backbone, not direct injection; does not import Communication/Learning modules.

- **Exports:** `PLANNING_SERVICE`
- **Deps:** `@nestjs/common`, `@sylphie/decision-making`, `@sylphie/shared`, `./planning.tokens`, `./planning.service`, `./queue/opportunity-queue.service`, `./pipeline/research.service`, `./pipeline/simulation.service`, `./pipeline/proposal.service`, `./pipeline/constraint-validation.service`, `./pipeline/procedure-creation.service`, `./evaluation/plan-evaluation.service`, `./logging/planning-event-logger.service`
- **Gotchas:** ConstraintValidationService note says 'LLM, max 3 retries' but comment line 56 states it runs 5 deterministic rule checks with no LLM - comment is correct; inline doc is stale.

#### planning.service.ts
*service* — Maintenance cycle orchestrator that converts drive-detected opportunities into new behavioral procedures through a pipeline.

PlanningService (Injectable) implements the core Planning subsystem (CANON SS5), triggering on two timers: PROCESSING_INTERVAL_MS (30s, dequeue+pipeline) and DECAY_INTERVAL_MS (60s, priority decay/stale-drop). Ingets unprocessed OPPORTUNITY_DETECTED and GUARDIAN_TEACHING_DETECTED events from TimescaleDB, enqueues them via IOpportunityQueue, then executes a 5-stage pipeline (research→simulation→proposal→constraint validation→procedure creation) on the highest-priority opportunity. Guards against concurrent runs with pipelineInFlight flag. Also polls PREDICTION_EVALUATED outcomes post-execution and passes them to planEvaluation for feedback. Guardian teaching opportunities skip the 30s wait and trigger immediate processing. Constraint validation deferral loop auto-retries up to MAX_DEFERRALS=5 on transient failures (e.g. Neo4j unavailability), then drops with loud error to prevent unbounded spin. All cross-subsystem communication flows through TimescaleDB event backbone, never direct injection (CANON §No Circular Dependencies). Rate-limiting enforced by queue via plansCreatedInWindow window. Outcome polling joins PREDICTION_EVALUATED←PREDICTION_CREATED←PLAN_CREATED to match predictions to Planning-created actions, marking processed rows has_plan_evaluated=true.

- **Exports:** `PlanningService`
- **Key constants:** `PROCESSING_INTERVAL_MS=30000`, `DECAY_INTERVAL_MS=60000`, `MAX_INGEST_PER_CYCLE=10`, `MAX_DEFERRALS=5`, `MAX_OUTCOMES_PER_CYCLE=20`
- **Deps:** `@nestjs/common`, `@sylphie/shared (TimescaleService, verboseFor)`, `./interfaces/planning.interfaces`, `./planning.tokens`, `./queue/opportunity-queue.service`
- **Gotchas:** No async/await error in ingestAndProcess catch—logs silently at warn on poll failure. Outcome evaluation is fire-and-forget per row (continues on individual failures). pipelineInFlight flag may not prevent true concurrency if cycle takes >30s; should use explicit lock if stricter guarantee needed. Deferral re-enqueue can fail silently if queue rejects it (duplicate/rate-limit/capacity), opportunity lost for that cycle.

#### planning.tokens.ts
*config* — NestJS dependency injection token registry for PlanningModule

Defines 9 Symbol-based DI tokens for injectable services in the planning subsystem. PLANNING_SERVICE is the sole public API token (re-exported from index.ts); all others are internal to PlanningModule only. Tokens cover: OpportunityQueueService (priority queue with time-decay and deduplication), ResearchService (TimescaleDB queries for event frequency and drive impact), SimulationService (outcome estimation from historical actions), ProposalService (plan generation with optional LLM), ConstraintValidationService (5 deterministic structural checks, retries via LLM refine, base confidence 0.30), ProcedureCreationService (Neo4j WKG writes with INFERENCE provenance), PlanEvaluationService (post-execution outcome logging), and PlanningEventLoggerService (fire-and-forget TimescaleDB event logging for observability). No constants, algorithms, or control flow — pure token declarations.

- **Exports:** `PLANNING_SERVICE`, `OPPORTUNITY_QUEUE`, `RESEARCH_SERVICE`, `SIMULATION_SERVICE`, `PROPOSAL_SERVICE`, `CONSTRAINT_VALIDATION_SERVICE`, `PROCEDURE_CREATION_SERVICE`, `PLAN_EVALUATION_SERVICE`, `PLANNING_EVENT_LOGGER`
- **Gotchas:** All tokens except PLANNING_SERVICE are internal-only and should not be injected outside PlanningModule; strict module boundary enforcement required.

### `packages/planning/src/evaluation/`

#### plan-evaluation.service.ts
*service* — Post-execution evaluation of Planning-created procedures (INFERENCE, TAUGHT_PROCEDURE); logs outcomes and tracks failure streaks.

PlanEvaluationService is a NestJS Injectable that evaluates procedure outcomes by tracking a rolling MAE (Mean Absolute Error) window per procedureId. On evaluateOutcome(), it computes MAE from the outcome (defaulting to 0.05 if predictionAccurate, 0.20 if not), maintains a bounded 10-entry window per procedure, calculates average MAE and consecutive failures, then logs PLAN_EVALUATION or PLAN_FAILURE events to TimescaleDB via eventLogger. Failures are MAE > 0.15 or executionSuccessful=false. When consecutive failures reach 5, the event reason becomes 'persistent_failure', signaling candidates for Drive Engine removal. State is in-memory only (fresh on restart); persistent history belongs in TimescaleDB queries. Thresholds: FAILURE_MAE_THRESHOLD=0.15, MAE_WINDOW_SIZE=10, FAILURE_STREAK_THRESHOLD=5.

- **Exports:** `PlanEvaluationService`
- **Key constants:** `FAILURE_MAE_THRESHOLD=0.15`, `MAE_WINDOW_SIZE=10`, `FAILURE_STREAK_THRESHOLD=5`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `../interfaces/planning.interfaces`, `../planning.tokens`
- **Gotchas:** State is in-memory only; on restart all procedures reset to clean slate. No persistent history in the service itself. Confidence updates are owned by Decision Making's ConfidenceUpdaterService (separate concern).

### `packages/planning/src/interfaces/`

#### planning.interfaces.ts
*type* — Planning subsystem type definitions and service interfaces for the opportunity queue, research, simulation, proposal, validation, and procedure creation pipeline.

Core public facade IPlanningService exposes processNextOpportunity(), getQueueStatus(), and evaluatePlanOutcome(). IOpportunityQueue manages a priority queue with enqueue/dequeue, time-decay, and rate-limiting via recordPlanCreated() deferralCount tracks retry attempts on transient failures (bounded to prevent infinite loops). Pipeline stages: IResearchService (event matching and pattern extraction), ISimulationService (outcome viability with drive effects and confidence), IProposalService (plan generation + refinement on validation failures, triggerContext is a deterministic fingerprint for dedup/retrieval), IConstraintValidationService (Neo4j conflict checks with deferred flag for fail-closed retry), IProcedureCreationService (WKG node creation), IPlanEvaluationService (post-execution outcome tracking with MAE prediction accuracy). PlanningCycleResult stages: NONE/RESEARCH/SIMULATION/PROPOSAL/VALIDATION/CREATED. Logging via IPlanningEventLogger covers 14 event types from OPPORTUNITY_RECEIVED through PLAN_FAILURE.

- **Exports:** `IPlanningService`, `PlanningCycleResult`, `IOpportunityQueue`, `QueuedOpportunity`, `OpportunityQueueStatus`, `IResearchService`, `ResearchResult`, `EventSummary`, `ISimulationService`, `SimulationResult`, `SimulatedOutcome`, `IProposalService`, `PlanProposal`, `IConstraintValidationService`, `ValidationResult`, `IProcedureCreationService`, `IPlanEvaluationService`, `PlanOutcomeData`, `PlanningEventType`, `IPlanningEventLogger`
- **Deps:** `@sylphie/shared (OpportunityCreatedPayload, OpportunityClassification, OpportunityPriority, DriveName, ActionStep)`
- **Gotchas:** QueuedOpportunity.deferralCount is optional and undefined on first intake; ValidationResult.deferred triggers re-queueing on transient failures (e.g., Neo4j unavailability) rather than immediate write to prevent duplicate procedure nodes; PlanProposal.triggerContext must be deterministically derived from contextFingerprint across all paths (template and LLM) to maintain exact-match dedup semantics; no explicit rate limit numeric threshold defined here (deferred to implementation).

### `packages/planning/src/logging/`

#### planning-event-logger.service.ts
*service* — Fire-and-forget event logger for Planning subsystem pipeline observability

PlanningEventLoggerService is a NestJS Injectable that writes PLANNING subsystem events to TimescaleDB. Single method log(eventType, payload, sessionId?) inserts rows into the events table with UUID, timestamp, subsystem='PLANNING', and JSON-serialized payload. Fire-and-forget pattern: errors caught internally and emitted as warn-level logs to prevent TimescaleDB failures from aborting planning cycles. driveSnapshot is hard-coded null (v1 limitation: Planning lacks direct drive state access). session_id defaults to 'planning-internal' when not supplied. schema_version pinned to 1.

- **Exports:** `PlanningEventLoggerService`
- **Key constants:** `subsystem='PLANNING'`, `schema_version=1`, `default_session_id='planning-internal'`
- **Deps:** `@nestjs/common`, `crypto`, `@sylphie/shared (TimescaleService)`, `../interfaces/planning.interfaces (IPlanningEventLogger, PlanningEventType)`
- **Gotchas:** driveSnapshot hardcoded null (known v1 limitation); fire-and-forget silences DB errors rather than propagating; no await/async on INSERT — callers get no feedback on success/failure

### `packages/planning/src/pipeline/`

#### constraint-checks.spec.ts
*test* — Unit tests for five constraint-checking pure functions used by the planning pipeline

Test suite for constraint-checks.ts with zero external dependencies, run via npx tsx. Covers 5 constraint functions: checkStepTypeValidity (validates all step types against VALID_STEP_TYPES set: LLM_GENERATE, WKG_QUERY, TTS_SPEAK, LOG_EVENT), checkAddressesOpportunity (ensures proposal rationale/triggerContext references the opportunity classification/drive/context), checkProcedureConflict (deduplicates proposals by triggerContext, skips when empty/whitespace), checkNoTheatricalBehavior (Theater Prohibition canon: expressive steps LLM_GENERATE/TTS_SPEAK must have non-zero predictedDriveEffects), checkContingencyTracing (validates step params: WKG_QUERY requires "query" non-empty, LLM_GENERATE requires "purpose" or "instruction" non-empty). Includes helper functions makeProposal() and makeOpportunity() to construct test fixtures. Simple custom test runner (describe/it) with pass/fail counters exits 1 on failure.

- **Key constants:** `VALID_STEP_TYPES={LLM_GENERATE,WKG_QUERY,TTS_SPEAK,LOG_EVENT}`
- **Deps:** `./constraint-checks.js`, `@sylphie/shared (DriveName)`, `../interfaces/planning.interfaces.js (PlanProposal, QueuedOpportunity)`
- **Gotchas:** Exact string matching for triggerContext dedup (no partial matches); empty/whitespace triggerContext intentionally skips dedup to avoid poisoning the set; case-insensitive matching in checkAddressesOpportunity; Theater Prohibition explicitly checks for zero drive effects on expressive steps (must be non-zero, not just >0)

#### constraint-checks.ts
*module* — Deterministic pure-function constraint validators for PlanProposal, replacing LLM engine for structural checks per CANON SS5.

Five synchronous constraint checkers: (1) checkStepTypeValidity ensures all steps use valid types from ActionHandlerRegistryService (LLM_GENERATE, WKG_QUERY, TTS_SPEAK, LOG_EVENT); fixes prior bug where EMIT_EVENT was listed but doesn't exist. (2) checkAddressesOpportunity verifies proposal text references the opportunity's classification, affected drive, or context fingerprint. (3) checkProcedureConflict checks for exact-match duplicate trigger contexts in WKG, skips dedup on empty triggers. (4) checkNoTheatricalBehavior enforces CANON Standard 1: plans with expressive steps (LLM_GENERATE, TTS_SPEAK) must have at least one non-zero predicted drive effect. (5) checkContingencyTracing enforces CANON Standard 2: all steps must have non-empty params; WKG_QUERY requires 'query' param, LLM_GENERATE requires 'purpose' or 'instruction'. All functions return ConstraintCheckResult with constraint name, pass/fail boolean, and message.

- **Exports:** `VALID_STEP_TYPES`, `ConstraintCheckResult`, `checkStepTypeValidity`, `checkAddressesOpportunity`, `checkProcedureConflict`, `checkNoTheatricalBehavior`, `checkContingencyTracing`
- **Key constants:** `VALID_STEP_TYPES=['LLM_GENERATE','WKG_QUERY','TTS_SPEAK','LOG_EVENT']`, `EXPRESSIVE_STEP_TYPES=['LLM_GENERATE','TTS_SPEAK']`
- **Deps:** `../interfaces/planning.interfaces (PlanProposal, QueuedOpportunity)`
- **Gotchas:** Empty/whitespace trigger contexts intentionally skip conflict dedup to avoid poisoning dedup key set; predictedDriveEffects populated from simulation.bestOutcome (empty map = zero drive benefit); fuzzy matching deferred to WKG embedding service outside scope of sync check; no I/O or LLM calls, purely deterministic.

#### constraint-validation.service.ts
*service* — Deterministic plan safety and coherence validation via 5 constraint checks; fail-closed on WORLD graph degradation.

ConstraintValidationService validates PlanProposal against 5 deterministic checks: STEP_TYPE_VALIDITY, ADDRESSES_OPPORTUNITY, PROCEDURE_CONFLICT, NO_THEATRICAL_BEHAVIOR, CONTINGENCY_TRACING. Runs synchronous constraint checks via helper functions (constraint-checks). On validation failure, calls ProposalService.refine() to refine proposal (LLM-assisted) and retries up to MAX_RETRIES=3 times. Fetch existing trigger contexts from WORLD graph once before retry loop; if fetch fails (DB unreachable), returns deferred result rather than risking duplicate procedure node corruption. All constraint checks are pure, deterministic, no I/O. Returns ValidationResult with passed/reasoning/violations/attemptsUsed/deferred fields.

- **Exports:** `ConstraintValidationService`
- **Key constants:** `MAX_RETRIES=3`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `../interfaces/planning.interfaces`, `../planning.tokens`, `./constraint-checks`
- **Gotchas:** FAIL-CLOSED design: if Neo4j WORLD fetch fails, defers entire opportunity rather than running validation with empty trigger-context set (would silently re-open duplicate-procedure corruption). Refinement errors are caught and last validation failure returned instead of propagating exception.

#### procedure-creation.service.ts
*service* — Writes validated plans to WKG as ActionProcedure nodes with semantic trigger embeddings and CANON-compliant provenance.

ProcedureCreationService is an injectable NestJS service that converts PlanProposal + QueuedOpportunity into ActionProcedure nodes in the World Knowledge Graph. Core logic: (1) derives semantic trigger phrase from proposal.triggerDescription, guardian instruction, or humanized name (never sha256 hash); (2) embeds trigger phrase via TextEncoder as a nomic DOCUMENT for cosine-retrieval matching; (3) creates Neo4j node with provenance (INFERENCE=0.30 or TAUGHT_PROCEDURE=0.60, resolved via canonical resolveBaseConfidence), actr_count=0, actr_decay_rate=0.06, and confidence ceiling 0.60 until guardian confirms. Uses randomUUID for node_id. Gracefully degrades if TextEncoder unavailable (returns null embedding, fail-closes cosine to 0.0 at retrieval). Logs procedure creation and embeds actionSequence + predictedDriveEffects as JSON strings.

- **Exports:** `ProcedureCreationService`
- **Key constants:** `DECAY_RATE=0.06`, `vlog=verboseFor('Planning')`
- **Deps:** `@nestjs/common`, `crypto.randomUUID`, `@sylphie/shared (Neo4jService, Neo4jInstanceName, verboseFor, resolveBaseConfidence, ProvenanceSource)`, `@sylphie/decision-making (TextEncoder)`, `../interfaces/planning.interfaces (IProcedureCreationService, PlanProposal, QueuedOpportunity)`
- **Gotchas:** TextEncoder is @Optional to gracefully degrade if unavailable. Zero-vector from encoder is treated as failure (encoder unreachable) and persists null. sha256-hash detection in deriveTriggerPhrase prevents broken Jaccard context match (broken when only 64-char hex was stored). Confidence no longer hardcoded—resolveBaseConfidence ensures canonical alignment per CANON.

#### proposal.service.ts
*service* — CANON Subsystem 5 (Planning) — generates concrete action procedure proposals from research and simulation results.

ProposalService implements IProposalService and provides two main methods: propose() generates a PlanProposal from a QueuedOpportunity, ResearchResult, and SimulationResult by invoking LLM-assisted generation (proposeLlm) with fallback to template-based (proposeTemplate) when LLM is unavailable or fails. refine() takes an original proposal and violation constraints, calls refineLlm if LLM available, else returns original. Core algorithm: withStableTrigger() derives a stable, deterministic dedup/retrieval key from opportunity.contextFingerprint and preserves authored trigger text separately in triggerDescription for semantic matching. parseLlmProposal() parses LLM JSON responses (with markdown block extraction fallback) into ActionStep arrays indexed from 0. LLM calls use tier='medium', temperature=0.3, maxTokens=1024, with metadata for auditing. Template fallback emits a two-step sequence: WKG_QUERY to retrieve action procedures by category, then LLM_GENERATE to synthesize response. Injected optional LLM_SERVICE allows graceful lesion testing (read-only fallback). Side effects: logs via NestJS Logger and verboseFor, calls external LLM service.

- **Exports:** `ProposalService`
- **Deps:** `@nestjs/common (Injectable, Inject, Optional, Logger)`, `@sylphie/shared (LLM_SERVICE, verboseFor, ILlmService, ActionStep)`, `../interfaces/planning.interfaces (IProposalService, PlanProposal, QueuedOpportunity, ResearchResult, SimulationResult)`
- **Gotchas:** LLM response parsing uses regex extraction to handle markdown code blocks; fallback proposal has minimal skeleton (single LLM_GENERATE step); refinement path does not validate/regenerate simulation when returning original; triggerContext overwritten to contextFingerprint on ALL paths (including LLM), potentially losing authored context unless preserved in triggerDescription; predictedDriveEffects hardcoded {} in both LLM and template paths, caller must supply it via withStableTrigger's extra param.

#### research.service.ts
*service* — Gathers evidence from TimescaleDB to determine if an opportunity has sufficient supporting evidence to warrant a plan.

ResearchService (CANON SS Subsystem 5) queries TimescaleDB for event frequency matching an opportunity's classification over a 7-day window, evaluates recency (24h counts), and extracts semantic context patterns from event payloads. Core method research() takes a QueuedOpportunity, executes three queries (total frequency, recent occurrences, related event summaries), deduplicates patterns from actionType/predictionType/affectedDrive fields, and compares eventFrequency against SUFFICIENCY_THRESHOLDS. Returns ResearchResult with sufficient flag (true if eventFrequency >= threshold), frequency counts, related event array, and extracted patterns. On error, returns insufficient result (false) to avoid proceeding with bad data.

- **Exports:** `ResearchService`
- **Key constants:** `SUFFICIENCY_THRESHOLDS={PREDICTION_FAILURE_PATTERN: 3, HIGH_IMPACT_ONE_OFF: 1, BEHAVIORAL_NARROWING: 3, GUARDIAN_TEACHING: 0}`, `MAX_RELATED_EVENTS=20`, `RESEARCH_WINDOW_DAYS=7`
- **Deps:** `@nestjs/common (Injectable, Logger)`, `@sylphie/shared (TimescaleService, verboseFor)`, `../interfaces/planning.interfaces (IResearchService, ResearchResult, EventSummary, QueuedOpportunity)`
- **Gotchas:** GUARDIAN_TEACHING classification has threshold 0 (always sufficient if explicitly initiated by guardian). Pattern extraction filters only actionType, predictionType, affectedDrive; other payload fields ignored. Query uses contextFingerprint equality matching with parameterized queries; no full-text search or fuzzy matching. Error handling returns insufficient rather than throwing, silently masking DB failures.

#### simulation.service.ts
*service* — Predicts outcomes of potential behavioral changes by analyzing historical action outcomes.

SimulationService implements ISimulationService and evaluates action viability for drive relief. Public method simulate(opportunity, research) iterates over CANDIDATE_CATEGORIES, calls evaluateCategory() for each to estimate drive effects, sorts by benefit (most negative = most relief), filters by MIN_RELIEF_THRESHOLD (-0.05), and returns viable/outcomes/bestOutcome. Special case: GUARDIAN_TEACHING classification always produces at least one viable outcome (-0.15 relief). Private evaluateCategory(category, affectedDrive, research) queries TimescaleDB for ACTION_OUTCOME_EVALUATED events in the past 14 days, aggregates driveEffects and success counts, returns SimulatedOutcome with avgEffect, successRate, and confidence. No historical data falls back to conservative estimate (confidence 0.2, risk 0.5).

- **Exports:** `SimulationService`
- **Key constants:** `MIN_RELIEF_THRESHOLD=-0.05`, `CANDIDATE_CATEGORIES=[ConversationalResponse,InformationSeeking,SocialEngagement,TaskExecution,SelfRegulation]`, `MAX_OUTCOMES_PER_CATEGORY=50`, `LOOKBACK_DAYS=14`
- **Deps:** `@nestjs/common (Injectable, Logger)`, `@sylphie/shared (TimescaleService, DriveName, verboseFor)`, `../interfaces/planning.interfaces (ISimulationService, SimulationResult, SimulatedOutcome, QueuedOpportunity, ResearchResult)`
- **Gotchas:** No stubs or dead code. Guardian teaching hardcodes -0.15 relief; assumes CognitiveAwareness always co-affected. JSON parsing of payload field can fail silently if malformed; no validation beyond type checks. SuccessRate calculation uses row count but assumes payload["outcome"] values; if missing, defaults to 0 successCount. Risk metric is simple 1.0-successRate with no outlier handling.

### `packages/planning/src/queue/`

#### opportunity-queue.service.spec.ts
*test* — Unit tests for OpportunityQueueService eviction and cap behavior

Tests the hard-cap queue (MAX_QUEUE_SIZE=50) with 9 test cases covering: normal enqueue below cap, eviction when newcomer outranks tail, rejection when newcomer does not outrank tail, tie rejection (strict >, not >=), GUARDIAN_TEACHING priority 1.5 always wins eviction over normal items, event logger emits OPPORTUNITY_DROPPED with reason='evicted_by_higher_priority' on eviction, no event emitted on outright rejection, duplicate fingerprint rejection, and rate-limit bypass for GUARDIAN_TEACHING. Key flow: enqueue checks duplicate fingerprint, compares currentPriority to tail priority, evicts if newcomer > tail, logs event with opportunityId, evictedPriority, replacedById, replacedByPriority. GUARDIAN_TEACHING classification gets priority 1.5 applied at enqueue time. Event logger receives PlanningEventType and payload dict. MockEventLogger tracks calls and filters by event type.

- **Key constants:** `MAX_QUEUE_SIZE=50`, `GUARDIAN_TEACHING_PRIORITY=1.5`, `idCounter starting at 0`
- **Deps:** `./opportunity-queue.service.js`, `../interfaces/planning.interfaces.js`, `@sylphie/shared`
- **Gotchas:** Test helper makeQueued() uses closure idCounter for unique IDs; TypeScript type-casting on makeService to avoid constructor visibility issues; test runner (describe/it) is custom implementation matching constraint-checks.spec.ts pattern, not Jest/Mocha; all tests must pass to exit 0, any failure triggers exit 1

#### opportunity-queue.service.ts
*service* — In-memory priority queue with exponential time-decay for planning opportunities

OpportunityQueueService maintains a sorted queue of planning opportunities, implementing hard-cap eviction (max 50 items), rate limiting (max 3 plans/hour), deduplication by contextFingerprint, and exponential decay applied externally. GUARDIAN_TEACHING items (priority 1.5) always outrank normal items (HIGH=1.0, MEDIUM=0.6, LOW=0.3) and bypass rate limiting. Queue sorted by currentPriority descending; items below DROP_THRESHOLD=0.1 are removed during applyDecay(). When full, newcomer compared against tail; if higher priority, tail evicted and newcomer inserted; otherwise rejected. Decay formula: priority = initialPriority × exp(-0.1 × hoursElapsed). Exports main service class and priorityToNumeric() helper. Logs to eventLogger for dropped opportunities and debug logger.

- **Exports:** `OpportunityQueueService`, `priorityToNumeric`
- **Key constants:** `PRIORITY_DECAY_RATE=0.1`, `DROP_THRESHOLD=0.1`, `GUARDIAN_TEACHING_PRIORITY=1.5`, `MAX_QUEUE_SIZE=50`, `MAX_PLANS_PER_WINDOW=3`, `RATE_LIMIT_WINDOW_MS=3600000`, `HIGH=1.0`, `MEDIUM=0.6`, `LOW=0.3`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `../interfaces/planning.interfaces`, `../planning.tokens`

## Risks / stubs / TODOs

- `packages/planning/src/evaluation/plan-evaluation.service.ts` — State is in-memory only; on restart all procedures reset to clean slate. No persistent history in the service itself. Confidence updates are owned by Decision Making's ConfidenceUpdaterService (separate concern).
- `packages/planning/src/index.ts` — Deliberately restrictive barrel design; internal services (ResearchService, SimulationService, ProposalService, etc.) are not exported and must not be imported externally.
- `packages/planning/src/interfaces/planning.interfaces.ts` — QueuedOpportunity.deferralCount is optional and undefined on first intake; ValidationResult.deferred triggers re-queueing on transient failures (e.g., Neo4j unavailability) rather than immediate write to prevent duplicate procedure nodes; PlanProposal.triggerContext must be deterministically derived from contextFingerprint across all paths (template and LLM) to maintain exact-match dedup semantics; no explicit rate limit numeric threshold defined here (deferred to implementation).
- `packages/planning/src/logging/planning-event-logger.service.ts` — driveSnapshot hardcoded null (known v1 limitation); fire-and-forget silences DB errors rather than propagating; no await/async on INSERT — callers get no feedback on success/failure
- `packages/planning/src/pipeline/constraint-checks.spec.ts` — Exact string matching for triggerContext dedup (no partial matches); empty/whitespace triggerContext intentionally skips dedup to avoid poisoning the set; case-insensitive matching in checkAddressesOpportunity; Theater Prohibition explicitly checks for zero drive effects on expressive steps (must be non-zero, not just >0)
- `packages/planning/src/pipeline/constraint-checks.ts` — Empty/whitespace trigger contexts intentionally skip conflict dedup to avoid poisoning dedup key set; predictedDriveEffects populated from simulation.bestOutcome (empty map = zero drive benefit); fuzzy matching deferred to WKG embedding service outside scope of sync check; no I/O or LLM calls, purely deterministic.
- `packages/planning/src/pipeline/constraint-validation.service.ts` — FAIL-CLOSED design: if Neo4j WORLD fetch fails, defers entire opportunity rather than running validation with empty trigger-context set (would silently re-open duplicate-procedure corruption). Refinement errors are caught and last validation failure returned instead of propagating exception.
- `packages/planning/src/pipeline/procedure-creation.service.ts` — TextEncoder is @Optional to gracefully degrade if unavailable. Zero-vector from encoder is treated as failure (encoder unreachable) and persists null. sha256-hash detection in deriveTriggerPhrase prevents broken Jaccard context match (broken when only 64-char hex was stored). Confidence no longer hardcoded—resolveBaseConfidence ensures canonical alignment per CANON.
- `packages/planning/src/pipeline/proposal.service.ts` — LLM response parsing uses regex extraction to handle markdown code blocks; fallback proposal has minimal skeleton (single LLM_GENERATE step); refinement path does not validate/regenerate simulation when returning original; triggerContext overwritten to contextFingerprint on ALL paths (including LLM), potentially losing authored context unless preserved in triggerDescription; predictedDriveEffects hardcoded {} in both LLM and template paths, caller must supply it via withStableTrigger's extra param.
- `packages/planning/src/pipeline/research.service.ts` — GUARDIAN_TEACHING classification has threshold 0 (always sufficient if explicitly initiated by guardian). Pattern extraction filters only actionType, predictionType, affectedDrive; other payload fields ignored. Query uses contextFingerprint equality matching with parameterized queries; no full-text search or fuzzy matching. Error handling returns insufficient rather than throwing, silently masking DB failures.
- `packages/planning/src/pipeline/simulation.service.ts` — No stubs or dead code. Guardian teaching hardcodes -0.15 relief; assumes CognitiveAwareness always co-affected. JSON parsing of payload field can fail silently if malformed; no validation beyond type checks. SuccessRate calculation uses row count but assumes payload["outcome"] values; if missing, defaults to 0 successCount. Risk metric is simple 1.0-successRate with no outlier handling.
- `packages/planning/src/planning.module.ts` — ConstraintValidationService note says 'LLM, max 3 retries' but comment line 56 states it runs 5 deterministic rule checks with no LLM - comment is correct; inline doc is stale.
- `packages/planning/src/planning.service.ts` — No async/await error in ingestAndProcess catch—logs silently at warn on poll failure. Outcome evaluation is fire-and-forget per row (continues on individual failures). pipelineInFlight flag may not prevent true concurrency if cycle takes >30s; should use explicit lock if stricter guarantee needed. Deferral re-enqueue can fail silently if queue rejects it (duplicate/rate-limit/capacity), opportunity lost for that cycle.
- `packages/planning/src/planning.tokens.ts` — All tokens except PLANNING_SERVICE are internal-only and should not be injected outside PlanningModule; strict module boundary enforcement required.
- `packages/planning/src/queue/opportunity-queue.service.spec.ts` — Test helper makeQueued() uses closure idCounter for unique IDs; TypeScript type-casting on makeService to avoid constructor visibility issues; test runner (describe/it) is custom implementation matching constraint-checks.spec.ts pattern, not Jest/Mocha; all tests must pass to exit 0, any failure triggers exit 1

## Change log
- 2026-06-13 — Initial auto-generated map (16 files read in full).

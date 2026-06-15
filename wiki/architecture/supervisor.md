# supervisor — Architecture Reference

> Living document. Last updated: 2026-06-13. Auto-generated from full-file reads (one agent per file); verify before trusting any single line.

**8 files** mapped.

## File-by-file

### `packages/supervisor/src/`

#### cost-tracker.service.ts
*service* — Tracks daily DeepSeek API spending; enforces daily budget ceiling and self-disables when exhausted

CostTrackerService is a NestJS Injectable that monitors cumulative cost for supervisor API calls against a configurable daily USD budget. Pricing model hardcoded: $0.28/M input tokens, $0.42/M output tokens (DeepSeek as of 2026-04). Core methods: recordCost(inputTokens, outputTokens) accumulates costs and returns false when budget exhausted; hasBudget() checks availability without recording; budgetRemaining() and budgetUsedToday() expose current state. Daily budget defaults to $5.00 USD (SUPERVISOR_DAILY_BUDGET_USD env). Resets costToday counter at midnight UTC via maybeResetDay() check (triggered on every method call). Maintains totalCost across all days. No persistence layer—state lost on restart; no error handling for invalid inputs.

- **Exports:** `CostTrackerService`
- **Key constants:** `SUPERVISOR_DAILY_BUDGET_USD=5.00 (default)`, `DeepSeek input rate=$0.28/M tokens`, `DeepSeek output rate=$0.42/M tokens`
- **Deps:** `@nestjs/common (Injectable, Logger)`, `@nestjs/config (ConfigService)`
- **Gotchas:** No persistence: costToday and totalCost are in-memory only; restart loses state. No validation: malformed token counts (negative, NaN) not guarded. Pricing hardcoded as constants; no pull from config. maybeResetDay() called on every public method; minor perf overhead but acceptable for hourly call frequency. toISOString().slice(0, 10) assumes UTC; system clock skew could cause edge cases at day boundary.

#### index.ts
*barrel* — Public API facade for @sylphie/supervisor NestJS module, exporting only the supervisor interface, service token, and types.

This is a pure barrel export (25 LOC) that exposes three public exports: (1) SupervisorModule—the NestJS module imported into AppModule; (2) SUPERVISOR_SERVICE—the DI token for injecting ISupervisorService; (3) ISupervisorService and related types (DecisionNarration, SupervisorVerdict, SupervisorIntervention, SamplingPolicy, SupervisorStatus, VerdictRating). Also exports SidecarControlService (for sidecar intervention control) and SidecarModelState. Internal implementation services (NarrationBuilderService, CostTrackerService) are intentionally kept private to enforce encapsulation. The module imports DecisionMakingModule to observe the cognitive pipeline's response$ Observable and integrates with DeepSeek reasoning for decision evaluation.

- **Exports:** `SupervisorModule`, `SUPERVISOR_SERVICE`, `ISupervisorService`, `SidecarControlService`, `SidecarModelState`, `DecisionNarration`, `SupervisorVerdict`, `SupervisorIntervention`, `SamplingPolicy`, `SupervisorStatus`, `VerdictRating`
- **Deps:** `./supervisor.module`, `./supervisor.tokens`, `./supervisor.service`, `./sidecar-control.service`, `./interfaces/supervisor.types`
- **Gotchas:** Implementation detail: NarrationBuilderService and CostTrackerService are explicitly NOT exported (only used internally by SupervisorService). SidecarControlService is exported but may be an implementation detail; verify if external callers actually use it.

#### narration-builder.service.ts
*service* — Converts raw CycleResponse into compact DecisionNarration for DeepSeek evaluation.

NarrationBuilderService (Injectable) contains buildNarration() which transforms a CycleResponse into a 300-500 token DecisionNarration. buildNarration() extracts dominant drive (highest positive pressure from pressureVector), builds input summary (arbitration type, latency, grounding, model), and extracts action name, populating DecisionNarration fields (cycleId, timestamp, inputSummary, arbitrationType, actionTaken, responsePreview first 200 chars, dominantDrive, driveSnapshot). Sidecar fields (convergenceScore, globalModelConfidence, panelDivergenceScores) initialized undefined for later population by cognition-service. Helper findDominantDrive() iterates DRIVE_INDEX_ORDER to find max pressure > -Infinity. extractActionName() handles SHRUG arbitration type and TYPE_1 candidates with procedureData names. No DB/network side effects in this service; purely data transformation.

- **Exports:** `NarrationBuilderService`
- **Key constants:** `DRIVE_INDEX_ORDER (used to iterate drives)`, `maxPressure initial=-Infinity`, `responsePreview slice(0,200)`
- **Deps:** `@nestjs/common`, `@sylphie/shared (CycleResponse, DriveName, PressureVector, DRIVE_INDEX_ORDER)`, `./interfaces/supervisor.types (DecisionNarration)`
- **Gotchas:** Sidecar fields convergenceScore/globalModelConfidence/panelDivergenceScores intentionally undefined pending external cognition-service population; outcome fields predictionMAE and guardianFeedback also undefined until reportOutcome fires. No null-safety on cycle.driveSnapshot.pressureVector — assumes shape always present.

#### sidecar-control.service.ts
*service* — HTTP client bridging NestJS supervisor to Python cognition sidecar control channel

SidecarControlService is an injectable NestJS service that routes supervisor interventions (reinforce, correct, freeze, rollback, boost_salience) to the Python cognition-service via HTTP POST endpoints. Retrieves model state snapshots for the player view dashboard. Exports SidecarModelState interface documenting sidecar model hierarchy (global, panels, convergence, deliberation branches with pragmatist/conservative/advocate/synthesis). Implements executeIntervention() which switches on intervention type and POSTs to /cognition/control/* endpoints, forceCheckpoint() for weight saves, and getModelState() for dashboard state queries. Internal post() helper abstracts HTTP layer with 10s timeout, JSON serialization, and error wrapping.

- **Exports:** `SidecarControlService`, `SidecarModelState`
- **Key constants:** `COGNITION_HOST (default: http://localhost:8431)`, `POST_TIMEOUT=10_000ms`, `STATE_TIMEOUT=5_000ms`, `DEFAULT_WEIGHT=1.0`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `@sylphie/shared (verboseFor)`, `./interfaces/supervisor.types (SupervisorIntervention)`
- **Gotchas:** boost_salience intervention type acknowledged as not-yet-implemented on sidecar (lines 92-97); error handling swallows all sidecar network errors gracefully (returns null/false) rather than propagating; model_name and checkpoint_id URL-encoded as query params with fallback defaults

#### supervisor.module.ts
*module* — NestJS module bootstrapping the DeepSeek reasoning supervisor and its internal services.

SupervisorModule is a NestJS @Module that wires the supervisor system: imports DecisionMakingModule (provides DECISION_MAKING_SERVICE and LLM_SERVICE), then declares three providers. SupervisorService is the public facade (exported as SUPERVISOR_SERVICE token); NarrationBuilderService assembles narrative context for reasoning; CostTrackerService tracks API/compute costs. SidecarControlService is also registered. Only SUPERVISOR_SERVICE is exported; internal services are module-scoped. No constants, thresholds, or algorithms—pure DI configuration.

- **Exports:** `SUPERVISOR_SERVICE`
- **Deps:** `@nestjs/common`, `@sylphie/decision-making`, `./supervisor.tokens`, `./supervisor.service`, `./narration-builder.service`, `./cost-tracker.service`, `./sidecar-control.service`
- **Gotchas:** SidecarControlService is registered but not given an explicit token (useClass missing)—relies on class name for injection. NarrationBuilderService and CostTrackerService are both registered by token AND as bare classes (redundant); likely to support both inject(NARRATION_BUILDER_SERVICE) and direct constructor injection patterns.

#### supervisor.service.ts
*service* — DeepSeek reasoning observer for cognitive cycle evaluation; runs async, never blocks hot path.

SupervisorService subscribes to DecisionMakingService.response$ and asynchronously evaluates decision narrations via DeepSeek-reasoner. Implements ISupervisorService with verdict$ Observable, status getters, and policy/intervention APIs. Core flow: (1) samples cycles at configurable rate (1/N), always evaluates GUARDIAN_FEEDBACK, (2) builds DecisionNarration via NarrationBuilderService, (3) calls llm.complete() with SUPERVISOR_SYSTEM_PROMPT (maxTokens=300, temp=0.2, tier=deep), (4) parses JSON verdict (good|acceptable|questionable|wrong + confidence + flag_for_guardian), (5) buffers 100 recent verdicts, emits to verdict$ Subject. Budget-gated by CostTrackerService; enforces CANON §Guardian Asymmetry (supervisor 0.5x weight < guardian 2x/3x). Sampling policy: sampleRate=10 (env), dailyBudgetUsd=5.00 (env), alwaysEvaluate=[guardian_feedback, attractor_alert], burstMode toggle.

- **Exports:** `ISupervisorService`, `SupervisorService`
- **Key constants:** `VERDICT_BUFFER_SIZE=100`, `SUPERVISOR_SAMPLING_RATE=10`, `SUPERVISOR_DAILY_BUDGET_USD=5.00`, `SUPERVISOR_ENABLED=true`, `maxTokens=300`, `temperature=0.2`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `rxjs`, `@sylphie/shared`, `@sylphie/decision-making`, `./narration-builder.service`, `./cost-tracker.service`, `./sidecar-control.service`, `./interfaces/supervisor.types`
- **Gotchas:** TODO at line 280: Expose reasoning_content on LlmResponse interface — DeepSeek reasoning trace not yet accessible. Fire-and-forget onCycleResponse can silently fail if .catch() swallows errors; sidecar intervention failures logged but not retried. parseVerdict regex /\{[\s\S]*\}/ is naive and may over-match. Guardian override mechanism not implemented here; CANON asymmetry exists but Jim's override flow lives elsewhere.

#### supervisor.tokens.ts
*config* — Dependency injection token registry for the Supervisor subsystem

Defines three DI tokens as Symbol exports for use with any DI container: SUPERVISOR_SERVICE (primary token for the supervisor subsystem), NARRATION_BUILDER_SERVICE (for narration builder functionality), and COST_TRACKER_SERVICE (for cost tracking functionality). Each token is a unique Symbol instance. Only SUPERVISOR_SERVICE is documented as the public export for package consumers. File serves as a single source of truth for Supervisor DI token definitions.

- **Exports:** `SUPERVISOR_SERVICE`, `NARRATION_BUILDER_SERVICE`, `COST_TRACKER_SERVICE`

### `packages/supervisor/src/interfaces/`

#### supervisor.types.ts
*type* — Type definitions for supervisor narration, verdicts, interventions, and sampling policies

Defines DecisionNarration (compact ~300-500 token cycle summaries with input/action/outcome), SupervisorVerdict (rating from 'good'/'acceptable'/'questionable'/'wrong' with confidence 0.0-1.0 and optional DeepSeek reasoning_trace), SupervisorCorrection (reinforce/correct/boost_salience actions with reason), SupervisorIntervention (supervisor or guardian actions: reinforce/correct/freeze_model/unfreeze_model/rollback_checkpoint/boost_salience), SamplingPolicy (sampleRate N, alwaysEvaluate event types, burstMode flag, dailyBudgetUsd ceiling), and SupervisorStatus (enabled flag, policy, budget tracking, recent verdicts, flagged count). VerdictRating type literal enum: 'good'|'acceptable'|'questionable'|'wrong'. InterventionType literal enum: 'reinforce'|'correct'|'freeze_model'|'unfreeze_model'|'rollback_checkpoint'|'boost_salience'. All interfaces export from supervisor subsystem for LLM-based corrective training signals and guardian feedback loop.

- **Exports:** `DecisionNarration`, `VerdictRating`, `SupervisorVerdict`, `SupervisorCorrection`, `InterventionType`, `SupervisorIntervention`, `SamplingPolicy`, `SupervisorStatus`
- **Deps:** `@sylphie/shared (PressureVector)`
- **Gotchas:** DecisionNarration.predictionMAE and guardianFeedback optional; convergenceScore/globalModelConfidence/panelDivergenceScores only populated when cognition sidecar running; VerdictRating currently hardcoded to 4 values (no extensibility); dailyBudgetUsd self-disables on exceed but implementation not visible in types; no validation on sampleRate or confidence range bounds in types layer

## Risks / stubs / TODOs

- `packages/supervisor/src/cost-tracker.service.ts` — No persistence: costToday and totalCost are in-memory only; restart loses state. No validation: malformed token counts (negative, NaN) not guarded. Pricing hardcoded as constants; no pull from config. maybeResetDay() called on every public method; minor perf overhead but acceptable for hourly call frequency. toISOString().slice(0, 10) assumes UTC; system clock skew could cause edge cases at day boundary.
- `packages/supervisor/src/index.ts` — Implementation detail: NarrationBuilderService and CostTrackerService are explicitly NOT exported (only used internally by SupervisorService). SidecarControlService is exported but may be an implementation detail; verify if external callers actually use it.
- `packages/supervisor/src/interfaces/supervisor.types.ts` — DecisionNarration.predictionMAE and guardianFeedback optional; convergenceScore/globalModelConfidence/panelDivergenceScores only populated when cognition sidecar running; VerdictRating currently hardcoded to 4 values (no extensibility); dailyBudgetUsd self-disables on exceed but implementation not visible in types; no validation on sampleRate or confidence range bounds in types layer
- `packages/supervisor/src/narration-builder.service.ts` — Sidecar fields convergenceScore/globalModelConfidence/panelDivergenceScores intentionally undefined pending external cognition-service population; outcome fields predictionMAE and guardianFeedback also undefined until reportOutcome fires. No null-safety on cycle.driveSnapshot.pressureVector — assumes shape always present.
- `packages/supervisor/src/sidecar-control.service.ts` — boost_salience intervention type acknowledged as not-yet-implemented on sidecar (lines 92-97); error handling swallows all sidecar network errors gracefully (returns null/false) rather than propagating; model_name and checkpoint_id URL-encoded as query params with fallback defaults
- `packages/supervisor/src/supervisor.module.ts` — SidecarControlService is registered but not given an explicit token (useClass missing)—relies on class name for injection. NarrationBuilderService and CostTrackerService are both registered by token AND as bare classes (redundant); likely to support both inject(NARRATION_BUILDER_SERVICE) and direct constructor injection patterns.
- `packages/supervisor/src/supervisor.service.ts` — TODO at line 280: Expose reasoning_content on LlmResponse interface — DeepSeek reasoning trace not yet accessible. Fire-and-forget onCycleResponse can silently fail if .catch() swallows errors; sidecar intervention failures logged but not retried. parseVerdict regex /\{[\s\S]*\}/ is naive and may over-match. Guardian override mechanism not implemented here; CANON asymmetry exists but Jim's override flow lives elsewhere.

## Change log
- 2026-06-13 — Initial auto-generated map (8 files read in full).

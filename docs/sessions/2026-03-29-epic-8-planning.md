# 2026-03-29 -- Epic 8: Planning (Opportunity-to-Procedure Pipeline)

## Changes
- NEW: src/planning/interfaces/planning.interfaces.ts -- Added 8 types + 3 interfaces (ContextFingerprint, ActionStep, PlanEvaluation, ColdStartConfig, RateLimitConfig, QueueConfig, IOpportunityQueueService, IPlanProposalService, IPlanEvaluationService)
- NEW: src/planning/exceptions/planning.exceptions.ts -- 7 exception classes (PlanningException hierarchy)
- NEW: src/planning/queue/opportunity-queue.service.ts -- Priority queue with exponential decay and cold-start dampening
- NEW: src/planning/proposal/plan-proposal.service.ts -- Plan assembly from simulation candidates with revision support
- NEW: src/planning/evaluation/plan-evaluation.service.ts -- Post-execution MAE evaluation with ACT-R confidence updates
- NEW: src/planning/pipeline/planning-pipeline.service.ts -- 6-stage pipeline orchestrator with error isolation
- MODIFIED: src/planning/planning.service.ts -- Full facade with background queue processing loop
- MODIFIED: src/planning/rate-limiting/planning-rate-limiter.service.ts -- Dual-cap rate limiter (per-window + active plans)
- MODIFIED: src/planning/research/opportunity-research.service.ts -- TimescaleDB + WKG evidence gathering
- MODIFIED: src/planning/simulation/simulation.service.ts -- Candidate generation with conservative sparse-data estimates
- MODIFIED: src/planning/validation/constraint-validation.service.ts -- 4 checkers including all 6 CANON Immutable Standards
- MODIFIED: src/planning/creation/procedure-creation.service.ts -- WKG procedure node creation at LLM_GENERATED/0.35
- MODIFIED: src/shared/types/event.types.ts -- Added 8 planning event types (15 total)
- MODIFIED: src/shared/config/app.config.ts -- Added PlanningConfig (14 env vars)
- NEW: 10 test files -- 159 tests passing (unit + integration)

## Wiring Changes
- PlanningModule now imports EventsModule, KnowledgeModule, CommunicationModule
- 4 new DI tokens: OPPORTUNITY_QUEUE, PLAN_PROPOSAL_SERVICE, PLAN_EVALUATION_SERVICE, PLANNING_PIPELINE_SERVICE

## Known Issues
- E5 trial mechanism dependency: Decision Making needs to select Planning-created procedures for execution
- queryRecentMAEs in PlanEvaluationService returns empty (needs TimescaleDB query for graduation check)

## Gotchas for Next Session
- Event builders use `(createPlanningEvent as any)()` cast due to Extract type inference limits
- Cold-start dampening relies on DECISION_CYCLE_STARTED event frequency count

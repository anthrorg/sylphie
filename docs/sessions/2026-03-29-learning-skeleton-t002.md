# 2026-03-29 -- Learning Module Skeleton (T002)

## Summary
Created complete Learning Module skeleton with DI wiring per Epic 7, Ticket E7-T002. All empty service classes with "Not implemented" throws. Full compilation successful.

## Changes

### NEW
- `src/learning/learning.service.ts` -- Top-level facade for ILearningService (moved from consolidation/)
- `src/learning/consolidation/consolidation.service.ts` -- IConsolidationService (batch selection, pipeline orchestration)
- `src/learning/consolidation/event-ranker.service.ts` -- IEventRankerService (salience ranking)
- `src/learning/consolidation/maintenance-cycle.service.ts` -- IMaintenanceCycleService (full cycle orchestration)
- `src/learning/extraction/` directory -- replaced entity-extraction/, edge-refinement/, contradiction/
  - `entity-extraction.service.ts` -- IEntityExtractionService (moved)
  - `edge-refinement.service.ts` -- IEdgeRefinementService (moved)
  - `contradiction-detector.service.ts` -- IContradictionDetector (moved)
- `src/learning/jobs/` directory -- five learnable jobs
  - `temporal-pattern.job.ts` -- ILearningJob (temporal pattern discovery)
  - `procedure-formation.job.ts` -- ILearningJob (procedure synthesis)
  - `correction-processing.job.ts` -- ILearningJob (guardian correction integration)
  - `sentence-processing.job.ts` -- ILearningJob (sentence fact extraction)
  - `pattern-generalization.job.ts` -- ILearningJob (pattern abstraction)
  - `job-registry.service.ts` -- ILearningJobRegistry (job management)
- `src/learning/metrics/` directory
  - `provenance-health.service.ts` -- IProvenanceHealthService (WKG health assessment)
  - `learning-metrics.service.ts` -- ILearningMetricsService (cycle metrics tracking)

### MODIFIED
- `src/learning/learning.module.ts` -- Full module wiring with 5 imports + 14 providers + 2 exports
- `src/learning/learning.tokens.ts` -- Added 6 new internal tokens (CONSOLIDATION_SERVICE, EVENT_RANKER_SERVICE, MAINTENANCE_CYCLE_SERVICE, PROVENANCE_HEALTH_SERVICE, LEARNING_METRICS_SERVICE, LEARNING_JOB_REGISTRY)
- `src/learning/index.ts` -- Barrel export updated for LEARNING_JOB_REGISTRY

### DELETED
- `src/learning/consolidation/learning.service.ts` (moved to top-level)
- `src/learning/entity-extraction/` directory (moved to extraction/)
- `src/learning/edge-refinement/` directory (moved to extraction/)
- `src/learning/contradiction/` directory (moved to extraction/)

## Wiring Changes

### Module Imports
- DriveEngineModule → DRIVE_STATE_READER (read-only)
- KnowledgeModule → WKG_SERVICE, CONFIDENCE_SERVICE
- EventsModule → EVENTS_SERVICE
- CommunicationModule → LLM_SERVICE (re-exported from shared)
- ConfigModule → learning cycle settings

### DI Wiring Hierarchy
- LearningService (LEARNING_SERVICE) ← DRIVE_STATE_READER, MAINTENANCE_CYCLE_SERVICE
- MaintenanceCycleService ← CONSOLIDATION_SERVICE, EVENT_RANKER_SERVICE
- ConsolidationService ← EVENTS_SERVICE, WKG_SERVICE, LLM_SERVICE, 3x pipeline services
- JobRegistryService (LEARNING_JOB_REGISTRY) ← auto-registers 5 jobs
- ProvenanceHealthService ← WKG_SERVICE
- All extraction services (Entity, Edge, Contradiction) ← no external deps yet

### Public API
- LEARNING_SERVICE -- Decision Making orchestrator
- LEARNING_JOB_REGISTRY -- Testing/diagnostics introspection

### Internal Tokens (not exported)
- CONSOLIDATION_SERVICE, EVENT_RANKER_SERVICE, MAINTENANCE_CYCLE_SERVICE
- ENTITY_EXTRACTION_SERVICE, EDGE_REFINEMENT_SERVICE, CONTRADICTION_DETECTOR
- PROVENANCE_HEALTH_SERVICE, LEARNING_METRICS_SERVICE

## Known Issues
- All services throw "Not implemented" (intentional for T002)
- Job registration not yet wired in JobRegistryService constructor
- No Config loading yet for learning cycle settings

## Gotchas for Next Session (T003+)
1. ConsolidationService constructor has 6 dependencies -- check DI resolution order
2. MaintenanceCycleService locks concurrent cycles with `isRunning()` flag -- race condition test needed
3. Jobs registered via JobRegistry but registration logic not implemented -- T003 will wire this
4. ProvenanceHealthService queries WKG health on every assess call -- may need caching
5. LearningService delegates to MaintenanceCycleService -- verify error propagation paths
6. All pipeline services currently isolated (no cross-calls) -- integration tests needed in T003

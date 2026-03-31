# 2026-03-29 -- Epic 7: Learning (Consolidation Pipeline) Complete

## Changes
- NEW: src/learning/interfaces/learning.interfaces.ts -- Extended with 12 new types + 4 new interfaces
- NEW: src/learning/learning.service.ts -- Public facade (ILearningService)
- NEW: src/learning/consolidation/consolidation.service.ts -- Batch selection + pipeline orchestration
- NEW: src/learning/consolidation/event-ranker.service.ts -- Salience ranking with guardian asymmetry
- NEW: src/learning/consolidation/maintenance-cycle.service.ts -- Pressure-driven cycle with adaptive batching
- NEW: src/learning/extraction/entity-extraction.service.ts -- LLM-assisted with provenance tracking
- NEW: src/learning/extraction/edge-refinement.service.ts -- 8 relationship types, provenance chain
- NEW: src/learning/extraction/contradiction-detector.service.ts -- 4 contradiction types, guardian protection
- NEW: src/learning/jobs/job-registry.service.ts -- Dependency-ordered execution with isolation
- NEW: src/learning/jobs/temporal-pattern.job.ts -- RESPONSE_TO edge detection
- NEW: src/learning/jobs/procedure-formation.job.ts -- Jaccard clustering + LLM abstraction
- NEW: src/learning/jobs/correction-processing.job.ts -- Guardian correction processing with penalties
- NEW: src/learning/jobs/sentence-processing.job.ts -- Splitting + structure + TRIGGERS proposals
- NEW: src/learning/jobs/pattern-generalization.job.ts -- ConceptPrimitive + symbolic decomposition
- NEW: src/learning/metrics/provenance-health.service.ts -- Lesion Test + health metrics
- NEW: src/learning/metrics/learning-metrics.service.ts -- Cycle metrics tracking
- MODIFIED: src/learning/learning.module.ts -- Full DI wiring (5 imports, 14 providers, 2 exports)
- MODIFIED: src/learning/learning.tokens.ts -- 9 DI tokens
- NEW: src/learning/__tests__/learning.spec.ts -- 48 integration tests

## Wiring Changes
- LearningModule now imports: DriveEngineModule, KnowledgeModule, EventsModule, CommunicationModule, ConfigModule
- LearningModule exports: LEARNING_SERVICE, LEARNING_JOB_REGISTRY

## Known Issues
- LLM prompts use JSON parsing; malformed responses fall back gracefully
- WKG methods may not be fully implemented yet; extraction/refinement services wrap calls in try/catch

## Gotchas for Next Session
- Epic 8 (Planning) and Epic 9 (Dashboard) can proceed in parallel; both depend on [2,3,4,5]
- Epic 10 (Integration) depends on all epics including this one

# 2026-03-29 -- Epic 2 & Epic 3 Automated Implementation

## Changes

### Epic 2: Events Module (TimescaleDB Backbone) — 9 tickets
- MODIFIED: src/shared/types/event.types.ts -- Added SYSTEM subsystem source, 4 system event types, validateEventBoundary(), EVENT_TYPE_BOUNDARIES
- MODIFIED: src/events/events.service.ts -- Full implementation: record(), query(), queryLearnableEvents(), queryEventFrequency(), queryPattern(), markProcessed(), markProcessedBatch()
- NEW: src/events/exceptions/events.exceptions.ts -- EventsException, EventValidationError, EventStorageError, EventQueryError, EventNotFoundError
- NEW: src/events/builders/event-builders.ts -- 6 type-safe subsystem builders with compile-time boundary enforcement
- NEW: src/events/__tests__/ -- 144 unit tests (3 test suites)

### Epic 3: Knowledge Module (WKG + Self KG + Other KG) — 10 tickets
- MODIFIED: src/knowledge/wkg.service.ts -- Full Neo4j WKG: upsertNode/Edge, queryContext BFS, contradiction detection, provenance enforcement
- MODIFIED: src/knowledge/confidence.service.ts -- ACT-R formula wrapper, lazy computation, Guardian Asymmetry (2x/3x)
- MODIFIED: src/knowledge/self-kg.service.ts -- Grafeo-backed self-model (capabilities, drive patterns, behavioral patterns)
- MODIFIED: src/knowledge/other-kg.service.ts -- Per-person isolated Grafeo instances with registry pattern
- MODIFIED: src/knowledge/knowledge.module.ts -- Added EventsModule import for event emission
- MODIFIED: src/knowledge/index.ts -- Comprehensive barrel exports
- NEW: src/knowledge/types/ -- self-kg.types.ts, other-kg.types.ts, contradiction.types.ts
- NEW: src/knowledge/services/grafeo-spike/ -- Technology spike validating Grafeo v0.5.28
- NEW: src/knowledge/__tests__/ -- 67 unit tests (5 test suites)

## Wiring Changes
- EventsModule fully functional (no more stubs)
- KnowledgeModule imports EventsModule for event emission
- All knowledge services emit events via injected EVENTS_SERVICE

## Known Issues
- Jim decisions were defaulted (6 items listed in Epic 3 queue.yaml) -- should be reviewed
- Integration tests use mocked Neo4j/Grafeo (no real DB in CI environment)

## Gotchas for Next Session
- Epic 4 (Drive Engine) depends on E2+E3 -- now unblocked
- The 6 defaulted Jim decisions may need review before downstream epics rely on them
- KNOWLEDGE_RETRIEVAL_AND_USE event type was added to event.types.ts during E3

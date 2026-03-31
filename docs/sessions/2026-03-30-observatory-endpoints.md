# 2026-03-30 -- E11-T011: Observatory endpoints (7 analytics APIs)

## Changes
- MODIFIED: src/knowledge/interfaces/knowledge.interfaces.ts -- added VocabularyGrowthDay and PhraseRecognitionStats types; added queryVocabularyGrowth() and queryPhraseRecognition() methods to IWkgService interface
- MODIFIED: src/knowledge/wkg.service.ts -- implemented queryVocabularyGrowth() (Neo4j daily bucket MATCH) and queryPhraseRecognition() (Utterance confidence filter); imported new types
- NEW: src/web/services/observatory.service.ts -- ObservatoryService with 7 analytics methods; injects WKG_SERVICE, TIMESCALEDB_POOL, POSTGRES_RUNTIME_POOL; 5-min TTL cache on vocabulary growth
- MODIFIED: src/web/controllers/metrics.controller.ts -- imported ObservatoryService; added it to constructor; added 7 GET /api/metrics/observatory/* endpoint methods
- MODIFIED: src/web/web.module.ts -- added ObservatoryService to providers; added MetricsModule to imports

## Wiring Changes
- MetricsModule is now imported by WebModule
- ObservatoryService is a plain provider in WebModule (no token — injected directly into MetricsController)
- Two new IWkgService methods route through WkgService to Neo4j; no external service holds the driver directly (CANON boundary maintained)

## Known Issues
- getDevelopmentalStage() returns empty sessions until Decision Making writes TYPE_1_DECISION/TYPE_2_DECISION events (instrumentation gap documented in epic-11-sentinel-analysis.md §2.4)
- getComprehensionAccuracy() returns empty sessions until Decision Making writes PREDICTION_EVALUATED events (same gap, §2.6)
- Both endpoints degrade gracefully to empty arrays in the interim

## Gotchas for Next Session
- Cypher CASE expression in queryPhraseRecognition uses standard SQL CASE syntax — valid in Neo4j 5 Cypher
- Drive evolution SQL extracts from drive_snapshot->'pressureVector'->>'driveName'; if DriveEngine writes the snapshot at a different nesting level the query returns NULLs for all drive columns (check with a raw SELECT on a DRIVE_TICK event)
- MetricsModule imports DriveEngineModule internally — adding it to WebModule imports creates a second import chain to DriveEngineModule, which NestJS handles correctly via module caching

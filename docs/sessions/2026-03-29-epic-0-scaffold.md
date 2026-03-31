# 2026-03-29 -- Epic 0: Scaffold + Full Interface Skeleton

## Changes
- NEW: 91 TypeScript files across 38 directories — full NestJS monolith skeleton
- NEW: package.json, tsconfig.json, ESLint/Prettier configs, nest-cli.json
- NEW: docker-compose.yml (Neo4j, TimescaleDB, PostgreSQL) + .env.example (42 vars)
- NEW: src/shared/ — 9 type files, config, exceptions, SharedModule, barrel
- NEW: src/events/ — IEventService (7 methods), stub, module
- NEW: src/knowledge/ — 4 interfaces (IWkgService 14 methods, ISelfKgService, IOtherKgService, IConfidenceService), stubs, module
- NEW: src/drive-engine/ — 4 interfaces (IDriveStateReader read-only, IActionOutcomeReporter, IRuleProposer, IDriveProcessManager), stubs, module
- NEW: src/decision-making/ — 7 interfaces, stubs in subdirectories, module
- NEW: src/communication/ — 6 interfaces + ILlmService (in shared), stubs, module
- NEW: src/learning/ — 4 interfaces (ExtractedEntity.provenance literal 'LLM_GENERATED'), stubs, module
- NEW: src/planning/ — 6 interfaces, stubs in subdirectories, module
- NEW: src/web/ — 5 controllers, 3 gateways, module
- MODIFIED: src/app.module.ts — imports all 9 modules

## Wiring Changes
- AppModule imports: SharedModule, EventsModule, KnowledgeModule, DriveEngineModule, DecisionMakingModule, CommunicationModule, LearningModule, PlanningModule, WebModule
- SharedModule is @Global() — ConfigModule available everywhere
- ILlmService + LLM_SERVICE token live in shared (not communication)
- Drive clamping: [-10.0, 1.0] (extended relief)

## Known Issues
- All service methods throw 'Not implemented' (by design — filled in E1-E9)
- NEO4J_DRIVER factory returns null (real driver in E1)
- Module cross-imports (KnowledgeModule in Learning, etc.) commented out until real implementations exist

## Gotchas for Next Session
- tsconfig.json has `include: ["src/**/*"]` to exclude `packages/` directory
- ConfidenceService has 3 methods already implemented (pure function wrappers)
- DriveReaderService returns INITIAL_DRIVE_STATE as cold-start default
- OpportunityClassification exists in both ipc.types.ts and drive-engine interfaces (different values, intentional)

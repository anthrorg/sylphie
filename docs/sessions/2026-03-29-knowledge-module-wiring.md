# 2026-03-29 -- KnowledgeModule wiring and cross-module integration (E3-T009)

## Changes
- MODIFIED: `src/knowledge/knowledge.module.ts` -- Added EventsModule import; KnowledgeModule now properly depends on EventsModule for IEventService
- MODIFIED: `src/knowledge/index.ts` -- Fixed barrel exports: removed NEO4J_DRIVER export (internal-only), added knowledge-specific domain types from types/ subdirectory, added clarifying comment about driver isolation

## Wiring Changes
- KnowledgeModule imports EventsModule to satisfy WkgService and ConfidenceService dependencies on EVENTS_SERVICE
- One-way dependency: EventsModule does NOT import KnowledgeModule (respects CANON §Drive Isolation)
- Import order in AppModule: EventsModule → KnowledgeModule (correct order for DI resolution)
- All four service tokens properly exported: WKG_SERVICE, SELF_KG_SERVICE, OTHER_KG_SERVICE, CONFIDENCE_SERVICE

## Verification
- TypeScript type check: `npx tsc --noEmit` passes with no errors
- No circular dependencies detected
- All service interfaces properly typed and exported
- No concrete implementation classes exported from barrel (only tokens and types)

## Known Issues
- None

## Gotchas for Next Session
- NEO4J_DRIVER is intentionally NOT exported from the barrel. Only WkgService holds a reference to the driver. Consumers must use WKG_SERVICE instead.
- EventsModule must remain the only module that provides EVENTS_SERVICE. It is a singleton across the entire application.
- If a new service in KnowledgeModule needs to emit events, it MUST inject EVENTS_SERVICE via the token and KnowledgeModule already provides access.

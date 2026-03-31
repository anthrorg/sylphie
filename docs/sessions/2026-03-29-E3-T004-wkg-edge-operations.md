# 2026-03-29 -- E3-T004: WKG Edge Operations & Contradiction Detection

## Changes

- **MODIFIED: `src/knowledge/wkg.service.ts`**
  - Implemented `upsertEdge(request)` with full persistence semantics: provenance validation, confidence ceiling enforcement (0.60), edge creation via APOC, fire-and-forget contradiction checking
  - Implemented `queryEdges(filter)` with sourceId/targetId/relationship/provenance filtering and configurable confidence threshold (default 0.50)
  - **NEW: Private method `checkContradictions()`** — Piaget-inspired developmental catalyst pattern: queries existing edges between same nodes, computes severity (confidence diff), creates CONTRADICTS meta-edges if severity > 0.20, emits CONTRADICTION_DETECTED events asynchronously
  - Added imports: `randomUUID`, `IEventService`, `EVENTS_SERVICE` token for event emission

## Wiring Changes

- WkgService now depends on IEventService (injected via EVENTS_SERVICE token) for async contradiction event emission
- Fire-and-forget event emission: errors during event recording are logged but do not block the upsert operation (per CANON Atlas risk 7 pattern)
- APOC `apoc.create.relationship()` enables dynamic relationship type handling (Neo4j doesn't support variable rel types in MERGE)

## Known Issues

- APOC assumes it is installed in Neo4j instance. If not available, upsertEdge will fail at runtime.
- checkContradictions uses a placeholder driveSnapshot (all drives = 0.5) since WkgService has no access to the drive engine. This is acceptable for a fire-and-forget operation; real drive state should come from the calling context if precision is needed.

## Gotchas for Next Session

- Event emission in checkContradictions does not validate the SylphieEvent contract due to IEventService accepting `Omit<SylphieEvent, 'id' | 'timestamp'>`. Type assertion (`as any`) used temporarily; clean this up if stronger typing is needed.
- LIMIT clause in queryEdges uses direct template literal for optional limit (not parameterized). This is safe because the limit comes from the internal filter type (immutable), but consider parameterization if filter becomes user-input-driven.
- elementId() is Neo4j 5+ syntax. Verify the deployment uses Neo4j 5+.

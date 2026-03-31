# Epic 0: Scaffold + Full Interface Skeleton

## Summary

Build the complete NestJS project skeleton with all shared types, all module interfaces, all DI tokens, and all stub service classes. `npx tsc --noEmit` passes at completion. No real implementations -- every subsequent epic fills in code behind already-compiling interfaces.

## Why Skeleton-First

1. NestJS DI requires all module imports/exports defined upfront -- circular dependencies found in stubs, not running code
2. The architecture is fully specified (CANON + agent profiles) -- we know every interface shape
3. Every subsequent epic becomes "implement behind a compiling interface" -- no surprises
4. Any agent can work on any epic without guessing adjacent module exports

## Ticket Summary (13 tickets)

| ID | Title | Complexity | Dependencies |
|----|-------|-----------|-------------|
| E0-T001 | Project scaffold (package.json, tsconfig, bootstrap) | S | - |
| E0-T002 | Docker Compose and .env.example | S | - |
| E0-T003 | Shared types: provenance, confidence, drive | M | T001 |
| E0-T004 | Shared types: events, knowledge, action, IPC, LLM, metrics | L | T003 |
| E0-T005 | Shared config and exceptions | M | T003, T004 |
| E0-T006 | Events module stub | S | T004 |
| E0-T007 | Knowledge module stubs | L | T004, T005 |
| E0-T008 | Drive engine module stubs | M | T003, T004 |
| E0-T009 | Decision making module stubs | M | T004, T005 |
| E0-T010 | Communication module stubs | M | T004, T005 |
| E0-T011 | Learning module stubs | S | T004, T005 |
| E0-T012 | Planning module stubs | S | T004, T005 |
| E0-T013 | Web module stubs + AppModule wiring + final verification | M | T006-T012 |

## Parallelization

```
T001, T002 (parallel -- scaffold + docker)
  |
  v
T003 (foundational types)
  |
  v
T004 (dependent types)
  |
  v
T005 (config + exceptions)
  |
  +---+---+---+---+---+---+
  |   |   |   |   |   |   |
  v   v   v   v   v   v   v
 T006 T007 T008 T009 T010 T011 T012  (all module stubs -- parallelizable)
  |   |   |   |   |   |   |
  +---+---+---+---+---+---+
  |
  v
 T013 (final wiring + verification)
```

## Key Design Decisions

1. **ILlmService lives in src/shared/**, not communication. Planning and Learning need it without cross-subsystem imports.

2. **ArbitrationResult is a discriminated union** (TYPE_1 | TYPE_2 | SHRUG), not nullable. SHRUG is first-class.

3. **DriveSnapshot enriched beyond raw PressureVector.** Includes timestamp, tickNumber, driveDeltas, ruleMatchResult per Ashby's feedback loop analysis. Without derivatives, 4/6 attractor states can't be detected early.

4. **Centralized EventType enum.** Single source of truth for all event type strings. Prevents stigmergic channel breakage from naming mismatches.

5. **Two PostgreSQL pools** (admin + runtime). Runtime pool (`sylphie_app`) has SELECT on drive_rules, INSERT on proposed_drive_rules only.

6. **Grafeo stub interface only.** `@grafeo-db/js` v0.5.28 exists but is pre-1.0. Define interface, defer real integration to E1.

7. **UpsertResult is discriminated union** (success | contradiction). Contradiction detection returns data, doesn't throw.

8. **All 7 CANON health metrics have first-class TypeScript types.** Not derived -- defined.

## Agent Analyses

See `agent-analyses/` for full perspectives from:
- **Forge**: Module structure, 75-file directory tree, 25 DI tokens, 25 interfaces
- **Sentinel**: Docker infra, 42 env vars, Grafeo assessment, two-pool PostgreSQL
- **Atlas**: 17 IWkgService methods, 5-layer isolation enforcement, 7 risks
- **Canon**: 14 structural corrections, 3 decisions for Jim, CANON compliance checklist
- **Ashby**: 15 feedback loops, requisite variety, attractor observability, DriveSnapshot enrichment

## Decisions Needed from Jim

1. **CANON A.2 (Episodic Memory)**: Approve Episode schema for IEpisodicMemoryService signatures
2. **CANON A.3 (Arbitration)**: Approve dynamic threshold formula for IArbitrationService
3. **CANON A.6 (LLM Context)**: Confirm context assembly components for ILlmService

Recommended defaults are provided in `wiki/roadmap.md` Spec Gaps table. If approved, E0 proceeds with those defaults.

## v1 Sources

| v1 File | v2 Destination | Lift Type |
|---------|---------------|-----------|
| `shared/src/pressure.types.ts` | `shared/types/drive.types.ts` | Rename + type tighten |
| `shared/src/instance-confidence.ts` | `shared/types/confidence.types.ts` | Direct port (pure functions) |
| `orchestrator/action.types.ts` | `shared/types/action.types.ts` | Adapt |
| `orchestrator/pressure-source.interface.ts` | `drive-engine/interfaces/` | Adapt to IDriveStateReader |
| `graph/graph-persistence.interface.ts` | `knowledge/interfaces/` | Split into 3 interfaces |
| `orchestrator/executor-engine.service.ts` | `decision-making/interfaces/` | Extract interface from class |

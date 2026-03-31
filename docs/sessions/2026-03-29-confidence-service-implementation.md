# 2026-03-29 -- E3-T005: ConfidenceService Implementation

## Changes
- **MODIFIED: `src/knowledge/confidence.service.ts`** -- Replaced stub with real ACT-R wrapper (200+ lines)
  - `compute(params)` → transparent wrapper over pure `computeConfidence()` formula
  - `recordUse(nodeId, success)` → loads node ACT-R params, increments count on success, updates lastRetrievalAt, recomputes confidence, persists to Neo4j, emits KNOWLEDGE_RETRIEVAL_AND_USE event
  - `checkCeiling(confidence, count)` → enforces CANON Standard 3 (no knowledge > 0.60 without retrieval)
  - `applyGuardianWeight(delta, type)` → transparent wrapper over pure function (Standard 5: 2x confirmation, 3x correction)
  - `batchRecompute(nodeIds)` → batch confidence refresh for maintenance cycles; reads all nodes, recomputes, persists in single transaction
  - `getConfidenceDebugInfo(nodeId)` → new debug utility returning all ACT-R params, intermediate formula terms, ceiling state
  - `getDefaultDriveSnapshot()` → private helper creating default drive snapshot from INITIAL_DRIVE_STATE for system events

- **MODIFIED: `src/shared/types/event.types.ts`** -- Added KNOWLEDGE_RETRIEVAL_AND_USE event type
  - Updated EventType union to include 'KNOWLEDGE_RETRIEVAL_AND_USE'
  - Updated EVENT_BOUNDARY_MAP to route event to LEARNING subsystem
  - Documented event in typedoc comments (now 6 Learning types instead of 5)

## Wiring Changes
- ConfidenceService now injects NEO4J_DRIVER and EVENTS_SERVICE via InjectionTokens
- recordUse() emits KNOWLEDGE_RETRIEVAL_AND_USE events as LearnableEvent (hasLearnable=true, salience=newConfidence)
- Events use default DriveSnapshot to maintain CANON §Drive Isolation (KnowledgeModule cannot import DriveEngineModule)

## Known Issues
- Drive snapshot on KNOWLEDGE_RETRIEVAL_AND_USE events is always INITIAL_DRIVE_STATE (system default) rather than actual drive state. This is intentional per CANON §Drive Isolation but may complicate drive analysis of retrieval patterns.
- Theater Prohibition (CANON Standard 1) does not apply to system events like knowledge retrieval (only user-facing output). If this changes, will need to revise event emission strategy.

## Gotchas for Next Session
- Do NOT modify computeConfidence() or applyGuardianWeight() — they are pure and protected (Standard 6)
- recordUse() only increments count if success=true; lastRetrievedAt always updates (triggers decay even on failures)
- Neo4j queries use elementId() for element IDs (not 'id' property) per Neo4j 5+ behavior
- DriveSnapshot construction requires all 12 drive deltas with camelCase keys matching DriveName enum values

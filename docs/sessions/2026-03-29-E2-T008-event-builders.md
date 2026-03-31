# 2026-03-29 -- E2-T008: Event Builder Utilities

## Changes
- NEW: `src/events/builders/event-builders.ts` -- Type-safe event builder functions for all six subsystems
- NEW: `src/events/builders/index.ts` -- Barrel export for builders module
- MODIFIED: `src/events/index.ts` -- Export builders from module API

## Design
Each builder function enforces compile-time subsystem ownership via TypeScript's `Extract` utility:
- `createDecisionMakingEvent(type: DecisionMakingEventType, opts)` — only emits DECISION_MAKING events
- `createCommunicationEvent(type: CommunicationEventType, opts)` — only emits COMMUNICATION events
- `createLearningEvent(type: LearningEventType, opts)` — only emits LEARNING events
- `createDriveEngineEvent(type: DriveEngineEventType, opts)` — only emits DRIVE_ENGINE events
- `createPlanningEvent(type: PlanningEventType, opts)` — only emits PLANNING events
- `createSystemEvent(type: SystemEventType, opts)` — only emits SYSTEM events

Each builder:
1. Auto-sets `subsystem` (from EVENT_BOUNDARY_MAP)
2. Auto-sets `timestamp` to current Date (creation time)
3. Auto-sets `schemaVersion` to 1
4. Accepts required: `sessionId`, `driveSnapshot`
5. Accepts optional: `correlationId`, `provenance`, `data`
6. Returns `Omit<SylphieEvent, 'id'>` (matches IEventService.record() contract)

All exported types are pure TypeScript — zero NestJS dependencies.

## Verification
- TypeScript compilation: `npx tsc --noEmit` — zero errors
- All imports in `src/events/index.ts` properly resolved
- Extract utility enforces subsystem boundaries at compile time

## Known Issues
- Event-specific payload fields (e.g., actionId for ACTION_EXECUTED) are not enforced by the builder. Callers must include the correct fields based on event type. Future: extend builders with type-specific overloads if needed.

## Gotchas
- The builders return `Omit<SylphieEvent, 'id'>` which includes the `timestamp` field. The DB will override this on persistence, but builders set it for the event record to capture creation time.
- Event-specific data should be attached via the `data` field; subsystems calling record() must cast/extend if they need type-specific fields like `actionId` or `predictionId`.

# Idea: Forward Drive Events to TimescaleDB Event Backbone

**Created:** 2026-04-09
**Status:** proposed

## Summary

In `DriveProcessManagerService` (`packages/drive-engine/src/drive-process/drive-process-manager.service.ts`, line 201), the `DRIVE_EVENT` IPC message handler only logs the event type and drive name but does not forward the event to TimescaleDB. The TODO comment states this should be forwarded to the "event backbone."

## Motivation

Drive events (rule firings, accumulations, state transitions) are critical for debugging, auditing, and the Observatory dashboard. Without TimescaleDB persistence, these events are lost after they scroll out of the NestJS log buffer. The event backbone is meant to provide a queryable timeline of drive activity — without this forwarding, that timeline has a blind spot for events originating in the drive child process.

## Subsystems Affected

- **drive-engine** — `DriveProcessManagerService` needs to inject the TimescaleDB writer (or a dedicated event logger service) and forward DRIVE_EVENT payloads.
- **shared** — May need a shared event schema for drive events in TimescaleDB.

## Open Questions

- Should drive events use the same `IDecisionEventLogger` as decision-making events, or a separate logger?
- What's the expected volume of drive events per tick? Need to ensure TimescaleDB writes don't create backpressure on the IPC channel.
- Should events be batched or written individually?

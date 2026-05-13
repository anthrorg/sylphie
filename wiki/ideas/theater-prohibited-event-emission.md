# Idea: Emit THEATER_PROHIBITED Events to TimescaleDB Instead of Stderr Only

**Created:** 2026-04-27
**Status:** proposed

## Summary

`DriveEngine.emitTheaterProhibitedEvent` (`packages/drive-engine/src/drive-process/drive-engine.ts`, lines 689-696) only writes a stderr log when a theater violation is detected. The body of the function is effectively empty: "Event is logged to stderr above. Could also emit via event emitter or TimescaleDB if those systems are available. For now, the stderr log provides visibility into theater prohibitions." Theater prohibitions are not persisted to the event backbone.

## Motivation

CANON Immutable Standard 1 (Theater Prohibition) states: "The system cannot learn to perform emotions it does not have." For that contract to be auditable, every theater-prohibited event must be a first-class event on the TimescaleDB backbone -- queryable, joinable with reinforcement records, and visible to the Supervisor. Today, theater prohibitions disappear into stderr where they cannot be counted, correlated with action outcomes, or used to verify that zero-reinforcement was actually applied. This is one of the six safety-critical contracts in the system; visibility into its enforcement should match its importance.

## Subsystems Affected

- **drive-engine** -- `drive-engine.ts emitTheaterProhibitedEvent` needs to forward the event to the existing IPC channel that the parent process drains into TimescaleDB (the same path used for drive events), or directly to `timescale-writer.ts`.
- **decision-making** / **supervisor** -- Once the event is on the backbone, the Supervisor can include theater prohibitions in its evaluation queue and the Decision Making subsystem can verify that the corresponding reinforcement was zeroed.

## Open Questions

- Should theater-prohibited events use the Drive Engine's existing IPC -> parent -> TimescaleDB path, or a dedicated channel given their safety-critical nature?
- What payload shape does the event need (offending response, drive snapshot, expected vs actual sentiment, action ID)?
- Should this be one of the `alwaysEvaluate` events in the Supervisor sampling policy?

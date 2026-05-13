# Idea: Populate correlation_id on Drive Events Written to TimescaleDB

**Created:** 2026-04-27
**Status:** proposed

## Summary

`TimescaleWriter` (`packages/drive-engine/src/drive-process/timescale-writer.ts`, line 193) hardcodes `correlation_id` to `null` for every drive event it inserts, with the comment "correlation_id (NULL for now; could be added later)". As a result, drive-engine events on the TimescaleDB backbone cannot be joined with the decision cycles, action outcomes, or reinforcement events that produced them.

## Motivation

The TimescaleDB backbone is the audit trail for Sylphie's behavior. Its value comes from being able to reconstruct a coherent timeline -- "decision cycle X produced action Y, which caused drive deltas Z, which fed back into reinforcement W." Without a correlation_id on drive events, that join is impossible: drive events and decision events live in the same table but have no shared key. This makes it hard to debug behavior, verify the contingency requirement (Standard 2 -- every reinforcement traces to a behavior), or compute MAE between predicted and observed drive deltas for a specific action.

## Subsystems Affected

- **drive-engine** -- `timescale-writer.ts` needs to accept correlation_id from the event source. The IPC payload from the parent process (action outcomes, decision cycles) already carries correlation IDs that should propagate to the resulting drive event.
- **decision-making** / **planning** -- Callers that originate the IPC message should attach their cycle/action correlation ID so it survives the round trip through the child process.

## Open Questions

- Where in the Drive Engine pipeline is the correlation_id available -- on the inbound action-outcome message, in the rule-application result, or both?
- Should drive-tick events without an originating action carry a synthetic correlation_id (e.g., the tick UUID), or remain NULL?
- Do existing TimescaleDB indexes need to be extended to make correlation_id efficient for joins?

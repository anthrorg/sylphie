# Idea: Add Jitter and Replace Recursive Retry in Recovery Mechanism

**Created:** 2026-04-09
**Status:** proposed

## Summary

The `RecoveryMechanism` in `packages/drive-engine/src/ipc-channel/recovery.ts` uses a recursive `attemptRecovery()` call on failure (line 158) and has no jitter in its exponential backoff. The recursion is bounded by `maxRetries` but risks stack growth if the guard fails or is raised, and the lack of jitter creates a thundering-herd problem when multiple Drive Engine instances reconnect simultaneously.

## Motivation

Two related issues in the current recovery logic:

1. **Recursive retry:** When a reconnect attempt fails, the `catch` block calls `return this.attemptRecovery()` recursively. While `maxRetries` (default 3) limits depth today, any future increase or off-by-one error turns this into unbounded recursion. An iterative loop (`while (attemptCount < maxRetries)`) is safer and easier to reason about.

2. **No jitter on backoff:** The delay sequence is deterministic (1s → 2s → 4s → …). In a multi-instance deployment, all instances that crash at the same time will retry at the same instant, amplifying load on the Drive Engine server. Adding randomized jitter (e.g., ±25% of the computed delay) spreads reconnection attempts and reduces thundering-herd pressure.

Secondary observations:
- `wsChannel.incrementReconnectCount()` is called on line 134 but does not appear to be defined or exported on `WsChannelService`. This should be verified and either implemented or removed.
- `pendingMessageCount` in `getState()` is hardcoded to `0` — it should pull from the actual `OutcomeQueue.size()` to give operators real visibility.

## Subsystems Affected

- `drive-engine` — `ipc-channel/recovery.ts`
- `drive-engine` — `ipc-channel/ws-channel.service.ts` (incrementReconnectCount verification)

## Open Questions

- Should jitter be configurable, or is a fixed ±25% of the backoff delay sufficient?
- Is there a preferred observability pattern (e.g., structured log fields, metrics counter) for tracking recovery attempts and safe-mode entries?
- Should the recovery mechanism integrate with the existing `OutcomeQueue` to report `pendingMessageCount` accurately?

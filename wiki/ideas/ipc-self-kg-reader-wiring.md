# Idea: Wire IPCSelfKgReader for Real KG(Self) Access in Drive Process

**Created:** 2026-04-09
**Status:** proposed

## Summary

The Drive Engine child process uses a `FallbackSelfKgReader` (`packages/drive-engine/src/drive-process/database-clients.ts`) that returns empty/neutral data for all KG(Self) queries. The `IPCSelfKgReader` class exists as a skeleton but is entirely unimplemented. This means the self-evaluation loop runs without actual capability data, drive patterns, or prediction accuracy — it cannot adjust baselines.

## Motivation

CANON §E4-T008 specifies that KG(Self) reads should occur on a slower timescale (every 10 ticks). The self-evaluation circuit in the drive process uses these readings to adjust drive baselines based on self-assessed capabilities. With the fallback adapter returning empty arrays and null, the baseline adjustment logic is effectively disabled — the system cannot learn from its own performance history. The `FallbackSelfKgReader` was intended as a Phase 1 stand-in, and the code explicitly documents it should be replaced when IPC infrastructure is ready.

## Subsystems Affected

- **drive-engine** — `IPCSelfKgReader` needs full implementation: initialize IPC channel, send query messages (IPC_QUERY_SELF_KG_CAPABILITIES, IPC_QUERY_SELF_KG_PATTERNS, IPC_QUERY_SELF_KG_PREDICTION_ACCURACY), handle timeouts.
- **apps/sylphie** — Main process needs IPC message handlers to receive and respond to KG(Self) queries from the drive child process.
- **shared** — IPC message types for KG(Self) queries may need to be defined.

## Open Questions

- Is the IPC WebSocket channel (`ws-channel.service.ts`) already capable of request/response patterns, or only fire-and-forget?
- What timeout should be used for IPC queries? The `SELF_KG_QUERY_TIMEOUT_MS` constant is imported but the actual value needs verification.
- Should the reader cache results to avoid hammering the main process on every 10-tick cycle?

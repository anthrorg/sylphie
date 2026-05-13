# Idea: Wire Real WKG Change Detection Into Curiosity Information Gain

**Created:** 2026-04-27
**Status:** proposed

## Summary

`CuriosityInformationGain` (`packages/drive-engine/src/drive-process/behavioral-contingencies/curiosity-information-gain.ts`, lines 13-15) is documented as: "For now (before WKG is accessible in child process), this accepts parameters directly or extracts from ACTION_OUTCOME context." The contingency relies on the caller to pass `newNodes`, `confidenceDeltas`, and `resolvedErrors` rather than computing them from actual WKG state changes.

## Motivation

CANON §A.14 (Curiosity Information Gain) states curiosity is relieved proportional to actual new information gained -- new nodes, confidence increases, and resolved prediction errors. Today the relief computation trusts whatever metrics the caller hands it, which means (a) the contingency can be defrauded by inflated upstream numbers, (b) any pipeline that fails to populate the context fields will silently produce zero relief, and (c) revisiting known territory is not actually verifiable to "produce ~0 relief" because there is no ground-truth WKG diff happening here. Wiring real WKG-derived metrics enforces the CANON guarantee at the source of the calculation.

## Subsystems Affected

- **drive-engine** -- The child process needs an IPC-based read path to the WKG (likely via the same IPC infrastructure described in `ipc-self-kg-reader-wiring.md`) so the contingency can compute its own deltas instead of trusting parameters.
- **decision-making** / **learning** -- Callers that currently compute and pass in the metrics may simplify once the contingency owns the computation.

## Open Questions

- Is the WKG diff cheap enough to compute synchronously per action outcome, or does it need a streaming change-feed?
- Should this share the same IPC channel as `IPCSelfKgReader`, or have its own to avoid head-of-line blocking?
- How should the contingency degrade when the IPC channel is unavailable -- fall back to caller-provided params (current behavior) or zero-relief?

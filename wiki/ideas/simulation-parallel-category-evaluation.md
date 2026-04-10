# Idea: Simulation Parallel Category Evaluation

**Created:** 2026-04-10
**Status:** proposed

## Summary

Run `SimulationService.evaluateCategory` calls concurrently via `Promise.allSettled` instead of sequentially in a `for...of` loop, reducing simulation latency by up to ~4x for the typical 5-category evaluation.

## Motivation

In `packages/planning/src/pipeline/simulation.service.ts`, the `simulate()` method iterates over `CANDIDATE_CATEGORIES` (currently 5 categories) and `await`s each `evaluateCategory` call one at a time. Each call executes an independent TimescaleDB query with no data dependency on the other categories — the only shared input is the `affectedDrive` and `research` object, both read-only.

Since each query hits TimescaleDB with a different `actionType` filter, there is no ordering requirement. Running them in parallel with `Promise.allSettled` would let all 5 queries execute concurrently, reducing the wall-clock time of the simulation step from ~5x a single query to ~1x (bounded by the slowest query). This matters because `simulate()` sits in the critical path of the planning pipeline, which runs on a 30-second timer — shaving latency here directly increases the throughput ceiling.

The current sequential approach also means a slow query for one category blocks evaluation of all subsequent categories. With `Promise.allSettled`, a slow or failing category would not delay the others, and failures can still be logged individually via the settled result status.

## Subsystems Affected

- **Planning** (SimulationService) — primary change site; replace the `for...of` loop with `Promise.allSettled` and post-process results

## Open Questions

- Should there be a concurrency limit (e.g., process at most 3 categories concurrently) to avoid overwhelming the TimescaleDB connection pool during high-load periods?
- Does the TimescaleService use a connection pool that can handle 5 concurrent queries from a single caller without contention?
- Should the error handling change from per-category `try/catch` to inspecting `PromiseSettledResult` status, or is a wrapper function cleaner?

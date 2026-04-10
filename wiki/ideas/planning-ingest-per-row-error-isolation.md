# Idea: Per-Row Error Isolation in Planning Opportunity Ingestion

**Created:** 2026-04-09
**Status:** proposed

## Summary

Wrap the `JSON.parse` and `QueuedOpportunity` construction inside `ingestOpportunities()` in a per-row try-catch so that a single malformed TimescaleDB row cannot crash the entire ingestion cycle.

## Motivation

`PlanningService.ingestOpportunities()` iterates over rows returned from TimescaleDB and calls `JSON.parse` on each row's payload (line ~232 of `planning.service.ts`). This parse is **not** wrapped in a try-catch at the row level — if any single row has corrupted or unexpected JSON, the thrown error aborts the entire ingestion loop and no further opportunities in that batch are processed.

By contrast, the same service's `pollAndEvaluateOutcomes()` method already handles this correctly: it wraps each row's JSON parsing in its own try-catch (line ~401) and continues on failure. The inconsistency means the ingestion path is less resilient than the evaluation path despite facing identical data-quality risks.

A single bad row from TimescaleDB (caused by migration drift, encoding issues, or upstream bugs) would silently block all opportunity intake until the problematic row ages out or is manually removed.

## Subsystems Affected

- planning (`PlanningService.ingestOpportunities`)
- Indirectly: opportunity queue (starved of new items during failures)

## Open Questions

- Should failed rows be marked as processed to avoid infinite retry, or left for a bounded number of retries before dead-lettering?
- Should a new planning event type (e.g. `OPPORTUNITY_INTAKE_ERROR`) be emitted for observability?
- Is it worth extracting a shared `safeParsePayload` utility since both `ingestOpportunities` and `pollAndEvaluateOutcomes` do the same `typeof === 'string' ? JSON.parse : JSON.stringify+parse` dance?

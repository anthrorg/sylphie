# Idea: Wire WKG Trigger Context Query in Constraint Validation

**Created:** 2026-04-13
**Status:** proposed

## Summary

The `fetchExistingTriggerContexts()` method in `packages/planning/src/pipeline/constraint-validation.service.ts` (line 203) returns an empty `Set<string>` instead of querying the WKG for existing ActionProcedure trigger contexts. This means constraint 3 (duplicate trigger detection) never fires, allowing the planning pipeline to create duplicate procedures for the same trigger context.

## Motivation

Without knowing which trigger contexts already have procedures in the WKG, the planning pipeline cannot prevent duplicate procedure creation. This could lead to multiple competing procedures being installed for the same trigger, causing ambiguity in action selection. The comment notes this is intentional during bootstrap (to avoid false positives), but once the WKG has real data, this should be wired.

## Subsystems Affected

- **planning** — `constraint-validation.service.ts` needs an injected `IWkgService` to query for existing trigger contexts.
- **shared/wkg** — May need a query method like `getExistingTriggerContexts()` on the WKG service interface.

## Open Questions

- Should the query be cached per planning cycle to avoid repeated WKG hits?
- What is the correct Cypher query to extract trigger contexts from ActionProcedure nodes?
- Should this constraint be soft (warning) or hard (block) during bootstrap?

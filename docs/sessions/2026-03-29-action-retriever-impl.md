# 2026-03-29 -- Action Retriever: WKG Queries for Candidates

## Changes
- MODIFIED: `src/decision-making/action-retrieval/action-retriever.service.ts` -- Replaced E0 stub with full implementation of IActionRetrieverService. Includes context fingerprinting (deterministic), LRU cache (50 entries, 5-min TTL), WKG queries with confidence >= 0.50 threshold, Jaccard similarity scoring, motivating drive assignment, and cold-start bootstrap with five seed procedures.

## Wiring Changes
- Optional injection of IWkgService via WKG_SERVICE token. Graceful degradation if unavailable (returns empty candidates, allowing Type 2 fallback).
- retrieve() queries WKG via queryActionCandidates(), enriches with context match scores and highest-pressure drive assignment.
- bootstrapActionTree() upserts five SYSTEM_BOOTSTRAP seed nodes: greet, acknowledge, ask_clarification, express_curiosity, shrug.

## Known Issues
- None. Implementation complete and type-checked.

## Gotchas for Next Session
- Optional WKG injection means graceful fail-safe, but tests should verify behavior when WKG is null.
- LRU cache uses Map insertion order (ES2015+); ensure Node.js version >= 14.
- Jaccard similarity edge case: both empty contexts return 1.0 (perfect match), one empty returns 0.0. Adjust if behavior differs from intent.
- Bootstrap seed procedures carry SYSTEM_BOOTSTRAP provenance and base confidence 0.40 (SENSOR equivalent). They should eventually be upgraded via guardian teaching or Type 1 graduation.

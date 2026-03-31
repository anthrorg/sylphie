# 2026-03-29 -- E8-T016: Unit Tests for Research, Simulation, Proposal

## Changes
- NEW: `src/planning/research/opportunity-research.service.spec.ts` -- 11 test cases covering evidence strength calculation, failure count thresholds, WKG context retrieval, and event emission (RESEARCH_COMPLETED vs RESEARCH_INSUFFICIENT)
- NEW: `src/planning/simulation/simulation.service.spec.ts` -- 11 test cases covering candidate generation, drive effect averaging, success probability estimation, expected value computation, sparse data handling, and viability thresholds
- NEW: `src/planning/proposal/plan-proposal.service.spec.ts` -- 7 test cases covering proposal generation, complete structure validation, revision-based feedback handling, and max 2-revision enforcement

## Wiring Changes
- No wiring changes; tests mock all external dependencies (ConfigService, IEventService, IWkgService, IDriveStateReader)

## Known Issues
- None; all 29 tests passing

## Gotchas for Next Session
- Event builder returns `type` property, not `eventType` — tests reference `recordCall.type`
- Floating point precision: use `toBeCloseTo()` for drive effect comparisons
- Revision count is keyed by proposal ID; separate proposals maintain independent revision counters
- Abort condition revisions accumulate based on feedback keywords (timeout, safety, resource)

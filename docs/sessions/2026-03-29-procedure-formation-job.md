# 2026-03-29 -- Implement E7-T009: ProcedureFormationJob

## Changes
- NEW: `/src/learning/jobs/procedure-formation.job.ts` -- Full implementation (641 lines) of ILearningJob that clusters RESPONSE_TO edges by word overlap (Jaccard similarity), proposes ActionProcedure abstractions via LLM, validates against cluster, and commits to WKG with LLM_GENERATED provenance at 0.35

## Implementation Details
- **Clustering**: Greedy single-pass grouping of edges using Jaccard similarity (threshold 0.4) on word sets
- **Proposal**: LLM generates abstraction (procedure name) for each cluster with conservative temperature (0.3)
- **Validation**: Heuristic word-overlap check; procedure must explain >= 70% of cluster edges
- **Commitment**: Creates SCHEMA-level ActionProcedure nodes with LLM_GENERATED provenance at base confidence 0.35 (CANON Standard 3)
- **Linking**: Connects procedures to representative source nodes via DERIVED_FROM edges
- **Cost Tracking**: All LLM calls report latency and token usage via ILlmService

## Wiring Changes
- ProcedureFormationJob injected with WKG_SERVICE, LLM_SERVICE, EVENTS_SERVICE
- Implements ILearningJob interface (shouldRun, run)
- Returns JobResult with artifactCount and latency metrics

## Known Issues
- None identified; type-check passes (`npx tsc --noEmit`)

## Gotchas for Next Session
- Edge properties must carry sourceText/targetText for phrase extraction; fallback uses node IDs as strings
- RESPONSE_TO edges expected to exist in WKG prior to job execution
- LLM unavailability (Lesion Test, budget limits) causes graceful job skip via shouldRun()
- Greedy clustering is O(n²) on edge count; maxEdgesToProcess=100 bounds worst case
- Validation threshold (0.70) is strict; consider tuning based on test data

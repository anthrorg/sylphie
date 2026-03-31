# 2026-03-30 -- Lesion Test Services (E10-T008, E10-T009, E10-T010)

## Changes

- NEW: LesionNoLlmService (`src/testing/lesion-modes/lesion-no-llm.service.ts`) -- Disables LLM access, tracks Type 1/Type 2 ratio and shrug rate during lesion.
- NEW: LesionNoWkgService (`src/testing/lesion-modes/lesion-no-wkg.service.ts`) -- Disables WKG queries/writes, tracks reasoning quality degradation.
- NEW: LesionNoDrivesService (`src/testing/lesion-modes/lesion-no-drives.service.ts`) -- Disables drives, tracks behavioral diversity collapse.

## Implementation Details

Each lesion service implements `ILesionMode` with:
- `enable(context)`: Captures baseline metrics, activates lesion, records state.
- `disable(context)`: Computes deficit profile from accumulated event counters, restores normal state.
- `getDeficitProfile()`: Returns `LesionResult` with baseline/lesioned metrics, deficits, and diagnostic classification.

### LesionNoLlmService
- Tracks: Type 1 decisions, Type 2 decisions, shrug count, LLM call attempts/blocks.
- Metrics: type1SuccessRate, responseQualityScore, behavioralDiversity, shrugRate.
- Classification: 'helpless' (>80% shrug), 'degraded' (40-80%), 'capable' (<40%).

### LesionNoWkgService
- Tracks: Query blocks, write blocks, entity resolution failures, reasoning quality.
- Metrics: reasoningQuality, predictionAccuracy, entityResolution, knowledgeReuse.
- Classification: 'helpless' (<20% degradation = graph is write-only), 'degraded' (20-40%), 'capable' (>40% = graph is essential).

### LesionNoDrivesService
- Tracks: Drive read attempts/blocks, outcome preference count, action distribution (for entropy).
- Metrics: behavioralDiversity, emotionalReactivity, outcomePreference, decisionVariance.
- Classification: 'helpless' (<10% diversity loss), 'degraded' (10-20%), 'capable' (>20% = drives shape personality).

## Wiring Changes

- All three services registered as providers in TestingModule (already present).
- Services inject no external dependencies; state is tracked internally.
- No changes to other modules required.

## Known Issues

- Event recording removed (lesion tests track metrics internally; full event integration deferred to E10-T003).
- Lesion services do not yet intercept actual LLM/WKG/Drive calls; infrastructure for DI override deferred.
- Baseline metrics are initialized as fixed defaults; actual baseline capture deferred to TestEnvironmentService.

## Gotchas for Next Session

- Each lesion service maintains independent session state. Multiple concurrent lesions will interfere; ensure tests run sequentially.
- Deficit computation assumes baseline metrics are non-zero to avoid division-by-zero; zero baselines produce zero deficit (safe fallback).
- Action entropy calculation uses normalized Shannon entropy; empty action distribution yields 0.0 entropy.
- Diagnostic classification uses hardcoded thresholds (e.g., 40% for WKG, 20% for drives, 80% for LLM); thresholds should be tuned during integration tests.

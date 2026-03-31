# 2026-03-29 -- Attractor State Monitoring (Type 2 Addict Detection)

## Changes
- NEW: `src/decision-making/monitoring/attractor-monitor.service.ts` -- Real implementation of 5 attractor detectors
- NEW: `src/decision-making/monitoring/index.ts` -- Barrel export for monitoring subsystem
- MODIFIED: `src/decision-making/decision-making.tokens.ts` -- Added ATTRACTOR_MONITOR_SERVICE token

## What It Does
The `AttractorMonitorService` detects when Sylphie enters degenerate behavioral attractors (CANON §Known Attractor States). Five detectors run every decision cycle:

1. **TYPE_2_ADDICT**: If Type 1/Type 2 ratio < 0.1 over 100 cycles → LLM always wins, Type 1 never develops
2. **HALLUCINATED_KNOWLEDGE**: If >20% of WKG nodes created without SENSOR/GUARDIAN provenance → plausible false information filling graph
3. **DEPRESSIVE_ATTRACTOR**: If >80% of self-evaluations negative over 50 cycles → learned helplessness feedback loop
4. **PLANNING_RUNAWAY**: If >70% prediction failures AND plan count > 50% of decisions → resource exhaustion
5. **PREDICTION_PESSIMIST**: If MAE > 0.30 in >80% of first 50 decisions (while decision count < 100) → early learning failure

Each detector returns an `AttractorAlert` with severity (WARNING/CRITICAL), human-readable message, diagnostic metrics, and suggested action. The service also computes `AttractorMetrics` (0.0-1.0 risk scores for each detector) usable by dashboard trending.

## Implementation Details
- Pure rolling window design: Each detector maintains its own window (100, 50, or 50 entries depending on detector)
- Provenance tracking is global (not windowed) to detect knowledge graph drift over entire system lifetime
- Risk metrics computed separately from alert thresholds: risk = (current - half_threshold) / half_threshold, capped at [0, 1]
- All windows shift automatically to maintain size limits
- No external dependencies: Injectable, Logger only
- Logging at DEBUG level for each record, WARN level for detected attractors

## Testing
All 5 detectors verified with unit tests:
- TYPE_2_ADDICT: 105 arbitrations (100 TYPE_2, 5 TYPE_1) → ratio 0.05 < 0.1 ✓
- HALLUCINATED_KNOWLEDGE: 100 nodes (79 SENSOR, 21 LLM_GENERATED) → 21% > 20% ✓
- DEPRESSIVE_ATTRACTOR: 50 evaluations (9 positive, 41 negative) → 82% > 80% ✓
- PLANNING_RUNAWAY: 50 predictions (10 accurate, 40 inaccurate, 60 plans) → 80% failure + 0.6 ratio ✓
- PREDICTION_PESSIMIST: 50 early predictions all with MAE 0.35 → 100% > 80% ✓
- getMetrics() structure verified: all 5 risk fields present and numeric

## Wiring Changes
None yet. Service is INTERNAL to DecisionMakingModule. When integrated:
1. Add provider in `decision-making.module.ts` under ATTRACTOR_MONITOR_SERVICE token
2. Inject into DecisionMakingService
3. Call recordXxx() methods during action execution
4. Call checkForAttractors() at end of decision cycle
5. Emit attractor events to TimescaleDB via EVENTS_SERVICE

## Known Issues
- Service initialized but not yet wired into decision loop
- No integration with event logging (EVENTS_SERVICE not injected yet)
- Risk metrics are informational only -- no automatic interventions triggered

## Gotchas for Next Session
- Detectors use strict > comparison (not >=), so exactly 0.8 negative doesn't trigger DEPRESSIVE alert
- Provenance normalization handles both 'llmgenerated' and 'llm_generated' forms
- Early failure window for PREDICTION_PESSIMIST only populates during first 100 decisions, then clears
- Plan count is never reset; ratio compares absolute plan count to decision count

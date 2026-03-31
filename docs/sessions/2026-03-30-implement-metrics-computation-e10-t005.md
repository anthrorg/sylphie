# 2026-03-30 -- Implement MetricsComputationService (E10-T005)

## Changes
- MODIFIED: `src/metrics/metrics-computation.service.ts` -- Implemented full MetricsComputationService with all 7 CANON health metrics computation methods

## Wiring Changes
- Service depends on: EVENTS_SERVICE, WKG_SERVICE, DRIVE_STATE_READER, SELF_KG_SERVICE
- Service implements: IMetricsComputation interface with computeHealthMetrics() and computeDriftMetrics() methods

## Metric Implementations
1. **Type 1/Type 2 Ratio** - queries TYPE_1_SELECTED and TYPE_2_SELECTED events over 1-hour window
2. **Prediction MAE** - queries PREDICTION_EVALUATED events, extracts absoluteError values, computes mean
3. **Provenance Ratio** - calls WKG queryGraphStats(), computes experiential ratio (SENSOR+GUARDIAN+INFERENCE)/total
4. **Behavioral Diversity Index** - queries ACTION_EXECUTED events over 20-action window, counts unique actionType values
5. **Guardian Response Rate** - queries SOCIAL_COMMENT_INITIATED and SOCIAL_CONTINGENCY_MET events, computes ratio
6. **Interoceptive Accuracy** - compares SelfKG self-model vs DriveStateReader current drive state
7. **Mean Drive Resolution Time** - queries DRIVE_TICK events, tracks pressure->relief transitions per drive

## Key Features
- Simple in-memory cache with configurable TTL (default 5 minutes)
- Configurable time windows for each metric via ConfigService
- Parallel computation of metrics where possible
- Type-safe implementation with proper handling of PressureVector enum keys
- Stub computeDriftMetrics() returns minimal valid DriftMetrics (full implementation deferred)

## Known Issues
- computeDriftMetrics() is a stub returning empty anomalies and zero trends
- Drive resolution time computation checks only 12 known drives (could be generalized)

## Gotchas for Next Session
- PressureVector uses DriveName enum keys, not string indexing; casting to `any` needed for dynamic access
- Event queries default to limit=100; ensure time windows are sufficient for statistical reliability
- Cache keys must be unique; sessionId is used as suffix for health metrics but not for global metrics

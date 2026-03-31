# 2026-03-30 -- Type 1 Graduation Integration Test Suite

## Changes
- NEW: `src/testing/__tests__/type-1-graduation.integration.spec.ts` -- Comprehensive 23-test suite validating Type 1 graduation mechanism. Tests four distinct scenarios per CANON §Dual-Process Cognition.

## Test Coverage
- **Graduation Path** (8 tests): Confidence grows via ACT-R formula, MAE tracked over last 10 uses, graduation fires when both confidence > 0.80 AND MAE < 0.10, subsequent decisions use Type 1.
- **Demotion Path** (4 tests): Context change causes prediction failures, MAE rises above 0.15, behavior demoted to Type 2, noisy prediction handling.
- **Dynamic Threshold Modulation** (3 tests): High anxiety (>0.7) increases graduation threshold (harder to graduate), baseline threshold under low anxiety. Documents that anxiety adjustment belongs in Decision Making service, not in pure confidence layer.
- **Guardian Asymmetry** (5 tests): Confirmation accelerates graduation (2x multiplier), correction decelerates (3x multiplier), demonstrates accumulation of multiple guardian feedbacks.
- **Full Integration Journey** (2 tests): Complete Type 2 → Type 1 → Type 2 cycle, confidence bounds throughout lifecycle.

## Wiring Changes
- Tests import from `src/shared/types/confidence.types.ts` (computeConfidence, qualifiesForGraduation, qualifiesForDemotion, applyGuardianWeight, CONFIDENCE_THRESHOLDS, DEFAULT_DECAY_RATES).
- Uses existing ACTRParams interface and confidence computation functions unchanged.
- No new dependencies on other subsystems; pure unit testing of confidence mechanics.

## Known Issues
- None. All 23 tests passing.

## Gotchas for Next Session
- ACT-R confidence formula uses logarithmic growth: 0.12 * ln(count). With GUARDIAN base (0.60) and decay rate 0.03, reaching 0.80 requires ~8-10 successful uses.
- MAE computation is simple average: sum(maes) / count. Tests use Array.slice(-10) to get last 10 uses for graduation/demotion checks.
- Floating-point arithmetic: use toBeCloseTo() for equality checks on computed values (not toBe()).
- Anxiety threshold modulation is documented as FUTURE: tests verify that base thresholds work correctly but do NOT implement anxiety scaling. That belongs in IArbitrationService or Decision Making's arbitrate() method.

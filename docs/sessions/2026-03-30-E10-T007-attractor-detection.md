# 2026-03-30 -- Implement AttractorDetectionService

## Changes
- MODIFIED: `src/metrics/attractor-detection.service.ts` -- Replaced stub with full implementation of 6 attractor detection algorithms (Type 2 Addict, Rule Drift, Hallucinated Knowledge, Depressive Attractor, Planning Runaway, Prediction Pessimist)

## Assessment Methods Implemented
1. **Type 2 Addict (HIGH RISK)** -- Detects LLM dependency via Type 1/Type 2 ratio decline and knowledge retrieval ratio <20%
2. **Rule Drift (MEDIUM RISK)** -- Counts unapproved proposed drive rules and scales proximity linearly
3. **Hallucinated Knowledge (MEDIUM RISK)** -- Checks LLM_GENERATED provenance ratio >50% and low experiential ratio
4. **Depressive Attractor (MEDIUM RISK)** -- Monitors Satisfaction <0.3, Anxiety >0.7, behavioral diversity <0.15
5. **Planning Runaway (LOW-MEDIUM RISK)** -- Compares opportunity queue size to resolved plans; triggers if ratio >3
6. **Prediction Pessimist (LOW-MEDIUM RISK)** -- Checks prediction MAE and tracks recently created plans

## Wiring Changes
- Injected: METRICS_COMPUTATION, EVENTS_SERVICE, DRIVE_STATE_READER, WKG_SERVICE, ConfigService
- Each attractor returns AttractorProximity with indicators and recommended actions
- Overall risk computed as worst-case severity: CRITICAL > HIGH > MEDIUM > LOW
- `getWarnings()` returns filtered list of warning/critical attractors from cached last report

## Known Issues
- `getCurrentSessionId()` uses config fallback; production should query TimescaleDB for current session
- Drive name access uses DriveName enum correctly (satisfaction, anxiety, not Satisfaction, Anxiety)
- Event types use canonical EventType enum: RULE_PROPOSED, OPPORTUNITY_DETECTED, PLAN_CREATED, etc.

## Gotchas for Next Session
- PressureVector uses enum keys (DriveName.Anxiety) not string literals
- Event queries must use exact EventType values from event.types.ts
- AttractorProximity indicators are human-readable strings; no machine-parsed structure

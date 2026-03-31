# 2026-03-29 -- Epic 5: Decision Making (Core Cognitive Loop)

## Changes
- NEW: src/decision-making/executor/executor-engine.service.ts -- 8-state machine with timeout recovery and cycle metrics
- NEW: src/decision-making/episodic-memory/episodic-memory.service.ts -- Ring buffer (50 max), encoding gate, Jaccard similarity
- NEW: src/decision-making/episodic-memory/consolidation.service.ts -- Episode maturation and semantic conversion
- NEW: src/decision-making/episodic-memory/consolidation.interfaces.ts -- Consolidation types
- NEW: src/decision-making/process-input/process-input.service.ts -- 9 input categories, SHA-256 fingerprinting, Cowan's 5-candidate limit
- NEW: src/decision-making/prediction/prediction.service.ts -- Prediction generation/evaluation, per-action MAE history
- NEW: src/decision-making/arbitration/arbitration.service.ts -- Dynamic threshold, Type 1/2/SHRUG discrimination
- NEW: src/decision-making/threshold/threshold-computation.service.ts -- Drive-modulated threshold [0.30, 0.70]
- NEW: src/decision-making/confidence/confidence-updater.service.ts -- 3-path ACT-R, Guardian 2x/3x weights
- NEW: src/decision-making/action-retrieval/action-retriever.service.ts -- LRU cache (50 entries, 5min TTL), seed procedures
- NEW: src/decision-making/action-handlers/action-handler-registry.service.ts -- 8 handlers including SHRUG
- NEW: src/decision-making/logging/decision-event-logger.service.ts -- Batch writes (10 events / 100ms)
- NEW: src/decision-making/monitoring/attractor-monitor.service.ts -- 5 dysfunction detectors
- NEW: src/decision-making/graduation/type1-tracker.service.ts -- Full state machine with transition history
- NEW: src/decision-making/shrug/shrug-imperative.service.ts -- CANON Standard 4 enforcement
- MODIFIED: src/decision-making/decision-making.service.ts -- Full 8-state cognitive loop facade
- MODIFIED: src/decision-making/decision-making.module.ts -- All 14 providers wired
- MODIFIED: src/decision-making/decision-making.tokens.ts -- 8 new internal tokens

## Wiring Changes
- DecisionMakingModule now imports EventsModule for TimescaleDB logging
- DecisionMakingService injects 11 internal services through full cognitive loop
- DriveEngine read-only integration via DRIVE_STATE_READER + ACTION_OUTCOME_REPORTER

## Known Issues
- Pre-existing test failures in knowledge/ and drive-engine/ modules (not introduced by this epic)
- WKG integration deferred to runtime (graceful degradation when unavailable)
- LLM integration deferred (Type 2 handlers return deferred execution results)

## Gotchas for Next Session
- Epic 6 (Communication) can now integrate with processInput() and getCognitiveContext()
- ActionHandlerRegistry deferred handlers need real subsystem wiring in E6/E7/E8
- AttractorMonitor needs to be called from the decision loop (hooks ready but not yet invoked)

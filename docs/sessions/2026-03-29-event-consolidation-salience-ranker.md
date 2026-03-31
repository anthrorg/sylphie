# 2026-03-29 -- Event Consolidation Service (Salience Ranking)

## Changes
- NEW: `src/learning/consolidation/event-ranker.service.ts` -- Full implementation of EventRankerService. Ranks learnable events by salience using guardian feedback, prediction signals, novelty detection, and recency decay. Returns parallel SalienceScore array sorted by totalScore descending.

## Salience Algorithm
- Guardian corrections: +0.50 (highest priority per Guardian Asymmetry, CANON Standard 5)
- Guardian confirmations: +0.20
- Prediction signals: +0.30 (detected via keyword heuristics: 'expect', 'predict', 'wrong', etc.)
- Novel entities: +0.25 (detected via capitalization ratio >20% or novelty keywords)
- Recency boost: Math.max(0, 0.15 - hoursAgo * 0.01) — decaying, newer events score higher
- Total: baseSalience + recencyBoost, capped at 1.0

## Implementation Notes
- Pure computation: no database access, one-way dependency on LearnableEvent interface
- Heuristic detection (content-based) for prediction and novelty signals; future versions can integrate WKG queries
- Results sorted descending by totalScore for direct integration with batch selection
- Logger injected but not used in alpha; available for diagnostics

## Known Issues
- Prediction signal and novelty detection use simple keyword heuristics; full implementation should query event provenance/correlationId and WKG

## Gotchas for Next Session
- hasPredictionSignal() and hasNovelContent() are placeholder heuristics. When IEventService is available, consider checking correlationId linking to PREDICTION_EVALUATED events and WKG entity lookup.
- Recency formula uses wall-clock time (new Date()); consider injecting a clock service if system requires deterministic timestamps.

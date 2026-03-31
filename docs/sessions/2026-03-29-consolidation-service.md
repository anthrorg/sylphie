# 2026-03-29 -- Episodic Memory Consolidation Service (E5-T004)

## Changes
- NEW: `src/decision-making/episodic-memory/consolidation.interfaces.ts` -- Interface contracts for consolidation service: ConsolidationCandidate, SemanticConversion, SemanticRelationship, ConsolidationResult, IConsolidationService
- NEW: `src/decision-making/episodic-memory/consolidation.service.ts` -- Full implementation with episode maturation detection (age > 2h, confidence > 0.65), semantic extraction (entities from inputSummary, relationships from action context and drive state), provenance preservation (INFERENCE default), confidence estimation per encodingDepth
- MODIFIED: `src/decision-making/decision-making.tokens.ts` -- Added CONSOLIDATION_SERVICE token (internal)

## Wiring Changes
- ConsolidationService depends on EPISODIC_MEMORY_SERVICE (read episodes), EVENTS_SERVICE (optional logging), EXECUTOR_ENGINE (injected but unused, deferred for future Learning integration)
- Token added to decision-making.tokens.ts (internal only, not exported from barrel)
- No module wiring yet (not integrated into DecisionMakingModule; integration task deferred)

## Known Issues
- Integration with DecisionMakingModule not yet done (task E5-T005 or later)
- Event emission deferred to Learning subsystem (CONSOLIDATION_CYCLE_STARTED/COMPLETED owned by LEARNING, not DECISION_MAKING)
- EXECUTOR_ENGINE injection present but unused (reserved for future Lesion Test tracking)

## Gotchas for Next Session
- IConsolidationService.convertToSemantic() is pure/synchronous; conversions are prepared but not persisted (Learning subsystem owns WKG writes)
- Entity extraction uses simple heuristics (tokenization + capitalization); may need linguistic NLP for production
- Relationship extraction assumes high-pressure drives (>0.5) are causal; confidence penalty applied to inferred relationships (-0.1)
- Confidence estimation formula accounts for encodingDepth: DEEP 1.2x boost, SHALLOW 0.8x penalty, max floor 0.4

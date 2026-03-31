# 2026-03-29 -- E7-T007: Contradiction Detection Service

## Changes
- NEW: `src/learning/extraction/contradiction-detector.service.ts` -- Full implementation of IContradictionDetector interface with four contradiction detection types (DIRECT, CONFIDENCE, SCHEMA, TEMPORAL)

## Wiring Changes
- ContradictionDetectorService now injected via @Inject(WKG_SERVICE) for KnowledgeNode lookups
- Injects IWkgService dependency for node/edge queries (though check method works autonomously without additional WKG calls)

## Implementation Details
The service detects contradictions across four CANON-specified categories:

1. **DIRECT**: Properties with opposite truth values (e.g., color='red' vs color='blue')
2. **CONFIDENCE**: Same semantic knowledge with high confidence variance (>0.25)
3. **SCHEMA**: Type/label mismatches or structural violations
4. **TEMPORAL**: Causality violations or impossible time sequences

### Resolution Strategy (CANON Standard 5: Guardian Asymmetry)
- **GUARDIAN existing**: Always GUARDIAN_REVIEW (write-protected from autonomous modification)
- **GUARDIAN incoming**: SUPERSEDED (guardian always wins)
- **Higher provenance rank**: SUPERSEDED when >0.5 rank advantage
- **Higher confidence**: COEXIST when gap >0.15
- **Default**: GUARDIAN_REVIEW (defer to human judgment)

Provenance rank (high→low): GUARDIAN (4) > GUARDIAN_APPROVED_INFERENCE (3.5) > SENSOR (3) > BEHAVIORAL_INFERENCE (2) > INFERENCE (2) > LLM_GENERATED (1) > SYSTEM_BOOTSTRAP (0.5)

## Known Issues
- None in ContradictionDetectorService itself
- Pre-existing type errors in procedure-formation.job.ts (unrelated to this ticket)

## Gotchas for Next Session
- The service returns discriminated unions; callers must handle both no_conflict and contradiction branches
- Event emission (CONTRADICTION_DETECTED to TimescaleDB) is the caller's responsibility, not this service's
- Synonym and related-types heuristics are basic; expand them per domain-specific knowledge
- Temporal conflict detection checks createdAt/updatedAt/timestamp properties; extend if custom temporal fields added

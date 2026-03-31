# 2026-03-29 -- E7-T011 Sentence Processing Job Implementation

## Changes

- **MODIFIED: src/learning/jobs/sentence-processing.job.ts** -- Full implementation of SentenceProcessingJob
  - Replaced stub with complete 6-phase sentence splitting and structure extraction pipeline
  - Phase 1: Queries WKG for PhraseNodes with multiple sentences (heuristic: text contains >1 boundary)
  - Phase 2: Splits sentences on boundaries (., !, ?) preserving punctuation
  - Phase 3: Creates individual SentenceNode (Entity/Phrase/Sentence) per sentence with PARENT_PHRASE edges to original
  - Phase 4: LLM-assisted structure extraction (Type 2) identifies subject, verb, object, modifiers
  - Phase 5: Creates FOLLOWS_PATTERN edges between sentences sharing identical template slots
  - Phase 6: Proposes TRIGGERS edges (verb→object) with confidence >= 0.45 threshold per CANON Standard 3
  - All LLM-generated edges carry LLM_GENERATED provenance at 0.35 base confidence
  - Includes fallback heuristic parsing when LLM unavailable or parsing fails
  - Comprehensive error handling with issue tracking per JobResult contract

## Wiring Changes

- SentenceProcessingJob injectable in LearningModule, registered by JobRegistryService
- Injects: WKG_SERVICE, LLM_SERVICE, EVENTS_SERVICE via @Inject decorators
- Implements ILearningJob contract: name='sentence-processing', shouldRun(), run()
- Returns JobResult with artifactCount (sentence nodes + edges created/updated)

## Known Issues

- Heuristic structure extraction is simplistic (word-position based, not POS tagged)
  - Fallback works for simple S-V-O structures but may fail on complex syntax
  - Production should integrate proper NLP tokenizer (SpaCy, NLTK, or similar)
- LLM JSON response parsing assumes specific format; may fail if LLM deviates
  - Fallback heuristic handles parse failures but with lower quality results
- No template similarity matching yet (exact match only on templateSlot)
  - Future work: fuzzy matching or clustering similar templates
- Sentence boundary detection ignores abbreviations (Dr., Mr., etc.)
  - May incorrectly split on abbreviations; production needs regex refinement
- No batch size limits on queryMultiSentencePhrases()
  - Large graphs could cause memory issues; should paginate large result sets

## Gotchas for Next Session

- PARENT_PHRASE edge relationship name is currently hardcoded; check against CANON for correctness
- Concept nodes created at SCHEMA level; verify this is correct abstraction level vs INSTANCE
- Template slot generation is deterministic but fragile; changing it breaks pattern matching
- LLM calls happen synchronously in loop; could optimize with Promise.all() for batch processing
- No metrics/telemetry on LLM token usage; Type 2 Cost Requirement should be monitored separately
- shouldRun() always returns true if LLM available; could be refined to check event queue depth

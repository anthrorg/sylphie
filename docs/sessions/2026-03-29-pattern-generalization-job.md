# 2026-03-29 -- Pattern Generalization + Symbolic Decomposition Job

## Changes

- **NEW:** `/src/learning/jobs/pattern-generalization.job.ts` -- Full implementation of E7-T012 PatternGeneralizationJob. Implements two-phase learning:
  - Phase 1: Pattern Generalization — clusters phrases by FOLLOWS_PATTERN templates, proposes ConceptPrimitive abstractions via LLM, validates >= 80% cluster coverage, commits valid concepts with HAS_INSTANCE edges (LLM_GENERATED provenance, 0.35 base confidence).
  - Phase 2: Symbolic Decomposition — decomposes phrases into word-level semantic units, creates WordNode instances, links via CONTAINS_WORD edges with semantic role heuristics.

## Wiring Changes

- **ILearningJob interface:** PatternGeneralizationJob implements contract with `shouldRun()` and `run()`.
- **Service injection:** WKG_SERVICE, LLM_SERVICE, EVENTS_SERVICE injected via @Inject decorators.
- **No new wiring required:** Job is a self-contained NestJS @Injectable service; will be registered in LearningModule.

## Known Issues

- LLM concept proposal is greedy (single round-trip); refinement cycles not yet supported.
- Word-level semantic role assignment uses simple heuristics (position-based, suffix-based); no POS tagger.
- Decomposition does not yet create inter-word relationships (e.g., PRECEDES, MODIFIES); only CONTAINS_WORD edges.

## Gotchas for Next Session

- **Cluster discovery:** Current logic queries all Phrase nodes and groups by `templateSlot` property. If SentenceProcessingJob or other jobs don't populate `templateSlot`, clusters may be empty. Verify template slot propagation.
- **Concept validation LLM call:** Two LLM round-trips per cluster (proposal + validation). High clusters → high latency. Consider batching validation for multiple clusters if performance becomes an issue.
- **Word deduplication:** Current decomposition creates a new WordNode for each occurrence of a word in each phrase. Consider deduplication across all phrases (global word index) in future.
- **Stopword filtering:** Hardcoded English stopwords in `extractWordUnits`. Multilinguality not supported yet.

# Idea: Richer Semantic Extraction in Episodic Memory Consolidation

**Created:** 2026-04-10
**Status:** proposed

## Summary

The consolidation service's `extractEntities()` and `extractRelationships()` functions use minimal heuristics — title-case token matching for entities and exactly two hardcoded relationship triples per episode. Upgrading these to leverage the LLM (or at minimum, richer NLP patterns) would produce higher-quality WKG nodes and dramatically improve the knowledge that survives consolidation.

## Motivation

In `consolidation.service.ts`, entity extraction (line 312–335) splits text on whitespace and selects tokens where the first character is uppercase but the whole token isn't all-caps. This misses multi-word entities ("Jim's house", "Google Drive"), lowercase entities that matter contextually ("anxiety", "curiosity"), and produces false positives on sentence-initial words. For a cognitive system that learns from experience, the quality of what gets promoted from episodic memory to the WKG is foundational — garbage-in at consolidation means the knowledge graph accumulates noise.

Relationship extraction (line 346–371) is even more constrained: every episode produces exactly two triples — `inputSummary -> "triggered" -> actionTaken` and `actionTaken -> "produced" -> "observed_outcome"`. The second triple's object is always the literal string `"observed_outcome"` regardless of what actually happened. This means the WKG never captures the actual outcome of actions, only that some unspecified outcome was produced. Over time this creates a graph full of identical, uninformative edges.

The consolidation service already has access to the full episode context (drive snapshot, input summary, action taken, context fingerprint). A lightweight LLM call — or even a more sophisticated regex/pattern-based extractor — could yield variable-count, contextually meaningful triples like `"Jim" -> "asked about" -> "weather"` or `"high curiosity" -> "drove" -> "web search"`.

## Subsystems Affected

- Decision Making (consolidation service — entity and relationship extraction)
- Learning (downstream consumer of SemanticConversion records — would receive richer data)

## Open Questions

- Should extraction use the Ollama LLM service already available in the decision-making package, or would that create too tight a coupling / too much latency during consolidation cycles?
- What's the right balance between extraction richness and WKG noise? More triples per episode means more knowledge but also more potential for low-confidence edges cluttering the graph.
- Should the hardcoded `"observed_outcome"` placeholder be replaced with actual outcome data from the action-outcome-reporter, or is that information not available at consolidation time?
- Could the existing `contextFingerprint` field be leveraged to produce better entity candidates, since it's already a semantic summary of the episode's context?

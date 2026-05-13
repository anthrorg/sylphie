# Idea: Replace Hardcoded 'noun_1' Default in Semantic Teaching Handler

**Created:** 2026-04-27
**Status:** proposed

## Summary

`_resolve_or_create_word_sense` in `semantic_teaching_handler.py` (`packages/perception-service/cobeing/layer3_knowledge/semantic_teaching_handler.py`, lines 219-220) creates new `WordSenseNode` rows with "a placeholder sense_tag of 'noun_1' (the most common default)" when no existing match is found. Every guardian-taught word that lacks a prior sense is therefore tagged as `noun_1`, regardless of whether it is actually a noun, verb, adjective, or adverb.

## Motivation

WordSenseNodes are the units of meaning the semantic layer composes against. CANON §A.18 emphasises GUARDIAN provenance and faithful sense capture. Tagging every newly-taught word as `noun_1` corrupts the sense-tag distribution, causes downstream sense-aware retrieval to mis-route lookups, and accumulates wrong tags that are hard to correct after the fact. A correct implementation should either (a) require the caller to supply the part-of-speech / sense from the teaching context, (b) infer it via the existing template-matcher / morphology executor, or (c) leave the tag null pending validation rather than poisoning the data with a confident default.

## Subsystems Affected

- **perception-service** -- `semantic_teaching_handler.py` needs an alternative sense-tag determination path. The teaching call site has the surrounding sentence and the word's surface form, which is enough for a coarse POS heuristic.
- **layer3_knowledge** -- `node_types.py` may need to allow a sentinel "unknown" sense tag, or the surrounding code may need to handle "no sense yet" gracefully.

## Open Questions

- Should the correct sense be inferred at teaching time or deferred until the word is used in context?
- If deferred, what value goes in the column -- NULL, a sentinel like `unknown_1`, or a structurally-valid placeholder that downstream code can recognise as "needs validation"?
- Does the existing template-matcher already produce enough POS signal to infer sense at teaching time without spaCy?

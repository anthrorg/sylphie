# Idea: Grounded Confidence Scoring for Reflection Insights

**Created:** 2026-04-09
**Status:** proposed

## Summary

Adjust reflection insight confidence based on how many of the LLM-referenced entities actually exist in the WKG, so that ungrounded or speculative insights are automatically penalized rather than stored at face-value confidence.

## Motivation

In `ConversationReflectionService.persistInsight()`, an Insight node is created with `REFLECTION_CONFIDENCE` (0.30) and `REVEALS` edges are attempted for each `referencedEntities` entry. However, if the entity labels don't match anything in the graph (the `MATCH` silently returns zero rows), the Insight node still sits at the same confidence — potentially orphaned with no `REVEALS` edges at all.

This means an LLM hallucination that references entities that were never extracted ("Jim mentioned he loves Haskell" when "Haskell" was never upserted as an Entity) gets the same treatment as a well-grounded insight that connects three known entities. Downstream consumers (retrieval, planning, drive modulation) have no signal to distinguish the two.

A simple post-persistence grounding check could:
1. Count how many `REVEALS` edges were actually created vs. how many were attempted.
2. Scale the insight's confidence by the grounding ratio (e.g., `0.30 * (matched / total)`).
3. Flag fully ungrounded insights (0 matched entities) with a property like `grounded: false` so they can be garbage-collected or re-evaluated later.

This keeps the reflection pipeline lightweight (no extra LLM calls) while giving the graph a built-in quality signal for reflection-derived knowledge.

## Subsystems Affected

- Learning (ConversationReflectionService — `persistInsight` method)
- Shared/WKG (Insight node schema — optional `grounded` property)

## Open Questions

- Should fully ungrounded insights (0/N entities matched) be stored at all, or silently dropped?
- Should the grounding ratio also factor in whether the suggested edge was successfully written?
- Is the linear scaling (`confidence * ratio`) the right function, or should there be a minimum floor (e.g., never below 0.10) to give ungrounded insights a chance to be confirmed later?

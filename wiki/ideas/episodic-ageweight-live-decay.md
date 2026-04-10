# Idea: Live ageWeight Decay for Episodic Memory Consolidation

**Created:** 2026-04-10
**Status:** proposed

## Summary

The episodic memory `ageWeight` is frozen at encoding time (set to `input.attention`) and never recalculated, even though the documented formula is `attention * exp(-0.1 * hoursSinceEncoding)`. This means consolidation candidate scoring ignores temporal decay entirely — a high-attention episode from 3 hours ago has the same weight as it will at 48 hours, defeating the purpose of age-based confidence estimation.

## Motivation

The `EpisodicMemoryService.encode()` method sets `ageWeight = input.attention` at t=0. The docstring says the formula should be `attention * exp(-0.1 * hoursSinceEncoding)`, but the exponential decay term is never applied after initial encoding. Downstream, `ConsolidationService.findConsolidationCandidates()` uses this stale `episode.ageWeight` directly in `estimateConfidence()`, which means:

1. **Consolidation ordering is wrong.** Candidates are sorted by `estimatedConfidence` descending, which is derived from `ageWeight`. Since `ageWeight` is just frozen attention, the sort is purely by initial attention — not by the intended "salience that decays over time" signal.

2. **The MIN_CONFIDENCE_THRESHOLD gate is miscalibrated.** Episodes with moderate initial attention (e.g., 0.55) will never cross the 0.65 threshold regardless of age, even though the consolidation design intends for older, well-attended episodes to rise to the top. Conversely, episodes with high initial attention will always pass the gate, even when very fresh (which shouldn't be consolidated yet — that's what the 2-hour age gate is for).

3. **`queryByContext` sorting is affected.** Results are sorted by `ageWeight` descending as a proxy for "most recent and attentionally salient," but without decay, old high-attention episodes permanently outrank recent moderate-attention ones.

The fix is straightforward: compute `ageWeight` live wherever it's consumed, rather than storing a frozen value. Either recalculate in `getRecentEpisodes()` / `findConsolidationCandidates()` using `episode.attention * Math.exp(-0.1 * hoursSince(episode.timestamp))`, or store the original attention separately and compute the decayed weight on read.

## Subsystems Affected

- `decision-making` — `EpisodicMemoryService` (ageWeight computation, queryByContext sort)
- `decision-making` — `ConsolidationService` (candidate scoring and ordering)
- `@sylphie/shared` — `Episode` type (may need an `initialAttention` field if ageWeight becomes computed)

## Open Questions

- Should the decay constant (0.1) be configurable via `PerceptionConfig` or a dedicated consolidation config?
- Does the TimescaleDB checkpoint restore path need to rehydrate the original attention value for live recomputation?
- Should `queryByContext` use the live-decayed weight or switch to a different relevance signal (e.g., recency-weighted similarity)?

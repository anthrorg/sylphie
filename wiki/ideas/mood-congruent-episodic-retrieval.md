# Idea: Mood-Congruent Episodic Retrieval

**Created:** 2026-04-13
**Status:** proposed

## Summary

Add drive-state similarity as a retrieval cue in `EpisodicMemoryService.queryByContext()`, so episodes encoded under emotionally similar conditions are preferentially recalled. Currently retrieval uses only Jaccard similarity on context fingerprint tokens — the drive snapshot stored with each episode is ignored during retrieval.

## Motivation

The episodic memory service stores a full `DriveSnapshot` with every encoded episode (line 205, `episodic-memory.service.ts`), but `queryByContext()` never consults it. Retrieval is purely semantic: tokenize the fingerprint, compute Jaccard, threshold at 0.70, sort by ageWeight. This means two episodes with identical text content but wildly different emotional contexts (one encoded during high curiosity, one during high anxiety) are treated identically at retrieval time.

This ignores a well-established finding in cognitive psychology: **mood-congruent memory** — the tendency for emotional states to act as retrieval cues, making memories encoded under similar affect more accessible. For Sylphie, this has practical consequences:

1. **Anxiety-relevant episodes surface when anxious.** If Sylphie previously encountered a confusing situation (high anxiety drive) and learned something useful, that episode should be more accessible when she's confused again — even if the topic is different. The emotional signature is the cue.

2. **Curiosity-driven exploration chains.** Episodes encoded during high curiosity (active exploration) should cluster together at retrieval when Sylphie is exploring again, creating a richer context for the deliberation system to work with.

3. **Social episodes surface in social contexts.** When the social drive is active (someone is speaking), episodes from prior social interactions should get a retrieval boost — they contain relevant interaction patterns regardless of topic.

The working memory service (`working-memory.service.ts`) already implements drive modulation for its own activation scoring (line 301, `computeDriveModulation`), but that only applies to working memory assembly — not to the upstream episodic retrieval that feeds it episodes. Adding drive-state similarity directly to `queryByContext` would mean better episode candidates reach working memory in the first place.

### Implementation sketch

Compute cosine similarity between the current `DriveSnapshot.pressureVector` and each stored episode's `driveSnapshot.pressureVector`. Blend this with the existing Jaccard score:

```
compositeScore = (1 - alpha) * jaccardSimilarity + alpha * driveCosineSimilarity
```

where `alpha` is a tunable parameter (suggest starting at 0.25 — modest influence, semantic content still dominates). Episodes pass the threshold when `compositeScore > 0.70` (same gate, richer signal). Sort by the composite score instead of raw ageWeight.

This requires the caller to pass the current drive snapshot into `queryByContext`, which means a small interface change to `IEpisodicMemoryService`.

## Subsystems Affected

- `decision-making` — `EpisodicMemoryService` (queryByContext method, IEpisodicMemoryService interface)
- `decision-making` — `WorkingMemoryService` (caller of queryByContext — needs to pass drive snapshot)
- `@sylphie/shared` — `IEpisodicMemoryService` interface (new parameter)

## Open Questions

- What alpha value gives the best balance? Too high and retrieval becomes emotionally biased at the expense of semantic relevance; too low and the signal is negligible.
- Should the drive similarity use all drives equally, or weight "active" drives (pressure > threshold) more heavily? A drive at 0.02 shouldn't contribute much to the similarity signal.
- Should this interact with the ageWeight decay idea (if implemented)? The composite score could incorporate live-decayed ageWeight as a third factor.
- Does the 0.70 threshold need recalibration when the similarity metric changes from pure Jaccard to a blended score?

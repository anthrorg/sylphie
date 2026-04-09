# Idea: Concurrent Persistence Checks in the Perception Pipeline

**Created:** 2026-04-09
**Status:** proposed

## Summary

The perception pipeline's processing loop runs persistence checks sequentially — one `await find_match()` per confirmed track per frame. These are independent I/O-bound calls that could run concurrently with `asyncio.gather`, reducing per-frame latency proportionally to the number of confirmed tracks in the scene.

## Motivation

In `pipeline.py` (lines 476–482 of the processing loop), each confirmed track's persistence check is awaited one at a time:

```python
for track in updated_confirmed:
    obs = preliminary_obs_map.get(track.track_id)
    if obs is None:
        continue
    result = await self._persistence_check.find_match(obs)
    if result is not None:
        persistence_results[track.track_id] = result
```

Each `find_match` call crosses the CANON A.5 boundary into Layer 3, which involves graph traversal and scoring against known entities. When the scene contains multiple confirmed objects (e.g., 5 objects on a desk), the pipeline pays 5× the single-check latency on every processing frame. At 3 fps processing rate, this sequential I/O directly eats into the frame budget (~333ms per frame).

Since each persistence check is independent (different track, different observation, no shared mutable state between calls), they are safe to dispatch concurrently. A simple `asyncio.gather` would parallelize the Layer 3 lookups:

```python
async def _check_one(track: TrackedObject) -> tuple[TrackId, PersistenceResult | None]:
    obs = preliminary_obs_map.get(track.track_id)
    if obs is None:
        return track.track_id, None
    return track.track_id, await self._persistence_check.find_match(obs)

results = await asyncio.gather(*[_check_one(t) for t in updated_confirmed])
persistence_results = {tid: r for tid, r in results if r is not None}
```

This change is contained entirely within the pipeline's processing loop and doesn't alter any protocol interfaces or Layer 3 code.

## Subsystems Affected

- `perception-service` — `pipeline.py` (processing loop persistence check section)

## Open Questions

- Does the current `InMemoryGraphPersistence` backend have any hidden shared state that would make concurrent `find_match` calls unsafe? The protocol suggests they should be independent, but the implementation should be audited.
- Should there be a concurrency limit (e.g., `asyncio.Semaphore`) to avoid overwhelming Layer 3 if the scene has a very large number of confirmed tracks?
- Is the same pattern applicable to the feature extraction step (lines 407–438), which is currently also sequential? Those are CPU-bound rather than I/O-bound, so `run_in_executor` with a thread pool might be the right parallelization approach there.
- Should per-check latency be instrumented so the improvement can be measured empirically?

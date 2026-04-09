# Idea: Thread-safe state mutations and lazy-init in perception-service

**Created:** 2026-04-09
**Status:** proposed

## Summary

Several shared mutable singletons in `perception-service/main.py` (frame sequence counter, tracker state, embedding extractor lazy-init) are accessed from concurrent async/threaded contexts without synchronization, creating race conditions under concurrent `/detect` or `/stream` requests.

## Motivation

The perception service's `_AppState` class holds mutable state — most notably `frame_sequence`, the `IoUTracker` instance, and the lazily-initialized embedding extractor — that is read and written by multiple concurrent request handlers and the background pipeline loop. Today none of these access paths are protected by locks.

Concrete risks:

1. **`_state.frame_sequence` increment** — multiple concurrent `/detect` requests each increment this counter without a lock, so two requests can receive the same sequence number or skip values entirely.
2. **`_state.tracker._tracks` access** — the `/status` endpoint reads the tracker's private `_tracks` dict while the processing loop mutates it, risking a `RuntimeError: dictionary changed size during iteration`.
3. **Embedding extractor lazy-init** — the `_embedding_extractor is None` check followed by construction is a classic TOCTOU race; two concurrent requests can both see `None` and both attempt initialization, potentially wasting resources or causing partial-init failures.

None of these are catastrophic today because traffic is low (single camera, single client), but they will bite as soon as the service handles parallel streams or multiple clients — and the fixes are straightforward.

## Subsystems Affected

- `perception-service` — `main.py` (state mutations, lazy-init pattern)
- `perception-service` — `tracker.py` (expose a public `get_active_track_count()` instead of callers reaching into `_tracks`)

## Open Questions

- Should the lock be an `asyncio.Lock` (for async handlers) or a `threading.Lock` (for thread-executor work)? The answer likely depends on whether detection dispatched to the executor needs to touch shared state — if so, `threading.Lock` is required.
- Is it worth adding a concurrency semaphore to cap parallel `/detect` invocations (e.g., max 4) to provide backpressure, or should that be left to an API gateway?
- Should the embedding extractor lazy-init be replaced with eager init at startup behind a feature flag, eliminating the race entirely?

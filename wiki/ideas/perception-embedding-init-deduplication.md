# Idea: Deduplicate Embedding Extractor Lazy-Init in Perception Service

**Created:** 2026-04-10
**Status:** proposed

## Summary

Extract the duplicated OnnxEmbeddingExtractor double-checked-locking init pattern in `perception-service/main.py` into a single shared helper, eliminating the two nearly-identical copies that currently live inside `_compute_embedding` (the `/crop-face` endpoint) and `_extract_track_embedding`.

## Motivation

`main.py` is an 840-line monolith that contains two independent copies of the same thread-safe lazy-init block for `OnnxEmbeddingExtractor`. Both use the same `_embedding_init_lock`, the same `_state.embedding_extractor` slot, and the same fallback logic — but they diverge in small ways that create maintenance risk. For example, `_extract_track_embedding` sets a module-level `_embedding_init_failed` flag to short-circuit future attempts, while the `/crop-face` version does not, meaning a transient init failure in `/crop-face` will be retried on every request while the same failure in tracking silently gives up forever. This inconsistency is almost certainly unintentional.

Consolidating into a single `_get_or_init_embedding_extractor() -> OnnxEmbeddingExtractor | None` function would make the init semantics consistent, reduce the surface area for bugs when the init logic changes (e.g. adding a retry or switching to a different model), and be a first step toward breaking the monolith into smaller modules.

## Subsystems Affected

- `packages/perception-service/main.py` — primary change site; extract helper, update both call sites
- `packages/perception-service/tests/test_thread_safety.py` — may need updates if tests exercise the init path

## Open Questions

- Should the `_embedding_init_failed` short-circuit be kept? If a transient error (e.g. OOM loading the ONNX model) can self-resolve, retrying may be better than giving up permanently.
- Is this a good opportunity to also extract the embedding functions into their own module (e.g. `embedding.py`) as part of splitting the monolith?
- Should the extractor init move to startup time (in `_startup()`) rather than staying lazy, now that both endpoints rely on it?

# Idea: Observation Validation Pipeline Before Layer 3 Handoff

**Created:** 2026-04-09
**Status:** proposed

## Summary

Add a configurable validation/filtering step between observation building and Layer 3 ingestion so that malformed, low-quality, or noise observations are caught before they pollute the knowledge graph.

## Motivation

Currently, observations produced by `ObservationBuilder` cross directly into Layer 3 without any quality gate. This means tiny bounding boxes (sensor noise), extremely low-confidence detections that happen to survive tracking confirmation, and observations with degenerate feature profiles (e.g., all-zero embeddings from a failed ONNX run) can all be ingested into the knowledge graph. Over time this degrades graph quality and makes persistence matching less reliable because Layer 3 has to compare against junk nodes.

A lightweight validation pipeline sitting between Layer 2 output and Layer 3 intake would let us enforce invariants like minimum bounding-box area, minimum detection confidence for confirmed tracks, valid embedding norms, and sane spatial relationships — all without changing either the observation builder or the ingestion interface.

## Subsystems Affected

- `perception-service` — `pipeline.py` (insert validation step after observation building), new `observation_validator.py` module
- `shared` — `observation.py` (potentially add validation helpers or computed properties like `is_valid`)
- `perception-service/config.py` — new `ValidationConfig` section for thresholds

## Open Questions

- Should rejected observations be silently dropped, or logged/counted for diagnostics?
- Should validation be a hard gate (reject) or soft (attach a quality score that Layer 3 can use)?
- What's the right minimum bounding-box area fraction — needs empirical tuning per camera setup?
- Should we validate feature profiles (e.g., embedding L2 norm within expected range) or trust the extractors?

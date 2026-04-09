# Idea: Configurable Persistence Check Weight Profiles

**Created:** 2026-04-09
**Status:** proposed

## Summary

The `PersistenceCheckService` in `perception-service` hardcodes two critical weight dictionaries (`_NEW_WEIGHTS`, `_KNOWN_WEIGHTS`) and their match thresholds (`_NEW_THRESHOLD`, `_KNOWN_THRESHOLD`) as module-level constants. These should be promoted to `PersistenceCheckConfig` fields so they can be tuned at runtime without code changes.

## Motivation

The weight profiles control how Sylphie decides whether a newly detected object matches a known entity — the core of Piaget R1 dynamic weighting. Today's values (`spatial: 0.50`, `embedding: 0.25`, `color: 0.15`, `size: 0.05`, `label_raw: 0.05` for new objects) were chosen during initial development and cannot be adjusted without editing `persistence_check_service.py` directly. This makes it impossible to:

- **A/B test** different weight profiles to measure recognition accuracy.
- **Tune per-environment** — a stationary desktop camera has different spatial reliability than a moving robot camera, so spatial weight should be adjustable.
- **Iterate on thresholds** — the `_NEW_THRESHOLD = 5` and `_KNOWN_THRESHOLD = 10` values gate match acceptance but have no way to be adjusted during experiments or evaluation runs.

Moving these into `PersistenceCheckConfig` (Pydantic `BaseModel`) means they become overridable via environment variables, config files, or constructor injection during tests — all without touching the service code.

## Subsystems Affected

- `perception-service` — `persistence_check_service.py` (extract constants into config)
- `perception-service` — `config.py` (add `PersistenceCheckConfig` fields with current values as defaults)
- `perception-service` — `main.py` (wire config through to service constructor)

## Open Questions

- Should weight profiles be validated (e.g., must sum to 1.0) at config load time, or left flexible for experimentation?
- Is there value in supporting named profile presets (e.g., `"stationary-camera"`, `"mobile"`) in addition to raw weight dicts?
- Should threshold changes emit a log line or metric so tuning sessions are auditable?
- The `ObservationBuilder.debounce_iou_threshold` (hardcoded at 0.95) has the same configurability gap — should it be addressed in the same pass?

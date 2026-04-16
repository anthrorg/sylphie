# Idea: Replace Uniform Fisher with Real Fisher Diagonal in EWC Regularizer

**Created:** 2026-04-13
**Status:** proposed

## Summary

The `EWCRegularizer` in `packages/cognition-service/training/replay.py` (line 73) uses a uniform Fisher information matrix (all ones) as a stand-in for the real Fisher diagonal. This reduces EWC to simple L2 weight anchoring — all parameters are treated as equally important. The real implementation should compute the Fisher diagonal from squared gradients of the log-likelihood over a held-out calibration dataset after each operational phase.

## Motivation

Uniform Fisher means the regularizer resists drift equally for all weights, regardless of how important they are to previously learned tasks. This is functional but suboptimal: unimportant weights that should be free to change are over-constrained, while critical weights may not be protected strongly enough. As Sylphie transitions between operational phases (bootstrap → audit → partial autonomy), proper EWC is needed to prevent catastrophic forgetting of earlier knowledge while still allowing new learning.

## Subsystems Affected

- **cognition-service/training** — `replay.py` EWCRegularizer needs `_compute_real_fisher()` method.
- **cognition-service** — Needs a calibration dataset path or held-out sample mechanism.
- **cognition-service/training/trainer.py** — Needs to call `set_reference()` with real Fisher at phase transitions.

## Open Questions

- Where does the held-out calibration dataset come from? Should it be sampled from the DataBuffer at phase-end?
- How many samples are needed for a stable Fisher estimate with the current model size?
- Should Fisher computation happen synchronously (blocking phase transition) or asynchronously?

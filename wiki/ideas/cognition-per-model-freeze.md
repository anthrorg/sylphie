# Idea: Implement Per-Model Freeze in Cognition Service

**Created:** 2026-04-13
**Status:** proposed

## Summary

The `/cognition/control/freeze` endpoint in `packages/cognition-service/main.py` (line 465-478) supports freezing all models by stopping the trainer entirely, but per-model freeze (freezing a specific named model while others continue training) logs a message and does nothing. The comment notes this "requires trainer refactor."

## Motivation

Per-model freeze is needed for fine-grained control during operational phase transitions. For example, the Supervisor may want to freeze the action-selection head while the category head continues learning, or freeze all models except the auxiliary output during bootstrap. Without per-model freeze, the only option is a full training halt, which is too coarse for the graduated operational phases described in CANON.

## Subsystems Affected

- **cognition-service** — Trainer needs a model registry that can selectively disable gradient updates per model/head.
- **cognition-service/training** — The training loop needs to check per-model freeze flags before computing gradients.

## Open Questions

- What are the valid model names? Should they map to the neural network heads (category, action, auxiliary)?
- Should freeze state persist across trainer restarts, or is it session-scoped?
- Does unfreezing a model also need a dedicated endpoint, or is the existing unfreeze endpoint sufficient?

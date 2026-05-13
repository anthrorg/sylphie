# Idea: Wire opportunityFeatures Into Tensor Inference Adapter

**Created:** 2026-04-27
**Status:** proposed

## Summary

`DecisionMakingService` (`packages/decision-making/src/decision-making.service.ts`, line 571) calls `this.tensorInference.infer(...)` and explicitly omits the `opportunityFeatures` field with the comment "opportunityFeatures requires drive engine exposure -- omitted for now". The tensor inference adapter therefore runs without the opportunity-signal feature inputs that its interface allows for, blunting the model's ability to bias action selection toward currently-active opportunities.

## Motivation

Opportunities are first-class signals in CANON §Subsystem 5 (Planning) and §Drive Engine -- prediction failures and curiosity gaps create opportunities, and the Decision Making subsystem is supposed to weigh them when selecting actions. If the tensor model is trained or designed to consume opportunity features but they are never populated, the model effectively learns the zero distribution for that input, and any future enabling of the feature will silently shift model behavior. Wiring the feature now -- even as a stub-but-real signal from the Drive Engine -- keeps train/eval inputs honest.

## Subsystems Affected

- **decision-making** -- `decision-making.service.ts` needs to read opportunity features from the Drive Engine (likely via the existing IPC channel or TimescaleDB query) and pass them to `tensorInference.infer()`.
- **drive-engine** -- Needs to expose the opportunity queue / current opportunity vector in a form consumable by the tensor adapter.
- **shared** -- The shape of `opportunityFeatures` may need to be added to a shared interface.

## Open Questions

- Are opportunity features a fixed-size vector (top-K opportunities) or a variable bag of structured records?
- Should the feature be sourced from the live Drive Engine state (low-latency) or from recent TimescaleDB events (consistent but slightly stale)?
- Does the existing tensor checkpoint expect this input slot, or will enabling it require retraining?

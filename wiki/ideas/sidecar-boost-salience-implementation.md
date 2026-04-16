# Idea: Implement boost_salience Intervention on Cognition Sidecar

**Created:** 2026-04-13
**Status:** proposed

## Summary

The `SidecarControlService` in `packages/supervisor/src/sidecar-control.service.ts` (lines 92-97) handles the `boost_salience` intervention type by logging a message and returning `{accepted: true}` without actually boosting salience. The cognition sidecar has no corresponding endpoint to receive this signal.

## Motivation

Boost salience is a supervisor intervention that should increase the model's attention to a specific pattern or category — for example, after detecting that Sylphie is under-reacting to a particular type of input. Without it, the supervisor can recommend salience boosts but they have no effect, leaving one arm of the feedback loop disconnected.

## Subsystems Affected

- **supervisor** — `sidecar-control.service.ts` needs a real HTTP call to a cognition endpoint.
- **cognition-service** — Needs a `/cognition/control/boost_salience` endpoint that adjusts internal attention weights or training priority for specified patterns.

## Open Questions

- What does "boost salience" mean concretely in terms of the neural network? Is it a training weight multiplier, an attention mask adjustment, or a replay buffer priority change?
- How long should a salience boost last? Is it permanent until explicitly removed, or does it decay?
- What parameters does the endpoint need (pattern/category to boost, magnitude, duration)?

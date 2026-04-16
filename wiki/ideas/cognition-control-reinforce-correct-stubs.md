# Idea: Wire Cognition Control Reinforce and Correct Endpoints

**Created:** 2026-04-13
**Status:** proposed

## Summary

The `/cognition/control/reinforce` and `/cognition/control/correct` endpoints in `packages/cognition-service/main.py` (lines 448-462) accept requests and log them but perform no actual training action. The reinforce endpoint should strengthen current weights for a pattern, and the correct endpoint should inject a corrective sample into the training buffer with high priority. Both currently return `{"accepted": True}` without modifying any model state.

## Motivation

These endpoints are the feedback path from the Supervisor and Guardian subsystems into the cognition training pipeline. Without them, supervisory verdicts that call for reinforcement or correction are silently dropped — the system accepts the signal but never acts on it. This means the self-improvement loop is broken at the final step: the Supervisor can evaluate and recommend, but the cognition service cannot learn from that feedback.

## Subsystems Affected

- **cognition-service** — `main.py` reinforce/correct handlers need to interact with the Trainer and DataBuffer to inject samples or adjust training weights.
- **cognition-service/training** — DataBuffer may need a `inject_priority_sample()` method; Trainer may need a `reinforce_current()` method.
- **supervisor** — Already sends these signals via SidecarControlService; no changes needed there.

## Open Questions

- What format should the corrective sample take? Does the caller provide input/output pairs, or just a signal strength?
- Should reinforcement use the EWC reference point mechanism, or a separate "positive replay" buffer?
- What priority weighting should corrective samples get in the DataBuffer sampling?

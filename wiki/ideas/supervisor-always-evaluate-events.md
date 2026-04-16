# Idea: Wire Always-Evaluate Events in Supervisor Sampling

**Created:** 2026-04-13
**Status:** proposed

## Summary

The `shouldEvaluate()` method in `packages/supervisor/src/supervisor.service.ts` (line 229) has a TODO to check for always-evaluate events like `guardian_feedback` and `attractor_alert`. Currently, these high-importance events are subject to the same sampling rate as ordinary cycles, meaning they may be skipped by the supervisor even though they represent critical safety signals.

## Motivation

Guardian feedback and attractor alerts are safety-critical events that should always receive supervisor evaluation regardless of the sampling rate. Missing a guardian feedback event means the Supervisor might not learn from a rule violation, and missing an attractor alert means a potential psychological attractor state goes unreviewed. The sampling policy already has `burstMode` for catching up, but individual high-importance events should bypass sampling entirely.

## Subsystems Affected

- **supervisor** — `supervisor.service.ts` shouldEvaluate() needs to inspect the cycle for guardian/attractor event markers.
- **guardian** — May need to tag cycles that contain guardian feedback so the supervisor can detect them.
- **decision-making/monitoring** — Attractor alerts need to be propagated as metadata on the cycle response.

## Open Questions

- How are guardian_feedback and attractor_alert events surfaced on the CycleResponse? Is there a metadata field, or does the supervisor need to inspect the cycle's event log?
- Should always-evaluate also apply to other event types (e.g., first interaction with a new person, skill installation)?
- Does always-evaluate override the cost budget, or should it count against the budget but never be skipped?

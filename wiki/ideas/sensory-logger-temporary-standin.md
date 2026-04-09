# Idea: Remove SensoryLoggerService After Executor Engine Tick Loop Is Wired

**Created:** 2026-04-09
**Status:** proposed

## Summary

`SensoryLoggerService` (`apps/sylphie/src/services/sensory-logger.service.ts`) is explicitly documented as "a temporary stand-in for the executor engine's tick loop." It runs a `setInterval` at 2000ms to sample the sensory pipeline and broadcast to telemetry. Once the executor engine calls `tickSampler.sample()` on its own cadence, this service should be removed.

## Motivation

The service creates a parallel sampling loop independent of the decision-making cycle. This means sensory data is sampled on a fixed 2s interval regardless of the executor engine's actual tick rate, which could cause timing mismatches between what the telemetry shows and what the decision-making system actually processes. The executor engine (`executor-engine.service.ts`) now appears to be wired and running cycles — it may be time to verify whether the SensoryLoggerService is still needed or if it's now redundant.

## Subsystems Affected

- **apps/sylphie** — Remove `SensoryLoggerService` from `app.module.ts` providers and delete the file.
- **decision-making** — Verify executor engine is calling `tickSampler.sample()` and broadcasting to telemetry on its own cadence.

## Open Questions

- Is the executor engine's tick loop currently active and sampling the sensory pipeline?
- Does removing this service break the telemetry panel in the frontend, or does the executor engine already emit the same data?
- Should the telemetry broadcast be moved into the executor engine's cycle directly?

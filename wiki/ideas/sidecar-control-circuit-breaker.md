# Idea: Circuit Breaker and Health-Aware Retry for SidecarControlService

**Created:** 2026-04-10
**Status:** proposed

## Summary

The `SidecarControlService` in `packages/supervisor/src/sidecar-control.service.ts` has no circuit breaker, retry logic, or health tracking for its HTTP calls to the cognition sidecar. When the sidecar is temporarily unavailable (restart, deployment, resource pressure), every intervention fires individually, fails, logs a warning, and is silently lost. Adding a circuit breaker pattern with queued retry would prevent intervention loss during transient outages and reduce noisy log spam.

## Motivation

Three concrete problems in the current implementation:

1. **Lost interventions during sidecar restarts:** If the supervisor issues a `correct` or `reinforce` intervention while the sidecar is restarting, the call fails and returns `{ accepted: false }`. The supervisor has no mechanism to retry — the intervention is permanently lost. For corrective interventions this means the model doesn't learn from a mistake the supervisor already identified.

2. **No health awareness:** The service calls the sidecar on every request with a fixed 10-second timeout. There is no tracking of consecutive failures. If the sidecar is down for 30 seconds, every intervention in that window generates a failed HTTP request + warn log, creating unnecessary load and log noise.

3. **No backoff or jitter:** The `post()` helper fires immediately on every call. If multiple supervisor cycles overlap during a sidecar outage, they all hit the same dead endpoint simultaneously rather than backing off.

A circuit breaker (closed → open → half-open) would short-circuit calls when the sidecar is known to be down, queue critical interventions (correct, reinforce) for retry when the circuit closes, and expose health state to the dashboard via `getModelState()` returning a cached last-known-good value instead of null.

## Subsystems Affected

- `supervisor` — `sidecar-control.service.ts` (primary change)
- `supervisor` — `supervisor.service.ts` (consume health state for verdict decisions)
- `apps/sylphie` — player-view dashboard (display sidecar health status)

## Open Questions

- Should queued interventions have a TTL after which they're dropped as stale?
- What's the right threshold for tripping the circuit — 3 consecutive failures? 5?
- Should `reinforce` and `correct` have different retry priorities (corrections arguably more critical)?
- Is there an existing circuit breaker library in the Node ecosystem worth adopting (e.g., `opossum`) vs. rolling a lightweight one?

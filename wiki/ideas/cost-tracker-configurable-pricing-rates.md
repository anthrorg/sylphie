# Idea: Configurable LLM Pricing Rates in Cost Tracker

**Created:** 2026-04-10
**Status:** proposed

## Summary

Move the hardcoded DeepSeek per-token pricing rates in `CostTrackerService` out of source code and into environment-level configuration, so pricing changes become operational updates instead of code deployments.

## Motivation

The cost tracker in `packages/supervisor/src/cost-tracker.service.ts` currently hardcodes DeepSeek pricing at `$0.28/M input` and `$0.42/M output` (lines 44-46). These rates are baked into a `const` calculation with no configurability. When DeepSeek updates its pricing — which model providers do regularly — the cost tracker will silently report inaccurate numbers. There is no observability around the rates being used, so cost drift would go unnoticed until someone manually audits the budget.

Making the rates configurable via `ConfigService` (environment variables with sensible defaults) means pricing updates require zero code changes and zero redeployments. It also enables better observability by logging the active rates, and prevents inconsistency if other parts of the system ever need to reference the same pricing.

## Subsystems Affected

- Supervisor (`cost-tracker.service.ts` — replace hardcoded constants with config-driven values)
- Supervisor types (`supervisor.types.ts` — optionally extend `SamplingPolicy` to expose active rate info)
- Shared config (if a centralized pricing config is preferred over per-service env vars)

## Open Questions

- Should pricing config live per-service (env vars like `DEEPSEEK_INPUT_PRICE_PER_M`) or in a shared config module that any service can reference?
- Should there be a staleness check — e.g., a `PRICING_LAST_VERIFIED` date that triggers a warning log if it's more than 90 days old?
- If other packages (decision-making, learning) also call DeepSeek, do they have their own hardcoded rates that should be consolidated?
- Should the cost tracker log the active pricing rates on startup so operators can verify at a glance?

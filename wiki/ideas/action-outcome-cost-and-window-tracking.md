# Idea: Compute Real Cost and Window Boundaries in Action Outcome Reporter

**Created:** 2026-04-13
**Status:** proposed

## Summary

The `ActionOutcomeReporterService` in `packages/drive-engine/src/action-outcome-reporter.service.ts` (lines 158-159) hardcodes `estimatedCostUsd: 0` and `windowStartAt: now` in the SoftwareMetricsPayload. The cost should be computed from token count and model pricing, and the window boundaries should reflect the actual measurement window rather than the current timestamp.

## Motivation

Zero cost reporting means the drive engine's software metrics provide no useful cost data to the drive equations. The Cognitive Effort drive, which uses LLM cost as an input signal, receives no information about actual resource expenditure. Similarly, using `now` for both window start and end makes temporal analysis of LLM usage patterns impossible. Both values are available from upstream — they just need to be threaded through.

## Subsystems Affected

- **drive-engine** — `action-outcome-reporter.service.ts` needs caller-provided window boundaries and a cost computation function.
- **decision-making** — The caller that invokes the reporter should pass timing data for window boundaries.
- **shared** — May benefit from a shared cost-computation utility that takes token counts and model tier.

## Open Questions

- Should cost computation use the same pricing configuration as the Supervisor's CostTracker, or be independent?
- Who owns the window start timestamp — the decision cycle that initiated the action, or the drive tick that triggered metrics collection?
- Should this block on getting the pricing config right, or use a reasonable default (e.g., the DeepSeek rates) as an interim?

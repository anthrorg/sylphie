# Idea: Sample-Size-Aware Confidence and Risk in Simulation

**Created:** 2026-04-27
**Status:** proposed

## Summary

Replace the current `confidenceEstimate = min(0.8, successRate)` and `riskScore = 1 - successRate` formulas in `SimulationService.evaluateCategory` with estimators that incorporate sample size and effect variance, so a single lucky outcome cannot produce the same confidence as 50 consistent ones.

## Motivation

In `packages/planning/src/pipeline/simulation.service.ts` (lines 199-208), `evaluateCategory` already tracks `totalCount` (number of historical outcomes for the category) but discards it when computing the two scores that downstream consumers actually depend on:

```ts
const successRate = totalCount > 0 ? successCount / totalCount : 0;

return {
  ...,
  confidenceEstimate: Math.min(0.8, successRate),
  riskScore: 1.0 - successRate,
};
```

This has three concrete failure modes:

1. **Tiny-sample over-confidence.** One historical outcome marked `'positive'` yields `successRate = 1.0`, which clamps to `confidenceEstimate = 0.8` and `riskScore = 0.0` — identical to a category with 50/50 successes. The proposer's LLM prompt prints these values verbatim (`proposal.service.ts:138-139`) and the planning service logs `bestRiskScore` (`planning.service.ts:523`), so spurious certainty propagates into both the plan rationale and the operator-facing telemetry.

2. **Confidence and risk are the same signal.** `riskScore = 1 - successRate` and `confidenceEstimate = min(0.8, successRate)` are perfectly anti-correlated up to the 0.8 cap. Two fields, one bit of information — there is no way for a category to be "high-confidence but high-risk" (e.g., we're sure the average effect is small *and* highly variable) or "low-confidence but low-risk" (e.g., few samples but all clustered tightly).

3. **Effect variance is invisible.** The loop sums `effect * count` to compute `avgEffect`, but never records the spread. A category whose historical effects are `[-0.3, -0.3, -0.3]` and one whose effects are `[-0.9, +0.3, -0.3]` produce the same `avgEffect = -0.3` and the same `riskScore`, even though the second is clearly riskier in the everyday sense of the word.

A more honest pair of estimators would:

- **Shrink confidence toward a prior** based on `totalCount`. Something like `confidence = totalCount / (totalCount + k)` where `k` is the number of samples needed to "trust" the estimate (e.g., `k = 10`). With one sample, confidence ≈ 0.09; with 50 samples, ≈ 0.83. Multiply this by `successRate` if a success-aware confidence is still desired, or keep the two factors separate.
- **Derive risk from variance**, not from success rate. While iterating the rows the loop can also accumulate `effect² * count` to compute the standard deviation of the historical drive effect, then map that to `[0, 1]` via a simple normalizer (e.g., `min(1, stdev / σ_max)`). Categories with consistent effects get low risk; chaotic categories get high risk, even if their average looks fine.

The change is contained to one method, doesn't alter the `SimulatedOutcome` shape, and immediately improves the signal that the proposal prompt and outcome ranking already consume.

## Subsystems Affected

- **Planning** (SimulationService) — primary change site; `evaluateCategory` aggregation loop and the no-data branch (which currently returns `confidenceEstimate: 0.2, riskScore: 0.5` — should slot into the same prior-based formula instead of being a magic pair)
- **Planning** (ProposalService) — indirect consumer; the LLM prompt already prints these values, so improved estimates flow through without code changes
- **Decision Making / monitoring** — `planning.service.ts` logs `bestRiskScore` in its event payload, so dashboards reading this value will start to mean something

## Open Questions

- What should the shrinkage prior `k` be? It should probably scale with `MAX_OUTCOMES_PER_CATEGORY` (currently 50) — `k = MAX_OUTCOMES_PER_CATEGORY / 5` is a starting heuristic.
- Should the no-historical-data branch (line 167-173) return `confidenceEstimate: 0` rather than `0.2`? The current `0.2` looks like a hand-picked floor; under a shrinkage formula with `totalCount = 0` the confidence falls out at zero, which is the more honest answer.
- Should `riskScore` blend variance with success rate (e.g., `0.5 * variance_term + 0.5 * (1 - successRate)`) or commit to variance only? Variance-only is cleaner but loses the signal of "this category technically averages negative drive effect but most of its outcomes were tagged failures."
- Does the existing `GROUP BY payload` in the SQL (line 160) interact badly with this — i.e., does the grouping mean `count` is per-distinct-payload rather than per-occurrence, biasing variance estimates? Worth verifying during implementation.

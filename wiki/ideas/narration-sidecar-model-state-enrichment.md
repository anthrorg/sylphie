# Idea: Enrich Supervisor Narrations with Sidecar Model State

**Created:** 2026-04-13
**Status:** proposed

## Summary

Wire `SidecarControlService.getModelState()` into `NarrationBuilderService.buildNarration()` so that supervisor narrations include the cognition sidecar's convergence score, global model confidence, and per-panel divergence — giving the DeepSeek evaluator critical context about how confident the tensor pipeline was when it produced the decision.

## Motivation

`NarrationBuilderService.buildNarration()` currently hardcodes three sidecar-related fields to `undefined`:

```ts
convergenceScore: undefined,
globalModelConfidence: undefined,
panelDivergenceScores: undefined,
```

The comment says "populated when cognition-service is running", but no code path ever populates them. Meanwhile, `SidecarControlService.getModelState()` already exists and returns `training_loss`, `training_active`, `bootstrap_mode`, and per-model parameter counts — all of which could be used to derive meaningful values for those fields.

Without this context, the supervisor LLM evaluates every decision as if the tensor pipeline is equally confident in all of them. In practice, a "questionable" verdict during early bootstrap (low convergence, high loss) is expected and shouldn't trigger the same concern as a "questionable" verdict from a well-converged model. The supervisor is currently blind to this distinction, which means:

- It may over-flag early-stage decisions that are naturally noisy
- It may under-flag late-stage regressions where the model should know better
- The `suggested_correction` field in verdicts can't account for model confidence when recommending reinforce vs. correct

The sidecar state endpoint already has a 5-second timeout and gracefully returns `null` when the sidecar is down, so the narration builder can safely attempt the call and fall back to `undefined` fields if the sidecar is unavailable.

## Subsystems Affected

- Supervisor (`narration-builder.service.ts` — inject `SidecarControlService`, call `getModelState()`, map response to narration fields)
- Supervisor (`supervisor.service.ts` — make `buildNarration` async, pass sidecar state through)
- Supervisor types (`supervisor.types.ts` — may need to refine the types for `panelDivergenceScores`)

## Open Questions

- Should the sidecar state be fetched per-narration, or cached with a short TTL (e.g., 30s) to avoid hammering the sidecar endpoint on burst-mode sampling?
- How should `convergenceScore` be derived from the raw sidecar state? Candidates: inverse of `training_loss`, a normalized metric from panel parameter ratios, or a dedicated convergence endpoint on the sidecar.
- Should `panelDivergenceScores` be computed from the per-panel parameter counts, or does the sidecar need to expose actual divergence metrics?
- Does the DeepSeek supervisor system prompt need to be updated to explain what the new fields mean, or will it interpret them correctly from the field names and values?
- Should the narration builder also include `bootstrap_mode` as a field so the supervisor can adjust its evaluation strictness during bootstrap?

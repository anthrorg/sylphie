# Idea: Behavioral Baseline Summary in Supervisor Narrations

**Created:** 2026-04-13
**Status:** proposed

## Summary

Inject a compact behavioral baseline digest into each `DecisionNarration` — derived from the `recentVerdicts` buffer — so the DeepSeek supervisor can evaluate consistency (criterion #4 in its system prompt) against actual observed patterns instead of guessing.

## Motivation

The supervisor's system prompt instructs the LLM to evaluate "Consistency: Does this decision align with established behavioral patterns, or is it an unexpected deviation?" but the `DecisionNarration` object contains zero behavioral history. Each evaluation is entirely stateless — the LLM receives only the current cycle's snapshot and has no context about what Sylphie has been doing recently.

This means criterion #4 is effectively unevaluable. The LLM either skips it, hallucinates a baseline, or gives a generic "seems consistent" response. Meanwhile, the `recentVerdicts` buffer in `SupervisorService` already holds up to 100 recent verdicts with ratings, action names, dominant drives, and timestamps — exactly the data needed to derive a behavioral baseline.

A compact baseline digest (not the full 100 verdicts) appended to the narration would let the supervisor detect:

- Action distribution shifts (e.g., suddenly using a new action type that hasn't appeared in recent history)
- Drive-response mismatches relative to recent patterns (e.g., Sylphie usually addresses curiosity drive pressure but suddenly ignores it)
- Rating trend context (e.g., "last 10 verdicts were all good" vs. "3 of the last 5 were questionable") which informs how alarming a new questionable verdict is
- Escalation pattern changes (e.g., Type 2 escalation rate increasing without a corresponding increase in novel inputs)

Without this, the supervisor is blind to gradual behavioral drift — the kind of regression that is invisible per-cycle but obvious over a window of 10-20 cycles.

## Subsystems Affected

- Supervisor (`narration-builder.service.ts` — accept recent verdicts as input, compute and attach a baseline digest to `DecisionNarration`)
- Supervisor (`supervisor.service.ts` — pass `recentVerdicts` slice to `buildNarration()`)
- Supervisor types (`supervisor.types.ts` — add a `BehavioralBaseline` type and optional field on `DecisionNarration`)
- Supervisor system prompt (update to explain the new baseline fields so DeepSeek uses them correctly)

## Open Questions

- What's the right window size for the baseline? The full 100-verdict buffer is too large to serialize cheaply. A rolling window of the last 10-20 verdicts is probably sufficient.
- What format should the baseline take? Candidates: a short natural-language summary (cheap to generate, easy for the LLM to parse), a structured object with counts and distributions (precise but adds tokens), or a hybrid with one sentence plus key stats.
- Should the baseline be computed eagerly on each verdict emission and cached, or lazily when a narration is built? Eager is cheaper per-narration but wastes work on non-sampled cycles.
- How many tokens does the baseline add to the narration? The current target is 300-500 tokens; if the baseline adds 100-150, that's a ~25% cost increase per evaluation — worth measuring against the quality improvement.
- Should the narration include raw recent verdicts (e.g., last 5 ratings as a list) in addition to aggregated stats, so the LLM can spot immediate patterns?

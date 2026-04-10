# Idea: Adaptive Candidate Scoring Weights via Outcome Feedback

**Created:** 2026-04-09
**Status:** proposed

## Summary

The deterministic `scoreCandidates()` function in `DeliberationService` uses hardcoded weights (e.g., +1.0 for GROUNDED, -0.5 for chatbot language, -0.7 for "I don't know" in conversational context, +0.15 for WKG entity mention, -0.1 for verbosity). These weights could be learned and adapted over time by feeding outcome signals from the Confidence Updater and drive-effect evaluations back into the scoring parameters, making the candidate selection self-improving.

## Motivation

Right now the scoring weights are static guesses baked into the code. They work as reasonable defaults, but Sylphie has no way to discover that, say, in her specific conversational context, the chatbot-language penalty should be stronger or that entity mentions matter more than grounding for certain intent types. The system already produces the outcome data needed to close this loop — the Confidence Updater tracks reinforcement and counter-indication, and the Prediction Service evaluates drive-effect MAE — but none of that feeds back into candidate selection weights. Closing this loop would create a second axis of Type 2 → Type 1 learning: not just graduating whole patterns to the latent space, but also tuning the deliberation heuristics that pick between candidates when Type 2 reasoning is still needed.

## Subsystems Affected

- Decision Making (deliberation/deliberation.service.ts — `scoreCandidates()`)
- Decision Making (confidence/confidence-updater.service.ts — outcome signal source)
- Decision Making (prediction/prediction.service.ts — drive-effect MAE signal source)
- Learning (could orchestrate the weight update cycle)

## Open Questions

- Should weights be tuned per-intent (GREETING vs FACT vs EMOTION) or globally?
- What update rule fits best — simple EMA on outcome-correlated deltas, or something more like bandit-style Thompson sampling?
- How to prevent weight drift from collapsing diversity (e.g., grounding weight goes to +5.0 and dominates everything)?
- Should there be a minimum observation window before adjusting (e.g., 50 scored selections per intent)?
- Where should the learned weights be persisted — TimescaleDB, or a lightweight config row in the WKG?

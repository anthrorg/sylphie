# Idea: Adaptive Supervisor Sampling Based on Verdict Trends

**Created:** 2026-04-10
**Status:** proposed

## Summary

Replace the supervisor's fixed 1-in-N sampling rate with an adaptive algorithm that tightens sampling when recent verdicts trend toward "questionable" or "wrong", and relaxes back to the baseline rate when decisions stabilize as "good" or "acceptable".

## Motivation

Currently `SupervisorService.shouldEvaluate()` uses a static modulo check (`cycleCount % sampleRate === 0`) regardless of what the supervisor has been observing. If the last five evaluated cycles all received "questionable" verdicts, the supervisor still only checks 1-in-10 — meaning 9 potentially problematic cycles pass unobserved between each check. Conversely, during long stretches of "good" verdicts, the supervisor spends budget evaluating cycles that are almost certainly fine.

An adaptive approach would make the supervisor more responsive when things are going wrong (catching drift or regression quickly) while conserving the daily DeepSeek budget during stable periods. The existing `burstMode` flag is the only current mechanism and it's binary — either evaluate everything or follow the fixed rate. An adaptive middle ground would be far more practical for day-to-day operation.

The `recentVerdicts` buffer (capped at 100) already exists in `SupervisorService` and could serve as the trend input without any new state.

## Subsystems Affected

- Supervisor (`supervisor.service.ts` — `shouldEvaluate()` logic, `SamplingPolicy` type)
- Supervisor types (`supervisor.types.ts` — extend `SamplingPolicy` with adaptive fields)
- Cost tracker (`cost-tracker.service.ts` — may need to expose a projected daily cost so the adaptive algorithm can factor remaining budget into its rate decisions)

## Open Questions

- What window size over `recentVerdicts` gives the best signal? (Last 5? Last 10? Exponential moving average?)
- Should the rate floor be 1-in-1 (effectively burst mode) or something like 1-in-2 to still conserve budget?
- Should the rate ceiling (most relaxed) exceed the configured `sampleRate`, e.g., go up to 1-in-20 during very stable stretches?
- How should the algorithm interact with `burstMode`? Override it, or treat burst as a separate manual override?
- Should the adaptive rate factor in budget remaining (e.g., tighten less aggressively when budget is low)?
- The `alwaysEvaluate` events in `SamplingPolicy` are still a TODO — should this work land first, or should adaptive sampling account for those event types in its trend calculation?

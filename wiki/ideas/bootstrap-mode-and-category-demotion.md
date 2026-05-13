# Idea: Bootstrap Mode and Category Demotion

**Created:** 2026-04-27
**Status:** proposed

## Summary

`BootstrapTracker` in `packages/cognition-service/inference/bootstrap.py` only advances mode and category status forward (shadow → audit → partial → full; ungraduated → graduated). There is no path for a category to lose its graduated status, and no path for the overall mode to step back to a more conservative LLM-led setting if agreement deteriorates after handoff. Add per-category demotion and mode regression so that a category which falls back below the agreement threshold (or sustained overall agreement that drops below the full-handoff threshold) is automatically returned to LLM-led decision-making.

## Motivation

CANON's confidence dynamics treat Type 1 / Type 2 arbitration as a two-way mechanism: knowledge and skills graduate when evidence supports them, and they demote when evidence stops supporting them. The current bootstrap implementation honors only the graduation half. The risks this creates:

- **Silent drift after distribution shift.** Once a category graduates, `should_use_tensor()` returns `True` permanently for that category, regardless of whether the tensor's agreement with the LLM has since collapsed (e.g. because a new conversation domain, guardian, or skill changed the input distribution). The system would keep using a now-bad tensor head with no auto-correction.
- **No lesion-test recovery.** If full mode is reached and the tensor regresses (training instability, a bad checkpoint, EWC under-fitting a task), there is no mechanism to fall back to audit or partial. The LLM safety net has been removed.
- **Per-category staleness.** The 100-sample sliding window keeps recording new comparisons even after graduation, so the data needed to decide demotion is already being collected — it is just not being read for that purpose.

Adding demotion is small, local, and CANON-aligned: it strengthens the Shrug Imperative (when the tensor drifts, hand back to a path that can express incomprehension or escalate to Type 2) and keeps Type 1 graduation honest by making it conditional on sustained, not one-time, agreement.

A secondary concern worth considering in the same idea: bootstrap state is in-memory only (`_category_history`, `_graduated_categories`, `mode`). Service restart resets everything, which means demotion logic alone is not sufficient — without persistence, a restart silently reverses both graduation and demotion decisions.

## Subsystems Affected

- **cognition-service / inference** — `BootstrapTracker` (`bootstrap.py`) needs a `check_demotions()` symmetric to `check_graduations()`, a `_demotion_threshold` (likely lower than `_graduation_threshold` to provide hysteresis), a minimum-sample requirement for demotion, and reverse mode transitions in `check_mode_transition`.
- **cognition-service / main** — `/cognition/bootstrap/status` and the lifecycle around `record_comparison` should expose demotion events; `BOOTSTRAP_MODE` env var becomes a startup hint, not a permanent floor.
- **cognition-service / control endpoints** — `/cognition/control/freeze` and the bootstrap control surface should be reviewed for interaction with demotion (e.g. should a frozen model be eligible to demote?).
- **supervisor** — The supervisor currently observes mode advancement events; it will need to react to mode regression events as well, and possibly treat them as a salience signal for narration / inner monologue.

## Open Questions

- What is the right hysteresis gap between graduation (0.85) and demotion thresholds? A naive symmetric 0.85 risks rapid oscillation; something like 0.70 with a 50-sample minimum window may be more stable.
- Should demotion require a sustained drop (e.g. agreement under threshold for N consecutive `check_demotions()` calls) rather than a single check below threshold?
- How should mode regression events be reported — are they reinforcement-bearing (failed predictions about Type 1 capability) or purely operational?
- Does demotion warrant persistence of `_category_history` and `_graduated_categories` across service restarts, or is the in-memory window acceptable given that a restart effectively re-enters shadow mode?
- For full → partial regression, which categories stay graduated and which return to LLM control? Is it the union of categories still above threshold, or do we degrade everything by one step on regression?
- Should guardian feedback (per CANON's Guardian Asymmetry: 2x confirm, 3x correction) also influence demotion — e.g., a guardian correction on a tensor-led action counts more heavily against the agreement window than a passive disagreement?

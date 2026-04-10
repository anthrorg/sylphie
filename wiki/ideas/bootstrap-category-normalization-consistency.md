# Idea: Bootstrap Category Normalization Consistency

**Created:** 2026-04-10
**Status:** proposed

## Summary

The `record_comparison` method in `bootstrap.py` normalizes categories with `.lower()` only, while `ActionVocabulary` in `trainer.py` uses `.strip().lower()`. This asymmetry can cause false disagreements in bootstrap agreement tracking when categories arrive with leading/trailing whitespace.

## Motivation

Bootstrap mode graduation depends on accurate agreement tracking between tensor and LLM outputs. If a category like `" ConversationalResponse "` gets normalized differently in the two code paths — `" conversationalresponse "` in bootstrap vs `"conversationalresponse"` in vocabulary — the tracker reports a false disagreement. Over time this skews graduation metrics and could delay or block legitimate mode advancement from shadow → audit → partial → full, slowing the transition away from LLM-backed cognition.

## Subsystems Affected

- cognition-service / inference (bootstrap.py lines 73-76)
- cognition-service / training (trainer.py ActionVocabulary)

## Open Questions

- Are there other normalization sites (e.g., in the NestJS caller or panel models) that should also be aligned?
- Should normalization be extracted into a shared utility to prevent future drift?
- How many false disagreements has this actually produced in practice — is it worth auditing historical bootstrap logs?

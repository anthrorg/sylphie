# Idea: Rule-Based Cross-Modulation Engine for Drive Interactions

**Created:** 2026-04-09
**Status:** proposed

## Summary

Replace the hardcoded `applyCrossModulation()` function in drive-engine with a declarative, rule-based system where each drive-to-drive interaction is defined as a typed rule object — making cross-modulation relationships configurable, testable, and extensible without modifying engine code.

## Motivation

Currently, `applyCrossModulation()` in the drive-engine contains hardcoded conditional blocks that wire specific drives together (e.g., anxiety amplifies integrity, satisfaction suppresses boredom). Adding, tuning, or removing a cross-modulation relationship requires editing the function body directly, which is error-prone and makes it impossible to unit-test individual modulation rules in isolation. The hardcoded coefficients (e.g., `ANXIETY_INTEGRITY_AMPLIFICATION_COEFFICIENT = 0.05`, guardian weighting multipliers of 2x/3x) lack documentation for why those values were chosen, and there's no way to A/B test different modulation profiles at runtime.

A rule-based approach would let each cross-modulation be defined as a standalone object (source drive, target drive, condition, effect function), loaded from configuration, and individually testable. This also opens the door to logging which rules fired per tick — critical for debugging emergent drive behaviors that are currently opaque.

## Subsystems Affected

- **drive-engine** — Core `applyCrossModulation()` rewritten to iterate over rule objects instead of inline conditionals
- **drive-engine/constants** — Cross-modulation coefficients moved from scattered constants into rule definitions
- **learning** — Could eventually propose new cross-modulation rules based on observed drive correlations
- **sylphie-pkg** — PKG edges would need to reflect the new rule-based dependency structure

## Open Questions

- Should rules be purely in-code config objects, or loaded from the database like `RuleEngine` guardian rules?
- What's the right format for the effect function — a simple coefficient, or a full `(sourceVal: number, targetVal: number) => number` callback?
- Should cross-modulation rules have priority/ordering, or should they all apply independently and sum?
- How to handle circular modulation (A affects B, B affects A) — apply in a single pass or iterate to convergence?
- Would adding per-rule metrics (fire count, cumulative effect magnitude) create meaningful tick-loop overhead at 100Hz?

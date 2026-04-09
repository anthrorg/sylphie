# Idea: Support 'call' Step Type in MorphologyExecutor

**Created:** 2026-04-09
**Status:** proposed

## Summary

`MorphologyExecutor` (`packages/perception-service/cobeing/layer3_knowledge/morphology_executor.py`, line 460) raises `NotImplementedError` for the `'call'` step type, which is needed for morphological procedure composition (one procedure invoking another). The `ProcedureExecutor` already supports `'call'` steps; the morphology executor needs the same capability via "executor unification."

## Motivation

Without `'call'` support, morphological procedures cannot compose — e.g., a plural-formation procedure can't delegate to a stem-change procedure. This limits the expressiveness of the morphological pipeline. The `ProcedureExecutor` already has a working `'call'` implementation (lines 560-622 in `procedure_executor.py`) including recursion depth limiting and cycle detection. The morphology executor needs an analogous implementation adapted for its string-based (rather than ValueNode-based) execution model.

## Subsystems Affected

- **perception-service** — `MorphologyExecutor._execute_string_ast()` needs a `'call'` branch that resolves the target procedure and delegates execution, converting between string values and the executor's internal representation.

## Open Questions

- Should MorphologyExecutor delegate to ProcedureExecutor for 'call' steps, or implement its own version?
- How should string values be passed as arguments to called procedures? ProcedureExecutor uses ValueNode IDs — the morphology executor uses raw strings.
- What's the recursion depth limit for morphological procedure calls?
- The docstring mentions "executor unification" — is there a design for merging MorphologyExecutor and ProcedureExecutor into a single executor?

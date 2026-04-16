# Idea: Support Syntactic Step Types in ProcedureExecutor

**Created:** 2026-04-13
**Status:** proposed

## Summary

The `ProcedureExecutor` in `packages/perception-service/cobeing/layer3_knowledge/procedure_executor.py` (lines 626-636) raises `NotImplementedError` for syntactic step types (`match_root`, `match_edge`, `match_optional`, `extract_role`, `match_property`). These require the `SyntacticTemplateMatcher` which is referenced as being implemented in P1.7-E4. Until this is wired, any procedure that contains syntactic parsing steps cannot execute.

## Motivation

Syntactic step types are needed for procedures that involve parsing sentence structure — matching grammatical roles, extracting subjects/objects, and understanding sentence patterns. These are a core part of Sylphie's language understanding pipeline. Without them, only semantic-level procedures can execute, limiting Sylphie's ability to learn from structurally complex inputs.

## Subsystems Affected

- **perception-service** — `procedure_executor.py` needs to delegate syntactic steps to `SyntacticTemplateMatcher`.
- **perception-service** — `template_matcher.py` likely contains the matcher implementation that needs to be integrated.
- **perception-service** — `language_bootstrap.py` Layer 5 disambiguation placeholder may also be involved.

## Open Questions

- Is the SyntacticTemplateMatcher already implemented in template_matcher.py, or does it need to be built?
- Does this depend on the morphology executor's 'call' step type (which has its own idea), or can they be wired independently?
- What is the P1.7-E4 epic reference — is this already planned in the ticket system?

# Idea: Define Depth 4+ Inference Advancement Criteria

**Created:** 2026-04-27
**Status:** proposed

## Summary

`inference_query.py` (`packages/perception-service/cobeing/layer3_knowledge/inference_query.py`, around line 1291) gates inference depth advancement on a series of unlock criteria (success rate, confirmed count, cluster coverage). For depth 4 and 5, it checks the E5 prerequisite, then short-circuits with the comment "For now, depth 4+ advancement criteria are not defined in E3" and returns the current depth unchanged. Inference therefore cannot advance past the architectural max even when E5 is available.

## Motivation

Inference depth is one of Sylphie's developmental ladders -- her ability to chain reasoning steps grows as competence is demonstrated at lower depths. CANON's developmental framing depends on this progression continuing once the inner-monologue (E5) prerequisite is in place. Leaving the depth-4+ rule undefined caps Sylphie's reasoning ceiling at depth 3 indefinitely, regardless of how much evidence accumulates. Even a placeholder rule that mirrors the depth-2 / depth-3 unlock pattern would be more honest than silently returning the current depth.

## Subsystems Affected

- **perception-service** -- `inference_query.py` `_advance_inference_depth` (or its equivalent) needs unlock predicates for depths 4 and 5, paralleling the existing depth-2 and depth-3 logic.
- **layer3_knowledge** -- The depth-rule node schema may need new properties (`depth_4_success_rate`, `depth_4_min_confirmed`, etc.) and corresponding defaults in `DEFAULT_*` constants.

## Open Questions

- What success metrics are meaningful at depth 4+ -- raw success rate, prediction-error-resolution rate, novel-edge yield?
- Should depth 4 and 5 share criteria, or do they diverge (e.g., depth 5 requiring sustained inner-monologue success)?
- Is the right place to define these the depth-rule node properties (data-driven) or constants in code (until E5 is mature)?

# Idea: Extract Query Subject From Trigger Inside Inner Monologue

**Created:** 2026-04-27
**Status:** proposed

## Summary

`inner_monologue.py` (`packages/perception-service/cobeing/layer3_knowledge/inner_monologue.py`, around line 452-456) sets `query_subject = trigger` directly, with the comment "A more sophisticated extraction would parse the question, but for now the caller is expected to provide a meaningful trigger string." The reasoning loop is therefore querying against whatever the caller passed, not against the entity or concept the trigger is actually about.

## Motivation

Inner-monologue reasoning is the E5 deliberation loop that drives Type 2 cognition. Its quality depends on querying the graph for the right subject. Passing the entire trigger string as the subject means questions like "What does Jim think about cats?" query for the literal phrase rather than for "Jim" or "cats". This degrades graph hits, increases miss rates on multi-step reasoning, and quietly pushes responsibility for question parsing onto every caller. Even a small extractor (noun-head, named-entity span, or an existing template-matched lemma) would lift this burden and make E5 more robust.

## Subsystems Affected

- **perception-service** -- `inner_monologue.py` needs a `_extract_query_subject(trigger)` helper. The simplest version reuses the existing word-grounding / template-matching pipeline; a richer version would handle question prefixes ("what about X", "do you know X").
- **layer3_knowledge** -- May involve `template_matcher.py` or `input_parser.py` for extraction.

## Open Questions

- Should the extractor return a single subject or a ranked list (and the loop tries them in order)?
- If extraction yields nothing, should the loop fall back to the full trigger string (current behavior) or shrug?
- Does this belong inside `inner_monologue.py` or upstream in the trigger-construction code so callers benefit too?

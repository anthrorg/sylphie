# Idea: Ungrounded Insight Re-grounding Sweep

**Created:** 2026-04-10
**Status:** proposed

## Summary

Add a periodic background process that revisits Insight nodes marked `grounded: false` and attempts to re-ground them against entities that have been added to the WKG since the insight was created, upgrading their confidence if new REVEALS edges can now be formed.

## Motivation

The conversation reflection service (`conversation-reflection.service.ts`) writes insights with `grounded: false` and a penalized confidence when the LLM references entities that don't yet exist in the WKG. This is correct behavior — it avoids inflating confidence for unverifiable claims. However, the system never revisits these insights. If a later maintenance cycle or reflection adds the missing entities, the ungrounded insight remains at its reduced confidence forever, even though it could now be verified.

This creates a temporal ordering problem: an insight's quality depends on whether the entities it references happened to be learned _before_ or _after_ reflection ran. Two identical insights about the same pattern could have very different confidence scores purely based on processing order.

A re-grounding sweep would make the learning pipeline order-independent and ensure insights converge toward their true confidence regardless of when entities enter the graph.

## Subsystems Affected

- Learning (primary — new pipeline step or separate timer cycle)
- WKG / Neo4j (reads Insight nodes with `grounded: false`, creates REVEALS edges, updates confidence)

## Open Questions

- Should re-grounding be a new timer in LearningService (like reflection/synthesis), or a step appended to the existing maintenance cycle after entity upsert?
- What's the right frequency? Every maintenance cycle seems too aggressive; every synthesis cycle (30 min) might be reasonable.
- Should there be a TTL on ungrounded insights? If an insight remains ungrounded after N cycles, it may be confabulated and should be garbage-collected rather than kept indefinitely at low confidence.
- Should re-grounding trigger a re-emission of `REFLECTION_INSIGHT_CREATED` events (with updated confidence), or a new event type like `INSIGHT_REGROUNDED`?
- Does the `computeGroundedConfidence` function need adjustment to account for partial re-grounding (e.g., 2 of 4 entities now exist vs. 0 of 4 at creation time)?

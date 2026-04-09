# Idea: Replace Edge Refinement LLM Call with Keyword/Pattern Decision Tree

**Created:** 2026-04-09
**Status:** proposed

## Summary

The `RefineEdgesService` uses a `quick`-tier LLM call to classify generic `RELATED_TO` edges into specific types (LIKES, KNOWS, WORKS_AT, etc.). A keyword/pattern decision tree over entity labels and source conversation text could handle the common cases, falling back to `RELATED_TO` for ambiguous ones.

## Motivation

The edge refinement LLM call at `packages/learning/src/pipeline/refine-edges.service.ts:143` takes entity pairs like `Jim -> Google` and classifies the relationship type. The LLM's job is pure classification over 16 possible types, with temperature 0.3 (conservative/deterministic).

The system already handles LLM unavailability gracefully (Lesion Test support — skips refinement entirely). A heuristic classifier would be strictly better than the skip-entirely fallback, and would eliminate the LLM dependency for this step.

Common patterns are highly predictable:
- Person → Organization → `WORKS_AT` or `BELONGS_TO`
- Person → Person → `KNOWS`
- Entity → Place → `LOCATED_IN` or `LIVES_AT`
- Person → Thing → `USES` or `OWNS`
- Verb-derived context: "likes X" → `LIKES`, "created X" → `CREATED`

## Proposed Approach

```typescript
const ENTITY_TYPE_RULES: Array<{
  sourcePattern?: RegExp;
  targetPattern?: RegExp;
  contextPattern?: RegExp;
  edgeType: string;
}> = [
  // Verb-derived from conversation context (highest priority)
  { contextPattern: /\b(?:likes?|loves?|enjoys?)\b/i, edgeType: 'LIKES' },
  { contextPattern: /\b(?:hates?|dislikes?)\b/i, edgeType: 'DISLIKES' },
  { contextPattern: /\b(?:works? (?:at|for)|employed)\b/i, edgeType: 'WORKS_AT' },
  { contextPattern: /\b(?:lives? (?:in|at)|resides?)\b/i, edgeType: 'LIVES_AT' },
  { contextPattern: /\b(?:uses?|using)\b/i, edgeType: 'USES' },
  { contextPattern: /\b(?:created?|built|made|wrote)\b/i, edgeType: 'CREATED' },
  { contextPattern: /\b(?:owns?|has a)\b/i, edgeType: 'OWNS' },
  { contextPattern: /\b(?:caused|because of|due to)\b/i, edgeType: 'CAUSED_BY' },
  { contextPattern: /\b(?:led to|resulted in)\b/i, edgeType: 'LED_TO' },
  // ... fall through to RELATED_TO if no match
];

function classifyEdge(
  source: string, target: string, conversationContext: string,
): string {
  for (const rule of ENTITY_TYPE_RULES) {
    if (rule.contextPattern && rule.contextPattern.test(conversationContext)) {
      return rule.edgeType;
    }
  }
  return 'RELATED_TO'; // No confident classification — keep generic
}
```

The key insight: falling back to `RELATED_TO` is safe. The edge already exists as `RELATED_TO`. The LLM refinement is an enrichment step, not a required one. A conservative heuristic that only reclassifies high-confidence patterns and leaves the rest as `RELATED_TO` loses nothing.

## Subsystems Affected

- Learning (refine-edges.service.ts)

## Open Questions

- Should the heuristic classifier use the WKG's existing entity `nodeType` metadata (e.g., if the target is typed as `Organization`, prefer `WORKS_AT`)?
- How much conversation context should be passed to the classifier? The current LLM call uses the person context gathered from TimescaleDB — the heuristic could use the same text.
- Should the confidence on heuristic-refined edges be lower than LLM-refined edges (e.g., 0.3 vs 0.35)?
- Could a lightweight embedding similarity approach (cosine distance to type exemplars) improve accuracy without an LLM call?
- Is it worth maintaining the LLM path as an optional enrichment for when the model is available and idle?

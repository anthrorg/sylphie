# Idea: Pre-computed Assistant Pairing in getSplitHistory()

**Created:** 2026-04-12
**Status:** proposed

## Summary

The `getSplitHistory()` method in `ConversationHistoryService` uses an O(n^2) forward scan to pair each answered user message with its assistant response. Pre-computing a user-to-assistant index map during history construction would reduce this to O(n) and eliminate redundant scanning on every call.

## Motivation

In `apps/sylphie/src/services/conversation-history.service.ts` (lines 181-222), `getSplitHistory()` walks the history array and, for every answered user message, performs a nested forward scan to find the next assistant entry. With a 50-message history cap this isn't catastrophic, but the method is called on every decision cycle to build LLM context, so the quadratic behavior adds up across cycles.

The inner loop (lines 200-206) is straightforward to replace:

```typescript
for (let j = i + 1; j < this.history.length; j++) {
  if (this.history[j].role === 'assistant') {
    assistantText = this.history[j].content;
    break;
  }
  if (this.history[j].role === 'user') break;
}
```

A simple improvement: maintain a `Map<number, number>` (user index to next assistant index) that gets updated whenever entries are added to history. Then `getSplitHistory()` can do a direct lookup instead of scanning. Alternatively, a single-pass approach where the method itself builds the map once per call and caches it (invalidated on history mutation) would achieve the same result with minimal structural change.

This is a small win individually but representative of a pattern worth establishing — hot-path methods that run every cycle should avoid nested iteration over growing collections.

## Subsystems Affected

- `apps/sylphie` — `conversation-history.service.ts` (primary change)
- `cognition` — any downstream consumer of `getSplitHistory()` benefits from reduced latency

## Open Questions

- Is the map worth maintaining incrementally (updated on `addEntry`), or is a lazy cache (built on first `getSplitHistory()` call, invalidated on mutation) simpler and sufficient?
- Are there other methods in this service with similar lookahead patterns that could share the same index structure?
- With the 50-message cap, is this optimization measurable in practice, or is it primarily a code-clarity improvement?

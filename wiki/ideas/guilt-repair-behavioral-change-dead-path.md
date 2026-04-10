# Idea: Fix Guilt Repair Behavioral Change Detection (Dead Code Path)

**Created:** 2026-04-10
**Status:** proposed

## Summary

The guilt-repair contingency's behavioral change detection is effectively dead code because `ContingencyCoordinator.applyContingencies()` passes `outcome.actionType` as both the current action and the `previousErrorActionType` context, causing `detectBehavioralChange()` to always compare the action type to itself and always return `false`.

## Motivation

The guilt-repair contingency (CANON §A.14) defines three relief tiers based on whether an action involves acknowledgment, behavioral change, or both. The relief schedule is:

- Acknowledgment only: guilt -= 0.10
- Behavioral change only: guilt -= 0.15
- Both acknowledgment + behavioral change: guilt -= 0.30

However, the behavioral change path never fires. In `contingency-coordinator.ts` line 98-105:

```typescript
const guiltRelief = this.guiltyRepair.computeGuiltRelief(
  outcome.actionType,
  outcome.outcome,
  {
    previousErrorActionType: outcome.actionType,   // ← BUG: same as first argument
    previousErrorContext: outcome.actionType,
  },
);
```

Inside `GuiltyRepair.detectBehavioralChange()`, this results in `currentActionType !== previousErrorActionType` always being `false` (since they're the same string). This means:

- The 0.15 relief (behavioral change only) never fires
- The 0.30 relief (both mechanisms) is unreachable — only the 0.10 acknowledgment path can ever trigger
- The `GuiltyRepair.recentErrors` tracking state is populated but never meaningfully consulted for behavioral change detection
- Guilt accumulation is harder to reverse than CANON intends

The fix should wire the coordinator to look up the most recent error from `GuiltyRepair.recentErrors` (or expose a method like `getLastErrorActionType()`) and pass *that* as `previousErrorActionType` instead of echoing back the current outcome's action type.

## Subsystems Affected

- Drive Engine (`contingency-coordinator.ts` — fix the context passed to `computeGuiltRelief`)
- Drive Engine (`guilt-repair.ts` — may need a new public method to expose last error action type, or the coordinator should query `getRecentErrors()` directly)

## Open Questions

- Should `GuiltyRepair` expose a dedicated `getLastErrorActionType()` helper, or should the coordinator read from `getRecentErrors()` and pick the most relevant one?
- Is "most recent error" the right comparison target, or should it be "most recent error of the same category/domain"? A completely unrelated error context might produce false positives for behavioral change.
- Should there be a semantic similarity check instead of simple string inequality? Currently *any* different action type counts as behavioral change, which may be too generous (e.g., switching from "reply" to "search" isn't really a behavioral correction).
- Does the existing test suite (if any) cover this path? If tests pass with the bug, they may need updating too.

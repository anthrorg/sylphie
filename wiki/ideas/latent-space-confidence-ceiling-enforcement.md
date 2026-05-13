# Idea: Enforce the Confidence Ceiling at the Latent Space Write Boundary

**Created:** 2026-04-27
**Status:** proposed

## Summary

`LatentSpaceService.write` (`packages/decision-making/src/latent-space/latent-space.service.ts`, line 298) accepts whatever `confidence` the caller passes and stores it directly in both the hot layer (line 314) and the warm layer `learned_patterns` row (line 348), with no enforcement of CANON Standard 3 (Confidence Ceiling). At write time `useCount` is always 0 -- the pattern has by definition not yet been retrieved-and-used -- so any caller-supplied confidence above 0.60 is a Standard 3 violation persisted into a Type 1 store.

## Motivation

Standard 3 of the Six Immutable Standards is unambiguous: *"No knowledge exceeds 0.60 confidence without at least one successful retrieval-and-use event."* The latent space is exactly the kind of store this rule was written to protect -- a pattern in the latent space is Type 1 reflex knowledge that fires in microseconds without LLM mediation. If a Type 2 deliberation commits a pattern at, say, 0.80 confidence on its first creation, that pattern can immediately dominate `searchByModality`'s "best similarity above threshold" selection on the next tick, producing reflexive behavior backed by knowledge that has never proven itself in retrieval.

The fix is the canonical clamp from the canon agent's enforcement notes: when `useCount === 0`, store `Math.min(0.60, confidence)`. The service already owns both writes (hot and warm), so it is the correct enforcement boundary -- callers should not be trusted to know the rule. Two complementary changes make the fix defensible:

1. **Runtime clamp in `write()`** -- `const safeConfidence = Math.min(0.60, pattern.confidence);` applied to both the hot layer push (line 308-317) and the parameterized INSERT (line 348). Add a `vlog` line when clamping fires so the suppression is observable.
2. **Schema-level CHECK constraint** in `ensureSchema()` -- `CHECK (use_count > 0 OR confidence <= 0.60)`. This makes the canon rule structurally enforced in TimescaleDB, not just in the application layer, so any future code path that bypasses `write()` (direct SQL, future migration paths, manual seeding) cannot create a violation.

A symmetric concern lives in `updateConfidence` (line 428): a successful outcome could boost confidence above 0.60, which is correct *if and only if* `useCount > 0` by that point. Today `recordUse` and `updateConfidence` are separate methods called by separate code paths -- there is no atomic guarantee that "use happened" precedes "confidence raised above ceiling." `updateConfidence` should also apply the clamp using the current `useCount` it can read from the hot entry.

## Subsystems Affected

- **decision-making** -- `latent-space.service.ts` (`write`, `updateConfidence`, `ensureSchema`); the Type 1 retrieval path in `searchByModality` will see correctly-bounded confidences once the rule is enforced.
- **decision-making** -- callers of `LatentSpaceService.write` (deliberation/executor paths that commit Type 2 results into the latent space) will need to be audited for whether they currently exceed 0.60 on first write; if they do, that is the bug being fixed, not regressed.
- **shared** -- if a confidence-clamp helper already exists in `@sylphie/shared` (the ACT-R update path described in the canon docs lives somewhere), reuse it rather than duplicating the `Math.min(0.60, x)` literal.

## Open Questions

- Does any existing call site rely on writing a pattern at >0.60 on creation? If so, that is the canon violation and should be quoted in the fix PR; confirm by grepping `writeMultiModal`/`write` call sites.
- Should clamping increment a counter or emit a `LATENT_CONFIDENCE_CLAMPED` event so the supervisor can detect callers that are repeatedly trying to violate the ceiling? (This would surface canon-violating *intent* even when the write path silently corrects it.)
- Is the schema CHECK constraint acceptable for an existing table with historical rows that may already violate it? If yes, an upgrade migration may need to clamp existing rows; if no, gate the constraint behind a fresh-install path and run a one-shot UPDATE during deploy.
- Does the `recentMae`-driven decay path (referenced by the unified-mae-history-store idea) ever lower `useCount`? If `useCount` can be reset, the ceiling must re-engage on the next write -- confirm the rule is "ever-used" or "currently-using" semantics with Jim.

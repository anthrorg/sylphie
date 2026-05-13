# Idea: Remove Runtime Mutation Path on the Action-to-Emotion Mapping Table

**Created:** 2026-04-27
**Status:** proposed

## Summary

`packages/drive-engine/src/constants/action-emotions.ts` exports `registerActionEmotionMapping`, which casts the `Readonly<Map<string, ActionEmotionMapping>>` constant to a mutable `Map` and `.set()`s a new entry at runtime. The action-to-emotion table is the lookup that Theater Prohibition checks consume to decide whether an emotional expression is authentic, so a runtime mutation API on this table is a back-door for self-modifying evaluation criteria.

## Motivation

CANON Immutable Standard 6 (No Self-Modification of Evaluation): "Sylphie can learn WHAT to do, HOW effective each action is, and WHEN to do it. She cannot learn to modify HOW success is measured -- the evaluation function is fixed architecture." The action→emotion mapping is part of *how* Theater Prohibition measures authenticity (it determines which drive must clear a directional threshold for a given action). The function's own JSDoc states it is "Used by the Learning subsystem when extracting behavioral patterns" -- which is the textbook violation pattern Standard 6 was written to prevent.

Two reinforcing concerns:

- The `as Map<...>` cast on line 147 is doing real work: it intentionally defeats the `Readonly` type contract that the export declared on line 122. Compilers, code review, and CANON enforcement tooling all see a constant; the runtime sees a mutable singleton.
- The project already has the canonical pattern for this exact problem: `RuleProposerService` (`packages/drive-engine/src/rule-proposer.service.ts`) submits proposed evaluation changes to a `proposed_drive_rules` review queue and waits for guardian approval before they take effect. Action-emotion mappings should travel the same path, not a private in-process Map mutation.

There is no urgent caller pressure to keep this API: a workspace-wide grep finds zero callers of `registerActionEmotionMapping` and zero callers of `getActionEmotionMapping` outside the file itself. Removing the mutation now is cheap; removing it after Learning has been wired through it is expensive.

## Subsystems Affected

- **drive-engine** -- delete `registerActionEmotionMapping`, drop the `as Map<...>` cast, and either freeze the Map or expose it as a true `ReadonlyMap`. Add a small unit test asserting the export rejects mutation.
- **rule-proposer** (drive-engine) -- if Learning legitimately needs to extend the mapping, add a `proposed_action_emotion_mappings` table and a `proposeActionEmotionMapping` method that mirrors `proposeRule`, so new entries enter the same guardian review queue rather than self-activating.
- **learning** -- audit any existing or planned code that intended to call `registerActionEmotionMapping` and route it through the proposer instead.

## Open Questions

- Should the mapping table stay code-resident (constants file) and require a code change + guardian-approved PR for new entries, or move to PostgreSQL alongside drive rules so guardians can edit it from the dashboard?
- Are there mappings beyond Theater Prohibition that have similar back-door registration APIs (e.g., drive correlation, opportunity priority)? A short audit of `packages/drive-engine/src/constants/*.ts` for the same `as` cast pattern would show whether this is one instance or a class of issues.
- Does removing the registration API break any in-flight work on the Learning subsystem's behavioral pattern extraction, and if so what's the migration plan?

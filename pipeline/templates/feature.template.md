<!--
HOW TO USE
  1. Copy this file into pipeline/inbox/ named  feature-<short-slug>.md
  2. Fill every section. The first heading becomes the item title, so make it specific.
  3. Delete the angle-bracket hints as you go. Keep it concrete — vague requests get
     parked in `replan` waiting on you; concrete ones flow to a plan.
  Sections marked (required) are what keep an item from stalling.
-->

# Feature: <one-line capability, specific — e.g. "Coordinated snapshot + restore across all five stores">

**Priority:** <P0 | P1 | P2>  ·  **Engineering level:** <prototype | production>
**Area / component:** <subsystem or feature, e.g. persistence, cognition-service, frontend>

## Why (required)
<The problem or gap this closes. What is true today that shouldn't be, or what becomes
possible once this exists. One short paragraph — the motivation, not the mechanism.>

## What it should do (required)
<The outcome, as observable behavior. What exists and works when this ships. Be precise —
this seeds the plan's acceptance criteria. Prefer "the system does X" over "add a module".>

## Scope hints
<Suspected file(s), services, packages, likely work-trio owner — anything that points
discovery at the right place. "Unknown" is fine; a good guess speeds planning.>

## Dependencies (required)
<Other pipeline items or features that must land first, and any items that touch the same
files (conflict risk — the pipeline should not run them concurrently). "None" is fine.>

## Database impact (required)
**Touches a database / schema / migration?** <no | yes | unknown>
<If yes or unknown: which store (Postgres / Timescale / Neo4j), whether it's a new shape
or a migration of existing data. This trips the DB-change-safety gate so a migration plan
gets written. If purely code, say "no".>

## Acceptance — how we'll know it works (required)
<Two to five runnable checks, ideally Given/When/Then. Every criterion must be checkable
by a command, test, or observable behavior — "looks done" is not done.>

## Non-goals / scope guard (required)
<What this feature explicitly does NOT include. The complexity budget's best friend —
name the adjacent work someone will be tempted to fold in, and forbid it.>

## Source / references
<Design doc, research note, decision id, or conversation this came from, e.g.
docs/future/sylphie-persistence-migration-plan.md §2. The feature doc is the pipeline's
unit of work; the source doc holds the full design detail.>

<!-- ─────────────────────────── EXAMPLE (delete in real requests) ───────────────────────────
# Feature: Verbose log rotation

**Priority:** P2 · **Engineering level:** production
**Area / component:** shared logging

## Why
verbose.log grows unbounded over long sessions, filling disk and slowing startup.

## What it should do
The verbose log rolls over past a size threshold and keeps only the last N segments,
so disk use and read time stay flat regardless of session length.

## Scope hints
packages/shared/src/verbose.ts (append-stream sink). Owner: forge.

## Dependencies
None.

## Database impact
no — only the verbose/debug log path.

## Acceptance — how we'll know it works
Given VERBOSE=1 and a log past the threshold, when a line is written, then it rolls to a
new file and only the last N segments remain on disk.

## Non-goals / scope guard
No structured-logging rework; no changes to log content or levels.

## Source / references
Pipeline decision — item 001 (2026-06-27).
─────────────────────────────────────────────────────────────────────────────────────── -->
